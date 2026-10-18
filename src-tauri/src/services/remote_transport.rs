//! SSH/WSL transports for host-owned remote tools. No provider credentials or
//! Agent runtime are sent to the target. A framed request and cancellation byte
//! share stdin; the remote helper returns one bounded, correlated receipt.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Write, path::PathBuf, process::Stdio, sync::OnceLock, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
    task::JoinHandle,
    time::Instant,
};

const HELPER: &str = include_str!("remote_rpc.py");
const MAX_REQUEST: usize = 8 * 1024 * 1024;
const MAX_RESPONSE: usize = 8 * 1024 * 1024;
const MAX_STDERR: usize = 64 * 1024;
const MARKER: &str = "LOLICODE_REMOTE_RPC_V1:";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum RemoteTarget {
    Ssh {
        host: String,
        #[serde(default)]
        port: Option<u16>,
        #[serde(default)]
        username: Option<String>,
        #[serde(default, rename = "identityFile")]
        identity_file: Option<PathBuf>,
    },
    Wsl {
        distribution: String,
        #[serde(default)]
        username: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteErrorKind {
    InvalidInput,
    Unavailable,
    Authentication,
    HostVerification,
    NotFound,
    Permission,
    Conflict,
    Cancelled,
    Timeout,
    CleanupUncertain,
    Protocol,
    Unsupported,
}

#[derive(Debug)]
pub struct RemoteError {
    pub kind: RemoteErrorKind,
    pub message: &'static str,
}
impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.kind == RemoteErrorKind::CleanupUncertain {
            write!(f, "[cleanup_uncertain]")?;
        }
        f.write_str(self.message)
    }
}
impl std::error::Error for RemoteError {}

fn failure(kind: RemoteErrorKind, message: &'static str) -> RemoteError {
    RemoteError { kind, message }
}
fn invalid() -> RemoteError {
    failure(RemoteErrorKind::InvalidInput, "远程目标或工具参数无效。")
}
fn uncertain() -> RemoteError {
    failure(
        RemoteErrorKind::CleanupUncertain,
        "连接中断，无法确认远程操作或命令清理结果。请重新连接并检查现有结果，再决定是否重试。",
    )
}

fn username_valid(username: Option<&str>) -> bool {
    username.is_none_or(|name| {
        !name.is_empty()
            && name.len() <= 128
            && !name.starts_with('-')
            && name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '$'))
    })
}

