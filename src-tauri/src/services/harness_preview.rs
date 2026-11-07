//! Live browser previews of HTML delivered by an owned Harness session.
//!
//! The desktop serves the delivered file and its sibling assets on a private
//! loopback origin. That origin can outlive the SDK process without keeping an
//! agent or an unrestricted subprocess running after its turn.
use super::agent_browser::BrowserTools;
use crate::commands::agent_files;
use axum::{
    extract::{Path as UrlPath, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use lolicode_agent::{
    native::applications::ApplicationTools, AgentPreviewRequest, AgentPreviewTarget,
};
use serde_json::json;
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
#[cfg(windows)]
use tauri::AppHandle;
use tokio::{
    net::TcpListener,
    sync::{watch, Mutex},
    task::JoinHandle,
    time::Instant,
};
use url::Url;
use uuid::Uuid;

const MAX_PREVIEWS: usize = 3;
#[cfg(windows)]
const MAX_LINK_PREVIEWS: usize = 12;
const TOKEN_ROUTE: &str = "__lolicode_preview";
const COOKIE: &str = "lolicode_preview";

#[derive(Clone, Default)]
pub(crate) struct HarnessPreview {
    live: Arc<Mutex<HashMap<String, LivePreview>>>,
    publishing: Arc<Mutex<()>>,
}

#[derive(Clone)]
pub(crate) struct FrameScope {
    pub project: String,
    pub working_directory: PathBuf,
    pub native: bool,
}

struct LivePreview {
    receipt_id: String,
    request: AgentPreviewRequest,
    scope: FrameScope,
    last_used: Instant,
    source: PreviewSource,
    #[cfg(windows)]
    view: Option<NativePreviewLease>,
}

enum PreviewSource {
    Tool,
    Delivery {
        // Own the server until this preview closes, including on platforms
        // where no native guest needs to read its URL again.
        _server: PreviewServer,
    },
    #[cfg(windows)]
    Link(Url),
}

impl LivePreview {
    fn is_link(&self) -> bool {
        match self.source {
            #[cfg(windows)]
            PreviewSource::Link(_) => true,
            _ => false,
        }
    }

    fn uses_browser_tool(&self) -> bool {
        matches!(self.source, PreviewSource::Tool) || !self.scope.native
    }
}

#[cfg(windows)]
struct NativePreviewLease {
    app: AppHandle,
    browser_id: String,
}

#[cfg(windows)]
impl Drop for NativePreviewLease {
    fn drop(&mut self) {
        let id = self.browser_id.clone();
        let _ = self
            .app
            .run_on_main_thread(move || super::agent_preview_guest::close(&id));
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct PreviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, serde::Deserialize)]
pub(crate) struct PreviewPresentation {
    pub slot: u8,
    pub revision: u64,
}

struct PreviewServer {
    url: String,
    active: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl Drop for PreviewServer {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        self.task.abort();
    }
}

impl HarnessPreview {
    #[cfg(windows)]
    pub(crate) async fn open_link(
        &self,
        session_id: String,
        project: String,
        url: &str,
    ) -> Result<AgentPreviewRequest, String> {
        let url = super::agent_preview_guest::link_url(url)?;
        let browser_id = Uuid::new_v4().simple().to_string();
        let request = AgentPreviewRequest {
            id: browser_id.clone(),
            session_id,
            created_at: chrono::Utc::now().timestamp_millis() as u64,
            target: AgentPreviewTarget::Browser {
                browser_id: browser_id.clone(),
                url: url.to_string(),
                delivery_id: None,
                native: true,
            },
        };
        let mut live = self.live.lock().await;
        if live.values().filter(|entry| entry.is_link()).count() >= MAX_LINK_PREVIEWS {
            return Err("已达到浏览器标签上限，请先关闭一个标签。".into());
        }
        live.insert(
            browser_id,
            LivePreview {
                receipt_id: request.id.clone(),
                request: request.clone(),
                scope: FrameScope {
                    working_directory: PathBuf::from(&project),
                    project,
                    native: true,
                },
                last_used: Instant::now(),
                source: PreviewSource::Link(url),
                view: None,
            },
        );
        Ok(request)
    }

    pub(crate) async fn publish(
        &self,
        browser: &BrowserTools,
        session_id: &str,
        project: &Path,
        working_directory: &Path,
        receipt_id: &str,
        delivered_path: &str,
    ) -> Result<AgentPreviewRequest, String> {
        let _publishing = self.publishing.lock().await;
        if let Some(request) = self.rendered(receipt_id).await {
            if request.session_id == session_id {
                return Ok(request);
            }
            return Err("网页预览回执不属于此会话".into());
        }

        let (working_directory, entry) = agent_files::resolve(working_directory, delivered_path)?;
        let entry_name = entry
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("网页文件名无效")?;
        let visible_entry = entry
            .strip_prefix(&working_directory)
            .ok()
            .and_then(Path::to_str)
            .is_some_and(|path| valid_asset_path(&path.replace('\\', "/")));
        if !is_html(&entry) || !entry.is_file() || !visible_entry {
            return Err("网页预览仅接受工作区中的 HTML 文件".into());
        }
        let directory = entry.parent().ok_or("网页目录无效")?.to_owned();
        let server = PreviewServer::start(directory, entry_name).await?;

        // Keep a bounded set of project origins and their user-facing views.
        let evicted = {
            let mut live = self.live.lock().await;
            let entries = || live.iter().filter(|(_, entry)| !entry.is_link());
            let replace = entries()
                .find(|(_, entry)| entry.request.session_id == session_id)
                .or_else(|| {
                    (entries().count() >= MAX_PREVIEWS)
                        .then(|| entries().min_by_key(|(_, entry)| entry.last_used))
                        .flatten()
                })
                .map(|(id, _)| id.clone());
            replace.and_then(|id| live.remove(&id).map(|entry| (id, entry)))
        };
        if let Some((id, entry)) = evicted {
            if entry.uses_browser_tool() {
                close_browser(browser, &entry.scope.working_directory, &id).await;
            }
        }

        #[cfg(windows)]
        let browser_id = Uuid::new_v4().simple().to_string();
        #[cfg(not(windows))]
        let browser_id = {
            let (_keep_open, cancel) = watch::channel(false);
            let result = browser
                .execute_output(
                    &working_directory,
                    "browser_open",
                    &json!({"url":server.url,"width":1000,"height":620}),
                    cancel,
                )
                .await?;
            let output: serde_json::Value =
                serde_json::from_str(&result.text).map_err(|_| "无法读取浏览器预览回执")?;
            let id = output["browser_id"]
                .as_str()
                .ok_or("浏览器没有返回预览编号")?
                .to_owned();
            if !output["http_status"]
                .as_u64()
                .is_some_and(|code| (200..300).contains(&code))
            {
                close_browser(browser, &working_directory, &id).await;
                return Err("浏览器未能读取已交付网页".into());
            }
            browser.retain_preview(&working_directory, &id).await?;
            id
        };
        let request = AgentPreviewRequest {
            id: browser_id.clone(),
            session_id: session_id.into(),
            created_at: chrono::Utc::now().timestamp_millis() as u64,
            target: AgentPreviewTarget::Browser {
                browser_id: browser_id.clone(),
                url: server.url.clone(),
                delivery_id: Some(receipt_id.into()),
                native: cfg!(windows),
            },
        };
        self.live.lock().await.insert(
            browser_id.clone(),
            LivePreview {
                receipt_id: receipt_id.into(),
                request: request.clone(),
                scope: FrameScope {
                    project: project.to_string_lossy().into_owned(),
                    working_directory,
                    native: cfg!(windows),
                },
                last_used: Instant::now(),
                source: PreviewSource::Delivery { _server: server },
                #[cfg(windows)]
                view: None,
            },
        );
        Ok(request)
    }

    /// Give the workbench access to an existing host-owned browser opened
    /// through an approved product tool.
    pub(super) async fn adopt(
        &self,
        browser: &BrowserTools,
        project: &Path,
        request: &AgentPreviewRequest,
    ) -> bool {
        let AgentPreviewTarget::Browser {
            browser_id, native, ..
        } = &request.target
        else {
            return true;
        };
        let _publishing = self.publishing.lock().await;
        if browser.retain_preview(project, browser_id).await.is_err() {
            return false;
        }
        let evicted = {
            let mut live = self.live.lock().await;
            if let Some(entry) = live.get(browser_id) {
                return entry.request.session_id == request.session_id;
            }
            let entries = || live.iter().filter(|(_, entry)| !entry.is_link());
            let evict = entries()
                .find(|(_, entry)| entry.request.session_id == request.session_id)
                .or_else(|| {
                    (entries().count() >= MAX_PREVIEWS)
                        .then(|| entries().min_by_key(|(_, entry)| entry.last_used))
                        .flatten()
                })
                .map(|(id, _)| id.clone());
            let evicted = evict.and_then(|id| live.remove(&id).map(|entry| (id, entry)));
            live.insert(
                browser_id.clone(),
                LivePreview {
                    receipt_id: request.id.clone(),
                    request: request.clone(),
                    scope: FrameScope {
                        project: project.to_string_lossy().into_owned(),
                        working_directory: project.to_owned(),
                        native: *native && cfg!(windows),
                    },
                    last_used: Instant::now(),
                    source: PreviewSource::Tool,
                    #[cfg(windows)]
                    view: None,
                },
            );
            evicted
        };
        if let Some((id, entry)) = evicted {
            if entry.uses_browser_tool() {
                close_browser(browser, &entry.scope.working_directory, &id).await;
            }
        }
        true
    }

    #[cfg(windows)]
    #[expect(
        clippy::too_many_arguments,
        reason = "Dispatch the desktop preview command with its session, browser and presentation fields."
    )]
    pub(crate) async fn sync_webview(
        &self,
        app: &AppHandle,
        browser: &BrowserTools,
        session_id: &str,
        browser_id: &str,
        bounds: Option<PreviewBounds>,
        reload: bool,
        presentation: PreviewPresentation,
    ) -> Result<(), String> {
        let mut live = self.live.lock().await;
        let entry = live
            .get_mut(browser_id)
            .filter(|entry| entry.request.session_id == session_id)
            .ok_or("此会话的页面预览已关闭")?;
        if !entry.scope.native {
            return Err("该预览不支持实时交互".into());
        }
        let show = bounds.is_some();
        let page = match &entry.source {
            PreviewSource::Tool => {
                let project = entry.scope.working_directory.clone();
                drop(live);
                browser
                    .sync_native_preview(
                        app,
                        &project,
                        session_id,
                        browser_id,
                        bounds,
                        reload,
                        presentation,
                    )
                    .await?;
                if show {
                    if let Some(entry) = self
                        .live
                        .lock()
                        .await
                        .get_mut(browser_id)
                        .filter(|entry| entry.request.session_id == session_id)
                    {
                        entry.last_used = Instant::now();
                    }
                }
                return Ok(());
            }
            PreviewSource::Delivery { _server: server } => {
                super::agent_preview_guest::PreviewPage::Delivery(server.url.clone())
            }
            PreviewSource::Link(url) => super::agent_preview_guest::PreviewPage::Link {
                session_id: session_id.to_owned(),
                url: url.clone(),
            },
        };
        entry.view.get_or_insert_with(|| NativePreviewLease {
            app: app.clone(),
            browser_id: browser_id.to_owned(),
        });
        let (result, done) = tokio::sync::oneshot::channel();
        let main = app.clone();
        let id = browser_id.to_owned();
        app.run_on_main_thread(move || {
            let _ = result.send(super::agent_preview_guest::sync(
                &main,
                &id,
                page,
                bounds,
                reload,
                presentation,
            ));
        })
        .map_err(|e| e.to_string())?;
        done.await.map_err(|_| "网页预览没有完成同步")??;
        if show {
            entry.last_used = Instant::now();
        }
        Ok(())
    }

    #[cfg(windows)]
    pub(crate) async fn navigate(
        &self,
        app: &AppHandle,
        session_id: &str,
        browser_id: &str,
        action: super::agent_preview_navigation::PreviewNavigation,
    ) -> Result<(), String> {
        use super::{agent_preview_guest, agent_preview_navigation::PreviewNavigation};

        let mut live = self.live.lock().await;
        let entry = live
            .get_mut(browser_id)
            .filter(|entry| {
                entry.request.session_id == session_id
                    && entry.scope.native
                    && !matches!(entry.source, PreviewSource::Delivery { .. })
            })
            .ok_or("此会话的浏览器预览已关闭")?;
        let (result, done) = tokio::sync::oneshot::channel();
        let id = browser_id.to_owned();
        match action {
            PreviewNavigation::History(action) => {
                app.run_on_main_thread(move || {
                    let _ = result.send(agent_preview_guest::navigate(&id, action));
                })
                .map_err(|error| error.to_string())?;
                done.await.map_err(|_| "网页预览没有完成导航")??;
            }
            PreviewNavigation::Address { url } => {
                if !entry.is_link() {
                    return Err("只能在用户打开的浏览器标签中输入网址".into());
                }
                let address = agent_preview_guest::link_url(&url)?;
                if entry.view.is_some() {
                    let target = address.clone();
                    app.run_on_main_thread(move || {
                        let _ = result.send(agent_preview_guest::navigate_link(&id, target));
                    })
                    .map_err(|error| error.to_string())?;
                    done.await.map_err(|_| "网页预览没有完成导航")??;
                }
                if let AgentPreviewTarget::Browser { url, .. } = &mut entry.request.target {
                    *url = address.to_string();
                }
                entry.source = PreviewSource::Link(address);
            }
        }
        entry.last_used = Instant::now();
        Ok(())
    }

    pub(crate) async fn rendered(&self, receipt_id: &str) -> Option<AgentPreviewRequest> {
        self.live
            .lock()
            .await
            .values()
            .find(|entry| !entry.is_link() && entry.receipt_id == receipt_id)
            .map(|entry| entry.request.clone())
    }

    pub(crate) async fn frame_scope(
        &self,
        session_id: &str,
        browser_id: &str,
    ) -> Result<Option<FrameScope>, String> {
        let mut live = self.live.lock().await;
        let Some(entry) = live.get_mut(browser_id) else {
            return Ok(None);
        };
        if entry.request.session_id != session_id {
            return Err("浏览器预览不属于此会话".into());
        }
        entry.last_used = Instant::now();
        Ok(Some(entry.scope.clone()))
    }

    pub(crate) async fn forget(&self, browser_id: &str) -> Option<String> {
        self.live
            .lock()
            .await
            .remove(browser_id)
            .map(|entry| entry.request.session_id)
    }

    pub(crate) async fn close(
        &self,
        browser: &BrowserTools,
        session_id: &str,
        browser_id: &str,
    ) -> Result<(), String> {
        let _publishing = self.publishing.lock().await;
        let entry = {
            let mut live = self.live.lock().await;
            if live
                .get(browser_id)
                .is_some_and(|entry| entry.request.session_id != session_id)
            {
                return Err("浏览器预览不属于此会话".into());
            }
            live.remove(browser_id)
        };
        if let Some(entry) = entry {
            if entry.uses_browser_tool() {
                close_browser(browser, &entry.scope.working_directory, browser_id).await;
            }
        }
        Ok(())
    }

    pub(super) async fn shutdown(&self) {
        let _publishing = self.publishing.lock().await;
        self.live.lock().await.clear();
    }
}

