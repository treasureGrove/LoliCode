//! Read-only adapters for desktop agents. Only completed request usage is
//! imported: never conversation text, credentials, context-size gauges or
//! session-level cumulative snapshots. Local prices are estimates, not bills.

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::proxy::usage::{calculator::CostCalculator, parser::TokenUsage};
use crate::services::session_usage::{
    metadata_modified_nanos, update_sync_state_on_conn, SessionSyncResult,
};
use crate::services::sql_helpers::{fresh_input_sql, INPUT_TOKEN_SEMANTICS_FRESH};
use crate::services::usage_stats::find_model_pricing;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use rust_decimal::Decimal;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    str::FromStr,
    sync::atomic::{AtomicU8, Ordering},
};

const SETTLE_SECONDS: i64 = 60;
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
static READ_FAILURES: AtomicU8 = AtomicU8::new(0);

#[derive(Clone, Copy, Debug)]
pub(crate) enum DesktopSource {
    WorkBuddy,
    DeepSeekHarness,
    ZCode,
    MiMo,
}

impl DesktopSource {
    pub(crate) const ALL: [Self; 4] = [
        Self::WorkBuddy,
        Self::DeepSeekHarness,
        Self::ZCode,
        Self::MiMo,
    ];
    pub(crate) fn app(self) -> &'static str {
        match self {
            Self::WorkBuddy => "workbuddy",
            Self::DeepSeekHarness => "deepseek-harness",
            Self::ZCode => "zcode",
            Self::MiMo => "mimocode",
        }
    }
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::WorkBuddy => "WorkBuddy",
            Self::DeepSeekHarness => "DeepSeek Harness",
            Self::ZCode => "ZCode",
            Self::MiMo => "MiMo",
        }
    }
    pub(crate) fn data_source(self) -> String {
        format!("{}_session", self.app())
    }
    pub(crate) fn unavailable(self) -> bool {
        READ_FAILURES.load(Ordering::Relaxed) & (1 << self as u8) != 0
    }
    pub(crate) fn paths(self) -> Result<Vec<PathBuf>, AppError> {
        source_paths(
            self,
            &SourceLocations {
                home: dirs::home_dir()
                    .ok_or_else(|| AppError::Config("无法确定应用用量用户目录".into()))?,
                local_data: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
                xdg_data: std::env::var_os("XDG_DATA_HOME").map(PathBuf::from),
                mimo_home: std::env::var_os("MIMOCODE_HOME").map(PathBuf::from),
                mimo_db: std::env::var_os("MIMOCODE_DB").map(PathBuf::from),
                dsh_home: std::env::var_os("DSH_HOME").map(PathBuf::from),
            },
        )
    }
}

struct SourceLocations {
    home: PathBuf,
    local_data: Option<PathBuf>,
    xdg_data: Option<PathBuf>,
    mimo_home: Option<PathBuf>,
    mimo_db: Option<PathBuf>,
    dsh_home: Option<PathBuf>,
}
fn source_paths(
    source: DesktopSource,
    locations: &SourceLocations,
) -> Result<Vec<PathBuf>, AppError> {
    let absolute = |path: &PathBuf| {
        if path.is_absolute() {
            Ok(path.clone())
        } else {
            Err(AppError::Config(format!(
                "{} 用量目录环境变量必须为绝对路径",
                source.label()
            )))
        }
    };
    let home = &locations.home;
    match source {
        DesktopSource::WorkBuddy => Ok(vec![
            home.join(".workbuddy/projects"),
            home.join(".workbuddy-ai/projects"),
        ]),
        DesktopSource::ZCode => Ok(vec![home.join(".zcode/cli/db/db.sqlite")]),
        DesktopSource::DeepSeekHarness => Ok(vec![match &locations.dsh_home {
            Some(root) if !root.as_os_str().is_empty() => absolute(root)?.join("sessions"),
            _ => home.join(".dsh/sessions"),
        }]),
        DesktopSource::MiMo => {
            if let Some(path) = &locations.mimo_db {
                if !path.as_os_str().is_empty() {
                    return Ok(vec![absolute(path)?]);
                }
            }
            if let Some(root) = &locations.mimo_home {
                if !root.as_os_str().is_empty() {
                    return Ok(vec![absolute(root)?.join("data/mimocode.db")]);
                }
            }
            if let Some(root) = &locations.xdg_data {
                if !root.as_os_str().is_empty() {
                    return Ok(vec![absolute(root)?.join("mimocode/mimocode.db")]);
                }
            }
            let mut paths = vec![home.join(".local/share/mimocode/mimocode.db")];
            if let Some(root) = &locations.local_data {
                paths.push(absolute(root)?.join("mimocode/mimocode.db"));
            }
            Ok(paths)
        }
    }
}

