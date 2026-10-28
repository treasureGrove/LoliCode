//! Tauri asset provider: select a complete renderer before creating windows.
//! Stable selection is immutable for the process lifetime. Development builds
//! may atomically replace a complete local snapshot before reloading the page.
#[path = "development_renderer.rs"]
mod development;
use super::renderer_updates::{native_contract, Boot, PackView, RendererStore};
pub use development::DevelopmentFrontendBuild;
use serde::Serialize;
use std::{
    borrow::Cow,
    path::Path,
    sync::{Arc, OnceLock, RwLock},
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
    development_assets: RwLock<Option<development::DevelopmentSelection>>,
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
    fn activate_development_renderer(
        &self,
        source: &Path,
        snapshot: development::DevelopmentSnapshot,
    ) -> Result<DevelopmentFrontendBuild, String> {
        let metadata = snapshot.metadata.clone();
        let mut assets = self
            .development_assets
            .write()
            .map_err(|_| "开发界面正在恢复，请重试")?;
        let old = assets.take();
        let previous = old.as_ref().map(|selection| selection.current.clone());
        *assets = Some(development::DevelopmentSelection {
            current: Arc::new(snapshot),
            previous,
        });
        let saved = serde_json::to_vec(&metadata)
            .map_err(|_| "开发界面记录无法保存")
            .and_then(|bytes| {
                crate::config::atomic_write(&development::pointer_path(source), &bytes)
                    .map_err(|_| "开发界面记录无法保存，当前界面保持不变")
            });
        if let Err(error) = saved {
            *assets = old;
            return Err(error.into());
        }
        Ok(metadata)
    }
    pub async fn rebuild_development_frontend(&self) -> Result<DevelopmentFrontendBuild, String> {
        if !crate::channel::is_development() {
            return Err("热更新界面仅用于本地开发版".into());
        }
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "界面构建正在进行，请稍候")?;
        let (source, snapshot) = tokio::task::spawn_blocking(development::build)
            .await
            .map_err(|_| "前端构建未完成，当前界面保持不变")??;
        self.activate_development_renderer(&source, snapshot)
    }
    /// Acceptance-only constructor: the caller supplies its isolated store.
    /// Does not resolve any application paths, database or account state.
    #[cfg(feature = "test-hooks")]
    pub fn isolated(store: Arc<RendererStore>) -> Arc<Self> {
        let host = Arc::new(Self::default());
        let _ = host.session.set(Session {
            boot: store.begin_boot(),
            store: Some(store),
            development: false,
        });
        host
    }
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
        if crate::channel::is_development() {
            let _ = self.session.set(Session {
                store: None,
                boot: Boot::default(),
                development: true,
            });
            if let Ok(source) = development::source_directory() {
                if development::pointer_path(&source).is_file() {
                    match development::load_current(&source) {
                        Ok(snapshot) => {
                            if let Ok(mut assets) = self.development_assets.write() {
                                *assets = Some(development::DevelopmentSelection {
                                    current: Arc::new(snapshot),
                                    previous: None,
                                });
                            }
                        }
                        Err(error) => log::warn!("本地开发界面不可用，使用内置界面：{error}"),
                    }
                }
            }
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
        if let Ok(assets) = self.host.development_assets.read() {
            if let Some(selection) = assets.as_ref() {
                let path = key.as_ref().trim_start_matches('/');
                return selection
                    .current
                    .files
                    .get(path)
                    .or_else(|| {
                        selection
                            .previous
                            .as_ref()
                            .and_then(|old| old.files.get(path))
                    })
                    .map(|bytes| Cow::Owned(bytes.clone()));
            }
        }
        match self.host.session.get().and_then(|s| s.boot.pack.as_ref()) {
            Some(pack) => pack
                .files
                .get(key.as_ref().trim_start_matches('/'))
                .map(|b| Cow::Borrowed(b.as_slice())),
            None => self.bundled.get(key),
        }
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        if let Ok(assets) = self.host.development_assets.read() {
            if let Some(selection) = assets.as_ref() {
                let files = selection
                    .current
                    .files
                    .iter()
                    .map(|(key, value)| (Cow::Owned(key.clone()), Cow::Owned(value.clone())))
                    .collect::<Vec<_>>();
                return Box::new(files.into_iter());
            }
        }
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
    let builder = tauri::plugin::Builder::new("renderer-selection").setup(move |app, _| {
        // Plugin setup runs before Tauri creates configuration windows.
        host.initialize(app);
        app.manage(host);
        Ok(())
    });
    let builder = if crate::channel::is_development() {
        // Use Tauri's resolver so native CSP and its HTML/IPC bootstrap stay
        // authoritative; only development responses opt out of browser caching.
        builder.register_uri_scheme_protocol("tauri", |context, request| {
            let https = request.uri().scheme_str() == Some("https");
            let asset = context
                .app_handle()
                .asset_resolver()
                .get_for_scheme(request.uri().path().to_string(), https);
            let mut response = tauri::http::Response::builder()
                .header("Cache-Control", "no-store")
                .header(
                    "Access-Control-Allow-Origin",
                    if cfg!(any(windows, target_os = "android")) {
                        if https {
                            "https://tauri.localhost"
                        } else {
                            "http://tauri.localhost"
                        }
                    } else {
                        "tauri://localhost"
                    },
                );
            match asset {
                Some(asset) => {
                    response = response.header("Content-Type", asset.mime_type);
                    if let Some(csp) = asset.csp_header {
                        response = response.header("Content-Security-Policy", csp);
                    }
                    response
                        .body(asset.bytes)
                        .expect("valid development asset response")
                }
                None => response
                    .status(404)
                    .header("Content-Type", "text/plain")
                    .body(b"Development asset not found".to_vec())
                    .expect("valid development asset response"),
            }
        })
    } else {
        builder
    };
    builder.build()
}

#[cfg(test)]
#[path = "renderer_host_tests.rs"]
mod tests;
