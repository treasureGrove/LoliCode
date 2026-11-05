//! Local preparation and cutover receipts for existing native sessions.
//!
//! The host must quiesce legacy execution before preparing a session. The
//! caller commits only after the Harness log has been flushed and verified.
//! Neither step launches an engine or writes the legacy session file.

use lolicode_agent::{AgentSecretaryTask, AgentSnapshot, AgentStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, Metadata, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_SESSION_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES: u64 = 4096;
const RECEIPT_FORMAT: u32 = 1;

pub(super) struct HarnessMigration {
    profile_root: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSessionRecord {
    format: u32,
    snapshot: AgentSnapshot,
    #[serde(default)]
    background_only: bool,
    #[cfg(test)]
    history: Vec<Value>,
    #[serde(default)]
    queued_inputs: Vec<Value>,
    #[serde(default)]
    context_summary: Option<String>,
    #[serde(default)]
    secretary_tasks: Vec<AgentSecretaryTask>,
    #[serde(default)]
    secretary_removed_tasks: BTreeSet<String>,
    #[serde(default)]
    commands: Value,
    #[serde(default)]
    secretary_worktree: Option<lolicode_agent::AgentSecretaryWorktree>,
}

/// The source transcript and model history stay separate, as in the old file.
/// This type is host-private and deliberately has no serialization or Debug.
pub(super) struct LegacySession {
    record: NativeSessionRecord,
    source_sha256: String,
}

impl LegacySession {
    pub(super) fn snapshot(&self) -> &AgentSnapshot {
        &self.record.snapshot
    }

    pub(super) fn background_only(&self) -> bool {
        self.record.background_only
    }

    pub(super) fn settled_snapshot(&self) -> AgentSnapshot {
        let mut snapshot = self.record.snapshot.clone();
        if self.record.background_only {
            snapshot.session.permission_mode = "ask".into();
            if let Some(link) = snapshot.session.coordination.as_mut() {
                link.permission_locked = Some(true);
            }
        }
        if matches!(
            snapshot.status,
            AgentStatus::Running | AgentStatus::WaitingPermission | AgentStatus::WaitingQuestion
        ) {
            snapshot.status = AgentStatus::Error;
            snapshot.error = Some("旧 Agent 的运行已中断，请核对已有结果后继续".into());
        }
        snapshot.permissions.clear();
        snapshot.questions.clear();
        snapshot.stream_connected = false;
        snapshot.title_pending = false;
        snapshot.compacting = false;
        snapshot.model_phase = None;
        snapshot.queue_paused = !snapshot.queued_messages.is_empty();
        snapshot
    }

    pub(super) fn command(&self, id: &str) -> Option<&Value> {
        self.record.commands.get(id)
    }

    pub(super) fn worktree(&self) -> Option<&lolicode_agent::AgentSecretaryWorktree> {
        self.record.secretary_worktree.as_ref()
    }

    #[cfg(test)]
    pub(super) fn history(&self) -> &[Value] {
        &self.record.history
    }

    pub(super) fn queued_inputs(&self) -> &[Value] {
        &self.record.queued_inputs
    }

    pub(super) fn context_summary(&self) -> Option<&str> {
        self.record.context_summary.as_deref()
    }

    pub(super) fn secretary_tasks(&self) -> impl Iterator<Item = &AgentSecretaryTask> {
        self.record
            .secretary_tasks
            .iter()
            .filter(|task| !self.record.secretary_removed_tasks.contains(&task.id))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    format: u32,
    loli_session_id: String,
    harness_session_id: String,
    source_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MigrationState {
    Prepared,
    Committed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct MigrationReceipt {
    binding: Binding,
    state: MigrationState,
}

impl MigrationReceipt {
    pub(super) fn loli_session_id(&self) -> &str {
        &self.binding.loli_session_id
    }

    pub(super) fn harness_session_id(&self) -> &str {
        &self.binding.harness_session_id
    }

    pub(super) fn state(&self) -> MigrationState {
        self.state
    }
}

impl HarnessMigration {
    pub(super) fn new(profile_root: &Path) -> Result<Self, String> {
        let profile_root = profile_root
            .canonicalize()
            .map_err(|_| "无法解析 Agent 配置目录")?;
        if !profile_root.is_dir() {
            return Err("Agent 配置目录无效".into());
        }
        Ok(Self { profile_root })
    }

    pub(super) fn read_legacy(&self, loli_session_id: &str) -> Result<LegacySession, String> {
        self.find_legacy(loli_session_id)?
            .ok_or("找不到旧 Agent 会话".into())
    }

    pub(super) fn find_legacy(
        &self,
        loli_session_id: &str,
    ) -> Result<Option<LegacySession>, String> {
        let id = loli_uuid(loli_session_id)?;
        let Some(sessions) = self.legacy_directory()? else {
            return Ok(None);
        };
        let Some(bytes) = read_regular(&sessions.join(format!("{id}.json")), MAX_SESSION_BYTES)?
        else {
            return Ok(None);
        };
        let record: NativeSessionRecord =
            serde_json::from_slice(&bytes).map_err(|_| "旧 Agent 会话无法读取，原文件已保留")?;
        if record.format != 1 || record.snapshot.session.id != loli_session_id {
            return Err("旧 Agent 会话格式或标识无效，原文件已保留".into());
        }
        Ok(Some(LegacySession {
            record,
            source_sha256: format!("{:x}", Sha256::digest(&bytes)),
        }))
    }

    pub(super) fn legacy_ids(&self) -> Result<Vec<String>, String> {
        let Some(directory) = self.legacy_directory()? else {
            return Ok(Vec::new());
        };
        let mut ids = Vec::new();
        for entry in fs::read_dir(directory).map_err(|_| "无法列出旧 Agent 会话")? {
            let path = entry.map_err(|_| "无法读取旧 Agent 会话目录项")?.path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
                    let id = format!("lc:{stem}");
                    if loli_uuid(&id).is_ok() {
                        ids.push(id);
                    }
                }
            }
        }
        Ok(ids)
    }

    fn legacy_directory(&self) -> Result<Option<PathBuf>, String> {
        let Some(agent) = child_directory(&self.profile_root, "agent", false)? else {
            return Ok(None);
        };
        let Some(native) = child_directory(&agent, "native", false)? else {
            return Ok(None);
        };
        child_directory(&native, "sessions", false)
    }

    pub(super) fn legacy_bytes(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        let id = loli_uuid(id)?;
        self.legacy_directory()?.map_or(Ok(None), |directory| {
            read_regular(&directory.join(format!("{id}.json")), MAX_SESSION_BYTES)
        })
    }

    pub(super) fn publish_legacy_archive(&self, id: &str, bytes: &[u8]) -> Result<bool, String> {
        let id = loli_uuid(id)?;
        if bytes.len() as u64 > MAX_SESSION_BYTES {
            return Err("会话超过同步大小限制".into());
        }
        let agent = child_directory(&self.profile_root, "agent", true)?.ok_or("会话目录不可用")?;
        let native = child_directory(&agent, "native", true)?.ok_or("会话目录不可用")?;
        let sessions = child_directory(&native, "sessions", true)?.ok_or("会话目录不可用")?;
        let target = sessions.join(format!("{id}.json"));
        let mut temporary =
            tempfile::NamedTempFile::new_in(&sessions).map_err(|_| "无法准备会话归档")?;
        temporary
            .write_all(bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "无法写入会话归档")?;
        match temporary.persist_noclobber(target) {
            Ok(_) => {
                sync_directory(&sessions)?;
                Ok(true)
            }
            Err(error) if error.error.kind() == ErrorKind::AlreadyExists => Ok(false),
            Err(_) => Err("无法发布会话归档".into()),
        }
    }

    pub(super) fn receipt(
        &self,
        loli_session_id: &str,
    ) -> Result<Option<MigrationReceipt>, String> {
        let id = loli_uuid(loli_session_id)?;
        self.migration_directory(false)?
            .map_or(Ok(None), |directory| load_receipt(&directory, id))
    }

    pub(super) fn prepare(
        &self,
        loli_session_id: &str,
    ) -> Result<(LegacySession, MigrationReceipt), String> {
        let source = self.read_legacy(loli_session_id)?;
        let id = loli_uuid(loli_session_id)?;
        let directory = self.migration_directory(true)?.ok_or("无法创建迁移目录")?;
        let binding = Binding {
            format: RECEIPT_FORMAT,
            loli_session_id: loli_session_id.into(),
            harness_session_id: harness_uuid(ensure_profile_id(&directory)?, id).to_string(),
            source_sha256: source.source_sha256.clone(),
        };
        if load_receipt(&directory, id)?.is_none() {
            write_binding(
                &receipt_path(&directory, id, MigrationState::Prepared),
                &binding,
            )?;
        }
        let receipt = load_receipt(&directory, id)?.ok_or("无法读取已保存的迁移准备记录")?;
        if receipt.binding != binding {
            return Err("旧 Agent 会话自迁移准备后已变化，原文件与迁移记录已保留".into());
        }
        Ok((source, receipt))
    }

    pub(super) fn commit(&self, expected: &MigrationReceipt) -> Result<MigrationReceipt, String> {
        let id = loli_uuid(expected.loli_session_id())?;
        let directory = self
            .migration_directory(false)?
            .ok_or("找不到迁移准备记录")?;
        let saved = load_receipt(&directory, id)?.ok_or("找不到迁移准备记录")?;
        if expected.binding != saved.binding {
            return Err("迁移准备记录不属于此会话或配置目录".into());
        }
        if saved.state == MigrationState::Committed {
            return Ok(saved);
        }
        if expected.state != MigrationState::Prepared {
            return Err("迁移状态与保存的记录不一致".into());
        }
        if self.read_legacy(expected.loli_session_id())?.source_sha256
            != saved.binding.source_sha256
        {
            return Err("旧 Agent 会话自迁移准备后已变化，原文件与迁移记录已保留".into());
        }
        write_binding(
            &receipt_path(&directory, id, MigrationState::Committed),
            &saved.binding,
        )?;
        let committed = load_receipt(&directory, id)?.ok_or("无法读取已保存的迁移完成记录")?;
        if committed.state != MigrationState::Committed || committed.binding != expected.binding {
            return Err("迁移状态与保存的记录不一致".into());
        }
        Ok(committed)
    }

    fn migration_directory(&self, create: bool) -> Result<Option<PathBuf>, String> {
        let Some(agent) = child_directory(&self.profile_root, "agent", false)? else {
            return Ok(None);
        };
        child_directory(&agent, "harness-migration", create)
    }
}

fn loli_uuid(session_id: &str) -> Result<Uuid, String> {
    session_id
        .strip_prefix("lc:")
        .and_then(canonical_uuid)
        .ok_or_else(|| "旧 Agent 会话标识无效".into())
}

fn canonical_uuid(raw: &str) -> Option<Uuid> {
    Uuid::parse_str(raw).ok().filter(|id| id.to_string() == raw)
}

fn profile_id(directory: &Path) -> Result<Uuid, String> {
    read_regular(&directory.join("profile-id"), MAX_RECEIPT_BYTES)?
        .as_deref()
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(canonical_uuid)
        .ok_or_else(|| "迁移配置标识无效，原记录已保留".into())
}

fn ensure_profile_id(directory: &Path) -> Result<Uuid, String> {
    let marker = directory.join("profile-id");
    if read_regular(&marker, MAX_RECEIPT_BYTES)?.is_none() {
        for entry in fs::read_dir(directory).map_err(|_| "无法读取迁移目录")? {
            let entry = entry.map_err(|_| "无法读取迁移目录")?;
            if entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
            {
                // A concurrently prepared receipt requires its marker to have
                // already landed. A missing marker here needs recovery.
                return profile_id(directory);
            }
        }
        publish_once(&marker, Uuid::new_v4().to_string().as_bytes())?;
    }
    profile_id(directory)
}

fn harness_uuid(profile: Uuid, session: Uuid) -> Uuid {
    let mut hash = Sha256::new();
    hash.update(b"lolicode-dsh-session-v1\0");
    hash.update(profile.as_bytes());
    hash.update(session.as_bytes());
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&hash.finalize()[..16]);
    // RFC 9562 custom UUIDv8 with an RFC variant, using the scoped digest above.
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn receipt_path(directory: &Path, id: Uuid, state: MigrationState) -> PathBuf {
    let phase = match state {
        MigrationState::Prepared => "prepared",
        MigrationState::Committed => "committed",
    };
    directory.join(format!("{id}.{phase}.json"))
}

fn load_receipt(directory: &Path, id: Uuid) -> Result<Option<MigrationReceipt>, String> {
    let committed = read_binding(&receipt_path(directory, id, MigrationState::Committed))?;
    let prepared = read_binding(&receipt_path(directory, id, MigrationState::Prepared))?;
    let invalid = "迁移记录不一致，原记录已保留";
    let Some(binding) = prepared else {
        return if committed.is_none() {
            Ok(None)
        } else {
            Err(invalid.into())
        };
    };
    if binding.format != RECEIPT_FORMAT
        || loli_uuid(&binding.loli_session_id)? != id
        || binding.harness_session_id != harness_uuid(profile_id(directory)?, id).to_string()
        || binding.source_sha256.len() != 64
        || !binding
            .source_sha256
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        || committed.as_ref().is_some_and(|record| record != &binding)
    {
        return Err(invalid.into());
    }
    let state = if committed.is_some() {
        MigrationState::Committed
    } else {
        MigrationState::Prepared
    };
    Ok(Some(MigrationReceipt { binding, state }))
}

fn read_binding(path: &Path) -> Result<Option<Binding>, String> {
    read_regular(path, MAX_RECEIPT_BYTES)?
        .map(|bytes| {
            serde_json::from_slice(&bytes).map_err(|_| "迁移记录无法读取，原记录已保留".into())
        })
        .transpose()
}

fn write_binding(path: &Path, binding: &Binding) -> Result<(), String> {
    let bytes = serde_json::to_vec(binding).map_err(|_| "无法编码迁移记录")?;
    publish_once(path, &bytes)
}

fn publish_once(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("迁移目录无效")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".migration-")
        .tempfile_in(directory)
        .map_err(|_| "无法创建迁移记录")?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "无法同步迁移记录")?;
    // The existing file wins a race. Callers re-read and validate the winner.
    match temporary.persist_noclobber(path) {
        Ok(_) => sync_directory(directory),
        Err(error) if error.error.kind() == ErrorKind::AlreadyExists => sync_directory(directory),
        Err(_) => Err("无法保存迁移记录".into()),
    }
}

fn sync_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(directory)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| "无法同步迁移目录")?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

