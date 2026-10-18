//! Recover native-agent attribution for older releases using the shared gateway.
//! Never import session totals or invent a second bill. Only uniquely matching
//! existing request rows are reassigned; model, provider, costs and IDs stay put.

use super::session_usage::{
    load_sync_cursors, metadata_modified_nanos, update_sync_state_on_conn, SessionSyncResult,
};
use crate::{
    database::{lock_conn, Database},
    error::AppError,
};
use lolicode_agent::AgentTokenUsage;
use rusqlite::params;
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::Path,
};

const SOURCE: &str = "lolicode_attribution_v1";
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

// Deliberately project metering fields only. Conversation, tools and credentials
// are ignored by the deserializer and never retained in this service.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    format: u32,
    snapshot: Snapshot,
    usage_ledger: Option<Ledger>,
}
#[derive(Deserialize)]
struct Snapshot {
    session: Session,
}
#[derive(Deserialize)]
struct Session {
    id: String,
}
#[derive(Deserialize)]
struct Ledger {
    requests: Vec<Request>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    message_id: String,
    started_at: u64,
    completed_at: Option<u64>,
    tokens: AgentTokenUsage,
    #[serde(default)]
    duration_unknown: bool,
}
struct Meter {
    id: String,
    session: String,
    start: i64,
    end: i64,
    input: i64,
    output: i64,
    read: i64,
    write: Option<i64>,
}

pub fn sync_lolicode_usage(db: &Database) -> Result<SessionSyncResult, AppError> {
    sync_at(
        db,
        &crate::config::get_app_config_dir().join("agent/native/sessions"),
        chrono::Utc::now().timestamp_millis(),
    )
}

