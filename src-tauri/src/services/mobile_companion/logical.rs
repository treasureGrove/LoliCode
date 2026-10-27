//! A bounded logical JSON object over the existing authenticated small frames.
//! Compression is not encryption; channel/epoch authentication stays with AEAD.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use flate2::{write::ZlibEncoder, Compression, Decompress, FlushDecompress, Status};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Write},
    time::{Duration, Instant},
};

pub(super) const MAX_LOGICAL_BYTES: usize = 1_048_576;
pub(super) const MAX_COMPRESSED_BYTES: usize = MAX_LOGICAL_BYTES + 64 * 1024;
pub(super) const CHUNK_BYTES: usize = 3000;
pub(super) const SMALL_BYTES: usize = 5000;
const MAX_PARTS: usize = MAX_COMPRESSED_BYTES.div_ceil(CHUNK_BYTES);
const MAX_PART_PLAIN: usize = 5500;
const IDLE: Duration = Duration::from_secs(30);
const LIFETIME: Duration = Duration::from_secs(60 * 60);
const INVALID: &str = "逻辑消息分片无效、已取消或未通过完整性校验";
const OVERSIZE: &str = "逻辑消息超过 1 MiB UTF-8 上限，请缩短内容";

struct JsonBuffer(Vec<u8>);
impl Write for JsonBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_LOGICAL_BYTES {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "logical_size"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn bytes(value: &Value) -> Result<Vec<u8>, String> {
    if !value.is_object() {
        return Err(INVALID.into());
    }
    let mut buffer = JsonBuffer(Vec::new());
    serde_json::to_writer(&mut buffer, value).map_err(|_| OVERSIZE)?;
    check_depth(&buffer.0)?;
    Ok(buffer.0)
}
fn check_depth(bytes: &[u8]) -> Result<(), String> {
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for byte in bytes {
        if quoted {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'{' | b'[' => {
                    depth += 1;
                    if depth > 20 {
                        return Err(INVALID.into());
                    }
                }
                b'}' | b']' => depth = depth.checked_sub(1).ok_or(INVALID)?,
                _ => {}
            }
        }
    }
    if quoted || depth != 0 {
        return Err(INVALID.into());
    }
    Ok(())
}
fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn request_id(value: &Value) -> Result<String, String> {
    let id = value.get("requestId").and_then(Value::as_str).unwrap_or("");
    if id.len() > 128 || id.contains('\0') {
        return Err(INVALID.into());
    }
    Ok(id.into())
}
fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn reserved(value: &Value) -> bool {
    value["type"]
        .as_str()
        .is_some_and(|kind| kind.starts_with("logical."))
}

pub(super) fn encode(value: &Value) -> Result<Vec<Value>, String> {
    if reserved(value) {
        return Err(INVALID.into());
    }
    let raw = bytes(value)?;
    let request = request_id(value)?;
    if raw.len() <= SMALL_BYTES {
        return Ok(vec![value.clone()]);
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw).map_err(|_| INVALID)?;
    let compressed = encoder.finish().map_err(|_| INVALID)?;
    if compressed.is_empty() || compressed.len() > MAX_COMPRESSED_BYTES {
        return Err(OVERSIZE.into());
    }
    let transfer = uuid::Uuid::new_v4().to_string();
    let checksum = sha(&raw);
    let total = compressed.len().div_ceil(CHUNK_BYTES);
    compressed.chunks(CHUNK_BYTES).enumerate().map(|(index,chunk)| {
        let part=json!({"type":"logical.part","v":1,"transferId":transfer,"index":index,"total":total,
            "decodedBytes":raw.len(),"compressedBytes":compressed.len(),"sha256":checksum,"requestId":request,
            "codec":"zlib","data":URL_SAFE_NO_PAD.encode(chunk)});
        // sentAt is inserted by the existing seal operation.
        if serde_json::to_vec(&part).map_err(|_|INVALID)?.len()+40>MAX_PART_PLAIN {return Err(INVALID.into());}
        Ok(part)
    }).collect()
}

#[derive(Clone, PartialEq, Eq)]
struct Meta {
    transfer: String,
    total: usize,
    decoded: usize,
    compressed: usize,
    checksum: String,
    request: String,
}
struct Active {
    meta: Meta,
    next: usize,
    data: Vec<u8>,
    started: Instant,
    last: Instant,
}
#[derive(Default)]
pub(super) struct Receiver {
    active: Option<Active>,
}

