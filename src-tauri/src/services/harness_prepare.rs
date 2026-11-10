//! Background SDK boot only: no Agent activation, prompt, receipt or history writes.
use super::{
    canonical_project, existing_markdown_directory, private_root, warm, warm_fingerprint,
    warm_session_configuration, HarnessDesktop, HarnessGateway, HarnessPaths, HarnessRuntime,
    InprocessAgentState, PluginSelection,
};
use crate::{
    services::harness_runtime::{PREPARATION_CANCELLED, PREPARATION_CLEANUP_FAILED},
    store::AppState,
};
use lolicode_agent::AgentSession;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Manager};
use tokio::sync::{watch, Semaphore, SemaphorePermit};

const MAX_PREPARING: usize = 2;
static PREPARATION_SLOTS: Semaphore = Semaphore::const_new(MAX_PREPARING);

#[derive(Clone)]
pub(super) struct Preparation {
    token: Arc<()>,
    cancel: watch::Sender<bool>,
    done: watch::Receiver<Option<Result<(), String>>>,
}

impl Preparation {
    fn cancel(&self) {
        self.cancel.send_replace(true);
    }

    async fn wait(&self) -> Result<(), String> {
        let mut done = self.done.clone();
        loop {
            if let Some(result) = done.borrow_and_update().clone() {
                return result;
            }
            done.changed()
                .await
                .map_err(|_| "Harness 会话准备未完成".to_owned())?;
        }
    }
}

pub(super) fn boot_fingerprint(
    session: &Value,
    route: &str,
    version: &str,
    plugins: &Option<PluginSelection>,
) -> Result<String, String> {
    warm_fingerprint(session, route, version, plugins, &Value::Null, &Value::Null)
}

