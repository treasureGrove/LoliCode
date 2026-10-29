//! Legacy OpenCode history, decoded without starting or mutating an engine.
use super::agent_preferences;
use lolicode_agent::{
    decode_legacy_message, AgentMessage, AgentModelRef, AgentPart, AgentSession, AgentSnapshot,
    AgentStatus,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{self, Read},
    path::Path,
    time::SystemTime,
};

const MAX_SESSIONS: usize = 10_000;
const MAX_MESSAGES: usize = 10_000;
const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_HISTORY_BYTES: usize = 32 * 1024 * 1024;
const MAX_DB_BYTES: u64 = 256 * 1024 * 1024;
const MAX_WAL_BYTES: u64 = 64 * 1024 * 1024;

struct ReadOnlyHistory {
    db: Connection,
    // Connection drops before its private snapshot. SQLite may need a shared
    // memory file to read WAL: it must never create one beside the user's DB.
    _snapshot: tempfile::TempDir,
}
#[derive(PartialEq)]
struct Stamp {
    bytes: u64,
    modified: Option<SystemTime>,
}
fn stamp(path: &Path) -> Result<Option<Stamp>, String> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(Some(Stamp {
            bytes: meta.len(),
            modified: meta.modified().ok(),
        })),
        Ok(_) => Err("旧会话数据库路径不是普通文件，原数据已保留".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("旧会话数据库状态无法读取，原数据已保留".into()),
    }
}
fn copy_bounded(source: &Path, target: &Path, maximum: u64) -> Result<(), String> {
    let input = File::open(source).map_err(|_| "旧会话数据库无法只读打开")?;
    let mut output = File::create(target).map_err(|_| "无法创建私有历史读取快照")?;
    let copied = io::copy(&mut input.take(maximum + 1), &mut output)
        .map_err(|_| "旧会话数据库读取未完成")?;
    if copied > maximum {
        return Err("旧会话数据库超过本次只读范围，原数据已保留".into());
    }
    Ok(())
}
fn open(root: &Path) -> Result<Option<ReadOnlyHistory>, String> {
    let path = root.join("data/lolicode-agent.db");
    let wal = root.join("data/lolicode-agent.db-wal");
    let journal = root.join("data/lolicode-agent.db-journal");
    for _ in 0..3 {
        let Some(before) = stamp(&path)? else {
            return Ok(None);
        };
        let wal_before = stamp(&wal)?;
        if before.bytes > MAX_DB_BYTES
            || wal_before.as_ref().is_some_and(|s| s.bytes > MAX_WAL_BYTES)
        {
            return Err("旧会话数据库超过本次只读范围，原数据已保留".into());
        }
        if stamp(&journal)?.is_some_and(|s| s.bytes > 0) {
            return Err("旧会话数据库存在待处理写入日志，请结束旧任务后重试；原数据未修改".into());
        }
        let snapshot = tempfile::Builder::new()
            .prefix("lolicode-history-readonly-")
            .tempdir()
            .map_err(|_| "无法创建私有历史读取目录")?;
        let copied = snapshot.path().join("history.db");
        copy_bounded(&path, &copied, MAX_DB_BYTES)?;
        if wal_before.is_some() {
            copy_bounded(&wal, &snapshot.path().join("history.db-wal"), MAX_WAL_BYTES)?;
        }
        if stamp(&path)?.as_ref() != Some(&before) || stamp(&wal)? != wal_before {
            continue;
        }
        let db = Connection::open_with_flags(
            &copied,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| "旧会话数据库无法只读打开，原数据已保留")?;
        db.execute_batch(
            "PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF;",
        )
        .map_err(|_| "旧会话只读连接无法初始化")?;
        return Ok(Some(ReadOnlyHistory {
            db,
            _snapshot: snapshot,
        }));
    }
    Err("旧会话数据库正在变化，请稍后重新读取；原数据未修改".into())
}
fn table_columns(db: &Connection, table: &str) -> Result<Option<BTreeSet<String>>, String> {
    // The table and column names below come only from these fixed allowlists.
    if !["session", "session_v2", "message", "session_message"].contains(&table) {
        return Err("历史表名称无效".into());
    }
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |row| row.get(0),
        )
        .map_err(|_| "旧会话数据库结构无法读取")?;
    if !exists {
        return Ok(None);
    }
    let mut statement = db
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .map_err(|_| "旧会话表结构无法读取")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| "旧会话列无法读取")?
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(|_| "旧会话列无法读取")?;
    Ok(Some(columns))
}
fn metadata(value: &Value) -> Option<AgentSession> {
    let id = value["id"].as_str().filter(|id| valid_id(id))?;
    let directory = value["location"]["directory"]
        .as_str()
        .or_else(|| value["directory"].as_str())?;
    let model = value.get("model").and_then(|m| {
        Some(AgentModelRef {
            provider_id: m["providerID"].as_str()?.into(),
            model_id: m["id"].as_str()?.into(),
        })
    });
    Some(AgentSession {
        id: id.into(),
        title: value["title"].as_str().unwrap_or("旧会话").into(),
        project_path: directory.into(),
        mode: value["agent"].as_str().unwrap_or("build").into(),
        permission_mode: "custom".into(),
        pinned: false,
        archived: false,
        model,
        created_at: value["time"]["created"].as_u64().unwrap_or(0),
        updated_at: value["time"]["updated"].as_u64().unwrap_or(0),
        activity: None,
        reasoning_effort: None,
        context_limit: None,
    })
}
fn valid_id(id: &str) -> bool {
    id.starts_with("ses_")
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn sessions(db: &Connection, project: Option<&str>) -> Result<Vec<AgentSession>, String> {
    let mut result = Vec::new();
    let mut ids = BTreeSet::new();
    let mut known = false;
    let mut scanned = 0;
    for table in ["session_v2", "session"] {
        let Some(columns) = table_columns(db, table)? else {
            continue;
        };
        known = true;
        if columns.contains("data") {
            let mut statement=db.prepare(&format!("SELECT CASE WHEN length(CAST(data AS BLOB))<=1048576 THEN data ELSE NULL END FROM \"{table}\" LIMIT {}",MAX_SESSIONS+1)).map_err(|_|"旧会话记录格式不兼容，原文件已保留")?;
            let rows = statement
                .query_map([], |row| row.get::<_, Option<String>>(0))
                .map_err(|_| "旧会话记录无法读取")?;
            for row in rows {
                scanned += 1;
                if scanned > MAX_SESSIONS {
                    return Err("旧会话数量超出本次只读范围，原数据已保留".into());
                }
                let raw = row
                    .map_err(|_| "旧会话记录无法读取")?
                    .ok_or("旧会话元数据超过读取范围，原文件已保留")?;
                let value: Value =
                    serde_json::from_str(&raw).map_err(|_| "旧会话元数据无法解析，原文件已保留")?;
                if let Some(session) = metadata(&value) {
                    push_session(&mut result, &mut ids, session, project);
                }
            }
        } else if ["id", "directory", "time_created", "time_updated"]
            .iter()
            .all(|name| columns.contains(*name))
        {
            let title = if columns.contains("title") {
                "COALESCE(title,'旧会话')"
            } else {
                "'旧会话'"
            };
            let mut statement=db.prepare(&format!("SELECT id,{title},directory,time_created,time_updated FROM \"{table}\" LIMIT {}",MAX_SESSIONS+1)).map_err(|_|"旧会话元数据列不兼容")?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .map_err(|_| "旧会话元数据无法读取")?;
            for row in rows {
                scanned += 1;
                if scanned > MAX_SESSIONS {
                    return Err("旧会话数量超出本次只读范围，原数据已保留".into());
                }
                let (id, title, directory, created, updated) =
                    row.map_err(|_| "旧会话元数据无法读取")?;
                if let Some(session) = metadata(
                    &serde_json::json!({"id":id,"title":title,"directory":directory,"time":{"created":created.max(0),"updated":updated.max(0)}}),
                ) {
                    push_session(&mut result, &mut ids, session, project);
                }
            }
        } else {
            return Err("旧会话元数据结构暂不支持，原文件已保留".into());
        }
    }
    if !known {
        return Err("旧会话数据库缺少会话表，原文件已保留".into());
    }
    result.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(result)
}
fn push_session(
    result: &mut Vec<AgentSession>,
    ids: &mut BTreeSet<String>,
    session: AgentSession,
    project: Option<&str>,
) {
    if project.is_none_or(|p| {
        agent_preferences::path_key(p) == agent_preferences::path_key(&session.project_path)
    }) && ids.insert(session.id.clone())
    {
        result.push(session)
    }
}
pub fn legacy_sessions(root: &Path, project: Option<&str>) -> Result<Vec<AgentSession>, String> {
    let Some(history) = open(root)? else {
        return Ok(vec![]);
    };
    sessions(&history.db, project)
}

pub fn legacy_snapshot(root: &Path, session_id: &str) -> Result<AgentSnapshot, String> {
    if !valid_id(session_id) {
        return Err("此编号不是可读取的旧 OpenCode 会话".into());
    }
    let history = open(root)?.ok_or("旧会话数据库不存在，原记录未修改")?;
    let session = sessions(&history.db, None)?
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or("未找到此旧会话，原记录未修改")?;
    let mut messages=vec![notice("readonly","这是旧 OpenCode 会话的只读记录，尚未迁移到本体。这里不会恢复旧任务或授权；继续编程请新建会话。")];
    let mut warnings = Vec::new();
    let mut found = false;
    let mut saw_message_table = false;
    for table in ["session_message", "message"] {
        let Some(columns) = table_columns(&history.db, table)? else {
            continue;
        };
        saw_message_table = true;
        if !columns.contains("data") {
            warnings.push(format!(
                "旧 {table} 表没有可解码的 data 列，部分历史无法展示。"
            ));
            continue;
        }
        let session_column = if columns.contains("session_id") {
            Some("session_id")
        } else if columns.contains("sessionID") {
            Some("sessionID")
        } else {
            None
        };
        let filter = if let Some(column) = session_column {
            format!("WHERE \"{column}\"=?1")
        } else {
            "WHERE ?1 IS NOT NULL".into()
        };
        let order = if columns.contains("seq") {
            "ORDER BY seq ASC"
        } else if columns.contains("time_created") {
            "ORDER BY time_created ASC"
        } else {
            ""
        };
        let sql=format!("SELECT CASE WHEN length(CAST(data AS BLOB))<={MAX_MESSAGE_BYTES} THEN data ELSE NULL END FROM \"{table}\" {filter} {order} LIMIT {}",MAX_MESSAGES+1);
        let mut statement = history
            .db
            .prepare(&sql)
            .map_err(|_| "旧会话消息结构暂不支持，原数据已保留")?;
        let rows = statement
            .query_map([session_id], |row| row.get::<_, Option<String>>(0))
            .map_err(|_| "旧会话消息无法只读读取")?;
        let mut decoded = Vec::new();
        let mut skipped = 0usize;
        let mut total = 0usize;
        let mut any = false;
        let mut ids = BTreeSet::new();
        for (index, row) in rows.enumerate() {
            if index >= MAX_MESSAGES {
                warnings.push("旧消息数量超出本次只读范围，后续记录尚未展示。".into());
                break;
            }
            let raw = match row {
                Ok(Some(raw)) => raw,
                _ => {
                    skipped += 1;
                    any = true;
                    continue;
                }
            };
            let value: Value = match serde_json::from_str(&raw) {
                Ok(value) => value,
                Err(_) => {
                    skipped += 1;
                    any = true;
                    continue;
                }
            };
            if session_column.is_none() {
                let owner = value["sessionID"]
                    .as_str()
                    .or_else(|| value["sessionId"].as_str())
                    .or_else(|| value["session_id"].as_str());
                if owner != Some(session_id) {
                    if owner.is_none() {
                        skipped += 1;
                    }
                    continue;
                }
            }
            any = true;
            if total
                .checked_add(raw.len())
                .is_none_or(|n| n > MAX_HISTORY_BYTES)
            {
                warnings.push("旧消息正文超出本次只读总量，后续记录尚未展示。".into());
                break;
            }
            total += raw.len();
            if value["type"] == "idle" {
                continue;
            }
            if let Some(message) = decode_legacy_message(&value) {
                if message.parts.is_empty() {
                    skipped += 1;
                    continue;
                }
                if value["type"] == "assistant"
                    && value["content"].as_array().is_some_and(|parts| {
                        parts.iter().any(|p| {
                            !matches!(p["type"].as_str(), Some("text" | "reasoning" | "tool"))
                        })
                    })
                {
                    skipped += 1;
                }
                if ids.insert(message.id.clone()) {
                    decoded.push(message);
                }
            } else {
                skipped += 1;
            }
        }
        if skipped > 0 {
            warnings.push(format!("有 {skipped} 条旧消息或内容片段无法完整解码，已保留能够读取的历史；原数据库未修改。"));
        }
        if any {
            messages.extend(decoded);
            found = true;
            break;
        }
    }
    if !saw_message_table {
        warnings.push(
            "旧数据库缺少 message / session_message 表，当前仅能显示会话资料，无法还原消息正文。"
                .into(),
        );
    } else if !found {
        warnings.push("此旧会话没有可读取的已保存消息；这里没有生成或补写任何历史。".into());
    }
    if messages.iter().any(|m| {
        m.parts
            .iter()
            .any(|p| matches!(p,AgentPart::Tool{state,..} if state=="running"||state=="pending"))
    }) {
        warnings
            .push("部分旧步骤保存时尚未结束，所示状态仅为历史记录，不代表现在仍在执行。".into());
    }
    for (index, warning) in warnings.iter().enumerate() {
        messages.push(notice(&format!("partial-{index}"), warning));
    }
    Ok(AgentSnapshot {
        session,
        status: AgentStatus::Idle,
        messages,
        permissions: vec![],
        questions: vec![],
        diffs: vec![],
        error: None,
        stream_connected: false,
        stream_gap: false,
        title_pending: false,
        compacting: false,
        usage: None,
        model_phase: None,
    })
}
fn notice(id: &str, text: &str) -> AgentMessage {
    AgentMessage {
        id: format!("lolicode-legacy-{id}"),
        role: "system".into(),
        created_at: 0,
        completed_at: Some(0),
        parts: vec![AgentPart::Text { text: text.into() }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (tempfile::TempDir, Connection) {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("data")).unwrap();
        let db = Connection::open(root.path().join("data/lolicode-agent.db")).unwrap();
        db.execute("CREATE TABLE session(data TEXT NOT NULL)", [])
            .unwrap();
        db.execute("INSERT INTO session(data) VALUES (?1)",[json!({"id":"ses_owned","title":"真实旧标题","location":{"directory":"D:/owned/project"},"model":{"providerID":"lolicode","id":"route/model"},"agent":"plan","time":{"created":1,"updated":9}}).to_string()]).unwrap();
        (root, db)
    }
    fn dump(root: &Path) -> Vec<(String, Vec<u8>)> {
        let mut files: Vec<_> = fs::read_dir(root.join("data"))
            .unwrap()
            .map(|e| {
                let p = e.unwrap().path();
                (
                    p.file_name().unwrap().to_string_lossy().into_owned(),
                    fs::read(&p).unwrap(),
                )
            })
            .collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        files
    }
    fn has(snapshot: &AgentSnapshot, needle: &str) -> bool {
        snapshot
            .messages
            .iter()
            .flat_map(|m| &m.parts)
            .any(|p| matches!(p,AgentPart::Text{text} if text.contains(needle)))
    }
    #[test]
    fn agent_history_actual_v2_json_restores_text_reasoning_tool_and_source_bytes() {
        let (root, db) = fixture();
        db.execute("CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL)",[]).unwrap();
        for (seq,value) in [json!({"id":"msg_user","type":"user","text":"原始问题","time":{"created":2}}),json!({"id":"msg_assistant","type":"assistant","time":{"created":3,"completed":8},"content":[{"type":"reasoning","text":"已保存思考"},{"type":"tool","id":"call_read","name":"read","state":{"status":"completed","input":{"path":"src/main.rs"},"content":[{"type":"text","text":"真实文件内容"}]}},{"type":"text","text":"原始回复"}]}),json!({"id":"msg_idle","type":"idle","time":{"created":9},"outcome":"succeeded"})].into_iter().enumerate() {
            db.execute("INSERT INTO session_message(id,session_id,seq,data) VALUES (?1,'ses_owned',?2,?3)",rusqlite::params![value["id"].as_str().unwrap(),seq as i64,value.to_string()]).unwrap();
        }
        drop(db);
        let before = dump(root.path());
        let list = legacy_sessions(root.path(), Some("D:/owned/project")).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].mode, "plan");
        let snapshot = legacy_snapshot(root.path(), "ses_owned").unwrap();
        assert_eq!(snapshot.session.title, "真实旧标题");
        assert!(has(&snapshot, "原始问题"));
        assert!(has(&snapshot, "原始回复"));
        assert!(has(&snapshot, "尚未迁移"));
        assert!(snapshot.messages.iter().flat_map(|m|&m.parts).any(|p|matches!(p,AgentPart::Tool{name,output:Some(text),..} if name=="read"&&text=="真实文件内容")));
        assert!(!snapshot.messages.iter().any(|m| m.id == "msg_idle"));
        assert!(snapshot.permissions.is_empty());
        assert!(!snapshot.stream_connected);
        assert_eq!(before, dump(root.path()));
    }
    #[test]
    fn agent_history_message_data_fallback_filters_session_scope_and_warns_on_partial_records() {
        let (root, db) = fixture();
        db.execute("CREATE TABLE message(data TEXT NOT NULL)", [])
            .unwrap();
        for value in [
            json!({"id":"msg_yes","sessionID":"ses_owned","type":"user","text":"属于此会话","time":{"created":1}}),
            json!({"id":"msg_no","sessionID":"ses_other","type":"user","text":"不能串入别的会话"}),
            json!({"id":"msg_future","sessionID":"ses_owned","type":"unknown-future"}),
        ] {
            db.execute("INSERT INTO message(data) VALUES (?1)", [value.to_string()])
                .unwrap();
        }
        drop(db);
        let before = dump(root.path());
        let snapshot = legacy_snapshot(root.path(), "ses_owned").unwrap();
        assert!(has(&snapshot, "属于此会话"));
        assert!(!has(&snapshot, "不能串入"));
        assert!(has(&snapshot, "无法完整解码"));
        assert_eq!(before, dump(root.path()));
    }
    #[test]
    fn agent_history_missing_message_table_is_explicit_and_never_creates_one() {
        let (root, db) = fixture();
        drop(db);
        let before = dump(root.path());
        let snapshot = legacy_snapshot(root.path(), "ses_owned").unwrap();
        assert!(has(&snapshot, "缺少 message"));
        assert_eq!(before, dump(root.path()));
        assert!(legacy_snapshot(root.path(), "lc:owned").is_err());
        assert!(legacy_snapshot(root.path(), "ses_absent").is_err());
    }
    #[test]
    fn agent_history_supports_column_metadata_and_does_not_create_missing_databases() {
        let empty = tempfile::tempdir().unwrap();
        assert!(legacy_sessions(empty.path(), None).unwrap().is_empty());
        assert_eq!(fs::read_dir(empty.path()).unwrap().count(), 0);
        let (root, db) = fixture();
        db.execute("DROP TABLE session", []).unwrap();
        db.execute("CREATE TABLE session_v2(id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER)",[]).unwrap();
        db.execute(
            "INSERT INTO session_v2 VALUES ('ses_columns','列式历史','D:/owned/project',3,8)",
            [],
        )
        .unwrap();
        drop(db);
        let before = dump(root.path());
        let list = legacy_sessions(root.path(), None).unwrap();
        assert_eq!(list[0].id, "ses_columns");
        assert_eq!(list[0].created_at, 3);
        assert_eq!(before, dump(root.path()));
    }
    #[test]
    fn agent_history_reads_uncheckpointed_wal_without_writing_source_db_or_sidecars() {
        let (root, db) = fixture();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        db.execute(
            "CREATE TABLE session_message(session_id TEXT,data TEXT)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO session_message VALUES ('ses_owned',?1)",
            [
                json!({"id":"msg_wal","type":"user","text":"WAL内提交的消息","time":{"created":4}})
                    .to_string(),
            ],
        )
        .unwrap();
        let before = dump(root.path());
        let snapshot = legacy_snapshot(root.path(), "ses_owned").unwrap();
        assert!(has(&snapshot, "WAL内提交"));
        assert_eq!(before, dump(root.path()));
        drop(db);
    }
    #[test]
    fn agent_history_large_or_unknown_parts_keep_readable_text_and_show_warning() {
        let (root, db) = fixture();
        db.execute("CREATE TABLE message(session_id TEXT,data TEXT)", [])
            .unwrap();
        db.execute("INSERT INTO message VALUES ('ses_owned',?1)",[json!({"id":"msg_partial","type":"assistant","content":[{"type":"text","text":"可读正文"},{"type":"future-image","payload":"unknown"}]}).to_string()]).unwrap();
        db.execute(
            "INSERT INTO message VALUES ('ses_owned',?1)",
            ["x".repeat(MAX_MESSAGE_BYTES + 1)],
        )
        .unwrap();
        drop(db);
        let snapshot = legacy_snapshot(root.path(), "ses_owned").unwrap();
        assert!(has(&snapshot, "可读正文"));
        assert!(has(&snapshot, "无法完整解码"));
    }
}