#[derive(Debug)]
struct Record {
    id: String,
    session: String,
    model: String,
    created: i64,
    input: u32,
    output: u32,
    read: Option<u32>,
    write: Option<u32>,
    reported_estimate: Option<Decimal>,
}

fn count(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|n| n.try_into().ok())
}
fn label(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty() && text.len() <= 512).then(|| text.to_owned())
}
fn timestamp(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    let seconds = if let Some(n) = value.as_i64() {
        if n > 100_000_000_000 {
            n / 1000
        } else {
            n
        }
    } else {
        chrono::DateTime::parse_from_rfc3339(value.as_str()?)
            .ok()?
            .timestamp()
    };
    (seconds > 0).then_some(seconds)
}
fn cost(value: Option<&Value>) -> Option<Decimal> {
    let value = value?;
    let raw = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string());
    let parsed = Decimal::from_str(&raw)
        .or_else(|_| Decimal::from_scientific(&raw))
        .ok()?;
    // A zero cost in agent caches commonly means "not priced", not free.
    (parsed > Decimal::ZERO).then_some(parsed)
}

fn workbuddy(value: &Value, session: &str) -> Option<Record> {
    let provider = value.get("providerData")?;
    let usage = provider.get("usage")?;
    if value.get("role").and_then(Value::as_str) == Some("user") {
        return None;
    }
    let input = count(usage.get("inputTokens"))?;
    let output = count(usage.get("outputTokens"))?;
    let read = count(usage.pointer("/inputTokensDetails/0/cached_tokens"))
        .or_else(|| count(value.pointer("/message/usage/cache_read_input_tokens")));
    Some(Record {
        id: label(provider.get("messageId")).or_else(|| label(value.get("id")))?,
        session: label(value.get("sessionId")).unwrap_or_else(|| session.into()),
        model: label(provider.get("model"))?,
        created: timestamp(value.get("timestamp"))?,
        // WorkBuddy uses inclusive prompt tokens (total = input + output).
        input: input.checked_sub(read.unwrap_or(0))?,
        output,
        read,
        write: None,
        reported_estimate: None,
    })
}

fn dsh(value: &Value, session: &str, model: Option<&str>) -> Option<Record> {
    let kind = value.get("type")?.as_str()?;
    if !matches!(
        kind,
        "assistant/message" | "assistant/attempt" | "compaction/summary"
    ) {
        return None;
    }
    let data = value.get("data")?;
    let usage = data.get("usage")?;
    let id = label(data.pointer("/message/id"))
        .or_else(|| label(data.get("compactionId")))
        .or_else(|| {
            value
                .get("seq")
                .and_then(Value::as_u64)
                .map(|n| format!("seq-{n}"))
        })?;
    Some(Record {
        id,
        session: session.into(),
        model: label(data.get("model")).or_else(|| model.map(str::to_owned))?,
        created: timestamp(value.get("time"))?,
        // DSH's normalized usage excludes cache read/write from inputTokens.
        input: count(usage.get("inputTokens"))?,
        output: count(usage.get("outputTokens"))?,
        read: count(usage.get("cacheReadTokens")),
        write: count(usage.get("cacheWriteTokens")),
        reported_estimate: None,
    })
}

