use crate::{
    services::{channel_center::AgentCatalog, tavern},
    store::AppState,
};
use tauri::State;

fn require_tavern(state: &AppState) -> Result<(), String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Tavern,
    )
}

#[tauri::command]
pub fn get_tavern_local_model(
    state: State<'_, AppState>,
) -> Result<tavern::local_model::LocalModelStatus, String> {
    require_tavern(&state)?;
    Ok(tavern::local_model::manager().status())
}

#[tauri::command]
pub fn install_tavern_local_model(
    state: State<'_, AppState>,
) -> Result<tavern::local_model::LocalModelStatus, String> {
    require_tavern(&state)?;
    tavern::local_model::manager().begin_install()
}

#[tauri::command]
pub fn pause_tavern_local_model_install(state: State<'_, AppState>) -> Result<(), String> {
    require_tavern(&state)?;
    tavern::local_model::manager().cancel_install();
    Ok(())
}

#[tauri::command]
pub async fn set_tavern_local_model_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<tavern::local_model::LocalModelStatus, String> {
    require_tavern(&state)?;
    tavern::local_model::manager().set_enabled(enabled).await
}

#[tauri::command]
pub async fn stop_tavern_local_model(
    state: State<'_, AppState>,
) -> Result<tavern::local_model::LocalModelStatus, String> {
    require_tavern(&state)?;
    tavern::local_model::manager().stop().await
}

#[tauri::command]
pub fn get_tavern_presets(state: State<'_, AppState>) -> Result<Vec<tavern::TavernPreset>, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Tavern,
    )?;
    tavern::preset_catalog(&state)
}

#[tauri::command]
pub fn add_tavern_preset(
    state: State<'_, AppState>,
    preset_id: String,
) -> Result<tavern::TavernCharacter, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Tavern,
    )?;
    tavern::add_preset(&state, &preset_id)
}

#[tauri::command]
pub fn get_tavern_snapshot(state: State<'_, AppState>) -> Result<tavern::TavernSnapshot, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Tavern,
    )?;
    tavern::snapshot(&state)
}

#[tauri::command]
pub fn import_tavern_character(
    state: State<'_, AppState>,
    path: String,
) -> Result<tavern::TavernCharacter, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Tavern,
    )?;
    tavern::import_character(&state, &path)
}

#[tauri::command]
pub fn get_tavern_avatar(
    state: State<'_, AppState>,
    character_id: String,
) -> Result<tavern::TavernAvatar, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Tavern,
    )?;
    tavern::avatar(&state, &character_id)
}

#[tauri::command]
pub async fn get_tavern_catalog(state: State<'_, AppState>) -> Result<AgentCatalog, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Tavern,
    )?;
    tavern::catalog(&state).await
}

#[tauri::command]
pub fn create_tavern_story(
    state: State<'_, AppState>,
    character_id: String,
    title: Option<String>,
) -> Result<tavern::TavernStory, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Tavern,
    )?;
    tavern::create_story(&state, &character_id, title.as_deref())
}

#[tauri::command]
pub fn delete_tavern_story(state: State<'_, AppState>, story_id: String) -> Result<(), String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Tavern,
    )?;
    tavern::delete_story(&state, &story_id)
}

#[tauri::command]
pub fn preview_tavern_context(
    state: State<'_, AppState>,
    story_id: String,
) -> Result<tavern::TavernContextPreview, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Tavern,
    )?;
    tavern::context_preview(&state, &story_id)
}

#[tauri::command]
pub async fn send_tavern_message(
    state: State<'_, AppState>,
    story_id: String,
    text: String,
    model_id: String,
) -> Result<tavern::TavernStory, String> {
    crate::services::builtin_apps::require(
        &state.db,
        crate::services::builtin_apps::BuiltinApp::Tavern,
    )?;
    tavern::send_message(&state, &story_id, &text, &model_id).await
}
