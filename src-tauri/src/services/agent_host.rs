//! Engine-independent desktop contracts and channel preparation.
//! Native execution must not depend on an OpenCode profile or Node service.
use super::channel_center::{self, AgentCatalog, AgentGatewayBinding};
use crate::store::AppState;
use lolicode_agent::AgentSession;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspace {
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeStatus {
    pub available: bool,
    pub version: Option<String>,
    pub running: bool,
    pub project_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenProject {
    pub workspace: AgentWorkspace,
    pub catalog: AgentCatalog,
    pub sessions: Vec<AgentSession>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

pub(crate) fn canonical_project(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("请选择一个项目文件夹".into());
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| "项目文件夹不存在或无法访问")?;
    if !canonical.is_dir() {
        return Err("请选择文件夹，不能选择单个文件".into());
    }
    #[cfg(windows)]
    {
        let text = canonical.to_string_lossy();
        if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
            return Ok(PathBuf::from(format!("\\\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix("\\\\?\\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(canonical)
}

#[cfg(any(test, feature = "test-hooks"))]
pub(crate) fn workspace(path: &Path) -> AgentWorkspace {
    AgentWorkspace {
        name: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("项目")
            .to_string(),
        path: path.to_string_lossy().into_owned(),
    }
}

fn validate_accounts(state: &AppState, accounts: &[(String, String)]) -> Result<(), String> {
    let draft =
        channel_center::agent_source_snapshot(state.db.as_ref()).map_err(|e| e.to_string())?;
    channel_center::validate_managed_account_references(&draft, accounts).map_err(|e| e.to_string())
}

fn validate_revision(
    state: &AppState,
    revision: u64,
    accounts: &[(String, String)],
) -> Result<(), String> {
    let pinned =
        channel_center::load_catalog(state.db.as_ref(), revision).map_err(|e| e.to_string())?;
    channel_center::validate_managed_account_references(&pinned, accounts)
        .map_err(|e| e.to_string())
}

pub(crate) async fn prepare_native_binding(
    state: &AppState,
    accounts: &[(String, String)],
) -> Result<AgentGatewayBinding, String> {
    validate_accounts(state, accounts)?;
    let prepared = channel_center::prepare_inprocess_agent_binding(state)
        .await
        .map_err(|e| e.to_string())?;
    validate_revision(state, prepared.catalog.revision, accounts)?;
    Ok(prepared)
}

/// Compatibility preparation for the old engine only.
#[cfg(any(test, feature = "test-hooks"))]
pub(crate) async fn prepare_catalog_for_accounts(
    state: &AppState,
    accounts: &[(String, String)],
) -> Result<channel_center::PreparedAgentCatalog, String> {
    validate_accounts(state, accounts)?;
    let prepared = channel_center::prepare_agent_catalog(state)
        .await
        .map_err(|e| e.to_string())?;
    validate_revision(state, prepared.catalog.revision, accounts)?;
    Ok(prepared)
}
