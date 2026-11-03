use crate::{AgentSnapshot, AgentSecretaryTask};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// A short-lived host gateway lease, never an upstream account credential.
/// Deliberately neither Debug nor Serialize.
#[derive(Clone)]
pub struct NativeGateway {
    pub base_url: String,
    pub bearer_token: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommandRecord {
    pub text: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct QueuedMessageInput {
    pub request_id: String,
    pub text: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(default)]
    pub background_only: bool,
    #[serde(default)]
    pub attachments: Vec<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AutomationSaveReceipt {
    pub tool_call_id: String,
    pub message_id: String,
    pub automation_id: String,
    pub proposal_fingerprint: String,
    pub title: String,
    pub saved_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredSession {
    pub format: u32,
    /// Permanent boundary for phone-created sessions. A phone continuation of a
    /// desktop session uses a stricter in-memory Flight instead of changing this.
    #[serde(default)]
    pub background_only: bool,
    pub snapshot: AgentSnapshot,
    pub history: Vec<Value>,
    pub commands: BTreeMap<String, CommandRecord>,
    #[serde(default)]
    pub file_changes: BTreeMap<String, FileState>,
    #[serde(default)]
    pub title_state: TitleState,
    #[serde(default)]
    pub context_summary: Option<String>,
    #[serde(default)]
    pub compaction_count: u64,
    #[serde(default)]
    pub response_locale: Option<String>,
    #[serde(default)]
    pub usage_ledger: Option<super::usage::Ledger>,
    /// Session-local discovery survives history compaction and restart. Names
    /// are intersected with the live scoped host catalog before every request.
    #[serde(default)]
    pub discovered_tools: BTreeSet<String>,
    /// Full queued inputs are private; snapshots contain attachment metadata only.
    #[serde(default)]
    pub queued_inputs: Vec<QueuedMessageInput>,
    /// Bounded receipts make withdrawal recoverable if the IPC reply is lost.
    #[serde(default)]
    pub withdrawn_queue_inputs: Vec<QueuedMessageInput>,
    /// Confirmed only through the trusted desktop save-receipt RPC, never a
    /// model tool. Kept separately so concurrent compaction cannot erase facts.
    #[serde(default)]
    pub automation_save_receipts: Vec<AutomationSaveReceipt>,
    /// The secretary owns its durable task registry and report outbox. Worker
    /// links are stored on AgentSession and never grant additional authority.
    #[serde(default)]
    pub secretary_tasks: Vec<AgentSecretaryTask>,
    #[serde(default)]
    pub secretary_reports: Vec<SecretaryReport>,
    #[serde(default)]
    pub secretary_cancel_requested: bool,
    /// Host-preserved original user authorization for a model-routed task.
    /// Routing instructions cannot replace this source or expand its scope.
    #[serde(default)]
    pub secretary_origin: Option<SecretaryOrigin>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct SecretaryOrigin {
    pub session_id: String,
    pub request_id: String,
    pub text: String,
    pub images_forwarded: usize,
    pub other_attachments: Vec<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SecretaryReport {
    pub request_id: String,
    pub text: String,
    #[serde(default)]
    pub public_text: String,
    #[serde(default)]
    pub delivered: bool,
    #[serde(default)]
    pub withdrawn: bool,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum TitleState {
    #[default]
    Legacy,
    Pending,
    Generated,
    Manual,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct FileState {
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Grant {
    pub project: String,
    pub action: String,
    pub resources: Vec<String>,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
pub(super) struct Skill {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub content: String,
}

#[derive(Clone, Default, PartialEq, Eq)]
pub(super) struct Skills {
    pub revision: u64,
    pub items: Vec<Skill>,
}
