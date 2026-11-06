//! Stdio boundary for the pinned upstream process. It does not run Agent logic.
use super::{
    agent_browser::ProcessTree,
    harness_gateway::{HarnessGateway, PROVIDER, TOKEN_ENV},
    harness_paths::HarnessPaths,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot, watch, Semaphore},
    time::timeout,
};

const RPC_TIMEOUT: Duration = Duration::from_secs(45);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FRAME: usize = 32 * 1024 * 1024;
const EVENT_CAPACITY: usize = 256;
const REQUEST_CAPACITY: usize = 64;

const MAX_MARKDOWN: usize = 8 * 1024 * 1024;
pub(super) const MARKDOWN_MISSING: &str = "会话尚未形成原生 Harness 日志，无法复制完整历史";
const MARKDOWN_TOO_LARGE: &str = "完整会话 Markdown 超过 8 MiB，无法复制";
const MARKDOWN_READ_FAILED: &str = "无法读取完整的原生 Harness 会话日志，请重试";

type Reply = Result<Value, String>;
type Requests = Mutex<HashMap<u64, oneshot::Sender<Reply>>>;
type Outbox = mpsc::Sender<Vec<u8>>;

pub(super) enum HarnessEvent {
    Notification(Value),
    Request(HarnessHostRequest),
}

/// The response capability is single use. Dropping a request refuses the
/// operation without blocking later SDK frames or the runtime's shutdown.
pub(super) struct HarnessHostRequest {
    pub method: String,
    pub params: Value,
    #[cfg(test)]
    frame_id: Value,
    response: oneshot::Sender<Option<Value>>,
}

impl HarnessHostRequest {
    pub(super) async fn respond(self, result: Option<Value>) -> Result<(), String> {
        self.response
            .send(result)
            .map_err(|_| "Harness 审批或提问已失效".into())
    }
}

#[derive(Clone)]
pub(super) struct HarnessClient {
    outbox: Outbox,
    pending: Arc<Requests>,
    sequence: Arc<AtomicU64>,
    stop: watch::Sender<bool>,
    stopped: watch::Receiver<Option<Result<(), String>>>,
    shutdown_lock: Arc<tokio::sync::Mutex<()>>,
}

struct PendingRequest {
    id: u64,
    pending: Arc<Requests>,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}

impl HarnessClient {
    pub(super) async fn request(&self, method: &str, params: Value) -> Reply {
        let request = self.send_request(method, params);
        if matches!(method, "session/wait" | "session/query") {
            // A wait can include an arbitrarily long model turn or human input.
            return request.await;
        }
        timeout(RPC_TIMEOUT, request)
            .await
            .map_err(|_| format!("Harness {method} 超时，操作状态待核对"))?
    }

    async fn send_request(&self, method: &str, params: Value) -> Reply {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let line = encode(&json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))?;
        let (tx, rx) = oneshot::channel();
        let guard = PendingRequest {
            id,
            pending: self.pending.clone(),
        };
        {
            let mut pending = guard.pending.lock().unwrap();
            if pending.len() >= REQUEST_CAPACITY {
                return Err("Harness 同时等待的请求过多".into());
            }
            pending.insert(id, tx);
        }
        self.outbox
            .send(line)
            .await
            .map_err(|_| "Harness 进程已断开")?;
        rx.await.map_err(|_| "Harness 进程已断开".to_owned())?
    }

    pub(super) async fn read_session_markdown(
        &self,
        root_id: &str,
        child_id: Option<&str>,
    ) -> Result<Option<String>, String> {
        let mut params = json!({"sessionId": root_id});
        if let Some(child) = child_id {
            params["childSessionId"] = json!(child);
        }
        match self.request("lolicode/session/read-markdown", params).await {
            Ok(Value::String(markdown)) => validate_markdown(markdown).map(Some),
            Err(error) => match error.as_str() {
                "LOLICODE_SESSION_LOG_COLD" | "Harness 进程已断开" => Ok(None),
                "LOLICODE_SESSION_LOG_MISSING" => Err(MARKDOWN_MISSING.into()),
                "LOLICODE_SESSION_MARKDOWN_TOO_LARGE" => Err(MARKDOWN_TOO_LARGE.into()),
                _ => Err(MARKDOWN_READ_FAILED.into()),
            },
            Ok(_) => Err(MARKDOWN_READ_FAILED.into()),
        }
    }

    pub(super) async fn cancel(&self, session_id: &str) -> Result<(), String> {
        self.request("lolicode/session/cancel", json!({"sessionId": session_id}))
            .await
            .map(|_| ())
    }

    pub(super) async fn shutdown(&self) -> Result<(), String> {
        let _shutdown = self.shutdown_lock.lock().await;
        let mut stopped = self.stopped.clone();
        if let Some(result) = stopped.borrow().clone() {
            return result;
        }
        let graceful = timeout(SHUTDOWN_TIMEOUT, async {
            self.send_request("shutdown", json!({})).await?;
            wait_stopped(&mut stopped).await
        })
        .await;
        if let Ok(Ok(())) = graceful {
            return Ok(());
        }
        self.stop.send_replace(true);
        let _ = timeout(SHUTDOWN_TIMEOUT, wait_stopped(&mut stopped)).await;
        Err("Harness 进程未能正常退出".into())
    }
}

