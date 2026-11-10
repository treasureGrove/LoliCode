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
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot, watch, Semaphore},
    time::{timeout, timeout_at, Instant},
};

const RPC_TIMEOUT: Duration = Duration::from_secs(45);
pub(super) const PREPARATION_CANCELLED: &str = "LOLICODE_HARNESS_PREPARATION_CANCELLED";
pub(super) const PREPARATION_CLEANUP_FAILED: &str = "LOLICODE_HARNESS_PREPARATION_CLEANUP_FAILED";
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FRAME: usize = 32 * 1024 * 1024;
const EVENT_CAPACITY: usize = 256;
const REQUEST_CAPACITY: usize = 64;

const MAX_MARKDOWN: usize = 8 * 1024 * 1024;
pub(super) const MARKDOWN_MISSING: &str = "会话尚未形成原生 Harness 日志，无法复制完整历史";
const MARKDOWN_TOO_LARGE: &str = "完整会话 Markdown 超过 8 MiB，无法复制";
const MARKDOWN_READ_FAILED: &str = "无法读取完整的原生 Harness 会话日志，请重试";
const MAX_NATIVE: usize = 8 * 1024 * 1024;
pub(super) const NATIVE_MISSING: &str = "会话尚未形成原生 Harness 日志";
const NATIVE_TOO_LARGE: &str = "原生会话页面超过 8 MiB，请缩小读取范围";
const NATIVE_READ_FAILED: &str = "无法读取原生 Harness 会话，请重试";
static NATIVE_READ_SLOTS: Semaphore = Semaphore::const_new(2);
const NATIVE_FOLLOW_CAPACITY: usize = 64;
const NATIVE_FOLLOW_BYTES: usize = 16 * 1024 * 1024;
const NATIVE_FOLLOW_LIMIT: usize = 8;
const NATIVE_FOLLOW_METHOD: &str = "lolicode/session.native-follow";
const NATIVE_FOLLOW_ENDED: &str = "原生会话实时连接已结束，请手动重新连接";
const NATIVE_FOLLOW_OVERFLOW: &str = "原生会话实时记录积压，请手动重新连接";

#[derive(Default)]
struct NativeFollows(Mutex<HashMap<String, NativeFollowRoute>>);

struct NativeFollowRoute {
    frames: mpsc::Sender<(Value, usize)>,
    failure: watch::Sender<Option<String>>,
    bytes: Arc<AtomicUsize>,
}

/// A distinct bounded observer; dropping it never stops the model's runtime.
pub(super) struct HarnessNativeSubscription {
    id: String,
    client: HarnessClient,
    frames: mpsc::Receiver<(Value, usize)>,
    failure: watch::Receiver<Option<String>>,
    bytes: Arc<AtomicUsize>,
}

impl HarnessNativeSubscription {
    pub(super) async fn ended(&mut self) -> String {
        if let Some(error) = self.failure.borrow().clone() {
            return error;
        }
        let mut stopped = self.client.stopped.clone();
        if stopped.borrow().is_some() {
            return NATIVE_FOLLOW_ENDED.into();
        }
        tokio::select! {
            _ = self.failure.changed() => self.failure.borrow().clone().unwrap_or_else(|| NATIVE_FOLLOW_ENDED.into()),
            _ = stopped.changed() => NATIVE_FOLLOW_ENDED.into(),
        }
    }
    pub(super) async fn next(&mut self) -> Result<Value, String> {
        if let Some(error) = self.failure.borrow().clone() {
            return Err(error);
        }
        let mut stopped = self.client.stopped.clone();
        if stopped.borrow().is_some() {
            return Err(NATIVE_FOLLOW_ENDED.into());
        }
        tokio::select! {
            biased;
            _ = self.failure.changed() => Err(self.failure.borrow().clone().unwrap_or_else(|| NATIVE_FOLLOW_ENDED.into())),
            _ = stopped.changed() => Err(NATIVE_FOLLOW_ENDED.into()),
            frame = self.frames.recv() => match frame {
                Some((frame, size)) => {
                    self.bytes.fetch_sub(size, Ordering::Relaxed);
                    Ok(frame)
                }
                None => Err(NATIVE_FOLLOW_ENDED.into()),
            },
        }
    }
}

