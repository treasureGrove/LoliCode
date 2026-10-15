use crate::AgentSnapshot;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

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
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredSession {
    pub format: u32,
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
