use super::super::renderer_updates::Envelope;
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
struct Bundled;
impl Assets<tauri::Wry> for Bundled {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match key.as_ref() {
            "/index.html" => Some(Cow::Borrowed(b"BUNDLED_INDEX")),
            "/assets/old.js" => Some(Cow::Borrowed(b"BUNDLED_JS")),
            _ => None,
        }
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::once((
            Cow::Borrowed("index.html"),
            Cow::Borrowed(b"BUNDLED_INDEX".as_slice()),
        )))
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
fn installed(root: &std::path::Path) -> Arc<RendererStore> {
    let f: serde_json::Value =
        serde_json::from_str(include_str!("../../test-fixtures/renderer-packs.json")).unwrap();
    let s = Arc::new(RendererStore::new(
        root.into(),
        f["publicKey"].as_str().unwrap().into(),
        "4.0.21-rc.2".into(),
        "a".repeat(64),
    ));
    let e: Envelope = serde_json::from_value(f["first"]["envelope"].clone()).unwrap();
    s.install_verified_archive(
        &e,
        &STANDARD
            .decode(f["first"]["archive"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    s
}
#[test]
fn asset_provider_uses_one_generation_keeps_memory_snapshot_and_confirms_exact_boot() {
    let temp = tempfile::tempdir().unwrap();
    let store = installed(temp.path());
    let host = Arc::new(RendererHost::default());
    host.session
        .set(Session {
            boot: store.begin_boot(),
            store: Some(store.clone()),
            development: false,
        })
        .ok()
        .unwrap();
    let assets = RendererAssets {
        bundled: Box::new(Bundled),
        host: host.clone(),
    };
    let index = assets
        .get(&AssetKey::from("/index.html"))
        .unwrap()
        .into_owned();
    assert_ne!(index, b"BUNDLED_INDEX");
    assert!(
        assets.get(&AssetKey::from("/assets/old.js")).is_none(),
        "never mix bundled chunks into a hot renderer"
    );
    assert_eq!(assets.iter().count(), 3);
    let status = host.status().unwrap();
    let id = status.running_id.unwrap();
    let ticket = status.boot_ticket.unwrap();
    assert!(host.confirm(&id, "wrong").is_err());
    assert!(
        store.rollback(&id).is_err(),
        "unconfirmed boot must not queue a second transition"
    );
    host.confirm(&id, &ticket).unwrap();
    host.confirm(&id, &ticket).unwrap();
    assert!(!host.status().unwrap().state.pending_confirmation);
    std::fs::write(temp.path().join(&id).join("index.html"), b"MODIFIED_DISK").unwrap();
    assert_eq!(
        assets.get(&AssetKey::from("/index.html")).unwrap().as_ref(),
        index
    );
    assert!(
        store.begin_boot().pack.is_none(),
        "next process rejects changed disk bytes"
    );
}
#[test]
fn bundled_provider_survives_unavailable_state_and_staging_is_inert() {
    let temp = tempfile::tempdir().unwrap();
    let store = installed(temp.path());
    let host = Arc::new(RendererHost::default());
    let assets = RendererAssets {
        bundled: Box::new(Bundled),
        host: host.clone(),
    };
    assert_eq!(
        assets.get(&AssetKey::from("index.html")).unwrap().as_ref(),
        b"BUNDLED_INDEX"
    );
    host.session
        .set(Session {
            store: Some(store),
            boot: Boot::default(),
            development: false,
        })
        .ok()
        .unwrap();
    assert!(host.status().unwrap().state.restart_required);
    assert_eq!(
        assets.get(&AssetKey::from("index.html")).unwrap().as_ref(),
        b"BUNDLED_INDEX"
    );
    assert_eq!(assets.csp_hashes(&AssetKey::from("index.html")).count(), 0);
}

fn local_development_build(source: &Path, id: &str) -> DevelopmentFrontendBuild {
    let directory = source
        .join("src-tauri/target/development/renderers")
        .join(id);
    std::fs::create_dir_all(directory.join("assets")).unwrap();
    std::fs::write(
        directory.join("index.html"),
        format!("<script src=\"./assets/{id}.js\"></script>INDEX_{id}"),
    )
    .unwrap();
    std::fs::write(
        directory.join(format!("assets/{id}.js")),
        format!("SCRIPT_{id}"),
    )
    .unwrap();
    let metadata = DevelopmentFrontendBuild {
        channel: "development".into(),
        development_build_number: format!("DEV-{id}"),
        source_branch: "TG/test-renderer".into(),
        revision: "test-revision+dirty".into(),
        built_at: "2026-10-28T10:04:01Z".into(),
        working_tree_dirty: true,
        output_directory: directory.clone(),
        native_contract: native_contract(),
        native_version: env!("CARGO_PKG_VERSION").into(),
    };
    std::fs::write(
        directory.join("development-renderer.json"),
        serde_json::to_vec(&metadata).unwrap(),
    )
    .unwrap();
    metadata
}

#[test]
fn local_development_snapshot_swaps_complete_generations_and_retains_previous_chunks() {
    let temp = tempfile::tempdir().unwrap();
    let host = Arc::new(RendererHost::default());
    let assets = RendererAssets {
        bundled: Box::new(Bundled),
        host: host.clone(),
    };
    let first = local_development_build(temp.path(), "first");
    let snapshot = development::load(temp.path(), first.clone()).unwrap();
    host.activate_development_renderer(temp.path(), snapshot)
        .unwrap();
    std::fs::write(first.output_directory.join("index.html"), b"MUTATED_DISK").unwrap();
    assert!(
        String::from_utf8_lossy(assets.get(&AssetKey::from("index.html")).unwrap().as_ref())
            .contains("INDEX_first")
    );
    assert!(
        assets.get(&AssetKey::from("assets/old.js")).is_none(),
        "never mix bundled chunks into a local snapshot"
    );
    let second = local_development_build(temp.path(), "second");
    let snapshot = development::load(temp.path(), second.clone()).unwrap();
    host.activate_development_renderer(temp.path(), snapshot)
        .unwrap();
    assert!(
        String::from_utf8_lossy(assets.get(&AssetKey::from("index.html")).unwrap().as_ref())
            .contains("INDEX_second")
    );
    assert_eq!(
        assets
            .get(&AssetKey::from("assets/first.js"))
            .unwrap()
            .as_ref(),
        b"SCRIPT_first"
    );
    assert_eq!(
        assets
            .get(&AssetKey::from("assets/second.js"))
            .unwrap()
            .as_ref(),
        b"SCRIPT_second"
    );
    assert_eq!(assets.iter().count(), 2);
    assert_eq!(
        development::load_current(temp.path()).unwrap().metadata,
        second
    );
}

#[test]
fn incomplete_wrong_native_and_outside_snapshots_are_rejected_without_switching_assets() {
    let temp = tempfile::tempdir().unwrap();
    let host = Arc::new(RendererHost::default());
    let assets = RendererAssets {
        bundled: Box::new(Bundled),
        host: host.clone(),
    };
    let first = local_development_build(temp.path(), "first");
    host.activate_development_renderer(temp.path(), development::load(temp.path(), first).unwrap())
        .unwrap();
    let incomplete = local_development_build(temp.path(), "incomplete");
    std::fs::write(
        incomplete.output_directory.join("index.html"),
        b"<script src=\"./assets/missing.js\"></script>",
    )
    .unwrap();
    assert!(development::load(temp.path(), incomplete).is_err());
    let mut wrong_native = local_development_build(temp.path(), "wrong-native");
    wrong_native.native_contract = "0".repeat(64);
    assert!(development::load(temp.path(), wrong_native)
        .err()
        .unwrap()
        .contains("完整重建"));
    let outside = tempfile::tempdir().unwrap();
    let outside_build = local_development_build(outside.path(), "outside");
    assert!(development::load(temp.path(), outside_build).is_err());
    assert!(
        String::from_utf8_lossy(assets.get(&AssetKey::from("index.html")).unwrap().as_ref())
            .contains("INDEX_first")
    );
}

#[test]
fn failed_pointer_write_restores_the_running_local_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let host = Arc::new(RendererHost::default());
    let assets = RendererAssets {
        bundled: Box::new(Bundled),
        host: host.clone(),
    };
    let first = local_development_build(temp.path(), "first");
    host.activate_development_renderer(temp.path(), development::load(temp.path(), first).unwrap())
        .unwrap();
    let pointer = development::pointer_path(temp.path());
    std::fs::remove_file(&pointer).unwrap();
    std::fs::create_dir(&pointer).unwrap();
    let second = local_development_build(temp.path(), "second");
    assert!(host
        .activate_development_renderer(temp.path(), development::load(temp.path(), second).unwrap())
        .is_err());
    assert!(
        String::from_utf8_lossy(assets.get(&AssetKey::from("index.html")).unwrap().as_ref())
            .contains("INDEX_first")
    );
}
