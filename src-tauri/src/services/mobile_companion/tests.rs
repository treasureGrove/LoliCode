use super::*;
use ring::aead;
use std::sync::Mutex as StdMutex;

#[derive(Default)]
struct MemoryVault(StdMutex<BTreeMap<String, Secret>>);
impl Vault for MemoryVault {
    fn read(&self, room: &str) -> Result<Secret, String> {
        self.0
            .lock()
            .unwrap()
            .get(room)
            .cloned()
            .ok_or("missing".into())
    }
    fn write(&self, room: &str, secret: &Secret) -> Result<(), String> {
        self.0.lock().unwrap().insert(room.into(), secret.clone());
        Ok(())
    }
    fn delete(&self, room: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(room);
        Ok(())
    }
}
pub(super) fn fixture_room(approved: bool) -> Room {
    Room {
        account: None,
        relay_url: "wss://example.invalid/companion".into(),
        expires_at: now() + WINDOW_MS,
        approved,
        revoked: false,
        device_id: Some("phone-a".into()),
        device_name: Some("Pixel".into()),
        sessions: BTreeSet::from(["lc:owned".into()]),
        shared_sessions: BTreeSet::new(),
        requests: BTreeMap::new(),
        seen_packets: BTreeMap::new(),
        events: BTreeMap::new(),
        active_requests: BTreeMap::new(),
        event_keys: BTreeSet::new(),
    }
}
fn phone_packet(key: &[u8; 32], room: &str, body: Value) -> Value {
    let nonce = crypto::random::<12>().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut bytes = serde_json::to_vec(&body).unwrap();
    let cipher = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).unwrap());
    cipher
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(format!("lolicode-companion/1|{room}|phone|{id}")),
            &mut bytes,
        )
        .unwrap();
    json!({"type":"packet","v":1,"from":"phone","id":id,"nonce":crypto::encode(&nonce),"ciphertext":crypto::encode(&bytes)})
}
#[test]
fn authenticated_packet_rejects_tamper_role_room_and_old_timestamps() {
    let key = crypto::random::<32>().unwrap();
    let body =
        json!({"type":"pair.request","deviceId":"phone","deviceName":"Pixel","sentAt":now()});
    let packet = phone_packet(&key, "room-a", body.clone());
    assert_eq!(
        crypto::open(&key, "room-a", &packet, now()).unwrap().1,
        body
    );
    assert!(crypto::open(&key, "room-b", &packet, now()).is_err());
    let mut wrong_role = packet.clone();
    wrong_role["from"] = json!("desktop");
    assert!(crypto::open(&key, "room-a", &wrong_role, now()).is_err());
    let mut tampered = packet.clone();
    let text = tampered["ciphertext"].as_str().unwrap().to_owned();
    tampered["ciphertext"] = json!(format!(
        "{}{}",
        if text.starts_with('A') { "B" } else { "A" },
        &text[1..]
    ));
    assert!(crypto::open(&key, "room-a", &tampered, now()).is_err());
    assert!(crypto::open(&key, "room-a", &packet, now() + WINDOW_MS + 100).is_err());
    let reflected = crypto::seal(&key, "room-a", &body).unwrap();
    assert!(crypto::open(&key, "room-a", &reflected, now()).is_err());
}
#[test]
fn fingerprint_covers_complete_params_but_ignores_envelope_time_and_object_order() {
    let original =
        json!({"method":"message.send","params":{"sessionId":"lc:a","text":"one\ntwo"},"sentAt":1});
    let reordered: Value = serde_json::from_str(
        r#"{"sentAt":2,"params":{"text":"one\ntwo","sessionId":"lc:a"},"method":"message.send"}"#,
    )
    .unwrap();
    assert_eq!(
        request_fingerprint(&original),
        request_fingerprint(&reordered)
    );
    for replacement in [
        json!({"method":"run.cancel","params":original["params"]}),
        json!({"method":"message.send","params":{"sessionId":"lc:b","text":"one\ntwo"}}),
        json!({"method":"message.send","params":{"sessionId":"lc:a","text":"different"}}),
    ] {
        assert_ne!(
            request_fingerprint(&original),
            request_fingerprint(&replacement)
        );
    }
}
#[tokio::test]
async fn room_ownership_and_pending_approvals_survive_restart_without_secret_leaks() {
    let db = Arc::new(Database::memory().unwrap());
    let vault = Arc::new(MemoryVault::default());
    let state = MobileCompanionState::with_vault(db.clone(), vault.clone());
    let secret = Secret {
        desktop_token: "desktop-secret".into(),
        phone_token: "phone-secret".into(),
        key: [27; 32],
    };
    vault.write("room-a", &secret).unwrap();
    {
        let mut store = state.0.store.lock().await;
        store.rooms.insert("room-a".into(), fixture_room(true));
        store.rooms.insert("room-b".into(), fixture_room(false));
        state.save(&store).unwrap();
    }
    let restored = MobileCompanionState::with_vault(db.clone(), vault.clone());
    assert!(restored
        .owned_sessions("room-a")
        .await
        .unwrap()
        .contains("lc:owned"));
    assert!(restored.owned_sessions("room-b").await.is_err());
    assert!(!restored
        .owned_sessions("room-a")
        .await
        .unwrap()
        .contains("lc:desktop-private"));
    let status = serde_json::to_string(&restored.status().await).unwrap();
    let saved = db.get_setting(STORE_KEY).unwrap().unwrap();
    for text in [status, saved] {
        assert!(!text.contains("desktop-secret"));
        assert!(!text.contains("phone-secret"));
        assert!(!text.contains("27,27"));
    }
    assert!(restored.approve("room-b", "different-phone").await.is_err());
    restored.approve("room-b", "phone-a").await.unwrap();
    assert!(restored.owned_sessions("room-b").await.is_ok());
    {
        let mut store = restored.0.store.lock().await;
        store.rooms.get_mut("room-a").unwrap().revoked = true;
        restored.save(&store).unwrap();
    }
    let again = MobileCompanionState::with_vault(db, vault);
    assert!(again.owned_sessions("room-a").await.is_err());
}
#[tokio::test]
async fn expired_pairing_cannot_be_approved_and_corruption_is_preserved() {
    let db = Arc::new(Database::memory().unwrap());
    let state = MobileCompanionState::with_vault(db.clone(), Arc::new(MemoryVault::default()));
    {
        let mut store = state.0.store.lock().await;
        let mut room = fixture_room(false);
        room.expires_at = now() - 1;
        store.rooms.insert("expired".into(), room);
    }
    assert!(state.approve("expired", "phone-a").await.is_err());
    db.set_setting(STORE_KEY, "{invalid").unwrap();
    let corrupt = MobileCompanionState::with_vault(db.clone(), Arc::new(MemoryVault::default()));
    assert!(corrupt.save(&Store::default()).is_err());
    assert_eq!(
        db.get_setting(STORE_KEY).unwrap().as_deref(),
        Some("{invalid")
    );
    assert!(corrupt.status().await.last_error.is_some());
}
#[test]
fn public_relay_requires_wss_and_never_accepts_credentials_or_query() {
    assert!(validate_relay("wss://relay.example/companion").is_ok());
    for url in [
        "ws://relay.example/companion",
        "wss://u:p@relay.example/companion",
        "wss://relay.example/companion?token=secret",
        "https://relay.example/companion",
        "wss://relay.example/companion#secret",
    ] {
        assert!(validate_relay(url).is_err(), "{url}");
    }
}