impl Receiver {
    pub(super) fn progress_request_id(&self) -> Option<&str> {
        self.active
            .as_ref()
            .map(|a| a.meta.request.as_str())
            .filter(|id| !id.is_empty())
    }
    pub(super) fn progress_transfer_id(&self) -> Option<&str> {
        self.active.as_ref().map(|a| a.meta.transfer.as_str())
    }
    pub(super) fn received_compressed_bytes(&self) -> usize {
        self.active.as_ref().map_or(0, |a| a.data.len())
    }
    pub(super) fn total_compressed_bytes(&self) -> usize {
        self.active.as_ref().map_or(0, |a| a.meta.compressed)
    }
    pub(super) fn next_deadline(&self) -> Option<Instant> {
        self.active
            .as_ref()
            .map(|a| (a.last + IDLE).min(a.started + LIFETIME))
    }
    pub(super) fn clear(&mut self) {
        self.active = None;
    }
    pub(super) fn check_timeout(&mut self) -> Result<(), String> {
        if self.expired(Instant::now()) {
            self.active = None;
            return Err("逻辑消息组装超时，请刷新后重试".into());
        }
        Ok(())
    }
    fn expired(&self, now: Instant) -> bool {
        self.active.as_ref().is_some_and(|a| {
            now.checked_duration_since(a.last).is_none_or(|d| d >= IDLE)
                || now
                    .checked_duration_since(a.started)
                    .is_none_or(|d| d >= LIFETIME)
        })
    }
    pub(super) fn ingest(&mut self, value: Value) -> Result<Option<Value>, String> {
        self.ingest_at(value, Instant::now())
    }
    fn ingest_at(&mut self, value: Value, now: Instant) -> Result<Option<Value>, String> {
        let result = self.ingest_inner(value, now);
        if result.is_err() {
            self.active = None;
        }
        result
    }
    fn ingest_inner(&mut self, value: Value, now: Instant) -> Result<Option<Value>, String> {
        let object = value.as_object().ok_or(INVALID)?;
        let expired = if self.expired(now) {
            self.active.take().map(|a| a.meta.transfer)
        } else {
            None
        };
        match value["type"].as_str() {
            Some("logical.cancel") => {
                if object
                    .keys()
                    .any(|key| !matches!(key.as_str(), "type" | "transferId" | "sentAt"))
                    || !matches!(object.len(), 2 | 3)
                    || value
                        .get("sentAt")
                        .is_some_and(|time| time.as_u64().is_none())
                {
                    return Err(INVALID.into());
                }
                let id = value["transferId"]
                    .as_str()
                    .filter(|id| uuid(id))
                    .ok_or(INVALID)?;
                if self.active.as_ref().is_some_and(|a| a.meta.transfer == id) {
                    self.active = None;
                }
                Ok(None)
            }
            Some("logical.part") => {
                let (meta, index, chunk) = parse_part(&value)?;
                if expired
                    .as_deref()
                    .is_some_and(|old| index != 0 || old == meta.transfer)
                {
                    return Err(INVALID.into());
                }
                if self.active.is_none() {
                    if index != 0 {
                        return Err(INVALID.into());
                    }
                    self.active = Some(Active {
                        data: Vec::with_capacity(meta.compressed),
                        meta: meta.clone(),
                        next: 0,
                        started: now,
                        last: now,
                    });
                }
                let active = self.active.as_mut().ok_or(INVALID)?;
                if active.meta != meta
                    || active.next != index
                    || active.data.len().saturating_add(chunk.len()) > active.meta.compressed
                {
                    return Err(INVALID.into());
                }
                active.data.extend_from_slice(&chunk);
                active.next += 1;
                active.last = now;
                if active.next != active.meta.total {
                    return Ok(None);
                }
                let active = self.active.take().ok_or(INVALID)?;
                if active.data.len() != active.meta.compressed {
                    return Err(INVALID.into());
                }
                decode(active)
            }
            Some(kind) if kind.starts_with("logical.") => Err(INVALID.into()),
            _ => {
                bytes(&value)?;
                Ok(Some(value))
            }
        }
    }
}