fn sync_at(db: &Database, directory: &Path, now: i64) -> Result<SessionSyncResult, AppError> {
    let mut result = SessionSyncResult::default();
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(_) => {
            return Err(AppError::Config(
                "无法读取 LoliCode 会话用量目录，已有账单未改动".into(),
            ))
        }
    };
    let cursors = load_sync_cursors(db)?;
    let mut files = Vec::new();
    let mut meters = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|_| AppError::Config("无法读取 LoliCode 会话用量目录项".into()))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let meta = fs::symlink_metadata(&path)
            .map_err(|_| AppError::Config("无法读取 LoliCode 会话用量文件状态".into()))?;
        if !meta.file_type().is_file() || meta.len() > MAX_FILE_BYTES {
            result
                .errors
                .push("LoliCode 会话用量文件不是普通文件或超过大小限制，已跳过".into());
            continue;
        }
        let key = format!("{SOURCE}:{}", path.display());
        let modified = metadata_modified_nanos(&meta);
        if modified > 0
            && cursors
                .get(&key)
                .is_some_and(|cursor| cursor.last_modified == modified)
        {
            continue;
        }
        result.files_scanned += 1;
        let file = fs::File::open(&path)
            .map_err(|_| AppError::Config("无法打开 LoliCode 会话用量文件".into()))?;
        let stored: SessionFile =
            match serde_json::from_reader(std::io::BufReader::new(file.take(MAX_FILE_BYTES + 1))) {
                Ok(stored) => stored,
                Err(_) => {
                    result
                        .errors
                        .push("LoliCode 会话用量文件无法解析，原文件保留".into());
                    continue;
                }
            };
        let session = stored.snapshot.session.id;
        let valid_id = session
            .strip_prefix("lc:")
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
            .is_some_and(|id| {
                path.file_stem().and_then(|s| s.to_str()) == Some(id.to_string().as_str())
                    && session == format!("lc:{id}")
            });
        if stored.format != 1 || !valid_id {
            result
                .errors
                .push("LoliCode 会话用量标识或格式不匹配，已跳过".into());
            continue;
        }
        let mut deferred = false;
        for request in stored
            .usage_ledger
            .into_iter()
            .flat_map(|ledger| ledger.requests)
        {
            let Some(end) = request.completed_at else {
                deferred = true;
                continue;
            };
            if end > now.saturating_sub(60_000) as u64 {
                deferred = true;
                continue;
            }
            if request.duration_unknown || request.started_at == 0 || end < request.started_at {
                continue;
            }
            if !request
                .message_id
                .strip_prefix("assistant-")
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
            {
                continue;
            }
            let t = request.tokens;
            let (Some(input), Some(output), Some(read)) =
                (t.input_tokens, t.output_tokens, t.cache_read_tokens)
            else {
                continue;
            };
            // Native usage is total-inclusive only when it has a known matching
            // denominator. A missing cache-write count is not filled with zero:
            // the candidate row's real count must fit the inclusive total.
            if t.cache_input_tokens != Some(input) || input < read || (input == 0 && output == 0) {
                continue;
            }
            if [input, output, read, end, request.started_at]
                .iter()
                .any(|value| *value > i64::MAX as u64)
                || t.cache_write_tokens
                    .is_some_and(|value| value > i64::MAX as u64)
            {
                continue;
            }
            meters.push(Meter {
                id: format!("{session}:{}", request.message_id),
                session: session.clone(),
                start: request.started_at as i64,
                end: end as i64,
                input: input as i64,
                output: output as i64,
                read: read as i64,
                write: t.cache_write_tokens.map(|value| value as i64),
            });
        }
        if fs::metadata(&path)
            .map(|m| metadata_modified_nanos(&m))
            .ok()
            != Some(modified)
        {
            deferred = true;
        }
        if deferred {
            result.deferred_files += 1;
        } else {
            files.push((key, modified));
        }
    }
    if meters.is_empty() && files.is_empty() {
        return Ok(result);
    }
    let mut conn = lock_conn!(db.conn);
    let tx = conn.transaction()?;
    let existing_claims = tx
        .prepare("SELECT semantic_id FROM session_usage_dedup WHERE semantic_id LIKE 'gateway:%'")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    let mut identities = HashMap::new();
    for meter in &meters {
        *identities.entry(&meter.id).or_insert(0usize) += 1;
    }
    let mut proposals = Vec::new();
    let mut claims = HashMap::new();
    for meter in &meters {
        if identities[&meter.id] != 1 {
            continue;
        }
        let seen: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM session_usage_dedup WHERE data_source=?1 AND request_id=?2)", params![SOURCE, meter.id], |row| row.get(0))?;
        if seen {
            result.skipped += 1;
            continue;
        }
        let mut query = tx.prepare_cached("SELECT l.request_id,l.app_type FROM proxy_request_logs l
            WHERE l.app_type IN ('channel-gateway','lolicode') AND COALESCE(l.data_source,'proxy')='proxy'
            AND l.provider_id LIKE 'channel-%' AND l.input_token_semantics IN (0,2)
            AND l.created_at BETWEEN ?1/1000-5 AND ?2/1000+5
            AND ABS(l.created_at-?2/1000.0)<=5
            AND ABS(l.created_at-l.latency_ms/1000.0-?1/1000.0)<=5
            AND l.input_tokens+l.cache_read_tokens+l.cache_creation_tokens=?3
            AND l.output_tokens=?4 AND l.cache_read_tokens=?5
            AND (?6 IS NULL OR l.cache_creation_tokens=?6) AND l.status_code BETWEEN 200 AND 299
            LIMIT 2")?;
        let candidates = query
            .query_map(
                params![
                    meter.start,
                    meter.end,
                    meter.input,
                    meter.output,
                    meter.read,
                    meter.write
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        if let [candidate] = candidates.as_slice() {
            if existing_claims.contains(&format!("gateway:{}", candidate.0)) {
                result.skipped += 1;
                continue;
            }
            *claims.entry(candidate.0.clone()).or_insert(0usize) += 1;
            proposals.push((meter, candidate.clone()));
        } else {
            result.skipped += 1;
        }
    }
    for (meter, (row, app)) in proposals {
        // Two local records claiming one upstream row are ambiguous too. No
        // first-match wins and no guessing across tools sharing the old route.
        if claims[&row] != 1 {
            result.skipped += 1;
            continue;
        }
        tx.execute("INSERT INTO session_usage_dedup(data_source,request_id,semantic_id,has_entry_id) VALUES(?1,?2,?3,1)", params![SOURCE,meter.id,format!("gateway:{row}")])?;
        if app == "channel-gateway" {
            result.imported += tx.execute("UPDATE proxy_request_logs SET app_type='lolicode',session_id=?2 WHERE request_id=?1 AND app_type='channel-gateway'", params![row,meter.session])? as u32;
        } else {
            result.skipped += 1;
        }
    }
    for (key, modified) in files {
        update_sync_state_on_conn(&tx, &key, modified, 0)?;
    }
    tx.commit()?;
    Ok(result)
}

#[cfg(test)]
#[path = "session_usage_lolicode_tests.rs"]
mod tests;
