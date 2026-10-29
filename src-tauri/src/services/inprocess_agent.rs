//! Desktop ownership for the in-process Rust agent.
//! Model I/O, turns, permissions and sessions execute in the application; there
//! is no worker executable, startup handshake, sidecar port or engine process.
use super::{
    agent_host::{canonical_project, prepare_native_binding, AgentOpenProject, AgentRuntimeStatus},
    agent_preferences as preferences,
    channel_center::{self, AgentCatalog},
    inprocess_extensions::{InprocessExtensionStore, SkillSnapshot},
};
use crate::store::AppState;
use lolicode_agent::native::{NativeEngine, NativeGateway};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::Path, sync::Arc};
use tauri::Manager;
use tokio::sync::{Mutex, MutexGuard, OnceCell, RwLock};

#[derive(Default)]
pub struct InprocessAgentState {
    lifecycle: Mutex<()>,
    engine: RwLock<Option<NativeEngine>>,
    binding: RwLock<Option<AgentOpenProject>>,
    extensions: OnceCell<Arc<InprocessExtensionStore>>,
    remote: OnceCell<Arc<super::remote_projects::RemoteProjects>>,
    skill_snapshot: RwLock<Option<SkillSnapshot>>,
    mcp: OnceCell<Arc<super::native_mcp::NativeMcpTools>>,
    mcp_error: RwLock<Option<String>>,
}

pub struct NativeUpdateLease<'a> {
    _guard: MutexGuard<'a, ()>,
    engine: Option<NativeEngine>,
}
impl Drop for NativeUpdateLease<'_> {
    fn drop(&mut self) {
        if let Some(engine) = self.engine.take() {
            tauri::async_runtime::spawn(async move {
                let _ = engine.call("endUpdate", json!({})).await;
            });
        }
    }
}

impl InprocessAgentState {
    pub async fn ensure_started(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self.engine.read().await.is_some() {
            return Ok(());
        }
        let _guard = self.lifecycle.lock().await;
        self.start_locked(app).await.map(|_| ())
    }

    async fn start_locked(&self, app: &tauri::AppHandle) -> Result<NativeEngine, String> {
        if let Some(engine) = self.engine.read().await.clone() {
            return Ok(engine);
        }
        let engine =
            NativeEngine::open(crate::config::get_app_config_dir().join("agent/native")).await?;
        engine.call("initializeMemoryDefaults", json!({})).await?;
        let state = app.state::<AppState>();
        let remote = self.remote_projects(&state).await;
        let mcp = self
            .mcp
            .get_or_init(|| async { Arc::new(super::native_mcp::NativeMcpTools::new()) })
            .await
            .clone();
        engine
            .set_application_tools(Arc::new(super::remote_agent_tools::DesktopToolHost {
                local: super::agent_applications::DesktopApplicationTools(state.inner().clone()),
                remote,
                mcp: Some(mcp),
            }))
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
        *self.engine.write().await = Some(engine.clone());
        if let Err(error) = self.sync_mcp_config().await {
            log::warn!("MCP 暂不可用：{error}");
        }
        Ok(engine)
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
        let path = tokio::task::spawn_blocking(move || canonical_project(&path))
            .await
            .map_err(|_| "项目目录检查未完成")??;
        if remote_requested && !remote.owns(&path) {
            return Err("远程项目标识指向了其他目录，请检查应用数据；此次打开已取消".into());
        }
        let _guard = self.lifecycle.lock().await;
        let engine = self.start_locked(app).await?;
        self.validate_remote_project(state, &path).await?;
        let prepared = prepare_native_binding(state, &accounts).await?;
        let catalog = prepared.catalog.clone();
        engine
            .bind_background(
                path,
                serde_json::to_value(&prepared.catalog).map_err(|_| "渠道目录编码失败")?,
                NativeGateway {
                    base_url: prepared.base_url,
                    bearer_token: prepared.bearer_token,
                },
            )
            .await?;
        Ok(catalog)
    }

    async fn connected(&self) -> Result<NativeEngine, String> {
        self.engine
            .read()
            .await
            .clone()
            .ok_or_else(|| "本体 Agent 尚未初始化，请重新打开项目".into())
    }

    async fn sync_skills(&self, engine: &NativeEngine) -> Result<(), String> {
        let Some(store) = self.extensions.get().cloned() else {
            return Ok(());
        };
        let snapshot = tokio::task::spawn_blocking(move || store.prepare_skills())
            .await
            .map_err(|_| "技能目录读取未完成")?
            .map_err(|e| e.to_string())?;
        let payload = snapshot.configure_payload();
        let unchanged = self
            .skill_snapshot
            .read()
            .await
            .as_ref()
            .map(SkillSnapshot::configure_payload)
            .as_ref()
            == Some(&payload);
        if unchanged {
            *self.skill_snapshot.write().await = Some(snapshot);
            return Ok(());
        }
        if engine.busy().await? {
            return Ok(());
        }
        engine.call("configureSkills", payload).await?;
        *self.skill_snapshot.write().await = Some(snapshot);
        Ok(())
    }

