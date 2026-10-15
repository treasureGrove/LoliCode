use super::{
    inference::{self, Delta},
    persistence, tools,
    types::*,
};
use crate::*;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot, watch, Mutex, RwLock};
use uuid::Uuid;

pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
type Entry = Arc<Mutex<SessionState>>;
struct SessionState {
    stored: StoredSession,
    flight: Option<Flight>,
    permission: Option<PermissionWait>,
    question: Option<QuestionWait>,
}
struct Flight {
    request_id: String,
    cancel: watch::Sender<bool>,
}
struct PermissionWait {
    id: String,
    dangerous: bool,
    action: String,
    resources: Vec<String>,
    reply: oneshot::Sender<bool>,
}
struct QuestionWait {
    id: String,
    reply: oneshot::Sender<Option<Value>>,
}
#[derive(Clone)]
struct Binding {
    project: PathBuf,
    catalog: Value,
    gateway: NativeGateway,
}
struct Inner {
    root: PathBuf,
    client: reqwest::Client,
    binding: RwLock<Option<Binding>>,
    sessions: RwLock<HashMap<String, Entry>>,
    grants: Mutex<Vec<Grant>>,
    skills: RwLock<Arc<Skills>>,
    loaded_skills: Mutex<BTreeSet<String>>,
    gate: Mutex<()>,
    updating: AtomicBool,
    closed: AtomicBool,
    cleanup_uncertain: AtomicBool,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// A clonable in-process session owner. Dropping a page never cancels a task;
/// desktop lifecycle explicitly calls shutdown before application exit.
#[derive(Clone)]
pub struct NativeEngine {
    inner: Arc<Inner>,
}

impl NativeEngine {
    pub async fn open(private_root: PathBuf) -> Result<Self, String> {
        if !private_root.is_absolute() || private_root.parent().is_none() {
            return Err("编程数据目录必须为独立的绝对路径".into());
        }
        tokio::fs::create_dir_all(&private_root)
            .await
            .map_err(|_| "无法创建编程数据目录")?;
        let root = tokio::fs::canonicalize(private_root)
            .await
            .map_err(|_| "无法访问编程数据目录")?;
        let mut sessions = HashMap::new();
        for stored in persistence::load(&root).await? {
            sessions.insert(
                stored.snapshot.session.id.clone(),
                Arc::new(Mutex::new(SessionState {
                    stored,
                    flight: None,
                    permission: None,
                    question: None,
                })),
            );
        }
        let grants = persistence::load_grants(&root).await?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|_| "无法初始化模型传输")?;
        Ok(Self {
            inner: Arc::new(Inner {
                root,
                client,
                binding: RwLock::new(None),
                sessions: RwLock::new(sessions),
                grants: Mutex::new(grants),
                skills: RwLock::new(Arc::new(Skills::default())),
                loaded_skills: Mutex::new(BTreeSet::new()),
                gate: Mutex::new(()),
                updating: AtomicBool::new(false),
                closed: AtomicBool::new(false),
                cleanup_uncertain: AtomicBool::new(false),
                tasks: Mutex::new(Vec::new()),
            }),
        })
    }

    pub async fn bind(
        &self,
        project: PathBuf,
        catalog: Value,
        gateway: NativeGateway,
    ) -> Result<Value, String> {
        let _gate = self.inner.gate.lock().await;
        self.mutable()?;
        inference::validate_gateway(&gateway)?;
        let project = canonical_project(&project).await?;
        let catalog = catalog_value(catalog)?;
        let mut binding = self.inner.binding.write().await;
        if self.busy().await? {
            if binding.as_ref().is_none_or(|old| {
                old.catalog != catalog
                    || old.gateway.base_url != gateway.base_url
                    || old.gateway.bearer_token != gateway.bearer_token
            }) {
                return Err("仍有编程任务执行中，请结束后刷新模型渠道".into());
            }
        }
        *binding = Some(Binding {
            project: project.clone(),
            catalog: catalog.clone(),
            gateway,
        });
        drop(binding);
        Ok(
            json!({"workspace":{"path":project.to_string_lossy(),"name":project.file_name().map(|v|v.to_string_lossy().into_owned()).unwrap_or_else(||"项目".into())},"catalog":catalog,"sessions":self.list(Some(&project), false).await}),
        )
    }

