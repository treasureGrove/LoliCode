use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelRef {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub title: String,
    pub project_path: String,
    pub mode: String,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// Host-owned view metadata. The engine does not provide archive/pin writes.
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
    pub model: Option<AgentModelRef>,
    pub created_at: u64,
    pub updated_at: u64,
    /// Ephemeral list projection; snapshots remain the source of activity truth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<AgentSessionActivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionActivity {
    pub status: AgentStatus,
    #[serde(default)]
    pub title_pending: bool,
}

fn default_permission_mode() -> String {
    "custom".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub autoinvoke: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlugin {
    pub id: Option<String>,
    pub source_type: String,
    pub target: Option<String>,
    pub version: Option<String>,
    pub server: bool,
    pub tui: bool,
    pub rpc: bool,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpServer {
    pub name: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Running,
    WaitingPermission,
    WaitingQuestion,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot {
    pub session: AgentSession,
    pub status: AgentStatus,
    pub messages: Vec<AgentMessage>,
    pub permissions: Vec<AgentPermission>,
    pub questions: Vec<AgentQuestion>,
    pub diffs: Vec<AgentDiff>,
    pub error: Option<String>,
    pub stream_connected: bool,
    pub stream_gap: bool,
    /// True only while the engine is producing a context checkpoint.
    #[serde(default)]
    pub compacting: bool,
    /// Automatic title generation can outlive the main model/tool task.
    #[serde(default)]
    pub title_pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub role: String,
    pub created_at: u64,
    pub completed_at: Option<u64>,
    pub parts: Vec<AgentPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentPart {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    Tool {
        id: String,
        name: String,
        state: String,
        input: Value,
        output: Option<String>,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermission {
    pub id: String,
    pub session_id: String,
    pub action: String,
    pub resources: Vec<String>,
    pub description: Option<String>,
    pub tool_name: Option<String>,
    /// Exact native tool input; parsed permission resources alone omit shell
    /// operators and cannot be used to auto-approve a command.
    #[serde(default)]
    pub tool_input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuestion {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub fields: Vec<AgentQuestionField>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuestionField {
    pub key: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub required: bool,
    pub options: Vec<AgentQuestionOption>,
    pub custom: bool,
    #[serde(rename = "default")]
    pub default_value: Option<Value>,
    pub hidden: bool,
    pub when: Vec<Value>,
    pub format: Option<String>,
    pub placeholder: Option<String>,
    pub min_length: Option<u64>,
    pub max_length: Option<u64>,
    pub pattern: Option<String>,
    pub min_items: Option<u64>,
    pub max_items: Option<u64>,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuestionOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiff {
    pub path: String,
    pub patch: String,
    pub additions: u64,
    pub deletions: u64,
    pub status: String,
}
