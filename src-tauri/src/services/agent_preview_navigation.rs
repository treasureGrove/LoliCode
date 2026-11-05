#[derive(serde::Deserialize)]
#[serde(untagged)]
pub(crate) enum PreviewNavigation {
    History(PreviewHistoryAction),
    Address { url: String },
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PreviewHistoryAction {
    Back,
    Forward,
}

#[cfg(windows)]
mod desktop {
    use super::PreviewHistoryAction;
    use serde::Serialize;
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };
    use tauri::{AppHandle, Emitter};
    use webview2_com::{
        take_pwstr, DocumentTitleChangedEventHandler, HistoryChangedEventHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2, NavigationCompletedEventHandler,
        NavigationStartingEventHandler, SourceChangedEventHandler,
    };

    #[derive(Clone, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PageState {
        url: String,
        title: String,
        loading: bool,
        can_go_back: bool,
        can_go_forward: bool,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PageNotice<'a> {
        session_id: &'a str,
        browser_id: &'a str,
        #[serde(flatten)]
        state: &'a PageState,
    }

    struct Observer {
        app: AppHandle,
        session_id: String,
        browser_id: String,
        loading: Cell<Option<u64>>,
        last: RefCell<Option<PageState>>,
    }

    impl Observer {
        fn publish(&self, core: Option<ICoreWebView2>) {
            let Some(core) = core else {
                return;
            };
            let Ok(state) = self.read(&core) else {
                return;
            };
            if self.last.borrow().as_ref() == Some(&state) {
                return;
            }
            let _ = self.app.emit_to(
                "main",
                "agent-browser-preview-state",
                PageNotice {
                    session_id: &self.session_id,
                    browser_id: &self.browser_id,
                    state: &state,
                },
            );
            self.last.replace(Some(state));
        }

        fn read(&self, core: &ICoreWebView2) -> Result<PageState, String> {
            // WebView2 delivers the events on the guest's UI apartment.
            unsafe {
                let mut source = Default::default();
                core.Source(&mut source).map_err(navigation_error)?;
                let url = take_pwstr(source);
                let mut title = Default::default();
                core.DocumentTitle(&mut title).map_err(navigation_error)?;
                let title = take_pwstr(title).chars().take(300).collect();
                let mut can_go_back = Default::default();
                let mut can_go_forward = Default::default();
                core.CanGoBack(&mut can_go_back).map_err(navigation_error)?;
                core.CanGoForward(&mut can_go_forward)
                    .map_err(navigation_error)?;
                Ok(PageState {
                    url,
                    title,
                    loading: self.loading.get().is_some(),
                    can_go_back: can_go_back.as_bool(),
                    can_go_forward: can_go_forward.as_bool(),
                })
            }
        }
    }

    enum PageEvent {
        Source,
        Title,
        History,
        Starting,
        Completed,
    }

    pub(crate) struct NavigationWatch {
        core: ICoreWebView2,
        registrations: Vec<(PageEvent, i64)>,
    }

    impl Drop for NavigationWatch {
        fn drop(&mut self) {
            // The guest owns this watch and drops it on its UI apartment.
            unsafe {
                for (event, token) in self.registrations.drain(..) {
                    let _ = match event {
                        PageEvent::Source => self.core.remove_SourceChanged(token),
                        PageEvent::Title => self.core.remove_DocumentTitleChanged(token),
                        PageEvent::History => self.core.remove_HistoryChanged(token),
                        PageEvent::Starting => self.core.remove_NavigationStarting(token),
                        PageEvent::Completed => self.core.remove_NavigationCompleted(token),
                    };
                }
            }
        }
    }

    pub(crate) fn attach(
        app: &AppHandle,
        session_id: &str,
        browser_id: &str,
        core: &ICoreWebView2,
    ) -> Result<NavigationWatch, String> {
        let observer = Rc::new(Observer {
            app: app.clone(),
            session_id: session_id.to_owned(),
            browser_id: browser_id.to_owned(),
            loading: Cell::new(None),
            last: RefCell::new(None),
        });
        let mut watch = NavigationWatch {
            core: core.clone(),
            registrations: Vec::with_capacity(5),
        };
        // Registration and callbacks use the same UI apartment as the guest.
        unsafe {
            let mut token = 0;
            let source = observer.clone();
            core.add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |core, _| {
                    source.publish(core);
                    Ok(())
                })),
                &mut token,
            )
            .map_err(navigation_error)?;
            watch.registrations.push((PageEvent::Source, token));
            let title = observer.clone();
            core.add_DocumentTitleChanged(
                &DocumentTitleChangedEventHandler::create(Box::new(move |core, _| {
                    title.publish(core);
                    Ok(())
                })),
                &mut token,
            )
            .map_err(navigation_error)?;
            watch.registrations.push((PageEvent::Title, token));
            let history = observer.clone();
            core.add_HistoryChanged(
                &HistoryChangedEventHandler::create(Box::new(move |core, _| {
                    history.publish(core);
                    Ok(())
                })),
                &mut token,
            )
            .map_err(navigation_error)?;
            watch.registrations.push((PageEvent::History, token));
            let starting = observer.clone();
            core.add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |core, args| {
                    if let Some(args) = args {
                        let mut id = 0;
                        args.NavigationId(&mut id)?;
                        starting.loading.set(Some(id));
                    }
                    starting.publish(core);
                    Ok(())
                })),
                &mut token,
            )
            .map_err(navigation_error)?;
            watch.registrations.push((PageEvent::Starting, token));
            let completed = observer.clone();
            core.add_NavigationCompleted(
                &NavigationCompletedEventHandler::create(Box::new(move |core, args| {
                    if let Some(args) = args {
                        let mut id = 0;
                        args.NavigationId(&mut id)?;
                        if completed.loading.get() == Some(id) {
                            completed.loading.set(None);
                        }
                    }
                    completed.publish(core);
                    Ok(())
                })),
                &mut token,
            )
            .map_err(navigation_error)?;
            watch.registrations.push((PageEvent::Completed, token));
        }
        observer.publish(Some(core.clone()));
        Ok(watch)
    }

    pub(crate) fn navigate(
        core: &ICoreWebView2,
        action: PreviewHistoryAction,
    ) -> Result<(), String> {
        // The registry supplies the owned controller on its UI apartment.
        unsafe {
            let mut enabled = Default::default();
            match action {
                PreviewHistoryAction::Back => {
                    core.CanGoBack(&mut enabled).map_err(navigation_error)?;
                    if enabled.as_bool() {
                        core.GoBack().map_err(navigation_error)?;
                    }
                }
                PreviewHistoryAction::Forward => {
                    core.CanGoForward(&mut enabled).map_err(navigation_error)?;
                    if enabled.as_bool() {
                        core.GoForward().map_err(navigation_error)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn navigation_error(error: impl std::fmt::Display) -> String {
        log::debug!("Windows browser preview navigation: {error}");
        "无法操作网页浏览记录".into()
    }
}

#[cfg(windows)]
pub(super) use desktop::{attach, navigate, NavigationWatch};
