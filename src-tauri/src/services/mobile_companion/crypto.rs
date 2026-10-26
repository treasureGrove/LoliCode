//! Wire encryption is independent of WebSocket and never logs key material.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use serde_json::{json, Value};

pub(super) const WINDOW_MS: u64 = 5 * 60 * 1000;
pub(super) const MAX_PLAIN: usize = 30 * 1024;
pub(super) fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}
pub(super) fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "系统安全随机数不可用")?;
    Ok(bytes)
}
pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub(super) fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
fn decode(value: &Value, name: &str, max: usize) -> Result<Vec<u8>, String> {
    let text = value[name]
        .as_str()
        .filter(|s| s.len() <= max)
        .ok_or("加密包字段无效")?;
    URL_SAFE_NO_PAD
        .decode(text)
        .map_err(|_| "加密包编码无效".into())
}
pub(super) fn seal(key: &[u8; 32], room: &str, payload: &Value) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let nonce = random::<12>()?;
    let mut body = serde_json::to_vec(payload).map_err(|_| "消息编码失败")?;
    if body.len() > MAX_PLAIN {
        return Err("消息超过安全传输上限".into());
    }
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| "配对密钥无效")?,
    );
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(format!("lolicode-companion/1|{room}|desktop|{id}")),
        &mut body,
    )
    .map_err(|_| "消息加密失败")?;
    Ok(json!({"type":"packet","v":1,"id":id,"nonce":encode(&nonce),"ciphertext":encode(&body)}))
}
pub(super) fn open(
    key: &[u8; 32],
    room: &str,
    packet: &Value,
    time: u64,
) -> Result<(String, Value), String> {
    if packet["type"] != "packet" || packet["v"] != 1 || packet["from"] != "phone" {
        return Err("消息来源或协议无效".into());
    }
    let id = packet["id"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or("消息编号无效")?;
    let nonce: [u8; 12] = decode(packet, "nonce", 16)?
        .try_into()
        .map_err(|_| "消息随机数无效")?;
    let mut body = decode(packet, "ciphertext", 48 * 1024)?;
    if body.len() > MAX_PLAIN + 16 || body.len() < 16 {
        return Err("加密消息大小无效".into());
    }
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| "配对密钥无效")?,
    );
    let plaintext = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(format!("lolicode-companion/1|{room}|phone|{id}")),
            &mut body,
        )
        .map_err(|_| "消息认证失败")?;
    let value: Value = serde_json::from_slice(plaintext).map_err(|_| "消息格式无效")?;
    let sent = value["sentAt"].as_u64().ok_or("消息缺少时间")?;
    if time.abs_diff(sent) > WINDOW_MS {
        return Err("消息已过期或设备时间不正确".into());
    }
    Ok((id.into(), value))
}
