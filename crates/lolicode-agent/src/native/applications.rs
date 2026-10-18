//! Host-owned domain capabilities. The engine retains approval and cancellation.
pub use super::tools::{FileChange, ToolInspection, ToolOutput};
use serde_json::Value;
use std::{future::Future, path::Path, pin::Pin};
use tokio::sync::watch;

pub type ApplicationResult<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;
pub type ApplicationOutput<'a> =
    Pin<Box<dyn Future<Output = Result<ToolOutput, String>> + Send + 'a>>;

/// Schemas only; inspecting or running local tools is deliberately not exposed.
pub fn core_tool_schemas() -> Vec<Value> {
    super::tools::schemas()
}

pub trait ApplicationTools: Send + Sync {
    fn schemas(&self) -> Vec<Value>;
    fn allows_unreal(&self) -> bool {
        false
    }
    /// Some replaces all filesystem/domain schemas for this project. A remote
    /// project must never advertise local-only tools or fall back to its anchor.
    fn project_schemas(&self, _project: &Path) -> Option<Vec<Value>> {
        None
    }
    fn project_context(&self, _project: &Path) -> Option<String> {
        None
    }
    /// None means the host does not own this tool; errors must never fall back.
    fn inspect(
        &self,
        project: &Path,
        name: &str,
        input: &Value,
    ) -> Option<Result<ToolInspection, String>>;
    fn execute<'a>(
        &'a self,
        project: &'a Path,
        name: &'a str,
        input: &'a Value,
        cancel: watch::Receiver<bool>,
    ) -> ApplicationResult<'a>;
    /// Keep snapshots and images separate from model-facing text. Existing
    /// domain adapters can continue returning plain text through execute.
    fn execute_output<'a>(
        &'a self,
        project: &'a Path,
        name: &'a str,
        input: &'a Value,
        cancel: watch::Receiver<bool>,
    ) -> ApplicationOutput<'a> {
        Box::pin(async move {
            self.execute(project, name, input, cancel)
                .await
                .map(|text| ToolOutput {
                    text,
                    image_data_url: None,
                    diffs: Vec::new(),
                    file_changes: Vec::new(),
                })
        })
    }
}
