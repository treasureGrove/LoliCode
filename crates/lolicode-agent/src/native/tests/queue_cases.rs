use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

fn current_user(input: &Value) -> &str {
    let content = &input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .unwrap()["content"];
    content
        .as_str()
        .unwrap_or_else(|| content[0]["text"].as_str().unwrap())
}

fn paused_text() -> Reply {
    let mut reply = text("FIRST_REPLY");
    reply.pause = true;
    reply
}

async fn enqueue(engine: &NativeEngine, id: &str, request: &str, text: &str) {
    engine
        .call(
            "enqueueMessage",
            json!({"sessionId":id,"requestId":request,"text":text}),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn queued_messages_run_fifo_once_after_success_even_when_another_project_is_selected() {
    let fake = Fake::start(|input| {
        if current_user(input) == "first" {
            paused_text()
        } else {
            text("QUEUED_REPLY")
        }
    })
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    send(&engine, &id, "first", "first").await;
    wait(&engine, &id, |_| fake.count() == 1).await;
    enqueue(&engine, &id, "second", "second").await;
    enqueue(&engine, &id, "third", "third").await;
    enqueue(&engine, &id, "second", "second").await;
    let before = snapshot(&engine, &id).await;
    assert_eq!(before["queuedMessages"].as_array().unwrap().len(), 2);
    assert_eq!(
        before["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "user")
            .count(),
        1
    );
    let other = TempDir::new().unwrap();
    engine
        .bind(other.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    fake.resume.notify_one();
    let done = wait(&engine, &id, |snapshot| {
        snapshot["status"] == "idle"
            && snapshot["queuedMessages"] == json!([])
            && snapshot["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] == "user")
                .count()
                == 3
    })
    .await;
    assert_eq!(done["queuePaused"], false);
    let requests = fake.requests.lock().unwrap();
    assert_eq!(
        requests.iter().map(current_user).collect::<Vec<_>>(),
        ["first", "second", "third"]
    );
    assert!(requests.iter().all(|input| input["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains(&project.path().to_string_lossy().into_owned())));
    drop(requests);
    enqueue(&engine, &id, "second", "second").await;
    assert_eq!(
        fake.count(),
        3,
        "a duplicate acknowledgement must never replay a queued turn"
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn queue_snapshots_omit_attachment_payloads_and_withdrawals_are_recoverable_after_restart() {
    let fake = Fake::start(|_| paused_text()).await;
    let (data, project, engine, id) = setup(&fake).await;
    send(&engine, &id, "first", "first").await;
    wait(&engine, &id, |_| fake.count() == 1).await;
    let attachments = json!([
        {"ref":"data:image/png;base64,UFJJVkFURV9QSVhFTFM=","fileName":"private.png","mime":"image/png","bytes":14},
        {"dataBase64":"UFJJVkFURV9ET0NVTUVOVA==","fileName":"private.txt","mime":"text/plain","bytes":16},
        {"localPath":"D:/private/source.md","fileName":"source.md","mime":"text/markdown","bytes":12}
    ]);
    let args = json!({"sessionId":id,"requestId":"with-media","text":"inspect attachments","locale":"zh","attachments":attachments});
    engine.call("enqueueMessage", args.clone()).await.unwrap();
    engine.call("enqueueMessage", args.clone()).await.unwrap();
    let queued = snapshot(&engine, &id).await;
    assert_eq!(
        queued["queuedMessages"][0]["attachments"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert!(!queued.to_string().contains("UFJJVkFURV"));
    assert!(!queued.to_string().contains("D:/private"));
    let mut changed = args.clone();
    changed["attachments"][0]["ref"] = json!("data:image/png;base64,RElGRkVSRU5U");
    assert!(engine.call("enqueueMessage", changed).await.is_err());
    for (key, value) in [("locale", json!("en")), ("backgroundOnly", json!(true))] {
        let mut changed = args.clone();
        changed[key] = value;
        assert!(engine.call("enqueueMessage", changed).await.is_err());
    }
    let remove = json!({"sessionId":id,"requestId":"with-media"});
    let withdrawn = engine
        .call("removeQueuedMessage", remove.clone())
        .await
        .unwrap();
    assert_eq!(withdrawn["attachments"], attachments);
    assert_eq!(
        engine
            .call("removeQueuedMessage", remove.clone())
            .await
            .unwrap(),
        withdrawn
    );
    assert_eq!(snapshot(&engine, &id).await["queuedMessages"], json!([]));
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    assert_eq!(
        reopened.call("removeQueuedMessage", remove).await.unwrap(),
        withdrawn
    );
    reopened.call("enqueueMessage", args).await.unwrap();
    assert_eq!(
        snapshot(&reopened, &id).await["queuedMessages"],
        json!([]),
        "replaying enqueue after withdrawal must not resurrect it"
    );
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn stopping_or_failing_a_turn_pauses_the_queue_until_an_explicit_send() {
    for fail in [false, true] {
        let fake = Fake::start(move |input| {
            if current_user(input) == "first" {
                if fail {
                    Reply {
                        frames: vec![json!({"error":{"code":"unsupported_parameter"}})],
                        pause: true,
                        status: 200,
                        json_response: false,
                    }
                } else {
                    paused_text()
                }
            } else {
                text("RECOVERED_QUEUE")
            }
        })
        .await;
        let (_data, _project, engine, id) = setup(&fake).await;
        if fail {
            engine
                .call("interruptSession", json!({"sessionId":id}))
                .await
                .unwrap();
            enqueue(&engine, &id, "first", "first").await;
            enqueue(&engine, &id, "second", "second").await;
            engine
                .call(
                    "sendQueuedMessageNow",
                    json!({"sessionId":id,"requestId":"first"}),
                )
                .await
                .unwrap();
        } else {
            send(&engine, &id, "first", "first").await;
            wait(&engine, &id, |_| fake.count() == 1).await;
            enqueue(&engine, &id, "second", "second").await;
            engine
                .call("interruptSession", json!({"sessionId":id}))
                .await
                .unwrap();
        }
        let paused = wait(&engine, &id, |snapshot| {
            snapshot["status"] == if fail { "error" } else { "idle" }
        })
        .await;
        assert_eq!(paused["queuePaused"], true);
        assert_eq!(paused["queuedMessages"][0]["id"], "second");
        assert_eq!(fake.count(), 1);
        engine
            .call(
                "sendQueuedMessageNow",
                json!({"sessionId":id,"requestId":"second"}),
            )
            .await
            .unwrap();
        let done = wait(&engine, &id, |snapshot| {
            snapshot["status"] == "idle" && snapshot["queuedMessages"] == json!([])
        })
        .await;
        assert!(done.to_string().contains("RECOVERED_QUEUE"));
        assert_eq!(fake.count(), 2);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn a_saved_queue_is_paused_after_restart_and_withdrawal_does_not_dispatch_it() {
    let fake = Fake::start(|input| {
        if current_user(input) == "first" {
            paused_text()
        } else {
            text("AFTER_RESTART")
        }
    })
    .await;
    let (data, project, engine, id) = setup(&fake).await;
    send(&engine, &id, "first", "first").await;
    wait(&engine, &id, |_| fake.count() == 1).await;
    enqueue(&engine, &id, "later", "later").await;
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    let paused = snapshot(&reopened, &id).await;
    assert_eq!(paused["queuePaused"], true);
    assert_eq!(paused["queuedMessages"][0]["id"], "later");
    assert_eq!(fake.count(), 1);
    reopened
        .call(
            "sendQueuedMessageNow",
            json!({"sessionId":id,"requestId":"later"}),
        )
        .await
        .unwrap();
    wait(&reopened, &id, |snapshot| {
        snapshot["status"] == "idle" && snapshot["queuedMessages"] == json!([])
    })
    .await;
    assert_eq!(fake.count(), 2);
    reopened.shutdown().await.unwrap();
}

struct CleanupHost {
    started: AtomicBool,
    cleaned: AtomicBool,
    release: tokio::sync::Notify,
}
impl applications::ApplicationTools for CleanupHost {
    fn schemas(&self) -> Vec<Value> {
        vec![
            json!({"type":"function","function":{"name":"queue_cleanup","description":"fixture","parameters":{"type":"object"}}}),
        ]
    }
    fn inspect(
        &self,
        _: &std::path::Path,
        name: &str,
        _: &Value,
    ) -> Option<Result<applications::ToolInspection, String>> {
        (name == "queue_cleanup").then(|| {
            Ok(applications::ToolInspection {
                action: "fixture".into(),
                resources: vec![],
                description: "fixture".into(),
                mutating: false,
                requires_approval: false,
                dangerous: false,
            })
        })
    }
    fn execute<'a>(
        &'a self,
        _: &'a std::path::Path,
        _: &'a str,
        _: &'a Value,
        mut cancel: tokio::sync::watch::Receiver<bool>,
    ) -> applications::ApplicationResult<'a> {
        Box::pin(async move {
            self.started.store(true, Ordering::SeqCst);
            super::super::inference::cancelled(&mut cancel).await;
            self.release.notified().await;
            self.cleaned.store(true, Ordering::SeqCst);
            Err(super::super::inference::CANCELLED.into())
        })
    }
}

#[tokio::test]
async fn send_now_is_nonblocking_waits_for_tool_cleanup_and_never_reinterrupts_after_a_lost_ack() {
    let host = Arc::new(CleanupHost {
        started: false.into(),
        cleaned: false.into(),
        release: tokio::sync::Notify::new(),
    });
    let checked = host.clone();
    let fake = Fake::start(move |input| match current_user(input) {
        "first" => tool("queue_cleanup", json!({})),
        "priority" => {
            assert!(checked.cleaned.load(Ordering::SeqCst));
            paused_text()
        }
        _ => text("FINAL_QUEUE_REPLY"),
    })
    .await;
    let (_data, _project, engine, id) = setup(&fake).await;
    engine.set_application_tools(host.clone()).await;
    send(&engine, &id, "first", "first").await;
    wait(&engine, &id, |_| host.started.load(Ordering::SeqCst)).await;
    enqueue(&engine, &id, "older", "older").await;
    enqueue(&engine, &id, "priority", "priority").await;
    let priority = json!({"sessionId":id,"requestId":"priority"});
    tokio::time::timeout(
        Duration::from_millis(500),
        engine.call("sendQueuedMessageNow", priority.clone()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!host.cleaned.load(Ordering::SeqCst));
    assert_eq!(
        fake.count(),
        1,
        "priority cannot run concurrently with cleanup"
    );
    host.release.notify_one();
    wait(&engine, &id, |_| fake.count() == 2).await;
    engine.call("sendQueuedMessageNow", priority).await.unwrap();
    assert_eq!(snapshot(&engine, &id).await["status"], "running");
    assert!(engine
        .call(
            "removeQueuedMessage",
            json!({"sessionId":id,"requestId":"priority"})
        )
        .await
        .is_err());
    fake.resume.notify_one();
    wait(&engine, &id, |snapshot| {
        snapshot["status"] == "idle" && snapshot["queuedMessages"] == json!([])
    })
    .await;
    assert_eq!(
        fake.requests
            .lock()
            .unwrap()
            .iter()
            .map(current_user)
            .collect::<Vec<_>>(),
        ["first", "priority", "older"]
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn stop_after_send_now_cancels_the_override_and_keeps_queued_work_paused() {
    let host = Arc::new(CleanupHost {
        started: false.into(),
        cleaned: false.into(),
        release: tokio::sync::Notify::new(),
    });
    let fake = Fake::start(|_| tool("queue_cleanup", json!({}))).await;
    let (_data, _project, engine, id) = setup(&fake).await;
    engine.set_application_tools(host.clone()).await;
    send(&engine, &id, "first", "first").await;
    wait(&engine, &id, |_| host.started.load(Ordering::SeqCst)).await;
    enqueue(&engine, &id, "priority", "priority").await;
    engine
        .call(
            "sendQueuedMessageNow",
            json!({"sessionId":id,"requestId":"priority"}),
        )
        .await
        .unwrap();
    engine
        .call("interruptSession", json!({"sessionId":id}))
        .await
        .unwrap();
    host.release.notify_one();
    let stopped = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert_eq!(stopped["queuePaused"], true);
    assert_eq!(stopped["queuedMessages"][0]["id"], "priority");
    assert_eq!(fake.count(), 1);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn withdrawing_the_priority_while_cleanup_is_pending_does_not_send_another_item() {
    let host = Arc::new(CleanupHost {
        started: false.into(),
        cleaned: false.into(),
        release: tokio::sync::Notify::new(),
    });
    let fake = Fake::start(|_| tool("queue_cleanup", json!({}))).await;
    let (_data, _project, engine, id) = setup(&fake).await;
    engine.set_application_tools(host.clone()).await;
    send(&engine, &id, "first", "first").await;
    wait(&engine, &id, |_| host.started.load(Ordering::SeqCst)).await;
    enqueue(&engine, &id, "older", "older").await;
    enqueue(&engine, &id, "priority", "priority").await;
    engine
        .call(
            "sendQueuedMessageNow",
            json!({"sessionId":id,"requestId":"priority"}),
        )
        .await
        .unwrap();
    let withdrawn = engine
        .call(
            "removeQueuedMessage",
            json!({"sessionId":id,"requestId":"priority"}),
        )
        .await
        .unwrap();
    assert_eq!(withdrawn["text"], "priority");
    host.release.notify_one();
    let stopped = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert_eq!(stopped["queuePaused"], true);
    assert_eq!(stopped["queuedMessages"][0]["id"], "older");
    assert_eq!(fake.count(), 1);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn queue_capacity_and_failed_saves_preserve_prior_queue_and_receipts() {
    let fake = Fake::start(|_| text("SHOULD_NOT_RUN")).await;
    let (data, _project, engine, id) = setup(&fake).await;
    engine
        .call("interruptSession", json!({"sessionId":id}))
        .await
        .unwrap();
    for index in 0..32 {
        enqueue(&engine, &id, &format!("queued-{index}"), "queued").await;
    }
    assert!(engine
        .call(
            "enqueueMessage",
            json!({"sessionId":id,"requestId":"overflow","text":"overflow"})
        )
        .await
        .is_err());
    let before = snapshot(&engine, &id).await;
    let record = data
        .path()
        .join("sessions")
        .join(format!("{}.json", id.trim_start_matches("lc:")));
    let saved = tokio::fs::read(&record).await.unwrap();
    tokio::fs::remove_file(&record).await.unwrap();
    tokio::fs::create_dir(&record).await.unwrap();
    assert!(engine
        .call(
            "removeQueuedMessage",
            json!({"sessionId":id,"requestId":"queued-0"})
        )
        .await
        .is_err());
    assert_eq!(snapshot(&engine, &id).await, before);
    tokio::fs::remove_dir(&record).await.unwrap();
    tokio::fs::write(&record, saved).await.unwrap();
    assert_eq!(fake.count(), 0);
    engine.shutdown().await.unwrap();
}
