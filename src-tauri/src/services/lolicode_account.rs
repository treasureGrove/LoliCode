//! LoliCode forum identity, independent of model-provider authentication.
//! Only public profile data crosses IPC; credentials live in the OS vault.
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use futures::StreamExt;
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use url::Url;

const ORIGIN: &str = "https://lolicode.com";
const VAULT_SERVICE: &str = "com.lolicode.desktop.forum-account.v1";
const VAULT_USER: &str = "current-account";
const VAULT_WARNING: &str = "系统凭据库不可用，本次登录仅在当前应用会话中保留。";
const VAULT_REPLACEMENT_WARNING: &str = "本次登录仅在当前应用会话中保留，系统凭据未能更新或删除；下次启动可能恢复之前的账户。请在系统凭据管理器移除 LoliCode 账户凭据。";
const LOGOUT_WARNING: &str = "已退出当前会话，但未能删除系统凭据。请在系统凭据管理器移除 LoliCode 账户凭据，避免下次启动恢复登录。";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LolicodeAccount {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub profile_url: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LolicodeAccountStatus {
    pub account: Option<LolicodeAccount>,
    pub persistent: bool,
    pub warning: Option<String>,
}

// Deliberately neither Debug nor exposed through commands/events.
#[derive(Clone, Serialize, Deserialize)]
struct Credential {
    id: String,
    token: String,
}

#[derive(Clone, Copy)]
enum ForumFailure {
    Unauthorized,
    Network,
    InvalidResponse,
}

impl ForumFailure {
    fn message(self) -> &'static str {
        match self {
            Self::Unauthorized => "账号或密码不正确，或登录已失效。请重新登录 LoliCode。",
            Self::Network => "暂时无法连接 LoliCode，请检查网络后重试。",
            Self::InvalidResponse => "LoliCode 返回的账户资料无效，请稍后重试。",
        }
    }
}

type ForumFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ForumFailure>> + Send + 'a>>;

trait ForumApi: Send + Sync {
    fn login<'a>(
        &'a self,
        identification: &'a str,
        password: &'a str,
    ) -> ForumFuture<'a, Credential>;
    fn profile<'a>(&'a self, credential: &'a Credential) -> ForumFuture<'a, LolicodeAccount>;
}

trait CredentialVault: Send + Sync {
    fn read(&self) -> Result<Option<Credential>, ()>;
    fn write(&self, credential: &Credential) -> Result<(), ()>;
    fn delete(&self) -> Result<(), ()>;
}

struct SystemVault;

