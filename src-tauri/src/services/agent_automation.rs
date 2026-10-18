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
use futures::future::BoxFuture;
use lolicode_agent::{AgentSession, AgentSnapshot, AgentStatus};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
#[cfg(test)]
#[path = "agent_automation_tests.rs"]
mod integration_tests;

const STORE_KEY: &str = "lolicode_agent_automations_v1";
const MAX_JOBS: usize = 500;
const MAX_RUNS: usize = 2_000;

/// Shared execution boundary for desktop scheduling and isolated acceptance.
/// The desktop adapter retains ownership of accounts, project binding and native
/// permissions; the scheduler never embeds another Agent runtime.
pub trait AutomationRuntime: Send + Sync {
    fn bind_project<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<AgentCatalog, String>>;
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        mutate: bool,
    ) -> BoxFuture<'a, Result<Value, String>>;
}

struct DesktopAutomationRuntime(AppHandle);

impl AutomationRuntime for DesktopAutomationRuntime {
    fn bind_project<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<AgentCatalog, String>> {
        Box::pin(async move {
            let state = self.0.state::<AppState>();
            let accounts = agent_dispatch::accounts(&self.0).await?;
            self.0
                .state::<InprocessAgentState>()
                .bind_background_project(&self.0, &state, path.into(), accounts)
                .await
        })
    }

    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        mutate: bool,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let carrier = self.0.state::<InprocessAgentState>();
            if method == "busy" {
                carrier.ensure_started(&self.0).await?;
            }
            carrier.call(method, params, mutate).await
        })
    }
}

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
    #[serde(default = "scheduled_trigger")]
    trigger: String,
    #[serde(default = "default_idle_minutes")]
    idle_after_minutes: u64,
    #[serde(default = "default_idle_interval")]
    idle_interval_minutes: u64,
    #[serde(default = "default_locale")]
    locale: String,
    #[serde(default)]
    last_error: Option<String>,
}

fn scheduled_trigger() -> String {
    "schedule".into()
}
fn default_idle_minutes() -> u64 {
    10
}
fn default_idle_interval() -> u64 {
    60
}
fn default_locale() -> String {
    "zh".into()
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
    #[serde(default)]
    cancel_requested: bool,
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

/// System input inactivity, rather than an unfocused window or a quiet Agent.
/// Missing platform support is surfaced on the job; it never runs by guessing.
#[cfg(any(target_os = "linux", test))]
fn validate_x11_idle_session(
    session_type: Option<&std::ffi::OsStr>,
    wayland_display: Option<&std::ffi::OsStr>,
) -> Result<(), String> {
    if session_type.is_some_and(|value| {
        value
            .to_string_lossy()
            .trim()
            .eq_ignore_ascii_case("wayland")
    }) || wayland_display.is_some_and(|value| !value.is_empty())
    {
        return Err("Wayland 暂不支持系统闲置检测，闲时任务已等待".into());
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn parse_ioreg_idle(success: bool, stdout: &[u8]) -> Result<u64, String> {
    if !success {
        return Err("无法读取系统闲置时间，闲时任务已等待".into());
    }
    String::from_utf8_lossy(stdout)
        .lines()
        .find_map(|line| {
            line.split_once("\"HIDIdleTime\" = ")
                .and_then(|(_, value)| value.trim().parse::<u64>().ok())
        })
        .map(|nanoseconds| nanoseconds / 1_000_000)
        .ok_or_else(|| "系统未提供闲置时间，闲时任务已等待".into())
}

pub async fn system_idle_ms() -> Result<u64, String> {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct LastInputInfo {
            size: u32,
            tick: u32,
        }
        #[link(name = "user32")]
        extern "system" {
            fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetTickCount() -> u32;
        }
        let mut info = LastInputInfo {
            size: std::mem::size_of::<LastInputInfo>() as u32,
            tick: 0,
        };
        // The Win32 function writes only this correctly sized stack structure.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return Err("无法读取系统闲置时间".into());
        }
        Ok(unsafe { GetTickCount() }.wrapping_sub(info.tick) as u64)
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = tokio::process::Command::new("/usr/sbin/ioreg");
        command.args(["-c", "IOHIDSystem", "-d", "4"]);
        command.kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(3), command.output())
            .await
            .map_err(|_| "读取系统闲置时间超时")?
            .map_err(|_| "无法读取系统闲置时间")?;
        parse_ioreg_idle(output.status.success(), &output.stdout)
    }
    #[cfg(target_os = "linux")]
    {
        validate_x11_idle_session(
            std::env::var_os("XDG_SESSION_TYPE").as_deref(),
            std::env::var_os("WAYLAND_DISPLAY").as_deref(),
        )?;
        let mut command = tokio::process::Command::new("xprintidle");
        command.kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(3), command.output())
            .await
            .map_err(|_| "读取系统闲置时间超时")?
            .map_err(|_| "当前桌面未提供闲置检测（X11 可安装 xprintidle；Wayland 暂不支持）")?;
        if !output.status.success() {
            return Err("当前桌面不支持闲置检测，闲时任务已等待".into());
        }
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .map_err(|_| "无法读取系统闲置时间".into())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("此系统尚未提供闲置检测，闲时任务已等待".into())
}

