//! Opt-in acceptance in the real desktop process. No substitute account, agent,
//! gateway or transport is constructed here; all credentials stay in native state.
#![cfg(all(debug_assertions, feature = "test-hooks"))]

use super::*;
use crate::services::lolicode_account::LolicodeAccountState;
use lolicode_agent::AgentPart;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::time::{timeout, Instant};

const MAX_SECONDS: u64 = 900;
const MAX_CONTROL: u64 = 16 * 1024;
static STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlFile {
    v: u8,
    run_id: String,
    expected_account_hash: String,
    expected_phone_device_id: String,
    expected_phone_fingerprint: String,
    metadata_path: PathBuf,
    receipt_path: PathBuf,
    stop_path: PathBuf,
    #[serde(default)]
    phase: Option<String>,
    #[serde(default)]
    preferred_project_path: Option<String>,
    #[serde(default)]
    preferred_session_id: Option<String>,
    #[serde(default)]
    task_project_path: Option<String>,
    #[serde(default)]
    expected_task_output_sha256: Option<String>,
}

fn sha(bytes: &[u8]) -> String {
    crypto::hex(&Sha256::digest(bytes))
}
fn account_hash(id: &str) -> String {
    sha(format!("lolicode-auth-status-v1|{id}").as_bytes())
}
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn ordinary_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
}
fn read_control(path: &Path) -> Result<ControlFile, &'static str> {
    if !ordinary_file(path) || fs::metadata(path).map_err(|_| "control_read")?.len() > MAX_CONTROL {
        return Err("control_file");
    }
    let bytes = fs::read(path).map_err(|_| "control_read")?;
    if bytes.len() as u64 > MAX_CONTROL {
        return Err("control_size");
    }
    serde_json::from_slice(&bytes).map_err(|_| "control_schema")
}
fn validate_control(path: &Path, control: &ControlFile) -> Result<(), &'static str> {
    if !path.is_absolute()
        || control.v != 1
        || control.run_id.is_empty()
        || control.run_id.len() > 128
        || control.run_id.chars().any(char::is_control)
        || !hex64(&control.expected_account_hash)
        || !hex64(&control.expected_phone_fingerprint)
        || uuid::Uuid::parse_str(&control.expected_phone_device_id).is_err()
        || control
            .expected_task_output_sha256
            .as_deref()
            .is_some_and(|v| !hex64(v))
    {
        return Err("control_identity");
    }
    let parent = path
        .parent()
        .ok_or("control_path")?
        .canonicalize()
        .map_err(|_| "control_path")?;
    if crate::config::get_app_config_dir()
        .canonicalize()
        .is_ok_and(|app| parent.starts_with(app))
    {
        return Err("control_inside_app_data");
    }
    let mut paths = BTreeSet::new();
    paths.insert(path.to_path_buf());
    for output in [
        &control.metadata_path,
        &control.receipt_path,
        &control.stop_path,
    ] {
        if !output.is_absolute()
            || output.file_name().is_none()
            || output.parent().and_then(|p| p.canonicalize().ok()).as_ref() != Some(&parent)
            || !paths.insert(output.clone())
            || fs::symlink_metadata(output)
                .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
        {
            return Err("control_output_path");
        }
    }
    Ok(())
}

