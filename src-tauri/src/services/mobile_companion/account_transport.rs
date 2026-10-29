//! Native direct preferred, with separately encrypted and bounded text fallback.
use super::authorization::fence_authorized_work;
use super::direct::DirectChannel;
use super::text::TextChannel;
use super::*;
use std::collections::VecDeque;

/// Bounded plaintext fragments, encrypted only immediately before their write.
/// Large replies never hold the receive loop while waiting for rate allowance.
#[derive(Default)]
struct Outbox {
    frames: VecDeque<Value>,
    bytes: usize,
}
impl Outbox {
    fn enqueue(&mut self, mut value: Value, capable: bool, urgent: bool) -> Result<(), String> {
        if !capable
            && serde_json::to_vec(&value)
                .map_err(|_| "消息编码失败")?
                .len()
                > 5000
        {
            let request = value["requestId"]
                .as_str()
                .ok_or("手机端版本过旧，请更新后读取完整消息")?
                .to_owned();
            value = response(&request, Err("手机端版本过旧，请更新后读取完整消息".into()));
        }
        let frames = logical::encode(&value)?;
        let bytes = frames.iter().try_fold(0usize, |total, frame| {
            serde_json::to_vec(frame)
                .map(|body| total + body.len())
                .map_err(|_| "消息编码失败")
        })?;
        if self.frames.len() + frames.len() > 768 || self.bytes + bytes > 3 * 1024 * 1024 {
            return Err("待发消息过多，请等待当前传输结束后刷新；未重新执行任何操作".into());
        }
        self.bytes += bytes;
        if urgent && frames.len() == 1 && frames[0]["type"] != "logical.part" {
            let frame = frames.into_iter().next().unwrap();
            // The peer has authenticated the channel, but will not accept any
            // task/event until pair.approved confirms the application session.
            // Replayed completion events must not cross this bootstrap barrier.
            if self
                .frames
                .front()
                .is_some_and(|head| head["type"] == "pair.approved")
            {
                self.frames.insert(1, frame);
            } else {
                self.frames.push_front(frame);
            }
        } else {
            self.frames.extend(frames);
        }
        Ok(())
    }
    fn pop(&mut self) -> Option<Value> {
        let frame = self.frames.pop_front()?;
        self.bytes -= serde_json::to_vec(&frame)
            .map(|body| body.len())
            .unwrap_or(0);
        Some(frame)
    }
    fn cancel(&mut self, transfer: &str) {
        self.frames
            .retain(|frame| frame["type"] != "logical.part" || frame["transferId"] != transfer);
        self.bytes = self
            .frames
            .iter()
            .map(|frame| {
                serde_json::to_vec(frame)
                    .map(|body| body.len())
                    .unwrap_or(0)
            })
            .sum();
    }
}
fn urgent_request(value: &Value) -> bool {
    value["method"] == "run.cancel"
        || value["method"] == "permission.reply" && value["params"]["decision"] == "reject"
}

