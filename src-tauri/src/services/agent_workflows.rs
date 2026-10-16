use crate::services::inprocess_agent::InprocessAgentState;
use lolicode_agent::{AgentSession, AgentStatus};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const MAX_WORKFLOW_BYTES: u64 = 256 * 1024;
const MAX_WORKFLOWS: usize = 200;

#[derive(Clone)]
pub struct SavedWorkflow {
    pub name: String,
    pub path: String,
    pub scope: String,
    pub meta: Value,
    pub script: String,
}

fn request(args: &[Value]) -> Result<&Value, String> {
    args.first().ok_or_else(|| "缺少工作流参数".to_string())
}

fn scope(value: &Value) -> Result<&str, String> {
    match value["scope"].as_str().unwrap_or("project") {
        "project" => Ok("project"),
        "global" => Ok("global"),
        _ => Err("工作流范围无效".into()),
    }
}

fn workflow_root(request: &Value) -> Result<(PathBuf, String), String> {
    let scope = scope(request)?;
    if scope == "global" {
        let root = crate::config::get_home_dir()
            .join(".zcode")
            .join("workflows");
        return Ok((root, scope.into()));
    }
    let project = request["workspacePath"]
        .as_str()
        .filter(|path| !path.trim().is_empty())
        .ok_or("工作流项目路径无效")?;
    let project = crate::services::agent_host::canonical_project(project)?;
    Ok((project.join(".zcode").join("workflows"), scope.into()))
}

fn normalized_name(name: &str) -> Result<String, String> {
    let name = name.trim().strip_suffix(".md").unwrap_or(name.trim());
    if name.is_empty()
        || name.len() > 160
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '\0'])
        || name.chars().any(char::is_control)
    {
        return Err("工作流名称无效".into());
    }
    Ok(name.to_string())
}

fn parse_document(
    content: &str,
    name: String,
    path: String,
    scope: String,
) -> Result<SavedWorkflow, String> {
    let normalized = content.replace("\r\n", "\n");
    let rest = normalized
        .strip_prefix("---\n")
        .ok_or_else(|| "缺少 YAML frontmatter（文件需以 --- 开始）".to_string())?;
    let end = rest
        .find("\n---")
        .ok_or_else(|| "YAML frontmatter 未结束".to_string())?;
    let metadata: serde_yaml::Value =
        serde_yaml::from_str(&rest[..end]).map_err(|_| "YAML frontmatter 格式无效".to_string())?;
    let meta = serde_json::to_value(metadata).map_err(|_| "工作流元数据无法解析")?;
    let description = meta["description"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "工作流需要填写 description".to_string())?;
    let _ = description;
    let script = rest[end + 4..].trim().to_string();
    if script.is_empty() {
        return Err("工作流脚本不能为空".into());
    }
    if script.len() > MAX_WORKFLOW_BYTES as usize {
        return Err("工作流脚本超过 256 KiB 上限".into());
    }
    Ok(SavedWorkflow {
        name,
        path,
        scope,
        meta,
        script,
    })
}

async fn load_workflow(root: PathBuf, name: &str, scope: String) -> Result<SavedWorkflow, String> {
    let name = normalized_name(name)?;
    let root_path = match tokio::fs::canonicalize(&root).await {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("工作流不存在".into());
        }
        Err(_) => return Err("无法读取工作流目录".into()),
    };
    let path = root.join(format!("{name}.md"));
    let metadata = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|_| "工作流不存在".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_WORKFLOW_BYTES
    {
        return Err("工作流文件类型或大小无效".into());
    }
    let canonical = tokio::fs::canonicalize(&path)
        .await
        .map_err(|_| "无法读取工作流文件".to_string())?;
    if !canonical.starts_with(&root_path) {
        return Err("工作流路径越过了工作流目录".into());
    }
    let content = tokio::fs::read_to_string(&canonical)
        .await
        .map_err(|_| "工作流文件不是有效的 UTF-8 文本".to_string())?;
    parse_document(
        &content,
        name,
        canonical.to_string_lossy().into_owned(),
        scope,
    )
}

fn invalid(reason: &str) -> Value {
    json!({"ok":false,"reason":"parse_error","detail":reason})
}

