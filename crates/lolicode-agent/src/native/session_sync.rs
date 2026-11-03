//! Explicit local profile exchange. Existing files are never replaced, and the
//! other profile is only decoded: opening its engine would recover live tasks.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Component,
};

const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SESSIONS: usize = 10_000;

#[derive(Clone)]
struct Record {
    raw: Value,
    stored: StoredSession,
    busy: bool,
}

#[derive(Default)]
struct Catalog {
    records: BTreeMap<String, Record>,
    occupied: BTreeSet<String>,
    byte_size: u64,
    files: usize,
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    imported: usize,
    exported: usize,
    duplicates: usize,
    conflicts: usize,
    skipped_busy: usize,
    skipped_unsupported: usize,
    local_sessions: Vec<AgentSession>,
    peer_sessions: Vec<AgentSession>,
    warnings: Vec<String>,
}

impl Report {
    fn unsupported(&mut self, warning: &str) {
        self.skipped_unsupported += 1;
        if self.warnings.len() < 20 && !self.warnings.iter().any(|item| item == warning) {
            self.warnings.push(warning.into());
        }
    }
}

fn reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

// Check ancestors as well as the leaf: profile and sessions directories must
// not redirect writes through a junction or symbolic link.
fn check_directory(path: &Path, allow_missing: bool) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("会话同步目录必须是独立的绝对路径".into());
    }
    let mut cursor = PathBuf::new();
    for part in path.components() {
        cursor.push(part.as_os_str());
        // A Windows drive/UNC prefix alone is not a rooted path yet (notably
        // canonical verbatim paths such as \\?\D:). Check it after RootDir.
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&cursor) {
            Ok(meta) if meta.is_dir() && !reparse(&meta) => {}
            Ok(_) => return Err("会话同步目录包含链接或异常目录，原文件已保留".into()),
            Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法访问会话同步目录，原文件已保留".into()),
        }
    }
    Ok(())
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    let text = text
        .strip_prefix(r"\\?\")
        .unwrap_or(&text)
        .replace('\\', "/");
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn inside(path: &Path, root: &Path) -> bool {
    let root = path_key(root);
    let candidate = path_key(path);
    candidate == root || candidate.starts_with(&(root + "/"))
}

fn remote_project(stored: &StoredSession, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| {
        root.parent().is_some_and(|agent| {
            inside(
                Path::new(&stored.snapshot.session.project_path),
                &agent.join("remote-workspaces"),
            )
        })
    })
}

fn busy(stored: &StoredSession) -> bool {
    let snapshot = &stored.snapshot;
    !matches!(snapshot.status, AgentStatus::Idle | AgentStatus::Error)
        || snapshot.title_pending
        || snapshot.compacting
        || snapshot.model_phase.is_some()
        || !snapshot.permissions.is_empty()
        || !snapshot.questions.is_empty()
        || (!stored.queued_inputs.is_empty() && !snapshot.queue_paused)
}

fn decode(raw: Value, filename: &Path, root: &Path) -> Result<Record, String> {
    let stored: StoredSession = serde_json::from_value(raw.clone())
        .map_err(|_| "部分会话格式不受支持或记录损坏，已保留原文件并跳过")?;
    let project = Path::new(&stored.snapshot.session.project_path);
    if stored.format != 1
        || persistence::session_path(root, &stored.snapshot.session.id)? != filename
        || !project.is_absolute()
        || project
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("部分会话标识或路径无效，已保留原文件并跳过".into());
    }
    Ok(Record {
        busy: busy(&stored),
        raw,
        stored,
    })
}