async fn connect_direct(
    room: &Room,
    id: &str,
    secret: &Secret,
    ticket: &str,
    expires: u64,
    controls: &mut mpsc::Receiver<Control>,
    lifetime: &mut tokio::sync::watch::Receiver<u64>,
) -> Result<Option<DirectChannel>, String> {
    tokio::select! {
        biased;
        _=lifetime.changed()=>Ok(None),
        _=tokio::time::sleep(Duration::from_millis(expires.saturating_sub(now())))=>Err("账号设备认证已到期".into()),
        result=DirectChannel::connect(&room.relay_url,id,secret,ticket)=>result.map(Some),
        _=controls.recv()=>Ok(None),
    }
}
impl MobileCompanionState {
    async fn logical_capable(&self, id: &str) -> bool {
        self.0
            .connections
            .lock()
            .await
            .get(id)
            .is_some_and(|connection| connection.logical_json)
    }
    async fn assemble_payload(
        &self,
        id: &str,
        receiver: &mut logical::Receiver,
        outbox: &mut Outbox,
        payload: Value,
    ) -> Result<Option<Value>, String> {
        let is_part = matches!(
            payload["type"].as_str(),
            Some("logical.part" | "logical.cancel")
        );
        if is_part && !self.logical_capable(id).await {
            return Err("客户端尚未协商完整消息能力".into());
        }
        let cancel = (payload["type"] == "logical.cancel")
            .then(|| payload["transferId"].as_str().unwrap_or("").to_owned());
        let result = receiver.ingest(payload)?;
        if let Some(transfer) = cancel {
            outbox.cancel(&transfer);
        }
        Ok(result)
    }
    pub(super) async fn direct_room_worker(
        &self,
        app: AppHandle,
        id: String,
        mut controls: mpsc::Receiver<Control>,
    ) {
        let mut outcome = self.run_direct_room(&app, &id, &mut controls).await;
        if outcome.is_err() && self.room_enabled(&id).await {
            self.connection(&id, false, Some("直连未建立，正在尝试受限文本通道".into()))
                .await;
            outcome = self.run_text_room(&app, &id, &mut controls).await;
        }
        if let Some(connection) = self.0.connections.lock().await.get_mut(&id) {
            connection.online = false;
            connection.transport = None;
            connection.tx = None;
            if let Err(error) = outcome {
                connection.last_error = Some(error);
                connection.retry_at = now() + 30_000;
            }
        }
    }
    async fn run_direct_room(
        &self,
        app: &AppHandle,
        id: &str,
        controls: &mut mpsc::Receiver<Control>,
    ) -> Result<(), String> {
        let (epoch, mut lifetime) = self.account_lifetime();
        let room = self
            .0
            .store
            .lock()
            .await
            .rooms
            .get(id)
            .cloned()
            .filter(|r| r.approved && !r.revoked)
            .ok_or("手机连接已停止")?;
        let binding = room.account.as_ref().ok_or("账号房间缺少身份绑定")?;
        let (ticket, expires) = self
            .account_room_ticket(binding)
            .await
            .ok_or("账号设备认证已到期")?;
        let secret = self.0.vault.read(id)?;
        let Some(mut channel) = connect_direct(
            &room,
            id,
            &secret,
            &ticket,
            expires,
            controls,
            &mut lifetime,
        )
        .await?
        else {
            return Ok(());
        };
        if !self.room_enabled(id).await {
            channel.close().await;
            return Ok(());
        }
        self.connection(id, true, None).await;
        if let Some(c) = self.0.connections.lock().await.get_mut(id) {
            c.transport = Some("direct");
            c.logical_json = false;
        }
        let teardown = lifetime.clone();
        let (auth_tx, auth_rx) = tokio::sync::watch::channel(expires);
        let work = async {
            let mut outbox = Outbox::default();
            let mut receiver = logical::Receiver::default();
            if let Some(message) = self.approval_message(id).await {
                outbox.enqueue(message, false, false)?;
            }
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            let mut drain = tokio::time::interval(Duration::from_millis(20));
            let mut attempts = BTreeMap::<String, u64>::new();
            loop {
                tokio::select! {
                    biased;
                    _ = lifetime.changed() => return Ok(()),
                    incoming = channel.recv() => {
                        let Some(packet) = incoming? else { return Err("直连已中断，请切换网络后重试".into()); };
                        if let Some(renewed) = channel.take_renewed_expiry() {
                            auth_tx.send_replace(renewed);
                            continue;
                        }
                        let payload = self.decode_packet(id, &secret, &packet).await?;
                        if let Some(payload) = self.assemble_payload(id, &mut receiver, &mut outbox, payload).await? {
                            let urgent = urgent_request(&payload);
                            if let Some(reply) = self.receive_payload(app, id, payload, false).await? {
                                outbox.enqueue(reply, self.logical_capable(id).await, urgent)?;
                            }
                        }
                    },
                    _ = drain.tick() => {
                        receiver.check_timeout()?;
                        if !outbox.frames.is_empty() && channel.ready_to_send().await {
                            let frame = outbox.pop().unwrap();
                            self.send_direct_payload(&mut channel, &secret, id, frame).await?;
                        }
                    },
                    _ = tick.tick() => {
                        if self.check_epoch(epoch).is_err() || !self.room_enabled(id).await { return Ok(()); }
                        if let Some((ticket, renewed)) = self.account_room_ticket(binding).await {
                            if renewed > *auth_tx.borrow() { channel.refresh_authorization(&ticket, renewed).await?; }
                        }
                        self.monitor(app, id).await?;
                        let pending = self.0.store.lock().await.rooms.get(id).map(|r|r.events.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
                        for event in pending {
                            let event_id = event["eventId"].as_str().unwrap_or("").to_owned();
                            if attempts.get(&event_id).is_some_and(|last|now().saturating_sub(*last)<60_000) { continue; }
                            outbox.enqueue(event, self.logical_capable(id).await, true)?;
                            attempts.insert(event_id,now());
                        }
                    }
                }
            }
        };
        let result = fence_authorized_work(work, teardown, auth_rx, controls).await;
        channel.close().await;
        result
    }
    async fn send_direct_payload(
        &self,
        channel: &mut DirectChannel,
        secret: &Secret,
        room: &str,
        mut value: Value,
    ) -> Result<(), String> {
        if !self.room_enabled(room).await {
            return Err("账号设备连接已停止".into());
        }
        value["sentAt"] = json!(now());
        channel.send(crypto::seal(&secret.key, room, &value)?).await
    }
    async fn run_text_room(
        &self,
        app: &AppHandle,
        id: &str,
        controls: &mut mpsc::Receiver<Control>,
    ) -> Result<(), String> {
        let (epoch, mut lifetime) = self.account_lifetime();
        let room = self
            .0
            .store
            .lock()
            .await
            .rooms
            .get(id)
            .cloned()
            .filter(|r| r.approved && !r.revoked)
            .ok_or("手机连接已停止")?;
        let binding = room.account.as_ref().ok_or("账号房间缺少身份绑定")?;
        let (ticket, expires) = self
            .account_room_ticket(binding)
            .await
            .ok_or("账号设备认证已到期")?;
        let secret = self.0.vault.read(id)?;
        let connected = tokio::select! {
            biased;
            _ = lifetime.changed() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_millis(expires.saturating_sub(now()))) => return Err("账号设备认证已到期".into()),
            _ = controls.recv() => return Ok(()),
            channel = TextChannel::connect(&room.relay_url, id, &secret, &ticket) => channel?,
        };
        let mut channel = connected;
        if !self.room_enabled(id).await {
            channel.close().await;
            return Ok(());
        }
        self.connection(id, true, None).await;
        if let Some(c) = self.0.connections.lock().await.get_mut(id) {
            c.transport = Some("text");
            c.logical_json = false;
        }
        let teardown = lifetime.clone();
        let (auth_tx, auth_rx) = tokio::sync::watch::channel(expires);
        let work = async {
            let mut outbox = Outbox::default();
            let mut receiver = logical::Receiver::default();
            if let Some(message) = self.approval_message(id).await {
                outbox.enqueue(message, false, false)?;
            }
            let mut tick = tokio::time::interval(Duration::from_secs(3));
            let mut attempts = BTreeMap::<String, u64>::new();
            loop {
                let ready = channel.ready_at();
                let has_frames = !outbox.frames.is_empty();
                tokio::select! {
                    biased;
                    _ = lifetime.changed() => return Ok(()),
                    incoming = channel.recv() => {
                        let Some(payload) = incoming? else { return Err("文本通道已断开".into()); };
                        if let Some(renewed) = channel.take_renewed_expiry() {
                            auth_tx.send_replace(renewed);
                            continue;
                        }
                        if let Some(payload) = self.assemble_payload(id, &mut receiver, &mut outbox, payload).await? {
                            let urgent = urgent_request(&payload);
                            if let Some(reply) = self.receive_payload(app, id, payload, true).await? {
                                if !self.room_enabled(id).await { return Ok(()); }
                                outbox.enqueue(reply, self.logical_capable(id).await, urgent)?;
                            }
                        }
                    },
                    _ = tokio::time::sleep_until(ready), if has_frames => {
                        if !self.room_enabled(id).await { return Ok(()); }
                        channel.send(outbox.pop().unwrap()).await?;
                    },
                    _ = tick.tick() => {
                        receiver.check_timeout()?;
                        if self.check_epoch(epoch).is_err() || !self.room_enabled(id).await { return Ok(()); }
                        if let Some((ticket, renewed)) = self.account_room_ticket(binding).await {
                            if renewed > *auth_tx.borrow() { channel.refresh_authorization(&ticket, renewed).await?; }
                        }
                        self.monitor(app,id).await?;
                        let pending = self.0.store.lock().await.rooms.get(id).map(|r| r.events.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
                        // Bounded replay, with an authenticated event.ack removing
                        // delivered notifications from persistent storage.
                        for event in pending.into_iter().filter(|event| !attempts.contains_key(event["eventId"].as_str().unwrap_or(""))).take(2).collect::<Vec<_>>() {
                            let event_id = event["eventId"].as_str().unwrap_or("").to_owned();
                            outbox.enqueue(event, self.logical_capable(id).await, true)?;
                            attempts.insert(event_id, now());
                        }
                    }
                }
            }
        };
        // Fence the whole operation, including a pending dispatch or paced send.
        // Dropping it never retries a mutation; its durable receipt remains.
        let result = fence_authorized_work(work, teardown, auth_rx, controls).await;
        channel.close().await;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_notification_cannot_overtake_initial_pair_approval() {
        let mut outbox = Outbox::default();
        outbox
            .enqueue(
                json!({"type":"pair.approved","deviceId":"approved-phone","sentAt":now()}),
                false,
                false,
            )
            .unwrap();
        // The first monitor tick is immediate while the text handshake's send
        // allowance is still cooling down. An unacknowledged completed task is
        // replayed on reconnect before the next paced frame becomes writable.
        outbox.enqueue(json!({"type":"event","eventId":"pending-completion","kind":"task_completed","sentAt":now()}), false, true).unwrap();
        assert_eq!(outbox.pop().unwrap()["type"], "pair.approved");
        assert_eq!(outbox.pop().unwrap()["type"], "event");
    }
    #[tokio::test]
    async fn confirmed_renewal_extends_fence_without_resetting_work_or_revocation() {
        let (_lifetime, teardown) = tokio::sync::watch::channel(0u64);
        let (renewal, deadline) = tokio::sync::watch::channel(now() + 80);
        let (_stop, mut controls) = mpsc::channel(1);
        let work = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            renewal.send_replace(now() + 1000);
            tokio::time::sleep(Duration::from_millis(120)).await;
            Ok(())
        };
        assert!(
            fence_authorized_work(work, teardown, deadline, &mut controls)
                .await
                .is_ok()
        );
    }
    #[test]
    fn logical_outbox_preserves_parts_and_allows_urgent_control_without_unbounded_queue() {
        let mut outbox = Outbox::default();
        let body = json!({"type":"response","requestId":"catalogue","result":{"models":"文".repeat(4000)}});
        outbox.enqueue(body, true, false).unwrap();
        assert_eq!(outbox.frames[0]["type"], "logical.part");
        let transfer = outbox.frames[0]["transferId"].as_str().unwrap().to_owned();
        let before = outbox.bytes;
        outbox
            .enqueue(response("stop", Ok(json!({"accepted":true}))), true, true)
            .unwrap();
        assert_eq!(outbox.pop().unwrap()["requestId"], "stop");
        assert_eq!(outbox.bytes, before);
        outbox.cancel("unknown");
        assert_eq!(outbox.bytes, before);
        outbox.cancel(&transfer);
        assert!(outbox.frames.is_empty());
        assert_eq!(outbox.bytes, 0);
        for index in 0..768 {
            outbox
                .enqueue(json!({"type":"event","eventId":index}), true, false)
                .unwrap();
        }
        assert!(outbox
            .enqueue(json!({"type":"event"}), true, false)
            .is_err());
        assert_eq!(outbox.frames.len(), 768);
    }
    #[test]
    fn old_client_receives_explicit_upgrade_error_for_large_logical_reply() {
        let mut outbox = Outbox::default();
        outbox.enqueue(json!({"type":"response","requestId":"models","result":{"models":"x".repeat(6000)}}), false, false).unwrap();
        let value = outbox.pop().unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["requestId"], "models");
        assert!(value["error"]["message"].as_str().unwrap().contains("更新"));
    }
    #[tokio::test]
    async fn logout_stop_and_ticket_expiry_cancel_absent_peer_without_task_websocket_fallback() {
        for mode in ["logout", "stop", "expiry"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}/companion", listener.local_addr().unwrap());
            let ready = Arc::new(tokio::sync::Notify::new());
            let observed = ready.clone();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let frame = socket.next().await.unwrap().unwrap().into_text().unwrap();
                let hello: Value = serde_json::from_str(&frame).unwrap();
                assert_eq!(hello["deviceToken"], "owned-fixture-device-ticket");
                assert!(hello.get("phoneToken").is_none());
                socket
                    .send(Message::Text(json!({"type":"ready","v":1}).to_string()))
                    .await
                    .unwrap();
                socket
                    .send(Message::Text(
                        json!({"type":"peer","online":false}).to_string(),
                    ))
                    .await
                    .unwrap();
                observed.notify_one();
                while let Some(Ok(message)) = socket.next().await {
                    if let Message::Text(text) = message {
                        let value: Value = serde_json::from_str(&text).unwrap();
                        assert_ne!(value["type"], "packet");
                        assert!(!value["type"]
                            .as_str()
                            .is_some_and(|t| t.starts_with("push.")));
                    }
                }
            });
            let state = MobileCompanionState::new(Arc::new(Database::memory().unwrap()));
            let (_, mut lifetime) = state.account_lifetime();
            let (stop, mut controls) = mpsc::channel(1);
            let secret = Secret {
                desktop_token: "a".repeat(64),
                phone_token: "b".repeat(64),
                key: [9; 32],
            };
            let room = Room {
                relay_url: url,
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
                account: None,
            };
            let expires = if mode == "expiry" {
                now() + 300
            } else {
                now() + 900_000
            };
            let pending = tokio::spawn(async move {
                connect_direct(
                    &room,
                    &"1".repeat(32),
                    &secret,
                    "owned-fixture-device-ticket",
                    expires,
                    &mut controls,
                    &mut lifetime,
                )
                .await
                .map(|channel| channel.is_none())
            });
            tokio::time::timeout(Duration::from_secs(2), ready.notified())
                .await
                .unwrap();
            if mode == "logout" {
                state.fence_account_state().await;
            } else if mode == "stop" {
                stop.send(Control::Stop).await.unwrap();
            }
            let result = tokio::time::timeout(Duration::from_secs(2), pending)
                .await
                .unwrap()
                .unwrap();
            if mode == "expiry" {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap(), true);
            }
            tokio::time::timeout(Duration::from_secs(2), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
}
