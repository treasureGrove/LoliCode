//! Read-only discovery of desktop harnesses and MiMo Code. Configuration files
//! are not proof of installation; discovery never starts a program or installer.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub const TARGETS: [&str; 6] = [
    "workbuddy",
    "deepseek-harness",
    "zcode",
    "mimocode",
    "codebuddy",
    "qoder",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentTool {
    pub id: String,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub custom_path: bool,
    pub config_paths: Vec<String>,
    pub config_exists: bool,
    pub config_error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct ToolPaths(pub BTreeMap<String, PathBuf>);

pub fn validate_target(target: &str) -> Result<(), String> {
    TARGETS
        .contains(&target)
        .then_some(())
        .ok_or_else(|| "不支持的本地 Agent".into())
}

fn names(target: &str) -> &'static [&'static str] {
    match target {
        "workbuddy" => &["WorkBuddy", "workbuddy"],
        "deepseek-harness" => &["DeepSeek Harness", "deepseek-harness"],
        "zcode" => &["ZCode", "zcode"],
        "mimocode" => &["mimo"],
        "codebuddy" => &["CodeBuddy", "CodeBuddy CN", "CodeBuddy IDE", "codebuddy"],
        "qoder" => &["Qoder", "Qoder IDE", "qoder"],
        _ => &[],
    }
}

fn file_names(target: &str) -> Vec<String> {
    names(target)
        .iter()
        .map(|name| {
            if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.to_string()
            }
        })
        .collect()
}

fn runnable(path: &Path, target: &str) -> bool {
    let name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
    if cfg!(target_os = "macos") && path.is_dir() {
        return names(target)
            .iter()
            .any(|n| name.eq_ignore_ascii_case(&format!("{n}.app")))
            && path.join("Contents/MacOS").is_dir();
    }
    let named = file_names(target)
        .iter()
        .any(|n| name.eq_ignore_ascii_case(n))
        || (cfg!(target_os = "linux")
            && target != "mimocode"
            && names(target).iter().any(|n| name.starts_with(n))
            && name.ends_with(".AppImage"));
    if !named || !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    true
}

pub fn validate_path(target: &str, path: &Path) -> Result<PathBuf, String> {
    validate_target(target)?;
    if !path.is_absolute() || !runnable(path, target) {
        return Err(format!(
            "请选择 {} 的已安装程序，不要选择安装包或配置文件",
            names(target)[0]
        ));
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "程序路径不存在或无法访问".to_string())?;
    // Shell file managers and labels need ordinary Windows paths rather than
    // std::fs's verbatim prefix. Rust restores that prefix for filesystem I/O.
    #[cfg(windows)]
    {
        let raw = canonical.to_string_lossy();
        Ok(if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{unc}"))
        } else {
            PathBuf::from(raw.strip_prefix(r"\\?\").unwrap_or(&raw))
        })
    }
    #[cfg(not(windows))]
    Ok(canonical)
}

#[derive(Clone, Debug)]
struct Candidate {
    path: PathBuf,
    version: Option<String>,
}

fn add_root(out: &mut Vec<Candidate>, root: &Path, target: &str, version: Option<String>) {
    for name in file_names(target) {
        out.push(Candidate {
            path: root.join(name),
            version: version.clone(),
        });
    }
    if cfg!(target_os = "macos") {
        for name in names(target) {
            out.push(Candidate {
                path: root.join(format!("{name}.app")),
                version: version.clone(),
            });
        }
    }
}

// Registry paths are used only as candidate directories. We never execute an
// uninstall string, DisplayIcon command line, or any data from registry values.
#[cfg(windows)]
fn registry_candidates(target: &str) -> Vec<Candidate> {
    use winreg::{enums::*, RegKey};
    let mut out = vec![];
    let labels: &[&str] = match target {
        "workbuddy" => &["workbuddy"],
        "deepseek-harness" => &["deepseek harness", "deepseek-harness"],
        "zcode" => &["zcode"],
        "mimocode" => &["mimo code", "mimocode"],
        "codebuddy" => &["codebuddy", "codebuddy cn", "codebuddy ide"],
        "qoder" => &["qoder", "qoder ide"],
        _ => &[],
    };
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for branch in [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ] {
            let Ok(key) = RegKey::predef(hive).open_subkey_with_flags(branch, KEY_READ) else {
                continue;
            };
            for entry in key.enum_keys().filter_map(Result::ok) {
                let Ok(entry) = key.open_subkey_with_flags(entry, KEY_READ) else {
                    continue;
                };
                let label: String = entry.get_value("DisplayName").unwrap_or_default();
                if !labels.iter().any(|n| display_name_matches(&label, n)) {
                    continue;
                }
                let version = entry.get_value::<String, _>("DisplayVersion").ok();
                if let Ok(root) = entry.get_value::<String, _>("InstallLocation") {
                    if !root.trim().is_empty() {
                        add_root(
                            &mut out,
                            Path::new(root.trim_matches('"')),
                            target,
                            version.clone(),
                        );
                    }
                }
                if let Ok(icon) = entry.get_value::<String, _>("DisplayIcon") {
                    let path = display_icon_path(&icon);
                    if let Some(root) = path.parent() {
                        add_root(&mut out, root, target, version);
                    }
                }
            }
        }
    }
    out
}