    fn mutable(&self) -> Result<(), String> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err("编程核心已关闭".into());
        }
        if self.inner.updating.load(Ordering::Acquire) {
            return Err("正在准备更新，请稍后重试".into());
        }
        if self.inner.cleanup_uncertain.load(Ordering::Acquire) {
            return Err("无法确认命令进程已回收，暂不能开始新操作；请关闭并重新打开应用。".into());
        }
        Ok(())
    }
    async fn entry(&self, id: &str) -> Result<Entry, String> {
        self.inner
            .sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "本地会话不存在，请重新读取会话列表".into())
    }
    async fn bound(&self) -> Result<Binding, String> {
        self.inner
            .binding
            .read()
            .await
            .clone()
            .ok_or_else(|| "请先选择项目文件夹".into())
    }
    pub async fn busy(&self) -> Result<bool, String> {
        if self.inner.cleanup_uncertain.load(Ordering::Acquire) {
            return Err("无法确认命令进程已回收，暂不能更新或切换运行环境。".into());
        }
        let entries: Vec<_> = self.inner.sessions.read().await.values().cloned().collect();
        for entry in entries {
            if entry.lock().await.flight.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }
    async fn list(&self, project: Option<&Path>, archived: bool) -> Vec<AgentSession> {
        let entries: Vec<_> = self.inner.sessions.read().await.values().cloned().collect();
        let mut result = Vec::new();
        for entry in entries {
            let session = entry.lock().await.stored.snapshot.session.clone();
            if (archived || !session.archived)
                && project.is_none_or(|p| Path::new(&session.project_path) == p)
            {
                result.push(session);
            }
        }
        result.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then(b.updated_at.cmp(&a.updated_at))
        });
        result
    }

    pub async fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        if method == "shutdown" {
            self.shutdown().await?;
            return Ok(Value::Null);
        }
        let mutation = matches!(
            method,
            "createSession"
                | "updateSession"
                | "renameSession"
                | "setSessionMetadata"
                | "deleteSession"
                | "sendMessage"
                | "configureSkills"
                | "closeProject"
                | "beginUpdate"
                | "endUpdate"
        );
        let _gate = if mutation {
            Some(self.inner.gate.lock().await)
        } else {
            None
        };
        if mutation && !matches!(method, "endUpdate" | "beginUpdate") {
            self.mutable()?;
        }
        match method {
            "status" => {
                let bound = self.inner.binding.read().await;
                Ok(
                    json!({"available":true,"version":"rust-native-1","running":!self.inner.closed.load(Ordering::Acquire),"projectPath":bound.as_ref().map(|b|b.project.to_string_lossy().into_owned())}),
                )
            }
            "catalog" => Ok(self
                .inner
                .binding
                .read()
                .await
                .as_ref()
                .map(|b| b.catalog.clone())
                .unwrap_or_else(|| json!({"revision":0,"models":[],"excludedSources":[]}))),
            "busy" => Ok(json!(self.busy().await?)),
            "activity" => {
                let result = self.busy().await;
                let unknown = result.is_err();
                let busy = result.unwrap_or(true);
                Ok(
                    json!({"engine":"lolicode-native","inProcess":true,"features":{"workflows":false,"automation":false,"remote":false},"busy":busy,"active":busy,"unknown":unknown,"source":"rust-in-process"}),
                )
            }
            "capabilities" => Ok(
                json!({"engine":"lolicode-native","inProcess":true,"features":{"chat":true,"streaming":true,"tools":true,"permissions":true,"questions":true,"skills":true,"workflows":false,"automation":false,"remote":false,"mcp":false,"plugins":false}}),
            ),
            "beginUpdate" => {
                self.mutable()?;
                self.inner.updating.store(true, Ordering::Release);
                match self.busy().await {
                    Ok(false) => {}
                    Ok(true) => {
                        self.inner.updating.store(false, Ordering::Release);
                        return Err("仍有编程任务或权限/提问等待处理，请任务结束后重试更新".into());
                    }
                    Err(error) => {
                        self.inner.updating.store(false, Ordering::Release);
                        return Err(error);
                    }
                }
                Ok(Value::Null)
            }
            "endUpdate" => {
                self.inner.updating.store(false, Ordering::Release);
                Ok(Value::Null)
            }
            "closeProject" => {
                if self.busy().await? {
                    return Err("仍有编程任务执行中，请先停止任务".into());
                }
                *self.inner.binding.write().await = None;
                Ok(Value::Null)
            }
            "listSessions" => {
                let bound = self.inner.binding.read().await.clone();
                let project = args["projectPath"]
                    .as_str()
                    .map(PathBuf::from)
                    .or_else(|| bound.map(|b| b.project));
                encode(
                    &self
                        .list(
                            project.as_deref(),
                            args["includeArchived"].as_bool().unwrap_or(false),
                        )
                        .await,
                )
            }
            "getSession" => {
                let entry = self.entry(arg(&args, "sessionId")?).await?;
                let state = entry.lock().await;
                encode(&state.stored.snapshot)
            }
            "createSession" => self.create(&args).await,
            "updateSession" | "renameSession" | "setSessionMetadata" => {
                self.update(method, &args).await
            }
            "deleteSession" => {
                let id = arg(&args, "sessionId")?;
                let entry = self.entry(id).await?;
                let state = entry.lock().await;
                if state.flight.is_some() {
                    return Err("请先停止当前任务再删除会话".into());
                }
                tokio::fs::remove_file(persistence::session_path(&self.inner.root, id)?)
                    .await
                    .map_err(|_| "无法删除本地会话记录")?;
                self.inner.sessions.write().await.remove(id);
                Ok(Value::Null)
            }
            "sendMessage" => {
                self.send(&args).await?;
                Ok(Value::Null)
            }
            "queryCommand" => {
                let id = arg(&args, "sessionId")?;
                let command = arg(&args, "requestId")?;
                let entry = self.entry(id).await?;
                let state = entry.lock().await;
                let result = state
                    .stored
                    .commands
                    .get(command)
                    .map(|_| json!({"commandId":command,"status":"accepted"}));
                Ok(
                    json!({"results":[{"key":{"sessionId":id.trim_start_matches("lc:"),"commandId":command},"result":result}]}),
                )
            }
            "interruptSession" => {
                let entry = self.entry(arg(&args, "sessionId")?).await?;
                let state = entry.lock().await;
                if let Some(flight) = &state.flight {
                    let _ = flight.cancel.send(true);
                }
                Ok(Value::Null)
            }
            "replyPermission" => {
                self.reply_permission(&args).await?;
                Ok(Value::Null)
            }
            "replyQuestion" | "rejectQuestion" => {
                self.reply_question(&args, method == "rejectQuestion")
                    .await?;
                Ok(Value::Null)
            }
            "configureSkills" => {
                let revision = args["revision"].as_u64().ok_or("技能版本无效")?;
                let items: Vec<Skill> = serde_json::from_value(args["skills"].clone())
                    .map_err(|_| "技能配置格式无效")?;
                let mut ids = BTreeSet::new();
                if items.len() > 128 {
                    return Err("技能数量超出上限".into());
                }
                for item in &items {
                    if item.id.is_empty()
                        || item.id.len() > 128
                        || item.name.len() > 256
                        || item.description.len() > 4096
                        || item.content.len() > 2 * 1024 * 1024
                        || !ids.insert(item.id.clone())
                    {
                        return Err("技能内容或标识无效".into());
                    }
                }
                if items.iter().map(|s| s.content.len()).sum::<usize>() > 8 * 1024 * 1024 {
                    return Err("启用技能的总正文超过注册上限".into());
                }
                let next = Skills { revision, items };
                if self.inner.skills.read().await.as_ref() == &next {
                    return Ok(Value::Null);
                }
                if self.busy().await? {
                    return Err("任务执行中，结束后再更新技能".into());
                }
                *self.inner.skills.write().await = Arc::new(next);
                self.inner.loaded_skills.lock().await.clear();
                Ok(Value::Null)
            }
            "loadedSkills" => encode(
                &self
                    .inner
                    .loaded_skills
                    .lock()
                    .await
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>(),
            ),
            _ => Err("此功能尚未迁入应用内编程核心，当前未执行任何操作。".into()),
        }
    }

    async fn create(&self, args: &Value) -> Result<Value, String> {
        let binding = self.bound().await?;
        let id = args["modelId"]
            .as_str()
            .or_else(|| binding.catalog["defaultModel"].as_str())
            .ok_or("请选择一个可用模型")?;
        let (model, _) = selection(&binding.catalog, id)?;
        let mode = args["mode"].as_str().unwrap_or("build");
        let permission = args["permissionMode"].as_str().unwrap_or("ask");
        validate_mode(mode, permission)?;
        let time = now();
        let session = AgentSession {
            id: format!("lc:{}", Uuid::new_v4()),
            title: args["title"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("新会话")
                .chars()
                .take(160)
                .collect(),
            project_path: binding.project.to_string_lossy().into_owned(),
            mode: mode.into(),
            permission_mode: permission.into(),
            pinned: false,
            archived: false,
            model: Some(model),
            created_at: time,
            updated_at: time,
        };
        let stored = StoredSession {
            format: 1,
            snapshot: AgentSnapshot {
                session: session.clone(),
                status: AgentStatus::Idle,
                messages: Vec::new(),
                permissions: Vec::new(),
                questions: Vec::new(),
                diffs: Vec::new(),
                error: None,
                stream_connected: true,
                stream_gap: false,
            },
            history: Vec::new(),
            commands: BTreeMap::new(),
            file_changes: BTreeMap::new(),
        };
        persistence::save(&self.inner.root, &stored).await?;
        self.inner.sessions.write().await.insert(
            session.id.clone(),
            Arc::new(Mutex::new(SessionState {
                stored,
                flight: None,
                permission: None,
                question: None,
            })),
        );
        encode(&session)
    }

    async fn update(&self, method: &str, args: &Value) -> Result<Value, String> {
        let entry = self.entry(arg(args, "sessionId")?).await?;
        let mut state = entry.lock().await;
        if method == "updateSession" && state.flight.is_some() {
            return Err("任务执行中，请结束后再切换模型或模式".into());
        }
        let mut stored = state.stored.clone();
        let session = &mut stored.snapshot.session;
        if method == "renameSession" {
            let title = arg(args, "title")?.trim();
            if title.is_empty() || title.chars().count() > 160 {
                return Err("会话名称需为1到160个字符".into());
            }
            session.title = title.into();
        }
        if method == "setSessionMetadata" {
            if let Some(value) = args["pinned"].as_bool() {
                session.pinned = value;
            }
            if let Some(value) = args["archived"].as_bool() {
                session.archived = value;
            }
        }
        if method == "updateSession" {
            let mode = args["mode"].as_str().unwrap_or(&session.mode).to_string();
            let permission = args["permissionMode"]
                .as_str()
                .unwrap_or(&session.permission_mode)
                .to_string();
            validate_mode(&mode, &permission)?;
            session.mode = mode;
            session.permission_mode = permission;
            if let Some(id) = args["modelId"].as_str() {
                session.model = Some(selection(&self.bound().await?.catalog, id)?.0);
            }
        }
        session.updated_at = now();
        persistence::save(&self.inner.root, &stored).await?;
        state.stored = stored;
        encode(&state.stored.snapshot.session)
    }

    async fn send(&self, args: &Value) -> Result<(), String> {
        let id = arg(args, "sessionId")?;
        let text = arg(args, "text")?;
        let request_id = arg(args, "requestId")?;
        if request_id.trim().is_empty()
            || text.trim().is_empty()
            || text.len() > 1024 * 1024
            || request_id.len() > 256
            || request_id.contains('\0')
        {
            return Err("消息或请求标识无效".into());
        }
        let binding = self.bound().await?;
        let entry = self.entry(id).await?;
        let mut state = entry.lock().await;
        if let Some(previous) = state.stored.commands.get(request_id) {
            return if previous.text == text {
                Ok(())
            } else {
                Err("此请求标识已用于另一条消息，未重复发送".into())
            };
        }
        if state.flight.is_some() {
            return Err("此会话仍在执行任务，请先停止或等待完成".into());
        }
        let model = state
            .stored
            .snapshot
            .session
            .model
            .clone()
            .ok_or("此会话没有可用模型")?;
        let context = binding.catalog["models"]
            .as_array()
            .and_then(|items| {
                items.iter().find(|m| {
                    m["providerId"] == model.provider_id && m["modelId"] == model.model_id
                })
            })
            .ok_or("会话模型不在当前渠道目录中，请重新选择模型")?["contextLimit"]
            .as_u64()
            .unwrap_or(8192)
            .clamp(1024, 2_000_000);
        let (cancel, receiver) = watch::channel(false);
        let skills = self.inner.skills.read().await.clone();
        let mut stored = state.stored.clone();
        stored.snapshot.status = AgentStatus::Running;
        stored.snapshot.error = None;
        stored.snapshot.permissions.clear();
        stored.snapshot.questions.clear();
        stored.snapshot.session.updated_at = now();
        stored.snapshot.messages.push(AgentMessage {
            id: request_id.into(),
            role: "user".into(),
            created_at: now(),
            completed_at: Some(now()),
            parts: vec![AgentPart::Text { text: text.into() }],
        });
        stored.history.push(json!({"role":"user","content":text}));
        stored.commands.insert(
            request_id.into(),
            CommandRecord {
                text: text.into(),
                status: "accepted".into(),
            },
        );
        persistence::save(&self.inner.root, &stored).await?;
        state.stored = stored;
        state.flight = Some(Flight {
            request_id: request_id.into(),
            cancel,
        });
        drop(state);
        let engine = self.clone();
        let request_id = request_id.to_string();
        let task = tokio::spawn(async move {
            let outcome = engine
                .run(
                    entry.clone(),
                    binding.gateway,
                    model,
                    context,
                    skills,
                    receiver,
                )
                .await;
            engine.finish(entry, &request_id, outcome).await;
        });
        let mut tasks = self.inner.tasks.lock().await;
        tasks.retain(|task| !task.is_finished());
        tasks.push(task);
        Ok(())
    }

    async fn run(
        &self,
        entry: Entry,
        gateway: NativeGateway,
        model: AgentModelRef,
        context: u64,
        skills: Arc<Skills>,
        cancel: watch::Receiver<bool>,
    ) -> Result<(), String> {
        for _ in 0..24 {
            if *cancel.borrow() {
                return Err(inference::CANCELLED.into());
            }
            let assistant_id = format!("assistant-{}", Uuid::new_v4());
            let (messages, project, mode) = {
                let mut state = entry.lock().await;
                let session = &state.stored.snapshot.session;
                let project = PathBuf::from(&session.project_path);
                let mode = session.mode.clone();
                let mut messages =
                    vec![json!({"role":"system","content":system_prompt(&project,&mode,&skills)})];
                messages.extend(state.stored.history.clone());
                if serde_json::to_vec(&messages)
                    .map_err(|_| "无法编码会话")?
                    .len()
                    > context.saturating_mul(2) as usize
                {
                    return Err(
                        "会话已超过此模型的保守上下文预算，请新建会话或选择更长上下文模型。".into(),
                    );
                }
                state.stored.snapshot.messages.push(AgentMessage {
                    id: assistant_id.clone(),
                    role: "assistant".into(),
                    created_at: now(),
                    completed_at: None,
                    parts: Vec::new(),
                });
                persistence::save(&self.inner.root, &state.stored).await?;
                (messages, project, mode)
            };
            let mut schemas = tools::schemas();
            schemas.extend(internal_schemas());
            let (tx, mut rx) = mpsc::unbounded_channel();
            let inference = inference::infer(
                &self.inner.client,
                &gateway,
                &model.model_id,
                messages,
                schemas,
                tx,
                cancel.clone(),
            );
            tokio::pin!(inference);
            let result = loop {
                tokio::select! {result=&mut inference=>break result,Some(delta)=rx.recv()=>self.delta(&entry,&assistant_id,delta).await}
            };
            while let Ok(delta) = rx.try_recv() {
                self.delta(&entry, &assistant_id, delta).await;
            }
            let turn = result?;
            {
                let mut state = entry.lock().await;
                let message = state
                    .stored
                    .snapshot
                    .messages
                    .iter_mut()
                    .find(|m| m.id == assistant_id)
                    .ok_or("助手消息状态丢失")?;
                message.parts.retain(|part| {
                    !matches!(part, AgentPart::Text { .. } | AgentPart::Reasoning { .. })
                });
                if !turn.reasoning.is_empty() {
                    message.parts.insert(
                        0,
                        AgentPart::Reasoning {
                            text: turn.reasoning.clone(),
                        },
                    );
                }
                if !turn.content.is_empty() {
                    message.parts.push(AgentPart::Text {
                        text: turn.content.clone(),
                    });
                }
                for call in &turn.calls {
                    message.parts.push(AgentPart::Tool {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        state: "pending".into(),
                        input: serde_json::from_str(&call.arguments).map_err(|_| "工具参数无效")?,
                        output: None,
                        error: None,
                    });
                }
                message.completed_at = Some(now());
                let mut history = json!({"role":"assistant","content":if turn.content.is_empty(){Value::Null}else{json!(turn.content)}});
                if !turn.reasoning.is_empty() {
                    history["reasoning_content"] = json!(turn.reasoning);
                }
                if !turn.calls.is_empty() {
                    history["tool_calls"]=json!(turn.calls.iter().map(|call|json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments}})).collect::<Vec<_>>());
                }
                state.stored.history.push(history);
                persistence::save(&self.inner.root, &state.stored).await?;
            }
            if turn.calls.is_empty() {
                return Ok(());
            }
            for call in turn.calls {
                if *cancel.borrow() {
                    return Err(inference::CANCELLED.into());
                }
                let input: Value =
                    serde_json::from_str(&call.arguments).map_err(|_| "工具参数无效")?;
                let output = if call.name == "ask_user" || call.name == "exit_plan_mode" {
                    self.ask(&entry, &call.name, &input, cancel.clone())
                        .await
                        .map(|text| tools::ToolOutput {
                            text,
                            diffs: Vec::new(),
                            file_changes: Vec::new(),
                        })
                } else if call.name == "read_skill" {
                    self.read_skill(&entry, &skills, &input, context)
                        .await
                        .map(|text| tools::ToolOutput {
                            text,
                            diffs: Vec::new(),
                            file_changes: Vec::new(),
                        })
                } else {
                    match tools::inspect(&project, &call.name, &input) {
                        Err(error) => Err(error),
                        Ok(inspection) => {
                            if mode == "plan" && (inspection.mutating || call.name == "run_command")
                            {
                                Err("分析模式不能写文件或执行命令；请先请求用户批准实施计划。"
                                    .into())
                            } else if self
                                .authorize(&entry, &inspection, &call.name, &input, cancel.clone())
                                .await?
                            {
                                self.tool_state(
                                    &entry,
                                    &assistant_id,
                                    &call.id,
                                    "running",
                                    None,
                                    None,
                                )
                                .await?;
                                tools::execute(&project, &call.name, &input, cancel.clone()).await
                            } else {
                                Err("用户拒绝了此次工具操作；请调整方案并继续。".into())
                            }
                        }
                    }
                };
                let cancelled = *cancel.borrow();
                self.record_tool_outcome(
                    &entry,
                    &assistant_id,
                    &call.id,
                    output,
                    cancelled,
                    &gateway.bearer_token,
                )
                .await?;
            }
        }
        Err("本次任务已达到24轮工具调用上限，请确认结果后继续。".into())
    }

    async fn delta(&self, entry: &Entry, id: &str, delta: Delta) {
        let mut state = entry.lock().await;
        if let Some(message) = state
            .stored
            .snapshot
            .messages
            .iter_mut()
            .find(|m| m.id == id)
        {
            match delta {
                Delta::Text(value) => {
                    if let Some(AgentPart::Text { text }) = message
                        .parts
                        .iter_mut()
                        .find(|p| matches!(p, AgentPart::Text { .. }))
                    {
                        text.push_str(&value);
                    } else {
                        message.parts.push(AgentPart::Text { text: value });
                    }
                }
                Delta::Reasoning(value) => {
                    if let Some(AgentPart::Reasoning { text }) = message
                        .parts
                        .iter_mut()
                        .find(|p| matches!(p, AgentPart::Reasoning { .. }))
                    {
                        text.push_str(&value);
                    } else {
                        message.parts.push(AgentPart::Reasoning { text: value });
                    }
                }
            }
        }
    }
    async fn record_tool_outcome(
        &self,
        entry: &Entry,
        message_id: &str,
        call_id: &str,
        output: Result<tools::ToolOutput, String>,
        cancelled: bool,
        secret: &str,
    ) -> Result<(), String> {
        let uncertain = output
            .as_ref()
            .err()
            .is_some_and(|error| tools::cleanup_uncertain(error));
        if uncertain {
            self.inner.cleanup_uncertain.store(true, Ordering::Release);
        }
        let (text, diffs, changes, failure) = match output {
            Ok(output) => (output.text, output.diffs, output.file_changes, None),
            Err(error) => {
                let error = error
                    .trim_start_matches(tools::CLEANUP_UNCERTAIN_PREFIX)
                    .replace(secret, "[已隐藏]");
                (
                    format!("Tool failed: {error}"),
                    Vec::new(),
                    Vec::new(),
                    Some(error),
                )
            }
        };
        let mut state = entry.lock().await;
        for message in &mut state.stored.snapshot.messages {
            if message.id == message_id {
                for part in &mut message.parts {
                    if let AgentPart::Tool {
                        id,
                        state: status,
                        output,
                        error,
                        ..
                    } = part
                    {
                        if id == call_id {
                            *status = if failure.is_some() {
                                "error"
                            } else {
                                "completed"
                            }
                            .into();
                            *output = Some(text.clone());
                            *error = failure.clone();
                        }
                    }
                }
            }
        }
        state
            .stored
            .history
            .push(json!({"role":"tool","tool_call_id":call_id,"content":text}));
        for diff in diffs {
            if let Some(old) = state
                .stored
                .snapshot
                .diffs
                .iter_mut()
                .find(|old| old.path == diff.path)
            {
                *old = diff;
            } else {
                state.stored.snapshot.diffs.push(diff);
            }
        }
        for change in changes {
            let saved = state
                .stored
                .file_changes
                .entry(change.path.clone())
                .or_insert_with(|| FileState {
                    before: change.before,
                    after: None,
                });
            saved.after = change.after;
            let cumulative = tools::cumulative_diff(
                &change.path,
                saved.before.as_deref(),
                saved.after.as_deref(),
            );
            state
                .stored
                .snapshot
                .diffs
                .retain(|diff| diff.path != change.path);
            state.stored.snapshot.diffs.extend(cumulative);
        }
        persistence::save(&self.inner.root, &state.stored).await?;
        if uncertain {
            return Err(failure.unwrap_or_else(|| "无法确认命令进程已回收".into()));
        }
        if cancelled {
            return Err(failure
                .filter(|error| error != tools::CANCELLED)
                .unwrap_or_else(|| inference::CANCELLED.into()));
        }
        Ok(())
    }
    async fn tool_state(
        &self,
        entry: &Entry,
        message_id: &str,
        id: &str,
        value: &str,
        output: Option<String>,
        failure: Option<String>,
    ) -> Result<(), String> {
        let mut state = entry.lock().await;
        for message in &mut state.stored.snapshot.messages {
            if message.id != message_id {
                continue;
            }
            for part in &mut message.parts {
                if let AgentPart::Tool {
                    id: tool_id,
                    state: status,
                    output: old,
                    error,
                    ..
                } = part
                {
                    if tool_id == id {
                        *status = value.into();
                        *old = output.clone();
                        *error = failure.clone();
                    }
                }
            }
        }
        persistence::save(&self.inner.root, &state.stored).await
    }

    async fn authorize(
        &self,
        entry: &Entry,
        inspection: &tools::ToolInspection,
        name: &str,
        input: &Value,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<bool, String> {
        let (policy, project) = {
            let state = entry.lock().await;
            (
                state.stored.snapshot.session.permission_mode.clone(),
                state.stored.snapshot.session.project_path.clone(),
            )
        };
        let grant = Grant {
            project,
            action: inspection.action.clone(),
            resources: inspection.resources.clone(),
        };
        let remembered = !inspection.dangerous && self.inner.grants.lock().await.contains(&grant);
        if remembered
            || policy == "full_access"
            || (!inspection.requires_approval && !inspection.mutating)
            || (policy == "auto"
                && !inspection.dangerous
                && (!inspection.requires_approval || inspection.mutating))
        {
            return Ok(true);
        }
        let (tx, rx) = oneshot::channel();
        let id = format!("permission-{}", Uuid::new_v4());
        {
            let mut state = entry.lock().await;
            let session_id = state.stored.snapshot.session.id.clone();
            state.stored.snapshot.status = AgentStatus::WaitingPermission;
            state.stored.snapshot.permissions = vec![AgentPermission {
                id: id.clone(),
                session_id,
                action: inspection.action.clone(),
                resources: inspection.resources.clone(),
                description: Some(inspection.description.clone()),
                tool_name: Some(name.into()),
                tool_input: Some(input.clone()),
                approval_mode: if inspection.dangerous {
                    Some("user-once".into())
                } else {
                    None
                },
            }];
            state.permission = Some(PermissionWait {
                id,
                dangerous: inspection.dangerous,
                action: inspection.action.clone(),
                resources: inspection.resources.clone(),
                reply: tx,
            });
            persistence::save(&self.inner.root, &state.stored).await?;
        }
        tokio::select! {_ = inference::cancelled(&mut cancel)=>Err(inference::CANCELLED.into()),value=rx=>value.map_err(|_|"权限请求已结束".into())}
    }

    async fn reply_permission(&self, args: &Value) -> Result<(), String> {
        let entry = self.entry(arg(args, "sessionId")?).await?;
        let mut state = entry.lock().await;
        let id = arg(args, "requestId")?;
        let pending = state
            .permission
            .as_ref()
            .filter(|p| p.id == id)
            .ok_or("此权限请求已结束或不属于该会话")?;
        let decision = arg(args, "decision")?;
        if !matches!(decision, "once" | "always" | "reject") {
            return Err("无效的权限选择".into());
        }
        if decision == "always" && pending.dangerous {
            return Err("此危险操作只允许单次授权，不能记住".into());
        }
        if decision == "always" {
            let grant = Grant {
                project: state.stored.snapshot.session.project_path.clone(),
                action: pending.action.clone(),
                resources: pending.resources.clone(),
            };
            let mut grants = self.inner.grants.lock().await;
            let mut updated = grants.clone();
            if !updated.contains(&grant) {
                updated.push(grant);
            }
            persistence::atomic(&self.inner.root.join("project-grants.json"), &updated).await?;
            *grants = updated;
        }
        let pending = state.permission.take().ok_or("权限请求已结束")?;
        state.stored.snapshot.permissions.clear();
        state.stored.snapshot.status = AgentStatus::Running;
        persistence::save(&self.inner.root, &state.stored).await?;
        let _ = pending.reply.send(decision != "reject");
        Ok(())
    }

    async fn ask(
        &self,
        entry: &Entry,
        name: &str,
        input: &Value,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<String, String> {
        let plan = name == "exit_plan_mode";
        let question = if plan {
            let state = entry.lock().await;
            if state.stored.snapshot.session.mode != "plan" {
                return Ok("Already in implementation mode.".into());
            }
            let text = input["plan"]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.len() <= 128 * 1024)
                .ok_or("请提供完整的实施计划后再请求批准")?;
            AgentQuestion {
                id: format!("question-{}", Uuid::new_v4()),
                session_id: state.stored.snapshot.session.id.clone(),
                title: "请确认实施计划".into(),
                fields: vec![field(
                    "answer_0",
                    "实施计划",
                    Some(text.into()),
                    false,
                    vec![AgentQuestionOption {
                        value: "approve".into(),
                        label: "同意并开始实施".into(),
                        description: None,
                    }],
                    false,
                )],
            }
        } else {
            let items = input["questions"]
                .as_array()
                .filter(|v| !v.is_empty() && v.len() <= 8)
                .ok_or("提问需要1到8个问题")?;
            let state = entry.lock().await;
            let mut fields = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let title = item["question"]
                    .as_str()
                    .filter(|v| v.len() <= 4096)
                    .ok_or("问题文本无效")?;
                let mut options = Vec::new();
                if let Some(values) = item["options"].as_array() {
                    if values.len() > 32 {
                        return Err("问题选项过多".into());
                    }
                    for value in values {
                        let label = value["label"]
                            .as_str()
                            .filter(|v| v.len() <= 256)
                            .ok_or("问题选项无效")?;
                        options.push(AgentQuestionOption {
                            value: label.into(),
                            label: label.into(),
                            description: value["description"].as_str().map(str::to_owned),
                        });
                    }
                }
                fields.push(field(
                    &format!("answer_{index}"),
                    title,
                    None,
                    item["multiSelect"].as_bool().unwrap_or(false),
                    options,
                    true,
                ));
            }
            AgentQuestion {
                id: format!("question-{}", Uuid::new_v4()),
                session_id: state.stored.snapshot.session.id.clone(),
                title: "需要你的回答".into(),
                fields,
            }
        };
        let (tx, rx) = oneshot::channel();
        {
            let mut state = entry.lock().await;
            state.stored.snapshot.status = AgentStatus::WaitingQuestion;
            state.stored.snapshot.questions = vec![question.clone()];
            state.question = Some(QuestionWait {
                id: question.id,
                reply: tx,
            });
            persistence::save(&self.inner.root, &state.stored).await?;
        }
        let answer = tokio::select! {_=inference::cancelled(&mut cancel)=>return Err(inference::CANCELLED.into()),value=rx=>value.map_err(|_|"提问已结束")?};
        match answer {
            None => Err("用户拒绝了此次提问，请调整方案。".into()),
            Some(answer) => {
                if plan {
                    if answer["answer_0"] != "approve" {
                        return Err("用户没有批准实施计划".into());
                    }
                    let mut state = entry.lock().await;
                    state.stored.snapshot.session.mode = "build".into();
                    persistence::save(&self.inner.root, &state.stored).await?;
                    Ok("Plan approved. Implementation mode is now enabled.".into())
                } else {
                    serde_json::to_string(&answer).map_err(|_| "无法编码回答".into())
                }
            }
        }
    }
    async fn reply_question(&self, args: &Value, reject: bool) -> Result<(), String> {
        let entry = self.entry(arg(args, "sessionId")?).await?;
        let mut state = entry.lock().await;
        let id = arg(args, "requestId")?;
        if state.question.as_ref().is_none_or(|p| p.id != id) {
            return Err("此提问已结束或不属于该会话".into());
        }
        let answer = if reject {
            None
        } else {
            let value = args["answer"].clone();
            let object = value.as_object().ok_or("回答格式无效")?;
            let question = state
                .stored
                .snapshot
                .questions
                .first()
                .ok_or("提问已结束")?;
            for field in &question.fields {
                let answer = object.get(&field.key).ok_or("请回答所有必填问题")?;
                if field.field_type == "multiselect" {
                    let items = answer.as_array().ok_or("多选回答格式无效")?;
                    if items.iter().any(|v| v.as_str().is_none()) {
                        return Err("多选回答格式无效".into());
                    }
                } else {
                    let text = answer.as_str().ok_or("回答文本无效")?;
                    if !field.custom && !field.options.iter().any(|o| o.value == text) {
                        return Err("请选择可用的回答选项".into());
                    }
                }
            }
            Some(value)
        };
        let pending = state.question.take().ok_or("提问已结束")?;
        state.stored.snapshot.questions.clear();
        state.stored.snapshot.status = AgentStatus::Running;
        persistence::save(&self.inner.root, &state.stored).await?;
        let _ = pending.reply.send(answer);
        Ok(())
    }

    async fn read_skill(
        &self,
        entry: &Entry,
        skills: &Skills,
        input: &Value,
        context: u64,
    ) -> Result<String, String> {
        let id = arg(input, "id")?;
        let skill = skills
            .items
            .iter()
            .find(|s| s.id == id)
            .ok_or("此技能未被启用或未注册")?;
        let used = {
            let state = entry.lock().await;
            serde_json::to_vec(&state.stored.history)
                .map_err(|_| "无法计算技能预算")?
                .len()
        };
        let budget = (context.saturating_mul(2) as usize).saturating_sub(used + 8192);
        if skill.content.len() > budget {
            return Err(
                "该技能完整正文超出当前模型的剩余上下文预算；未截断指令，请选择更长上下文模型。"
                    .into(),
            );
        }
        self.inner.loaded_skills.lock().await.insert(id.into());
        Ok(skill.content.clone())
    }

    async fn finish(&self, entry: Entry, request: &str, result: Result<(), String>) {
        let mut state = entry.lock().await;
        if state
            .flight
            .as_ref()
            .is_none_or(|f| f.request_id != request)
        {
            return;
        }
        let cancelled = result
            .as_ref()
            .err()
            .is_some_and(|e| e == inference::CANCELLED);
        state.stored.snapshot.status = if result.is_ok() || cancelled {
            AgentStatus::Idle
        } else {
            AgentStatus::Error
        };
        state.stored.snapshot.error = if cancelled { None } else { result.err() };
        state.stored.snapshot.permissions.clear();
        state.stored.snapshot.questions.clear();
        state.permission = None;
        state.question = None;
        state.stored.snapshot.session.updated_at = now();
        for message in &mut state.stored.snapshot.messages {
            if message.role == "assistant" && message.completed_at.is_none() {
                message.completed_at = Some(now());
            }
            for part in &mut message.parts {
                if let AgentPart::Tool {
                    state: status,
                    error,
                    ..
                } = part
                {
                    if matches!(status.as_str(), "pending" | "running") {
                        *status = "error".into();
                        *error = Some(
                            if cancelled {
                                "任务已停止"
                            } else {
                                "执行未完成"
                            }
                            .into(),
                        );
                    }
                }
            }
        }
        let idle = state.stored.snapshot.status == AgentStatus::Idle;
        if let Some(command) = state.stored.commands.get_mut(request) {
            command.status = if cancelled {
                "cancelled"
            } else if idle {
                "completed"
            } else {
                "failed"
            }
            .into();
        }
        persistence::repair_history(&mut state.stored);
        if persistence::save(&self.inner.root, &state.stored)
            .await
            .is_err()
        {
            state.stored.snapshot.status = AgentStatus::Error;
            state.stored.snapshot.error =
                Some("任务已结束，但无法保存本地记录，请检查磁盘后再继续。".into());
        }
        state.flight = None;
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        let _gate = self.inner.gate.lock().await;
        if self.inner.closed.swap(true, Ordering::AcqRel) {
            return if self.inner.cleanup_uncertain.load(Ordering::Acquire) {
                Err("无法确认所有命令进程均已回收".into())
            } else {
                Ok(())
            };
        }
        let entries: Vec<_> = self.inner.sessions.read().await.values().cloned().collect();
        for entry in entries {
            let state = entry.lock().await;
            if let Some(flight) = &state.flight {
                let _ = flight.cancel.send(true);
            }
        }
        let tasks = std::mem::take(&mut *self.inner.tasks.lock().await);
        for task in tasks {
            tokio::time::timeout(Duration::from_secs(30), task)
                .await
                .map_err(|_| "编程任务停止超时，仍需等待工具清理")?
                .map_err(|_| "编程任务清理未完成")?;
        }
        *self.inner.binding.write().await = None;
        if self.inner.cleanup_uncertain.load(Ordering::Acquire) {
            return Err("无法确认所有命令进程均已回收".into());
        }
        Ok(())
    }
}