fn idle_ready(job: &Job, idle: Result<u64, &str>, agent_busy: bool) -> Result<bool, String> {
    let elapsed = idle.map_err(str::to_owned)?;
    Ok(!agent_busy && elapsed >= job.idle_after_minutes.saturating_mul(60_000))
}

fn next_for_job(job: &Job, now: u64) -> Result<u64, String> {
    if job.trigger == "idle" {
        Ok(now.saturating_add(job.idle_interval_minutes.saturating_mul(60_000)))
    } else {
        next_run_at(&job.cron_expr, now)
    }
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
    registered_project_in_db(&state.db, path)
}

fn registered_project_in_db(
    db: &crate::database::Database,
    path: &str,
) -> Result<AgentProject, String> {
    let projects = preferences::load(db)?;
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

fn validate_job(
    value: &Value,
    workspace: String,
    db: &crate::database::Database,
) -> Result<Job, String> {
    registered_project_in_db(db, &workspace)?;
    let title = value["title"].as_str().unwrap_or_default().trim();
    let prompt = value["prompt"].as_str().unwrap_or_default().trim();
    if title.is_empty()
        || title.chars().count() > 160
        || prompt.is_empty()
        || prompt.len() > 64 * 1024
    {
        return Err("请填写名称和任务内容（名称不超过 160 字，任务不超过 64 KiB）".into());
    }
    let trigger = value["trigger"].as_str().unwrap_or("schedule");
    if !matches!(trigger, "schedule" | "idle") {
        return Err("自动化触发方式无效".into());
    }
    let cron_expr = value["cronExpr"].as_str().unwrap_or("0 * * * *").trim();
    cron_parts(cron_expr)?;
    let idle_after_minutes = value["idleAfterMinutes"].as_u64().unwrap_or(10);
    let idle_interval_minutes = value["idleIntervalMinutes"].as_u64().unwrap_or(60);
    if ["idleAfterMinutes", "idleIntervalMinutes"]
        .iter()
        .any(|key| value.get(key).is_some_and(|value| value.as_u64().is_none()))
    {
        return Err("闲置分钟和运行间隔必须是整数".into());
    }
    if !(1..=1440).contains(&idle_after_minutes) || !(1..=10080).contains(&idle_interval_minutes) {
        return Err("闲置时间需为 1–1440 分钟，运行间隔需为 1–10080 分钟".into());
    }
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
        next_run_at: Some(if trigger == "idle" {
            now
        } else {
            next_run_at(cron_expr, now)?
        }),
        created_at: now,
        updated_at: now,
        trigger: trigger.into(),
        idle_after_minutes,
        idle_interval_minutes,
        locale: value["locale"]
            .as_str()
            .and_then(|locale| locale.split('-').next())
            .filter(|locale| matches!(*locale, "zh" | "en" | "ja"))
            .unwrap_or("zh")
            .into(),
        last_error: None,
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
        cancel_requested: false,
    };
    store.runs.push(run.clone());
    while store.runs.len() > MAX_RUNS {
        if let Some(index) = store.runs.iter().position(|run| !active(run)) {
            store.runs.remove(index);
        } else {
            break;
        }
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
    let db = app.state::<AppState>().db.clone();
    let runtime: Arc<dyn AutomationRuntime> = Arc::new(DesktopAutomationRuntime(app));
    dispatch_with_runtime(runtime, db, job, run).await;
}

async fn dispatch_with_runtime(
    runtime: Arc<dyn AutomationRuntime>,
    db: Arc<crate::database::Database>,
    job: Job,
    run: Run,
) {
    let run_id = run.run_id.clone();
    if let Some(session_id) = dispatch_run(runtime.clone(), db.clone(), job, run).await {
        tauri::async_runtime::spawn(async move {
            monitor_run(runtime, db, run_id, session_id).await;
        });
    }
}

async fn dispatch_run(
    runtime: Arc<dyn AutomationRuntime>,
    db: Arc<crate::database::Database>,
    job: Job,
    run: Run,
) -> Option<String> {
    let result = async {
        if load(&db)?
            .runs
            .iter()
            .find(|item| item.run_id == run.run_id)
            .is_none_or(|item| item.cancel_requested)
        {
            return Err("任务已取消".into());
        }
        let workspace = registered_project_in_db(&db, &job.workspace_path)?;
        if preferences::path_key(&workspace.path) != preferences::path_key(&job.workspace_path) {
            return Err("工作区路径已变化，请重新打开项目".to_string());
        }
        let catalog = runtime.bind_project(&job.workspace_path).await?;
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
        let session: AgentSession = serde_json::from_value(
            runtime
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
                .await?,
        )
        .map_err(|_| "自动化会话回执无效".to_string())?;
        update_run(&db, &run.run_id, |record| {
            record.dispatch_status = "running".into();
            record.session_id = Some(session.id.clone());
        })
        .await?;
        // Serialize the final cancellation check and send acknowledgement. An
        // interrupt cannot race ahead of the engine creating its flight.
        let send_guard = mutation_lock().lock().await;
        if load(&db)?
            .runs
            .iter()
            .find(|item| item.run_id == run.run_id)
            .is_none_or(|item| item.cancel_requested)
        {
            return Err("任务已取消".into());
        }
        runtime
            .call(
                "sendMessage",
                json!({
                    "sessionId": session.id,
                    "requestId": format!("automation:{}", run.run_id),
                    "text": job.prompt,
                    "locale": job.locale,
                }),
                true,
            )
            .await?;
        drop(send_guard);
        update_run(&db, &run.run_id, |record| {
            record.dispatch_status = "dispatched".into();
        })
        .await?;
        Ok::<AgentSession, String>(session)
    }
    .await;

    match result {
        Ok(session) => Some(session.id),
        Err(error) => {
            let detail = error.clone();
            let _ = update_run(&db, &run.run_id, |record| {
                record.dispatch_status = "failed_to_dispatch".into();
                record.outcome = Some(
                    if record.cancel_requested {
                        "stopped"
                    } else {
                        "failed"
                    }
                    .into(),
                );
                record.error = if record.cancel_requested {
                    None
                } else {
                    Some(detail)
                };
                record.finished_at = Some(now_ms());
            })
            .await;
            log::warn!("自动化任务派发失败：{error}");
            None
        }
    }
}

async fn command_status(
    carrier: &dyn AutomationRuntime,
    session_id: &str,
    run_id: &str,
) -> Result<Option<String>, String> {
    let result: Value = carrier
        .call(
            "queryCommand",
            json!({"sessionId": session_id, "requestId": format!("automation:{run_id}")}),
            false,
        )
        .await?;
    Ok(result["results"][0]["result"]["status"]
        .as_str()
        .map(str::to_owned))
}

// An idle snapshot alone is not proof of success: cancellation and recovery also
// return an idle session. Persisted command receipts are the terminal authority.
fn terminal_outcome(
    command: Option<&str>,
    cancel_requested: bool,
    snapshot: &AgentSnapshot,
) -> (String, Option<String>) {
    if command == Some("completed") {
        return ("succeeded".into(), None);
    }
    if command == Some("cancelled") {
        return ("stopped".into(), None);
    }
    let error = snapshot.error.clone().unwrap_or_else(|| {
        if cancel_requested {
            "已请求停止，但未收到已停止的命令回执；请核对已有结果后继续".into()
        } else if command.is_none() {
            "此任务尚未被 Agent 接收，可重试运行".into()
        } else {
            "任务未完整结束；已保留会话，可打开后继续".into()
        }
    });
    ("failed".into(), Some(error))
}

async fn monitor_run(
    carrier: Arc<dyn AutomationRuntime>,
    db: Arc<crate::database::Database>,
    run_id: String,
    session_id: String,
) {
    loop {
        let snapshot: Result<AgentSnapshot, String> = carrier
            .call("getSession", json!({"sessionId":session_id}), false)
            .await
            .and_then(|value| {
                serde_json::from_value(value).map_err(|_| "自动化会话状态无效".to_string())
            });
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
                let cancelled = load(&db)
                    .ok()
                    .and_then(|store| store.runs.into_iter().find(|run| run.run_id == run_id))
                    .is_some_and(|run| run.cancel_requested);
                let command = command_status(carrier.as_ref(), &session_id, &run_id)
                    .await
                    .ok()
                    .flatten();
                let (outcome, error) = terminal_outcome(command.as_deref(), cancelled, &snapshot);
                let _ = update_run(&db, &run_id, |run| {
                    run.outcome = Some(outcome);
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

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(trigger: &str, now: u64) -> (Store, preferences::Preferences) {
        let job: Job = serde_json::from_value(json!({"automationId":"owned-job","title":"Fixture","prompt":"Read owned project","workspacePath":"D:/owned/project","cronExpr":"0 * * * *","recurring":true,"mode":"guarded","modelSelection":{"providerId":"fixture","modelId":"fixture"},"enabled":true,"lifecycleStatus":"active","nextRunAt":now,"createdAt":now,"updatedAt":now,"trigger":trigger,"idleAfterMinutes":10,"idleIntervalMinutes":60})).unwrap();
        let mut registered = preferences::Preferences::default();
        registered.projects.insert(
            preferences::path_key(&job.workspace_path),
            AgentProject {
                path: job.workspace_path.clone(),
                name: "fixture".into(),
                pinned: false,
                last_opened_at: now,
            },
        );
        (
            Store {
                jobs: vec![job],
                runs: vec![],
            },
            registered,
        )
    }
    #[test]
    fn automation_idle_waits_for_real_inactivity_and_agent_availability_without_consuming_schedule()
    {
        let now = now_ms();
        let (mut store, registered) = fixture("idle", now);
        assert!(
            claim_due(&mut store, &registered, now, Ok(9 * 60_000), false)
                .0
                .is_empty()
        );
        assert!(
            claim_due(&mut store, &registered, now, Ok(10 * 60_000), true)
                .0
                .is_empty()
        );
        assert_eq!(store.jobs[0].next_run_at, Some(now));
        assert!(claim_due(
            &mut store,
            &registered,
            now,
            Err("UNSUPPORTED_PLATFORM"),
            false
        )
        .0
        .is_empty());
        assert_eq!(
            store.jobs[0].last_error.as_deref(),
            Some("UNSUPPORTED_PLATFORM")
        );
        assert_eq!(
            claim_due(&mut store, &registered, now, Ok(10 * 60_000), false)
                .0
                .len(),
            1
        );
        assert_eq!(store.jobs[0].next_run_at, Some(now + 60 * 60_000));
        assert!(store.jobs[0].last_error.is_none());
        assert!(
            claim_due(
                &mut store,
                &registered,
                now + 60 * 60_000,
                Ok(100 * 60_000),
                false
            )
            .0
            .is_empty(),
            "An active run must not be duplicated"
        );
    }
    #[test]
    fn automation_single_run_missed_schedule_pause_and_restart_receipts_remain_distinct() {
        let now = now_ms();
        let (mut store, registered) = fixture("schedule", now);
        store.jobs[0].recurring = false;
        assert_eq!(
            claim_due(&mut store, &registered, now, Ok(0), false)
                .0
                .len(),
            1
        );
        assert!(!store.jobs[0].enabled);
        assert_eq!(store.jobs[0].next_run_at, None);
        assert!(
            claim_due(&mut store, &registered, now + 60_000, Ok(0), false)
                .0
                .is_empty()
        );
        let (mut missed, registered) = fixture("schedule", now - 121_000);
        assert!(claim_due(&mut missed, &registered, now, Ok(0), false)
            .0
            .is_empty());
        assert_eq!(missed.runs[0].outcome.as_deref(), Some("skipped"));
        assert!(missed.jobs[0].next_run_at.unwrap() > now);
        let db = crate::database::Database::memory().unwrap();
        save(&db, &missed).unwrap();
        let restored = load(&db).unwrap();
        assert_eq!(restored.runs[0].outcome.as_deref(), Some("skipped"));
        assert!(!active(&restored.runs[0]));
    }
    #[test]
    fn automation_idle_tasks_are_serial_and_cannot_run_unregistered_projects() {
        let now = now_ms();
        let (mut store, registered) = fixture("idle", now);
        let mut other = store.jobs[0].clone();
        other.automation_id = "other".into();
        store.jobs.push(other);
        assert_eq!(
            claim_due(&mut store, &registered, now, Ok(10 * 60_000), false)
                .0
                .len(),
            1
        );
        let (mut store, _) = fixture("idle", now);
        assert!(claim_due(
            &mut store,
            &preferences::Preferences::default(),
            now,
            Ok(10 * 60_000),
            false
        )
        .0
        .is_empty());
    }

    #[test]
    fn automation_due_schedule_precedes_idle_independently_of_creation_order() {
        let now = now_ms();
        for idle_first in [true, false] {
            let (mut store, registered) = fixture("idle", now);
            let mut scheduled = store.jobs[0].clone();
            scheduled.automation_id = "scheduled".into();
            scheduled.trigger = "schedule".into();
            if idle_first {
                store.jobs.push(scheduled);
            } else {
                store.jobs.insert(0, scheduled);
            }
            let (due, _) = claim_due(&mut store, &registered, now, Ok(10 * 60_000), false);
            assert_eq!(due.len(), 1);
            assert_eq!(due[0].0.automation_id, "scheduled");
            let idle = store.jobs.iter().find(|job| job.trigger == "idle").unwrap();
            assert_eq!(idle.next_run_at, Some(now));
        }
    }

    #[test]
    fn automation_idle_waits_for_another_claim_even_before_native_flight_exists() {
        let now = now_ms();
        let (mut store, registered) = fixture("idle", now);
        let pending = create_run(&mut store, "another-automation");
        let (due, _) = claim_due(&mut store, &registered, now, Ok(10 * 60_000), false);
        assert!(due.is_empty());
        assert_eq!(store.jobs[0].next_run_at, Some(now));
        let previous = store
            .runs
            .iter_mut()
            .find(|run| run.run_id == pending.run_id)
            .unwrap();
        previous.outcome = Some("succeeded".into());
        previous.finished_at = Some(now);
        assert_eq!(
            claim_due(&mut store, &registered, now, Ok(10 * 60_000), false)
                .0
                .len(),
            1
        );
    }
    #[test]
    fn automation_cron_validation_does_not_silently_rewrite_unsupported_schedules() {
        assert!(cron_parts("0 * * * *").is_ok());
        assert!(cron_parts("35 14 * * 3").is_ok());
        for expr in [
            "61 * * * *",
            "0 24 * * *",
            "0 9 * * 7",
            "*/5 * * * *",
            "0 9 1 * *",
        ] {
            assert!(cron_parts(expr).is_err(), "{expr}");
        }
        let now = now_ms();
        assert!(next_run_at("0 9 * * *", now).unwrap() > now);
    }
    #[test]
    fn automation_history_retention_never_evicts_an_active_run() {
        let now = now_ms();
        let (mut store, _) = fixture("schedule", now);
        let first = create_run(&mut store, "owned-job");
        for index in 1..MAX_RUNS {
            let mut terminal = first.clone();
            terminal.run_id = format!("finished-{index}");
            terminal.outcome = Some("succeeded".into());
            store.runs.push(terminal);
        }
        create_run(&mut store, "another-job");
        assert_eq!(store.runs.len(), MAX_RUNS);
        assert!(store
            .runs
            .iter()
            .any(|run| run.run_id == first.run_id && active(run)));
    }
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn automation_windows_idle_probe_reads_os_without_synthesizing_input() {
        let result = system_idle_ms().await.unwrap();
        assert!(result <= u32::MAX as u64);
        println!("WINDOWS_IDLE_PROBE_OK: system input idle {result} ms");
    }

    #[test]
    fn automation_linux_rejects_wayland_even_when_an_x11_display_exists() {
        use std::ffi::OsStr;
        let x11 = Some(OsStr::new("x11"));
        let wayland = Some(OsStr::new("wayland"));
        let display = Some(OsStr::new("wayland-0"));
        assert!(validate_x11_idle_session(wayland, None).is_err());
        assert!(validate_x11_idle_session(Some(OsStr::new("Wayland")), None).is_err());
        assert!(validate_x11_idle_session(x11, display).is_err());
        assert!(validate_x11_idle_session(None, display).is_err());
        assert!(validate_x11_idle_session(x11, None).is_ok());
        assert!(validate_x11_idle_session(x11, Some(OsStr::new(""))).is_ok());
        assert!(validate_x11_idle_session(None, None).is_ok());
    }

    #[test]
    fn automation_macos_idle_requires_successful_probe_and_valid_nanoseconds() {
        let fixture = b"  |   \"HIDIdleTime\" = 1234567890\n";
        assert_eq!(parse_ioreg_idle(true, fixture).unwrap(), 1234);
        assert!(parse_ioreg_idle(false, fixture).is_err());
        assert!(parse_ioreg_idle(true, b"no idle property").is_err());
        assert!(parse_ioreg_idle(true, b"\"HIDIdleTime\" = invalid").is_err());
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

pub async fn create_saved_job(
    db: &crate::database::Database,
    input: &Value,
) -> Result<Value, String> {
    let workspace = workspace_from_scope(Some(input))?;
    let job = validate_job(input, workspace, db)?;
    let _guard = mutation_lock().lock().await;
    let mut store = load(db)?;
    if store.jobs.len() >= MAX_JOBS {
        return Err("自动化数量达到上限".into());
    }
    store.jobs.push(job.clone());
    save(db, &store)?;
    Ok(json!(job))
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
            create_saved_job(&state.db, input).await
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
                Some(if job.trigger == "idle" {
                    now_ms()
                } else {
                    next_for_job(job, now_ms())?
                })
            } else {
                None
            };
            job.updated_at = now_ms();
            let result = job.clone();
            save(&state.db, &store)?;
            Ok(json!(result))
        }
        "update" => {
            let id = arg(&args, 0, "自动化编号")?
                .as_str()
                .ok_or("自动化编号无效")?;
            let input = arg(&args, 1, "自动化内容")?;
            let workspace = workspace_from_scope(args.get(2))?;
            let replacement = validate_job(input, workspace.clone(), &state.db)?;
            let _guard = mutation_lock().lock().await;
            let mut store = load(&state.db)?;
            let job = find_job_mut(&mut store, id, &workspace)?;
            let enabled = job.enabled;
            let created_at = job.created_at;
            *job = replacement;
            job.automation_id = id.into();
            job.created_at = created_at;
            job.enabled = enabled;
            job.lifecycle_status = if enabled { "active" } else { "paused" }.into();
            if !enabled {
                job.next_run_at = None;
            }
            let result = job.clone();
            save(&state.db, &store)?;
            Ok(json!(result))
        }
        "cancelRun" => {
            let id = arg(&args, 0, "运行编号")?.as_str().ok_or("运行编号无效")?;
            let workspace = workspace_from_scope(args.get(1))?;
            cancel_run_runtime(
                Arc::new(DesktopAutomationRuntime(app.clone())),
                state.db.clone(),
                id,
                &workspace,
            )
            .await
        }
        "idleStatus" => {
            let idle = system_idle_ms().await;
            Ok(match idle {
                Ok(idle) => json!({"supported":true,"idleMs":idle}),
                Err(error) => json!({"supported":false,"reason":error}),
            })
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
            if store
                .runs
                .iter()
                .any(|run| run.automation_id == id && active(run))
            {
                return Err("请先停止正在运行的任务，再删除自动化".into());
            }
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

/// Stop through the same native runtime for local and remote automations.
/// Persist cancellation before interrupting, so a lost acknowledgement never
/// turns a pending cancellation into an automatic resend.
pub async fn cancel_run_runtime(
    runtime: Arc<dyn AutomationRuntime>,
    db: Arc<crate::database::Database>,
    id: &str,
    workspace: &str,
) -> Result<Value, String> {
    registered_project_in_db(&db, workspace)?;
    let session = {
        let _guard = mutation_lock().lock().await;
        let mut store = load(&db)?;
        let record = store
            .runs
            .iter()
            .find(|run| run.run_id == id)
            .ok_or("运行记录不存在")?;
        let job = store
            .jobs
            .iter()
            .find(|job| job.automation_id == record.automation_id)
            .ok_or("自动化任务不存在")?;
        ensure_job_scope(job, workspace)?;
        let record = store.runs.iter_mut().find(|run| run.run_id == id).unwrap();
        if !active(record) {
            return Ok(json!({"status":"finished"}));
        }
        record.cancel_requested = true;
        let session = record.session_id.clone();
        if session.is_none() {
            record.outcome = Some("stopped".into());
            record.dispatch_status = "cancelled".into();
            record.finished_at = Some(now_ms());
        }
        save(&db, &store)?;
        session
    };
    if let Some(session) = session {
        runtime
            .call("interruptSession", json!({"sessionId":session}), false)
            .await?;
    }
    Ok(json!({"status":"stopping"}))
}

fn claim_due(
    store: &mut Store,
    registered: &preferences::Preferences,
    now: u64,
    idle: Result<u64, &str>,
    agent_busy: bool,
) -> (Vec<(Job, Run)>, bool) {
    let mut due = Vec::new();
    let mut changed = false;
    // Scheduled work gets first claim regardless of creation order. An idle job
    // must not be dispatched alongside a due scheduled task in this same tick.
    let mut indexes: Vec<_> = (0..store.jobs.len()).collect();
    indexes.sort_by_key(|index| store.jobs[*index].trigger == "idle");
    for index in indexes {
        let job = &store.jobs[index];
        if !job.enabled || job.next_run_at.is_some_and(|next| next > now) {
            continue;
        }
        if job.next_run_at.is_none() && job.trigger != "idle" {
            store.jobs[index].next_run_at = next_for_job(job, now).ok();
            changed = true;
            continue;
        }
        if !registered
            .projects
            .contains_key(&preferences::path_key(&job.workspace_path))
        {
            continue;
        }
        if store
            .runs
            .iter()
            .any(|run| run.automation_id == job.automation_id && active(run))
        {
            continue;
        }
        if job.trigger == "idle" {
            // One idle task at a time, and no contention with an active main
            // Agent. A deferred idle job keeps its due timestamp.
            let any_claimed = store.runs.iter().any(active);
            match idle_ready(job, idle, agent_busy || !due.is_empty() || any_claimed) {
                Ok(true) => {}
                Ok(false) => continue,
                Err(error) => {
                    if store.jobs[index].last_error.as_ref() != Some(&error) {
                        store.jobs[index].last_error = Some(error);
                        changed = true;
                    }
                    continue;
                }
            }
        } else if job
            .next_run_at
            .is_some_and(|next| now.saturating_sub(next) > 120_000)
        {
            let id = job.automation_id.clone();
            let next = next_for_job(job, now).ok();
            let run = create_run(store, &id);
            let record = store
                .runs
                .iter_mut()
                .find(|record| record.run_id == run.run_id)
                .unwrap();
            record.dispatch_status = "skipped".into();
            record.outcome = Some("skipped".into());
            record.error = Some("应用关闭或系统休眠期间错过本次计划，等待下次运行".into());
            record.finished_at = Some(now);
            if store.jobs[index].recurring {
                store.jobs[index].next_run_at = next;
            } else {
                store.jobs[index].next_run_at = None;
                store.jobs[index].enabled = false;
                store.jobs[index].lifecycle_status = "completed".into();
            }
            changed = true;
            continue;
        }
        let job = store.jobs[index].clone();
        let run = create_run(store, &job.automation_id);
        let current = &mut store.jobs[index];
        current.last_error = None;
        current.updated_at = now;
        if current.recurring {
            current.next_run_at = next_for_job(current, now).ok();
        } else {
            current.next_run_at = None;
            current.enabled = false;
            current.lifecycle_status = "completed".into();
        }
        due.push((job, run));
        changed = true;
    }
    (due, changed)
}

async fn scheduler_tick(app: &AppHandle) {
    let db = app.state::<AppState>().db.clone();
    let runtime: Arc<dyn AutomationRuntime> = Arc::new(DesktopAutomationRuntime(app.clone()));
    if let Err(error) = scheduler_tick_runtime(runtime, db).await {
        log::warn!("自动化计划检查失败：{error}");
    }
}

pub async fn scheduler_tick_runtime(
    runtime: Arc<dyn AutomationRuntime>,
    db: Arc<crate::database::Database>,
) -> Result<Vec<String>, String> {
    let has_idle = load(&db)?
        .jobs
        .iter()
        .any(|job| job.enabled && job.trigger == "idle");
    let idle = if has_idle {
        system_idle_ms().await
    } else {
        Ok(0)
    };
    let agent_busy = if has_idle {
        runtime
            .call("busy", json!({}), false)
            .await
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(true)
    } else {
        false
    };
    let due = {
        let _guard = mutation_lock().lock().await;
        let mut store = load(&db)?;
        let registered = preferences::load(&db)?;
        let (due, changed) = claim_due(
            &mut store,
            &registered,
            now_ms(),
            idle.as_ref().copied().map_err(String::as_str),
            agent_busy,
        );
        if changed {
            save(&db, &store)?;
        }
        due
    };
    let run_ids = due.iter().map(|(_, run)| run.run_id.clone()).collect();
    for (job, run) in due {
        let runtime = runtime.clone();
        let db = db.clone();
        tauri::async_runtime::spawn(
            async move { dispatch_with_runtime(runtime, db, job, run).await },
        );
    }
    Ok(run_ids)
}

async fn recover_interrupted_runs(app: &AppHandle) {
    let db = app.state::<AppState>().db.clone();
    match load(&db) {
        Ok(store) if !store.runs.iter().any(active) => return,
        Err(error) => {
            log::warn!("自动化运行记录恢复失败：{error}");
            return;
        }
        _ => {}
    }
    if let Err(error) = app.state::<InprocessAgentState>().ensure_started(app).await {
        log::warn!("自动化恢复启动失败：{error}");
        // The runtime will report the unavailable carrier below; records remain
        // terminal and never replay a model request on startup.
    }
    recover_runs_runtime(Arc::new(DesktopAutomationRuntime(app.clone())), db).await;
}

/// Reconcile persisted receipts after opening the native store; never dispatch.
pub async fn recover_runs_runtime(
    runtime: Arc<dyn AutomationRuntime>,
    db: Arc<crate::database::Database>,
) {
    let runs = {
        let _guard = mutation_lock().lock().await;
        match load(&db) {
            Ok(store) => store
                .runs
                .into_iter()
                .filter(active)
                .map(|run| (run.run_id, run.session_id, run.cancel_requested))
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

    for (run_id, session_id, cancel_requested) in runs {
        let result: Result<AgentSnapshot, String> = match session_id.as_deref() {
            Some(session_id) => runtime
                .call("getSession", json!({"sessionId":session_id}), false)
                .await
                .and_then(|value| {
                    serde_json::from_value(value).map_err(|_| "自动化会话状态无效".to_string())
                }),
            None => Err("会话尚未创建".into()),
        };
        // A recovered carrier may already own a live flight (for example,
        // foreground startup racing the worker). Reattach monitoring instead of
        // falsely recording failure or replaying the prompt.
        if result.as_ref().is_ok_and(|snapshot| {
            matches!(
                snapshot.status,
                AgentStatus::Running
                    | AgentStatus::WaitingPermission
                    | AgentStatus::WaitingQuestion
            )
        }) {
            if let Some(id) = session_id {
                if cancel_requested {
                    if runtime
                        .call("interruptSession", json!({"sessionId":id}), false)
                        .await
                        .is_err()
                    {
                        // Keep cancellation pending for the next recovery attempt.
                        continue;
                    }
                }
                let runtime = runtime.clone();
                let db = db.clone();
                tauri::async_runtime::spawn(async move {
                    monitor_run(runtime, db, run_id, id).await;
                });
                continue;
            }
        }
        let (dispatch_status, outcome, error) = match result {
            Ok(snapshot) => {
                let command = match session_id.as_deref() {
                    Some(id) => command_status(runtime.as_ref(), id, &run_id)
                        .await
                        .ok()
                        .flatten(),
                    None => None,
                };
                let (outcome, error) =
                    terminal_outcome(command.as_deref(), cancel_requested, &snapshot);
                ("dispatched", outcome, error)
            }
            Err(error) => (
                "failed_to_dispatch",
                if cancel_requested {
                    "stopped"
                } else {
                    "failed"
                }
                .into(),
                Some(error),
            ),
        };
        let _ = update_run(&db, &run_id, |run| {
            run.dispatch_status = dispatch_status.into();
            run.outcome = Some(outcome);
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