pub async fn invoke_service(
    app: &AppHandle,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    let params = request(&args)?;
    let (root, scope) = workflow_root(params)?;
    match method {
        "listSavedWorkflows" => {
            let mut workflows = Vec::new();
            let mut invalid_files = Vec::new();
            match tokio::fs::read_dir(&root).await {
                Ok(mut entries) => {
                    while let Some(entry) = entries
                        .next_entry()
                        .await
                        .map_err(|_| "无法读取工作流目录")?
                    {
                        if workflows.len() + invalid_files.len() >= MAX_WORKFLOWS {
                            break;
                        }
                        let kind = entry
                            .file_type()
                            .await
                            .map_err(|_| "无法读取工作流目录项")?;
                        if !kind.is_file()
                            || kind.is_symlink()
                            || entry.path().extension().is_none_or(|ext| ext != "md")
                        {
                            continue;
                        }
                        let path = entry.path();
                        let name = path
                            .file_stem()
                            .and_then(|part| part.to_str())
                            .unwrap_or_default();
                        let visible_path = path.to_string_lossy().into_owned();
                        match load_workflow(root.clone(), name, scope.clone()).await {
                            Ok(workflow) => workflows.push(json!({
                                "name": workflow.name,
                                "description": workflow.meta["description"],
                                "whenToUse": workflow.meta["whenToUse"],
                                "args": workflow.meta["args"],
                                "scope": workflow.scope,
                                "path": workflow.path,
                            })),
                            Err(error) => {
                                invalid_files.push(json!({"path":visible_path,"reason":error}))
                            }
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("无法读取工作流目录".into()),
            }
            workflows.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
            invalid_files.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
            Ok(json!({"workflows":workflows,"invalid":invalid_files,"dir":root.to_string_lossy()}))
        }
        "getSavedWorkflow" => {
            let name = params["name"].as_str().ok_or("缺少工作流名称")?;
            match load_workflow(root, name, scope).await {
                Ok(workflow) => Ok(json!({
                    "ok":true,
                    "name":workflow.name,
                    "path":workflow.path,
                    "scope":workflow.scope,
                    "meta":workflow.meta,
                    "script":workflow.script,
                })),
                Err(error) => Ok(invalid(&error)),
            }
        }
        "deleteSavedWorkflow" => {
            let name = params["name"].as_str().ok_or("缺少工作流名称")?;
            let name = match normalized_name(name) {
                Ok(name) => name,
                Err(error) => {
                    return Ok(json!({"ok":false,"reason":"invalid_name","detail":error}))
                }
            };
            let path = root.join(format!("{name}.md"));
            match tokio::fs::symlink_metadata(&path).await {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
                Ok(_) => return Ok(json!({"ok":false,"reason":"read_error","path":path})),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(json!({"ok":false,"reason":"not_found"}));
                }
                Err(_) => return Ok(json!({"ok":false,"reason":"read_error"})),
            }
            tokio::fs::remove_file(&path)
                .await
                .map_err(|_| "工作流删除失败".to_string())?;
            Ok(json!({"ok":true,"path":path.to_string_lossy()}))
        }
        "listSavedWorkflowRuns" => {
            let state = app.state::<InprocessAgentState>();
            state.ensure_started(app).await?;
            let project_path = params["workspacePath"].as_str();
            let sessions: Vec<AgentSession> = state
                .call(
                    "listSessions",
                    json!({"projectPath":project_path,"includeArchived":true}),
                    false,
                )
                .await?;
            let target_name = params["name"].as_str();
            let mut runs = sessions
                .into_iter()
                .filter_map(|session| {
                    let name = session.title.strip_prefix("工作流 · ")?;
                    if target_name.is_some_and(|target| target != name) {
                        return None;
                    }
                    let status = match session.activity.as_ref().map(|activity| &activity.status) {
                        Some(
                            AgentStatus::Running
                            | AgentStatus::WaitingPermission
                            | AgentStatus::WaitingQuestion,
                        ) => "running",
                        Some(AgentStatus::Error) => "errored",
                        _ => "completed",
                    };
                    Some(json!({
                        "runId":session.id,
                        "name":name,
                        "status":status,
                        "createdAt":session.created_at,
                        "cwd":session.project_path,
                        "sessionId":session.id,
                    }))
                })
                .collect::<Vec<_>>();
            runs.sort_by(|left, right| {
                right["createdAt"].as_u64().cmp(&left["createdAt"].as_u64())
            });
            let truncated = runs.len() > 50;
            runs.truncate(50);
            Ok(if truncated {
                json!({"runs":runs,"truncated":true})
            } else {
                json!({"runs":runs})
            })
        }
        _ => Err("此工作流功能暂不可用".into()),
    }
}

pub async fn workflow_prompt(
    project_path: &str,
    name: &str,
    scope: &str,
    args: &Value,
) -> Result<String, String> {
    let request = json!({"workspacePath":project_path,"scope":scope});
    let (root, scope) = workflow_root(&request)?;
    let workflow = load_workflow(root, name, scope).await?;
    let values = args.as_object().ok_or("工作流参数必须是 JSON 对象")?;
    let declarations = workflow.meta["args"].as_object();
    if let Some(declarations) = declarations {
        for key in values.keys() {
            if !declarations.contains_key(key) {
                return Err(format!("工作流不接受参数：{key}"));
            }
        }
        for (key, spec) in declarations {
            if spec["required"].as_bool() == Some(true) && !values.contains_key(key) {
                return Err(format!("请填写工作流参数：{key}"));
            }
            if let Some(value) = values.get(key) {
                let valid = match spec["type"].as_str().unwrap_or("string") {
                    "string" => value.is_string(),
                    "number" => value.is_number(),
                    "boolean" => value.is_boolean(),
                    "json" => true,
                    _ => false,
                };
                if !valid {
                    return Err(format!("工作流参数 {key} 的类型无效"));
                }
            }
        }
    } else if !values.is_empty() {
        return Err("此工作流不接受参数".into());
    }
    let args = serde_json::to_string_pretty(args).map_err(|_| "工作流参数无法编码")?;
    let description = workflow.meta["description"].as_str().unwrap_or_default();
    let when_to_use = workflow.meta["whenToUse"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("\n使用说明：{value}\n"))
        .unwrap_or_default();
    Ok(format!(
        "请按保存的工作流执行任务。先检查当前项目状态，再遵循脚本步骤；如遇到脚本没有覆盖的情况，先说明并采取最稳妥的做法。\n\n工作流：{}\n说明：{}{}\n参数（JSON）：\n```json\n{}\n```\n\n工作流脚本：\n```markdown\n{}\n```",
        workflow.name, description, when_to_use, args, workflow.script
    ))
}
