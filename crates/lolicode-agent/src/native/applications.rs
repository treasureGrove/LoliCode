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
    /// Prepare project capabilities once after a turn is admitted, sharing its
    /// cancellation signal. Background turns never call this hook.
    fn prepare<'a>(
        &'a self,
        _project: &'a Path,
        _cancel: watch::Receiver<bool>,
    ) -> ApplicationResult<'a> {
        Box::pin(async { Ok(String::new()) })
    }
    fn schemas(&self) -> Vec<Value>;
    /// Additive host capabilities scoped to a local project. Remote filesystem
    /// replacement remains the separate project_schemas contract below.
    fn schemas_for_project(&self, _project: &Path) -> Vec<Value> {
        self.schemas()
    }
    /// Names from this host's current project catalog that are advertised only
    /// after discovery. The engine filters project/background scope first and
    /// retains discovered names per session; this never grants execution rights.
    fn deferred_tool_names(&self, _project: &Path) -> Vec<String> {
        Vec::new()
    }
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
