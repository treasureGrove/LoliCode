//! Desktop carrier for the UI-independent LoliCode agent adapter.
//! Only normalized session data crosses IPC; engine config and credentials stay here.

use crate::database::Database;
use crate::services::channel_center::{self, AgentCatalog};
use crate::services::{
    agent_extensions::AgentExtensionStore, agent_policy, agent_preferences as preferences,
};
use crate::store::AppState;
use lolicode_agent::{AgentModelRef, AgentSession, AgentSnapshot, Engine, EngineOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::{Mutex, MutexGuard, OnceCell, RwLock};

async fn acquire_idle_update_lease<'a>(
    lifecycle: &'a Mutex<()>,
    activity: impl Future<Output = Result<bool, String>>,
) -> Result<MutexGuard<'a, ()>, String> {
    let lease = lifecycle.lock().await;
    match activity.await {
        Ok(false) => Ok(lease),
        Ok(true) => Err("仍有编程任务或授权/提问等待处理，请等待任务结束后重试更新。".into()),
        Err(_) => Err("无法确认后台任务是否已结束，更新尚未安装；请稍后重试。".into()),
    }
}

#[derive(Default)]
pub struct AgentState {
    /// Sending and switching projects serialize, while interrupt and snapshots
    /// remain available during network I/O.
    lifecycle: Mutex<()>,
    connection: RwLock<Option<AgentConnection>>,
    extensions: OnceCell<Arc<AgentExtensionStore>>,
    monitors: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

struct AgentConnection {
    engine: Arc<Engine>,
    workspace: AgentWorkspace,
    catalog: AgentCatalog,
    db: Arc<Database>,
    projects: BTreeSet<String>,
    extension_revision: u64,
    selection_cleared: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspace {
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeStatus {
    pub available: bool,
    pub version: Option<String>,
    pub running: bool,
    pub project_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenProject {
    pub workspace: AgentWorkspace,
    pub catalog: AgentCatalog,
    pub sessions: Vec<AgentSession>,
}

pub fn runtime_executable(app: &tauri::AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "opencode.exe"
    } else {
        "opencode"
    };
    let bundled = app.path().resource_dir().ok()?.join("agent").join(name);
    if bundled.is_file() {
        return Some(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let development = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("agent")
            .join(name);
        if development.is_file() {
            return Some(development);
        }
    }
    None
}

pub(crate) fn canonical_project(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("请选择一个项目文件夹".into());
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| "项目文件夹不存在或无法访问")?;
    if !canonical.is_dir() {
        return Err("请选择文件夹，不能选择单个文件".into());
    }
    // Windows std returns verbatim paths, whereas the upstream JS runtime
    // stores ordinary drive/UNC paths. Keep the canonical location, not its prefix.
    #[cfg(windows)]
    {
        let text = canonical.to_string_lossy();
        if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
            return Ok(PathBuf::from(format!("\\\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix("\\\\?\\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(canonical)
}

#[cfg(test)]
fn same_project(left: &str, right: &str) -> bool {
    let (Ok(left), Ok(right)) = (canonical_project(left), canonical_project(right)) else {
        return false;
    };
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

pub(crate) fn workspace(path: &Path) -> AgentWorkspace {
    AgentWorkspace {
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("项目")
            .to_string(),
        path: path.to_string_lossy().into_owned(),
    }
}

fn selected_model(catalog: &AgentCatalog, id: &str) -> Result<AgentModelRef, String> {
    let model = catalog
        .models
        .iter()
        .find(|model| model.id == id)
        .ok_or_else(|| "此模型不在当前项目的渠道目录中，请刷新项目或重新选择模型".to_string())?;
    Ok(AgentModelRef {
        provider_id: model.provider_id.clone(),
        model_id: model.model_id.clone(),
    })
}

/// Shared host preparation. Neither native engine receives an upstream key.
pub(crate) async fn prepare_catalog_for_accounts(
    state: &AppState,
    accounts: &[(String, String)],
) -> Result<channel_center::PreparedAgentCatalog, String> {
    let draft =
        channel_center::agent_source_snapshot(state.db.as_ref()).map_err(|e| e.to_string())?;
    channel_center::validate_managed_account_references(&draft, accounts)
        .map_err(|e| e.to_string())?;
    let prepared = channel_center::prepare_agent_catalog(state)
        .await
        .map_err(|e| e.to_string())?;
    let published = channel_center::load_catalog(state.db.as_ref(), prepared.catalog.revision)
        .map_err(|e| e.to_string())?;
    channel_center::validate_managed_account_references(&published, accounts)
        .map_err(|e| e.to_string())?;
    Ok(prepared)
}

impl AgentState {
    /// The update installer keeps this lease through cleanup and installation.
    /// New sends/project changes cannot race with the final host-wide idle check.
    pub async fn acquire_idle_for_update(&self) -> Result<MutexGuard<'_, ()>, String> {
        acquire_idle_update_lease(&self.lifecycle, async {
            let engine = self
                .connection
                .read()
                .await
                .as_ref()
                .filter(|connection| connection.engine.is_running())
                .map(|connection| connection.engine.clone());
            match engine {
                Some(engine) => engine.has_active_sessions().await,
                None => Ok(false),
            }
        })
        .await
    }

    /// Builds only an isolated test carrier; production initialization still
    /// requires the desktop resource path and the managed channel catalog.
    #[cfg(feature = "test-hooks")]
    pub async fn from_test_engine(
        engine: Arc<Engine>,
        db: Arc<Database>,
        catalog: AgentCatalog,
        projects: Vec<PathBuf>,
    ) -> Result<Self, String> {
        let first = projects.first().ok_or("Test carrier requires a project")?;
        let selected = workspace(&canonical_project(&first.to_string_lossy())?);
        let mut navigation = preferences::load(&db)?;
        for project in projects {
            let project = workspace(&canonical_project(&project.to_string_lossy())?);
            navigation.projects.insert(
                preferences::path_key(&project.path),
                preferences::AgentProject {
                    path: project.path,
                    name: project.name,
                    pinned: false,
                    last_opened_at: 0,
                },
            );
        }
        preferences::save(&db, &navigation)?;
        let state = Self::default();
        *state.connection.write().await = Some(AgentConnection {
            engine,
            workspace: selected,
            catalog,
            db,
            projects: navigation.projects.keys().cloned().collect(),
            extension_revision: 0,
            selection_cleared: false,
        });
        Ok(state)
    }

    #[cfg(feature = "test-hooks")]
    pub async fn bind_test_extension_revision(&self, revision: u64) -> Result<(), String> {
        let mut connection = self.connection.write().await;
        connection
            .as_mut()
            .ok_or("Test carrier requires an engine")?
            .extension_revision = revision;
        Ok(())
    }

    pub async fn extensions(
        &self,
        app: &tauri::AppHandle,
    ) -> Result<Arc<AgentExtensionStore>, String> {
        self.extensions
            .get_or_try_init(|| async {
                let bundled = app
                    .path()
                    .resource_dir()
                    .map_err(|_| "无法读取应用资源目录")?
                    .join("agent/extensions");
                #[cfg(debug_assertions)]
                let bundled = if bundled.join("manifest.json").is_file() {
                    bundled
                } else {
                    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/agent/extensions")
                };
                AgentExtensionStore::new(
                    crate::config::get_app_config_dir().join("agent/extensions"),
                    bundled,
                )
                .map(Arc::new)
                .map_err(|error| error.to_string())
            })
            .await
            .cloned()
    }

    pub async fn runtime_extensions(&self) -> Option<(Arc<Engine>, AgentWorkspace, u64)> {
        self.connection
            .read()
            .await
            .as_ref()
            .filter(|item| item.engine.is_running())
            .map(|item| {
                (
                    item.engine.clone(),
                    item.workspace.clone(),
                    item.extension_revision,
                )
            })
    }

    async fn decorate(&self, session: &mut AgentSession) -> Result<(), String> {
        let connection = self.connection.read().await;
        let connection = connection.as_ref().ok_or("请先打开项目")?;
        preferences::decorate(&preferences::load(&connection.db)?, session);
        Ok(())
    }

    async fn check_project(&self, path: &str) -> Result<(), String> {
        let connection = self.connection.read().await;
        if connection
            .as_ref()
            .is_some_and(|item| item.projects.contains(&preferences::path_key(path)))
        {
            Ok(())
        } else {
            Err("请先打开这段会话所属的项目".into())
        }
    }

    async fn monitor_auto(&self, engine: Arc<Engine>, session: &AgentSession) {
        if session.permission_mode != "auto" || session.mode == "plan" {
            return;
        }
        let id = session.id.clone();
        let key = format!("{:p}:{id}", Arc::as_ptr(&engine));
        let lease = Arc::new(AtomicBool::new(true));
        {
            let mut monitors = self.monitors.lock().await;
            if monitors.contains_key(&key) {
                return;
            }
            monitors.insert(key.clone(), lease.clone());
        }
        let project = session.project_path.clone();
        let monitors = self.monitors.clone();
        tokio::spawn(async move {
            let mut idle = 0;
            let mut failures = 0;
            loop {
                if !engine.is_running() || !lease.load(Ordering::Acquire) {
                    break;
                }
                match engine.session(&id).await {
                    Ok(current) if current.permission_mode == "auto" && current.mode != "plan" => {
                        ()
                    }
                    _ => break,
                }
                match engine.pending_permissions(&id).await {
                    Ok(requests) => {
                        failures = 0;
                        for request in requests {
                            if lease.load(Ordering::Acquire)
                                && agent_policy::approve_automatically(&request, &project)
                            {
                                let _ = engine.reply_permission(&id, &request.id, "once").await;
                            }
                        }
                    }
                    Err(_) => {
                        failures += 1;
                        if failures >= 3 {
                            break;
                        }
                    }
                }
                match engine.is_session_busy(&id).await {
                    Ok(true) => idle = 0,
                    Ok(false) => {
                        idle += 1;
                        if idle >= 5 {
                            break;
                        }
                    }
                    Err(_) => {
                        failures += 1;
                        if failures >= 3 {
                            break;
                        }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            }
            let mut monitors = monitors.lock().await;
            if monitors
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &lease))
            {
                monitors.remove(&key);
            }
        });
    }

    async fn cancel_auto(&self, engine: &Arc<Engine>, id: &str) {
        let key = format!("{:p}:{id}", Arc::as_ptr(engine));
        if let Some(lease) = self.monitors.lock().await.remove(&key) {
            lease.store(false, Ordering::Release);
        }
    }

    pub async fn update_session(
        &self,
        id: &str,
        model_id: Option<&str>,
        mode: Option<&str>,
        permission_mode: Option<&str>,
    ) -> Result<AgentSession, String> {
        let _operation = self.lifecycle.lock().await;
        let (engine, snapshot, catalog) = self.session_connection(id).await?;
        if engine.is_session_busy(id).await? {
            return Err("请先停止或等待任务完成后再切换模型和模式".into());
        }
        let model = model_id
            .map(|id| selected_model(&catalog, id))
            .transpose()?;
        self.cancel_auto(&engine, id).await;
        if mode.is_some() || permission_mode.is_some() {
            let inherited = match snapshot.session.permission_mode.as_str() {
                "ask" | "auto" | "full_access" => snapshot.session.permission_mode.as_str(),
                // A legacy/externally configured policy can be represented as
                // custom. A mode change must regain explicit safe permissions.
                _ => "ask",
            };
            let policy = permission_mode.unwrap_or(inherited);
            engine
                .configure_session(id, mode.unwrap_or(&snapshot.session.mode), policy)
                .await?;
        }
        if let Some(model) = model {
            engine.switch_model(id, &model).await?;
        }
        let mut session = engine.session(id).await?;
        self.decorate(&mut session).await?;
        Ok(session)
    }

    pub async fn rename_session(&self, id: &str, title: &str) -> Result<AgentSession, String> {
        let _operation = self.lifecycle.lock().await;
        let (engine, _, _) = self.session_connection(id).await?;
        let mut session = engine.rename_session(id, title).await?;
        self.decorate(&mut session).await?;
        Ok(session)
    }

    pub async fn session_metadata(
        &self,
        id: &str,
        pinned: Option<bool>,
        archived: Option<bool>,
    ) -> Result<AgentSession, String> {
        let _operation = self.lifecycle.lock().await;
        let (engine, snapshot, _) = self.session_connection(id).await?;
        if archived == Some(true) && engine.is_session_busy(id).await? {
            return Err("请先停止或等待任务完成后再归档".into());
        }
        let connection = self.connection.read().await;
        let db = &connection.as_ref().ok_or("请先打开项目")?.db;
        let mut navigation = preferences::load(db)?;
        let view = navigation.sessions.entry(id.into()).or_default();
        if let Some(pinned) = pinned {
            view.pinned = pinned;
        }
        if let Some(archived) = archived {
            view.archived = archived;
        }
        preferences::save(db, &navigation)?;
        let mut session = snapshot.session;
        preferences::decorate(&navigation, &mut session);
        Ok(session)
    }

    pub async fn delete_session(&self, id: &str) -> Result<(), String> {
        let _operation = self.lifecycle.lock().await;
        let (engine, _, _) = self.session_connection(id).await?;
        engine.delete_session(id).await?;
        self.cancel_auto(&engine, id).await;
        let connection = self.connection.read().await;
        let db = &connection.as_ref().ok_or("请先打开项目")?.db;
        let mut navigation = preferences::load(db)?;
        navigation.sessions.remove(id);
        preferences::save(db, &navigation)
    }

    pub async fn project_metadata(
        &self,
        state: &AppState,
        path: &str,
        pinned: bool,
    ) -> Result<preferences::AgentProject, String> {
        let _operation = self.lifecycle.lock().await;
        let mut navigation = preferences::load(&state.db)?;
        let project = navigation
            .projects
            .get_mut(&preferences::path_key(path))
            .ok_or("这个项目还没有加入工作台")?;
        project.pinned = pinned;
        let project = project.clone();
        preferences::save(&state.db, &navigation)?;
        Ok(project)
    }

    pub async fn remove_project(&self, state: &AppState, path: &str) -> Result<(), String> {
        let _operation = self.lifecycle.lock().await;
        self.remove_project_under_lease(state, path).await
    }

    /// Dispatch owns the legacy lifecycle lease before taking the native lease.
    /// Keep that lock order shared with close and installation.
    pub(crate) async fn remove_project_under_lease(
        &self,
        state: &AppState,
        path: &str,
    ) -> Result<(), String> {
        let key = preferences::path_key(path);
        let mut navigation = preferences::load(&state.db)?;
        if !navigation.projects.contains_key(&key) {
            return Err("这个项目已经移出工作台".into());
        }
        if let Some((engine, _, _)) = self.runtime_extensions().await {
            // A moved/deleted recent project must remain removable. The native
            // location endpoint requires an existing directory; when it is gone,
            // check global activity before removing only the navigation record.
            let sessions = if Path::new(path).is_dir() {
                engine.list_sessions(Path::new(path)).await?
            } else {
                if engine.has_active_sessions().await? {
                    return Err("还有任务在执行，请结束后再移出不存在的项目".into());
                }
                Vec::new()
            };
            for session in sessions {
                if engine.is_session_busy(&session.id).await? {
                    return Err("这个项目还有任务在执行，请结束后再移出列表".into());
                }
                self.cancel_auto(&engine, &session.id).await;
            }
        }
        navigation.projects.remove(&key);
        preferences::save(&state.db, &navigation)?;
        if let Some(connection) = self.connection.write().await.as_mut() {
            connection.projects.remove(&key);
            if preferences::path_key(&connection.workspace.path) == key {
                connection.selection_cleared = true;
            }
        }
        Ok(())
    }

    pub async fn catalog(&self, state: &AppState) -> Result<AgentCatalog, String> {
        let connection = self.connection.read().await;
        if let Some(connection) = connection.as_ref().filter(|item| item.engine.is_running()) {
            return Ok(connection.catalog.clone());
        }
        channel_center::agent_catalog(state.db.as_ref()).map_err(|error| error.to_string())
    }

    pub async fn status(&self, app: &tauri::AppHandle) -> AgentRuntimeStatus {
        let available = runtime_executable(app).is_some();
        let connection = self.connection.read().await;
        AgentRuntimeStatus {
            available,
            version: available.then(|| lolicode_agent::ENGINE_VERSION.to_string()),
            running: connection
                .as_ref()
                .is_some_and(|connection| connection.engine.is_running()),
            project_path: connection
                .as_ref()
                .filter(|connection| !connection.selection_cleared)
                .map(|connection| connection.workspace.path.clone()),
        }
    }

    pub async fn open_project(
        &self,
        app: &tauri::AppHandle,
        state: &AppState,
        path: String,
        accounts: Vec<(String, String)>,
        refresh_models: bool,
    ) -> Result<AgentOpenProject, String> {
        let project = tokio::task::spawn_blocking(move || canonical_project(&path))
            .await
            .map_err(|_| "项目目录检测失败，请重试".to_string())??;
        let executable = runtime_executable(app).ok_or_else(|| {
            "未找到应用附带的 agent 引擎，请重新安装完整 LoliCode 安装包".to_string()
        })?;
        let _operation = self.lifecycle.lock().await;
        let old = self.connection.read().await.as_ref().map(|connection| {
            (
                connection.engine.clone(),
                connection.workspace.clone(),
                connection.catalog.clone(),
            )
        });
        let draft = channel_center::agent_source_snapshot(state.db.as_ref())
            .map_err(|error| error.to_string())?;
        let extension_store = self.extensions(app).await?;
        let extension_revision = extension_store
            .list()
            .map_err(|error| error.to_string())?
            .revision;
        let mut navigation = preferences::load(&state.db)?;
        let workspace = workspace(&project);
        let project_key = preferences::path_key(&workspace.path);
        let pinned = navigation
            .projects
            .get(&project_key)
            .is_some_and(|entry| entry.pinned);
        navigation.projects.insert(
            project_key.clone(),
            preferences::AgentProject {
                path: workspace.path.clone(),
                name: workspace.name.clone(),
                pinned,
                last_opened_at: chrono::Utc::now().timestamp_millis() as u64,
            },
        );
        if let Some((engine, _current, catalog)) = &old {
            if engine.is_running() {
                let active = engine.has_active_sessions().await?;
                if refresh_models && active {
                    return Err("还有任务在执行，请结束后再重新载入模型与扩展".into());
                }
                let same_extensions = self
                    .connection
                    .read()
                    .await
                    .as_ref()
                    .is_some_and(|connection| connection.extension_revision == extension_revision);
                if !refresh_models
                    && (active || (catalog.revision == draft.revision && same_extensions))
                {
                    let mut sessions = engine.list_sessions(&project).await?;
                    for session in &mut sessions {
                        preferences::decorate(&navigation, session);
                        self.monitor_auto(engine.clone(), session).await;
                    }
                    sessions.retain(|session| !session.archived);
                    preferences::save(&state.db, &navigation)?;
                    if let Some(connection) = self.connection.write().await.as_mut() {
                        connection.workspace = workspace.clone();
                        connection.selection_cleared = false;
                        connection.projects.insert(project_key.clone());
                    }
                    return Ok(AgentOpenProject {
                        workspace: workspace.clone(),
                        catalog: catalog.clone(),
                        sessions,
                    });
                }
                if active {
                    return Err("还有任务在执行，请结束后再重新载入模型与扩展".into());
                }
            }
        }
        // Validate before publishing, then validate the exact immutable revision.
        // A concurrent channel editor must not replace what this engine binds.
        let mut prepared = prepare_catalog_for_accounts(state, &accounts).await?;
        let private_root = crate::config::get_app_config_dir().join("agent/runtime");
        let extension_revision = extension_store
            .project_runtime(&private_root, &mut prepared.config)
            .map_err(|error| error.to_string())?;
        self.shutdown().await?;
        let engine = Arc::new(
            Engine::launch(EngineOptions {
                executable,
                private_root,
                config: prepared.config,
            })
            .await?,
        );
        let mut sessions = match engine.list_sessions(&project).await {
            Ok(sessions) => sessions,
            Err(error) => {
                let _ = engine.shutdown().await;
                return Err(error);
            }
        };
        for session in &mut sessions {
            preferences::decorate(&navigation, session);
        }
        sessions.retain(|session| !session.archived);
        if let Err(error) = preferences::save(&state.db, &navigation) {
            let _ = engine.shutdown().await;
            return Err(error);
        }
        for session in &sessions {
            self.monitor_auto(engine.clone(), session).await;
        }
        let catalog = prepared.catalog;
        *self.connection.write().await = Some(AgentConnection {
            engine,
            workspace: workspace.clone(),
            catalog: catalog.clone(),
            db: state.db.clone(),
            projects: navigation.projects.keys().cloned().collect(),
            extension_revision,
            selection_cleared: false,
        });
        Ok(AgentOpenProject {
            workspace,
            catalog,
            sessions,
        })
    }

    async fn connected(&self) -> Result<(Arc<Engine>, AgentWorkspace, AgentCatalog), String> {
        self.connection
            .read()
            .await
            .as_ref()
            .filter(|connection| connection.engine.is_running())
            .map(|connection| {
                (
                    connection.engine.clone(),
                    connection.workspace.clone(),
                    connection.catalog.clone(),
                )
            })
            .ok_or_else(|| "请先打开项目；若引擎已退出，请重新打开项目".to_string())
    }

    async fn session_connection(
        &self,
        id: &str,
    ) -> Result<(Arc<Engine>, AgentSnapshot, AgentCatalog), String> {
        let (engine, _, catalog) = self.connected().await?;
        let mut snapshot = engine.snapshot(id).await?;
        self.check_project(&snapshot.session.project_path).await?;
        self.decorate(&mut snapshot.session).await?;
        Ok((engine, snapshot, catalog))
    }

    pub async fn list_sessions(
        &self,
        project_path: Option<&str>,
        include_archived: bool,
    ) -> Result<Vec<AgentSession>, String> {
        let (engine, workspace, _) = self.connected().await?;
        let path = project_path.unwrap_or(&workspace.path);
        self.check_project(path).await?;
        let mut sessions = engine.list_sessions(Path::new(path)).await?;
        for session in &mut sessions {
            self.decorate(session).await?;
            self.monitor_auto(engine.clone(), session).await;
        }
        sessions.retain(|session| include_archived || !session.archived);
        sessions.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then(b.updated_at.cmp(&a.updated_at))
        });
        Ok(sessions)
    }

    pub async fn create_session(
        &self,
        model_id: &str,
        mode: &str,
        title: Option<&str>,
        permission_mode: &str,
    ) -> Result<AgentSession, String> {
        if !matches!(mode, "build" | "plan") {
            return Err("请选择实现或分析模式".into());
        }
        let _operation = self.lifecycle.lock().await;
        let (engine, workspace, catalog) = self.connected().await?;
        self.check_project(&workspace.path).await?;
        let model = selected_model(&catalog, model_id)?;
        engine
            .create_session_with_policy(
                Path::new(&workspace.path),
                &model,
                mode,
                permission_mode,
                title,
            )
            .await
    }

    pub async fn snapshot(&self, id: &str) -> Result<AgentSnapshot, String> {
        let (engine, snapshot, _) = self.session_connection(id).await?;
        self.monitor_auto(engine, &snapshot.session).await;
        Ok(snapshot)
    }

    pub async fn send(&self, id: &str, text: &str, request_id: &str) -> Result<(), String> {
        if text.trim().is_empty() {
            return Err("请输入任务内容".into());
        }
        if text.len() > 1024 * 1024 {
            return Err("消息过长，请拆成几段发送".into());
        }
        let _operation = self.lifecycle.lock().await;
        let (engine, snapshot, catalog) = self.session_connection(id).await?;
        if let Some(model) = &snapshot.session.model {
            if !catalog.models.iter().any(|available| {
                available.provider_id == model.provider_id && available.model_id == model.model_id
            }) {
                return Err("会话绑定的模型已不在当前目录中，请选择可用模型新建会话".into());
            }
        } else {
            return Err("此会话没有绑定模型，请新建会话并选择模型".into());
        }
        if snapshot.session.archived {
            return Err("请先恢复归档会话，再继续发送消息".into());
        }
        engine.send_message(id, text, request_id).await?;
        self.monitor_auto(engine, &snapshot.session).await;
        Ok(())
    }

    pub async fn interrupt(&self, id: &str) -> Result<(), String> {
        let (engine, _, _) = self.connected().await?;
        // Interrupt must remain usable even if message/diff reads are slow.
        let session = engine.session(id).await?;
        self.check_project(&session.project_path).await?;
        engine.interrupt(id).await
    }

    pub async fn permission(
        &self,
        id: &str,
        request_id: &str,
        decision: &str,
    ) -> Result<(), String> {
        if !matches!(decision, "once" | "always" | "reject") {
            return Err("无效的权限选择".into());
        }
        let (engine, snapshot, _) = self.session_connection(id).await?;
        if !snapshot
            .permissions
            .iter()
            .any(|request| request.id == request_id && request.session_id == id)
        {
            return Err("这个操作请求已结束，请刷新会话".into());
        }
        engine.reply_permission(id, request_id, decision).await
    }

    pub async fn question(&self, id: &str, request_id: &str, answer: &Value) -> Result<(), String> {
        let (engine, snapshot, _) = self.session_connection(id).await?;
        if !snapshot
            .questions
            .iter()
            .any(|request| request.id == request_id && request.session_id == id)
        {
            return Err("这个问题已结束，请刷新会话".into());
        }
        engine.reply_question(id, request_id, answer).await
    }

    pub async fn reject_question(&self, id: &str, request_id: &str) -> Result<(), String> {
        let (engine, snapshot, _) = self.session_connection(id).await?;
        if !snapshot
            .questions
            .iter()
            .any(|request| request.id == request_id && request.session_id == id)
        {
            return Err("这个问题已结束，请刷新会话".into());
        }
        engine.reject_question(id, request_id).await
    }

    pub async fn close_project(&self) -> Result<(), String> {
        let _operation = self.lifecycle.lock().await;
        let (engine, _, _) = self.connected().await?;
        if engine.has_active_sessions().await? {
            return Err("请先停止或等待当前任务完成，再关闭项目".into());
        }
        self.shutdown().await
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        for lease in self.monitors.lock().await.drain().map(|(_, lease)| lease) {
            lease.store(false, Ordering::Release);
        }
        let previous = self.connection.write().await.take();
        if let Some(previous) = previous {
            previous.engine.shutdown().await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn update_lease_keeps_new_work_blocked_until_installation_finishes() {
        let state = AgentState::default();
        let lease = state.acquire_idle_for_update().await.unwrap();
        assert!(state.lifecycle.try_lock().is_err());
        drop(lease);
        assert!(state.lifecycle.try_lock().is_ok());
    }

    #[tokio::test]
    async fn update_idle_check_runs_after_an_inflight_send_finishes() {
        let lifecycle = Mutex::new(());
        let inflight_send = lifecycle.lock().await;
        let active = AtomicBool::new(false);
        let check =
            acquire_idle_update_lease(&lifecycle, async { Ok(active.load(Ordering::SeqCst)) });
        tokio::pin!(check);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut check)
                .await
                .is_err()
        );
        // Sending finishes, but its queued task continues in the background.
        active.store(true, Ordering::SeqCst);
        drop(inflight_send);
        assert!(check.await.unwrap_err().contains("等待任务结束"));
        assert!(lifecycle.try_lock().is_ok());
    }

    #[tokio::test]
    async fn failed_background_inspection_prevents_install_and_releases_the_lease() {
        let lifecycle = Mutex::new(());
        let error = acquire_idle_update_lease(&lifecycle, async {
            Err("a private engine transport failure".to_string())
        })
        .await
        .unwrap_err();
        assert!(error.contains("更新尚未安装"));
        assert!(!error.contains("private"));
        assert!(lifecycle.try_lock().is_ok());
    }

    #[test]
    fn project_identity_is_canonical_and_does_not_write_selected_directory() {
        let directory = tempfile::tempdir().unwrap();
        let nested = directory.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        assert!(same_project(
            &directory.path().to_string_lossy(),
            &nested.join("..").to_string_lossy()
        ));
        assert!(!same_project(
            &directory.path().to_string_lossy(),
            &nested.to_string_lossy()
        ));
        let file = directory.path().join("file.txt");
        std::fs::write(&file, "unchanged").unwrap();
        assert!(canonical_project(&file.to_string_lossy()).is_err());
        assert!(canonical_project("").is_err());
        assert_eq!(std::fs::read_to_string(file).unwrap(), "unchanged");
    }
}
