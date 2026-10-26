use super::*;
use axum::{http::StatusCode, response::IntoResponse, routing::post, Json};
use std::sync::{atomic::AtomicUsize, Mutex as SyncMutex};

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
