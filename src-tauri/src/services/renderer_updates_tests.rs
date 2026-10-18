use super::*;
fn fixtures() -> serde_json::Value {
    serde_json::from_str(include_str!("../../test-fixtures/renderer-packs.json")).unwrap()
}
fn store(root: &Path) -> RendererStore {
    RendererStore::new(
        root.into(),
        fixtures()["publicKey"].as_str().unwrap().into(),
        "4.0.21-rc.2".into(),
        "a".repeat(64),
    )
}
fn case(name: &str) -> (Envelope, Vec<u8>) {
    let f = fixtures();
    (
        serde_json::from_value(f[name]["envelope"].clone()).unwrap(),
        STANDARD
            .decode(f[name]["archive"].as_str().unwrap())
            .unwrap(),
    )
}
fn install(s: &RendererStore, name: &str) -> PackView {
    let (e, b) = case(name);
    s.install_verified_archive(&e, &b).unwrap()
}
#[test]
fn stage_is_inert_boot_is_whole_and_health_receipt_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(temp.path());
    let v = install(&s, "first");
    assert_eq!(v.active_id, None);
    assert_eq!(v.staged_version, Some(1));
    assert!(v.restart_required);
    let boot = s.begin_boot();
    let p = boot.pack.as_ref().unwrap();
    assert_eq!(p.version, 1);
    assert_eq!(p.files.len(), 3);
    assert!(String::from_utf8_lossy(&p.files["assets/app.js"]).contains("ONE"));
    assert!(s.confirm(&p.id, "wrong-ticket").is_err());
    s.confirm(&p.id, boot.ticket.as_deref().unwrap()).unwrap();
    let reopened = store(temp.path());
    let next = reopened.begin_boot();
    assert_eq!(next.pack.unwrap().id, p.id);
    assert!(next.ticket.is_none());
    assert!(s.confirm(&p.id, boot.ticket.as_deref().unwrap()).is_err());
}
#[test]
fn crashed_new_renderer_returns_to_previous_and_does_not_reinstall_rejected_revision() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(temp.path());
    install(&s, "first");
    let first = s.begin_boot();
    let id = first.pack.as_ref().unwrap().id.clone();
    s.confirm(&id, first.ticket.as_deref().unwrap()).unwrap();
    install(&s, "second");
    let failed_boot = s.begin_boot();
    assert_eq!(failed_boot.pack.unwrap().version, 2);
    let recovered = store(temp.path()).begin_boot();
    assert_eq!(recovered.pack.unwrap().id, id);
    assert!(recovered.warning.is_some());
    assert!(s.view().unwrap().highest_version == 2);
    let (e, b) = case("second");
    assert!(s.install_verified_archive(&e, &b).is_err());
}
#[test]
fn first_failed_boot_and_explicit_rollback_restore_bundled_ui() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(temp.path());
    install(&s, "first");
    let boot = s.begin_boot();
    let id = boot.pack.as_ref().unwrap().id.clone();
    assert!(store(temp.path()).begin_boot().pack.is_none());
    assert!(s.confirm(&id, boot.ticket.as_deref().unwrap()).is_err());
    let temp = tempfile::tempdir().unwrap();
    let s = store(temp.path());
    install(&s, "first");
    let boot = s.begin_boot();
    let id = boot.pack.as_ref().unwrap().id.clone();
    s.confirm(&id, boot.ticket.as_deref().unwrap()).unwrap();
    assert!(s.rollback(&"b".repeat(64)).is_err());
    assert!(s.rollback(&id).unwrap().restart_required);
    assert!(s.begin_boot().pack.is_none());
    assert_eq!(s.view().unwrap().highest_version, 1);
}
#[test]
fn incompatible_signed_code_bad_archives_and_wrong_keys_preserve_selected_renderer() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(temp.path());
    install(&s, "first");
    let boot = s.begin_boot();
    let id = boot.pack.as_ref().unwrap().id.clone();
    s.confirm(&id, boot.ticket.as_deref().unwrap()).unwrap();
    for name in [
        "wrongNative",
        "wrongContract",
        "nativeFile",
        "traversal",
        "undeclared",
        "symlink",
    ] {
        let (e, b) = case(name);
        assert!(s.install_verified_archive(&e, &b).is_err(), "{name}");
        assert_eq!(s.view().unwrap().active_id.as_deref(), Some(id.as_str()));
    }
    let (mut e, mut b) = case("second");
    b[0] ^= 1;
    assert!(s.install_verified_archive(&e, &b).is_err());
    e.signature.replace_range(0..4, "AAAA");
    assert!(s.install_verified_archive(&e, &b).is_err());
    let (e, b) = case("first");
    let other = RendererStore::new(
        temp.path().join("other"),
        "AAAA".into(),
        "4.0.21-rc.2".into(),
        "a".repeat(64),
    );
    assert!(other.install_verified_archive(&e, &b).is_err());
}
#[test]
fn corruption_never_supplies_partial_hot_files_and_broken_marker_is_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(temp.path());
    install(&s, "first");
    let boot = s.begin_boot();
    let id = boot.pack.as_ref().unwrap().id.clone();
    s.confirm(&id, boot.ticket.as_deref().unwrap()).unwrap();
    fs::write(temp.path().join(&id).join("assets/app.js"), "tampered").unwrap();
    assert!(s.begin_boot().pack.is_none());
    fs::write(temp.path().join("active.json"), "malformed-original").unwrap();
    let b = s.begin_boot();
    assert!(b.pack.is_none() && b.warning.is_some());
    assert_eq!(
        fs::read_to_string(temp.path().join("active.json")).unwrap(),
        "malformed-original"
    );
}
#[test]
fn strict_paths_and_official_transport_do_not_expand_native_permissions() {
    for path in [
        "../index.html",
        "assets/../a.js",
        "/assets/a.js",
        "assets/a%2ejs",
        "assets/CON.js",
        "assets/a.js.",
        "assets/.config.js",
        "native.exe",
        "assets/a.map",
        "assets/A\\b.js",
        "assets/a.js?x",
    ] {
        assert!(!file_path(path), "{path}");
    }
    assert!(
        file_path("index.html")
            && file_path("assets/worker-a.js")
            && file_path("assets/font.woff2")
    );
    for url in [
        "http://tools.treasuregrove.art/lolicode/renderer/1.zip",
        "https://evil.example/lolicode/renderer/1.zip",
        "https://tools.treasuregrove.art/lolicode/resources/1.zip",
        "https://user:pass@tools.treasuregrove.art/lolicode/renderer/1.zip",
        "https://tools.treasuregrove.art/lolicode/renderer/1.zip?q=1",
        "https://pub-250df9737586416fbd6e8cb0a843b249.r2.dev/lolicode/releases/renderer.zip",
        "https://pub-250df9737586416fbd6e8cb0a843b249.r2.dev.evil.example/lolicode/renderer/1.zip",
    ] {
        assert!(official_url(url).is_err());
    }
    assert!(
        official_url("https://tools.treasuregrove.art/lolicode/renderer/1/renderer.zip").is_ok()
    );
    assert!(official_url(
        "https://pub-250df9737586416fbd6e8cb0a843b249.r2.dev/lolicode/renderer/1/renderer.zip"
    )
    .is_ok());
    assert!(digest(&native_contract()));
    println!("renderer-native-contract={}", native_contract());
}
#[test]
fn explicit_recovery_cancels_waiting_stage_and_survives_a_damaged_predecessor() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(temp.path());
    install(&s, "first");
    let first = s.begin_boot();
    let first_id = first.pack.unwrap().id;
    s.confirm(&first_id, first.ticket.as_deref().unwrap())
        .unwrap();
    install(&s, "second");
    let second = s.begin_boot();
    let second_id = second.pack.unwrap().id;
    s.confirm(&second_id, second.ticket.as_deref().unwrap())
        .unwrap();
    s.rollback(&second_id).unwrap();
    fs::write(temp.path().join(first_id).join("index.html"), "corrupt").unwrap();
    assert!(s.rollback(&second_id).unwrap().restart_required);
    assert!(s.begin_boot().pack.is_none());
    assert_eq!(s.view().unwrap().highest_version, 2);
}
#[cfg(windows)]
#[test]
fn windows_junction_cache_cannot_redirect_signed_pack_writes() {
    let temp = tempfile::tempdir().unwrap();
    let real = temp.path().join("real");
    fs::create_dir(&real).unwrap();
    let link = temp.path().join("link");
    let result = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(&real)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "could not create isolated junction fixture"
    );
    let s = store(&link);
    let (e, b) = case("first");
    assert!(s.install_verified_archive(&e, &b).is_err());
    assert!(s.begin_boot().pack.is_none());
    assert!(!real.join("active.json").exists());
    fs::remove_dir(&link).unwrap();
}
#[cfg(unix)]
#[test]
fn linked_cache_roots_or_files_are_not_executed() {
    let temp = tempfile::tempdir().unwrap();
    let real = temp.path().join("real");
    fs::create_dir(&real).unwrap();
    let link = temp.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let s = store(&link);
    let (e, b) = case("first");
    assert!(s.install_verified_archive(&e, &b).is_err());
    assert!(s.begin_boot().pack.is_none());
    assert!(!real.join("active.json").exists());
}
