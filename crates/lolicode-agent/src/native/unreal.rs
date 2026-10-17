//! Authenticated localhost bridge for the optional UnrealAgentLink editor plugin.
//!
//! The editor plugin opens the WebSocket connection to us. A short pairing token
//! is carried in the launch-only `-UALServer` URL and is never exposed to the UI
//! or model. We bind loopback only and route requests to the project that paired.

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, OnceCell, RwLock},
    time::timeout,
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        Message,
    },
};
use uuid::Uuid;

pub const BRIDGE_PORT: u16 = 17_861;
const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrealBridgeStatus {
    pub listening: bool,
    pub port: u16,
    pub error: Option<String>,
    pub editors: Vec<UnrealEditorConnection>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrealEditorConnection {
    pub project_path: String,
    pub project_name: String,
    pub engine_version: Option<String>,
    pub connected_at: u64,
    pub last_seen_at: u64,
}

struct Pairing {
    project_path: String,
    expires_at: u64,
}

struct Client {
    project_path: String,
    project_name: String,
    engine_version: Option<String>,
    connected_at: u64,
    last_seen_at: u64,
    verified: bool,
    tx: mpsc::UnboundedSender<Message>,
}

struct Bridge {
    pairings: Mutex<HashMap<String, Pairing>>,
    clients: RwLock<HashMap<String, Client>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl Bridge {
    fn new() -> Self {
        Self {
            pairings: Mutex::new(HashMap::new()),
            clients: RwLock::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
        }
    }
}

fn runtime() -> &'static OnceCell<Arc<Bridge>> {
    static RUNTIME: OnceCell<Arc<Bridge>> = OnceCell::const_new();
    &RUNTIME
}

fn startup_error() -> &'static Mutex<Option<String>> {
    static ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    ERROR.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn canonical_path(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|_| "虚幻项目路径无法访问")?;
    if !canonical.is_dir()
        && !(canonical.is_file()
            && canonical
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("uproject")))
    {
        return Err("虚幻项目必须是本机文件夹或 .uproject 文件".into());
    }
    Ok(canonical)
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

/// Bind one authenticated editor launch to the selected project and return its
/// ephemeral URL. The project path is checked again when the plugin announces
/// `project.info` before any agent tool can target the editor.
pub async fn prepare_editor_launch(project_path: &Path) -> Result<(String, String), String> {
    ensure_started().await?;
    let canonical = canonical_path(project_path)?;
    let project_file =
        find_project_file(&canonical).ok_or("所选路径中找不到唯一的 .uproject 文件")?;
    let project_path = project_file.to_string_lossy().into_owned();
    let token = Uuid::new_v4().simple().to_string();
    let bridge = runtime().get().ok_or("虚幻编辑器桥尚未启动")?;
    bridge
        .pairings
        .lock()
        .map_err(|_| "虚幻编辑器配对状态不可用")?
        .insert(
            token.clone(),
            Pairing {
                project_path: path_key(Path::new(&project_path)),
                expires_at: now_ms()
                    .saturating_add(Duration::from_secs(10 * 60).as_millis() as u64),
            },
        );
    Ok((
        token.clone(),
        format!("ws://127.0.0.1:{BRIDGE_PORT}?token={token}"),
    ))
}

pub fn cancel_editor_launch(token: &str) {
    if let Some(bridge) = runtime().get() {
        if let Ok(mut pairings) = bridge.pairings.lock() {
            pairings.remove(token);
        }
    }
}

pub fn find_project_file(root: &Path) -> Option<PathBuf> {
    if root.is_file() {
        return root
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("uproject"))
            .then(|| root.to_path_buf());
    }
    let mut projects = std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("uproject"))
        })
        .take(2);
    let only = projects.next()?;
    projects.next().is_none().then_some(only)
}