fn mimo(value: &Value, id: &str, session: &str) -> Option<Record> {
    if value.get("role")?.as_str()? != "assistant"
        || value
            .pointer("/time/completed")
            .and_then(Value::as_i64)
            .is_none()
    {
        return None;
    }
    let tokens = value.get("tokens")?;
    let output =
        count(tokens.get("output"))?.checked_add(count(tokens.get("reasoning")).unwrap_or(0))?;
    Some(Record {
        id: id.into(),
        session: session.into(),
        model: label(value.get("modelID"))?,
        created: timestamp(value.pointer("/time/created"))?,
        input: count(tokens.get("input"))?,
        output,
        read: count(tokens.pointer("/cache/read")),
        write: count(tokens.pointer("/cache/write")),
        // This is MiMo's local price calculation, not the account's actual bill.
        reported_estimate: cost(value.get("cost")),
    })
}

fn files(root: &Path, source: DesktopSource) -> Result<Vec<PathBuf>, AppError> {
    let mut found = Vec::new();
    let mut pending = vec![(root.to_owned(), 0)];
    while let Some((directory, depth)) = pending.pop() {
        let entries = fs::read_dir(&directory).map_err(|error| AppError::io(&directory, error))?;
        for entry in entries {
            let entry = entry.map_err(|error| AppError::io(&directory, error))?;
            let kind = entry
                .file_type()
                .map_err(|error| AppError::io(entry.path(), error))?;
            // Do not follow symlinks/junctions into arbitrary folders.
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() && depth < 4 {
                pending.push((entry.path(), depth + 1));
            } else if kind.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                let supported = match source {
                    DesktopSource::WorkBuddy => name.ends_with(".jsonl"),
                    DesktopSource::DeepSeekHarness => dsh_generation(&name).is_some(),
                    _ => false,
                };
                if supported {
                    found.push(entry.path());
                }
            }
        }
    }
    if matches!(source, DesktopSource::DeepSeekHarness) {
        // Format migration freezes old generations. Fork boundaries and
        // projections in the newest generation are the accounting authority.
        let mut latest = BTreeMap::<PathBuf, (u32, PathBuf)>::new();
        for path in found {
            let generation =
                dsh_generation(path.file_name().unwrap().to_str().unwrap_or("")).unwrap();
            let directory = path.parent().unwrap().to_owned();
            match latest.get(&directory) {
                Some((current, previous))
                    if *current > generation
                        || (*current == generation
                            && fs::metadata(previous).and_then(|m| m.modified()).ok()
                                >= fs::metadata(&path).and_then(|m| m.modified()).ok()) => {}
                _ => {
                    latest.insert(directory, (generation, path));
                }
            }
        }
        found = latest.into_values().map(|(_, path)| path).collect();
    }
    found.sort();
    Ok(found)
}

fn dsh_generation(name: &str) -> Option<u32> {
    let plain = name
        .strip_suffix(".zstd")
        .unwrap_or(name)
        .strip_suffix(".jsonl")?;
    if plain == "session" {
        Some(0)
    } else {
        plain.strip_prefix("session.v")?.parse().ok()
    }
}

