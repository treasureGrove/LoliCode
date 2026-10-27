//! Native direct preferred, with separately encrypted and bounded text fallback.
use super::direct::DirectChannel;
use super::text::TextChannel;
use super::*;

pub(super) async fn fence_text_work<F>(
    work: F,
    mut teardown: tokio::sync::watch::Receiver<u64>,
    expires: u64,
    controls: &mut mpsc::Receiver<Control>,
) -> Result<(), String>
where
    F: std::future::Future<Output = Result<(), String>>,
{
    let mut work = Box::pin(work);
    loop {
        tokio::select! {
            biased;
            _ = teardown.changed() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_millis(expires.saturating_sub(now()))) => return Err("账号设备认证已到期，文本通道已关闭".into()),
            control = controls.recv() => match control {
                Some(Control::Approved) => continue,
                Some(Control::Stop | Control::Revoke) | None => return Ok(()),
            },
            result = &mut work => return result,
        }
    }
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
        }
        let result=async{
            if let Some(message)=self.approval_message(id).await{self.send_direct_payload(&mut channel,&secret,id,message).await?;}
            let mut tick=tokio::time::interval(Duration::from_secs(2));
            let deadline=tokio::time::sleep(Duration::from_millis(expires.saturating_sub(now())));tokio::pin!(deadline);
            let mut attempts=BTreeMap::<String,u64>::new();
            loop{tokio::select!{
                biased;
                _=lifetime.changed()=>return Ok(()),
                _=&mut deadline=>return Err("账号设备认证已到期，直连已关闭并等待续期".into()),
                control=controls.recv()=>match control{Some(Control::Approved)=>{if let Some(message)=self.approval_message(id).await{self.send_direct_payload(&mut channel,&secret,id,message).await?;}},Some(Control::Stop|Control::Revoke)|None=>return Ok(())},
                incoming=channel.recv()=>{
                    let Some(packet)=incoming?else{return Err("直连已中断，请切换网络后重试".into());};
                    match self.receive(app,id,&secret,&packet).await{
                        Ok(Some(reply))=>self.send_direct_payload(&mut channel,&secret,id,reply).await?,
                        Ok(None)=>{},Err(error)=>return Err(error),
                    }
                },
                _=tick.tick()=>{
                    if self.check_epoch(epoch).is_err()||!self.room_enabled(id).await{return Ok(());}
                    self.monitor(app,id).await?;
                    let pending=self.0.store.lock().await.rooms.get(id).map(|r|r.events.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
                    for event in pending{let event_id=event["eventId"].as_str().unwrap_or("").to_owned();if attempts.get(&event_id).is_some_and(|last|now().saturating_sub(*last)<60_000){continue;}
                        self.send_direct_payload(&mut channel,&secret,id,event).await?;attempts.insert(event_id,now());
                    }
                }
            }}
        }.await;
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
        }
        let teardown = lifetime.clone();
        let work = async {
            if let Some(message) = self.approval_message(id).await {
                channel.send(message).await?;
            }
            let mut tick = tokio::time::interval(Duration::from_secs(3));
            let deadline = tokio::time::sleep(Duration::from_millis(expires.saturating_sub(now())));
            tokio::pin!(deadline);
            let mut attempts = BTreeMap::<String, u64>::new();
            loop {
                tokio::select! {
                    biased;
                    _ = lifetime.changed() => return Ok(()),
                    _ = &mut deadline => return Err("账号设备认证已到期，文本通道已关闭".into()),
                    incoming = channel.recv() => {
                        let Some(payload) = incoming? else { return Err("文本通道已断开".into()); };
                        if let Some(reply) = self.receive_payload(app, id, payload, true).await? {
                            if !self.room_enabled(id).await { return Ok(()); }
                            channel.send(reply).await?;
                        }
                    },
                    _ = tick.tick() => {
                        if self.check_epoch(epoch).is_err() || !self.room_enabled(id).await { return Ok(()); }
                        self.monitor(app,id).await?;
                        let pending = self.0.store.lock().await.rooms.get(id).map(|r| r.events.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
                        // Bounded replay, with an authenticated event.ack removing
                        // delivered notifications from persistent storage.
                        for event in pending.into_iter().filter(|event| !attempts.contains_key(event["eventId"].as_str().unwrap_or(""))).take(2).collect::<Vec<_>>() {
                            let event_id = event["eventId"].as_str().unwrap_or("").to_owned();
                            channel.send(event).await?;
                            attempts.insert(event_id, now());
                        }
                    }
                }
            }
        };
        // Fence the whole operation, including a pending dispatch or paced send.
        // Dropping it never retries a mutation; its durable receipt remains.
        let result = fence_text_work(work, teardown, expires, controls).await;
        channel.close().await;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
