use crate::services::inprocess_agent::InprocessAgentState;
use lolicode_agent::AgentStatus;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

const MAX_WORKFLOW_BYTES: u64 = 256 * 1024;
const MAX_WORKFLOWS: usize = 200;
const RUNS_KEY: &str = "lolicode_workflow_runs_v1";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowRun {
    run_id: String,
    name: String,
    scope: String,
    cwd: String,
    session_id: String,
    request_id: String,
    prompt_hash: String,
    created_at: u64,
}
fn runs_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
fn read_runs(db: &crate::database::Database) -> Result<Vec<WorkflowRun>, String> {
    db.get_setting(RUNS_KEY)
        .map_err(|error| error.to_string())?
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| "工作流运行记录无法解析，原数据已保留".into())
        })
        .unwrap_or_else(|| Ok(vec![]))
}

/// Persist the intent before sendMessage. A lost IPC response can be retried
/// with the same receipt without creating another turn or losing its history.
pub async fn record_run(
    app: &AppHandle,
    project: &str,
    session: &str,
    name: &str,
    scope: &str,
    request_id: &str,
    prompt: &str,
) -> Result<(), String> {
    let state = app.state::<crate::store::AppState>();
    record_run_in_db(&state.db, project, session, name, scope, request_id, prompt).await
}

pub async fn record_run_in_db(
    db: &crate::database::Database,
    project: &str,
    session: &str,
    name: &str,
    scope: &str,
    request_id: &str,
    prompt: &str,
) -> Result<(), String> {
    let _guard = runs_lock().lock().await;
    let mut runs = read_runs(db)?;
    let hash = format!("{:x}", Sha256::digest(prompt.as_bytes()));
    if let Some(existing) = runs
        .iter()
        .find(|run| run.session_id == session && run.request_id == request_id)
    {
        if existing.prompt_hash != hash
            || existing.name != name
            || existing.scope != scope
            || crate::services::agent_preferences::path_key(&existing.cwd)
                != crate::services::agent_preferences::path_key(project)
        {
            return Err("重试的工作流已被修改，请新建一次运行".into());
        }
        return Ok(());
    }
    runs.push(WorkflowRun {
        run_id: request_id.into(),
        name: name.into(),
        scope: scope.into(),
        cwd: project.into(),
        session_id: session.into(),
        request_id: request_id.into(),
        prompt_hash: hash,
        created_at: chrono::Utc::now().timestamp_millis().max(0) as u64,
    });
    if runs.len() > 2000 {
        runs.drain(..runs.len() - 2000);
    }
    db.set_setting(
        RUNS_KEY,
        &serde_json::to_string(&runs).map_err(|_| "工作流记录编码失败")?,
    )
    .map_err(|error| error.to_string())
}

#[derive(Clone)]
pub struct SavedWorkflow {
    pub name: String,
    pub path: String,
    pub scope: String,
    pub meta: Value,
    pub script: String,
    pub document: String,
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
    let mut offset = 0;
    let (end, script_start) = rest
        .split_inclusive('\n')
        .find_map(|line| {
            let start = offset;
            offset += line.len();
            (line.trim_end() == "---").then_some((start, offset))
        })
        .ok_or_else(|| "YAML frontmatter 未结束".to_string())?;
    let metadata: serde_yaml::Value =
        serde_yaml::from_str(&rest[..end]).map_err(|_| "YAML frontmatter 格式无效".to_string())?;
    let meta = serde_json::to_value(metadata).map_err(|_| "工作流元数据无法解析")?;
    let description = meta["description"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "工作流需要填写 description".to_string())?;
    let _ = description;
    if let Some(args) = meta.get("args") {
        let args = args.as_object().ok_or("工作流 args 必须是参数对象")?;
        for (key, spec) in args {
            if key.trim().is_empty()
                || key.len() > 160
                || !spec.is_object()
                || !matches!(
                    spec["type"].as_str().unwrap_or("string"),
                    "string" | "number" | "boolean" | "json"
                )
            {
                return Err("工作流参数声明无效".into());
            }
            if spec
                .get("required")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err("工作流参数 required 必须是布尔值".into());
            }
        }
    }
    let script = rest[script_start..].trim().to_string();
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
        document: content.to_string(),
    })
}

