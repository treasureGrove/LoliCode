//! Native-owned account discovery. No credential, ticket or envelope crosses IPC.
use super::account_crypto::{self as keys, Identity, StoredIdentity};
use super::*;
use crate::services::lolicode_account::LolicodeAccountState;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(test)]
#[path = "account_tests.rs"]
mod tests;

const SETTINGS: &str = "lolicode_mobile_companion_account_v2";
const IDENTITY_SERVICE: &str = "art.treasuregrove.lolicode.companion.identity.v2";
const BASE: &str = "https://lolicode.com/companion/v2";
pub(super) const RELAY: &str = "wss://lolicode.com/companion/ws";
const FAILURE: &str = "账号设备服务暂不可用，请稍后重试";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub device_id: String,
    pub device_name: String,
    pub kind: String,
    pub public_key: String,
    pub fingerprint: String,
    pub online: bool,
    pub last_seen_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EnrollmentRequest {
    pub request_id: String,
    pub account_id: String,
    pub challenge: String,
    pub desktop: Device,
    pub phone: Device,
    pub created_at: u64,
    pub expires_at: u64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub envelope: Option<Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCompanionStatus {
    protocol: u8,
    enabled: bool,
    signed_in: bool,
    account_id: Option<String>,
    device: Option<Device>,
    devices: Vec<Device>,
    requests: Vec<Value>,
    ticket_expires_at: Option<u64>,
    last_error: Option<String>,
    transport: &'static str,
    direct_available: bool,
    transport_policy: &'static str,
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    device_name: Option<String>,
    #[serde(default)]
    peers: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AccountRoom {
    pub account_id: String,
    pub challenge: String,
    pub request_id: String,
    pub desktop_device_id: String,
    pub phone_device_id: String,
    pub desktop_fingerprint: String,
    pub phone_fingerprint: String,
    pub envelope_hash: String,
}
// Deliberately no Debug or Serialize implementation.
#[derive(Clone)]
pub(super) struct Ticket {
    account_id: String,
    token: String,
    expires_at: u64,
    device: Device,
}
pub(super) trait IdentityVault: Send + Sync {
    fn read(&self, account_id: &str) -> Result<Option<StoredIdentity>, String>;
    fn write(&self, account_id: &str, value: &StoredIdentity) -> Result<(), String>;
    fn read_legacy(&self) -> Result<Option<StoredIdentity>, String>;
}
struct OsIdentityVault;
fn identity_entry(account_id: &str) -> Result<String, String> {
    if account_id
        .parse::<u64>()
        .ok()
        .is_none_or(|id| id == 0 || id.to_string() != account_id)
    {
        return Err("账号身份无效，连接未建立".into());
    }
    Ok(format!("account:{account_id}"))
}
impl OsIdentityVault {
    fn read_entry(&self, entry: &str) -> Result<Option<StoredIdentity>, String> {
        match keyring::Entry::new(IDENTITY_SERVICE, entry)
            .map_err(|_| "设备系统凭据库不可用")?
            .get_password()
        {
            Ok(text) => serde_json::from_str(&text)
                .map(Some)
                .map_err(|_| "设备密钥损坏，原密钥已保留；请勿重新配对".into()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("无法读取系统设备密钥，连接未建立".into()),
        }
    }
}
impl IdentityVault for OsIdentityVault {
    fn read(&self, account_id: &str) -> Result<Option<StoredIdentity>, String> {
        self.read_entry(&identity_entry(account_id)?)
    }
    fn write(&self, account_id: &str, value: &StoredIdentity) -> Result<(), String> {
        keyring::Entry::new(IDENTITY_SERVICE, &identity_entry(account_id)?)
            .map_err(|_| "设备系统凭据库不可用")?
            .set_password(&serde_json::to_string(value).map_err(|_| "设备密钥编码失败")?)
            .map_err(|_| "无法安全保存设备密钥，连接未建立".into())
    }
    fn read_legacy(&self) -> Result<Option<StoredIdentity>, String> {
        self.read_entry("installation")
    }
}
pub(super) struct Runtime {
    settings: Settings,
    identity: Option<(String, Arc<Identity>)>,
    ticket: Option<Ticket>,
    account_id: Option<String>,
    devices: Vec<Device>,
    requests: Vec<EnrollmentRequest>,
    visible_until: u64,
    last_presence: u64,
    last_error: Option<String>,
    suspended: bool,
    worker_started: bool,
}
impl Runtime {
    pub fn new(db: &Database) -> Self {
        let loaded = db
            .get_setting(SETTINGS)
            .map_err(|_| "账号设备设置无法读取")
            .and_then(|value| {
                value
                    .map(|text| {
                        serde_json::from_str::<Settings>(&text)
                            .map_err(|_| "账号设备设置损坏，原记录已保留")
                    })
                    .unwrap_or_else(|| Ok(Settings::default()))
            });
        let (settings, last_error) = match loaded {
            Ok(settings) => (settings, None),
            Err(error) => (Settings::default(), Some(error.into())),
        };
        Self {
            settings,
            identity: None,
            ticket: None,
            account_id: None,
            devices: vec![],
            requests: vec![],
            visible_until: 0,
            last_presence: 0,
            last_error,
            suspended: false,
            worker_started: false,
        }
    }
}
pub(super) struct AccountState {
    runtime: Mutex<Runtime>,
    gate: Mutex<()>,
    identity_gate: Mutex<()>,
    epoch: AtomicU64,
    changes: tokio::sync::watch::Sender<u64>,
    vault: Arc<dyn IdentityVault>,
    api: Api,
    wake: tokio::sync::Notify,
}
impl AccountState {
    pub fn new(db: &Database) -> Self {
        Self {
            runtime: Mutex::new(Runtime::new(db)),
            gate: Mutex::new(()),
            identity_gate: Mutex::new(()),
            epoch: AtomicU64::new(0),
            changes: tokio::sync::watch::channel(0).0,
            vault: Arc::new(OsIdentityVault),
            api: Api::production(),
            wake: tokio::sync::Notify::new(),
        }
    }
}

struct Api {
    client: reqwest::Client,
    base: String,
}
impl Api {
    fn production() -> Self {
        Self::new(BASE, false).expect("fixed companion service URL")
    }
    fn new(base: &str, local: bool) -> Result<Self, String> {
        let url = url::Url::parse(base).map_err(|_| FAILURE)?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.host_str().is_none()
            || !(url.scheme() == "https"
                || (local
                    && url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
        {
            return Err(FAILURE.into());
        }
        Ok(Self {
            base: base.trim_end_matches('/').into(),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(12))
                .build()
                .map_err(|_| FAILURE)?,
        })
    }
    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        token: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(token)
            .header("Accept", "application/json");
        if let Some(body) = body {
            if body.to_string().len() > 16 * 1024 {
                return Err(FAILURE.into());
            }
            request = request.json(&body);
        }
        let mut response = request.send().await.map_err(|_| FAILURE)?;
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => "设备认证已过期或被撤销，请重新连接账号",
                409 => "请求状态已经改变，请刷新设备列表",
                429 => "设备连接请求过于频繁，请稍后重试",
                _ => FAILURE,
            }
            .into());
        }
        if response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| v.split(';').next() != Some("application/json"))
        {
            return Err(FAILURE.into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| FAILURE)? {
            if bytes.len() + chunk.len() > 256 * 1024 {
                return Err(FAILURE.into());
            }
            bytes.extend(chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| FAILURE.into())
    }
}

impl MobileCompanionState {
    fn save_account(&self, settings: &Settings) -> Result<(), String> {
        if let Some(text) = self
            .0
            .db
            .get_setting(SETTINGS)
            .map_err(|_| "账号设备设置无法读取")?
        {
            serde_json::from_str::<Settings>(&text)
                .map_err(|_| "账号设备设置损坏，原记录已保留")?;
        }
        if settings.peers.len() > 128 {
            return Err("已记录设备过多，请先管理账号设备".into());
        }
        self.0
            .db
            .set_setting(
                SETTINGS,
                &serde_json::to_string(settings).map_err(|_| FAILURE)?,
            )
            .map_err(|_| "账号设备设置保存失败".into())
    }
    pub async fn account_status(&self) -> AccountCompanionStatus {
        let runtime = self.0.account.runtime.lock().await;
        let requests = runtime
            .requests
            .iter()
            .map(|request| {
                let mut value = serde_json::to_value(request).unwrap_or(Value::Null);
                if let Some(value) = value.as_object_mut() {
                    value.remove("envelope");
                }
                value
            })
            .collect();
        AccountCompanionStatus {
            protocol: 2,
            enabled: runtime.settings.enabled,
            signed_in: runtime.account_id.is_some(),
            account_id: runtime.account_id.clone(),
            device: runtime.ticket.as_ref().map(|t| t.device.clone()),
            devices: runtime.devices.clone(),
            requests,
            ticket_expires_at: runtime.ticket.as_ref().map(|t| t.expires_at),
            last_error: runtime.last_error.clone(),
            transport: "direct",
            direct_available: true,
            transport_policy: "directPreferredTextFallback",
        }
    }
    async fn identity(&self, account_id: &str, epoch: u64) -> Result<Arc<Identity>, String> {
        identity_entry(account_id)?;
        // Separate from the request gate, which callers already hold. Logout
        // never waits for this vault I/O; the epoch check below prevents a
        // queued or completed lookup from restoring fenced memory state.
        let _identity_gate = self.0.account.identity_gate.lock().await;
        {
            let runtime = self.0.account.runtime.lock().await;
            self.check_epoch(epoch)?;
            if let Some((_, identity)) =
                runtime.identity.as_ref().filter(|(id, _)| id == account_id)
            {
                return Ok(identity.clone());
            }
        }
        let bindings = self
            .0
            .store
            .lock()
            .await
            .rooms
            .values()
            .filter_map(|room| room.account.clone())
            .collect::<Vec<_>>();
        let vault = self.0.account.vault.clone();
        let scope = account_id.to_owned();
        let may_own_legacy = bindings.iter().any(|binding| binding.account_id == scope);
        let identity = tokio::task::spawn_blocking(move || match vault.read(&scope)? {
            Some(value) => Identity::load(&value),
            None => {
                if let Some(legacy) = if may_own_legacy {
                    vault.read_legacy()?
                } else {
                    None
                } {
                    let identity = Identity::load(&legacy)?;
                    let owners = bindings
                        .iter()
                        .filter(|binding| {
                            binding.desktop_device_id == identity.device_id
                                && binding.desktop_fingerprint == identity.fingerprint
                        })
                        .map(|binding| binding.account_id.as_str())
                        .collect::<BTreeSet<_>>();
                    // A legacy installation key has no account field. Copy it
                    // only when persisted room bindings prove one owner; never
                    // change or delete that entry, even after a successful copy.
                    if owners.len() == 1 && owners.contains(scope.as_str()) {
                        vault.write(&scope, &legacy)?;
                        return Ok(identity);
                    }
                }
                let (identity, stored) = Identity::generate()?;
                vault.write(&scope, &stored)?;
                Ok(identity)
            }
        })
        .await
        .map_err(|_| "设备凭据库无法响应")??;
        let identity = Arc::new(identity);
        let mut runtime = self.0.account.runtime.lock().await;
        self.check_epoch(epoch)?;
        runtime.identity = Some((account_id.to_owned(), identity.clone()));
        Ok(identity)
    }
    pub async fn connect_account(
        &self,
        app: &AppHandle,
        name: Option<String>,
    ) -> Result<AccountCompanionStatus, String> {
        {
            let account_rooms = self
                .0
                .store
                .lock()
                .await
                .rooms
                .iter()
                .filter(|(_, r)| r.account.is_some())
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let mut connections = self.0.connections.lock().await;
            for id in account_rooms {
                if let Some(c) = connections.get_mut(&id) {
                    c.retry_at = 0;
                    c.last_error = None;
                }
            }
        }
        {
            let mut runtime = self.0.account.runtime.lock().await;
            let mut settings = runtime.settings.clone();
            if let Some(name) = name {
                if name.trim().is_empty() || name.len() > 128 || name.chars().any(char::is_control)
                {
                    return Err("设备名称无效".into());
                }
                settings.device_name = Some(name);
            }
            settings.enabled = true;
            self.save_account(&settings)?;
            runtime.settings = settings;
            runtime.suspended = false;
        }
        let outcome = self.refresh_account(app).await;
        if let Err(error) = outcome {
            self.0.account.runtime.lock().await.last_error = Some(error);
        }
        self.start_account_worker(app.clone()).await;
        Ok(self.account_status().await)
    }
    pub async fn account_visible(&self, visible: bool) -> AccountCompanionStatus {
        self.0.account.runtime.lock().await.visible_until =
            if visible { now() + 15_000 } else { 0 };
        if visible {
            self.0.account.wake.notify_one();
        }
        self.account_status().await
    }
    pub async fn account_changed(&self, app: &AppHandle, id: Option<String>) {
        let current = self.0.account.runtime.lock().await.account_id.clone();
        if current != id {
            self.fence_account(app).await;
            let mut runtime = self.0.account.runtime.lock().await;
            runtime.account_id = id;
            runtime.suspended = runtime.account_id.is_none();
        }
        if self.0.account.runtime.lock().await.settings.enabled {
            self.start_account_worker(app.clone()).await;
        }
        self.0.account.wake.notify_one();
    }
    /// Clear credentials first; then wait for admitted mutations and stop them.
    /// A failed remote revocation never restores local authority.
    pub async fn fence_account(&self, app: &AppHandle) {
        self.fence_account_state().await;
        let _gate = self.0.gate.lock().await;
        let rooms = self
            .0
            .store
            .lock()
            .await
            .rooms
            .iter()
            .filter(|(_, r)| r.account.is_some())
            .map(|(id, r)| (id.clone(), r.sessions.clone()))
            .collect::<Vec<_>>();
        for (id, sessions) in rooms {
            if let Some(tx) = self
                .0
                .connections
                .lock()
                .await
                .get(&id)
                .and_then(|c| c.tx.clone())
            {
                let _ = tx.try_send(Control::Stop);
            }
            for session in sessions {
                let _ = agent_dispatch::interrupt_agent_session(app.clone(), session).await;
            }
        }
    }
    pub(super) async fn fence_account_state(&self) {
        let epoch = self.0.account.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        self.0.account.changes.send_replace(epoch);
        {
            let mut runtime = self.0.account.runtime.lock().await;
            runtime.suspended = true;
            runtime.identity = None;
            runtime.ticket = None;
            runtime.account_id = None;
            runtime.devices.clear();
            runtime.requests.clear();
        }
    }
    pub async fn disconnect_account(
        &self,
        app: &AppHandle,
    ) -> Result<AccountCompanionStatus, String> {
        let ticket = self.0.account.runtime.lock().await.ticket.clone();
        self.fence_account(app).await;
        {
            let mut runtime = self.0.account.runtime.lock().await;
            let mut settings = runtime.settings.clone();
            settings.enabled = false;
            self.save_account(&settings)?;
            runtime.settings = settings;
        }
        if let Some(ticket) = ticket {
            if let Err(error) = self
                .0
                .account
                .api
                .call(reqwest::Method::DELETE, "/device", &ticket.token, None)
                .await
            {
                self.0.account.runtime.lock().await.last_error =
                    Some(format!("本机已停止连接；{error}"));
            }
        }
        Ok(self.account_status().await)
    }
    pub async fn logout_account(&self, app: &AppHandle) {
        let ticket = self.0.account.runtime.lock().await.ticket.clone();
        self.fence_account(app).await;
        if let Some(ticket) = ticket {
            if self
                .0
                .account
                .api
                .call(reqwest::Method::DELETE, "/device", &ticket.token, None)
                .await
                .is_err()
            {
                self.0.account.runtime.lock().await.last_error =
                    Some("本机已退出；远端设备撤销未确认，请登录原账号后检查设备列表".into());
            }
        }
    }
    pub(super) async fn restore_account(&self, app: AppHandle) {
        if self.0.account.runtime.lock().await.settings.enabled {
            self.start_account_worker(app).await;
        }
    }
    async fn start_account_worker(&self, app: AppHandle) {
        {
            let mut runtime = self.0.account.runtime.lock().await;
            if runtime.worker_started {
                return;
            }
            runtime.worker_started = true;
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let delay = {
                    let mut runtime = state.0.account.runtime.lock().await;
                    if !runtime.settings.enabled {
                        runtime.worker_started = false;
                        return;
                    }
                    if runtime.visible_until > now() {
                        3
                    } else {
                        30
                    }
                };
                let suspended = state.0.account.runtime.lock().await.suspended;
                if !suspended {
                    if let Err(error) = state.refresh_account(&app).await {
                        let expired = state
                            .0
                            .account
                            .runtime
                            .lock()
                            .await
                            .ticket
                            .as_ref()
                            .is_some_and(|t| t.expires_at <= now());
                        if error == "设备认证已过期或被撤销，请重新连接账号" {
                            state.fence_account(&app).await;
                        } else if expired {
                            state.0.account.runtime.lock().await.ticket = None;
                        }
                        state.0.account.runtime.lock().await.last_error = Some(error);
                    }
                }
                tokio::select! {_=tokio::time::sleep(Duration::from_secs(delay))=>{},_=state.0.account.wake.notified()=>{}}
            }
        });
    }
    pub(super) fn account_lifetime(&self) -> (u64, tokio::sync::watch::Receiver<u64>) {
        let changes = self.0.account.changes.subscribe();
        let epoch = *changes.borrow();
        (epoch, changes)
    }
    pub(super) fn check_epoch(&self, epoch: u64) -> Result<(), String> {
        if self.0.account.epoch.load(Ordering::SeqCst) != epoch {
            Err("账号已退出或发生改变，本次连接已丢弃".into())
        } else {
            Ok(())
        }
    }
    async fn refresh_account(&self, app: &AppHandle) -> Result<(), String> {
        let _gate = self.0.account.gate.lock().await;
        let epoch = self.0.account.epoch.load(Ordering::SeqCst);
        {
            let runtime = self.0.account.runtime.lock().await;
            if !runtime.settings.enabled || runtime.suspended {
                return Ok(());
            }
        }
        let (id, bearer) = app
            .state::<LolicodeAccountState>()
            .relay_credential(None)
            .await?;
        self.check_epoch(epoch)?;
        let previous = self.0.account.runtime.lock().await.account_id.clone();
        if previous.as_ref().is_some_and(|old| old != &id) {
            self.fence_account(app).await;
            return Err("账号已改变，请重新启用设备连接".into());
        }
        let identity = self.identity(&id, epoch).await?;
        self.check_epoch(epoch)?;
        let existing = self.0.account.runtime.lock().await.ticket.clone();
        let ticket = if let Some(ticket) =
            existing.filter(|t| t.account_id == id && t.expires_at > now() + 120_000)
        {
            ticket
        } else {
            let name = self
                .0
                .account
                .runtime
                .lock()
                .await
                .settings
                .device_name
                .clone()
                .unwrap_or_else(|| self.0.host_name.clone());
            let value=self.0.account.api.call(reqwest::Method::POST,"/session",&bearer,Some(json!({"deviceId":identity.device_id,"deviceName":name,"kind":"desktop","publicKey":identity.public_key}))).await?;
            self.check_epoch(epoch)?;
            parse_ticket(value, &id, &identity, now())?
        };
        self.check_epoch(epoch)?;
        {
            let mut runtime = self.0.account.runtime.lock().await;
            self.check_epoch(epoch)?;
            runtime.account_id = Some(id.clone());
            runtime.ticket = Some(ticket.clone());
        }
        let devices = self
            .0
            .account
            .api
            .call(reqwest::Method::GET, "/devices", &ticket.token, None)
            .await?;
        let requests = self
            .0
            .account
            .api
            .call(reqwest::Method::GET, "/requests", &ticket.token, None)
            .await?;
        let devices: Vec<Device> =
            serde_json::from_value(devices["devices"].clone()).map_err(|_| FAILURE)?;
        let requests: Vec<EnrollmentRequest> =
            serde_json::from_value(requests["requests"].clone()).map_err(|_| FAILURE)?;
        if devices.len() > 32 || requests.len() > 64 {
            return Err(FAILURE.into());
        }
        let settings = self.0.account.runtime.lock().await.settings.clone();
        for device in &devices {
            keys::validate_device(device)?;
            if settings
                .peers
                .get(&format!("{id}:{}", device.device_id))
                .is_some_and(|fp| fp != &device.fingerprint)
            {
                return Err("已知设备的密钥发生变化，连接已拒绝".into());
            }
        }
        for request in &requests {
            validate_request(request, &id, &identity, &settings, false)?;
        }
        self.check_epoch(epoch)?;
        {
            let mut runtime = self.0.account.runtime.lock().await;
            self.check_epoch(epoch)?;
            runtime.devices = devices;
            runtime.requests = requests.clone();
            runtime.last_error = None;
        }
        self.reconcile_account_rooms(app, &ticket, &requests, epoch)
            .await?;
        let rooms = self
            .0
            .store
            .lock()
            .await
            .rooms
            .iter()
            .filter(|(_, r)| {
                !r.revoked
                    && r.approved
                    && r.account
                        .as_ref()
                        .is_some_and(|a| a.account_id == ticket.account_id)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for room in rooms {
            self.check_epoch(epoch)?;
            self.start_room(app.clone(), room).await;
        }
        let revoked = self
            .0
            .store
            .lock()
            .await
            .rooms
            .iter()
            .filter_map(|(id, r)| {
                r.account
                    .as_ref()
                    .filter(|a| r.revoked && a.account_id == ticket.account_id)
                    .map(|a| (id.clone(), a.clone()))
            })
            .collect::<Vec<_>>();
        for (id, binding) in revoked {
            if self.0.vault.read(&id).is_ok() {
                let _ = self.revoke_account_remote(&id, &binding).await;
            }
        }
        let presence = self.0.account.runtime.lock().await.last_presence;
        if now().saturating_sub(presence) >= 60_000 {
            self.check_epoch(epoch)?;
            self.0.account.runtime.lock().await.last_presence = now();
            let value = self
                .0
                .account
                .api
                .call(
                    reqwest::Method::POST,
                    "/presence",
                    &ticket.token,
                    Some(json!({})),
                )
                .await?;
            if value["ok"] != true {
                return Err(FAILURE.into());
            }
            self.check_epoch(epoch)?;
            self.0.account.runtime.lock().await.last_presence = now();
        }
        Ok(())
    }
    pub(super) async fn account_room_ticket(&self, binding: &AccountRoom) -> Option<(String, u64)> {
        let runtime = self.0.account.runtime.lock().await;
        if runtime.suspended || !runtime.settings.enabled {
            return None;
        }
        runtime
            .ticket
            .as_ref()
            .filter(|t| {
                t.account_id == binding.account_id
                    && t.device.device_id == binding.desktop_device_id
                    && t.device.fingerprint == binding.desktop_fingerprint
                    && t.expires_at > now()
            })
            .map(|t| (t.token.clone(), t.expires_at))
    }
    async fn current_ticket(&self) -> Result<Ticket, String> {
        let runtime = self.0.account.runtime.lock().await;
        runtime
            .ticket
            .clone()
            .filter(|t| !runtime.suspended && runtime.settings.enabled && t.expires_at > now())
            .ok_or_else(|| "请先连接当前 LoliCode 账号".into())
    }
    pub async fn approve_account_request(
        &self,
        app: &AppHandle,
        id: &str,
        fingerprint: &str,
    ) -> Result<AccountCompanionStatus, String> {
        if !keys::uuid(id) || !keys::hex(fingerprint, 64) {
            return Err("设备请求无效".into());
        }
        let _account_gate = self.0.account.gate.lock().await;
        let epoch = self.0.account.epoch.load(Ordering::SeqCst);
        let ticket = self.current_ticket().await?;
        let identity = self.identity(&ticket.account_id, epoch).await?;
        self.check_epoch(epoch)?;
        let value = self
            .0
            .account
            .api
            .call(
                reqwest::Method::GET,
                &format!("/requests/{id}"),
                &ticket.token,
                None,
            )
            .await?;
        let request: EnrollmentRequest = serde_json::from_value(value).map_err(|_| FAILURE)?;
        let settings = self.0.account.runtime.lock().await.settings.clone();
        validate_request(&request, &ticket.account_id, &identity, &settings, true)?;
        if request.request_id != id || request.phone.fingerprint != fingerprint {
            return Err("手机身份已改变，请重新核对请求".into());
        }
        self.check_epoch(epoch)?;
        let _gate = self.0.gate.lock().await;
        if self.0.store.lock().await.rooms.values().any(|r| {
            r.account
                .as_ref()
                .is_some_and(|a| a.account_id == ticket.account_id && a.request_id == id)
        }) {
            return Err("该请求已提交，请刷新并核对服务端状态，未重复批准".into());
        }
        let room_id = crypto::hex(&crypto::random::<16>()?);
        let secret = Secret {
            desktop_token: crypto::hex(&crypto::random::<32>()?),
            phone_token: crypto::hex(&crypto::random::<32>()?),
            key: crypto::random()?,
        };
        let pairing = json!({"v":1,"relayUrl":RELAY,"roomId":room_id,"phoneToken":secret.phone_token,"key":crypto::encode(&secret.key),"hostName":self.0.host_name,"expiresAt":request.expires_at});
        let envelope = keys::seal(&identity, &request, &pairing)?;
        let binding = AccountRoom {
            account_id: ticket.account_id.clone(),
            challenge: request.challenge.clone(),
            request_id: id.into(),
            desktop_device_id: identity.device_id.clone(),
            phone_device_id: request.phone.device_id.clone(),
            desktop_fingerprint: identity.fingerprint.clone(),
            phone_fingerprint: fingerprint.into(),
            envelope_hash: keys::envelope_hash(&envelope)?,
        };
        self.persist_pending_account_room(&room_id, &secret, &request, binding)
            .await?;
        self.check_epoch(epoch)?;
        let approval = json!({"roomId":room_id,"desktopTokenHash":crypto::hex(&Sha256::digest(secret.desktop_token.as_bytes())),"phoneTokenHash":crypto::hex(&Sha256::digest(secret.phone_token.as_bytes())),"envelope":envelope});
        let response = self
            .0
            .account
            .api
            .call(
                reqwest::Method::POST,
                &format!("/requests/{id}/approve"),
                &ticket.token,
                Some(approval),
            )
            .await;
        // A timeout may follow a real server commit. The persisted pending room
        // is recovered using GET; never replay this approval automatically.
        let response: EnrollmentRequest = serde_json::from_value(response?).map_err(|_| FAILURE)?;
        if response.status != "approved"
            || response.room_id.as_deref() != Some(room_id.as_str())
            || response.challenge != request.challenge
            || response.created_at != request.created_at
            || response.expires_at != request.expires_at
        {
            return Err("服务端未确认相同的设备请求，连接未建立".into());
        }
        validate_request(&response, &ticket.account_id, &identity, &settings, false)?;
        self.check_epoch(epoch)?;
        drop(_gate);
        self.reconcile_account_rooms(app, &ticket, &[response], epoch)
            .await?;
        Ok(self.account_status().await)
    }
    async fn persist_pending_account_room(
        &self,
        id: &str,
        secret: &Secret,
        request: &EnrollmentRequest,
        binding: AccountRoom,
    ) -> Result<(), String> {
        let mut store = self.0.store.lock().await;
        let mut next = store.clone();
        if next.rooms.contains_key(id)
            || next
                .rooms
                .values()
                .filter(|r| !r.revoked && (r.approved || r.expires_at > now()))
                .count()
                >= MAX_ROOMS
        {
            return Err("最多绑定8台手机，请先撤销旧连接".into());
        }
        self.0.vault.write(id, secret)?;
        next.rooms.insert(
            id.into(),
            Room {
                relay_url: RELAY.into(),
                expires_at: request.expires_at,
                approved: false,
                revoked: false,
                device_id: Some(request.phone.device_id.clone()),
                device_name: Some(request.phone.device_name.clone()),
                sessions: BTreeSet::new(),
                requests: BTreeMap::new(),
                seen_packets: BTreeMap::new(),
                events: BTreeMap::new(),
                active_requests: BTreeMap::new(),
                event_keys: BTreeSet::new(),
                account: Some(binding),
            },
        );
        if let Err(error) = self.save(&next) {
            let _ = self.0.vault.delete(id);
            return Err(error);
        }
        *store = next;
        Ok(())
    }
    async fn reconcile_account_rooms(
        &self,
        app: &AppHandle,
        ticket: &Ticket,
        requests: &[EnrollmentRequest],
        epoch: u64,
    ) -> Result<(), String> {
        let _gate = self.0.gate.lock().await;
        self.check_epoch(epoch)?;
        let mut store = self.0.store.lock().await;
        let mut next = store.clone();
        let mut start = Vec::new();
        for request in requests.iter().filter(|r| r.status == "approved") {
            let Some(room_id) = &request.room_id else {
                return Err(FAILURE.into());
            };
            let Some(room) = next.rooms.get_mut(room_id) else {
                continue;
            };
            let Some(binding) = &room.account else {
                return Err("账号房间与旧版连接冲突".into());
            };
            if binding.account_id != ticket.account_id
                || binding.challenge != request.challenge
                || room.expires_at != request.expires_at
                || binding.request_id != request.request_id
                || binding.phone_device_id != request.phone.device_id
                || binding.phone_fingerprint != request.phone.fingerprint
                || binding.desktop_device_id != request.desktop.device_id
                || binding.desktop_fingerprint != request.desktop.fingerprint
                || request
                    .envelope
                    .as_ref()
                    .map(keys::envelope_hash)
                    .transpose()?
                    .as_ref()
                    != Some(&binding.envelope_hash)
            {
                return Err("已批准请求的设备或加密内容不匹配".into());
            }
            if !room.revoked {
                room.approved = true;
                start.push(room_id.clone());
            }
        }
        self.save(&next)?;
        *store = next;
        drop(store);
        let mut runtime = self.0.account.runtime.lock().await;
        let mut settings = runtime.settings.clone();
        for request in requests.iter().filter(|r| r.status == "approved") {
            settings
                .peers
                .entry(format!("{}:{}", ticket.account_id, request.phone.device_id))
                .or_insert_with(|| request.phone.fingerprint.clone());
        }
        self.save_account(&settings)?;
        runtime.settings = settings;
        for request in requests.iter().filter(|r| {
            r.status == "approved" && r.room_id.as_ref().is_some_and(|id| start.contains(id))
        }) {
            runtime
                .requests
                .retain(|r| r.request_id != request.request_id);
            if runtime.requests.len() < 64 {
                runtime.requests.push(request.clone());
            }
        }
        drop(runtime);
        drop(_gate);
        for room in start {
            self.start_room(app.clone(), room).await;
        }
        Ok(())
    }
    pub async fn reject_account_request(&self, id: &str) -> Result<AccountCompanionStatus, String> {
        if !keys::uuid(id) {
            return Err("请求编号无效".into());
        }
        let _gate = self.0.account.gate.lock().await;
        let epoch = self.0.account.epoch.load(Ordering::SeqCst);
        let ticket = self.current_ticket().await?;
        let response = self
            .0
            .account
            .api
            .call(
                reqwest::Method::POST,
                &format!("/requests/{id}/reject"),
                &ticket.token,
                Some(json!({})),
            )
            .await?;
        let request: EnrollmentRequest = serde_json::from_value(response).map_err(|_| FAILURE)?;
        let identity = self.identity(&ticket.account_id, epoch).await?;
        let settings = self.0.account.runtime.lock().await.settings.clone();
        validate_request(&request, &ticket.account_id, &identity, &settings, false)?;
        if request.request_id != id || request.status != "rejected" {
            return Err(FAILURE.into());
        }
        self.check_epoch(epoch)?;
        self.0
            .account
            .runtime
            .lock()
            .await
            .requests
            .retain(|r| r.request_id != id);
        Ok(self.account_status().await)
    }
    pub(super) async fn revoke_account_remote(
        &self,
        room_id: &str,
        binding: &AccountRoom,
    ) -> Result<(), String> {
        if !keys::hex(room_id, 32) {
            return Err("房间编号无效，已在本机停止".into());
        }
        let ticket = self.current_ticket().await?;
        if ticket.account_id != binding.account_id {
            return Err("此房间不属于当前账号，已在本机停止".into());
        }
        let value = self
            .0
            .account
            .api
            .call(
                reqwest::Method::POST,
                &format!("/rooms/{room_id}/revoke"),
                &ticket.token,
                Some(json!({})),
            )
            .await?;
        if value["ok"] != true {
            return Err(FAILURE.into());
        }
        self.0.vault.delete(room_id)
    }
}
fn parse_ticket(value: Value, id: &str, identity: &Identity, time: u64) -> Result<Ticket, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Response {
        v: u8,
        account_id: String,
        device_token: String,
        expires_at: u64,
        device: Device,
    }
    let response: Response = serde_json::from_value(value).map_err(|_| FAILURE)?;
    if response.v != 2
        || response.account_id != id
        || !keys::account_id(id)
        || response.device_token.len() < 32
        || response.device_token.len() > 512
        || !response
            .device_token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        || response.expires_at <= time
        || response.expires_at > time + 15 * 60 * 1000 + 30_000
        || !identity.matches(&response.device)
    {
        return Err("账号设备登记返回了错误身份".into());
    }
    keys::validate_device(&response.device)?;
    Ok(Ticket {
        account_id: id.into(),
        token: response.device_token,
        expires_at: response.expires_at,
        device: response.device,
    })
}
fn validate_request(
    request: &EnrollmentRequest,
    id: &str,
    identity: &Identity,
    settings: &Settings,
    pending: bool,
) -> Result<(), String> {
    keys::transcript(request)?;
    if request.account_id != id
        || !identity.matches(&request.desktop)
        || request.created_at > now() + 30_000
        || (pending && (request.status != "pending" || request.expires_at <= now()))
        || settings
            .peers
            .get(&format!("{id}:{}", request.phone.device_id))
            .is_some_and(|fp| fp != &request.phone.fingerprint)
    {
        return Err("设备请求不属于当前账号、已过期或身份发生变化".into());
    }
    if request.status == "approved"
        && (!request.room_id.as_deref().is_some_and(|r| keys::hex(r, 32))
            || request
                .envelope
                .as_ref()
                .map(keys::envelope_hash)
                .transpose()?
                .is_none())
    {
        return Err(FAILURE.into());
    }
    Ok(())
}