fn child_directory(parent: &Path, name: &str, create: bool) -> Result<Option<PathBuf>, String> {
    let path = parent.join(name);
    if create {
        match fs::create_dir(&path) {
            Ok(()) => sync_directory(parent)?,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(_) => return Err("无法创建迁移目录".into()),
        }
    }
    let Some(metadata) = path_metadata(&path)? else {
        return Ok(None);
    };
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("Agent 数据目录必须是普通目录".into());
    }
    let canonical = path.canonicalize().map_err(|_| "无法验证 Agent 数据目录")?;
    if canonical.parent() != Some(parent) {
        return Err("Agent 数据目录超出配置目录".into());
    }
    Ok(Some(canonical))
}

fn path_metadata(path: &Path) -> Result<Option<Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法读取 Agent 数据路径".into()),
    }
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn read_regular(path: &Path, maximum: u64) -> Result<Option<Vec<u8>>, String> {
    let Some(metadata) = path_metadata(path)? else {
        return Ok(None);
    };
    if !metadata.is_file() || is_link(&metadata) {
        return Err("Agent 数据记录必须是普通文件".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|_| "无法打开 Agent 数据记录")?;
    let metadata = file.metadata().map_err(|_| "无法验证 Agent 数据记录")?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err("Agent 数据记录必须是普通文件".into());
    }
    if metadata.len() > maximum {
        return Err("Agent 数据记录超出读取上限".into());
    }
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取 Agent 数据记录")?;
    if bytes.len() as u64 > maximum {
        return Err("Agent 数据记录超出读取上限".into());
    }
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests;
