use super::*;
use serde_json::json;

fn wb(id: &str, input: u32) -> Value {
    json!({
        "type":"function_call","id":"content-block","sessionId":"session-a",
        "timestamp":"2025-01-01T00:00:00Z","arguments":"PRIVATE CONTENT MUST NOT BE STORED",
        "providerData":{"messageId":id,"model":"fixture-model","usage":{
            "inputTokens":input,"outputTokens":20,"inputTokensDetails":[{"cached_tokens":80}]}}
    })
}
fn save(path: &Path, values: &[Value]) {
    fs::write(
        path,
        values
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
}
fn rows(db: &Database) -> Vec<(String, u32, u32, u32, String, String)> {
    let conn = db.conn.lock().unwrap();
    let result = conn.prepare("SELECT app_type,input_tokens,output_tokens,cache_read_tokens,total_cost_usd,COALESCE(provider_type,'') FROM proxy_request_logs ORDER BY created_at,request_id").unwrap()
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap()
        .collect::<Result<Vec<_>,_>>().unwrap();
    result
}

#[test]
fn workbuddy_reads_actual_usage_once_and_never_treats_context_size_as_tokens(
) -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("s.jsonl");
    let first = wb("message-1", 100);
    let second = wb("message-2", 100);
    save(
        &file,
        &[
            first.clone(),
            first.clone(),
            second,
            json!({"type":"usage","used":999,"size":192000}),
        ],
    );
    let db = Database::memory()?;
    let result = sync_path(&db, DesktopSource::WorkBuddy, root.path(), 1_800_000_000)?;
    assert_eq!(result.imported, 2);
    let actual = rows(&db);
    assert_eq!(actual.len(), 2);
    assert_eq!(
        (&actual[0].0, actual[0].1, actual[0].2, actual[0].3),
        (&"workbuddy".to_string(), 20, 20, 80)
    );
    assert_eq!(actual[0].4, "0");
    assert!(actual[0].5.contains("unpriced:cache-partial"));
    // A renamed/exported copy with the same session and message identity is not new spend.
    save(&root.path().join("renamed.jsonl"), &[first]);
    assert_eq!(
        sync_path(&db, DesktopSource::WorkBuddy, root.path(), 1_800_000_000)?.imported,
        0
    );
    let conn = lock_conn!(db.conn);
    let private:i64=conn.query_row("SELECT COUNT(*) FROM proxy_request_logs WHERE error_message LIKE '%PRIVATE%' OR model LIKE '%PRIVATE%'",[],|r|r.get(0))?;
    assert_eq!(private, 0);
    Ok(())
}

#[test]
fn durable_dedup_survives_pruning_and_log_rewrite() -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("s.jsonl");
    save(&file, &[wb("m", 100)]);
    let db = Database::memory()?;
    assert_eq!(
        sync_path(&db, DesktopSource::WorkBuddy, root.path(), 1_800_000_000)?.imported,
        1
    );
    {
        let conn = lock_conn!(db.conn);
        conn.execute("DELETE FROM proxy_request_logs", [])?;
        conn.execute("DELETE FROM session_log_sync", [])?;
    }
    assert_eq!(
        sync_path(&db, DesktopSource::WorkBuddy, root.path(), 1_800_000_000)?.imported,
        0
    );
    assert!(rows(&db).is_empty());
    Ok(())
}

