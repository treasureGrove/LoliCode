//! Desktop host for the upstream Harness session process.
#[path = "harness_prepare.rs"]
mod prepare;
#[path = "harness_warm.rs"]
mod warm;
#[cfg(test)]
#[path = "harness_warm_tests.rs"]
mod warm_tests;
use super::{
    agent_browser::BrowserTools,
    agent_host::canonical_project,
    harness_events::{HarnessEvents, HarnessTurnOutcome, PreviewSource},
    harness_gateway::HarnessGateway,
    harness_mcp::{self, HarnessMcp, McpCall},
    harness_migration::{HarnessMigration, LegacySession, MigrationState},
    harness_paths::HarnessPaths,
    harness_plugins::PluginSelection,
    harness_preview::HarnessPreview,
    harness_questions::{answer_for_question, question_from_params},
    harness_runtime::{
        native_read_request, read_cold_session_markdown, read_cold_session_native, HarnessClient,
        HarnessEvent, HarnessHostRequest, HarnessNativeSubscription, HarnessRuntime,
        MARKDOWN_MISSING, NATIVE_MISSING,
    },
    harness_secretary::{HarnessSecretary, SecretaryCommand, SecretarySidebar, WorkerAction},
    harness_sessions::activity,
    harness_snapshot::{is_live_message, HarnessSnapshotProjection},
    inprocess_agent::InprocessAgentState,
    native_mcp::NativeMcpTools,
};
use crate::{config, store::AppState};
use lolicode_agent::{
    AgentMessage, AgentPart, AgentPermission, AgentPreviewRequest, AgentPreviewTarget,
    AgentQuestion, AgentQueuedMessage, AgentSecretaryState, AgentSession, AgentSnapshot,
    AgentStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex, OnceLock,
    },
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, WebviewWindow};
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use uuid::Uuid;

const INTERRUPTED: &str = "上次 Harness 会话中断，已保留已确认的历史。";
const MAX_RECEIPTS: usize = 4096;
const SNAPSHOT_EVENT: &str = "agent-session-update";
const AUTOMATIC_TITLE_GRACE: Duration = Duration::from_secs(6);
const LEGACY_MARKDOWN: &str = "旧引擎迁移会话的完整历史不在原生 Harness 日志中，无法复制完整历史";
const NATIVE_LEGACY_HISTORY: &str = "LOLICODE_SESSION_LEGACY_HISTORY";

#[derive(Clone, Default)]
pub(crate) struct HarnessDesktop(Arc<Mutex<DesktopState>>);

#[derive(Default)]
struct DesktopState {
    flights: HashMap<String, Flight>,
    warm: warm::IdleCache,
    preparing: HashMap<String, prepare::Preparation>,
    early_stops: BTreeSet<(String, String)>,
    closing: bool,
}

struct SessionSidebar {
    updated_at: u64,
    status: AgentStatus,
    secretary: Option<SecretarySidebar>,
}

type SidebarEntry = Arc<OnceLock<Option<Arc<SessionSidebar>>>>;
static SIDEBAR_CACHE: OnceLock<StdMutex<HashMap<PathBuf, SidebarEntry>>> = OnceLock::new();

#[derive(Default)]
struct NativeViewWatches {
    entries: HashMap<(String, String), NativeViewWatch>,
    windows: BTreeSet<String>,
}

struct NativeViewWatch {
    serial: Uuid,
    cancel: watch::Sender<bool>,
    ack: watch::Sender<u64>,
    expected: Arc<AtomicU64>,
}

static NATIVE_VIEW_WATCHES: OnceLock<StdMutex<NativeViewWatches>> = OnceLock::new();

struct NativeViewWatchGuard {
    key: (String, String),
    serial: Uuid,
}

struct NativeViewRegistration {
    guard: NativeViewWatchGuard,
    cancelled: watch::Receiver<bool>,
    acknowledged: watch::Receiver<u64>,
    expected: Arc<AtomicU64>,
}

impl Drop for NativeViewWatchGuard {
    fn drop(&mut self) {
        let mut watches = NATIVE_VIEW_WATCHES
            .get_or_init(Default::default)
            .lock()
            .unwrap();
        if watches
            .entries
            .get(&self.key)
            .is_some_and(|watch| watch.serial == self.serial)
        {
            watches.entries.remove(&self.key);
        }
    }
}

fn register_native_view(
    window: &WebviewWindow,
    id: &str,
) -> Result<NativeViewRegistration, String> {
    if Uuid::parse_str(id).is_err() {
        return Err("原生会话订阅编号无效".into());
    }
    let key = (window.label().to_owned(), id.to_owned());
    let serial = Uuid::new_v4();
    let (cancel, cancelled) = watch::channel(false);
    let (ack, acknowledged) = watch::channel(0);
    let expected = Arc::new(AtomicU64::new(0));
    let register_window = {
        let mut watches = NATIVE_VIEW_WATCHES
            .get_or_init(Default::default)
            .lock()
            .unwrap();
        if watches.entries.len() >= 16 || watches.entries.contains_key(&key) {
            return Err("原生会话实时订阅过多或编号重复".into());
        }
        watches.entries.insert(
            key.clone(),
            NativeViewWatch {
                serial,
                cancel,
                ack,
                expected: expected.clone(),
            },
        );
        watches.windows.insert(key.0.clone())
    };
    if register_window {
        let label = key.0.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                close_native_window(&label);
            }
        });
    }
    Ok(NativeViewRegistration {
        guard: NativeViewWatchGuard { key, serial },
        cancelled,
        acknowledged,
        expected,
    })
}

fn close_native_window(label: &str) {
    let mut watches = NATIVE_VIEW_WATCHES
        .get_or_init(Default::default)
        .lock()
        .unwrap();
    watches.windows.remove(label);
    watches.entries.retain(|(window, _), watch| {
        if window == label {
            watch.cancel.send_replace(true);
            false
        } else {
            true
        }
    });
}

pub(crate) fn stop_native_view(window: &str, id: &str) {
    let watches = NATIVE_VIEW_WATCHES
        .get_or_init(Default::default)
        .lock()
        .unwrap();
    if let Some(watch) = watches.entries.get(&(window.to_owned(), id.to_owned())) {
        watch.cancel.send_replace(true);
    }
}

pub(crate) fn ack_native_view(window: &str, id: &str, delivery: u64) {
    let watches = NATIVE_VIEW_WATCHES
        .get_or_init(Default::default)
        .lock()
        .unwrap();
    if let Some(watch) = watches.entries.get(&(window.to_owned(), id.to_owned())) {
        if delivery != 0 && watch.expected.load(Ordering::Acquire) == delivery {
            watch.ack.send_replace(delivery);
        }
    }
}

struct Flight {
    request_id: String,
    permission_selection: PermissionSelection,
    plugins: Option<PluginSelection>,
    model: String,
    project: PathBuf,
    policy: &'static str,
    retained: bool,
    record: Arc<Mutex<SessionRecord>>,
    controls: mpsc::Sender<Control>,
    stopped: tokio::sync::watch::Receiver<bool>,
}

#[derive(Clone)]
struct PermissionSelection {
    mode: String,
    permission: String,
}

impl PermissionSelection {
    fn from_session(session: &lolicode_agent::AgentSession) -> Self {
        Self {
            mode: session.mode.clone(),
            permission: session.permission_mode.clone(),
        }
    }

    fn check_queue(&self, session: &lolicode_agent::AgentSession) -> Result<(), String> {
        if self.mode != session.mode || self.permission != session.permission_mode {
            return Err("权限或工作模式已更改。请结束当前运行，再按新设置发送消息。".into());
        }
        Ok(())
    }
}

