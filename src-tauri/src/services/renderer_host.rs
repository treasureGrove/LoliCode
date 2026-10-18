//! Tauri asset provider: select a complete renderer before creating windows.
//! Selection is immutable for the process lifetime; staging never swaps live JS.
use super::renderer_updates::{native_contract, Boot, PackView, RendererStore};
use serde::Serialize;
use std::{
    borrow::Cow,
    sync::{Arc, OnceLock},
};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Manager, Runtime};

struct Session {
    store: Option<Arc<RendererStore>>,
    boot: Boot,
    development: bool,
}
#[derive(Default)]
pub struct RendererHost {
    session: OnceLock<Session>,
    pub operation: tokio::sync::Mutex<()>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererStatus {
    pub running_id: Option<String>,
    pub running_version: Option<u64>,
    pub boot_ticket: Option<String>,
    pub development: bool,
    pub warning: Option<String>,
    pub state: PackView,
}
impl RendererHost {
    pub fn store(&self) -> Result<Arc<RendererStore>, String> {
        self.session
            .get()
            .and_then(|s| s.store.clone())
            .ok_or_else(|| "当前为开发模式或数据目录需要恢复，不能应用界面更新".into())
    }
    pub fn status(&self) -> Result<RendererStatus, String> {
        let session = self.session.get().ok_or("界面更新尚未初始化")?;
        Ok(RendererStatus {
            running_id: session.boot.pack.as_ref().map(|p| p.id.clone()),
            running_version: session.boot.pack.as_ref().map(|p| p.version),
            boot_ticket: session.boot.ticket.clone(),
            development: session.development,
            warning: session.boot.warning.clone(),
            state: match &session.store {
                Some(s) => s.view()?,
                None => PackView::default(),
            },
        })
    }
    pub fn confirm(&self, id: &str, ticket: &str) -> Result<(), String> {
        let session = self.session.get().ok_or("界面尚未初始化")?;
        if session.boot.pack.as_ref().map(|p| p.id.as_str()) != Some(id)
            || session.boot.ticket.as_deref() != Some(ticket)
        {
            return Err("界面启动回执不属于当前窗口版本".into());
        }
        // StrictMode may mount twice. A receipt already committed by this exact
        // session is harmless; stale IDs/tickets remain rejected above.
        let store = self.store()?;
        let state = store.view()?;
        if state.active_id.as_deref() == Some(id) && !state.pending_confirmation {
            return Ok(());
        }
        store.confirm(id, ticket)
    }
    fn initialize(&self, app: &tauri::AppHandle) {
        if cfg!(debug_assertions) {
            let _ = self.session.set(Session {
                store: None,
                boot: Boot::default(),
                development: true,
            });
            return;
        }
        let loaded = (|| -> Result<Arc<RendererStore>, String> {
            let selected = crate::app_store::read_app_config_dir_override(app)
                .map_err(|_| "数据目录配置需要恢复，使用内置界面")?;
            if selected.as_ref().is_some_and(|p| !p.is_dir()) {
                return Err("原数据目录不可用，使用内置界面".into());
            }
            let base = selected.unwrap_or_else(crate::config::get_device_config_dir);
            let config: serde_json::Value =
                serde_json::from_str(include_str!("../../tauri.conf.json"))
                    .map_err(|_| "内置界面更新配置无效")?;
            let key = config["plugins"]["updater"]["pubkey"]
                .as_str()
                .ok_or("缺少界面更新公钥")?;
            let contract = native_contract();
            Ok(Arc::new(RendererStore::new(
                base.join("renderer-packs").join(&contract),
                key.into(),
                env!("CARGO_PKG_VERSION").into(),
                contract,
            )))
        })();
        let (store, boot) = match loaded {
            Ok(store) => {
                let boot = store.begin_boot();
                (Some(store), boot)
            }
            Err(warning) => (
                None,
                Boot {
                    warning: Some(warning),
                    ..Boot::default()
                },
            ),
        };
        let _ = self.session.set(Session {
            store,
            boot,
            development: false,
        });
    }
}
struct EmptyAssets;
impl<R: Runtime> Assets<R> for EmptyAssets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
struct RendererAssets<R: Runtime> {
    bundled: Box<dyn Assets<R>>,
    host: Arc<RendererHost>,
}
impl<R: Runtime> Assets<R> for RendererAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.bundled.setup(app);
    }
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match self.host.session.get().and_then(|s| s.boot.pack.as_ref()) {
            Some(pack) => pack
                .files
                .get(key.as_ref().trim_start_matches('/'))
                .map(|b| Cow::Borrowed(b.as_slice())),
            None => self.bundled.get(key),
        }
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        match self.host.session.get().and_then(|s| s.boot.pack.as_ref()) {
            Some(pack) => Box::new(
                pack.files
                    .iter()
                    .map(|(k, v)| (Cow::Borrowed(k.as_str()), Cow::Borrowed(v.as_slice()))),
            ),
            None => self.bundled.iter(),
        }
    }
    fn csp_hashes(&self, path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        // Native CSP remains authoritative. Renderer packages cannot add hashes
        // or change capabilities. Vite entries use self-hosted external scripts.
        self.bundled.csp_hashes(path)
    }
}
pub fn wrap<R: Runtime>(context: &mut tauri::Context<R>, host: Arc<RendererHost>) {
    let bundled = context.set_assets(Box::new(EmptyAssets));
    context.set_assets(Box::new(RendererAssets { bundled, host }));
}
pub fn plugin(host: Arc<RendererHost>) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("renderer-selection")
        .setup(move |app, _| {
            // Plugin setup runs before Tauri creates configuration windows.
            host.initialize(app);
            app.manage(host);
            Ok(())
        })
        .build()
}

#[cfg(test)]
#[path = "renderer_host_tests.rs"]
mod tests;