#[test]
fn dsh_imports_terminal_messages_and_compaction_but_not_chunks_or_shadow_streams(
) -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("session");
    fs::create_dir(&dir).unwrap();
    let entries = vec![
        json!({"type":"session","id":"dsh-session"}),
        json!({"type":"request/context","data":{"model":"fixture-model","provider":"local"}}),
        json!({"type":"assistant/chunk","seq":2,"time":1_700_000_000_000i64,"data":{"chunk":{"usage":{"inputTokens":90000,"outputTokens":90000}}}}),
        json!({"type":"assistant/message","seq":3,"time":1_700_000_001_000i64,"data":{"message":{"id":"reply-1","content":"SECRET TEXT"},"usage":{"inputTokens":100,"outputTokens":20,"cacheReadTokens":80,"cacheWriteTokens":0}}}),
        json!({"type":"compaction/summary","seq":4,"time":1_700_000_002_000i64,"data":{"compactionId":"compact-1","model":"fixture-model","usage":{"inputTokens":2,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0},"stream":[{"chunk":{"usage":{"inputTokens":99999}}}]}}),
    ];
    let bytes = entries
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(
        dir.join("session.v4.jsonl.zstd"),
        zstd::encode_all(bytes.as_bytes(), 1).unwrap(),
    )
    .unwrap();
    let db = Database::memory()?;
    let result = sync_path(
        &db,
        DesktopSource::DeepSeekHarness,
        root.path(),
        1_800_000_000,
    )?;
    assert_eq!(result.imported, 2);
    assert_eq!(rows(&db).iter().map(|r| r.1).sum::<u32>(), 102);
    assert!(rows(&db).iter().all(|r| r.0 == "deepseek-harness"));
    Ok(())
}

#[test]
fn mimo_uses_own_source_and_local_reported_estimate_not_official_bill() -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mimocode.db");
    let c = Connection::open(&path)?;
    c.execute_batch("CREATE TABLE message(id TEXT,session_id TEXT,data TEXT);")?;
    let v = json!({"role":"assistant","modelID":"mimo-v2.6-pro","time":{"created":1_700_000_000_000i64,"completed":1_700_000_010_000i64},"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":80,"write":0}},"cost":0.00123});
    c.execute(
        "INSERT INTO message VALUES('reply','session',?1)",
        [v.to_string()],
    )?;
    let mut pending = v.clone();
    pending["time"]["completed"] = Value::Null;
    c.execute(
        "INSERT INTO message VALUES('pending','session',?1)",
        [pending.to_string()],
    )?;
    let db = Database::memory()?;
    let result = sync_path(&db, DesktopSource::MiMo, &path, 1_800_000_000)?;
    assert_eq!(result.imported, 1);
    let actual = rows(&db);
    assert_eq!(
        (&actual[0].0, actual[0].1, actual[0].2),
        (&"mimocode".to_string(), 100, 25)
    );
    assert_eq!(actual[0].4, "0.00123");
    assert!(actual[0].5.contains("reported-estimate"));
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM message", [], |r| r.get::<_, u32>(0))?,
        2
    );
    Ok(())
}

#[test]
fn zcode_normalizes_inclusive_input_and_does_not_add_reasoning_twice() -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("zcode.sqlite");
    let c = Connection::open(&path)?;
    c.execute_batch("CREATE TABLE model_usage(id TEXT,session_id TEXT,model_id TEXT,started_at INTEGER,completed_at INTEGER,status TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,cache_creation_input_tokens INTEGER);
        INSERT INTO model_usage VALUES('r1','s','fixture-model',1700000000000,1700000001000,'completed',100,20,80,0);
        INSERT INTO model_usage VALUES('r2','s','fixture-model',1700000001000,NULL,'pending',100,20,80,0);
        INSERT INTO model_usage VALUES('r3','s','fixture-model',1700000002000,1700000003000,'error',0,0,0,0);")?;
    let db = Database::memory()?;
    assert_eq!(
        sync_path(&db, DesktopSource::ZCode, &path, 1_800_000_000)?.imported,
        1
    );
    let actual = rows(&db);
    assert_eq!((actual[0].1, actual[0].2, actual[0].3), (20, 20, 80));
    Ok(())
}

#[test]
fn settling_defers_cursor_and_retries_even_when_file_has_not_changed() -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    save(&root.path().join("s.jsonl"), &[wb("m", 100)]);
    let db = Database::memory()?;
    let time = 1_735_689_600;
    let first = sync_path(&db, DesktopSource::WorkBuddy, root.path(), time + 10)?;
    assert_eq!((first.imported, first.deferred_files), (0, 1));
    assert_eq!(
        sync_path(&db, DesktopSource::WorkBuddy, root.path(), time + 100)?.imported,
        1
    );
    Ok(())
}