#[cfg(any(windows, test))]
fn display_name_matches(label: &str, name: &str) -> bool {
    let label = label.to_ascii_lowercase();
    label == name
        || label
            .strip_prefix(name)
            .is_some_and(|rest| rest.starts_with(' '))
}

#[cfg(any(windows, test))]
fn display_icon_path(icon: &str) -> PathBuf {
    let value = icon.trim();
    let value = value
        .rsplit_once(',')
        .filter(|(_, n)| n.trim().parse::<i32>().is_ok())
        .map(|(path, _)| path)
        .unwrap_or(value);
    PathBuf::from(value.trim().trim_matches('"'))
}

fn candidates(target: &str) -> Vec<Candidate> {
    let mut out = vec![];
    #[cfg(windows)]
    out.extend(registry_candidates(target));
    let home = crate::config::get_home_dir();
    if target == "mimocode" {
        add_root(&mut out, &home.join(".mimocode/bin"), target, None);
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for root in std::env::split_paths(&paths).filter(|p| p.is_absolute()) {
            add_root(&mut out, &root, target, None);
        }
    }
    #[cfg(windows)]
    for var in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(var).map(PathBuf::from) {
            for name in names(target) {
                add_root(&mut out, &root.join(name), target, None);
                add_root(&mut out, &root.join("Programs").join(name), target, None);
            }
        }
    }
    #[cfg(target_os = "macos")]
    for root in [
        PathBuf::from("/Applications"),
        home.join("Applications"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ] {
        add_root(&mut out, &root, target, None);
    }
    #[cfg(target_os = "linux")]
    for root in [
        PathBuf::from("/usr/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".local/bin"),
    ] {
        add_root(&mut out, &root, target, None);
    }
    out
}

fn product_version(path: &Path, target: &str) -> Option<String> {
    if !matches!(target, "qoder" | "codebuddy") {
        return None;
    }
    // The Windows uninstall version may be the underlying editor's version.
    // Prefer the installed product's own bounded package metadata when present.
    let root = if path.is_dir() {
        path.join("Contents/Resources/app")
    } else {
        path.parent()?.join("resources/app")
    };
    let file = root.join("package.json");
    if std::fs::metadata(&file).ok()?.len() > 128 * 1024 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let name = value["name"].as_str()?;
    if !names(target).iter().any(|n| name.eq_ignore_ascii_case(n)) {
        return None;
    }
    let version = value["version"].as_str()?;
    (version.len() < 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c)))
    .then(|| version.to_owned())
}

fn detect(target: &str, custom: Option<&PathBuf>, candidates: Vec<Candidate>) -> LocalAgentTool {
    let found = candidates.into_iter().find(|c| runnable(&c.path, target));
    let (path, version, installed) = if let Some(path) = custom {
        let installed = runnable(path, target);
        let version = found
            .filter(|c| c.path.canonicalize().ok() == path.canonicalize().ok())
            .and_then(|c| c.version);
        (
            Some(path.to_string_lossy().into_owned()),
            version,
            installed,
        )
    } else if let Some(found) = found {
        (
            Some(found.path.to_string_lossy().into_owned()),
            found.version,
            true,
        )
    } else {
        (None, None, false)
    };
    let version = path
        .as_deref()
        .filter(|_| installed)
        .and_then(|p| product_version(Path::new(p), target))
        .or(version);
    LocalAgentTool {
        id: target.into(),
        installed,
        path,
        version,
        custom_path: custom.is_some(),
        config_paths: vec![],
        config_exists: false,
        config_error: None,
    }
}

