//! Selection of SDK-compatible, bundled Harness plugin layers.
use super::{harness_paths::HarnessPaths, inprocess_agent::InprocessAgentState};
use crate::config;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

const BUNDLES: [(&str, &str); 2] = [
    ("terminal", "@deepseek-ai/dsh-experimental-terminal-bundle"),
    ("ralph", "@deepseek-ai/dsh-experimental-ralph-bundle"),
];
static SELECTION_WRITE: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub(super) struct PluginSelection {
    enabled: BTreeSet<String>,
}

impl PluginSelection {
    pub(super) fn load(profile: &Path) -> Result<Self, String> {
        match fs::read(selection_file(profile)) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "Harness 插件配置无效，原文件已保留".into()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("无法读取 Harness 插件配置".into()),
        }
    }

    pub(super) fn patches(&self, paths: &HarnessPaths) -> Vec<PathBuf> {
        BUNDLES
            .iter()
            .filter(|(id, _)| self.enabled.contains(*id))
            .filter_map(|(_, package)| available_bundle(paths, package).map(|(patch, _)| patch))
            .collect()
    }
}

fn selection_file(profile: &Path) -> PathBuf {
    profile.join("agent/harness-plugins.json")
}

#[derive(Deserialize, Serialize)]
struct PackageInfo {
    name: String,
    description: String,
    version: String,
}

fn available_bundle(paths: &HarnessPaths, package: &str) -> Option<(PathBuf, PackageInfo)> {
    let directory = paths.package.join("node_modules").join(package);
    let manifest: PackageInfo = config::read_json_file(&directory.join("package.json")).ok()?;
    let patch = directory.join("cordis.patch.yml");
    (manifest.name == package && manifest.version == paths.version && patch.is_file())
        .then_some((patch, manifest))
}

#[derive(Serialize)]
struct BundleEntry {
    id: &'static str,
    #[serde(flatten)]
    package: PackageInfo,
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginCatalog {
    bundles: Vec<BundleEntry>,
    pending_reload: bool,
}

fn read_or_update(
    profile: &Path,
    paths: &HarnessPaths,
    change: Option<(String, bool)>,
) -> Result<(PluginSelection, Vec<BundleEntry>), String> {
    let _guard = SELECTION_WRITE
        .lock()
        .map_err(|_| "Harness 插件配置暂不可用")?;
    let mut selection = PluginSelection::load(profile)?;
    let mut bundles: Vec<_> = BUNDLES
        .iter()
        .filter_map(|&(id, package)| {
            let (_, package) = available_bundle(paths, package)?;
            Some(BundleEntry {
                id,
                package,
                enabled: selection.enabled.contains(id),
            })
        })
        .collect();
    if let Some((id, enabled)) = change {
        let bundle = bundles
            .iter_mut()
            .find(|bundle| bundle.id == id)
            .ok_or("这个 Harness 插件未随当前运行时提供")?;
        if bundle.enabled != enabled {
            if enabled {
                selection.enabled.insert(id);
            } else {
                selection.enabled.remove(&id);
            }
            config::write_json_file_private(&selection_file(profile), &selection)
                .map_err(|_| "无法保存 Harness 插件配置")?;
            bundle.enabled = enabled;
        }
    }
    Ok((selection, bundles))
}

pub(crate) async fn catalog(
    app: &AppHandle,
    change: Option<(String, bool)>,
) -> Result<PluginCatalog, String> {
    let paths = HarnessPaths::resolve(app)?;
    let profile = config::get_app_config_dir();
    let (selection, bundles) =
        tokio::task::spawn_blocking(move || read_or_update(&profile, &paths, change))
            .await
            .map_err(|_| "Harness 插件配置读取未完成")??;
    let pending_reload = app
        .state::<InprocessAgentState>()
        .harness
        .plugin_reload_pending(&selection)
        .await;
    Ok(PluginCatalog {
        bundles,
        pending_reload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_available_bundled_plugins_and_preserves_saved_state() {
        let temporary = tempfile::tempdir().unwrap();
        let profile = temporary.path().join("profile");
        let paths = HarnessPaths {
            node: PathBuf::new(),
            package: temporary.path().join("runtime"),
            version: "test-version".into(),
        };
        for (_, package) in BUNDLES {
            let directory = paths.package.join("node_modules").join(package);
            fs::create_dir_all(&directory).unwrap();
            fs::write(
                directory.join("package.json"),
                serde_json::json!({
                    "name": package, "version": paths.version, "description": "Fixture",
                })
                .to_string(),
            )
            .unwrap();
            fs::write(directory.join("cordis.patch.yml"), "[]").unwrap();
        }

        let (initial, bundles) = read_or_update(&profile, &paths, None).unwrap();
        assert!(initial.patches(&paths).is_empty());
        assert_eq!(bundles.len(), 2);
        assert!(!selection_file(&profile).exists());
        assert!(read_or_update(&profile, &paths, Some(("../arbitrary".into(), true))).is_err());
        assert!(!selection_file(&profile).exists());

        let (selected, bundles) =
            read_or_update(&profile, &paths, Some(("terminal".into(), true))).unwrap();
        assert_eq!(selected, PluginSelection::load(&profile).unwrap());
        assert!(bundles[0].enabled && !bundles[1].enabled);
        assert_eq!(selected.patches(&paths).len(), 1);
        let (selected, _) = read_or_update(&profile, &paths, Some(("ralph".into(), true))).unwrap();
        assert_eq!(selected.patches(&paths).len(), 2);

        let (selected, _) =
            read_or_update(&profile, &paths, Some(("terminal".into(), false))).unwrap();
        assert_eq!(selected, PluginSelection::load(&profile).unwrap());
        assert_eq!(selected.patches(&paths).len(), 1);
        assert!(selected.patches(&paths)[0].ends_with(format!("{}/cordis.patch.yml", BUNDLES[1].1)));
    }
}
