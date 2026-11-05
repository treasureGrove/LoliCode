//! Retained Windows child webviews for workspace previews and clicked links.
//!
//! Wry owns the guest directly. It never receives Tauri's initialization
//! scripts, invoke key, app protocols, or IPC handlers.

use super::{
    agent_preview_navigation::{self, NavigationWatch, PreviewHistoryAction},
    harness_preview::{PreviewBounds, PreviewPresentation},
};
use raw_window_handle::{
    HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::HashMap,
    net::SocketAddr,
    num::NonZeroIsize,
    path::{Path, PathBuf},
    ptr,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tempfile::TempDir;
use tokio::sync::{mpsc, oneshot};
use url::{Origin, Url};
use webview2_com::{
    take_pwstr, BasicAuthenticationRequestedEventHandler,
    CallDevToolsProtocolMethodCompletedHandler, ClientCertificateRequestedEventHandler,
    CoTaskMemPWSTR, DevToolsProtocolEventReceivedEventHandler,
    LaunchingExternalUriSchemeEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_10, ICoreWebView2_18, ICoreWebView2_5,
        COREWEBVIEW2_PERMISSION_STATE_DENY,
    },
    NavigationStartingEventHandler, PermissionRequestedEventHandler,
};
use windows_core::Interface;
use windows_sys::Win32::{
    Foundation::{GetLastError, SetLastError, HWND, LPARAM, LRESULT, WPARAM},
    UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
    UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetParent, SetWindowPos, ShowWindow, HWND_TOP,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, WM_DESTROY,
        WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_POPUP,
    },
};
use wry::{
    dpi, NewWindowResponse, Rect, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows,
    WebViewExtWindows,
};

struct Guest {
    navigation: Option<NavigationWatch>,
    // Drop the WebView before its immediate native parent.
    view: WebView,
    container: GuestContainer,
    parent: usize,
    url: Url,
    bounds: PhysicalBounds,
    slot: Option<u8>,
    presentation_revision: u64,
    is_tool: bool,
    profile: Option<ToolProfile>,
}

struct ToolProfile {
    parent: PathBuf,
    directory: Option<TempDir>,
}

impl ToolProfile {
    fn path(&self) -> &Path {
        self.directory.as_ref().expect("live tool profile").path()
    }

    fn close(mut self) {
        if let Some(directory) = self.directory.take() {
            remove_tool_profile(&self.parent, directory);
        }
    }
}

impl Drop for ToolProfile {
    fn drop(&mut self) {
        if let Some(directory) = self.directory.take() {
            let parent = self.parent.clone();
            tauri::async_runtime::spawn_blocking(move || remove_tool_profile(&parent, directory));
        }
    }
}

fn remove_tool_profile(parent: &Path, directory: TempDir) {
    let path = directory.path().to_owned();
    let is_owned = || {
        path.canonicalize().is_ok_and(|target| {
            target.parent() == Some(parent) && target.file_name() == path.file_name()
        })
    };
    if !is_owned() {
        // Do not follow a replaced profile directory outside the owned root.
        let _ = directory.keep();
        return;
    }
    if directory.close().is_ok() {
        return;
    }
    // Closing a controller releases browser-process handles asynchronously.
    // Keep this retry off the UI apartment and bounded on shutdown.
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(100));
        if !is_owned() || std::fs::remove_dir_all(&path).is_ok() {
            return;
        }
    }
    log::debug!("Windows preview guest: tool profile was still busy during cleanup");
}

#[derive(Clone, Copy, PartialEq)]
struct PhysicalBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl PhysicalBounds {
    fn viewport(self) -> Rect {
        Rect {
            position: dpi::PhysicalPosition::new(0, 0).into(),
            size: dpi::PhysicalSize::new(self.width, self.height).into(),
        }
    }
}

struct GuestContainer(HWND);