async fn read_document(path: &std::path::Path) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "无法读取工作流文件")?;
    let mut bytes = Vec::new();
    file.take(MAX_WORKFLOW_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "无法读取工作流文件")?;
    if bytes.len() > MAX_WORKFLOW_BYTES as usize {
        return Err("工作流文件超过 256 KiB 上限".into());
    }
    String::from_utf8(bytes).map_err(|_| "工作流文件不是有效的 UTF-8 文本".into())
}

async fn load_workflow(root: PathBuf, name: &str, scope: String) -> Result<SavedWorkflow, String> {
    let name = normalized_name(name)?;
    ensure_no_links(&root)?;
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
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > MAX_WORKFLOW_BYTES {
        return Err("工作流文件类型或大小无效".into());
    }
    let canonical = tokio::fs::canonicalize(&path)
        .await
        .map_err(|_| "无法读取工作流文件".to_string())?;
    if !canonical.starts_with(&root_path) {
        return Err("工作流路径越过了工作流目录".into());
    }
    let content = read_document(&canonical).await?;
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
fn is_link(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
fn ensure_no_links(path: &std::path::Path) -> Result<(), String> {
    for ancestor in path.ancestors().filter(|path| path.exists()) {
        let metadata = std::fs::symlink_metadata(ancestor).map_err(|_| "无法检查工作流目录")?;
        if is_link(&metadata) {
            return Err("工作流目录不能经过符号链接或目录联接".into());
        }
    }
    Ok(())
}

async fn delete_workflow(root: &std::path::Path, name: &str) -> Result<Value, String> {
    let name = match normalized_name(name) {
        Ok(name) => name,
        Err(error) => {
            return Ok(json!({"ok":false,"reason":"invalid_name","detail":error}));
        }
    };
    ensure_no_links(root)?;
    let path = root.join(format!("{name}.md"));
    match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) if metadata.is_file() && !is_link(&metadata) => {}
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

pub async fn invoke_file_service(method: &str, args: Vec<Value>) -> Result<Value, String> {
    let params = request(&args)?;
    let (root, scope) = workflow_root(params)?;
    ensure_no_links(&root)?;
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
                    "document":workflow.document,
                })),
                Err(error) => Ok(invalid(&error)),
            }
        }
        "saveSavedWorkflow" => {
            let name = normalized_name(params["name"].as_str().ok_or("请填写工作流名称")?)?;
            let content = params["document"]
                .as_str()
                .filter(|text| text.len() <= MAX_WORKFLOW_BYTES as usize)
                .ok_or("工作流内容为空或超过 256 KiB")?;
            let path = root.join(format!("{name}.md"));
            parse_document(content, name.clone(), path.to_string_lossy().into(), scope)?;
            let _guard = runs_lock().lock().await;
            // Never traverse a reparse point when saving or deleting recipes.
            for ancestor in path.ancestors().filter(|path| path.exists()) {
                let metadata =
                    std::fs::symlink_metadata(ancestor).map_err(|_| "无法检查工作流路径")?;
                if is_link(&metadata) {
                    return Err("工作流路径不能经过符号链接或目录联接".into());
                }
            }
            if path.exists() && params["overwrite"].as_bool() != Some(true) {
                return Err("同名工作流已存在，请更名或明确覆盖".into());
            }
            if let Some(expected) = params.get("expectedDocument") {
                let expected = expected.as_str().ok_or("工作流原文无效，请重新读取")?;
                if expected.len() > MAX_WORKFLOW_BYTES as usize {
                    return Err("工作流原文超过大小限制".into());
                }
                let actual = read_document(&path)
                    .await
                    .map_err(|_| "工作流已被删除、过大或无法读取，请重新加载")?;
                if actual != expected {
                    return Err(
                        "工作流已被其他操作修改，请重新加载后再保存；你的编辑内容仍保留".into(),
                    );
                }
            }
            std::fs::create_dir_all(&root).map_err(|_| "无法创建工作流目录")?;
            crate::config::atomic_write_private(&path, content.as_bytes())
                .map_err(|error| error.to_string())?;
            Ok(json!({"ok":true,"name":name,"path":path.to_string_lossy()}))
        }
        "deleteSavedWorkflow" => {
            let name = params["name"].as_str().ok_or("缺少工作流名称")?;
            let _guard = runs_lock().lock().await;
            delete_workflow(&root, name).await
        }
        _ => Err("此工作流功能暂不可用".into()),
    }
}

