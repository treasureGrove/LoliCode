use super::*;
use axum::{http::StatusCode, response::IntoResponse, routing::post, Json};
use std::sync::{atomic::AtomicUsize, Mutex as SyncMutex};

#[derive(Default)]
struct MemoryIdentityVault {
    entries: SyncMutex<BTreeMap<String, String>>,
    legacy: SyncMutex<Option<String>>,
    calls: SyncMutex<Vec<String>>,
    paused_read: SyncMutex<Option<(Arc<tokio::sync::Notify>, std::sync::mpsc::Receiver<()>)>>,
}
impl IdentityVault for MemoryIdentityVault {
    fn read(&self, account_id: &str) -> Result<Option<StoredIdentity>, String> {
        let entry = identity_entry(account_id)?;
        self.calls.lock().unwrap().push(format!("read:{entry}"));
        let paused = self.paused_read.lock().unwrap().take();
        if let Some((started, release)) = paused {
            started.notify_one();
            release
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| "fixture read timed out")?;
        }
        self.entries
            .lock()
            .unwrap()
            .get(&entry)
            .map(|text| serde_json::from_str(text).map_err(|_| "fixture corrupt identity".into()))
            .transpose()
    }
    fn write(&self, account_id: &str, value: &StoredIdentity) -> Result<(), String> {
        let entry = identity_entry(account_id)?;
        self.calls.lock().unwrap().push(format!("write:{entry}"));
        self.entries
            .lock()
            .unwrap()
            .insert(entry, serde_json::to_string(value).unwrap());
        Ok(())
    }
    fn read_legacy(&self) -> Result<Option<StoredIdentity>, String> {
        self.calls.lock().unwrap().push("read:installation".into());
        self.legacy
            .lock()
            .unwrap()
            .as_ref()
            .map(|text| serde_json::from_str(text).map_err(|_| "fixture corrupt legacy".into()))
            .transpose()
    }
}
fn identity_state(db: Arc<Database>, vault: Arc<MemoryIdentityVault>) -> MobileCompanionState {
    let mut state = MobileCompanionState::with_vault(db, Arc::new(MemoryRoomVault::default()));
    Arc::get_mut(&mut state.0).unwrap().account.vault = vault;
    state
}
async fn scoped_identity(state: &MobileCompanionState, id: &str) -> Arc<Identity> {
    state
        .identity(id, state.0.account.epoch.load(Ordering::SeqCst))
        .await
        .unwrap()
}
async fn save_identity_binding(
    state: &MobileCompanionState,
    identity: &Identity,
    owner: &str,
    id: &str,
) {
    let mut store = state.0.store.lock().await;
    store.rooms.insert(
        id.into(),
        Room {
            account: Some(AccountRoom {
                account_id: owner.into(),
                challenge: "fixture".into(),
                request_id: uuid::Uuid::new_v4().to_string(),
                desktop_device_id: identity.device_id.clone(),
                phone_device_id: uuid::Uuid::new_v4().to_string(),
                desktop_fingerprint: identity.fingerprint.clone(),
                phone_fingerprint: "a".repeat(64),
                envelope_hash: "b".repeat(64),
            }),
            relay_url: RELAY.into(),
            expires_at: now() + WINDOW_MS,
            approved: true,
            revoked: false,
            device_id: None,
            device_name: None,
            sessions: BTreeSet::new(),
            shared_sessions: BTreeSet::new(),
            requests: BTreeMap::new(),
            seen_packets: BTreeMap::new(),
            events: BTreeMap::new(),
            active_requests: BTreeMap::new(),
            event_keys: BTreeSet::new(),
        },
    );
    state.save(&store).unwrap();
}

#[tokio::test]
async fn identity_scope_rejects_noncanonical_account_ids_before_any_vault_access() {
    let vault = Arc::new(MemoryIdentityVault::default());
    let state = identity_state(Arc::new(Database::memory().unwrap()), vault.clone());
    for id in [
        "",
        "0",
        "07",
        "+7",
        " 7",
        "7\n",
        "7:8",
        "18446744073709551616",
    ] {
        assert!(state.identity(id, 0).await.is_err(), "{id:?}");
    }
    assert!(vault.calls.lock().unwrap().is_empty());
    assert_eq!(
        identity_entry("18446744073709551615").unwrap(),
        "account:18446744073709551615"
    );
}

