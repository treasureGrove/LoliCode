//! Native direct-only task transport. The authenticated service carries only
//! bounded, separately encrypted SDP; it never receives task packet bytes.
use super::{crypto, Secret};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures::{SinkExt, StreamExt};
use ring::aead;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::mpsc,
    time::{interval, timeout, Interval},
};
use tokio_tungstenite::{
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
use webrtc::{
    api::APIBuilder,
    data_channel::{
        data_channel_init::RTCDataChannelInit, data_channel_state::RTCDataChannelState,
        RTCDataChannel,
    },
    ice_transport::{ice_candidate_type::RTCIceCandidateType, ice_server::RTCIceServer},
    peer_connection::{
        configuration::RTCConfiguration, peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription, RTCPeerConnection,
    },
};

const STUN: &str = "stun:lolicode.com:3478";
const MAX_SIGNAL: usize = 16 * 1024;
const MAX_SDP: usize = 10 * 1024;
const MAX_PACKET: usize = 64 * 1024;
const LABEL: &str = "lolicode.tasks.v1";
const PROTOCOL: &str = "lolicode-companion/1";
const UNAVAILABLE: &str = "直连不可用，请切换网络后重试；任务未经过中继";
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

enum Event {
    Open,
    Packet(String),
    Closed,
}

/// Dropping an in-progress negotiation closes UDP/DTLS, including on cancellation.
struct PeerGuard(Arc<RTCPeerConnection>);
impl Drop for PeerGuard {
    fn drop(&mut self) {
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let peer = self.0.clone();
            runtime.spawn(async move {
                let _ = peer.close().await;
            });
        }
    }
}

pub(super) struct DirectChannel {
    peer: PeerGuard,
    data: Arc<RTCDataChannel>,
    socket: Socket,
    events: mpsc::Receiver<Event>,
    ping: Interval,
    faulted: Arc<AtomicBool>,
    pending_packet: Option<String>,
    auth_refresh: super::account_transport::AuthRefresh,
}

