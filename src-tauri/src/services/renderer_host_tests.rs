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