fn read_record(path: &Path, root: &Path) -> Result<Record, String> {
    let before = fs::symlink_metadata(path).map_err(|_| "部分会话无法读取，已保留原文件并跳过")?;
    if !before.is_file() || reparse(&before) || before.len() > MAX_FILE_BYTES {
        return Err("部分会话不是普通文件或超过 64 MiB，已保留原文件并跳过".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "部分会话无法打开，已保留原文件并跳过")?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "部分会话读取未完成，已保留原文件并跳过")?;
    let after = fs::symlink_metadata(path).map_err(|_| "部分会话正在变化，已跳过")?;
    if !after.is_file()
        || reparse(&after)
        || bytes.len() as u64 > MAX_FILE_BYTES
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("部分会话正在变化，已保留原文件并跳过".into());
    }
    let raw =
        serde_json::from_slice(&bytes).map_err(|_| "部分会话 JSON 损坏，已保留原文件并跳过")?;
    decode(raw, path, root)
}

fn scan(root: &Path, report: &mut Report) -> Result<Catalog, String> {
    check_directory(root, true)?;
    let directory = root.join("sessions");
    check_directory(&directory, true)?;
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Catalog::default()),
        Err(_) => return Err("无法读取会话同步目录，原文件已保留".into()),
    };
    let mut result = Catalog::default();
    for entry in entries {
        let entry = entry.map_err(|_| "会话目录读取未完成，尚未同步任何文件")?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        result.files += 1;
        if result.files > MAX_SESSIONS {
            return Err("会话数量超过 10,000 条，本次同步未写入任何文件".into());
        }
        // Corrupt and unsupported JSON files still consume the destination's
        // capacity. Each profile has its own limit, so repeating a completed
        // bidirectional exchange never fails merely because both now have it.
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| "无法核对会话目录容量，本次未写入任何文件")?;
        result.byte_size = result.byte_size.saturating_add(metadata.len());
        if result.byte_size > MAX_TOTAL_BYTES {
            return Err("单个版本的会话总量超过 256 MiB，本次同步未写入任何文件".into());
        }
        if let Some(raw) = path.file_stem().and_then(|value| value.to_str()) {
            if Uuid::parse_str(raw).is_ok_and(|id| id.to_string() == raw) {
                result.occupied.insert(format!("lc:{raw}"));
            }
        }
        match read_record(&path, root) {
            Ok(record) => {
                result
                    .records
                    .insert(record.stored.snapshot.session.id.clone(), record);
            }
            Err(error) => report.unsupported(&error),
        }
    }
    Ok(result)
}

// Materialize serde defaults for comparisons, while retaining fields understood
// by a newer version at every nesting level. Actual publication uses raw JSON.
fn keep_unknown(known: &mut Value, raw: &Value) {
    match (known, raw) {
        (Value::Object(known), Value::Object(raw)) => {
            for (key, value) in raw {
                match known.get_mut(key) {
                    Some(known) => keep_unknown(known, value),
                    None => {
                        known.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (Value::Array(known), Value::Array(raw)) => {
            for (known, raw) in known.iter_mut().zip(raw) {
                keep_unknown(known, raw);
            }
        }
        _ => {}
    }
}

fn content_hash(record: &Record) -> Result<String, String> {
    let mut normalized = serde_json::to_value(&record.stored).map_err(|_| "无法比较会话内容")?;
    keep_unknown(&mut normalized, &record.raw);
    if let Some(snapshot) = normalized["snapshot"].as_object_mut() {
        for key in ["streamConnected", "streamGap", "queuePaused"] {
            snapshot.remove(key);
        }
        if let Some(session) = snapshot.get_mut("session").and_then(Value::as_object_mut) {
            for key in ["id", "activity"] {
                session.remove(key);
            }
        }
        if let Some(task) = snapshot
            .get_mut("usage")
            .and_then(|usage| usage.get_mut("task"))
            .and_then(Value::as_object_mut)
        {
            for key in ["elapsedMs", "generationMs"] {
                task.remove(key);
            }
        }
    }
    // The desktop enables serde_json/preserve_order through feature unification.
    // Explicit sorting also covers arbitrary history and newer unknown fields.
    sort_keys(&mut normalized);
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&normalized).map_err(|_| "无法比较会话内容")?)
    ))
}

fn known_content_hash(stored: &StoredSession) -> Result<String, String> {
    content_hash(&Record {
        raw: Value::Null,
        stored: stored.clone(),
        busy: false,
    })
}