/// Register promptly. The worker owns cancellation through confirmed shutdown.
pub(super) async fn prepare(
    desktop: &HarnessDesktop,
    app: &AppHandle,
    carrier: &InprocessAgentState,
    id: &str,
) -> Result<(), String> {
    carrier.ensure_started(app).await?;
    let _admission = carrier.lock_harness_admission().await;
    let profile = canonical_project(&crate::config::get_app_config_dir().to_string_lossy())?;
    let root = private_root(&profile, id).ok_or("无效的 Harness 会话编号")?;
    let mut session: AgentSession = carrier
        .call("getSessionMetadata", json!({"sessionId":id}), false)
        .await?;
    crate::commands::agent_dispatch::decorate(app, &mut session)?;
    if session.archived || session.coordination.is_some() {
        return Ok(());
    }
    let project = canonical_project(&session.project_path)?;
    if carrier
        .remote_projects(&app.state::<AppState>())
        .await
        .owns(&project)
    {
        return Ok(());
    }
    let automatic_title = carrier.automatic_title_allowed(id).await?;
    let paths = HarnessPaths::resolve(app)?;
    let plugins = Some(PluginSelection::load(&profile)?);
    let mut configuration = warm_session_configuration(&session)?;
    configuration["automaticTitle"] = json!(automatic_title);
    let (cancel, cancelled) = watch::channel(false);
    let (finished, done) = watch::channel(None);
    let preparation = Preparation {
        token: Arc::new(()),
        cancel,
        done,
    };
    let previous = {
        let mut state = desktop.0.lock().await;
        if state.closing {
            return Err("Harness 正在关闭".into());
        }
        for (other_id, other) in &state.preparing {
            if other_id != id {
                other.cancel();
            }
        }
        if state.flights.contains_key(id) || state.warm.has_ready(id) {
            return Ok(());
        }
        if state
            .preparing
            .get(id)
            .is_some_and(|current| !*current.cancel.borrow())
        {
            return Ok(());
        }
        state.preparing.insert(id.to_owned(), preparation.clone())
    };
    let desktop = desktop.clone();
    let app = app.clone();
    let id = id.to_owned();
    tokio::spawn(async move {
        let started = tokio::time::Instant::now();
        // A replacement for this same owner must release its predecessor first.
        // Different owners can immediately use the second bounded boot slot.
        let previous_result = match previous {
            Some(previous) => previous.wait().await,
            None => Ok(()),
        };
        let result = async {
            previous_result?;
            check_cancelled(&cancelled)?;
            let permit = acquire_slot(&PREPARATION_SLOTS, cancelled.clone()).await?;
            check_cancelled(&cancelled)?;
            let old = desktop.0.lock().await.warm.remove(&id);
            if let Some(old) = old {
                old.retire().await.map_err(cleanup_error)?;
            }
            check_cancelled(&cancelled)?;
            let accounts = tokio::select! {
                biased;
                _ = cancellation(cancelled.clone()) => return Err(PREPARATION_CANCELLED.into()),
                accounts = crate::commands::agent_dispatch::accounts(&app) => accounts?,
            };
            log::info!(target: "lolicode::harness_prepare", "background_stage=accounts elapsed_ms={}", started.elapsed().as_millis());
            check_cancelled(&cancelled)?;
            let state = app.state::<AppState>();
            let model = session
                .model
                .as_ref()
                .map(|model| format!("{}/{}", model.provider_id, model.model_id))
                .ok_or("请先选择模型")?;
            // Channel changes may own apply_lock while waiting for this
            // preparation to retire. No child exists yet, so cancellation can
            // safely drop gateway preparation and release its RAII guards.
            let mut gateway = tokio::select! {
                biased;
                _ = cancellation(cancelled.clone()) => return Err(PREPARATION_CANCELLED.into()),
                gateway = HarnessGateway::open(&state, &model, &id, &accounts) => gateway?,
            };
            log::info!(target: "lolicode::harness_prepare", "background_stage=gateway elapsed_ms={}", started.elapsed().as_millis());
            let home = prepare_home(&profile, &root)?;
            if automatic_title {
                gateway
                    .profile_patch
                    .as_array_mut()
                    .ok_or("Harness 渠道配置无效")?
                    .push(json!({"id":"session-title-llm","disabled":false}));
            }
            let fingerprint = boot_fingerprint(
                &configuration,
                &gateway.reuse_fingerprint,
                &paths.version,
                &plugins,
            )?;
            let patches = plugins
                .as_ref()
                .map_or_else(Vec::new, |plugins| plugins.patches(&paths));
            let born_at = tokio::time::Instant::now();
            let (client, events) = HarnessRuntime::start_live_cancellable(
                &paths.node,
                &paths.package,
                &project,
                &home,
                gateway,
                &patches,
                cancelled.clone(),
            )
            .await?;
            log::info!(target: "lolicode::harness_prepare", "background_stage=initialized elapsed_ms={}", started.elapsed().as_millis());
            let runtime = warm::WarmRuntime {
                client,
                events,
                born_at,
                fingerprint,
                configured: false,
            };
            // Load the official observation and provider modules now. They are
            // lazy otherwise, and must not delay the first submitted message.
            let prepared = tokio::select! {
                biased;
                _ = cancellation(cancelled.clone()) => Err(PREPARATION_CANCELLED.to_owned()),
                result = runtime.client.request("lolicode/runtime/prepare", json!({})) => result,
            };
            if let Err(error) = prepared {
                runtime.retire().await.map_err(cleanup_error)?;
                return Err(error);
            }
            log::info!(target: "lolicode::harness_prepare", "background_stage=dependencies_ready elapsed_ms={}", started.elapsed().as_millis());
            let (retired, discard) = {
                let mut state = desktop.0.lock().await;
                let current = state
                    .preparing
                    .get(&id)
                    .is_some_and(|current| Arc::ptr_eq(&current.token, &preparation.token));
                if !*cancelled.borrow()
                    && !state.closing
                    && current
                    && !state.flights.contains_key(&id)
                {
                    (state.warm.insert(id.clone(), runtime), None)
                } else {
                    (Vec::new(), Some(runtime))
                }
            };
            let mut retirement_failure = None;
            for retired in retired {
                if let Err(error) = retired.retire().await {
                    retirement_failure.get_or_insert(cleanup_error(error));
                }
            }
            if let Some(runtime) = discard {
                runtime.retire().await.map_err(cleanup_error)?;
            }
            if let Some(error) = retirement_failure {
                return Err(error);
            }
            drop(permit);
            check_cancelled(&cancelled)
        }
        .await;
        // Completion is published only after cancellation and retired writers
        // have finished cleanup. A failed boot never leaves a ready cache entry.
        let result = match result {
            Err(error) if error == PREPARATION_CANCELLED => Ok(()),
            other => other,
        };
        let mut state = desktop.0.lock().await;
        if !is_cleanup_failure(&result)
            && state
                .preparing
                .get(&id)
                .is_some_and(|current| Arc::ptr_eq(&current.token, &preparation.token))
        {
            state.preparing.remove(&id);
        }
        finished.send_replace(Some(result));
    });
    Ok(())
}

pub(super) async fn wait_preparation(desktop: &HarnessDesktop, id: &str) -> Result<(), String> {
    let preparation = desktop.0.lock().await.preparing.get(id).cloned();
    if let Some(preparation) = preparation {
        preparation.wait().await?;
    }
    Ok(())
}

