//! Desktop carrier for the UI-independent Lolicode agent adapter.
//! Only normalized session data crosses IPC; engine config and credentials stay here.

use crate::services::channel_center::{self, AgentCatalog};
use crate::store::AppState;
use lolicode_agent::{AgentModelRef, AgentSession, AgentSnapshot, Engine, EngineOptions};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::{Mutex, RwLock};

#[derive(Default)]
pub struct AgentState {
    /// Sending and switching projects serialize, while interrupt and snapshots
    /// remain available during network I/O.
    lifecycle: Mutex<()>,
    connection: RwLock<Option<AgentConnection>>,
}

struct AgentConnection {
    engine: Arc<Engine>,
    workspace: AgentWorkspace,
    catalog: AgentCatalog,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspace {
    pub path: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeStatus {
    pub available: bool,
    pub version: Option<String>,
    pub running: bool,
    pub project_path: Option<String>,
}

#[derive(Serialize)]
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

fn canonical_project(path: &str) -> Result<PathBuf, String> {
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

fn workspace(path: &Path) -> AgentWorkspace {
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

impl AgentState {
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
                .map(|connection| connection.workspace.path.clone()),
        }
    }

    pub async fn open_project(
        &self,
        app: &tauri::AppHandle,
        state: &AppState,
        path: String,
        accounts: Vec<(String, String)>,
    ) -> Result<AgentOpenProject, String> {
        let project = tokio::task::spawn_blocking(move || canonical_project(&path))
            .await
            .map_err(|_| "项目目录检测失败，请重试".to_string())??;
        let executable = runtime_executable(app).ok_or_else(|| {
            "未找到应用附带的 agent 引擎，请重新安装完整 Lolicode 安装包".to_string()
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
        if let Some((engine, current, catalog)) = &old {
            if engine.is_running() {
                let same = same_project(&current.path, &project.to_string_lossy());
                let active = engine.has_active_sessions().await?;
                if same && (catalog.revision == draft.revision || active) {
                    let sessions = engine.list_sessions(&project).await?;
                    return Ok(AgentOpenProject {
                        workspace: current.clone(),
                        catalog: catalog.clone(),
                        sessions,
                    });
                }
                if active {
                    return Err("当前项目还有任务在执行，请先停止或等待完成后再切换项目".into());
                }
            }
        }
        // Validate before publishing, then validate the exact immutable revision.
        // A concurrent channel editor must not replace what this engine binds.
        channel_center::validate_managed_account_references(&draft, &accounts)
            .map_err(|error| error.to_string())?;
        let prepared = channel_center::prepare_agent_catalog(state)
            .await
            .map_err(|error| error.to_string())?;
        let published = channel_center::load_catalog(state.db.as_ref(), prepared.catalog.revision)
            .map_err(|error| error.to_string())?;
        channel_center::validate_managed_account_references(&published, &accounts)
            .map_err(|error| error.to_string())?;
        if let Some(previous) = self.connection.write().await.take() {
            previous.engine.shutdown().await?;
        }
        let engine = Arc::new(
            Engine::launch(EngineOptions {
                executable,
                private_root: crate::config::get_app_config_dir()
                    .join("agent")
                    .join("runtime"),
                config: prepared.config,
            })
            .await?,
        );
        let sessions = match engine.list_sessions(&project).await {
            Ok(sessions) => sessions,
            Err(error) => {
                let _ = engine.shutdown().await;
                return Err(error);
            }
        };
        let workspace = workspace(&project);
        let catalog = prepared.catalog;
        *self.connection.write().await = Some(AgentConnection {
            engine,
            workspace: workspace.clone(),
            catalog: catalog.clone(),
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
        let (engine, workspace, catalog) = self.connected().await?;
        let snapshot = engine.snapshot(id).await?;
        if !same_project(&workspace.path, &snapshot.session.project_path) {
            return Err("这段会话属于另一个项目，请先打开对应项目".into());
        }
        Ok((engine, snapshot, catalog))
    }

    pub async fn list_sessions(&self) -> Result<Vec<AgentSession>, String> {
        let (engine, workspace, _) = self.connected().await?;
        engine.list_sessions(Path::new(&workspace.path)).await
    }

    pub async fn create_session(
        &self,
        model_id: &str,
        mode: &str,
        title: Option<&str>,
    ) -> Result<AgentSession, String> {
        if !matches!(mode, "build" | "plan") {
            return Err("请选择实现或分析模式".into());
        }
        let _operation = self.lifecycle.lock().await;
        let (engine, workspace, catalog) = self.connected().await?;
        let model = selected_model(&catalog, model_id)?;
        engine
            .create_session(Path::new(&workspace.path), &model, mode, title)
            .await
    }

    pub async fn snapshot(&self, id: &str) -> Result<AgentSnapshot, String> {
        self.session_connection(id)
            .await
            .map(|(_, snapshot, _)| snapshot)
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
        engine.send_message(id, text, request_id).await
    }

    pub async fn interrupt(&self, id: &str) -> Result<(), String> {
        let (engine, workspace, _) = self.connected().await?;
        // Interrupt must remain usable even if message/diff reads are slow.
        let session = engine.session(id).await?;
        if !same_project(&workspace.path, &session.project_path) {
            return Err("这段会话属于另一个项目，请先打开对应项目".into());
        }
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
