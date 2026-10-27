//! Synthetic text-channel interoperability probe. No AppHandle, agent or user data.
//! Credentials are accepted only from LOLICODE_TEXT_PROBE_FIXTURE, never argv/logs.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    time::Duration,
};

#[allow(dead_code)]
#[path = "../src/services/mobile_companion/crypto.rs"]
mod crypto;
#[allow(dead_code)]
#[path = "../src/services/mobile_companion/text.rs"]
mod text;
#[allow(dead_code)]
#[path = "../src/services/mobile_companion/text_projection.rs"]
mod text_projection;

// Same private parent contract used by the production text module.
#[allow(dead_code)]
struct Secret {
    desktop_token: String,
    phone_token: String,
    key: [u8; 32],
}

const EXISTING: &str = "fixture-existing-session";
const LONG_MESSAGE: &str = "fixture-msg-13";
const PROJECT: &str = "/lolicode-text-probe/registered";
const UPDATE: &str = "LOLICODE_TEXT_PROBE_UPDATE_V1";
const COMPLETE: &str = "LOLICODE_TEXT_PROBE_COMPLETE_V1";
const UPDATED_TEXT: &str = "已接收手机合成更新：中文增量与重连保持一致。";
// Repeated page metadata and reconnect snapshots are counted, not only unique text.
// The offline full-flow check separately bounds the unique corpus to 20 KiB.
const MAX_PLAIN_PER_DIRECTION: usize = 48 * 1024;
// Covers both production-internal text.ready challenges per direction.
const HANDSHAKE_RESERVE: usize = 1024;
const MAX_APPLICATION_FRAMES: usize = 96;
const MAX_TOTAL_SECONDS: u64 = 240;
const SAFE_ERROR: &str = "合成探针请求未完成；未读取或执行真实会话。";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    relay_url: String,
    room_id: String,
    key: String,
    desktop_token: String,
    device_token: String,
    account_id: Value,
    phone_device_id: String,
    run_id: String,
    receipt_path: PathBuf,
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn long_text() -> String {
    (0..36)
        .map(|i| format!("长回复第{i:02}段：这是完整中文分段验收，重连后文字与编号保持稳定。\n"))
        .collect()
}

fn description() -> Value {
    let text = long_text();
    json!({"existingSessionId":EXISTING,"longMessageId":LONG_MESSAGE,
        "longTextUtf8Sha256":digest(text.as_bytes()),"longTextUtf8Bytes":text.len(),
        "expectedUpdateText":UPDATED_TEXT,"updateMarker":UPDATE,"completeMarker":COMPLETE,
        "sessionCount":8,"initialMessageCount":14,"projectPath":PROJECT,
        "scope":"synthetic text WSS only; no native ICE, real account enrollment, AI or user tasks"})
}

fn source_hashes() -> Value {
    json!({
        "examples/companion_text_probe.rs":digest(include_bytes!("companion_text_probe.rs")),
        "src/services/mobile_companion/text.rs":digest(include_bytes!("../src/services/mobile_companion/text.rs")),
        "src/services/mobile_companion/crypto.rs":digest(include_bytes!("../src/services/mobile_companion/crypto.rs")),
        "src/services/mobile_companion/text_projection.rs":digest(include_bytes!("../src/services/mobile_companion/text_projection.rs"))
    })
}

struct Probe {
    sessions: Vec<Value>,
    messages: Vec<Value>,
    attached: BTreeSet<String>,
    // Keep mutation receipts across text epochs, with their original parameters.
    receipts: BTreeMap<String, (String, Value, Value)>,
    methods: BTreeMap<String, usize>,
    updated: bool,
    completed: bool,
    update_mutations: usize,
    duplicate_mutations: usize,
    denied_before_attach: usize,
    not_modified: usize,
    inbound_plain: usize,
    outbound_plain: usize,
    incoming_frames: usize,
    outgoing_frames: usize,
    connections: usize,
}