impl GuestContainer {
    fn create(parent: HWND, bounds: PhysicalBounds) -> Result<Self, String> {
        // A plain system-class child isolates Wry's subclass cleanup from the
        // main Tauri HWND. Wry removes a parent subclass when any view drops.
        let class = [
            b'S' as u16,
            b'T' as u16,
            b'A' as u16,
            b'T' as u16,
            b'I' as u16,
            b'C' as u16,
            0,
        ];
        let handle = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                ptr::null(),
                (if parent.is_null() { WS_POPUP } else { WS_CHILD })
                    | WS_CLIPCHILDREN
                    | WS_CLIPSIBLINGS,
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
                parent,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if handle.is_null() {
            return Err(guest_error(std::io::Error::last_os_error()));
        }
        Ok(Self(handle))
    }

    fn resize(&self, bounds: PhysicalBounds) -> Result<(), String> {
        let changed = unsafe {
            SetWindowPos(
                self.0,
                ptr::null_mut(),
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
        };
        if changed == 0 {
            return Err(guest_error(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    fn show(&self) -> Result<(), String> {
        let shown = unsafe {
            SetWindowPos(
                self.0,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
        if shown == 0 {
            return Err(guest_error(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    fn hide(&self) {
        unsafe {
            ShowWindow(self.0, SW_HIDE);
        }
    }

    fn reparent(&self, parent: HWND) -> Result<(), String> {
        unsafe {
            SetLastError(0);
            let previous = SetParent(self.0, parent);
            if previous.is_null() && GetLastError() != 0 {
                return Err(guest_error(std::io::Error::last_os_error()));
            }
        }
        Ok(())
    }
}

impl HasWindowHandle for GuestContainer {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let handle = NonZeroIsize::new(self.0 as isize).ok_or(HandleError::Unavailable)?;
        // The HWND is owned by self and lives for the lifetime of this borrow.
        Ok(unsafe {
            WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(handle)))
        })
    }
}

impl Drop for GuestContainer {
    fn drop(&mut self) {
        unsafe {
            DestroyWindow(self.0);
        }
    }
}

thread_local! {
    // WebView2 controllers are apartment-affine. Every caller dispatches here
    // through the application's main thread.
    static GUESTS: RefCell<HashMap<String, Guest>> = RefCell::new(HashMap::new());
    static SLOT_REVISIONS: RefCell<[u64; 2]> = const { RefCell::new([0; 2]) };
    static HIDDEN_REVISIONS: RefCell<HashMap<String, [u64; 2]>> = RefCell::new(HashMap::new());
    static TOOL_HOST: RefCell<Option<GuestContainer>> = const { RefCell::new(None) };
}

fn tool_host() -> Result<HWND, String> {
    TOOL_HOST.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some(host) = slot.as_ref() {
            return Ok(host.0);
        }
        let host = GuestContainer::create(
            ptr::null_mut(),
            PhysicalBounds {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            },
        )?;
        let hwnd = host.0;
        *slot = Some(host);
        Ok(hwnd)
    })
}

unsafe extern "system" fn keep_tool_guests(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    _data: usize,
) -> LRESULT {
    if message == WM_DESTROY {
        let _ = RemoveWindowSubclass(window, Some(keep_tool_guests), id);
        if let Ok(host) = tool_host() {
            GUESTS.with(|guests| {
                for guest in guests.borrow_mut().values_mut() {
                    if guest.is_tool && guest.parent == window as usize {
                        let _ = guest.hide();
                        if guest.container.reparent(host).is_ok() {
                            guest.parent = host as usize;
                        }
                    }
                }
            });
        }
    }
    DefSubclassProc(window, message, wparam, lparam)
}

pub(super) enum PreviewPage {
    Delivery(String),
    Link { session_id: String, url: Url },
}

pub(super) fn link_url(value: &str) -> Result<Url, String> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("网页地址无效".into());
    }
    let url = Url::parse(value).map_err(|_| "网页地址无效")?;
    let host = url.host_str().unwrap_or_default().trim_end_matches('.');
    if !matches!(url.scheme(), "http" | "https")
        || host.is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || matches!(
            host,
            "tauri.localhost" | "asset.localhost" | "ipc.localhost"
        )
    {
        return Err("右栏仅支持普通 HTTP/HTTPS 网页".into());
    }
    Ok(url)
}

pub(super) fn sync(
    app: &AppHandle,
    id: &str,
    page: PreviewPage,
    bounds: Option<PreviewBounds>,
    reload: bool,
    presentation: PreviewPresentation,
) -> Result<(), String> {
    let Some(bounds) = bounds else {
        return hide_presentation(id, presentation);
    };
    if !claim_slot(id, presentation)? {
        return Ok(());
    }
    let (url, link_session) = match page {
        PreviewPage::Delivery(value) => {
            let url = Url::parse(&value).map_err(|_| "网页预览地址无效")?;
            if !is_preview_origin(&url) {
                return Err("网页预览仅接受已注册的本地地址".into());
            }
            (url, None)
        }
        PreviewPage::Link { session_id, url } => (url, Some(session_id)),
    };
    let main = app.get_webview_window("main").ok_or("找不到主窗口")?;
    let hwnd = main.hwnd().map_err(|_| "无法读取网页预览容器")?.0;
    let parent = hwnd as usize;
    let rect = guest_bounds(bounds, main.scale_factor().map_err(guest_error)?)?;

    // A lightweight-mode teardown can destroy and recreate the main HWND.
    // Never reuse its detached child controllers for the replacement window.
    let current = GUESTS.with(|guests| {
        let mut guests = guests.borrow_mut();
        guests.retain(|_, guest| guest.is_tool || guest.parent == parent);
        guests.remove(id)
    });
    let guest = match current {
        Some(guest) if guest.url == url => guest,
        _ => Guest::open(
            app,
            hwnd,
            url,
            rect,
            link_session.as_deref().map(|session_id| (session_id, id)),
        )?,
    };
    present_guest(id, guest, rect, reload, presentation)
}

fn claim_slot(id: &str, presentation: PreviewPresentation) -> Result<bool, String> {
    // Renderer IPC can complete out of order when a tab or workbench changes.
    // A delayed resize must not replace a newer tab in either slot.
    if was_hidden(id, presentation) {
        return Ok(false);
    }
    let current = SLOT_REVISIONS.with(|slots| {
        let mut slots = slots.borrow_mut();
        let revision = &mut slots[usize::from(presentation.slot)];
        if *revision >= presentation.revision {
            return false;
        }
        *revision = presentation.revision;
        true
    });
    if !current {
        return Ok(false);
    }
    GUESTS.with(|guests| {
        let mut guests = guests.borrow_mut();
        if guests
            .get(id)
            .is_some_and(|guest| guest.presentation_revision >= presentation.revision)
        {
            return Ok(false);
        }
        for (other, guest) in guests.iter_mut() {
            if other != id && guest.slot == Some(presentation.slot) {
                guest.hide()?;
            }
        }
        Ok(true)
    })
}

fn was_hidden(id: &str, presentation: PreviewPresentation) -> bool {
    HIDDEN_REVISIONS.with(|hidden| {
        hidden
            .borrow()
            .get(id)
            .is_some_and(|slots| slots[usize::from(presentation.slot)] >= presentation.revision)
    })
}

fn hide_presentation(id: &str, presentation: PreviewPresentation) -> Result<(), String> {
    HIDDEN_REVISIONS.with(|hidden| {
        let mut hidden = hidden.borrow_mut();
        let slots = hidden.entry(id.to_owned()).or_default();
        let revision = &mut slots[usize::from(presentation.slot)];
        *revision = (*revision).max(presentation.revision);
    });
    GUESTS.with(|guests| {
        if let Some(guest) = guests.borrow_mut().get_mut(id) {
            if guest.slot == Some(presentation.slot)
                && guest.presentation_revision < presentation.revision
            {
                guest.hide()?;
            }
        }
        Ok(())
    })
}

fn present_guest(
    id: &str,
    mut guest: Guest,
    bounds: PhysicalBounds,
    reload: bool,
    presentation: PreviewPresentation,
) -> Result<(), String> {
    // Creating a WebView can pump Windows messages. Recheck after opening it.
    let slot_is_current = SLOT_REVISIONS
        .with(|slots| slots.borrow()[usize::from(presentation.slot)] == presentation.revision);
    let guest_is_current = GUESTS.with(|guests| {
        guests
            .borrow()
            .get(id)
            .is_none_or(|existing| existing.presentation_revision < presentation.revision)
    });
    if slot_is_current && guest_is_current && !was_hidden(id, presentation) {
        let result = guest.show(bounds, reload, presentation);
        GUESTS.with(|guests| guests.borrow_mut().insert(id.to_owned(), guest));
        return result;
    }
    if guest.slot == Some(presentation.slot) {
        guest.hide()?;
    }
    GUESTS.with(|guests| {
        guests.borrow_mut().entry(id.to_owned()).or_insert(guest);
    });
    Ok(())
}

pub(super) fn sync_tool(
    app: &AppHandle,
    session_id: &str,
    id: &str,
    bounds: Option<PreviewBounds>,
    reload: bool,
    presentation: PreviewPresentation,
) -> Result<(), String> {
    let Some(bounds) = bounds else {
        return hide_presentation(id, presentation);
    };
    if !claim_slot(id, presentation)? {
        return Ok(());
    }
    let mut guest = GUESTS
        .with(|guests| guests.borrow_mut().remove(id))
        .ok_or("浏览器会话已关闭")?;
    let prepare = (|| {
        let main = app.get_webview_window("main").ok_or("找不到主窗口")?;
        let hwnd = main.hwnd().map_err(guest_error)?.0;
        let rect = guest_bounds(bounds, main.scale_factor().map_err(guest_error)?)?;
        if guest.parent != hwnd as usize {
            let installed = unsafe { SetWindowSubclass(hwnd, Some(keep_tool_guests), 1, 0) };
            if installed == 0 {
                return Err(guest_error(std::io::Error::last_os_error()));
            }
            guest.container.reparent(hwnd)?;
            guest.parent = hwnd as usize;
        }
        if guest.navigation.is_none() {
            let core = unsafe { guest.view.controller().CoreWebView2() }.map_err(guest_error)?;
            guest.navigation = Some(agent_preview_navigation::attach(
                app, session_id, id, &core,
            )?);
        }
        Ok(rect)
    })();
    match prepare {
        Ok(rect) => present_guest(id, guest, rect, reload, presentation),
        Err(cause) => {
            GUESTS.with(|guests| guests.borrow_mut().insert(id.to_owned(), guest));
            Err(cause)
        }
    }
}

pub(super) fn navigate(id: &str, action: PreviewHistoryAction) -> Result<(), String> {
    GUESTS.with(|guests| {
        let guests = guests.borrow();
        let guest = guests
            .get(id)
            .filter(|guest| guest.navigation.is_some())
            .ok_or("浏览器会话已关闭")?;
        let core = unsafe { guest.view.controller().CoreWebView2() }.map_err(guest_error)?;
        // Release the registry before COM dispatches any navigation events.
        drop(guests);
        agent_preview_navigation::navigate(&core, action)
    })
}

pub(super) fn navigate_link(id: &str, url: Url) -> Result<(), String> {
    let mut guest = GUESTS
        .with(|guests| {
            let mut guests = guests.borrow_mut();
            if guests
                .get(id)
                .is_some_and(|guest| !guest.is_tool && guest.navigation.is_some())
            {
                guests.remove(id)
            } else {
                None
            }
        })
        .ok_or("浏览器会话已关闭")?;
    // Keep the controller and its history while updating the lease's address.
    let result = guest.view.load_url(url.as_str()).map_err(guest_error);
    if result.is_ok() {
        guest.url = url;
    }
    GUESTS.with(|guests| guests.borrow_mut().insert(id.to_owned(), guest));
    result
}

pub(crate) fn close(id: &str) {
    drop(close_guest(id));
}

fn close_guest(id: &str) -> Option<ToolProfile> {
    HIDDEN_REVISIONS.with(|hidden| hidden.borrow_mut().remove(id));
    let mut guest = GUESTS.with(|guests| guests.borrow_mut().remove(id))?;
    let profile = guest.profile.take();
    drop(guest);
    profile
}

pub(super) struct ToolGuest {
    app: AppHandle,
    id: String,
    pub(super) events: mpsc::Receiver<Value>,
}

impl ToolGuest {
    pub(super) async fn open(
        app: AppHandle,
        id: String,
        url: Url,
        proxy: SocketAddr,
        width: u64,
        height: u64,
    ) -> Result<Self, String> {
        let profiles = crate::config::get_app_config_dir().join("agent/browser-profiles");
        std::fs::create_dir_all(&profiles).map_err(guest_error)?;
        let parent = profiles.canonicalize().map_err(guest_error)?;
        let directory = tempfile::Builder::new()
            .prefix("tool-")
            .tempdir_in(profiles)
            .map_err(guest_error)?;
        let profile = ToolProfile {
            parent,
            directory: Some(directory),
        };
        let (event_sender, events) = mpsc::channel(128);
        let (result, done) = oneshot::channel();
        let guest_id = id.clone();
        app.run_on_main_thread(move || {
            let opened: Result<(), String> = (|| {
                let viewport = PhysicalBounds {
                    x: 0,
                    y: 0,
                    width: width as i32,
                    height: height as i32,
                };
                let guest = Guest::build(tool_host()?, url, viewport, Some((profile, proxy)))?;
                guest.listen_for_network(event_sender)?;
                GUESTS.with(|guests| guests.borrow_mut().insert(guest_id.clone(), guest));
                Ok(())
            })();
            if result.send(opened).is_err() {
                close(&guest_id);
            }
        })
        .map_err(guest_error)?;
        done.await.map_err(guest_error)??;
        Ok(Self { app, id, events })
    }

    pub(super) async fn cdp(&self, method: &str, params: Value) -> Result<Value, String> {
        let (result, done) = oneshot::channel();
        let id = self.id.clone();
        let method = method.to_owned();
        self.app
            .run_on_main_thread(move || {
                let reply = GUESTS.with(|guests| {
                    let guests = guests.borrow();
                    let guest = guests.get(&id).ok_or("浏览器会话已关闭")?;
                    guest.call_devtools(&method, params)
                });
                let _ = result.send(reply);
            })
            .map_err(guest_error)?;
        done.await
            .map_err(guest_error)??
            .await
            .map_err(guest_error)?
    }

    pub(super) async fn close(&self) {
        let id = self.id.clone();
        let (result, done) = oneshot::channel();
        if self
            .app
            .run_on_main_thread(move || {
                let _ = result.send(close_guest(&id));
            })
            .is_ok()
        {
            if let Ok(Ok(Some(profile))) = tokio::time::timeout(Duration::from_secs(2), done).await
            {
                let _ = tokio::task::spawn_blocking(move || profile.close()).await;
            }
        }
    }
}

impl Drop for ToolGuest {
    fn drop(&mut self) {
        let id = self.id.clone();
        let _ = self.app.run_on_main_thread(move || close(&id));
    }
}

impl Guest {
    fn open(
        app: &AppHandle,
        parent: HWND,
        url: Url,
        bounds: PhysicalBounds,
        link: Option<(&str, &str)>,
    ) -> Result<Self, String> {
        let directory = app
            .path()
            .app_cache_dir()
            .map_err(guest_error)?
            .join(if link.is_some() {
                "agent-link-preview-webview"
            } else {
                "agent-preview-webview"
            });
        let mut guest = Self::build_with_context(
            parent,
            url,
            bounds,
            WebContext::new(Some(directory)),
            None,
            link.is_some(),
        )?;
        if let Some((session_id, id)) = link {
            let core = unsafe { guest.view.controller().CoreWebView2() }.map_err(guest_error)?;
            guest.navigation = Some(agent_preview_navigation::attach(
                app, session_id, id, &core,
            )?);
        }
        guest
            .view
            .load_url(guest.url.as_str())
            .map_err(guest_error)?;
        Ok(guest)
    }

    fn build(
        parent: HWND,
        url: Url,
        bounds: PhysicalBounds,
        tool: Option<(ToolProfile, SocketAddr)>,
    ) -> Result<Self, String> {
        let directory = tool.as_ref().map(|(profile, _)| profile.path().to_owned());
        Self::build_with_context(parent, url, bounds, WebContext::new(directory), tool, false)
    }

    fn build_with_context(
        parent: HWND,
        url: Url,
        bounds: PhysicalBounds,
        mut context: WebContext,
        tool: Option<(ToolProfile, SocketAddr)>,
        is_link: bool,
    ) -> Result<Self, String> {
        let navigation_origin = url.origin();
        let allow_navigation = move |target: &str| {
            if is_link {
                link_url(target).is_ok()
            } else {
                allows_navigation(target, &navigation_origin)
            }
        };
        let allow_frame_navigation = allow_navigation.clone();
        let container = GuestContainer::create(parent, bounds)?;
        let is_tool = tool.is_some();
        let mut builder = WebViewBuilder::new_with_web_context(&mut context)
            .with_bounds(bounds.viewport())
            // The native container controls presentation. Tool input must
            // still reach the renderer before the sidebar is shown.
            .with_visible(is_tool)
            .with_focused(false)
            .with_incognito(true)
            .with_devtools(false)
            .with_browser_accelerator_keys(false)
            .with_default_context_menus(false)
            .with_download_started_handler(|_, _| false)
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_navigation_handler(move |target| allow_navigation(&target));
        if let Some((_, proxy)) = &tool {
            // A per-tool WebView2 profile permits an exact-origin proxy per page.
            // Chromium must send even loopback HTTP and WebSockets through it.
            builder = builder.with_additional_browser_args(format!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --disable-background-networking --disable-quic --dns-prefetch-disable --force-webrtc-ip-handling-policy=disable_non_proxied_udp --proxy-bypass-list=<-loopback> --proxy-server=http://{proxy}"
            ));
        }
        let view = builder.build_as_child(&container).map_err(guest_error)?;

        // Configure the blank controller before navigating to guest content.
        // Safety: WebView2 calls run on the creating UI apartment, with live
        // interfaces obtained from this Wry controller.
        unsafe {
            let core = view.controller().CoreWebView2().map_err(guest_error)?;
            let settings = core.Settings().map_err(guest_error)?;
            settings
                .SetAreHostObjectsAllowed(false)
                .map_err(guest_error)?;
            settings
                .SetIsWebMessageEnabled(false)
                .map_err(guest_error)?;
            settings
                .SetAreDefaultScriptDialogsEnabled(false)
                .map_err(guest_error)?;
            core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    }
                    Ok(())
                })),
                &mut Default::default(),
            )
            .map_err(guest_error)?;
            if is_tool || is_link {
                isolate_navigation(&core, allow_frame_navigation)?;
            }
        }
        Ok(Self {
            navigation: None,
            view,
            container,
            parent: parent as usize,
            url,
            bounds,
            slot: None,
            presentation_revision: 0,
            is_tool,
            profile: tool.map(|(profile, _)| profile),
        })
    }

    fn call_devtools(
        &self,
        method: &str,
        params: Value,
    ) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
        let (result, done) = oneshot::channel();
        let name = CoTaskMemPWSTR::from(method);
        let args = params.to_string();
        let args = CoTaskMemPWSTR::from(args.as_str());
        unsafe {
            let core = self.view.controller().CoreWebView2().map_err(guest_error)?;
            core.CallDevToolsProtocolMethod(
                *name.as_ref().as_pcwstr(),
                *args.as_ref().as_pcwstr(),
                &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |error, json| {
                        let reply = error
                            .map_err(|error| format!("浏览器操作失败：{error}"))
                            .and_then(|_| {
                                serde_json::from_str(&json).map_err(|_| "浏览器调试响应无效".into())
                            });
                        let _ = result.send(reply);
                        Ok(())
                    },
                )),
            )
            .map_err(guest_error)?;
        }
        Ok(done)
    }

    fn listen_for_network(&self, sender: mpsc::Sender<Value>) -> Result<(), String> {
        unsafe {
            let core = self.view.controller().CoreWebView2().map_err(guest_error)?;
            for method in [
                "Network.requestWillBeSent",
                "Network.responseReceived",
                "Network.responseReceivedExtraInfo",
            ] {
                let name = CoTaskMemPWSTR::from(method);
                let receiver = core
                    .GetDevToolsProtocolEventReceiver(*name.as_ref().as_pcwstr())
                    .map_err(guest_error)?;
                let sender = sender.clone();
                receiver
                    .add_DevToolsProtocolEventReceived(
                        &DevToolsProtocolEventReceivedEventHandler::create(Box::new(
                            move |_, args| {
                                if let Some(args) = args {
                                    let mut text = Default::default();
                                    args.ParameterObjectAsJson(&mut text)?;
                                    if let Ok(params) =
                                        serde_json::from_str::<Value>(&take_pwstr(text))
                                    {
                                        if method == "Network.responseReceivedExtraInfo"
                                            || params["type"] == "Document"
                                        {
                                            let _ = sender.try_send(
                                                json!({ "method": method, "params": params }),
                                            );
                                        }
                                    }
                                }
                                Ok(())
                            },
                        )),
                        &mut Default::default(),
                    )
                    .map_err(guest_error)?;
            }
        }
        Ok(())
    }

    fn set_bounds(&mut self, bounds: PhysicalBounds) -> Result<(), String> {
        if self.bounds != bounds {
            self.container.resize(bounds)?;
            self.view
                .set_bounds(bounds.viewport())
                .map_err(guest_error)?;
            self.bounds = bounds;
        }
        Ok(())
    }

    fn show(
        &mut self,
        bounds: PhysicalBounds,
        reload: bool,
        presentation: PreviewPresentation,
    ) -> Result<(), String> {
        self.set_bounds(bounds)?;
        if reload {
            self.view.reload().map_err(guest_error)?;
        }
        if self.slot.is_none() {
            if !self.is_tool {
                self.view.set_visible(true).map_err(guest_error)?;
            }
            self.container.show()?;
        }
        self.slot = Some(presentation.slot);
        self.presentation_revision = presentation.revision;
        Ok(())
    }

    fn hide(&mut self) -> Result<(), String> {
        if self.slot.take().is_some() {
            self.container.hide();
            if !self.is_tool {
                self.view.set_visible(false).map_err(guest_error)?;
            }
        }
        Ok(())
    }
}