pub fn list(paths: &ToolPaths) -> Vec<LocalAgentTool> {
    TARGETS
        .into_iter()
        .map(|target| {
            let mut tool = detect(target, paths.0.get(target), candidates(target));
            // Qoder BYOK is owned by its settings wizard; a generic settings.json
            // is neither a model credential file nor a supported import surface.
            if target == "qoder" {
                return tool;
            }
            match super::external_agent_config::config_paths(target) {
                Ok(paths) => {
                    tool.config_exists = paths.iter().any(|p| p.is_file());
                    tool.config_paths = paths
                        .iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect();
                }
                Err(error) => tool.config_error = Some(error.to_string()),
            }
            tool
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn executable(root: &Path, target: &str) -> PathBuf {
        std::fs::create_dir_all(root).unwrap();
        let path = root.join(&file_names(target)[0]);
        std::fs::write(&path, "never execute discovery fixtures").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        path
    }
    #[test]
    fn validates_installed_programs_but_rejects_installers_configs_and_other_apps() {
        let dir = tempfile::tempdir().unwrap();
        for target in TARGETS {
            let path = executable(dir.path(), target);
            let selected = validate_path(target, &path).unwrap();
            assert!(selected.is_absolute());
            #[cfg(windows)]
            assert!(!selected.to_string_lossy().starts_with(r"\\?\"));
        }
        let installer = dir.path().join("ZCode-setup.exe");
        std::fs::write(&installer, "installer").unwrap();
        assert!(validate_path("zcode", &installer).is_err());
        assert!(validate_path("zcode", &dir.path().join("missing/ZCode.exe")).is_err());
        assert!(validate_path("mimocode", &dir.path().join("Xiaomi MiMo.exe")).is_err());
        assert!(validate_path("unknown", dir.path()).is_err());
    }
    #[test]
    fn discovery_does_not_execute_and_preserves_custom_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = executable(dir.path(), "zcode");
        let detected = detect(
            "zcode",
            None,
            vec![Candidate {
                path: path.clone(),
                version: Some("3.15.3".into()),
            }],
        );
        assert!(detected.installed);
        assert_eq!(detected.version.as_deref(), Some("3.15.3"));
        let custom = dir.path().join("missing").join(&file_names("zcode")[0]);
        let detected = detect(
            "zcode",
            Some(&custom),
            vec![Candidate {
                path,
                version: None,
            }],
        );
        assert!(!detected.installed);
        assert!(detected.custom_path);
        assert_eq!(detected.path, Some(custom.to_string_lossy().into_owned()));
        assert!(!detect("zcode", None, vec![]).installed);
    }
    #[test]
    fn registry_values_are_paths_not_commands_and_match_exact_products() {
        assert!(display_name_matches("ZCode 3.15.3", "zcode"));
        assert!(!display_name_matches("ZCode-setup", "zcode"));
        assert!(!display_name_matches("Xiaomi MiMo 26.9", "mimo code"));
        assert!(display_name_matches("Qoder IDE", "qoder"));
        assert!(display_name_matches("CodeBuddy 1.0", "codebuddy"));
        assert!(!display_name_matches("WorkBuddy 5.3", "codebuddy"));
        assert_eq!(
            display_icon_path("\"D:\\Apps,Local\\ZCode.exe\",0"),
            PathBuf::from("D:\\Apps,Local\\ZCode.exe")
        );
        assert_eq!(
            display_icon_path("/opt/zcode/icon.ico"),
            PathBuf::from("/opt/zcode/icon.ico")
        );
    }
    #[test]
    fn editor_product_version_takes_priority_over_base_editor_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = executable(dir.path(), "qoder");
        std::fs::create_dir_all(dir.path().join("resources/app")).unwrap();
        std::fs::write(
            dir.path().join("resources/app/package.json"),
            r#"{"name":"Qoder IDE","version":"1.25.1"}"#,
        )
        .unwrap();
        let tool = detect(
            "qoder",
            None,
            vec![Candidate {
                path: path.clone(),
                version: Some("1.106.3".into()),
            }],
        );
        assert_eq!(tool.version.as_deref(), Some("1.25.1"));
        std::fs::write(
            dir.path().join("resources/app/package.json"),
            r#"{"name":"Other Editor","version":"9.9.9"}"#,
        )
        .unwrap();
        assert!(product_version(&path, "qoder").is_none());
    }
    #[test]
    #[ignore = "Manual read-only check of installed local tools on this device"]
    fn system_discovery_smoke() {
        let tools = list(&ToolPaths::default());
        assert_eq!(tools.len(), TARGETS.len());
        println!("{}", serde_json::to_string_pretty(&tools).unwrap());
    }
}
