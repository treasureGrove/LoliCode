//! Account-v2 enrollment only. Task packet encryption stays on the v1 wire.
use super::{
    account::{Device, EnrollmentRequest},
    crypto,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use p256::{
    ecdh::diffie_hellman,
    pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey},
    PublicKey, SecretKey,
};
use ring::aead;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const INVALID: &str = "设备身份或加密邀请无效，连接未建立";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredIdentity {
    pub device_id: String,
    pub private_key: String,
}
pub(super) struct Identity {
    pub device_id: String,
    pub key: SecretKey,
    pub public_key: String,
    pub fingerprint: String,
}
pub(super) fn decode(text: &str, max: usize) -> Result<Vec<u8>, String> {
    if text.len() > max || text.contains('=') {
        return Err(INVALID.into());
    }
    let bytes = URL_SAFE_NO_PAD.decode(text).map_err(|_| INVALID)?;
    if URL_SAFE_NO_PAD.encode(&bytes) != text {
        return Err(INVALID.into());
    }
    Ok(bytes)
}
pub(super) fn uuid(text: &str) -> bool {
    uuid::Uuid::parse_str(text).is_ok_and(|id| id.to_string() == text)
}
pub(super) fn hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn account_id(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub(super) fn fingerprint(spki: &str) -> Result<String, String> {
    let bytes = decode(spki, 256)?;
    PublicKey::from_public_key_der(&bytes).map_err(|_| INVALID)?;
    Ok(crypto::hex(&Sha256::digest(bytes)))
}
impl Identity {
    pub fn generate() -> Result<(Self, StoredIdentity), String> {
        let mut key = None;
        for _ in 0..8 {
            if let Ok(value) = SecretKey::from_slice(&crypto::random::<32>()?) {
                key = Some(value);
                break;
            }
        }
        let key = key.ok_or(INVALID)?;
        let stored = StoredIdentity {
            device_id: uuid::Uuid::new_v4().to_string(),
            private_key: crypto::encode(key.to_pkcs8_der().map_err(|_| INVALID)?.as_bytes()),
        };
        Ok((Self::load(&stored)?, stored))
    }
    pub fn load(stored: &StoredIdentity) -> Result<Self, String> {
        if !uuid(&stored.device_id) {
            return Err(INVALID.into());
        }
        let key =
            SecretKey::from_pkcs8_der(&decode(&stored.private_key, 1024)?).map_err(|_| INVALID)?;
        let public_key = crypto::encode(
            key.public_key()
                .to_public_key_der()
                .map_err(|_| INVALID)?
                .as_bytes(),
        );
        Ok(Self {
            device_id: stored.device_id.clone(),
            fingerprint: fingerprint(&public_key)?,
            public_key,
            key,
        })
    }
    pub fn matches(&self, device: &Device) -> bool {
        device.device_id == self.device_id
            && device.public_key == self.public_key
            && device.fingerprint == self.fingerprint
            && device.kind == "desktop"
    }
}
pub(super) fn validate_device(device: &Device) -> Result<(), String> {
    if !uuid(&device.device_id)
        || !matches!(device.kind.as_str(), "desktop" | "phone")
        || device.device_name.trim().is_empty()
        || device.device_name.len() > 128
        || device.device_name.chars().any(char::is_control)
        || fingerprint(&device.public_key)? != device.fingerprint
    {
        return Err(INVALID.into());
    }
    Ok(())
}
pub(super) fn transcript(request: &EnrollmentRequest) -> Result<String, String> {
    validate_device(&request.desktop)?;
    validate_device(&request.phone)?;
    if !account_id(&request.account_id)
        || !uuid(&request.request_id)
        || decode(&request.challenge, 64)?.len() != 32
        || request.desktop.kind != "desktop"
        || request.phone.kind != "phone"
        || request.desktop.device_id == request.phone.device_id
        || request.desktop.fingerprint == request.phone.fingerprint
        || request.expires_at < request.created_at
        || request.expires_at - request.created_at > crypto::WINDOW_MS
        || !matches!(request.status.as_str(), "pending" | "approved" | "rejected")
    {
        return Err(INVALID.into());
    }
    Ok([
        "lolicode-companion-account/2",
        &request.account_id,
        &request.request_id,
        &request.challenge,
        &request.desktop.device_id,
        &request.desktop.fingerprint,
        &request.phone.device_id,
        &request.phone.fingerprint,
    ]
    .join("\n"))
}
fn wrapping_key(
    identity: &Identity,
    request: &EnrollmentRequest,
    phone: bool,
) -> Result<[u8; 32], String> {
    let peer = if phone {
        &request.desktop
    } else {
        &request.phone
    };
    let peer =
        PublicKey::from_public_key_der(&decode(&peer.public_key, 256)?).map_err(|_| INVALID)?;
    let shared = diffie_hellman(identity.key.to_nonzero_scalar(), peer.as_affine());
    let mut key = [0u8; 32];
    hkdf::Hkdf::<Sha256>::new(
        Some(&decode(&request.challenge, 64)?),
        shared.raw_secret_bytes(),
    )
    .expand(transcript(request)?.as_bytes(), &mut key)
    .map_err(|_| INVALID)?;
    Ok(key)
}
pub(super) fn seal(
    identity: &Identity,
    request: &EnrollmentRequest,
    pairing: &Value,
) -> Result<Value, String> {
    seal_nonce(identity, request, pairing, crypto::random()?)
}
fn seal_nonce(
    identity: &Identity,
    request: &EnrollmentRequest,
    pairing: &Value,
    nonce: [u8; 12],
) -> Result<Value, String> {
    if !identity.matches(&request.desktop) {
        return Err(INVALID.into());
    }
    let value = json!({"v":2,"accountId":request.account_id,"requestId":request.request_id,"desktopDeviceId":request.desktop.device_id,"phoneDeviceId":request.phone.device_id,"desktopKeyFingerprint":request.desktop.fingerprint,"phoneKeyFingerprint":request.phone.fingerprint,"pairing":pairing});
    let mut bytes = serde_json::to_vec(&value).map_err(|_| INVALID)?;
    let cipher = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &wrapping_key(identity, request, false)?)
            .map_err(|_| INVALID)?,
    );
    cipher
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(format!("{}\nenrollment", transcript(request)?)),
            &mut bytes,
        )
        .map_err(|_| INVALID)?;
    Ok(json!({"nonce":crypto::encode(&nonce),"ciphertext":crypto::encode(&bytes)}))
}
pub(super) fn envelope_hash(envelope: &Value) -> Result<String, String> {
    let nonce = envelope["nonce"].as_str().ok_or(INVALID)?;
    let body = envelope["ciphertext"].as_str().ok_or(INVALID)?;
    if decode(nonce, 16)?.len() != 12 || !(16..=8192).contains(&decode(body, 12000)?.len()) {
        return Err(INVALID.into());
    }
    Ok(crypto::hex(&Sha256::digest(format!("{nonce}\n{body}"))))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn vector() -> Value {
        serde_json::from_str(include_str!(
            "../../../../docs/architecture/fixtures/companion-account-v2-vector.json"
        ))
        .unwrap()
    }
    #[test]
    fn node_generated_cross_language_envelope_matches_p256_hkdf_and_aes_gcm() {
        let v = vector();
        let plain: Value = serde_json::from_str(v["plaintext"].as_str().unwrap()).unwrap();
        let request: EnrollmentRequest = serde_json::from_value(json!({"requestId":v["requestId"],"accountId":v["accountId"],"challenge":v["challenge"],"desktop":{"deviceId":v["desktopDeviceId"],"deviceName":"Fixture desktop","kind":"desktop","publicKey":v["desktop"]["publicKey"],"fingerprint":v["desktop"]["fingerprint"],"online":true,"lastSeenAt":1893455700000u64},"phone":{"deviceId":v["phoneDeviceId"],"deviceName":"Fixture phone","kind":"phone","publicKey":v["phone"]["publicKey"],"fingerprint":v["phone"]["fingerprint"],"online":true,"lastSeenAt":1893455700000u64},"createdAt":1893455700000u64,"expiresAt":1893456000000u64,"status":"pending"})).unwrap();
        let identity = Identity::load(&StoredIdentity {
            device_id: request.desktop.device_id.clone(),
            private_key: v["desktop"]["privateKeyPkcs8"].as_str().unwrap().into(),
        })
        .unwrap();
        assert_eq!(identity.public_key, request.desktop.public_key);
        assert_eq!(
            crypto::encode(&wrapping_key(&identity, &request, false).unwrap()),
            v["derivedKey"]
        );
        let nonce: [u8; 12] = decode(v["nonce"].as_str().unwrap(), 16)
            .unwrap()
            .try_into()
            .unwrap();
        // Object insertion order is irrelevant to enrollment authentication;
        // compare authenticated plaintext, not incidental JSON key order.
        let envelope = seal_nonce(&identity, &request, &plain["pairing"], nonce).unwrap();
        assert_eq!(envelope["ciphertext"], v["ciphertext"]);
        let phone = Identity::load(&StoredIdentity {
            device_id: request.phone.device_id.clone(),
            private_key: v["phone"]["privateKeyPkcs8"].as_str().unwrap().into(),
        })
        .unwrap();
        let key = wrapping_key(&phone, &request, true).unwrap();
        assert_eq!(transcript(&request).unwrap(), v["transcript"]);
        for candidate in [
            envelope,
            json!({"nonce":v["nonce"],"ciphertext":v["ciphertext"]}),
        ] {
            let cipher =
                aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &key).unwrap());
            let mut bytes = decode(candidate["ciphertext"].as_str().unwrap(), 12000).unwrap();
            let plaintext = cipher
                .open_in_place(
                    aead::Nonce::assume_unique_for_key(nonce),
                    aead::Aad::from(format!("{}\nenrollment", transcript(&request).unwrap())),
                    &mut bytes,
                )
                .unwrap();
            let decrypted: Value = serde_json::from_slice(plaintext).unwrap();
            assert_eq!(decrypted, plain);
        }
        let mut wrong = request.clone();
        wrong.account_id = "foreign".into();
        assert_ne!(wrapping_key(&phone, &wrong, true).unwrap(), key);
        let mut tampered = decode(v["ciphertext"].as_str().unwrap(), 12000).unwrap();
        tampered[0] ^= 1;
        let cipher =
            aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &key).unwrap());
        assert!(cipher
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(format!("{}\nenrollment", transcript(&request).unwrap())),
                &mut tampered
            )
            .is_err());
        let wrong_key = wrapping_key(&phone, &wrong, true).unwrap();
        let cipher =
            aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &wrong_key).unwrap());
        let mut body = decode(v["ciphertext"].as_str().unwrap(), 12000).unwrap();
        assert!(cipher
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(format!("{}\nenrollment", transcript(&wrong).unwrap())),
                &mut body
            )
            .is_err());
        let mut wrong = request.clone();
        wrong.phone.fingerprint = "0".repeat(64);
        assert!(transcript(&wrong).is_err());
        assert!(decode("AA==", 16).is_err());
    }
}
