use crate::{services::unreal, store::AppState};
use serde::Serialize;
use std::{path::Path, process::Command};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrealLaunchResult {
    pub project_id: String,
    pub project_name: String,
    pub process_id: Option<u32>,
}

#[tauri::command]
pub async fn get_unreal_snapshot(
    state: State<'_, AppState>,
) -> Result<unreal::UnrealSnapshot, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Unreal,
    )?;
    let _ = lolicode_agent::native::unreal::ensure_started().await;
    unreal::snapshot(&state).await
}

#[tauri::command]
pub fn add_unreal_project(
    state: State<'_, AppState>,
    path: String,
) -> Result<unreal::UnrealProject, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Unreal,
    )?;
    unreal::add_project(&state, &path)
}

#[tauri::command]
pub fn remove_unreal_project(state: State<'_, AppState>, project_id: String) -> Result<(), String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Unreal,
    )?;
    unreal::remove_project(&state, &project_id)
}

#[tauri::command]
pub async fn launch_unreal_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<UnrealLaunchResult, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Unreal,
    )?;
    let (project, engine) = unreal::launch_target(&state, &project_id)?;
    if !project.plugin_enabled || !project.plugin_ready {
        return Err("此工程的桥接插件尚未编译或启用，请先点击安装／修复桥".into());
    }
    if lolicode_agent::native::unreal::has_connection_for_project(Path::new(&project.path)).await {
        return Err(
            "这个工程已经连接 Unreal Editor；请在虚幻工作区查看当前连接，不重复启动".into(),
        );
    }
    let (pairing_token, bridge_url) =
        lolicode_agent::native::unreal::prepare_editor_launch(Path::new(&project.path)).await?;
    let executable = engine.editor_executable.clone();
    let project_path = project.path.clone();
    let launch_result = tokio::task::spawn_blocking(move || {
        let mut command = Command::new(executable);
        command
            .arg(&project_path)
            .arg(format!("-UALServer={bridge_url}"));
        command
            .spawn()
            .map(|child| child.id())
            .map_err(|error| format!("无法启动 Unreal Editor：{error}"))
    })
    .await
    .map_err(|_| "虚幻启动任务未完成")?;
    let process_id = match launch_result {
        Ok(process_id) => process_id,
        Err(error) => {
            lolicode_agent::native::unreal::cancel_editor_launch(&pairing_token);
            return Err(error);
        }
    };
    Ok(UnrealLaunchResult {
        project_id: project.id,
        project_name: project.name,
        process_id: Some(process_id),
    })
}

#[tauri::command]
pub async fn install_unreal_agent_link(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<unreal::UnrealProject, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Unreal,
    )?;
    unreal::install_plugin(&state, &project_id).await
}
