//! Pure language selection and text, testable without a native event loop.

/// Keep the fallback order aligned with frontend i18n and the tray. A saved
/// supported AppSettings.language always wins over the system locale.
pub(super) fn resolve_language(saved: Option<&str>, locale: Option<&str>) -> &'static str {
    match saved.map(str::trim) {
        Some("zh") => return "zh",
        Some("zh-TW") => return "zh-TW",
        Some("en") => return "en",
        Some("ja") => return "ja",
        _ => {}
    }
    let locale = locale.unwrap_or_default().to_lowercase();
    if locale.starts_with("zh-tw")
        || locale.starts_with("zh-hk")
        || locale.starts_with("zh-mo")
        || locale.starts_with("zh-hant")
    {
        "zh-TW"
    } else if locale.starts_with("ja") {
        "ja"
    } else if locale.starts_with("en") {
        "en"
    } else {
        "zh"
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct NativeMenuTexts {
    pub file: &'static str,
    pub edit: &'static str,
    pub view: &'static str,
    pub window: &'static str,
    pub help: &'static str,
    pub about: &'static str,
    pub services: &'static str,
    pub hide: &'static str,
    pub hide_others: &'static str,
    pub quit: &'static str,
    pub close_window: &'static str,
    pub undo: &'static str,
    pub redo: &'static str,
    pub cut: &'static str,
    pub copy: &'static str,
    pub paste: &'static str,
    pub select_all: &'static str,
    pub fullscreen: &'static str,
    pub minimize: &'static str,
    pub zoom: &'static str,
}

impl NativeMenuTexts {
    pub fn for_language(language: &str) -> Self {
        match language {
            "en" => Self {
                file: "File",
                edit: "Edit",
                view: "View",
                window: "Window",
                help: "Help",
                about: "About {app}",
                services: "Services",
                hide: "Hide {app}",
                hide_others: "Hide Others",
                quit: "Quit {app}",
                close_window: "Close Window",
                undo: "Undo",
                redo: "Redo",
                cut: "Cut",
                copy: "Copy",
                paste: "Paste",
                select_all: "Select All",
                fullscreen: "Enter Full Screen",
                minimize: "Minimize",
                zoom: "Zoom",
            },
            "zh-TW" => Self {
                file: "檔案",
                edit: "編輯",
                view: "顯示",
                window: "視窗",
                help: "輔助說明",
                about: "關於 {app}",
                services: "服務",
                hide: "隱藏 {app}",
                hide_others: "隱藏其他",
                quit: "結束 {app}",
                close_window: "關閉視窗",
                undo: "還原",
                redo: "重做",
                cut: "剪下",
                copy: "拷貝",
                paste: "貼上",
                select_all: "全選",
                fullscreen: "進入全螢幕",
                minimize: "縮到最小",
                zoom: "縮放",
            },
            "ja" => Self {
                file: "ファイル",
                edit: "編集",
                view: "表示",
                window: "ウインドウ",
                help: "ヘルプ",
                about: "{app}について",
                services: "サービス",
                hide: "{app}を非表示",
                hide_others: "ほかを非表示",
                quit: "{app}を終了",
                close_window: "ウインドウを閉じる",
                undo: "取り消す",
                redo: "やり直す",
                cut: "カット",
                copy: "コピー",
                paste: "ペースト",
                select_all: "すべてを選択",
                fullscreen: "フルスクリーンにする",
                minimize: "ウインドウをしまう",
                zoom: "拡大／縮小",
            },
            _ => Self {
                file: "文件",
                edit: "编辑",
                view: "显示",
                window: "窗口",
                help: "帮助",
                about: "关于 {app}",
                services: "服务",
                hide: "隐藏 {app}",
                hide_others: "隐藏其他",
                quit: "退出 {app}",
                close_window: "关闭窗口",
                undo: "撤销",
                redo: "重做",
                cut: "剪切",
                copy: "拷贝",
                paste: "粘贴",
                select_all: "全选",
                fullscreen: "进入全屏幕",
                minimize: "最小化",
                zoom: "缩放",
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_language_wins_over_every_system_locale() {
        for saved in ["zh", "zh-TW", "en", "ja"] {
            for locale in [
                None,
                Some("zh-CN"),
                Some("zh-TW"),
                Some("en-US"),
                Some("ja-JP"),
            ] {
                assert_eq!(resolve_language(Some(saved), locale), saved);
            }
        }
        assert_eq!(resolve_language(Some(" en "), Some("zh-CN")), "en");
    }

    #[test]
    fn first_run_locale_follows_frontend_and_tray_fallbacks() {
        for locale in ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-HK", "ZH-TW"] {
            assert_eq!(resolve_language(None, Some(locale)), "zh-TW", "{locale}");
        }
        for locale in ["zh", "zh-CN", "zh-SG", "zh-Hans-CN"] {
            assert_eq!(resolve_language(None, Some(locale)), "zh", "{locale}");
        }
        for locale in ["en", "en-US", "en-GB"] {
            assert_eq!(resolve_language(None, Some(locale)), "en", "{locale}");
        }
        for locale in ["ja", "ja-JP"] {
            assert_eq!(resolve_language(None, Some(locale)), "ja", "{locale}");
        }
        for locale in [None, Some(""), Some("fr-FR"), Some("de-DE")] {
            assert_eq!(resolve_language(None, locale), "zh");
        }
    }

    #[test]
    fn invalid_saved_language_falls_back_like_normalized_settings() {
        for saved in [None, Some(""), Some("invalid"), Some("zh-CN")] {
            assert_eq!(resolve_language(saved, Some("ja-JP")), "ja");
            assert_eq!(resolve_language(saved, None), "zh");
        }
        assert_eq!(
            NativeMenuTexts::for_language("invalid"),
            NativeMenuTexts::for_language("zh")
        );
    }

    #[test]
    fn every_supported_language_has_localized_top_level_menus() {
        for (language, expected) in [
            ("zh", ["文件", "编辑", "显示", "窗口", "帮助"]),
            ("zh-TW", ["檔案", "編輯", "顯示", "視窗", "輔助說明"]),
            ("en", ["File", "Edit", "View", "Window", "Help"]),
            ("ja", ["ファイル", "編集", "表示", "ウインドウ", "ヘルプ"]),
        ] {
            let texts = NativeMenuTexts::for_language(language);
            assert_eq!(
                [texts.file, texts.edit, texts.view, texts.window, texts.help],
                expected,
                "{language}"
            );
        }
    }

    #[test]
    fn native_roles_have_text_and_preserve_the_application_name() {
        for language in ["zh", "zh-TW", "en", "ja"] {
            let texts = NativeMenuTexts::for_language(language);
            for text in [
                texts.services,
                texts.hide_others,
                texts.close_window,
                texts.undo,
                texts.redo,
                texts.cut,
                texts.copy,
                texts.paste,
                texts.select_all,
                texts.fullscreen,
                texts.minimize,
                texts.zoom,
            ] {
                assert!(!text.trim().is_empty(), "{language}");
            }
            for template in [texts.about, texts.hide, texts.quit] {
                assert_eq!(
                    template.matches("{app}").count(),
                    1,
                    "{language}: {template}"
                );
                let rendered = template.replace("{app}", "LoliCode Dev");
                assert!(rendered.contains("LoliCode Dev"));
                assert!(!rendered.contains('{'));
            }
        }
    }
}
