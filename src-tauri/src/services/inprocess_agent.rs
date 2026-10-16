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
    skill_snapshot: RwLock<Option<SkillSnapshot>>,
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
        Ok(engine)
    }

    pub async fn bind_background_project(
        &self,
        app: &tauri::AppHandle,
        state: &AppState,
        path: String,
        accounts: Vec<(String, String)>,
    ) -> Result<AgentCatalog, String> {
        let path = tokio::task::spawn_blocking(move || canonical_project(&path))
            .await
            .map_err(|_| "项目目录检查未完成")??;
        let _guard = self.lifecycle.lock().await;
        let engine = self.start_locked(app).await?;
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
        ) {
            return Ok(None);
        }
        let store = self
            .extensions
            .get()
            .ok_or("默认技能资源不可用，请使用完整安装包；核心编程仍可运行")?;
        let id = || args["id"].as_str().ok_or("缺少扩展编号");
        let enabled = || args["enabled"].as_bool().ok_or("缺少启用状态");
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
                store
                    .store()
                    .set_plugin_enabled(id()?, enabled()?)
                    .map_err(|e| e.to_string())?;
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
        store
            .catalog(active.as_ref(), &loaded)
            .map(Some)
            .map_err(|e| e.to_string())
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
        let path = tokio::task::spawn_blocking(move || canonical_project(&path))
            .await
            .map_err(|_| "项目目录检查未完成")??;
        let _guard = self.lifecycle.lock().await;
        let engine = self.start_locked(app).await?;
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
        pinned: bool,
    ) -> Result<preferences::AgentProject, String> {
        let _guard = self.lifecycle.lock().await;
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
        if let Some(engine) = engine {
            engine.shutdown().await?;
        }
        Ok(())
    }
}
