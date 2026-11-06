//! LoliCode session identities and view settings. Harness owns all turns and
//! logs; format-1 Rust transcripts are read only for display and migration.
use super::{
    agent_preferences::path_key, channel_center::AgentCatalog, harness_migration::HarnessMigration,
};
use lolicode_agent::{
    AgentModelRef, AgentSecretaryState, AgentSecretaryTask, AgentSession, AgentSessionActivity,
    AgentSessionCoordination, AgentSnapshot, AgentStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(super) struct SessionStore {
    directory: PathBuf,
    migration: HarnessMigration,
    sessions: BTreeMap<String, Metadata>,
    // Format-1 records are read-only; a profile sync rebuilds this index.
    legacy_secretaries: BTreeMap<String, Vec<AgentSecretaryTask>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    session: AgentSession,
    #[serde(default, skip_serializing_if = "TitlePolicy::is_fixed")]
    title_policy: TitlePolicy,
    #[serde(default)]
    deleted: bool,
    // Older desktop builds stored full_access even when they actually ran
    // with a confined preset. Only records written under the current policy
    // can restore full access.
    #[serde(default)]
    full_access_selected: bool,
    #[serde(default)]
    background_only: bool,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum TitlePolicy {
    #[default]
    Fixed,
    Eligible,
    Fallback,
}

impl TitlePolicy {
    fn is_fixed(&self) -> bool {
        *self == Self::Fixed
    }
}

pub(super) fn normalized_permission(mode: &str, full_access_selected: bool) -> &'static str {
    match mode {
        "auto" => "auto",
        "full_access" if full_access_selected => "full_access",
        _ => "ask",
    }
}

pub(super) fn valid_permission(mode: &str) -> bool {
    matches!(mode, "ask" | "auto" | "full_access")
}

pub(super) fn stored_permission(profile: &Path, id: &str) -> Result<Option<&'static str>, String> {
    let path = profile
        .join("agent/harness-sessions")
        .join(format!("{}.json", uuid(id)?));
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= 64 * 1024 => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        _ => return Err("Harness 会话信息文件无效".into()),
    };
    let bytes = fs::read(path).map_err(|_| "无法读取 Harness 会话信息")?;
    if bytes.len() as u64 != metadata.len() {
        return Err("Harness 会话信息已变更，请重试".into());
    }
    let entry: Metadata = serde_json::from_slice(&bytes).map_err(|_| "Harness 会话信息无法解析")?;
    if entry.session.id != id || entry.deleted {
        return Err("Harness 会话标识与文件不符".into());
    }
    Ok(Some(if entry.background_only {
        "ask"
    } else {
        normalized_permission(&entry.session.permission_mode, entry.full_access_selected)
    }))
}

fn uuid(id: &str) -> Result<Uuid, String> {
    id.strip_prefix("lc:")
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .filter(|uuid| format!("lc:{uuid}") == id)
        .ok_or("本地会话标识无效".into())
}

fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

fn project_matches(session: &AgentSession, project: &str) -> bool {
    path_key(&session.project_path) == path_key(project)
}

pub(super) fn argument<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && !s.contains('\0'))
        .ok_or_else(|| format!("缺少有效的 {key}"))
}

pub(super) fn encode(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "Agent 会话数据编码失败".into())
}

