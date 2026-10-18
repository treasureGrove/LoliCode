use crate::{
    config,
    services::local_agent_tools::{self, LocalAgentTool, ToolPaths},
};
use std::{path::PathBuf, sync::Mutex};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

static PATHS_LOCK: Mutex<()> = Mutex::new(());

fn paths_file() -> PathBuf {
    config::get_device_config_dir().join("local-agent-paths.json")
}
fn load_paths() -> Result<ToolPaths, String> {
    match std::fs::read(paths_file()) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "本地 Agent 路径记录损坏，请检查 local-agent-paths.json".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ToolPaths::default()),
        Err(_) => Err("无法读取本地 Agent 路径记录".into()),
    }
}

#[tauri::command]
pub async fn list_local_agent_tools() -> Result<Vec<LocalAgentTool>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _lock = PATHS_LOCK
            .lock()
            .map_err(|_| "本地 Agent 管理繁忙".to_string())?;
        Ok(local_agent_tools::list(&load_paths()?))
    })
    .await
    .map_err(|_| "本地 Agent 检测失败".to_string())?
}

#[tauri::command]
pub async fn set_local_agent_tool_path(target: String, path: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        local_agent_tools::validate_target(&target)?;
        let path = path
            .map(|p| local_agent_tools::validate_path(&target, &PathBuf::from(p)))
            .transpose()?;
        let _lock = PATHS_LOCK
            .lock()
            .map_err(|_| "本地 Agent 管理繁忙".to_string())?;
        let mut paths = load_paths()?;
        if let Some(path) = path {
            paths.0.insert(target, path);
        } else {
            paths.0.remove(&target);
        }
        let bytes = serde_json::to_vec_pretty(&paths).map_err(|e| e.to_string())?;
        config::atomic_write_private(&paths_file(), &bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "无法保存程序路径".to_string())?
}

#[tauri::command]
pub async fn reveal_local_agent_tool(app: AppHandle, target: String) -> Result<(), String> {
    local_agent_tools::validate_target(&target)?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        let _lock = PATHS_LOCK
            .lock()
            .map_err(|_| "本地 Agent 管理繁忙".to_string())?;
        let tool = local_agent_tools::list(&load_paths()?)
            .into_iter()
            .find(|t| t.id == target && t.installed)
            .ok_or_else(|| "未找到已安装程序，请先选择程序位置".to_string())?;
        let path = PathBuf::from(tool.path.ok_or_else(|| "程序路径不可用".to_string())?);
        Ok::<_, String>(
            path.parent()
                .ok_or_else(|| "程序目录不可用".to_string())?
                .to_path_buf(),
        )
    })
    .await
    .map_err(|_| "无法读取程序位置".to_string())??;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}