impl DirectChannel {
    pub(super) async fn connect(
        relay_url: &str,
        room_id: &str,
        secret: &Secret,
        device_token: &str,
    ) -> Result<Self, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        timeout(
            Duration::from_secs(40),
            Self::negotiate(relay_url, room_id, secret, device_token),
        )
        .await
        .map_err(|_| UNAVAILABLE.to_string())?
    }

    async fn negotiate(
        relay_url: &str,
        room_id: &str,
        secret: &Secret,
        device_token: &str,
    ) -> Result<Self, String> {
        let config = WebSocketConfig {
            max_message_size: Some(MAX_SIGNAL),
            max_frame_size: Some(MAX_SIGNAL),
            ..Default::default()
        };
        let (mut socket, _) =
            tokio_tungstenite::connect_async_with_config(relay_url, Some(config), false)
                .await
                .map_err(|_| UNAVAILABLE)?;
        socket
            .send(Message::Text(
                json!({"type":"hello","v":1,"role":"desktop","roomId":room_id,
            "token":secret.desktop_token,"deviceToken":device_token})
                .to_string(),
            ))
            .await
            .map_err(|_| UNAVAILABLE)?;
        let mut ready = false;
        let mut auth_refresh = false;
        let mut online = false;
        while !ready || !online {
            let value = control_frame(&mut socket).await?;
            match value["type"].as_str() {
                Some("ready") if value["v"] == 1 => {
                    ready = true;
                    auth_refresh = value["authRefresh"] == true;
                }
                Some("peer") => online = value["online"] == true,
                _ => return Err(UNAVAILABLE.into()),
            }
        }
        let peer = PeerGuard(new_peer(&[STUN.to_string()]).await?);
        let (tx, mut events) = mpsc::channel(32);
        let faulted = Arc::new(AtomicBool::new(false));
        attach_peer(&peer.0, tx.clone(), faulted.clone());
        let data = peer
            .0
            .create_data_channel(
                LABEL,
                Some(RTCDataChannelInit {
                    ordered: Some(true),
                    protocol: Some(PROTOCOL.into()),
                    ..Default::default()
                }),
            )
            .await
            .map_err(|_| UNAVAILABLE)?;
        attach_data(&data, tx, faulted.clone());
        let offer = peer.0.create_offer(None).await.map_err(|_| UNAVAILABLE)?;
        let sdp = gather(&peer.0, offer).await?;
        validate_sdp(&sdp)?;
        let negotiation_id = uuid::Uuid::new_v4().to_string();
        let offer = seal_signal(
            &secret.key,
            room_id,
            "desktop",
            &json!({"type":"direct.offer",
            "negotiationId":negotiation_id,"sdp":sdp,"sentAt":crypto::now()}),
        )?;
        socket
            .send(Message::Text(offer.to_string()))
            .await
            .map_err(|_| UNAVAILABLE)?;
        let mut seen = BTreeSet::new();
        loop {
            let value = control_frame(&mut socket).await?;
            match value["type"].as_str() {
                Some("peer") if value["online"] == true => {}
                Some("signal") => {
                    let (id, answer) = open_signal(&secret.key, room_id, "phone", &value)?;
                    if !seen.insert(id)
                        || answer["type"] != "direct.answer"
                        || answer["negotiationId"] != negotiation_id
                    {
                        return Err(UNAVAILABLE.into());
                    }
                    let sdp = answer["sdp"].as_str().ok_or(UNAVAILABLE)?;
                    validate_sdp(sdp)?;
                    let description =
                        RTCSessionDescription::answer(sdp.to_string()).map_err(|_| UNAVAILABLE)?;
                    peer.0
                        .set_remote_description(description)
                        .await
                        .map_err(|_| UNAVAILABLE)?;
                    break;
                }
                _ => return Err(UNAVAILABLE.into()),
            }
        }
        // Keep processing revocation while ICE/DTLS/SCTP is connecting.
        let mut pending_packet = None;
        loop {
            tokio::select! {
                event = events.recv() => match event {
                    Some(Event::Open) => break,
                    Some(Event::Packet(text)) if data.ready_state() == RTCDataChannelState::Open && !faulted.load(Ordering::Acquire) => {
                        // webrtc-rs dispatches on_open and its receive loop on
                        // separate tasks. Preserve an authenticated peer's early
                        // packet instead of treating callback order as failure.
                        pending_packet = Some(text);
                        break;
                    },
                    _ => return Err(UNAVAILABLE.into()),
                },
                control = control_frame(&mut socket) => {
                    let control = control?;
                    if control["type"] != "peer" || control["online"] != true { return Err(UNAVAILABLE.into()); }
                }
            }
        }
        verify_direct_pair(&peer.0).await?;
        Ok(Self {
            peer,
            data,
            socket,
            events,
            ping: interval(Duration::from_secs(25)),
            faulted,
            pending_packet,
            auth_refresh: super::account_transport::AuthRefresh::new(auth_refresh),
        })
    }

    pub(super) async fn ready_to_send(&self) -> bool {
        !self.faulted.load(Ordering::Acquire)
            && self.data.ready_state() == RTCDataChannelState::Open
            && self.data.buffered_amount().await <= 16 * 1024
    }
    pub(super) async fn refresh_authorization(
        &mut self,
        ticket: &str,
        expires: u64,
    ) -> Result<(), String> {
        if let Some(message) = self.auth_refresh.request(ticket, expires)? {
            timeout(
                Duration::from_secs(3),
                self.socket.send(Message::Text(message.to_string())),
            )
            .await
            .map_err(|_| UNAVAILABLE)?
            .map_err(|_| UNAVAILABLE)?;
        }
        Ok(())
    }
    pub(super) fn take_renewed_expiry(&mut self) -> Option<u64> {
        self.auth_refresh.take_renewed()
    }
    pub(super) async fn send(&mut self, mut packet: Value) -> Result<(), String> {
        if self.faulted.load(Ordering::Acquire)
            || packet["type"] != "packet"
            || packet["v"] != 1
            || self.data.ready_state() != RTCDataChannelState::Open
        {
            return Err(UNAVAILABLE.into());
        }
        packet["from"] = json!("desktop");
        let text = serde_json::to_string(&packet).map_err(|_| UNAVAILABLE)?;
        if text.len() > MAX_PACKET || self.data.buffered_amount().await + text.len() > 512 * 1024 {
            self.close().await;
            return Err(UNAVAILABLE.into());
        }
        self.data.send_text(text).await.map_err(|_| UNAVAILABLE)?;
        Ok(())
    }

    pub(super) async fn recv(&mut self) -> Result<Option<Value>, String> {
        if let Some(text) = self.pending_packet.take() {
            return self.task_packet(&text).map(Some);
        }
        loop {
            if self.faulted.load(Ordering::Acquire) {
                self.close().await;
                return Err(UNAVAILABLE.into());
            }
            tokio::select! {
                event = self.events.recv() => match event {
                    Some(Event::Packet(text)) => {
                        return self.task_packet(&text).map(Some);
                    },
                    Some(Event::Open) => continue,
                    _ => return Ok(None),
                },
                control = control_frame(&mut self.socket) => {
                    let control = control?;
                    if control["type"] == "auth.renewed" {
                        self.auth_refresh.accept(&control)?;
                        return Ok(Some(json!({"type":"transport.auth.renewed"})));
                    }
                    if control["type"] != "peer" || control["online"] != true {
                        self.close().await;
                        return Err(UNAVAILABLE.into());
                    }
                },
                _ = self.ping.tick() => {
                    self.socket.send(Message::Ping(Vec::new())).await.map_err(|_| UNAVAILABLE)?;
                }
            }
        }
    }

    fn task_packet(&self, text: &str) -> Result<Value, String> {
        if self.faulted.load(Ordering::Acquire)
            || self.data.ready_state() != RTCDataChannelState::Open
        {
            return Err(UNAVAILABLE.into());
        }
        let value: Value = serde_json::from_str(text).map_err(|_| UNAVAILABLE)?;
        if value["type"] != "packet" || value["v"] != 1 || value["from"] != "phone" {
            return Err(UNAVAILABLE.into());
        }
        Ok(value)
    }

    pub(super) async fn close(&mut self) {
        let _ = self.peer.0.close().await;
        let _ = self.socket.close(None).await;
    }
}