fn sort_keys(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let mut entries = std::mem::take(object).into_iter().collect::<Vec<_>>();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            for (key, mut value) in entries {
                sort_keys(&mut value);
                object.insert(key, value);
            }
        }
        Value::Array(items) => {
            for item in items {
                sort_keys(item);
            }
        }
        _ => {}
    }
}

fn conflict_id(hash: &str) -> String {
    let digest = Sha256::digest(format!("lolicode-session-sync-v1:{hash}"));
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!("lc:{}", Uuid::from_bytes(bytes))
}

fn prepare(mut record: Record, id: &str) -> Result<Record, String> {
    record.raw["snapshot"]["session"]["id"] = json!(id);
    if let Some(session) = record.raw["snapshot"]["session"].as_object_mut() {
        session.remove("activity");
    }
    record.raw["snapshot"]["streamConnected"] = json!(false);
    record.raw["snapshot"]["streamGap"] = json!(false);
    if !record.stored.queued_inputs.is_empty() {
        record.raw["snapshot"]["queuePaused"] = json!(true);
    }
    record.stored = serde_json::from_value(record.raw.clone()).map_err(|_| "无法准备会话副本")?;
    record.busy = false;
    Ok(record)
}

fn publish(root: &Path, record: &Record, existing_bytes: u64) -> Result<(bool, u64), String> {
    check_directory(root, true)?;
    let destination = persistence::session_path(root, &record.stored.snapshot.session.id)?;
    let directory = destination.parent().ok_or("会话目标路径无效")?;
    check_directory(directory, true)?;
    fs::create_dir_all(directory).map_err(|_| "无法创建会话同步目录，已有记录保留")?;
    check_directory(directory, false)?;
    let bytes = serde_json::to_vec(&record.raw).map_err(|_| "无法编码会话同步记录")?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("同步后的会话超过 64 MiB，原记录已保留".into());
    }
    if !fits_capacity(existing_bytes, bytes.len() as u64, MAX_TOTAL_BYTES) {
        return Err("目标会话总量将超过 256 MiB，该会话保留在原处并跳过".into());
    }
    let temporary = directory.join(format!(".{}.session-sync", Uuid::new_v4()));
    let outcome = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "无法创建会话同步副本")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "会话同步副本写入未完成")?;
        drop(file);
        check_directory(directory, false)?;
        match fs::hard_link(&temporary, &destination) {
            Ok(()) => Ok((true, bytes.len() as u64)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok((false, 0)),
            Err(_) => Err("会话副本无法原子发布，目标已有记录保留".into()),
        }
    })();
    let _ = fs::remove_file(&temporary);
    outcome
}

fn fits_capacity(existing: u64, incoming: u64, maximum: u64) -> bool {
    existing
        .checked_add(incoming)
        .is_some_and(|total| total <= maximum)
}

fn coordinated(record: &Record) -> bool {
    record.stored.snapshot.session.coordination.is_some()
        || !record.stored.secretary_tasks.is_empty()
        || !record.stored.secretary_reports.is_empty()
}