fn allows_navigation(target: &str, origin: &Origin) -> bool {
    Url::parse(target).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
            && &url.origin() == origin
    })
}

fn isolate_navigation(
    core: &ICoreWebView2,
    allows_frame: impl Fn(&str) -> bool + 'static,
) -> Result<(), String> {
    // Suppress native auth prompts and external protocol dispatch in the guest.
    unsafe {
        core.add_FrameNavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut uri = Default::default();
                    args.Uri(&mut uri)?;
                    let target = take_pwstr(uri);
                    if !matches!(target.as_str(), "about:blank" | "about:srcdoc")
                        && !allows_frame(&target)
                    {
                        args.SetCancel(true)?;
                    }
                }
                Ok(())
            })),
            &mut Default::default(),
        )
        .map_err(guest_error)?;
        core.cast::<ICoreWebView2_5>()
            .map_err(guest_error)?
            .add_ClientCertificateRequested(
                &ClientCertificateRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                        args.SetHandled(true)?;
                    }
                    Ok(())
                })),
                &mut Default::default(),
            )
            .map_err(guest_error)?;
        core.cast::<ICoreWebView2_10>()
            .map_err(guest_error)?
            .add_BasicAuthenticationRequested(
                &BasicAuthenticationRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                    }
                    Ok(())
                })),
                &mut Default::default(),
            )
            .map_err(guest_error)?;
        core.cast::<ICoreWebView2_18>()
            .map_err(guest_error)?
            .add_LaunchingExternalUriScheme(
                &LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                    }
                    Ok(())
                })),
                &mut Default::default(),
            )
            .map_err(guest_error)?;
    }
    Ok(())
}