enum Control {
    Stop {
        expected_request: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    StopWorker {
        session: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Approval {
        session: String,
        id: String,
        decision: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Enqueue {
        args: Value,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ModeCommand {
        args: Value,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ReadMarkdown {
        child: Option<String>,
        reply: oneshot::Sender<Result<Option<String>, String>>,
    },
    ReadNative {
        child: Option<String>,
        request: Value,
        reply: oneshot::Sender<Result<Option<Value>, String>>,
    },
    FollowNative {
        child: Option<String>,
        id: String,
        max_messages: Option<u32>,
        reply: oneshot::Sender<Result<Option<HarnessNativeSubscription>, String>>,
    },
    WorkerEnqueue {
        session: String,
        args: Value,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Question {
        session: String,
        id: String,
        answer: Option<Value>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    QueuedAction {
        id: String,
        action: &'static str,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    WorkerQueuedAction {
        session: String,
        id: String,
        action: &'static str,
        steer_only: bool,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    SecretaryAction {
        args: Value,
        command: SecretaryCommand,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Shutdown,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    snapshot: AgentSnapshot,
    root_created: bool,
    receipts: BTreeMap<String, CommandReceipt>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    native_message_aliases: BTreeMap<String, String>,
    #[serde(default)]
    secretary: HarnessSecretary,
    #[serde(default)]
    queue: Vec<QueuedInput>,
    #[serde(default)]
    withdrawn: Vec<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    worker_queues: BTreeMap<String, WorkerQueue>,
}

#[derive(Serialize, Deserialize)]
struct QueuedInput {
    sdk_id: Option<String>,
    args: Value,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerQueue {
    inputs: Vec<WorkerQueuedInput>,
    withdrawn: Vec<Value>,
    receipts: BTreeMap<String, CommandReceipt>,
    paused: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerQueuedInput {
    message: AgentQueuedMessage,
    args: Value,
    sdk_id: Option<String>,
    #[serde(skip)]
    provisional: bool,
}

impl QueuedInput {
    fn id(&self) -> &str {
        self.args["requestId"].as_str().unwrap_or_default()
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct CommandReceipt {
    fingerprint: String,
    status: ReceiptStatus,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReceiptStatus {
    Accepted,
    Completed,
    Failed,
    Cancelled,
}

fn private_root(profile: &Path, id: &str) -> Option<PathBuf> {
    let raw = id.strip_prefix("lc:")?;
    let uuid = Uuid::parse_str(raw).ok()?;
    (raw == uuid.to_string()).then(|| profile.join("agent/harness-desktop").join(raw))
}

pub(super) fn sync_snapshot(profile: &Path, id: &str) -> Result<Option<AgentSnapshot>, String> {
    let Some(file) = private_root(profile, id).map(|root| root.join("desktop.json")) else {
        return Ok(None);
    };
    if !file.is_file() {
        return Ok(None);
    }
    Ok(Some(load_record(&file, id)?.snapshot))
}

struct VerifiedSessionRead {
    owner_id: String,
    owner_root: PathBuf,
    sdk_id: String,
    child: Option<String>,
    controls: Option<mpsc::Sender<Control>>,
    warm_reader: Option<HarnessClient>,
    stored_aliases: Option<BTreeMap<String, String>>,
}

async fn verified_sessions_directory(
    root: PathBuf,
    missing: &'static str,
) -> Result<PathBuf, String> {
    tokio::task::spawn_blocking(move || {
        existing_markdown_directory(&root.join("home/sessions"))?.ok_or_else(|| missing.to_owned())
    })
    .await
    .map_err(|_| "无法读取 Harness 日志目录")?
}

fn native_context_error(error: String) -> String {
    match error.as_str() {
        MARKDOWN_MISSING => NATIVE_MISSING.into(),
        LEGACY_MARKDOWN => "旧引擎迁移会话没有完整的原生 Harness 历史".into(),
        _ => error,
    }
}

fn native_alias_context_error(error: String) -> String {
    if error == LEGACY_MARKDOWN {
        NATIVE_LEGACY_HISTORY.into()
    } else {
        native_context_error(error)
    }
}

impl HarnessDesktop {
    pub(crate) async fn prepare_session(
        &self,
        app: &AppHandle,
        carrier: &InprocessAgentState,
        id: &str,
    ) -> Result<(), String> {
        prepare::prepare(self, app, carrier, id).await
    }

    pub(crate) async fn wait_for_preparation(&self, id: &str) -> Result<(), String> {
        prepare::wait_preparation(self, id).await?;
        let state = self.0.lock().await;
        if state.warm.has_ready(id) || state.flights.contains_key(id) {
            Ok(())
        } else {
            Err("会话运行环境尚未准备完成".into())
        }
    }

    /// Remove idle SDKs atomically, then wait for their write leases to close
    /// outside the state lock. Active turns remain governed by `flights`.
    pub(super) async fn retire_idle(&self, id: Option<&str>) -> Result<(), String> {
        prepare::retire_preparations(self, id).await?;
        let handles = {
            let mut state = self.0.lock().await;
            match id {
                Some(id) => state.warm.remove(id).into_iter().collect(),
                None => state.warm.drain(),
            }
        };
        for handle in handles {
            handle.retire().await?;
        }
        Ok(())
    }

    pub(super) async fn busy(&self) -> bool {
        !self.0.lock().await.flights.is_empty()
    }

    pub(super) async fn plugin_reload_pending(&self, selection: &PluginSelection) -> bool {
        self.0.lock().await.flights.values().any(|flight| {
            flight
                .plugins
                .as_ref()
                .is_some_and(|active| active != selection)
        })
    }

    pub(super) async fn session_busy(&self, id: &str) -> bool {
        self.0.lock().await.flights.contains_key(id)
    }

    pub(super) async fn root_snapshot(&self, id: &str) -> Result<Option<AgentSnapshot>, String> {
        let flight = self
            .0
            .lock()
            .await
            .flights
            .get(id)
            .map(|flight| flight.record.clone());
        if let Some(record) = flight {
            return Ok(Some(record.lock().await.snapshot.clone()));
        }
        let Some(file) =
            private_root(&config::get_app_config_dir(), id).map(|root| root.join("desktop.json"))
        else {
            return Ok(None);
        };
        if !file.is_file() {
            return Ok(None);
        }
        let mut snapshot = load_record(&file, id)?.snapshot;
        clear_waits(&mut snapshot);
        Ok(Some(snapshot))
    }

    async fn verified_read_context(
        &self,
        app: &AppHandle,
        carrier: &InprocessAgentState,
        id: &str,
    ) -> Result<VerifiedSessionRead, String> {
        let profile = config::get_app_config_dir();
        let selected_root = private_root(&profile, id).ok_or("无效的 Harness 会话编号")?;
        let id_for_paths = id.to_owned();
        let (owner, owner_root) = tokio::task::spawn_blocking(move || {
            let migration = HarnessMigration::new(&profile)?;
            if migration.receipt(&id_for_paths)?.is_some()
                || migration.find_legacy(&id_for_paths)?.is_some()
            {
                return Err(LEGACY_MARKDOWN.into());
            }
            let profile = canonical_project(&profile.to_string_lossy())?;
            let owner = read_worker_owner(&selected_root, &id_for_paths).unwrap_or(id_for_paths);
            let owner_root = private_root(&profile, &owner).ok_or("无效的 Harness 会话归属")?;
            let owner_root = existing_markdown_directory(&owner_root)?;
            Ok::<_, String>((owner, owner_root))
        })
        .await
        .map_err(|_| "无法验证 Harness 会话归属")??;
        let metadata: AgentSession = carrier
            .call("getSessionMetadata", json!({"sessionId": &owner}), false)
            .await?;
        crate::commands::agent_dispatch::check_project(app, &metadata.project_path)?;
        let owner_root = owner_root.ok_or(MARKDOWN_MISSING)?;
        let record_file = owner_root.join("desktop.json");
        let flight = self
            .0
            .lock()
            .await
            .flights
            .get(&owner)
            .map(|flight| (flight.record.clone(), flight.controls.clone()));
        let sdk_id = id
            .strip_prefix("lc:")
            .ok_or("无效的 Harness 会话编号")?
            .to_owned();
        let child = (owner != id).then(|| sdk_id.clone());
        let (controls, stored_aliases) = if let Some((record, controls)) = flight {
            let project = markdown_session(&*record.lock().await, &owner, id)?
                .project_path
                .clone();
            crate::commands::agent_dispatch::check_project(app, &project)?;
            (Some(controls), None)
        } else {
            let id = id.to_owned();
            let owner_for_load = owner.clone();
            let (project, aliases) = tokio::task::spawn_blocking(move || {
                if !record_file.is_file() {
                    return Err(MARKDOWN_MISSING.into());
                }
                let record = load_record(&record_file, &owner_for_load)?;
                Ok::<_, String>((
                    markdown_session(&record, &owner_for_load, &id)?
                        .project_path
                        .clone(),
                    record.native_message_aliases,
                ))
            })
            .await
            .map_err(|_| "无法读取 Harness 会话")??;
            crate::commands::agent_dispatch::check_project(app, &project)?;
            (None, Some(aliases))
        };
        let warm_reader = if controls.is_none() {
            self.0.lock().await.warm.reader(&owner)
        } else {
            None
        };
        Ok(VerifiedSessionRead {
            owner_id: owner,
            owner_root,
            sdk_id,
            child,
            controls,
            warm_reader,
            stored_aliases,
        })
    }

    pub(crate) async fn read_session_markdown(
        &self,
        app: &AppHandle,
        carrier: &InprocessAgentState,
        id: &str,
    ) -> Result<String, String> {
        let context = self.verified_read_context(app, carrier, id).await?;
        if let Some(controls) = &context.controls {
            let child = context.child.clone();
            let response = tokio::time::timeout(
                Duration::from_secs(55),
                forward_live_control(controls, |reply| Control::ReadMarkdown { child, reply }),
            )
            .await
            .map_err(|_| "读取完整会话日志超时，请重试")?;
            match response {
                Some(Ok(Some(markdown))) => return Ok(markdown),
                Some(Err(error)) => return Err(error),
                // The runtime can exit while the read is in flight. A nonresident
                // child or finished root can still have a committed stored log.
                Some(Ok(None)) | None => {}
            }
        }
        if let Some(reader) = &context.warm_reader {
            let owner = context
                .owner_id
                .strip_prefix("lc:")
                .ok_or("无效的 Harness 会话归属")?;
            if let Some(markdown) = reader
                .read_session_markdown(owner, context.child.as_deref())
                .await?
            {
                return Ok(markdown);
            }
        }
        let sessions = verified_sessions_directory(context.owner_root, MARKDOWN_MISSING).await?;
        read_cold_session_markdown(&HarnessPaths::resolve(app)?, &sessions, &context.sdk_id).await
    }

    pub(crate) async fn read_session_native(
        &self,
        app: &AppHandle,
        carrier: &InprocessAgentState,
        id: &str,
        before_seq: Option<u64>,
        through_seq: Option<u64>,
        max_messages: Option<u32>,
    ) -> Result<Value, String> {
        let request = native_read_request(before_seq, through_seq, max_messages)?;
        let context = self
            .verified_read_context(app, carrier, id)
            .await
            .map_err(native_context_error)?;
        if let Some(controls) = &context.controls {
            let child = context.child.clone();
            let live_request = request.clone();
            let response = tokio::time::timeout(
                Duration::from_secs(55),
                forward_live_control(controls, |reply| Control::ReadNative {
                    child,
                    request: live_request,
                    reply,
                }),
            )
            .await
            .map_err(|_| "读取原生会话超时，请重试")?;
            match response {
                Some(Ok(Some(mut value))) => {
                    value["messageAliases"] =
                        to_value(self.native_aliases_for_context(context).await?)?;
                    return Ok(value);
                }
                Some(Err(error)) => return Err(error),
                Some(Ok(None)) | None => {}
            }
        }
        if let Some(reader) = &context.warm_reader {
            let owner = context
                .owner_id
                .strip_prefix("lc:")
                .ok_or("无效的 Harness 会话归属")?;
            if let Some(mut value) = reader
                .read_session_native(owner, context.child.as_deref(), &request)
                .await?
            {
                value["messageAliases"] =
                    to_value(self.native_aliases_for_context(context).await?)?;
                return Ok(value);
            }
        }
        let sessions =
            verified_sessions_directory(context.owner_root.clone(), NATIVE_MISSING).await?;
        let mut value = read_cold_session_native(
            &HarnessPaths::resolve(app)?,
            &sessions,
            &context.sdk_id,
            &request,
        )
        .await?;
        value["messageAliases"] = to_value(self.native_aliases_for_context(context).await?)?;
        Ok(value)
    }

    pub(crate) async fn read_native_message_aliases(
        &self,
        app: &AppHandle,
        carrier: &InprocessAgentState,
        id: &str,
    ) -> Result<BTreeMap<String, String>, String> {
        let context = self
            .verified_read_context(app, carrier, id)
            .await
            .map_err(native_alias_context_error)?;
        self.native_aliases_for_context(context).await
    }

    async fn native_aliases_for_context(
        &self,
        context: VerifiedSessionRead,
    ) -> Result<BTreeMap<String, String>, String> {
        let live = self
            .0
            .lock()
            .await
            .flights
            .get(&context.owner_id)
            .map(|flight| flight.record.clone());
        if let Some(record) = live {
            return Ok(record.lock().await.native_message_aliases.clone());
        }
        if let Some(aliases) = context.stored_aliases {
            return Ok(aliases);
        }
        // The live turn may have ended while its history read was in flight.
        let owner = context.owner_id;
        let file = context.owner_root.join("desktop.json");
        tokio::task::spawn_blocking(move || {
            load_record(&file, &owner).map(|record| record.native_message_aliases)
        })
        .await
        .map_err(|_| "无法读取原生会话消息关联".to_owned())?
    }

    pub(crate) async fn watch_session_native(
        &self,
        window: &WebviewWindow,
        carrier: &InprocessAgentState,
        id: &str,
        subscription_id: &str,
        max_messages: Option<u32>,
        on_frame: Channel<Value>,
    ) -> Result<bool, String> {
        native_read_request(None, None, max_messages)?;
        // Register cancellation before validation/transport opening, so an
        // immediate close can cancel a watch whose first reply is still pending.
        let NativeViewRegistration {
            guard: _guard,
            mut cancelled,
            mut acknowledged,
            expected,
        } = register_native_view(window, subscription_id)?;
        let app = window.app_handle();
        let open = async {
            carrier.ensure_started(app).await?;
            let context = self
                .verified_read_context(app, carrier, id)
                .await
                .map_err(native_context_error)?;
            if let Some(controls) = context.controls {
                forward_live_control(&controls, |reply| Control::FollowNative {
                    child: context.child,
                    id: subscription_id.to_owned(),
                    max_messages,
                    reply,
                })
                .await
                .transpose()
                .map(|result| result.flatten())
            } else if let Some(reader) = context.warm_reader {
                let owner = context
                    .owner_id
                    .strip_prefix("lc:")
                    .ok_or("无效的 Harness 会话归属")?;
                reader
                    .follow_session_native(
                        owner,
                        context.child.as_deref(),
                        subscription_id.to_owned(),
                        max_messages,
                    )
                    .await
            } else {
                Ok(None)
            }
        };
        let opened = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(55), open) => result.map_err(|_| "原生会话实时连接超时，请重试")??,
            _ = cancelled.changed() => return Ok(true),
        };
        let Some(mut subscription) = opened else {
            return Ok(false);
        };
        if *cancelled.borrow() {
            return Ok(true);
        }
        let mut delivery = 0u64;
        loop {
            tokio::select! {
                biased;
                _ = cancelled.changed() => return Ok(true),
                frame = async {
                    if delivery == 0 {
                        tokio::time::timeout(Duration::from_secs(30), subscription.next())
                            .await
                            .map_err(|_| "原生会话起始快照超时，请手动重新连接".to_owned())?
                    } else {
                        subscription.next().await
                    }
                } => {
                    delivery = delivery.checked_add(1).ok_or("原生会话交付编号已耗尽")?;
                    expected.store(delivery, Ordering::Release);
                    on_frame.send(json!({"subscriptionId":subscription_id,"deliveryId":delivery,"frame":frame?}))
                        .map_err(|_| "原生会话预览窗口已关闭")?;
                }
            }
            // One unacknowledged IPC message at a time. A frozen renderer must
            // not move an unlimited stream into Tauri's internal payload queue.
            let ack = async {
                loop {
                    if *acknowledged.borrow_and_update() == delivery {
                        return Ok::<_, String>(());
                    }
                    acknowledged
                        .changed()
                        .await
                        .map_err(|_| "原生会话预览已关闭".to_owned())?;
                }
            };
            tokio::select! {
                biased;
                _ = cancelled.changed() => return Ok(true),
                error = subscription.ended() => return Err(error),
                result = tokio::time::timeout(Duration::from_secs(30), ack) => {
                    result.map_err(|_| "原生会话预览响应超时，请手动重新连接")??;
                }
            }
        }
    }

    pub(super) async fn session_list_activity(
        &self,
        sessions: &mut [AgentSession],
    ) -> Result<(), String> {
        let flights = {
            let state = self.0.lock().await;
            sessions
                .iter()
                .map(|session| {
                    state
                        .flights
                        .get(&session.id)
                        .map(|flight| flight.record.clone())
                })
                .collect::<Vec<_>>()
        };
        let inactive = sessions
            .iter()
            .zip(&flights)
            .filter(|(_, flight)| flight.is_none())
            .map(|(session, _)| session.id.clone())
            .collect::<Vec<_>>();
        let profile = config::get_app_config_dir();
        let mut stored = tokio::task::spawn_blocking(move || {
            inactive
                .iter()
                .map(|id| load_sidebar(&profile, id))
                .collect::<Result<Vec<_>, _>>()
        })
        .await
        .map_err(|_| "无法读取会话列表")??
        .into_iter();
        for (session, flight) in sessions.iter_mut().zip(flights) {
            let info = if let Some(record) = flight {
                let record = record.lock().await;
                Some((
                    record.snapshot.session.updated_at,
                    record.snapshot.status.clone(),
                    record.snapshot.title_pending,
                ))
            } else {
                stored
                    .next()
                    .flatten()
                    .map(|sidebar| (sidebar.updated_at, sidebar.status.clone(), false))
            };
            if let Some((updated_at, status, title_pending)) = info {
                session.updated_at = session.updated_at.max(updated_at);
                activity(session, status, title_pending);
            }
        }
        Ok(())
    }

    pub(super) async fn overlay_secretary(
        &self,
        state: &mut AgentSecretaryState,
    ) -> Result<Option<AgentStatus>, String> {
        let id = state.session_id.clone();
        let flight = self
            .0
            .lock()
            .await
            .flights
            .get(&id)
            .map(|flight| flight.record.clone());
        if let Some(record) = flight {
            let record = record.lock().await;
            record.secretary.sidebar(&id, false).overlay(state);
            return Ok(Some(record.snapshot.status.clone()));
        }
        let profile = config::get_app_config_dir();
        let sidebar = tokio::task::spawn_blocking(move || load_sidebar(&profile, &id))
            .await
            .map_err(|_| "无法读取秘书任务列表")??;
        if let Some(sidebar) = sidebar {
            if let Some(secretary) = &sidebar.secretary {
                secretary.overlay(state);
            }
            return Ok(Some(sidebar.status.clone()));
        }
        Ok(None)
    }

    pub(crate) async fn dispatch(
        &self,
        app: &AppHandle,
        carrier: &InprocessAgentState,
        method: &str,
        args: &Value,
    ) -> Result<Option<Value>, String> {
        if !matches!(
            method,
            "sendMessage"
                | "getSession"
                | "updateSession"
                | "recordAutomationSave"
                | "queryCommand"
                | "interruptSession"
                | "replyPermission"
                | "replyQuestion"
                | "rejectQuestion"
                | "enqueueMessage"
                | "sendQueuedMessageNow"
                | "removeQueuedMessage"
                | "getSecretary"
                | "delegateSecretaryTask"
                | "sendSecretaryTaskMessage"
                | "deleteSecretaryTask"
                | "cancelSecretaryTask"
                | "getSessionExecutionRoot"
        ) {
            return Ok(None);
        }
        let Some(id) = args["sessionId"].as_str() else {
            return Ok(None);
        };
        let profile = config::get_app_config_dir();
        let Some(root) = private_root(&profile, id) else {
            return Ok(None);
        };
        let owner = read_worker_owner(&root, id).unwrap_or_else(|| id.to_owned());
        let mode_command = args["automationIdleOnly"] != true
            && args["text"].as_str().is_some_and(native_mode_command);
        if (is_compact_command(args) || mode_command)
            && (method == "sendSecretaryTaskMessage"
                || owner != id && matches!(method, "sendMessage" | "enqueueMessage"))
        {
            return Err("请在主会话中运行此命令".into());
        }
        let owner_root = private_root(&profile, &owner).ok_or("Harness 会话归属无效")?;
        let file = owner_root.join("desktop.json");
        let flight = self
            .0
            .lock()
            .await
            .flights
            .get(&owner)
            .map(|flight| (flight.record.clone(), flight.controls.clone()));
        if mode_command && owner == id && matches!(method, "sendMessage" | "enqueueMessage") {
            let _admission = carrier.lock_harness_admission().await;
            let current = self
                .0
                .lock()
                .await
                .flights
                .get(id)
                .map(|flight| flight.controls.clone());
            if let Some(controls) = current {
                let session: lolicode_agent::AgentSession = carrier
                    .call("getSessionMetadata", json!({"sessionId": id}), false)
                    .await?;
                if session.archived {
                    return Err("归档会话不能运行命令".into());
                }
                drop(_admission);
                send_control(&controls, |reply| Control::ModeCommand {
                    args: args.clone(),
                    reply,
                })
                .await?;
                return Ok(Some(Value::Null));
            }
        }
        if method == "updateSession" {
            if owner == id {
                let _admission = carrier.lock_harness_admission().await;
                self.retire_idle(Some(id)).await?;
                let retiring =
                    self.0
                        .lock()
                        .await
                        .flights
                        .get(id)
                        .filter(|flight| {
                            flight.retained
                                && (args["permissionMode"].as_str().is_some_and(|mode| {
                                    mode != flight.permission_selection.permission
                                }) || args["mode"]
                                    .as_str()
                                    .is_some_and(|mode| mode != flight.permission_selection.mode)
                                    || args["modelId"]
                                        .as_str()
                                        .is_some_and(|model| model != flight.model))
                        })
                        .map(|flight| (flight.controls.clone(), flight.stopped.clone()));
                if let Some((controls, mut stopped)) = retiring {
                    if controls.send(Control::Shutdown).await.is_ok() {
                        let _ = stopped.wait_for(|stopped| *stopped).await;
                    }
                }
                let result: AgentSession = carrier.call(method, args.clone(), false).await?;
                return to_value(result).map(Some);
            }
            let mode = super::harness_sessions::validate_worker_permission(args)?;
            let _admission = carrier.lock_harness_admission().await;
            let current = self
                .0
                .lock()
                .await
                .flights
                .get(&owner)
                .map(|flight| flight.record.clone());
            let session = if let Some(record) = current {
                let mut saved = record.lock().await;
                update_worker_permission(&mut saved, &file, id, mode)?
            } else {
                let mut saved = load_record(&file, &owner)?;
                update_worker_permission(&mut saved, &file, id, mode)?
            };
            return to_value(session).map(Some);
        }
        if method == "recordAutomationSave" {
            let _admission = carrier.lock_harness_admission().await;
            let snapshot = if let Some((record, _)) = flight {
                view_snapshot(&*record.lock().await, id, &owner)?
            } else if file.is_file() {
                view_snapshot(&load_record(&file, &owner)?, id, &owner)?
            } else {
                carrier
                    .call("getSession", json!({"sessionId":id}), false)
                    .await?
            };
            crate::commands::agent_dispatch::check_project(app, &snapshot.session.project_path)?;
            return super::harness_automation::save(&profile, snapshot, args).map(Some);
        }
        if matches!(method, "delegateSecretaryTask" | "sendSecretaryTaskMessage") {
            if owner != id {
                return Err("请从所属总秘书管理此任务".into());
            }
            let content = if method == "sendSecretaryTaskMessage" {
                content_blocks(args)?
            } else {
                Value::Null
            };
            let command = SecretaryCommand::parse(method, args, content)?;
            if let SecretaryCommand::Delegate {
                project_path: Some(path),
                ..
            } = &command
            {
                crate::commands::agent_dispatch::check_project(app, path)?;
                let secretary: lolicode_agent::AgentSession = carrier
                    .call("getSessionMetadata", json!({"sessionId":id}), false)
                    .await?;
                let remote = carrier
                    .remote_projects(&app.state::<crate::store::AppState>())
                    .await;
                if !super::agent_host::is_standalone_workspace(Path::new(&secretary.project_path))
                    || remote.owns(Path::new(path))
                    || super::agent_host::canonical_project(path)?.as_path() != Path::new(path)
                {
                    return Err("跨项目派工需要总秘书和已打开的本地项目".into());
                }
            }
            let request = request_id(args)?;
            let fingerprint = secretary_fingerprint(args);
            loop {
                let admission = carrier.lock_harness_admission().await;
                let active = self.0.lock().await.flights.get(id).map(|flight| {
                    (
                        flight.record.clone(),
                        flight.controls.clone(),
                        flight.stopped.clone(),
                    )
                });
                let Some((record, controls, mut stopped)) = active else {
                    let mut session: AgentSnapshot = carrier
                        .call("getSession", json!({"sessionId": id}), false)
                        .await?;
                    crate::commands::agent_dispatch::decorate(app, &mut session.session)?;
                    return self
                        .admit(app, carrier, session, profile, root, args, Some(command))
                        .await
                        .map(Some);
                };
                {
                    let saved = record.lock().await;
                    if check_receipt(&saved, request, &fingerprint)? {
                        return secretary_response(&saved, request, Some(&command)).map(Some);
                    }
                }
                drop(admission);
                if let Some(result) = send_secretary_control(&controls, args, command.clone()).await
                {
                    return result.map(Some);
                }
                // The child can publish a terminal status while its parent's
                // flight is still saving and shutting down. Once that exact
                // flight settles, read the durable receipt before admitting
                // the same command again.
                stopped
                    .wait_for(|done| *done)
                    .await
                    .map_err(|_| "秘书会话关闭未确认，请重试")?;
            }
        }
        if owner != id
            && matches!(
                method,
                "enqueueMessage" | "sendQueuedMessageNow" | "removeQueuedMessage"
            )
        {
            let request = request_id(args)?;
            let steer_only = args["steerOnly"] == true;
            let _admission = loop {
                let admission = carrier.lock_harness_admission().await;
                let active = self.0.lock().await.flights.get(&owner).map(|flight| {
                    (
                        flight.record.clone(),
                        flight.controls.clone(),
                        flight.stopped.clone(),
                    )
                });
                let Some((record, controls, mut stopped)) = active else {
                    break admission;
                };
                {
                    let saved = record.lock().await;
                    check_worker_queue_access(app, &saved, id)?;
                }
                drop(admission);
                let result = if method == "enqueueMessage" {
                    forward_live_control(&controls, |reply| Control::WorkerEnqueue {
                        session: id.into(),
                        args: args.clone(),
                        reply,
                    })
                    .await
                    .map(|result| result.map(|()| Value::Null))
                } else {
                    forward_live_control(&controls, |reply| Control::WorkerQueuedAction {
                        session: id.into(),
                        id: request.into(),
                        action: if method == "removeQueuedMessage" {
                            "remove"
                        } else {
                            "steer"
                        },
                        steer_only,
                        reply,
                    })
                    .await
                };
                if let Some(result) = result {
                    return result.map(Some);
                }
                // The child may become idle before the owner closes its event
                // transport. Reconcile the same request after that exact flight.
                stopped
                    .wait_for(|done| *done)
                    .await
                    .map_err(|_| "秘书会话关闭未确认，请重试")?;
            };
            let mut saved = load_record(&file, &owner)?;
            let task = check_worker_queue_access(app, &saved, id)?.to_owned();
            if method == "enqueueMessage" {
                let content = content_blocks(args)?;
                if check_worker_queue_duplicate(&saved, id, args, &content)? {
                    return Ok(Some(Value::Null));
                }
                if args["delivery"] == "steer" {
                    return Err("当前子任务已经结束，请重新发送。".into());
                }
                add_worker_queue_input(&mut saved, id, args, &content)?;
                saved
                    .worker_queues
                    .get_mut(id)
                    .expect("worker queue exists")
                    .paused = true;
                save_record(&file, &saved)?;
                return Ok(Some(Value::Null));
            }
            if method == "removeQueuedMessage" {
                let input = withdraw_worker_queue_input(&mut saved, id, request)?;
                save_record(&file, &saved)?;
                return Ok(Some(input));
            }
            if steer_only {
                return Err("当前子任务已经结束，这条消息仍保留在队列中。".into());
            }
            let mut payload = worker_queue_input(&saved, id, request)?.args.clone();
            payload["sessionId"] = json!(owner);
            payload["taskId"] = json!(task);
            payload["requestId"] = json!(format!("worker-resume-{}", Uuid::new_v4().simple()));
            payload["workerQueueRequest"] = json!(request);
            let command = SecretaryCommand::parse(
                "sendSecretaryTaskMessage",
                &payload,
                content_blocks(&payload)?,
            )?;
            let mut native: AgentSnapshot = carrier
                .call("getSession", json!({"sessionId": owner}), false)
                .await?;
            crate::commands::agent_dispatch::decorate(app, &mut native.session)?;
            self.admit(
                app,
                carrier,
                native,
                profile,
                owner_root,
                &payload,
                Some(command),
            )
            .await?;
            return Ok(Some(Value::Null));
        }
        if method == "enqueueMessage" && owner == id {
            let admission = carrier.lock_harness_admission().await;
            let active = self.0.lock().await.flights.get(id).map(|flight| {
                (
                    flight.controls.clone(),
                    flight.permission_selection.clone(),
                    flight.record.clone(),
                )
            });
            if let Some((controls, selection, record)) = active {
                let foreground = unsettled(&record.lock().await.snapshot.status);
                if !foreground && args["delivery"] == "steer" {
                    return Err("当前任务已经结束，草稿已保留。".into());
                }
                if !foreground {
                    let mut native: AgentSnapshot = carrier
                        .call("getSession", json!({"sessionId": id}), false)
                        .await?;
                    crate::commands::agent_dispatch::decorate(app, &mut native.session)?;
                    return self
                        .admit(app, carrier, native, profile, root, args, None)
                        .await
                        .map(Some);
                }
                if is_compact_command(args) {
                    return Err("请等当前任务结束后再运行 /compact".into());
                }
                let session: lolicode_agent::AgentSession = carrier
                    .call("getSessionMetadata", json!({"sessionId": id}), false)
                    .await?;
                selection.check_queue(&session)?;
                drop(admission);
                send_control(&controls, |reply| Control::Enqueue {
                    args: args.clone(),
                    reply,
                })
                .await?;
                return Ok(Some(Value::Null));
            }
            if args["delivery"] == "steer" {
                if file.is_file() {
                    let id = request_id(args)?;
                    let content = content_blocks(args)?;
                    let fingerprint = message_fingerprint(&content, true);
                    let saved = load_record(&file, &owner)?;
                    if check_receipt(&saved, id, &fingerprint)? {
                        return Ok(Some(Value::Null));
                    }
                }
                return Err("当前任务已经结束，草稿已保留。".into());
            }
        }
        if method == "sendQueuedMessageNow" || method == "removeQueuedMessage" {
            if owner != id {
                return Err("子任务消息由总秘书管理".into());
            }
            let request_id = args["requestId"].as_str().ok_or("无效的队列编号")?;
            let action = if method == "sendQueuedMessageNow" {
                "steer"
            } else {
                "remove"
            };
            if let Some((_, controls)) = &flight {
                let (reply, response) = oneshot::channel();
                controls
                    .send(Control::QueuedAction {
                        id: request_id.into(),
                        action,
                        reply,
                    })
                    .await
                    .map_err(|_| "本轮已结束，请重试")?;
                return response.await.map_err(|_| "本轮已结束，请重试")?.map(Some);
            }
            if action == "steer" && args["steerOnly"] == true {
                return Err("当前任务已经结束，这条消息仍保留在队列中。".into());
            }
            if file.is_file() {
                let _admission = carrier.lock_harness_admission().await;
                if self.0.lock().await.flights.contains_key(id) {
                    return Err("会话状态已变化，请重试".into());
                }
                let mut saved = load_record(&file, id)?;
                if action == "remove" {
                    let withdrawn = withdraw(&mut saved, request_id)?;
                    save_record(&file, &saved)?;
                    return Ok(Some(withdrawn));
                }
                let input = saved
                    .queue
                    .iter()
                    .find(|input| input.id() == request_id)
                    .ok_or("该排队消息已开始执行或已撤回")?;
                let mut payload = input.args.clone();
                payload["queuedResume"] = json!(true);
                let mut native: AgentSnapshot = carrier
                    .call("getSession", json!({"sessionId": id}), false)
                    .await?;
                crate::commands::agent_dispatch::decorate(app, &mut native.session)?;
                return self
                    .admit(app, carrier, native, profile, root, &payload, None)
                    .await
                    .map(Some);
            }
            return Ok(None);
        }
        if matches!(method, "sendMessage" | "enqueueMessage") {
            if owner != id {
                return Err("请通过总秘书给这个子任务补充指令".into());
            }
            let _admission = carrier.lock_harness_admission().await;
            let mut native: AgentSnapshot = carrier
                .call("getSession", json!({"sessionId": id}), false)
                .await?;
            if native
                .session
                .coordination
                .as_ref()
                .is_some_and(|item| item.role != "secretary")
            {
                return Ok(None);
            }
            crate::commands::agent_dispatch::decorate(app, &mut native.session)?;
            return self
                .admit(app, carrier, native, profile, root, args, None)
                .await
                .map(Some);
        }
        if flight.is_none() && !file.is_file() && method != "interruptSession" {
            if method == "deleteSecretaryTask" && owner == id {
                let task = args["taskId"].as_str().ok_or("无效的子任务编号")?;
                let _admission = carrier.lock_harness_admission().await;
                let record = self
                    .0
                    .lock()
                    .await
                    .flights
                    .get(id)
                    .map(|flight| flight.record.clone());
                if let Some(record) = record {
                    let mut saved = record.lock().await;
                    saved.secretary.delete(task)?;
                    save_record(&file, &saved)?;
                } else if file.is_file() {
                    let mut saved = load_record(&file, id)?;
                    saved.secretary.settle_interrupted();
                    saved.secretary.delete(task)?;
                    save_record(&file, &saved)?;
                } else {
                    let migration = HarnessMigration::new(&profile)?;
                    let Some(source) = migration.find_legacy(id)? else {
                        return Ok(None);
                    };
                    let mut saved = record_from_snapshot(source.snapshot().clone(), &profile)?;
                    saved.secretary.import_legacy(id, source.secretary_tasks());
                    saved.secretary.delete(task)?;
                    std::fs::create_dir_all(&owner_root)
                        .map_err(|_| "无法创建 Harness 会话目录")?;
                    save_record(&file, &saved)?;
                }
                return Ok(Some(Value::Null));
            }
            return Ok(None);
        }
        match method {
            "getSession" => {
                let mut snapshot = if let Some((record, _)) = &flight {
                    view_snapshot(&*record.lock().await, id, &owner)?
                } else {
                    let owner = owner.clone();
                    let id = id.to_owned();
                    tokio::task::spawn_blocking(move || {
                        let saved = load_record(&file, &owner)?;
                        let mut snapshot = view_snapshot(&saved, &id, &owner)?;
                        clear_waits(&mut snapshot);
                        Ok::<_, String>(snapshot)
                    })
                    .await
                    .map_err(|_| "无法读取 Harness 会话")??
                };
                if owner == id {
                    let native: lolicode_agent::AgentSession = carrier
                        .call("getSessionMetadata", args.clone(), false)
                        .await?;
                    let updated = snapshot.session.updated_at;
                    snapshot.session = native;
                    snapshot.session.updated_at = snapshot.session.updated_at.max(updated);
                }
                super::harness_automation::apply(&profile, &mut snapshot)?;
                if let Some(preview) = &snapshot.preview {
                    if let Some(browser) = carrier.harness_preview.rendered(&preview.id).await {
                        snapshot.preview = Some(browser);
                    }
                }
                to_value(snapshot).map(Some)
            }
            "getSessionExecutionRoot" if owner != id && args["browserId"].is_null() => {
                let (project, execution) = if let Some((record, _)) = &flight {
                    worker_root(&*record.lock().await, id)?
                } else {
                    worker_root(&load_record(&file, &owner)?, id)?
                };
                Ok(Some(json!([project, execution])))
            }
            "getSessionExecutionRoot" => Ok(None),
            "getSecretary" if owner == id => {
                let mut existing: lolicode_agent::AgentSecretaryState = carrier
                    .call(
                        "getSecretary",
                        json!({"sessionId": id, "refresh": false}),
                        false,
                    )
                    .await?;
                self.overlay_secretary(&mut existing).await?;
                to_value(existing).map(Some)
            }
            "deleteSecretaryTask" if owner == id => {
                let task = args["taskId"].as_str().ok_or("无效的子任务编号")?;
                if let Some((record, _)) = flight {
                    let mut saved = record.lock().await;
                    saved.secretary.delete(task)?;
                    save_record(&file, &saved)?;
                } else {
                    let mut saved = load_record(&file, &owner)?;
                    saved.secretary.settle_interrupted();
                    saved.secretary.delete(task)?;
                    save_record(&file, &saved)?;
                }
                Ok(Some(Value::Null))
            }
            "cancelSecretaryTask" if owner == id => {
                let task = args["taskId"].as_str().ok_or("无效的子任务编号")?;
                let Some((record, controls)) = flight else {
                    let saved = load_record(&file, &owner)?;
                    let task = saved.secretary.task(task).ok_or("子任务不属于此秘书")?;
                    return to_value(task).map(Some);
                };
                let session = record
                    .lock()
                    .await
                    .secretary
                    .task_sdk_id(task)
                    .ok_or("子任务不属于此秘书")?
                    .to_owned();
                send_control(&controls, |reply| Control::StopWorker { session, reply }).await?;
                // Return the same task view the secretary panel is already using.
                let state = record.lock().await.secretary.state(id);
                let task = state
                    .tasks
                    .into_iter()
                    .find(|entry| entry.id == task)
                    .ok_or("子任务不属于此秘书")?;
                to_value(task).map(Some)
            }
            "queryCommand" => {
                let request_id = args["requestId"].as_str().ok_or("无效的请求编号")?;
                let status = if let Some((record, _)) = flight {
                    command_status(&*record.lock().await, id, &owner, request_id)
                } else {
                    command_status(&load_record(&file, &owner)?, id, &owner, request_id)
                };
                let results = status
                    .map(|status| {
                        json!({
                            "key":{"sessionId":id,"commandId":request_id},
                            "result":{"commandId":request_id,"status":status}
                        })
                    })
                    .into_iter()
                    .collect::<Vec<_>>();
                Ok(Some(json!({"results":results})))
            }
            "interruptSession" => {
                // Stop must not wait behind admission's preparation barrier.
                // Record an exact-ID intent before a not-yet-admitted send can
                // acquire a runtime; never apply it to another request.
                let expected_request = args["expectedRequestId"].as_str();
                let flight = {
                    let mut state = self.0.lock().await;
                    let flight = state
                        .flights
                        .get(&owner)
                        .map(|flight| (flight.record.clone(), flight.controls.clone()));
                    if flight.is_none() && owner == id {
                        if let Some(expected) = expected_request {
                            request_id(&json!({"requestId":expected}))?;
                            let known = if file.is_file() {
                                load_record(&file, &owner)?.receipts.contains_key(expected)
                            } else {
                                false
                            };
                            if known {
                                return Ok(Some(Value::Null));
                            } else {
                                let key = (owner.clone(), expected.to_owned());
                                if state.early_stops.len() >= MAX_RECEIPTS
                                    && !state.early_stops.contains(&key)
                                {
                                    return Err("待提交的取消请求过多，请稍后重试".into());
                                }
                                state.early_stops.insert(key);
                            }
                        }
                    }
                    flight
                };
                if flight.is_none() {
                    self.retire_idle(Some(&owner)).await?;
                    return Ok(Some(Value::Null));
                }
                if let Some(expected) = expected_request {
                    let desktop = self.0.lock().await;
                    if owner != id
                        || desktop
                            .flights
                            .get(&owner)
                            .is_none_or(|flight| flight.request_id != expected)
                    {
                        return Ok(Some(Value::Null));
                    }
                }
                if let Some((record, controls)) = flight {
                    if owner == id {
                        send_control(&controls, |reply| Control::Stop {
                            expected_request: expected_request.map(str::to_owned),
                            reply,
                        })
                        .await?;
                    } else {
                        let session = record
                            .lock()
                            .await
                            .secretary
                            .child_sdk_id(id)
                            .ok_or("子任务不属于此秘书")?
                            .to_owned();
                        send_control(&controls, |reply| Control::StopWorker { session, reply })
                            .await?;
                    }
                }
                Ok(Some(Value::Null))
            }
            "replyPermission" => {
                let (record, controls) = flight.ok_or("这项审批已经结束")?;
                let session = view_snapshot(&*record.lock().await, id, &owner)?.session.id;
                let approval = args["requestId"]
                    .as_str()
                    .ok_or("无效的审批编号")?
                    .to_owned();
                let decision = match args["decision"].as_str() {
                    Some("once") => "allowed-once",
                    Some("reject") => "rejected",
                    _ => return Err("Harness 审批只支持本次允许或拒绝".into()),
                }
                .to_owned();
                send_control(&controls, |reply| Control::Approval {
                    session,
                    id: approval,
                    decision,
                    reply,
                })
                .await?;
                Ok(Some(Value::Null))
            }
            "replyQuestion" | "rejectQuestion" => {
                let (record, controls) = flight.ok_or("此问题已经结束")?;
                let session = view_snapshot(&*record.lock().await, id, &owner)?.session.id;
                let id = args["requestId"]
                    .as_str()
                    .ok_or("无效的问题编号")?
                    .to_owned();
                let answer = (method == "replyQuestion").then(|| args["answer"].clone());
                send_control(&controls, |reply| Control::Question {
                    session,
                    id,
                    answer,
                    reply,
                })
                .await?;
                Ok(Some(Value::Null))
            }
            _ => Err("Harness 开发验收暂不接管消息队列，请等待本轮结束后发送".into()),
        }
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Admission combines the desktop state, saved session, request, and optional secretary action"
    )]
    async fn admit(
        &self,
        app: &AppHandle,
        carrier: &InprocessAgentState,
        native: AgentSnapshot,
        profile: PathBuf,
        root: PathBuf,
        args: &Value,
        secretary: Option<SecretaryCommand>,
    ) -> Result<Value, String> {
        let id = native.session.id.clone();
        prepare::wait_preparation(self, &id).await?;
        if args["sessionId"].as_str() != Some(id.as_str())
            || native.session.archived
            || matches!(
                native.status,
                AgentStatus::Running
                    | AgentStatus::WaitingPermission
                    | AgentStatus::WaitingQuestion
            )
        {
            return Err("请先结束现有任务，再用 Harness 继续此会话".into());
        }
        let request_id = request_id(args)?.to_owned();
        let automation_idle_only = args["automationIdleOnly"] == true;
        if automation_idle_only && native.session.coordination.is_some() {
            return Err("自动化只能投递到普通对话".into());
        }
        let interactive_command = secretary.is_none() && !automation_idle_only;
        let compact = interactive_command && is_compact_command(args);
        let mode_command =
            interactive_command && args["text"].as_str().is_some_and(native_mode_command);
        if compact
            && args["attachments"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        {
            return Err("/compact 不支持附件".into());
        }
        let content = if secretary.is_none() {
            content_blocks(args)?
        } else {
            Value::Null
        };
        let fingerprint = if secretary.is_some() {
            secretary_fingerprint(args)
        } else {
            message_fingerprint(&content, args["delivery"] == "steer")
        };
        let project = canonical_project(&native.session.project_path)?;
        let remote = carrier.remote_projects(&app.state::<AppState>()).await;
        let selected_project = Path::new(&native.session.project_path);
        let remote_tools = if remote.owns(selected_project) || remote.owns(&project) {
            if remote.resolve(selected_project)?.binding() != remote.resolve(&project)?.binding() {
                return Err("远程工作目录已变更，请重新打开项目".into());
            }
            Some(HarnessMcp::prepare_remote(
                remote.clone(),
                &project,
                native.session.mode == "plan",
            )?)
        } else {
            None
        };
        let background_only: bool = carrier
            .call(
                "sessionRequiresBackgroundReview",
                json!({"sessionId":id}),
                false,
            )
            .await?;
        let background = background_only || args["backgroundOnly"] == true;
        let auto_title = secretary.is_none()
            && native.session.coordination.is_none()
            && !background
            && !compact
            && !mode_command
            && content.as_array().is_some_and(|blocks| {
                blocks.iter().any(|block| {
                    block["type"] == "text"
                        && block["text"]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty())
                })
            })
            && carrier.automatic_title_allowed(&id).await?;
        let local_interactive = !background && remote_tools.is_none();
        let policy = workspace_policy(&native.session, background, remote_tools.is_some());
        let model = native
            .session
            .model
            .as_ref()
            .map(|model| format!("{}/{}", model.provider_id, model.model_id))
            .ok_or("请先选择模型")?;
        let paths = HarnessPaths::resolve(app)?;
        let accounts = crate::commands::agent_dispatch::accounts(app).await?;
        let plugins = local_interactive.then(|| {
            PluginSelection::load(&profile).unwrap_or_else(|error| {
                log::warn!("{error}");
                PluginSelection::default()
            })
        });
        let mut desktop = self.0.lock().await;
        if desktop.closing {
            return Err("Harness 正在关闭".into());
        }
        if let Some(active) = desktop.flights.get(&id) {
            let saved = active.record.lock().await;
            if check_receipt(&saved, &request_id, &fingerprint)? {
                return secretary_response(&saved, &request_id, secretary.as_ref());
            }
            if automation_idle_only {
                return Err("目标对话仍有任务在运行，请等待对话空闲后再投递".into());
            }
            if unsettled(&saved.snapshot.status) || secretary.is_some() {
                return Err("Harness 正在处理本轮，请先等待或停止".into());
            }
            if compact || args["queuedResume"] == true {
                return Err("请先等待后台作业结束，再执行此命令".into());
            }
            active.permission_selection.check_queue(&native.session)?;
            if active.model != model || active.project != project || active.policy != policy {
                return Err("模型或工作区已更改。请先结束后台作业，再按新设置发送消息。".into());
            }
            let controls = active.controls.clone();
            drop(saved);
            drop(desktop);
            send_control(&controls, |reply| {
                if mode_command {
                    Control::ModeCommand {
                        args: args.clone(),
                        reply,
                    }
                } else {
                    Control::Enqueue {
                        args: args.clone(),
                        reply,
                    }
                }
            })
            .await?;
            return Ok(Value::Null);
        }
        let file = root.join("desktop.json");
        let mut record = if file.is_file() {
            load_record(&file, &id)?
        } else {
            record_from_snapshot(native.clone(), &profile)?
        };
        let resume = args["queuedResume"] == true;
        if check_receipt(&record, &request_id, &fingerprint)? && !resume {
            return secretary_response(&record, &request_id, secretary.as_ref());
        }
        let stop_key = (id.clone(), request_id.clone());
        let stopped_before_admission = desktop.early_stops.contains(&stop_key);
        if stopped_before_admission && secretary.is_none() {
            if record.receipts.len() >= MAX_RECEIPTS {
                return Err("此会话已达到请求记录上限，请新建会话".into());
            }
            record.receipts.insert(
                request_id,
                CommandReceipt {
                    fingerprint,
                    status: ReceiptStatus::Cancelled,
                },
            );
            record.snapshot.status = AgentStatus::Idle;
            record.snapshot.error = None;
            save_record(&file, &record)?;
            desktop.early_stops.remove(&stop_key);
            drop(desktop);
            notify_snapshot_changed(app, &id);
            return Ok(Value::Null);
        }
        desktop.early_stops.remove(&stop_key);
        if automation_idle_only
            && (record.snapshot.queue_paused
                || !record.queue.is_empty()
                || !record.snapshot.queued_messages.is_empty())
        {
            return Err("目标对话还有排队消息，请处理后再投递自动化任务".into());
        }
        if let Some(command) = &secretary {
            if let Some(task) = record.secretary.existing_delegation(&request_id, command)? {
                return to_value(task);
            }
        }
        if resume {
            record.queue.retain(|input| input.id() != request_id);
            record
                .snapshot
                .queued_messages
                .retain(|input| input.id != request_id);
        }
        if record.receipts.len() >= MAX_RECEIPTS {
            return Err("此会话已达到请求记录上限，请新建会话".into());
        }
        let permission_selection = PermissionSelection::from_session(&native.session);
        record.snapshot.session = native.session;
        if background {
            record.snapshot.session.permission_mode = "ask".into();
        } else if remote_tools.is_some() && record.snapshot.session.permission_mode == "full_access"
        {
            record.snapshot.session.permission_mode = "auto".into();
        }
        record.snapshot.session.updated_at = now();
        record.snapshot.status = AgentStatus::Running;
        record.snapshot.error = None;
        record.snapshot.preview = None;
        record.snapshot.permissions.clear();
        record.snapshot.questions.clear();
        record.snapshot.stream_connected = false;
        if compact || mode_command {
            push_command_message(
                &mut record.snapshot,
                request_id.clone(),
                "user",
                args["text"].as_str().unwrap_or_default().trim().into(),
            );
        }
        let (worker, result) = match secretary {
            Some(command) => {
                let (task, action) =
                    prepare_secretary_action(&mut record, &profile, &request_id, command).await?;
                (Some(action), to_value(task)?)
            }
            None => (None, Value::Null),
        };
        let worker_queue_request = args["workerQueueRequest"].as_str().map(str::to_owned);
        record.receipts.insert(
            request_id.clone(),
            CommandReceipt {
                fingerprint,
                status: ReceiptStatus::Accepted,
            },
        );
        std::fs::create_dir_all(&root).map_err(|_| "无法创建 Harness 会话目录")?;
        save_record(&file, &record)?;
        let record = Arc::new(Mutex::new(record));
        let (controls, inbox) = mpsc::channel(8);
        let (done, stopped) = tokio::sync::watch::channel(false);
        desktop.flights.insert(
            id.clone(),
            Flight {
                request_id: request_id.clone(),
                permission_selection,
                plugins: plugins.clone(),
                model: model.clone(),
                project: project.clone(),
                policy,
                retained: false,
                record: record.clone(),
                controls,
                stopped,
            },
        );
        drop(desktop);

        let host = self.clone();
        let app = app.clone();
        let state = app.state::<AppState>().inner().clone();
        let preview = carrier.harness_preview.clone();
        let browser = carrier.browser.clone();
        let (mcp_host, skills) = tokio::join!(carrier.harness_mcp(), carrier.workspace_skills());
        let applications = Arc::new(super::remote_agent_tools::DesktopToolHost {
            local: super::agent_applications::DesktopApplicationTools(state.clone()),
            remote,
            mcp: None,
            browser: browser.clone(),
        });
        tauri::async_runtime::spawn(async move {
            let result = run_turn(Turn {
                app: &app,
                id: &id,
                request_id: &request_id,
                profile,
                root,
                project,
                paths,
                plugins,
                model,
                accounts,
                content,
                auto_title,
                compact,
                mode_command,
                worker,
                worker_queue_request,
                state,
                preview,
                browser,
                mcp_host,
                applications,
                remote_tools,
                policy,
                local_interactive,
                skills,
                record: record.clone(),
                inbox,
                desktop: host.clone(),
            })
            .await;
            let (result, idle_runtime) = match result {
                Ok((status, runtime)) => (Ok(status), runtime),
                Err(error) => (Err(error), None),
            };
            let mut desktop = host.0.lock().await;
            let mut saved = record.lock().await;
            let outcome = match result {
                Ok(status) => {
                    saved.snapshot.status = AgentStatus::Idle;
                    saved.snapshot.error = None;
                    status
                }
                Err(error) => {
                    saved.snapshot.status = AgentStatus::Error;
                    saved.snapshot.error = Some(error);
                    ReceiptStatus::Failed
                }
            };
            if let Some(receipt) = saved
                .receipts
                .get_mut(&request_id)
                .filter(|receipt| receipt.status == ReceiptStatus::Accepted)
            {
                receipt.status = outcome;
            }
            saved.snapshot.background_jobs = 0;
            saved.snapshot.title_pending = false;
            saved.snapshot.session.updated_at = now();
            clear_waits(&mut saved.snapshot);
            saved.secretary.settle_interrupted();
            park_worker_queues(&mut saved);
            for input in &mut saved.queue {
                input.sdk_id = None;
            }
            for item in &mut saved.snapshot.queued_messages {
                item.delivery = None;
            }
            saved.snapshot.queue_paused = !saved.queue.is_empty();
            if let Err(error) = save_record(&file, &saved) {
                log::warn!("{error}");
            }
            // Publishing idle and lending the SDK to a later request share
            // the same lock. A new send cannot borrow an entry being retired.
            let (retired, discard) = match idle_runtime {
                Some(runtime) if !desktop.closing && outcome == ReceiptStatus::Completed => {
                    (desktop.warm.insert(id.clone(), runtime), None)
                }
                runtime => (Vec::new(), runtime),
            };
            desktop.flights.remove(&id);
            drop(saved);
            drop(desktop);
            notify_snapshot_changed(&app, &id);
            for handle in retired {
                if let Err(error) = handle.retire().await {
                    log::warn!("{error}");
                }
            }
            if let Some(runtime) = discard {
                let _ = runtime.client.shutdown().await;
            }
            let _ = done.send(true);
        });
        Ok(result)
    }

    pub(super) async fn shutdown(&self) {
        let flights = {
            let mut state = self.0.lock().await;
            state.closing = true;
            state
                .flights
                .values()
                .map(|flight| (flight.controls.clone(), flight.stopped.clone()))
                .collect::<Vec<_>>()
        };
        for (controls, mut stopped) in flights {
            let _ = controls.send(Control::Shutdown).await;
            let _ = stopped.wait_for(|stopped| *stopped).await;
        }
        if let Err(error) = self.retire_idle(None).await {
            log::warn!("{error}");
        }
    }
}

fn now() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

fn read_worker_owner(root: &Path, child: &str) -> Option<String> {
    let file = root.join("secretary-owner.json");
    if std::fs::symlink_metadata(&file)
        .ok()
        .is_none_or(|entry| !entry.is_file() || entry.len() > 128)
    {
        return None;
    }
    let owner: String = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    (owner != child && private_root(root, &owner).is_some()).then_some(owner)
}

fn save_worker_owner(profile: &Path, owner: &str, child: &str) -> Result<(), String> {
    let root = private_root(profile, child).ok_or("无效的 Harness 子任务标识")?;
    if private_root(profile, owner) == Some(root.clone()) {
        return Err("秘书不能成为自己的子任务".into());
    }
    if let Some(existing) = read_worker_owner(&root, child) {
        return if existing == owner {
            Ok(())
        } else {
            Err("Harness 子任务归属发生冲突".into())
        };
    }
    std::fs::create_dir_all(&root).map_err(|_| "无法保存 Harness 子任务归属")?;
    config::write_json_file_private(&root.join("secretary-owner.json"), &owner)
        .map_err(|_| "无法保存 Harness 子任务归属".into())
}

fn existing_markdown_directory(path: &Path) -> Result<Option<PathBuf>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取 Harness 日志目录".into()),
    }
    let canonical =
        canonical_project(&path.to_string_lossy()).map_err(|_| "Harness 日志目录无效")?;
    if canonical != path {
        return Err("Harness 日志目录超出会话数据范围".into());
    }
    Ok(Some(canonical))
}

fn markdown_session<'a>(
    record: &'a SessionRecord,
    owner: &str,
    id: &str,
) -> Result<&'a AgentSession, String> {
    if record.snapshot.session.id != owner {
        return Err("Harness 会话编号与记录不符".into());
    }
    let session = if owner == id {
        &record.snapshot.session
    } else {
        let child = record.secretary.child(id).ok_or("此子任务不属于当前秘书")?;
        let task_id = child
            .session
            .coordination
            .as_ref()
            .filter(|link| {
                link.role == "worker" && link.parent_session_id.as_deref() == Some(owner)
            })
            .and_then(|link| link.task_id.as_deref())
            .ok_or("此子任务不属于当前秘书")?;
        record
            .secretary
            .task(task_id)
            .filter(|task| task.session_id == id && task.parent_session_id == owner)
            .ok_or("此子任务不属于当前秘书")?;
        // Legacy Rust workers retain their original task IDs on migration,
        // even when a copied legacy history file is no longer present.
        if task_id.starts_with("task-") {
            return Err(LEGACY_MARKDOWN.into());
        }
        &child.session
    };
    if !record.root_created {
        return Err(MARKDOWN_MISSING.into());
    }
    Ok(session)
}

fn view_snapshot(record: &SessionRecord, id: &str, owner: &str) -> Result<AgentSnapshot, String> {
    if owner == id {
        Ok(record.snapshot.clone())
    } else {
        let mut snapshot = record
            .secretary
            .child(id)
            .cloned()
            .ok_or("此子任务不属于当前秘书")?;
        record
            .secretary
            .decorate_child_session(&mut snapshot.session);
        if let Some(queue) = record.worker_queues.get(id) {
            snapshot.queued_messages = queue
                .inputs
                .iter()
                .filter(|input| !input.provisional)
                .map(|input| input.message.clone())
                .collect();
            snapshot.queue_paused =
                !queue.inputs.is_empty() && (queue.paused || !unsettled(&snapshot.status));
        }
        Ok(snapshot)
    }
}

fn update_worker_permission(
    record: &mut SessionRecord,
    file: &Path,
    id: &str,
    mode: &str,
) -> Result<lolicode_agent::AgentSession, String> {
    let mut previous = record
        .secretary
        .child(id)
        .ok_or("此子任务不属于当前秘书")?
        .session
        .clone();
    record.secretary.decorate_child_session(&mut previous);
    let session = record.secretary.update_child_permission(id, mode)?;
    if let Err(error) = save_record(file, record) {
        let _ = record
            .secretary
            .update_child_permission(id, &previous.permission_mode);
        return Err(error);
    }
    Ok(session)
}

fn workspace_policy(
    session: &lolicode_agent::AgentSession,
    background: bool,
    remote: bool,
) -> &'static str {
    if session.mode == "plan" {
        return "plan";
    }
    if background {
        return "review";
    }
    match session.permission_mode.as_str() {
        "full_access" if !remote => "full",
        "full_access" | "auto" => "workspace",
        _ => "review",
    }
}

fn full_tool_access(
    local_interactive: bool,
    turn_policy: &str,
    owner_policy: Option<&str>,
) -> bool {
    local_interactive && turn_policy != "plan" && owner_policy == Some("full")
}

fn worker_root(record: &SessionRecord, id: &str) -> Result<(String, PathBuf), String> {
    let worker = record.secretary.child(id).ok_or("此子任务不属于当前秘书")?;
    let execution = record
        .secretary
        .child_execution_root(id)
        .ok_or("Harness 子任务的工作目录尚未验证")?;
    Ok((worker.session.project_path.clone(), execution))
}

fn clear_waits(snapshot: &mut AgentSnapshot) {
    snapshot.permissions.clear();
    snapshot.questions.clear();
    snapshot.stream_connected = false;
    snapshot.model_phase = None;
    snapshot
        .messages
        .retain(|message| !is_live_message(&message.id));
    if unsettled(&snapshot.status) {
        snapshot.status = AgentStatus::Error;
        snapshot.error = Some(INTERRUPTED.into());
    }
}

fn unsettled(status: &AgentStatus) -> bool {
    matches!(
        status,
        AgentStatus::Running | AgentStatus::WaitingPermission | AgentStatus::WaitingQuestion
    )
}

fn load_sidebar(profile: &Path, id: &str) -> Result<Option<Arc<SessionSidebar>>, String> {
    let Some(root) = private_root(profile, id) else {
        return Ok(None);
    };
    let file = root.join("desktop.json");
    let entry = SIDEBAR_CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(file.clone())
        .or_default()
        .clone();
    if let Some(cached) = entry.get() {
        return Ok(cached.clone());
    }
    let loaded = if file.is_file() {
        let record = load_record(&file, id)?;
        let status = if unsettled(&record.snapshot.status) {
            AgentStatus::Error
        } else {
            record.snapshot.status
        };
        let secretary = super::harness_sessions::role(&record.snapshot.session, "secretary")
            .then(|| record.secretary.sidebar(id, true));
        Some(Arc::new(SessionSidebar {
            updated_at: record.snapshot.session.updated_at,
            status,
            secretary,
        }))
    } else {
        None
    };
    Ok(entry.get_or_init(|| loaded).clone())
}

fn load_record(file: &Path, id: &str) -> Result<SessionRecord, String> {
    let metadata = std::fs::symlink_metadata(file).map_err(|_| "无法读取 Harness 会话")?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
        return Err("Harness 会话文件无效".into());
    }
    let bytes = std::fs::read(file).map_err(|_| "无法读取 Harness 会话")?;
    let mut record: SessionRecord =
        serde_json::from_slice(&bytes).map_err(|_| "Harness 会话文件损坏，原文件已保留")?;
    if record.snapshot.session.id != id {
        return Err("Harness 会话编号与记录不符".into());
    }
    // A crash may leave the durable input reservation without its public row.
    // A cold record can still recover it as a paused message.
    for input in &record.queue {
        if input.args["delivery"] == "steer"
            && !record
                .snapshot
                .queued_messages
                .iter()
                .any(|item| item.id == input.id())
        {
            let mut row = queued_message(&input.args)?;
            row.delivery = None;
            record.snapshot.queued_messages.push(row);
            record.snapshot.queue_paused = true;
        }
    }
    for row in &mut record.snapshot.queued_messages {
        row.delivery = None;
    }
    // Child inbox IDs from an earlier process cannot address the new actor.
    record.snapshot.background_jobs = 0;
    record.snapshot.title_pending = false;
    if let Some(goal) = &mut record.snapshot.goal {
        goal.activation = "disarmed".into();
    }
    if let Some(plan) = &mut record.snapshot.plan {
        plan.pending = None;
    }
    record.secretary.clear_background_jobs();
    park_worker_queues(&mut record);
    Ok(record)
}

fn park_worker_queues(record: &mut SessionRecord) {
    for queue in record.worker_queues.values_mut() {
        queue.paused = !queue.inputs.is_empty();
        for input in &mut queue.inputs {
            input.sdk_id = None;
            input.message.delivery = None;
            input.provisional = false;
        }
    }
}

fn save_record(file: &Path, record: &SessionRecord) -> Result<(), String> {
    config::write_json_file_private(file, record)
        .map_err(|_| "无法保存 Harness 会话，原记录已保留")?;
    if let Some(cache) = SIDEBAR_CACHE.get() {
        // A reader already loading the old record may finish its current
        // request, but it can only fill the now-detached cache entry.
        cache
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(file);
    }
    Ok(())
}

fn remember_native_message_alias(record: &mut SessionRecord, native: &str, request: &str) {
    if !native.is_empty() && !request.is_empty() {
        // Only an explicit SDK receipt or a matched pending input establishes
        // this business identity. Never infer it from text or old DTO history.
        record
            .native_message_aliases
            .entry(native.to_owned())
            .or_insert_with(|| request.to_owned());
    }
}

fn notify_native_message_aliases_changed(app: &AppHandle, session_id: &str) {
    let _ = app.emit_to(
        "main",
        "agent-native-message-aliases-changed",
        json!({"sessionId": session_id}),
    );
}

fn record_from_snapshot(snapshot: AgentSnapshot, profile: &Path) -> Result<SessionRecord, String> {
    let mut record = SessionRecord {
        snapshot,
        root_created: false,
        receipts: BTreeMap::new(),
        native_message_aliases: BTreeMap::new(),
        secretary: HarnessSecretary::default(),
        queue: Vec::new(),
        withdrawn: Vec::new(),
        worker_queues: BTreeMap::new(),
    };
    let migration = HarnessMigration::new(profile)?;
    if let Some(source) = migration.find_legacy(&record.snapshot.session.id)? {
        record
            .secretary
            .import_legacy(&record.snapshot.session.id, source.secretary_tasks());
        if !record.snapshot.queued_messages.is_empty() {
            import_queued_inputs(&mut record, source.queued_inputs())?;
        }
    }
    Ok(record)
}

fn to_value(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "Harness 桌面状态无法编码".into())
}

fn check_receipt(record: &SessionRecord, id: &str, fingerprint: &str) -> Result<bool, String> {
    check_command_receipt(&record.receipts, id, fingerprint)
}

fn message_fingerprint(content: &Value, steering: bool) -> String {
    let digest = Sha256::digest(content.to_string().as_bytes());
    if steering {
        format!("steer:{digest:x}")
    } else {
        format!("{digest:x}")
    }
}

fn queued_message(args: &Value) -> Result<AgentQueuedMessage, String> {
    serde_json::from_value(json!({
        "id":args["requestId"], "text":args["text"],
        "createdAt":args["createdAt"], "attachments":args["attachments"],
        "delivery":args["delivery"],
    }))
    .map_err(|_| "排队消息格式无效".into())
}

fn check_command_receipt(
    receipts: &BTreeMap<String, CommandReceipt>,
    id: &str,
    fingerprint: &str,
) -> Result<bool, String> {
    match receipts.get(id) {
        None => Ok(false),
        Some(receipt) if receipt.fingerprint == fingerprint => Ok(true),
        Some(_) => Err("同一个请求编号已用于其他输入".into()),
    }
}

fn command_status(
    record: &SessionRecord,
    session: &str,
    owner: &str,
    request: &str,
) -> Option<ReceiptStatus> {
    if let Some(receipt) = record
        .worker_queues
        .get(session)
        .and_then(|queue| queue.receipts.get(request))
    {
        return Some(receipt.status);
    }
    if session != owner && record.secretary.child(session).is_none() {
        return None;
    }
    record.receipts.get(request).map(|receipt| receipt.status)
}

fn check_worker_queue_access<'a>(
    app: &AppHandle,
    saved: &'a SessionRecord,
    id: &str,
) -> Result<&'a str, String> {
    let child = saved.secretary.child(id).ok_or("子任务不属于此秘书")?;
    let task = child
        .session
        .coordination
        .as_ref()
        .and_then(|link| link.task_id.as_deref())
        .and_then(|task| saved.secretary.task(task))
        .ok_or("子任务不属于此秘书")?;
    if child.session.archived
        || task.session_id != id
        || task.parent_session_id != saved.snapshot.session.id
    {
        return Err("子任务不属于此秘书".into());
    }
    crate::commands::agent_dispatch::check_project(app, &child.session.project_path)?;
    Ok(&task.id)
}

fn worker_rpc_id(request: &str) -> String {
    format!("{:x}", Sha256::digest(request.as_bytes()))
}

fn worker_queue_input<'a>(
    saved: &'a SessionRecord,
    session: &str,
    request: &str,
) -> Result<&'a WorkerQueuedInput, String> {
    saved
        .worker_queues
        .get(session)
        .and_then(|queue| {
            queue
                .inputs
                .iter()
                .find(|input| input.message.id == request)
        })
        .ok_or_else(|| "该排队消息已开始执行或已撤回".into())
}