fn exchange(
    source: Vec<Record>,
    target: &mut Catalog,
    root: &Path,
    roots: &[PathBuf],
    importing: bool,
    report: &mut Report,
) {
    let mut hashes = target
        .records
        .values()
        .filter(|record| !coordinated(record))
        .filter_map(|record| {
            content_hash(record)
                .ok()
                .map(|hash| (hash, record.stored.snapshot.session.clone()))
        })
        .collect::<BTreeMap<_, _>>();
    for record in source {
        // This exchange copies individual sessions and may assign conflict IDs.
        // It cannot preserve a secretary's worker links or pending report outbox.
        if coordinated(&record) {
            report.unsupported(
                "秘书及其任务会话需保留完整的父子关系，本次不跨版本同步，原会话和任务保持原位",
            );
            continue;
        }
        if record.busy {
            report.skipped_busy += 1;
            continue;
        }
        if remote_project(&record.stored, roots) {
            report.unsupported("远程项目会话需要原有 SSH / WSL 连接，本次保持原位并跳过");
            continue;
        }
        let hash = match content_hash(&record) {
            Ok(hash) => hash,
            Err(error) => {
                report.unsupported(&error);
                continue;
            }
        };
        if let Some(session) = hashes.get(&hash) {
            report.duplicates += 1;
            remember(session, importing, report);
            continue;
        }
        let source_id = &record.stored.snapshot.session.id;
        if target
            .records
            .get(source_id)
            .is_some_and(|record| record.busy)
        {
            report.skipped_busy += 1;
            continue;
        }
        let conflict = target.occupied.contains(source_id);
        let id = if conflict {
            conflict_id(&hash)
        } else {
            source_id.clone()
        };
        if target.occupied.contains(&id) {
            report.unsupported("会话副本标识已被占用，已保留两边原文件并跳过");
            continue;
        }
        if target.files >= MAX_SESSIONS {
            report.unsupported("目标会话数量已达 10,000 条，剩余记录保留在原处并跳过");
            continue;
        }
        let prepared = match prepare(record, &id) {
            Ok(record) => record,
            Err(error) => {
                report.unsupported(&error);
                continue;
            }
        };
        match publish(root, &prepared, target.byte_size) {
            Ok((true, bytes)) => {
                target.byte_size += bytes;
                target.files += 1;
                if importing {
                    report.imported += 1;
                } else {
                    report.exported += 1;
                }
                if conflict {
                    report.conflicts += 1;
                }
                let session = prepared.stored.snapshot.session.clone();
                hashes.insert(hash, session.clone());
                remember(&session, importing, report);
                target.occupied.insert(id.clone());
                target.records.insert(id, prepared);
            }
            Ok((false, _)) => {
                report.unsupported("目标会话在同步期间发生变化，原文件保留，请再次同步")
            }
            Err(error) => report.unsupported(&error),
        }
    }
}

fn remember(session: &AgentSession, importing: bool, report: &mut Report) {
    let sessions = if importing {
        &mut report.local_sessions
    } else {
        &mut report.peer_sessions
    };
    if !sessions.iter().any(|existing| existing.id == session.id) {
        sessions.push(session.clone());
    }
}