#[test]
fn routed_requests_are_claimed_once_without_collapsing_two_real_identical_requests(
) -> Result<(), AppError> {
    for app in ["channel-gateway", "workbuddy"] {
        let db = Database::memory()?;
        let mut c = lock_conn!(db.conn);
        c.execute("INSERT INTO proxy_request_logs(request_id,provider_id,app_type,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,total_cost_usd,latency_ms,status_code,created_at,data_source,input_token_semantics)
        VALUES('gateway-request','channel-fixture','channel-gateway','fixture-model',20,20,80,0,'0.01',0,200,1700000000,'proxy',2)",[])?;
        c.execute(
            "UPDATE proxy_request_logs SET app_type=?1,created_at=created_at-100,latency_ms=100000",
            [app],
        )?;
        let record = Record {
            id: "local-1".into(),
            session: "s".into(),
            model: "fixture-model".into(),
            created: 1_700_000_000,
            input: 20,
            output: 20,
            read: Some(80),
            write: Some(0),
            reported_estimate: None,
        };
        let tx = c.transaction()?;
        assert!(!insert(&tx, DesktopSource::WorkBuddy, &record)?);
        let second = Record {
            id: "local-2".into(),
            ..record
        };
        assert!(insert(&tx, DesktopSource::WorkBuddy, &second)?);
        tx.commit()?;
        drop(c);
        assert_eq!(rows(&db).len(), 2);
    }
    Ok(())
}

#[test]
fn malformed_and_oversized_usage_counters_are_not_invented() {
    let mut value = wb("bad", 100);
    value["providerData"]["usage"]["inputTokens"] = json!(-1);
    assert!(workbuddy(&value, "s").is_none());
    assert_eq!(
        cost(Some(&json!("2e-7"))),
        Some(Decimal::from_scientific("2e-7").unwrap())
    );
    assert_eq!(cost(Some(&json!(-0.01))), None);
    value["providerData"]["usage"]["inputTokens"] = json!(u64::MAX);
    assert!(workbuddy(&value, "s").is_none());
    value["providerData"]["usage"]["inputTokens"] = json!(10);
    assert!(workbuddy(&value, "s").is_none());
}

#[test]
fn later_price_sync_cannot_invent_missing_cache_counts() -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    let mut value = wb("partial", 100);
    value["providerData"]["model"] = json!("gpt-5.4");
    save(&root.path().join("s.jsonl"), &[value]);
    let db = Database::memory()?;
    assert_eq!(
        sync_path(&db, DesktopSource::WorkBuddy, root.path(), 1_800_000_000)?.imported,
        1
    );
    db.backfill_missing_usage_costs()?;
    assert_eq!(rows(&db)[0].4, "0");
    let summaries = crate::services::session_usage::get_data_source_breakdown(&db)?;
    let source = summaries
        .iter()
        .find(|source| source.app_type.as_deref() == Some("workbuddy"))
        .unwrap();
    assert_eq!(source.unpriced_requests, Some(1));
    assert_eq!(source.cache_partial_requests, Some(1));
    Ok(())
}

/// Explicit opt-in, read-only local acceptance. It writes only a fresh in-memory
/// LoliCode database and prints aggregate counts, never message bodies or keys.
#[test]
#[ignore]
fn local_desktop_sources_acceptance_read_only() -> Result<(), AppError> {
    let db = Database::memory()?;
    for source in DesktopSource::ALL {
        let mut result = SessionSyncResult::default();
        for path in source.paths()? {
            result.merge(sync_path(
                &db,
                source,
                &path,
                chrono::Utc::now().timestamp(),
            )?);
        }
        println!(
            "{} imported={} files={} deferred={} errors={}",
            source.label(),
            result.imported,
            result.files_scanned,
            result.deferred_files,
            result.errors.len()
        );
        assert!(
            result.errors.is_empty(),
            "{} schema unsupported",
            source.label()
        );
    }
    let repeat = sync_desktop_usage(&db);
    assert_eq!(repeat.imported, 0);
    Ok(())
}