fn validate_markdown(markdown: String) -> Result<String, String> {
    if markdown.len() > MAX_MARKDOWN {
        return Err(MARKDOWN_TOO_LARGE.into());
    }
    if markdown.is_empty() {
        return Err(MARKDOWN_READ_FAILED.into());
    }
    Ok(markdown)
}

pub(super) async fn read_cold_session_markdown(
    paths: &HarnessPaths,
    sessions: &Path,
    session_id: &str,
) -> Result<String, String> {
    let mut command = Command::new(&paths.node);
    command
        .arg(paths.package.join("host-session-markdown.mjs"))
        .arg(sessions)
        .arg(session_id)
        .current_dir(&paths.package)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
        for name in ["SystemRoot", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }
    let mut child = command.spawn().map_err(|_| MARKDOWN_READ_FAILED)?;
    let stdout = child.stdout.take().ok_or(MARKDOWN_READ_FAILED)?;
    timeout(RPC_TIMEOUT, async {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_MARKDOWN as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| MARKDOWN_READ_FAILED)?;
        if bytes.len() > MAX_MARKDOWN {
            return Err(MARKDOWN_TOO_LARGE.into());
        }
        let status = child.wait().await.map_err(|_| MARKDOWN_READ_FAILED)?;
        match status.code() {
            Some(0) => {
                validate_markdown(String::from_utf8(bytes).map_err(|_| MARKDOWN_READ_FAILED)?)
            }
            Some(2) => Err(MARKDOWN_MISSING.into()),
            Some(3) => Err(MARKDOWN_TOO_LARGE.into()),
            _ => Err(MARKDOWN_READ_FAILED.into()),
        }
    })
    .await
    .map_err(|_| "读取完整会话日志超时，请重试")?
}

async fn wait_stopped(
    stopped: &mut watch::Receiver<Option<Result<(), String>>>,
) -> Result<(), String> {
    loop {
        if let Some(result) = stopped.borrow_and_update().clone() {
            return result;
        }
        stopped.changed().await.map_err(|_| "Harness 进程已断开")?;
    }
}

pub(super) struct HarnessRuntime {
    #[cfg(test)]
    client: HarnessClient,
    #[cfg(test)]
    events: mpsc::Receiver<HarnessEvent>,
}

impl HarnessRuntime {
    #[cfg(test)]
    pub(super) async fn start(
        node: &Path,
        runtime_package: &Path,
        project: &Path,
        home: &Path,
        gateway: HarnessGateway,
    ) -> Result<Self, String> {
        let (client, events) =
            Self::launch(node, runtime_package, project, home, gateway, false, &[]).await?;
        Ok(Self { client, events })
    }

    pub(super) async fn start_live(
        node: &Path,
        runtime_package: &Path,
        project: &Path,
        home: &Path,
        gateway: HarnessGateway,
        plugin_patches: &[PathBuf],
    ) -> Result<(HarnessClient, mpsc::Receiver<HarnessEvent>), String> {
        Self::launch(
            node,
            runtime_package,
            project,
            home,
            gateway,
            true,
            plugin_patches,
        )
        .await
    }