#[tokio::test]
async fn fence_during_vault_read_cannot_restore_an_old_identity_cache() {
    let vault = Arc::new(MemoryIdentityVault::default());
    let started = Arc::new(tokio::sync::Notify::new());
    let (release, wait) = std::sync::mpsc::channel();
    *vault.paused_read.lock().unwrap() = Some((started.clone(), wait));
    let state = identity_state(Arc::new(Database::memory().unwrap()), vault);
    let worker = state.clone();
    let pending = tokio::spawn(async move { worker.identity("7", 0).await });
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    state.fence_account_state().await;
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(state.0.account.runtime.lock().await.identity.is_none());
    // A request admitted before logout cannot start another vault operation in
    // the new generation, even when it has not yet reached identity().
    assert!(state.identity("7", 0).await.is_err());
}

#[tokio::test]
async fn concurrent_first_identity_reads_write_once_per_account_and_keep_both_stable() {
    let vault = Arc::new(MemoryIdentityVault::default());
    let started = Arc::new(tokio::sync::Notify::new());
    let (release, wait) = std::sync::mpsc::channel();
    *vault.paused_read.lock().unwrap() = Some((started.clone(), wait));
    let state = identity_state(Arc::new(Database::memory().unwrap()), vault.clone());
    let first_state = state.clone();
    let first = tokio::spawn(async move { first_state.identity("7", 0).await });
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    let mut queued = Vec::new();
    for id in ["7", "8", "7", "8"] {
        let worker = state.clone();
        queued.push((
            id,
            tokio::spawn(async move { worker.identity(id, 0).await }),
        ));
    }
    // Keep the first OS-vault read blocked long enough for the other tasks to
    // reach identity(). They must not read or write another key before it ends.
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(vault.calls.lock().unwrap().len(), 1);
    assert!(vault.entries.lock().unwrap().is_empty());
    release.send(()).unwrap();
    let first = first.await.unwrap().unwrap();
    let mut known = BTreeMap::from([("7", (first.device_id.clone(), first.fingerprint.clone()))]);
    for (id, task) in queued {
        let identity = task.await.unwrap().unwrap();
        let value = (identity.device_id.clone(), identity.fingerprint.clone());
        if let Some(expected) = known.get(id) {
            assert_eq!(expected, &value);
        } else {
            known.insert(id, value);
        }
    }
    assert_ne!(known["7"], known["8"]);
    for id in ["7", "8"] {
        let identity = scoped_identity(&state, id).await;
        assert_eq!(
            known[id],
            (identity.device_id.clone(), identity.fingerprint.clone())
        );
        assert_eq!(
            vault
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| *call == &format!("write:account:{id}"))
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn scoped_identity_survives_account_switches_and_real_relay_http_registration() {
    use tokio::io::AsyncBufReadExt;
    let directory = tempfile::tempdir().unwrap();
    let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    // Run the actual relay with a private state directory and fake forum API.
    // kill_on_drop prevents a failed assertion from leaving a server behind.
    let script = r#"
      import { pathToFileURL } from 'node:url';
      const root = process.argv[1];
      const { createCompanionRelay } = await import(pathToFileURL(root + '/packages/companion-relay/src/server.mjs'));
      const { forumFetch } = await import(pathToFileURL(root + '/packages/companion-relay/test/account-support.mjs'));
      const relay = await createCompanionRelay({stateDirectory:process.argv[2], allowInsecureLocal:true, forumFetch});
      console.log(JSON.stringify({port:relay.address.port}));
    "#;
    let mut server = tokio::process::Command::new("node")
        .args(["--input-type=module", "-e", script])
        .arg(repository)
        .arg(directory.path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("Node.js is required for the repository's relay fixture");
    let mut lines = tokio::io::BufReader::new(server.stdout.take().unwrap()).lines();
    let ready = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let port = serde_json::from_str::<Value>(&ready).unwrap()["port"]
        .as_u64()
        .unwrap();
    let api = Api::new(&format!("http://127.0.0.1:{port}/v2"), true).unwrap();
    let vault = Arc::new(MemoryIdentityVault::default());
    let state = identity_state(Arc::new(Database::memory().unwrap()), vault.clone());
    let mut identities = Vec::new();
    let mut first_binding = None;
    for account_id in ["7", "8", "7"] {
        let identity = scoped_identity(&state, account_id).await;
        let response = api.call(reqwest::Method::POST, "/session", &format!("lc1.{account_id}.{}", "A".repeat(40)),
            Some(json!({"deviceId":identity.device_id,"deviceName":"Fixture desktop","kind":"desktop","publicKey":identity.public_key}))).await.unwrap();
        let ticket = parse_ticket(response, account_id, &identity, now()).unwrap();
        {
            let mut runtime = state.0.account.runtime.lock().await;
            runtime.settings.enabled = true;
            runtime.suspended = false;
            runtime.account_id = Some(account_id.into());
            runtime.ticket = Some(ticket);
        }
        if let Some(binding) = &first_binding {
            assert_eq!(
                state.account_room_ticket(binding).await.is_some(),
                account_id == "7"
            );
            if account_id == "8" {
                assert!(state.owned_sessions("first-account-room").await.is_err());
            }
        } else {
            save_identity_binding(&state, &identity, "7", "first-account-room").await;
            first_binding = state.0.store.lock().await.rooms["first-account-room"]
                .account
                .clone();
            assert!(state
                .account_room_ticket(first_binding.as_ref().unwrap())
                .await
                .is_some());
        }
        identities.push((identity.device_id.clone(), identity.fingerprint.clone()));
        state.fence_account_state().await;
        assert!(state.0.account.runtime.lock().await.identity.is_none());
        assert!(state
            .account_room_ticket(first_binding.as_ref().unwrap())
            .await
            .is_none());
    }
    assert_ne!(identities[0], identities[1]);
    assert_eq!(identities[0], identities[2]);
    assert_eq!(vault.entries.lock().unwrap().len(), 2);
    let calls = vault.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.as_str() == "write:account:7")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.as_str() == "write:account:8")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.as_str() == "read:account:7")
            .count(),
        2
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.as_str() == "read:installation")
            .count(),
        0
    );
    drop(calls);
    server.kill().await.unwrap();
}

