use super::*;

#[tokio::test]
async fn foreground_session_defaults_to_full_access_and_retains_it_after_reopen() {
    let fake = Fake::start(|_| text("unused")).await;
    let data = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let engine = NativeEngine::open(data.path().into()).await.unwrap();
    engine
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    let mut ids = Vec::new();
    for args in [json!({}), json!({"permissionMode": null})] {
        let session = engine.call("createSession", args).await.unwrap();
        assert_eq!(session["permissionMode"], "full_access");
        ids.push(session["id"].as_str().unwrap().to_owned());
    }
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    for id in ids {
        assert_eq!(
            snapshot(&reopened, &id).await["session"]["permissionMode"],
            "full_access"
        );
    }
    assert!(fake.requests.lock().unwrap().is_empty());
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn explicit_session_permission_choices_survive_restart_without_default_overrides() {
    let fake = Fake::start(|_| text("unused")).await;
    let data = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let engine = NativeEngine::open(data.path().into()).await.unwrap();
    engine
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    let mut saved = Vec::new();
    for permission in ["ask", "auto", "full_access"] {
        let session = engine
            .call("createSession", json!({"permissionMode": permission}))
            .await
            .unwrap();
        assert_eq!(session["permissionMode"], permission);
        saved.push((session["id"].as_str().unwrap().to_owned(), permission));
    }
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    for (id, permission) in saved {
        assert_eq!(
            snapshot(&reopened, &id).await["session"]["permissionMode"],
            permission
        );
    }
    assert!(fake.requests.lock().unwrap().is_empty());
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn background_session_defaults_to_ask_and_rejects_full_access() {
    let fake = Fake::start(|_| text("unused")).await;
    let data = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let engine = NativeEngine::open(data.path().into()).await.unwrap();
    engine
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    let mut ids = Vec::new();
    for args in [
        json!({"backgroundOnly": true}),
        json!({"backgroundOnly": true, "permissionMode": null}),
    ] {
        let session = engine.call("createSession", args).await.unwrap();
        assert_eq!(session["permissionMode"], "ask");
        let id = session["id"].as_str().unwrap().to_owned();
        for permission in ["auto", "full_access"] {
            assert!(engine
                .call(
                    "updateSession",
                    json!({"sessionId": id, "permissionMode": permission}),
                )
                .await
                .is_err());
        }
        ids.push(id);
    }
    for permission in ["auto", "full_access"] {
        assert!(engine
            .call(
                "createSession",
                json!({"backgroundOnly": true, "permissionMode": permission}),
            )
            .await
            .is_err());
    }
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    for id in ids {
        assert_eq!(
            snapshot(&reopened, &id).await["session"]["permissionMode"],
            "ask"
        );
    }
    assert!(fake.requests.lock().unwrap().is_empty());
    reopened.shutdown().await.unwrap();
}
