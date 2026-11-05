//! Reuse the configured desktop MCP connections without exposing their
//! credentials or connection setup to the Harness process or transcript.
use super::{
    harness_remote::{HarnessRemote, RemoteCall},
    harness_runtime::HarnessClient,
    native_mcp::NativeMcpTools,
    remote_agent_tools::preview_path,
    remote_projects::RemoteProjects,
};
use lolicode_agent::{
    native::{
        applications::{ApplicationTools, ToolInspection, ToolOutput},
        memory,
    },
    AgentPreviewTarget,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::watch;

pub(super) const CALL_METHOD: &str = "lolicode/mcp/approve-and-call";

#[derive(Clone)]
pub(super) struct HarnessMcp {
    host: ToolHost,
    project: PathBuf,
}

#[derive(Clone)]
enum ToolHost {
    Local(LocalTools),
    Remote(HarnessRemote),
}

#[derive(Clone)]
struct LocalTools {
    mcp: Option<Arc<NativeMcpTools>>,
    applications: Arc<dyn ApplicationTools>,
    mcp_schemas: Vec<Value>,
    application_schemas: Vec<Value>,
    read_only: bool,
    memory_root: Option<PathBuf>,
}

enum CallBinding {
    Mcp(String),
    Application(ToolInspection),
    Remote(RemoteCall),
    Memory {
        binding: memory::DesktopToolBinding,
        source: String,
    },
}

pub(super) struct McpCall {
    pub tool: String,
    pub arguments: Value,
    pub description: String,
    pub resources: Vec<String>,
    pub requires_approval: bool,
    binding: CallBinding,
}

pub(super) struct ToolReply {
    pub payload: Value,
    pub preview: Option<AgentPreviewTarget>,
    pub closed_browser: Option<String>,
}

impl HarnessMcp {
    pub(super) async fn prepare_local(
        mcp: Option<Arc<NativeMcpTools>>,
        applications: Arc<dyn ApplicationTools>,
        project: &Path,
        read_only: bool,
        memory_root: Option<PathBuf>,
    ) -> Self {
        let mcp_schemas = if let Some(host) = &mcp {
            let (_lifetime, cancel) = watch::channel(false);
            // Discovery is optional; a misconfigured or slow server must not
            // prevent an ordinary Agent turn from starting.
            let _ =
                tokio::time::timeout(Duration::from_secs(4), host.prepare(project, cancel)).await;
            host.schemas_for_project(project)
        } else {
            Vec::new()
        };
        let mut application_schemas = applications.schemas();
        let memory_root = match memory_root {
            Some(root) if memory::desktop_tool_enabled(&root).await.unwrap_or(false) => {
                application_schemas.push(memory::schema());
                Some(root)
            }
            _ => None,
        };
        Self {
            host: ToolHost::Local(LocalTools {
                mcp,
                applications,
                mcp_schemas,
                application_schemas,
                read_only,
                memory_root,
            }),
            project: project.to_owned(),
        }
    }

    pub(super) fn prepare_remote(
        host: Arc<RemoteProjects>,
        project: &Path,
        read_only: bool,
    ) -> Result<Self, String> {
        let remote = HarnessRemote::prepare(host, project, read_only)?;
        Ok(Self {
            host: ToolHost::Remote(remote),
            project: project.to_owned(),
        })
    }

    pub(super) async fn configure(
        &self,
        client: &HarnessClient,
        session_id: &str,
    ) -> Result<(), String> {
        match &self.host {
            ToolHost::Remote(remote) => {
                let result = client
                    .request(
                        "lolicode/session/configure-remote",
                        json!({"sessionId":session_id,"tools":remote.tools,"location":remote.location}),
                    )
                    .await?;
                if result["registered"].as_u64() != Some(remote.tools.len() as u64) {
                    return Err("Harness 未能加载全部远程工作区工具".into());
                }
            }
            ToolHost::Local(local) => {
                if !local.application_schemas.is_empty() {
                    let result = client
                        .request(
                            "lolicode/session/configure-tools",
                            json!({"sessionId":session_id,"tools":local.application_schemas}),
                        )
                        .await?;
                    if result["registered"].as_u64() != Some(local.application_schemas.len() as u64)
                    {
                        return Err("Harness 未能加载全部 LoliCode 工具".into());
                    }
                }
                if !local.mcp_schemas.is_empty() {
                    if client
                        .request(
                            "lolicode/session/configure-mcp",
                            json!({"sessionId":session_id,"tools":local.mcp_schemas}),
                        )
                        .await
                        .is_err()
                    {
                        log::warn!("本轮未加载 MCP 工具");
                    }
                }
            }
        }
        Ok(())
    }

    pub(super) async fn inspect(&self, request: &Value) -> Result<McpCall, String> {
        let tool = request["toolName"].as_str().ok_or("工具名称无效")?;
        let arguments = request["arguments"].as_object().ok_or("工具参数无效")?;
        let arguments = Value::Object(arguments.clone());
        let planning = request["workspacePolicy"] == "plan";
        let (description, resources, requires_approval, binding) = match &self.host {
            ToolHost::Local(local) if tool == "memory" => {
                let root = local
                    .memory_root
                    .as_deref()
                    .ok_or("当前会话未开启记忆工具")?;
                let source = request["sessionId"].as_str().ok_or("会话标识无效")?;
                let binding =
                    memory::desktop_inspect_tool(root, &self.memory_project(), &arguments).await?;
                let inspection = &binding.inspection;
                let policy = request["workspacePolicy"].as_str();
                if inspection.mutating && (local.read_only || policy == Some("plan")) {
                    return Err("分析模式不能修改跨会话记忆".into());
                }
                (
                    inspection.description.clone(),
                    inspection.resources.clone(),
                    inspection.requires_approval
                        || (inspection.mutating && policy != Some("workspace")),
                    CallBinding::Memory {
                        binding,
                        source: format!("lc:{source}"),
                    },
                )
            }
            ToolHost::Local(local) if has_tool(&local.mcp_schemas, tool) => {
                if local.read_only || planning {
                    return Err("分析模式不能调用已配置的 MCP 工具".into());
                }
                let host = local.mcp.as_ref().ok_or("此 MCP 工具不属于当前会话")?;
                let (inspection, fingerprint) =
                    host.inspect_approved(&self.project, tool, &arguments)?;
                (
                    inspection.description,
                    inspection.resources,
                    true,
                    CallBinding::Mcp(fingerprint),
                )
            }
            ToolHost::Local(local) if has_tool(&local.application_schemas, tool) => {
                let inspection = local
                    .applications
                    .inspect(&self.project, tool, &arguments)
                    .ok_or("此工具不属于当前工作区")??;
                if (local.read_only || planning) && inspection.mutating {
                    return Err("分析模式不能修改工作区或应用数据".into());
                }
                (
                    inspection.description.clone(),
                    inspection.resources.clone(),
                    inspection.requires_approval || inspection.mutating,
                    CallBinding::Application(inspection),
                )
            }
            ToolHost::Remote(remote) if has_tool(&remote.tools, tool) => {
                let call = remote.inspect(tool, &arguments)?;
                (
                    call.inspection.description.clone(),
                    call.inspection.resources.clone(),
                    call.inspection.requires_approval || call.inspection.mutating,
                    CallBinding::Remote(call),
                )
            }
            _ => return Err("此工具不属于当前会话".into()),
        };
        Ok(McpCall {
            tool: tool.into(),
            arguments,
            description,
            resources,
            requires_approval,
            binding,
        })
    }

    pub(super) async fn execute(
        &self,
        approved: McpCall,
        cancel: watch::Receiver<bool>,
    ) -> ToolReply {
        let closed_browser = match (&approved.binding, approved.tool.as_str()) {
            (CallBinding::Application(_), "browser_close") => {
                approved.arguments["browser_id"].as_str().map(str::to_owned)
            }
            _ => None,
        };
        let result = if *cancel.borrow() {
            Err("工具操作已取消".into())
        } else {
            match (&self.host, approved.binding) {
                (ToolHost::Local(local), CallBinding::Mcp(fingerprint)) => match &local.mcp {
                    Some(host) => host
                        .call_approved(
                            &self.project,
                            &approved.tool,
                            &approved.arguments,
                            &fingerprint,
                            cancel,
                        )
                        .await
                        .map(|output| (output, None)),
                    None => Err("MCP 配置已失效".into()),
                },
                (ToolHost::Local(local), CallBinding::Application(binding)) => {
                    self.execute_application(
                        local,
                        &approved.tool,
                        &approved.arguments,
                        binding,
                        cancel,
                    )
                    .await
                }
                (ToolHost::Local(local), CallBinding::Memory { binding, source }) => {
                    match &local.memory_root {
                        Some(root) => memory::desktop_execute_tool(
                            root,
                            &self.memory_project(),
                            &approved.arguments,
                            &source,
                            binding,
                            cancel,
                        )
                        .await
                        .map(|text| {
                            (
                                ToolOutput {
                                    text,
                                    image_data_url: None,
                                    diffs: vec![],
                                    file_changes: vec![],
                                },
                                None,
                            )
                        }),
                        None => Err("当前会话未开启记忆工具".into()),
                    }
                }
                (ToolHost::Remote(remote), CallBinding::Remote(call)) => {
                    remote.execute(call, cancel).await.map(|(output, path)| {
                        (
                            output,
                            path.map(|path| AgentPreviewTarget::File {
                                path,
                                locator: None,
                            }),
                        )
                    })
                }
                _ => Err("工具绑定已失效".into()),
            }
        };
        match result {
            Ok((output, preview)) => ToolReply {
                payload: rendered_output(output),
                preview,
                closed_browser,
            },
            Err(error) => ToolReply {
                payload: denied(&error),
                preview: None,
                closed_browser: None,
            },
        }
    }

    fn memory_project(&self) -> String {
        super::agent_preferences::path_key(&self.project.to_string_lossy())
    }

    async fn execute_application(
        &self,
        local: &LocalTools,
        tool: &str,
        arguments: &Value,
        binding: ToolInspection,
        cancel: watch::Receiver<bool>,
    ) -> Result<(ToolOutput, Option<AgentPreviewTarget>), String> {
        let current = local
            .applications
            .inspect(&self.project, tool, arguments)
            .ok_or("工作区工具已失效")??;
        if current != binding {
            return Err("工具资源已变更，请重新提交请求".into());
        }
        let output = local
            .applications
            .execute_output(&self.project, tool, arguments, cancel)
            .await?;
        let preview = match tool {
            "open_preview" => Some(AgentPreviewTarget::File {
                path: preview_path(arguments)?.into(),
                locator: None,
            }),
            "browser_open" => {
                let receipt: Value =
                    serde_json::from_str(&output.text).map_err(|_| "无法读取浏览器回执")?;
                Some(AgentPreviewTarget::Browser {
                    browser_id: receipt["browser_id"]
                        .as_str()
                        .ok_or("无效的浏览器编号")?
                        .into(),
                    url: receipt["url"].as_str().ok_or("无效的浏览器地址")?.into(),
                    delivery_id: None,
                    native: receipt["native"].as_bool().unwrap_or(false),
                })
            }
            _ => None,
        };
        Ok((output, preview))
    }
}

fn has_tool(schemas: &[Value], name: &str) -> bool {
    schemas
        .iter()
        .any(|entry| entry["function"]["name"].as_str() == Some(name))
}

fn rendered_output(output: ToolOutput) -> Value {
    let mut content = vec![json!({"type":"text","text":output.text})];
    if let Some((media, data)) = output
        .image_data_url
        .as_deref()
        .and_then(|value| value.strip_prefix("data:"))
        .and_then(|value| value.split_once(";base64,"))
    {
        if matches!(
            media,
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        ) {
            content.push(json!({"type":"image","mimeType":media,"data":data}));
        } else {
            content.push(json!({"type":"text","text":"图片格式不受 Harness 支持。"}));
        }
    }
    json!({"content":content,"isError":false})
}

pub(super) fn denied(reason: &str) -> Value {
    json!({"content":[{"type":"text","text":reason}],"isError":true})
}