async fn new_peer(stun: &[String]) -> Result<Arc<RTCPeerConnection>, String> {
    // Tauri's dependency graph also enables aws-lc; select the application's
    // ring provider explicitly instead of relying on rustls feature inference.
    let _ = rustls::crypto::ring::default_provider().install_default();
    // This constructor accepts STUN only. TURN is not configurable by SDP or UI.
    if stun
        .iter()
        .any(|url| !url.starts_with("stun:") || url.contains('@') || url.len() > 200)
    {
        return Err(UNAVAILABLE.into());
    }
    let servers = if stun.is_empty() {
        vec![]
    } else {
        vec![RTCIceServer {
            urls: stun.to_vec(),
            ..Default::default()
        }]
    };
    let peer = APIBuilder::new()
        .build()
        .new_peer_connection(RTCConfiguration {
            ice_servers: servers,
            ..Default::default()
        })
        .await
        .map_err(|_| UNAVAILABLE)?;
    Ok(Arc::new(peer))
}

async fn gather(
    peer: &RTCPeerConnection,
    description: RTCSessionDescription,
) -> Result<String, String> {
    let mut complete = peer.gathering_complete_promise().await;
    peer.set_local_description(description)
        .await
        .map_err(|_| UNAVAILABLE)?;
    // A nonresponsive STUN helper does not prevent local/IPv6 candidate use.
    let _ = timeout(Duration::from_secs(10), complete.recv()).await;
    peer.local_description()
        .await
        .map(|value| value.sdp)
        .ok_or_else(|| UNAVAILABLE.into())
}