impl Drop for HarnessNativeSubscription {
    fn drop(&mut self) {
        // Reserve the ID until the upstream unfollow has completed. Otherwise
        // a delayed cleanup could cancel a new watch that reused the same ID.
        let routes = self.client.native_follows.0.lock().unwrap();
        let Some(route) = routes.get(&self.id) else {
            return;
        };
        if !Arc::ptr_eq(&route.bytes, &self.bytes) {
            return;
        }
        route.failure.send_replace(Some(NATIVE_FOLLOW_ENDED.into()));
        drop(routes);
        let client = self.client.clone();
        let id = self.id.clone();
        let bytes = self.bytes.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = client
                    .request(
                        "lolicode/session/unfollow-native",
                        json!({"subscriptionId":id}),
                    )
                    .await;
                client.native_follows.remove(&id, &bytes);
            });
        } else {
            client.native_follows.remove(&id, &bytes);
        }
    }
}

impl NativeFollows {
    fn remove(&self, id: &str, bytes: &Arc<AtomicUsize>) {
        let mut routes = self.0.lock().unwrap();
        if routes
            .get(id)
            .is_some_and(|route| Arc::ptr_eq(&route.bytes, bytes))
        {
            routes.remove(id);
        }
    }

    /// Keep observer traffic out of the execution/approval event queue entirely.
    fn route(&self, params: &Value) {
        let Some(id) = params["subscriptionId"].as_str() else {
            return;
        };
        let routes = self.0.lock().unwrap();
        let Some(route) = routes.get(id) else {
            return;
        };
        if route.failure.borrow().is_some() {
            return;
        }
        let failure = if params["error"].is_string() {
            Some(NATIVE_FOLLOW_ENDED)
        } else if let Some(frame) = params.get("frame") {
            match serde_json::to_vec(frame) {
                Ok(bytes) if bytes.len() <= MAX_NATIVE => {
                    let size = bytes.len();
                    let previous = route.bytes.fetch_add(size, Ordering::Relaxed);
                    if previous + size > NATIVE_FOLLOW_BYTES
                        || route.frames.try_send((frame.clone(), size)).is_err()
                    {
                        route.bytes.fetch_sub(size, Ordering::Relaxed);
                        Some(NATIVE_FOLLOW_OVERFLOW)
                    } else {
                        None
                    }
                }
                _ => Some(NATIVE_FOLLOW_OVERFLOW),
            }
        } else {
            Some(NATIVE_FOLLOW_ENDED)
        };
        if let Some(error) = failure {
            route.failure.send_replace(Some(error.into()));
        }
    }
}

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
    native_follows: Arc<NativeFollows>,
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

    pub(super) async fn read_session_native(
        &self,
        root_id: &str,
        child_id: Option<&str>,
        request: &Value,
    ) -> Result<Option<Value>, String> {
        let mut params = request.clone();
        params["sessionId"] = json!(root_id);
        if let Some(child) = child_id {
            params["childSessionId"] = json!(child);
        }
        match self.request("lolicode/session/read-native", params).await {
            Ok(Value::Null) => Ok(None),
            Ok(value) => validate_native(value).map(Some),
            Err(error) => match error.as_str() {
                "LOLICODE_SESSION_LOG_COLD" | "Harness 进程已断开" => Ok(None),
                "LOLICODE_SESSION_LOG_MISSING" => Err(NATIVE_MISSING.into()),
                "LOLICODE_SESSION_NATIVE_TOO_LARGE" => Err(NATIVE_TOO_LARGE.into()),
                _ => Err(NATIVE_READ_FAILED.into()),
            },
        }
    }

    pub(super) async fn follow_session_native(
        &self,
        root_id: &str,
        child_id: Option<&str>,
        id: String,
        max_messages: Option<u32>,
    ) -> Result<Option<HarnessNativeSubscription>, String> {
        let request = native_read_request(None, None, max_messages)?;
        let (frames, receiver) = mpsc::channel(NATIVE_FOLLOW_CAPACITY);
        let (failure, failed) = watch::channel(None);
        let bytes = Arc::new(AtomicUsize::new(0));
        {
            let mut routes = self.native_follows.0.lock().unwrap();
            if routes.len() >= NATIVE_FOLLOW_LIMIT || routes.contains_key(&id) {
                return Err("原生会话实时订阅过多或编号重复".into());
            }
            routes.insert(
                id.clone(),
                NativeFollowRoute {
                    frames,
                    failure,
                    bytes: bytes.clone(),
                },
            );
        }
        let subscription = HarnessNativeSubscription {
            id: id.clone(),
            client: self.clone(),
            frames: receiver,
            failure: failed,
            bytes,
        };
        let mut params = request;
        params["sessionId"] = json!(root_id);
        params["subscriptionId"] = json!(id);
        if let Some(child) = child_id {
            params["childSessionId"] = json!(child);
        }
        match self.request("lolicode/session/follow-native", params).await {
            Ok(Value::Null) => Ok(None),
            Ok(value) if value == json!({}) => Ok(Some(subscription)),
            Err(error) if error == "LOLICODE_SESSION_LOG_COLD" || error == "Harness 进程已断开" => {
                Ok(None)
            }
            _ => Err(NATIVE_FOLLOW_ENDED.into()),
        }
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

    /// A failed/crashed SDK is still safe to replace after its process tree
    /// has actually been reaped. An unknown close must remain a hard error.
    pub(super) async fn shutdown_for_reuse(&self) -> Result<(), String> {
        let result = self.shutdown().await;
        if self.stopped.borrow().is_some() {
            Ok(())
        } else {
            result
        }
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

pub(super) fn native_read_request(
    before_seq: Option<u64>,
    through_seq: Option<u64>,
    max_messages: Option<u32>,
) -> Result<Value, String> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    if before_seq.is_some_and(|seq| seq > MAX_SAFE_INTEGER)
        || through_seq.is_some_and(|seq| seq > MAX_SAFE_INTEGER)
        || max_messages.is_some_and(|count| count == 0 || count > 200)
    {
        return Err("原生会话分页参数无效".into());
    }
    let mut request = json!({});
    for (key, value) in [("beforeSeq", before_seq), ("throughSeq", through_seq)] {
        if let Some(value) = value {
            request[key] = json!(value);
        }
    }
    if let Some(value) = max_messages {
        request["maxMessages"] = json!(value);
    }
    Ok(request)
}

fn validate_native(value: Value) -> Result<Value, String> {
    if !value["page"].is_object()
        || value.get("projections").is_none()
        || !value["state"].is_object()
    {
        return Err(NATIVE_READ_FAILED.into());
    }
    if serde_json::to_vec(&value)
        .map_err(|_| NATIVE_READ_FAILED)?
        .len()
        > MAX_NATIVE
    {
        return Err(NATIVE_TOO_LARGE.into());
    }
    Ok(value)
}

pub(super) async fn read_cold_session_native(
    paths: &HarnessPaths,
    sessions: &Path,
    session_id: &str,
    request: &Value,
) -> Result<Value, String> {
    read_cold_session_native_until(
        paths,
        sessions,
        session_id,
        request,
        Instant::now() + RPC_TIMEOUT,
    )
    .await
}

async fn read_cold_session_native_until(
    paths: &HarnessPaths,
    sessions: &Path,
    session_id: &str,
    request: &Value,
    deadline: Instant,
) -> Result<Value, String> {
    timeout_at(deadline, async {
        // A stale frontend read can outlive its view. Bound the heavy helpers
        // across all sessions; queuing consumes the same deadline as execution.
        let permit = NATIVE_READ_SLOTS
            .acquire()
            .await
            .map_err(|_| NATIVE_READ_FAILED)?;
        let request = serde_json::to_string(request).map_err(|_| NATIVE_READ_FAILED)?;
        let home = tempfile::Builder::new()
            .prefix("lolicode-native-read-")
            .tempdir()
            .map_err(|_| NATIVE_READ_FAILED)?;
        let mut command = Command::new(&paths.node);
        command
            .arg(&paths.native_reader)
            .arg(sessions)
            .arg(session_id)
            .arg(request)
            .arg(home.path())
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
        let mut child = command.spawn().map_err(|_| NATIVE_READ_FAILED)?;
        let stdout = child.stdout.take().ok_or(NATIVE_READ_FAILED)?;
        let (reply, result) = oneshot::channel();
        tokio::spawn(async move {
            let _permit = permit;
            let mut reply = reply;
            let read = async {
                let mut bytes = Vec::new();
                stdout
                    .take(MAX_NATIVE as u64 + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|_| NATIVE_READ_FAILED)?;
                if bytes.len() > MAX_NATIVE {
                    return Err(NATIVE_TOO_LARGE.into());
                }
                let status = child.wait().await.map_err(|_| NATIVE_READ_FAILED)?;
                match status.code() {
                    Some(0) => validate_native(
                        serde_json::from_slice(&bytes).map_err(|_| NATIVE_READ_FAILED)?,
                    ),
                    Some(2) => Err(NATIVE_MISSING.into()),
                    Some(3) => Err(NATIVE_TOO_LARGE.into()),
                    _ => Err(NATIVE_READ_FAILED.into()),
                }
            };
            let outcome = tokio::select! {
                result = read => result,
                _ = tokio::time::sleep_until(deadline) => Err("读取原生会话超时，请重试".into()),
                _ = reply.closed() => Err("原生会话读取已取消".into()),
            };
            // Kill/wait before deleting HOME: a Windows child can hold cwd and
            // storage files open even after its caller has stopped waiting.
            if child.id().is_some() {
                let _ = child.kill().await;
            }
            let _ = child.wait().await;
            drop(child);
            let cleanup = tokio::task::spawn_blocking(move || home.close()).await;
            let outcome = match cleanup {
                Ok(Ok(())) => outcome,
                _ => Err("无法清理原生会话临时读取目录".into()),
            };
            let _ = reply.send(outcome);
        });
        result.await.map_err(|_| NATIVE_READ_FAILED.to_owned())?
    })
    .await
    .map_err(|_| "读取原生会话超时，请重试")?
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

async fn shutdown_preparation(client: &HarnessClient) -> Result<(), String> {
    let result = client.shutdown().await;
    // An uninitialized SDK may reject graceful shutdown. The transport still
    // kills and reaps its process tree before publishing `stopped`; that is a
    // confirmed cancellation, even when its exit result reports a wire error.
    if client.stopped.borrow().is_some() {
        return Ok(());
    }
    Err(format!(
        "{PREPARATION_CLEANUP_FAILED}: {}",
        result
            .err()
            .unwrap_or_else(|| "SDK termination was not confirmed".into())
    ))
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
        let (client, events) = Self::launch(
            node,
            runtime_package,
            project,
            home,
            gateway,
            false,
            &[],
            None,
        )
        .await?;
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
            None,
        )
        .await
    }

    /// Cancellation owns and awaits child cleanup; dropping initialization is
    /// insufficient because the transport task owns the process and gateway.
    pub(super) async fn start_live_cancellable(
        node: &Path,
        runtime_package: &Path,
        project: &Path,
        home: &Path,
        gateway: HarnessGateway,
        plugin_patches: &[PathBuf],
        cancel: watch::Receiver<bool>,
    ) -> Result<(HarnessClient, mpsc::Receiver<HarnessEvent>), String> {
        Self::launch(
            node,
            runtime_package,
            project,
            home,
            gateway,
            true,
            plugin_patches,
            Some(cancel),
        )
        .await
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Launch owns both SDK process configuration and optional preparation cancellation"
    )]
    async fn launch(
        node: &Path,
        runtime_package: &Path,
        project: &Path,
        home: &Path,
        gateway: HarnessGateway,
        live: bool,
        plugin_patches: &[PathBuf],
        mut cancel: Option<watch::Receiver<bool>>,
    ) -> Result<(HarnessClient, mpsc::Receiver<HarnessEvent>), String> {
        if cancel.as_ref().is_some_and(|cancel| *cancel.borrow()) {
            return Err(PREPARATION_CANCELLED.into());
        }
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
            native_follows: Arc::new(NativeFollows::default()),
        };
        let client_native_follows = client.native_follows.clone();
        tokio::spawn(async move {
            let result = tokio::select! {
                result = read_frames(output, &pending, &publish, outbox, stopped, &client_native_follows) => result,
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
            let reaped = if outcome.is_err() {
                child.kill().await.is_ok() || child.try_wait().ok().flatten().is_some()
            } else {
                true
            };
            let failure = outcome
                .clone()
                .err()
                .unwrap_or_else(|| "Harness 进程已断开".into());
            for (_, waiter) in pending.lock().unwrap().drain() {
                let _ = waiter.send(Err(failure.clone()));
            }
            drop(overlay);
            drop(gateway);
            if reaped {
                terminated.send_replace(Some(outcome));
            }
        });
        let initialized = {
            let initialize = client.request(
                "initialize",
                json!({
                    "cwd": project, "provider": PROVIDER, "model": model,
                    "approvalRequests": true, "capabilities": {"userQuestions": live},
                }),
            );
            tokio::pin!(initialize);
            if let Some(cancel) = &mut cancel {
                tokio::select! {
                    biased;
                    _ = async {
                        loop {
                            if *cancel.borrow_and_update() { break; }
                            if cancel.changed().await.is_err() { break; }
                        }
                    } => {
                        shutdown_preparation(&client).await?;
                        return Err(PREPARATION_CANCELLED.into());
                    }
                    result = &mut initialize => result,
                }
            } else {
                initialize.await
            }
        };
        let initialized = match initialized {
            Ok(value) => value,
            Err(error) => {
                shutdown_preparation(&client).await?;
                return Err(error);
            }
        };
        if initialized["serverInfo"]["name"] != "deepseek-harness-sdk-runtime" {
            shutdown_preparation(&client).await?;
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
    native_follows: &NativeFollows,
) -> Result<(), String> {
    let mut output = BufReader::new(output);
    let host_slots = Arc::new(Semaphore::new(REQUEST_CAPACITY));
    while let Some(frame) = receive(&mut output).await? {
        if frame["jsonrpc"] != "2.0" {
            return Err("Harness 返回了无效事件".into());
        }
        if let Some(method) = frame["method"].as_str() {
            if method == NATIVE_FOLLOW_METHOD && frame.get("id").is_none() {
                native_follows.route(&frame["params"]);
                continue;
            }
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

    #[tokio::test]
    #[ignore = "requires the prepared pinned Harness Node runtime"]
    async fn native_cold_helper_cancellation_and_timeout_remove_the_owned_home() {
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let node = HarnessPaths::from_resource_dir(&resources).unwrap().node;
        let fixture = tempfile::tempdir().unwrap();
        let helper = fixture.path().join("cold-helper.mjs");
        std::fs::write(
            &helper,
            r#"
            import fs from 'node:fs';
            import path from 'node:path';
            const home = process.argv[5];
            process.chdir(home);
            fs.writeFileSync(path.join(process.argv[2], 'started.json'), JSON.stringify({home}));
            setInterval(() => {}, 1000);
        "#,
        )
        .unwrap();
        for cancel in [true, false] {
            let marker = fixture.path().join("started.json");
            let paths = HarnessPaths {
                node: node.clone(),
                package: fixture.path().to_owned(),
                native_reader: helper.clone(),
                version: "fixture".into(),
            };
            let sessions = fixture.path().to_owned();
            let run = tokio::spawn(async move {
                let deadline = Instant::now() + Duration::from_secs(3);
                read_cold_session_native_until(&paths, &sessions, "fixture", &json!({}), deadline)
                    .await
            });
            timeout(Duration::from_secs(2), async {
                while !marker.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the fixture helper did not start");
            let started: Value = serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
            let home = PathBuf::from(started["home"].as_str().unwrap());
            assert!(home.is_dir());
            if cancel {
                run.abort();
                assert!(run.await.unwrap_err().is_cancelled());
            } else {
                assert_eq!(run.await.unwrap().unwrap_err(), "读取原生会话超时，请重试");
            }
            timeout(Duration::from_secs(5), async {
                while home.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("cancelled helper left its owned HOME behind");
            std::fs::remove_file(marker).unwrap();
        }
    }

    #[tokio::test]
    async fn native_follow_overflow_and_cancellation_do_not_block_other_observers_or_rpcs() {
        timeout(Duration::from_secs(5), async {
            let (host_in, mut sdk_out) = tokio::io::duplex(16 * 1024);
            let (host_out, sdk_in) = tokio::io::duplex(16 * 1024);
            let mut sdk_in = BufReader::new(sdk_in);
            let (outbox, writes) = mpsc::channel(REQUEST_CAPACITY);
            let (publish, mut events) = mpsc::channel(1);
            let (stop, _should_stop) = watch::channel(false);
            let (_terminated, stopped) = watch::channel(None);
            let pending = Arc::new(Requests::default());
            let client = HarnessClient {
                outbox: outbox.clone(), pending: pending.clone(),
                sequence: Arc::new(AtomicU64::new(1)), stop, stopped: stopped.clone(),
                shutdown_lock: Arc::new(tokio::sync::Mutex::new(())),
                native_follows: Arc::new(NativeFollows::default()),
            };
            let routes = client.native_follows.clone();
            let reader = tokio::spawn(async move {
                read_frames(host_in, &pending, &publish, outbox, stopped, &routes).await
            });
            let writer = tokio::spawn(write_frames(host_out, writes));
            let first_client = client.clone();
            let first = tokio::spawn(async move {
                first_client.follow_session_native("root", None, "first".into(), Some(12)).await
            });
            let first_open = receive(&mut sdk_in).await.unwrap().unwrap();
            sdk_out.write_all(&encode(&json!({"jsonrpc":"2.0","id":first_open["id"],"result":{}})).unwrap()).await.unwrap();
            let mut first = first.await.unwrap().unwrap().unwrap();
            let second_client = client.clone();
            let second = tokio::spawn(async move {
                second_client.follow_session_native("root", None, "second".into(), Some(12)).await
            });
            let second_open = receive(&mut sdk_in).await.unwrap().unwrap();
            sdk_out.write_all(&encode(&json!({"jsonrpc":"2.0","id":second_open["id"],"result":{}})).unwrap()).await.unwrap();
            let mut second = second.await.unwrap().unwrap().unwrap();
            for seq in 0..=NATIVE_FOLLOW_CAPACITY {
                sdk_out.write_all(&encode(&json!({"jsonrpc":"2.0","method":NATIVE_FOLLOW_METHOD,
                    "params":{"subscriptionId":"first","frame":{"type":"event","event":{"seq":seq}}}})).unwrap()).await.unwrap();
            }
            let expected = json!({"type":"event","event":{"seq":77,"future":{"preserve":true}}});
            sdk_out.write_all(&encode(&json!({"jsonrpc":"2.0","method":NATIVE_FOLLOW_METHOD,
                "params":{"subscriptionId":"second","frame":expected}})).unwrap()).await.unwrap();
            // Observation frames cannot fill even a capacity-one Agent queue.
            sdk_out.write_all(&encode(&json!({"jsonrpc":"2.0","method":"approval/request","id":"approval",
                "params":{"kind":"fixture"}})).unwrap()).await.unwrap();
            let Some(HarnessEvent::Request(approval)) = events.recv().await else { panic!("approval was blocked"); };
            assert_eq!(second.next().await.unwrap(), expected);
            assert_eq!(first.next().await.unwrap_err(), NATIVE_FOLLOW_OVERFLOW);
            assert!(!reader.is_finished());
            approval.respond(Some(json!({"outcome":"allowed-once"}))).await.unwrap();
            assert_eq!(receive(&mut sdk_in).await.unwrap().unwrap()["id"], "approval");
            drop(first);
            let cancelled = receive(&mut sdk_in).await.unwrap().unwrap();
            assert_eq!(cancelled["method"], "lolicode/session/unfollow-native");
            assert_eq!(cancelled["params"]["subscriptionId"], "first");
            // Cleanup must settle upstream before this ID becomes reusable.
            assert!(client.follow_session_native("root", None, "first".into(), Some(12)).await.is_err());
            sdk_out.write_all(&encode(&json!({"jsonrpc":"2.0","id":cancelled["id"],"result":{}})).unwrap()).await.unwrap();
            while client.native_follows.0.lock().unwrap().contains_key("first") {
                tokio::task::yield_now().await;
            }
            sdk_out.write_all(&encode(&json!({"jsonrpc":"2.0","method":NATIVE_FOLLOW_METHOD,
                "params":{"subscriptionId":"second","frame":{"type":"event","event":{"seq":78}}}})).unwrap()).await.unwrap();
            assert_eq!(second.next().await.unwrap()["event"]["seq"], 78);
            drop(second);
            let cancelled = receive(&mut sdk_in).await.unwrap().unwrap();
            assert_eq!(cancelled["params"]["subscriptionId"], "second");
            sdk_out.write_all(&encode(&json!({"jsonrpc":"2.0","id":cancelled["id"],"result":{}})).unwrap()).await.unwrap();
            // Closing while the first upstream reply is pending still owns the
            // cleanup capability; a late successful reply cannot leak a watch.
            let opening_client = client.clone();
            let opening = tokio::spawn(async move {
                opening_client.follow_session_native("root", None, "opening".into(), Some(12)).await
            });
            let started = receive(&mut sdk_in).await.unwrap().unwrap();
            opening.abort();
            assert!(matches!(opening.await, Err(error) if error.is_cancelled()));
            let cancelled = receive(&mut sdk_in).await.unwrap().unwrap();
            assert_eq!(cancelled["method"], "lolicode/session/unfollow-native");
            assert_eq!(cancelled["params"]["subscriptionId"], "opening");
            sdk_out.write_all(&encode(&json!({"jsonrpc":"2.0","id":started["id"],"result":{}})).unwrap()).await.unwrap();
            sdk_out.write_all(&encode(&json!({"jsonrpc":"2.0","id":cancelled["id"],"result":{}})).unwrap()).await.unwrap();
            while client.native_follows.0.lock().unwrap().contains_key("opening") {
                tokio::task::yield_now().await;
            }
            reader.abort(); writer.abort();
        }).await.unwrap();
    }

    #[test]
    fn native_pagination_preserves_cut_and_rejects_unsafe_numbers() {
        assert_eq!(native_read_request(None, None, None).unwrap(), json!({}));
        assert_eq!(
            native_read_request(Some(11), Some(19), Some(25)).unwrap(),
            json!({"beforeSeq":11,"throughSeq":19,"maxMessages":25})
        );
        assert!(native_read_request(Some(9_007_199_254_740_992), None, None).is_err());
        assert!(native_read_request(None, Some(9_007_199_254_740_992), None).is_err());
        assert!(native_read_request(None, None, Some(0)).is_err());
        assert!(native_read_request(None, None, Some(201)).is_err());
    }

    #[test]
    fn native_payload_keeps_official_fields_and_enforces_a_complete_page_limit() {
        let value = json!({
            "page": {"cursor":19,"records":[{"type":"event","event":{
                "seq":7,"time":100,"type":"assistant/message","surfaceOp":"append",
                "data":{"turn":2,"step":3,"providerMetadata":{"fixture":[1,2,3]}}
            }}],"hasMore":true},
            // State may be newer than the fixed history cut. Do not normalize it.
            "projections":{"asOfSeq":22,"values":{"turnOutline":[{"turn":2,"seq":5}]}},
            "state":{"cursor":22,"active":true,"running":false},
            "futureOfficialField":{"keep":true}
        });
        assert_eq!(validate_native(value.clone()).unwrap(), value);
        assert!(validate_native(json!({"page":{},"state":{}})).is_err());
        let oversized =
            json!({"page":{"payload":"x".repeat(MAX_NATIVE)},"projections":{},"state":{}});
        assert_eq!(validate_native(oversized).unwrap_err(), NATIVE_TOO_LARGE);
    }

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
                native_follows: Arc::new(NativeFollows::default()),
            };
            let test_native_follows = client.native_follows.clone();
            let reader = tokio::spawn(async move {
                read_frames(
                    host_in,
                    &pending,
                    &publish,
                    outbox,
                    stopped,
                    &test_native_follows,
                )
                .await
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

            let reading = client.clone();
            let native = tokio::spawn(async move {
                reading
                    .read_session_native(
                        "first",
                        Some("worker"),
                        &native_read_request(Some(11), Some(19), Some(25)).unwrap(),
                    )
                    .await
            });
            let native_frame = receive(&mut sdk_in).await.unwrap().unwrap();
            assert_eq!(native_frame["method"], "lolicode/session/read-native");
            assert_eq!(
                native_frame["params"],
                json!({
                    "sessionId":"first","childSessionId":"worker",
                    "beforeSeq":11,"throughSeq":19,"maxMessages":25
                })
            );
            let native_value = json!({
                "page":{"cursor":19,"records":[{"type":"event","event":{
                    "seq":7,"time":100,"type":"turn/end",
                    "data":{"turn":2,"reason":{"kind":"max-tokens"}}
                }}],"hasMore":true},
                "projections":{"asOfSeq":22,"values":{}},
                "state":{"cursor":22,"active":true,"running":false}
            });
            sdk_out
                .write_all(
                    &encode(&json!({"jsonrpc":"2.0","id":native_frame["id"],
                "result":native_value}))
                    .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(native.await.unwrap().unwrap(), Some(native_value));
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