impl SessionStore {
    pub(super) fn load(profile: &Path) -> Result<Self, String> {
        let migration = HarnessMigration::new(profile)?;
        let directory = profile.join("agent/harness-sessions");
        let mut sessions = BTreeMap::new();
        let mut legacy_secretaries = BTreeMap::new();
        for id in migration.legacy_ids()? {
            match migration.read_legacy(&id) {
                Ok(legacy) => {
                    if role(&legacy.snapshot().session, "secretary") {
                        let tasks = legacy
                            .secretary_tasks()
                            .filter(|task| task.parent_session_id == id)
                            .cloned()
                            .map(settle_legacy_task)
                            .collect();
                        legacy_secretaries.insert(id.clone(), tasks);
                    }
                    let mut session = legacy.snapshot().session.clone();
                    session.permission_mode =
                        normalized_permission(&session.permission_mode, false).into();
                    if legacy.background_only() {
                        session.permission_mode = "ask".into();
                        if let Some(link) = session.coordination.as_mut() {
                            link.permission_locked = Some(true);
                        }
                    }
                    sessions.insert(
                        id,
                        Metadata {
                            session,
                            title_policy: TitlePolicy::Fixed,
                            deleted: false,
                            full_access_selected: false,
                            background_only: legacy.background_only(),
                        },
                    );
                }
                Err(error) => log::warn!("跳过无法读取的旧 Agent 会话 {id}：{error}"),
            }
        }
        match fs::symlink_metadata(&directory) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err("Harness 会话目录不是普通目录".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Self {
                    directory,
                    migration,
                    sessions,
                    legacy_secretaries,
                })
            }
            Err(_) => return Err("无法访问 Harness 会话目录".into()),
        }
        for entry in fs::read_dir(&directory).map_err(|_| "无法列出 Harness 会话")? {
            let entry = entry.map_err(|_| "无法读取 Harness 会话目录项")?;
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
                continue;
            };
            let id = format!("lc:{stem}");
            if path.extension().and_then(|name| name.to_str()) != Some("json") || uuid(&id).is_err()
            {
                continue;
            }
            let meta = fs::symlink_metadata(&path).map_err(|_| "无法读取 Harness 会话信息")?;
            if !meta.is_file() || meta.len() > 64 * 1024 {
                return Err("Harness 会话信息文件无效".into());
            }
            let bytes = fs::read(path).map_err(|_| "无法读取 Harness 会话信息")?;
            let mut metadata: Metadata =
                serde_json::from_slice(&bytes).map_err(|_| "Harness 会话信息无法解析")?;
            if metadata.session.id != id {
                return Err("Harness 会话标识与文件不符".into());
            }
            metadata.background_only |=
                sessions.get(&id).is_some_and(|entry| entry.background_only);
            metadata.session.permission_mode = normalized_permission(
                &metadata.session.permission_mode,
                metadata.full_access_selected,
            )
            .into();
            if metadata.background_only {
                metadata.session.permission_mode = "ask".into();
            }
            sessions.insert(id, metadata);
        }
        Ok(Self {
            directory,
            migration,
            sessions,
            legacy_secretaries,
        })
    }

    fn persist(&mut self, entry: Metadata) -> Result<(), String> {
        let id = &entry.session.id;
        let path = self.directory.join(format!("{}.json", uuid(id)?));
        crate::config::write_json_file_private(&path, &entry)
            .map_err(|_| "无法保存 Harness 会话信息")?;
        self.sessions.insert(id.clone(), entry);
        Ok(())
    }

    pub(super) fn get(&self, id: &str) -> Result<&AgentSession, String> {
        self.sessions
            .get(id)
            .filter(|entry| !entry.deleted)
            .map(|entry| &entry.session)
            .ok_or("找不到此会话".into())
    }

    pub(super) fn contains(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    pub(super) fn automatic_title_allowed(&self, id: &str) -> bool {
        self.sessions
            .get(id)
            .is_some_and(|entry| !entry.deleted && entry.title_policy == TitlePolicy::Eligible)
    }

    pub(super) fn accept_automatic_title(
        &mut self,
        id: &str,
        title: &str,
        generated: bool,
    ) -> Result<Option<AgentSession>, String> {
        let title = title.trim();
        if title.is_empty() || title.len() > 80 || title.chars().any(char::is_control) {
            return Ok(None);
        }
        let Some(mut entry) = self.sessions.get(id).cloned() else {
            return Ok(None);
        };
        if entry.deleted
            || entry.title_policy.is_fixed()
            || (entry.title_policy == TitlePolicy::Fallback && !generated)
        {
            return Ok(None);
        }
        entry.title_policy = if generated {
            TitlePolicy::Fixed
        } else {
            TitlePolicy::Fallback
        };
        entry.session.title = title.into();
        entry.session.updated_at = now().max(entry.session.updated_at.saturating_add(1));
        let session = entry.session.clone();
        self.persist(entry)?;
        Ok(Some(session))
    }

    pub(super) fn requires_background_review(&self, id: &str) -> Result<bool, String> {
        self.get(id)?;
        Ok(self
            .sessions
            .get(id)
            .is_some_and(|entry| entry.background_only))
    }

    pub(super) fn list(&self, project: Option<&str>, archived: bool) -> Vec<AgentSession> {
        let mut sessions: Vec<_> = self
            .sessions
            .values()
            .filter(|entry| !entry.deleted && (archived || !entry.session.archived))
            .map(|entry| &entry.session)
            .filter(|session| project.is_none_or(|path| project_matches(session, path)))
            .cloned()
            .collect();
        sessions.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then(b.updated_at.cmp(&a.updated_at))
        });
        sessions
    }

    pub(super) fn snapshot(&self, id: &str) -> Result<AgentSnapshot, String> {
        let session = self.get(id)?.clone();
        if let Some(legacy) = self.migration.find_legacy(id)? {
            let mut snapshot = legacy.settled_snapshot();
            snapshot.session = session;
            return Ok(snapshot);
        }
        Ok(AgentSnapshot {
            session,
            status: AgentStatus::Idle,
            messages: Vec::new(),
            permissions: Vec::new(),
            questions: Vec::new(),
            diffs: Vec::new(),
            error: None,
            stream_connected: false,
            stream_gap: false,
            title_pending: false,
            compacting: false,
            usage: None,
            model_phase: None,
            preview: None,
            queued_messages: Vec::new(),
            queue_paused: false,
            background_jobs: 0,
            goal: None,
            plan: None,
        })
    }

    pub(super) fn create(
        &mut self,
        project: &str,
        catalog: &AgentCatalog,
        args: &Value,
        secretary: bool,
        remote: bool,
    ) -> Result<AgentSession, String> {
        if secretary {
            if let Some(session) = self
                .list(Some(project), true)
                .into_iter()
                .find(|session| role(session, "secretary"))
            {
                return Ok(session);
            }
        }
        let time = now();
        let background_only = args["backgroundOnly"] == true;
        let custom_title = args["title"]
            .as_str()
            .filter(|title| !title.trim().is_empty());
        let default_permission = if background_only || remote || args["mode"] == "plan" {
            "ask"
        } else {
            "full_access"
        };
        let mut session = AgentSession {
            id: format!("lc:{}", Uuid::new_v4()),
            title: if secretary {
                "总秘书".into()
            } else {
                custom_title.unwrap_or("新会话").chars().take(160).collect()
            },
            project_path: project.into(),
            mode: "build".into(),
            permission_mode: default_permission.into(),
            pinned: false,
            archived: false,
            model: None,
            created_at: time,
            updated_at: time,
            activity: None,
            reasoning_effort: None,
            context_limit: None,
            coordination: secretary.then(|| AgentSessionCoordination {
                role: "secretary".into(),
                parent_session_id: None,
                task_id: None,
                permission_locked: None,
            }),
        };
        let mut settings = args.clone();
        if !settings["modelId"].is_string() {
            settings["modelId"] =
                json!(catalog.default_model.as_ref().ok_or("请选择一个可用模型")?);
        }
        update_settings(&mut session, catalog, &settings)?;
        if background_only && session.permission_mode != "ask" {
            return Err("后台会话必须逐次审批".into());
        }
        self.persist(Metadata {
            title_policy: if secretary || background_only || custom_title.is_some() {
                TitlePolicy::Fixed
            } else {
                TitlePolicy::Eligible
            },
            full_access_selected: session.permission_mode == "full_access",
            background_only,
            session: session.clone(),
            deleted: false,
        })?;
        Ok(session)
    }

    pub(super) fn update(
        &mut self,
        method: &str,
        args: &Value,
        catalog: &AgentCatalog,
    ) -> Result<AgentSession, String> {
        let id = argument(args, "sessionId")?;
        let mut session = self.get(id)?.clone();
        let mut title_policy = self.sessions[id].title_policy;
        let background_only = self.requires_background_review(id)?;
        match method {
            "renameSession" => {
                let title = argument(args, "title")?.trim();
                if title.chars().count() > 160 {
                    return Err("会话名称需为 1 到 160 个字符".into());
                }
                session.title = title.into();
                title_policy = TitlePolicy::Fixed;
            }
            "setSessionMetadata" => {
                if let Some(value) = args["pinned"].as_bool() {
                    session.pinned = value;
                }
                if let Some(value) = args["archived"].as_bool() {
                    session.archived = value;
                }
            }
            "updateSession" => {
                if let Some(link) = &session.coordination {
                    if link.role == "worker" {
                        if link.permission_locked == Some(true) {
                            return Err("自动子任务的审批模式由所属秘书任务约束".into());
                        }
                        let mode = validate_worker_permission(args)?;
                        if mode == "full_access" && self.legacy_worktree(id)?.is_some() {
                            return Err(
                                "独立工作树支持逐次确认和 Auto Mode，请在主会话使用完整权限".into(),
                            );
                        }
                    }
                }
                update_settings(&mut session, catalog, args)?;
                if background_only && session.permission_mode != "ask" {
                    return Err("后台会话必须逐次审批".into());
                }
            }
            _ => return Err("未知会话设置操作".into()),
        }
        session.updated_at = now().max(session.updated_at.saturating_add(1));
        self.persist(Metadata {
            title_policy,
            full_access_selected: session.permission_mode == "full_access",
            background_only,
            session: session.clone(),
            deleted: false,
        })?;
        Ok(session)
    }

    pub(super) fn delete(&mut self, id: &str) -> Result<(), String> {
        let session = self.get(id)?.clone();
        if session.coordination.is_some() {
            return Err("秘书及工作会话请使用归档".into());
        }
        self.persist(Metadata {
            title_policy: TitlePolicy::Fixed,
            full_access_selected: false,
            background_only: false,
            session,
            deleted: true,
        })
    }

    pub(super) fn secretary(&self, id: &str) -> Result<AgentSecretaryState, String> {
        if !role(self.get(id)?, "secretary") {
            return Err("此会话不是总秘书".into());
        }
        Ok(AgentSecretaryState {
            session_id: id.into(),
            tasks: self.legacy_secretaries.get(id).cloned().unwrap_or_default(),
        })
    }

    pub(super) fn query_command(&self, id: &str, request: &str) -> Result<Value, String> {
        self.get(id)?;
        let legacy = self.migration.find_legacy(id)?;
        let status = legacy
            .as_ref()
            .and_then(|legacy| legacy.command(request))
            .and_then(|command| command["status"].as_str());
        Ok(
            json!({"results":[{"key":{"sessionId":id,"commandId":request},"result":status.map(|status| json!({"commandId":request,"status":status}))}]}),
        )
    }

    pub(super) fn legacy_worktree(
        &self,
        id: &str,
    ) -> Result<Option<lolicode_agent::AgentSecretaryWorktree>, String> {
        self.get(id)?;
        Ok(self
            .migration
            .find_legacy(id)?
            .and_then(|legacy| legacy.worktree().cloned()))
    }
}

