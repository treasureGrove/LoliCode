//! Exchange portable conversation archives without copying runtime credentials
//! or touching the other profile's live Harness process.
use super::{
    agent_preferences::path_key,
    harness_desktop::HarnessDesktop,
    harness_migration::HarnessMigration,
    harness_sessions::{encode, SessionStore},
};
use lolicode_agent::{AgentPart, AgentSession, AgentSnapshot, AgentStatus};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    imported: usize,
    exported: usize,
    duplicates: usize,
    conflicts: usize,
    skipped_busy: usize,
    skipped_unsupported: usize,
    local_sessions: Vec<AgentSession>,
    peer_sessions: Vec<AgentSession>,
    warnings: Vec<String>,
}

pub(super) async fn exchange(
    current: &SessionStore,
    harness: &HarnessDesktop,
    local: &Path,
    peer: &Path,
    direction: &str,
) -> Result<Value, String> {
    if !matches!(direction, "both" | "import" | "export")
        || !peer.is_absolute()
        || local.canonicalize().ok() == peer.canonicalize().ok()
    {
        return Err("会话同步来源、目标或方向无效".into());
    }
    let local_archive = HarnessMigration::new(local)?;
    let peer_archive = HarnessMigration::new(peer)?;
    let peer_store = SessionStore::load(peer)?;
    let local_sessions = current.list(None, true);
    let peer_sessions = peer_store.list(None, true);
    let mut report = Report::default();
    if direction != "export" {
        for session in &peer_sessions {
            if let Some(snapshot) = super::harness_desktop::sync_snapshot(peer, &session.id)? {
                if !matches!(snapshot.status, AgentStatus::Idle | AgentStatus::Error) {
                    report.skipped_busy += 1;
                    continue;
                }
                if !snapshot.queued_messages.is_empty() {
                    report.skipped_unsupported += 1;
                    continue;
                }
                let bytes = archive(snapshot, session)?;
                publish(
                    &local_archive,
                    current,
                    session,
                    local,
                    peer,
                    &bytes,
                    true,
                    &mut report,
                )?;
            } else if let Some(bytes) = peer_archive.legacy_bytes(&session.id)? {
                let old = peer_archive.read_legacy(&session.id)?;
                let status = old.snapshot().status.clone();
                if !matches!(status, AgentStatus::Idle | AgentStatus::Error) {
                    report.skipped_busy += 1;
                    continue;
                }
                publish(
                    &local_archive,
                    current,
                    session,
                    local,
                    peer,
                    &bytes,
                    true,
                    &mut report,
                )?;
            } else {
                report.skipped_unsupported += 1;
            }
        }
    }
    if direction != "import" {
        for session in &local_sessions {
            let projected = harness.root_snapshot(&session.id).await?;
            if projected.as_ref().is_some_and(|value| {
                !matches!(value.status, AgentStatus::Idle | AgentStatus::Error)
            }) {
                report.skipped_busy += 1;
                continue;
            }
            if let Some(snapshot) = projected {
                if !snapshot.queued_messages.is_empty() {
                    report.skipped_unsupported += 1;
                    continue;
                }
                let bytes = archive(snapshot, session)?;
                publish(
                    &peer_archive,
                    &peer_store,
                    session,
                    peer,
                    local,
                    &bytes,
                    false,
                    &mut report,
                )?;
            } else if let Some(bytes) = local_archive.legacy_bytes(&session.id)? {
                publish(
                    &peer_archive,
                    &peer_store,
                    session,
                    peer,
                    local,
                    &bytes,
                    false,
                    &mut report,
                )?;
            } else {
                report.skipped_unsupported += 1;
            }
        }
    }
    if report.skipped_unsupported > 0 {
        report
            .warnings
            .push("已跳过远程、独立、秘书、排队或没有可交换归档的会话".into());
    }
    encode(report)
}

fn archive(mut snapshot: AgentSnapshot, session: &AgentSession) -> Result<Vec<u8>, String> {
    snapshot.session = session.clone();
    snapshot.session.activity = None;
    snapshot.preview = None;
    let history: Vec<_> = snapshot
        .messages
        .iter()
        .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
        .filter_map(|message| {
            let text = message
                .parts
                .iter()
                .filter_map(|part| match part {
                    AgentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then(|| json!({"role": message.role, "content": text}))
        })
        .collect();
    serde_json::to_vec(&json!({"format":1,"snapshot":snapshot,"history":history,"commands":{}}))
        .map_err(|_| "无法编码会话归档".into())
}

#[expect(
    clippy::too_many_arguments,
    reason = "Publishing validates both profiles and reports the result against the shared target stores"
)]
fn publish(
    target: &HarnessMigration,
    target_store: &SessionStore,
    session: &AgentSession,
    target_profile: &Path,
    source_profile: &Path,
    bytes: &[u8],
    importing: bool,
    report: &mut Report,
) -> Result<(), String> {
    let project = path_key(&session.project_path);
    let profile_owned = [target_profile, source_profile].iter().any(|profile| {
        let agent = path_key(&profile.join("agent").to_string_lossy());
        project.starts_with(&(agent.clone() + "/")) || project.starts_with(&(agent + "\\"))
    });
    if session.coordination.is_some()
        || profile_owned
        || !Path::new(&session.project_path).is_absolute()
    {
        report.skipped_unsupported += 1;
        return Ok(());
    }
    let existing = target.legacy_bytes(&session.id)?;
    let transferred = if existing.as_deref() == Some(bytes) {
        report.duplicates += 1;
        true
    } else if existing.is_some()
        || target_store.contains(&session.id)
        || !target.publish_legacy_archive(&session.id, bytes)?
    {
        report.conflicts += 1;
        false
    } else {
        if importing {
            report.imported += 1;
        } else {
            report.exported += 1;
        }
        true
    };
    if transferred {
        if importing {
            report.local_sessions.push(session.clone());
        } else {
            report.peer_sessions.push(session.clone());
        }
    }
    Ok(())
}
