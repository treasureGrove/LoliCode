use super::*;
use sha2::{Digest, Sha256};

const MAX_QUEUED_MESSAGES: usize = 32;
const MAX_QUEUE_BYTES: usize = 24 * 1024 * 1024;
const MAX_WITHDRAWAL_RECEIPTS: usize = 20;

pub(super) fn parse_input(args: &Value) -> Result<QueuedMessageInput, String> {
    let text = arg(args, "text")?;
    let request_id = arg(args, "requestId")?;
    let attachments = match args.get("attachments") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) if items.len() <= 8 => items.clone(),
        _ => return Err("附件格式或数量无效".into()),
    };
    let images = image_message_parts(&attachments)?;
    if request_id.trim().is_empty()
        || request_id.len() > 256
        || (text.trim().is_empty() && images.is_empty())
        || text.len() > 1024 * 1024
    {
        return Err("消息或请求标识无效".into());
    }
    let locale = match args.get("locale") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if matches!(value.as_str(), "zh" | "zh-TW" | "en" | "ja") => {
            Some(value.clone())
        }
        _ => return Err("不支持的界面语言".into()),
    };
    let background_only = match args.get("backgroundOnly") {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return Err("后台执行标记必须为布尔值".into()),
    };
    Ok(QueuedMessageInput {
        request_id: request_id.into(),
        text: text.into(),
        attachments,
        locale,
        background_only,
        created_at: now(),
    })
}

#[cfg(test)]
mod handoff_tests {
    use super::*;
    use tempfile::TempDir;

    async fn fixture() -> (TempDir, TempDir, NativeEngine, String) {
        let data = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let engine = NativeEngine::open(data.path().into()).await.unwrap();
        let catalog = json!({"revision":1,"models":[{"id":"model","providerId":"lolicode","modelId":"channel/model","name":"Fixture","channelName":"Fixture","contextLimit":128000}],"defaultModel":"model"});
        engine
            .bind(
                project.path().into(),
                catalog,
                NativeGateway {
                    base_url: "http://127.0.0.1:1/v1".into(),
                    bearer_token: "private-local-fixture".into(),
                },
            )
            .await
            .unwrap();
        let id = engine.call("createSession", json!({})).await.unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        engine
            .call("interruptSession", json!({"sessionId":id}))
            .await
            .unwrap();
        engine
            .call(
                "enqueueMessage",
                json!({"sessionId":id,"requestId":"pending","text":"pending"}),
            )
            .await
            .unwrap();
        (data, project, engine, id)
    }

