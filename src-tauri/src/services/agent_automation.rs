//! Project scoped automations for the in-process agent.
//!
//! Jobs are stored in the application database and dispatched as independent
//! native sessions. The scheduler only runs while the desktop app is open.

use super::{
    agent_preferences::{self as preferences, AgentProject},
    channel_center::{AgentCatalog, AgentCatalogModel},
    inprocess_agent::InprocessAgentState,
};
use crate::{commands::agent_dispatch, store::AppState};
use chrono::{Datelike, Local, TimeZone, Timelike};
use lolicode_agent::{AgentSession, AgentSnapshot, AgentStatus};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

const STORE_KEY: &str = "lolicode_agent_automations_v1";
const MAX_JOBS: usize = 500;
const MAX_RUNS: usize = 2_000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    automation_id: String,
    title: String,
    prompt: String,
    cron_expr: String,
    workspace_path: String,
    recurring: bool,
    mode: String,
    model_selection: Value,
    enabled: bool,
    lifecycle_status: String,
    next_run_at: Option<u64>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    run_id: String,
    automation_id: String,
    dispatch_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    finished_at: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    jobs: Vec<Job>,
    #[serde(default)]
    runs: Vec<Run>,
}

fn mutation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

fn load(db: &crate::database::Database) -> Result<Store, String> {
    match db
        .get_setting(STORE_KEY)
        .map_err(|error| error.to_string())?
    {
        Some(value) => serde_json::from_str(&value)
            .map_err(|_| "自动化数据无法读取；原始记录已保留".to_string()),
        None => Ok(Store::default()),
    }
}

fn save(db: &crate::database::Database, store: &Store) -> Result<(), String> {
    let value = serde_json::to_string(store).map_err(|_| "自动化数据无法编码")?;
    db.set_setting(STORE_KEY, &value)
        .map_err(|error| error.to_string())
}

fn cron_parts(expr: &str) -> Result<(u32, Option<u32>, Option<u32>), String> {
    let fields: Vec<_> = expr.split_whitespace().collect();
    if fields.len() != 5 || fields[2] != "*" || fields[3] != "*" {
        return Err("目前只支持每小时、每天或每周运行的计划".into());
    }
    let minute = fields[0]
        .parse::<u32>()
        .ok()
        .filter(|value| *value <= 59)
        .ok_or("计划分钟无效")?;
    if fields[1] == "*" && fields[4] == "*" {
        return Ok((minute, None, None));
    }
    let hour = fields[1]
        .parse::<u32>()
        .ok()
        .filter(|value| *value <= 23)
        .ok_or("计划小时无效")?;
    if fields[4] == "*" {
        return Ok((minute, Some(hour), None));
    }
    let weekday = fields[4]
        .parse::<u32>()
        .ok()
        .filter(|value| *value <= 6)
        .ok_or("计划星期无效")?;
    Ok((minute, Some(hour), Some(weekday)))
}

fn next_run_at(expr: &str, after_ms: u64) -> Result<u64, String> {
    let (minute, hour, weekday) = cron_parts(expr)?;
    let after = Local
        .timestamp_millis_opt(after_ms as i64)
        .single()
        .unwrap_or_else(Local::now);
    let mut candidate = after
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .ok_or("无法计算自动化计划")?
        + chrono::Duration::minutes(1);
    for _ in 0..(8 * 24 * 60) {
        if candidate.minute() == minute
            && hour.is_none_or(|expected| candidate.hour() == expected)
            && weekday.is_none_or(|expected| candidate.weekday().num_days_from_sunday() == expected)
        {
            return Ok(candidate.timestamp_millis().max(0) as u64);
        }
        candidate += chrono::Duration::minutes(1);
    }
    Err("无法找到下一次自动化运行时间".into())
}

fn workspace_from_scope(scope: Option<&Value>) -> Result<String, String> {
    let path = scope
        .and_then(|value| value.get("workspacePath"))
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .ok_or("自动化需要指定工作区")?;
    crate::services::agent_host::canonical_project(path)
        .map(|path| path.to_string_lossy().into_owned())
}

fn registered_project(state: &AppState, path: &str) -> Result<AgentProject, String> {
    let projects = preferences::load(&state.db)?;
    projects
        .projects
        .get(&preferences::path_key(path))
        .cloned()
        .ok_or_else(|| "请先将此文件夹添加到工作区，再管理自动化".into())
}