impl NativeEngine {
    pub(super) async fn sync_sessions(&self, args: &Value) -> Result<Value, String> {
        let peer = PathBuf::from(arg(args, "peerRoot")?);
        let direction = args["direction"].as_str().unwrap_or("both");
        if !matches!(direction, "both" | "import" | "export") {
            return Err("会话同步方向无效".into());
        }
        if peer.file_name().and_then(|name| name.to_str()) != Some("native")
            || peer
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                != Some("agent")
        {
            return Err("请选择 LoliCode 的本体会话目录".into());
        }
        check_directory(&peer, true)?;
        if inside(&peer, &self.inner.root) || inside(&self.inner.root, &peer) {
            return Err("同步来源和目标必须使用不同的数据目录".into());
        }
        let local_root = self.inner.root.clone();
        let roots = vec![local_root.clone(), peer.clone()];
        let entries = self
            .inner
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut memory = BTreeMap::new();
        for entry in entries {
            let state = entry.lock().await;
            memory.insert(
                state.stored.snapshot.session.id.clone(),
                (
                    state.stored.clone(),
                    state.flight.is_some() || state.title_in_flight,
                ),
            );
        }
        let import = direction != "export";
        let export = direction != "import";
        let (local, mut report) = tokio::task::spawn_blocking(move || {
            let mut report = Report::default();
            let mut local = scan(&local_root, &mut report)?;
            let mut remote = scan(&peer, &mut report)?;
            for (id, (stored, active)) in memory {
                local.occupied.insert(id.clone());
                if let Some(record) = local.records.get_mut(&id) {
                    // Stable records already have a complete disk commit. Keep
                    // that raw object, including unknown fields from newer apps.
                    record.busy |= active || busy(&stored);
                    if !record.busy
                        && known_content_hash(&record.stored)? != known_content_hash(&stored)?
                    {
                        record.busy = true;
                        if report.warnings.len() < 20 {
                            report.warnings.push(
                                "部分本地会话内存与已保存记录不同，本次跳过，请确认记录后重试"
                                    .into(),
                            );
                        }
                    }
                } else {
                    let raw = serde_json::to_value(&stored).map_err(|_| "无法读取本地会话")?;
                    local.records.insert(
                        id,
                        Record {
                            raw,
                            busy: active || busy(&stored),
                            stored,
                        },
                    );
                }
            }
            if local.records.len() > MAX_SESSIONS {
                return Err("会话数量超过 10,000 条，本次同步未写入任何文件".into());
            }
            let local_source = local.records.values().cloned().collect();
            let peer_source = remote.records.values().cloned().collect();
            if import {
                exchange(
                    peer_source,
                    &mut local,
                    &local_root,
                    &roots,
                    true,
                    &mut report,
                );
            }
            if export {
                exchange(local_source, &mut remote, &peer, &roots, false, &mut report);
            }
            Ok::<_, String>((local, report))
        })
        .await
        .map_err(|_| "会话同步未完成，请检查两版记录后重试")??;
        let mut sessions = self.inner.sessions.write().await;
        for (id, record) in local.records {
            if record.busy || coordinated(&record) || sessions.contains_key(&id) {
                continue;
            }
            sessions.insert(
                id,
                Arc::new(Mutex::new(SessionState {
                    stored: record.stored,
                    flight: None,
                    permission: None,
                    question: None,
                    title_in_flight: false,
                    send_queued_after_stop: None,
                })),
            );
        }
        report.local_sessions.sort_by(|a, b| a.id.cmp(&b.id));
        report.peer_sessions.sort_by(|a, b| a.id.cmp(&b.id));
        encode(&report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn root(directory: &TempDir, profile: &str) -> PathBuf {
        directory.path().join(profile).join("agent/native")
    }

    fn record(id: &str, text: &str, project: &Path) -> Value {
        json!({"format":1,"snapshot":{"session":{"id":id,"title":"同步测试","projectPath":project,"mode":"build","model":null,"createdAt":1,"updatedAt":2},"status":"idle","messages":[{"id":"m1","role":"user","createdAt":1,"completedAt":1,"parts":[{"type":"text","text":text}]}],"permissions":[],"questions":[],"diffs":[],"error":null,"streamConnected":false,"streamGap":false},"history":[{"role":"user","content":text}],"commands":{"request":{"text":text,"status":"completed","futureReceipt":"retained"}},"contextSummary":"完整压缩上下文","futureRoot":{"retained":true}})
    }

    fn write(root: &Path, value: &Value) -> PathBuf {
        let path =
            persistence::session_path(root, value["snapshot"]["session"]["id"].as_str().unwrap())
                .unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        path
    }

    async fn sync(engine: &NativeEngine, peer: &Path, direction: &str) -> Value {
        engine
            .call(
                "syncSessions",
                json!({"peerRoot":peer,"direction":direction}),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn full_history_unknown_fields_and_context_survive_bidirectional_exchange() {
        let directory = TempDir::new().unwrap();
        let local = root(&directory, "local");
        let peer = root(&directory, "peer");
        let a = "lc:00000000-0000-4000-8000-000000000001";
        let b = "lc:00000000-0000-4000-8000-000000000002";
        let original_a = record(a, "local history", directory.path());
        let original_b = record(b, "peer history", directory.path());
        write(&local, &original_a);
        write(&peer, &original_b);
        let engine = NativeEngine::open(local.clone()).await.unwrap();
        let result = sync(&engine, &peer, "both").await;
        assert_eq!(
            (result["imported"].as_u64(), result["exported"].as_u64()),
            (Some(1), Some(1))
        );
        let imported: Value = serde_json::from_slice(
            &fs::read(persistence::session_path(&local, b).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(imported["history"], original_b["history"]);
        assert_eq!(imported["commands"], original_b["commands"]);
        assert_eq!(imported["futureRoot"], original_b["futureRoot"]);
        assert_eq!(imported["contextSummary"], original_b["contextSummary"]);
        assert_eq!(
            engine.entry(b).await.unwrap().lock().await.stored.history,
            vec![json!({"role":"user","content":"peer history"})]
        );
        let repeated = sync(&engine, &peer, "both").await;
        assert_eq!(repeated["imported"], 0);
        assert_eq!(repeated["exported"], 0);
        let reverse = NativeEngine::open(peer.clone()).await.unwrap();
        let repeated = sync(&reverse, &local, "both").await;
        assert_eq!(repeated["imported"], 0);
        assert_eq!(repeated["exported"], 0);
    }

    #[tokio::test]
    async fn conflicting_histories_keep_originals_and_repeated_or_reverse_sync_is_idempotent() {
        let directory = TempDir::new().unwrap();
        let local = root(&directory, "local");
        let peer = root(&directory, "peer");
        let id = "lc:00000000-0000-4000-8000-000000000001";
        let local_path = write(&local, &record(id, "local branch", directory.path()));
        let peer_path = write(&peer, &record(id, "peer branch", directory.path()));
        let local_before = fs::read(&local_path).unwrap();
        let peer_before = fs::read(&peer_path).unwrap();
        let engine = NativeEngine::open(local.clone()).await.unwrap();
        let first = sync(&engine, &peer, "both").await;
        assert_eq!(first["conflicts"], 2);
        assert_eq!(fs::read(&local_path).unwrap(), local_before);
        assert_eq!(fs::read(&peer_path).unwrap(), peer_before);
        assert_eq!(first["localSessions"].as_array().unwrap().len(), 1);
        let second = sync(&engine, &peer, "both").await;
        assert_eq!(second["imported"], 0);
        assert_eq!(second["exported"], 0);
        let reverse = NativeEngine::open(peer.clone()).await.unwrap();
        let second = sync(&reverse, &local, "both").await;
        assert_eq!(second["imported"], 0);
        assert_eq!(second["exported"], 0);
    }

    #[tokio::test]
    async fn busy_and_remote_records_are_skipped_without_recovering_or_changing_source() {
        let directory = TempDir::new().unwrap();
        let local = root(&directory, "local");
        let peer = root(&directory, "peer");
        let mut active = record(
            "lc:00000000-0000-4000-8000-000000000001",
            "running",
            directory.path(),
        );
        active["snapshot"]["status"] = json!("running");
        let path = write(&peer, &active);
        let before = fs::read(&path).unwrap();
        let remote = record(
            "lc:00000000-0000-4000-8000-000000000002",
            "remote",
            &peer.parent().unwrap().join("remote-workspaces/anchor"),
        );
        write(&peer, &remote);
        let engine = NativeEngine::open(local.clone()).await.unwrap();
        let result = sync(&engine, &peer, "import").await;
        assert_eq!(result["imported"], 0);
        assert_eq!(result["skippedBusy"], 1);
        assert_eq!(result["skippedUnsupported"], 1);
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(engine.inner.sessions.read().await.is_empty());
    }

    #[tokio::test]
    async fn secretary_groups_are_skipped_in_both_directions_while_ordinary_sessions_sync() {
        let directory = TempDir::new().unwrap();
        let local = root(&directory, "local");
        let peer = root(&directory, "peer");
        // Open before writing the fixtures: synchronization must inspect the
        // other profile without running its recovery or task scheduler.
        let engine = NativeEngine::open(local.clone()).await.unwrap();
        let mut protected = Vec::new();
        for (profile, prefix) in [(&local, "1"), (&peer, "2")] {
            let parent = format!("lc:00000000-0000-4000-8000-0000000000{prefix}1");
            let worker = format!("lc:00000000-0000-4000-8000-0000000000{prefix}2");
            let task_id = format!("task-{prefix}");
            let mut secretary = record(&parent, "secretary", directory.path());
            secretary["snapshot"]["session"]["coordination"] = json!({"role":"secretary"});
            secretary["secretaryTasks"] = json!([{
                "id":task_id,"parentSessionId":parent,"sessionId":worker,
                "title":"Protected task","instructions":"Preserve the parent link",
                "status":"queued","createdAt":1,"updatedAt":2,
                "projectPath":directory.path(),"requestId":format!("request-{prefix}")
            }]);
            let mut child = record(&worker, "worker", directory.path());
            child["snapshot"]["session"]["coordination"] = json!({
                "role":"worker","parentSessionId":parent,"taskId":task_id
            });
            child["snapshot"]["status"] = json!("running");
            for value in [secretary, child] {
                let path = write(profile, &value);
                protected.push((path.clone(), fs::read(path).unwrap()));
            }
            write(
                profile,
                &record(
                    &format!("lc:00000000-0000-4000-8000-0000000000{prefix}3"),
                    &format!("ordinary {prefix}"),
                    directory.path(),
                ),
            );
        }
        let result = sync(&engine, &peer, "both").await;
        assert_eq!(result["imported"], 1);
        assert_eq!(result["exported"], 1);
        assert_eq!(result["skippedUnsupported"], 4);
        assert_eq!(result["skippedBusy"], 0);
        assert!(result["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning
                .as_str()
                .is_some_and(|text| text.contains("父子关系"))));
        for (path, original) in protected {
            assert_eq!(fs::read(&path).unwrap(), original);
            let other = if path.starts_with(&local) {
                &peer
            } else {
                &local
            };
            assert!(!other
                .join("sessions")
                .join(path.file_name().unwrap())
                .exists());
            let id = format!("lc:{}", path.file_stem().unwrap().to_string_lossy());
            assert!(engine.entry(&id).await.is_err());
        }
        assert!(result["localSessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|session| session["coordination"].is_null()));
        assert!(result["peerSessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|session| session["coordination"].is_null()));
    }

    #[test]
    fn legacy_session_defaults_and_new_coordination_metadata_decode_without_dropping_links() {
        let directory = TempDir::new().unwrap();
        let profile = root(&directory, "profile");
        let id = "lc:00000000-0000-4000-8000-000000000001";
        let legacy = record(id, "legacy", directory.path());
        let filename = persistence::session_path(&profile, id).unwrap();
        let decoded = decode(legacy.clone(), &filename, &profile).unwrap();
        assert!(decoded.stored.snapshot.session.coordination.is_none());
        assert!(decoded.stored.secretary_tasks.is_empty());
        assert!(decoded.stored.secretary_reports.is_empty());
        assert!(!coordinated(&decoded));

        let mut newer = legacy;
        newer["snapshot"]["session"]["coordination"] = json!({
            "role":"worker","parentSessionId":"lc:parent","taskId":"task-original"
        });
        let decoded = decode(newer, &filename, &profile).unwrap();
        let link = decoded
            .stored
            .snapshot
            .session
            .coordination
            .as_ref()
            .unwrap();
        assert_eq!(link.role, "worker");
        assert_eq!(link.parent_session_id.as_deref(), Some("lc:parent"));
        assert_eq!(link.task_id.as_deref(), Some("task-original"));
        assert!(coordinated(&decoded));
        assert_eq!(
            serde_json::to_value(&decoded.stored).unwrap()["snapshot"]["session"]["coordination"],
            decoded.raw["snapshot"]["session"]["coordination"]
        );

        // A registry/outbox still belongs to a coordinated group if a partial
        // older record lacks the view metadata; never copy it as ordinary chat.
        let mut orphan = decoded;
        orphan.stored.snapshot.session.coordination = None;
        orphan.stored.secretary_reports = vec![SecretaryReport {
            request_id: "report-original".into(),
            text: "pending".into(),
            public_text: "fixture report".into(),
            delivered: false,
            withdrawn: false,
        }];
        assert!(coordinated(&orphan));
    }

    #[tokio::test]
    async fn corrupt_target_is_preserved_and_a_complete_source_gets_a_separate_id() {
        let directory = TempDir::new().unwrap();
        let local = root(&directory, "local");
        let peer = root(&directory, "peer");
        let id = "lc:00000000-0000-4000-8000-000000000001";
        let source = write(&local, &record(id, "intact", directory.path()));
        let destination = persistence::session_path(&peer, id).unwrap();
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&destination, b"corrupt original").unwrap();
        let engine = NativeEngine::open(local).await.unwrap();
        let result = sync(&engine, &peer, "export").await;
        assert_eq!(result["exported"], 1);
        assert_eq!(result["conflicts"], 1);
        assert_eq!(result["skippedUnsupported"], 1);
        assert_eq!(fs::read(&destination).unwrap(), b"corrupt original");
        assert!(fs::read(source).unwrap().starts_with(b"{"));
    }

    #[tokio::test]
    async fn reordered_nested_keys_are_duplicates_and_navigation_only_contains_transfer_matches() {
        let directory = TempDir::new().unwrap();
        let local = root(&directory, "local");
        let peer = root(&directory, "peer");
        let id = "lc:00000000-0000-4000-8000-000000000001";
        let mut local_value = record(id, "same", directory.path());
        local_value["history"][0]["extra"] =
            serde_json::from_str(r#"{"z":{"b":2,"a":1},"a":0}"#).unwrap();
        let mut peer_value = local_value.clone();
        peer_value["history"][0]["extra"] =
            serde_json::from_str(r#"{"a":0,"z":{"a":1,"b":2}}"#).unwrap();
        write(&local, &local_value);
        write(&peer, &peer_value);
        write(
            &local,
            &record(
                "lc:00000000-0000-4000-8000-000000000002",
                "destination only",
                directory.path(),
            ),
        );
        let engine = NativeEngine::open(local).await.unwrap();
        let result = sync(&engine, &peer, "import").await;
        assert_eq!(result["duplicates"], 1);
        assert_eq!(result["conflicts"], 0);
        assert_eq!(result["localSessions"].as_array().unwrap().len(), 1);
        assert_eq!(result["localSessions"][0]["id"], id);
        assert!(result["peerSessions"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn local_memory_activity_prevents_export_even_when_disk_is_idle() {
        let directory = TempDir::new().unwrap();
        let local = root(&directory, "local");
        let peer = root(&directory, "peer");
        let id = "lc:00000000-0000-4000-8000-000000000001";
        write(&local, &record(id, "idle on disk", directory.path()));
        let engine = NativeEngine::open(local).await.unwrap();
        engine.entry(id).await.unwrap().lock().await.title_in_flight = true;
        let result = sync(&engine, &peer, "export").await;
        assert_eq!(result["skippedBusy"], 1);
        assert_eq!(result["exported"], 0);
        assert!(!peer.exists());
    }

    #[test]
    fn capacity_is_per_profile_counts_bad_files_and_never_overflows() {
        let directory = TempDir::new().unwrap();
        let local = root(&directory, "local");
        let peer = root(&directory, "peer");
        let value = record(
            "lc:00000000-0000-4000-8000-000000000001",
            "capacity",
            directory.path(),
        );
        let path = write(&local, &value);
        write(&peer, &value);
        let bad = local.join("sessions/bad.json");
        fs::write(&bad, b"invalid JSON").unwrap();
        let mut report = Report::default();
        let local_catalog = scan(&local, &mut report).unwrap();
        let peer_catalog = scan(&peer, &mut report).unwrap();
        assert_eq!(
            local_catalog.byte_size,
            fs::metadata(path).unwrap().len() + fs::metadata(bad).unwrap().len()
        );
        assert_eq!(local_catalog.files, 2);
        assert!(local_catalog.byte_size > peer_catalog.byte_size);
        assert_eq!(report.skipped_unsupported, 1);
        // Two initially disjoint 75-unit profiles each become 150 units. Each
        // remains scannable even though their combined size is now 300 units.
        assert!(fits_capacity(75, 75, 256));
        assert!(fits_capacity(150, 0, 256));
        assert!(!fits_capacity(150, 107, 256));
        assert!(!fits_capacity(u64::MAX, 1, u64::MAX));
    }
}