impl CredentialVault for SystemVault {
    fn read(&self) -> Result<Option<Credential>, ()> {
        let entry = keyring::Entry::new(VAULT_SERVICE, VAULT_USER).map_err(|_| ())?;
        match entry.get_password() {
            Ok(secret) => {
                let credential: Credential = serde_json::from_str(&secret).map_err(|_| ())?;
                validate_credential(&credential).map_err(|_| ())?;
                Ok(Some(credential))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }

    fn write(&self, credential: &Credential) -> Result<(), ()> {
        let secret = serde_json::to_string(credential).map_err(|_| ())?;
        keyring::Entry::new(VAULT_SERVICE, VAULT_USER)
            .map_err(|_| ())?
            .set_password(&secret)
            .map_err(|_| ())
    }

    fn delete(&self) -> Result<(), ()> {
        match keyring::Entry::new(VAULT_SERVICE, VAULT_USER)
            .map_err(|_| ())?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

struct LiveForum;

fn forum_client() -> Result<Client, ForumFailure> {
    Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("LoliCodeDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| ForumFailure::Network)
}

async fn response_json(response: Response, limit: usize) -> Result<Value, ForumFailure> {
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => return Err(ForumFailure::Unauthorized),
        status if !status.is_success() => return Err(ForumFailure::Network),
        _ => {}
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(ForumFailure::InvalidResponse);
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ForumFailure::Network)?;
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(ForumFailure::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ForumFailure::InvalidResponse)
}

fn login_request(client: &Client, identification: &str, password: &str) -> reqwest::RequestBuilder {
    client
        .post(format!("{ORIGIN}/api/token"))
        .header("Accept", "application/json")
        // Flarum's ordinary session token expires after one hour. The desktop
        // stores a remember token in the OS vault to support persistent login.
        .json(&json!({ "identification": identification, "password": password, "remember": true }))
}

impl ForumApi for LiveForum {
    fn login<'a>(
        &'a self,
        identification: &'a str,
        password: &'a str,
    ) -> ForumFuture<'a, Credential> {
        Box::pin(async move {
            let response = login_request(&forum_client()?, identification, password)
                .send()
                .await
                .map_err(|_| ForumFailure::Network)?;
            if matches!(
                response.status(),
                StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
            ) {
                return Err(ForumFailure::Unauthorized);
            }
            let value = response_json(response, 16_384).await?;
            let id = value
                .get("userId")
                .and_then(value_id)
                .ok_or(ForumFailure::InvalidResponse)?;
            let token = value
                .get("token")
                .and_then(Value::as_str)
                .ok_or(ForumFailure::InvalidResponse)?;
            let credential = Credential {
                id,
                token: token.to_owned(),
            };
            validate_credential(&credential)?;
            Ok(credential)
        })
    }

    fn profile<'a>(&'a self, credential: &'a Credential) -> ForumFuture<'a, LolicodeAccount> {
        Box::pin(async move {
            validate_credential(credential)?;
            let response = forum_client()?
                .get(format!("{ORIGIN}/api/users/{}", credential.id))
                .header("Accept", "application/json")
                .header("Authorization", format!("Token {}", credential.token))
                .send()
                .await
                .map_err(|_| ForumFailure::Network)?;
            parse_profile(response_json(response, 131_072).await?, &credential.id)
        })
    }
}

fn value_id(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.as_u64()?.to_string(),
        _ => return None,
    };
    // Flarum IDs are positive database integers, never paths or arbitrary URL input.
    (text.parse::<u64>().ok().is_some_and(|id| id > 0)
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && !text.starts_with('0'))
    .then_some(text)
}

fn validate_credential(credential: &Credential) -> Result<(), ForumFailure> {
    if value_id(&Value::String(credential.id.clone())).is_none()
        || credential.token.len() != 40
        || !credential
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(ForumFailure::InvalidResponse);
    }
    Ok(())
}

fn public_text(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty() && text.len() <= max && !text.chars().any(char::is_control))
        .then(|| text.to_owned())
}

fn safe_avatar(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    if text.len() > 4096 || text.chars().any(char::is_control) || text.contains('\\') {
        return None;
    }
    let mut url = if text.starts_with('/') && !text.starts_with("//") {
        Url::parse(ORIGIN).ok()?.join(text).ok()?
    } else {
        Url::parse(text).ok()?
    };
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_fragment(None);
    Some(url.into())
}

fn parse_profile(value: Value, expected_id: &str) -> Result<LolicodeAccount, ForumFailure> {
    let user = value.get("data").ok_or(ForumFailure::InvalidResponse)?;
    if user.get("type").and_then(Value::as_str) != Some("users")
        || user.get("id").and_then(value_id).as_deref() != Some(expected_id)
    {
        return Err(ForumFailure::InvalidResponse);
    }
    let attrs = user
        .get("attributes")
        .ok_or(ForumFailure::InvalidResponse)?;
    // Flarum 1.x ignores an invalid Authorization token and may still return a
    // public user resource with HTTP 200. ShowUserController selects the
    // CurrentUserSerializer (including isAdmin) only when actor.id == user.id.
    // Public profile data alone must never restore a desktop login.
    if !attrs.get("isEmailConfirmed").is_some_and(Value::is_boolean)
        || !attrs.get("email").is_some_and(Value::is_string)
        || !attrs.get("isAdmin").is_some_and(Value::is_boolean)
    {
        return Err(ForumFailure::Unauthorized);
    }
    let username = public_text(attrs.get("username"), 512).ok_or(ForumFailure::InvalidResponse)?;
    let display_name = public_text(attrs.get("displayName"), 512)
        .or_else(|| public_text(attrs.get("nickname"), 512))
        .unwrap_or_else(|| username.clone());
    Ok(LolicodeAccount {
        id: expected_id.to_owned(),
        username,
        display_name,
        avatar_url: safe_avatar(attrs.get("avatarUrl")),
        profile_url: format!("{ORIGIN}/u/{expected_id}"),
    })
}

#[derive(Default)]
struct AccountSession {
    initialized: bool,
    credential: Option<Credential>,
    status: LolicodeAccountStatus,
    vault_warning: Option<String>,
}