fn ensure_job_scope(job: &Job, workspace: &str) -> Result<(), String> {
    if preferences::path_key(&job.workspace_path) != preferences::path_key(workspace) {
        return Err("自动化不属于当前工作区".into());
    }
    Ok(())
}

fn arg<'a>(args: &'a [Value], index: usize, label: &str) -> Result<&'a Value, String> {
    args.get(index).ok_or_else(|| format!("缺少{label}"))
}

fn model_selection_valid(value: &Value) -> bool {
    value["providerId"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty())
        && value["modelId"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
}

fn validate_job(value: &Value, workspace: String, state: &AppState) -> Result<Job, String> {
    registered_project(state, &workspace)?;
    let title = value["title"].as_str().unwrap_or_default().trim();
    let prompt = value["prompt"].as_str().unwrap_or_default().trim();
    if title.is_empty()
        || title.chars().count() > 160
        || prompt.is_empty()
        || prompt.len() > 64 * 1024
    {
        return Err("请填写名称和任务内容（名称不超过 160 字，任务不超过 64 KiB）".into());
    }
    let cron_expr = value["cronExpr"].as_str().unwrap_or_default().trim();
    cron_parts(cron_expr)?;
    let mode = value["mode"].as_str().unwrap_or("build");
    if !matches!(mode, "build" | "guarded" | "yolo") {
        return Err("自动化权限模式无效".into());
    }
    let model_selection = value["modelSelection"].clone();
    if !model_selection_valid(&model_selection) {
        return Err("自动化模型选择无效".into());
    }
    let now = now_ms();
    Ok(Job {
        automation_id: uuid::Uuid::new_v4().to_string(),
        title: title.to_string(),
        prompt: prompt.to_string(),
        cron_expr: cron_expr.to_string(),
        workspace_path: workspace,
        recurring: value["recurring"].as_bool().unwrap_or(true),
        mode: mode.to_string(),
        model_selection,
        enabled: true,
        lifecycle_status: "active".into(),
        next_run_at: Some(next_run_at(cron_expr, now)?),
        created_at: now,
        updated_at: now,
    })
}

fn find_job_mut<'a>(
    store: &'a mut Store,
    id: &str,
    workspace: &str,
) -> Result<&'a mut Job, String> {
    let job = store
        .jobs
        .iter_mut()
        .find(|job| job.automation_id == id)
        .ok_or_else(|| "自动化任务不存在".to_string())?;
    ensure_job_scope(job, workspace)?;
    Ok(job)
}

fn active(run: &Run) -> bool {
    matches!(run.outcome.as_deref(), Some("running"))
        || matches!(
            run.dispatch_status.as_str(),
            "claimed" | "running" | "dispatched"
        ) && run.outcome.is_none()
}

fn create_run(store: &mut Store, automation_id: &str) -> Run {
    let run = Run {
        run_id: uuid::Uuid::new_v4().to_string(),
        automation_id: automation_id.to_string(),
        dispatch_status: "claimed".into(),
        outcome: Some("running".into()),
        session_id: None,
        error: None,
        created_at: now_ms(),
        finished_at: None,
    };
    store.runs.push(run.clone());
    if store.runs.len() > MAX_RUNS {
        store.runs.drain(..store.runs.len() - MAX_RUNS);
    }
    run
}

async fn claim_run(
    app: &AppHandle,
    automation_id: &str,
    workspace: &str,
) -> Result<Option<Run>, String> {
    let _guard = mutation_lock().lock().await;
    let state = app.state::<AppState>();
    let mut store = load(&state.db)?;
    let job = store
        .jobs
        .iter()
        .find(|job| job.automation_id == automation_id)
        .cloned()
        .ok_or_else(|| "自动化任务不存在".to_string())?;
    ensure_job_scope(&job, workspace)?;
    if store
        .runs
        .iter()
        .any(|run| run.automation_id == automation_id && active(run))
    {
        return Ok(None);
    }
    let run = create_run(&mut store, automation_id);
    save(&state.db, &store)?;
    Ok(Some(run))
}

async fn update_run(
    db: &crate::database::Database,
    run_id: &str,
    update: impl FnOnce(&mut Run),
) -> Result<(), String> {
    let _guard = mutation_lock().lock().await;
    let mut store = load(db)?;
    let run = store
        .runs
        .iter_mut()
        .find(|run| run.run_id == run_id)
        .ok_or_else(|| "自动化运行记录不存在".to_string())?;
    update(run);
    save(db, &store)
}