    async fn sync_optional_skills(&self, engine: &NativeEngine) -> Result<(), String> {
        if let Err(error) = self.sync_skills(engine).await {
            // A broken extension catalog must not disable basic coding. Clear
            // stale instructions instead of silently using unverified skills.
            // The extension panel still returns the original, actionable error.
            log::warn!("技能暂不可用：{error}");
            engine
                .call("configureSkills", json!({"revision":0,"skills":[]}))
                .await?;
            *self.skill_snapshot.write().await = None;
        }
        Ok(())
    }

    async fn extension_call(
        &self,
        engine: &NativeEngine,
        method: &str,
        args: &Value,
    ) -> Result<Option<Value>, String> {
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
            self.sync_skills(engine).await?;
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
        self.sync_skills(engine).await?;
        if let Err(error) = self.sync_mcp_config().await {
            log::warn!("MCP 配置暂不可用：{error}");
        }
        let loaded = engine
            .call("loadedSkills", json!({}))
            .await?
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect::<BTreeSet<_>>();
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
        let engine = self.connected().await?;
        if matches!(method, "sendMessage" | "createSession") {
            self.sync_optional_skills(&engine).await?;
        }
        let result = match self.extension_call(&engine, method, &args).await? {
            Some(value) => value,
            None => engine.call(method, args).await?,
        };
        serde_json::from_value(result).map_err(|_| "本体 Agent 返回的数据格式不兼容".into())
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
        _refresh: bool,
    ) -> Result<AgentOpenProject, String> {
        let remote = self.remote_projects(state).await;
        let remote_requested = remote.owns(Path::new(&path));
        let path = tokio::task::spawn_blocking(move || canonical_project(&path))
            .await
            .map_err(|_| "项目目录检查未完成")??;
        if remote_requested && !remote.owns(&path) {
            return Err("远程项目标识指向了其他目录，请检查应用数据；此次打开已取消".into());
        }
        let _guard = self.lifecycle.lock().await;
        let engine = self.start_locked(app).await?;
        let remote_name = self.validate_remote_project(state, &path).await?;
        let prepared = prepare_native_binding(state, &accounts).await?;
        let catalog = serde_json::to_value(&prepared.catalog).map_err(|_| "渠道目录编码失败")?;
        let mut result: AgentOpenProject = serde_json::from_value(
            engine
                .bind(
                    path.clone(),
                    catalog,
                    NativeGateway {
                        base_url: prepared.base_url,
                        bearer_token: prepared.bearer_token,
                    },
                )
                .await?,
        )
        .map_err(|_| "本体项目状态格式不兼容")?;
        if preferences::path_key(&result.workspace.path)
            != preferences::path_key(&path.to_string_lossy())
        {
            return Err("返回项目与所选目录不一致".into());
        }
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
        if let Some(name) = preferences::remembered_project_name(&navigation, &result.workspace.path) {
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
        self.sync_optional_skills(&engine).await?;
        *self.binding.write().await = Some(AgentOpenProject {
            workspace: result.workspace.clone(),
            catalog: result.catalog.clone(),
            sessions: Vec::new(),
            warnings: Vec::new(),
        });
        Ok(result)
    }
    pub async fn busy(&self) -> Result<bool, String> {
        match self.engine.read().await.clone() {
            Some(engine) => engine.busy().await,
            None => Ok(false),
        }
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
            if preferences::path_key(&binding.workspace.path) == preferences::path_key(&project.path) {
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
            if let Some(engine) = self.engine.read().await.clone() {
                engine.call("closeProject", json!({})).await?;
            }
            self.binding.write().await.take();
        }
        preferences::save(&state.db, &navigation)
    }
    pub async fn acquire_idle_for_update(&self) -> Result<NativeUpdateLease<'_>, String> {
        let guard = self.lifecycle.lock().await;
        let engine = self.engine.read().await.clone();
        if let Some(engine) = &engine {
            engine.call("beginUpdate", json!({})).await?;
        }
        Ok(NativeUpdateLease {
            _guard: guard,
            engine,
        })
    }
    pub(crate) async fn acquire_idle_for_navigation(&self) -> Result<MutexGuard<'_, ()>, String> {
        let guard = self.lifecycle.lock().await;
        if self.busy().await? {
            return Err("还有任务或授权等待处理，请先结束任务".into());
        }
        Ok(guard)
    }
    pub async fn close_project(&self) -> Result<(), String> {
        let _guard = self.acquire_idle_for_navigation().await?;
        if let Some(engine) = self.engine.read().await.clone() {
            engine.call("closeProject", json!({})).await?;
        }
        self.binding.write().await.take();
        Ok(())
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        let engine = self.engine.write().await.take();
        self.binding.write().await.take();
        *self.skill_snapshot.write().await = None;
        let engine_result = if let Some(engine) = engine {
            engine.shutdown().await
        } else {
            Ok(())
        };
        let mcp_result = if let Some(mcp) = self.mcp.get() {
            mcp.shutdown().await
        } else {
            Ok(())
        };
        *self.mcp_error.write().await = None;
        engine_result.and(mcp_result)
    }
}