#[tokio::test]
async fn legacy_identity_is_copied_only_to_its_unique_persisted_account_owner() {
    let (legacy, stored) = Identity::generate().unwrap();
    let encoded = serde_json::to_string(&stored).unwrap();
    let vault = Arc::new(MemoryIdentityVault::default());
    *vault.legacy.lock().unwrap() = Some(encoded.clone());
    let db = Arc::new(Database::memory().unwrap());
    let initial = identity_state(db.clone(), vault.clone());
    save_identity_binding(&initial, &legacy, "7", "first-room").await;
    save_identity_binding(&initial, &legacy, "7", "second-room").await;
    let original_rooms = db.get_setting(STORE_KEY).unwrap();
    drop(initial);

    // Reload the persisted bindings, rather than supplying a caller-owned
    // account hint to the legacy credential.
    let state = identity_state(db.clone(), vault.clone());
    let migrated = scoped_identity(&state, "7").await;
    assert_eq!(migrated.device_id, legacy.device_id);
    assert_eq!(migrated.fingerprint, legacy.fingerprint);
    assert_eq!(vault.entries.lock().unwrap()["account:7"], encoded);
    assert_eq!(vault.legacy.lock().unwrap().as_ref(), Some(&encoded));
    assert_eq!(db.get_setting(STORE_KEY).unwrap(), original_rooms);

    // The cache is scoped even without an intervening fence. Another account
    // must receive a different identity, and returning restores the first one.
    let other = scoped_identity(&state, "8").await;
    assert_ne!(other.device_id, migrated.device_id);
    assert_ne!(other.fingerprint, migrated.fingerprint);
    let returned = scoped_identity(&state, "7").await;
    assert_eq!(returned.device_id, migrated.device_id);
    assert_eq!(returned.fingerprint, migrated.fingerprint);
    assert_eq!(vault.legacy.lock().unwrap().as_ref(), Some(&encoded));
}