fn settle_legacy_task(mut task: AgentSecretaryTask) -> AgentSecretaryTask {
    if !matches!(
        task.status.as_str(),
        "completed" | "cancelled" | "failed" | "interrupted" | "error"
    ) {
        task.status = "interrupted".into();
        task.error = Some("旧任务执行已中断，历史与项目文件保留".into());
    }
    task
}

pub(super) fn role(session: &AgentSession, role: &str) -> bool {
    session
        .coordination
        .as_ref()
        .is_some_and(|relation| relation.role == role)
}

pub(super) fn activity(session: &mut AgentSession, status: AgentStatus, title_pending: bool) {
    session.activity = Some(AgentSessionActivity {
        status,
        title_pending,
    });
}

pub(super) fn validate_worker_permission(args: &Value) -> Result<&str, String> {
    let mode = args["permissionMode"]
        .as_str()
        .filter(|mode| valid_permission(mode))
        .ok_or("子任务仅可更改审批模式")?;
    if [
        "modelId",
        "mode",
        "reasoningEffort",
        "contextLimit",
        "resetContextLimit",
    ]
    .iter()
    .any(|key| !args[*key].is_null())
    {
        return Err("子任务仅可更改审批模式".into());
    }
    Ok(mode)
}

fn update_settings(
    session: &mut AgentSession,
    catalog: &AgentCatalog,
    args: &Value,
) -> Result<(), String> {
    if let Some(mode) = args["mode"].as_str() {
        if !matches!(mode, "build" | "plan") {
            return Err("无效的会话模式".into());
        }
        session.mode = mode.into();
    }
    if let Some(mode) = args["permissionMode"].as_str() {
        if !valid_permission(mode) {
            return Err("无效的审批模式".into());
        }
        session.permission_mode = mode.into();
    }
    if let Some(id) = args["modelId"].as_str() {
        let selected = catalog
            .models
            .iter()
            .find(|model| model.id == id)
            .ok_or("选中的渠道模型已不可用")?;
        let model = AgentModelRef {
            provider_id: selected.provider_id.clone(),
            model_id: selected.model_id.clone(),
        };
        if session.model.as_ref() != Some(&model) {
            session.model = Some(model);
            session.context_limit = None;
            session.reasoning_effort = None;
        }
    }
    if args["resetContextLimit"] == true {
        session.context_limit = None;
    }
    if let Some(limit) = args["contextLimit"].as_u64() {
        if !(1024..=16_000_000).contains(&limit) {
            return Err("模型上下文窗口超出范围".into());
        }
        session.context_limit = Some(limit);
    }
    if let Some(effort) = args["reasoningEffort"].as_str() {
        session.reasoning_effort =
            (effort != "default" && !effort.is_empty()).then(|| effort.to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_titles_are_monotonic_and_manual_names_win_after_reload() {
        let profile = tempfile::tempdir().unwrap();
        let id = "lc:49295d67-2041-4a47-a38b-8dfeaf7ab788";
        let path = profile
            .path()
            .join("agent/harness-sessions/49295d67-2041-4a47-a38b-8dfeaf7ab788.json");
        let entry = json!({"titlePolicy":"eligible","session":{
            "id":id,"title":"新会话","projectPath":profile.path(),"mode":"build",
            "permissionMode":"ask","model":null,"createdAt":1,"updatedAt":1,
        }});
        crate::config::write_json_file_private(&path, &entry).unwrap();
        let mut store = SessionStore::load(profile.path()).unwrap();
        assert!(store.automatic_title_allowed(id));
        let fallback = store
            .accept_automatic_title(id, "首条消息", false)
            .unwrap()
            .unwrap();
        assert!(!store.automatic_title_allowed(id));
        let generated = store
            .accept_automatic_title(id, "改进会话切换", true)
            .unwrap()
            .unwrap();
        assert!(generated.updated_at > fallback.updated_at);
        let mut restored = SessionStore::load(profile.path()).unwrap();
        assert_eq!(restored.get(id).unwrap().title, "改进会话切换");
        assert!(restored
            .accept_automatic_title(id, "较迟的回退标题", false)
            .unwrap()
            .is_none());

        crate::config::write_json_file_private(&path, &entry).unwrap();
        let mut store = SessionStore::load(profile.path()).unwrap();
        let fallback = store
            .accept_automatic_title(id, "首条消息", false)
            .unwrap()
            .unwrap();
        let catalog = AgentCatalog {
            revision: 0,
            models: Vec::new(),
            default_model: None,
            excluded_sources: Vec::new(),
        };
        let renamed = store
            .update(
                "renameSession",
                &json!({"sessionId":id,"title":"新会话"}),
                &catalog,
            )
            .unwrap();
        assert!(renamed.updated_at > fallback.updated_at);
        let mut restored = SessionStore::load(profile.path()).unwrap();
        assert!(restored
            .accept_automatic_title(id, "较迟的自动标题", true)
            .unwrap()
            .is_none());
        assert_eq!(restored.get(id).unwrap().title, "新会话");
    }

    #[test]
    fn preexisting_full_access_requires_a_new_selection_and_explicit_modes_survive_reload() {
        let profile = tempfile::tempdir().unwrap();
        let id = "lc:49295d67-2041-4a47-a38b-8dfeaf7ab788";
        let path = profile
            .path()
            .join("agent/harness-sessions/49295d67-2041-4a47-a38b-8dfeaf7ab788.json");
        let previous = json!({"session":{
            "id":id,"title":"Existing session","projectPath":profile.path(),"mode":"build",
            "permissionMode":"full_access","model":null,"createdAt":1,"updatedAt":1,
        }});
        crate::config::write_json_file_private(&path, &previous).unwrap();
        let mut store = SessionStore::load(profile.path()).unwrap();
        assert_eq!(store.get(id).unwrap().permission_mode, "ask");
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
            previous
        );
        let catalog = AgentCatalog {
            revision: 0,
            models: Vec::new(),
            default_model: None,
            excluded_sources: Vec::new(),
        };
        store
            .update(
                "updateSession",
                &json!({"sessionId":id,"permissionMode":"full_access"}),
                &catalog,
            )
            .unwrap();
        store
            .update(
                "renameSession",
                &json!({"sessionId":id,"title":"Renamed"}),
                &catalog,
            )
            .unwrap();
        let mut restored = SessionStore::load(profile.path()).unwrap();
        assert_eq!(restored.get(id).unwrap().permission_mode, "full_access");
        restored
            .update(
                "updateSession",
                &json!({"sessionId":id,"permissionMode":"auto"}),
                &catalog,
            )
            .unwrap();
        assert_eq!(
            SessionStore::load(profile.path())
                .unwrap()
                .get(id)
                .unwrap()
                .permission_mode,
            "auto"
        );
    }
}
