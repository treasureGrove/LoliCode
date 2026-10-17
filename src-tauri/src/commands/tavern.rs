use crate::{
    services::{channel_center::AgentCatalog, tavern},
    store::AppState,
};
use tauri::State;

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