#[test]
fn configured_client_routes_match_request_model_without_truncating_vendor_ids(
) -> Result<(), AppError> {
    for source in DesktopSource::ALL {
        for (model, duplicate) in [
            ("channel-fixture/fixture-model", true),
            ("lolicode/channel-fixture/fixture-model", true),
            ("vendor/fixture-model", false),
        ] {
            let db = Database::memory()?;
            let mut conn = lock_conn!(db.conn);
            conn.execute("INSERT INTO proxy_request_logs(request_id,provider_id,app_type,model,request_model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,total_cost_usd,latency_ms,status_code,created_at,data_source,input_token_semantics)
                VALUES('gateway','channel-fixture',?1,'fixture-model','channel-fixture/fixture-model',20,20,80,0,'0.01',0,200,1700000000,'proxy',2)",[source.app()])?;
            let record = Record {
                id: "local".into(),
                session: "s".into(),
                model: model.into(),
                created: 1_700_000_000,
                input: 20,
                output: 20,
                read: Some(80),
                write: Some(0),
                reported_estimate: None,
            };
            let tx = conn.transaction()?;
            assert_eq!(
                insert(&tx, source, &record)?,
                !duplicate,
                "{} {model}",
                source.app()
            );
            tx.commit()?;
        }
    }
    Ok(())
}

#[test]
fn path_discovery_preserves_legacy_roots_and_honors_explicit_overrides() -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    let base = root.path();
    let mut locations = SourceLocations {
        home: base.into(),
        local_data: Some(base.join("local")),
        xdg_data: None,
        mimo_home: None,
        mimo_db: None,
        dsh_home: None,
    };
    assert_eq!(
        source_paths(DesktopSource::WorkBuddy, &locations)?,
        vec![
            base.join(".workbuddy/projects"),
            base.join(".workbuddy-ai/projects")
        ]
    );
    assert_eq!(
        source_paths(DesktopSource::MiMo, &locations)?,
        vec![
            base.join(".local/share/mimocode/mimocode.db"),
            base.join("local/mimocode/mimocode.db")
        ]
    );
    locations.xdg_data = Some(base.join("xdg"));
    assert_eq!(
        source_paths(DesktopSource::MiMo, &locations)?,
        vec![base.join("xdg/mimocode/mimocode.db")]
    );
    locations.mimo_home = Some(base.join("mimo"));
    assert_eq!(
        source_paths(DesktopSource::MiMo, &locations)?,
        vec![base.join("mimo/data/mimocode.db")]
    );
    locations.mimo_db = Some(base.join("direct.db"));
    assert_eq!(
        source_paths(DesktopSource::MiMo, &locations)?,
        vec![base.join("direct.db")]
    );
    locations.dsh_home = Some(base.join("harness"));
    assert_eq!(
        source_paths(DesktopSource::DeepSeekHarness, &locations)?,
        vec![base.join("harness/sessions")]
    );
    locations.mimo_db = Some(PathBuf::from("relative.db"));
    assert!(source_paths(DesktopSource::MiMo, &locations).is_err());
    Ok(())
}

#[test]
fn directory_read_errors_are_reported_instead_of_becoming_empty_usage() -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("not-a-directory");
    fs::write(&file, "fixture").unwrap();
    let db = Database::memory()?;
    assert!(sync_path(&db, DesktopSource::WorkBuddy, &file, 1_800_000_000).is_err());
    assert!(rows(&db).is_empty());
    Ok(())
}