async fn close_browser(browser: &BrowserTools, owner: &Path, id: &str) {
    let (_keep_open, cancel) = watch::channel(false);
    let _ = browser
        .execute_output(owner, "browser_close", &json!({"browser_id":id}), cancel)
        .await;
}

#[derive(Clone)]
struct WebRoot {
    directory: PathBuf,
    token: String,
    host: String,
    active: Arc<AtomicBool>,
}

impl PreviewServer {
    async fn start(directory: PathBuf, entry: &str) -> Result<Self, String> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "无法启动本地网页预览")?;
        let host = listener
            .local_addr()
            .map_err(|_| "无法定位网页预览地址")?
            .to_string();
        let token = Uuid::new_v4().simple().to_string();
        let mut url = Url::parse(&format!("http://{host}/")).map_err(|_| "网页预览地址无效")?;
        url.path_segments_mut()
            .map_err(|_| "网页预览地址无效")?
            .pop_if_empty()
            .extend([TOKEN_ROUTE, &token, entry]);
        let active = Arc::new(AtomicBool::new(true));
        let router = Router::new()
            .route("/*path", get(asset))
            .with_state(WebRoot {
                directory,
                token,
                host,
                active: active.clone(),
            });
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok(Self {
            url: url.into(),
            active,
            task,
        })
    }
}