fn attach_peer(peer: &RTCPeerConnection, tx: mpsc::Sender<Event>, faulted: Arc<AtomicBool>) {
    peer.on_peer_connection_state_change(Box::new(move |state| {
        if matches!(
            state,
            RTCPeerConnectionState::Failed
                | RTCPeerConnectionState::Closed
                | RTCPeerConnectionState::Disconnected
        ) {
            faulted.store(true, Ordering::Release);
            let _ = tx.try_send(Event::Closed);
        }
        Box::pin(async {})
    }));
}

fn attach_data(data: &Arc<RTCDataChannel>, tx: mpsc::Sender<Event>, faulted: Arc<AtomicBool>) {
    let opened = tx.clone();
    data.on_open(Box::new(move || {
        Box::pin(async move {
            let _ = opened.try_send(Event::Open);
        })
    }));
    let closed = tx.clone();
    let close_fence = faulted.clone();
    data.on_close(Box::new(move || {
        let closed = closed.clone();
        close_fence.store(true, Ordering::Release);
        Box::pin(async move {
            let _ = closed.try_send(Event::Closed);
        })
    }));
    let failed = tx.clone();
    let error_fence = faulted.clone();
    data.on_error(Box::new(move |_| {
        let failed = failed.clone();
        error_fence.store(true, Ordering::Release);
        Box::pin(async move {
            let _ = failed.try_send(Event::Closed);
        })
    }));
    let weak = Arc::downgrade(data);
    data.on_message(Box::new(move |message| {
        let tx = tx.clone();
        let weak = weak.clone();
        let faulted = faulted.clone();
        Box::pin(async move {
            let text = if message.is_string && message.data.len() <= MAX_PACKET {
                String::from_utf8(message.data.to_vec()).ok()
            } else {
                None
            };
            if text
                .and_then(|text| tx.try_send(Event::Packet(text)).ok())
                .is_none()
            {
                faulted.store(true, Ordering::Release);
                let _ = tx.try_send(Event::Closed);
                if let Some(data) = weak.upgrade() {
                    let _ = data.close().await;
                }
            }
        })
    }));
}

async fn verify_direct_pair(peer: &RTCPeerConnection) -> Result<(), String> {
    let pair = peer
        .sctp()
        .transport()
        .ice_transport()
        .get_selected_candidate_pair()
        .await
        .ok_or(UNAVAILABLE)?;
    if pair.local.typ == RTCIceCandidateType::Relay || pair.remote.typ == RTCIceCandidateType::Relay
    {
        return Err(UNAVAILABLE.into());
    }
    Ok(())
}

async fn control_frame(socket: &mut Socket) -> Result<Value, String> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) if text.len() <= MAX_SIGNAL => {
                let value: Value = serde_json::from_str(&text).map_err(|_| UNAVAILABLE)?;
                if value["type"] == "packet" || value["type"] == "error" {
                    return Err(UNAVAILABLE.into());
                }
                return Ok(value);
            }
            Some(Ok(Message::Ping(data))) => {
                socket
                    .send(Message::Pong(data))
                    .await
                    .map_err(|_| UNAVAILABLE)?;
            }
            Some(Ok(Message::Pong(_))) => {}
            _ => return Err(UNAVAILABLE.into()),
        }
    }
}

fn validate_sdp(sdp: &str) -> Result<(), String> {
    if sdp.is_empty() || sdp.len() > MAX_SDP || sdp.contains('\0') {
        return Err(UNAVAILABLE.into());
    }
    let mut application = 0;
    let mut fingerprint = false;
    for line in sdp.lines() {
        if line.starts_with("m=") {
            if !line.starts_with("m=application ") || !line.contains("webrtc-datachannel") {
                return Err(UNAVAILABLE.into());
            }
            application += 1;
        }
        if line.starts_with("a=fingerprint:sha-256 ") {
            fingerprint = true;
        }
        if line.starts_with("a=candidate:") {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.get(6) != Some(&"typ")
                || !matches!(fields.get(7), Some(&"host" | &"srflx" | &"prflx"))
            {
                return Err(UNAVAILABLE.into());
            }
        }
    }
    if application != 1 || !fingerprint {
        return Err(UNAVAILABLE.into());
    }
    Ok(())
}