struct Report {
    control: ControlFile,
    control_path: PathBuf,
    started: Instant,
    metadata: Value,
    approval_attempts: usize,
    rejected_other_pending: usize,
    verified_snapshot: bool,
    observed_tasks: BTreeMap<String, Value>,
}
impl Report {
    fn new(control_path: PathBuf, control: ControlFile) -> Self {
        Self {
            metadata: json!({"v":1,"runId":control.run_id,"phase":"starting","accountHash":control.expected_account_hash,
            "scope":"real desktop AppHandle and normal account/session services; no token or message body export"}),
            control,
            control_path,
            started: Instant::now(),
            approval_attempts: 0,
            rejected_other_pending: 0,
            verified_snapshot: false,
            observed_tasks: BTreeMap::new(),
        }
    }
    fn write(path: &Path, value: &Value) -> Result<(), &'static str> {
        if fs::symlink_metadata(path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
            return Err("output_path_changed");
        }
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| "output_encoding")?;
        if bytes.len() > 64 * 1024 {
            return Err("output_budget");
        }
        crate::config::atomic_write_private(path, &bytes).map_err(|_| "output_write")
    }
    fn phase(&mut self, phase: &str) -> Result<(), &'static str> {
        self.metadata["phase"] = json!(phase);
        self.metadata["elapsedMs"] = json!(self.started.elapsed().as_millis() as u64);
        Self::write(&self.control.metadata_path, &self.metadata)?;
        self.receipt(phase)
    }
    fn receipt(&self, phase: &str) -> Result<(), &'static str> {
        let receipt = json!({"v":1,"runId":self.control.run_id,"phase":phase,
            "elapsedMs":self.started.elapsed().as_millis() as u64,"accountHash":self.control.expected_account_hash,
            "approvalAttempts":self.approval_attempts,"otherPendingNotApproved":self.rejected_other_pending,
            "selectedSessionIdSha256":self.metadata["existingSessionId"].as_str().map(|s|sha(s.as_bytes())),
            "existingSnapshotVerified":self.verified_snapshot,"expectedSnapshotRevision":self.metadata["expectedSnapshotRevision"],
            "expectedExistingTextSha256":self.metadata["expectedExistingTextSha256"],
            "phoneCreatedTaskObservations":self.observed_tasks.values().collect::<Vec<_>>(),
            "realAiObserved":self.observed_tasks.values().any(|v|v["completedWithAssistantText"]==true),
            "credentialsExported":false,"messageBodiesExported":false,"syntheticResponsesUsed":false,
            "helperCreatedOrSentTask":false,"helperAttachedExistingSession":false});
        Self::write(&self.control.receipt_path, &receipt)
    }
    fn stopped(&self) -> Result<bool, &'static str> {
        if self
            .control
            .stop_path
            .try_exists()
            .map_err(|_| "stop_path")?
        {
            return Ok(true);
        }
        let current = read_control(&self.control_path)?;
        if current.run_id != self.control.run_id
            || current.expected_account_hash != self.control.expected_account_hash
            || current.expected_phone_device_id != self.control.expected_phone_device_id
            || current.expected_phone_fingerprint != self.control.expected_phone_fingerprint
            || current.metadata_path != self.control.metadata_path
            || current.receipt_path != self.control.receipt_path
            || current.stop_path != self.control.stop_path
        {
            return Err("control_changed");
        }
        Ok(matches!(
            current.phase.as_deref(),
            Some("stop" | "complete")
        ))
    }
}

fn matching_request<'a>(
    requests: &'a [Value],
    control: &ControlFile,
    account_id: &str,
) -> Option<&'a Value> {
    requests.iter().find(|r| {
        r["status"] == "pending"
            && r["accountId"] == account_id
            && r["phone"]["deviceId"] == control.expected_phone_device_id
            && r["phone"]["fingerprint"] == control.expected_phone_fingerprint
    })
}

async fn matching_room(
    mobile: &MobileCompanionState,
    control: &ControlFile,
    account_id: &str,
    desktop: &Value,
) -> Option<(String, BTreeSet<String>)> {
    mobile
        .0
        .store
        .lock()
        .await
        .rooms
        .iter()
        .filter(|(_, r)| r.approved && !r.revoked)
        .filter(|(_, r)| {
            r.account.as_ref().is_some_and(|a| {
                a.account_id == account_id
                    && a.phone_device_id == control.expected_phone_device_id
                    && a.phone_fingerprint == control.expected_phone_fingerprint
                    && desktop["deviceId"] == a.desktop_device_id
                    && desktop["fingerprint"] == a.desktop_fingerprint
            })
        })
        .max_by_key(|(_, r)| r.expires_at)
        .map(|(id, r)| (id.clone(), r.sessions.clone()))
}

fn plain_message_id(snapshot: &AgentSnapshot) -> Option<String> {
    snapshot
        .messages
        .iter()
        .rev()
        .find(|m| {
            matches!(m.role.as_str(), "user" | "assistant")
                && !m.parts.is_empty()
                && m.parts.iter().all(|p| matches!(p, AgentPart::Text { .. }))
                && m.parts
                    .iter()
                    .filter_map(|p| {
                        if let AgentPart::Text { text } = p {
                            Some(text.len())
                        } else {
                            None
                        }
                    })
                    .sum::<usize>()
                    <= 16 * 1024
                && m.parts
                    .iter()
                    .any(|p| matches!(p,AgentPart::Text{text} if !text.trim().is_empty()))
        })
        .map(|m| m.id.clone())
}

