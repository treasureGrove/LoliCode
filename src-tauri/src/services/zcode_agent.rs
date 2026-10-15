//! Owned ZCode worker carrier. Its bearer and gateway credential stay on the host.
use super::{
    agent::{
        canonical_project, prepare_catalog_for_accounts, AgentOpenProject, AgentRuntimeStatus,
        AgentWorkspace,
    },
    agent_preferences as preferences,
    channel_center::{self, AgentCatalog},
};
use crate::store::AppState;
use lolicode_agent::{AgentModelRef, AgentSession};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, MutexGuard, RwLock},
    time::timeout,
};

#[derive(Default)]
pub struct ZcodeAgentState {
    lifecycle: Mutex<()>,
    worker: RwLock<Option<Arc<NativeWorker>>>,
    binding: RwLock<Option<Binding>>,
}
pub struct NativeUpdateLease<'a> {
    _guard: MutexGuard<'a, ()>,
    worker: Option<Arc<NativeWorker>>,
}
impl Drop for NativeUpdateLease<'_> {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            tauri::async_runtime::spawn(async move {
                let _ = worker.call::<()>("endUpdate", json!({})).await;
            });
        }
    }
}
struct Binding {
    workspace: AgentWorkspace,
    catalog: AgentCatalog,
    gateway: Value,
}
struct NativeWorker {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    client: reqwest::Client,
    endpoint: String,
    token: String,
    secrets: Mutex<Vec<String>>,
    running: AtomicBool,
    #[cfg(test)]
    detached: bool,
}

pub fn runtime_files(app: &tauri::AppHandle) -> Option<(PathBuf, PathBuf)> {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let installed = app.path().resource_dir().ok()?.join("zcode-runtime");
    let candidates = [
        Some(installed),
        if cfg!(debug_assertions) {
            Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/zcode-runtime"))
        } else {
            None
        },
    ];
    candidates.into_iter().flatten().find_map(|root| {
        let node = root.join(executable);
        let worker = root.join("worker.cjs");
        (node.is_file() && worker.is_file()).then_some((node, worker))
    })
}