#[test]
fn mimo_rejects_oversized_rows_before_transferring_payloads() -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oversized.db");
    let conn = Connection::open(&path)?;
    conn.execute_batch("CREATE TABLE message(id TEXT,session_id TEXT,data TEXT);")?;
    conn.execute("INSERT INTO message VALUES('m','s',json_object('role','assistant','content',hex(zeroblob(?1))))",[(MAX_LINE_BYTES/2+1) as i64])?;
    assert!(database_records(&path, DesktopSource::MiMo).is_err());
    Ok(())
}

#[test]
fn dsh_nested_forks_exclude_only_the_last_tagged_inherited_prefix() -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("session.v4.jsonl");
    let terminal = |seq: i64, input: u32, kind: &str| {
        json!({"type":kind,"seq":seq,"time":1700000000000i64+seq*1000,
        "data":{"usage":{"inputTokens":input,"outputTokens":20,"cacheReadTokens":0,"cacheWriteTokens":0}}})
    };
    save(
        &file,
        &[
            json!({"type":"session","id":"nested","parentSession":"parent","isSeeded":true}),
            json!({"type":"request/context","data":{"model":"fixture-model"}}),
            terminal(1, 100, "assistant/message"),
            json!({"type":"session/end-seed","seq":2,"data":{"inherited":true}}),
            terminal(3, 200, "assistant/message"),
            json!({"type":"session/end-seed","seq":4,"data":{"inherited":true}}),
            terminal(5, 3, "assistant/message"),
            json!({"type":"session/end-seed","seq":6,"data":{}}),
            terminal(7, 2, "assistant/attempt"),
        ],
    );
    let records = read_records(&file, DesktopSource::DeepSeekHarness)?;
    assert_eq!(records.len(), 2);
    assert_eq!(records.iter().map(|r| r.input).sum::<u32>(), 5);
    assert!(records.iter().all(|r| r.model == "fixture-model"));
    // Restore markers alone are not fork boundaries.
    save(
        &file,
        &[
            json!({"type":"request/context","data":{"model":"fixture-model"}}),
            terminal(1, 100, "assistant/message"),
            json!({"type":"session/end-seed","seq":2,"data":{}}),
            terminal(3, 2, "assistant/message"),
        ],
    );
    assert_eq!(
        read_records(&file, DesktopSource::DeepSeekHarness)?.len(),
        2
    );
    Ok(())
}

#[test]
fn dsh_uses_latest_generation_instead_of_importing_frozen_pre_fork_files() -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    let entries = |input| {
        vec![
            json!({"type":"session","id":"s"}),
            json!({"type":"request/context","data":{"model":"fixture-model"}}),
            json!({"type":"assistant/message","seq":1,"time":1700000000000i64,"data":{"usage":{"inputTokens":input,"outputTokens":1}}}),
        ]
    };
    save(&root.path().join("session.jsonl"), &entries(10000));
    save(&root.path().join("session.v4.jsonl"), &entries(2));
    let db = Database::memory()?;
    assert_eq!(
        sync_path(
            &db,
            DesktopSource::DeepSeekHarness,
            root.path(),
            1_800_000_000
        )?
        .imported,
        1
    );
    assert_eq!(rows(&db)[0].1, 2);
    Ok(())
}

#[test]
fn desktop_source_keeps_recorded_history_after_detail_pruning() -> Result<(), AppError> {
    let root = tempfile::tempdir().unwrap();
    save(&root.path().join("s.jsonl"), &[wb("old", 100)]);
    let db = Database::memory()?;
    assert_eq!(
        sync_path(&db, DesktopSource::WorkBuddy, root.path(), 1_800_000_000)?.imported,
        1
    );
    assert_eq!(db.rollup_and_prune(30)?, 1);
    assert!(rows(&db).is_empty());
    let sources = crate::services::session_usage::get_data_source_breakdown(&db)?;
    let source = sources
        .iter()
        .find(|s| s.app_type.as_deref() == Some("workbuddy"))
        .unwrap();
    assert_eq!(source.request_count, 1);
    assert_eq!(source.historical_requests, Some(1));
    assert_eq!(source.status.as_deref(), Some("recorded"));
    Ok(())
}