    async fn launch(
        node: &Path,
        runtime_package: &Path,
        project: &Path,
        home: &Path,
        gateway: HarnessGateway,
        live: bool,
        plugin_patches: &[PathBuf],
    ) -> Result<(HarnessClient, mpsc::Receiver<HarnessEvent>), String> {
        let entry = runtime_package.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
        let profile = runtime_package.join("profile.cordis.patch.yml");
        let host_ops = runtime_package.join("host-operations.cordis.patch.yml");
        if !entry.is_file() || !profile.is_file() || live && !host_ops.is_file() {
            return Err("请先准备固定版本的 DeepSeek Harness 开发运行包".into());
        }
        let private = home.parent().ok_or("Harness 数据目录无效")?;
        let route_patch =
            serde_json::to_vec(&gateway.profile_patch).map_err(|_| "无法生成 Harness 渠道配置")?;
        let mut overlay = tempfile::Builder::new()
            .prefix("channel-")
            .suffix(".cordis.patch.yml")
            .tempfile_in(private)
            .map_err(|_| "无法创建 Harness 渠道配置")?;
        overlay
            .write_all(&route_patch)
            .map_err(|_| "无法写入 Harness 渠道配置")?;
        let mut command = Command::new(node);
        command.arg(entry).args(["--profile", "sdk"]);
        for patch in plugin_patches {
            command.arg("--patch").arg(patch);
        }
        command.arg("--patch").arg(profile);
        if live {
            command.arg("--patch").arg(host_ops);
        }
        command
            .arg("--patch")
            .arg(overlay.path())
            .current_dir(project)
            .env_clear()
            .env("DSH_HOME", home)
            .env("DSH_TELEMETRY_DISABLED", "1")
            .env(TOKEN_ENV, &gateway.token)
            .env("NO_PROXY", "127.0.0.1,localhost")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for name in [
            "HOME",
            "USERPROFILE",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "APPDATA",
            "LOCALAPPDATA",
            "COMSPEC",
            "PATHEXT",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let inherited_path = std::env::var_os("PATH").unwrap_or_default();
        let entries = node
            .parent()
            .filter(|path| path.is_absolute())
            .map(Path::to_path_buf)
            .into_iter()
            .chain(std::env::split_paths(&inherited_path));
        command.env(
            "PATH",
            std::env::join_paths(entries).map_err(|_| "Harness 运行路径无效")?,
        );
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        #[cfg(not(windows))]
        command.process_group(0);
        let mut child = command.spawn().map_err(|_| "无法启动 DeepSeek Harness")?;
        let process_tree = match ProcessTree::attach(&child) {
            Ok(tree) => tree,
            Err(_) => {
                let _ = child.kill().await;
                return Err("无法管理 DeepSeek Harness 进程树".into());
            }
        };
        let input = child.stdin.take().ok_or("Harness 没有打开输入流")?;
        let output = child.stdout.take().ok_or("Harness 没有打开输出流")?;
        let model = gateway.model.clone();
        let (outbox, writes) = mpsc::channel(REQUEST_CAPACITY);
        let (publish, events) = mpsc::channel(EVENT_CAPACITY);
        let (stop, mut should_stop) = watch::channel(false);
        let (terminated, stopped) = watch::channel(None);
        let pending = Arc::new(Requests::default());
        let client = HarnessClient {
            outbox: outbox.clone(),
            pending: pending.clone(),
            sequence: Arc::new(AtomicU64::new(1)),
            stop,
            stopped: stopped.clone(),
            shutdown_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        tokio::spawn(async move {
            let result = tokio::select! {
                result = read_frames(output, &pending, &publish, outbox, stopped) => result,
                result = write_frames(input, writes) => result,
                _ = should_stop.changed() => Err("Harness 连接已关闭".into()),
                _ = publish.closed() => Err("Harness 事件接收已关闭".into()),
            };
            // Stdout EOF follows the final response on graceful shutdown. Give
            // the child time to exit normally; faults close stdin and kill it.
            let outcome = match result {
                Ok(()) => match timeout(SHUTDOWN_TIMEOUT, child.wait()).await {
                    Ok(Ok(status)) if status.success() => Ok(()),
                    Ok(Ok(status)) => Err(status.code().map_or_else(
                        || "Harness 进程异常退出".to_owned(),
                        |code| format!("Harness 进程异常退出（{code}）"),
                    )),
                    _ => Err("Harness 进程异常退出".into()),
                },
                Err(error) => Err(error),
            };
            drop(process_tree);
            if outcome.is_err() {
                let _ = child.kill().await;
            }
            let failure = outcome
                .clone()
                .err()
                .unwrap_or_else(|| "Harness 进程已断开".into());
            for (_, waiter) in pending.lock().unwrap().drain() {
                let _ = waiter.send(Err(failure.clone()));
            }
            drop(overlay);
            drop(gateway);
            terminated.send_replace(Some(outcome));
        });
        let initialized = client
            .request(
                "initialize",
                json!({
                    "cwd": project, "provider": PROVIDER, "model": model,
                    "approvalRequests": true, "capabilities": {"userQuestions": live},
                }),
            )
            .await?;
        if initialized["serverInfo"]["name"] != "deepseek-harness-sdk-runtime" {
            return Err("DeepSeek Harness 握手身份不匹配".into());
        }
        Ok((client, events))
    }

    #[cfg(test)]
    pub(super) async fn request(
        &mut self,
        method: &str,
        params: Value,
        mut event: impl FnMut(&Value),
        mut host_request: impl FnMut(&Value) -> Option<Value>,
    ) -> Reply {
        let rpc = self.client.request(method, params);
        tokio::pin!(rpc);
        loop {
            tokio::select! {
                reply = &mut rpc => {
                    while let Ok(frame) = self.events.try_recv() {
                        legacy_callback(frame, &mut event, &mut host_request).await?;
                    }
                    return reply;
                }
                Some(frame) = self.events.recv() => {
                    legacy_callback(frame, &mut event, &mut host_request).await?;
                }
            }
        }
    }

    #[cfg(test)]
    pub(super) async fn shutdown(self) -> Result<(), String> {
        self.client.shutdown().await
    }
}

#[cfg(test)]
async fn legacy_callback(
    frame: HarnessEvent,
    event: &mut impl FnMut(&Value),
    host_request: &mut impl FnMut(&Value) -> Option<Value>,
) -> Result<(), String> {
    match frame {
        HarnessEvent::Notification(value) => event(&value),
        HarnessEvent::Request(request) => {
            let response = host_request(&json!({"jsonrpc":"2.0", "method":request.method,
                "params":request.params, "id":request.frame_id}));
            request.respond(response).await?;
        }
    }
    Ok(())
}

async fn write_frames(
    mut input: impl AsyncWrite + Unpin,
    mut writes: mpsc::Receiver<Vec<u8>>,
) -> Result<(), String> {
    while let Some(line) = writes.recv().await {
        input
            .write_all(&line)
            .await
            .map_err(|_| "Harness 输入流已关闭")?;
    }
    Err("Harness 输入流已关闭".into())
}

async fn read_frames(
    output: impl AsyncRead + Unpin,
    pending: &Requests,
    publish: &mpsc::Sender<HarnessEvent>,
    outbox: Outbox,
    stopped: watch::Receiver<Option<Result<(), String>>>,
) -> Result<(), String> {
    let mut output = BufReader::new(output);
    let host_slots = Arc::new(Semaphore::new(REQUEST_CAPACITY));
    while let Some(frame) = receive(&mut output).await? {
        if frame["jsonrpc"] != "2.0" {
            return Err("Harness 返回了无效事件".into());
        }
        if let Some(method) = frame["method"].as_str() {
            let event = if let Some(id) = frame.get("id") {
                let id = id.clone();
                let (response, answer) = oneshot::channel();
                let permit = host_slots
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| "Harness 同时等待的审批或提问过多")?;
                let (output_id, tx, mut done) = (id.clone(), outbox.clone(), stopped.clone());
                tokio::spawn(async move {
                    let _permit = permit;
                    let result = tokio::select! {
                        answer = answer => answer.ok().flatten(),
                        _ = done.changed() => return,
                    };
                    let response = match result {
                        Some(result) => json!({"jsonrpc":"2.0", "id":output_id, "result":result}),
                        None => json!({"jsonrpc":"2.0", "id":output_id, "error":{
                            "code":-32601, "message":"Unavailable host operation"}}),
                    };
                    if let Ok(line) = encode(&response) {
                        let _ = tx.send(line).await;
                    }
                });
                HarnessEvent::Request(HarnessHostRequest {
                    method: method.to_owned(),
                    params: frame["params"].clone(),
                    #[cfg(test)]
                    frame_id: id,
                    response,
                })
            } else {
                HarnessEvent::Notification(frame)
            };
            publish
                .try_send(event)
                .map_err(|_| "Harness 事件积压或接收已关闭")?;
        } else if let Some(id) = frame["id"].as_u64() {
            // Responses after a cancelled local wait must not settle another RPC.
            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                let result = if let Some(error) = frame.get("error") {
                    // SDK errors can include model or tool output. The message is
                    // used by the host caller, never logged by this transport.
                    Err(error["message"]
                        .as_str()
                        .unwrap_or("Harness 请求失败")
                        .to_owned())
                } else {
                    frame
                        .get("result")
                        .cloned()
                        .ok_or_else(|| "Harness 回执缺少结果".into())
                };
                let _ = tx.send(result);
            }
        } else {
            return Err("Harness 返回了无效回执".into());
        }
    }
    Ok(())
}

