//! Localized macOS application menu. Native roles own their shortcuts/actions.

mod texts;

use tauri::{
    menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID},
    AppHandle, Runtime,
};

use texts::NativeMenuTexts;

// Keep the builder type-checked by Windows/Linux unit-test builds, without
// installing an application menu or changing either platform's menu behavior.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_menu<R: Runtime>(app: &AppHandle<R>, language: &str) -> tauri::Result<Menu<R>> {
    let texts = NativeMenuTexts::for_language(language);
    let package = app.package_info();
    let about_metadata = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let about = texts.about.replace("{app}", &package.name);
    let hide = texts.hide.replace("{app}", &package.name);
    let quit = texts.quit.replace("{app}", &package.name);

    // Match Tauri's default macOS menu structure. Predefined items preserve
    // AppKit responders, editing shortcuts, close handling and the quit path.
    let app_menu = Submenu::with_items(
        app,
        &package.name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&about), Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(texts.services))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&hide))?,
            &PredefinedMenuItem::hide_others(app, Some(texts.hide_others))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&quit))?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        texts.file,
        true,
        &[&PredefinedMenuItem::close_window(
            app,
            Some(texts.close_window),
        )?],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        texts.edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(texts.undo))?,
            &PredefinedMenuItem::redo(app, Some(texts.redo))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(texts.cut))?,
            &PredefinedMenuItem::copy(app, Some(texts.copy))?,
            &PredefinedMenuItem::paste(app, Some(texts.paste))?,
            &PredefinedMenuItem::select_all(app, Some(texts.select_all))?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        texts.view,
        true,
        &[&PredefinedMenuItem::fullscreen(
            app,
            Some(texts.fullscreen),
        )?],
    )?;
    // These IDs let Tauri register NSApplication's Window and Help menus after
    // every replacement, retaining the window list and native Help search.
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        texts.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(texts.minimize))?,
            &PredefinedMenuItem::maximize(app, Some(texts.zoom))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(texts.close_window))?,
        ],
    )?;
    let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, texts.help, true, &[])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

/// Read the latest persisted preference on the main thread so queued updates
/// cannot reinstall an older language after a newer settings save.
#[cfg(target_os = "macos")]
pub(crate) fn refresh<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let settings = crate::settings::get_settings();
        let locale = sys_locale::get_locale();
        let language = texts::resolve_language(settings.language.as_deref(), locale.as_deref());
        if let Err(error) = build_menu(&handle, language).and_then(|menu| handle.set_menu(menu)) {
            // A menu failure must not turn a successful settings write into a
            // misleading save failure or prevent the application from opening.
            log::warn!("Failed to install localized macOS application menu: {error}");
        }
    })
}