#[test]
fn mutation_receipts_never_replay_uncertain_requests_or_accept_changed_payload() {
    let pending = Receipt {
        payload: "original-hash".into(),
        response: None,
        read_only: false,
    };
    assert!(receipt_replay(&pending, "id", "different-hash").is_err());
    let uncertain = receipt_replay(&pending, "id", "original-hash")
        .unwrap()
        .unwrap();
    assert_eq!(uncertain["ok"], false);
    assert!(uncertain.to_string().contains("未重新执行"));
    let completed = response("id", Ok(json!({"accepted":true})));
    let cached = Receipt {
        response: Some(completed.clone()),
        ..pending
    };
    assert_eq!(
        receipt_replay(&cached, "id", "original-hash").unwrap(),
        Some(completed)
    );
    let restored: Receipt = serde_json::from_str(&serde_json::to_string(&cached).unwrap()).unwrap();
    assert_eq!(
        receipt_replay(&restored, "id", "original-hash").unwrap(),
        cached.response
    );
}

#[tokio::test]
async fn offline_revocation_cleanup_authenticates_and_deletes_vault_only_after_relay_ack() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/companion", listener.local_addr().unwrap());
    let relay = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let hello = socket.next().await.unwrap().unwrap().into_text().unwrap();
        let value: Value = serde_json::from_str(&hello).unwrap();
        assert_eq!(value["role"], "desktop");
        assert_eq!(value["token"], "desktop-test-token");
        socket
            .send(Message::Text(json!({"type":"ready","v":1}).to_string()))
            .await
            .unwrap();
        let command: Value =
            serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap())
                .unwrap();
        assert_eq!(command["type"], "room.revoke");
        socket
            .send(Message::Text(json!({"type":"room.revoked"}).to_string()))
            .await
            .unwrap();
    });
    let vault = Arc::new(MemoryVault::default());
    vault
        .write(
            "room",
            &Secret {
                desktop_token: "desktop-test-token".into(),
                phone_token: "phone-test-token".into(),
                key: [9; 32],
            },
        )
        .unwrap();
    let state =
        MobileCompanionState::with_vault(Arc::new(Database::memory().unwrap()), vault.clone());
    state.start_revoke_cleanup("room".into(), url);
    tokio::time::timeout(Duration::from_secs(5), async {
        relay.await.unwrap();
        while vault.read("room").is_ok() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn read_polling_never_fills_mutation_ledger_and_legacy_read_receipts_are_pruned() {
    let mut room = fixture_room(true);
    for index in 0..(MAX_RECORDS + 100) {
        assert!(
            admit_request(&mut room, &format!("read-{index}"), "read-hash", true)
                .unwrap()
                .is_none()
        );
    }
    assert!(room.requests.is_empty());
    admit_request(&mut room, "mutation", "write-hash", false).unwrap();
    assert!(admit_request(&mut room, "mutation", "different-read-hash", true).is_err());
    assert_eq!(room.requests.len(), 1);
    room.requests.insert(
        "old-read".into(),
        Receipt {
            payload: "old-read-hash".into(),
            response: None,
            read_only: true,
        },
    );
    let db = Arc::new(Database::memory().unwrap());
    let mut store = Store::default();
    store.rooms.insert("room".into(), room);
    db.set_setting(STORE_KEY, &serde_json::to_string(&store).unwrap())
        .unwrap();
    let restored = MobileCompanionState::with_vault(db, Arc::new(MemoryVault::default()));
    let store = restored.0.store.lock().await;
    let requests = &store.rooms["room"].requests;
    assert_eq!(requests.len(), 1);
    assert!(requests.contains_key("mutation"));
    assert!(!requests.contains_key("old-read"));
}

#[tokio::test]
async fn approval_confirmations_are_reconstructed_from_persistent_state_after_reconnect() {
    let db = Arc::new(Database::memory().unwrap());
    let vault = Arc::new(MemoryVault::default());
    let state = MobileCompanionState::with_vault(db.clone(), vault.clone());
    {
        let mut store = state.0.store.lock().await;
        store.rooms.insert("room".into(), fixture_room(false));
        state.save(&store).unwrap();
    }
    assert!(state.approval_message("room").await.is_none());
    // No WebSocket/control receiver exists here: the volatile notification is
    // intentionally lost, exactly as when approval races a reconnect handshake.
    state.approve("room", "phone-a").await.unwrap();
    let restored = MobileCompanionState::with_vault(db, vault);
    for _ready_or_peer_online in 0..3 {
        let message = restored.approval_message("room").await.unwrap();
        assert_eq!(message["type"], "pair.approved");
        assert_eq!(message["deviceId"], "phone-a");
    }
}