impl NativeWorker {
    async fn spawn(node: &Path, script: &Path, root: &Path) -> Result<Arc<Self>, String> {
        for folder in ["home", "tmp", "config", "cache", "data"] {
            tokio::fs::create_dir_all(root.join(folder))
                .await
                .map_err(|_| "无法创建 ZCode 私有运行目录")?;
        }
        let root = canonical_project(&root.to_string_lossy())?;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut command = Command::new(node);
        command
            .arg(script)
            .arg("--private-root")
            .arg(&root)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_clear();
        for (key, value) in std::env::vars_os() {
            if matches!(
                key.to_string_lossy().to_ascii_uppercase().as_str(),
                "PATH"
                    | "PATHEXT"
                    | "SYSTEMROOT"
                    | "WINDIR"
                    | "COMSPEC"
                    | "SYSTEMDRIVE"
                    | "PROGRAMFILES"
                    | "PROGRAMFILES(X86)"
                    | "PROGRAMW6432"
                    | "LANG"
                    | "LC_ALL"
                    | "LC_CTYPE"
                    | "SHELL"
            ) {
                command.env(key, value);
            }
        }
        command
            .env("HOME", root.join("home"))
            .env("USERPROFILE", root.join("home"))
            .env("APPDATA", root.join("home/AppData/Roaming"))
            .env("LOCALAPPDATA", root.join("home/AppData/Local"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_CACHE_HOME", root.join("cache"))
            .env("XDG_DATA_HOME", root.join("data"))
            .env("TMP", root.join("tmp"))
            .env("TEMP", root.join("tmp"))
            .env("TMPDIR", root.join("tmp"));
        // Preserve the authorized SSH configuration path, never its contents.
        if let Some(home) = dirs::home_dir() {
            command.env("LOLICODE_SSH_CONFIG_PATH", home.join(".ssh/config"));
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动应用附带的 ZCode 服务")?;
        let mut stdin = child.stdin.take().ok_or("ZCode 启动通道不可用")?;
        let stdout = child.stdout.take().ok_or("ZCode 状态通道不可用")?;
        if let Some(mut stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                while matches!(stderr.read(&mut buffer).await, Ok(n) if n > 0) {}
            });
        }
        let mut boot = serde_json::to_vec(&json!({"token":token,"privateRoot":root}))
            .map_err(|_| "ZCode 启动信息无法编码")?;
        boot.push(b'\n');
        stdin
            .write_all(&boot)
            .await
            .map_err(|_| "无法初始化 ZCode 服务")?;
        stdin.flush().await.map_err(|_| "无法初始化 ZCode 服务")?;
        let mut stdout = BufReader::new(stdout);
        let mut line = String::new();
        timeout(Duration::from_secs(60), stdout.read_line(&mut line))
            .await
            .map_err(|_| "ZCode 启动超时，请重试")?
            .map_err(|_| "无法读取 ZCode 启动状态")?;
        if line.len() > 16384 {
            return Err("ZCode 启动响应无效".into());
        }
        let ready: Value = serde_json::from_str(&line).map_err(|_| "ZCode 启动响应无效")?;
        let port = ready["port"]
            .as_u64()
            .filter(|port| *port > 0 && *port <= u16::MAX as u64)
            .ok_or("ZCode 没有返回有效本地端口")?;
        if ready["event"] != "ready" {
            return Err("ZCode 尚未准备就绪".into());
        }
        tokio::spawn(async move {
            let mut buffer = [0u8; 4096];
            while matches!(stdout.read(&mut buffer).await, Ok(n) if n > 0) {}
        });
        Ok(Arc::new(Self {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            client: reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(|_| "无法创建本地服务连接")?,
            endpoint: format!("http://127.0.0.1:{port}/rpc"),
            token,
            secrets: Mutex::new(Vec::new()),
            running: AtomicBool::new(true),
            #[cfg(test)]
            detached: false,
        }))
    }

    fn is_running(&self) -> bool {
        if !self.running.load(Ordering::Acquire) {
            return false;
        }
        #[cfg(test)]
        if self.detached {
            return true;
        }
        if let Ok(mut child) = self.child.try_lock() {
            if child
                .as_mut()
                .is_none_or(|child| !matches!(child.try_wait(), Ok(None)))
            {
                self.running.store(false, Ordering::Release);
                return false;
            }
        }
        true
    }

    async fn redact(&self, mut value: Value) -> Value {
        let mut secrets = self.secrets.lock().await.clone();
        secrets.push(self.token.clone());
        secrets.push(self.endpoint.clone());
        fn walk(value: &mut Value, secrets: &[String]) {
            match value {
                Value::String(text) => {
                    for secret in secrets.iter().filter(|v| !v.is_empty()) {
                        *text = text.replace(secret, "[已隐藏]");
                    }
                }
                Value::Array(items) => {
                    for item in items {
                        walk(item, secrets);
                    }
                }
                Value::Object(items) => {
                    for (key, item) in items {
                        if matches!(
                            key.to_ascii_lowercase().replace(['_', '-'], "").as_str(),
                            "apikey"
                                | "password"
                                | "token"
                                | "accesstoken"
                                | "refreshtoken"
                                | "authorization"
                                | "clientsecret"
                                | "bearertoken"
                        ) && !item.is_null()
                        {
                            *item = json!("[已隐藏]");
                        } else {
                            walk(item, secrets);
                        }
                    }
                }
                _ => {}
            }
        }
        walk(&mut value, &secrets);
        value
    }

    async fn call<T: DeserializeOwned>(&self, method: &str, args: Value) -> Result<T, String> {
        if !self.is_running() {
            return Err("ZCode 服务已退出，请重新打开项目".into());
        }
        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.token)
            .json(&json!({"method":method,"args":args}))
            .send()
            .await
            .map_err(|_| "无法连接 ZCode 服务，请检查任务状态后重试")?;
        if !response.status().is_success() {
            return Err(format!(
                "ZCode 本地服务请求失败（{}）",
                response.status().as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size > 64 * 1024 * 1024)
        {
            return Err("ZCode 返回的数据过大".into());
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "无法读取 ZCode 服务响应")?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("ZCode 返回的数据过大".into());
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "ZCode 服务返回了无法识别的响应")?;
        let value = self.redact(value).await;
        if value["ok"] != true {
            return Err(value["error"]
                .as_str()
                .unwrap_or("ZCode 操作未完成，请重试")
                .chars()
                .take(1000)
                .collect());
        }
        serde_json::from_value(value["result"].clone())
            .map_err(|_| "ZCode 服务返回的数据格式不兼容".into())
    }

    async fn shutdown(&self) -> Result<(), String> {
        let _ = timeout(
            Duration::from_secs(2),
            self.call::<Value>("shutdown", json!({})),
        )
        .await;
        self.running.store(false, Ordering::Release);
        self.stdin.lock().await.take();
        if let Some(mut child) = self.child.lock().await.take() {
            if !matches!(
                timeout(Duration::from_secs(5), child.wait()).await,
                Ok(Ok(_))
            ) {
                child.kill().await.map_err(|_| "无法结束 ZCode 私有服务")?;
                let _ = child.wait().await;
            }
        }
        Ok(())
    }
}

impl ZcodeAgentState {
    pub async fn ensure_started(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self
            .worker
            .read()
            .await
            .as_ref()
            .is_some_and(|worker| worker.is_running())
        {
            return Ok(());
        }
        let _guard = self.lifecycle.lock().await;
        self.start_locked(app).await.map(|_| ())
    }
    async fn start_locked(&self, app: &tauri::AppHandle) -> Result<Arc<NativeWorker>, String> {
        if let Some(worker) = self
            .worker
            .read()
            .await
            .as_ref()
            .filter(|w| w.is_running())
            .cloned()
        {
            return Ok(worker);
        }
        let old = self.worker.write().await.take();
        if let Some(old) = old {
            let _ = old.shutdown().await;
        }
        let (node, script) = runtime_files(app)
            .ok_or("未找到应用附带的 ZCode 服务，请重新安装完整 LoliCode 安装包")?;
        let root = crate::config::get_app_config_dir().join("agent/zcode");
        let worker = NativeWorker::spawn(&node, &script, &root).await?;
        *self.worker.write().await = Some(worker.clone());
        Ok(worker)
    }
    async fn connected(&self) -> Result<Arc<NativeWorker>, String> {
        self.worker
            .read()
            .await
            .as_ref()
            .filter(|w| w.is_running())
            .cloned()
            .ok_or_else(|| "ZCode 服务尚未启动，请重新打开项目".into())
    }
    pub async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        args: Value,
        mutation: bool,
    ) -> Result<T, String> {
        let _guard = if mutation {
            Some(self.lifecycle.lock().await)
        } else {
            None
        };
        self.connected().await?.call(method, args).await
    }
    pub async fn status(&self, app: &tauri::AppHandle) -> Result<AgentRuntimeStatus, String> {
        self.ensure_started(app).await?;
        self.call("status", json!({}), false).await
    }
    pub async fn catalog(&self, state: &AppState) -> Result<AgentCatalog, String> {
        if let Some(binding) = self.binding.read().await.as_ref() {
            return Ok(binding.catalog.clone());
        }
        channel_center::agent_catalog(&state.db).map_err(|e| e.to_string())
    }
    pub async fn workspace_path(&self) -> Option<String> {
        self.binding
            .read()
            .await
            .as_ref()
            .map(|b| b.workspace.path.clone())
    }
    pub async fn open_project(
        &self,
        app: &tauri::AppHandle,
        state: &AppState,
        path: String,
        accounts: Vec<(String, String)>,
        refresh: bool,
    ) -> Result<AgentOpenProject, String> {
        let path = tokio::task::spawn_blocking(move || canonical_project(&path))
            .await
            .map_err(|_| "项目目录检查失败")??;
        let _guard = self.lifecycle.lock().await;
        let worker = self.start_locked(app).await?;
        let busy = worker.call::<bool>("busy", json!({})).await?;
        if refresh && busy {
            return Err("还有任务在执行，请结束后再重新载入模型与扩展".into());
        }
        let leased = self
            .binding
            .read()
            .await
            .as_ref()
            .map(|b| (b.catalog.clone(), b.gateway.clone()));
        let (catalog, gateway) = if busy {
            leased.ok_or("ZCode 有后台任务，但缺少本次目录绑定；请先结束任务再打开项目")?
        } else {
            let prepared = prepare_catalog_for_accounts(state, &accounts).await?;
            let settings = &prepared.config["providers"]["lolicode"]["settings"];
            let base = settings["baseURL"].as_str().ok_or("本地渠道地址缺失")?;
            let token = settings["apiKey"].as_str().ok_or("本地渠道凭据缺失")?;
            worker.secrets.lock().await.push(token.into());
            worker.secrets.lock().await.push(base.into());
            (
                prepared.catalog,
                json!({"baseUrl":base,"bearerToken":token}),
            )
        };
        let mut result: AgentOpenProject = worker
            .call(
                "openProject",
                json!({"path":path,"catalog":catalog,"gateway":gateway}),
            )
            .await?;
        if preferences::path_key(&result.workspace.path)
            != preferences::path_key(&path.to_string_lossy())
        {
            return Err("ZCode 返回的项目与所选文件夹不一致".into());
        }
        let mut navigation = preferences::load(&state.db)?;
        let key = preferences::path_key(&result.workspace.path);
        let pinned = navigation.projects.get(&key).is_some_and(|p| p.pinned);
        navigation.projects.insert(
            key,
            preferences::AgentProject {
                path: result.workspace.path.clone(),
                name: result.workspace.name.clone(),
                pinned,
                last_opened_at: chrono::Utc::now().timestamp_millis() as u64,
            },
        );
        preferences::save(&state.db, &navigation)?;
        for session in &mut result.sessions {
            preferences::decorate(&navigation, session);
        }
        *self.binding.write().await = Some(Binding {
            workspace: result.workspace.clone(),
            catalog,
            gateway,
        });
        Ok(result)
    }
    pub async fn busy(&self) -> Result<bool, String> {
        let worker = self.worker.read().await.as_ref().cloned();
        match worker {
            Some(worker) => worker.call("busy", json!({})).await,
            None => Ok(false),
        }
    }
    pub async fn acquire_idle_for_update(&self) -> Result<NativeUpdateLease<'_>, String> {
        let guard = self.lifecycle.lock().await;
        let worker = self.worker.read().await.as_ref().cloned();
        if let Some(worker) = &worker {
            // A native barrier pauses scheduler/remote admission before its
            // authoritative activity check. The Rust mutex only gates IPC.
            if let Err(error) = worker.call::<()>("beginUpdate", json!({})).await {
                // An ACK can be lost after the native barrier was installed.
                // Idempotent release leaves an unsuccessful update retryable.
                let _ = worker.call::<()>("endUpdate", json!({})).await;
                return Err(error);
            }
        }
        Ok(NativeUpdateLease {
            _guard: guard,
            worker,
        })
    }
    pub(crate) async fn acquire_idle_for_navigation(&self) -> Result<MutexGuard<'_, ()>, String> {
        let guard = self.lifecycle.lock().await;
        if self.busy().await? {
            return Err("还有编程、工作流或远程任务等待处理，请先结束任务".into());
        }
        Ok(guard)
    }
    pub async fn close_project(&self) -> Result<(), String> {
        let _guard = self.lifecycle.lock().await;
        if self.busy().await? {
            return Err("还有任务或交互等待处理，请先结束后关闭项目".into());
        }
        if let Some(worker) = self.worker.read().await.as_ref().cloned() {
            worker.call::<()>("closeProject", json!({})).await?;
        }
        self.binding.write().await.take();
        Ok(())
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        let worker = self.worker.write().await.take();
        self.binding.write().await.take();
        if let Some(worker) = worker {
            worker.shutdown().await?;
        }
        Ok(())
    }
}

