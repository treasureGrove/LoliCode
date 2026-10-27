//! Phone-owned tasks in the normal desktop process. No window API or renderer
//! event is used here; a hidden/destroyed WebView never owns task delivery.
mod account;
mod account_crypto;
mod account_transport;
mod crypto;
mod direct;
mod text;
mod text_projection;
pub use account::AccountCompanionStatus;
#[cfg(test)]
mod tests;
use crate::{
    commands::agent_dispatch,
    database::Database,
    services::{agent_preferences, inprocess_agent::InprocessAgentState},
    store::AppState,
};
use crypto::{now, WINDOW_MS};
#[cfg(test)]
use futures::{SinkExt, StreamExt};
use lolicode_agent::{AgentSession, AgentSnapshot, AgentStatus};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Mutex};
#[cfg(test)]
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};

const STORE_KEY: &str = "lolicode_mobile_companion_v1";
const VAULT_SERVICE: &str = "art.treasuregrove.lolicode.companion.v1";
const MAX_ROOMS: usize = 8;
const MAX_RECORDS: usize = 20_000;
const MAX_SESSIONS: usize = 100;
pub const LEGACY_PAIRING_DISABLED: &str = "旧版配对中继已停用，请登录同一账户直连";

// Neither Debug nor public Serialize: only the explicit QR DTO leaves the host.
#[derive(Clone, Serialize, Deserialize)]
struct Secret {
    desktop_token: String,
    phone_token: String,
    key: [u8; 32],
}
trait Vault: Send + Sync {
    fn read(&self, room: &str) -> Result<Secret, String>;
    fn write(&self, room: &str, secret: &Secret) -> Result<(), String>;
    fn delete(&self, room: &str) -> Result<(), String>;
}
struct SystemVault;
impl Vault for SystemVault {
    fn read(&self, room: &str) -> Result<Secret, String> {
        let text = keyring::Entry::new(VAULT_SERVICE, room)
            .map_err(|_| "系统凭据库不可用")?
            .get_password()
            .map_err(|_| "无法读取手机配对凭据")?;
        serde_json::from_str(&text).map_err(|_| "手机配对凭据格式无效".into())
    }
    fn write(&self, room: &str, secret: &Secret) -> Result<(), String> {
        let text = serde_json::to_string(secret).map_err(|_| "配对凭据编码失败")?;
        keyring::Entry::new(VAULT_SERVICE, room)
            .map_err(|_| "系统凭据库不可用")?
            .set_password(&text)
            .map_err(|_| "无法安全保存配对凭据；配对未开启".into())
    }
    fn delete(&self, room: &str) -> Result<(), String> {
        match keyring::Entry::new(VAULT_SERVICE, room)
            .map_err(|_| "系统凭据库不可用")?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("本机已撤销，但系统凭据删除失败，请在凭据管理器清理此配对".into()),
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    rooms: BTreeMap<String, Room>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Room {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account: Option<account::AccountRoom>,
    relay_url: String,
    expires_at: u64,
    approved: bool,
    revoked: bool,
    device_id: Option<String>,
    device_name: Option<String>,
    sessions: BTreeSet<String>,
    #[serde(default)]
    requests: BTreeMap<String, Receipt>,
    #[serde(default)]
    seen_packets: BTreeMap<String, u64>,
    #[serde(default)]
    events: BTreeMap<String, Value>,
    #[serde(default)]
    active_requests: BTreeMap<String, String>,
    #[serde(default)]
    event_keys: BTreeSet<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Receipt {
    payload: String,
    response: Option<Value>,
    read_only: bool,
}
#[derive(Default)]
struct Connection {
    retry_at: u64,
    online: bool,
    last_error: Option<String>,
    tx: Option<mpsc::Sender<Control>>,
    transport: Option<&'static str>,
}
enum Control {
    Approved,
    Revoke,
    Stop,
}
struct Inner {
    account: account::AccountState,
    db: Arc<Database>,
    vault: Arc<dyn Vault>,
    store: Mutex<Store>,
    connections: Mutex<BTreeMap<String, Connection>>,
    gate: Mutex<()>,
    init_error: Option<String>,
    host_name: String,
}
#[derive(Clone)]
pub struct MobileCompanionState(Arc<Inner>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    host_name: String,
    protocol: u8,
    quiet_mode: bool,
    pairs: Vec<PairStatus>,
    last_error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStatus {
    account_id: Option<String>,
    peer_fingerprint: Option<String>,
    transport: Option<&'static str>,
    connection_state: &'static str,
    room_id: String,
    relay_url: String,
    approved: bool,
    device_id: Option<String>,
    device_name: Option<String>,
    online: bool,
    last_error: Option<String>,
    session_count: usize,
    expires_at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingQr {
    v: u8,
    relay_url: String,
    room_id: String,
    phone_token: String,
    key: String,
    host_name: String,
    expires_at: u64,
}

impl MobileCompanionState {
    pub fn new(db: Arc<Database>) -> Self {
        Self::with_vault(db, Arc::new(SystemVault))
    }
    fn with_vault(db: Arc<Database>, vault: Arc<dyn Vault>) -> Self {
        let loaded = db
            .get_setting(STORE_KEY)
            .map_err(|_| "手机配对记录无法读取".to_string())
            .and_then(|value| {
                value
                    .map(|v| {
                        serde_json::from_str::<Store>(&v)
                            .map_err(|_| "手机配对记录损坏，原记录已保留".into())
                    })
                    .unwrap_or_else(|| Ok(Store::default()))
            });
        let (mut store, init_error) = match loaded {
            Ok(store) => (store, None),
            Err(error) => (Store::default(), Some(error)),
        };
        for room in store.rooms.values_mut() {
            room.requests.retain(|_, receipt| !receipt.read_only);
        }
        let host_name = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "LoliCode 电脑".into())
            .chars()
            .filter(|c| !c.is_control())
            .take(80)
            .collect();
        Self(Arc::new(Inner {
            account: account::AccountState::new(&db),
            db,
            vault,
            store: Mutex::new(store),
            connections: Mutex::new(BTreeMap::new()),
            gate: Mutex::new(()),
            init_error,
            host_name,
        }))
    }
    fn save(&self, store: &Store) -> Result<(), String> {
        if let Some(error) = &self.0.init_error {
            return Err(error.clone());
        }
        let text = serde_json::to_string(store).map_err(|_| "手机配对记录编码失败")?;
        if text.len() > 16 * 1024 * 1024 {
            return Err("手机配对记录超过保存上限".into());
        }
        self.0
            .db
            .set_setting(STORE_KEY, &text)
            .map_err(|_| "手机配对记录保存失败".into())
    }
    pub async fn status(&self) -> CompanionStatus {
        let store = self.0.store.lock().await;
        let connections = self.0.connections.lock().await;
        CompanionStatus {
            host_name: self.0.host_name.clone(),
            protocol: 1,
            quiet_mode: true,
            last_error: self.0.init_error.clone(),
            pairs: store
                .rooms
                .iter()
                .filter(|(_, r)| !r.revoked)
                .map(|(id, r)| {
                    let connection = connections.get(id);
                    PairStatus {
                        account_id: r.account.as_ref().map(|a| a.account_id.clone()),
                        peer_fingerprint: r.account.as_ref().map(|a| a.phone_fingerprint.clone()),
                        transport: connection.filter(|c| c.online).map(|c| {
                            if let Some(transport) = c.transport {
                                return transport;
                            }
                            if r.account.is_some() {
                                "direct"
                            } else {
                                "relay"
                            }
                        }),
                        connection_state: if connection.is_some_and(|c| c.online) {
                            if let Some(transport) = connection.and_then(|c| c.transport) {
                                transport
                            } else if r.account.is_some() {
                                "direct"
                            } else {
                                "relay"
                            }
                        } else if connection.is_some_and(|c| c.tx.is_some()) {
                            "connecting"
                        } else {
                            "offline"
                        },
                        room_id: id.clone(),
                        relay_url: r.relay_url.clone(),
                        approved: r.approved,
                        device_id: r.device_id.clone(),
                        device_name: r.device_name.clone(),
                        online: connection.is_some_and(|c| c.online),
                        last_error: connection.and_then(|c| c.last_error.clone()),
                        session_count: r.sessions.len(),
                        expires_at: r.expires_at,
                    }
                })
                .collect(),
        }
    }
    #[cfg(test)]
    async fn start_pairing(&self, app: &AppHandle, relay_url: String) -> Result<PairingQr, String> {
        let relay_url = validate_relay(&relay_url)?;
        let _gate = self.0.gate.lock().await;
        let room_id = crypto::hex(&crypto::random::<16>()?);
        let secret = Secret {
            desktop_token: crypto::hex(&crypto::random::<32>()?),
            phone_token: crypto::hex(&crypto::random::<32>()?),
            key: crypto::random()?,
        };
        let expires_at = now() + WINDOW_MS;
        let mut store = self.0.store.lock().await;
        if store
            .rooms
            .values()
            .filter(|r| !r.revoked && (r.approved || r.expires_at > now()))
            .count()
            >= MAX_ROOMS
        {
            return Err("最多绑定 8 台手机，请先撤销旧配对".into());
        }
        self.0.vault.write(&room_id, &secret)?;
        let mut next = store.clone();
        next.rooms.insert(
            room_id.clone(),
            Room {
                account: None,
                relay_url: relay_url.clone(),
                expires_at,
                approved: false,
                revoked: false,
                device_id: None,
                device_name: None,
                sessions: BTreeSet::new(),
                requests: BTreeMap::new(),
                seen_packets: BTreeMap::new(),
                events: BTreeMap::new(),
                active_requests: BTreeMap::new(),
                event_keys: BTreeSet::new(),
            },
        );
        if let Err(error) = self.save(&next) {
            let _ = self.0.vault.delete(&room_id);
            return Err(error);
        }
        *store = next;
        drop(store);
        self.start_room(app.clone(), room_id.clone()).await;
        Ok(PairingQr {
            v: 1,
            relay_url,
            room_id,
            phone_token: secret.phone_token,
            key: crypto::encode(&secret.key),
            host_name: self.0.host_name.clone(),
            expires_at,
        })
    }
    #[cfg(test)]
    async fn approve(&self, room_id: &str, device_id: &str) -> Result<(), String> {
        let _gate = self.0.gate.lock().await;
        let mut store = self.0.store.lock().await;
        let mut next = store.clone();
        let room = next
            .rooms
            .get_mut(room_id)
            .filter(|r| {
                !r.revoked
                    && !r.approved
                    && r.expires_at >= now()
                    && r.device_id.as_deref() == Some(device_id)
            })
            .ok_or("配对已过期、已批准或手机身份已改变")?;
        room.approved = true;
        self.save(&next)?;
        *store = next;
        drop(store);
        if let Some(tx) = self
            .0
            .connections
            .lock()
            .await
            .get(room_id)
            .and_then(|c| c.tx.clone())
        {
            let _ = tx.send(Control::Approved).await;
        }
        Ok(())
    }
    pub async fn revoke(&self, app: &AppHandle, room_id: &str) -> Result<(), String> {
        let _gate = self.0.gate.lock().await;
        let mut store = self.0.store.lock().await;
        let mut next = store.clone();
        let room = next.rooms.get_mut(room_id).ok_or("未找到此配对")?;
        room.revoked = true;
        let account = room.account.clone();
        let sessions = room.sessions.clone();
        self.save(&next)?;
        *store = next;
        drop(store);
        if let Some(tx) = self
            .0
            .connections
            .lock()
            .await
            .get(room_id)
            .and_then(|c| c.tx.clone())
        {
            let _ = tx.send(Control::Stop).await;
        }
        for session in sessions {
            let _ = agent_dispatch::interrupt_agent_session(app.clone(), session).await;
        }
        // Account revocation retains its authenticated remote cleanup. Legacy
        // records are archived locally; never reopen an anonymous relay or
        // delete an old vault key whose remote registration cannot be verified.
        if let Some(binding) = account {
            drop(_gate);
            self.revoke_account_remote(room_id, &binding).await?;
        }
        Ok(())
    }
    pub async fn restore(&self, app: AppHandle) {
        // Old QR rooms, history and vault entries stay untouched. Startup has
        // no anonymous relay restore or legacy revocation retry loop.
        self.restore_account(app).await;
    }
    #[cfg(test)]
    fn start_revoke_cleanup(&self, room_id: String, relay_url: String) {
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(secret) = state.0.vault.read(&room_id) else {
                return;
            };
            loop {
                let outcome=tokio::time::timeout(Duration::from_secs(15),async{
                    let config=WebSocketConfig{max_message_size:Some(64*1024),max_frame_size:Some(64*1024),..Default::default()};
                    let (mut socket,_)=tokio_tungstenite::connect_async_with_config(&relay_url,Some(config),false).await.map_err(|_|())?;
                    socket.send(Message::Text(json!({"type":"hello","v":1,"role":"desktop","roomId":room_id,"token":secret.desktop_token,"phoneToken":secret.phone_token}).to_string())).await.map_err(|_|())?;
                    while let Some(Ok(frame))=socket.next().await{
                        if let Message::Text(text)=frame{let Ok(value)=serde_json::from_str::<Value>(&text) else{continue;};
                            if value["type"]=="room.revoked"||(value["type"]=="error"&&value["code"]=="unauthorized"){return Ok::<(),()>(());}
                            if value["type"]=="ready"{socket.send(Message::Text(json!({"type":"room.revoke"}).to_string())).await.map_err(|_|())?;}
                        }
                    }Err(())
                }).await;
                if matches!(outcome, Ok(Ok(()))) {
                    let _ = state.0.vault.delete(&room_id);
                    return;
                }
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });
    }
    async fn account_room_may_start(&self, room_id: &str) -> bool {
        self.0
            .store
            .lock()
            .await
            .rooms
            .get(room_id)
            .is_some_and(|room| room.account.is_some() && room.approved && !room.revoked)
    }
    async fn start_room(&self, app: AppHandle, room_id: String) {
        if !self.account_room_may_start(&room_id).await {
            return;
        }
        let (tx, rx) = mpsc::channel(8);
        let mut connections = self.0.connections.lock().await;
        if connections
            .get(&room_id)
            .is_some_and(|c| c.retry_at > now())
        {
            return;
        }
        if connections.get(&room_id).is_some_and(|c| c.tx.is_some()) {
            return;
        }
        connections.insert(
            room_id.clone(),
            Connection {
                tx: Some(tx),
                ..Default::default()
            },
        );
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            state.room_worker(app, room_id, rx).await;
        });
    }
    async fn connection(&self, room: &str, online: bool, error: Option<String>) {
        if let Some(c) = self.0.connections.lock().await.get_mut(room) {
            c.online = online;
            c.last_error = error;
        }
    }
    async fn room_worker(
        &self,
        app: AppHandle,
        room_id: String,
        controls: mpsc::Receiver<Control>,
    ) {
        if self.account_room_may_start(&room_id).await {
            self.direct_room_worker(app, room_id, controls).await;
            return;
        }
        #[cfg(test)]
        {
            let mut controls = controls;
            'worker: loop {
                let room = self.0.store.lock().await.rooms.get(&room_id).cloned();
                let Some(room) =
                    room.filter(|r| !r.revoked && (r.approved || r.expires_at > now()))
                else {
                    break;
                };
                let secret = match self.0.vault.read(&room_id) {
                    Ok(secret) => secret,
                    Err(error) => {
                        self.connection(&room_id, false, Some(error)).await;
                        break;
                    }
                };
                let config = WebSocketConfig {
                    max_message_size: Some(64 * 1024),
                    max_frame_size: Some(64 * 1024),
                    ..Default::default()
                };
                let opened = tokio::time::timeout(
                    Duration::from_secs(15),
                    tokio_tungstenite::connect_async_with_config(
                        &room.relay_url,
                        Some(config),
                        false,
                    ),
                )
                .await;
                match opened {
                    Ok(Ok((mut socket, _))) => {
                        if !self.room_enabled(&room_id).await {
                            let _ = socket.close(None).await;
                            break;
                        }
                        let hello = json!({"type":"hello","v":1,"role":"desktop","roomId":room_id,"token":secret.desktop_token,"phoneToken":secret.phone_token});
                        if socket.send(Message::Text(hello.to_string())).await.is_err() {
                            continue;
                        }
                        let mut tick = tokio::time::interval(Duration::from_secs(2));
                        let mut ready = false;
                        let mut peer_online = false;
                        let mut event_attempts = BTreeMap::<String, u64>::new();
                        let mut ready_deadline =
                            Box::pin(tokio::time::sleep(Duration::from_secs(5)));
                        loop {
                            tokio::select! {
                                _ = &mut ready_deadline, if !ready => { self.connection(&room_id,false,Some("设备中转认证超时".into())).await; break; }
                                control = controls.recv() => {
                                    match control {
                                        Some(Control::Revoke) => { let _=socket.send(Message::Text(json!({"type":"room.revoke"}).to_string())).await; let _=socket.close(None).await; break 'worker; }
                                        Some(Control::Stop)|None => {let _=socket.close(None).await;break 'worker;}
                                        Some(Control::Approved) if ready => { if let Some(message)=self.approval_message(&room_id).await { if self.send_payload(&mut socket,&secret,&room_id,message).await.is_err(){break;} } }
                                        _ => {}
                                    }
                                }
                                _ = tick.tick(), if ready => {
                                    if !self.room_enabled(&room_id).await {let _=socket.close(None).await;break;}
                                    if let Err(error) = self.monitor(&app,&room_id).await { self.connection(&room_id,false,Some(error)).await; }
                                    let pending = self.0.store.lock().await.rooms.get(&room_id).map(|r|r.events.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
                                    for event in pending {
                                        let event_id=event["eventId"].as_str().unwrap_or("").to_string();
                                        if event_attempts.get(&event_id).is_some_and(|time|now().saturating_sub(*time)<60_000){continue;}
                                        if peer_online && self.send_payload(&mut socket,&secret,&room_id,event.clone()).await.is_err() { break; }
                                        event_attempts.insert(event_id,now());
                                        let notice=json!({"type":"push.notice","eventId":event["eventId"],"kind":event["kind"],"sessionId":event["sessionId"]});
                                        let _=socket.send(Message::Text(notice.to_string())).await;
                                    }
                                }
                                frame = socket.next() => {
                                    let Some(Ok(frame))=frame else { break; };
                                    match frame {
                                        Message::Text(text) => {
                                            let Ok(value)=serde_json::from_str::<Value>(&text) else { continue; };
                                            match value["type"].as_str() {
                                                Some("ready") => { ready=true; self.connection(&room_id,false,None).await; if let Some(message)=self.approval_message(&room_id).await{if self.send_payload(&mut socket,&secret,&room_id,message).await.is_err(){break;}} }
                                                Some("peer") => { peer_online=value["online"]==true;self.connection(&room_id,peer_online,None).await; if peer_online{event_attempts.clear();if let Some(message)=self.approval_message(&room_id).await{if self.send_payload(&mut socket,&secret,&room_id,message).await.is_err(){break;}}} }
                                                Some("packet") if ready => {
                                                    match self.receive(&app,&room_id,&secret,&value).await {
                                                        Ok(Some(reply)) => { if self.send_payload(&mut socket,&secret,&room_id,reply).await.is_err(){break;} }
                                                        Ok(None)=>{}, Err(error)=>self.connection(&room_id,false,Some(error)).await,
                                                    }
                                                }
                                                Some("push.result") if value["accepted"]==true => { self.ack_event(&room_id,value["eventId"].as_str().unwrap_or("")).await; }
                                                Some("error") => { self.connection(&room_id,false,Some("设备中转拒绝了请求，请检查配对或中转配置".into())).await; break; }
                                                _ => {}
                                            }
                                        }
                                        Message::Ping(data)=>{let _=socket.send(Message::Pong(data)).await;}, Message::Close(_)=>break, _=>{}
                                    }
                                }
                            }
                        }
                    }
                    _ => {
                        self.connection(
                            &room_id,
                            false,
                            Some("无法连接设备中转，正在后台重试".into()),
                        )
                        .await
                    }
                }
                if let Some(c) = self.0.connections.lock().await.get_mut(&room_id) {
                    c.online = false;
                }
                // No window or focus side effect, including reconnect and backoff.
                tokio::select! { _=tokio::time::sleep(Duration::from_secs(5))=>{}, control=controls.recv()=>{if matches!(control,Some(Control::Revoke|Control::Stop)|None){break;}} }
            }
            if let Some(c) = self.0.connections.lock().await.get_mut(&room_id) {
                c.online = false;
                c.tx = None;
            }
        }
    }
    #[cfg(test)]
    async fn send_payload<S>(
        &self,
        socket: &mut tokio_tungstenite::WebSocketStream<S>,
        secret: &Secret,
        room: &str,
        payload: Value,
    ) -> Result<(), String>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let mut payload = payload;
        payload["sentAt"] = json!(now());
        socket
            .send(Message::Text(
                crypto::seal(&secret.key, room, &payload)?.to_string(),
            ))
            .await
            .map_err(|_| "设备连接已中断".into())
    }
    async fn approval_message(&self, room: &str) -> Option<Value> {
        self.0
            .store
            .lock()
            .await
            .rooms
            .get(room)
            .filter(|r| r.approved && !r.revoked)
            .and_then(|r| r.device_id.clone())
            .map(|device|json!({"type":"pair.approved","deviceId":device,"hostName":self.0.host_name,"sentAt":now()}))
    }
    async fn room_enabled(&self, room: &str) -> bool {
        let room = self.0.store.lock().await.rooms.get(room).cloned();
        let Some(room) = room.filter(|r| !r.revoked && (r.approved || r.expires_at > now())) else {
            return false;
        };
        if let Some(binding) = &room.account {
            self.account_room_ticket(binding).await.is_some()
        } else {
            true
        }
    }
    async fn receive(
        &self,
        app: &AppHandle,
        room_id: &str,
        secret: &Secret,
        packet: &Value,
    ) -> Result<Option<Value>, String> {
        if !self.room_enabled(room_id).await {
            return Err("手机连接已停止或账号认证已失效".into());
        }
        let (id, payload) = crypto::open(&secret.key, room_id, packet, now())?;
        {
            let mut store = self.0.store.lock().await;
            let mut next = store.clone();
            let room = next
                .rooms
                .get_mut(room_id)
                .filter(|r| !r.revoked)
                .ok_or("配对已撤销")?;
            room.seen_packets
                .retain(|_, time| now().saturating_sub(*time) <= WINDOW_MS);
            if room.seen_packets.contains_key(&id) {
                return Err("重复的加密包已拒绝".into());
            }
            if room.seen_packets.len() >= MAX_RECORDS {
                return Err("消息速率超过上限".into());
            }
            room.seen_packets.insert(id, now());
            self.save(&next)?;
            *store = next;
        }
        self.receive_payload(app, room_id, payload, false).await
    }
    async fn receive_payload(
        &self,
        app: &AppHandle,
        room_id: &str,
        payload: Value,
        text_only: bool,
    ) -> Result<Option<Value>, String> {
        if !self.room_enabled(room_id).await {
            return Err("手机连接已停止或账号认证已失效".into());
        }
        if payload["type"] == "event.ack" {
            let event_id = bounded(&payload, "eventId", 128)?;
            self.ack_event(room_id, event_id).await;
            return Ok(None);
        }
        if payload["type"] == "pair.request" {
            let device = bounded(&payload, "deviceId", 128)?;
            let name = bounded(&payload, "deviceName", 128)?;
            let mut store = self.0.store.lock().await;
            let mut next = store.clone();
            let room = next
                .rooms
                .get_mut(room_id)
                .filter(|r| !r.revoked)
                .ok_or("配对已撤销")?;
            if room.device_id.as_deref().is_some_and(|id| id != device) {
                return Ok(Some(json!({"type":"pair.rejected","sentAt":now()})));
            }
            if room.approved {
                return Ok(Some(
                    json!({"type":"pair.approved","deviceId":device,"hostName":self.0.host_name,"sentAt":now()}),
                ));
            }
            if room.expires_at < now() {
                return Ok(Some(json!({"type":"pair.rejected","sentAt":now()})));
            }
            room.device_id = Some(device.into());
            room.device_name = Some(name.into());
            self.save(&next)?;
            *store = next;
            return Ok(None);
        }
        if payload["type"] != "request" {
            return Err("未知消息类型".into());
        }
        Ok(Some(
            self.request_with_mode(app, room_id, payload, text_only)
                .await,
        ))
    }
    async fn request_with_mode(
        &self,
        app: &AppHandle,
        room_id: &str,
        payload: Value,
        text_only: bool,
    ) -> Value {
        let request_id = match bounded(&payload, "requestId", 128) {
            Ok(id) => id.to_string(),
            Err(error) => return response("", Err(error)),
        };
        if text_only {
            if let Err(error) = text_projection::validate_request(
                payload["method"].as_str().unwrap_or(""),
                &payload["params"],
            ) {
                return response(&request_id, Err(error));
            }
        }
        let _gate = self.0.gate.lock().await;
        if !self.room_enabled(room_id).await {
            return response(&request_id, Err("手机连接已停止或账号认证已失效".into()));
        }
        let fingerprint = request_fingerprint(&payload);
        let read_only = matches!(
            payload["method"].as_str(),
            Some("status" | "projects.list" | "models.list" | "sessions.list" | "session.get")
        );
        {
            let mut store = self.0.store.lock().await;
            let mut next = store.clone();
            let Some(room) = next
                .rooms
                .get_mut(room_id)
                .filter(|r| r.approved && !r.revoked)
            else {
                return response(
                    &request_id,
                    Err("手机尚未在电脑上批准，或配对已撤销".into()),
                );
            };
            match admit_request(room, &request_id, &fingerprint, read_only) {
                Ok(Some(reply)) => {
                    if !text_only {
                        return reply;
                    }
                    // A receipt may have been created over direct transport.
                    // Re-project it without re-executing the mutation.
                    let projected = text_projection::project_receipt(
                        payload["method"].as_str().unwrap_or(""),
                        &payload["params"],
                        &reply,
                    );
                    return response(&request_id, projected);
                }
                Err(error) => return response(&request_id, Err(error)),
                Ok(None) => {}
            }
            if !read_only {
                if let Err(error) = self.save(&next) {
                    return response(&request_id, Err(error));
                }
                *store = next;
            }
        }
        let mut dispatched = payload.clone();
        if text_only && payload["method"] == "session.get" {
            if let Some(params) = dispatched["params"].as_object_mut() {
                params.remove("knownRevision");
                params.remove("offset");
                params.remove("limit");
            }
        }
        let outcome = self
            .dispatch(app, room_id, &request_id, &dispatched, text_only)
            .await;
        let result = if text_only {
            text_projection::project_outcome(
                payload["method"].as_str().unwrap_or(""),
                &payload["params"],
                outcome,
            )
        } else {
            outcome
        }
        .and_then(bound_result);
        let reply = response(&request_id, result);
        if read_only {
            return reply;
        }
        let mut store = self.0.store.lock().await;
        let mut next = store.clone();
        if let Some(record) = next
            .rooms
            .get_mut(room_id)
            .and_then(|r| r.requests.get_mut(&request_id))
            .filter(|r| !r.read_only)
        {
            record.response = Some(reply.clone());
        }
        if self.save(&next).is_ok() {
            *store = next;
            reply
        } else {
            response(
                &request_id,
                Err("请求可能已执行，但回执保存失败；请读取会话状态，不要重复提交".into()),
            )
        }
    }
    async fn dispatch(
        &self,
        app: &AppHandle,
        room_id: &str,
        request_id: &str,
        payload: &Value,
        text_only: bool,
    ) -> Result<Value, String> {
        let method = bounded(payload, "method", 64)?;
        let params = &payload["params"];
        let allowed: &[&str] = match method {
            "status" | "projects.list" | "sessions.list" => &[],
            "models.list" => &["projectPath"],
            "session.create" => &["projectPath", "modelId", "title"],
            "session.get" | "run.cancel" => &["sessionId"],
            "message.send" => &["sessionId", "text"],
            "permission.reply" => &["sessionId", "permissionId", "decision"],
            "question.reply" => &["sessionId", "questionId", "answers"],
            _ => return Err("此远程方法未开放".into()),
        };
        let object = params.as_object().ok_or("请求参数必须为对象")?;
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err("请求包含未开放的参数".into());
        }
        let host = app.state::<InprocessAgentState>();
        match method {
            "status" => Ok(json!({"hostName":self.0.host_name,"protocol":1,"quietMode":true})),
            "projects.list" => Ok(Value::Array(
                agent_dispatch::list_agent_projects(app.clone())
                    .await?
                    .into_iter()
                    .map(|p| json!({"path":p.path,"name":p.name}))
                    .collect(),
            )),
            "models.list" | "session.create" => {
                let path = bounded(params, "projectPath", 4096)?;
                self.check_project(app, path)?;
                let catalog = host
                    .bind_background_project(
                        app,
                        app.state::<AppState>().inner(),
                        path.into(),
                        agent_dispatch::accounts(app).await?,
                    )
                    .await?;
                if method == "models.list" {
                    return serde_json::to_value(catalog).map_err(|_| "模型目录编码失败".into());
                }
                if self
                    .0
                    .store
                    .lock()
                    .await
                    .rooms
                    .get(room_id)
                    .is_some_and(|r| r.sessions.len() >= MAX_SESSIONS)
                {
                    return Err("此手机会话数量已达上限".into());
                }
                let model = bounded(params, "modelId", 512)?;
                let title = params
                    .get("title")
                    .map(|_| bounded(params, "title", 160))
                    .transpose()?;
                let session:AgentSession=host.call("createSession",json!({"projectPath":path,"modelId":model,"title":title,"mode":"build","permissionMode":"ask","backgroundOnly":true}),true).await?;
                let mut store = self.0.store.lock().await;
                let mut next = store.clone();
                next.rooms
                    .get_mut(room_id)
                    .ok_or("配对已撤销")?
                    .sessions
                    .insert(session.id.clone());
                self.save(&next)?;
                *store = next;
                serde_json::to_value(session).map_err(|_| "会话编码失败".into())
            }
            "sessions.list" => {
                let ids = self.owned_sessions(room_id).await?;
                let mut values = Vec::new();
                host.ensure_started(app).await?;
                // List surviving sessions in explicitly registered projects.
                // Deleted sessions and removed projects must not poison the
                // entire phone workspace, and no current-project fallback runs.
                for project in agent_dispatch::list_agent_projects(app.clone()).await? {
                    let sessions: Vec<AgentSession> = host
                        .call(
                            "listSessions",
                            json!({"projectPath":project.path,"includeArchived":false}),
                            false,
                        )
                        .await?;
                    for session in sessions
                        .into_iter()
                        .filter(|session| ids.contains(&session.id))
                    {
                        values.push(serde_json::to_value(session).map_err(|_| "会话编码失败")?);
                    }
                }
                Ok(Value::Array(values))
            }
            _ => {
                let id = bounded(params, "sessionId", 128)?;
                let snapshot = self.owned_snapshot(app, room_id, id).await?;
                match method {
                    "session.get" if text_only => {
                        serde_json::to_value(snapshot).map_err(|_| "会话编码失败".into())
                    }
                    "session.get" => bounded_snapshot(snapshot),
                    "message.send" => {
                        if !matches!(snapshot.status, AgentStatus::Idle | AgentStatus::Error) {
                            return Err("此会话仍在执行或等待审批，请先停止或等待完成".into());
                        }
                        let text = params["text"]
                            .as_str()
                            .filter(|s| {
                                !s.trim().is_empty() && s.len() <= 20 * 1024 && !s.contains('\0')
                            })
                            .ok_or("消息为空或超过 20 KiB")?;
                        host.bind_background_project(
                            app,
                            app.state::<AppState>().inner(),
                            snapshot.session.project_path.clone(),
                            agent_dispatch::accounts(app).await?,
                        )
                        .await?;
                        // Persist origin/active task before allowing the native mutation.
                        let mut store = self.0.store.lock().await;
                        let mut next = store.clone();
                        let previous = next
                            .rooms
                            .get_mut(room_id)
                            .ok_or("配对已撤销")?
                            .active_requests
                            .insert(id.into(), request_id.into());
                        self.save(&next)?;
                        *store = next;
                        drop(store);
                        let accepted:Result<Value,String>=host.call("sendMessage",json!({"sessionId":id,"text":text,"requestId":format!("mobile:{request_id}"),"locale":"zh"}),true).await;
                        if let Err(error) = accepted {
                            let mut store = self.0.store.lock().await;
                            let mut next = store.clone();
                            if let Some(room) = next.rooms.get_mut(room_id) {
                                if let Some(previous) = previous {
                                    room.active_requests.insert(id.into(), previous);
                                } else {
                                    room.active_requests.remove(id);
                                }
                            }
                            self.save(&next)?;
                            *store = next;
                            return Err(error);
                        }
                        Ok(json!({"accepted":true,"requestId":request_id}))
                    }
                    "run.cancel" => {
                        agent_dispatch::interrupt_agent_session(app.clone(), id.into()).await?;
                        Ok(json!({"accepted":true}))
                    }
                    "permission.reply" => {
                        let pending = bounded(params, "permissionId", 128)?;
                        let decision = bounded(params, "decision", 16)?;
                        if !matches!(decision, "once" | "reject")
                            || !snapshot
                                .permissions
                                .iter()
                                .any(|p| p.id == pending && p.session_id == id)
                        {
                            return Err("审批已结束或选择无效，请刷新会话".into());
                        }
                        agent_dispatch::reply_agent_permission(
                            app.clone(),
                            id.into(),
                            pending.into(),
                            decision.into(),
                        )
                        .await?;
                        Ok(json!({"accepted":true}))
                    }
                    "question.reply" => {
                        let pending = bounded(params, "questionId", 128)?;
                        if !snapshot
                            .questions
                            .iter()
                            .any(|q| q.id == pending && q.session_id == id)
                        {
                            return Err("提问已结束，请刷新会话".into());
                        }
                        agent_dispatch::reply_agent_question(
                            app.clone(),
                            id.into(),
                            pending.into(),
                            params["answers"].clone(),
                        )
                        .await?;
                        Ok(json!({"accepted":true}))
                    }
                    _ => Err("此远程方法未开放".into()),
                }
            }
        }
    }
    fn check_project(&self, app: &AppHandle, path: &str) -> Result<(), String> {
        let projects = agent_preferences::load(&app.state::<AppState>().db)?;
        if !projects
            .projects
            .contains_key(&agent_preferences::path_key(path))
        {
            return Err("手机只能使用电脑已打开的项目".into());
        }
        Ok(())
    }
    async fn owned_sessions(&self, room: &str) -> Result<BTreeSet<String>, String> {
        if !self.room_enabled(room).await {
            return Err("手机未授权或账号认证已失效".into());
        }
        self.0
            .store
            .lock()
            .await
            .rooms
            .get(room)
            .filter(|r| r.approved && !r.revoked)
            .map(|r| r.sessions.clone())
            .ok_or("手机未授权".into())
    }
    async fn owned_snapshot(
        &self,
        app: &AppHandle,
        room: &str,
        id: &str,
    ) -> Result<AgentSnapshot, String> {
        if !self.owned_sessions(room).await?.contains(id) {
            return Err("此会话不属于当前手机，未读取或修改".into());
        }
        let snapshot = agent_dispatch::get_agent_session(app.clone(), id.into()).await?;
        self.check_project(app, &snapshot.session.project_path)?;
        Ok(snapshot)
    }
    async fn monitor(&self, app: &AppHandle, room_id: &str) -> Result<(), String> {
        let _gate = self.0.gate.lock().await;
        let ids: Vec<_> = self
            .0
            .store
            .lock()
            .await
            .rooms
            .get(room_id)
            .filter(|r| r.approved && !r.revoked)
            .map(|r| r.active_requests.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            let snapshot = match self.owned_snapshot(app, room_id, &id).await {
                Ok(snapshot) => snapshot,
                Err(_) => continue,
            };
            let mut store = self.0.store.lock().await;
            let mut next = store.clone();
            let room = next.rooms.get_mut(room_id).ok_or("配对已撤销")?;
            let active = room.active_requests.get(&id).cloned();
            let mut notices = Vec::new();
            for p in &snapshot.permissions {
                notices.push((format!("permission:{}", p.id), "approval_required"));
            }
            for q in &snapshot.questions {
                notices.push((format!("question:{}", q.id), "question_required"));
            }
            if let Some(request) = &active {
                if snapshot
                    .messages
                    .iter()
                    .any(|m| m.role == "user" && m.id == format!("mobile:{request}"))
                {
                    match snapshot.status {
                        AgentStatus::Idle => {
                            notices.push((format!("done:{request}"), "task_completed"))
                        }
                        AgentStatus::Error => {
                            notices.push((format!("error:{request}"), "task_failed"))
                        }
                        _ => {}
                    }
                }
            }
            let mut changed = false;
            for (key, kind) in notices {
                if room.event_keys.contains(&key) {
                    continue;
                }
                if room.event_keys.len() >= MAX_RECORDS || room.events.len() >= MAX_RECORDS {
                    return Err("通知记录已达上限，请新建配对".into());
                }
                let event_id = uuid::Uuid::new_v4().to_string();
                room.event_keys.insert(key);
                room.events.insert(event_id.clone(),json!({"type":"event","eventId":event_id,"kind":kind,"sessionId":id,"requestId":active,"sentAt":now()}));
                changed = true;
            }
            if matches!(snapshot.status, AgentStatus::Idle | AgentStatus::Error) && active.is_some()
            {
                room.active_requests.remove(&id);
                changed = true;
            }
            if changed {
                self.save(&next)?;
                *store = next;
            }
        }
        Ok(())
    }
    async fn ack_event(&self, room_id: &str, event_id: &str) {
        let mut store = self.0.store.lock().await;
        let mut next = store.clone();
        if let Some(room) = next.rooms.get_mut(room_id) {
            room.events.remove(event_id);
        }
        if self.save(&next).is_ok() {
            *store = next;
        }
    }
}

fn bounded<'a>(value: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .ok_or_else(|| format!("参数 {key} 缺失或超出范围"))
}
fn request_fingerprint(payload: &Value) -> String {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                let sorted: BTreeMap<_, _> = object
                    .iter()
                    .map(|(k, v)| (k.clone(), canonical(v)))
                    .collect();
                serde_json::to_value(sorted).unwrap_or(Value::Null)
            }
            Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
            other => other.clone(),
        }
    }
    let bytes = serde_json::to_vec(&canonical(
        &json!({"method":payload["method"],"params":payload["params"]}),
    ))
    .unwrap_or_default();
    crypto::hex(&Sha256::digest(bytes))
}
fn admit_request(
    room: &mut Room,
    id: &str,
    fingerprint: &str,
    read_only: bool,
) -> Result<Option<Value>, String> {
    if let Some(receipt) = room.requests.get(id) {
        if let Some(reply) = receipt_replay(receipt, id, fingerprint)? {
            return Ok(Some(reply));
        }
    }
    // Polling is repeatable and must never consume the durable mutation ledger.
    // A previous mutation ID is still checked above, including on a read request.
    if read_only {
        return Ok(None);
    }
    if room.requests.len() >= MAX_RECORDS {
        return Err("此配对的操作记录已达上限，请创建新配对；未重复执行旧请求".into());
    }
    room.requests.insert(
        id.into(),
        Receipt {
            payload: fingerprint.into(),
            response: None,
            read_only: false,
        },
    );
    Ok(None)
}
fn receipt_replay(receipt: &Receipt, id: &str, fingerprint: &str) -> Result<Option<Value>, String> {
    if receipt.payload != fingerprint {
        return Err("请求编号已用于不同内容；没有执行".into());
    }
    if receipt.read_only {
        return Ok(None);
    }
    Ok(Some(receipt.response.clone().unwrap_or_else(|| {
        response(
            id,
            Err("原请求结果尚未确认，请读取会话状态；为避免重复操作未重新执行".into()),
        )
    })))
}
fn response(id: &str, result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => {
            json!({"type":"response","requestId":id,"ok":true,"result":value,"sentAt":now()})
        }
        Err(error) => {
            json!({"type":"response","requestId":id,"ok":false,"error":{"code":"request_rejected","message":error.chars().take(500).collect::<String>()},"sentAt":now()})
        }
    }
}
#[cfg(test)]
fn validate_relay(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw).map_err(|_| "中转地址无效")?;
    let local = cfg!(debug_assertions)
        && std::env::var("LOLICODE_COMPANION_ALLOW_LOCAL").as_deref() == Ok("1")
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if raw.len() > 2048
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || !(url.scheme() == "wss" || (url.scheme() == "ws" && local))
    {
        return Err("必须使用无凭据参数的 WSS 中转地址；仅显式本地开发允许回环 WS".into());
    }
    Ok(url.into())
}

