//! Desktop ownership for Harness and for LoliCode's project and channel data.
use super::{
    agent_host::{
        canonical_project_or_restore_standalone, prepare_native_binding, AgentOpenProject,
        AgentRuntimeStatus, AgentWorkspace,
    },
    agent_preferences as preferences,
    channel_center::{self, AgentCatalog},
    harness_sessions::{argument, encode, role, SessionStore},
    inprocess_extensions::{InprocessExtensionStore, SkillSnapshot},
};
use crate::store::AppState;
use lolicode_agent::AgentStatus;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::Path, sync::Arc, time::Duration};
use tauri::Manager;
use tokio::sync::{Mutex, MutexGuard, OnceCell, RwLock};

#[derive(Default)]
pub struct InprocessAgentState {
    lifecycle: Mutex<()>,
    pub(crate) harness: super::harness_desktop::HarnessDesktop,
    sessions: OnceCell<RwLock<SessionStore>>,
    app_state: OnceCell<AppState>,
    binding: RwLock<Option<AgentOpenProject>>,
    extensions: OnceCell<Arc<InprocessExtensionStore>>,
    remote: OnceCell<Arc<super::remote_projects::RemoteProjects>>,
    skill_snapshot: RwLock<Option<SkillSnapshot>>,
    mcp: OnceCell<Arc<super::native_mcp::NativeMcpTools>>,
    mcp_error: RwLock<Option<String>>,
    pub(crate) browser: super::agent_browser::BrowserTools,
    pub(crate) harness_preview: super::harness_preview::HarnessPreview,
    secretary_github_monitor: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

pub struct NativeUpdateLease<'a> {
    _guard: MutexGuard<'a, ()>,
}