async fn select_existing(
    app: &AppHandle,
    mobile: &MobileCompanionState,
    room: &str,
    control: &ControlFile,
) -> Result<Option<AgentSession>, &'static str> {
    let candidates = mobile
        .visible_sessions(app, room)
        .await
        .map_err(|_| "visible_sessions")?;
    for session in candidates {
        if control
            .preferred_project_path
            .as_deref()
            .is_some_and(|p| session.project_path != p)
            || control
                .preferred_session_id
                .as_deref()
                .is_some_and(|id| session.id != id)
            || session
                .activity
                .as_ref()
                .is_some_and(|a| a.status != AgentStatus::Idle)
        {
            continue;
        }
        let Ok(snapshot) = agent_dispatch::get_agent_session(app.clone(), session.id.clone()).await
        else {
            continue;
        };
        if snapshot.status == AgentStatus::Idle
            && !snapshot.title_pending
            && plain_message_id(&snapshot).is_some()
        {
            return Ok(Some(session));
        }
    }
    Ok(None)
}

fn selected_proof(snapshot: &AgentSnapshot, transport: &str) -> Result<Value, &'static str> {
    if snapshot.status != AgentStatus::Idle || snapshot.title_pending {
        return Err("selected_session_not_idle");
    }
    let message_id = plain_message_id(snapshot).ok_or("selected_session_no_text")?;
    let snapshot_value = serde_json::to_value(snapshot).map_err(|_| "snapshot_encoding")?;
    let params = json!({"sessionId":snapshot.session.id,"limit":6});
    let projected = match transport {
        "text" => text_projection::project("session.get", &params, snapshot_value.clone()),
        "direct" => text_projection::direct_snapshot_page(&params, &snapshot_value),
        _ => return Err("snapshot_transport"),
    }
    .map_err(|_| "snapshot_projection")?;
    let mut text = String::new();
    let mut offset = 0;
    loop {
        let page=text_projection::message_page(&json!({"sessionId":snapshot.session.id,"messageId":message_id,"offset":offset,"limit":2500}),&snapshot_value).map_err(|_|"message_projection")?;
        text.push_str(page["text"].as_str().ok_or("message_text")?);
        if text.len() > 20 * 1024 {
            return Err("message_budget");
        }
        if page["hasMore"] != true {
            break;
        }
        offset = page["nextOffset"].as_u64().ok_or("message_offset")?;
    }
    Ok(
        json!({"existingMessageId":message_id,"expectedExistingTextSha256":sha(text.as_bytes()),"existingTextUtf8Bytes":text.len(),
        "expectedSnapshotRevision":projected["revision"],"snapshotParams":{"limit":6},"snapshotTransport":transport,
        "existingVisibleTextMessageCount":snapshot.messages.iter().filter(|m|matches!(m.role.as_str(),"user"|"assistant")).count()}),
    )
}

async fn model_id(app: &AppHandle, session: &AgentSession) -> Option<(String, bool)> {
    let catalog = app
        .state::<InprocessAgentState>()
        .catalog(app.state::<AppState>().inner())
        .await
        .ok()?;
    if let Some(model) = &session.model {
        if let Some(found) = catalog
            .models
            .iter()
            .find(|m| m.provider_id == model.provider_id && m.model_id == model.model_id)
        {
            return Some((found.id.clone(), true));
        }
    }
    catalog
        .default_model
        .and_then(|id| {
            catalog
                .models
                .iter()
                .find(|m| m.id == id)
                .map(|m| (m.id.clone(), false))
        })
        .or_else(|| catalog.models.first().map(|m| (m.id.clone(), false)))
}