#[tokio::test]
async fn unbound_foreign_ambiguous_or_mismatched_legacy_identity_is_preserved_without_claiming_it()
{
    let (legacy, stored) = Identity::generate().unwrap();
    let encoded = serde_json::to_string(&stored).unwrap();
    for mode in [
        "unbound",
        "foreign",
        "ambiguous",
        "wrong-fingerprint",
        "wrong-device-id",
    ] {
        let vault = Arc::new(MemoryIdentityVault::default());
        *vault.legacy.lock().unwrap() = Some(encoded.clone());
        let db = Arc::new(Database::memory().unwrap());
        let initial = identity_state(db.clone(), vault.clone());
        match mode {
            "unbound" => {}
            "foreign" => save_identity_binding(&initial, &legacy, "8", "other-room").await,
            "ambiguous" => {
                save_identity_binding(&initial, &legacy, "7", "first-room").await;
                save_identity_binding(&initial, &legacy, "8", "other-room").await;
            }
            _ => {
                save_identity_binding(&initial, &legacy, "7", "first-room").await;
                let mut store = initial.0.store.lock().await;
                let binding = store
                    .rooms
                    .get_mut("first-room")
                    .unwrap()
                    .account
                    .as_mut()
                    .unwrap();
                if mode == "wrong-fingerprint" {
                    binding.desktop_fingerprint = "0".repeat(64);
                } else {
                    binding.desktop_device_id = uuid::Uuid::new_v4().to_string();
                }
                initial.save(&store).unwrap();
            }
        }
        let original_rooms = db.get_setting(STORE_KEY).unwrap();
        drop(initial);
        let state = identity_state(db.clone(), vault.clone());
        let fresh = scoped_identity(&state, "7").await;
        assert_ne!(fresh.device_id, legacy.device_id, "{mode}");
        assert_ne!(fresh.fingerprint, legacy.fingerprint, "{mode}");
        assert_eq!(
            vault.legacy.lock().unwrap().as_ref(),
            Some(&encoded),
            "{mode}"
        );
        assert_eq!(db.get_setting(STORE_KEY).unwrap(), original_rooms, "{mode}");
        assert!(vault.entries.lock().unwrap().contains_key("account:7"));
        if mode == "foreign" {
            let owner = scoped_identity(&state, "8").await;
            assert_eq!(owner.device_id, legacy.device_id);
            assert_eq!(owner.fingerprint, legacy.fingerprint);
        }
    }
}

#[tokio::test]
async fn corrupt_scoped_identity_never_falls_back_to_or_overwrites_the_legacy_key() {
    let (_, stored) = Identity::generate().unwrap();
    let encoded_legacy = serde_json::to_string(&stored).unwrap();
    for damaged in [
        "not-json".to_owned(),
        json!({"deviceId":uuid::Uuid::new_v4(),"privateKey":"invalid-key"}).to_string(),
    ] {
        let vault = Arc::new(MemoryIdentityVault::default());
        *vault.legacy.lock().unwrap() = Some(encoded_legacy.clone());
        vault
            .entries
            .lock()
            .unwrap()
            .insert("account:7".into(), damaged.clone());
        let state = identity_state(Arc::new(Database::memory().unwrap()), vault.clone());
        assert!(state.identity("7", 0).await.is_err());
        assert!(state.0.account.runtime.lock().await.identity.is_none());
        assert_eq!(vault.entries.lock().unwrap()["account:7"], damaged);
        assert_eq!(vault.legacy.lock().unwrap().as_ref(), Some(&encoded_legacy));
        assert_eq!(*vault.calls.lock().unwrap(), ["read:account:7"]);
    }
}