fn arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args[key]
        .as_str()
        .filter(|v| !v.contains('\0'))
        .ok_or_else(|| format!("缺少有效参数：{key}"))
}
fn encode<T: serde::Serialize + ?Sized>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "无法编码编程状态".into())
}
async fn canonical_project(path: &Path) -> Result<PathBuf, String> {
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| "项目文件夹不存在或无法访问")?;
    if !path.is_dir() {
        return Err("请选择项目文件夹".into());
    }
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
            return Ok(PathBuf::from(format!("\\\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix("\\\\?\\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(path)
}
fn validate_mode(mode: &str, permission: &str) -> Result<(), String> {
    if !matches!(mode, "build" | "plan") || !matches!(permission, "ask" | "auto" | "full_access") {
        Err("无效的工作模式或权限模式".into())
    } else {
        Ok(())
    }
}
fn catalog_value(value: Value) -> Result<Value, String> {
    let models = value["models"].as_array().ok_or("模型目录格式无效")?;
    if models.len() > 10000 || value["revision"].as_u64().is_none() {
        return Err("模型目录格式无效".into());
    }
    let mut seen = BTreeSet::new();
    let mut clean = Vec::new();
    for model in models {
        for key in ["id", "providerId", "modelId", "name", "channelName"] {
            if model[key]
                .as_str()
                .is_none_or(|v| v.is_empty() || v.len() > 2048 || v.contains('\0'))
            {
                return Err("模型目录字段无效".into());
            }
        }
        if !seen.insert(model["id"].as_str().unwrap()) {
            return Err("模型目录包含重复标识".into());
        }
        let mut object = serde_json::Map::new();
        for key in [
            "id",
            "providerId",
            "modelId",
            "name",
            "channelName",
            "contextLimit",
            "outputLimit",
            "reasoningEfforts",
        ] {
            if let Some(value) = model.get(key) {
                object.insert(key.into(), value.clone());
            }
        }
        clean.push(Value::Object(object));
    }
    Ok(
        json!({"revision":value["revision"],"models":clean,"defaultModel":value.get("defaultModel"),"excludedSources":value["excludedSources"].as_array().map(|v|v.iter().filter(|i|i.is_string()).cloned().collect::<Vec<_>>()).unwrap_or_default()}),
    )
}
fn selection(catalog: &Value, id: &str) -> Result<(AgentModelRef, u64), String> {
    let model = catalog["models"]
        .as_array()
        .and_then(|models| models.iter().find(|m| m["id"] == id))
        .ok_or("此模型不在当前渠道目录中")?;
    Ok((
        AgentModelRef {
            provider_id: arg(model, "providerId")?.into(),
            model_id: arg(model, "modelId")?.into(),
        },
        model["contextLimit"].as_u64().unwrap_or(8192),
    ))
}
fn field(
    key: &str,
    title: &str,
    description: Option<String>,
    multiple: bool,
    options: Vec<AgentQuestionOption>,
    custom: bool,
) -> AgentQuestionField {
    AgentQuestionField {
        key: key.into(),
        field_type: if multiple { "multiselect" } else { "string" }.into(),
        title: Some(title.into()),
        description,
        required: true,
        options,
        custom,
        default_value: None,
        hidden: false,
        when: Vec::new(),
        format: None,
        placeholder: None,
        min_length: None,
        max_length: None,
        pattern: None,
        min_items: None,
        max_items: None,
        minimum: None,
        maximum: None,
        url: None,
    }
}
fn system_prompt(project: &Path, mode: &str, skills: &Skills) -> String {
    let mut prompt=format!("You are LoliCode, an in-process coding agent. Work only inside this selected project: {}. Use the provided tools to inspect real files before changing them. Tool results and user permission decisions are authoritative. Do not claim a file was changed unless a tool succeeded. Current mode: {}. In plan mode, inspect and propose a plan; use exit_plan_mode to request approval before implementation. Ask for missing decisions with ask_user.\n",project.display(),mode);
    prompt.push_str(&format!("Enabled skills revision {} (use read_skill to read complete instructions only when relevant):\n",skills.revision));
    for skill in &skills.items {
        let line = format!(
            "{} | {} | {}\n",
            skill.id,
            skill.name,
            skill.description.chars().take(512).collect::<String>()
        );
        if prompt.len() + line.len() > 20000 {
            prompt.push_str("Further skills omitted from this bounded index.\n");
            break;
        }
        prompt.push_str(&line);
    }
    prompt
}
fn internal_schemas() -> Vec<Value> {
    vec![
        json!({"type":"function","function":{"name":"ask_user","description":"Ask the user structured questions before making a decision.","parameters":{"type":"object","properties":{"questions":{"type":"array","items":{"type":"object","properties":{"question":{"type":"string"},"multiSelect":{"type":"boolean"},"options":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string"},"description":{"type":"string"}},"required":["label"]}}},"required":["question"]}}},"required":["questions"]}}}),
        json!({"type":"function","function":{"name":"exit_plan_mode","description":"Present a complete implementation plan and request user approval to leave read-only planning mode.","parameters":{"type":"object","properties":{"plan":{"type":"string"}},"required":["plan"]}}}),
        json!({"type":"function","function":{"name":"read_skill","description":"Read the complete instructions of an enabled skill by its exact registered id.","parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}}),
    ]
}

#[cfg(test)]
#[path = "outcome_tests.rs"]
mod outcome_tests;