pub async fn ensure_started() -> Result<(), String> {
    runtime()
        .get_or_try_init(|| async {
            let address = SocketAddr::from(([127, 0, 0, 1], BRIDGE_PORT));
            let listener = TcpListener::bind(address).await.map_err(|error| {
                let message = format!(
                    "本机虚幻桥端口 {BRIDGE_PORT} 无法监听（{error}）；请关闭占用该端口的程序后重试"
                );
                if let Ok(mut stored) = startup_error().lock() {
                    *stored = Some(message.clone());
                }
                message
            })?;
            let bridge = Arc::new(Bridge::new());
            let server_bridge = bridge.clone();
            tokio::spawn(async move {
                loop {
                    match listener.accept().await {
                        Ok((stream, _)) => {
                            let state = server_bridge.clone();
                            tokio::spawn(async move {
                                let _ = serve_connection(state, stream).await;
                            });
                        }
                        Err(error) => {
                            if let Ok(mut stored) = startup_error().lock() {
                                *stored = Some(format!("虚幻编辑器桥监听中断：{error}"));
                            }
                            tokio::time::sleep(Duration::from_millis(250)).await;
                        }
                    }
                }
            });
            Ok::<Arc<Bridge>, String>(bridge)
        })
        .await
        .map(|_| ())
}

fn requested_token(request: &Request) -> Option<String> {
    request.uri().query()?.split('&').find_map(|part| {
        let (name, value) = part.split_once('=')?;
        (name == "token" && !value.is_empty() && value.len() <= 128).then(|| value.to_string())
    })
}