fn catalog_model<'a>(
    catalog: &'a AgentCatalog,
    selection: &Value,
) -> Result<&'a AgentCatalogModel, String> {
    let provider_id = selection["providerId"].as_str().ok_or("自动化渠道不存在")?;
    let model_id = selection["modelId"].as_str().ok_or("自动化模型不存在")?;
    catalog
        .models
        .iter()
        .find(|model| model.provider_id == provider_id && model.model_id == model_id)
        .ok_or_else(|| "自动化所选模型已不可用，请编辑任务并重新选择模型".into())
}

async fn dispatch(app: AppHandle, job: Job, run: Run) {
    let result = async {
        let state = app.state::<AppState>();
        let workspace = registered_project(&state, &job.workspace_path)?;
        if preferences::path_key(&workspace.path) != preferences::path_key(&job.workspace_path) {
            return Err("工作区路径已变化，请重新打开项目".to_string());
        }
        let accounts = agent_dispatch::accounts(&app).await?;
        let carrier = app.state::<InprocessAgentState>();
        let catalog = carrier
            .bind_background_project(&app, &state, job.workspace_path.clone(), accounts)
            .await?;
        let model = catalog_model(&catalog, &job.model_selection)?;
        let reasoning = job.model_selection["options"]["reasoningLevel"]
            .as_str()
            .filter(|level| !level.is_empty() && *level != "default")
            .map(str::to_owned);
        let permission = match job.mode.as_str() {
            "guarded" => "auto",
            "yolo" => "full_access",
            _ => "ask",
        };
        let session: AgentSession = carrier
            .call(
                "createSession",
                json!({
                    "projectPath": job.workspace_path,
                    "modelId": model.id,
                    "mode": "build",
                    "permissionMode": permission,
                    "reasoningEffort": reasoning,
                    "title": format!("自动化 · {}", job.title),
                }),
                true,
            )
            .await?;
        update_run(&state.db, &run.run_id, |record| {
            record.dispatch_status = "running".into();
            record.session_id = Some(session.id.clone());
        })
        .await?;
        carrier
            .call::<Value>(
                "sendMessage",
                json!({
                    "sessionId": session.id,
                    "requestId": format!("automation:{}", run.run_id),
                    "text": job.prompt,
                    "locale": "zh",
                }),
                true,
            )
            .await?;
        update_run(&state.db, &run.run_id, |record| {
            record.dispatch_status = "dispatched".into();
        })
        .await?;
        Ok::<AgentSession, String>(session)
    }
    .await;

    match result {
        Ok(session) => {
            let app_for_monitor = app.clone();
            let run_id = run.run_id.clone();
            tauri::async_runtime::spawn(async move {
                monitor_run(app_for_monitor, run_id, session.id).await;
            });
        }
        Err(error) => {
            let detail = error.clone();
            if let Ok(state) = app.try_state::<AppState>().ok_or(()) {
                let _ = update_run(&state.db, &run.run_id, |record| {
                    record.dispatch_status = "failed_to_dispatch".into();
                    record.outcome = Some("failed".into());
                    record.error = Some(detail);
                    record.finished_at = Some(now_ms());
                })
                .await;
            }
            log::warn!("自动化任务派发失败：{error}");
        }
    }
}

async fn monitor_run(app: AppHandle, run_id: String, session_id: String) {
    let carrier = app.state::<InprocessAgentState>();
    let db = app.state::<AppState>().db.clone();
    let started = tokio::time::Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(12 * 60 * 60) {
            let _ = update_run(&db, &run_id, |run| {
                run.outcome = Some("failed".into());
                run.error = Some("自动化运行超过 12 小时，已停止跟踪".into());
                run.finished_at = Some(now_ms());
            })
            .await;
            break;
        }
        let snapshot: Result<AgentSnapshot, String> = carrier
            .call("getSession", json!({"sessionId":session_id}), false)
            .await;
        match snapshot {
            Ok(snapshot)
                if matches!(
                    snapshot.status,
                    AgentStatus::Running
                        | AgentStatus::WaitingPermission
                        | AgentStatus::WaitingQuestion
                ) =>
            {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Ok(snapshot) => {
                let (outcome, error) = if snapshot.status == AgentStatus::Error {
                    (
                        "failed",
                        snapshot
                            .error
                            .clone()
                            .or_else(|| Some("Agent 运行失败".into())),
                    )
                } else {
                    ("succeeded", None)
                };
                let _ = update_run(&db, &run_id, |run| {
                    run.outcome = Some(outcome.into());
                    run.error = error;
                    run.finished_at = Some(now_ms());
                })
                .await;
                break;
            }
            Err(error) => {
                let _ = update_run(&db, &run_id, |run| {
                    run.outcome = Some("failed".into());
                    run.error = Some(format!("无法读取运行会话：{error}"));
                    run.finished_at = Some(now_ms());
                })
                .await;
                break;
            }
        }
    }
}

