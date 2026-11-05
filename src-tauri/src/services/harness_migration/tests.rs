use super::*;
use lolicode_agent::{AgentPart, AgentStatus};
use serde_json::json;
use std::{sync::Barrier, thread};

const RAW_ID: &str = "12345678-1234-4321-8765-123456789abc";
const LOLI_ID: &str = "lc:12345678-1234-4321-8765-123456789abc";
const PRIVATE_CONTEXT: &str = "private tool context survives only in the legacy record";

fn legacy_fixture() -> Value {
    json!({
        "format": 1,
        "snapshot": {
            "session": {
                "id": LOLI_ID, "title": "Original chat", "projectPath": "D:/owned/project",
                "mode": "build", "permissionMode": "ask", "model": null,
                "createdAt": 10, "updatedAt": 20, "coordination": { "role": "secretary" }
            },
            "status": "running",
            "messages": [{
                "id": "msg_first", "role": "user", "createdAt": 11, "completedAt": 11,
                "parts": [{"type": "text", "text": "Original chat message"}]
            }],
            "permissions": [], "questions": [], "diffs": [], "error": null,
            "streamConnected": true, "streamGap": false,
            "queuedMessages": [{"id":"msg_queued", "text":"Queued", "createdAt":21, "attachments":[]}]
        },
        "history": [{ "role": "tool", "tool_call_id": "historical-call", "content": PRIVATE_CONTEXT }],
        "commands": { "msg_first": { "text": "Original chat message", "status": "completed" } },
        "contextSummary": "Old context checkpoint",
        "secretaryTasks": [{
            "id": "task_finished", "parentSessionId": LOLI_ID,
            "sessionId": "lc:12345678-1234-4321-8765-123456789abb", "title": "Old worker",
            "instructions": "Keep the old result", "status": "completed", "createdAt": 13,
            "updatedAt": 20, "projectPath": "D:/owned/project", "requestId": "req_worker"
        }],
        "unknownOldField": { "keepExactly": "Do not rewrite" }
    })
}

fn write_source(root: &Path, value: &Value) -> PathBuf {
    let sessions = root.join("agent/native/sessions");
    fs::create_dir_all(&sessions).unwrap();
    let path = sessions.join(format!("{RAW_ID}.json"));
    fs::write(&path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
    path
}

#[test]
fn reads_native_snapshot_context_and_secretary_without_repairing_or_writing() {
    let profile = tempfile::tempdir().unwrap();
    let path = write_source(profile.path(), &legacy_fixture());
    let original = fs::read(&path).unwrap();
    let migration = HarnessMigration::new(profile.path()).unwrap();

    let legacy = migration.read_legacy(LOLI_ID).unwrap();
    let snapshot = legacy.snapshot();
    assert_eq!(snapshot.session.id, LOLI_ID);
    assert_eq!(snapshot.status, AgentStatus::Running);
    assert_eq!(snapshot.messages[0].id, "msg_first");
    assert_eq!(
        snapshot.messages[0].parts,
        [AgentPart::Text {
            text: "Original chat message".into()
        }]
    );
    assert_eq!(snapshot.queued_messages[0].id, "msg_queued");
    assert_eq!(legacy.context_summary(), Some("Old context checkpoint"));
    assert_eq!(legacy.history()[0]["content"], PRIVATE_CONTEXT);
    assert_eq!(
        legacy.secretary_tasks().next().unwrap().parent_session_id,
        LOLI_ID
    );
    assert_eq!(migration.receipt(LOLI_ID).unwrap(), None);
    assert!(!profile.path().join("agent/harness-migration").exists());
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn repeated_preparation_and_commit_keep_one_identity_and_leave_the_source_untouched() {
    let profile = tempfile::tempdir().unwrap();
    let mut fixture = legacy_fixture();
    fixture["secretaryRemovedTasks"] = json!(["task_finished"]);
    let path = write_source(profile.path(), &fixture);
    let original = fs::read(&path).unwrap();
    let migration = HarnessMigration::new(profile.path()).unwrap();

    let (legacy, prepared) = migration.prepare(LOLI_ID).unwrap();
    assert_eq!(legacy.secretary_tasks().count(), 0);
    assert_eq!(prepared.state(), MigrationState::Prepared);
    assert_eq!(prepared.loli_session_id(), LOLI_ID);
    assert!(canonical_uuid(prepared.harness_session_id()).is_some());
    assert_ne!(prepared.harness_session_id(), RAW_ID);

    let reopened = HarnessMigration::new(profile.path()).unwrap();
    assert_eq!(reopened.receipt(LOLI_ID).unwrap(), Some(prepared.clone()));
    assert_eq!(reopened.prepare(LOLI_ID).unwrap().1, prepared);
    let committed = reopened.commit(&prepared).unwrap();
    assert_eq!(committed.state(), MigrationState::Committed);
    assert_eq!(
        committed.harness_session_id(),
        prepared.harness_session_id()
    );
    assert_eq!(migration.commit(&prepared).unwrap(), committed);
    assert_eq!(migration.commit(&committed).unwrap(), committed);
    assert_eq!(migration.prepare(LOLI_ID).unwrap().1, committed);
    assert_eq!(migration.receipt(LOLI_ID).unwrap(), Some(committed));
    assert_eq!(fs::read(path).unwrap(), original);

    let directory = profile.path().join("agent/harness-migration");
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 3);
    for phase in ["prepared", "committed"] {
        let stored = fs::read_to_string(directory.join(format!("{RAW_ID}.{phase}.json"))).unwrap();
        assert!(!stored.contains(PRIVATE_CONTEXT));
        assert!(!stored.contains("Original chat message"));
    }
}

#[test]
fn concurrent_prepares_and_commits_agree() {
    let profile = tempfile::tempdir().unwrap();
    write_source(profile.path(), &legacy_fixture());
    let migration = HarnessMigration::new(profile.path()).unwrap();
    let start = Barrier::new(2);
    let (first, second) = thread::scope(|scope| {
        let first = scope.spawn(|| {
            start.wait();
            let receipt = migration.prepare(LOLI_ID).unwrap().1;
            migration.commit(&receipt).unwrap()
        });
        start.wait();
        let receipt = migration.prepare(LOLI_ID).unwrap().1;
        (first.join().unwrap(), migration.commit(&receipt).unwrap())
    });
    assert_eq!(first, second);
    assert_eq!(first.state(), MigrationState::Committed);
}

#[test]
fn rejects_cross_profile_receipts_and_changed_sources() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    write_source(first.path(), &legacy_fixture());
    write_source(second.path(), &legacy_fixture());
    let first_migration = HarnessMigration::new(first.path()).unwrap();
    let second_migration = HarnessMigration::new(second.path()).unwrap();
    let first_receipt = first_migration.prepare(LOLI_ID).unwrap().1;
    let second_receipt = second_migration.prepare(LOLI_ID).unwrap().1;
    assert_ne!(
        first_receipt.harness_session_id(),
        second_receipt.harness_session_id()
    );
    assert!(second_migration.commit(&first_receipt).is_err());

    let mut changed = legacy_fixture();
    changed["unknownOldField"]["keepExactly"] = json!("The old source changed after prepare");
    let changed_path = write_source(first.path(), &changed);
    let changed_bytes = fs::read(&changed_path).unwrap();
    assert!(first_migration.prepare(LOLI_ID).is_err());
    assert!(first_migration.commit(&first_receipt).is_err());
    assert_eq!(
        first_migration.receipt(LOLI_ID).unwrap(),
        Some(first_receipt)
    );
    assert_eq!(
        second_migration.receipt(LOLI_ID).unwrap(),
        Some(second_receipt)
    );
    assert_eq!(fs::read(changed_path).unwrap(), changed_bytes);
}