impl Probe {
    fn new() -> Self {
        let mut sessions = (0..7).map(|i| json!({"id":format!("fixture-session-{i}"),"title":format!("合成目录会话 {i}"),"projectPath":PROJECT})).collect::<Vec<_>>();
        sessions.push(json!({"id":EXISTING,"title":"已有桌面合成会话","projectPath":PROJECT}));
        let messages = (0..14).map(|i| {
            let body = if i == 13 { long_text() } else { format!("合成历史第{i:02}条：稳定中文文字，编号不会随重连改变。") };
            json!({"id":format!("fixture-msg-{i:02}"),"role":if i%2==0 {"user"} else {"assistant"},"parts":[{"type":"text","text":body}]})
        }).collect();
        Self {
            sessions,
            messages,
            attached: BTreeSet::new(),
            receipts: BTreeMap::new(),
            methods: BTreeMap::new(),
            updated: false,
            completed: false,
            update_mutations: 0,
            duplicate_mutations: 0,
            denied_before_attach: 0,
            not_modified: 0,
            inbound_plain: 0,
            outbound_plain: 0,
            incoming_frames: 0,
            outgoing_frames: 0,
            connections: 0,
        }
    }

    fn snapshot(&self, id: &str) -> Result<Value, String> {
        if !self.attached.contains(id) {
            return Err(SAFE_ERROR.into());
        }
        let session = self
            .sessions
            .iter()
            .find(|s| s["id"] == id)
            .ok_or(SAFE_ERROR)?;
        Ok(
            json!({"session":session,"status":"idle","messages":if id==EXISTING {self.messages.clone()} else {vec![]},
            "permissions":[],"questions":[],"diffs":[],"error":null}),
        )
    }

    fn raw(&mut self, method: &str, params: &Value, request: &str) -> Result<Value, String> {
        match method {
            "status" => Ok(json!({"hostName":"合成文本验收主机","protocol":1,"quietMode":true})),
            "projects.list" => Ok(json!([{"path":PROJECT,"name":"合成已注册项目"}])),
            "models.list" if params["projectPath"] == PROJECT => Ok(
                json!({"models":[{"id":"fixture-model-no-ai","name":"合成占位目录（不调用AI）"}]}),
            ),
            "sessions.list" => Ok(json!(self.sessions)),
            "session.attach" => {
                let id = params["sessionId"].as_str().ok_or(SAFE_ERROR)?;
                let session = self
                    .sessions
                    .iter()
                    .find(|s| s["id"] == id)
                    .ok_or(SAFE_ERROR)?
                    .clone();
                self.attached.insert(id.into());
                Ok(session)
            }
            "session.get" | "message.get" => {
                let id = params["sessionId"].as_str().ok_or(SAFE_ERROR)?;
                if !self.attached.contains(id) {
                    self.denied_before_attach += 1;
                }
                self.snapshot(id)
            }
            "message.send" => {
                let id = params["sessionId"].as_str().ok_or(SAFE_ERROR)?;
                self.snapshot(id)?;
                if id != EXISTING {
                    return Err(SAFE_ERROR.into());
                }
                match params["text"].as_str() {
                    Some(UPDATE) if !self.updated => {
                        self.messages.push(json!({"id":"fixture-update-user","role":"user","parts":[{"type":"text","text":"手机合成更新"}]}));
                        self.messages.push(json!({"id":"fixture-update-assistant","role":"assistant","parts":[{"type":"text","text":UPDATED_TEXT}]}));
                        self.updated = true;
                        self.update_mutations += 1;
                    }
                    Some(UPDATE) => return Err(SAFE_ERROR.into()),
                    Some(COMPLETE) if self.updated => self.completed = true,
                    _ => return Err(SAFE_ERROR.into()),
                }
                Ok(json!({"accepted":true,"requestId":request}))
            }
            "run.cancel" => {
                self.snapshot(params["sessionId"].as_str().ok_or(SAFE_ERROR)?)?;
                Ok(json!({"accepted":true}))
            }
            _ => Err(SAFE_ERROR.into()),
        }
    }