async fn run_now(app: &AppHandle, id: &str, workspace: &str) -> Result<Value, String> {
    let Some(run) = claim_run(app, id, workspace).await? else {
        return Ok(json!({"status":"duplicate"}));
    };
    let state = app.state::<AppState>();
    let job = load(&state.db)?
        .jobs
        .into_iter()
        .find(|job| job.automation_id == id)
        .ok_or("自动化任务不存在")?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move { dispatch(app, job, run).await });
    Ok(json!({"status":"claimed"}))
}

pub async fn invoke(app: &AppHandle, method: &str, args: Vec<Value>) -> Result<Value, String> {
    let state = app.state::<AppState>();
    match method {
        "list" => {
            let workspace = workspace_from_scope(args.first())?;
            registered_project(&state, &workspace)?;
            let _guard = mutation_lock().lock().await;
            let store = load(&state.db)?;
            Ok(json!(store
                .jobs
                .into_iter()
                .filter(|job| preferences::path_key(&job.workspace_path)
                    == preferences::path_key(&workspace))
                .collect::<Vec<_>>()))
        }
        "create" => {
            let input = arg(&args, 0, "自动化内容")?;
            let workspace = workspace_from_scope(Some(input))?;
            let job = validate_job(input, workspace, &state)?;
            let _guard = mutation_lock().lock().await;
            let mut store = load(&state.db)?;
            if store.jobs.len() >= MAX_JOBS {
                return Err("自动化数量达到上限".into());
            }
            store.jobs.push(job.clone());
            save(&state.db, &store)?;
            Ok(json!(job))
        }
        "runNow" => {
            let id = arg(&args, 0, "自动化编号")?
                .as_str()
                .ok_or("自动化编号无效")?;
            let workspace = workspace_from_scope(args.get(1))?;
            run_now(app, id, &workspace).await
        }
        "setEnabled" => {
            let id = arg(&args, 0, "自动化编号")?
                .as_str()
                .ok_or("自动化编号无效")?;
            let enabled = arg(&args, 1, "启用状态")?.as_bool().ok_or("启用状态无效")?;
            let workspace = workspace_from_scope(args.get(2))?;
            registered_project(&state, &workspace)?;
            let _guard = mutation_lock().lock().await;
            let mut store = load(&state.db)?;
            let job = find_job_mut(&mut store, id, &workspace)?;
            job.enabled = enabled;
            job.lifecycle_status = if enabled { "active" } else { "paused" }.into();
            job.next_run_at = if enabled {
                Some(next_run_at(&job.cron_expr, now_ms())?)
            } else {
                None
            };
            job.updated_at = now_ms();
            let result = job.clone();
            save(&state.db, &store)?;
            Ok(json!(result))
        }
        "delete" => {
            let id = arg(&args, 0, "自动化编号")?
                .as_str()
                .ok_or("自动化编号无效")?;
            let workspace = workspace_from_scope(args.get(1))?;
            registered_project(&state, &workspace)?;
            let _guard = mutation_lock().lock().await;
            let mut store = load(&state.db)?;
            let job = store
                .jobs
                .iter()
                .find(|job| job.automation_id == id)
                .ok_or("自动化任务不存在")?;
            ensure_job_scope(job, &workspace)?;
            store.jobs.retain(|job| job.automation_id != id);
            save(&state.db, &store)?;
            Ok(json!(true))
        }
        "listRuns" => {
            let id = args.first().and_then(Value::as_str);
            let workspace = workspace_from_scope(args.get(1))?;
            registered_project(&state, &workspace)?;
            let _guard = mutation_lock().lock().await;
            let store = load(&state.db)?;
            let job_ids: std::collections::HashSet<_> = store
                .jobs
                .iter()
                .filter(|job| {
                    preferences::path_key(&job.workspace_path) == preferences::path_key(&workspace)
                })
                .map(|job| job.automation_id.as_str())
                .collect();
            if id.is_some_and(|id| !job_ids.contains(id)) {
                return Ok(json!([]));
            }
            let mut runs: Vec<_> = store
                .runs
                .into_iter()
                .filter(|run| {
                    job_ids.contains(run.automation_id.as_str())
                        && id.is_none_or(|id| run.automation_id == id)
                })
                .collect();
            runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            runs.truncate(100);
            Ok(json!(runs))
        }
        _ => Err("自动化方法暂不支持".into()),
    }
}