fn parse_part(value: &Value) -> Result<(Meta, usize, Vec<u8>), String> {
    const KEYS: [&str; 11] = [
        "type",
        "v",
        "transferId",
        "index",
        "total",
        "decodedBytes",
        "compressedBytes",
        "sha256",
        "requestId",
        "codec",
        "data",
    ];
    let object = value.as_object().ok_or(INVALID)?;
    if !matches!(object.len(), 11 | 12)
        || KEYS.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !KEYS.contains(&key.as_str()) && key != "sentAt")
        || value["v"].as_u64() != Some(1)
        || value["codec"] != "zlib"
        || value
            .get("sentAt")
            .is_some_and(|time| time.as_u64().is_none())
        || serde_json::to_vec(value).map_err(|_| INVALID)?.len() > MAX_PART_PLAIN
    {
        return Err(INVALID.into());
    }
    let number = |key: &str| {
        value[key]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or(INVALID)
    };
    let total = number("total")?;
    let index = number("index")?;
    let decoded = number("decodedBytes")?;
    let compressed = number("compressedBytes")?;
    if decoded == 0
        || decoded > MAX_LOGICAL_BYTES
        || compressed == 0
        || compressed > MAX_COMPRESSED_BYTES
        || total == 0
        || total > MAX_PARTS
        || total != compressed.div_ceil(CHUNK_BYTES)
        || index >= total
    {
        return Err(INVALID.into());
    }
    let transfer = value["transferId"]
        .as_str()
        .filter(|id| uuid(id))
        .ok_or(INVALID)?
        .to_owned();
    let checksum = value["sha256"]
        .as_str()
        .filter(|hash| hex64(hash))
        .ok_or(INVALID)?
        .to_owned();
    let request = value["requestId"]
        .as_str()
        .filter(|id| id.len() <= 128 && !id.contains('\0'))
        .ok_or(INVALID)?
        .to_owned();
    let data = value["data"]
        .as_str()
        .filter(|data| data.len() <= 4000)
        .ok_or(INVALID)?;
    let chunk = URL_SAFE_NO_PAD.decode(data).map_err(|_| INVALID)?;
    let expected = if index + 1 == total {
        compressed - index * CHUNK_BYTES
    } else {
        CHUNK_BYTES
    };
    if chunk.len() != expected || URL_SAFE_NO_PAD.encode(&chunk) != data {
        return Err(INVALID.into());
    }
    Ok((
        Meta {
            transfer,
            total,
            decoded,
            compressed,
            checksum,
            request,
        },
        index,
        chunk,
    ))
}