impl RemoteTarget {
    pub fn validate(&self) -> Result<(), RemoteError> {
        match self {
            Self::Ssh {
                host,
                port,
                username,
                identity_file,
            } => {
                if host.is_empty()
                    || host.len() > 253
                    || host.starts_with('-')
                    || !host.chars().all(|ch| {
                        ch.is_ascii_alphanumeric()
                            || matches!(ch, '.' | '_' | '-' | ':' | '[' | ']' | '%')
                    })
                    || *port == Some(0)
                    || !username_valid(username.as_deref())
                {
                    return Err(invalid());
                }
                if identity_file.as_ref().is_some_and(|path| {
                    !path.is_absolute()
                        || !path.is_file()
                        || path.to_string_lossy().contains(['\0', '\r', '\n'])
                }) {
                    return Err(invalid());
                }
            }
            Self::Wsl {
                distribution,
                username,
            } => {
                if distribution.trim().is_empty()
                    || distribution.len() > 256
                    || distribution.starts_with('-')
                    || distribution.chars().any(char::is_control)
                    || !username_valid(username.as_deref())
                {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }

    fn command(&self) -> Result<Command, RemoteError> {
        self.validate()?;
        let script = python_script()?;
        let mut command = match self {
            Self::Ssh {
                host,
                port,
                username,
                identity_file,
            } => {
                let mut command = Command::new(system_program("ssh")?);
                command.args([
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ForwardAgent=no",
                    "-o",
                    "ClearAllForwardings=yes",
                    "-o",
                    "PermitLocalCommand=no",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "ConnectTimeout=10",
                    "-o",
                    "ServerAliveInterval=15",
                    "-o",
                    "ServerAliveCountMax=2",
                ]);
                if let Some(port) = port {
                    command.arg("-p").arg(port.to_string());
                }
                if let Some(username) = username {
                    command.arg("-l").arg(username);
                }
                if let Some(identity_file) = identity_file {
                    command.arg("-i").arg(identity_file);
                }
                // Only the fixed compressed helper appears in the remote shell
                // command. Paths, commands and file contents go through stdin.
                command
                    .arg("--")
                    .arg(host)
                    .arg(format!("python3 -c '{script}'"));
                command
            }
            Self::Wsl {
                distribution,
                username,
            } => {
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = (distribution, username, script);
                    return Err(failure(
                        RemoteErrorKind::Unsupported,
                        "WSL 连接仅适用于 Windows 桌面。",
                    ));
                }
                #[cfg(target_os = "windows")]
                {
                    let mut command = Command::new(system_program("wsl")?);
                    command.arg("--distribution").arg(distribution);
                    if let Some(username) = username {
                        command.arg("--user").arg(username);
                    }
                    command.args(["--exec", "python3", "-c", script]);
                    command
                }
            }
        };
        // Avoid accidental SendEnv/WSLENV propagation of provider API keys from
        // the desktop's environment. Preserve only OS launch, home, locale and
        // the existing local SSH-agent socket needed for authentication.
        command.env_clear();
        for (name, value) in std::env::vars_os() {
            if matches!(
                name.to_string_lossy().to_ascii_uppercase().as_str(),
                "PATH"
                    | "HOME"
                    | "USERPROFILE"
                    | "HOMEDRIVE"
                    | "HOMEPATH"
                    | "APPDATA"
                    | "LOCALAPPDATA"
                    | "SYSTEMROOT"
                    | "WINDIR"
                    | "TEMP"
                    | "TMP"
                    | "SSH_AUTH_SOCK"
                    | "SSH_AGENT_PID"
                    | "LANG"
                    | "LC_ALL"
                    | "USERNAME"
                    | "USERDOMAIN"
                    | "USERDNSDOMAIN"
                    | "COMPUTERNAME"
                    | "SYSTEMDRIVE"
                    | "COMSPEC"
                    | "PROGRAMDATA"
                    | "ALLUSERSPROFILE"
                    | "OS"
            ) {
                command.env(name, value);
            }
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        Ok(command)
    }
}

fn system_program(name: &str) -> Result<PathBuf, RemoteError> {
    #[cfg(target_os = "windows")]
    {
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| failure(RemoteErrorKind::Unavailable, "无法定位 Windows 系统工具。"))?;
        let path = root.join("System32").join(if name == "ssh" {
            "OpenSSH/ssh.exe"
        } else {
            "wsl.exe"
        });
        if !path.is_file() {
            return Err(failure(
                RemoteErrorKind::Unavailable,
                "系统 SSH / WSL 工具未安装，请安装对应的 Windows 可选组件后重试。",
            ));
        }
        Ok(path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let path = PathBuf::from("/usr/bin").join(name);
        if path.is_file() {
            Ok(path)
        } else {
            Err(failure(
                RemoteErrorKind::Unavailable,
                "系统 OpenSSH 客户端未安装。",
            ))
        }
    }
}

fn python_script() -> Result<&'static str, RemoteError> {
    static SCRIPT: OnceLock<String> = OnceLock::new();
    if let Some(script) = SCRIPT.get() {
        return Ok(script);
    }
    let mut compressor =
        flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    compressor
        .write_all(HELPER.as_bytes())
        .map_err(|_| failure(RemoteErrorKind::Protocol, "无法准备远程工具。"))?;
    let compressed = compressor
        .finish()
        .map_err(|_| failure(RemoteErrorKind::Protocol, "无法准备远程工具。"))?;
    let script = format!(
        "import base64,zlib;exec(zlib.decompress(base64.b64decode(\"{}\")))",
        STANDARD.encode(compressed)
    );
    let _ = SCRIPT.set(script);
    Ok(SCRIPT.get().expect("initialized remote helper"))
}

async fn bounded_read(
    mut stream: impl AsyncRead + Unpin,
    maximum: usize,
) -> Result<Vec<u8>, RemoteError> {
    let mut bytes = Vec::new();
    (&mut stream)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| failure(RemoteErrorKind::Unavailable, "远程连接读取中断。"))?;
    if bytes.len() > maximum {
        return Err(failure(
            RemoteErrorKind::Protocol,
            "远程工具返回的数据超过限制。",
        ));
    }
    Ok(bytes)
}

fn parse_reply(bytes: &[u8], request_id: &str) -> Result<Value, RemoteError> {
    let decoded = std::str::from_utf8(bytes)
        .map_err(|_| failure(RemoteErrorKind::Protocol, "远程工具响应不是有效文本。"))?;
    let mut matches = decoded.lines().filter_map(|line| line.strip_prefix(MARKER));
    let payload = matches.next().ok_or_else(|| {
        failure(
            RemoteErrorKind::Protocol,
            "未收到远程工具回执，请确认远端已安装 Python 3.9+，并支持 POSIX 文件接口。",
        )
    })?;
    if matches.next().is_some() {
        return Err(failure(
            RemoteErrorKind::Protocol,
            "远程工具回执重复，未接受此次结果。",
        ));
    }
    let value: Value = serde_json::from_str(payload)
        .map_err(|_| failure(RemoteErrorKind::Protocol, "远程工具回执无法解析。"))?;
    if value["version"].as_u64() != Some(1) || value["requestId"] != request_id {
        return Err(failure(
            RemoteErrorKind::Protocol,
            "远程工具回执与当前请求不匹配。",
        ));
    }
    if value["ok"].as_bool() == Some(true) {
        return value
            .get("result")
            .cloned()
            .ok_or_else(|| failure(RemoteErrorKind::Protocol, "远程工具未提供执行结果。"));
    }
    let error = match value["error"]["code"].as_str() {
        Some("CANCELLED") => failure(RemoteErrorKind::Cancelled, "远程任务已停止。"),
        Some("COMMAND_TIMEOUT") => {
            failure(RemoteErrorKind::Timeout, "远程命令已超时，已停止其进程组。")
        }
        Some("CLEANUP_UNCERTAIN") => uncertain(),
        Some("CONFLICT") => failure(
            RemoteErrorKind::Conflict,
            "远程文件内容已变化或正在被修改，请重新读取后再提交。",
        ),
        Some("NOT_FOUND") => failure(RemoteErrorKind::NotFound, "远程目录或文件不存在。"),
        Some("PERMISSION_DENIED") => failure(
            RemoteErrorKind::Permission,
            "远程账户没有访问该文件或目录的权限。",
        ),
        Some("SYMLINK_REJECTED" | "PATH_OUTSIDE_PROJECT") => failure(
            RemoteErrorKind::Permission,
            "远程文件工具不允许越出工程或经过符号链接。",
        ),
        Some("FILE_TOO_LARGE") => failure(
            RemoteErrorKind::InvalidInput,
            "远程文件超出工具读取或修改大小限制。",
        ),
        Some("NOT_UTF8" | "NOT_REGULAR_FILE") => failure(
            RemoteErrorKind::InvalidInput,
            "请选择普通 UTF-8 文本文件，图片请使用图片工具。",
        ),
        Some("UNSUPPORTED_PLATFORM") => failure(
            RemoteErrorKind::Unsupported,
            "当前远程工具需要 POSIX 系统及 Python 3.9+。",
        ),
        Some("INVALID_REQUEST" | "UNKNOWN_OPERATION") => invalid(),
        _ => failure(
            RemoteErrorKind::Protocol,
            "远程工具未能完成操作，原始错误内容未展示。",
        ),
    };
    Err(error)
}

fn connection_error(stderr: &[u8]) -> Option<RemoteError> {
    let text = String::from_utf8_lossy(stderr);
    if text.contains("Host key verification failed")
        || text.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
    {
        Some(failure(
            RemoteErrorKind::HostVerification,
            "SSH 主机指纹尚未信任或发生变化。请使用系统 SSH 核验正确指纹后重试，不会自动跳过验证。",
        ))
    } else if text.contains("Permission denied") || text.contains("Load key") {
        Some(failure(
            RemoteErrorKind::Authentication,
            "SSH 认证失败。请检查 SSH 配置、ssh-agent 或私钥文件；不会保存或回显密码。",
        ))
    } else if text.contains("Could not resolve hostname") || text.contains("Connection refused") {
        Some(failure(
            RemoteErrorKind::Unavailable,
            "SSH 主机无法解析或拒绝连接，请检查主机、端口和网络。",
        ))
    } else {
        None
    }
}

fn mutation(operation: &str) -> bool {
    matches!(operation, "run_command" | "write_file" | "apply_patch")
}

pub async fn call(
    target: &RemoteTarget,
    operation: &str,
    root: Option<&str>,
    args: Value,
    mut cancel: watch::Receiver<bool>,
) -> Result<Value, RemoteError> {
    if *cancel.borrow() {
        return Err(failure(
            RemoteErrorKind::Cancelled,
            "远程任务尚未执行，已停止。",
        ));
    }
    if !matches!(
        operation,
        "probe"
            | "open_project"
            | "read_file"
            | "view_image"
            | "list_files"
            | "search_files"
            | "write_file"
            | "apply_patch"
            | "run_command"
    ) || !args.is_object()
    {
        return Err(invalid());
    }
    if (operation == "probe" && root.is_some())
        || (operation != "probe"
            && root.is_none_or(|root| {
                !root.starts_with('/') || root.len() > 4096 || root.chars().any(char::is_control)
            }))
    {
        return Err(invalid());
    }
    let timeout = if operation == "run_command" {
        args.get("timeout_seconds")
            .map_or(Some(30), Value::as_u64)
            .filter(|seconds| (1..=120).contains(seconds))
            .ok_or_else(invalid)?
            + 15
    } else {
        30
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let bytes = serde_json::to_vec(
        &json!({"version":1,"requestId":request_id,"operation":operation,"root":root,"args":args}),
    )
    .map_err(|_| invalid())?;
    if bytes.len() > MAX_REQUEST {
        return Err(invalid());
    }
    let mut child = target.command()?.spawn().map_err(|_| {
        failure(
            RemoteErrorKind::Unavailable,
            "无法启动系统 SSH / WSL 客户端。",
        )
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| failure(RemoteErrorKind::Protocol, "无法创建远程输入通道。"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let mut reader: JoinHandle<Result<Vec<u8>, RemoteError>> =
        tokio::spawn(bounded_read(stdout, MAX_RESPONSE));
    let mut errors = tokio::spawn(bounded_read(stderr, MAX_STDERR));
    let sent = tokio::time::timeout(Duration::from_secs(15), async {
        stdin.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
        stdin.write_all(&bytes).await?;
        stdin.flush().await
    })
    .await;
    if !matches!(sent, Ok(Ok(()))) {
        let _ = child.kill().await;
        let _ = child.wait().await;
        reader.abort();
        let error_bytes = tokio::time::timeout(Duration::from_secs(2), &mut errors)
            .await
            .ok()
            .and_then(Result::ok)
            .and_then(Result::ok)
            .unwrap_or_default();
        if !errors.is_finished() {
            errors.abort();
        }
        return Err(connection_error(&error_bytes).unwrap_or_else(|| {
            if mutation(operation) {
                uncertain()
            } else {
                failure(
                    RemoteErrorKind::Unavailable,
                    "无法发送远程请求，请检查连接及远端 Python 环境。",
                )
            }
        }));
    }
    let mut stopping = false;
    let mut deadline = Instant::now() + Duration::from_secs(timeout);
    let output = loop {
        tokio::select! {
            result = &mut reader => break result.ok().and_then(Result::ok),
            _ = cancel.changed(), if !stopping => {
                // Closing the owning flight also cancels; do not busy-loop on a
                // closed watch channel or leave a detached remote command.
                if *cancel.borrow() || cancel.has_changed().is_err() {
                    let _ = tokio::time::timeout(Duration::from_secs(1), async { stdin.write_all(b"!").await?; stdin.flush().await }).await;
                    stopping = true;
                    deadline = Instant::now() + Duration::from_secs(5);
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                if stopping { break None; }
                let _ = tokio::time::timeout(Duration::from_secs(1), async { stdin.write_all(b"!").await?; stdin.flush().await }).await;
                stopping = true;
                deadline = Instant::now() + Duration::from_secs(5);
            }
        }
    };
    drop(stdin);
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    if !reader.is_finished() {
        reader.abort();
    }
    let error_bytes = tokio::time::timeout(Duration::from_secs(2), &mut errors)
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(Result::ok)
        .unwrap_or_default();
    if !errors.is_finished() {
        errors.abort();
    }
    if let Some(bytes) = output {
        match parse_reply(&bytes, &request_id) {
            Ok(result) => return Ok(result),
            Err(error) if error.kind != RemoteErrorKind::Protocol => return Err(error),
            Err(error) => {
                return Err(connection_error(&error_bytes).unwrap_or_else(|| {
                    if mutation(operation) {
                        uncertain()
                    } else {
                        error
                    }
                }));
            }
        }
    }
    Err(connection_error(&error_bytes).unwrap_or_else(|| {
        if mutation(operation) {
            uncertain()
        } else {
            failure(
                RemoteErrorKind::Unavailable,
                "远程连接中断或响应超时，请重新连接后重试。",
            )
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_target_validation_keeps_options_and_credentials_out_of_host_arguments() {
        let valid = RemoteTarget::Ssh {
            host: "owned-host".into(),
            port: Some(22),
            username: Some("developer".into()),
            identity_file: None,
        };
        assert!(valid.validate().is_ok());
        for host in [
            "-oProxyCommand=bad",
            "host\ncommand",
            "user@host",
            "host;command",
            "host name",
            "",
        ] {
            assert!(RemoteTarget::Ssh {
                host: host.into(),
                port: None,
                username: None,
                identity_file: None
            }
            .validate()
            .is_err());
        }
        assert!(serde_json::from_value::<RemoteTarget>(
            json!({"kind":"ssh","host":"owned-host","password":"must-not-be-saved"})
        )
        .is_err());
        assert!(RemoteTarget::Ssh {
            host: "host".into(),
            port: Some(0),
            username: None,
            identity_file: None
        }
        .validate()
        .is_err());
    }

    #[test]
    fn helper_command_is_fixed_compressed_code_without_request_data() {
        let script = python_script().unwrap();
        assert!(!script.contains('\''));
        assert!(script.len() < 16_000);
        let encoded = script.split('"').nth(1).unwrap();
        let data = STANDARD.decode(encoded).unwrap();
        let mut decoder = flate2::read::ZlibDecoder::new(data.as_slice());
        let mut actual = String::new();
        std::io::Read::read_to_string(&mut decoder, &mut actual).unwrap();
        assert_eq!(actual, HELPER);
    }

    #[test]
    fn receipt_requires_one_correlated_marker_and_never_exposes_server_errors() {
        let good = format!("Welcome\n{MARKER}{{\"version\":1,\"requestId\":\"owned\",\"ok\":true,\"result\":{{\"text\":\"done\"}}}}\n");
        assert_eq!(
            parse_reply(good.as_bytes(), "owned").unwrap()["text"],
            "done"
        );
        assert_eq!(
            parse_reply(good.as_bytes(), "other").unwrap_err().kind,
            RemoteErrorKind::Protocol
        );
        assert!(parse_reply(format!("{good}{good}").as_bytes(), "owned").is_err());
        let hostile = format!("{MARKER}{{\"version\":1,\"requestId\":\"owned\",\"ok\":false,\"error\":{{\"code\":\"UNKNOWN_SERVER_ERROR\",\"message\":\"PRIVATE_SENTINEL_73\"}}}}");
        assert!(!parse_reply(hostile.as_bytes(), "owned")
            .unwrap_err()
            .to_string()
            .contains("PRIVATE_SENTINEL_73"));
    }

    #[test]
    fn ssh_errors_use_fixed_actionable_messages_without_echoing_paths_or_keys() {
        let error = connection_error(b"Permission denied PRIVATE_SENTINEL_73").unwrap();
        assert_eq!(error.kind, RemoteErrorKind::Authentication);
        assert!(!error.to_string().contains("PRIVATE_SENTINEL_73"));
        assert_eq!(
            connection_error(b"Host key verification failed")
                .unwrap()
                .kind,
            RemoteErrorKind::HostVerification
        );
        assert!(uncertain().to_string().starts_with("[cleanup_uncertain]"));
    }
}
