//! Bind Harness tools to the selected SSH/WSL project. Harness owns execution
//! scheduling and model I/O. The existing host transport owns remote access.
use super::{
    remote_agent_tools::{
        preview_path, preview_schema, relative, remote_arguments, remote_inspection, remote_output,
        remote_schemas,
    },
    remote_projects::{RemoteBinding, RemoteProjects},
};
use lolicode_agent::native::applications::{ToolInspection, ToolOutput};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::watch;

const PREFIX: &str = "mcp_remote_";
const PREVIEW: &str = "open_preview";

#[derive(Clone)]
pub(super) struct HarnessRemote {
    host: Arc<RemoteProjects>,
    project: PathBuf,
    binding: RemoteBinding,
    read_only: bool,
    pub tools: Vec<Value>,
    pub location: Value,
}

pub(super) struct RemoteCall {
    tool: String,
    path: String,
    normalized: Value,
    pub inspection: ToolInspection,
}

impl HarnessRemote {
    pub(super) fn prepare(
        host: Arc<RemoteProjects>,
        project: &Path,
        read_only: bool,
    ) -> Result<Self, String> {
        let resolved = host.resolve(project)?;
        let tools = remote_schemas()
            .into_iter()
            .chain(std::iter::once(preview_schema()))
            .map(|mut entry| {
                let name = entry["function"]["name"].as_str().unwrap_or_default().to_owned();
                entry["function"]["name"] = json!(format!("{PREFIX}{name}"));
                if name == PREVIEW {
                    entry["function"]["description"] =
                        json!("Open a raster image, text file, or static HTML file in the right sidebar. Use a relative POSIX path inside the remote workspace.");
                }
                entry
            })
            .collect();
        Ok(Self {
            host,
            project: project.to_owned(),
            binding: resolved.binding(),
            read_only,
            location: json!({"name":resolved.connection.name,"root":resolved.project.root}),
            tools,
        })
    }

    pub(super) fn inspect(&self, tool: &str, arguments: &Value) -> Result<RemoteCall, String> {
        let binding = self.host.resolve(&self.project)?;
        if binding.binding() != self.binding {
            return Err("远程连接或工作目录已变更，请重新提交工具请求".into());
        }
        let tool = tool.strip_prefix(PREFIX).ok_or("无效的远程工具")?;
        let (normalized, path, inspection) = if tool == PREVIEW {
            let path = relative(preview_path(arguments)?)?;
            let normalized = json!({"path":path});
            let mut inspection = remote_inspection(&binding, "read_file", &normalized)?;
            inspection.action = "project-preview".into();
            (normalized, path, inspection)
        } else {
            let (normalized, path) = remote_arguments(tool, arguments)?;
            let inspection = remote_inspection(&binding, tool, &normalized)?;
            (normalized, path, inspection)
        };
        if self.read_only && inspection.mutating {
            return Err("分析模式不能修改远程文件或执行远程命令".into());
        }
        Ok(RemoteCall {
            tool: tool.into(),
            path,
            normalized,
            inspection,
        })
    }

    pub(super) async fn execute(
        &self,
        call: RemoteCall,
        cancel: watch::Receiver<bool>,
    ) -> Result<(ToolOutput, Option<String>), String> {
        if call.tool == PREVIEW {
            let (path, bytes) = self
                .host
                .preview_bound(&self.project, &call.path, &self.binding, cancel)
                .await?;
            let size = bytes.len() as u64;
            crate::commands::agent_files::preview_bytes(&path, bytes, size, true)?;
            return Ok((
                ToolOutput {
                    text: format!("已为当前会话打开远程项目文件预览：{path}"),
                    image_data_url: None,
                    diffs: vec![],
                    file_changes: vec![],
                },
                Some(path),
            ));
        }
        let receipt = self
            .host
            .call_bound(
                &self.project,
                &call.tool,
                call.normalized,
                &self.binding,
                cancel,
            )
            .await?;
        remote_output(&call.tool, &call.path, receipt).map(|output| (output, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    #[tokio::test]
    async fn remote_tool_scope_checks_path_policy_and_connection_before_dispatch() {
        let profile = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::memory().unwrap());
        let (host, project) =
            super::super::remote_projects::fixture(db, profile.path().join("anchors"));
        let remote = HarnessRemote::prepare(host.clone(), &project, false).unwrap();
        assert_eq!(remote.tools.len(), 8);
        assert!(remote
            .inspect("mcp_remote_read_file", &json!({"path":"../private"}))
            .is_err());
        assert!(remote
            .inspect("mcp_remote_read_file", &json!({"path":"/absolute"}))
            .is_err());
        assert!(remote
            .inspect(
                "mcp_remote_open_preview",
                &json!({"path":"https://example.com"})
            )
            .is_err());
        let read = remote
            .inspect("mcp_remote_read_file", &json!({"path":"./probe.txt"}))
            .unwrap();
        assert_eq!(read.path, "probe.txt");
        assert!(!read.inspection.mutating);
        let args = json!({"path":"new.txt","content":"fixture","expected_content":null});
        let planned = HarnessRemote::prepare(host.clone(), &project, true).unwrap();
        assert!(planned.inspect("mcp_remote_write_file", &args).is_err());
        let write = remote.inspect("mcp_remote_write_file", &args).unwrap();
        assert!(write.inspection.mutating);
        let connection = host.resolve(&project).unwrap().connection;
        host.disconnect(&connection.id).unwrap();
        let (_stop, cancel) = watch::channel(false);
        assert!(remote.execute(write, cancel).await.is_err());
    }
}
