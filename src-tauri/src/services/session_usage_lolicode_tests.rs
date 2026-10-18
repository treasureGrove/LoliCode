use super::*;
use serde_json::{json, Value};

const START: u64 = 1_000_000;
const END: u64 = START + 5_000;
const NOW: i64 = END as i64 + 120_000;

fn request() -> Value {
    json!({"messageId":format!("assistant-{}",uuid::Uuid::new_v4()),"taskId":"ignored",
        "startedAt":START,"completedAt":END,"tokens":{"inputTokens":100,"outputTokens":10,
            "cacheReadTokens":20,"cacheWriteTokens":0,"cacheInputTokens":100}})
}
fn write_session(root: &Path, requests: Vec<Value>) -> std::path::PathBuf {
    let id = uuid::Uuid::new_v4();
    let path = root.join(format!("{id}.json"));
    fs::write(
        &path,
        json!({"format":1,"snapshot":{"session":{"id":format!("lc:{id}")},
        "messages":[{"content":"private text must not be imported"}]},"history":["not read"],
        "usageLedger":{"requests":requests}})
        .to_string(),
    )
    .unwrap();
    path
}
fn row(db: &Database, id: &str, app: &str) {
    let conn = db.conn.lock().unwrap();
    conn.execute("INSERT INTO proxy_request_logs(request_id,provider_id,app_type,model,request_model,pricing_model,
        input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,input_token_semantics,
        total_cost_usd,latency_ms,status_code,created_at,data_source,session_id)
        VALUES(?1,'channel-fixture',?2,'vendor/model','source/vendor/model','vendor/model',80,10,20,0,2,
            '0.125',5000,200,1005,'proxy','old-generated-session')", params![id,app]).unwrap();
}
fn counts(db: &Database) -> (u32, u32) {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT COUNT(*),COALESCE(SUM(app_type='lolicode'),0) FROM proxy_request_logs",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

#[test]
fn repairs_attribution_without_adding_bills_and_updates_app_and_channel_summaries() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::memory().unwrap();
    write_session(dir.path(), vec![request()]);
    row(&db, "bill", "channel-gateway");
    let before = db.get_usage_summary(None, None, None, None, None).unwrap();
    let result = sync_at(&db, dir.path(), NOW).unwrap();
    assert_eq!(result.imported, 1);
    assert!(result.errors.is_empty());
    assert_eq!(counts(&db), (1, 1));
    let after = db.get_usage_summary(None, None, None, None, None).unwrap();
    assert_eq!(before.total_requests, after.total_requests);
    assert_eq!(before.total_cost, after.total_cost);
    assert_eq!(before.real_total_tokens, after.real_total_tokens);
    let own = db
        .get_usage_summary(None, None, Some("lolicode"), None, None)
        .unwrap();
    assert_eq!(own.total_requests, 1);
    assert_eq!(own.real_total_tokens, 110);
    assert_eq!(own.total_cost, "0.125000");
    let channels = db
        .get_provider_stats(None, None, Some("lolicode"), None, None)
        .unwrap();
    assert_eq!(channels[0].provider_id, "channel-fixture");
    assert_eq!(channels[0].request_count, 1);
    let conn = db.conn.lock().unwrap();
    let (id, model, source, cost, session): (String, String, String, String, String) = conn
        .query_row(
            "SELECT request_id,model,data_source,total_cost_usd,session_id FROM proxy_request_logs",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(
        (id.as_str(), model.as_str(), source.as_str(), cost.as_str()),
        ("bill", "vendor/model", "proxy", "0.125")
    );
    assert!(session.starts_with("lc:"));
    drop(conn);
    assert_eq!(sync_at(&db, dir.path(), NOW).unwrap().imported, 0);
    // A re-read after file changes or pruning never creates another bill.
    db.conn
        .lock()
        .unwrap()
        .execute("DELETE FROM session_log_sync", [])
        .unwrap();
    assert_eq!(sync_at(&db, dir.path(), NOW).unwrap().imported, 0);
    assert_eq!(counts(&db), (1, 1));
    db.conn
        .lock()
        .unwrap()
        .execute("DELETE FROM proxy_request_logs", [])
        .unwrap();
    db.conn
        .lock()
        .unwrap()
        .execute("DELETE FROM session_log_sync", [])
        .unwrap();
    assert_eq!(sync_at(&db, dir.path(), NOW).unwrap().imported, 0);
    assert_eq!(counts(&db), (0, 0));
}

#[test]
fn ambiguous_matches_never_pick_the_first_bill_or_the_first_local_request() {
    for many_bills in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::memory().unwrap();
        let mut requests = vec![request()];
        if !many_bills {
            requests.push(request());
        }
        write_session(dir.path(), requests);
        row(&db, "one", "channel-gateway");
        if many_bills {
            row(&db, "two", "channel-gateway");
        }
        assert_eq!(sync_at(&db, dir.path(), NOW).unwrap().imported, 0);
        assert_eq!(counts(&db).1, 0);
    }
}

