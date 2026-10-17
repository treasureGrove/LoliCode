use crate::services::resource_updates::{PackView, ResourceStore};
use std::sync::{Arc, OnceLock};
use tokio::sync::{Mutex, OnceCell};

struct ResourceUpdates {
    store: OnceCell<Arc<ResourceStore>>,
    operation: Mutex<()>,
}
fn updates() -> &'static ResourceUpdates {
    static UPDATES: OnceLock<ResourceUpdates> = OnceLock::new();
    UPDATES.get_or_init(|| ResourceUpdates {
        store: OnceCell::new(),
        operation: Mutex::new(()),
    })
}

async fn store() -> Result<Arc<ResourceStore>, String> {
    updates()
        .store
        .get_or_try_init(|| async {
            let config: serde_json::Value =
                serde_json::from_str(include_str!("../../tauri.conf.json"))
                    .map_err(|_| "内置资源更新配置无效")?;
            let key = config["plugins"]["updater"]["pubkey"]
                .as_str()
                .ok_or("缺少内置资源公钥")?
                .to_string();
            let store = Arc::new(ResourceStore::new(
                crate::config::get_app_config_dir().join("presentation-packs"),
                key,
                env!("CARGO_PKG_VERSION").into(),
            ));
            let recover = store.clone();
            // A failed previous render returns to the prior local pack on startup.
            // Damaged marker files leave the bundled artwork available through view().
            let _ = tokio::task::spawn_blocking(move || recover.recover_startup()).await;
            Ok(store)
        })
        .await
        .cloned()
}

#[tauri::command]
pub async fn get_resource_pack() -> Result<PackView, String> {
    let _operation = updates().operation.lock().await;
    let store = store().await?;
    tokio::task::spawn_blocking(move || store.view())
        .await
        .map_err(|_| "本地资源读取未完成".into())
}

#[tauri::command]
pub async fn check_resource_update() -> Result<Option<u64>, String> {
    let _operation = updates()
        .operation
        .try_lock()
        .map_err(|_| "资源更新正在进行，请稍后重试")?;
    store().await?.check().await
}

#[tauri::command]
pub async fn install_resource_update() -> Result<PackView, String> {
    let _operation = updates()
        .operation
        .try_lock()
        .map_err(|_| "资源更新正在进行，请稍后重试")?;
    store().await?.install().await
}

#[tauri::command]
pub async fn confirm_resource_pack(id: String) -> Result<(), String> {
    let _operation = updates().operation.lock().await;
    let store = store().await?;
    tokio::task::spawn_blocking(move || store.confirm(&id))
        .await
        .map_err(|_| "资源显示确认未完成")?
}

#[tauri::command]
pub async fn rollback_resource_pack(id: String) -> Result<PackView, String> {
    let _operation = updates()
        .operation
        .try_lock()
        .map_err(|_| "资源更新正在进行，请稍后重试")?;
    let store = store().await?;
    tokio::task::spawn_blocking(move || store.rollback(&id))
        .await
        .map_err(|_| "资源回退未完成")?
}