    fn request(&mut self, payload: &Value) -> Result<Value, String> {
        let request = payload["requestId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or(SAFE_ERROR)?;
        let method = payload["method"].as_str().ok_or(SAFE_ERROR)?;
        let params = &payload["params"];
        text_projection::validate_request(method, params)?;
        *self.methods.entry(method.into()).or_default() += 1;
        let mutation = matches!(method, "session.attach" | "message.send" | "run.cancel");
        let projected = if let Some((old_method, old_params, receipt)) = self.receipts.get(request)
        {
            if old_method != method || old_params != params {
                Err(SAFE_ERROR.into())
            } else {
                self.duplicate_mutations += 1;
                text_projection::project_receipt(method, params, receipt)
            }
        } else {
            let raw = self.raw(method, params, request);
            let outcome = text_projection::project_outcome(method, params, raw);
            if mutation {
                let receipt = match &outcome {
                    Ok(result) => json!({"ok":true,"result":result}),
                    Err(_) => json!({"ok":false}),
                };
                self.receipts
                    .insert(request.into(), (method.into(), params.clone(), receipt));
            }
            outcome
        };
        if projected
            .as_ref()
            .is_ok_and(|result| result["notModified"] == true)
        {
            self.not_modified += 1;
        }
        let response = match projected {
            Ok(result) => json!({"type":"response","requestId":request,"ok":true,"result":result}),
            Err(_) => {
                json!({"type":"response","requestId":request,"ok":false,"error":{"message":SAFE_ERROR}})
            }
        };
        if response.to_string().len() + 40 > 5500 {
            return Err("response_budget".into());
        }
        Ok(response)
    }

    async fn send(
        &mut self,
        channel: &mut text::TextChannel,
        mut payload: Value,
    ) -> Result<(), String> {
        payload["sentAt"] = json!(crypto::now());
        let bytes = serde_json::to_vec(&payload).map_err(|_| "encoding")?.len();
        if self.outbound_plain.saturating_add(bytes) > MAX_PLAIN_PER_DIRECTION - HANDSHAKE_RESERVE
            || self.incoming_frames + self.outgoing_frames >= MAX_APPLICATION_FRAMES
        {
            return Err("outbound_budget".into());
        }
        channel
            .send(payload)
            .await
            .map_err(|_| "text_send".to_string())?;
        self.outbound_plain += bytes;
        self.outgoing_frames += 1;
        Ok(())
    }

    async fn run(&mut self, fixture: &Fixture, secret: &Secret) -> Result<(), String> {
        for round in 0..2 {
            let mut channel = text::TextChannel::connect(
                &fixture.relay_url,
                &fixture.room_id,
                secret,
                &fixture.device_token,
            )
            .await
            .map_err(|_| "text_connect".to_string())?;
            self.connections += 1;
            self.send(&mut channel,json!({"type":"pair.approved","deviceId":fixture.phone_device_id,"hostName":"合成文本验收主机"})).await?;
            loop {
                let payload = match channel.recv().await {
                    Ok(Some(value)) => value,
                    Ok(None) | Err(_) => {
                        channel.close().await;
                        break;
                    }
                };
                let bytes = serde_json::to_vec(&payload).map_err(|_| "encoding")?.len();
                if self.inbound_plain.saturating_add(bytes)
                    > MAX_PLAIN_PER_DIRECTION - HANDSHAKE_RESERVE
                    || self.incoming_frames + self.outgoing_frames >= MAX_APPLICATION_FRAMES
                {
                    channel.close().await;
                    return Err("inbound_budget".into());
                }
                self.inbound_plain += bytes;
                self.incoming_frames += 1;
                if payload["type"] == "event.ack" {
                    if payload["eventId"]
                        .as_str()
                        .is_none_or(|id| id.is_empty() || id.len() > 128)
                    {
                        return Err("event_ack_schema".into());
                    }
                    continue;
                }
                if payload["type"] != "request" {
                    return Err("payload_type".into());
                }
                let response=self.request(&payload).unwrap_or_else(|_|json!({"type":"response","requestId":payload["requestId"].as_str().unwrap_or(""),"ok":false,"error":{"message":SAFE_ERROR}}));
                self.send(&mut channel, response).await?;
            }
            if round == 0 && (!self.updated || self.completed) {
                return Err("unexpected_first_disconnect".into());
            }
            if round == 1 && !self.completed {
                return Err("incomplete_second_connection".into());
            }
        }
        if self.update_mutations != 1 || self.not_modified == 0 || self.connections != 2 {
            return Err("assertions_incomplete".into());
        }
        Ok(())
    }

    fn receipt(&self, outcome: &str, elapsed_ms: u128) -> Value {
        json!({"probe":"synthetic-production-text-channel","outcome":outcome,"elapsedMs":elapsed_ms,
            "connections":self.connections,"methodCounts":self.methods,"updateMutations":self.update_mutations,
            "duplicateMutationReceipts":self.duplicate_mutations,"deniedBeforeAttach":self.denied_before_attach,"notModifiedResponses":self.not_modified,
            "applicationPlaintextBytes":{"desktopToPhone":self.outbound_plain,"phoneToDesktop":self.inbound_plain,"perDirectionTotalCap":MAX_PLAIN_PER_DIRECTION,"handshakeReservePerDirection":HANDSHAKE_RESERVE,
                "excludes":"production TextChannel internal text.ready challenge and WebSocket control frames"},
            "applicationFrames":{"sent":self.outgoing_frames,"received":self.incoming_frames},
            "fixture":description(),"compiledSourceSha256":source_hashes(),
            "limitations":["Synthetic sessions only; no AppHandle or SessionEngine","No real AI, user task, account enrollment or native ICE attempt","Use server metering for actual encrypted wire bytes"]})
    }
}

fn load_fixture() -> Result<(Fixture, Secret), String> {
    let path = std::env::var_os("LOLICODE_TEXT_PROBE_FIXTURE").ok_or("fixture_missing")?;
    if std::fs::metadata(&path).map_err(|_| "fixture_read")?.len() > 16 * 1024 {
        return Err("fixture_size".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "fixture_read")?;
    if bytes.len() > 16 * 1024 {
        return Err("fixture_size".into());
    }
    let fixture: Fixture = serde_json::from_slice(&bytes).map_err(|_| "fixture_schema")?;
    let url = url::Url::parse(&fixture.relay_url).map_err(|_| "fixture_url")?;
    if url.scheme() != "wss"
        || url.host_str() != Some("lolicode.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || fixture.room_id.len() != 32
        || !fixture
            .room_id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || fixture.desktop_token.is_empty()
        || fixture.desktop_token.len() > 4096
        || fixture.device_token.is_empty()
        || fixture.device_token.len() > 8192
        || fixture.phone_device_id.is_empty()
        || fixture.phone_device_id.len() > 128
        || fixture.run_id.is_empty()
        || fixture.run_id.len() > 128
        || !(fixture.account_id.is_string() || fixture.account_id.is_u64())
        || !fixture.receipt_path.is_absolute()
    {
        return Err("fixture_validation".into());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(&fixture.key)
        .map_err(|_| "fixture_key")?;
    if URL_SAFE_NO_PAD.encode(&decoded) != fixture.key {
        return Err("fixture_key".into());
    }
    let key = decoded.try_into().map_err(|_| "fixture_key")?;
    let secret = Secret {
        desktop_token: fixture.desktop_token.clone(),
        phone_token: String::new(),
        key,
    };
    Ok((fixture, secret))
}

fn offline_exchange(
    probe: &mut Probe,
    sequence: &mut u64,
    method: &str,
    params: Value,
    replay: Option<&str>,
) -> Result<Value, String> {
    *sequence += 1;
    let request_id = replay
        .map(str::to_owned)
        .unwrap_or_else(|| format!("00000000-0000-4000-8000-{:012}", *sequence));
    let payload = json!({"type":"request","requestId":request_id,"method":method,"params":params,"sentAt":1_700_000_000_000_u64});
    let mut response = probe.request(&payload)?;
    response["sentAt"] = json!(1_700_000_000_000_u64);
    probe.inbound_plain += serde_json::to_vec(&payload)
        .map_err(|_| "offline_encoding")?
        .len();
    probe.outbound_plain += serde_json::to_vec(&response)
        .map_err(|_| "offline_encoding")?
        .len();
    probe.incoming_frames += 1;
    probe.outgoing_frames += 1;
    if response.to_string().len() > 5500 {
        return Err("offline_frame_budget".into());
    }
    Ok(response)
}

fn offline_history(
    probe: &mut Probe,
    sequence: &mut u64,
    latest: &Value,
) -> Result<BTreeSet<String>, String> {
    let mut ids = BTreeSet::new();
    let mut page = latest.clone();
    let expected = latest["historyTotal"]
        .as_u64()
        .ok_or("offline_history_total")?;
    for _ in 0..8 {
        for message in page["messages"]
            .as_array()
            .ok_or("offline_history_messages")?
        {
            if !ids.insert(
                message["id"]
                    .as_str()
                    .ok_or("offline_history_id")?
                    .to_owned(),
            ) {
                return Err("offline_history_duplicate".into());
            }
        }
        if page["hasMore"] != true {
            if ids.len() as u64 != expected {
                return Err("offline_history_incomplete".into());
            }
            return Ok(ids);
        }
        page = offline_exchange(
            probe,
            sequence,
            "session.get",
            json!({"sessionId":EXISTING,"offset":page["nextOffset"],"limit":6}),
            None,
        )?["result"]
            .clone();
        if page["historyRevision"] != latest["historyRevision"] {
            return Err("offline_history_generation".into());
        }
    }
    Err("offline_history_limit".into())
}

fn self_test() -> Result<Value, String> {
    let mut probe = Probe::new();
    let mut sequence = 0;
    offline_exchange(&mut probe, &mut sequence, "status", json!({}), None)?;
    let first_directory = offline_exchange(
        &mut probe,
        &mut sequence,
        "sessions.list",
        json!({"offset":0,"limit":3}),
        None,
    )?;
    let mut rows = first_directory["result"]["sessions"]
        .as_array()
        .ok_or("offline_directory")?
        .clone();
    for offset in [3, 6] {
        let page = offline_exchange(
            &mut probe,
            &mut sequence,
            "sessions.list",
            json!({"offset":offset,"limit":3}),
            None,
        )?;
        if page["result"]["directoryRevision"] != first_directory["result"]["directoryRevision"] {
            return Err("offline_directory_generation".into());
        }
        rows.extend(
            page["result"]["sessions"]
                .as_array()
                .ok_or("offline_directory")?
                .clone(),
        );
    }
    if rows.len() != 8 || !rows.iter().any(|s| s["id"] == EXISTING) {
        return Err("offline_directory_complete".into());
    }
    let same_directory = offline_exchange(
        &mut probe,
        &mut sequence,
        "sessions.list",
        json!({"offset":0,"limit":3,"knownRevision":first_directory["result"]["revision"]}),
        None,
    )?;
    if same_directory["result"]["notModified"] != true {
        return Err("offline_directory_revision".into());
    }
    if offline_exchange(
        &mut probe,
        &mut sequence,
        "session.get",
        json!({"sessionId":EXISTING}),
        None,
    )?["ok"]
        != false
    {
        return Err("attach_guard".into());
    }
    offline_exchange(
        &mut probe,
        &mut sequence,
        "session.attach",
        json!({"sessionId":EXISTING}),
        None,
    )?;
    let first = offline_exchange(
        &mut probe,
        &mut sequence,
        "session.get",
        json!({"sessionId":EXISTING,"limit":6}),
        None,
    )?;
    let same = offline_exchange(
        &mut probe,
        &mut sequence,
        "session.get",
        json!({"sessionId":EXISTING,"limit":6,"knownRevision":first["result"]["revision"]}),
        None,
    )?;
    if same["result"]["notModified"] != true {
        return Err("revision".into());
    }
    let original_ids = offline_history(&mut probe, &mut sequence, &first["result"])?;
    let mut complete_text = String::new();
    let mut offset = 0;
    loop {
        let page = offline_exchange(
            &mut probe,
            &mut sequence,
            "message.get",
            json!({"sessionId":EXISTING,"messageId":LONG_MESSAGE,"offset":offset,"limit":2000}),
            None,
        )?;
        complete_text.push_str(page["result"]["text"].as_str().ok_or("message_page")?);
        if page["result"]["hasMore"] != true {
            break;
        }
        offset = page["result"]["nextOffset"]
            .as_u64()
            .ok_or("message_offset")?;
    }
    if complete_text != long_text() {
        return Err("message_complete".into());
    }
    let update = offline_exchange(
        &mut probe,
        &mut sequence,
        "message.send",
        json!({"sessionId":EXISTING,"text":UPDATE}),
        None,
    )?;
    // One extra offline-only replay check, beyond the actual Android request flow.
    offline_exchange(
        &mut probe,
        &mut sequence,
        "message.send",
        json!({"sessionId":EXISTING,"text":UPDATE}),
        update["requestId"].as_str(),
    )?;
    let changed = offline_exchange(
        &mut probe,
        &mut sequence,
        "session.get",
        json!({"sessionId":EXISTING,"limit":6}),
        None,
    )?;
    if changed["result"]["revision"] == first["result"]["revision"] {
        return Err("update_revision".into());
    }
    // The real second connection is performed only by run(); this simulates its requests.
    offline_exchange(
        &mut probe,
        &mut sequence,
        "session.attach",
        json!({"sessionId":EXISTING}),
        None,
    )?;
    let reconnected = offline_exchange(
        &mut probe,
        &mut sequence,
        "session.get",
        json!({"sessionId":EXISTING,"limit":6}),
        None,
    )?;
    let new_ids = offline_history(&mut probe, &mut sequence, &reconnected["result"])?;
    if !original_ids.is_subset(&new_ids) || new_ids.len() != 16 {
        return Err("reconnect_history".into());
    }
    offline_exchange(
        &mut probe,
        &mut sequence,
        "message.send",
        json!({"sessionId":EXISTING,"text":COMPLETE}),
        None,
    )?;
    let unique_text_bytes = probe
        .messages
        .iter()
        .flat_map(|m| m["parts"].as_array().into_iter().flatten())
        .filter_map(|p| p["text"].as_str())
        .map(str::len)
        .sum::<usize>();
    if probe.update_mutations != 1 || probe.messages.len() != 16 || unique_text_bytes > 20 * 1024 {
        return Err("mutation_or_corpus_budget".into());
    }
    if probe.outbound_plain + HANDSHAKE_RESERVE > MAX_PLAIN_PER_DIRECTION
        || probe.inbound_plain + HANDSHAKE_RESERVE > MAX_PLAIN_PER_DIRECTION
    {
        return Err("offline_total_budget".into());
    }
    Ok(
        json!({"phoneToDesktopJsonBytes":probe.inbound_plain,"desktopToPhoneJsonBytes":probe.outbound_plain,"uniqueMessageTextUtf8Bytes":unique_text_bytes,
        "jsonCapPerDirection":MAX_PLAIN_PER_DIRECTION,"handshakeReservePerDirection":HANDSHAKE_RESERVE,"applicationFrames":probe.incoming_frames+probe.outgoing_frames,
        "wouldExceedOriginal20KiBJsonCap":probe.outbound_plain+HANDSHAKE_RESERVE>20*1024,"includesOneAdditionalOfflineMutationReplayCheck":true,
        "directoryPages":3,"initialHistoryMessages":14,"reconnectedHistoryMessages":16,"longTextComplete":true,"notModifiedResponses":probe.not_modified}),
    )
}

#[tokio::main]
async fn main() {
    let option = std::env::args().skip(1).collect::<Vec<_>>();
    if option == ["--describe"] {
        println!("{}", description());
        return;
    }
    if option == ["--self-test"] {
        let result = self_test();
        let passed = result.is_ok();
        let (summary, reason) = match result {
            Ok(summary) => (summary, None),
            Err(reason) => (Value::Null, Some(reason)),
        };
        println!(
            "{}",
            json!({"offlineSelfTest":passed,"reason":reason,"fullFlow":summary,"compiledSourceSha256":source_hashes()})
        );
        if !passed {
            std::process::exit(1);
        }
        return;
    }
    if !option.is_empty() {
        eprintln!("probe_error: unknown_option");
        std::process::exit(2);
    }
    let (fixture, secret) = match load_fixture() {
        Ok(value) => value,
        Err(reason) => {
            eprintln!("probe_error: {reason}");
            std::process::exit(2);
        }
    };
    let mut probe = Probe::new();
    let started = tokio::time::Instant::now();
    let outcome = match tokio::time::timeout(
        Duration::from_secs(MAX_TOTAL_SECONDS),
        probe.run(&fixture, &secret),
    )
    .await
    {
        Ok(Ok(())) => "passed".to_owned(),
        Ok(Err(reason)) => reason,
        Err(_) => "deadline".into(),
    };
    let mut receipt = probe.receipt(&outcome, started.elapsed().as_millis());
    receipt["runId"] = json!(fixture.run_id);
    let saved = serde_json::to_vec_pretty(&receipt)
        .ok()
        .is_some_and(|bytes| std::fs::write(&fixture.receipt_path, bytes).is_ok());
    println!(
        "{}",
        json!({"probe":"synthetic-production-text-channel","outcome":outcome,"receiptSaved":saved,"connections":probe.connections,"updateMutations":probe.update_mutations})
    );
    if outcome != "passed" || !saved {
        std::process::exit(1);
    }
}