fn worker_queue_fingerprint(args: &Value, content: &Value) -> String {
    let delivery = if args["delivery"] == "steer" {
        "steer"
    } else {
        "queue"
    };
    format!(
        "worker-{delivery}:{:x}",
        Sha256::digest(content.to_string().as_bytes())
    )
}

fn check_worker_queue_duplicate(
    saved: &SessionRecord,
    session: &str,
    args: &Value,
    content: &Value,
) -> Result<bool, String> {
    let id = request_id(args)?;
    if let Some(queue) = saved.worker_queues.get(session) {
        if check_command_receipt(
            &queue.receipts,
            id,
            &worker_queue_fingerprint(args, content),
        )? {
            return match queue.receipts[id].status {
                ReceiptStatus::Accepted | ReceiptStatus::Completed => Ok(true),
                ReceiptStatus::Cancelled => Err("这条排队消息已撤回。".into()),
                ReceiptStatus::Failed => Err("这条消息未被接收，请重新发送。".into()),
            };
        }
    }
    Ok(false)
}

fn add_worker_queue_input(
    saved: &mut SessionRecord,
    session: &str,
    args: &Value,
    content: &Value,
) -> Result<(), String> {
    let id = request_id(args)?;
    let steering = args["delivery"] == "steer";
    let fingerprint = worker_queue_fingerprint(args, content);
    if let Some(queue) = saved.worker_queues.get(session) {
        if queue.inputs.len() >= 32 || queue.receipts.len() >= MAX_RECEIPTS {
            return Err("子任务待发送消息已达到容量上限".into());
        }
    }
    let bytes = saved
        .worker_queues
        .values()
        .flat_map(|queue| {
            queue
                .inputs
                .iter()
                .map(|input| &input.args)
                .chain(queue.withdrawn.iter())
        })
        .map(|args| args.to_string().len())
        .sum::<usize>();
    if bytes + args.to_string().len() > 24 * 1024 * 1024 {
        return Err("秘书待发送消息已达到容量上限".into());
    }
    let created = now();
    let mut args = args.clone();
    args["createdAt"] = json!(created);
    if args["attachments"].is_null() {
        args["attachments"] = json!([]);
    }
    let message = serde_json::from_value(json!({
        "id": id, "text": args["text"], "createdAt": created,
        "attachments": args["attachments"], "delivery": if steering { Some("steer") } else { None },
    }))
    .map_err(|_| "子任务排队消息格式无效")?;
    let queue = saved.worker_queues.entry(session.into()).or_default();
    queue.inputs.push(WorkerQueuedInput {
        message,
        args,
        sdk_id: None,
        provisional: steering,
    });
    queue.receipts.insert(
        id.into(),
        CommandReceipt {
            fingerprint,
            status: ReceiptStatus::Accepted,
        },
    );
    Ok(())
}