async fn scheduler_tick(app: &AppHandle) {
    let due = {
        let _guard = mutation_lock().lock().await;
        let state = app.state::<AppState>();
        let mut store = match load(&state.db) {
            Ok(store) => store,
            Err(error) => {
                log::warn!("自动化计划读取失败：{error}");
                return;
            }
        };
        let now = now_ms();
        let mut due = Vec::new();
        for job in store
            .jobs
            .iter_mut()
            .filter(|job| job.enabled && job.recurring)
        {
            let Some(next) = job.next_run_at else {
                job.next_run_at = next_run_at(&job.cron_expr, now).ok();
                continue;
            };
            if next <= now {
                if now.saturating_sub(next) <= 120_000 {
                    due.push(job.clone());
                }
                job.next_run_at = next_run_at(&job.cron_expr, now).ok();
                job.updated_at = now;
            }
        }
        if let Err(error) = save(&state.db, &store) {
            log::warn!("自动化计划更新时间失败：{error}");
            return;
        }
        due
    };

    for job in due {
        let state = app.state::<AppState>();
        let project_registered = preferences::load(&state.db)
            .ok()
            .is_some_and(|preferences| {
                preferences
                    .projects
                    .contains_key(&preferences::path_key(&job.workspace_path))
            });
        if !project_registered {
            continue;
        }
        match claim_run(app, &job.automation_id, &job.workspace_path).await {
            Ok(Some(run)) => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { dispatch(app, job, run).await });
            }
            Ok(None) => {}
            Err(error) => log::warn!("自动化计划派发失败：{error}"),
        }
    }
}

async fn recover_interrupted_runs(app: &AppHandle) {
    let runs = {
        let _guard = mutation_lock().lock().await;
        let state = app.state::<AppState>();
        match load(&state.db) {
            Ok(store) => store
                .runs
                .into_iter()
                .filter(active)
                .map(|run| (run.run_id, run.session_id))
                .collect::<Vec<_>>(),
            Err(error) => {
                log::warn!("自动化运行记录恢复失败：{error}");
                return;
            }
        }
    };
    if runs.is_empty() {
        return;
    }

    let carrier = app.state::<InprocessAgentState>();
    if let Err(error) = carrier.ensure_started(app).await {
        let db = app.state::<AppState>().db.clone();
        for (run_id, _) in runs {
            let detail = format!("应用重启后无法恢复运行记录：{error}");
            let _ = update_run(&db, &run_id, |run| {
                run.dispatch_status = "failed_to_dispatch".into();
                run.outcome = Some("failed".into());
                run.error = Some(detail);
                run.finished_at = Some(now_ms());
            })
            .await;
        }
        return;
    }

    let db = app.state::<AppState>().db.clone();
    for (run_id, session_id) in runs {
        let result: Result<AgentSnapshot, String> = match session_id {
            Some(session_id) => {
                carrier
                    .call("getSession", json!({"sessionId":session_id}), false)
                    .await
            }
            None => Err("会话尚未创建".into()),
        };
        let (dispatch_status, outcome, error) = match result {
            Ok(snapshot)
                if snapshot.status == AgentStatus::Idle && !snapshot.messages.is_empty() =>
            {
                ("dispatched", "succeeded", None)
            }
            Ok(snapshot) => (
                "failed_to_dispatch",
                "failed",
                Some(
                    snapshot
                        .error
                        .unwrap_or_else(|| "应用关闭前任务尚未完成".into()),
                ),
            ),
            Err(error) => ("failed_to_dispatch", "failed", Some(error)),
        };
        let _ = update_run(&db, &run_id, |run| {
            run.dispatch_status = dispatch_status.into();
            run.outcome = Some(outcome.into());
            run.error = error;
            run.finished_at = Some(now_ms());
        })
        .await;
    }
}

pub fn start_worker(app: AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        recover_interrupted_runs(&app).await;
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        interval.tick().await;
        loop {
            interval.tick().await;
            scheduler_tick(&app).await;
        }
    });
}