#[tokio::test]
async fn corrupt_legacy_key_only_blocks_accounts_with_existing_candidate_room_bindings() {
    let (old, _) = Identity::generate().unwrap();
    for owner in [None, Some("8"), Some("7")] {
        let vault = Arc::new(MemoryIdentityVault::default());
        *vault.legacy.lock().unwrap() = Some("corrupt legacy entry kept unchanged".into());
        let db = Arc::new(Database::memory().unwrap());
        let initial = identity_state(db.clone(), vault.clone());
        if let Some(owner) = owner {
            save_identity_binding(&initial, &old, owner, "old-room").await;
        }
        let original_rooms = db.get_setting(STORE_KEY).unwrap();
        drop(initial);
        let state = identity_state(db.clone(), vault.clone());
        let result = state.identity("7", 0).await;
        assert_eq!(result.is_ok(), owner != Some("7"));
        assert_eq!(
            vault.entries.lock().unwrap().contains_key("account:7"),
            owner != Some("7")
        );
        assert_eq!(
            vault
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call == "read:installation"),
            owner == Some("7")
        );
        assert_eq!(
            vault.legacy.lock().unwrap().as_deref(),
            Some("corrupt legacy entry kept unchanged")
        );
        assert_eq!(db.get_setting(STORE_KEY).unwrap(), original_rooms);
    }
}

#[derive(Default)]
struct MemoryRoomVault(SyncMutex<BTreeMap<String, Secret>>);
impl Vault for MemoryRoomVault {
    fn read(&self, id: &str) -> Result<Secret, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("missing".into())
    }
    fn write(&self, id: &str, value: &Secret) -> Result<(), String> {
        self.0.lock().unwrap().insert(id.into(), value.clone());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}
fn fixture() -> (Identity, EnrollmentRequest) {
    let stamp = now();
    let v: Value = serde_json::from_str(include_str!(
        "../../../../docs/architecture/fixtures/companion-account-v2-vector.json"
    ))
    .unwrap();
    let identity = Identity::load(&StoredIdentity {
        device_id: v["desktopDeviceId"].as_str().unwrap().into(),
        private_key: v["desktop"]["privateKeyPkcs8"].as_str().unwrap().into(),
    })
    .unwrap();
    let request:EnrollmentRequest=serde_json::from_value(json!({"requestId":v["requestId"],"accountId":v["accountId"],"challenge":v["challenge"],"desktop":{"deviceId":v["desktopDeviceId"],"deviceName":"Fixture desktop","kind":"desktop","publicKey":v["desktop"]["publicKey"],"fingerprint":v["desktop"]["fingerprint"],"online":true,"lastSeenAt":stamp},"phone":{"deviceId":v["phoneDeviceId"],"deviceName":"Fixture phone","kind":"phone","publicKey":v["phone"]["publicKey"],"fingerprint":v["phone"]["fingerprint"],"online":true,"lastSeenAt":stamp},"createdAt":stamp,"expiresAt":stamp+WINDOW_MS,"status":"pending"})).unwrap();
    (identity, request)
}
fn secret() -> Secret {
    Secret {
        desktop_token: "a".repeat(64),
        phone_token: "b".repeat(64),
        key: [9; 32],
    }
}
fn binding(request: &EnrollmentRequest, envelope: &Value) -> AccountRoom {
    AccountRoom {
        account_id: request.account_id.clone(),
        challenge: request.challenge.clone(),
        request_id: request.request_id.clone(),
        desktop_device_id: request.desktop.device_id.clone(),
        phone_device_id: request.phone.device_id.clone(),
        desktop_fingerprint: request.desktop.fingerprint.clone(),
        phone_fingerprint: request.phone.fingerprint.clone(),
        envelope_hash: keys::envelope_hash(envelope).unwrap(),
    }
}

