//! ZCode's published CLI OAuth and project-token protocol (official v3.15.1).
//! Sources: zai-org/ZCode/.../auth/cli-oauth.ts, coding-plan-api-key.ts and
//! packages/shared/src/project-access-token-{client,response}.ts.
//! Login tokens stay in a private account store. Project tokens stay in memory
//! and are resolved for each new gateway request; neither enters a channel draft.

use crate::services::channel_center::ChannelSource;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, sync::OnceLock};
use tokio::sync::Mutex;

const OAUTH_BASE: &str = "https://zcode.z.ai/api/v1";
const MAX_AUTH_BYTES: usize = 64 * 1024;
const MAX_FLOW_SECONDS: i64 = 600;
const REFRESH_LEAD_SECONDS: i64 = 120;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Family {
    Bigmodel,
    Zai,
}

impl Family {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "bigmodel" => Ok(Self::Bigmodel),
            "zai" => Ok(Self::Zai),
            _ => Err("不支持的智谱登录平台".into()),
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::Bigmodel => "bigmodel",
            Self::Zai => "zai",
        }
    }
    fn origin(self) -> &'static str {
        match self {
            Self::Bigmodel => "https://bigmodel.cn",
            Self::Zai => "https://api.z.ai",
        }
    }
    fn base_url(self) -> &'static str {
        match self {
            Self::Bigmodel => "https://open.bigmodel.cn/api/coding/paas/v4",
            Self::Zai => "https://api.z.ai/api/coding/paas/v4",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Bigmodel => "智谱 Coding Plan",
            Self::Zai => "Z.ai Coding Plan",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub flow_id: String,
    pub url: String,
    pub expires_in: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPoll {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<ChannelSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl LoginPoll {
    fn pending() -> Self {
        Self {
            status: "pending",
            channel: None,
            message: None,
        }
    }
    fn error(message: impl Into<String>) -> Self {
        Self {
            status: "error",
            channel: None,
            message: Some(message.into()),
        }
    }
}

/// Private ephemeral material; deliberately does not implement Serialize/Debug.
pub struct ResolvedMaterial {
    pub base_url: String,
    pub api_key: String,
    pub protocol: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Account {
    family: Family,
    identity: String,
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    generation: String,
    #[serde(default)]
    location: Option<Location>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Location {
    organization_id: String,
    project_id: String,
    key_id: String,
}

#[derive(Default, Serialize, Deserialize)]
struct AccountStore {
    #[serde(default)]
    accounts: HashMap<String, Account>,
}

struct Flow {
    family: Family,
    server_id: String,
    poll_token: String,
    expires_at: i64,
    interval: i64,
    next_poll: i64,
    in_flight: bool,
    result: Option<LoginPoll>,
}

#[derive(Clone)]
struct CachedToken {
    token: String,
    expires_at: i64,
    refresh_at: i64,
}

#[derive(Default)]
struct Runtime {
    generation: String,
    business: Option<CachedToken>,
    project: Option<CachedToken>,
}

#[derive(Default)]
struct State {
    flows: HashMap<String, Flow>,
    accounts: Option<AccountStore>,
    runtime: HashMap<String, std::sync::Arc<Mutex<Runtime>>>,
}

struct Manager {
    state: Mutex<State>,
    path: PathBuf,
    oauth_base: String,
    bigmodel_origin: String,
    zai_origin: String,
}

impl Manager {
    fn production() -> Self {
        Self {
            state: Mutex::new(State::default()),
            path: crate::config::get_app_config_dir().join("zhipu_oauth_auth.json"),
            oauth_base: OAUTH_BASE.into(),
            bigmodel_origin: Family::Bigmodel.origin().into(),
            zai_origin: Family::Zai.origin().into(),
        }
    }
    fn origin(&self, family: Family) -> &str {
        match family {
            Family::Bigmodel => &self.bigmodel_origin,
            Family::Zai => &self.zai_origin,
        }
    }
    fn load_accounts(&self, state: &mut State) -> Result<(), String> {
        if state.accounts.is_some() {
            return Ok(());
        }
        let store = if self.path.exists() {
            let size = std::fs::metadata(&self.path)
                .map_err(|_| "无法读取智谱登录凭据，原文件已保留")?
                .len();
            if size > 1024 * 1024 {
                return Err("智谱登录凭据文件过大，原文件已保留".into());
            }
            crate::config::read_json_file(&self.path)
                .map_err(|_| "智谱登录凭据无法解析，原文件已保留")?
        } else {
            AccountStore::default()
        };
        state.accounts = Some(store);
        Ok(())
    }
    fn persist(&self, store: &AccountStore) -> Result<(), String> {
        crate::config::write_json_file_private(&self.path, store)
            .map_err(|_| "无法保存智谱登录凭据；已有文件已保留".into())
    }
    async fn start(&self, provider: &str) -> Result<LoginStart, String> {
        let family = Family::parse(provider)?;
        let poll_token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let payload = auth_json(
            http::Method::POST,
            &format!("{}/oauth/cli/init", self.oauth_base),
            Some(&format!("Bearer {poll_token}")),
            Some(json!({"provider":family.id()})),
        )
        .await?;
        let data = read_data(&payload)?;
        let server_id = nonempty(data.get("flow_id"))
            .ok_or("官方登录响应缺少 flow_id")?
            .to_string();
        let url = nonempty(data.get("authorize_url"))
            .ok_or("官方登录响应缺少授权地址")?
            .to_string();
        validate_authorize_url(&url, &poll_token)?;
        let now = chrono::Utc::now().timestamp();
        let deadline = data
            .get("expires_at")
            .and_then(Value::as_i64)
            .ok_or("官方登录有效期无效")?;
        let interval = data
            .get("poll_interval_sec")
            .and_then(Value::as_i64)
            .ok_or("官方登录轮询间隔无效")?;
        if deadline <= now || interval < 1 || interval >= deadline - now {
            return Err("官方登录有效期或轮询间隔无效".into());
        }
        let deadline = deadline.min(now + MAX_FLOW_SECONDS);
        let flow_id = uuid::Uuid::new_v4().to_string();
        let mut state = self.state.lock().await;
        state.flows.retain(|_, flow| flow.expires_at > now);
        if state.flows.len() >= 8 {
            return Err("登录请求过多，请先取消已有登录".into());
        }
        state.flows.insert(
            flow_id.clone(),
            Flow {
                family,
                server_id,
                poll_token,
                expires_at: deadline,
                interval,
                next_poll: now,
                in_flight: false,
                result: None,
            },
        );
        Ok(LoginStart {
            flow_id,
            url,
            expires_in: (deadline - now) as u64,
        })
    }
    async fn cancel(&self, flow_id: &str) {
        self.state.lock().await.flows.remove(flow_id);
    }
    async fn poll(&self, flow_id: &str) -> LoginPoll {
        let (family, server_id, poll_token) = {
            let mut state = self.state.lock().await;
            let Some(flow) = state.flows.get_mut(flow_id) else {
                return LoginPoll::error("登录已取消或不存在");
            };
            if let Some(result) = &flow.result {
                return result.clone();
            }
            let now = chrono::Utc::now().timestamp();
            if now >= flow.expires_at {
                flow.poll_token.clear();
                return LoginPoll::error("登录已过期，请重新开始");
            }
            if flow.in_flight || now < flow.next_poll {
                return LoginPoll::pending();
            }
            flow.in_flight = true;
            flow.next_poll = now + flow.interval;
            (flow.family, flow.server_id.clone(), flow.poll_token.clone())
        };
        let url = match endpoint(&self.oauth_base, &["oauth", "cli", "poll", &server_id]) {
            Ok(url) => url,
            Err(message) => return self.finish_error(flow_id, message).await,
        };
        let payload = match auth_json(
            http::Method::GET,
            &url,
            Some(&format!("Bearer {poll_token}")),
            None,
        )
        .await
        {
            Ok(payload) => payload,
            Err(message) => return self.finish_error(flow_id, message).await,
        };
        let data = match read_data(&payload) {
            Ok(data) => data,
            Err(message) => return self.finish_error(flow_id, message).await,
        };
        match data.get("status").and_then(Value::as_str) {
            Some("pending") => {
                let mut state = self.state.lock().await;
                if let Some(flow) = state.flows.get_mut(flow_id) {
                    flow.in_flight = false;
                    LoginPoll::pending()
                } else {
                    LoginPoll::error("登录已取消")
                }
            }
            Some("failed") => {
                self.finish_error(flow_id, "官方授权未完成，请重新登录".into())
                    .await
            }
            Some("ready") => {
                let account = match parse_account(family, data) {
                    Ok(account) => account,
                    Err(message) => return self.finish_error(flow_id, message).await,
                };
                let account_id = account_id(&account);
                let channel = account_channel(&account_id, &account);
                let result = LoginPoll {
                    status: "success",
                    channel: Some(channel),
                    message: None,
                };
                let mut state = self.state.lock().await;
                // Cancellation or expiry during HTTP must never persist late credentials.
                if !state.flows.get(flow_id).is_some_and(|flow| {
                    flow.expires_at > chrono::Utc::now().timestamp() && flow.result.is_none()
                }) {
                    return LoginPoll::error("登录已取消或过期");
                }
                if let Err(message) = self.load_accounts(&mut state) {
                    let result = LoginPoll::error(message);
                    if let Some(flow) = state.flows.get_mut(flow_id) {
                        flow.result = Some(result.clone());
                        flow.poll_token.clear();
                        flow.in_flight = false;
                    }
                    return result;
                }
                let mut next = state.accounts.as_ref().expect("loaded").accounts.clone();
                next.insert(account_id.clone(), account);
                let next = AccountStore { accounts: next };
                if let Err(message) = self.persist(&next) {
                    let result = LoginPoll::error(message);
                    if let Some(flow) = state.flows.get_mut(flow_id) {
                        flow.result = Some(result.clone());
                        flow.poll_token.clear();
                        flow.in_flight = false;
                    }
                    return result;
                }
                state.accounts = Some(next);
                // Existing requests keep their runtime object but will fail the generation
                // check before committing material from this superseded login.
                state.runtime.remove(&account_id);
                let flow = state.flows.get_mut(flow_id).expect("validated");
                flow.result = Some(result.clone());
                flow.in_flight = false;
                flow.poll_token.clear();
                result
            }
            _ => {
                self.finish_error(flow_id, "官方登录返回了未知状态".into())
                    .await
            }
        }
    }
    async fn finish_error(&self, flow_id: &str, message: String) -> LoginPoll {
        let result = LoginPoll::error(message);
        let mut state = self.state.lock().await;
        if let Some(flow) = state.flows.get_mut(flow_id) {
            flow.result = Some(result.clone());
            flow.poll_token.clear();
            flow.in_flight = false;
            result
        } else {
            LoginPoll::error("登录已取消")
        }
    }
    async fn account(&self, account_id: &str) -> Result<Account, String> {
        let mut state = self.state.lock().await;
        self.load_accounts(&mut state)?;
        state
            .accounts
            .as_ref()
            .expect("loaded")
            .accounts
            .get(account_id)
            .cloned()
            .ok_or_else(|| "智谱登录账号不存在，请重新登录".into())
    }
    async fn resolve(&self, account_id: &str) -> Result<ResolvedMaterial, String> {
        let account = self.account(account_id).await?;
        if jwt_expiry(&account.access_token)
            .is_some_and(|expiry| expiry <= chrono::Utc::now().timestamp())
        {
            return Err("智谱网页登录已过期，请重新授权；没有公开的登录 Token 刷新接口".into());
        }
        let runtime = {
            let mut state = self.state.lock().await;
            state.runtime.entry(account_id.into()).or_default().clone()
        };
        // One refresh per account; concurrent model requests wait for the same material.
        let mut runtime = runtime.lock().await;
        if runtime.generation != account.generation {
            *runtime = Runtime {
                generation: account.generation.clone(),
                ..Default::default()
            };
        }
        let now = chrono::Utc::now().timestamp();
        if self.account(account_id).await?.generation != account.generation {
            return Err("智谱账号登录已改变，请重试".into());
        }
        if let Some(token) = runtime
            .project
            .as_ref()
            .filter(|token| now < token.refresh_at && now < token.expires_at)
        {
            return Ok(ResolvedMaterial {
                base_url: account.family.base_url().into(),
                api_key: token.token.clone(),
                protocol: "openai_chat".into(),
            });
        }
        let origin = self.origin(account.family);
        let login_token = if account.family == Family::Zai {
            let business = runtime
                .business
                .as_ref()
                .filter(|token| now < token.refresh_at && now < token.expires_at)
                .cloned();
            let business = match business {
                Some(business) => business,
                None => {
                    let raw = auth_json(
                        http::Method::POST,
                        &format!("{origin}/api/auth/z/login"),
                        None,
                        Some(json!({"token":account.access_token})),
                    )
                    .await?;
                    parse_business_token(&raw, now)?
                }
            };
            runtime.business = Some(business.clone());
            business.token
        } else {
            account.access_token.clone()
        };
        let location = match &account.location {
            Some(location) => location.clone(),
            None => self.resolve_location(account.family, &login_token).await?,
        };
        let url = key_url(origin, &location)?;
        let started = chrono::Utc::now().timestamp();
        let raw = auth_json(
            http::Method::POST,
            &format!("{url}/access_tokens"),
            Some(&format!("Bearer {login_token}")),
            Some(json!({"clientType":"zcode","clientVersion":env!("CARGO_PKG_VERSION")})),
        )
        .await?;
        let token = parse_project_token(&raw, started, chrono::Utc::now().timestamp())?;
        let mut state = self.state.lock().await;
        let current = state
            .accounts
            .as_mut()
            .and_then(|store| store.accounts.get_mut(account_id))
            .ok_or("智谱登录已失效，请重新登录")?;
        if current.generation != account.generation {
            return Err("智谱账号登录已改变，请重试".into());
        }
        // Only non-secret location IDs persist. Project tokens never touch disk.
        if current.location.is_none() {
            current.location = Some(location);
            self.persist(state.accounts.as_ref().expect("loaded"))?;
        }
        runtime.project = Some(token.clone());
        Ok(ResolvedMaterial {
            base_url: account.family.base_url().into(),
            api_key: token.token,
            protocol: "openai_chat".into(),
        })
    }
    async fn resolve_location(&self, family: Family, token: &str) -> Result<Location, String> {
        let origin = self.origin(family);
        let authorization = if family == Family::Zai {
            format!("Bearer {token}")
        } else {
            token.into()
        };
        let customer = auth_json(
            http::Method::GET,
            &format!("{origin}/api/biz/customer/getCustomerInfo"),
            Some(&authorization),
            None,
        )
        .await?;
        let location = select_location(read_data(&customer)?)?;
        let url = endpoint(
            origin,
            &[
                "api",
                "biz",
                "v1",
                "organization",
                &location.organization_id,
                "projects",
                &location.project_id,
                "api_keys",
            ],
        )?;
        let keys = auth_json(http::Method::GET, &url, Some(&authorization), None).await?;
        let list = read_data(&keys)?
            .as_array()
            .ok_or("智谱项目 Key ID 列表无效")?;
        let candidate = list
            .iter()
            .find(|key| key.get("name").and_then(Value::as_str) == Some("zcode-api-key"));
        let key = if let Some(candidate) = candidate {
            // A malformed existing entry must not lead to duplicate key creation.
            nonempty(candidate.get("apiKey"))
                .ok_or("智谱现有项目 Key ID 无效，请在官网检查")?
                .to_string()
        } else {
            let created = auth_json(
                http::Method::POST,
                &url,
                Some(&authorization),
                Some(json!({"name":"zcode-api-key","usageScene":1})),
            )
            .await?;
            nonempty(read_data(&created)?.get("apiKey"))
                .ok_or("智谱项目 Key ID 创建响应无效")?
                .to_string()
        };
        Ok(Location {
            key_id: key,
            ..location
        })
    }
}

fn manager() -> &'static Manager {
    static MANAGER: OnceLock<Manager> = OnceLock::new();
    MANAGER.get_or_init(Manager::production)
}

pub async fn start(provider: &str) -> Result<LoginStart, String> {
    manager().start(provider).await
}
pub async fn poll(flow_id: &str) -> LoginPoll {
    manager().poll(flow_id).await
}
pub async fn cancel(flow_id: &str) {
    manager().cancel(flow_id).await
}
pub async fn resolve_account(account_id: &str) -> Result<ResolvedMaterial, String> {
    manager().resolve(account_id).await
}

/// Opt-in acceptance harness: no login/location discovery writes, no IPC exposure.
#[cfg(feature = "test-hooks")]
pub async fn acceptance_secret_read_only(account_id: &str) -> Result<String, String> {
    let account = manager().account(account_id).await?;
    if account.location.is_none() {
        return Err("测试账号尚无已保存的项目位置，请先在渠道中心完成目录发现".into());
    }
    Ok(manager().resolve(account_id).await?.api_key)
}

pub async fn discover_account(account_id: &str) -> Result<ChannelSource, String> {
    let account = manager().account(account_id).await?;
    let material = resolve_account(account_id).await?;
    let mut channel = account_channel(account_id, &account);
    channel.base_url = material.base_url;
    channel.api_key = material.api_key;
    channel.protocol = material.protocol;
    channel.auth_kind = "api_key".into();
    let mut channel = crate::services::channel_center::discover_api_models(channel)
        .await
        .map_err(|_| {
            "智谱登录已保存，但官方模型目录暂时无法读取；请检查套餐权限或稍后重试".to_string()
        })?;
    // Discovery's temporary project token is never returned to the UI or saved
    // in the source catalog. Inference still uses the official Coding endpoint.
    channel.api_key.clear();
    channel.auth_kind = "zhipu_oauth".into();
    channel.account_id = Some(account_id.into());
    if channel.models.is_empty() {
        return Err("此智谱账号的官方模型目录为空，请检查 Coding Plan 权限".into());
    }
    Ok(channel)
}

fn account_id(account: &Account) -> String {
    let hash = Sha256::digest(format!("{}\0{}", account.family.id(), account.identity).as_bytes());
    format!("zhipu-{}-{:x}", account.family.id(), hash)
}

fn account_channel(id: &str, account: &Account) -> ChannelSource {
    ChannelSource {
        id: id.into(),
        name: account.family.name().into(),
        base_url: account.family.base_url().into(),
        api_key: String::new(),
        auth_kind: "zhipu_oauth".into(),
        account_id: Some(id.into()),
        protocol: "openai_chat".into(),
        models: Vec::new(),
        enabled: true,
    }
}

fn parse_account(family: Family, data: &Value) -> Result<Account, String> {
    // The ZCode JWT in data.token is not a Coding Plan credential.
    nonempty(data.get("token")).ok_or("官方登录响应缺少会话 Token")?;
    let identity = nonempty(data.pointer("/user/user_id")).ok_or("官方登录响应缺少稳定账号身份")?;
    if identity.len() > 512 {
        return Err("官方登录账号标识无效".into());
    }
    let provider = data.get(family.id()).ok_or("官方登录响应缺少平台凭据")?;
    let access_token = nonempty(provider.get("access_token"))
        .or_else(|| nonempty(provider.get("accessToken")))
        .ok_or("官方登录响应缺少平台访问 Token")?;
    let refresh_token = nonempty(provider.get("refresh_token"))
        .or_else(|| nonempty(provider.get("refreshToken")))
        .map(str::to_string);
    Ok(Account {
        family,
        identity: identity.into(),
        access_token: access_token.into(),
        refresh_token,
        generation: uuid::Uuid::new_v4().to_string(),
        location: None,
    })
}

fn select_location(data: &Value) -> Result<Location, String> {
    let organizations = data
        .get("organizations")
        .and_then(Value::as_array)
        .ok_or("智谱账号组织列表无效")?;
    let eligible: Vec<_> = organizations
        .iter()
        .filter(|org| {
            nonempty(org.get("organizationId")).is_some()
                && org
                    .get("projects")
                    .and_then(Value::as_array)
                    .is_some_and(|projects| {
                        projects
                            .iter()
                            .any(|project| nonempty(project.get("projectId")).is_some())
                    })
        })
        .collect();
    let organization = eligible
        .iter()
        .copied()
        .find(|org| {
            org.get("organizationName")
                .and_then(Value::as_str)
                .is_some_and(|name| name.contains("默认机构"))
        })
        .or_else(|| eligible.first().copied())
        .ok_or("该智谱账号没有可用 Coding Plan 项目")?;
    let projects = organization["projects"].as_array().expect("filtered");
    let project = projects
        .iter()
        .filter(|project| nonempty(project.get("projectId")).is_some())
        .find(|project| {
            project
                .get("projectName")
                .and_then(Value::as_str)
                .is_some_and(|name| name.contains("默认项目"))
        })
        .or_else(|| {
            projects
                .iter()
                .find(|project| nonempty(project.get("projectId")).is_some())
        })
        .ok_or("该智谱账号没有可用项目")?;
    Ok(Location {
        organization_id: nonempty(organization.get("organizationId"))
            .expect("filtered")
            .into(),
        project_id: nonempty(project.get("projectId")).expect("filtered").into(),
        key_id: String::new(),
    })
}

fn key_url(origin: &str, location: &Location) -> Result<String, String> {
    endpoint(
        origin,
        &[
            "api",
            "biz",
            "v1",
            "organization",
            &location.organization_id,
            "projects",
            &location.project_id,
            "api_keys",
            &location.key_id,
        ],
    )
}

fn endpoint(origin: &str, segments: &[&str]) -> Result<String, String> {
    let mut url = url::Url::parse(origin).map_err(|_| "官方认证接口地址无效")?;
    let mut path = url
        .path_segments_mut()
        .map_err(|_| "官方认证接口地址无效")?;
    path.pop_if_empty();
    for segment in segments {
        path.push(segment);
    }
    drop(path);
    Ok(url.into())
}

fn nonempty(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
fn read_data(payload: &Value) -> Result<&Value, String> {
    if !matches!(payload.get("code"),Some(Value::Number(code)) if code.as_i64().is_some_and(|code|code==0||code==200))
        && !matches!(
            payload.get("code").and_then(Value::as_str),
            Some("0" | "200")
        )
    {
        return Err("官方认证接口拒绝了请求，请检查登录状态、套餐和客户端准入".into());
    }
    payload
        .get("data")
        .ok_or_else(|| "官方认证响应缺少 data".into())
}

fn jwt_expiry(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice::<Value>(&decoded)
        .ok()?
        .get("exp")?
        .as_i64()
}

fn parse_business_token(raw: &Value, started: i64) -> Result<CachedToken, String> {
    let data = read_data(raw)?;
    let token = nonempty(data.get("access_token"))
        .or_else(|| nonempty(data.get("accessToken")))
        .ok_or("Z.ai 业务登录没有返回有效 Token")?;
    let ttl = data
        .get("expires_in")
        .or_else(|| data.get("expiresIn"))
        .and_then(Value::as_i64)
        .filter(|ttl| *ttl > 0);
    let expiry = jwt_expiry(token)
        .into_iter()
        .chain(ttl.map(|ttl| started.saturating_add(ttl)))
        .min()
        .unwrap_or(started + 300);
    if expiry <= started {
        return Err("Z.ai 业务登录 Token 已过期".into());
    }
    Ok(CachedToken {
        token: token.into(),
        expires_at: expiry,
        refresh_at: expiry.saturating_sub(REFRESH_LEAD_SECONDS),
    })
}

fn parse_project_token(raw: &Value, started: i64, now: i64) -> Result<CachedToken, String> {
    let data = read_data(raw)?;
    if data.get("enable") == Some(&Value::Bool(false)) {
        return Err("该账号的项目 Token 已被平台关闭，不能改用旧 Key".into());
    }
    if data
        .get("enable")
        .is_some_and(|value| value != &Value::Bool(true))
    {
        return Err("项目 Token 开关响应无效".into());
    }
    let token = nonempty(data.get("accessToken")).ok_or("官方项目 Token 响应缺少有效 Token")?;
    if data.get("tokenType").and_then(Value::as_str) != Some("Bearer") {
        return Err("项目 Token 类型无效".into());
    }
    let ttl = data
        .get("expiresIn")
        .and_then(Value::as_i64)
        .filter(|ttl| *ttl > 0)
        .ok_or("项目 Token 有效期无效")?;
    let expiry = data
        .get("expiresAt")
        .and_then(Value::as_i64)
        .filter(|expiry| *expiry > 0)
        .ok_or("项目 Token 有效期无效")?
        .min(started.saturating_add(ttl));
    if expiry <= now {
        return Err("平台签发的项目 Token 已过期".into());
    }
    Ok(CachedToken {
        token: token.into(),
        expires_at: expiry,
        refresh_at: expiry.saturating_sub(REFRESH_LEAD_SECONDS),
    })
}

fn validate_authorize_url(raw: &str, poll_token: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|_| "官方授权地址无效")?;
    let host = url.host_str().unwrap_or("");
    let official = ["z.ai", "bigmodel.cn"]
        .into_iter()
        .any(|domain| host == domain || host.ends_with(&format!(".{domain}")));
    if url.scheme() != "https"
        || !official
        || !url.username().is_empty()
        || url.password().is_some()
        || raw.contains(poll_token)
    {
        return Err("官方授权地址未通过校验，登录已停止".into());
    }
    Ok(())
}

async fn auth_json(
    method: http::Method,
    url: &str,
    authorization: Option<&str>,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut request = crate::proxy::http_client::get()
        .request(method, url)
        .timeout(std::time::Duration::from_secs(15));
    if let Some(authorization) = authorization {
        request = request.header(http::header::AUTHORIZATION, authorization);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "官方认证请求失败，请检查网络后重试".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "官方认证接口返回 HTTP {}，请重新登录或检查账号权限",
            response.status().as_u16()
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "无法读取官方认证响应")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_AUTH_BYTES {
            return Err("官方认证响应超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "官方认证响应不是有效 JSON".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zhipu_login_token_fields_and_project_expiry_are_strict() {
        let raw = json!({"token":"zcode-session","user":{"user_id":"stable-user"},"bigmodel":{"access_token":"business-token"}});
        let account = parse_account(Family::Bigmodel, &raw).unwrap();
        let channel = account_channel(&account_id(&account), &account);
        assert_eq!(channel.auth_kind, "zhipu_oauth");
        assert!(channel.api_key.is_empty());
        assert!(!serde_json::to_string(&channel)
            .unwrap()
            .contains("business-token"));
        assert!(!serde_json::to_string(&channel)
            .unwrap()
            .contains("zcode-session"));
        let mut missing = raw;
        missing["bigmodel"] = json!({});
        assert!(parse_account(Family::Bigmodel, &missing).is_err());
        let pat = json!({"code":0,"data":{"accessToken":"temporary-pat","tokenType":"Bearer","expiresIn":900,"expiresAt":2000}});
        let token = parse_project_token(&pat, 1000, 1001).unwrap();
        assert_eq!(token.expires_at, 1900);
        assert_eq!(token.refresh_at, 1780);
        assert!(parse_project_token(&pat, 1000, 1900).is_err());
        assert!(
            parse_project_token(&json!({"code":200,"data":{"enable":false}}), 1000, 1000).is_err()
        );
        assert!(parse_project_token(
            &json!({"code":0,"data":{"apiKey":"a-long-key-id"}}),
            1000,
            1000
        )
        .is_err());
    }
    #[test]
    fn zhipu_login_rejects_external_authorize_urls_and_encodes_ids_as_path_segments() {
        assert!(
            validate_authorize_url("https://chat.z.ai/oauth/authorize?state=s", "poll-secret")
                .is_ok()
        );
        for url in [
            "http://bigmodel.cn/login",
            "https://z.ai.evil.test/login",
            "https://evil.test/login",
            "https://user@bigmodel.cn/login",
        ] {
            assert!(validate_authorize_url(url, "poll-secret").is_err());
        }
        assert!(validate_authorize_url(
            "https://bigmodel.cn/login?state=poll-secret",
            "poll-secret"
        )
        .is_err());
        let url = key_url(
            "https://bigmodel.cn",
            &Location {
                organization_id: "org/other".into(),
                project_id: "p?x".into(),
                key_id: "k/#".into(),
            },
        )
        .unwrap();
        assert!(url.contains("org%2Fother"));
        assert!(url.contains("p%3Fx"));
        assert!(url.ends_with("k%2F%23"));
    }

    #[tokio::test]
    async fn zhipu_login_official_polling_and_pat_refresh_use_only_loopback_mocks_and_keep_tokens_private(
    ) {
        use axum::{
            extract::Path,
            routing::{get, post},
            Json, Router,
        };
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::sync::Notify;
        let issued = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let init = |Json(body): Json<Value>| async move {
            Json(
                json!({"code":0,"data":{"flow_id":format!("server-{}",body["provider"].as_str().unwrap()),
                "authorize_url":"https://bigmodel.cn/login?state=official-state",
                "expires_at":chrono::Utc::now().timestamp()+60,"poll_interval_sec":1}}),
            )
        };
        let poll = {
            let entered = entered.clone();
            let release = release.clone();
            move |Path(flow): Path<String>| {
                let entered = entered.clone();
                let release = release.clone();
                async move {
                    let provider = flow.trim_start_matches("server-");
                    if provider == "zai" {
                        entered.notify_one();
                        release.notified().await;
                    }
                    let mut data = json!({"status":"ready","token":"fake-zcode-session","user":{"user_id":"stable-user"}});
                    data[provider] = json!({"access_token":"fake-oauth-login-token","refresh_token":"fake-refresh-token"});
                    Json(json!({"code":0,"data":data}))
                }
            }
        };
        let issue = {
            let issued = issued.clone();
            move |Json(body): Json<Value>| {
                let issued = issued.clone();
                async move {
                    assert_eq!(body["clientType"], "zcode");
                    assert_eq!(body["clientVersion"], env!("CARGO_PKG_VERSION"));
                    let generation = issued.fetch_add(1, Ordering::SeqCst) + 1;
                    Json(
                        json!({"code":200,"data":{"accessToken":format!("temporary-project-token-{generation}"),
                        "tokenType":"Bearer","expiresIn":900,"expiresAt":chrono::Utc::now().timestamp()+900}}),
                    )
                }
            }
        };
        let mock=Router::new()
            .route("/api/v1/oauth/cli/init",post(init))
            .route("/api/v1/oauth/cli/poll/:flow",get(poll))
            .route("/api/biz/customer/getCustomerInfo",get(||async {
                Json(json!({"code":0,"data":{"organizations":[{"organizationId":"org","organizationName":"默认机构",
                    "projects":[{"projectId":"project","projectName":"默认项目"}]}]}}))
            }))
            .route("/api/biz/v1/organization/org/projects/project/api_keys",get(||async {
                Json(json!({"code":0,"data":[{"name":"zcode-api-key","apiKey":"non-secret-key-id"}]}))
            }))
            .route("/api/biz/v1/organization/org/projects/project/api_keys/non-secret-key-id/access_tokens",post(issue));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let manager = Arc::new(Manager {
            state: Mutex::new(State::default()),
            path: temp.path().join("accounts.json"),
            oauth_base: format!("{origin}/api/v1"),
            bigmodel_origin: origin.clone(),
            zai_origin: origin,
        });
        let flow = manager.start("bigmodel").await.unwrap();
        assert!(flow.url.starts_with("https://bigmodel.cn/"));
        let result = manager.poll(&flow.flow_id).await;
        assert_eq!(result.status, "success");
        let channel = result.channel.unwrap();
        assert!(channel.api_key.is_empty());
        let account = channel.account_id.unwrap();
        let (first, second) = tokio::join!(manager.resolve(&account), manager.resolve(&account));
        assert_eq!(first.unwrap().api_key, "temporary-project-token-1");
        assert_eq!(second.unwrap().api_key, "temporary-project-token-1");
        assert_eq!(issued.load(Ordering::SeqCst), 1);
        let runtime = manager
            .state
            .lock()
            .await
            .runtime
            .get(&account)
            .unwrap()
            .clone();
        runtime.lock().await.project.as_mut().unwrap().refresh_at = 0;
        assert_eq!(
            manager.resolve(&account).await.unwrap().api_key,
            "temporary-project-token-2"
        );
        let persisted = std::fs::read_to_string(&manager.path).unwrap();
        assert!(persisted.contains("non-secret-key-id"));
        assert!(!persisted.contains("temporary-project-token"));
        assert!(!persisted.contains("poll_token"));
        let late = manager.start("zai").await.unwrap();
        let polling = {
            let manager = manager.clone();
            let flow = late.flow_id.clone();
            tokio::spawn(async move { manager.poll(&flow).await })
        };
        entered.notified().await;
        manager.cancel(&late.flow_id).await;
        release.notify_one();
        assert_eq!(polling.await.unwrap().status, "error");
        assert_eq!(
            manager
                .state
                .lock()
                .await
                .accounts
                .as_ref()
                .unwrap()
                .accounts
                .len(),
            1
        );
        server.abort();
    }
}
