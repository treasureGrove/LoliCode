//! Account ticket renewal shared by native and text signaling transports.
//! This module depends only on the wire clock, JSON messages and the renewal state.
use super::crypto::now;
use serde_json::{json, Value};
use std::time::Duration;

/// Only the TLS signaling socket can confirm an account ticket renewal. Peer
/// task payloads never update this state or the authority deadline.
pub(super) struct AuthRefresh {
    supported: bool,
    pending: Option<(String, u64, tokio::time::Instant)>,
    renewed: Option<u64>,
}
impl AuthRefresh {
    pub(super) fn new(supported: bool) -> Self {
        Self {
            supported,
            pending: None,
            renewed: None,
        }
    }
    pub(super) fn request(&mut self, ticket: &str, expires: u64) -> Result<Option<Value>, String> {
        if !self.supported {
            return Ok(None);
        }
        if let Some((_, _, started)) = &self.pending {
            if started.elapsed() > Duration::from_secs(30) {
                return Err("账号票据续期未获确认，连接已停止".into());
            }
            return Ok(None);
        }
        if ticket.is_empty() || ticket.len() > 4096 || expires <= now() {
            return Err("账号续期票据无效".into());
        }
        let request = uuid::Uuid::new_v4().to_string();
        self.pending = Some((request.clone(), expires, tokio::time::Instant::now()));
        Ok(Some(
            json!({"type":"auth.refresh","v":1,"requestId":request,"deviceToken":ticket}),
        ))
    }
    pub(super) fn accept(&mut self, value: &Value) -> Result<(), String> {
        let object = value.as_object().ok_or("账号续期确认格式无效")?;
        let (request, expires, started) = self.pending.as_ref().ok_or("意外的账号续期确认")?;
        if object.len() != 4
            || object
                .keys()
                .any(|key| !["type", "v", "requestId", "expiresAt"].contains(&key.as_str()))
            || value["type"] != "auth.renewed"
            || value["v"] != 1
            || value["requestId"] != *request
            || value["expiresAt"] != *expires
            || *expires <= now()
            || started.elapsed() > Duration::from_secs(30)
        {
            return Err("账号续期确认不匹配，连接已停止".into());
        }
        self.renewed = Some(*expires);
        self.pending = None;
        Ok(())
    }
    pub(super) fn take_renewed(&mut self) -> Option<u64> {
        self.renewed.take()
    }
}

#[cfg(test)]
#[path = "auth_refresh/tests.rs"]
mod tests;