impl InprocessAgentState {
    pub(crate) async fn lock_harness_admission(&self) -> MutexGuard<'_, ()> {
        self.lifecycle.lock().await
    }

    pub(super) async fn automatic_title_allowed(&self, id: &str) -> Result<bool, String> {
        Ok(self.sessions()?.read().await.automatic_title_allowed(id))
    }

    pub(super) async fn accept_automatic_title(
        &self,
        id: &str,
        title: &str,
        generated: bool,
    ) -> Result<Option<lolicode_agent::AgentSession>, String> {
        self.sessions()?
            .write()
            .await
            .accept_automatic_title(id, title, generated)
    }

    pub async fn ensure_started(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self.sessions.get().is_some() {
            return Ok(());
        }
        let _guard = self.lifecycle.lock().await;
        self.start_locked(app).await
    }

    async fn start_locked(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self.sessions.get().is_some() {
            return Ok(());
        }
        let state = app.state::<AppState>();
        let profile = crate::config::get_app_config_dir();
        let sessions = tokio::task::spawn_blocking(move || SessionStore::load(&profile))
            .await
            .map_err(|_| "无法初始化会话目录")??;
        let _ = self.app_state.set(state.inner().clone());
        #[cfg(windows)]
        self.browser.set_app(app.clone());
        self.remote_projects(&state).await;
        self.mcp
            .get_or_init(|| async { Arc::new(super::native_mcp::NativeMcpTools::new()) })
            .await;
        let mut bundled = app
            .path()
            .resource_dir()
            .map_err(|_| "无法定位技能资源目录")?
            .join("agent/extensions");
        if cfg!(debug_assertions) && !bundled.join("manifest.json").is_file() {
            bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/agent/extensions");
        }
        if let Ok(store) = InprocessExtensionStore::new(
            crate::config::get_app_config_dir().join("agent/extensions"),
            bundled,
        ) {
            let _ = self.extensions.set(Arc::new(store));
        }
        let _ = self.sessions.set(RwLock::new(sessions));
        *self.secretary_github_monitor.lock().await =
            Some(start_secretary_github_monitor(app.clone()));
        if let Err(error) = self.sync_mcp_config().await {
            log::warn!("MCP 暂不可用：{error}");
        }
        Ok(())
    }

    async fn sync_mcp_config(&self) -> Result<(), String> {
        let result = async {
            if let (Some(store), Some(mcp)) = (self.extensions.get(), self.mcp.get()) {
                let (revision, config) =
                    store.store().raw_mcp_config().map_err(|e| e.to_string())?;
                mcp.configure(revision, config).await?;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = &result {
            if let Some(mcp) = self.mcp.get() {
                let _ = mcp.invalidate().await;
            }
            *self.mcp_error.write().await = Some(error.clone());
        } else {
            *self.mcp_error.write().await = None;
        }
        result
    }

    pub(super) async fn harness_mcp(&self) -> Option<Arc<super::native_mcp::NativeMcpTools>> {
        self.sync_mcp_config().await.ok()?;
        self.mcp.get().cloned()
    }

    async fn discover_mcp(&self, project: &Path) -> Result<(), String> {
        self.sync_mcp_config().await?;
        if self.remote.get().is_some_and(|remote| remote.owns(project)) {
            return Ok(());
        }
        if let Some(mcp) = self.mcp.get() {
            let (_stop, cancel) = tokio::sync::watch::channel(false);
            mcp.discover(project, cancel).await?;
        }
        Ok(())
    }

    pub async fn connect_mcp(&self) -> Result<(), String> {
        let project = self.workspace_path().await.ok_or("请先打开一个本地项目")?;
        if self
            .remote
            .get()
            .is_some_and(|remote| remote.owns(Path::new(&project)))
        {
            return Err("MCP 连接属于本地项目；远程项目暂不连接本机服务".into());
        }
        self.discover_mcp(Path::new(&project)).await
    }

    fn decorate_mcp_catalog(&self, value: &mut Value, project: Option<&str>) {
        value["mcpRuntime"] = json!(true);
        value["mcpRuntimeError"] = json!(self.mcp_error.try_read().ok().and_then(|e| e.clone()));
        let statuses = self
            .mcp
            .get()
            .zip(project)
            .map(|(mcp, project)| mcp.status_catalog(Path::new(project)))
            .unwrap_or_default();
        for entry in value["mcpServers"].as_array_mut().into_iter().flatten() {
            let status = statuses.iter().find(|s| s["name"] == entry["id"]);
            let connected = status.is_some_and(|s| s["status"] == "connected");
            entry["loaded"] = json!(connected);
            entry["runtimeStatus"] = status.map(|s| s["status"].clone()).unwrap_or_else(|| {
                json!(if entry["enabled"] == true {
                    "disconnected"
                } else {
                    "disabled"
                })
            });
            entry["error"] = status.map(|s| s["error"].clone()).unwrap_or(Value::Null);
            entry["toolCount"] = status.map(|s| s["toolCount"].clone()).unwrap_or(json!(0));
        }
        value["loadedMcpServers"] = json!(statuses
            .into_iter()
            .filter(|s| s["status"] == "connected")
            .collect::<Vec<_>>());
    }

    pub async fn remote_projects(
        &self,
        state: &AppState,
    ) -> Arc<super::remote_projects::RemoteProjects> {
        self.remote
            .get_or_init(|| async {
                Arc::new(super::remote_projects::RemoteProjects::new(
                    state.db.clone(),
                    crate::config::get_app_config_dir().join("agent/remote-workspaces"),
                ))
            })
            .await
            .clone()
    }

    async fn validate_remote_project(
        &self,
        state: &AppState,
        path: &Path,
    ) -> Result<Option<super::agent_host::RemoteWorkspace>, String> {
        let remote = self.remote_projects(state).await;
        if !remote.owns(path) {
            return Ok(None);
        }
        let resolved = remote.resolve(path)?;
        let (_stop, cancel) = tokio::sync::watch::channel(false);
        let checked = remote.call(path, "open_project", json!({}), cancel).await?;
        if checked["root"].as_str() != Some(&resolved.project.root) {
            return Err("远程项目目录已改变，请在 SSH / WSL 中重新选择项目".into());
        }
        Ok(Some(super::agent_host::RemoteWorkspace {
            connection_name: resolved.connection.name,
            root: resolved.project.root,
            kind: match resolved.connection.target {
                super::remote_transport::RemoteTarget::Ssh { .. } => "ssh",
                super::remote_transport::RemoteTarget::Wsl { .. } => "wsl",
            }
            .into(),
        }))
    }

    pub async fn bind_background_project(
        &self,
        app: &tauri::AppHandle,
        state: &AppState,
        path: String,
        accounts: Vec<(String, String)>,
    ) -> Result<AgentCatalog, String> {
        let remote = self.remote_projects(state).await;
        let remote_requested = remote.owns(Path::new(&path));
        let path =
            tokio::task::spawn_blocking(move || canonical_project_or_restore_standalone(&path))
                .await
                .map_err(|_| "项目目录检查未完成")??;
        if remote_requested && !remote.owns(&path) {
            return Err("远程项目标识指向了其他目录，请检查应用数据；此次打开已取消".into());
        }
        let _guard = self.lifecycle.lock().await;
        self.start_locked(app).await?;
        self.validate_remote_project(state, &path).await?;
        let prepared = prepare_native_binding(state, &accounts).await?;
        Ok(prepared.catalog)
    }

    fn sessions(&self) -> Result<&RwLock<SessionStore>, String> {
        self.sessions
            .get()
            .ok_or("Agent 尚未初始化，请重新打开项目".into())
    }

    async fn sync_skills(&self) -> Result<(), String> {
        let Some(store) = self.extensions.get().cloned() else {
            return Ok(());
        };
        let snapshot = tokio::task::spawn_blocking(move || store.prepare_skills())
            .await
            .map_err(|_| "技能目录读取未完成")?
            .map_err(|e| e.to_string())?;
        *self.skill_snapshot.write().await = Some(snapshot);
        Ok(())
    }

    pub(super) async fn workspace_skills(&self) -> Value {
        if let Err(error) = self.sync_skills().await {
            log::warn!("无法读取已启用的技能：{error}");
            return json!([]);
        }
        self.skill_snapshot
            .read()
            .await
            .as_ref()
            .and_then(|snapshot| serde_json::to_value(&snapshot.verified_skills).ok())
            .unwrap_or_else(|| json!([]))
    }

    async fn extension_call(&self, method: &str, args: &Value) -> Result<Option<Value>, String> {
        if !matches!(
            method,
            "getExtensions"
                | "getExtensionConfig"
                | "setSkillEnabled"
                | "importSkill"
                | "removeSkill"
                | "installPlugin"
                | "setPluginEnabled"
                | "uninstallPlugin"
                | "saveExtensionConfig"
                | "getPluginStore"
                | "addPluginMarketplace"
                | "updatePluginMarketplace"
                | "removePluginMarketplace"
                | "installMarketplacePlugin"
                | "updateMarketplacePlugin"
                | "uninstallMarketplacePlugin"
                | "restoreBuiltinPlugin"
        ) {
            return Ok(None);
        }
        let store = self
            .extensions
            .get()
            .ok_or("默认技能资源不可用，请使用完整安装包；核心编程仍可运行")?;
        let id = || args["id"].as_str().ok_or("缺少扩展编号");
        let enabled = || args["enabled"].as_bool().ok_or("缺少启用状态");
        if matches!(
            method,
            "getPluginStore"
                | "addPluginMarketplace"
                | "updatePluginMarketplace"
                | "removePluginMarketplace"
                | "installMarketplacePlugin"
                | "updateMarketplacePlugin"
                | "uninstallMarketplacePlugin"
                | "restoreBuiltinPlugin"
        ) {
            let value = store.marketplace_call(method, args).await?;
            self.sync_skills().await?;
            return Ok(Some(value));
        }
        match method {
            "getExtensionConfig" => {
                return serde_json::to_value(store.store().config().map_err(|e| e.to_string())?)
                    .map(Some)
                    .map_err(|_| "扩展配置编码失败".into())
            }
            "setSkillEnabled" => {
                store
                    .store()
                    .set_skill_enabled(id()?, enabled()?)
                    .map_err(|e| e.to_string())?;
            }
            "importSkill" => {
                store
                    .store()
                    .import_skill(Path::new(args["path"].as_str().ok_or("请选择技能目录")?))
                    .map_err(|e| e.to_string())?;
            }
            "removeSkill" => {
                store
                    .store()
                    .remove_skill(id()?)
                    .map_err(|e| e.to_string())?;
            }
            "installPlugin" => {
                store
                    .store()
                    .install_plugin(Path::new(args["path"].as_str().ok_or("请选择插件目录")?))
                    .map_err(|e| e.to_string())?;
            }
            "setPluginEnabled" => {
                if id()?.starts_with("cli-") {
                    store.marketplace_call("setCliPluginEnabled", args).await?;
                } else {
                    store
                        .store()
                        .set_plugin_enabled(id()?, enabled()?)
                        .map_err(|e| e.to_string())?;
                }
            }
            "uninstallPlugin" => {
                store
                    .store()
                    .uninstall_plugin(id()?)
                    .map_err(|e| e.to_string())?;
            }
            "saveExtensionConfig" => {
                store
                    .store()
                    .save_config(
                        serde_json::from_value(args["config"].clone())
                            .map_err(|_| "扩展配置无效")?,
                    )
                    .map_err(|e| e.to_string())?;
            }
            "getExtensions" => {}
            _ => return Ok(None),
        }
        self.sync_skills().await?;
        if let Err(error) = self.sync_mcp_config().await {
            log::warn!("MCP 配置暂不可用：{error}");
        }
        let loaded = BTreeSet::new();
        let active = self.skill_snapshot.read().await;
        let mut value = store
            .catalog(active.as_ref(), &loaded)
            .map_err(|e| e.to_string())?;
        let project = self.workspace_path().await;
        self.decorate_mcp_catalog(&mut value, project.as_deref());
        Ok(Some(value))
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
        let result = match self.extension_call(method, &args).await? {
            Some(value) => value,
            None => self.metadata_call(method, &args).await?,
        };
        serde_json::from_value(result).map_err(|_| "Agent 桌面数据格式不兼容".into())
    }

    async fn metadata_call(&self, method: &str, args: &Value) -> Result<Value, String> {
        let sessions = self.sessions()?;
        let id = || argument(args, "sessionId");
        let state = self.app_state.get().ok_or("应用数据尚未初始化")?;
        match method {
            "busy" => Ok(json!(self.busy().await?)),
            "activity" => {
                let busy = self.busy().await?;
                Ok(
                    json!({"engine":"deepseek-harness","inProcess":false,"features":{"workflows":true,"automation":true,"remote":true},"busy":busy,"active":busy,"unknown":false,"source":"harness-sdk"}),
                )
            }
            "capabilities" => Ok(
                json!({"engine":"deepseek-harness","inProcess":false,"features":{"chat":true,"streaming":true,"tools":true,"permissions":true,"questions":true,"skills":true,"workflows":true,"automation":true,"remote":true,"mcp":true,"plugins":false}}),
            ),
            "createSession" | "openSecretary" => {
                let project = match args["projectPath"].as_str() {
                    Some(path) => path.to_owned(),
                    None => self.workspace_path().await.ok_or("请先打开项目")?,
                };
                let navigation = preferences::load(&state.db)?;
                let project = &navigation
                    .projects
                    .get(&preferences::path_key(&project))
                    .ok_or("此会话不属于已打开的工作台项目")?
                    .path;
                let catalog =
                    channel_center::agent_catalog(&state.db).map_err(|error| error.to_string())?;
                let remote = self
                    .remote
                    .get()
                    .is_some_and(|host| host.owns(Path::new(project)));
                encode(sessions.write().await.create(
                    project,
                    &catalog,
                    args,
                    method == "openSecretary",
                    remote,
                )?)
            }
            "listSessions" => {
                let project = match args["projectPath"].as_str() {
                    Some(path) => Some(path.to_owned()),
                    None => self.workspace_path().await,
                };
                let mut listed = sessions
                    .read()
                    .await
                    .list(project.as_deref(), args["includeArchived"] == true);
                self.harness.session_list_activity(&mut listed).await?;
                listed.sort_by(|a, b| {
                    b.pinned
                        .cmp(&a.pinned)
                        .then(b.updated_at.cmp(&a.updated_at))
                });
                encode(listed)
            }
            "getSessionMetadata" => encode(sessions.read().await.get(id()?)?),
            "sessionRequiresBackgroundReview" => {
                encode(sessions.read().await.requires_background_review(id()?)?)
            }
            "getSession" => {
                let mut snapshot = sessions.read().await.snapshot(id()?)?;
                super::harness_automation::apply(
                    &crate::config::get_app_config_dir(),
                    &mut snapshot,
                )?;
                encode(snapshot)
            }
            "getSessionExecutionRoot" => {
                let store = sessions.read().await;
                let project = store.get(id()?)?.project_path.clone();
                if args["browserId"].is_string() {
                    return Err("浏览器不属于当前会话".into());
                }
                if let Some(worktree) = store.legacy_worktree(id()?)? {
                    let root = crate::config::get_app_config_dir().join("agent/native");
                    let worktree =
                        lolicode_agent::native::secretary_worktree_root(&root, &worktree).await?;
                    return encode((project, worktree));
                }
                encode((&project, &project))
            }
            "getSecretary" => encode(sessions.read().await.secretary(id()?)?),
            "getSecretaryActivity" => {
                let secretaries = sessions.read().await.list(None, true);
                let mut result = Vec::new();
                for secretary in secretaries
                    .into_iter()
                    .filter(|session| role(session, "secretary"))
                {
                    let mut projection = sessions.read().await.secretary(&secretary.id)?;
                    let status = self
                        .harness
                        .overlay_secretary(&mut projection)
                        .await?
                        .unwrap_or(AgentStatus::Idle);
                    result.push(json!({"sessionId":secretary.id,"projectPath":secretary.project_path,"title":secretary.title,"status":status,"tasks":projection.tasks}));
                }
                encode(result)
            }
            "queryCommand" => sessions
                .read()
                .await
                .query_command(id()?, argument(args, "requestId")?),
            "renameSession" | "setSessionMetadata" | "updateSession" => {
                self.harness.retire_idle(Some(id()?)).await?;
                let catalog =
                    channel_center::agent_catalog(&state.db).map_err(|error| error.to_string())?;
                encode(sessions.write().await.update(method, args, &catalog)?)
            }
            "deleteSession" => {
                if self.harness.session_busy(id()?).await {
                    return Err("请先结束此会话的任务".into());
                }
                self.harness.retire_idle(Some(id()?)).await?;
                sessions.write().await.delete(id()?)?;
                Ok(Value::Null)
            }
            "interruptSession" => {
                sessions.read().await.get(id()?)?;
                Ok(Value::Null)
            }
            "syncSessions" => {
                if self.harness.busy().await {
                    return Err("请等当前会话结束后再同步".into());
                }
                self.harness.retire_idle(None).await?;
                let peer_root = Path::new(argument(args, "peerRoot")?);
                let peer = peer_root
                    .parent()
                    .and_then(Path::parent)
                    .ok_or("另一版本会话目录无效")?;
                let local = crate::config::get_app_config_dir();
                let mut store = sessions.write().await;
                let report = super::harness_session_sync::exchange(
                    &store,
                    &self.harness,
                    &local,
                    peer,
                    argument(args, "direction")?,
                )
                .await?;
                *store = SessionStore::load(&local)?;
                Ok(report)
            }
            "getMemory" | "editMemory" | "configureMemory" | "clearMemory" => {
                let project = match args["projectPath"].as_str() {
                    Some(path) => {
                        if !preferences::load(&state.db)?
                            .projects
                            .contains_key(&preferences::path_key(path))
                        {
                            return Err("请先在工作台打开该项目".into());
                        }
                        Some(path.to_owned())
                    }
                    None => self.workspace_path().await,
                };
                lolicode_agent::native::memory::desktop_call(
                    &crate::config::get_app_config_dir().join("agent/native"),
                    method,
                    args,
                    project.as_deref().map(preferences::path_key).as_deref(),
                )
                .await
            }
            _ => Err(format!("Harness 桌面入口暂不支持 {method}")),
        }
    }

    pub async fn status(&self, app: &tauri::AppHandle) -> Result<AgentRuntimeStatus, String> {
        self.ensure_started(app).await?;
        let version = super::harness_paths::HarnessPaths::resolve(app)
            .ok()
            .map(|paths| format!("deepseek-harness-{}", paths.version));
        let available = version.is_some();
        Ok(AgentRuntimeStatus {
            available,
            version,
            running: available,
            project_path: self.workspace_path().await,
        })
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
        _refresh: bool,
    ) -> Result<AgentOpenProject, String> {
        let remote = self.remote_projects(state).await;
        let remote_requested = remote.owns(Path::new(&path));
        let path =
            tokio::task::spawn_blocking(move || canonical_project_or_restore_standalone(&path))
                .await
                .map_err(|_| "项目目录检查未完成")??;
        if remote_requested && !remote.owns(&path) {
            return Err("远程项目标识指向了其他目录，请检查应用数据；此次打开已取消".into());
        }
        let _guard = self.lifecycle.lock().await;
        self.start_locked(app).await?;
        // Only the foreground binding changes. Each admitted Harness flight
        // already owns its project path, permissions, and gateway lease.
        let remote_name = self.validate_remote_project(state, &path).await?;
        let prepared = prepare_native_binding(state, &accounts).await?;
        let mut result = AgentOpenProject {
            workspace: AgentWorkspace {
                path: path.to_string_lossy().into_owned(),
                name: path
                    .file_name()
                    .map(|part| part.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string_lossy().into_owned()),
                standalone: false,
                remote: None,
            },
            catalog: prepared.catalog,
            sessions: self
                .call("listSessions", json!({"projectPath": path}), false)
                .await?,
            warnings: Vec::new(),
        };
        if let Some(remote) = remote_name {
            result.workspace.name = format!(
                "{} · {}",
                remote.connection_name,
                remote
                    .root
                    .rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("/")
            );
            result.workspace.remote = Some(remote);
        }
        result.workspace.standalone = super::agent_host::is_standalone_workspace(&path);
        if result.workspace.standalone {
            result.workspace.name = "独立任务".into();
        }
        let mut navigation = preferences::load(&state.db)?;
        let key = preferences::path_key(&result.workspace.path);
        let pinned = navigation.projects.get(&key).is_some_and(|p| p.pinned);
        if let Some(name) =
            preferences::remembered_project_name(&navigation, &result.workspace.path)
        {
            result.workspace.name = name;
        }
        navigation.projects.insert(
            key,
            preferences::AgentProject {
                path: result.workspace.path.clone(),
                name: result.workspace.name.clone(),
                standalone: result.workspace.standalone,
                pinned,
                last_opened_at: chrono::Utc::now().timestamp_millis() as u64,
            },
        );
        preferences::save(&state.db, &navigation)?;
        for session in &mut result.sessions {
            preferences::decorate(&navigation, session);
        }
        if let Err(error) = self.sync_skills().await {
            log::warn!("技能暂不可用：{error}");
            result.warnings.push(error);
        }
        *self.binding.write().await = Some(AgentOpenProject {
            workspace: result.workspace.clone(),
            catalog: result.catalog.clone(),
            sessions: Vec::new(),
            warnings: Vec::new(),
        });
        Ok(result)
    }
    pub async fn busy(&self) -> Result<bool, String> {
        Ok(self.harness.busy().await)
    }
    pub async fn project_metadata(
        &self,
        state: &AppState,
        path: &str,
        pinned: Option<bool>,
        name: Option<&str>,
    ) -> Result<preferences::AgentProject, String> {
        let _guard = self.lifecycle.lock().await;
        let project = preferences::update_project_metadata(&state.db, path, pinned, name)?;
        if let Some(binding) = self.binding.write().await.as_mut() {
            if preferences::path_key(&binding.workspace.path)
                == preferences::path_key(&project.path)
            {
                binding.workspace.name = project.name.clone();
            }
        }
        Ok(project)
    }
    pub async fn remove_project(&self, state: &AppState, path: &str) -> Result<(), String> {
        let _guard = self.acquire_idle_for_navigation().await?;
        let key = preferences::path_key(path);
        let mut navigation = preferences::load(&state.db)?;
        if navigation.projects.remove(&key).is_none() {
            return Err("这个项目已经移出工作台".into());
        }
        if self
            .binding
            .read()
            .await
            .as_ref()
            .is_some_and(|b| preferences::path_key(&b.workspace.path) == key)
        {
            self.binding.write().await.take();
        }
        preferences::save(&state.db, &navigation)
    }
    pub async fn acquire_idle_for_update(&self) -> Result<NativeUpdateLease<'_>, String> {
        let guard = self.lifecycle.lock().await;
        if self.harness.busy().await {
            return Err("还有 Harness 任务正在运行，请先结束任务".into());
        }
        self.harness.retire_idle(None).await?;
        Ok(NativeUpdateLease { _guard: guard })
    }
    pub(crate) async fn acquire_idle_for_navigation(&self) -> Result<MutexGuard<'_, ()>, String> {
        let guard = self.lifecycle.lock().await;
        if self.busy().await? {
            return Err("还有任务或授权等待处理，请先结束任务".into());
        }
        self.harness.retire_idle(None).await?;
        Ok(guard)
    }
    pub async fn close_project(&self) -> Result<(), String> {
        let _guard = self.acquire_idle_for_navigation().await?;
        self.binding.write().await.take();
        Ok(())
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        self.harness.shutdown().await;
        if let Some(monitor) = self.secretary_github_monitor.lock().await.take() {
            monitor.abort();
            let _ = monitor.await;
        }
        self.binding.write().await.take();
        *self.skill_snapshot.write().await = None;
        self.harness_preview.shutdown().await;
        self.browser.shutdown().await;
        let mcp_result = if let Some(mcp) = self.mcp.get() {
            mcp.shutdown().await
        } else {
            Ok(())
        };
        *self.mcp_error.write().await = None;
        mcp_result
    }
}

fn start_secretary_github_monitor(app: tauri::AppHandle) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let period = Duration::from_secs(60);
        let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            timer.tick().await;
            let Ok(activity) = app
                .state::<InprocessAgentState>()
                .call::<Value>("getSecretaryActivity", json!({}), false)
                .await
            else {
                continue;
            };
            let Some(secretaries) = activity.as_array() else {
                continue;
            };
            for secretary in secretaries {
                if let Some(id) = secretary["sessionId"].as_str() {
                    let _ = crate::commands::refresh_monitored_secretary(&app, id).await;
                }
            }
        }
    })
}
