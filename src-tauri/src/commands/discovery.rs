use crate::{
    services::{
        builtin_apps::BuiltinApp,
        discovery::{self, Snapshot},
    },
    store::AppState,
};
use tauri::State;

#[tauri::command]
pub fn get_discovery_catalog(
    state: State<'_, AppState>,
    app: BuiltinApp,
) -> Result<Snapshot, String> {
    discovery::snapshot(&state.db, app)
}
#[tauri::command]
pub async fn refresh_discovery_catalog(
    state: State<'_, AppState>,
    app: BuiltinApp,
) -> Result<Snapshot, String> {
    discovery::refresh(&state.db, app).await
}
#[tauri::command]
pub fn set_discovery_favorite(
    state: State<'_, AppState>,
    app: BuiltinApp,
    id: String,
    saved: bool,
) -> Result<Snapshot, String> {
    discovery::favorite(&state.db, app, &id, saved)
}

#[tauri::command]
pub async fn get_discovery_preview(
    state: State<'_, AppState>,
    id: String,
) -> Result<discovery::PreviewImage, String> {
    discovery::preview(&state.db, &id).await
}