fn withdraw_worker_queue_input(
    saved: &mut SessionRecord,
    session: &str,
    request: &str,
) -> Result<Value, String> {
    let queue = saved
        .worker_queues
        .get_mut(session)
        .ok_or("该排队消息已开始执行或已撤回")?;
    if let Some(input) = queue
        .withdrawn
        .iter()
        .find(|input| input["requestId"] == request)
    {
        return Ok(input.clone());
    }
    let index = queue
        .inputs
        .iter()
        .position(|input| input.message.id == request)
        .ok_or("该排队消息已开始执行或已撤回")?;
    let input = queue.inputs.remove(index).args;
    queue.withdrawn.push(input.clone());
    if queue.withdrawn.len() > 8 {
        queue.withdrawn.remove(0);
    }
    queue.paused &= !queue.inputs.is_empty();
    if let Some(receipt) = queue.receipts.get_mut(request) {
        receipt.status = ReceiptStatus::Cancelled;
    }
    Ok(input)
}

fn claim_worker_queue_message(
    saved: &mut SessionRecord,
    sdk_root: &str,
    notification: &Value,
) -> Option<(String, String, String)> {
    let params = &notification["params"];
    let source = params["sessionId"]
        .as_str()
        .filter(|source| *source != sdk_root)?;
    let event = &params["event"];
    if event["type"] != "user/message" || event["data"]["source"]["kind"] != "user" {
        return None;
    }
    let native = event["data"]["id"].as_str()?;
    let rpc_id = event["data"]["source"]["rpcId"].as_str();
    let session = format!("lc:{source}");
    let queue = saved.worker_queues.get_mut(&session)?;
    let index = queue.inputs.iter().position(|input| {
        input.sdk_id.as_deref() == Some(native)
            || rpc_id.is_some_and(|id| id == worker_rpc_id(&input.message.id))
    })?;
    let request = queue.inputs.remove(index).message.id;
    queue.paused &= !queue.inputs.is_empty();
    remember_native_message_alias(saved, native, &request);
    Some((session, native.into(), request))
}

fn request_id(args: &Value) -> Result<&str, String> {
    args["requestId"]
        .as_str()
        .filter(|id| !id.trim().is_empty() && id.len() <= 256 && !id.contains('\0'))
        .ok_or_else(|| "无效的请求编号".into())
}

fn secretary_fingerprint(args: &Value) -> String {
    format!(
        "secretary:{:x}",
        Sha256::digest(args.to_string().as_bytes())
    )
}

fn secretary_response(
    record: &SessionRecord,
    request: &str,
    command: Option<&SecretaryCommand>,
) -> Result<Value, String> {
    let Some(command) = command else {
        return Ok(Value::Null);
    };
    let task = match command.task_id() {
        Some(task) => record.secretary.task(task),
        None => record.secretary.task_for_request(request),
    }
    .ok_or("任务已移除或不存在")?;
    to_value(task)
}

async fn prepare_secretary_action(
    record: &mut SessionRecord,
    profile: &Path,
    request: &str,
    command: SecretaryCommand,
) -> Result<(lolicode_agent::AgentSecretaryTask, WorkerAction), String> {
    if record
        .snapshot
        .session
        .coordination
        .as_ref()
        .is_none_or(|link| link.role != "secretary")
    {
        return Err("只有总秘书可以分派或补充任务".into());
    }
    let migration = HarnessMigration::new(profile)?;
    let owner = &record.snapshot.session.id;
    if let Some(source) = migration.find_legacy(owner)? {
        record
            .secretary
            .import_legacy(owner, source.secretary_tasks());
    }
    let legacy = if let Some(task) = command
        .task_id()
        .filter(|task| record.secretary.task_sdk_id(task).is_none())
    {
        let task = record.secretary.task(task).ok_or("此任务不属于当前秘书")?;
        let source = migration.read_legacy(&task.session_id)?;
        Some((source.snapshot().clone(), legacy_context(&source)))
    } else {
        None
    };
    record
        .secretary
        .prepare_action(profile, &record.snapshot, request, command, legacy)
        .await
}

fn import_queued_inputs(record: &mut SessionRecord, inputs: &[Value]) -> Result<(), String> {
    for existing in &record.snapshot.queued_messages {
        let raw = inputs
            .iter()
            .find(|entry| entry["requestId"] == existing.id)
            .ok_or("旧队列缺少原始消息，已保留原会话")?;
        let content = content_blocks(raw).unwrap_or_else(|_| raw.clone());
        let fingerprint = format!("{:x}", Sha256::digest(content.to_string().as_bytes()));
        record.queue.push(QueuedInput {
            sdk_id: None,
            args: raw.clone(),
        });
        record.receipts.insert(
            existing.id.clone(),
            CommandReceipt {
                fingerprint,
                status: ReceiptStatus::Accepted,
            },
        );
    }
    record.snapshot.queue_paused = !record.queue.is_empty();
    Ok(())
}

fn withdraw(record: &mut SessionRecord, id: &str) -> Result<Value, String> {
    if let Some(input) = record
        .withdrawn
        .iter()
        .find(|input| input["requestId"] == id)
    {
        return Ok(input.clone());
    }
    let index = record
        .queue
        .iter()
        .position(|input| input.id() == id)
        .ok_or("该排队消息已开始执行或已撤回")?;
    let removed = record.queue.remove(index).args;
    record
        .snapshot
        .queued_messages
        .retain(|entry| entry.id != id);
    record.snapshot.queue_paused &= !record.queue.is_empty();
    record.withdrawn.push(removed.clone());
    while record.withdrawn.len() > 8
        || record
            .withdrawn
            .iter()
            .map(|value| value.to_string().len())
            .sum::<usize>()
            > 20 * 1024 * 1024
    {
        record.withdrawn.remove(0);
    }
    Ok(removed)
}

async fn enqueue_live(
    turn: &Turn<'_>,
    client: &HarnessClient,
    sdk_id: &str,
    mut args: Value,
) -> Result<(), String> {
    let id = args["requestId"]
        .as_str()
        .filter(|id| !id.trim().is_empty() && id.len() <= 256 && !id.contains('\0'))
        .ok_or("无效的队列编号")?
        .to_owned();
    let steering = args["delivery"] == "steer";
    let content = content_blocks(&args)?;
    let fingerprint = message_fingerprint(&content, steering);
    let created = now();
    args["createdAt"] = json!(created);
    if args["attachments"].is_null() {
        args["attachments"] = json!([]);
    }
    let entry = queued_message(&args)?;
    let file = turn.root.join("desktop.json");
    {
        let mut saved = turn.record.lock().await;
        if check_receipt(&saved, &id, &fingerprint)? {
            return Ok(());
        }
        if saved.queue.len() >= 32
            || saved.receipts.len() >= MAX_RECEIPTS
            || saved
                .queue
                .iter()
                .map(|entry| entry.args.to_string().len())
                .sum::<usize>()
                + args.to_string().len()
                > 24 * 1024 * 1024
        {
            return Err("待发送消息已达到容量上限".into());
        }
        saved.queue.push(QueuedInput { sdk_id: None, args });
        if !steering {
            saved.snapshot.queued_messages.push(entry.clone());
        }
        saved.receipts.insert(
            id.clone(),
            CommandReceipt {
                fingerprint,
                status: ReceiptStatus::Accepted,
            },
        );
        if let Err(error) = save_record(&file, &saved) {
            saved.queue.pop();
            if !steering {
                saved.snapshot.queued_messages.pop();
            }
            saved.receipts.remove(&id);
            return Err(error);
        }
    }
    let result = if steering {
        let result = client
            .request(
                "lolicode/session/steer",
                json!({"sessionId":sdk_id,"requestId":id,"contentBlocks":content}),
            )
            .await;
        let Ok(result) = result else {
            // The desktop owns the saved input. A lost SDK response can still
            // settle by its durable request source, or remain in the paused queue.
            let mut saved = turn.record.lock().await;
            saved.snapshot.queued_messages.push(entry);
            if let Err(error) = save_record(&file, &saved) {
                log::warn!("{error}");
            }
            return Ok(());
        };
        if result["status"] == "rejected" {
            let mut saved = turn.record.lock().await;
            let input = saved.queue.pop().ok_or("排队记录已变化")?;
            let receipt = saved.receipts.remove(&id);
            if save_record(&file, &saved).is_err() {
                saved.queue.push(input);
                saved.snapshot.queued_messages.push(entry);
                if let Some(receipt) = receipt {
                    saved.receipts.insert(id, receipt);
                }
                return Ok(());
            }
            return Err(result["message"]
                .as_str()
                .unwrap_or("当前任务未接收插入消息")
                .into());
        }
        result
    } else {
        client
            .request(
                "session/prompt",
                json!({"sessionId":sdk_id,"contentBlocks":content}),
            )
            .await?
    };
    let message_id = result["messageId"].as_str().ok_or("Harness 缺少队列回执")?;
    let mut saved = turn.record.lock().await;
    let queued = saved
        .queue
        .iter_mut()
        .find(|entry| entry.id() == id)
        .ok_or("排队记录已变化")?;
    queued.sdk_id = Some(message_id.to_owned());
    remember_native_message_alias(&mut saved, message_id, &id);
    if steering {
        saved.snapshot.queued_messages.push(entry);
        if let Err(error) = save_record(&file, &saved) {
            log::warn!("{error}");
        } else {
            notify_native_message_aliases_changed(turn.app, turn.id);
        }
        Ok(())
    } else {
        save_record(&file, &saved)?;
        notify_native_message_aliases_changed(turn.app, turn.id);
        Ok(())
    }
}

async fn edit_queue(
    turn: &Turn<'_>,
    client: &HarnessClient,
    sdk_id: &str,
    id: &str,
    action: &str,
) -> Result<Value, String> {
    let message = {
        let saved = turn.record.lock().await;
        if action == "remove" {
            if let Some(input) = saved
                .withdrawn
                .iter()
                .find(|input| input["requestId"] == id)
            {
                return Ok(input.clone());
            }
        }
        saved
            .queue
            .iter()
            .find(|entry| entry.id() == id)
            .ok_or("该排队消息已开始执行或已撤回")?
            .sdk_id
            .clone()
    };
    if let Some(message_id) = message {
        client
            .request(
                "lolicode/session/queued-action",
                json!({"sessionId":sdk_id,"messageId":message_id,"action":action}),
            )
            .await?;
    } else if action != "remove" {
        return Err("该消息已暂停，请在本轮结束后发送".into());
    }
    if action != "remove" {
        {
            let mut saved = turn.record.lock().await;
            if let Some(row) = saved
                .snapshot
                .queued_messages
                .iter_mut()
                .find(|row| row.id == id)
            {
                row.delivery = Some("steer".into());
            }
        }
        notify_snapshot_changed(turn.app, turn.id);
        return Ok(Value::Null);
    }
    let mut saved = turn.record.lock().await;
    let input = withdraw(&mut saved, id)?;
    save_record(&turn.root.join("desktop.json"), &saved)?;
    Ok(input)
}

fn mark_worker_input_live(saved: &mut SessionRecord, session: &str, request: &str, sdk_id: String) {
    if let Some(queue) = saved.worker_queues.get_mut(session) {
        if let Some(input) = queue
            .inputs
            .iter_mut()
            .find(|input| input.message.id == request)
        {
            input.sdk_id = Some(sdk_id.clone());
            input.provisional = false;
        }
        queue.paused &= queue.inputs.iter().any(|input| input.sdk_id.is_none());
    }
    remember_native_message_alias(saved, &sdk_id, request);
}

enum WorkerQueueDelivery {
    Admitted,
    Rejected(String),
}

async fn deliver_worker_queue_input(
    turn: &Turn<'_>,
    client: &HarnessClient,
    sdk_id: &str,
    session: &str,
    request: &str,
    delivery: &str,
) -> Result<WorkerQueueDelivery, String> {
    let (child, policy, content) = {
        let saved = turn.record.lock().await;
        let task = check_worker_queue_access(turn.app, &saved, session)?;
        let child = saved
            .secretary
            .child_sdk_id(session)
            .ok_or("子任务不属于此秘书")?;
        let input = worker_queue_input(&saved, session, request)?;
        let mut content = content_blocks(&input.args)?;
        if saved
            .secretary
            .task(task)
            .is_some_and(|task| task.worktree.is_some())
        {
            content.as_array_mut().expect("content is an array").insert(0, json!({"type":"text","text":"This task uses an independent Git worktree. Read and edit files only in its working directory. Leave its changes and branch for review. Do not merge, push, or change the primary checkout."}));
        }
        let policy = saved.secretary.child_queue_policy(session)?;
        let policy = if turn.policy == "plan" {
            "plan"
        } else if turn.remote_tools.is_some() && policy == "full" {
            "workspace"
        } else {
            policy
        };
        (child.to_owned(), policy, content)
    };
    let result = client.request("lolicode/secretary/prompt-worker", json!({
        "sessionId": sdk_id, "childSessionId": child, "content": content,
        "workspacePolicy": policy, "requestId": worker_rpc_id(request), "delivery": delivery,
    })).await?;
    if result["status"] == "rejected" {
        return Ok(WorkerQueueDelivery::Rejected(
            result["message"]
                .as_str()
                .unwrap_or("子任务拒绝了这条消息")
                .into(),
        ));
    }
    let message = result["messageId"]
        .as_str()
        .ok_or("Harness 缺少子任务队列回执")?;
    let mut saved = turn.record.lock().await;
    mark_worker_input_live(&mut saved, session, request, message.into());
    if let Err(error) = save_record(&turn.root.join("desktop.json"), &saved) {
        log::warn!("子任务已接收排队消息，回执稍后由会话事件恢复：{error}");
    } else {
        notify_native_message_aliases_changed(turn.app, session);
    }
    Ok(WorkerQueueDelivery::Admitted)
}

async fn enqueue_worker_live(
    turn: &Turn<'_>,
    client: &HarnessClient,
    sdk_id: &str,
    session: &str,
    args: &Value,
) -> Result<(), String> {
    let request = request_id(args)?;
    let steering = args["delivery"] == "steer";
    let content = content_blocks(args)?;
    let file = turn.root.join("desktop.json");
    let parked = {
        let mut saved = turn.record.lock().await;
        check_worker_queue_access(turn.app, &saved, session)?;
        if check_worker_queue_duplicate(&saved, session, args, &content)? {
            return Ok(());
        }
        let running = saved
            .secretary
            .child(session)
            .is_some_and(|child| unsettled(&child.status));
        if steering && !running {
            return Err("当前子任务已经结束，请重新发送。".into());
        }
        let paused = saved
            .worker_queues
            .get(session)
            .is_some_and(|queue| queue.paused);
        let parked = !steering && (!running || paused);
        if !parked {
            saved.secretary.child_queue_policy(session)?;
        }
        let previous = saved.worker_queues.get(session).cloned();
        add_worker_queue_input(&mut saved, session, args, &content)?;
        if parked {
            saved
                .worker_queues
                .get_mut(session)
                .expect("worker queue exists")
                .paused = true;
        }
        if let Err(error) = save_record(&file, &saved) {
            if let Some(previous) = previous {
                saved.worker_queues.insert(session.into(), previous);
            } else {
                saved.worker_queues.remove(session);
            }
            return Err(error);
        }
        parked
    };
    if parked {
        return Ok(());
    }
    let delivery = if steering { "steer" } else { "queue" };
    match deliver_worker_queue_input(turn, client, sdk_id, session, request, delivery).await {
        Ok(WorkerQueueDelivery::Admitted) => {}
        Ok(WorkerQueueDelivery::Rejected(error)) => {
            let mut saved = turn.record.lock().await;
            let queue = saved
                .worker_queues
                .get_mut(session)
                .expect("worker queue exists");
            queue.inputs.retain(|input| input.message.id != request);
            if let Some(receipt) = queue.receipts.get_mut(request) {
                receipt.status = ReceiptStatus::Failed;
            }
            save_record(&file, &saved)?;
            return Err(error);
        }
        Err(error) => {
            // The exact payload is durable. An ambiguous SDK reply must not
            // discard it, since the user/message event can still claim it.
            let mut saved = turn.record.lock().await;
            let queue = saved
                .worker_queues
                .get_mut(session)
                .expect("worker queue exists");
            queue.paused = true;
            if let Some(input) = queue
                .inputs
                .iter_mut()
                .find(|input| input.message.id == request)
            {
                input.provisional = false;
            }
            save_record(&file, &saved)?;
            log::warn!("子任务队列接收待确认：{error}");
        }
    }
    Ok(())
}