fn encode(value: &Value) -> Result<Vec<u8>, String> {
    let mut line = serde_json::to_vec(value).map_err(|_| "无法编码 Harness 请求")?;
    if line.len() >= MAX_FRAME {
        return Err("Harness 请求超过本地大小限制".into());
    }
    line.push(b'\n');
    Ok(line)
}

async fn receive(output: &mut BufReader<impl AsyncRead + Unpin>) -> Result<Option<Value>, String> {
    let mut line = Vec::new();
    loop {
        let chunk = output
            .fill_buf()
            .await
            .map_err(|_| "无法读取 Harness 事件")?;
        if chunk.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err("Harness 返回了不完整的事件".into())
            };
        }
        let end = chunk.iter().position(|byte| *byte == b'\n');
        let consumed = end.map_or(chunk.len(), |index| index + 1);
        if line.len() + consumed > MAX_FRAME {
            return Err("Harness 事件超过本地大小限制".into());
        }
        line.extend_from_slice(&chunk[..consumed]);
        output.consume(consumed);
        if end.is_some() {
            return serde_json::from_slice(&line)
                .map(Some)
                .map_err(|_| "Harness 返回了无效事件".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_size_limit_counts_utf8_bytes_without_truncating() {
        let markdown = "é".repeat(MAX_MARKDOWN / 2);
        assert_eq!(
            validate_markdown(markdown.clone()).unwrap().len(),
            MAX_MARKDOWN
        );
        assert_eq!(
            validate_markdown(markdown + "x").unwrap_err(),
            MARKDOWN_TOO_LARGE
        );
        assert!(validate_markdown(String::new()).is_err());
    }

    #[tokio::test]
    async fn a_pending_turn_does_not_block_approvals_or_a_second_rpc() {
        timeout(Duration::from_secs(5), async {
            let (host_in, mut sdk_out) = tokio::io::duplex(4096);
            let (host_out, sdk_in) = tokio::io::duplex(4096);
            let mut sdk_in = BufReader::new(sdk_in);
            let (outbox, writes) = mpsc::channel(REQUEST_CAPACITY);
            let (publish, mut events) = mpsc::channel(EVENT_CAPACITY);
            let (stop, _should_stop) = watch::channel(false);
            let (_terminated, stopped) = watch::channel(None);
            let pending = Arc::new(Requests::default());
            let client = HarnessClient {
                outbox: outbox.clone(),
                pending: pending.clone(),
                sequence: Arc::new(AtomicU64::new(1)),
                stop,
                stopped: stopped.clone(),
                shutdown_lock: Arc::new(tokio::sync::Mutex::new(())),
            };
            let reader = tokio::spawn(async move {
                read_frames(host_in, &pending, &publish, outbox, stopped).await
            });
            let writer = tokio::spawn(write_frames(host_out, writes));

            let waiting = client.clone();
            let turn = tokio::spawn(async move {
                waiting
                    .request("session/wait", json!({"sessionId":"first"}))
                    .await
            });
            let wait_frame = receive(&mut sdk_in).await.unwrap().unwrap();
            assert_eq!(wait_frame["method"], "session/wait");
            sdk_out
                .write_all(
                    &encode(&json!({"jsonrpc":"2.0", "id":"approval-1",
                "method":"approval/request", "params":{"sessionId":"first", "toolName":"write"}}))
                    .unwrap(),
                )
                .await
                .unwrap();
            let Some(HarnessEvent::Request(approval)) = events.recv().await else {
                panic!("expected an approval while the turn was waiting");
            };
            assert_eq!(approval.method, "approval/request");
            assert_eq!(approval.params["sessionId"], "first");

            let stopping = client.clone();
            let other = tokio::spawn(async move { stopping.cancel("second").await });
            let stop_frame = receive(&mut sdk_in).await.unwrap().unwrap();
            assert_eq!(stop_frame["method"], "lolicode/session/cancel");
            assert_eq!(stop_frame["params"]["sessionId"], "second");
            sdk_out
                .write_all(
                    &encode(&json!({"jsonrpc":"2.0", "id":stop_frame["id"],
                "result":{}}))
                    .unwrap(),
                )
                .await
                .unwrap();
            other.await.unwrap().unwrap();

            let exporting = client.clone();
            let export = tokio::spawn(async move {
                exporting
                    .read_session_markdown("first", Some("worker"))
                    .await
            });
            let export_frame = receive(&mut sdk_in).await.unwrap().unwrap();
            assert_eq!(export_frame["method"], "lolicode/session/read-markdown");
            assert_eq!(
                export_frame["params"],
                json!({"sessionId":"first","childSessionId":"worker"})
            );
            sdk_out
                .write_all(
                    &encode(&json!({"jsonrpc":"2.0", "id":export_frame["id"],
                    "result":"# Worker

Committed log
"}))
                    .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                export.await.unwrap().unwrap().as_deref(),
                Some(
                    "# Worker

Committed log
"
                )
            );
            assert!(!turn.is_finished());

            approval
                .respond(Some(json!({"outcome":"allowed-once"})))
                .await
                .unwrap();
            let approved = receive(&mut sdk_in).await.unwrap().unwrap();
            assert_eq!(approved["id"], "approval-1");
            assert_eq!(approved["result"]["outcome"], "allowed-once");
            sdk_out
                .write_all(
                    &encode(&json!({"jsonrpc":"2.0", "id":"approval-2",
                "method":"approval/request", "params":{"sessionId":"first", "toolName":"write"}}))
                    .unwrap(),
                )
                .await
                .unwrap();
            let Some(HarnessEvent::Request(refused)) = events.recv().await else {
                panic!("expected the second approval");
            };
            drop(refused);
            let refused = receive(&mut sdk_in).await.unwrap().unwrap();
            assert_eq!(refused["id"], "approval-2");
            assert_eq!(refused["error"]["code"], -32601);

            sdk_out
                .write_all(
                    &encode(&json!({"jsonrpc":"2.0", "method":"session.status",
                "params":{"sessionId":"first", "status":"idle"}}))
                    .unwrap(),
                )
                .await
                .unwrap();
            sdk_out
                .write_all(
                    &encode(&json!({"jsonrpc":"2.0", "id":wait_frame["id"],
                "result":{}}))
                    .unwrap(),
                )
                .await
                .unwrap();
            let Some(HarnessEvent::Notification(status)) = events.recv().await else {
                panic!("expected the terminal session notification");
            };
            assert_eq!(status["params"]["status"], "idle");
            assert_eq!(turn.await.unwrap().unwrap(), json!({}));

            sdk_out.shutdown().await.unwrap();
            reader.await.unwrap().unwrap();
            drop(client);
            assert!(writer.await.unwrap().is_err());
        })
        .await
        .expect("stdio flow was blocked");
    }
}