pub async fn invoke_service(
    app: &AppHandle,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    if method != "listSavedWorkflowRuns" {
        return invoke_file_service(method, args).await;
    }
    let params = request(&args)?;
    let (root, scope) = workflow_root(params)?;
    ensure_no_links(&root)?;

    let state = app.state::<InprocessAgentState>();
    state.ensure_started(app).await?;
    let project_path = params["workspacePath"].as_str().ok_or("缺少工作区路径")?;
    let target_name = params["name"].as_str();
    let state_db = app.state::<crate::store::AppState>();
    let records = {
        let _guard = runs_lock().lock().await;
        read_runs(&state_db.db)?
    };
    let mut runs = Vec::new();
    for record in records
        .into_iter()
        .filter(|run| {
            crate::services::agent_preferences::path_key(&run.cwd)
                == crate::services::agent_preferences::path_key(project_path)
                && run.scope == scope
                && target_name.is_none_or(|name| name == run.name)
        })
        .rev()
        .take(51)
    {
        let snapshot: Result<lolicode_agent::AgentSnapshot, String> = state
            .call("getSession", json!({"sessionId":record.session_id}), false)
            .await;
        let command: Result<Value, String> = state
            .call(
                "queryCommand",
                json!({"sessionId":record.session_id,"requestId":record.request_id}),
                false,
            )
            .await;
        let status = match (
            snapshot.as_ref(),
            command
                .as_ref()
                .ok()
                .and_then(|value| value["results"][0]["result"]["status"].as_str()),
        ) {
            (_, Some("completed")) => "completed",
            (_, Some("cancelled")) => "stopped",
            (_, Some("failed")) => "errored",
            (Err(_), _) => "errored",
            (Ok(snapshot), _) if snapshot.status == AgentStatus::Error => "errored",
            (Ok(snapshot), _)
                if matches!(
                    snapshot.status,
                    AgentStatus::Running
                        | AgentStatus::WaitingPermission
                        | AgentStatus::WaitingQuestion
                ) =>
            {
                "running"
            }
            (Ok(_), Some("accepted" | "running")) => "errored",
            _ => "pending",
        };
        runs.push(json!({"runId":record.run_id,"name":record.name,"scope":record.scope,"status":status,"createdAt":record.created_at,"cwd":record.cwd,"sessionId":record.session_id,"error":snapshot.as_ref().ok().and_then(|snapshot| snapshot.error.clone())}));
    }
    runs.sort_by(|left, right| right["createdAt"].as_u64().cmp(&left["createdAt"].as_u64()));
    let truncated = runs.len() > 50;
    runs.truncate(50);
    Ok(if truncated {
        json!({"runs":runs,"truncated":true})
    } else {
        json!({"runs":runs})
    })
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
    render_prompt(&workflow, args)
}