fn read_records(path: &Path, source: DesktopSource) -> Result<Vec<Record>, AppError> {
    let file = fs::File::open(path)
        .map_err(|e| AppError::Config(format!("读取 {} 用量日志失败: {e}", source.label())))?;
    let reader: Box<dyn Read> = if path.extension().is_some_and(|s| s == "zstd") {
        Box::new(
            zstd::stream::read::Decoder::new(file)
                .map_err(|e| AppError::Config(format!("解压 DSH 用量日志失败: {e}")))?,
        )
    } else {
        Box::new(file)
    };
    let mut reader = BufReader::new(reader.take(MAX_FILE_BYTES + 1));
    let mut buffer = Vec::new();
    let mut consumed = 0u64;
    let mut records = Vec::new();
    let mut session = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_owned();
    if matches!(source, DesktopSource::WorkBuddy) {
        session = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_owned();
    }
    let mut model = None;
    loop {
        buffer.clear();
        let read = reader
            .by_ref()
            .take((MAX_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut buffer)
            .map_err(|e| AppError::Config(format!("解析 {} 用量日志失败: {e}", source.label())))?;
        if read == 0 {
            break;
        }
        consumed += read as u64;
        if consumed > MAX_FILE_BYTES || read > MAX_LINE_BYTES {
            return Err(AppError::Config(format!(
                "{} 用量日志超过安全读取大小",
                source.label()
            )));
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session") {
            if let Some(id) = label(value.get("id")) {
                session = id;
            }
        }
        if value.get("type").and_then(Value::as_str) == Some("request/context") {
            model = label(value.pointer("/data/model"));
        }
        if matches!(source, DesktopSource::DeepSeekHarness)
            && value.get("type").and_then(Value::as_str) == Some("session/end-seed")
            && value.pointer("/data/inherited").and_then(Value::as_bool) == Some(true)
        {
            // Nested forks contain earlier tagged boundaries. Only the LAST
            // tagged marker defines this child's inherited history. Ordinary
            // resume markers have {} and must retain the preceding usage.
            records.clear();
        }
        let record = match source {
            DesktopSource::WorkBuddy => workbuddy(&value, &session),
            DesktopSource::DeepSeekHarness => dsh(&value, &session, model.as_deref()),
            _ => None,
        };
        if let Some(record) = record {
            records.push(record);
        }
    }
    Ok(records)
}

fn open_read_only(path: &Path) -> Result<Connection, AppError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| AppError::Config(format!("只读打开应用用量数据库失败: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    Ok(conn)
}

fn database_records(path: &Path, source: DesktopSource) -> Result<Vec<Record>, AppError> {
    let conn = open_read_only(path)?;
    let mut records = Vec::new();
    match source {
        DesktopSource::ZCode => {
            // Read only metering columns, never messages, rawUsage or credentials.
            let mut query = conn.prepare(
                "SELECT id, session_id, model_id, started_at,
                input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
                FROM model_usage WHERE completed_at IS NOT NULL AND status <> 'pending'",
            )?;
            let rows = query.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, u32>(4)?,
                    row.get::<_, u32>(5)?,
                    row.get::<_, Option<u32>>(6)?,
                    row.get::<_, Option<u32>>(7)?,
                ))
            })?;
            for row in rows {
                let (id, session, model, time, input, output, read, write) = row?;
                // ZCode normalizes inputTokens to inclusive input; reasoning is
                // already included in outputTokens, unlike OpenCode/MiMo.
                let Some(input) =
                    input.checked_sub(read.unwrap_or(0).saturating_add(write.unwrap_or(0)))
                else {
                    continue;
                };
                records.push(Record {
                    id,
                    session,
                    model,
                    created: time / 1000,
                    input,
                    output,
                    read,
                    write,
                    reported_estimate: None,
                });
            }
        }
        DesktopSource::MiMo => {
            let invalid: u32 = conn.query_row(
                "SELECT COUNT(*) FROM message
                WHERE length(CAST(data AS BLOB))>?1 OR NOT json_valid(data)",
                [MAX_LINE_BYTES as i64],
                |r| r.get(0),
            )?;
            if invalid > 0 {
                return Err(AppError::Config(
                    "MiMo 用量行过大或格式无效；已有记录保留".into(),
                ));
            }
            // Project only allow-listed metering fields inside SQLite. Never
            // transfer conversation text/path/tool payloads to this importer.
            let mut query = conn.prepare(
                "SELECT id, session_id,
                json_object('role',json_extract(data,'$.role'),
                    'modelID',json_extract(data,'$.modelID'),
                    'tokens',json(json_extract(data,'$.tokens')),
                    'time',json(json_extract(data,'$.time')),
                    'cost',json_extract(data,'$.cost'))
                FROM message WHERE length(CAST(data AS BLOB))<=?1
                    AND json_valid(data) AND json_extract(data, '$.role') = 'assistant'",
            )?;
            let rows = query.query_map([MAX_LINE_BYTES as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (id, session, data) = row?;
                if data.len() <= MAX_LINE_BYTES {
                    if let Ok(value) = serde_json::from_str(&data) {
                        if let Some(record) = mimo(&value, &id, &session) {
                            records.push(record);
                        }
                    }
                }
            }
        }
        _ => {}
    }
    Ok(records)
}

fn identity(source: DesktopSource, record: &Record) -> String {
    let mut digest = Sha256::new();
    for field in [source.app(), &record.session, &record.id] {
        digest.update((field.len() as u64).to_le_bytes());
        digest.update(field.as_bytes());
    }
    format!("desktop-{:x}", digest.finalize())
}