#[test]
fn rejects_unowned_legacy_paths_formats_and_session_ids() {
    let profile = tempfile::tempdir().unwrap();
    let migration = HarnessMigration::new(profile.path()).unwrap();
    assert!(migration.prepare("lc:../private").is_err());
    assert!(migration.prepare(&LOLI_ID.to_uppercase()).is_err());
    assert!(migration.prepare("ses_legacy").is_err());
    let mut fixture = legacy_fixture();
    fixture["format"] = json!(2);
    write_source(profile.path(), &fixture);
    assert!(migration.prepare(LOLI_ID).is_err());
    fixture["format"] = json!(1);
    fixture["snapshot"]["session"]["id"] = json!("lc:12345678-1234-4321-8765-123456789abb");
    write_source(profile.path(), &fixture);
    assert!(migration.prepare(LOLI_ID).is_err());
    assert!(!profile.path().join("agent/harness-migration").exists());
}

#[test]
fn preserves_existing_receipts_when_the_profile_marker_is_missing_or_the_record_is_invalid() {
    let profile = tempfile::tempdir().unwrap();
    write_source(profile.path(), &legacy_fixture());
    let migration = HarnessMigration::new(profile.path()).unwrap();
    let (_, prepared) = migration.prepare(LOLI_ID).unwrap();
    let directory = profile.path().join("agent/harness-migration");
    let marker = directory.join("profile-id");
    let record = directory.join(format!("{RAW_ID}.prepared.json"));
    let original = fs::read(&record).unwrap();
    let identity = fs::read(&marker).unwrap();
    fs::remove_file(&marker).unwrap();
    assert!(migration.prepare(LOLI_ID).is_err());
    assert!(migration.commit(&prepared).is_err());
    assert_eq!(fs::read(&record).unwrap(), original);
    assert!(!marker.exists());

    fs::write(marker, identity).unwrap();
    fs::write(&record, b"unexpected partial record").unwrap();
    assert!(migration.prepare(LOLI_ID).is_err());
    assert!(migration.commit(&prepared).is_err());
    assert_eq!(fs::read(&record).unwrap(), b"unexpected partial record");
}

#[cfg(unix)]
#[test]
fn rejects_symbolic_links_to_legacy_sessions_and_receipt_directories() {
    use std::os::unix::fs::symlink;

    let profile = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let external = write_source(outside.path(), &legacy_fixture());
    let own = write_source(profile.path(), &legacy_fixture());
    fs::remove_file(&own).unwrap();
    symlink(external, &own).unwrap();
    let migration = HarnessMigration::new(profile.path()).unwrap();
    assert!(migration.prepare(LOLI_ID).is_err());

    fs::remove_file(own).unwrap();
    write_source(profile.path(), &legacy_fixture());
    symlink(
        outside.path(),
        profile.path().join("agent/harness-migration"),
    )
    .unwrap();
    assert!(migration.prepare(LOLI_ID).is_err());
    assert!(!outside.path().join("profile-id").exists());
}