#[test]
fn identity_roundtrip_and_ticket_directory_bindings_reject_substitution() {
    let (identity, stored) = Identity::generate().unwrap();
    let restored = Identity::load(&stored).unwrap();
    assert_eq!(identity.fingerprint, restored.fingerprint);
    assert_eq!(identity.device_id, restored.device_id);
    let (identity, request) = fixture();
    let response = json!({"v":2,"accountId":"7","deviceToken":"owned-device-ticket-aaaaaaaaaaaaaaaaaaaa","expiresAt":now()+900_000,"device":request.desktop});
    assert!(parse_ticket(response.clone(), "7", &identity, now()).is_ok());
    for changed in [
        json!({"accountId":"8"}),
        json!({"expiresAt":now()-1}),
        json!({"expiresAt":now()+1_800_000}),
        json!({"device":request.phone}),
        json!({"deviceToken":"bad\ncredential"}),
    ] {
        let mut value = response.clone();
        for (k, v) in changed.as_object().unwrap() {
            value[k] = v.clone();
        }
        assert!(parse_ticket(value, "7", &identity, now()).is_err());
    }
    assert!(validate_request(&request, "8", &identity, &Settings::default(), true).is_err());
    let mut settings = Settings::default();
    settings
        .peers
        .insert(format!("7:{}", request.phone.device_id), "0".repeat(64));
    assert!(validate_request(&request, "7", &identity, &settings, true).is_err());
    let mut old = request.clone();
    old.expires_at = now() - 1;
    old.created_at = old.expires_at - 1000;
    assert!(validate_request(&old, "7", &identity, &Settings::default(), true).is_err());
    assert!(Api::new("http://evil.example/v2", true).is_err());
    assert!(Api::new("https://u:p@lolicode.com/v2", false).is_err());
    assert!(Api::new("https://lolicode.com/v2?token=x", false).is_err());
}
#[tokio::test]
async fn pending_enrollment_save_failure_rolls_back_only_its_vault_secret_and_preserves_corruption()
{
    let (identity, request) = fixture();
    let db = Arc::new(Database::memory().unwrap());
    db.set_setting(STORE_KEY, "broken original").unwrap();
    let vault = Arc::new(MemoryRoomVault::default());
    let state = MobileCompanionState::with_vault(db.clone(), vault.clone());
    let envelope = keys::seal(&identity, &request, &json!({"fixture":true})).unwrap();
    assert!(state
        .persist_pending_account_room(
            &"1".repeat(32),
            &secret(),
            &request,
            binding(&request, &envelope)
        )
        .await
        .is_err());
    assert!(vault.0.lock().unwrap().is_empty());
    assert_eq!(
        db.get_setting(STORE_KEY).unwrap().as_deref(),
        Some("broken original")
    );
    db.set_setting(SETTINGS, "invalid settings").unwrap();
    assert!(state.save_account(&Settings::default()).is_err());
    assert_eq!(
        db.get_setting(SETTINGS).unwrap().as_deref(),
        Some("invalid settings")
    );
}
#[tokio::test]
async fn account_fence_expires_all_authority_without_disclosing_or_reassigning_old_rooms() {
    let (identity, request) = fixture();
    let db = Arc::new(Database::memory().unwrap());
    let state = MobileCompanionState::with_vault(db.clone(), Arc::new(MemoryRoomVault::default()));
    let envelope = keys::seal(&identity, &request, &json!({"fixture":true})).unwrap();
    let binding = binding(&request, &envelope);
    let room = "1".repeat(32);
    state
        .persist_pending_account_room(&room, &secret(), &request, binding.clone())
        .await
        .unwrap();
    state
        .0
        .store
        .lock()
        .await
        .rooms
        .get_mut(&room)
        .unwrap()
        .approved = true;
    {
        let mut runtime = state.0.account.runtime.lock().await;
        runtime.settings.enabled = true;
        runtime.account_id = Some("7".into());
        runtime.ticket = Some(Ticket {
            account_id: "7".into(),
            token: "never-render-this-ticket".into(),
            expires_at: now() + 900000,
            device: request.desktop.clone(),
        });
        let mut approved = request.clone();
        approved.envelope = Some(envelope);
        runtime.requests = vec![approved];
    }
    assert!(state.account_room_ticket(&binding).await.is_some());
    let status = serde_json::to_string(&state.account_status().await).unwrap();
    assert!(!status.contains("never-render"));
    assert!(!status.contains("ciphertext"));
    assert!(!status.contains(&"a".repeat(64)));
    let epoch = state.0.account.epoch.load(Ordering::SeqCst);
    state.fence_account_state().await;
    assert!(state.account_room_ticket(&binding).await.is_none());
    assert!(state.check_epoch(epoch).is_err());
    {
        let mut runtime = state.0.account.runtime.lock().await;
        runtime.suspended = false;
        runtime.account_id = Some("8".into());
        runtime.ticket = Some(Ticket {
            account_id: "8".into(),
            token: "foreign-ticket-not-authority".into(),
            expires_at: now() + 900000,
            device: request.desktop.clone(),
        });
    }
    assert!(state.account_room_ticket(&binding).await.is_none());
    assert!(state.owned_sessions(&room).await.is_err());
    let restored = MobileCompanionState::with_vault(db, Arc::new(MemoryRoomVault::default()));
    assert!(restored.account_room_ticket(&binding).await.is_none());
}
#[tokio::test]
async fn real_bounded_http_exchange_and_failed_approval_preserve_an_unconfirmed_room_without_secret_leaks(
) {
    let (identity, request) = fixture();
    let desktop = request.desktop.clone();
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let router=axum::Router::new().route("/v2/session",post(move|headers:axum::http::HeaderMap,Json(body):Json<Value>|{let desktop=desktop.clone();async move{assert_eq!(headers["authorization"],"Bearer lc1.7.owned-fixture-forum-token");assert_eq!(body["kind"],"desktop");assert_eq!(body["publicKey"],desktop.public_key);Json(json!({"v":2,"accountId":"7","deviceToken":"owned-device-ticket-aaaaaaaaaaaaaaaaaaaa","expiresAt":now()+900000,"device":desktop}))}})).route("/v2/requests/:id/approve",post(move|headers:axum::http::HeaderMap,Json(body):Json<Value>|{let requests=observed.clone();async move{assert_eq!(headers["authorization"],"Bearer owned-device-ticket-aaaaaaaaaaaaaaaaaaaa");let text=body.to_string();assert!(!text.contains(&"a".repeat(64)));assert!(!text.contains(&"b".repeat(64)));assert!(body.get("key").is_none());assert_eq!(body["desktopTokenHash"],crypto::hex(&Sha256::digest("a".repeat(64).as_bytes())));requests.fetch_add(1,Ordering::SeqCst);(StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":{"code":"fixture","message":"secret-body-must-not-leak"}}))).into_response()}}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api = Api::new(
        &format!("http://{}/v2", listener.local_addr().unwrap()),
        true,
    )
    .unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let value=api.call(reqwest::Method::POST,"/session","lc1.7.owned-fixture-forum-token",Some(json!({"deviceId":identity.device_id,"deviceName":"Fixture","kind":"desktop","publicKey":identity.public_key}))).await.unwrap();
    let ticket = parse_ticket(value, "7", &identity, now()).unwrap();
    let state = MobileCompanionState::with_vault(
        Arc::new(Database::memory().unwrap()),
        Arc::new(MemoryRoomVault::default()),
    );
    let envelope = keys::seal(&identity, &request, &json!({"fixture":true})).unwrap();
    let room = "1".repeat(32);
    state
        .persist_pending_account_room(&room, &secret(), &request, binding(&request, &envelope))
        .await
        .unwrap();
    let error=api.call(reqwest::Method::POST,&format!("/requests/{}/approve",request.request_id),&ticket.token,Some(json!({"roomId":room,"desktopTokenHash":crypto::hex(&Sha256::digest("a".repeat(64).as_bytes())),"phoneTokenHash":crypto::hex(&Sha256::digest("b".repeat(64).as_bytes())),"envelope":envelope}))).await.unwrap_err();
    assert!(!error.contains("secret-body"));
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(!state.0.store.lock().await.rooms[&room].approved);
    assert!(state
        .account_room_ticket(
            state.0.store.lock().await.rooms[&room]
                .account
                .as_ref()
                .unwrap()
        )
        .await
        .is_none());
    server.abort();
}