fn insert(conn: &Connection, source: DesktopSource, record: &Record) -> Result<bool, AppError> {
    let id = identity(source, record);
    let data_source = source.data_source();
    let seen: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_usage_dedup WHERE data_source=?1 AND request_id=?2)",
        rusqlite::params![data_source, id],
        |r| r.get(0),
    )?;
    if seen {
        return Ok(false);
    }
    // Settle before import so a routed request has time to be logged. Match
    // exact normalized counters + model + time, and claim at most one local
    // record for each gateway request. The durable ledger survives pruning.
    let fresh = fresh_input_sql("l");
    // This is the exact provider ID emitted by our one-click configuration.
    // Never truncate arbitrary vendor/model paths at their final slash.
    let published_model = record
        .model
        .strip_prefix("lolicode/")
        .unwrap_or(&record.model);
    let proxy: Option<String> = conn.query_row(&format!("SELECT l.request_id FROM proxy_request_logs l
        WHERE l.app_type IN ('channel-gateway',?7) AND COALESCE(l.data_source,'proxy')='proxy'
        AND (l.model=?1 OR l.request_model=?1 OR l.request_model=?8)
        AND {fresh}=?2 AND l.output_tokens=?3 AND l.cache_read_tokens=?4
        AND l.cache_creation_tokens=?5 AND l.created_at BETWEEN ?6-600 AND ?6+10
        AND (ABS(l.created_at-?6)<=10 OR ABS(l.created_at+COALESCE(l.latency_ms,0)/1000-?6)<=10)
        AND NOT EXISTS(SELECT 1 FROM session_usage_dedup d WHERE d.semantic_id='gateway:'||l.request_id)
        ORDER BY ABS(l.created_at-?6) LIMIT 1"), rusqlite::params![record.model, record.input,
        record.output, record.read.unwrap_or(0), record.write.unwrap_or(0), record.created, source.app(), published_model], |r| r.get(0)).optional()?;
    let semantic = proxy
        .as_ref()
        .map(|p| format!("gateway:{p}"))
        .unwrap_or_else(|| id.clone());
    conn.execute("INSERT OR IGNORE INTO session_usage_dedup(data_source,request_id,semantic_id,has_entry_id) VALUES(?1,?2,?3,1)",
        rusqlite::params![data_source, id, semantic])?;
    if proxy.is_some() {
        return Ok(false);
    }
    let usage = TokenUsage {
        input_tokens: record.input,
        output_tokens: record.output,
        cache_read_tokens: record.read.unwrap_or(0),
        cache_creation_tokens: record.write.unwrap_or(0),
        cache_creation_1h_tokens: 0,
        reported_cost_usd: None,
        model: Some(record.model.clone()),
        message_id: None,
    };
    let estimate = find_model_pricing(conn, &record.model).map(|pricing| {
        CostCalculator::calculate_for_app(source.app(), &usage, &pricing, Decimal::ONE)
    });
    let classification = if record.reported_estimate.is_some() {
        "reported-estimate"
    } else if estimate.is_some() && record.read.is_some() && record.write.is_some() {
        "estimated"
    } else {
        "unpriced"
    };
    // Missing cache counters can affect the price, so don't present a partial
    // local price as a complete estimate. Still retain the real token counters.
    let total = record
        .reported_estimate
        .or_else(|| (classification == "estimated").then(|| estimate.as_ref().unwrap().total_cost));
    let metadata = format!(
        "desktop-usage:{classification}:{}",
        if record.read.is_some() && record.write.is_some() {
            "cache-reported"
        } else {
            "cache-partial"
        }
    );
    let provider = format!("_{}_session", source.app());
    let parts = if classification == "estimated" {
        let value = estimate.as_ref().unwrap();
        [
            value.input_cost,
            value.output_cost,
            value.cache_read_cost,
            value.cache_creation_cost,
        ]
        .map(|n| n.to_string())
    } else {
        std::array::from_fn(|_| "0".to_string())
    };
    conn.execute("INSERT OR IGNORE INTO proxy_request_logs(
        request_id,provider_id,app_type,model,request_model,pricing_model,input_tokens,output_tokens,
        cache_read_tokens,cache_creation_tokens,input_token_semantics,
        input_cost_usd,output_cost_usd,cache_read_cost_usd,cache_creation_cost_usd,total_cost_usd,
        latency_ms,status_code,session_id,provider_type,is_streaming,cost_multiplier,created_at,data_source)
        VALUES(?1,?2,?3,?4,?4,?4,?5,?6,?7,?8,?9,?15,?16,?17,?18,?10,0,200,?11,?12,1,'1.0',?13,?14)",
        rusqlite::params![id,provider,source.app(),record.model,record.input,record.output,
            record.read.unwrap_or(0),record.write.unwrap_or(0),INPUT_TOKEN_SEMANTICS_FRESH,
            total.unwrap_or(Decimal::ZERO).to_string(),record.session,metadata,record.created,data_source,
            parts[0],parts[1],parts[2],parts[3]])
        .map(|changed| changed > 0).map_err(AppError::from)
}