pub(super) async fn retire_preparations(
    desktop: &HarnessDesktop,
    id: Option<&str>,
) -> Result<(), String> {
    let preparations = {
        let mut state = desktop.0.lock().await;
        match id {
            Some(id) => state
                .preparing
                .remove(id)
                .map(|preparation| (id.to_owned(), preparation))
                .into_iter()
                .collect::<Vec<_>>(),
            None => state.preparing.drain().collect(),
        }
    };
    for (_, preparation) in &preparations {
        preparation.cancel();
    }
    let mut failure = None;
    for (id, preparation) in preparations {
        let result = preparation.wait().await;
        if is_cleanup_failure(&result) {
            desktop
                .0
                .lock()
                .await
                .preparing
                .entry(id)
                .or_insert(preparation);
        }
        if let Err(error) = result {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

fn check_cancelled(cancel: &watch::Receiver<bool>) -> Result<(), String> {
    if *cancel.borrow() {
        Err(PREPARATION_CANCELLED.into())
    } else {
        Ok(())
    }
}

async fn cancellation(mut cancel: watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

async fn acquire_slot(
    slots: &Semaphore,
    cancel: watch::Receiver<bool>,
) -> Result<SemaphorePermit<'_>, String> {
    tokio::select! {
        biased;
        _ = cancellation(cancel) => Err(PREPARATION_CANCELLED.into()),
        permit = slots.acquire() => permit.map_err(|_| "Harness 准备队列不可用".to_owned()),
    }
}

fn prepare_home(profile: &Path, root: &Path) -> Result<PathBuf, String> {
    let home = root.join("home");
    let relative = home
        .strip_prefix(profile)
        .map_err(|_| "Harness 数据目录超出当前配置范围")?;
    let mut current = profile.to_path_buf();
    existing_markdown_directory(&current)?.ok_or("Harness 配置目录不存在")?;
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("Harness 数据目录无效".into());
        }
        // Validate the complete existing parent chain before creating one
        // directory. Neither create_dir_all nor Node may follow a junction.
        existing_markdown_directory(&current)?.ok_or("Harness 数据目录不存在")?;
        current.push(component.as_os_str());
        if existing_markdown_directory(&current)?.is_none() {
            match std::fs::create_dir(&current) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err("无法准备 Harness 会话目录".into()),
            }
        }
        existing_markdown_directory(&current)?.ok_or("Harness 数据目录不存在")?;
    }
    Ok(home)
}

fn cleanup_error(error: String) -> String {
    format!("{PREPARATION_CLEANUP_FAILED}: {error}")
}

fn is_cleanup_failure(result: &Result<(), String>) -> bool {
    matches!(result, Err(error) if error.starts_with(PREPARATION_CLEANUP_FAILED))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_cancelled_queue_entry_does_not_wait_for_an_unavailable_boot_slot() {
        let slots = Arc::new(Semaphore::new(0));
        let (cancel, cancelled) = watch::channel(false);
        let waiter_slots = slots.clone();
        let waiter =
            tokio::spawn(async move { acquire_slot(&waiter_slots, cancelled).await.map(drop) });
        tokio::task::yield_now().await;
        cancel.send_replace(true);
        assert!(matches!(waiter.await.unwrap(), Err(error) if error == PREPARATION_CANCELLED));
        assert_eq!(slots.available_permits(), 0);
    }

    #[tokio::test]
    async fn cancellation_does_not_acknowledge_cleanup_before_the_worker_finishes() {
        let (cancel, _) = watch::channel(false);
        let (finished, done) = watch::channel(None);
        let preparation = Preparation {
            token: Arc::new(()),
            cancel,
            done,
        };
        preparation.cancel();
        let waiting = tokio::spawn(async move { preparation.wait().await });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        finished.send_replace(Some(Err("SDK shutdown unconfirmed".into())));
        assert!(
            matches!(waiting.await.unwrap(), Err(error) if error == "SDK shutdown unconfirmed")
        );
    }

    #[test]
    fn creating_a_boot_home_does_not_create_chat_logs_or_desktop_receipts() {
        let temporary = tempfile::tempdir().unwrap();
        let profile = canonical_project(&temporary.path().to_string_lossy()).unwrap();
        let root = private_root(&profile, "lc:12345678-1234-4234-8234-123456789abc").unwrap();
        let home = prepare_home(&profile, &root).unwrap();
        assert!(home.is_dir());
        assert!(!root.join("desktop.json").exists());
        assert!(!home.join("sessions").exists());
        assert!(prepare_home(&profile, &profile.parent().unwrap().join("outside")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn boot_home_rejects_an_existing_symlink_before_creating_any_external_child() {
        let temporary = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let profile = canonical_project(&temporary.path().to_string_lossy()).unwrap();
        std::fs::create_dir(profile.join("agent")).unwrap();
        std::os::unix::fs::symlink(external.path(), profile.join("agent/harness-desktop")).unwrap();
        let root = private_root(&profile, "lc:12345678-1234-4234-8234-123456789abc").unwrap();
        assert!(prepare_home(&profile, &root).is_err());
        assert_eq!(std::fs::read_dir(external.path()).unwrap().count(), 0);
    }

    #[test]
    fn boot_key_keeps_the_automatic_title_capability_in_its_identity() {
        let disabled = json!({"id":"owner","automaticTitle":false});
        let enabled = json!({"id":"owner","automaticTitle":true});
        assert_ne!(
            boot_fingerprint(&disabled, "route", "version", &None).unwrap(),
            boot_fingerprint(&enabled, "route", "version", &None).unwrap()
        );
    }

    #[test]
    fn only_unconfirmed_cleanup_keeps_a_failed_preparation_as_a_barrier() {
        assert!(!is_cleanup_failure(&Err("暂时没有可用模型".into())));
        assert!(!is_cleanup_failure(&Ok(())));
        assert!(is_cleanup_failure(&Err(cleanup_error(
            "unconfirmed process exit".into()
        ))));
    }
}