async fn asset(
    State(root): State<WebRoot>,
    UrlPath(request): UrlPath<String>,
    headers: HeaderMap,
) -> Response {
    if !root.active.load(Ordering::Acquire)
        || headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            != Some(root.host.as_str())
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let prefix = format!("{TOKEN_ROUTE}/{}/", root.token);
    let bootstrapped = request.strip_prefix(&prefix);
    // Cookies are shared across ports of 127.0.0.1. Give each preview its own
    // name so another retained preview cannot replace its root-asset lease.
    let cookie_name = format!("{COOKIE}_{}", root.token);
    let has_cookie = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|cookies| {
            cookies.split(';').map(str::trim).any(|cookie| {
                cookie.split_once('=') == Some((cookie_name.as_str(), root.token.as_str()))
            })
        });
    let path = if let Some(path) = bootstrapped {
        path
    } else if has_cookie {
        &request
    } else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !valid_asset_path(path) || asset_mime(Path::new(path)).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = path.to_owned();
    let scoped = tokio::task::spawn_blocking(move || {
        agent_files::read_canonical_scoped_file(&root.directory, &path)
    })
    .await;
    let Ok(Ok((relative, body, _))) = scoped else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !root.active.load(Ordering::Acquire) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(mime) = asset_mime(&relative) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !relative
        .to_str()
        .is_some_and(|value| valid_asset_path(&value.replace('\\', "/")))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut response = ([(header::CONTENT_TYPE, mime)], body).into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response_headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response_headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response_headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(
        "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ));
    response_headers.insert(header::HeaderName::from_static("permissions-policy"), HeaderValue::from_static(
        "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), clipboard-read=(), clipboard-write=(), fullscreen=()",
    ));
    if bootstrapped.is_some() {
        if let Ok(cookie) = HeaderValue::from_str(&format!(
            "{cookie_name}={}; Path=/; HttpOnly; SameSite=Strict",
            root.token
        )) {
            response_headers.insert(header::SET_COOKIE, cookie);
        }
    }
    response
}