fn render_prompt(workflow: &SavedWorkflow, args: &Value) -> Result<String, String> {
    if serde_json::to_vec(args)
        .map_err(|_| "工作流参数无法编码")?
        .len()
        > 64 * 1024
    {
        return Err("工作流参数超过 64 KiB".into());
    }
    let mut values = args
        .as_object()
        .ok_or("工作流参数必须是 JSON 对象")?
        .clone();
    let declarations = workflow.meta["args"].as_object();
    if let Some(declarations) = declarations {
        for key in values.keys() {
            if !declarations.contains_key(key) {
                return Err(format!("工作流不接受参数：{key}"));
            }
        }
        for (key, spec) in declarations {
            if !values.contains_key(key) {
                if let Some(default) = spec.get("default") {
                    values.insert(key.clone(), default.clone());
                }
            }
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
    let args = serde_json::to_string_pretty(&values).map_err(|_| "工作流参数无法编码")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn edits_preserve_original_yaml_and_reject_stale_overwrites() {
        let temp = tempfile::tempdir().unwrap();
        let document = "---\r\n# Keep this comment\r\ndescription: Saved edit\r\ncustom: kept\r\nnotes: |\r\n  ---not a delimiter\r\n---\r\nRead README.\r\n";
        let params = json!({"workspacePath":temp.path(),"scope":"project","name":"editable","document":document});
        invoke_file_service("saveSavedWorkflow", vec![params.clone()])
            .await
            .unwrap();
        let loaded = invoke_file_service("getSavedWorkflow", vec![params.clone()])
            .await
            .unwrap();
        assert_eq!(loaded["document"], document);
        assert_eq!(loaded["meta"]["custom"], "kept");
        let changed = document.replace("Read README.", "Read README and test the change.");
        let mut edit = params.clone();
        edit["document"] = json!(changed);
        edit["expectedDocument"] = json!(document);
        edit["overwrite"] = json!(true);
        invoke_file_service("saveSavedWorkflow", vec![edit.clone()])
            .await
            .unwrap();
        edit["document"] =
            json!(document.replace("Read README.", "Stale edit must not replace anything."));
        assert!(invoke_file_service("saveSavedWorkflow", vec![edit])
            .await
            .unwrap_err()
            .contains("已被其他操作修改"));
        let final_document = invoke_file_service("getSavedWorkflow", vec![params])
            .await
            .unwrap();
        assert_eq!(final_document["document"], changed);
        assert_eq!(final_document["meta"]["custom"], "kept");
    }

    #[tokio::test]
    async fn simultaneous_edits_with_same_base_only_accept_one_writer() {
        let temp = tempfile::tempdir().unwrap();
        let original = "---\ndescription: Concurrent\n---\nOriginal steps.";
        let base = json!({"workspacePath":temp.path(),"scope":"project","name":"shared","document":original});
        invoke_file_service("saveSavedWorkflow", vec![base.clone()])
            .await
            .unwrap();
        let mut a = base.clone();
        a["overwrite"] = json!(true);
        a["expectedDocument"] = json!(original);
        a["document"] = json!(original.replace("Original steps.", "Writer A."));
        let mut b = a.clone();
        b["document"] = json!(original.replace("Original steps.", "Writer B."));
        let (first, second) = tokio::join!(
            invoke_file_service("saveSavedWorkflow", vec![a]),
            invoke_file_service("saveSavedWorkflow", vec![b])
        );
        assert_ne!(first.is_ok(), second.is_ok());
        let loaded = invoke_file_service("getSavedWorkflow", vec![base])
            .await
            .unwrap();
        assert!(loaded["document"]
            .as_str()
            .unwrap()
            .contains(if first.is_ok() {
                "Writer A."
            } else {
                "Writer B."
            }));
    }

    #[tokio::test]
    async fn run_receipt_survives_database_reopen_and_rejects_changed_scope_or_prompt() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("workflow-receipts.db");
        let open = || {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute(
                "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)",
                [],
            )
            .unwrap();
            crate::database::Database {
                conn: std::sync::Mutex::new(conn),
                log_count_cache: std::sync::Mutex::new(None),
            }
        };
        let db = open();
        record_run_in_db(
            &db,
            "D:/owned/project",
            "lc:owned",
            "check",
            "project",
            "owned-request",
            "Owned workflow prompt",
        )
        .await
        .unwrap();
        drop(db);
        let db = open();
        record_run_in_db(
            &db,
            "D:/owned/project",
            "lc:owned",
            "check",
            "project",
            "owned-request",
            "Owned workflow prompt",
        )
        .await
        .unwrap();
        assert_eq!(read_runs(&db).unwrap().len(), 1);
        for (cwd, prompt, scope) in [
            ("D:/different/project", "Owned workflow prompt", "project"),
            ("D:/owned/project", "Changed prompt", "project"),
            ("D:/owned/project", "Owned workflow prompt", "global"),
        ] {
            assert!(record_run_in_db(
                &db,
                cwd,
                "lc:owned",
                "check",
                scope,
                "owned-request",
                prompt
            )
            .await
            .is_err());
        }
        assert_eq!(read_runs(&db).unwrap().len(), 1);
    }
    #[test]
    fn workflow_arguments_apply_defaults_and_validate_before_model_dispatch() {
        let workflow=parse_document("---\ndescription: Fixture\nargs:\n  count:\n    type: number\n    required: true\n    default: 2\n  apply:\n    type: boolean\n---\nRead the owned project before changing anything.","fixture".into(),"fixture.md".into(),"project".into()).unwrap();
        let text = render_prompt(&workflow, &json!({})).unwrap();
        assert!(text.contains("\"count\": 2"));
        assert!(render_prompt(&workflow, &json!({"count":"wrong"})).is_err());
        assert!(render_prompt(&workflow, &json!({"unknown":true})).is_err());
        assert!(render_prompt(&workflow, &json!({"apply":"false"})).is_err());
        assert!(render_prompt(&workflow, &json!([])).is_err());
    }
    #[tokio::test]
    async fn workflow_load_uses_isolated_saved_document_and_rejects_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".zcode/workflows");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(
            root.join("check.md"),
            "---\ndescription: Isolated workflow\n---\nRead README and report findings.",
        )
        .await
        .unwrap();
        let workflow = load_workflow(root.clone(), "check", "project".into())
            .await
            .unwrap();
        assert!(render_prompt(&workflow, &json!({}))
            .unwrap()
            .contains("Read README and report findings."));
        for name in ["../escape", "..", "C:/outside", "bad\\name"] {
            assert!(load_workflow(root.clone(), name, "project".into())
                .await
                .is_err());
        }
        assert!(parse_document(
            "---\ndescription: Bad\nargs: []\n---\nFixture",
            "bad".into(),
            "bad.md".into(),
            "project".into()
        )
        .is_err());
    }

    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn workflow_ancestor_link_cannot_read_or_delete_external_recipe() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("owned-project");
        let outside = temp.path().join("outside-project");
        std::fs::create_dir_all(project.join(".zcode")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let protected = outside.join("protected.md");
        let content = "---\ndescription: Must remain untouched\n---\nProtected fixture.";
        std::fs::write(&protected, content).unwrap();
        let link = project.join(".zcode/workflows");
        #[cfg(windows)]
        {
            // A junction exercises Windows reparse points without requiring symlink privileges.
            assert!(link.starts_with(temp.path()) && outside.starts_with(temp.path()));
            let result = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(link.to_string_lossy().replace('/', "\\"))
                .arg(outside.to_string_lossy().replace('/', "\\"))
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "junction fixture creation failed: {} {}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(ensure_no_links(&link).is_err());
        assert!(load_workflow(link.clone(), "protected", "project".into())
            .await
            .is_err());
        assert!(delete_workflow(&link, "protected").await.is_err());
        assert_eq!(std::fs::read_to_string(&protected).unwrap(), content);
        // Unlink only the owned junction, never recursively traverse its target.
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
        assert!(protected.is_file());
        assert_eq!(
            delete_workflow(&outside, "protected").await.unwrap()["ok"],
            true
        );
        assert!(!protected.exists());
    }
}
