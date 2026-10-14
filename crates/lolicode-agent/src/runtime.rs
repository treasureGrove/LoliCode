use crate::{
    mapping,
    stream::{LiveState, SseDecoder},
    *,
};
use futures::StreamExt;
use reqwest::{Client, Method};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{watch, Mutex},
    time::timeout,
};
use uuid::Uuid;

pub struct EngineOptions {
    pub executable: PathBuf,
    pub private_root: PathBuf,
    pub config: Value,
}

/// This handle is clonable; credentials, process pipes and live state are shared.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

struct Inner {
    client: Client,
    stream_client: Client,
    endpoint: String,
    password: String,
    secrets: Vec<String>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    live: Mutex<LiveState>,
    running: AtomicBool,
    stop: watch::Sender<bool>,
    // Concurrent snapshots of one session must not race a live-overlay cleanup.
    snapshots: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    #[cfg(test)]
    detached_fixture: bool,
}

impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        // Child has kill_on_drop; ChildStdin closes even when the UI is gone.
    }
}

impl Engine {
    pub async fn launch(options: EngineOptions) -> Result<Self, String> {
        if !options.executable.is_absolute() || !options.executable.is_file() {
            return Err("未找到已准备的编程引擎".into());
        }
        if !options.private_root.is_absolute() || options.private_root.parent().is_none() {
            return Err("引擎数据目录必须是独立的绝对路径".into());
        }
        if !options.config.is_object() {
            return Err("引擎配置必须是 JSON 对象".into());
        }
        prepare_directories(&options.private_root).await?;
        let root = tokio::fs::canonicalize(&options.private_root)
            .await
            .map_err(|_| "无法读取引擎数据目录".to_string())?;
        let root = PathBuf::from(js_project_path(&root.to_string_lossy()));
        write_private_config(&root.join("config/opencode.json"), &options.config).await?;
        let password = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let mut command = Command::new(&options.executable);
        command
            .args(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"])
            .current_dir(root.join("home"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        apply_private_environment(&mut command, &root, &password);
        hide_window(command.as_std_mut());
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动编程引擎".to_string())?;
        let stdin = child.stdin.take().ok_or("无法创建引擎生命周期管道")?;
        let stdout = child.stdout.take().ok_or("无法读取引擎启动状态")?;
        let stderr = child.stderr.take().ok_or("无法读取引擎诊断管道")?;
        // Never forward process output; it can contain provider credentials.
        tokio::spawn(discard_output(stderr));
        let mut stdout = BufReader::new(stdout);
        let endpoint = match timeout(Duration::from_secs(30), read_listener(&mut stdout)).await {
            Ok(Ok(url)) => url,
            _ => {
                let _ = child.kill().await;
                return Err("编程引擎未能在限定时间内启动".into());
            }
        };
        tokio::spawn(discard_output(stdout));
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "无法创建引擎连接".to_string())?;
        let stream_client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .build()
            .map_err(|_| "无法创建引擎事件连接".to_string())?;
        let (stop, stop_receiver) = watch::channel(false);
        let mut secrets = vec![password.clone(), endpoint.clone()];
        collect_secrets(&options.config, &mut secrets);
        let engine = Self {
            inner: Arc::new(Inner {
                client,
                stream_client,
                endpoint,
                password,
                secrets,
                child: Mutex::new(Some(child)),
                stdin: Mutex::new(Some(stdin)),
                live: Mutex::new(LiveState::default()),
                running: AtomicBool::new(true),
                stop,
                snapshots: Mutex::new(HashMap::new()),
                #[cfg(test)]
                detached_fixture: false,
            }),
        };
        let info = match engine.request(Method::GET, "/api/info", None).await {
            Ok(info) => info,
            Err(error) => {
                let _ = engine.shutdown().await;
                return Err(error);
            }
        };
        if info["version"].as_str() != Some(ENGINE_VERSION) {
            let _ = engine.shutdown().await;
            return Err(format!("编程引擎版本不兼容，需要 {ENGINE_VERSION}"));
        }
        spawn_events(Arc::downgrade(&engine.inner), stop_receiver);
        let stream_ready = timeout(Duration::from_secs(5), async {
            while !engine.inner.live.lock().await.connected {
                if !engine.is_running() {
                    return false;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            true
        })
        .await;
        if !matches!(stream_ready, Ok(true)) {
            let _ = engine.shutdown().await;
            return Err("编程引擎事件流未能连接，请重试".into());
        }
        Ok(engine)
    }

    /// A bounded, hidden version probe; never starts an agent session.
    pub fn version(executable: &Path) -> Result<String, String> {
        use std::io::Read;
        if !executable.is_file() {
            return Err("未找到编程引擎".into());
        }
        let mut command = std::process::Command::new(executable);
        command
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        hide_window(&mut command);
        let mut child = command
            .spawn()
            .map_err(|_| "无法检查编程引擎版本".to_string())?;
        let stdout = child.stdout.take().ok_or("无法读取编程引擎版本")?;
        let reader = std::thread::spawn(move || {
            let mut output = String::new();
            let _ = stdout.take(8192).read_to_string(&mut output);
            output
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) | Err(_) => return Err("编程引擎版本检查失败".into()),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("编程引擎版本检查超时".into());
                }
            }
        }
        let output = reader
            .join()
            .map_err(|_| "编程引擎版本检查失败".to_string())?;
        let version = output
            .split_whitespace()
            .find_map(|part| {
                let candidate = part.strip_prefix('v').unwrap_or(part);
                (candidate.split('.').count() == 3
                    && candidate.chars().all(|c| c.is_ascii_digit() || c == '.'))
                .then(|| candidate.to_string())
            })
            .ok_or("无法识别编程引擎版本")?;
        Ok(version)
    }

    pub fn is_running(&self) -> bool {
        if !self.inner.running.load(Ordering::Acquire) {
            return false;
        }
        #[cfg(test)]
        if self.inner.detached_fixture {
            return true;
        }
        if let Ok(mut child) = self.inner.child.try_lock() {
            if child
                .as_mut()
                .is_none_or(|child| !matches!(child.try_wait(), Ok(None)))
            {
                self.inner.running.store(false, Ordering::Release);
                let _ = self.inner.stop.send(true);
                return false;
            }
        }
        true
    }

    pub async fn list_sessions(&self, project: &Path) -> Result<Vec<AgentSession>, String> {
        let project = canonical_project(project).await?;
        let mut url = url::Url::parse(&format!("{}/api/session", self.inner.endpoint))
            .map_err(|_| "引擎地址无效")?;
        url.query_pairs_mut()
            .append_pair("directory", &project)
            .append_pair("limit", "100")
            .append_pair("order", "desc");
        let mut result = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_cursors = std::collections::HashSet::new();
        loop {
            let mut page_url = url.clone();
            if let Some(cursor) = &cursor {
                // Upstream cursors carry ordering; do not send order twice.
                page_url.set_query(None);
                page_url
                    .query_pairs_mut()
                    .append_pair("directory", &project)
                    .append_pair("limit", "100")
                    .append_pair("cursor", cursor);
            }
            let page = self
                .request_url(Method::GET, page_url.as_str(), None)
                .await?;
            for raw in mapping::array(&page["data"]) {
                let session = mapping::session(raw)?;
                if same_project(&session.project_path, &project) {
                    self.inner.live.lock().await.track(&session.id);
                    result.push(session);
                }
            }
            cursor = page["cursor"]["next"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let Some(next) = &cursor else {
                break;
            };
            if !seen_cursors.insert(next.clone()) || result.len() > 10000 {
                return Err("引擎会话分页异常".into());
            }
        }
        Ok(result)
    }

    pub async fn create_session(
        &self,
        project: &Path,
        model: &AgentModelRef,
        mode: &str,
        title: Option<&str>,
    ) -> Result<AgentSession, String> {
        if !matches!(mode, "build" | "plan") {
            return Err("请选择编程或规划模式".into());
        }
        if model.provider_id.is_empty() || model.model_id.is_empty() {
            return Err("请选择可用模型".into());
        }
        let project = canonical_project(project).await?;
        let mut body = json!({ "location": { "directory": project }, "agent": mode, "model": { "providerID": model.provider_id, "id": model.model_id } });
        if mode == "plan" {
            // V2 appends global rules to the built-in Plan agent. Our global
            // edit allowance therefore overrides its original read-only rule.
            // Session-level denies win over agent rules and are checked before
            // project-saved approvals, including an earlier "always" reply.
            // Delegation and shell commands could otherwise bypass edit gating.
            body["permissions"] = json!([
                {"action":"edit","resource":"*","effect":"deny"},
                {"action":"shell","resource":"*","effect":"deny"},
                {"action":"subagent","resource":"*","effect":"deny"},
                {"action":"task","resource":"*","effect":"deny"}
            ]);
        }
        if let Some(title) = title {
            body["title"] = json!(title);
        }
        let result = self
            .request(Method::POST, "/api/session", Some(&body))
            .await?;
        let session = mapping::session(&result["data"])?;
        if !same_project(&session.project_path, &project) {
            return Err("引擎创建的会话不属于所选项目".into());
        }
        self.inner.live.lock().await.track(&session.id);
        Ok(session)
    }

    /// Lightweight session identity for scope checks before an interrupt.
    /// Stopping a run must never depend on loading messages, forms or diffs.
    pub async fn session(&self, session_id: &str) -> Result<AgentSession, String> {
        validate_id(session_id, "ses")?;
        let mut response = self
            .request(Method::GET, &format!("/api/session/{session_id}"), None)
            .await?;
        self.redact_value(&mut response);
        mapping::session(&response["data"])
    }

    pub async fn snapshot(&self, session_id: &str) -> Result<AgentSnapshot, String> {
        validate_id(session_id, "ses")?;
        let lock = self
            .inner
            .snapshots
            .lock()
            .await
            .entry(session_id.into())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = lock.lock().await;
        self.inner.live.lock().await.track(session_id);
        let path = format!("/api/session/{session_id}");
        let permission_path = format!("{path}/permission");
        let question_path = format!("{path}/form");
        let (raw_session, active, permissions, questions) = tokio::try_join!(
            self.request(Method::GET, &path, None),
            self.request(Method::GET, "/api/session/active", None),
            self.request(Method::GET, &permission_path, None),
            self.request(Method::GET, &question_path, None)
        )?;
        let raw_messages = self.read_messages(session_id).await?;
        let session = mapping::session(&raw_session["data"])?;
        let mut messages: Vec<_> = raw_messages.iter().filter_map(mapping::message).collect();
        let latest_idle = raw_messages.iter().rev().find(|m| m["type"] == "idle");
        let mut live = self.inner.live.lock().await;
        let gap = live.overlay(session_id, &mut messages);
        let pending = live.pending.get(session_id).cloned();
        let pending_run = pending
            .as_ref()
            .is_some_and(|(id, _)| pending_incomplete(id, &raw_messages));
        if !pending_run {
            live.pending.remove(session_id);
        }
        let connected = live.connected;
        drop(live);
        let permissions: Vec<_> = mapping::array(&permissions["data"])
            .iter()
            .map(|p| mapping::permission(p, &messages))
            .collect();
        let questions: Vec<_> = mapping::array(&questions["data"])
            .iter()
            .map(mapping::question)
            .collect();
        let running = active["data"][session_id]["type"] == "running" || pending_run;
        let failed = !running && latest_idle.is_some_and(|idle| idle["outcome"] == "failed");
        let status = if !permissions.is_empty() {
            AgentStatus::WaitingPermission
        } else if !questions.is_empty() {
            AgentStatus::WaitingQuestion
        } else if running {
            AgentStatus::Running
        } else if failed {
            AgentStatus::Error
        } else {
            AgentStatus::Idle
        };
        let error = if failed {
            Some(
                raw_messages
                    .iter()
                    .rev()
                    .find_map(|m| mapping::structured_error(&m["error"]))
                    .unwrap_or_else(|| "本次执行未完成，请查看工具输出后重试".into()),
            )
        } else {
            None
        };
        // Diff reads can fail on an uninitialized snapshot / non-VCS workspace.
        // Preserve working chat but expose that limitation rather than invent changes.
        let (diffs, diff_error) = match self
            .request(Method::GET, &format!("{path}/diff"), None)
            .await
        {
            Ok(value) => (
                mapping::array(&value["data"])
                    .iter()
                    .map(mapping::diff)
                    .collect(),
                None,
            ),
            Err(error) => (Vec::new(), Some(format!("无法读取文件变更：{error}"))),
        };
        let mut snapshot = AgentSnapshot {
            session,
            status,
            messages,
            permissions,
            questions,
            diffs,
            error: error.or(diff_error),
            stream_connected: connected,
            stream_gap: running && (!connected || gap),
        };
        let mut value = serde_json::to_value(&snapshot).map_err(|_| "会话内容编码失败")?;
        self.redact_value(&mut value);
        snapshot = serde_json::from_value(value).map_err(|_| "会话内容编码失败")?;
        Ok(snapshot)
    }

    pub async fn send_message(
        &self,
        session_id: &str,
        text: &str,
        request_id: &str,
    ) -> Result<(), String> {
        validate_id(session_id, "ses")?;
        if text.trim().is_empty() {
            return Err("请输入任务内容".into());
        }
        let message_id = request_message_id(request_id)?;
        self.inner.live.lock().await.track(session_id);
        let response = self
            .request(
                Method::POST,
                &format!("/api/session/{session_id}/prompt"),
                Some(&json!({
                    "id": message_id, "text": text, "delivery": "queue", "resume": true,
                })),
            )
            .await?;
        let created = response["data"]["time"]["created"]
            .as_u64()
            .unwrap_or_else(now_ms);
        self.inner
            .live
            .lock()
            .await
            .pending
            .insert(session_id.into(), (message_id, created));
        Ok(())
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<(), String> {
        validate_id(session_id, "ses")?;
        self.request(
            Method::POST,
            &format!("/api/session/{session_id}/interrupt?resume=false"),
            None,
        )
        .await?;
        self.inner.live.lock().await.pending.remove(session_id);
        Ok(())
    }

    pub async fn reply_permission(
        &self,
        session_id: &str,
        request_id: &str,
        decision: &str,
    ) -> Result<(), String> {
        validate_id(session_id, "ses")?;
        validate_id(request_id, "per")?;
        if !matches!(decision, "once" | "always" | "reject") {
            return Err("无效的授权决定".into());
        }
        self.request(
            Method::POST,
            &format!("/api/session/{session_id}/permission/{request_id}/reply"),
            Some(&json!({"decision":decision})),
        )
        .await?;
        Ok(())
    }

    pub async fn reply_question(
        &self,
        session_id: &str,
        request_id: &str,
        answer: &Value,
    ) -> Result<(), String> {
        validate_id(session_id, "ses")?;
        validate_id(request_id, "frm_")?;
        if !answer.is_object() {
            return Err("提问答案必须包含对应的字段".into());
        }
        self.request(
            Method::POST,
            &format!("/api/session/{session_id}/form/{request_id}/reply"),
            Some(&json!({"answer":answer})),
        )
        .await?;
        Ok(())
    }

    pub async fn reject_question(&self, session_id: &str, request_id: &str) -> Result<(), String> {
        validate_id(session_id, "ses")?;
        validate_id(request_id, "frm_")?;
        self.request(
            Method::DELETE,
            &format!("/api/session/{session_id}/form/{request_id}"),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn has_active_sessions(&self) -> Result<bool, String> {
        let active = self
            .request(Method::GET, "/api/session/active", None)
            .await?;
        if active["data"]
            .as_object()
            .is_some_and(|sessions| sessions.values().any(|s| s["type"] == "running"))
        {
            return Ok(true);
        }
        let sessions: Vec<_> = {
            let live = self.inner.live.lock().await;
            live.tracked_sessions()
        };
        for session in sessions {
            let pending = self.inner.live.lock().await.pending.get(&session).cloned();
            if let Some((id, _)) = pending {
                let messages = self.read_messages(&session).await?;
                if pending_incomplete(&id, &messages) {
                    return Ok(true);
                }
                self.inner.live.lock().await.pending.remove(&session);
            }
            let permission_path = format!("/api/session/{session}/permission");
            let question_path = format!("/api/session/{session}/form");
            let (permissions, forms) = tokio::try_join!(
                self.request(Method::GET, &permission_path, None),
                self.request(Method::GET, &question_path, None)
            )?;
            if !mapping::array(&permissions["data"]).is_empty()
                || !mapping::array(&forms["data"]).is_empty()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.inner.running.store(false, Ordering::Release);
        let _ = self.inner.stop.send(true);
        self.inner.stdin.lock().await.take();
        let child = self.inner.child.lock().await.take();
        if let Some(mut child) = child {
            match timeout(Duration::from_secs(5), child.wait()).await {
                Ok(Ok(_)) => {}
                _ => {
                    child.kill().await.map_err(|_| "无法停止本次编程引擎进程")?;
                    let _ = child.wait().await;
                }
            }
        }
        self.inner.live.lock().await.disconnected();
        Ok(())
    }

    async fn read_messages(&self, session_id: &str) -> Result<Vec<Value>, String> {
        let mut result = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen = std::collections::HashSet::new();
        loop {
            let mut url = url::Url::parse(&format!(
                "{}/api/session/{session_id}/message",
                self.inner.endpoint
            ))
            .map_err(|_| "引擎地址无效")?;
            url.query_pairs_mut().append_pair("limit", "100");
            if let Some(cursor) = &cursor {
                url.query_pairs_mut().append_pair("cursor", cursor);
            } else {
                url.query_pairs_mut().append_pair("order", "asc");
            }
            let page = self.request_url(Method::GET, url.as_str(), None).await?;
            result.extend(mapping::array(&page["data"]).iter().cloned());
            cursor = page["cursor"]["next"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let Some(next) = &cursor else {
                break;
            };
            if !seen.insert(next.clone()) || result.len() > 100000 {
                return Err("引擎消息分页异常".into());
            }
        }
        Ok(result)
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, String> {
        self.request_url(method, &format!("{}{}", self.inner.endpoint, path), body)
            .await
    }

    async fn request_url(
        &self,
        method: Method,
        url: &str,
        body: Option<&Value>,
    ) -> Result<Value, String> {
        if !self.is_running() {
            return Err("编程引擎已退出，请重新打开项目".into());
        }
        let mut request = self
            .inner
            .client
            .request(method, url)
            .basic_auth("opencode", Some(&self.inner.password));
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| self.redact(&format!("无法连接编程引擎：{error}")))?;
        let status = response.status();
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "无法读取引擎响应".to_string())?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("引擎响应过大".into());
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "引擎返回了无法识别的响应".to_string())?;
        if !status.is_success() {
            let message = mapping::structured_error(&value)
                .unwrap_or_else(|| format!("请求失败（{}）", status.as_u16()));
            return Err(self.redact(&message));
        }
        Ok(value)
    }

    fn redact(&self, input: &str) -> String {
        redact(input, &self.inner.secrets)
    }
    fn redact_value(&self, value: &mut Value) {
        redact_value(value, &self.inner.secrets);
    }
}

async fn canonical_project(project: &Path) -> Result<String, String> {
    if !project.is_absolute() || !project.is_dir() {
        return Err("请选择存在的项目目录".into());
    }
    let path = tokio::fs::canonicalize(project)
        .await
        .map_err(|_| "无法读取所选项目目录".to_string())?;
    Ok(js_project_path(&path.to_string_lossy()))
}

fn js_project_path(path: &str) -> String {
    // Windows canonicalize produces extended-length paths. JS/Bun's filesystem
    // can read them, but native Git cwd/repository discovery uses ordinary paths.
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
}

fn same_project(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        left.trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .eq_ignore_ascii_case(&right.trim_start_matches(r"\\?\").replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn validate_id(id: &str, prefix: &str) -> Result<(), String> {
    if !id.starts_with(prefix)
        || id.len() > 256
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("无效的会话或请求标识".into());
    }
    Ok(())
}

fn request_message_id(id: &str) -> Result<String, String> {
    if id.is_empty()
        || id.len() > 200
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("无效的任务请求标识".into());
    }
    Ok(if id.starts_with("msg_") {
        id.into()
    } else {
        format!("msg_{id}")
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// Ordering is authoritative: a very fast run can share the same millisecond
// with its user input. Clock comparisons would leave it running forever.
fn pending_incomplete(id: &str, messages: &[Value]) -> bool {
    let Some(user) = messages.iter().position(|m| m["id"].as_str() == Some(id)) else {
        return true;
    };
    !messages.iter().skip(user + 1).any(|m| m["type"] == "idle")
}

async fn prepare_directories(root: &Path) -> Result<(), String> {
    for part in ["home", "data", "cache", "config", "state", "tmp"] {
        tokio::fs::create_dir_all(root.join(part))
            .await
            .map_err(|_| "无法创建引擎私有目录".to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(root.join(part), std::fs::Permissions::from_mode(0o700))
                .await
                .map_err(|_| "无法保护引擎私有目录".to_string())?;
        }
    }
    Ok(())
}

async fn write_private_config(path: &Path, config: &Value) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .await
        .map_err(|_| "无法创建引擎私有配置".to_string())?;
    let data = serde_json::to_vec_pretty(config).map_err(|_| "引擎配置编码失败".to_string())?;
    file.write_all(&data)
        .await
        .map_err(|_| "无法写入引擎私有配置".to_string())?;
    file.sync_all()
        .await
        .map_err(|_| "无法保存引擎私有配置".to_string())?;
    drop(file);
    if tokio::fs::rename(&temporary, path).await.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err("无法发布引擎私有配置".into());
    }
    Ok(())
}

fn apply_private_environment(command: &mut Command, root: &Path, password: &str) {
    let root = PathBuf::from(js_project_path(&root.to_string_lossy()));
    command.env_clear();
    // Preserve platform execution essentials, not API credentials or external
    // OpenCode settings. Changes apply only to this owned child process.
    for (key, value) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if matches!(
            name.as_str(),
            "PATH"
                | "PATHEXT"
                | "SYSTEMROOT"
                | "WINDIR"
                | "COMSPEC"
                | "SYSTEMDRIVE"
                | "PROGRAMFILES"
                | "PROGRAMFILES(X86)"
                | "PROGRAMW6432"
                | "LOCALAPPDATA"
                | "APPDATA"
                | "LANG"
                | "LC_ALL"
                | "LC_CTYPE"
                | "TERM"
                | "SHELL"
                | "HOME"
                | "USERPROFILE"
                | "HOMEDRIVE"
                | "HOMEPATH"
                | "USER"
                | "USERNAME"
        ) {
            command.env(key, value);
        }
    }
    command
        .env("OPENCODE_CLIENT", "lolicode")
        .env("OPENCODE_PASSWORD", password)
        .env("OPENCODE_TEST_HOME", root.join("home"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("OPENCODE_CONFIG_DIR", root.join("config"))
        .env("OPENCODE_DB", root.join("data/lolicode-agent.db"))
        .env("OPENCODE_DISABLE_PROJECT_CONFIG", "1")
        .env("OPENCODE_DISABLE_MODELS_FETCH", "1")
        .env("TMP", root.join("tmp"))
        .env("TEMP", root.join("tmp"))
        .env("TMPDIR", root.join("tmp"));
}

#[cfg(windows)]
fn hide_window(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}
#[cfg(not(windows))]
fn hide_window(_: &mut std::process::Command) {}

async fn read_listener<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<String, String> {
    for _ in 0..64 {
        let mut line = String::new();
        if reader
            .read_line(&mut line)
            .await
            .map_err(|_| "无法读取引擎启动状态")?
            == 0
        {
            break;
        }
        if line.len() > 16384 {
            return Err("引擎启动状态异常".into());
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            if let Some(url) = value["url"].as_str() {
                return validate_listener(url);
            }
        }
    }
    Err("未收到引擎监听状态".into())
}

fn validate_listener(input: &str) -> Result<String, String> {
    let url = url::Url::parse(input).map_err(|_| "引擎地址无效")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none_or(|p| p == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err("引擎必须监听独立的本地环回地址".into());
    }
    Ok(input.trim_end_matches('/').into())
}

async fn discard_output<R: tokio::io::AsyncRead + Unpin>(mut reader: R) {
    let mut buffer = [0u8; 4096];
    while matches!(reader.read(&mut buffer).await, Ok(count) if count > 0) {}
}

fn collect_secrets(value: &Value, result: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                let key = key.to_ascii_lowercase();
                if matches!(
                    key.as_str(),
                    "apikey"
                        | "api_key"
                        | "password"
                        | "authorization"
                        | "x-api-key"
                        | "authtoken"
                        | "token"
                ) {
                    if let Some(secret) = value.as_str().filter(|s| !s.is_empty()) {
                        result.push(secret.into());
                    }
                }
                collect_secrets(value, result);
            }
        }
        Value::Array(array) => {
            for value in array {
                collect_secrets(value, result);
            }
        }
        _ => {}
    }
    // Longest strings first, avoiding partial replacement of bearer credentials.
    result.sort_by_key(|s| std::cmp::Reverse(s.len()));
    result.dedup();
}

fn redact(input: &str, secrets: &[String]) -> String {
    secrets.iter().fold(input.to_owned(), |text, secret| {
        text.replace(secret, "[已隐藏]")
    })
}
fn redact_value(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => *text = redact(text, secrets),
        Value::Object(object) => {
            for value in object.values_mut() {
                redact_value(value, secrets);
            }
        }
        Value::Array(array) => {
            for value in array {
                redact_value(value, secrets);
            }
        }
        _ => {}
    }
}

fn spawn_events(inner: std::sync::Weak<Inner>, mut stop: watch::Receiver<bool>) {
    tokio::spawn(async move {
        loop {
            if *stop.borrow() {
                break;
            }
            let Some(state) = inner.upgrade() else {
                break;
            };
            let client = state.stream_client.clone();
            let endpoint = state.endpoint.clone();
            let password = state.password.clone();
            drop(state);
            let response = tokio::select! {
                _ = stop.changed() => break,
                response = client.get(format!("{endpoint}/api/event")).basic_auth("opencode", Some(password)).send() => response,
            };
            if let Ok(response) = response {
                if response.status().is_success() {
                    let mut stream = response.bytes_stream();
                    let mut decoder = SseDecoder::default();
                    loop {
                        let chunk = tokio::select! { _ = stop.changed() => return, chunk = timeout(Duration::from_secs(40), stream.next()) => chunk };
                        let Ok(Some(Ok(bytes))) = chunk else {
                            break;
                        };
                        let Ok(events) = decoder.push(&bytes) else {
                            break;
                        };
                        let Some(state) = inner.upgrade() else {
                            return;
                        };
                        let mut live = state.live.lock().await;
                        for event in events {
                            live.apply(&event);
                        }
                    }
                }
            }
            if let Some(state) = inner.upgrade() {
                state.live.lock().await.disconnected();
            }
            tokio::select! { _ = stop.changed() => break, _ = tokio::time::sleep(Duration::from_millis(500)) => {} }
        }
    });
}

#[cfg(test)]
pub(crate) mod test_access {
    use super::*;
    pub(crate) fn engine(endpoint: String, password: String) -> Engine {
        let (stop, _) = watch::channel(false);
        Engine {
            inner: Arc::new(Inner {
                client: Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap(),
                stream_client: Client::new(),
                endpoint: endpoint.clone(),
                password: password.clone(),
                secrets: vec![endpoint, password],
                child: Mutex::new(None),
                stdin: Mutex::new(None),
                live: Mutex::new(LiveState::default()),
                running: AtomicBool::new(true),
                stop,
                snapshots: Mutex::new(HashMap::new()),
                detached_fixture: true,
            }),
        }
    }
    pub(crate) fn validate_url(url: &str) -> Result<String, String> {
        validate_listener(url)
    }
    pub(crate) fn request_id(id: &str) -> Result<String, String> {
        request_message_id(id)
    }
    pub(crate) fn environment(root: &Path) -> Command {
        let mut cmd = Command::new("unused");
        apply_private_environment(&mut cmd, root, "private-test-password");
        cmd
    }
    pub(crate) async fn config(path: &Path, value: &Value) -> Result<(), String> {
        write_private_config(path, value).await
    }
    pub(crate) fn pending(id: &str, messages: &[Value]) -> bool {
        pending_incomplete(id, messages)
    }
    pub(crate) fn js_path(path: &str) -> String {
        js_project_path(path)
    }
}
