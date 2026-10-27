//! Account-scoped, bounded text fallback. This is a separate AEAD domain from
//! both native task packets and signaling; no media or opaque packet tunnel.
use super::{crypto, Secret};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures::{SinkExt, StreamExt};
use ring::aead;
use serde_json::{json, Value};
use std::{collections::BTreeSet, time::Duration};
use tokio::{
    net::TcpStream,
    time::{interval, timeout, Instant, Interval},
};
use tokio_tungstenite::{
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};

const MAX_FRAME: usize = 8192;
const MAX_PLAIN: usize = 5500;
const ERROR: &str = "受限文本通道不可用、额度已用尽或连接已断开，请刷新设备状态";
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub(super) struct TextChannel {
    socket: Socket,
    epoch: String,
    room: String,
    key: [u8; 32],
    seen: BTreeSet<String>,
    ping: Interval,
    next_send: Instant,
}
impl TextChannel {
    pub(super) async fn connect(
        url: &str,
        room: &str,
        secret: &Secret,
        ticket: &str,
    ) -> Result<Self, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        timeout(
            Duration::from_secs(35),
            Self::negotiate(url, room, secret, ticket),
        )
        .await
        .map_err(|_| ERROR.to_string())?
    }
    async fn negotiate(
        url: &str,
        room: &str,
        secret: &Secret,
        ticket: &str,
    ) -> Result<Self, String> {
        let config = WebSocketConfig {
            max_message_size: Some(MAX_FRAME),
            max_frame_size: Some(MAX_FRAME),
            write_buffer_size: 8192,
            max_write_buffer_size: 32 * 1024,
            ..Default::default()
        };
        let (mut socket, _) =
            tokio_tungstenite::connect_async_with_config(url, Some(config), false)
                .await
                .map_err(|_| ERROR)?;
        socket
            .send(Message::Text(
                json!({"type":"hello","v":1,"role":"desktop","roomId":room,
            "token":secret.desktop_token,"deviceToken":ticket,"capabilities":["text-v1"]})
                .to_string(),
            ))
            .await
            .map_err(|_| ERROR)?;
        let mut ready = false;
        let epoch = loop {
            let value = read(&mut socket).await?;
            match value["type"].as_str() {
                Some("ready") if value["v"] == 1 && value["textRelay"] == true => ready = true,
                Some("peer") if value["online"] == false => {}
                Some("peer") if ready && value["online"] == true && value["textRelay"] == true => {
                    let epoch = value["textEpoch"]
                        .as_str()
                        .filter(|s| valid_epoch(s))
                        .ok_or(ERROR)?;
                    break epoch.to_owned();
                }
                _ => return Err(ERROR.into()),
            }
        };
        let mut channel = Self {
            socket,
            epoch,
            room: room.into(),
            key: secret.key,
            seen: BTreeSet::new(),
            ping: interval(Duration::from_secs(25)),
            next_send: Instant::now(),
        };
        let challenge = crypto::hex(&crypto::random::<16>()?);
        channel
            .send(json!({"type":"text.ready","challenge":challenge,"sentAt":crypto::now()}))
            .await?;
        let reply = channel.recv().await?.ok_or(ERROR)?;
        if reply["type"] != "text.ready" || reply["challenge"] != challenge {
            return Err(ERROR.into());
        }
        Ok(channel)
    }
    pub(super) async fn send(&mut self, mut payload: Value) -> Result<(), String> {
        payload["sentAt"] = json!(crypto::now());
        let frame = seal(&self.key, &self.room, &self.epoch, "desktop", &payload)?.to_string();
        // Leave room for phone requests and control traffic within the shared
        // account budget. No unbounded application send queue is maintained.
        tokio::time::sleep_until(self.next_send).await;
        timeout(
            Duration::from_secs(3),
            self.socket.send(Message::Text(frame.clone())),
        )
        .await
        .map_err(|_| ERROR)?
        .map_err(|_| ERROR)?;
        // The relay appends ,"from":"desktop" before metering delivery.
        self.next_send = Instant::now()
            + Duration::from_millis(((frame.len() as u64 + 17) * 1000).div_ceil(1500));
        Ok(())
    }
    pub(super) async fn recv(&mut self) -> Result<Option<Value>, String> {
        loop {
            let value = tokio::select! {
                frame = read(&mut self.socket) => frame?,
                _ = self.ping.tick() => {
                    self.socket.send(Message::Ping(Vec::new())).await.map_err(|_| ERROR)?;
                    continue;
                }
            };
            if value["type"] == "peer"
                && value["online"] == true
                && value["textEpoch"] == self.epoch
            {
                continue;
            }
            let (id, plain) = open(
                &self.key,
                &self.room,
                &self.epoch,
                "phone",
                &value,
                crypto::now(),
            )?;
            if self.seen.len() >= 20_000 || !self.seen.insert(id) {
                return Err(ERROR.into());
            }
            return Ok(Some(plain));
        }
    }
    pub(super) async fn close(&mut self) {
        let _ = timeout(Duration::from_secs(1), self.socket.close(None)).await;
    }
}
fn valid_epoch(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn aad(room: &str, epoch: &str, role: &str, id: &str) -> String {
    format!("lolicode-companion-text/1|{room}|{epoch}|{role}|{id}")
}
fn decode(value: &Value, key: &str, max: usize) -> Result<Vec<u8>, String> {
    let text = value[key]
        .as_str()
        .filter(|s| s.len() <= max)
        .ok_or(ERROR)?;
    let bytes = URL_SAFE_NO_PAD.decode(text).map_err(|_| ERROR)?;
    if URL_SAFE_NO_PAD.encode(&bytes) != text {
        return Err(ERROR.into());
    }
    Ok(bytes)
}
fn seal(
    key: &[u8; 32],
    room: &str,
    epoch: &str,
    role: &str,
    payload: &Value,
) -> Result<Value, String> {
    if !valid_epoch(epoch) {
        return Err(ERROR.into());
    }
    let mut body = serde_json::to_vec(payload).map_err(|_| ERROR)?;
    if body.len() > MAX_PLAIN {
        return Err("文本内容超过通道上限，请通过直连查看".into());
    }
    let nonce = crypto::random::<12>()?;
    let id = uuid::Uuid::new_v4().to_string();
    let cipher =
        aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| ERROR)?);
    cipher
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad(room, epoch, role, &id)),
            &mut body,
        )
        .map_err(|_| ERROR)?;
    let value = json!({"type":"text","v":1,"id":id,"epoch":epoch,"nonce":crypto::encode(&nonce),"ciphertext":crypto::encode(&body)});
    if value.to_string().len() > MAX_FRAME {
        return Err(ERROR.into());
    }
    Ok(value)
}
fn open(
    key: &[u8; 32],
    room: &str,
    epoch: &str,
    role: &str,
    frame: &Value,
    now: u64,
) -> Result<(String, Value), String> {
    if frame["type"] != "text"
        || frame["v"] != 1
        || frame["epoch"] != epoch
        || frame["from"] != role
        || frame.to_string().len() > MAX_FRAME
    {
        return Err(ERROR.into());
    }
    let object = frame.as_object().ok_or(ERROR)?;
    if object.len() != 7
        || object.keys().any(|k| {
            !["type", "v", "id", "epoch", "from", "nonce", "ciphertext"].contains(&k.as_str())
        })
    {
        return Err(ERROR.into());
    }
    let id = frame["id"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok_and(|u| u.to_string() == *s))
        .ok_or(ERROR)?;
    let nonce: [u8; 12] = decode(frame, "nonce", 16)?.try_into().map_err(|_| ERROR)?;
    let mut body = decode(frame, "ciphertext", 7400)?;
    if body.len() < 16 || body.len() > MAX_PLAIN + 16 {
        return Err(ERROR.into());
    }
    let cipher =
        aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| ERROR)?);
    let bytes = cipher
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad(room, epoch, role, id)),
            &mut body,
        )
        .map_err(|_| ERROR)?;
    let payload: Value = serde_json::from_slice(bytes).map_err(|_| ERROR)?;
    let sent = payload["sentAt"].as_u64().ok_or(ERROR)?;
    if now.abs_diff(sent) > crypto::WINDOW_MS {
        return Err(ERROR.into());
    }
    Ok((id.into(), payload))
}
async fn read(socket: &mut Socket) -> Result<Value, String> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) if text.len() <= MAX_FRAME => {
                return serde_json::from_str(&text).map_err(|_| ERROR.into())
            }
            Some(Ok(Message::Ping(data))) => {
                socket.send(Message::Pong(data)).await.map_err(|_| ERROR)?
            }
            Some(Ok(Message::Pong(_))) => {}
            _ => return Err(ERROR.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_cipher_binds_protocol_room_epoch_sender_id_and_expiry() {
        let epoch = "e".repeat(32);
        let payload = json!({"type":"request","sentAt":1234});
        let mut frame = seal(&[9; 32], "room", &epoch, "phone", &payload).unwrap();
        frame["from"] = json!("phone");
        assert_eq!(
            open(&[9; 32], "room", &epoch, "phone", &frame, 1234)
                .unwrap()
                .1,
            payload
        );
        assert!(open(&[9; 32], "other", &epoch, "phone", &frame, 1234).is_err());
        assert!(open(&[9; 32], "room", &"f".repeat(32), "phone", &frame, 1234).is_err());
        assert!(open(&[9; 32], "room", &epoch, "desktop", &frame, 1234).is_err());
        assert!(open(&[9; 32], "room", &epoch, "phone", &frame, 301235).is_err());
        frame["id"] = json!(uuid::Uuid::new_v4().to_string());
        assert!(open(&[9; 32], "room", &epoch, "phone", &frame, 1234).is_err());
        assert!(seal(
            &[9; 32],
            "room",
            &epoch,
            "phone",
            &json!({"text":"x".repeat(5500)})
        )
        .is_err());
    }
    #[test]
    fn opens_shared_android_node_aes_gcm_fixture() {
        let frame = json!({"type":"text","v":1,"id":"00000000-0000-4000-8000-000000000001",
            "epoch":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","from":"phone","nonce":"AQEBAQEBAQEBAQEB",
            "ciphertext":"wlL1HGOC6kozKymoi_uuct-u5ubHpQulgsdA8A77erNQEyR6BKuI7hJ5JcaRi71WokomOgyhIl_16rZ7hPAmQjx4"});
        assert_eq!(
            open(&[9; 32], "room", &"e".repeat(32), "phone", &frame, 1234)
                .unwrap()
                .1,
            json!({"type":"event.ack","eventId":"ack","sentAt":1234})
        );
    }
    #[tokio::test]
    async fn authenticated_text_handshake_and_duplicate_are_fenced() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let epoch = "e".repeat(32);
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(stream))
                .await
                .unwrap();
            let hello = read(&mut socket).await.unwrap();
            assert_eq!(hello["capabilities"], json!(["text-v1"]));
            assert_eq!(hello["deviceToken"], "synthetic-ticket");
            socket
                .send(Message::Text(
                    json!({"type":"ready","v":1,"textRelay":true}).to_string(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"peer","online":true,"textRelay":true,"textEpoch":epoch})
                        .to_string(),
                ))
                .await
                .unwrap();
            let mut frame = read(&mut socket).await.unwrap();
            assert_eq!(frame["type"], "text");
            frame["from"] = json!("desktop");
            let (_, challenge) =
                open(&[9; 32], "room", &epoch, "desktop", &frame, crypto::now()).unwrap();
            assert_eq!(challenge["type"], "text.ready");
            let mut echo = seal(&[9; 32], "room", &epoch, "phone", &challenge).unwrap();
            echo["from"] = json!("phone");
            socket.send(Message::Text(echo.to_string())).await.unwrap();
            let mut message = seal(
                &[9; 32],
                "room",
                &epoch,
                "phone",
                &json!({"type":"event.ack","eventId":"one","sentAt":crypto::now()}),
            )
            .unwrap();
            message["from"] = json!("phone");
            for _ in 0..2 {
                socket
                    .send(Message::Text(message.to_string()))
                    .await
                    .unwrap();
            }
            while socket.next().await.is_some() {}
        });
        let secret = Secret {
            desktop_token: "a".repeat(64),
            phone_token: "b".repeat(64),
            key: [9; 32],
        };
        let mut channel = TextChannel::connect(&url, "room", &secret, "synthetic-ticket")
            .await
            .unwrap();
        assert_eq!(channel.recv().await.unwrap().unwrap()["eventId"], "one");
        assert!(channel.recv().await.is_err());
        channel.close().await;
        drop(channel);
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn authority_fences_cancel_a_real_paced_text_send_before_a_second_frame_is_written() {
        use super::super::{account_transport::fence_text_work, Control};
        use tokio::sync::{mpsc, oneshot, watch};

        for mode in ["logout", "stop", "revoke", "expiry"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let (warmup_seen, warmup_received) = oneshot::channel();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(MaybeTlsStream::Plain(stream))
                    .await
                    .unwrap();
                let epoch = "e".repeat(32);
                let hello = read(&mut socket).await.unwrap();
                assert_eq!(hello["deviceToken"], "synthetic-cancellation-ticket");
                for value in [
                    json!({"type":"ready","v":1,"textRelay":true}),
                    json!({"type":"peer","online":true,"textRelay":true,"textEpoch":epoch}),
                ] {
                    socket.send(Message::Text(value.to_string())).await.unwrap();
                }
                let mut challenge = read(&mut socket).await.unwrap();
                challenge["from"] = json!("desktop");
                let (_, payload) = open(
                    &[9; 32],
                    "room",
                    &epoch,
                    "desktop",
                    &challenge,
                    crypto::now(),
                )
                .unwrap();
                assert_eq!(payload["type"], "text.ready");
                let mut echo = seal(&[9; 32], "room", &epoch, "phone", &payload).unwrap();
                echo["from"] = json!("phone");
                socket.send(Message::Text(echo.to_string())).await.unwrap();

                let mut warmup = read(&mut socket).await.unwrap();
                warmup["from"] = json!("desktop");
                let (_, payload) =
                    open(&[9; 32], "room", &epoch, "desktop", &warmup, crypto::now()).unwrap();
                assert_eq!(payload["type"], "warmup");
                assert_eq!(payload["text"].as_str().unwrap().len(), 3000);
                warmup_seen.send(()).unwrap();

                let mut later_text_frames = 0;
                while let Some(message) = socket.next().await {
                    match message {
                        Ok(Message::Text(frame)) => {
                            let mut frame: Value = serde_json::from_str(&frame).unwrap();
                            frame["from"] = json!("desktop");
                            // Count only genuine authenticated text, not WS controls.
                            open(&[9; 32], "room", &epoch, "desktop", &frame, crypto::now())
                                .unwrap();
                            later_text_frames += 1;
                        }
                        Ok(Message::Ping(data)) => {
                            socket.send(Message::Pong(data)).await.unwrap();
                        }
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }
                later_text_frames
            });
            let secret = Secret {
                desktop_token: "a".repeat(64),
                phone_token: "b".repeat(64),
                key: [9; 32],
            };
            let mut channel =
                TextChannel::connect(&url, "room", &secret, "synthetic-cancellation-ticket")
                    .await
                    .unwrap();
            channel
                .send(json!({"type":"warmup","text":"文".repeat(1000)}))
                .await
                .unwrap();
            timeout(Duration::from_secs(1), warmup_received)
                .await
                .unwrap()
                .unwrap();
            assert!(
                channel.next_send.saturating_duration_since(Instant::now())
                    > Duration::from_secs(2)
            );

            let (watch_tx, teardown) = watch::channel(0_u64);
            let (control_tx, mut controls) = mpsc::channel(1);
            let (started, work_started) = oneshot::channel();
            let trigger_watch = watch_tx.clone();
            let trigger_control = control_tx.clone();
            let trigger = tokio::spawn(async move {
                work_started.await.unwrap();
                tokio::time::sleep(Duration::from_millis(20)).await;
                match mode {
                    "logout" => {
                        trigger_watch.send(1).unwrap();
                    }
                    "stop" => {
                        trigger_control.send(Control::Stop).await.unwrap();
                    }
                    "revoke" => {
                        trigger_control.send(Control::Revoke).await.unwrap();
                    }
                    "expiry" => {}
                    _ => unreachable!(),
                }
            });
            let expires = crypto::now() + if mode == "expiry" { 150 } else { 60_000 };
            let work = async {
                started.send(()).unwrap();
                channel
                    .send(json!({"type":"must-not-arrive-after-fence"}))
                    .await
            };
            // This is the production teardown helper, not a test copy of its select.
            let result = timeout(
                Duration::from_millis(750),
                fence_text_work(work, teardown, expires, &mut controls),
            )
            .await
            .expect("authority fence must win before the paced write becomes due");
            if mode == "expiry" {
                assert!(result.unwrap_err().contains("到期"));
            } else {
                result.unwrap();
            }
            // Keep both senders alive until the fence returns, so channel closure
            // cannot accidentally stand in for Stop/Revoke or ticket expiry.
            drop((watch_tx, control_tx));
            trigger.await.unwrap();
            channel.close().await;
            drop(channel);
            assert_eq!(
                timeout(Duration::from_secs(2), server)
                    .await
                    .unwrap()
                    .unwrap(),
                0,
                "{mode}"
            );
        }
    }
}