fn valid_asset_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|name| !name.is_empty() && !name.starts_with('.'))
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn is_html(path: &Path) -> bool {
    asset_mime(path) == Some("text/html; charset=utf-8")
}

fn asset_mime(path: &Path) -> Option<&'static str> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "html" | "htm" => "text/html; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "js" | "mjs" => "text/javascript; charset=utf-8",
            "json" => "application/json",
            "webmanifest" => "application/manifest+json",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "ico" => "image/x-icon",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "ttf" => "font/ttf",
            "wasm" => "application/wasm",
            "mp3" => "audio/mpeg",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            _ => return None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn delivery_source_retains_server_until_dropped() {
        let temp = tempfile::tempdir().unwrap();
        let server = PreviewServer::start(temp.path().to_owned(), "index.html")
            .await
            .unwrap();
        let active = server.active.clone();
        let source = PreviewSource::Delivery { _server: server };
        assert!(active.load(Ordering::Acquire));
        drop(source);
        assert!(!active.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn serves_delivered_assets_only_with_owned_capability() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().canonicalize().unwrap();
        std::fs::write(
            directory.join("首页.html"),
            "<html><script src='/app.js'></script></html>",
        )
        .unwrap();
        std::fs::write(directory.join("app.js"), "window.live = true;").unwrap();
        std::fs::write(directory.join(".private.json"), "secret").unwrap();
        let server = PreviewServer::start(directory, "首页.html").await.unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let home = client
            .get(&server.url)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let cookie = home.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        assert!(home.text().await.unwrap().contains("/app.js"));
        let origin = Url::parse(&server.url)
            .unwrap()
            .origin()
            .ascii_serialization();
        let javascript = format!("{origin}/app.js");
        assert_eq!(
            client.get(&javascript).send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        let asset = client
            .get(&javascript)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(
            asset.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(asset.text().await.unwrap(), "window.live = true;");
        for denied in [
            ".private.json",
            "nested%2F%2e%2e%2Fapp.js",
            "app.js%3Asecret",
            "nested%5Capp.js",
        ] {
            assert_eq!(
                client
                    .get(format!("{origin}/{denied}"))
                    .header(header::COOKIE, &cookie)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND,
                "{denied}"
            );
        }
        assert_eq!(
            client
                .get(javascript)
                .header(header::COOKIE, cookie)
                .header(header::HOST, "untrusted.example")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    #[ignore = "requires a local Chromium-family browser"]
    async fn published_page_runs_javascript_and_yields_a_session_owned_frame() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        std::fs::write(project.join("index.html"), "<title>Harness delivery</title><main id='result'></main><script src='/script.js'></script>").unwrap();
        std::fs::write(
            project.join("script.js"),
            "document.querySelector('#result').textContent = 'live Harness JS';",
        )
        .unwrap();
        let preview = HarnessPreview::default();
        let browser = BrowserTools::default();
        let request = preview
            .publish(
                &browser,
                "lc:worker",
                project,
                project,
                "dsh:worker:1:0",
                "index.html",
            )
            .await
            .unwrap();
        assert_eq!(
            preview.rendered("dsh:worker:1:0").await,
            Some(request.clone())
        );
        let AgentPreviewTarget::Browser { browser_id, .. } = request.target else {
            panic!("expected live browser")
        };
        assert!(preview.frame_scope("lc:other", &browser_id).await.is_err());
        let scope = preview
            .frame_scope("lc:worker", &browser_id)
            .await
            .unwrap()
            .unwrap();
        let (_keep_open, cancel) = watch::channel(false);
        let snapshot = browser
            .execute_output(
                &scope.working_directory,
                "browser_snapshot",
                &json!({"browser_id":browser_id}),
                cancel,
            )
            .await
            .unwrap();
        assert!(snapshot.text.contains("live Harness JS"));
        let frame = browser
            .preview_frame(&scope.working_directory, &browser_id)
            .await
            .unwrap();
        assert!(frame.starts_with("data:image/png;base64,"));
        assert!(preview
            .close(&browser, "lc:other", &browser_id)
            .await
            .is_err());
        preview
            .close(&browser, "lc:worker", &browser_id)
            .await
            .unwrap();
        assert!(browser
            .preview_frame(&scope.working_directory, &browser_id)
            .await
            .is_err());
        preview.shutdown().await;
        browser.shutdown().await;
        assert!(preview.rendered("dsh:worker:1:0").await.is_none());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn published_native_page_owns_its_loopback_origin_until_closed() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path();
        std::fs::write(project.join("index.html"), "<main>Live delivery</main>").unwrap();
        let preview = HarnessPreview::default();
        let browser = BrowserTools::default();
        let request = preview
            .publish(
                &browser,
                "lc:worker",
                project,
                project,
                "dsh:worker:1:0",
                "index.html",
            )
            .await
            .unwrap();
        let AgentPreviewTarget::Browser {
            browser_id, url, ..
        } = request.target
        else {
            panic!("expected live browser");
        };
        let scope = preview
            .frame_scope("lc:worker", &browser_id)
            .await
            .unwrap()
            .unwrap();
        assert!(scope.native);
        assert!(preview.frame_scope("lc:other", &browser_id).await.is_err());
        assert!(preview
            .close(&browser, "lc:other", &browser_id)
            .await
            .is_err());
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let page = client
            .get(&url)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert!(page.headers()["permissions-policy"]
            .to_str()
            .unwrap()
            .contains("camera=()"));
        assert_eq!(page.text().await.unwrap(), "<main>Live delivery</main>");
        preview
            .close(&browser, "lc:worker", &browser_id)
            .await
            .unwrap();
        assert!(preview.rendered("dsh:worker:1:0").await.is_none());
        assert!(preview
            .frame_scope("lc:worker", &browser_id)
            .await
            .unwrap()
            .is_none());
    }
}