fn decode(active: Active) -> Result<Option<Value>, String> {
    // One extra output byte detects a lying decodedBytes and decompression bombs
    // without permitting output allocation beyond the declared bounded size.
    let mut output = vec![0u8; active.meta.decoded + 1];
    let mut decoder = Decompress::new(true);
    let status = decoder
        .decompress(&active.data, &mut output, FlushDecompress::Finish)
        .map_err(|_| INVALID)?;
    if status != Status::StreamEnd
        || decoder.total_in() != active.data.len() as u64
        || decoder.total_out() != active.meta.decoded as u64
    {
        return Err(INVALID.into());
    }
    output.truncate(active.meta.decoded);
    if sha(&output) != active.meta.checksum {
        return Err(INVALID.into());
    }
    check_depth(&output)?;
    let value: Value = serde_json::from_slice(&output).map_err(|_| INVALID)?;
    if !value.is_object() || reserved(&value) || request_id(&value)? != active.meta.request {
        return Err(INVALID.into());
    }
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn vector() -> Value {
        serde_json::from_str(include_str!(
            "../../../../docs/architecture/fixtures/companion-logical-v1-vector.json"
        ))
        .unwrap()
    }
    fn collect(parts: Vec<Value>) -> Result<Value, String> {
        let mut receiver = Receiver::default();
        let mut result = None;
        for part in parts {
            if let Some(value) = receiver.ingest(part)? {
                if result.is_some() {
                    return Err("duplicate completion".into());
                }
                result = Some(value);
            }
        }
        result.ok_or_else(|| "no completion".into())
    }
    fn compressed_frames(raw: &[u8], declared: usize, compressed: Vec<u8>) -> Vec<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let total = compressed.len().div_ceil(CHUNK_BYTES);
        compressed.chunks(CHUNK_BYTES).enumerate().map(|(index,chunk)|json!({"type":"logical.part","v":1,"transferId":id,"index":index,"total":total,
            "decodedBytes":declared,"compressedBytes":compressed.len(),"sha256":sha(raw),"requestId":"","codec":"zlib","data":URL_SAFE_NO_PAD.encode(chunk)})).collect()
    }
    fn zlib(raw: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(raw).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn python_zlib_fixed_vector_assembles_only_after_all_parts_and_matches_utf8_hash() {
        let fixture = vector();
        let parts = fixture["parts"].as_array().unwrap();
        let mut receiver = Receiver::default();
        assert_eq!(parts.len(), 2);
        assert!(receiver.ingest(parts[0].clone()).unwrap().is_none());
        assert_eq!(receiver.received_compressed_bytes(), 3000);
        assert_eq!(
            receiver.total_compressed_bytes(),
            fixture["compressedBytes"].as_u64().unwrap() as usize
        );
        assert_eq!(
            receiver.progress_request_id(),
            fixture["payload"]["requestId"].as_str()
        );
        let completed = receiver.ingest(parts[1].clone()).unwrap().unwrap();
        assert_eq!(completed, fixture["payload"]);
        assert_eq!(
            sha(&bytes(&completed).unwrap()),
            fixture["sha256"].as_str().unwrap()
        );
        assert!(receiver.progress_transfer_id().is_none());
    }

    #[test]
    fn exactly_one_mib_roundtrips_and_one_extra_utf8_byte_is_rejected() {
        let overhead = bytes(&json!({"text":""})).unwrap().len();
        let exact = json!({"text":"x".repeat(MAX_LOGICAL_BYTES-overhead)});
        assert_eq!(bytes(&exact).unwrap().len(), MAX_LOGICAL_BYTES);
        assert_eq!(collect(encode(&exact).unwrap()).unwrap(), exact);
        let over = json!({"text":"x".repeat(MAX_LOGICAL_BYTES-overhead+1)});
        assert!(encode(&over).unwrap_err().contains("1 MiB"));
        let chinese = json!({"type":"response","requestId":"中文请求","result":{"text":"中文🙂完整回复".repeat(1200)}});
        assert_eq!(collect(encode(&chinese).unwrap()).unwrap(), chinese);
    }

    #[test]
    fn small_threshold_is_direct_and_sealing_timestamp_is_allowed_on_parts() {
        let overhead = bytes(&json!({"text":""})).unwrap().len();
        let small = json!({"text":"x".repeat(SMALL_BYTES-overhead)});
        assert_eq!(encode(&small).unwrap(), vec![small.clone()]);
        assert_eq!(
            Receiver::default().ingest(small.clone()).unwrap(),
            Some(small)
        );
        let mut frames = encode(&json!({"text":"x".repeat(SMALL_BYTES-overhead+1)})).unwrap();
        assert_eq!(frames[0]["type"], "logical.part");
        for frame in &mut frames {
            frame["sentAt"] = json!(1234);
            assert!(frame.to_string().len() <= MAX_PART_PLAIN);
        }
        assert!(collect(frames).is_ok());
    }

    #[test]
    fn strict_schema_canonical_chunks_and_sequence_fail_closed() {
        let fixture = vector();
        let original = fixture["parts"][0].clone();
        let mut invalid = Vec::new();
        let mut part = original.clone();
        part["extra"] = json!(true);
        invalid.push(part);
        let mut part = original.clone();
        part["v"] = json!(1.5);
        invalid.push(part);
        let mut part = original.clone();
        part["decodedBytes"] = json!(MAX_LOGICAL_BYTES + 1);
        invalid.push(part);
        let mut part = original.clone();
        part["compressedBytes"] = json!(MAX_COMPRESSED_BYTES + 1);
        invalid.push(part);
        let mut part = original.clone();
        part["total"] = json!(3);
        invalid.push(part);
        let mut part = original.clone();
        part["index"] = json!(1);
        invalid.push(part);
        let mut part = original.clone();
        part["codec"] = json!("gzip");
        invalid.push(part);
        let mut part = original.clone();
        part["requestId"] = json!("汉".repeat(43));
        invalid.push(part);
        let mut part = original.clone();
        part["data"] = json!(format!("{}=", part["data"].as_str().unwrap()));
        invalid.push(part);
        let mut part = original.clone();
        part["data"] = json!(URL_SAFE_NO_PAD.encode([0u8; 2999]));
        invalid.push(part);
        for part in invalid {
            let mut receiver = Receiver::default();
            assert!(receiver.ingest(part).is_err());
            assert!(receiver.progress_transfer_id().is_none());
        }
        let mut receiver = Receiver::default();
        receiver.ingest(original.clone()).unwrap();
        assert!(receiver.ingest(original.clone()).is_err());
        assert!(receiver.progress_transfer_id().is_none());
        let mut receiver = Receiver::default();
        receiver.ingest(original).unwrap();
        let mut mixed = fixture["parts"][1].clone();
        mixed["transferId"] = json!(uuid::Uuid::new_v4().to_string());
        assert!(receiver.ingest(mixed).is_err());
    }

    #[test]
    fn small_messages_interleave_and_cancel_only_discards_matching_active_transfer() {
        let fixture = vector();
        let first = fixture["parts"][0].clone();
        let id = first["transferId"].as_str().unwrap().to_owned();
        let mut receiver = Receiver::default();
        receiver.ingest(first).unwrap();
        let small = json!({"type":"response","requestId":"urgent","ok":true});
        assert_eq!(receiver.ingest(small.clone()).unwrap(), Some(small));
        assert_eq!(receiver.received_compressed_bytes(), 3000);
        assert!(receiver
            .ingest(json!({"type":"logical.cancel","transferId":uuid::Uuid::new_v4().to_string()}))
            .unwrap()
            .is_none());
        assert_eq!(receiver.received_compressed_bytes(), 3000);
        receiver
            .ingest(json!({"type":"logical.cancel","transferId":id,"sentAt":1234}))
            .unwrap();
        assert!(receiver.progress_transfer_id().is_none());
        assert!(receiver.ingest(fixture["parts"][1].clone()).is_err());
    }

    #[test]
    fn idle_and_total_deadlines_do_not_extend_for_unrelated_small_messages() {
        let fixture = vector();
        let first = fixture["parts"][0].clone();
        let now = Instant::now();
        let mut receiver = Receiver::default();
        receiver.ingest_at(first.clone(), now).unwrap();
        receiver
            .ingest_at(json!({"type":"response"}), now + Duration::from_secs(29))
            .unwrap();
        assert_eq!(receiver.next_deadline(), Some(now + IDLE));
        assert!(receiver
            .ingest_at(fixture["parts"][1].clone(), now + IDLE)
            .is_err());
        assert!(receiver.progress_transfer_id().is_none());
        receiver.ingest_at(first.clone(), now).unwrap();
        let mut fresh = first.clone();
        let fresh_id = uuid::Uuid::new_v4().to_string();
        fresh["transferId"] = json!(fresh_id);
        assert!(receiver.ingest_at(fresh, now + IDLE).unwrap().is_none());
        receiver.active.as_mut().unwrap().started = now;
        receiver.active.as_mut().unwrap().last = now + LIFETIME - Duration::from_secs(1);
        let mut final_part = fixture["parts"][1].clone();
        final_part["transferId"] = json!(fresh_id);
        assert!(receiver.ingest_at(final_part, now + LIFETIME).is_err());
        receiver
            .ingest_at(first, now + Duration::from_secs(1))
            .unwrap();
        assert!(receiver
            .ingest_at(fixture["parts"][1].clone(), now)
            .is_err());
        receiver.clear();
        assert!(receiver.next_deadline().is_none());
        receiver.ingest(fixture["parts"][0].clone()).unwrap();
        receiver.active.as_mut().unwrap().last = Instant::now() - IDLE;
        assert!(receiver.check_timeout().is_err());
        assert!(receiver.progress_request_id().is_none());
    }

    #[test]
    fn bounded_inflate_rejects_bombs_trailing_streams_corruption_and_wrong_hash() {
        let raw = serde_json::to_vec(&json!({"text":"z".repeat(MAX_LOGICAL_BYTES)})).unwrap();
        assert!(collect(compressed_frames(&raw, MAX_LOGICAL_BYTES, zlib(&raw))).is_err());
        let raw = br#"{"text":"valid"}"#;
        let mut trailing = zlib(raw);
        trailing.push(0);
        assert!(collect(compressed_frames(raw, raw.len(), trailing)).is_err());
        let mut concatenated = zlib(raw);
        concatenated.extend(zlib(raw));
        assert!(collect(compressed_frames(raw, raw.len(), concatenated)).is_err());
        let mut truncated = zlib(raw);
        truncated.pop();
        assert!(collect(compressed_frames(raw, raw.len(), truncated)).is_err());
        let mut corrupted = zlib(raw);
        corrupted[3] ^= 0x40;
        assert!(collect(compressed_frames(raw, raw.len(), corrupted)).is_err());
        let mut frames = compressed_frames(raw, raw.len(), zlib(raw));
        frames[0]["sha256"] = json!("0".repeat(64));
        assert!(collect(frames).is_err());
        assert!(collect(compressed_frames(b"[]", 2, zlib(b"[]"))).is_err());
        let nested = br#"{"type":"logical.part"}"#;
        assert!(collect(compressed_frames(nested, nested.len(), zlib(nested))).is_err());
    }
}