pub struct LolicodeAccountState {
    // Serialize all account operations, including vault I/O. A refresh that began
    // before logout must finish first and cannot later restore the old identity.
    session: Mutex<AccountSession>,
    api: Arc<dyn ForumApi>,
    vault: Arc<dyn CredentialVault>,
}

impl Default for LolicodeAccountState {
    fn default() -> Self {
        Self {
            session: Mutex::default(),
            api: Arc::new(LiveForum),
            vault: Arc::new(SystemVault),
        }
    }
}

impl LolicodeAccountState {
    /// Native transport only. Never expose this bearer through renderer IPC.
    pub(crate) async fn relay_credential(
        &self,
        expected_id: Option<&str>,
    ) -> Result<(String, String), String> {
        self.status(false).await;
        let session = self.session.lock().await;
        let credential = session
            .credential
            .as_ref()
            .ok_or("请先登录 LoliCode 账号。")?;
        if expected_id.is_some_and(|id| id != credential.id) {
            return Err("公益模型绑定的账号已切换，请刷新公益模型后重试。".into());
        }
        validate_credential(credential).map_err(|_| "LoliCode 登录凭据无效，请重新登录。")?;
        Ok((
            credential.id.clone(),
            format!("lc1.{}.{}", credential.id, credential.token),
        ))
    }

    async fn delete_credential(&self) -> bool {
        let vault = self.vault.clone();
        matches!(
            tokio::task::spawn_blocking(move || vault.delete()).await,
            Ok(Ok(()))
        )
    }

    pub async fn status(&self, refresh: bool) -> LolicodeAccountStatus {
        let mut session = self.session.lock().await;
        if !session.initialized {
            session.initialized = true;
            let vault = self.vault.clone();
            match tokio::task::spawn_blocking(move || vault.read()).await {
                Ok(Ok(credential)) => {
                    session.status.persistent = credential.is_some();
                    session.credential = credential;
                }
                _ => {
                    session.status.warning =
                        Some("无法读取系统凭据库，请重新登录 LoliCode。".to_owned())
                }
            }
        } else if !refresh && session.status.account.is_some() {
            return session.status.clone();
        }
        let Some(credential) = session.credential.clone() else {
            return session.status.clone();
        };
        match self.api.profile(&credential).await {
            Ok(account) => {
                session.status.account = Some(account);
                session.status.warning = session.vault_warning.clone();
            }
            Err(ForumFailure::Unauthorized) => {
                let removed = self.delete_credential().await;
                session.credential = None;
                session.status = LolicodeAccountStatus {
                    warning: Some(
                        if removed {
                            ForumFailure::Unauthorized.message()
                        } else {
                            LOGOUT_WARNING
                        }
                        .to_owned(),
                    ),
                    ..Default::default()
                };
            }
            Err(error) => session.status.warning = Some(error.message().to_owned()),
        }
        session.status.clone()
    }

    pub async fn login(
        &self,
        identification: String,
        password: String,
    ) -> Result<LolicodeAccountStatus, String> {
        let identification = identification.trim();
        if identification.is_empty()
            || identification.len() > 320
            || identification.chars().any(char::is_control)
            || password.is_empty()
            || password.len() > 4096
        {
            return Err("请输入有效的 LoliCode 用户名或邮箱及密码。".to_owned());
        }
        let mut session = self.session.lock().await;
        let credential = self
            .api
            .login(identification, &password)
            .await
            .map_err(|error| error.message().to_owned())?;
        let account = self
            .api
            .profile(&credential)
            .await
            .map_err(|error| error.message().to_owned())?;
        let vault = self.vault.clone();
        let stored = credential.clone();
        let persistent = matches!(
            tokio::task::spawn_blocking(move || vault.write(&stored)).await,
            Ok(Ok(()))
        );
        let vault_warning = if persistent {
            None
        } else {
            // A failed replacement must not intentionally leave another account
            // stored as this session's persistent identity.
            let removed = self.delete_credential().await;
            Some(
                if removed {
                    VAULT_WARNING
                } else {
                    VAULT_REPLACEMENT_WARNING
                }
                .to_owned(),
            )
        };
        *session = AccountSession {
            initialized: true,
            credential: Some(credential),
            status: LolicodeAccountStatus {
                account: Some(account),
                persistent,
                warning: vault_warning.clone(),
            },
            vault_warning,
        };
        Ok(session.status.clone())
    }