fn task_observation(snapshot: &AgentSnapshot, expected: Option<&str>) -> Value {
    let assistant = snapshot
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "assistant")
        .map(|m| {
            m.parts
                .iter()
                .filter_map(|p| {
                    if let AgentPart::Text { text } = p {
                        Some(text.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let assistant_hash = if assistant.is_empty() {
        None
    } else {
        Some(sha(assistant.as_bytes()))
    };
    let status = serde_json::to_value(&snapshot.status).unwrap_or(Value::Null);
    json!({"sessionIdSha256":sha(snapshot.session.id.as_bytes()),"status":status,"messageCount":snapshot.messages.len(),
        "assistantTextMessageCount":snapshot.messages.iter().filter(|m|m.role=="assistant"&&m.parts.iter().any(|p|matches!(p,AgentPart::Text{text}if !text.is_empty()))).count(),
        "latestAssistantTextSha256":assistant_hash,"expectedOutputHashMatches":expected.map(|hash|assistant_hash.as_deref()==Some(hash)),
        "completedWithAssistantText":snapshot.status==AgentStatus::Idle&&!assistant.is_empty(),
        "pendingPermissions":snapshot.permissions.len(),"pendingQuestions":snapshot.questions.len(),"diffCount":snapshot.diffs.len(),
        "toolPartCount":snapshot.messages.iter().flat_map(|m|m.parts.iter()).filter(|p|matches!(p,AgentPart::Tool{..})).count()})
}

async fn run(app: &AppHandle, report: &mut Report) -> Result<(), &'static str> {
    let mobile = app.state::<MobileCompanionState>();
    let account = app.state::<LolicodeAccountState>();
    let mut verified_id = None::<String>;
    let mut connect_attempted = false;
    let mut approval_attempted = false;
    let mut tracked_room = None::<String>;
    let mut baseline_phone_sessions = BTreeSet::new();
    let mut selected = None::<AgentSession>;
    loop {
        if report.stopped()? {
            report.phase("stopped")?;
            return Ok(());
        }
        let login = account.status(verified_id.is_none()).await;
        let Some(identity) = login.account else {
            report.phase("desktop_login_required")?;
            tokio::time::sleep(Duration::from_secs(3)).await;
            continue;
        };
        if account_hash(&identity.id) != report.control.expected_account_hash {
            return Err("desktop_account_mismatch");
        }
        if verified_id.as_ref().is_some_and(|id| id != &identity.id) {
            return Err("desktop_account_changed");
        }
        verified_id = Some(identity.id.clone());
        report.metadata["desktopAccountVerified"] = json!(true);
        if !connect_attempted {
            connect_attempted = true;
            if mobile.connect_account(app, None).await.is_err() {
                report.phase("desktop_connect_pending")?;
            }
        }
        let status = mobile.account_visible(true).await;
        let status = serde_json::to_value(status).map_err(|_| "account_status_encoding")?;
        if status["accountId"] != identity.id
            || !status["signedIn"].as_bool().unwrap_or(false)
            || !status["device"].is_object()
        {
            report.phase("desktop_connect_pending")?;
            tokio::time::sleep(Duration::from_secs(3)).await;
            continue;
        }
        let desktop = &status["device"];
        report.metadata["desktopDeviceId"] = desktop["deviceId"].clone();
        report.metadata["desktopFingerprint"] = desktop["fingerprint"].clone();
        if let Some(path) = &report.control.task_project_path {
            if mobile.check_project(app, path).is_err() {
                report.phase("task_project_not_registered")?;
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
            report.metadata["taskProjectPath"] = json!(path);
        }
        let requests = status["requests"].as_array().cloned().unwrap_or_default();
        let matched = matching_request(&requests, &report.control, &identity.id).cloned();
        report.rejected_other_pending = requests
            .iter()
            .filter(|r| r["status"] == "pending")
            .count()
            .saturating_sub(usize::from(matched.is_some()));
        if !approval_attempted {
            if let Some(request) = matched {
                let request_id = request["requestId"].as_str().ok_or("pending_request_id")?;
                approval_attempted = true;
                report.approval_attempts += 1;
                report.phase("approving_pinned_phone")?;
                // Mark attempted first: an uncertain HTTP response is recovered
                // by the normal account worker, never by replaying approval.
                if mobile
                    .approve_account_request(
                        app,
                        request_id,
                        &report.control.expected_phone_fingerprint,
                    )
                    .await
                    .is_err()
                {
                    report.phase("approval_awaiting_recovery")?;
                }
            }
        }
        if tracked_room.is_none() {
            if let Some((room, sessions)) =
                matching_room(&mobile, &report.control, &identity.id, desktop).await
            {
                tracked_room = Some(room);
                baseline_phone_sessions = sessions;
                report.metadata["phoneApproved"] = json!(true);
            } else {
                report.phase(if approval_attempted {
                    "approval_awaiting_recovery"
                } else {
                    "awaiting_phone_request"
                })?;
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        }
        let room = tracked_room.as_deref().ok_or("room_missing")?;
        if !mobile.room_enabled(room).await {
            return Err("approved_room_unavailable");
        }
        if selected.is_none() {
            selected = select_existing(app, &mobile, room, &report.control).await?;
            let Some(session) = &selected else {
                report.phase("no_existing_session")?;
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            };
            report.metadata["existingSessionId"] = json!(session.id);
            report.metadata["projectPath"] = json!(session.project_path);
            if let Some((model, matches_existing)) = model_id(app, session).await {
                report.metadata["existingModelId"] = json!(model);
                report.metadata["modelMatchesExistingSession"] = json!(matches_existing);
            }
            report.phase("session_selected")?;
        }
        let session = selected.as_ref().ok_or("selection_missing")?;
        let attached = {
            let store = mobile.0.store.lock().await;
            store.rooms.get(room).is_some_and(|r| {
                r.shared_sessions.contains(&session.id) || r.sessions.contains(&session.id)
            })
        };
        if !attached {
            report.phase("session_selected")?;
        } else if !report.verified_snapshot {
            let transport = mobile
                .0
                .connections
                .lock()
                .await
                .get(room)
                .and_then(|c| c.transport);
            let Some(transport) = transport.filter(|mode| matches!(*mode, "text" | "direct"))
            else {
                report.phase("waiting_session_transport")?;
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            };
            let snapshot = mobile
                .owned_snapshot(app, room, &session.id)
                .await
                .map_err(|_| "owned_snapshot")?;
            let proof = selected_proof(&snapshot, transport)?;
            for (key, value) in proof.as_object().ok_or("proof_encoding")? {
                report.metadata[key] = value.clone();
            }
            report.verified_snapshot = true;
            report.phase("session_verified")?;
        }
        if report.verified_snapshot {
            let new_ids = {
                let store = mobile.0.store.lock().await;
                store
                    .rooms
                    .get(room)
                    .map(|r| {
                        r.sessions
                            .difference(&baseline_phone_sessions)
                            .take(4)
                            .cloned()
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            };
            for id in new_ids {
                let snapshot = mobile
                    .owned_snapshot(app, room, &id)
                    .await
                    .map_err(|_| "new_phone_snapshot")?;
                if report
                    .control
                    .task_project_path
                    .as_deref()
                    .is_some_and(|path| snapshot.session.project_path != path)
                {
                    continue;
                }
                report.observed_tasks.insert(
                    sha(id.as_bytes()),
                    task_observation(
                        &snapshot,
                        report.control.expected_task_output_sha256.as_deref(),
                    ),
                );
            }
            if report
                .observed_tasks
                .values()
                .any(|v| v["completedWithAssistantText"] == true)
            {
                report.phase("real_ai_observed")?;
            } else {
                report.receipt("session_verified")?;
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// Called only after normal startup has installed every real application state.
/// With no explicit local control path, this feature has no effect.
pub(super) fn start_real_acceptance(app: AppHandle) {
    let Some(path) = std::env::var_os("LOLICODE_REAL_ACCEPTANCE_CONTROL").map(PathBuf::from) else {
        return;
    };
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let control = match read_control(&path).and_then(|c| {
        validate_control(&path, &c)?;
        Ok(c)
    }) {
        Ok(control) => control,
        Err(_) => {
            log::warn!("Real acceptance control is invalid; no acceptance action started");
            return;
        }
    };
    tauri::async_runtime::spawn(async move {
        let mut report = Report::new(path, control);
        if report.phase("starting").is_err() {
            return;
        }
        let result = timeout(Duration::from_secs(MAX_SECONDS), run(&app, &mut report)).await;
        let phase = match result {
            Ok(Ok(())) => "stopped",
            Ok(Err(reason)) => reason,
            Err(_) => "deadline",
        };
        let _ = report.phase(phase);
        // Restore ordinary background polling, preserving the approved account,
        // real sessions, connection and user settings. Never disconnect/revoke.
        app.state::<MobileCompanionState>()
            .account_visible(false)
            .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_hash_is_domain_separated_and_only_exact_pending_phone_can_be_approved() {
        let control = ControlFile {
            v: 1,
            run_id: "test".into(),
            expected_account_hash: account_hash("7"),
            expected_phone_device_id: uuid::Uuid::new_v4().to_string(),
            expected_phone_fingerprint: "a".repeat(64),
            metadata_path: PathBuf::new(),
            receipt_path: PathBuf::new(),
            stop_path: PathBuf::new(),
            phase: None,
            preferred_project_path: None,
            preferred_session_id: None,
            task_project_path: None,
            expected_task_output_sha256: None,
        };
        assert_ne!(account_hash("7"), sha(b"7"));
        let good = json!({"status":"pending","accountId":"7","phone":{"deviceId":control.expected_phone_device_id,"fingerprint":control.expected_phone_fingerprint}});
        assert!(matching_request(&[good.clone()], &control, "7").is_some());
        for (field, value) in [("status", json!("approved")), ("accountId", json!("8"))] {
            let mut bad = good.clone();
            bad[field] = value;
            assert!(matching_request(&[bad], &control, "7").is_none());
        }
        let mut bad = good.clone();
        bad["phone"]["deviceId"] = json!(uuid::Uuid::new_v4().to_string());
        assert!(matching_request(&[bad], &control, "7").is_none());
        let mut bad = good;
        bad["phone"]["fingerprint"] = json!("b".repeat(64));
        assert!(matching_request(&[bad], &control, "7").is_none());
    }
}
