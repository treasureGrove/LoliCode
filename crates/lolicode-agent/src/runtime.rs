use crate::{
    mapping,
    stream::{LiveState, SseDecoder},
    *,
};
use futures::StreamExt;
use reqwest::{Client, Method};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
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
    plan_enter_reminder: String,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    live: Mutex<LiveState>,
    running: AtomicBool,
    stop: watch::Sender<bool>,
    // Concurrent snapshots of one session must not race a live-overlay cleanup.
    snapshots: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    // Model/policy changes and prompt admission share one between-turn boundary.
    mutations: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    configuration_uncertain: Mutex<HashSet<String>>,
    #[cfg(test)]
    detached_fixture: bool,
}

struct RequestFailure {
    message: String,
    status: Option<u16>,
    tag: Option<String>,
}

impl RequestFailure {
    fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
            tag: None,
        }
    }
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
                plan_enter_reminder: plan_enter_reminder(&root),
                child: Mutex::new(Some(child)),
                stdin: Mutex::new(Some(stdin)),
                live: Mutex::new(LiveState::default()),
                running: AtomicBool::new(true),
                stop,
                snapshots: Mutex::new(HashMap::new()),
                mutations: Mutex::new(HashMap::new()),
                configuration_uncertain: Mutex::new(HashSet::new()),
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
        self.create_session_with_policy(project, model, mode, "auto", title)
            .await
    }

    pub async fn create_session_with_policy(
        &self,
        project: &Path,
        model: &AgentModelRef,
        mode: &str,
        permission_mode: &str,
        title: Option<&str>,
    ) -> Result<AgentSession, String> {
        let permissions = crate::policy::rules(mode, permission_mode)?;
        if model.provider_id.is_empty() || model.model_id.is_empty() {
            return Err("请选择可用模型".into());
        }
        let project = canonical_project(project).await?;
        let mut body = json!({ "location": { "directory": project }, "agent": mode, "permissions": permissions, "model": { "providerID": model.provider_id, "id": model.model_id } });
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

    pub async fn switch_model(
        &self,
        session_id: &str,
        model: &AgentModelRef,
    ) -> Result<AgentSession, String> {
        validate_id(session_id, "ses")?;
        if model.provider_id.is_empty() || model.model_id.is_empty() {
            return Err("请选择可用模型".into());
        }
        let lock = self.mutation_lock(session_id).await;
        let _guard = lock.lock().await;
        self.ensure_session_idle(session_id).await?;
        self.request(
            Method::POST,
            &format!("/api/session/{session_id}/model"),
            Some(&json!({"model":{"providerID":model.provider_id,"id":model.model_id}})),
        )
        .await?;
        self.session(session_id).await
    }

    /// Both the agent and permissions are persisted upstream for future turns.
    pub async fn configure_session(
        &self,
        session_id: &str,
        mode: &str,
        permission_mode: &str,
    ) -> Result<AgentSession, String> {
        validate_id(session_id, "ses")?;
        let permissions = crate::policy::rules(mode, permission_mode)?;
        let lock = self.mutation_lock(session_id).await;
        let _guard = lock.lock().await;
        self.ensure_session_idle(session_id).await?;
        let path = format!("/api/session/{session_id}");
        let old = self.request(Method::GET, &path, None).await?;
        let old_agent = old["data"]["agent"].as_str().unwrap_or("build");
        let old_permissions = old["data"]["permissions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        self.inner
            .configuration_uncertain
            .lock()
            .await
            .insert(session_id.into());
        let result = self
            .request(
                Method::PATCH,
                &path,
                Some(&json!({"permissions":permissions})),
            )
            .await;
        let result = match result {
            Ok(_) => {
                self.request(
                    Method::POST,
                    &format!("{path}/agent"),
                    Some(&json!({"agent":mode})),
                )
                .await
            }
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            // A timeout may follow either successful write; restore both parts.
            let restore_agent = self
                .request(
                    Method::POST,
                    &format!("{path}/agent"),
                    Some(&json!({"agent":old_agent})),
                )
                .await;
            let restore_policy = self
                .request(
                    Method::PATCH,
                    &path,
                    Some(&json!({"permissions":old_permissions})),
                )
                .await;
            if restore_agent.is_err() || restore_policy.is_err() {
                return Err(format!(
                    "{error}；恢复设置未完成，请重新设置会话权限后再发送任务"
                ));
            }
            self.inner
                .configuration_uncertain
                .lock()
                .await
                .remove(session_id);
            return Err(error);
        }
        let session = self.session(session_id).await?;
        self.inner
            .configuration_uncertain
            .lock()
            .await
            .remove(session_id);
        Ok(session)
    }

    pub async fn rename_session(
        &self,
        session_id: &str,
        title: &str,
    ) -> Result<AgentSession, String> {
        validate_id(session_id, "ses")?;
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 256 {
            return Err("会话名称需为 1 到 256 个字符".into());
        }
        let lock = self.mutation_lock(session_id).await;
        let _guard = lock.lock().await;
        self.request(
            Method::PATCH,
            &format!("/api/session/{session_id}"),
            Some(&json!({"title":title})),
        )
        .await?;
        self.session(session_id).await
    }

    /// Upstream deletes the selected session and its descendants. Protect that
    /// entire subtree, while allowing unrelated projects to keep working.
    pub async fn delete_session(&self, session_id: &str) -> Result<(), String> {
        validate_id(session_id, "ses")?;
        let lock = self.mutation_lock(session_id).await;
        let _guard = lock.lock().await;
        self.ensure_session_idle(session_id).await?;
        let descendants = self.descendants(session_id).await?;
        let mut child_guards = Vec::new();
        // Discovery order places every ancestor before its descendants. Keep
        // that lock order when a parent and one of its children are deleted
        // concurrently; lexical ID sorting could invert ancestry and deadlock.
        for child in &descendants {
            child_guards.push(self.mutation_lock(child).await.lock_owned().await);
        }
        for child in &descendants {
            if self.is_session_busy(child).await? {
                return Err("请先停止该会话及其子会话中的任务，再删除会话".into());
            }
        }
        self.request(Method::DELETE, &format!("/api/session/{session_id}"), None)
            .await?;
        self.forget_session(session_id).await;
        for child in descendants {
            self.forget_session(&child).await;
        }
        Ok(())
    }

    async fn descendants(&self, session_id: &str) -> Result<Vec<String>, String> {
        let mut parents = vec![session_id.to_owned()];
        let mut seen = HashSet::from([session_id.to_owned()]);
        let mut children = Vec::new();
        while let Some(parent) = parents.pop() {
            let mut cursor: Option<String> = None;
            let mut cursors = HashSet::new();
            loop {
                let mut url = url::Url::parse(&format!("{}/api/session", self.inner.endpoint))
                    .map_err(|_| "引擎地址无效")?;
                url.query_pairs_mut().append_pair("limit", "100");
                if let Some(cursor) = &cursor {
                    url.query_pairs_mut().append_pair("cursor", cursor);
                } else {
                    url.query_pairs_mut()
                        .append_pair("parentID", &parent)
                        .append_pair("order", "asc");
                }
                let page = self.request_url(Method::GET, url.as_str(), None).await?;
                for child in mapping::array(&page["data"]) {
                    let id = child["id"].as_str().ok_or("引擎子会话结构无效")?;
                    validate_id(id, "ses")?;
                    if child["parentID"].as_str() != Some(parent.as_str())
                        || !seen.insert(id.to_owned())
                    {
                        return Err("引擎子会话结构无效".into());
                    }
                    if seen.len() > 10000 {
                        return Err("引擎子会话数量异常".into());
                    }
                    parents.push(id.to_owned());
                    children.push(id.to_owned());
                }
                cursor = page["cursor"]["next"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                let Some(next) = &cursor else {
                    break;
                };
                if !cursors.insert(next.clone()) {
                    return Err("引擎子会话分页异常".into());
                }
            }
        }
        Ok(children)
    }

    async fn forget_session(&self, session_id: &str) {
        self.inner.live.lock().await.untrack(session_id);
        self.inner.snapshots.lock().await.remove(session_id);
        self.inner.mutations.lock().await.remove(session_id);
        self.inner
            .configuration_uncertain
            .lock()
            .await
            .remove(session_id);
    }

    /// Native removal also deletes descendants, including ones tracked earlier.
    /// Confirm that the session itself is gone; a missing permission, transient
    /// failure or unsupported route must never be mistaken for an idle session.
    async fn forget_if_missing(&self, session_id: &str) -> bool {
        let url = format!("{}/api/session/{session_id}", self.inner.endpoint);
        match self.http_request(Method::GET, &url, None).await {
            Err(error)
                if error.status == Some(404)
                    && matches!(
                        error.tag.as_deref(),
                        Some("SessionNotFoundError" | "Session.NotFoundError")
                    ) =>
            {
                self.forget_session(session_id).await;
                true
            }
            _ => false,
        }
    }

    pub async fn list_skills(&self, project: &Path) -> Result<Vec<AgentSkill>, String> {
        let value = self.location_catalog(project, "skill").await?;
        Ok(mapping::array(&value["data"])
            .iter()
            .map(|item| AgentSkill {
                id: mapping::string(item, "id"),
                name: mapping::string(item, "name"),
                description: item["description"].as_str().map(str::to_owned),
                autoinvoke: item["autoinvoke"].as_bool(),
            })
            .collect())
    }

    pub async fn list_plugins(&self, project: &Path) -> Result<Vec<AgentPlugin>, String> {
        let value = self.location_catalog(project, "plugin").await?;
        Ok(mapping::array(&value["data"])
            .iter()
            .map(|item| AgentPlugin {
                id: item["id"].as_str().map(str::to_owned),
                source_type: mapping::string(&item["source"], "type"),
                target: plugin_target(&item["source"]),
                version: item["source"]["version"].as_str().map(str::to_owned),
                server: item["features"]["server"] == true,
                tui: item["features"]["tui"] == true,
                rpc: item["features"]["rpc"] == true,
                status: mapping::string(&item["state"], "status"),
                // Loader errors can contain dynamically acquired credentials not in
                // the launch config. Publish real status without raw diagnostics.
                error: (item["state"]["status"] == "failed").then(|| "插件未能加载".into()),
            })
            .collect())
    }

    pub async fn list_mcp(&self, project: &Path) -> Result<Vec<AgentMcpServer>, String> {
        let value = self.location_catalog(project, "mcp").await?;
        Ok(mapping::array(&value["data"])
            .iter()
            .map(|item| AgentMcpServer {
                name: mapping::string(item, "name"),
                status: mapping::string(&item["status"], "status"),
                error: match item["status"]["status"].as_str() {
                    Some("failed") => Some("MCP 服务连接失败".into()),
                    Some("needs_auth") => Some("MCP 服务需要登录授权".into()),
                    _ => None,
                },
            })
            .collect())
    }

    /// Native v2 activation appends a skill message and resumes execution.
    pub async fn activate_skill(&self, session_id: &str, skill_id: &str) -> Result<(), String> {
        validate_id(session_id, "ses")?;
        if skill_id.is_empty() || skill_id.len() > 1024 {
            return Err("请选择可用技能".into());
        }
        let lock = self.mutation_lock(session_id).await;
        let _guard = lock.lock().await;
        self.ensure_configuration_known(session_id).await?;
        self.ensure_session_idle(session_id).await?;
        self.inner.live.lock().await.track(session_id);
        self.request(
            Method::POST,
            &format!("/api/experimental/session/{session_id}/skill"),
            Some(&json!({"id":skill_id,"resume":true})),
        )
        .await?;
        Ok(())
    }

    async fn location_catalog(&self, project: &Path, kind: &str) -> Result<Value, String> {
        let project = canonical_project(project).await?;
        let mut url = url::Url::parse(&format!("{}/api/{kind}", self.inner.endpoint))
            .map_err(|_| "引擎地址无效")?;
        url.query_pairs_mut()
            .append_pair("location[directory]", &project);
        let mut value = self.request_url(Method::GET, url.as_str(), None).await?;
        self.redact_value(&mut value);
        Ok(value)
    }

    async fn mutation_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        self.inner
            .mutations
            .lock()
            .await
            .entry(session_id.into())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn ensure_configuration_known(&self, session_id: &str) -> Result<(), String> {
        if self
            .inner
            .configuration_uncertain
            .lock()
            .await
            .contains(session_id)
        {
            return Err("会话设置未同步，请重新设置会话权限后再发送任务".into());
        }
        let session = self.session(session_id).await?;
        if session.mode == "plan" && session.permission_mode == "custom" {
            // Also catches an interrupted partial write after a process restart:
            // a Plan agent with arbitrary permissions is not proven read-only.
            return Err("分析模式的权限未同步，请重新选择分析模式后再发送任务".into());
        }
        Ok(())
    }

    async fn ensure_session_idle(&self, session_id: &str) -> Result<(), String> {
        if self.is_session_busy(session_id).await? {
            return Err("请等待任务和授权处理完成，再修改会话设置".into());
        }
        Ok(())
    }

    pub async fn is_session_busy(&self, session_id: &str) -> Result<bool, String> {
        validate_id(session_id, "ses")?;
        let path = format!("/api/session/{session_id}");
        let inbox_path = format!("{path}/inbox");
        let permission_path = format!("{path}/permission");
        let form_path = format!("{path}/form");
        let (active, inbox, permissions, forms) = tokio::try_join!(
            self.request(Method::GET, "/api/session/active", None),
            self.request(Method::GET, &inbox_path, None),
            self.request(Method::GET, &permission_path, None),
            self.request(Method::GET, &form_path, None)
        )?;
        let pending = self
            .inner
            .live
            .lock()
            .await
            .pending
            .get(session_id)
            .cloned();
        let native_busy = active["data"][session_id]["type"] == "running"
            || inbox_has_work(&inbox["data"], &self.inner.plan_enter_reminder)
            || !mapping::array(&permissions["data"]).is_empty()
            || !mapping::array(&forms["data"]).is_empty();
        let pending_run = if let Some((id, _)) = pending {
            pending_unsettled(&id, &self.read_messages(session_id).await?, native_busy)
        } else {
            false
        };
        Ok(native_busy || pending_run)
    }

    pub async fn pending_permissions(
        &self,
        session_id: &str,
    ) -> Result<Vec<AgentPermission>, String> {
        validate_id(session_id, "ses")?;
        let mut value = self
            .request(
                Method::GET,
                &format!("/api/session/{session_id}/permission"),
                None,
            )
            .await?;
        let mut messages = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for request in mapping::array(&value["data"]) {
            if request["action"] != "shell" || request["source"]["type"] != "tool" {
                continue;
            }
            let Some(message_id) = request["source"]["messageID"].as_str() else {
                continue;
            };
            if validate_id(message_id, "msg_").is_err() || !seen.insert(message_id.to_owned()) {
                continue;
            }
            // A pending request can outlive a deleted/unavailable source. In
            // that case keep the user gate, rather than trusting its resources.
            if let Ok(mut source) = self
                .request(
                    Method::GET,
                    &format!("/api/session/{session_id}/message/{message_id}"),
                    None,
                )
                .await
            {
                self.redact_value(&mut source);
                if let Some(message) = mapping::message(&source["data"]) {
                    messages.push(message);
                }
            }
        }
        self.redact_value(&mut value);
        Ok(mapping::array(&value["data"])
            .iter()
            .map(|p| mapping::permission(p, &messages))
            .collect())
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

    /// Bounded lifecycle metadata for isolated engine verification. Never return
    /// message text, tool input/output, provider config or connection credentials.
    pub async fn lifecycle_diagnostic(&self, session_id: &str) -> Result<Value, String> {
        validate_id(session_id, "ses")?;
        let path = format!("/api/session/{session_id}");
        let inbox_path = format!("{path}/inbox");
        let (active, inbox, session) = tokio::try_join!(
            self.request(Method::GET, "/api/session/active", None),
            self.request(Method::GET, &inbox_path, None),
            self.request(Method::GET, &path, None)
        )?;
        let messages = self.read_messages(session_id).await?;
        let pending = self
            .inner
            .live
            .lock()
            .await
            .pending
            .get(session_id)
            .cloned();
        let pending_index = pending.as_ref().and_then(|(id, _)| {
            messages
                .iter()
                .position(|m| m["id"].as_str() == Some(id.as_str()))
        });
        let facts=messages.iter().map(|message|json!({
            "id":message["id"].as_str(),"type":message["type"].as_str(),
            "outcome":message["outcome"].as_str(),"createdAt":message["time"]["created"].as_u64(),
            "completedAt":message["time"]["completed"].as_u64(),
            "errorType":message["error"]["type"].as_str().or_else(||message["error"]["_tag"].as_str()),
            "tools":mapping::array(&message["content"]).iter().filter(|p|p["type"]=="tool").map(|tool|json!({
                "id":tool["id"].as_str(),"name":tool["name"].as_str(),"status":tool["state"]["status"].as_str(),
                "errorType":tool["state"]["error"]["type"].as_str().or_else(||tool["state"]["error"]["_tag"].as_str())
            })).collect::<Vec<_>>()
        })).collect::<Vec<_>>();
        let mut facts = json!({
            "activeType":active["data"][session_id]["type"].as_str(),
            "inboxCount":mapping::array(&inbox["data"]).len(),
            "inboxKinds":mapping::array(&inbox["data"]).iter().map(|m|m["type"].as_str()).collect::<Vec<_>>(),
            "sessionOutcome":session["data"]["outcome"].as_str(),"sessionIdleAt":session["data"]["time"]["idle"].as_u64(),
            "pendingRequestId":pending.as_ref().map(|(id,_)|id),"pendingPresent":pending_index.is_some(),"pendingIndex":pending_index,
            "idleAfterPending":pending_index.map(|index|messages.iter().skip(index+1).filter(|m|m["type"]=="idle").count()),
            "messages":facts
        });
        self.redact_value(&mut facts);
        Ok(facts)
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
        let inbox_path = format!("{path}/inbox");
        let (raw_session, active, permissions, questions, inbox) = tokio::try_join!(
            self.request(Method::GET, &path, None),
            self.request(Method::GET, "/api/session/active", None),
            self.request(Method::GET, &permission_path, None),
            self.request(Method::GET, &question_path, None),
            self.request(Method::GET, &inbox_path, None)
        )?;
        let raw_messages = self.read_messages(session_id).await?;
        let session = mapping::session(&raw_session["data"])?;
        let mut messages: Vec<_> = raw_messages.iter().filter_map(mapping::message).collect();
        let latest_idle = raw_messages.iter().rev().find(|m| m["type"] == "idle");
        let native_running = active["data"][session_id]["type"] == "running";
        let queued = inbox_has_work(&inbox["data"], &self.inner.plan_enter_reminder);
        let native_busy = native_running
            || queued
            || !mapping::array(&permissions["data"]).is_empty()
            || !mapping::array(&questions["data"]).is_empty();
        let aborted = raw_messages
            .iter()
            .rev()
            .find(|m| m["type"] == "user")
            .and_then(|m| m["id"].as_str())
            .and_then(|id| aborted_completion_after(id, &raw_messages));
        let mut live = self.inner.live.lock().await;
        let gap = live.overlay(session_id, &mut messages);
        let pending = live.pending.get(session_id).cloned();
        let pending_run = pending
            .as_ref()
            .is_some_and(|(id, _)| pending_unsettled(id, &raw_messages, native_busy));
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
        let running = native_running || queued || pending_run;
        let failed = !running
            && (latest_idle.is_some_and(|idle| idle["outcome"] == "failed")
                || (!native_busy && aborted.is_some()));
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
            title_pending: false,
            compacting: false,
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
        let lock = self.mutation_lock(session_id).await;
        let _guard = lock.lock().await;
        self.ensure_configuration_known(session_id).await?;
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
        let lock = self.mutation_lock(session_id).await;
        let _guard = lock.lock().await;
        if decision == "reject" {
            let requests = self
                .request(
                    Method::GET,
                    &format!("/api/session/{session_id}/permission"),
                    None,
                )
                .await?;
            if !mapping::array(&requests["data"]).iter().any(|request| {
                request["id"].as_str() == Some(request_id)
                    && request["sessionID"].as_str() == Some(session_id)
            }) {
                return Err("该授权请求已结束，请刷新会话".into());
            }
            // Native decline interrupts the turn without a user reason, which
            // preserves its shutdown claim for automatic restart. A scoped
            // user stop cancels the same turn and releases that durable claim;
            // cancellation also removes the permission's waiting deferred.
            let accepted = self
                .request(
                    Method::POST,
                    &format!("/api/session/{session_id}/interrupt?resume=false"),
                    None,
                )
                .await?;
            if accepted["interrupted"] != true {
                return Err("任务状态已变化，未接受本次停止，请刷新会话".into());
            }
            // The interrupt ACK is not settlement. Keep the pending marker
            // until a native terminal record and empty lifecycle gates agree.
            return Ok(());
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
            let messages = if pending.is_some() {
                let messages = match self.read_messages(&session).await {
                    Ok(messages) => messages,
                    Err(error) => {
                        if self.forget_if_missing(&session).await {
                            continue;
                        }
                        return Err(error);
                    }
                };
                messages
            } else {
                Vec::new()
            };
            let permission_path = format!("/api/session/{session}/permission");
            let question_path = format!("/api/session/{session}/form");
            let inbox_path = format!("/api/session/{session}/inbox");
            let result = tokio::try_join!(
                self.request(Method::GET, &permission_path, None),
                self.request(Method::GET, &question_path, None),
                self.request(Method::GET, &inbox_path, None)
            );
            let (permissions, forms, inbox) = match result {
                Ok(result) => result,
                Err(error) => {
                    if self.forget_if_missing(&session).await {
                        continue;
                    }
                    return Err(error);
                }
            };
            if !mapping::array(&permissions["data"]).is_empty()
                || !mapping::array(&forms["data"]).is_empty()
                || inbox_has_work(&inbox["data"], &self.inner.plan_enter_reminder)
            {
                return Ok(true);
            }
            if let Some((id, _)) = pending {
                if pending_unsettled(&id, &messages, false) {
                    return Ok(true);
                }
                self.inner.live.lock().await.pending.remove(&session);
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
        self.http_request(method, url, body)
            .await
            .map_err(|error| error.message)
    }

    async fn http_request(
        &self,
        method: Method,
        url: &str,
        body: Option<&Value>,
    ) -> Result<Value, RequestFailure> {
        if !self.is_running() {
            return Err(RequestFailure::plain("编程引擎已退出，请重新打开项目"));
        }
        let mut request = self
            .inner
            .client
            .request(method, url)
            .basic_auth("opencode", Some(&self.inner.password));
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| {
            RequestFailure::plain(self.redact(&format!("无法连接编程引擎：{error}")))
        })?;
        let status = response.status();
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| RequestFailure::plain("无法读取引擎响应"))?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err(RequestFailure::plain("引擎响应过大"));
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| RequestFailure::plain("引擎返回了无法识别的响应"))?;
        if !status.is_success() {
            let message = mapping::structured_error(&value)
                .unwrap_or_else(|| format!("请求失败（{}）", status.as_u16()));
            return Err(RequestFailure {
                message: self.redact(&message),
                status: Some(status.as_u16()),
                tag: value["_tag"].as_str().map(str::to_owned),
            });
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

// Permission decline can persist a completed, aborted assistant without an idle
// message in the pinned runtime. Only the last assistant in this user's turn is
// evidence; an ACK, tool error, incomplete assistant or another turn is not.
fn aborted_completion_after<'a>(id: &str, messages: &'a [Value]) -> Option<&'a Value> {
    let user = messages
        .iter()
        .position(|m| m["type"] == "user" && m["id"].as_str() == Some(id))?;
    let turn: Vec<_> = messages
        .iter()
        .skip(user + 1)
        .take_while(|m| m["type"] != "user")
        .collect();
    if turn.iter().any(|m| m["type"] == "idle") {
        return None;
    }
    let assistant = turn.iter().rev().find(|m| m["type"] == "assistant")?;
    (assistant["time"]["completed"].as_u64().is_some() && assistant["error"]["type"] == "aborted")
        .then_some(*assistant)
}

fn pending_unsettled(id: &str, messages: &[Value], native_busy: bool) -> bool {
    pending_incomplete(id, messages)
        && (native_busy || aborted_completion_after(id, messages).is_none())
}

const PLAN_LEAVE_REMINDER: &str = "<system-reminder>\nYou are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.\n</system-reminder>";

fn plan_enter_reminder(root: &Path) -> String {
    let directory = root
        .join("home")
        .join(".opencode")
        .join("plan")
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    let directory = directory.replace('/', "\\");
    format!("<system-reminder>\nYou are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:\n{directory}\n\nDo not modify any other files or ask a subagent to do so.\n\nYou remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.\n</system-reminder>")
}

fn inbox_has_work(value: &Value, enter_reminder: &str) -> bool {
    mapping::array(value).iter().any(|item| {
        // Pinned opencode.plan emits precisely these inert context notes with
        // resume:false. Public inbox omits that flag, so don't generalize this
        // exception to arbitrary synthetic work or partial text matches.
        !(item["type"] == "synthetic"
            && item["delivery"] == "steer"
            && item["payload"]["description"].is_null()
            && item["payload"]["metadata"].is_null()
            && item["payload"]["text"]
                .as_str()
                .is_some_and(|text| text == PLAN_LEAVE_REMINDER || text == enter_reminder))
    })
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
                if matches!(key.as_str(), "headers" | "environment") {
                    collect_string_values(value, result);
                }
                if key == "plugins" {
                    for plugin in mapping::array(value) {
                        collect_extension_values(&plugin["options"], result);
                    }
                }
                if key == "mcp" {
                    if let Some(servers) = value["servers"].as_object() {
                        for server in servers.values() {
                            for arg in mapping::array(&server["command"]).iter().skip(1) {
                                collect_extension_values(arg, result);
                            }
                        }
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

fn collect_string_values(value: &Value, result: &mut Vec<String>) {
    match value {
        Value::String(value) if !value.is_empty() => result.push(value.clone()),
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_string_values(item, result)),
        Value::Object(items) => items
            .values()
            .for_each(|item| collect_string_values(item, result)),
        _ => {}
    }
}

fn collect_extension_values(value: &Value, result: &mut Vec<String>) {
    match value {
        // Unknown options/argv contain ordinary short words as well as secrets.
        // Keep existing known-credential behavior, without globally replacing
        // one-character switches or common short configuration values.
        Value::String(value) if value.len() >= 4 => result.push(value.clone()),
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_extension_values(item, result)),
        Value::Object(items) => items
            .values()
            .for_each(|item| collect_extension_values(item, result)),
        _ => {}
    }
}

fn public_package_target(target: &str) -> String {
    if let Ok(mut url) = url::Url::parse(target) {
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        url.to_string()
    } else {
        target.into()
    }
}

fn plugin_target(source: &Value) -> Option<String> {
    if source["type"] == "local" {
        return owned_plugin_target(source["path"].as_str()?);
    }
    source["target"].as_str().map(public_package_target)
}

/// Match the immutable owned projection layout without publishing a user's
/// absolute private root or arbitrary external local plugin paths.
fn owned_plugin_target(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    let absolute = path.starts_with('/')
        || (path.as_bytes().get(1) == Some(&b':')
            && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && path.as_bytes().get(2) == Some(&b'/'));
    if !absolute || path.contains('\0') {
        return None;
    }
    let (root, tail) = path.rsplit_once("/extensions/catalogs/")?;
    if root.is_empty() {
        return None;
    }
    let parts = tail.split('/').collect::<Vec<_>>();
    if parts.len() < 4 || parts[1] != "plugins" {
        return None;
    }
    let (revision, hash) = parts[0].split_once('-')?;
    if revision.is_empty()
        || !revision.bytes().all(|c| c.is_ascii_digit())
        || revision.parse::<u64>().is_err()
        || hash.len() != 16
        || !hash.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return None;
    }
    let asset = parts[2];
    if asset.is_empty()
        || asset.len() > 80
        || !asset
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return None;
    }
    if parts[3..].iter().any(|part| {
        part.is_empty() || matches!(*part, "." | "..") || part.contains([':', '?', '#'])
    }) {
        return None;
    }
    Some(format!("plugins/{asset}/{}", parts[3..].join("/")))
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
        engine_with_config(endpoint, password, &json!({}))
    }
    pub(crate) fn engine_with_config(endpoint: String, password: String, config: &Value) -> Engine {
        let (stop, _) = watch::channel(false);
        let mut secrets = vec![endpoint.clone(), password.clone()];
        collect_secrets(config, &mut secrets);
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
                secrets,
                plan_enter_reminder: plan_enter_reminder(Path::new("/fixture-owned-runtime")),
                child: Mutex::new(None),
                stdin: Mutex::new(None),
                live: Mutex::new(LiveState::default()),
                running: AtomicBool::new(true),
                stop,
                snapshots: Mutex::new(HashMap::new()),
                mutations: Mutex::new(HashMap::new()),
                configuration_uncertain: Mutex::new(HashSet::new()),
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
    pub(crate) fn plan_note(enter: bool) -> String {
        if enter {
            plan_enter_reminder(Path::new("/fixture-owned-runtime"))
        } else {
            PLAN_LEAVE_REMINDER.into()
        }
    }
    pub(crate) fn js_path(path: &str) -> String {
        js_project_path(path)
    }
    pub(crate) fn secrets(config: &Value) -> Vec<String> {
        let mut result = Vec::new();
        collect_secrets(config, &mut result);
        result
    }
}