async fn edit_worker_queue(
    turn: &Turn<'_>,
    client: &HarnessClient,
    sdk_id: &str,
    session: &str,
    request: &str,
    action: &str,
    steer_only: bool,
) -> Result<Value, String> {
    let (child, message, running) = {
        let saved = turn.record.lock().await;
        check_worker_queue_access(turn.app, &saved, session)?;
        if action == "remove" {
            if let Some(input) = saved.worker_queues.get(session).and_then(|queue| {
                queue
                    .withdrawn
                    .iter()
                    .find(|input| input["requestId"] == request)
            }) {
                return Ok(input.clone());
            }
        }
        let input = worker_queue_input(&saved, session, request)?;
        let child = saved
            .secretary
            .child_sdk_id(session)
            .ok_or("子任务不属于此秘书")?;
        let running = saved
            .secretary
            .child(session)
            .is_some_and(|child| unsettled(&child.status));
        (child.to_owned(), input.sdk_id.clone(), running)
    };
    if action == "steer" && steer_only && !running {
        return Err("当前子任务已经结束，这条消息仍保留在队列中。".into());
    }
    if let Some(message_id) = message {
        client.request("lolicode/session/queued-action", json!({
            "sessionId": sdk_id, "childSessionId": child, "messageId": message_id, "action": action,
        })).await?;
    } else if action != "remove" {
        let delivery = if running { "steer" } else { "queue" };
        if let WorkerQueueDelivery::Rejected(error) =
            deliver_worker_queue_input(turn, client, sdk_id, session, request, delivery).await?
        {
            return Err(error);
        }
    }
    if action != "remove" {
        if running {
            let mut saved = turn.record.lock().await;
            if let Some(input) = saved.worker_queues.get_mut(session).and_then(|queue| {
                queue
                    .inputs
                    .iter_mut()
                    .find(|input| input.message.id == request)
            }) {
                input.message.delivery = Some("steer".into());
            }
        }
        return Ok(Value::Null);
    }
    let mut saved = turn.record.lock().await;
    let input = withdraw_worker_queue_input(&mut saved, session, request)?;
    save_record(&turn.root.join("desktop.json"), &saved)?;
    Ok(input)
}

async fn stop_worker_and_park(
    turn: &Turn<'_>,
    client: &HarnessClient,
    sdk_id: &str,
    child: &str,
) -> Result<(), String> {
    let session = format!("lc:{child}");
    let pending = {
        let saved = turn.record.lock().await;
        saved
            .worker_queues
            .get(&session)
            .into_iter()
            .flat_map(|queue| &queue.inputs)
            .map(|input| worker_rpc_id(&input.message.id))
            .collect::<Vec<_>>()
    };
    let result = client
        .request(
            "lolicode/secretary/cancel-worker",
            json!({
                "sessionId": sdk_id, "childSessionId": child, "parkedRequestIds": pending,
            }),
        )
        .await?;
    let mut saved = turn.record.lock().await;
    if let Some(queue) = saved.worker_queues.get_mut(&session) {
        queue.paused = !queue.inputs.is_empty();
        for input in &mut queue.inputs {
            let rpc_id = worker_rpc_id(&input.message.id);
            if result["parked"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(rpc_id.as_str())))
            {
                input.sdk_id = None;
                input.message.delivery = None;
            }
        }
        save_record(&turn.root.join("desktop.json"), &saved)?;
    }
    Ok(())
}

async fn send_control(
    controls: &mpsc::Sender<Control>,
    make: impl FnOnce(oneshot::Sender<Result<(), String>>) -> Control,
) -> Result<(), String> {
    let (reply, result) = oneshot::channel();
    controls
        .send(make(reply))
        .await
        .map_err(|_| "Harness 本轮已结束")?;
    result.await.map_err(|_| "Harness 本轮已结束")?
}

fn reply_live_markdown(
    client: &HarnessClient,
    sdk_id: &str,
    child: Option<String>,
    reply: oneshot::Sender<Result<Option<String>, String>>,
) {
    // The read does not own the turn. Keep draining events and responding to
    // model requests while the runtime prepares the detached observation.
    let client = client.clone();
    let sdk_id = sdk_id.to_owned();
    tokio::spawn(async move {
        let result = client
            .read_session_markdown(&sdk_id, child.as_deref())
            .await;
        let _ = reply.send(result);
    });
}

fn reply_live_native(
    client: &HarnessClient,
    sdk_id: &str,
    child: Option<String>,
    request: Value,
    reply: oneshot::Sender<Result<Option<Value>, String>>,
) {
    // Like Markdown reads, native history must never stall approval/event draining.
    let client = client.clone();
    let sdk_id = sdk_id.to_owned();
    tokio::spawn(async move {
        let result = client
            .read_session_native(&sdk_id, child.as_deref(), &request)
            .await;
        let _ = reply.send(result);
    });
}

fn reply_live_native_follow(
    client: &HarnessClient,
    sdk_id: &str,
    child: Option<String>,
    id: String,
    max_messages: Option<u32>,
    reply: oneshot::Sender<Result<Option<HarnessNativeSubscription>, String>>,
) {
    let client = client.clone();
    let sdk_id = sdk_id.to_owned();
    tokio::spawn(async move {
        let result = client
            .follow_session_native(&sdk_id, child.as_deref(), id, max_messages)
            .await;
        // A cancelled opening drops a successfully created subscription here,
        // invoking its observer-only cleanup without touching the running Agent.
        let _ = reply.send(result);
    });
}

async fn send_secretary_control(
    controls: &mpsc::Sender<Control>,
    args: &Value,
    command: SecretaryCommand,
) -> Option<Result<Value, String>> {
    forward_live_control(controls, |reply| Control::SecretaryAction {
        args: args.clone(),
        command,
        reply,
    })
    .await
}

async fn forward_live_control<T>(
    controls: &mpsc::Sender<Control>,
    make: impl FnOnce(oneshot::Sender<Result<T, String>>) -> Control,
) -> Option<Result<T, String>> {
    let (reply, result) = oneshot::channel();
    controls.send(make(reply)).await.ok()?;
    result.await.ok()
}

fn content_blocks(args: &Value) -> Result<Value, String> {
    let mut blocks = Vec::new();
    if let Some(text) = args["text"].as_str().filter(|text| !text.trim().is_empty()) {
        blocks.push(json!({"type":"text","text":text}));
    }
    for attachment in args["attachments"].as_array().into_iter().flatten() {
        let mime = attachment["mime"].as_str().ok_or("附件类型无效")?;
        if !matches!(
            mime,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            return Err("Harness 开发版支持 PNG、JPEG、GIF 和 WebP 图片，文档接入正在迁移".into());
        }
        let data = attachment["ref"]
            .as_str()
            .and_then(|value| value.strip_prefix(&format!("data:{mime};base64,")))
            .ok_or("图片内容无效")?;
        blocks.push(
            json!({"type":"image","mimeType":mime,"data":data,"name":attachment["fileName"]}),
        );
    }
    if blocks.is_empty() {
        return Err("请输入内容或添加图片".into());
    }
    Ok(Value::Array(blocks))
}

fn is_compact_command(args: &Value) -> bool {
    matches!(
        args["text"].as_str().map(str::trim),
        Some("/compact" | "/压缩")
    )
}

fn native_mode_command(text: &str) -> bool {
    matches!(text.split_whitespace().next(), Some("/goal" | "/plan"))
}

fn has_live_goal(snapshot: &AgentSnapshot) -> bool {
    snapshot
        .goal
        .as_ref()
        .is_some_and(|goal| goal.phase == "active" && goal.activation == "armed")
}

fn push_command_message(snapshot: &mut AgentSnapshot, id: String, role: &str, text: String) {
    let time = now();
    snapshot.messages.push(AgentMessage {
        id,
        role: role.into(),
        created_at: time,
        completed_at: Some(time),
        parts: vec![AgentPart::Text { text }],
    });
}

async fn query_mode_command(
    client: &HarnessClient,
    sdk_id: &str,
    content: &Value,
) -> Result<(String, Value), String> {
    let result = client
        .request(
            "session/query",
            json!({"sessionId": sdk_id, "contentBlocks": content}),
        )
        .await?;
    if result["kind"] != "command" {
        return Err("当前 Harness 配置不支持此命令".into());
    }
    let execution = &result["execution"];
    let command_id = execution["commandId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Harness 缺少命令回执")?
        .to_owned();
    Ok((command_id, execution["result"].clone()))
}

fn push_mode_result(snapshot: &mut AgentSnapshot, command_id: &str, result: &Value) {
    if result["kind"] != "success" {
        return;
    }
    if let Some(text) = result["text"].as_str().filter(|text| !text.is_empty()) {
        push_command_message(
            snapshot,
            format!("harness-command:{command_id}"),
            "assistant",
            text.into(),
        );
    }
}

async fn accept_mode_command(
    turn: &Turn<'_>,
    client: &HarnessClient,
    sdk_id: &str,
    args: Value,
) -> Result<Option<(String, String)>, String> {
    let request = request_id(&args)?.to_owned();
    let text = args["text"]
        .as_str()
        .map(str::trim)
        .filter(|text| native_mode_command(text))
        .ok_or("无效的 Harness 命令")?;
    let content = content_blocks(&args)?;
    let fingerprint = message_fingerprint(&content, args["delivery"] == "steer");
    let file = turn.root.join("desktop.json");
    {
        let mut saved = turn.record.lock().await;
        if check_receipt(&saved, &request, &fingerprint)? {
            return Ok(None);
        }
        if saved.receipts.len() >= MAX_RECEIPTS {
            return Err("此会话已达到请求记录上限，请新建会话".into());
        }
        saved.receipts.insert(
            request.clone(),
            CommandReceipt {
                fingerprint,
                status: ReceiptStatus::Accepted,
            },
        );
        push_command_message(&mut saved.snapshot, request.clone(), "user", text.into());
        save_record(&file, &saved)?;
    }
    let result = query_mode_command(client, sdk_id, &content).await;
    let mut saved = turn.record.lock().await;
    match result {
        Ok((command_id, result)) => {
            push_mode_result(&mut saved.snapshot, &command_id, &result);
            save_record(&file, &saved)?;
            Ok(Some((command_id, request)))
        }
        Err(error) => {
            if let Some(receipt) = saved.receipts.get_mut(&request) {
                receipt.status = ReceiptStatus::Failed;
            }
            save_record(&file, &saved)?;
            Err(error)
        }
    }
}