#[cfg(test)]
mod archived_legacy_tests {
    use super::*;

    struct UntouchedVault;
    impl Vault for UntouchedVault {
        fn read(&self, _: &str) -> Result<Secret, String> {
            panic!("archived relay credentials must not be read");
        }
        fn write(&self, _: &str, _: &Secret) -> Result<(), String> {
            panic!("archived relay credentials must not be replaced");
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            panic!("archived relay credentials must not be deleted");
        }
    }

    #[tokio::test]
    async fn room_start_admission_archives_legacy_data_without_touching_vault() {
        let db = Arc::new(Database::memory().unwrap());
        let room = json!({
            "relayUrl":"wss://example.invalid/old-relay",
            "expiresAt":now()+WINDOW_MS,
            "approved":true,"revoked":false,
            "deviceId":"legacy-phone","deviceName":"Old phone",
            "sessions":["lc:owned-history"],
            "requests":{"old-request":{"payload":"old-hash","response":{"ok":true},"read_only":false}},
            "seenPackets":{"old-packet":123},
            "events":{"old-event":{"type":"event","eventId":"old-event"}},
            "activeRequests":{"lc:owned-history":"old-request"},
            "eventKeys":["old-event-key"]
        });
        let mut rooms = serde_json::Map::new();
        rooms.insert("legacy-approved".into(), room.clone());
        let mut pending = room.clone();
        pending["approved"] = json!(false);
        rooms.insert("legacy-pending".into(), pending);
        let mut revoked = room.clone();
        revoked["revoked"] = json!(true);
        rooms.insert("legacy-revoked".into(), revoked);
        let mut account = room.clone();
        account["account"] = json!({
            "accountId":"7","challenge":"fixture-challenge","requestId":"fixture-request",
            "desktopDeviceId":"desktop","phoneDeviceId":"phone",
            "desktopFingerprint":"desktop-fingerprint","phoneFingerprint":"phone-fingerprint",
            "envelopeHash":"fixture-envelope-hash"
        });
        rooms.insert("account-approved".into(), account.clone());
        account["revoked"] = json!(true);
        rooms.insert("account-revoked".into(), account.clone());
        account["revoked"] = json!(false);
        account["approved"] = json!(false);
        rooms.insert("account-pending".into(), account);
        let original = json!({"rooms":rooms}).to_string();
        db.set_setting(STORE_KEY, &original).unwrap();

        // The same admission check runs before start_room allocates a control
        // channel, reads a credential or spawns a transport worker.
        let state = MobileCompanionState::with_vault(db.clone(), Arc::new(UntouchedVault));
        for id in [
            "legacy-approved",
            "legacy-pending",
            "legacy-revoked",
            "account-pending",
            "account-revoked",
            "missing",
        ] {
            assert!(!state.account_room_may_start(id).await, "{id}");
        }
        assert!(state.account_room_may_start("account-approved").await);
        assert!(state.0.connections.lock().await.is_empty());
        let reloaded = serde_json::to_value(&*state.0.store.lock().await).unwrap();
        assert_eq!(reloaded["rooms"]["legacy-approved"], room);
        assert_eq!(db.get_setting(STORE_KEY).unwrap().unwrap(), original);
    }
}
fn bound_result(value: Value) -> Result<Value, String> {
    if serde_json::to_vec(&value)
        .map_err(|_| "结果编码失败")?
        .len()
        > 28 * 1024
    {
        Err("结果超过移动端传输上限，请在电脑端查看完整内容".into())
    } else {
        Ok(value)
    }
}
fn bounded_snapshot(snapshot: AgentSnapshot) -> Result<Value, String> {
    let mut value = serde_json::to_value(snapshot).map_err(|_| "会话编码失败")?;
    let mut truncated = false;
    while serde_json::to_vec(&value)
        .map_err(|_| "会话编码失败")?
        .len()
        > 27 * 1024
    {
        if let Some(messages) = value["messages"].as_array_mut().filter(|m| !m.is_empty()) {
            messages.remove(0);
            truncated = true;
            continue;
        }
        if value["diffs"].as_array().is_some_and(|d| !d.is_empty()) {
            value["diffs"] = json!([]);
            truncated = true;
            continue;
        }
        return Err("此审批或会话元数据过大，请在电脑端查看；手机未作任何审批".into());
    }
    if truncated {
        value["truncated"] = json!(true);
        value["truncationMessage"] = json!("较早消息或差异已省略；请在电脑端查看完整内容");
    }
    Ok(value)
}