#[test]
fn preserves_other_apps_unmatched_requests_and_rows_already_claimed_by_an_importer() {
    for case in [
        "other-app",
        "wrong-time",
        "wrong-tokens",
        "claimed",
        "already-correct",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::memory().unwrap();
        write_session(dir.path(), vec![request()]);
        row(
            &db,
            "bill",
            match case {
                "other-app" => "codex",
                "already-correct" => "lolicode",
                _ => "channel-gateway",
            },
        );
        match case {
            "wrong-time" => {
                db.conn
                    .lock()
                    .unwrap()
                    .execute("UPDATE proxy_request_logs SET created_at=900", [])
                    .unwrap();
            }
            "wrong-tokens" => {
                db.conn
                    .lock()
                    .unwrap()
                    .execute("UPDATE proxy_request_logs SET input_tokens=81", [])
                    .unwrap();
            }
            "claimed" => {
                db.conn
                    .lock()
                    .unwrap()
                    .execute(
                        "INSERT INTO session_usage_dedup VALUES('other','entry','gateway:bill',1)",
                        [],
                    )
                    .unwrap();
            }
            _ => {}
        }
        assert_eq!(sync_at(&db, dir.path(), NOW).unwrap().imported, 0, "{case}");
        assert_eq!(
            counts(&db),
            (1, if case == "already-correct" { 1 } else { 0 })
        );
    }
}

#[test]
fn a_missing_write_counter_is_matched_against_the_actual_inclusive_total_not_invented() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::memory().unwrap();
    let mut meter = request();
    meter["tokens"]
        .as_object_mut()
        .unwrap()
        .remove("cacheWriteTokens");
    meter["tokens"]["inputTokens"] = json!(130);
    meter["tokens"]["cacheInputTokens"] = json!(130);
    write_session(dir.path(), vec![meter]);
    row(&db, "bill", "channel-gateway");
    db.conn
        .lock()
        .unwrap()
        .execute("UPDATE proxy_request_logs SET cache_creation_tokens=30", [])
        .unwrap();
    assert_eq!(sync_at(&db, dir.path(), NOW).unwrap().imported, 1);
    assert_eq!(
        db.get_usage_summary(None, None, Some("lolicode"), None, None)
            .unwrap()
            .total_cache_creation_tokens,
        30
    );
}

#[test]
fn recent_requests_are_retried_after_settling_and_incomplete_usage_is_not_fabricated() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::memory().unwrap();
    write_session(dir.path(), vec![request()]);
    row(&db, "bill", "channel-gateway");
    let early = sync_at(&db, dir.path(), END as i64 + 1000).unwrap();
    assert_eq!(early.imported, 0);
    assert_eq!(early.deferred_files, 1);
    assert_eq!(sync_at(&db, dir.path(), NOW).unwrap().imported, 1);
    for field in ["outputTokens", "cacheReadTokens", "cacheInputTokens"] {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::memory().unwrap();
        let mut meter = request();
        meter["tokens"].as_object_mut().unwrap().remove(field);
        write_session(dir.path(), vec![meter]);
        row(&db, "bill", "channel-gateway");
        assert_eq!(
            sync_at(&db, dir.path(), NOW).unwrap().imported,
            0,
            "{field}"
        );
    }
}

#[test]
fn malformed_or_mismatched_session_files_leave_existing_bills_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::memory().unwrap();
    let path = write_session(dir.path(), vec![request()]);
    row(&db, "bill", "channel-gateway");
    let mut data: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    data["snapshot"]["session"]["id"] = json!(format!("lc:{}", uuid::Uuid::new_v4()));
    fs::write(&path, data.to_string()).unwrap();
    let result = sync_at(&db, dir.path(), NOW).unwrap();
    assert_eq!(result.imported, 0);
    assert_eq!(result.errors.len(), 1);
    fs::write(&path, "invalid secret text").unwrap();
    let result = sync_at(&db, dir.path(), NOW).unwrap();
    assert_eq!(result.errors.len(), 1);
    assert!(!result.errors[0].contains("secret"));
    assert_eq!(counts(&db), (1, 0));
}
