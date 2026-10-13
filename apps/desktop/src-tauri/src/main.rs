#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use freehub_gateway::{
    credentials::SystemCredentials, Channel, Gateway, GatewayHandle, ProbeResult, RequestLog,
    SafeError, SaveChannel, Store,
};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

struct AppState {
    store: Arc<Store>,
    gateway: Gateway,
    handle: tokio::sync::Mutex<Option<GatewayHandle>>,
    error: Mutex<Option<String>>,
    shutdown: CancellationToken,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    running: bool,
    base_url: String,
    version: String,
    error: Option<String>,
}

#[tauri::command]
async fn gateway_status(state: State<'_, AppState>) -> Result<Status, SafeError> {
    Ok(Status {
        running: state.handle.lock().await.is_some(),
        base_url: "http://127.0.0.1:4310/v1".into(),
        version: "0.1.0".into(),
        error: state.error.lock().unwrap().clone(),
    })
}
#[tauri::command]
fn list_channels(state: State<'_, AppState>) -> Result<Vec<Channel>, SafeError> {
    state.store.channels()
}
#[tauri::command]
fn save_channel(input: SaveChannel, state: State<'_, AppState>) -> Result<Channel, SafeError> {
    state.store.save_channel(input)
}
#[tauri::command]
fn delete_channel(id: String, state: State<'_, AppState>) -> Result<(), SafeError> {
    state.store.delete_channel(&id)
}
#[tauri::command]
async fn test_channel(id: String, state: State<'_, AppState>) -> Result<ProbeResult, SafeError> {
    state.gateway.probe(&id).await
}
#[tauri::command]
fn request_logs(state: State<'_, AppState>) -> Result<Vec<RequestLog>, SafeError> {
    state.store.logs()
}
#[tauri::command]
fn rotate_token(state: State<'_, AppState>) -> Result<(), SafeError> {
    state.store.rotate_token()
}
#[tauri::command]
fn copy_connection(
    kind: String,
    id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), SafeError> {
    let text = match kind.as_str() {
        "token" => state.store.local_token()?.to_string(),
        "url" => "http://127.0.0.1:4310/v1".into(),
        "model" => state
            .store
            .channels()?
            .into_iter()
            .find(|c| Some(&c.id) == id.as_ref())
            .ok_or_else(|| SafeError::invalid("请选择渠道。"))?
            .public_model(),
        _ => return Err(SafeError::invalid("无效的复制请求。")),
    };
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|_| {
            SafeError::new(
                500,
                "clipboard_unavailable",
                "剪贴板暂时不可用，请稍后重试。",
            )
        })
}
#[tauri::command]
fn open_provider(provider_id: String, app: tauri::AppHandle) -> Result<(), SafeError> {
    let url = match provider_id.as_str() {
        "zhipu-bigmodel" => "https://open.bigmodel.cn/",
        "groq" => "https://console.groq.com/keys",
        "siliconflow" => "https://cloud.siliconflow.cn/",
        "zhipu-docs" => "https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash",
        _ => return Err(SafeError::invalid("该渠道没有内置注册链接。")),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| SafeError::new(500, "browser_unavailable", "无法打开浏览器。"))
}
#[tauri::command]
async fn retry_gateway(state: State<'_, AppState>) -> Result<(), SafeError> {
    let mut handle = state.handle.lock().await;
    if handle.is_none() {
        match state.gateway.start(4310).await {
            Ok(server) => {
                *handle = Some(server);
                *state.error.lock().unwrap() = None;
            }
            Err(e) => {
                *state.error.lock().unwrap() = Some(e.message.clone());
                return Err(e);
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn quit_app(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), SafeError> {
    state.shutdown.cancel();
    if let Some(handle) = state.handle.lock().await.take() {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), handle.stop()).await;
    }
    app.exit(0);
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let credentials = SystemCredentials::default();
            // Acceptance runs get an isolated directory and vault service; release builds ignore these variables.
            #[cfg(debug_assertions)]
            let (dir, credentials) = match std::env::var_os("FREEHUB_ACCEPTANCE_DATA_DIR") {
                Some(path) => (
                    std::path::PathBuf::from(path),
                    SystemCredentials::new("art.treasuregrove.freehub.acceptance".into()),
                ),
                None => (dir, credentials),
            };
            let store = Store::open(&dir, Arc::new(credentials))?;
            let shutdown = CancellationToken::new();
            let gateway = Gateway::new(store.clone(), shutdown.clone())?;
            let (handle, error) = match tauri::async_runtime::block_on(gateway.start(4310)) {
                Ok(server) => (Some(server), None),
                Err(e) => (None, Some(e.message)),
            };
            app.manage(AppState {
                store,
                gateway,
                handle: tokio::sync::Mutex::new(handle),
                error: Mutex::new(error),
                shutdown,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gateway_status,
            list_channels,
            save_channel,
            delete_channel,
            test_channel,
            request_logs,
            rotate_token,
            copy_connection,
            open_provider,
            retry_gateway,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("FreeHub startup failed; check Windows Credential Manager and WebView2");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            app.state::<AppState>().shutdown.cancel();
        }
    });
}