/// Metadata-only view of the old owned engine database. Opening a new ZCode
/// workspace never launches the old engine or resumes an old shutdown claim.
pub fn legacy_sessions(root: &Path, project: Option<&str>) -> Result<Vec<AgentSession>, String> {
    let path = root.join("data/lolicode-agent.db");
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| "旧会话记录无法只读打开，原文件已保留")?;
    let mut query = db
        .prepare("SELECT data FROM session LIMIT 10001")
        .map_err(|_| "旧会话记录格式不兼容，原文件已保留")?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "旧会话记录无法读取")?;
    let mut sessions = Vec::new();
    for (index, row) in rows.enumerate() {
        if index >= 10000 {
            return Err("旧会话数量超出读取范围，请先使用旧引擎整理历史".into());
        }
        let raw = row.map_err(|_| "旧会话记录无法读取")?;
        let value: Value =
            serde_json::from_str(&raw).map_err(|_| "旧会话记录无法解析，原文件已保留")?;
        let Some(id) = value["id"].as_str().filter(|id| id.starts_with("ses_")) else {
            continue;
        };
        let Some(directory) = value["location"]["directory"].as_str() else {
            continue;
        };
        if project.is_some_and(|project| {
            preferences::path_key(project) != preferences::path_key(directory)
        }) {
            continue;
        }
        let model = value.get("model").and_then(|model| {
            Some(AgentModelRef {
                provider_id: model["providerID"].as_str()?.into(),
                model_id: model["id"].as_str()?.into(),
            })
        });
        sessions.push(AgentSession {
            id: id.into(),
            title: value["title"].as_str().unwrap_or("旧会话").into(),
            project_path: directory.into(),
            mode: value["agent"].as_str().unwrap_or("build").into(),
            permission_mode: "custom".into(),
            pinned: false,
            archived: false,
            model,
            created_at: value["time"]["created"].as_u64().unwrap_or(0),
            updated_at: value["time"]["updated"].as_u64().unwrap_or(0),
        });
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
    type Requests = Arc<Mutex<Vec<(String, Value)>>>;
    async fn fixture(reply: Value) -> (Arc<NativeWorker>, Requests, tokio::task::JoinHandle<()>) {
        async fn rpc(
            State((reply, requests)): State<(Value, Requests)>,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            let response = if let Some(replies) = reply.get("responses") {
                json!({"ok":true,"result":replies.get(body["method"].as_str().unwrap_or_default()).cloned().unwrap_or(Value::Null)})
            } else {
                reply
            };
            requests.lock().await.push((
                headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .into(),
                body,
            ));
            Json(response)
        }
        let requests = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new()
            .route("/rpc", post(rpc))
            .with_state((reply, requests.clone()));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let worker = Arc::new(NativeWorker {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            endpoint: format!("http://127.0.0.1:{port}/rpc"),
            token: "owned-fixture-bearer".into(),
            secrets: Mutex::new(vec!["owned-gateway-secret".into()]),
            running: AtomicBool::new(true),
            detached: true,
        });
        (worker, requests, server)
    }
    #[tokio::test]
    async fn native_rpc_uses_private_bearer_and_stable_command_identity() {
        let (worker, requests, server) = fixture(json!({"ok":true,"result":null})).await;
        worker
            .call::<()>(
                "sendMessage",
                json!({"sessionId":"zc:owned","requestId":"msg_stable","text":"owned input"}),
            )
            .await
            .unwrap();
        let requests = requests.lock().await;
        assert_eq!(requests[0].0, "Bearer owned-fixture-bearer");
        assert_eq!(
            requests[0].1,
            json!({"method":"sendMessage","args":{"sessionId":"zc:owned","requestId":"msg_stable","text":"owned input"}})
        );
        server.abort();
    }
    #[tokio::test]
    async fn native_rpc_redacts_credentials_and_error_details() {
        let (worker, _, server) =
            fixture(json!({"ok":false,"error":"failed owned-fixture-bearer owned-gateway-secret"}))
                .await;
        let error = worker.call::<Value>("status", json!({})).await.unwrap_err();
        assert!(!error.contains("owned-fixture"));
        assert!(!error.contains("owned-gateway"));
        let value = worker
            .redact(json!({"apiKey":"unregistered-private-value","detail":"owned-gateway-secret"}))
            .await;
        assert_eq!(value["apiKey"], "[已隐藏]");
        assert_eq!(value["detail"], "[已隐藏]");
        server.abort();
    }
    #[tokio::test]
    async fn idle_lease_blocks_new_work_while_stop_bypasses_mutation_lane() {
        let (worker, requests, server) = fixture(
            json!({"responses":{"beginUpdate":null,"endUpdate":null,"interruptSession":false}}),
        )
        .await;
        let state = ZcodeAgentState::default();
        *state.worker.write().await = Some(worker);
        let lease = state.acquire_idle_for_update().await.unwrap();
        assert!(timeout(
            Duration::from_millis(20),
            state.call::<bool>("sendMessage", json!({}), true)
        )
        .await
        .is_err());
        assert!(!state
            .call::<bool>("interruptSession", json!({}), false)
            .await
            .unwrap());
        assert_eq!(
            requests
                .lock()
                .await
                .iter()
                .map(|r| r.1["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["beginUpdate", "interruptSession"]
        );
        drop(lease);
        for _ in 0..50 {
            if requests
                .lock()
                .await
                .iter()
                .any(|r| r.1["method"] == "endUpdate")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(requests
            .lock()
            .await
            .iter()
            .any(|r| r.1["method"] == "endUpdate"));
        assert!(state.lifecycle.try_lock().is_ok());
        server.abort();
    }
    #[tokio::test]
    async fn unknown_background_activity_fails_closed_for_installation() {
        let (worker, _, server) = fixture(json!({"ok":false,"error":"activity unavailable"})).await;
        let state = ZcodeAgentState::default();
        *state.worker.write().await = Some(worker);
        assert!(state.acquire_idle_for_update().await.is_err());
        assert!(state.lifecycle.try_lock().is_ok());
        server.abort();
    }
    #[test]
    fn old_history_listing_reads_metadata_without_mutating_database_or_launching() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("data")).unwrap();
        let path = root.path().join("data/lolicode-agent.db");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute("CREATE TABLE session(data TEXT NOT NULL)", [])
            .unwrap();
        for (id, directory, updated) in [
            ("ses_old", "D:/owned/project", 2),
            ("ses_other", "D:/owned/other", 3),
        ] {
            db.execute("INSERT INTO session(data) VALUES (?)", [json!({"id":id,"title":"Owned history","location":{"directory":directory},"model":{"providerID":"lolicode","id":"source/model"},"agent":"plan","time":{"created":1,"updated":updated}}).to_string()]).unwrap();
        }
        drop(db);
        let before = std::fs::read(&path).unwrap();
        let sessions = legacy_sessions(root.path(), Some("D:/owned/project")).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "ses_old");
        assert_eq!(sessions[0].mode, "plan");
        assert_eq!(sessions[0].model.as_ref().unwrap().model_id, "source/model");
        assert_eq!(before, std::fs::read(path).unwrap());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
}
