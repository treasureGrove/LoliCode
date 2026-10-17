//! Host-owned domain capabilities. The engine retains approval and cancellation.
pub use super::tools::ToolInspection;
use serde_json::Value;
use std::{future::Future, path::Path, pin::Pin};
use tokio::sync::watch;

pub type ApplicationResult<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

pub trait ApplicationTools: Send + Sync {
    fn schemas(&self) -> Vec<Value>;
    fn allows_unreal(&self) -> bool {
        false
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
}
