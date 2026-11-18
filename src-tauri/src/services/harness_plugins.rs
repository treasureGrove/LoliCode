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

const BUNDLES: [(&str, &str); 7] = [
    ("terminal", "@deepseek-ai/dsh-experimental-terminal-bundle"),
    ("ralph", "@deepseek-ai/dsh-experimental-ralph-bundle"),
    (
        "session-search",
        "@deepseek-ai/dsh-experimental-session-search",
    ),
    (
        "session-titles",
        "@deepseek-ai/dsh-experimental-session-titles-bundle",
    ),
    (
        "badge-skill",
        "@deepseek-ai/dsh-experimental-badge-skill-bundle",
    ),
    ("worktree", "@deepseek-ai/dsh-experimental-tool-worktree"),
    ("auto-review", "@deepseek-ai/dsh-experimental-auto-review"),
];
static SELECTION_WRITE: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub(super) struct PluginSelection {
    enabled: BTreeSet<String>,
    #[serde(default)]
    marketplace: Vec<super::dsh_marketplace::SelectedMarketBundle>,
}

#[derive(Serialize)]
struct PersistedPluginSelection<'a> {
    enabled: &'a BTreeSet<String>,
}

impl PluginSelection {
    pub(super) fn load(profile: &Path) -> Result<Self, String> {
        let mut selection = match fs::read(selection_file(profile)) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "Harness 插件配置无效，原文件已保留".to_owned())?,
            Err(error) if error.kind() == ErrorKind::NotFound => Self::default(),
            Err(_) => return Err("无法读取 Harness 插件配置".into()),
        };
        selection.marketplace =
            super::dsh_marketplace::selected_bundles(profile).unwrap_or_default();
        Ok(selection)
    }

    pub(super) fn patches(&self, paths: &HarnessPaths) -> Vec<PathBuf> {
        BUNDLES
            .iter()
            .filter(|(id, _)| self.enabled.contains(*id))
            .filter_map(|(_, package)| available_bundle(paths, package).map(|(patch, _)| patch))
            .collect()
    }

    pub(super) fn sync_home(&self, profile: &Path, home: &Path) -> Result<(), String> {
        super::dsh_marketplace::sync_home_sdk_profile(profile, home, &self.marketplace)
    }
}

fn selection_file(profile: &Path) -> PathBuf {
    profile.join("agent/harness-plugins.json")
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct PackageInfo {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) version: String,
}

fn available_bundle(paths: &HarnessPaths, package: &str) -> Option<(PathBuf, PackageInfo)> {
    let directory = paths.package.join("node_modules").join(package);
    let manifest: PackageInfo = config::read_json_file(&directory.join("package.json")).ok()?;
    let patch = directory.join("cordis.patch.yml");
    (manifest.name == package && manifest.version == paths.version && patch.is_file())
        .then_some((patch, manifest))
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct BundleEntry {
    pub(crate) id: &'static str,
    #[serde(flatten)]
    pub(crate) package: PackageInfo,
    pub(crate) enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginCatalog {
    pub(crate) bundles: Vec<BundleEntry>,
    pub(crate) pending_reload: bool,
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
            config::write_json_file_private(
                &selection_file(profile),
                &PersistedPluginSelection {
                    enabled: &selection.enabled,
                },
            )
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
    let changed = change.is_some();
    let (selection, bundles) =
        tokio::task::spawn_blocking(move || read_or_update(&profile, &paths, change))
            .await
            .map_err(|_| "Harness 插件配置读取未完成")??;
    let harness = &app.state::<InprocessAgentState>().harness;
    if changed {
        let _ = harness.retire_idle(None).await;
    }
    let pending_reload = harness.plugin_reload_pending(&selection).await;
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
            native_reader: temporary.path().join("runtime/host-session-native.mjs"),
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
        assert_eq!(bundles.len(), BUNDLES.len());
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