    pub async fn logout(&self) -> LolicodeAccountStatus {
        let mut session = self.session.lock().await;
        let removed = self.delete_credential().await;
        *session = AccountSession {
            initialized: true,
            status: LolicodeAccountStatus {
                warning: (!removed).then(|| LOGOUT_WARNING.to_owned()),
                ..Default::default()
            },
            ..Default::default()
        };
        session.status.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Mutex as SyncMutex,
        },
    };

    fn credential() -> Credential {
        Credential {
            id: "42".to_owned(),
            token: "a".repeat(40),
        }
    }

    fn account() -> LolicodeAccount {
        parse_profile(
            json!({"data":{"type":"users","id":"42","attributes":{
                "username":"test-user","displayName":"昵称","avatarUrl":"/assets/avatars/test.png",
                "isEmailConfirmed":true,"email":"fixture@example.invalid","isAdmin":false
            }}}),
            "42",
        )
        .unwrap_or_else(|_| panic!("valid profile"))
    }

    #[derive(Default)]
    struct FakeVault {
        value: SyncMutex<Option<Credential>>,
        fail: AtomicBool,
        fail_write: AtomicBool,
        fail_delete: AtomicBool,
        reads: AtomicUsize,
    }
    impl CredentialVault for FakeVault {
        fn read(&self) -> Result<Option<Credential>, ()> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.fail.load(Ordering::SeqCst) {
                return Err(());
            }
            Ok(self.value.lock().unwrap().clone())
        }
        fn write(&self, value: &Credential) -> Result<(), ()> {
            if self.fail.load(Ordering::SeqCst) || self.fail_write.load(Ordering::SeqCst) {
                return Err(());
            }
            *self.value.lock().unwrap() = Some(value.clone());
            Ok(())
        }
        fn delete(&self) -> Result<(), ()> {
            if self.fail.load(Ordering::SeqCst) || self.fail_delete.load(Ordering::SeqCst) {
                return Err(());
            }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeForum {
        profiles: SyncMutex<VecDeque<Result<LolicodeAccount, ForumFailure>>>,
        calls: AtomicUsize,
    }
    impl ForumApi for FakeForum {
        fn login<'a>(&'a self, _: &'a str, _: &'a str) -> ForumFuture<'a, Credential> {
            Box::pin(async { Ok(credential()) })
        }
        fn profile<'a>(&'a self, _: &'a Credential) -> ForumFuture<'a, LolicodeAccount> {
            Box::pin(async {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.profiles
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| Ok(account()))
            })
        }
    }

    fn service(api: Arc<FakeForum>, vault: Arc<FakeVault>) -> LolicodeAccountState {
        LolicodeAccountState {
            session: Mutex::default(),
            api,
            vault,
        }
    }

    #[test]
    fn profile_is_public_and_bound_to_authenticated_id() {
        let profile = account();
        assert_eq!(profile.display_name, "昵称");
        assert_eq!(
            profile.avatar_url.as_deref(),
            Some("https://lolicode.com/assets/avatars/test.png")
        );
        assert_eq!(profile.profile_url, "https://lolicode.com/u/42");
        assert!(parse_profile(
            json!({"data":{"type":"users","id":"43","attributes":{"username":"other"}}}),
            "42"
        )
        .is_err());
        assert!(parse_profile(
            json!({"data":{"type":"posts","id":"42","attributes":{"username":"other"}}}),
            "42"
        )
        .is_err());
        let serialized = serde_json::to_string(&profile).unwrap();
        assert!(serialized.contains("displayName") && serialized.contains("avatarUrl"));
        assert!(!serialized.contains("token") && !serialized.contains("password"));
    }

    #[test]
    fn desktop_login_requests_a_persistent_flarum_token_from_the_fixed_origin() {
        let request = login_request(
            &forum_client().unwrap_or_else(|_| panic!("client")),
            "fixture@example.invalid",
            "fixture password",
        )
        .build()
        .unwrap();
        assert_eq!(request.url().as_str(), "https://lolicode.com/api/token");
        assert_eq!(request.method(), reqwest::Method::POST);
        let body: Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"identification":"fixture@example.invalid", "password":"fixture password", "remember":true})
        );
    }

    #[test]
    fn unsafe_avatar_urls_and_non_numeric_ids_are_rejected() {
        for invalid in [
            "http://example.com/a.png",
            "javascript:alert(1)",
            "data:image/png;base64,aaaa",
            "https://user:pass@example.com/a",
            "//elsewhere.test/a",
            "/\\elsewhere.test/a",
        ] {
            assert!(safe_avatar(Some(&json!(invalid))).is_none(), "{invalid}");
        }
        assert!(safe_avatar(Some(&json!("https://cdn.example.com/a.png"))).is_some());
        for invalid in ["../users/1", "0", "-1", "01", "42?x=1"] {
            assert!(value_id(&json!(invalid)).is_none());
        }
        let mut secret = credential();
        secret.token = "\r".repeat(40);
        assert!(validate_credential(&secret).is_err());
    }

    #[test]
    fn public_profile_returned_for_invalid_token_does_not_count_as_login() {
        let public_profile = json!({"data":{"type":"users","id":"42","attributes":{
            "username":"test-user","displayName":"Public name","canEdit":false
        }}});
        assert!(matches!(
            parse_profile(public_profile, "42"),
            Err(ForumFailure::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn relay_transport_is_account_bound_and_logout_revokes_local_access() {
        let state = service(
            Arc::new(FakeForum::default()),
            Arc::new(FakeVault::default()),
        );
        assert!(state.relay_credential(None).await.is_err());
        state
            .login("member".into(), "fixture password".into())
            .await
            .unwrap();
        assert!(state.relay_credential(Some("7")).await.is_err());
        let (id, bearer) = state.relay_credential(Some("42")).await.unwrap();
        assert_eq!(id, "42");
        assert_eq!(bearer, format!("lc1.42.{}", "a".repeat(40)));
        let public = serde_json::to_string(&state.status(false).await).unwrap();
        assert!(!public.contains(&bearer) && !public.contains(&"a".repeat(40)));
        state.logout().await;
        assert!(state.relay_credential(Some("42")).await.is_err());
    }

    #[tokio::test]
    async fn signed_out_status_does_not_query_the_site() {
        let api = Arc::new(FakeForum::default());
        let vault = Arc::new(FakeVault::default());
        let state = service(api.clone(), vault.clone());
        assert!(state.status(false).await.account.is_none());
        assert!(state.status(true).await.account.is_none());
        assert_eq!(api.calls.load(Ordering::SeqCst), 0);
        assert_eq!(vault.reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn network_responses_are_bounded_and_never_surface_server_bodies() {
        let response = |status, body: &'static str| {
            Response::from(http::Response::builder().status(status).body(body).unwrap())
        };
        assert!(response_json(response(200, "{\"large\":\"value\"}"), 4)
            .await
            .is_err());
        assert!(matches!(
            response_json(response(401, "secret server error"), 1024).await,
            Err(ForumFailure::Unauthorized)
        ));
        assert!(matches!(
            response_json(response(302, "redirect to another site"), 1024).await,
            Err(ForumFailure::Network)
        ));
        assert!(response_json(response(200, "not json"), 1024)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn restored_credentials_are_validated_and_network_errors_keep_profile() {
        let api = Arc::new(FakeForum::default());
        let vault = Arc::new(FakeVault::default());
        *vault.value.lock().unwrap() = Some(credential());
        let state = service(api.clone(), vault.clone());
        let initial = state.status(false).await;
        assert_eq!(initial.account, Some(account()));
        assert!(initial.persistent);
        api.profiles
            .lock()
            .unwrap()
            .push_back(Err(ForumFailure::Network));
        let failed = state.status(true).await;
        assert_eq!(failed.account, initial.account);
        assert!(failed.warning.is_some());
        api.profiles
            .lock()
            .unwrap()
            .push_back(Err(ForumFailure::Unauthorized));
        let expired = state.status(true).await;
        assert!(expired.account.is_none() && !expired.persistent);
        assert!(vault.value.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn failed_vault_keeps_only_current_session_and_logout_cannot_restore_it() {
        let api = Arc::new(FakeForum::default());
        let vault = Arc::new(FakeVault::default());
        vault.fail.store(true, Ordering::SeqCst);
        let state = service(api.clone(), vault.clone());
        let status = state
            .login(" user@example.com ".to_owned(), "test password".to_owned())
            .await
            .unwrap();
        assert!(status.account.is_some() && !status.persistent && status.warning.is_some());
        let status = state.logout().await;
        assert!(status.account.is_none() && status.warning.is_some());
        let calls = api.calls.load(Ordering::SeqCst);
        assert!(state.status(true).await.account.is_none());
        assert_eq!(api.calls.load(Ordering::SeqCst), calls);
    }

    #[tokio::test]
    async fn login_persists_without_password_and_logout_removes_only_own_vault_entry() {
        let api = Arc::new(FakeForum::default());
        let vault = Arc::new(FakeVault::default());
        let state = service(api, vault.clone());
        let status = state
            .login("test-user".to_owned(), "not stored".to_owned())
            .await
            .unwrap();
        assert!(status.persistent && status.warning.is_none());
        let stored = serde_json::to_string(vault.value.lock().unwrap().as_ref().unwrap()).unwrap();
        assert!(!stored.contains("password") && !stored.contains("not stored"));
        assert!(state.logout().await.account.is_none());
        assert!(vault.value.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn failed_replacement_and_delete_warn_that_previous_account_can_return() {
        let api = Arc::new(FakeForum::default());
        let vault = Arc::new(FakeVault::default());
        let mut previous = credential();
        previous.id = "7".to_owned();
        previous.token = "b".repeat(40);
        *vault.value.lock().unwrap() = Some(previous);
        vault.fail_write.store(true, Ordering::SeqCst);
        vault.fail_delete.store(true, Ordering::SeqCst);
        let state = service(api.clone(), vault.clone());
        let status = state
            .login("test-user".to_owned(), "fixture password".to_owned())
            .await
            .unwrap();
        assert_eq!(status.account.as_ref().unwrap().id, "42");
        assert!(!status.persistent);
        assert_eq!(status.warning.as_deref(), Some(VAULT_REPLACEMENT_WARNING));
        assert_eq!(vault.value.lock().unwrap().as_ref().unwrap().id, "7");
        // Successful profile refresh must not erase the unresolved storage warning.
        assert_eq!(
            state.status(true).await.warning.as_deref(),
            Some(VAULT_REPLACEMENT_WARNING)
        );
        let mut old_account = account();
        old_account.id = "7".to_owned();
        api.profiles.lock().unwrap().push_back(Ok(old_account));
        let restarted = service(api, vault);
        assert_eq!(restarted.status(false).await.account.unwrap().id, "7");
    }

    #[tokio::test]
    async fn failed_replacement_with_successful_delete_does_not_claim_old_credentials_remain() {
        let api = Arc::new(FakeForum::default());
        let vault = Arc::new(FakeVault::default());
        *vault.value.lock().unwrap() = Some(credential());
        vault.fail_write.store(true, Ordering::SeqCst);
        let state = service(api, vault.clone());
        let status = state
            .login("test-user".to_owned(), "fixture password".to_owned())
            .await
            .unwrap();
        assert!(status.account.is_some() && !status.persistent);
        assert_eq!(status.warning.as_deref(), Some(VAULT_WARNING));
        assert!(vault.value.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn logout_waits_for_inflight_refresh_and_old_profile_cannot_sign_in_again() {
        struct SlowForum {
            entered: tokio::sync::Notify,
            release: tokio::sync::Notify,
        }
        impl ForumApi for SlowForum {
            fn login<'a>(&'a self, _: &'a str, _: &'a str) -> ForumFuture<'a, Credential> {
                Box::pin(async { Ok(credential()) })
            }
            fn profile<'a>(&'a self, _: &'a Credential) -> ForumFuture<'a, LolicodeAccount> {
                Box::pin(async {
                    self.entered.notify_one();
                    self.release.notified().await;
                    Ok(account())
                })
            }
        }
        let api = Arc::new(SlowForum {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let vault = Arc::new(FakeVault::default());
        *vault.value.lock().unwrap() = Some(credential());
        let state = Arc::new(LolicodeAccountState {
            session: Mutex::default(),
            api: api.clone(),
            vault,
        });
        let refresh_state = state.clone();
        let refresh = tokio::spawn(async move { refresh_state.status(true).await });
        api.entered.notified().await;
        let logout_state = state.clone();
        let logout = tokio::spawn(async move { logout_state.logout().await });
        api.release.notify_one();
        assert!(refresh.await.unwrap().account.is_some());
        assert!(logout.await.unwrap().account.is_none());
        assert!(state.status(false).await.account.is_none());
    }
}
