use crate::{
    services::builtin_apps::{self, BuiltinApp, BuiltinAppState},
    store::AppState,
};
use tauri::State;

#[tauri::command]
pub fn list_builtin_apps(state: State<'_, AppState>) -> Result<Vec<BuiltinAppState>, String> {
    builtin_apps::list(&state.db)
}

#[tauri::command]
pub fn set_builtin_app_enabled(
    state: State<'_, AppState>,
    app: BuiltinApp,
    enabled: bool,
) -> Result<(), String> {
    builtin_apps::set_enabled(&state.db, app, enabled)
}