fn is_preview_origin(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn guest_bounds(bounds: PreviewBounds, scale: f64) -> Result<PhysicalBounds, String> {
    let PreviewBounds {
        x,
        y,
        width,
        height,
    } = bounds;
    if ![x, y, width, height]
        .into_iter()
        .all(|v| v.is_finite() && (0.0..=32_768.0).contains(&v))
        || width < 1.0
        || height < 1.0
    {
        return Err("网页预览位置无效".into());
    }
    let pos = dpi::LogicalPosition::new(x, y).to_physical::<i32>(scale);
    let size = dpi::LogicalSize::new(width, height).to_physical::<i32>(scale);
    Ok(PhysicalBounds {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    })
}

fn guest_error(error: impl std::fmt::Display) -> String {
    log::debug!("Windows preview guest: {error}");
    "无法打开内嵌网页预览".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hide_before_open_only_cancels_older_shows_for_that_guest_and_slot() {
        let left = |revision| PreviewPresentation { slot: 0, revision };
        let right = |revision| PreviewPresentation { slot: 1, revision };

        hide_presentation("opening-guest", left(20)).unwrap();
        assert!(!claim_slot("opening-guest", left(19)).unwrap());
        assert!(claim_slot("another-guest", left(19)).unwrap());
        assert!(claim_slot("opening-guest", right(19)).unwrap());
        assert!(claim_slot("opening-guest", left(21)).unwrap());
        close("opening-guest");
        assert!(!was_hidden("opening-guest", left(19)));
    }

    #[test]
    fn guest_accepts_only_plain_localhost_origins_with_a_private_port() {
        assert!(is_preview_origin(
            &Url::parse("http://127.0.0.1:59124/index.html").unwrap()
        ));
        for url in [
            "https://127.0.0.1:59124/index.html",
            "http://127.0.0.1/index.html",
            "http://admin@127.0.0.1:59124/index.html",
            "http://ipc.localhost:59124/index.html",
            "https://example.com/index.html",
            "file:///index.html",
        ] {
            assert!(!is_preview_origin(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn clicked_links_accept_web_addresses_and_reject_local_protocol_bridges() {
        for url in [
            "https://example.com/docs?q=1#usage",
            "http://localhost:5173/",
            "http://127.0.0.1:5173/",
            "http://[::1]:5173/",
        ] {
            assert!(link_url(url).is_ok(), "{url}");
        }
        for url in [
            "//example.com",
            "file:///C:/private.txt",
            "javascript:alert(1)",
            "mailto:user@example.com",
            "https://user:password@example.com",
            "https://example.com/\n",
            "http://tauri.localhost",
            "https://asset.localhost.",
            "http://ipc.localhost",
        ] {
            assert!(link_url(url).is_err(), "{url}");
        }
    }
}