    #[tokio::test]
    async fn stop_between_handoff_selection_and_admission_never_starts_the_next_flight() {
        let (_data, _project, engine, id) = fixture().await;
        let entry = engine.entry(&id).await.unwrap();
        let args = {
            let mut state = entry.lock().await;
            state.stored.snapshot.queue_paused = false;
            input_args(&id, &state.stored.queued_inputs[0])
        };
        engine
            .call("interruptSession", json!({"sessionId":id}))
            .await
            .unwrap();
        assert!(engine.admit(&args, true).await.unwrap().is_none());
        let state = entry.lock().await;
        assert!(state.flight.is_none());
        assert_eq!(state.stored.queued_inputs.len(), 1);
        assert!(state.stored.snapshot.queue_paused);
        drop(state);
        engine.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn a_deleted_session_cannot_be_resurrected_by_a_stale_queue_handoff() {
        let (data, _project, engine, id) = fixture().await;
        let entry = engine.entry(&id).await.unwrap();
        entry.lock().await.stored.snapshot.queue_paused = false;
        engine
            .call("deleteSession", json!({"sessionId":id}))
            .await
            .unwrap();
        assert!(engine.admit_next_queued(entry).await.is_none());
        assert!(!persistence::session_path(data.path(), &id)
            .unwrap()
            .exists());
        assert!(engine.entry(&id).await.is_err());
        engine.shutdown().await.unwrap();
    }
}

pub(super) fn fingerprint(input: &QueuedMessageInput) -> Result<String, String> {
    let bytes = serde_json::to_vec(&json!({"text":input.text,"attachments":input.attachments,
        "locale":input.locale,"backgroundOnly":input.background_only}))
    .map_err(|_| "无法编码消息")?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

pub(super) fn check_fingerprint(
    record: &CommandRecord,
    input: &QueuedMessageInput,
    fingerprint: &str,
) -> Result<(), String> {
    if record.text != input.text {
        return Err("此请求标识已用于另一条消息，未重复发送".into());
    }
    if record
        .fingerprint
        .as_deref()
        .is_none_or(|saved| saved == fingerprint)
    {
        return Ok(());
    }
    // An admitted flight's background boundary is immutable. Preserve the
    // existing duplicate-ack behavior without allowing a queued input to be
    // replaced or a replay to weaken the running flight's tool scope.
    let admitted_scope_replay = if record.status != "queued" {
        let mut original_scope = input.clone();
        original_scope.background_only = !original_scope.background_only;
        record.fingerprint.as_deref() == Some(self::fingerprint(&original_scope)?.as_str())
    } else {
        false
    };
    if admitted_scope_replay {
        Ok(())
    } else {
        Err("此请求标识已用于另一条消息，未重复发送".into())
    }
}

pub(super) fn sync_snapshot(stored: &mut StoredSession) {
    stored.snapshot.queued_messages = stored
        .queued_inputs
        .iter()
        .map(|input| AgentQueuedMessage {
            id: input.request_id.clone(),
            text: input.text.clone(),
            created_at: input.created_at,
            delivery: None,
            attachments: input
                .attachments
                .iter()
                .map(|attachment| AgentQueuedAttachment {
                    file_name: attachment["fileName"].as_str().unwrap_or("附件").into(),
                    mime: attachment["mime"]
                        .as_str()
                        .unwrap_or("application/octet-stream")
                        .into(),
                    bytes: attachment["bytes"].as_u64().unwrap_or(0),
                })
                .collect(),
        })
        .collect();
}

fn input_args(session_id: &str, input: &QueuedMessageInput) -> Value {
    json!({"sessionId":session_id,"requestId":input.request_id,"text":input.text,
        "locale":input.locale,"attachments":input.attachments,"backgroundOnly":input.background_only})
}

fn encoded_size(inputs: &[QueuedMessageInput]) -> Result<usize, String> {
    serde_json::to_vec(inputs)
        .map(|bytes| bytes.len())
        .map_err(|_| "无法编码排队消息".into())
}

impl NativeEngine {
    pub(super) async fn enqueue_message(&self, args: &Value) -> Result<(), String> {
        self.enqueue_message_inner(args, false).await
    }

    pub(super) async fn enqueue_secretary_followup(&self, args: &Value) -> Result<(), String> {
        self.enqueue_message_inner(args, true).await
    }

    async fn enqueue_message_inner(&self, args: &Value, resume_secretary: bool) -> Result<(), String> {
        let id = arg(args, "sessionId")?;
        let input = parse_input(args)?;
        let fingerprint = fingerprint(&input)?;
        let entry = self.entry(id).await?;
        let mut state = entry.lock().await;
        if let Some(record) = state.stored.commands.get(&input.request_id) {
            return check_fingerprint(record, &input, &fingerprint);
        }
        if state.stored.queued_inputs.len() >= MAX_QUEUED_MESSAGES {
            return Err("此会话已有 32 条排队消息，请先发送或撤回一些消息。".into());
        }
        let mut stored = state.stored.clone();
        stored.commands.insert(
            input.request_id.clone(),
            CommandRecord {
                text: input.text.clone(),
                status: "queued".into(),
                fingerprint: Some(fingerprint),
            },
        );
        stored.queued_inputs.push(input);
        if encoded_size(&stored.queued_inputs)? > MAX_QUEUE_BYTES {
            return Err("排队消息与附件合计超过 24 MB，请先发送或撤回一些消息。".into());
        }
        if resume_secretary {
            // Admission and the explicit resume are one durable mutation. A
            // rejected duplicate, capacity or disk failure leaves pauses intact.
            stored.snapshot.queue_paused = false;
            stored.secretary_cancel_requested = false;
        }
        sync_snapshot(&mut stored);
        stored.snapshot.session.updated_at = now();
        persistence::save(&self.inner.root, &stored).await?;
        state.stored = stored;
        drop(state);
        if let Some(admitted) = self.admit_queued_locked(entry).await {
            self.spawn_turn(admitted).await;
        }
        Ok(())
    }

    pub(super) async fn remove_queued_message(&self, args: &Value) -> Result<Value, String> {
        let entry = self.entry(arg(args, "sessionId")?).await?;
        let request_id = arg(args, "requestId")?;
        let mut state = entry.lock().await;
        if let Some(input) = state
            .stored
            .withdrawn_queue_inputs
            .iter()
            .find(|input| input.request_id == request_id)
        {
            return encode(input);
        }
        let index = state
            .stored
            .queued_inputs
            .iter()
            .position(|input| input.request_id == request_id)
            .ok_or("该排队消息已开始执行或已撤回，不能再次撤回")?;
        let mut stored = state.stored.clone();
        let removed = stored.queued_inputs.remove(index);
        let withdraws_priority = state.send_queued_after_stop.as_deref() == Some(request_id);
        if withdraws_priority {
            stored.snapshot.queue_paused = true;
        }
        let response = encode(&removed)?;
        stored.withdrawn_queue_inputs.push(removed);
        while stored.withdrawn_queue_inputs.len() > MAX_WITHDRAWAL_RECEIPTS
            || encoded_size(&stored.withdrawn_queue_inputs)? > MAX_QUEUE_BYTES
        {
            stored.withdrawn_queue_inputs.remove(0);
        }
        if let Some(record) = stored.commands.get_mut(request_id) {
            record.status = "withdrawn".into();
        }
        sync_snapshot(&mut stored);
        stored.snapshot.session.updated_at = now();
        persistence::save(&self.inner.root, &stored).await?;
        state.stored = stored;
        if withdraws_priority {
            state.send_queued_after_stop = None;
        }
        Ok(response)
    }

    pub(super) async fn send_queued_message_now(&self, args: &Value) -> Result<(), String> {
        self.validate_secretary_queue_action(arg(args,"sessionId")?).await?;
        let entry = self.entry(arg(args, "sessionId")?).await?;
        let request_id = arg(args, "requestId")?;
        let mut state = entry.lock().await;
        if state.stored.commands.get(request_id).is_some_and(|record| {
            matches!(
                record.status.as_str(),
                "accepted" | "completed" | "cancelled" | "failed"
            )
        }) {
            return Ok(()); // A lost acknowledgement must never interrupt a later task.
        }
        let index = state
            .stored
            .queued_inputs
            .iter()
            .position(|input| input.request_id == request_id)
            .ok_or("该排队消息不存在或已撤回")?;
        let mut stored = state.stored.clone();
        let input = stored.queued_inputs.remove(index);
        stored.queued_inputs.insert(0, input);
        stored.snapshot.queue_paused = false;
        sync_snapshot(&mut stored);
        persistence::save(&self.inner.root, &stored).await?;
        state.stored = stored;
        if let Some(flight) = &state.flight {
            let cancel = flight.cancel.clone();
            state.send_queued_after_stop = Some(request_id.into());
            let _ = cancel.send(true);
        }
        drop(state);
        if let Some(admitted) = self.admit_queued_locked(entry).await {
            self.spawn_turn(admitted).await;
        }
        Ok(())
    }

    // Caller already owns inner.gate; admission removes the queued payload in
    // the same atomic save that creates its user message and accepted receipt.
    pub(super) async fn admit_queued_locked(&self, entry: Entry) -> Option<AdmittedTurn> {
        let id = entry.lock().await.stored.snapshot.session.id.clone();
        let current = self.entry(&id).await.ok()?;
        if !Arc::ptr_eq(&current, &entry) {
            return None;
        }
        if self.mutable().is_err() {
            let mut state = entry.lock().await;
            if !state.stored.queued_inputs.is_empty() {
                state.stored.snapshot.queue_paused = true;
                let _ = persistence::save(&self.inner.root, &state.stored).await;
            }
            return None;
        }
        let args = {
            let state = entry.lock().await;
            if state.flight.is_some() || state.stored.snapshot.queue_paused {
                return None;
            }
            input_args(
                &state.stored.snapshot.session.id,
                state.stored.queued_inputs.first()?,
            )
        };
        match self.admit(&args, true).await {
            Ok(admitted) => admitted,
            Err(error) => {
                let mut state = entry.lock().await;
                state.stored.snapshot.queue_paused = true;
                state.stored.snapshot.status = AgentStatus::Error;
                state.stored.snapshot.error = Some(format!("排队消息尚未发送：{error}"));
                let _ = persistence::save(&self.inner.root, &state.stored).await;
                None
            }
        }
    }

    pub(super) async fn admit_next_queued(&self, entry: Entry) -> Option<AdmittedTurn> {
        if self.inner.closed.load(Ordering::Acquire) {
            return None;
        }
        let mut shutdown = self.inner.shutdown.subscribe();
        let _gate = tokio::select! {
            biased;
            _ = inference::cancelled(&mut shutdown) => return None,
            gate = self.inner.gate.lock() => gate,
        };
        self.admit_queued_locked(entry).await
    }
}