fn sync_path(
    db: &Database,
    source: DesktopSource,
    path: &Path,
    now: i64,
) -> Result<SessionSyncResult, AppError> {
    let mut result = SessionSyncResult::default();
    match fs::metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(error) => return Err(AppError::io(path, error)),
    }
    let paths = match source {
        DesktopSource::ZCode | DesktopSource::MiMo => vec![path.to_owned()],
        _ => files(path, source)?,
    };
    let cursors = crate::services::session_usage::load_sync_cursors(db)?;
    for path in paths {
        result.files_scanned += 1;
        let key = format!("desktop-usage-v1:{}:{}", source.app(), path.display());
        let mut modified = fs::metadata(&path)
            .map(|m| metadata_modified_nanos(&m))
            .unwrap_or(0);
        if matches!(source, DesktopSource::ZCode | DesktopSource::MiMo) {
            if let Ok(meta) = fs::metadata(format!("{}-wal", path.display())) {
                modified = modified.max(metadata_modified_nanos(&meta));
            }
        }
        if modified > 0
            && cursors
                .get(&key)
                .is_some_and(|c| c.last_modified == modified)
        {
            continue;
        }
        let records = match source {
            DesktopSource::ZCode | DesktopSource::MiMo => database_records(&path, source),
            _ => read_records(&path, source),
        };
        let records = match records {
            Ok(records) => records,
            Err(e) => {
                result
                    .errors
                    .push(format!("{} 用量读取失败: {e}", source.label()));
                continue;
            }
        };
        let mut deferred = false;
        let mut ids = HashSet::new();
        let mut conn = lock_conn!(db.conn);
        let tx = conn.transaction()?;
        for record in records {
            if record.created > now - SETTLE_SECONDS {
                deferred = true;
                continue;
            }
            if record.model.is_empty()
                || record.created <= 0
                || (record.input == 0
                    && record.output == 0
                    && record.read.unwrap_or(0) == 0
                    && record.write.unwrap_or(0) == 0)
            {
                continue;
            }
            if !ids.insert(identity(source, &record)) {
                continue;
            }
            if insert(&tx, source, &record)? {
                result.imported += 1;
            } else {
                result.skipped += 1;
            }
        }
        if deferred {
            result.deferred_files += 1;
        } else {
            update_sync_state_on_conn(&tx, &key, modified, 0)?;
        }
        tx.commit()?;
    }
    Ok(result)
}

pub fn sync_desktop_usage(db: &Database) -> SessionSyncResult {
    let mut result = SessionSyncResult::default();
    let now = chrono::Utc::now().timestamp();
    for source in DesktopSource::ALL {
        let mut failed = false;
        match source.paths() {
            Ok(paths) => {
                for path in paths {
                    match sync_path(db, source, &path, now) {
                        Ok(next) => {
                            failed |= !next.errors.is_empty();
                            result.merge(next);
                        }
                        Err(error) => {
                            result
                                .errors
                                .push(format!("{} 用量同步失败: {error}", source.label()));
                            failed = true;
                        }
                    }
                }
            }
            Err(error) => {
                result.errors.push(error.to_string());
                failed = true;
            }
        }
        let bit = 1 << source as u8;
        if failed {
            READ_FAILURES.fetch_or(bit, Ordering::Relaxed);
        } else {
            READ_FAILURES.fetch_and(!bit, Ordering::Relaxed);
        }
    }
    result
}

#[cfg(test)]
mod tests;