fn legacy_context(legacy: &LegacySession) -> String {
    let mut recent = legacy
        .snapshot()
        .messages
        .iter()
        .rev()
        .take(12)
        .filter_map(|message| {
            if !matches!(message.role.as_str(), "user" | "assistant") {
                return None;
            }
            let text: String = message
                .parts
                .iter()
                .filter_map(|part| match part {
                    AgentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .flat_map(str::chars)
                .take(420)
                .collect();
            (!text.trim().is_empty()).then(|| format!("{}: {text}", message.role))
        })
        .collect::<Vec<_>>();
    recent.reverse();
    let summary: String = legacy
        .context_summary()
        .unwrap_or_default()
        .chars()
        .take(2000)
        .collect();
    if !summary.trim().is_empty() {
        recent.insert(0, summary);
    }
    recent.join("\n\n")
}

struct Turn<'a> {
    app: &'a AppHandle,
    id: &'a str,
    request_id: &'a str,
    profile: PathBuf,
    root: PathBuf,
    project: PathBuf,
    paths: HarnessPaths,
    plugins: Option<PluginSelection>,
    model: String,
    accounts: Vec<(String, String)>,
    content: Value,
    auto_title: bool,
    compact: bool,
    mode_command: bool,
    worker: Option<WorkerAction>,
    worker_queue_request: Option<String>,
    state: AppState,
    preview: HarnessPreview,
    browser: BrowserTools,
    mcp_host: Option<Arc<NativeMcpTools>>,
    applications: Arc<super::remote_agent_tools::DesktopToolHost>,
    remote_tools: Option<HarnessMcp>,
    policy: &'static str,
    local_interactive: bool,
    skills: Value,
    record: Arc<Mutex<SessionRecord>>,
    inbox: mpsc::Receiver<Control>,
    desktop: HarnessDesktop,
}

fn warm_session_configuration(session: &AgentSession) -> Result<Value, String> {
    let mut value = to_value(session)?;
    let object = value.as_object_mut().ok_or("Harness 会话配置无效")?;
    // Presentation metadata does not alter a running Agent's capabilities.
    for key in ["title", "updatedAt", "activity", "pinned"] {
        object.remove(key);
    }
    Ok(value)
}

fn warm_fingerprint(
    session: &Value,
    route: &str,
    version: &str,
    plugins: &Option<PluginSelection>,
    workspace: &Value,
    tools: &Value,
) -> Result<String, String> {
    let bytes = serde_json::to_vec(&json!({
        "session": session, "route": route, "version": version,
        "plugins": plugins, "workspace": workspace, "tools": tools,
    }))
    .map_err(|_| "无法校验 Harness 运行配置")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn can_keep_warm(record: &SessionRecord) -> bool {
    record.snapshot.session.coordination.is_none()
        && record.snapshot.permissions.is_empty()
        && record.snapshot.questions.is_empty()
        && record.snapshot.background_jobs == 0
        && !record.snapshot.title_pending
        && !record.snapshot.compacting
        && !has_live_goal(&record.snapshot)
        && record.queue.is_empty()
        && record.withdrawn.is_empty()
        && record.snapshot.queued_messages.is_empty()
        && record.worker_queues.is_empty()
}

async fn run_turn(
    mut turn: Turn<'_>,
) -> Result<(ReceiptStatus, Option<warm::WarmRuntime>), String> {
    let preparing_since = tokio::time::Instant::now();
    let migration = HarnessMigration::new(&turn.profile)?;
    let committed = migration
        .receipt(turn.id)?
        .filter(|receipt| receipt.state() == MigrationState::Committed);
    let mut context = None;
    let receipt = if committed.is_some() {
        committed
    } else if migration.find_legacy(turn.id)?.is_some() {
        let (legacy, receipt) = migration.prepare(turn.id)?;
        context = Some(legacy_context(&legacy));
        turn.record
            .lock()
            .await
            .secretary
            .import_legacy(turn.id, legacy.secretary_tasks());
        Some(receipt)
    } else {
        None
    };
    let sdk_id = receipt
        .as_ref()
        .map(|receipt| receipt.harness_session_id())
        .or_else(|| turn.id.strip_prefix("lc:"))
        .ok_or("无效的 Harness 会话编号")?;
    let mut gateway =
        HarnessGateway::open(&turn.state, &turn.model, turn.id, &turn.accounts).await?;
    log::info!(target: "lolicode::harness_prepare", "stage=gateway elapsed_ms={}", preparing_since.elapsed().as_millis());
    if turn.auto_title {
        // The pinned SDK profile disables the title provider that Desktop uses.
        gateway
            .profile_patch
            .as_array_mut()
            .ok_or("Harness 渠道配置无效")?
            .push(json!({"id":"session-title-llm","disabled":false}));
    }
    if turn.remote_tools.is_some() {
        // A remote anchor has no project content. Keep automatic SDK discovery
        // from treating local instructions or skills as part of that workspace.
        gateway
            .profile_patch
            .as_array_mut()
            .ok_or("Harness 渠道配置无效")?
            .extend(
                [
                    "agent-instructions",
                    "skill-filesystem",
                    "skill-office",
                    "workspace-dependencies",
                ]
                .map(|id| json!({"id":id,"disabled":true})),
            );
    }
    let home = turn.root.join("home");
    let plugin_patches = turn
        .plugins
        .as_ref()
        .map_or_else(Vec::new, |plugins| plugins.patches(&turn.paths));
    // Disk-backed context and local tool discovery are independent of the
    // child handshake. Complete them before applying the policy and prompting.
    let prepare_workspace = async {
        let mut memory = lolicode_agent::native::memory::desktop_context(
            &turn.profile.join("agent/native"),
            &super::agent_preferences::path_key(&turn.project.to_string_lossy()),
        )
        .await
        .unwrap_or_default();
        let confirmed = super::harness_automation::context(&turn.profile, turn.id);
        if !confirmed.is_empty() {
            memory.push('\n');
            memory.push_str(&confirmed);
        }
        memory.chars().take(2400).collect::<String>()
    };
    let prepare_tools = async {
        if let Some(bridge) = &turn.remote_tools {
            return bridge.clone();
        }
        HarnessMcp::prepare_local(
            turn.mcp_host.clone(),
            turn.applications.clone(),
            &turn.project,
            turn.policy == "plan",
            turn.local_interactive
                .then(|| turn.profile.join("agent/native")),
        )
        .await
    };
    let mut configuration = warm_session_configuration(&turn.record.lock().await.snapshot.session)?;
    configuration["automaticTitle"] = json!(turn.auto_title);
    let route = gateway.reuse_fingerprint.clone();
    let candidate = turn.desktop.0.lock().await.warm.take(turn.id);
    let reuse_allowed =
        turn.local_interactive && !turn.compact && !turn.mode_command && turn.worker.is_none();
    let candidate = if reuse_allowed {
        candidate
    } else {
        if let Some(candidate) = candidate {
            candidate.retire().await?;
        }
        None
    };
    let mut host_reused = false;
    let (runtime, memory, bridge, reused) = if let Some(candidate) = candidate {
        let (memory, bridge) = tokio::join!(prepare_workspace, prepare_tools);
        let workspace = json!({"policy":turn.policy,"skills":turn.skills,"memory":memory});
        let fingerprint = warm_fingerprint(
            &configuration,
            &route,
            &turn.paths.version,
            &turn.plugins,
            &workspace,
            &bridge.reuse_configuration(),
        )?;
        let boot_fingerprint =
            prepare::boot_fingerprint(&configuration, &route, &turn.paths.version, &turn.plugins)?;
        if let Some(runtime) = candidate
            .take_any(&[fingerprint.clone(), boot_fingerprint])
            .await?
        {
            drop(gateway);
            host_reused = true;
            let configured = runtime.configured;
            (runtime, memory, bridge, configured)
        } else {
            let born_at = tokio::time::Instant::now();
            let (client, events) = HarnessRuntime::start_live(
                &turn.paths.node,
                &turn.paths.package,
                &turn.project,
                &home,
                gateway,
                &plugin_patches,
            )
            .await?;
            (
                warm::WarmRuntime {
                    client,
                    events,
                    born_at,
                    fingerprint,
                    configured: false,
                },
                memory,
                bridge,
                false,
            )
        }
    } else {
        let born_at = tokio::time::Instant::now();
        let (runtime, memory, bridge) = tokio::join!(
            HarnessRuntime::start_live(
                &turn.paths.node,
                &turn.paths.package,
                &turn.project,
                &home,
                gateway,
                &plugin_patches
            ),
            prepare_workspace,
            prepare_tools
        );
        let (client, events) = runtime?;
        let workspace = json!({"policy":turn.policy,"skills":turn.skills,"memory":memory});
        let fingerprint = warm_fingerprint(
            &configuration,
            &route,
            &turn.paths.version,
            &turn.plugins,
            &workspace,
            &bridge.reuse_configuration(),
        )?;
        (
            warm::WarmRuntime {
                client,
                events,
                born_at,
                fingerprint,
                configured: false,
            },
            memory,
            bridge,
            false,
        )
    };
    let warm::WarmRuntime {
        client,
        mut events,
        born_at,
        ..
    } = runtime;
    let mut completed_configuration = configuration.clone();
    // The official title provider is first-human-prompt-only. Once that title
    // has settled it is safe to reuse its process for ordinary later turns.
    // A process created without it (e.g. image-only input) still misses when a
    // later text prompt actually needs the provider for the first time.
    completed_configuration["automaticTitle"] = json!(false);
    let completed_fingerprint = warm_fingerprint(
        &completed_configuration,
        &route,
        &turn.paths.version,
        &turn.plugins,
        &json!({"policy":turn.policy,"skills":turn.skills,"memory":memory}),
        &bridge.reuse_configuration(),
    )?;
    let mut configured = reused;
    log::info!(target: "lolicode::harness_prepare", "stage=runtime_ready elapsed_ms={} host_reused={} session_ready={}", preparing_since.elapsed().as_millis(), host_reused, reused);
    let outcome = async {
        turn.record.lock().await.secretary.reset_live_projection();
        let exists = turn.record.lock().await.root_created;
        let session = json!({"sessionId": sdk_id});
        if reused {
            // This Agent is already owned by this connection. SDK resume and
            // tool registrations are one-time operations, not per-turn hooks.
        } else if exists {
            client.request("session/resume", session.clone()).await?;
        } else {
            client
                .request("session/working-directory/get", session.clone())
                .await?;
        }
        log::info!(target: "lolicode::harness_prepare", "stage=session_open elapsed_ms={}", preparing_since.elapsed().as_millis());
        if let Some(context) = context.filter(|text| !reused && !text.trim().is_empty()) {
            client
                .request(
                    "lolicode/session/inject-legacy-context",
                    json!({"sessionId": sdk_id, "context": context}),
                )
                .await?;
        }
        if !exists {
            let mut saved = turn.record.lock().await;
            saved.root_created = true;
            save_record(&turn.root.join("desktop.json"), &saved)?;
        }
        if let Some(receipt) = &receipt {
            migration.commit(receipt)?;
        }
        let workspace = json!({"policy":turn.policy,"skills":turn.skills,"memory":memory});
        if !reused {
            client
                .request(
                    "lolicode/session/configure-workspace",
                    json!({"sessionId": sdk_id, "workspace": workspace}),
                )
                .await?;
        }
        if turn
            .record
            .lock()
            .await
            .snapshot
            .session
            .coordination
            .as_ref()
            .is_some_and(|entry| entry.role == "secretary")
        {
            client
                .request("lolicode/session/configure-secretary", session.clone())
                .await?;
            let workers = {
                let saved = turn.record.lock().await;
                saved
                    .worker_queues
                    .iter()
                    .filter_map(|(session, queue)| {
                        let child = saved.secretary.child_sdk_id(session)?;
                        let request_ids = queue
                            .inputs
                            .iter()
                            .map(|input| input.message.id.as_str())
                            .chain(
                                queue
                                    .withdrawn
                                    .iter()
                                    .filter_map(|args| args["requestId"].as_str()),
                            )
                            .map(worker_rpc_id)
                            .collect::<Vec<_>>();
                        (!request_ids.is_empty())
                            .then(|| json!({"childSessionId": child, "requestIds": request_ids}))
                    })
                    .collect::<Vec<_>>()
            };
            if !workers.is_empty() {
                client
                    .request(
                        "lolicode/secretary/configure-worker-queues",
                        json!({"sessionId": sdk_id, "workers": workers}),
                    )
                    .await?;
            }
        }
        log::info!(target: "lolicode::harness_prepare", "stage=workspace_ready elapsed_ms={}", preparing_since.elapsed().as_millis());
        if !reused {
            configured = bridge.configure(&client, sdk_id).await?;
        }
        log::info!(target: "lolicode::harness_prepare", "stage=tools_ready elapsed_ms={}", preparing_since.elapsed().as_millis());
        let mcp = Some(bridge);
        let mut early_controls = VecDeque::new();
        // Check every control already waiting for startup so that a Stop can
        // cancel admission even when an earlier enqueue is waiting for the SDK.
        for _ in 0..turn.inbox.len() {
            let Ok(control) = turn.inbox.try_recv() else {
                break;
            };
            match control {
                Control::Stop {
                    expected_request,
                    reply,
                } => {
                    let _ = reply.send(Ok(()));
                    if expected_request
                        .as_deref()
                        .is_some_and(|request| request != turn.request_id)
                    {
                        continue;
                    }
                    return Ok(ReceiptStatus::Cancelled);
                }
                Control::Shutdown => return Ok(ReceiptStatus::Cancelled),
                Control::Approval { reply, .. } => {
                    let _ = reply.send(Err("本轮尚未请求审批".into()));
                }
                Control::Question { reply, .. } => {
                    let _ = reply.send(Err("本轮尚未发出提问".into()));
                }
                Control::StopWorker { reply, .. } => {
                    let _ = reply.send(Err("子任务尚未启动".into()));
                }
                Control::Enqueue { args, reply }
                    if !turn.compact && args["delivery"] != "steer" =>
                {
                    early_controls.push_back(Control::Enqueue { args, reply });
                }
                Control::Enqueue { reply, .. } => {
                    let _ = reply.send(Err("会话正在启动，请稍后再加入队列".into()));
                }
                Control::ModeCommand { reply, .. } => {
                    let _ = reply.send(Err("会话正在启动，请稍后再运行命令".into()));
                }
                Control::ReadMarkdown { child, reply } => {
                    reply_live_markdown(&client, sdk_id, child, reply);
                }
                Control::ReadNative {
                    child,
                    request,
                    reply,
                } => {
                    reply_live_native(&client, sdk_id, child, request, reply);
                }
                Control::FollowNative {
                    child,
                    id,
                    max_messages,
                    reply,
                } => {
                    reply_live_native_follow(&client, sdk_id, child, id, max_messages, reply);
                }
                Control::WorkerEnqueue { reply, .. } => {
                    let _ = reply.send(Err("子任务正在启动，请稍后再加入队列".into()));
                }
                Control::QueuedAction { reply, .. } => {
                    let _ = reply.send(Err("会话正在启动，请稍后再调整队列".into()));
                }
                Control::WorkerQueuedAction { reply, .. } => {
                    let _ = reply.send(Err("子任务正在启动，请稍后再调整队列".into()));
                }
                Control::SecretaryAction { reply, .. } if turn.compact => {
                    let _ = reply.send(Err("请等 /compact 执行完成后再派工".into()));
                }
                action @ Control::SecretaryAction { .. } => early_controls.push_back(action),
            }
        }
        if turn.compact {
            return run_compaction(&mut turn, &client, &mut events, sdk_id).await;
        }
        let worker = turn.worker.take();
        let mut command_id = None;
        let message_id = if let Some(worker) = &worker {
            let request = turn
                .worker_queue_request
                .as_deref()
                .unwrap_or(turn.request_id);
            let message = send_worker_action(&turn, &client, sdk_id, request, worker).await?;
            if turn.worker_queue_request.is_some() {
                let mut saved = turn.record.lock().await;
                let session = format!("lc:{}", worker.child);
                mark_worker_input_live(&mut saved, &session, request, message.clone());
                save_record(&turn.root.join("desktop.json"), &saved)?;
            }
            message
        } else if turn.mode_command {
            let (id, result) = query_mode_command(&client, sdk_id, &turn.content).await?;
            push_mode_result(&mut turn.record.lock().await.snapshot, &id, &result);
            command_id = Some(id);
            String::new()
        } else {
            client
                .request(
                    "session/prompt",
                    json!({"sessionId": sdk_id, "contentBlocks": turn.content}),
                )
                .await?["messageId"]
                .as_str()
                .ok_or("Harness 缺少消息回执")?
                .into()
        };
        log::info!(target: "lolicode::harness_prepare", "stage=prompt_accepted elapsed_ms={}", preparing_since.elapsed().as_millis());
        if worker.is_none() && !turn.mode_command {
            let mut saved = turn.record.lock().await;
            remember_native_message_alias(&mut saved, &message_id, turn.request_id);
            save_record(&turn.root.join("desktop.json"), &saved)?;
            notify_native_message_aliases_changed(turn.app, turn.id);
        }
        observe_turn(
            &mut turn,
            &client,
            &mut events,
            sdk_id,
            &message_id,
            worker.as_ref().map(|worker| worker.child.as_str()),
            early_controls,
            command_id.as_deref(),
            mcp.as_ref(),
        )
        .await
    }
    .await;
    let eligible = outcome == Ok(ReceiptStatus::Completed)
        && configured
        && !turn.compact
        && !turn.mode_command
        && turn.local_interactive
        && turn.inbox.is_empty()
        && receipt.is_none()
        && can_keep_warm(&*turn.record.lock().await);
    if eligible {
        // session/wait is not a persistence flush. Park must confirm official
        // quiescence and fsync before the desktop publishes an idle cache entry.
        let parked = client
            .request("lolicode/session/park", json!({"sessionId": sdk_id}))
            .await;
        if matches!(parked, Ok(ref value) if value["parked"] == true)
            && turn.inbox.is_empty()
            && can_keep_warm(&*turn.record.lock().await)
        {
            if outcome == Ok(ReceiptStatus::Completed) {
                publish_web_preview(&turn).await;
            }
            return Ok((
                ReceiptStatus::Completed,
                Some(warm::WarmRuntime {
                    client,
                    events,
                    born_at,
                    fingerprint: completed_fingerprint,
                    configured: true,
                }),
            ));
        }
    }
    let cleanup = client.shutdown().await;
    let outcome = outcome?;
    cleanup?;
    if outcome == ReceiptStatus::Completed {
        publish_web_preview(&turn).await;
    }
    Ok((outcome, None))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompactionCompletion {
    command_id: String,
    finish_reason: String,
    final_response: String,
}

impl CompactionCompletion {
    fn from_event(event: HarnessEvent, sdk_id: &str) -> Result<Option<Self>, String> {
        let HarnessEvent::Notification(notification) = event else {
            // Manual compaction uses the model's summary path without tools.
            // Refuse any unexpected SDK host request instead of blocking it.
            return Ok(None);
        };
        let params = &notification["params"];
        if notification["method"] != "session.query.completed" || params["sessionId"] != sdk_id {
            return Ok(None);
        }
        serde_json::from_value(params.clone())
            .map(Some)
            .map_err(|_| "Harness 返回了无效的压缩结果".into())
    }
}

async fn run_compaction(
    turn: &mut Turn<'_>,
    client: &HarnessClient,
    events: &mut mpsc::Receiver<HarnessEvent>,
    sdk_id: &str,
) -> Result<ReceiptStatus, String> {
    let request = client.request(
        "session/query",
        json!({"sessionId": sdk_id, "contentBlocks": turn.content}),
    );
    tokio::pin!(request);
    let receipt_timeout = Duration::from_secs(5);
    let deadline = tokio::time::sleep(receipt_timeout);
    tokio::pin!(deadline);
    let mut command_id = None::<String>;
    let mut completion = None::<CompactionCompletion>;
    loop {
        // Upstream emits completion before or after the handler acknowledgment.
        // Match both, since an ordinary session/wait may succeed without a turn.
        if let (Some(command), Some(result)) = (&command_id, &completion) {
            if command != &result.command_id {
                return Err("Harness 压缩回执编号不匹配".into());
            }
            if result.finish_reason != "completed" {
                return Err(result.final_response.clone());
            }
            push_command_message(
                &mut turn.record.lock().await.snapshot,
                format!("harness-compact:{command}"),
                "assistant",
                result.final_response.clone(),
            );
            return Ok(ReceiptStatus::Completed);
        }
        tokio::select! {
            response = &mut request, if command_id.is_none() => {
                let response = response?;
                if response["kind"] != "command" {
                    return Err("当前 Harness 配置不支持 /compact".into());
                }
                let id = response["execution"]["commandId"].as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("Harness 缺少压缩回执")?;
                command_id = Some(id.to_owned());
                deadline.as_mut().reset(tokio::time::Instant::now() + receipt_timeout);
            }
            _ = &mut deadline, if command_id.is_some() => return Err("Harness 缺少压缩完成事件".into()),
            event = events.recv() => {
                let event = event.ok_or("Harness 事件连接已关闭")?;
                if let Some(result) = CompactionCompletion::from_event(event, sdk_id)? {
                    completion = Some(result);
                }
            }
            control = turn.inbox.recv() => {
                const BUSY: &str = "请等 /compact 执行完成后再操作";
                match control {
                    Some(Control::Stop { expected_request, reply }) => {
                        // The SDK shutdown cancels native commands through its lifetime signal.
                        let _ = reply.send(Ok(()));
                        if expected_request.as_deref().is_some_and(|request| request != turn.request_id) {
                            continue;
                        }
                        return Ok(ReceiptStatus::Cancelled);
                    }
                    Some(Control::Shutdown) | None => return Ok(ReceiptStatus::Cancelled),
                    Some(Control::ReadMarkdown { child, reply }) => {
                        reply_live_markdown(client, sdk_id, child, reply);
                    }
                    Some(Control::ReadNative { child, request, reply }) => {
                        reply_live_native(client, sdk_id, child, request, reply);
                    }
                    Some(Control::FollowNative { child, id, max_messages, reply }) => {
                        reply_live_native_follow(client, sdk_id, child, id, max_messages, reply);
                    }
                    Some(Control::StopWorker { reply, .. } | Control::Approval { reply, .. }
                        | Control::Enqueue { reply, .. } | Control::WorkerEnqueue { reply, .. }
                        | Control::ModeCommand { reply, .. } | Control::Question { reply, .. }) => {
                        let _ = reply.send(Err(BUSY.into()));
                    }
                    Some(Control::QueuedAction { reply, .. } | Control::WorkerQueuedAction { reply, .. }
                        | Control::SecretaryAction { reply, .. }) => { let _ = reply.send(Err(BUSY.into())); }
                }
            }
        }
    }
}

async fn send_worker_action(
    turn: &Turn<'_>,
    client: &HarnessClient,
    sdk_id: &str,
    request: &str,
    action: &WorkerAction,
) -> Result<String, String> {
    let policy = if turn.policy == "plan" {
        "plan"
    } else if turn.remote_tools.is_some() && action.workspace_policy == "full" {
        "workspace"
    } else {
        action.workspace_policy
    };
    let mut params = json!({"sessionId":sdk_id,"childSessionId":action.child,"content":action.content,"workspacePolicy":policy});
    let method = if action.start {
        params["label"] = json!(action.label);
        params["cwd"] = json!(action.cwd);
        "lolicode/secretary/delegate-worker"
    } else {
        params["requestId"] = json!(worker_rpc_id(request));
        "lolicode/secretary/prompt-worker"
    };
    let result = client.request(method, params).await;
    let mut saved = turn.record.lock().await;
    saved
        .secretary
        .settle_action(&action.child, result.as_ref().err().map(String::as_str));
    if result.is_ok() {
        save_worker_owner(&turn.profile, turn.id, &format!("lc:{}", action.child))?;
    } else if let Some(receipt) = saved.receipts.get_mut(request) {
        receipt.status = ReceiptStatus::Failed;
    }
    let native_message = result
        .as_ref()
        .ok()
        .and_then(|value| value["messageId"].as_str());
    if let Some(message) = native_message {
        remember_native_message_alias(&mut saved, message, request);
    }
    save_record(&turn.root.join("desktop.json"), &saved)?;
    if native_message.is_some_and(|message| !message.is_empty()) {
        notify_native_message_aliases_changed(turn.app, &format!("lc:{}", action.child));
    }
    result.map(|value| value["messageId"].as_str().unwrap_or_default().to_owned())
}

async fn accept_secretary_action(
    turn: &Turn<'_>,
    client: &HarnessClient,
    sdk_id: &str,
    args: &Value,
    command: SecretaryCommand,
) -> Result<(Value, Option<(String, String)>), String> {
    let request = request_id(args)?;
    let fingerprint = secretary_fingerprint(args);
    let action = {
        let mut saved = turn.record.lock().await;
        if check_receipt(&saved, request, &fingerprint)? {
            return secretary_response(&saved, request, Some(&command)).map(|task| (task, None));
        }
        if let Some(task) = saved.secretary.existing_delegation(request, &command)? {
            return to_value(task).map(|task| (task, None));
        }
        if saved.receipts.len() >= MAX_RECEIPTS {
            return Err("此会话已达到请求记录上限，请新建会话".into());
        }
        let (_, action) =
            prepare_secretary_action(&mut saved, &turn.profile, request, command).await?;
        saved.receipts.insert(
            request.into(),
            CommandReceipt {
                fingerprint,
                status: ReceiptStatus::Accepted,
            },
        );
        save_record(&turn.root.join("desktop.json"), &saved)?;
        action
    };
    let message = send_worker_action(turn, client, sdk_id, request, &action).await?;
    let saved = turn.record.lock().await;
    let task = saved
        .secretary
        .worker_task(&action.child)
        .ok_or("此任务不属于当前秘书")?;
    Ok((to_value(task)?, Some((action.child, message))))
}

async fn publish_web_preview(turn: &Turn<'_>) {
    if turn.remote_tools.is_some() {
        return;
    }
    let (receipt, working_directory) = {
        let saved = turn.record.lock().await;
        let receipt = saved.snapshot.preview.clone();
        let working_directory = receipt.as_ref().and_then(|receipt| {
            if receipt.session_id == turn.id {
                Some(turn.project.clone())
            } else {
                saved.secretary.child_execution_root(&receipt.session_id)
            }
        });
        (receipt, working_directory)
    };
    let Some(receipt) = receipt else { return };
    let Some(working_directory) = working_directory else {
        return;
    };
    let AgentPreviewTarget::File { path, .. } = &receipt.target else {
        return;
    };
    if !Path::new(path)
        .extension()
        .and_then(|part| part.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"))
    {
        return;
    }
    if let Err(error) = turn
        .preview
        .publish(
            &turn.browser,
            &receipt.session_id,
            &turn.project,
            &working_directory,
            &receipt.id,
            path,
        )
        .await
    {
        log::debug!("Harness 网页交付保留文件预览：{error}");
    }
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum SnapshotNotice<'a> {
    Changed {
        session_id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_path: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_at: Option<u64>,
    },
    Tail {
        session_id: &'a str,
        previous_message_id: Option<&'a str>,
        message: &'a AgentMessage,
    },
}

fn notify_snapshot_changed(app: &AppHandle, session_id: &str) {
    let _ = app.emit_to(
        "main",
        SNAPSHOT_EVENT,
        SnapshotNotice::Changed {
            session_id,
            title: None,
            project_path: None,
            updated_at: None,
        },
    );
}

async fn observe_automatic_title(turn: &Turn<'_>, sdk_id: &str, notification: &Value) {
    let params = &notification["params"];
    if !turn.auto_title
        || notification["method"] != "session.event"
        || params["sessionId"] != sdk_id
    {
        return;
    }
    let carrier = turn.app.state::<InprocessAgentState>();
    let event = &params["event"];
    if event["type"] == "session/title-llm-request" {
        turn.record.lock().await.snapshot.title_pending = true;
        return;
    }
    if event["type"] != "session/title" {
        return;
    }
    let data = &event["data"];
    let generated = match data["source"]["kind"].as_str() {
        Some("provider") => true,
        Some("fallback") => false,
        _ => return,
    };
    let Some(title) = data["title"].as_str() else {
        return;
    };
    let applied = carrier
        .accept_automatic_title(turn.id, title, generated)
        .await;
    let mut saved = turn.record.lock().await;
    if generated {
        saved.snapshot.title_pending = false;
    }
    match applied {
        Ok(Some(session)) => {
            saved.snapshot.session.title.clone_from(&session.title);
            saved.snapshot.session.updated_at =
                saved.snapshot.session.updated_at.max(session.updated_at);
            let _ = turn.app.emit_to(
                "main",
                SNAPSHOT_EVENT,
                SnapshotNotice::Changed {
                    session_id: &session.id,
                    title: Some(&session.title),
                    project_path: Some(&session.project_path),
                    updated_at: Some(session.updated_at),
                },
            );
        }
        Ok(None) => {}
        Err(error) => log::warn!("无法保存 Harness 自动会话标题：{error}"),
    }
}

enum SnapshotChange {
    Tail(String),
    Refresh(String),
}

impl SnapshotChange {
    fn from_event(event: &HarnessEvent, root: &str, sdk_root: &str) -> Option<Self> {
        let owner = |source: &str| {
            if source == sdk_root {
                root.to_owned()
            } else {
                format!("lc:{source}")
            }
        };
        match event {
            HarnessEvent::Notification(notification) => {
                let params = &notification["params"];
                match notification["method"].as_str()? {
                    "lolicode/session.assistant-stream" if params["frame"]["type"] == "chunk" => {
                        Some(Self::Tail(owner(params["sessionId"].as_str()?)))
                    }
                    "session.event"
                    | "session.status"
                    | "lolicode/session.mode"
                    | "user-question.cancelled"
                    | "lolicode/mcp.cancelled" => {
                        Some(Self::Refresh(owner(params["sessionId"].as_str()?)))
                    }
                    "subagent.started"
                    | "subagent.finished"
                    | "lolicode/subagent.directory"
                    | "lolicode/secretary.report" => Some(Self::Refresh(root.to_owned())),
                    _ => None,
                }
            }
            HarnessEvent::Request(request)
                if matches!(
                    request.method.as_str(),
                    "approval/request" | "user-question/ask" | harness_mcp::CALL_METHOD
                ) =>
            {
                Some(Self::Refresh(owner(request.params["sessionId"].as_str()?)))
            }
            _ => None,
        }
    }

    fn publish(self, app: &AppHandle, tails: &mut BTreeSet<String>) {
        match self {
            Self::Tail(id) => {
                tails.insert(id);
            }
            Self::Refresh(id) => notify_snapshot_changed(app, &id),
        }
    }
}

async fn publish_stream_tails(turn: &Turn<'_>, tails: &mut BTreeSet<String>) {
    let saved = turn.record.lock().await;
    for id in std::mem::take(tails) {
        let snapshot = if id == turn.id {
            Some(&saved.snapshot)
        } else {
            saved.secretary.child(&id)
        };
        let Some((message, previous)) =
            snapshot.and_then(|snapshot| snapshot.messages.split_last())
        else {
            continue;
        };
        if is_live_message(&message.id) {
            let _ = turn.app.emit_to(
                "main",
                SNAPSHOT_EVENT,
                SnapshotNotice::Tail {
                    session_id: &id,
                    previous_message_id: previous.last().map(|entry| entry.id.as_str()),
                    message,
                },
            );
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "The observer routes one turn's root, worker, and command events to their separate identities"
)]
async fn observe_turn(
    turn: &mut Turn<'_>,
    client: &HarnessClient,
    events: &mut mpsc::Receiver<HarnessEvent>,
    sdk_id: &str,
    message_id: &str,
    worker_id: Option<&str>,
    mut early_controls: VecDeque<Control>,
    command_id: Option<&str>,
    mcp: Option<&HarnessMcp>,
) -> Result<ReceiptStatus, String> {
    // Controls can also arrive while the SDK is admitting the primary prompt.
    // Process them before a fast first turn can settle, with cancellation first.
    for _ in 0..turn.inbox.len() {
        match turn.inbox.try_recv() {
            Ok(control @ (Control::Stop { .. } | Control::Shutdown)) => {
                early_controls.push_front(control);
            }
            Ok(control) => early_controls.push_back(control),
            Err(_) => break,
        }
    }
    let mut projection = HarnessSnapshotProjection::default();
    let mut outcome = HarnessEvents::new(sdk_id);
    if let Some(worker) = worker_id {
        outcome.track_child(sdk_id, worker)?;
    }
    let mut pending = HashMap::new();
    let mut host_tools = HostToolRuns::default();
    let mut extra_prompts = HashMap::new();
    let mut extra_workers = HashMap::new();
    let mut stop_requested = false;
    let mut stream_tails = BTreeSet::new();
    let mut stream_tick = tokio::time::interval(Duration::from_millis(75));
    stream_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let request_wait = || Box::pin(client.request("session/wait", json!({"sessionId": sdk_id})));
    let mut wait = Some(request_wait());
    let mut wait_settlements = 0;
    let mut primary_settled = false;
    let mut title_settlement = None;
    let mut title_deadline = Box::pin(tokio::time::sleep(Duration::ZERO));
    let mut command_result = None;
    let mut mode_commands = HashMap::new();
    let result = async { loop {
        if title_settlement.is_some() && !turn.record.lock().await.snapshot.title_pending {
            let status = title_settlement.take().expect("retained title turn");
            if wait.is_none() && mode_commands.is_empty() && outcome.active_jobs() == 0
                && !has_live_goal(&turn.record.lock().await.snapshot)
            {
                return status;
            }
        }
        tokio::select! {
            event = events.recv() => {
                let event = event.ok_or("Harness 事件连接已关闭")?;
                let change = SnapshotChange::from_event(&event, turn.id, sdk_id);
                let completion = native_command_completion(&event, sdk_id, command_id);
                let mode_settled = settle_secondary_mode_command(turn, &event, sdk_id, &mut mode_commands).await?;
                let prior_settlements = outcome.job_settlements();
                apply_event(event, turn, sdk_id, message_id, &mut projection, &mut outcome, &mut pending, &mut extra_prompts, mcp, &mut host_tools, stop_requested, wait.is_some()).await?;
                if completion.is_some() || mode_settled {
                    if completion.is_some() { command_result = completion; }
                    wait = Some(request_wait());
                    wait_settlements = outcome.job_settlements();
                } else if wait.is_none()
                    && (outcome.has_open_turn() || outcome.job_settlements() != prior_settlements)
                {
                    wait = Some(request_wait());
                    wait_settlements = outcome.job_settlements();
                }
                if let Some(change) = change { change.publish(turn.app, &mut stream_tails); }
            }
            _ = stream_tick.tick(), if !stream_tails.is_empty() => publish_stream_tails(turn, &mut stream_tails).await,
            _ = &mut title_deadline, if title_settlement.is_some() => {
                turn.record.lock().await.snapshot.title_pending = false;
                notify_snapshot_changed(turn.app, turn.id);
            }
            completed = host_tools.tasks.join_next(), if !host_tools.tasks.is_empty() => {
                if let Some(Ok(key)) = completed { host_tools.active.remove(&key); }
            }
            control = async {
                match early_controls.pop_front() {
                    Some(control) => Some(control),
                    None => turn.inbox.recv().await,
                }
            } => match control {
                Some(Control::Stop { expected_request, reply }) => {
                    if expected_request.as_deref().is_some_and(|request| request != turn.request_id || primary_settled) {
                        let _ = reply.send(Ok(()));
                        continue;
                    }
                    let result = cancel_root(turn, client, sdk_id).await;
                    stop_requested |= result.is_ok();
                    let _ = reply.send(result);
                    if stop_requested && wait.is_none() { return Ok(ReceiptStatus::Cancelled); }
                }
                Some(Control::StopWorker { session, reply }) => {
                    let result = stop_worker_and_park(turn, client, sdk_id, &session).await;
                    let _ = reply.send(result);
                }
                Some(Control::Enqueue { args, reply }) => {
                    if stop_requested {
                        let _ = reply.send(Err("当前任务正在停止，草稿已保留。".into()));
                        continue;
                    }
                    let resumed = primary_settled && wait.is_none();
                    let request = request_id(&args)?.to_owned();
                    if resumed && args["delivery"] == "steer" {
                        let _ = reply.send(Err("当前任务已经结束，草稿已保留。".into()));
                        continue;
                    }
                    let result = enqueue_live(turn, client, sdk_id, args).await;
                    if result.is_ok() {
                        if resumed { resume_retained_foreground(turn, &request).await; }
                        wait = Some(request_wait());
                        wait_settlements = outcome.job_settlements();
                    }
                    let _ = reply.send(result);
                }
                Some(Control::ReadMarkdown { child, reply }) => {
                    reply_live_markdown(client, sdk_id, child, reply);
                }
                Some(Control::ReadNative { child, request, reply }) => {
                    reply_live_native(client, sdk_id, child, request, reply);
                }
                Some(Control::FollowNative { child, id, max_messages, reply }) => {
                    reply_live_native_follow(client, sdk_id, child, id, max_messages, reply);
                }
                Some(Control::ModeCommand { args, reply }) => {
                    let result = accept_mode_command(turn, client, sdk_id, args).await.map(|accepted| {
                        if let Some((command, request)) = accepted {
                            mode_commands.insert(command, request);
                        }
                    });
                    let _ = reply.send(result);
                }
                Some(Control::QueuedAction { id, action, reply }) => {
                    let _ = reply.send(edit_queue(turn, client, sdk_id, &id, action).await);
                }
                Some(Control::WorkerEnqueue { session, args, reply }) => {
                    let result = enqueue_worker_live(turn, client, sdk_id, &session, &args).await;
                    if result.is_ok() {
                        notify_snapshot_changed(turn.app, &session);
                        wait = Some(request_wait());
                        wait_settlements = outcome.job_settlements();
                    }
                    let _ = reply.send(result);
                }
                Some(Control::WorkerQueuedAction { session, id, action, steer_only, reply }) => {
                    let result = edit_worker_queue(turn, client, sdk_id, &session, &id, action, steer_only).await;
                    if result.is_ok() {
                        notify_snapshot_changed(turn.app, &session);
                        if action != "remove" {
                            wait = Some(request_wait());
                            wait_settlements = outcome.job_settlements();
                        }
                    }
                    let _ = reply.send(result);
                }
                Some(Control::SecretaryAction { args, command, reply }) => {
                    let result = accept_secretary_action(turn, client, sdk_id, &args, command).await;
                    let result = result.and_then(|(task, worker)| {
                        if let Some((child, message)) = worker {
                            outcome.track_child(sdk_id, &child)?;
                            extra_workers.insert(request_id(&args)?.to_owned(), (child, message));
                            wait = Some(request_wait());
                            wait_settlements = outcome.job_settlements();
                        }
                        Ok(task)
                    });
                    let _ = reply.send(result);
                }
                Some(Control::Approval { session, id, decision, reply }) => {
                    let owned = pending.get(&id).is_some_and(|entry| entry.owner == session && entry.question.is_none());
                    let result = if let Some(entry) = owned.then(|| pending.remove(&id)).flatten() {
                        let result = if let Some(call) = entry.mcp {
                            if decision == "allowed-once" {
                                let bridge = mcp.cloned().ok_or("MCP 配置已失效")?;
                                host_tools.start(turn, entry.request, &entry.owner, bridge, call).await
                            } else { entry.request.respond(Some(harness_mcp::denied("工具操作已拒绝"))).await }
                        } else { entry.request.respond(Some(json!({"outcome": decision}))).await };
                        let mut saved = turn.record.lock().await;
                        if let Some(snapshot) = if session == turn.id { Some(&mut saved.snapshot) } else { saved.secretary.child_mut(&session) } {
                            snapshot.permissions.retain(|permission| permission.id != id);
                            if snapshot.permissions.is_empty() { snapshot.status = AgentStatus::Running; }
                        }
                        saved.secretary.sync_waiting_status(&session);
                        result
                    } else { Err("这项审批已经结束".into()) };
                    let _ = reply.send(result);
                }
                Some(Control::Question { session, id, answer, reply }) => {
                    let key = question_key(&session, &id);
                    let response = pending.get(&key).and_then(|entry| entry.question.as_ref())
                        .ok_or("此问题已经结束".to_owned())
                        .and_then(|question| match answer {
                            Some(answer) => answer_for_question(question, &answer),
                            None => Ok(json!({"cancelled":true})),
                        });
                    let result = match response {
                        Ok(response) => if let Some(entry) = pending.remove(&key) {
                            let result = entry.request.respond(Some(response)).await;
                            clear_question(turn, &session, &id).await;
                            result
                        } else { Err("此问题已经结束".into()) },
                        Err(error) => Err(error),
                    };
                    let _ = reply.send(result);
                }
                Some(Control::Shutdown) | None => {
                    let _ = cancel_root(turn, client, sdk_id).await;
                    return Ok(ReceiptStatus::Cancelled);
                }
            },
            finished = async { wait.as_mut().expect("foreground wait").await }, if wait.is_some() && early_controls.is_empty() => {
                wait = None;
                while let Ok(event) = events.try_recv() {
                    let change = SnapshotChange::from_event(&event, turn.id, sdk_id);
                    if let Some(completion) = native_command_completion(&event, sdk_id, command_id) {
                        command_result = Some(completion);
                    }
                    settle_secondary_mode_command(turn, &event, sdk_id, &mut mode_commands).await?;
                    apply_event(event, turn, sdk_id, message_id, &mut projection, &mut outcome, &mut pending, &mut extra_prompts, mcp, &mut host_tools, stop_requested, true).await?;
                    if let Some(change) = change { change.publish(turn.app, &mut stream_tails); }
                }
                if !stop_requested { finished?; }
                if !stop_requested && wait_settlements != outcome.job_settlements() {
                    // A job's log entry is committed before its completion notice
                    // is delivered. Verify native quiescence after that delivery.
                    wait_settlements = outcome.job_settlements();
                    wait = Some(request_wait());
                    continue;
                }
                if !stop_requested && (!mode_commands.is_empty()
                    || (!primary_settled && command_id.is_some() && command_result.is_none()))
                {
                    // session/wait covers the current turn tree, while a command
                    // may schedule more work before its native completion event.
                    continue;
                }
                if !extra_workers.is_empty() {
                    let mut saved = turn.record.lock().await;
                    for (request, (child, message)) in extra_workers.drain() {
                        if let Some(receipt) = saved.receipts.get_mut(&request) {
                            receipt.status = worker_receipt(&outcome, &child, &message, stop_requested);
                        }
                    }
                    save_record(&turn.root.join("desktop.json"), &saved)?;
                }
                let status = if stop_requested {
                    Ok(ReceiptStatus::Cancelled)
                } else if primary_settled {
                    Ok(ReceiptStatus::Completed)
                } else if let Some(result) = command_result.take() {
                    result
                } else if let Some(child) = worker_id {
                    Ok(worker_receipt(&outcome, child, message_id, stop_requested))
                } else {
                    prompt_receipt(
                        &outcome,
                        sdk_id,
                        message_id,
                        turn.record.lock().await.snapshot.error.as_deref(),
                    )
                };
                if stop_requested {
                    return status;
                }
                let (active_goal, title_pending) = {
                    let saved = turn.record.lock().await;
                    (has_live_goal(&saved.snapshot), saved.snapshot.title_pending)
                };
                if outcome.active_jobs() == 0 && !active_goal && !title_pending { return status; }
                if title_pending && title_settlement.is_none() {
                    title_deadline.as_mut().reset(tokio::time::Instant::now() + AUTOMATIC_TITLE_GRACE);
                    title_settlement = Some(status.clone());
                }
                settle_retained_foreground(turn, (!primary_settled).then_some(&status)).await?;
                primary_settled = true;
                if status == Ok(ReceiptStatus::Completed) { publish_web_preview(turn).await; }
            }
        }
    } }.await;
    host_tools.cancel_and_join().await;
    result
}

fn prompt_receipt(
    outcome: &HarnessEvents,
    session: &str,
    message: &str,
    error: Option<&str>,
) -> Result<ReceiptStatus, String> {
    match outcome.turn_outcome(session, message) {
        Some(HarnessTurnOutcome::Completed) => Ok(ReceiptStatus::Completed),
        Some(HarnessTurnOutcome::Ended(reason)) => {
            Err(error.map_or_else(|| format!("Harness 本轮结束：{reason}"), str::to_owned))
        }
        // A resumed turn can fail before the newly admitted prompt reaches
        // user/message (or even before its first step). Preserve the root's
        // sanitized terminal error instead of hiding it behind a missing receipt.
        // Neither session/wait nor another prompt's success confirms this one.
        None => Err(error.map_or_else(
            || "Harness 未确认本轮结果，已保留会话".into(),
            str::to_owned,
        )),
    }
}

fn native_command_completion(
    event: &HarnessEvent,
    session: &str,
    command: Option<&str>,
) -> Option<Result<ReceiptStatus, String>> {
    let command = command?;
    let HarnessEvent::Notification(notification) = event else {
        return None;
    };
    let params = &notification["params"];
    if notification["method"] != "session.query.completed"
        || params["sessionId"] != session
        || params["commandId"] != command
    {
        return None;
    }
    Some(match params["finishReason"].as_str() {
        Some("completed") => Ok(ReceiptStatus::Completed),
        Some("aborted" | "cancelled" | "canceled" | "paused") => Ok(ReceiptStatus::Cancelled),
        Some(reason) => Err(params["finalResponse"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Harness 本轮结束：{reason}"))),
        None => Err("Harness 返回了无效的命令结果".into()),
    })
}

async fn settle_secondary_mode_command(
    turn: &Turn<'_>,
    event: &HarnessEvent,
    sdk_id: &str,
    commands: &mut HashMap<String, String>,
) -> Result<bool, String> {
    let HarnessEvent::Notification(notification) = event else {
        return Ok(false);
    };
    let Some(command) = notification["params"]["commandId"].as_str() else {
        return Ok(false);
    };
    if !commands.contains_key(command) {
        return Ok(false);
    }
    let Some(status) = native_command_completion(event, sdk_id, Some(command)) else {
        return Ok(false);
    };
    let Some(request) = commands.remove(command) else {
        return Ok(false);
    };
    let mut saved = turn.record.lock().await;
    if let Some(receipt) = saved.receipts.get_mut(&request) {
        receipt.status = status.unwrap_or(ReceiptStatus::Failed);
    }
    save_record(&turn.root.join("desktop.json"), &saved)?;
    drop(saved);
    notify_snapshot_changed(turn.app, turn.id);
    Ok(true)
}

async fn settle_retained_foreground(
    turn: &Turn<'_>,
    initial: Option<&Result<ReceiptStatus, String>>,
) -> Result<(), String> {
    let mut desktop = turn.desktop.0.lock().await;
    if let Some(flight) = desktop.flights.get_mut(turn.id) {
        flight.retained = true;
    }
    let mut saved = turn.record.lock().await;
    if let Some(status) = initial {
        if let Some(receipt) = saved.receipts.get_mut(turn.request_id) {
            receipt.status = status.as_ref().copied().unwrap_or(ReceiptStatus::Failed);
        }
    }
    let error = initial
        .and_then(|status| status.as_ref().err())
        .cloned()
        .or_else(|| saved.snapshot.error.clone());
    saved.snapshot.status = if error.is_some() {
        AgentStatus::Error
    } else {
        AgentStatus::Idle
    };
    saved.snapshot.error = error;
    saved.snapshot.session.updated_at = now();
    clear_waits(&mut saved.snapshot);
    save_record(&turn.root.join("desktop.json"), &saved)?;
    drop(saved);
    drop(desktop);
    notify_snapshot_changed(turn.app, turn.id);
    Ok(())
}

async fn resume_retained_foreground(turn: &Turn<'_>, request: &str) {
    let mut desktop = turn.desktop.0.lock().await;
    if let Some(flight) = desktop.flights.get_mut(turn.id) {
        flight.request_id = request.to_owned();
    }
    let mut saved = turn.record.lock().await;
    saved.snapshot.status = AgentStatus::Running;
    saved.snapshot.error = None;
    saved.snapshot.session.updated_at = now();
    drop(saved);
    drop(desktop);
    notify_snapshot_changed(turn.app, turn.id);
}

type HostToolKey = (String, String);

#[derive(Default)]
struct HostToolRuns {
    active: HashMap<HostToolKey, tokio::sync::watch::Sender<bool>>,
    tasks: tokio::task::JoinSet<HostToolKey>,
}

impl HostToolRuns {
    async fn start(
        &mut self,
        turn: &Turn<'_>,
        request: HarnessHostRequest,
        owner: &str,
        bridge: HarnessMcp,
        call: McpCall,
    ) -> Result<(), String> {
        let key = mcp_key(&request.params);
        if key.1.is_empty() || self.active.contains_key(&key) {
            return request
                .respond(Some(harness_mcp::denied("工具请求编号重复或无效")))
                .await;
        }
        let (stop, cancel) = tokio::sync::watch::channel(false);
        self.active.insert(key.clone(), stop);
        let record = turn.record.clone();
        let owner = owner.to_owned();
        let preview_registry = turn.preview.clone();
        let browser = turn.browser.clone();
        let project = turn.project.clone();
        let app = turn.app.clone();
        self.tasks.spawn(async move {
            let result = bridge.execute(call, cancel.clone()).await;
            if let Some(browser_id) = result.closed_browser {
                if let Some(session_id) = preview_registry.forget(&browser_id).await {
                    let matches_preview = |preview: &AgentPreviewRequest| {
                        preview.session_id == session_id
                            && matches!(
                                &preview.target,
                                AgentPreviewTarget::Browser { browser_id: id, .. } if id == &browser_id
                            )
                    };
                    let mut saved = record.lock().await;
                    if saved.snapshot.preview.as_ref().is_some_and(matches_preview) {
                        saved.snapshot.preview = None;
                    }
                    if let Some(child) = saved.secretary.child_mut(&session_id) {
                        if child.preview.as_ref().is_some_and(matches_preview) {
                            child.preview = None;
                        }
                    }
                    drop(saved);
                    let _ = app.emit_to(
                        "main",
                        "agent-browser-preview-closed",
                        json!({"sessionId": session_id, "browserId": browser_id}),
                    );
                }
            }
            if let Some(target) = result.preview {
                if !*cancel.borrow() {
                    let preview = AgentPreviewRequest {
                        id: Uuid::new_v4().to_string(),
                        session_id: owner.clone(),
                        created_at: now(),
                        target,
                    };
                    if preview_registry.adopt(&browser, &project, &preview).await {
                        let mut saved = record.lock().await;
                        let still_open = match &preview.target {
                            AgentPreviewTarget::Browser { browser_id, .. } => preview_registry
                                .frame_scope(&owner, browser_id)
                                .await
                                .is_ok_and(|scope| scope.is_some()),
                            _ => true,
                        };
                        if still_open {
                            if let Some(child) = saved.secretary.child_mut(&owner) {
                                child.preview = Some(preview.clone());
                            }
                            saved.snapshot.preview = Some(preview);
                        }
                    }
                }
            }
            let _ = request.respond(Some(result.payload)).await;
            key
        });
        Ok(())
    }

    async fn cancel_and_join(&mut self) {
        for stop in self.active.values() {
            let _ = stop.send(true);
        }
        while self.tasks.join_next().await.is_some() {}
    }
}

fn worker_receipt(
    events: &HarnessEvents,
    child: &str,
    message: &str,
    stopped: bool,
) -> ReceiptStatus {
    match events.turn_outcome(child, message) {
        Some(HarnessTurnOutcome::Completed) => ReceiptStatus::Completed,
        Some(HarnessTurnOutcome::Ended(reason))
            if matches!(reason.as_str(), "aborted" | "cancelled" | "canceled") =>
        {
            ReceiptStatus::Cancelled
        }
        Some(HarnessTurnOutcome::Ended(_)) => ReceiptStatus::Failed,
        None if events
            .child_outcome(child)
            .is_some_and(|end| end.is_completed()) =>
        {
            ReceiptStatus::Completed
        }
        None if stopped => ReceiptStatus::Cancelled,
        None => ReceiptStatus::Failed,
    }
}

struct PendingApproval {
    owner: String,
    request: HarnessHostRequest,
    mcp: Option<McpCall>,
    question: Option<AgentQuestion>,
}

fn question_key(owner: &str, id: &str) -> String {
    format!("{owner}/{id}")
}

async fn clear_question(turn: &Turn<'_>, owner: &str, id: &str) {
    let mut saved = turn.record.lock().await;
    if let Some(snapshot) = if owner == turn.id {
        Some(&mut saved.snapshot)
    } else {
        saved.secretary.child_mut(owner)
    } {
        snapshot.questions.retain(|question| question.id != id);
        if snapshot.questions.is_empty() && snapshot.status == AgentStatus::WaitingQuestion {
            snapshot.status = if snapshot.permissions.is_empty() {
                AgentStatus::Running
            } else {
                AgentStatus::WaitingPermission
            };
        }
    }
    saved.secretary.sync_waiting_status(owner);
}

fn mcp_key(params: &Value) -> (String, String) {
    (
        params["sessionId"].as_str().unwrap_or_default().to_owned(),
        params["callId"].as_str().unwrap_or_default().to_owned(),
    )
}

async fn cancel_root(turn: &Turn<'_>, client: &HarnessClient, sdk_id: &str) -> Result<(), String> {
    let secretary = turn
        .record
        .lock()
        .await
        .snapshot
        .session
        .coordination
        .as_ref()
        .is_some_and(|entry| entry.role == "secretary");
    if secretary {
        client
            .request(
                "lolicode/session/cancel",
                json!({"sessionId":sdk_id,"includeWorkers":true}),
            )
            .await
            .map(|_| ())
    } else {
        client.cancel(sdk_id).await
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Dispatch borrows the event loop's projections and pending operations for one event"
)]
async fn apply_event(
    event: HarnessEvent,
    turn: &Turn<'_>,
    sdk_id: &str,
    message_id: &str,
    projection: &mut HarnessSnapshotProjection,
    outcome: &mut HarnessEvents,
    pending: &mut HashMap<String, PendingApproval>,
    extra_prompts: &mut HashMap<String, String>,
    mcp: Option<&HarnessMcp>,
    host_tools: &mut HostToolRuns,
    stop_requested: bool,
    foreground: bool,
) -> Result<(), String> {
    match event {
        HarnessEvent::Notification(notification) => {
            observe_automatic_title(turn, sdk_id, &notification).await;
            if notification["method"] == "user-question.cancelled" {
                if let (Some(source), Some(id)) = (
                    notification["params"]["sessionId"].as_str(),
                    notification["params"]["requestId"].as_str(),
                ) {
                    let owner = if source == sdk_id {
                        turn.id.to_owned()
                    } else {
                        format!("lc:{source}")
                    };
                    if pending.remove(&question_key(&owner, id)).is_some() {
                        clear_question(turn, &owner, id).await;
                    }
                }
                return Ok(());
            }
            if notification["method"] == "lolicode/mcp.cancelled" {
                let key = mcp_key(&notification["params"]);
                if let Some(stop) = host_tools.active.get(&key) {
                    let _ = stop.send(true);
                }
                let expired = pending
                    .iter()
                    .filter(|(_, entry)| {
                        entry.mcp.is_some() && mcp_key(&entry.request.params) == key
                    })
                    .map(|(id, entry)| (id.clone(), entry.owner.clone()))
                    .collect::<Vec<_>>();
                let mut saved = turn.record.lock().await;
                for (id, owner) in expired {
                    pending.remove(&id);
                    if let Some(snapshot) = if owner == turn.id {
                        Some(&mut saved.snapshot)
                    } else {
                        saved.secretary.child_mut(&owner)
                    } {
                        snapshot
                            .permissions
                            .retain(|permission| permission.id != id);
                    }
                    saved.secretary.sync_waiting_status(&owner);
                }
                return Ok(());
            }
            outcome.apply(&notification)?;
            let mut saved = turn.record.lock().await;
            let mut checkpoint = false;
            checkpoint |= notification["method"] == "lolicode/session.mode";
            let worker_message = claim_worker_queue_message(&mut saved, sdk_id, &notification);
            let mut alias_session = worker_message
                .as_ref()
                .map(|(session, _, _)| session.clone());
            checkpoint |= worker_message.is_some();
            if notification["params"]["sessionId"].as_str() == Some(sdk_id) {
                let event = &notification["params"]["event"];
                if event["type"] == "user/message" {
                    if let Some(sdk_message) = event["data"]["id"].as_str() {
                        if let Some(index) = saved.queue.iter().position(|entry| {
                            entry.sdk_id.as_deref() == Some(sdk_message)
                                || (entry.args["delivery"] == "steer"
                                    && event["data"]["source"]["rpcId"].as_str()
                                        == Some(entry.id()))
                        }) {
                            let input = saved.queue.remove(index);
                            let request = input.id().to_owned();
                            saved
                                .snapshot
                                .queued_messages
                                .retain(|item| item.id != request);
                            remember_native_message_alias(&mut saved, sdk_message, &request);
                            alias_session = Some(turn.id.to_owned());
                            extra_prompts.insert(sdk_message.into(), request);
                            checkpoint = true;
                        }
                    }
                } else if event["type"] == "turn/end" {
                    extra_prompts.retain(|message, id| {
                        let Some(status) = outcome.turn_outcome(sdk_id, message) else {
                            return true;
                        };
                        if let Some(receipt) = saved.receipts.get_mut(id) {
                            receipt.status = match status {
                                HarnessTurnOutcome::Completed => ReceiptStatus::Completed,
                                HarnessTurnOutcome::Ended(reason) if reason == "aborted" => {
                                    ReceiptStatus::Cancelled
                                }
                                HarnessTurnOutcome::Ended(_) => ReceiptStatus::Failed,
                            };
                        }
                        checkpoint = true;
                        false
                    });
                }
            }
            let SessionRecord {
                snapshot,
                secretary,
                ..
            } = &mut *saved;
            if matches!(
                notification["params"]["event"]["type"].as_str(),
                Some("job/registered" | "job/settled")
            ) {
                snapshot.background_jobs = outcome.active_jobs();
                if let Some(source) = notification["params"]["sessionId"]
                    .as_str()
                    .filter(|source| *source != sdk_id)
                {
                    if let Some(child) = secretary.child_mut(&format!("lc:{source}")) {
                        child.background_jobs = outcome.active_jobs_for(source);
                    }
                }
            }
            if snapshot
                .session
                .coordination
                .as_ref()
                .is_some_and(|entry| entry.role == "secretary")
            {
                secretary.apply(snapshot, sdk_id, &notification, outcome);
                if let Some((child, native, request)) = worker_message {
                    if let Some(snapshot) = secretary.child_mut(&child) {
                        if let Some(message) = snapshot
                            .messages
                            .iter_mut()
                            .rev()
                            .find(|message| message.id == native)
                        {
                            message.id = request;
                        }
                    }
                }
                checkpoint |= notification["method"] == "subagent.finished";
                checkpoint |= notification["method"] == "lolicode/secretary.report";
                if notification["method"] == "subagent.started" {
                    if let Some(child) = notification["params"]["childSessionId"].as_str() {
                        let public = format!("lc:{child}");
                        if secretary.child(&public).is_some() {
                            save_worker_owner(&turn.profile, turn.id, &public)?;
                        }
                    }
                }
            }
            if notification["params"]["sessionId"].as_str() == Some(sdk_id) {
                projection.apply(snapshot, &notification);
                let event = &notification["params"]["event"];
                if event["type"] == "user/message" {
                    if let Some(sdk_message) = event["data"]["id"].as_str() {
                        let public = if sdk_message == message_id {
                            Some(turn.request_id)
                        } else {
                            extra_prompts.get(sdk_message).map(String::as_str)
                        };
                        if let Some(public) = public {
                            if let Some(message) = snapshot
                                .messages
                                .iter_mut()
                                .rev()
                                .find(|entry| entry.id == sdk_message)
                            {
                                message.id = public.into();
                            }
                        }
                    }
                }
            }
            if foreground && snapshot.status == AgentStatus::Idle {
                // A root can become idle while descendants are still active.
                // Publish idle only after the upstream tree and its host receipt settle.
                snapshot.status = AgentStatus::Running;
            }
            // Stream frames cannot deliver files or change their owning directory.
            if notification["params"]["event"]["type"] == "deliverables/presented"
                || notification["method"] == "lolicode/subagent.directory"
                || notification["method"] == "subagent.started"
            {
                if let Some(receipt) = outcome.latest_preview(|source| {
                    if source == sdk_id {
                        Some(PreviewSource {
                            session_id: turn.id.into(),
                            working_directory: turn.project.clone(),
                        })
                    } else {
                        secretary.preview_source(source)
                    }
                }) {
                    if let Some(child) = secretary.child_mut(&receipt.session_id) {
                        child.preview = Some(receipt.clone());
                    }
                    snapshot.preview = Some(receipt);
                }
            }
            if pending
                .values()
                .any(|entry| entry.owner == turn.id && entry.question.is_none())
            {
                snapshot.status = AgentStatus::WaitingPermission;
            } else if !snapshot.questions.is_empty() {
                snapshot.status = AgentStatus::WaitingQuestion;
            }
            if checkpoint {
                save_record(&turn.root.join("desktop.json"), &saved)?;
                if let Some(session) = alias_session {
                    notify_native_message_aliases_changed(turn.app, &session);
                }
            }
        }
        HarnessEvent::Request(request)
            if matches!(
                request.method.as_str(),
                "approval/request" | harness_mcp::CALL_METHOD
            ) =>
        {
            if stop_requested {
                let response = if request.method == harness_mcp::CALL_METHOD {
                    harness_mcp::denied("任务已停止")
                } else {
                    json!({"outcome":"rejected"})
                };
                let _ = request.respond(Some(response)).await;
                return Ok(());
            }
            let id = Uuid::new_v4().to_string();
            let tool_name = request.params["toolName"]
                .as_str()
                .unwrap_or("Harness tool")
                .to_owned();
            let reason = request.params["reason"]
                .as_str()
                .map(|reason| reason.chars().take(2000).collect());
            let call_id = request.params["callId"].as_str();
            let mut saved = turn.record.lock().await;
            let Some(source) = request.params["sessionId"].as_str() else {
                return Ok(());
            };
            let child = format!("lc:{source}");
            let scoped_mcp = source == sdk_id
                || saved.secretary.child_execution_root(&child).as_ref() == Some(&turn.project);
            let ticket = if request.method == harness_mcp::CALL_METHOD {
                let approved = match mcp.filter(|_| scoped_mcp) {
                    Some(bridge) => bridge.inspect(&request.params).await.map_err(|reason| {
                        if tool_name.starts_with("mcp_") && turn.remote_tools.is_none() {
                            "MCP 工具或配置已失效".into()
                        } else {
                            reason
                        }
                    }),
                    None => Err("工具不属于此任务工作目录".into()),
                };
                match approved {
                    Ok(call) => Some(call),
                    Err(reason) => {
                        drop(saved);
                        let _ = request.respond(Some(harness_mcp::denied(&reason))).await;
                        return Ok(());
                    }
                }
            } else {
                None
            };
            let owner_policy = if source == sdk_id {
                Some(turn.policy)
            } else if ticket.is_some() {
                // Top-level host RPC metadata from the runtime's scoped Agent,
                // never the model-provided arguments inside the ticket.
                request.params["workspacePolicy"].as_str()
            } else {
                None
            };
            let full_access = full_tool_access(turn.local_interactive, turn.policy, owner_policy);
            let snapshot = if source == sdk_id {
                Some(&mut saved.snapshot)
            } else {
                saved.secretary.child_mut(&child)
            };
            let Some(snapshot) = snapshot else {
                return Ok(());
            };
            let public = snapshot.session.id.clone();
            if ticket
                .as_ref()
                .is_some_and(|call| full_access || !call.requires_approval)
            {
                let bridge = mcp.cloned().ok_or("工具配置已失效")?;
                let call = ticket.ok_or("工具配置已失效")?;
                drop(saved);
                return host_tools.start(turn, request, &public, bridge, call).await;
            }
            if full_access && request.method == "approval/request" {
                // Harness full policy uses approval=never. An upstream request
                // that still reaches the host must not override that guard.
                drop(saved);
                return request.respond(Some(json!({"outcome":"rejected"}))).await;
            }
            let input = snapshot
                .messages
                .iter()
                .rev()
                .flat_map(|message| &message.parts)
                .find_map(|part| match part {
                    AgentPart::Tool { id, input, .. } if Some(id.as_str()) == call_id => {
                        Some(input.clone())
                    }
                    _ => None,
                });
            snapshot.permissions.push(AgentPermission {
                id: id.clone(),
                session_id: public.clone(),
                action: tool_name.clone(),
                resources: ticket
                    .as_ref()
                    .map(|call| call.resources.clone())
                    .unwrap_or_default(),
                description: ticket
                    .as_ref()
                    .map(|call| call.description.clone())
                    .or(reason),
                tool_name: Some(tool_name),
                tool_input: ticket.as_ref().map(|call| call.arguments.clone()).or(input),
                approval_mode: Some("user-once".into()),
                edit_preview: None,
            });
            snapshot.status = AgentStatus::WaitingPermission;
            saved.secretary.sync_waiting_status(&public);
            pending.insert(
                id,
                PendingApproval {
                    owner: public,
                    request,
                    mcp: ticket,
                    question: None,
                },
            );
        }
        HarnessEvent::Request(request) if request.method == "user-question/ask" => {
            let Some(source) = request.params["sessionId"].as_str() else {
                return Ok(());
            };
            let owner = if source == sdk_id {
                turn.id.to_owned()
            } else {
                format!("lc:{source}")
            };
            let Ok(question) = question_from_params(&owner, &request.params) else {
                return Ok(());
            };
            let mut saved = turn.record.lock().await;
            let Some(snapshot) = (if source == sdk_id {
                Some(&mut saved.snapshot)
            } else {
                saved.secretary.child_mut(&owner)
            }) else {
                return Ok(());
            };
            let key = question_key(&owner, &question.id);
            if pending.contains_key(&key) {
                return Ok(());
            }
            snapshot.questions.push(question.clone());
            snapshot.status = AgentStatus::WaitingQuestion;
            saved.secretary.sync_waiting_status(&owner);
            pending.insert(
                key,
                PendingApproval {
                    owner,
                    request,
                    mcp: None,
                    question: Some(question),
                },
            );
        }
        HarnessEvent::Request(request) => {
            let _ = request.respond(None).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod prompt_receipt_tests {
    use super::*;

    fn observe(
        outcome: &mut HarnessEvents,
        snapshot: &mut AgentSnapshot,
        projection: &mut HarnessSnapshotProjection,
        seq: u64,
        kind: &str,
        data: Value,
    ) {
        let notification = json!({
            "jsonrpc":"2.0", "method":"session.event",
            "params":{"sessionId":"root", "event":{
                "seq":seq,"time":seq,"type":kind,"data":data
            }}
        });
        outcome.apply(&notification).unwrap();
        projection.apply(snapshot, &notification);
    }

    #[test]
    fn resumed_turn_failure_preserves_the_sanitized_error_for_a_waiting_prompt() {
        let mut snapshot: AgentSnapshot = serde_json::from_value(json!({
            "session":{"id":"root","title":"Fixture","projectPath":"fixture",
                "mode":"build","permissionMode":"ask","model":null,"createdAt":1,"updatedAt":1},
            "status":"running","messages":[],"permissions":[],"questions":[],
            "diffs":[],"streamConnected":true,"streamGap":false
        }))
        .unwrap();
        let mut projection = HarnessSnapshotProjection::default();
        let mut outcome = HarnessEvents::new("root");
        observe(
            &mut outcome,
            &mut snapshot,
            &mut projection,
            1,
            "turn/start",
            json!({"turn":2}),
        );
        observe(
            &mut outcome,
            &mut snapshot,
            &mut projection,
            2,
            "user/message",
            json!({
                "id":"restored-prompt","role":"user","source":{"kind":"user"},"content":[]
            }),
        );
        observe(
            &mut outcome,
            &mut snapshot,
            &mut projection,
            3,
            "turn/end",
            json!({
                "turn":2,"reason":{"kind":"error","error":{"code":"AUTH","message":"private provider response"}}
            }),
        );
        let error = prompt_receipt(&outcome, "root", "new-prompt", snapshot.error.as_deref())
            .err()
            .expect("waiting prompt must fail with the root's terminal error");
        assert!(error.contains("认证失败"));
        assert!(!error.contains("private provider response"));
        assert!(!error.contains("未确认"));
        assert_eq!(outcome.turn_outcome("root", "new-prompt"), None);
    }

    #[test]
    fn another_completed_prompt_does_not_confirm_a_waiting_prompt() {
        let mut outcome = HarnessEvents::new("root");
        for (seq, kind, data) in [
            (1, "turn/start", json!({"turn":1})),
            (
                2,
                "user/message",
                json!({"id":"previous","role":"user","source":{"kind":"user"},"content":[]}),
            ),
            (
                3,
                "turn/end",
                json!({"turn":1,"reason":{"kind":"completed"}}),
            ),
        ] {
            outcome
                .apply(&json!({"jsonrpc":"2.0","method":"session.event","params":{
                    "sessionId":"root","event":{"seq":seq,"time":seq,"type":kind,"data":data}
                }}))
                .unwrap();
        }
        assert!(matches!(
            prompt_receipt(&outcome, "root", "previous", None),
            Ok(ReceiptStatus::Completed)
        ));
        assert_eq!(
            prompt_receipt(&outcome, "root", "waiting", None)
                .err()
                .as_deref(),
            Some("Harness 未确认本轮结果，已保留会话")
        );
    }
}

#[cfg(test)]
mod permission_tests {
    use super::*;

    #[test]
    fn only_an_admitted_local_full_policy_skips_host_tool_approval() {
        assert!(full_tool_access(true, "full", Some("full")));
        // A manually configured child can have a different admitted policy.
        assert!(full_tool_access(true, "review", Some("full")));
        assert!(!full_tool_access(true, "full", Some("review")));
        assert!(!full_tool_access(true, "workspace", Some("workspace")));
        assert!(!full_tool_access(true, "full", None));
        assert!(!full_tool_access(true, "plan", Some("full")));
        assert!(!full_tool_access(false, "full", Some("full")));
    }

    #[test]
    fn queue_admission_requires_the_active_permissions_and_work_mode() {
        let mut session: lolicode_agent::AgentSession = serde_json::from_value(json!({
            "id":"lc:fixture", "title":"Fixture", "projectPath":"fixture", "mode":"build",
            "permissionMode":"full_access", "model":null, "createdAt":1, "updatedAt":2
        }))
        .unwrap();
        let admitted = PermissionSelection::from_session(&session);
        assert!(admitted.check_queue(&session).is_ok());
        session.permission_mode = "ask".into();
        assert!(admitted.check_queue(&session).is_err());
        assert!(PermissionSelection::from_session(&session)
            .check_queue(&session)
            .is_ok());
        session.permission_mode = "full_access".into();
        session.mode = "plan".into();
        assert!(admitted.check_queue(&session).is_err());
    }
}

#[cfg(test)]
mod sidebar_tests {
    use super::*;

    #[test]
    fn cold_record_recovers_a_steering_reservation_as_paused() {
        let profile = tempfile::tempdir().unwrap();
        let id = format!("lc:{}", Uuid::new_v4());
        let file = private_root(profile.path(), &id)
            .unwrap()
            .join("desktop.json");
        let args = json!({
            "requestId": "fixture-steering", "text": "additional direction", "createdAt": 3,
            "attachments": [], "delivery": "steer"
        });
        let content = content_blocks(&args).unwrap();
        let fingerprint = message_fingerprint(&content, true);
        let record: SessionRecord = serde_json::from_value(json!({
            "snapshot": {
                "session": { "id": id, "title": "Fixture", "projectPath": profile.path(),
                    "mode": "build", "permissionMode": "ask", "model": null, "createdAt": 1, "updatedAt": 2 },
                "status": "running", "messages": [], "permissions": [], "questions": [],
                "diffs": [], "streamConnected": false, "streamGap": false
            },
            "rootCreated": true, "receipts": { "fixture-steering": { "fingerprint": fingerprint, "status": "accepted" } },
            "queue": [{ "sdk_id": null, "args": args }]
        })).unwrap();
        save_record(&file, &record).unwrap();
        let restored = load_record(&file, &id).unwrap();
        assert!(restored.snapshot.queue_paused);
        assert_eq!(restored.snapshot.queued_messages[0].id, "fixture-steering");
        assert_eq!(restored.snapshot.queued_messages[0].delivery, None);
        assert!(check_receipt(&restored, "fixture-steering", &fingerprint).unwrap());
        assert!(check_receipt(
            &restored,
            "fixture-steering",
            &message_fingerprint(&content, false)
        )
        .is_err());
    }

    #[test]
    fn sidebar_reuses_metadata_until_a_saved_update_and_preserves_history() {
        let profile = tempfile::tempdir().unwrap();
        let id = format!("lc:{}", Uuid::new_v4());
        let file = private_root(profile.path(), &id)
            .unwrap()
            .join("desktop.json");
        assert!(load_sidebar(profile.path(), &id).unwrap().is_none());
        let mut record: SessionRecord = serde_json::from_value(json!({
            "snapshot": {
                "session": {
                    "id": id, "title": "会话", "projectPath": profile.path(), "mode": "build",
                    "permissionMode": "ask", "model": null, "createdAt": 1, "updatedAt": 2
                },
                "status": "running", "messages": [], "permissions": [], "questions": [],
                "diffs": [], "streamConnected": false, "streamGap": false
            },
            "rootCreated": true, "receipts": {}
        }))
        .unwrap();
        save_record(&file, &record).unwrap();
        let first = load_sidebar(profile.path(), &id).unwrap().unwrap();
        let again = load_sidebar(profile.path(), &id).unwrap().unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(first.updated_at, 2);
        assert_eq!(first.status, AgentStatus::Error);
        assert_eq!(
            load_record(&file, &id).unwrap().snapshot.status,
            AgentStatus::Running
        );

        record.snapshot.status = AgentStatus::Idle;
        record.snapshot.session.updated_at = 3;
        save_record(&file, &record).unwrap();
        let latest = load_sidebar(profile.path(), &id).unwrap().unwrap();
        assert_eq!(latest.updated_at, 3);
        assert_eq!(latest.status, AgentStatus::Idle);
    }
}

#[cfg(test)]
mod markdown_tests {
    use super::*;

    #[test]
    fn markdown_copy_requires_the_selected_native_session_and_visible_child() {
        let owner_uuid = "4291e52e-54ba-4e45-8284-e30708f367bd";
        let child_uuid = "85acc8e9-589d-4724-a4dd-1ba0d171fcde";
        let owner = format!("lc:{owner_uuid}");
        let child = format!("lc:{child_uuid}");
        let task = format!("harness-{child_uuid}");
        let mut record: SessionRecord = serde_json::from_value(json!({
            "snapshot": {
                "session": {
                    "id": owner, "title": "Root", "projectPath": "fixture", "mode": "build",
                    "model": null, "createdAt": 1, "updatedAt": 2
                },
                "status": "idle", "messages": [], "permissions": [], "questions": [],
                "diffs": [], "streamConnected": false, "streamGap": false
            },
            "rootCreated": false, "receipts": {}
        }))
        .unwrap();
        assert_eq!(
            markdown_session(&record, &owner, &owner).unwrap_err(),
            MARKDOWN_MISSING
        );
        record.root_created = true;
        assert_eq!(markdown_session(&record, &owner, &owner).unwrap().id, owner);
        assert!(markdown_session(&record, &child, &owner).is_err());
        assert!(markdown_session(&record, &owner, &child).is_err());
        record.secretary.apply(
            &record.snapshot,
            owner_uuid,
            &json!({"method":"subagent.started","params":{
                "parentSessionId": owner_uuid, "childSessionId": child_uuid
            }}),
            &HarnessEvents::new(owner_uuid),
        );
        assert_eq!(markdown_session(&record, &owner, &child).unwrap().id, child);

        let mut legacy = serde_json::to_value(&record).unwrap();
        let worker = &mut legacy["secretary"]["workers"][child_uuid];
        worker["task"]["id"] = json!("task-legacy");
        worker["snapshot"]["session"]["coordination"]["taskId"] = json!("task-legacy");
        let legacy = serde_json::from_value(legacy).unwrap();
        assert_eq!(
            markdown_session(&legacy, &owner, &child).unwrap_err(),
            LEGACY_MARKDOWN
        );

        record.secretary.settle_interrupted();
        record.secretary.delete(&task).unwrap();
        assert!(markdown_session(&record, &owner, &child).is_err());
    }

    #[test]
    fn markdown_storage_is_only_read_from_a_verified_existing_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = canonical_project(&temp.path().to_string_lossy()).unwrap();
        let sessions = root.join("sessions");
        assert_eq!(existing_markdown_directory(&sessions).unwrap(), None);
        std::fs::write(&sessions, b"not a directory").unwrap();
        assert!(existing_markdown_directory(&sessions).is_err());
        assert_eq!(existing_markdown_directory(&root).unwrap(), Some(root));
    }
}

#[cfg(test)]
mod native_message_alias_tests {
    use super::*;

    fn fixture() -> SessionRecord {
        serde_json::from_value(json!({
            "snapshot": {
                "session": {
                    "id":"lc:4291e52e-54ba-4e45-8284-e30708f367bd", "title":"Aliases", "projectPath":"fixture", "mode":"build",
                    "model":null, "createdAt":1, "updatedAt":2
                },
                "status":"idle", "messages":[], "permissions":[], "questions":[],
                "diffs":[], "streamConnected":false, "streamGap":false
            },
            "rootCreated":true, "receipts":{},
            "workerQueues": {"lc:worker": {"inputs":[
                {"message":{"id":"ui-first","text":"First","createdAt":1,"attachments":[]}, "args":{"requestId":"ui-first"}, "sdkId":null},
                {"message":{"id":"ui-lost-reply","text":"Second","createdAt":2,"attachments":[]}, "args":{"requestId":"ui-lost-reply"}, "sdkId":null}
            ],"withdrawn":[],"receipts":{},"paused":false}}
        }))
        .unwrap()
    }

    #[test]
    fn explicit_native_receipts_and_worker_claims_keep_business_identity() {
        let mut record = fixture();
        remember_native_message_alias(&mut record, "native-root", "ui-root");
        remember_native_message_alias(&mut record, "native-root", "a-different-request");
        remember_native_message_alias(&mut record, "", "not-a-message");
        mark_worker_input_live(&mut record, "lc:worker", "ui-first", "native-worker".into());
        let first = json!({"params":{"sessionId":"worker","event":{
            "type":"user/message", "data":{"id":"native-worker","source":{"kind":"user"}}
        }}});
        assert_eq!(
            claim_worker_queue_message(&mut record, "root", &first),
            Some((
                "lc:worker".into(),
                "native-worker".into(),
                "ui-first".into()
            ))
        );
        let recovered = json!({"params":{"sessionId":"worker","event":{
            "type":"user/message", "data":{"id":"native-lost-reply","source":{"kind":"user","rpcId":worker_rpc_id("ui-lost-reply")}}
        }}});
        assert!(claim_worker_queue_message(&mut record, "root", &recovered).is_some());
        assert_eq!(record.native_message_aliases["native-root"], "ui-root");
        assert_eq!(record.native_message_aliases["native-worker"], "ui-first");
        assert_eq!(
            record.native_message_aliases["native-lost-reply"],
            "ui-lost-reply"
        );
        assert_eq!(record.native_message_aliases.len(), 3);
        assert!(record.worker_queues["lc:worker"].inputs.is_empty());
    }

    #[tokio::test]
    async fn cold_native_alias_reads_preserve_receipts_and_default_older_records_to_empty() {
        assert_eq!(
            native_alias_context_error(LEGACY_MARKDOWN.into()),
            NATIVE_LEGACY_HISTORY
        );
        assert_eq!(
            native_alias_context_error("other read failure".into()),
            "other read failure"
        );
        let directory = tempfile::tempdir().unwrap();
        let mut record = fixture();
        let owner = record.snapshot.session.id.clone();
        let file = directory.path().join("desktop.json");
        let context = |stored_aliases| VerifiedSessionRead {
            owner_id: owner.clone(),
            owner_root: directory.path().to_owned(),
            sdk_id: owner.trim_start_matches("lc:").to_owned(),
            child: None,
            controls: None,
            warm_reader: None,
            stored_aliases,
        };
        let desktop = HarnessDesktop::default();
        assert!(record.native_message_aliases.is_empty());
        remember_native_message_alias(&mut record, "native-root", "ui-root");
        save_record(&file, &record).unwrap();
        assert_eq!(
            desktop
                .native_aliases_for_context(context(None))
                .await
                .unwrap(),
            record.native_message_aliases
        );
        let mut older = serde_json::to_value(&record).unwrap();
        older
            .as_object_mut()
            .unwrap()
            .remove("nativeMessageAliases");
        std::fs::write(&file, serde_json::to_vec(&older).unwrap()).unwrap();
        assert!(desktop
            .native_aliases_for_context(context(None))
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            desktop
                .native_aliases_for_context(context(Some(record.native_message_aliases.clone())))
                .await
                .unwrap(),
            record.native_message_aliases
        );
    }
}

#[cfg(test)]
mod native_watch_tests {
    use super::*;

    #[test]
    fn destroyed_windows_release_registration_and_cancel_all_their_watches() {
        let label = format!("native-watch-window-{}", Uuid::new_v4());
        for _ in 0..25 {
            let mut cancelled = Vec::new();
            {
                let mut watches = NATIVE_VIEW_WATCHES
                    .get_or_init(Default::default)
                    .lock()
                    .unwrap();
                watches.windows.insert(label.clone());
                for _ in 0..3 {
                    let (cancel, receiver) = watch::channel(false);
                    let (ack, _) = watch::channel(0);
                    cancelled.push(receiver);
                    watches.entries.insert(
                        (label.clone(), Uuid::new_v4().to_string()),
                        NativeViewWatch {
                            serial: Uuid::new_v4(),
                            cancel,
                            ack,
                            expected: Arc::new(AtomicU64::new(0)),
                        },
                    );
                }
            }
            close_native_window(&label);
            assert!(cancelled.iter().all(|receiver| *receiver.borrow()));
            let watches = NATIVE_VIEW_WATCHES
                .get_or_init(Default::default)
                .lock()
                .unwrap();
            assert!(!watches.windows.contains(&label));
            assert!(!watches.entries.keys().any(|(window, _)| window == &label));
        }
    }

    #[test]
    fn native_watch_ack_and_cancel_are_scoped_to_the_invoking_window() {
        let id = Uuid::new_v4().to_string();
        let key = ("native-watch-fixture".to_owned(), id.clone());
        let serial = Uuid::new_v4();
        let (cancel, cancelled) = watch::channel(false);
        let (ack, acknowledged) = watch::channel(0);
        let expected = Arc::new(AtomicU64::new(1));
        NATIVE_VIEW_WATCHES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .entries
            .insert(
                key.clone(),
                NativeViewWatch {
                    serial,
                    cancel,
                    ack,
                    expected,
                },
            );
        let _guard = NativeViewWatchGuard { key, serial };
        ack_native_view("other-window", &id, 1);
        assert_eq!(*acknowledged.borrow(), 0);
        ack_native_view("native-watch-fixture", &id, 2);
        assert_eq!(*acknowledged.borrow(), 0);
        ack_native_view("native-watch-fixture", &id, 1);
        assert_eq!(*acknowledged.borrow(), 1);
        stop_native_view("other-window", &id);
        assert!(!*cancelled.borrow());
        stop_native_view("native-watch-fixture", &id);
        assert!(*cancelled.borrow());
    }

    #[test]
    fn a_retired_watch_guard_cannot_remove_a_new_generation() {
        let key = (
            "native-watch-generation".to_owned(),
            Uuid::new_v4().to_string(),
        );
        let (cancel, _) = watch::channel(false);
        let (ack, _) = watch::channel(0);
        let serial = Uuid::new_v4();
        NATIVE_VIEW_WATCHES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .entries
            .insert(
                key.clone(),
                NativeViewWatch {
                    serial,
                    cancel,
                    ack,
                    expected: Arc::new(AtomicU64::new(0)),
                },
            );
        drop(NativeViewWatchGuard {
            key: key.clone(),
            serial: Uuid::new_v4(),
        });
        assert!(NATIVE_VIEW_WATCHES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .entries
            .contains_key(&key));
        drop(NativeViewWatchGuard {
            key: key.clone(),
            serial,
        });
        assert!(!NATIVE_VIEW_WATCHES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .entries
            .contains_key(&key));
    }
}