fn signal_aad(room: &str, role: &str, id: &str) -> String {
    format!("lolicode-companion-signaling/1|{room}|{role}|{id}")
}
fn seal_signal(key: &[u8; 32], room: &str, role: &str, payload: &Value) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let nonce = crypto::random::<12>()?;
    let mut body = serde_json::to_vec(payload).map_err(|_| UNAVAILABLE)?;
    if body.len() > 11 * 1024 {
        return Err(UNAVAILABLE.into());
    }
    let cipher = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| UNAVAILABLE)?,
    );
    cipher
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(signal_aad(room, role, &id)),
            &mut body,
        )
        .map_err(|_| UNAVAILABLE)?;
    let value = json!({"type":"signal","v":1,"id":id,"nonce":crypto::encode(&nonce),"ciphertext":crypto::encode(&body)});
    if value.to_string().len() > MAX_SIGNAL {
        return Err(UNAVAILABLE.into());
    }
    Ok(value)
}
fn open_signal(
    key: &[u8; 32],
    room: &str,
    role: &str,
    packet: &Value,
) -> Result<(String, Value), String> {
    if packet["type"] != "signal"
        || packet["v"] != 1
        || packet["from"] != role
        || packet.to_string().len() > MAX_SIGNAL
    {
        return Err(UNAVAILABLE.into());
    }
    let id = packet["id"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or(UNAVAILABLE)?;
    let nonce: [u8; 12] = URL_SAFE_NO_PAD
        .decode(packet["nonce"].as_str().ok_or(UNAVAILABLE)?)
        .map_err(|_| UNAVAILABLE)?
        .try_into()
        .map_err(|_| UNAVAILABLE)?;
    let mut body = URL_SAFE_NO_PAD
        .decode(packet["ciphertext"].as_str().ok_or(UNAVAILABLE)?)
        .map_err(|_| UNAVAILABLE)?;
    if body.len() < 16 || body.len() > 11 * 1024 + 16 {
        return Err(UNAVAILABLE.into());
    }
    let cipher = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| UNAVAILABLE)?,
    );
    let plaintext = cipher
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(signal_aad(room, role, id)),
            &mut body,
        )
        .map_err(|_| UNAVAILABLE)?;
    let value: Value = serde_json::from_slice(plaintext).map_err(|_| UNAVAILABLE)?;
    let sent = value["sentAt"].as_u64().ok_or(UNAVAILABLE)?;
    if crypto::now().abs_diff(sent) > crypto::WINDOW_MS {
        return Err(UNAVAILABLE.into());
    }
    Ok((id.to_string(), value))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signaling_is_bound_to_its_channel_role_room_and_authenticated_content() {
        let key = [7; 32];
        let mut signal = seal_signal(
            &key,
            "room",
            "phone",
            &json!({"type":"direct.answer","sentAt":crypto::now()}),
        )
        .unwrap();
        signal["from"] = json!("phone");
        assert!(open_signal(&key, "room", "phone", &signal).is_ok());
        assert!(open_signal(&key, "other", "phone", &signal).is_err());
        assert!(open_signal(&key, "room", "desktop", &signal).is_err());
        assert!(crypto::open(&key, "room", &signal, crypto::now()).is_err());
        let mut changed = signal.clone();
        changed["type"] = json!("packet");
        assert!(crypto::open(&key, "room", &changed, crypto::now()).is_err());
        signal["ciphertext"] = json!("A".repeat(32));
        assert!(open_signal(&key, "room", "phone", &signal).is_err());
    }
    #[tokio::test]
    async fn native_host_candidates_carry_data_without_any_task_relay() {
        let offerer = PeerGuard(new_peer(&[]).await.unwrap());
        let answerer = PeerGuard(new_peer(&[]).await.unwrap());
        let (offer_tx, mut offer_rx) = mpsc::channel(32);
        let (answer_tx, mut answer_rx) = mpsc::channel(32);
        let channel = offerer
            .0
            .create_data_channel(
                LABEL,
                Some(RTCDataChannelInit {
                    ordered: Some(true),
                    protocol: Some(PROTOCOL.into()),
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
        let close_fence = Arc::new(AtomicBool::new(false));
        attach_data(&channel, offer_tx.clone(), close_fence.clone());
        answerer.0.on_data_channel(Box::new(move |data| {
            assert_eq!(data.label(), LABEL);
            assert_eq!(data.protocol(), PROTOCOL);
            attach_data(&data, answer_tx.clone(), Arc::new(AtomicBool::new(false)));
            Box::pin(async {})
        }));
        let offer = gather(&offerer.0, offerer.0.create_offer(None).await.unwrap())
            .await
            .unwrap();
        validate_sdp(&offer).unwrap();
        assert!(validate_sdp(&format!("{offer}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n")).is_err());
        assert!(validate_sdp(&format!(
            "{offer}\r\na=candidate:1 1 udp 1 127.0.0.1 9 typ relay\r\n"
        ))
        .is_err());
        answerer
            .0
            .set_remote_description(RTCSessionDescription::offer(offer).unwrap())
            .await
            .unwrap();
        let answer = gather(&answerer.0, answerer.0.create_answer(None).await.unwrap())
            .await
            .unwrap();
        validate_sdp(&answer).unwrap();
        offerer
            .0
            .set_remote_description(RTCSessionDescription::answer(answer).unwrap())
            .await
            .unwrap();
        assert!(matches!(
            timeout(Duration::from_secs(15), offer_rx.recv())
                .await
                .unwrap(),
            Some(Event::Open)
        ));
        assert!(matches!(
            timeout(Duration::from_secs(15), answer_rx.recv())
                .await
                .unwrap(),
            Some(Event::Open)
        ));
        verify_direct_pair(&offerer.0).await.unwrap();
        verify_direct_pair(&answerer.0).await.unwrap();
        let key = [9; 32];
        let mut packet = crypto::seal(
            &key,
            "test-room",
            &json!({"type":"fixture","body":"x".repeat(20*1024),"sentAt":crypto::now()}),
        )
        .unwrap();
        packet["from"] = json!("desktop");
        let bytes = packet.to_string();
        channel.send_text(bytes.clone()).await.unwrap();
        match timeout(Duration::from_secs(15), answer_rx.recv())
            .await
            .unwrap()
            .unwrap()
        {
            Event::Packet(received) => assert_eq!(received, bytes),
            _ => panic!("no native direct payload"),
        }
        // A full event queue must never swallow the terminal close fence.
        for _ in 0..32 {
            assert!(offer_tx.try_send(Event::Packet("queued".into())).is_ok());
        }
        answerer.0.close().await.unwrap();
        timeout(Duration::from_secs(3), async {
            while !close_fence.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("close was lost behind a full packet queue");
        offerer.0.close().await.unwrap();
        answerer.0.close().await.unwrap();
    }

    /// Real-device interoperability, deliberately opt-in. HTTP over adb reverse
    /// contains SDP only; both 20 KiB payloads must cross native UDP/DTLS/SCTP.
    #[tokio::test]
    #[ignore = "requires Android RustDirectInteropTest and adb reverse tcp:3127"]
    async fn android_native_interop() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        timeout(Duration::from_secs(180), async {
            let listener = TcpListener::bind("127.0.0.1:3127").await.unwrap();
            let stun = if std::env::var("LOLICODE_INTEROP_STUN").as_deref() == Ok("true") { vec![STUN.to_string()] } else { vec![] };
            let peer = PeerGuard(new_peer(&stun).await.unwrap());
            let (tx,mut rx) = mpsc::channel(32);
            let channel = peer.0.create_data_channel(LABEL,Some(RTCDataChannelInit {
                ordered:Some(true),protocol:Some(PROTOCOL.into()),..Default::default()
            })).await.unwrap();
            attach_data(&channel,tx,Arc::new(AtomicBool::new(false)));
            let offer = gather(&peer.0,peer.0.create_offer(None).await.unwrap()).await.unwrap();
            validate_sdp(&offer).unwrap();
            let room = "f".repeat(32);
            let key = [42;32];
            let offer_body = json!({"sdp":offer,"roomId":room,"testKey":crypto::encode(&key)}).to_string();
            println!("Android interop SDP helper ready on 127.0.0.1:3127 (public test identity only)");
            let mut signaling_http_bytes = 0usize;
            for _ in 0..8 {
                let (mut stream,_) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let (header_end,content_length) = loop {
                    let mut chunk = [0u8;4096];
                    let n = stream.read(&mut chunk).await.unwrap();
                    assert!(n>0 && request.len()+n<=32*1024);
                    request.extend_from_slice(&chunk[..n]);
                    if let Some(end) = request.windows(4).position(|w|w==b"\r\n\r\n") {
                        let header = std::str::from_utf8(&request[..end]).unwrap();
                        let length = header.lines().find_map(|line| {
                            let (name,value)=line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length").then(||value.trim().parse::<usize>().unwrap())
                        }).unwrap_or(0);
                        assert!(length<=MAX_SDP+1024);
                        break (end+4,length);
                    }
                };
                while request.len()<header_end+content_length {
                    let mut chunk=[0u8;4096];
                    let n=stream.read(&mut chunk).await.unwrap();
                    assert!(n>0 && request.len()+n<=32*1024);
                    request.extend_from_slice(&chunk[..n]);
                }
                signaling_http_bytes+=request.len();
                let first=std::str::from_utf8(&request[..header_end]).unwrap().lines().next().unwrap().to_string();
                let answered=first=="POST /answer HTTP/1.1";
                let body=if first=="GET /offer HTTP/1.1" { offer_body.clone() }
                else if answered {
                    let answer:Value=serde_json::from_slice(&request[header_end..header_end+content_length]).unwrap();
                    let sdp=answer["sdp"].as_str().unwrap();validate_sdp(sdp).unwrap();
                    peer.0.set_remote_description(RTCSessionDescription::answer(sdp.into()).unwrap()).await.unwrap();
                    "{\"ok\":true}".into()
                } else { panic!("unexpected interop HTTP route"); };
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                signaling_http_bytes+=response.len();
                stream.write_all(response.as_bytes()).await.unwrap();stream.shutdown().await.unwrap();
                if answered {break;}
            }
            let opened = timeout(Duration::from_secs(30),rx.recv()).await;
            assert!(matches!(opened,Ok(Some(Event::Open))), "native interop did not open: ice={}, peer={}",peer.0.ice_connection_state(),peer.0.connection_state());
            verify_direct_pair(&peer.0).await.unwrap();
            let mut ping=crypto::seal(&key,&room,&json!({"type":"interop.ping","body":"x".repeat(20480),"sentAt":crypto::now()})).unwrap();
            ping["from"]=json!("desktop");
            let ping=ping.to_string();
            channel.send_text(ping.clone()).await.unwrap();
            let Event::Packet(pong)=timeout(Duration::from_secs(30),rx.recv()).await.unwrap().unwrap() else {panic!("no Android direct packet")};
            let packet:Value=serde_json::from_str(&pong).unwrap();
            let (_,plain)=crypto::open(&key,&room,&packet,crypto::now()).unwrap();
            assert_eq!(plain["type"],"interop.pong");assert_eq!(plain["body"],"y".repeat(20480));
            let mut ack=crypto::seal(&key,&room,&json!({"type":"interop.ok","sentAt":crypto::now()})).unwrap();
            ack["from"]=json!("desktop");channel.send_text(ack.to_string()).await.unwrap();
            println!("{}",json!({"nativeAndroidRustInterop":true,"desktopEncryptedBytes":ping.len(),"phoneEncryptedBytes":pong.len(),"signalingHttpBytes":signaling_http_bytes,"taskWebSocketBytes":0,"turnConfigured":false,"selectedCandidatePair":"non-relay"}));
            tokio::time::sleep(Duration::from_secs(2)).await;
            peer.0.close().await.unwrap();
        }).await.expect("Android interop timed out");
    }
}
