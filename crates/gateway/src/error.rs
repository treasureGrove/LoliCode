use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SafeError {
    pub code: String,
    pub message: String,
    #[serde(skip)]
    pub status: u16,
}

pub type Result<T> = std::result::Result<T, SafeError>;

impl SafeError {
    pub fn new(status: u16, code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status,
        }
    }
    pub fn storage() -> Self {
        Self::new(
            500,
            "storage_error",
            "本地配置读取或保存失败，请重启后重试。",
        )
    }
    pub fn credentials() -> Self {
        Self::new(
            503,
            "credential_error",
            "系统凭据库不可用，请检查 Windows 登录与凭据管理器。",
        )
    }
    pub fn invalid(message: &str) -> Self {
        Self::new(400, "invalid_request", message)
    }
    pub fn from_upstream(status: u16) -> Self {
        match status {
            401 => Self::new(
                502,
                "upstream_authentication",
                "渠道 Key 无效或已过期，请更新凭据。",
            ),
            403 => Self::new(
                502,
                "upstream_permission",
                "渠道拒绝访问，请核对账户权限、地区和模型。",
            ),
            429 => Self::new(
                429,
                "upstream_rate_limit",
                "渠道限流或配额不足，请稍后重试或检查账户额度。",
            ),
            400 | 404 | 422 => Self::new(
                400,
                "upstream_request",
                "渠道不支持此模型或请求参数，请核对模型与接口。",
            ),
            _ => Self::new(502, "upstream_unavailable", "渠道暂时不可用，请稍后重试。"),
        }
    }
}

impl std::fmt::Display for SafeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for SafeError {}
impl IntoResponse for SafeError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(serde_json::json!({"error": {"type": self.code, "code": self.code, "message": self.message}}))).into_response()
    }
}