async fn serve_connection(bridge: Arc<Bridge>, stream: TcpStream) -> Result<(), String> {
    let accepted_token = Arc::new(Mutex::new(None::<String>));
    let token_for_handshake = accepted_token.clone();
    let bridge_for_handshake = bridge.clone();
    let socket = accept_hdr_async(
        stream,
        move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
            let Some(token) = requested_token(request) else {
                return Err(handshake_error(401, "Missing editor pairing token"));
            };
            let valid = bridge_for_handshake
                .pairings
                .lock()
                .ok()
                .is_some_and(|mut pairings| {
                    let now = now_ms();
                    pairings.retain(|_, pairing| pairing.expires_at > now);
                    pairings.contains_key(&token)
                });
            if !valid {
                return Err(handshake_error(403, "Invalid editor pairing token"));
            }
            if let Ok(mut accepted) = token_for_handshake.lock() {
                *accepted = Some(token);
            }
            Ok(response)
        },
    )
    .await
    .map_err(|_| "虚幻编辑器 WebSocket 握手失败".to_string())?;
    let token = accepted_token
        .lock()
        .map_err(|_| "虚幻编辑器配对状态不可用")?
        .clone()
        .ok_or("虚幻编辑器配对令牌丢失")?;
    let expected_project = bridge
        .pairings
        .lock()
        .map_err(|_| "虚幻编辑器配对状态不可用")?
        .get(&token)
        .map(|pairing| pairing.project_path.clone())
        .ok_or("虚幻编辑器配对已过期")?;

    let connection_id = Uuid::new_v4().simple().to_string();
    let (mut sink, mut source) = socket.split();
    let (tx, mut outgoing) = mpsc::unbounded_channel::<Message>();
    let mut verified = false;
    let connection = async {
        loop {
            tokio::select! {
                outbound = outgoing.recv() => {
                    let Some(message) = outbound else { break; };
                    sink.send(message).await.map_err(|_| "发送虚幻编辑器请求失败")?;
                }
                incoming = source.next() => {
                    let Some(incoming) = incoming else { break; };
                    let message = incoming.map_err(|_| "读取虚幻编辑器响应失败")?;
                    match message {
                        Message::Text(text) => {
                            if text.len() > MAX_FRAME_BYTES { return Err("虚幻编辑器响应超过 2 MiB".into()); }
                            let value: Value = serde_json::from_str(&text).map_err(|_| "虚幻编辑器响应格式无效")?;
                            match value["type"].as_str() {
                                Some("evt") if value["method"] == "project.info" => {
                                    let payload = &value["payload"];
                                    let path = payload["projectPath"].as_str().unwrap_or_default();
                                    let current_key = if path.is_empty() { String::new() } else { path_key(Path::new(path)) };
                                    if current_key != expected_project {
                                        return Err("已拒绝与配对工程不一致的编辑器连接".into());
                                    }
                                    let project_name = payload["projectName"].as_str().filter(|value| !value.is_empty()).unwrap_or("Unreal Project").to_string();
                                    let engine_version = payload["engineVersion"].as_str().map(str::to_string);
                                    bridge.clients.write().await.insert(connection_id.clone(), Client {
                                        project_path: expected_project.clone(),
                                        project_name,
                                        engine_version,
                                        connected_at: now_ms(),
                                        last_seen_at: now_ms(),
                                        verified: true,
                                        tx: tx.clone(),
                                    });
                                    if let Ok(mut pairings) = bridge.pairings.lock() {
                                        pairings.remove(&token);
                                    }
                                    verified = true;
                                }
                                Some("evt") if value["method"] == "project.closed" => break,
                                Some("evt") if value["method"] == "system.heartbeat" => {
                                    if let Some(client) = bridge.clients.write().await.get_mut(&connection_id) {
                                        client.last_seen_at = now_ms();
                                    }
                                }
                                Some("res") => {
                                    let Some(id) = value["id"].as_str() else { continue; };
                                    let response = if value["code"].as_i64().unwrap_or(500) < 400 {
                                        Ok(value.get("result").cloned().unwrap_or(Value::Null))
                                    } else {
                                        Err(value["result"]["message"].as_str().unwrap_or("虚幻编辑器执行失败").to_string())
                                    };
                                    if let Ok(mut pending) = bridge.pending.lock() {
                                        if let Some(sender) = pending.remove(id) { let _ = sender.send(response); }
                                    }
                                }
                                _ => {}
                            }
                        }
                        Message::Ping(payload) => {
                            sink.send(Message::Pong(payload)).await.map_err(|_| "虚幻编辑器心跳响应失败")?;
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            }
        }
        Ok::<(), String>(())
    }.await;
    bridge.clients.write().await.remove(&connection_id);
    if !verified {
        if let Ok(mut pairings) = bridge.pairings.lock() {
            pairings.remove(&token);
        }
    }
    connection
}

fn handshake_error(status: u16, reason: &str) -> ErrorResponse {
    tokio_tungstenite::tungstenite::http::Response::builder()
        .status(status)
        .body(Some(reason.to_string()))
        .expect("valid WebSocket handshake error response")
}

pub async fn status() -> UnrealBridgeStatus {
    let error = startup_error()
        .lock()
        .ok()
        .and_then(|stored| stored.clone());
    let Some(bridge) = runtime().get() else {
        return UnrealBridgeStatus {
            listening: false,
            port: BRIDGE_PORT,
            error,
            editors: vec![],
        };
    };
    let mut editors: Vec<_> = bridge
        .clients
        .read()
        .await
        .values()
        .filter(|client| client.verified)
        .map(|client| UnrealEditorConnection {
            project_path: client.project_path.clone(),
            project_name: client.project_name.clone(),
            engine_version: client.engine_version.clone(),
            connected_at: client.connected_at,
            last_seen_at: client.last_seen_at,
        })
        .collect();
    editors.sort_by(|left, right| left.project_path.cmp(&right.project_path));
    UnrealBridgeStatus {
        listening: true,
        port: BRIDGE_PORT,
        error,
        editors,
    }
}

pub async fn has_connection_for_project(project: &Path) -> bool {
    let Some(bridge) = runtime().get() else {
        return false;
    };
    let Ok(project) = canonical_path(project) else {
        return false;
    };
    let Some(file) = find_project_file(&project) else {
        return false;
    };
    let key = path_key(&file);
    bridge
        .clients
        .read()
        .await
        .values()
        .any(|client| client.verified && client.project_path == key)
}

pub fn method_is_allowed(method: &str) -> bool {
    matches!(
        method,
        "system.get_project_info"
            | "system.get_editor_health"
            | "level.get_current"
            | "level.list"
            | "actor.get_info"
            | "actor.inspect"
            | "actor.spawn"
            | "actor.set_transform"
            | "actor.set_property"
            | "actor.destroy"
            | "level.save"
            | "level.open"
            | "level.new"
            | "blueprint.describe"
            | "blueprint.compile"
    )
}

pub fn method_is_mutating(method: &str) -> bool {
    matches!(
        method,
        "actor.spawn"
            | "actor.set_transform"
            | "actor.set_property"
            | "actor.destroy"
            | "level.save"
            | "level.open"
            | "level.new"
            | "blueprint.compile"
    )
}

pub fn schemas() -> Vec<Value> {
    vec![json!({
        "type":"function",
        "function":{
            "name":"unreal_editor_command",
            "description":"Call an explicitly supported Unreal Editor command through the paired UnrealAgentLink plugin. Read-only commands inspect project/editor/level/actors. Changes to actors, levels or Blueprints require the configured project permission and should be verified with a read-back command.",
            "parameters":{
                "type":"object",
                "properties":{
                    "method":{"type":"string","enum":[
                        "system.get_project_info","system.get_editor_health","level.get_current","level.list","actor.get_info","actor.inspect","actor.spawn","actor.set_transform","actor.set_property","actor.destroy","level.save","level.open","level.new","blueprint.describe","blueprint.compile"
                    ]},
                    "params":{"type":"object","description":"Arguments for the selected UnrealAgentLink command. Use the command's documented parameter names and do not include unrelated fields."}
                },
                "required":["method"],
                "additionalProperties":false
            }
        }
    })]
}

pub async fn request(
    project: &Path,
    method: &str,
    params: &Value,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<Value, String> {
    if !method_is_allowed(method) {
        return Err("当前版本尚未开放这条 UnrealAgentLink 命令".into());
    }
    if !params.is_object()
        || serde_json::to_vec(params)
            .map_err(|_| "虚幻参数无法编码")?
            .len()
            > 64 * 1024
    {
        return Err("虚幻编辑器参数必须是 64 KiB 以内的 JSON 对象".into());
    }
    let canonical = canonical_path(project)?;
    let project_file = find_project_file(&canonical).ok_or("当前 Agent 工程不是 Unreal 工程")?;
    let key = path_key(&project_file);
    let bridge = runtime()
        .get()
        .ok_or("本机虚幻桥没有启动，请在虚幻工作区打开项目")?;
    let (connection_id, tx) = {
        let clients = bridge.clients.read().await;
        clients
            .iter()
            .find(|(_, client)| client.verified && client.project_path == key)
            .map(|(id, client)| (id.clone(), client.tx.clone()))
            .ok_or("当前项目没有连接的 Unreal Editor；请从虚幻工作区启动并确认工程已启用 UnrealAgentLink")?
    };
    let id = Uuid::new_v4().simple().to_string();
    let (reply, receive) = oneshot::channel();
    bridge
        .pending
        .lock()
        .map_err(|_| "虚幻请求状态暂不可用")?
        .insert(id.clone(), reply);
    let message = Message::Text(
        json!({
            "ver":"1.0","type":"req","id":id,"method":method,"params":params
        })
        .to_string(),
    );
    if tx.send(message).is_err() {
        bridge
            .pending
            .lock()
            .ok()
            .map(|mut pending| pending.remove(&id));
        return Err("Unreal Editor 已断开，请重新连接后再试；没有自动重放本次操作".into());
    }
    let response = tokio::select! {
        result = timeout(REQUEST_TIMEOUT, receive) => match result {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => Err("Unreal Editor 在响应前断开；操作结果未确认，请先检查编辑器状态".into()),
            Err(_) => Err("Unreal Editor 命令超时；操作结果未确认，请先检查编辑器状态".into()),
        },
        changed = cancel.changed() => {
            let _ = changed;
            Err("任务已停止；编辑器命令可能已经开始，请先检查编辑器状态再重试".into())
        }
    };
    bridge
        .pending
        .lock()
        .ok()
        .map(|mut pending| pending.remove(&id));
    let _ = connection_id;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_allowlist_keeps_arbitrary_code_execution_out() {
        for method in [
            "cmd.run_python",
            "system.run_console_command",
            "editor.quit",
            "system.manage_plugin",
        ] {
            assert!(!method_is_allowed(method), "{method} must stay unavailable");
        }
        for method in [
            "level.get_current",
            "actor.inspect",
            "level.save",
            "actor.set_transform",
        ] {
            assert!(method_is_allowed(method));
        }
    }

    #[test]
    fn mutations_are_distinguished_for_agent_approval() {
        assert!(!method_is_mutating("level.get_current"));
        assert!(method_is_mutating("actor.set_transform"));
        assert!(method_is_mutating("level.save"));
    }

    #[test]
    fn project_file_lookup_accepts_a_file_and_rejects_ambiguous_directories() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("Game.uproject");
        std::fs::write(&project, "{}").unwrap();
        assert_eq!(
            find_project_file(&project).as_deref(),
            Some(project.as_path())
        );
        assert_eq!(
            find_project_file(temp.path()).as_deref(),
            Some(project.as_path())
        );

        let second = temp.path().join("Editor.uproject");
        std::fs::write(second, "{}").unwrap();
        assert!(find_project_file(temp.path()).is_none());
    }
}
