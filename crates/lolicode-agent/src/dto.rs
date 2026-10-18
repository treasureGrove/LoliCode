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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<u64>,
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
#[serde(rename_all = "snake_case")]
pub enum AgentModelPhase {
    Waiting,
    Streaming,
    Finishing,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<AgentUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_phase: Option<AgentModelPhase>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTokenUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    /// Known inclusive prompt-token denominator; absent for ambiguous schemas.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_input_tokens: Option<u64>,
}
impl AgentTokenUsage {
    pub fn reported(&self) -> bool {
        self.input_tokens.is_some()
            || self.output_tokens.is_some()
            || self.cache_read_tokens.is_some()
            || self.cache_write_tokens.is_some()
    }
    pub fn merge(&mut self, other: &Self) {
        if other.input_tokens.is_some() {
            self.input_tokens = other.input_tokens;
        }
        if other.output_tokens.is_some() {
            self.output_tokens = other.output_tokens;
        }
        if other.cache_read_tokens.is_some() {
            self.cache_read_tokens = other.cache_read_tokens;
        }
        if other.cache_write_tokens.is_some() {
            self.cache_write_tokens = other.cache_write_tokens;
        }
        if other.cache_input_tokens.is_some() {
            self.cache_input_tokens = other.cache_input_tokens;
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageTotals {
    #[serde(flatten)]
    pub tokens: AgentTokenUsage,
    pub model_requests: u64,
    pub reported_requests: u64,
    /// Sum only requests with both input and output reported. Pending or
    /// incomplete requests do not erase already accounted usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(default)]
    pub token_reported_requests: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_hit_rate: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskUsage {
    #[serde(flatten)]
    pub totals: AgentUsageTotals,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionUsage {
    #[serde(flatten)]
    pub totals: AgentUsageTotals,
    pub since: u64,
    pub complete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentUsage {
    pub task: Option<AgentTaskUsage>,
    pub session: AgentSessionUsage,
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
