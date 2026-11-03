//! Explicit, local-only exchange between the stable and development profiles.
//! Session files are added by the engine; navigation is merged transactionally.
use crate::{commands::agent_dispatch::native, services::agent_preferences, store::AppState};
use lolicode_agent::AgentSession;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tauri::{AppHandle, Manager};

const NAVIGATION_KEY: &str = "lolicode_agent_workspace_preferences";

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineSyncResult {
    imported: usize,
    exported: usize,
    duplicates: usize,
    conflicts: usize,
    skipped_busy: usize,
    skipped_unsupported: usize,
    #[serde(default)]
    warnings: Vec<String>,
    local_sessions: Vec<AgentSession>,
    peer_sessions: Vec<AgentSession>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSyncResult {
    imported: usize,
    exported: usize,
    duplicates: usize,
    conflicts: usize,
    skipped_busy: usize,
    skipped_unsupported: usize,
    peer_name: String,
    warnings: Vec<String>,
}

fn read_navigation(connection: &Connection) -> Result<Value, String> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [NAVIGATION_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "会话项目导航无法读取，请先启动对应版本完成初始化")?;
    let value = match raw {
        Some(raw) => {
            serde_json::from_str::<Value>(&raw).map_err(|_| "会话项目导航损坏，原记录已保留")?
        }
        None => json!({"projects":{},"sessions":{}}),
    };
    if !value.is_object()
        || ["projects", "sessions"]
            .iter()
            .any(|key| value.get(key).is_some_and(|v| !v.is_object()))
    {
        return Err("会话项目导航格式不兼容，原记录已保留".into());
    }
    // Check known fields as well, without dropping fields from newer versions.
    serde_json::from_value::<agent_preferences::Preferences>(value.clone())
        .map_err(|_| "会话项目导航格式不兼容，原记录已保留")?;
    Ok(value)
}

fn merge_navigation(
    connection: &mut Connection,
    profile: &Path,
    sessions: &[AgentSession],
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "会话已保留，但项目导航被占用；请稍后再次同步")?;
    let mut value = read_navigation(&transaction)?;
    let before = value.clone();
    let root = value.as_object_mut().ok_or("会话项目导航格式无效")?;
    root.entry("projects").or_insert_with(|| json!({}));
    root.entry("sessions").or_insert_with(|| json!({}));
    for session in sessions {
        let path = Path::new(&session.project_path);
        if !path.is_absolute() {
            continue;
        }
        let standalone = agent_preferences::path_key(&session.project_path)
            == agent_preferences::path_key(
                &profile.join("agent/standalone-workspace").to_string_lossy(),
            );
        let projects = root
            .get_mut("projects")
            .and_then(Value::as_object_mut)
            .ok_or("会话项目导航格式无效")?;
        projects
            .entry(agent_preferences::path_key(&session.project_path))
            .or_insert_with(|| {
                let name = if standalone {
                    "独立任务".to_string()
                } else if path
                    .file_name()
                    .is_some_and(|name| name == "standalone-workspace")
                {
                    "同步的独立任务".to_string()
                } else {
                    path.file_name()
                        .map(|v| v.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "同步的项目".into())
                };
                json!({"path":session.project_path,"name":name,"standalone":standalone,
                "pinned":false,"lastOpenedAt":session.updated_at})
            });
        // Destination navigation wins. Import flags only for a new session.
        root.get_mut("sessions")
            .and_then(Value::as_object_mut)
            .ok_or("会话项目导航格式无效")?
            .entry(session.id.clone())
            .or_insert_with(|| json!({"pinned":session.pinned,"archived":session.archived}));
    }
    if value != before {
        let serialized = serde_json::to_string(&value).map_err(|_| "会话项目导航编码失败")?;
        transaction.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![NAVIGATION_KEY, serialized],
        ).map_err(|_| "会话已保留，但项目导航保存失败；请再次同步修复")?;
    }
    transaction
        .commit()
        .map_err(|_| "会话项目导航保存未完成，请再次同步".to_string())
}

fn peer_connection(profile: &Path) -> Result<Connection, String> {
    let database = crate::config::database_path_in(profile);
    let metadata = std::fs::symlink_metadata(&database)
        .map_err(|_| "未找到另一版本的本机数据，请先启动该版本一次")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("另一版本的数据库路径不是普通文件，原数据已保留".into());
    }
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| "另一版本的会话项目导航无法打开，原数据已保留")?;
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(|_| "无法设置会话同步等待时间")?;
    Ok(connection)
}

#[tauri::command]
pub async fn sync_agent_sessions(
    app: AppHandle,
    direction: String,
) -> Result<AgentSessionSyncResult, String> {
    // The build channel comes from the executable, never from renderer input.
    // Stable packages cannot invoke the development-only transfer operation.
    if !crate::channel::is_development() {
        return Err("会话同步仅在开发版提供，请从开发版同步到正式版".into());
    }
    if !matches!(direction.as_str(), "both" | "import" | "export") {
        return Err("请选择双向同步、同步过来或同步过去".into());
    }
    let local_profile = crate::config::get_app_config_dir();
    let peer_profile = crate::config::get_home_dir().join(if crate::channel::is_development() {
        ".tai-switch"
    } else {
        ".lolicode-dev"
    });
    let local_canonical =
        std::fs::canonicalize(&local_profile).map_err(|_| "当前会话目录不可用")?;
    let peer_canonical = std::fs::canonicalize(&peer_profile)
        .map_err(|_| "未找到另一版本的本机数据，请先启动该版本一次")?;
    if local_canonical == peer_canonical {
        return Err("两版指向同一数据目录，无需同步".into());
    }
    // Preflight both navigation records before publishing any session files.
    {
        let state = app.state::<AppState>();
        let connection = state.db.conn.lock().map_err(|_| "当前项目导航被占用")?;
        read_navigation(&connection)?;
    }
    let peer_preflight = peer_profile.clone();
    tokio::task::spawn_blocking(move || {
        read_navigation(&peer_connection(&peer_preflight)?).map(|_| ())
    })
    .await
    .map_err(|_| "另一版本的项目导航检查未完成")??;

    let result: EngineSyncResult = native(
        &app,
        "syncSessions",
        json!({
            "peerRoot":peer_profile.join("agent/native"),"direction":direction
        }),
        true,
    )
    .await?;
    let mut warnings = result.warnings;
    let local_sessions = result.local_sessions;
    let peer_sessions = result.peer_sessions;
    let state = app.state::<AppState>().inner().clone();
    let navigation_warnings = tokio::task::spawn_blocking(move || {
        let mut warnings = Vec::new();
        if direction != "export" {
            let merged = state
                .db
                .conn
                .lock()
                .map_err(|_| "当前项目导航被占用".to_string())
                .and_then(|mut connection| {
                    merge_navigation(&mut connection, &local_profile, &local_sessions)
                });
            if let Err(error) = merged {
                warnings.push(error);
            }
        }
        if direction != "import" {
            let merged = peer_connection(&peer_profile).and_then(|mut connection| {
                merge_navigation(&mut connection, &peer_profile, &peer_sessions)
            });
            if let Err(error) = merged {
                warnings.push(error);
            }
        }
        warnings
    })
    .await
    .map_err(|_| "会话文件同步完成，但项目导航更新中断；请再次同步修复")?;
    warnings.extend(navigation_warnings);
    Ok(AgentSessionSyncResult {
        imported: result.imported,
        exported: result.exported,
        duplicates: result.duplicates,
        conflicts: result.conflicts,
        skipped_busy: result.skipped_busy,
        skipped_unsupported: result.skipped_unsupported,
        peer_name: if crate::channel::is_development() {
            "正式版"
        } else {
            "开发版"
        }
        .into(),
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)")
            .unwrap();
        connection
    }

    fn session(project: &Path) -> AgentSession {
        serde_json::from_value(
            json!({"id":"lc:fixture","title":"Keep context","projectPath":project,
            "mode":"build","permissionMode":"ask","pinned":true,"archived":true,
            "model":null,"createdAt":1,"updatedAt":2}),
        )
        .unwrap()
    }

    #[test]
    fn navigation_merge_preserves_existing_names_flags_and_unknown_fields() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let session = session(&project);
        let mut connection = connection();
        let original = json!({"projects":{agent_preferences::path_key(&project.to_string_lossy()):{
            "path":project,"name":"User name","pinned":true,"standalone":false,"lastOpenedAt":100,
            "futureProjectField":123}}, "sessions":{"lc:fixture":{"pinned":false,"archived":false}},
            "futureField":{"keep":true}});
        connection
            .execute(
                "INSERT INTO settings VALUES(?1,?2)",
                rusqlite::params![NAVIGATION_KEY, original.to_string()],
            )
            .unwrap();
        merge_navigation(&mut connection, temp.path(), &[session]).unwrap();
        assert_eq!(read_navigation(&connection).unwrap(), original);
    }

    #[test]
    fn navigation_registers_new_project_and_session_without_relocating_standalone_files() {
        let temp = tempfile::tempdir().unwrap();
        let source_workspace = temp.path().join("source/agent/standalone-workspace");
        let mut connection = connection();
        let session = session(&source_workspace);
        merge_navigation(
            &mut connection,
            &temp.path().join("destination"),
            &[session.clone()],
        )
        .unwrap();
        let value = read_navigation(&connection).unwrap();
        let project = &value["projects"][agent_preferences::path_key(&session.project_path)];
        assert_eq!(project["path"], session.project_path);
        assert_eq!(project["standalone"], false);
        assert_eq!(value["sessions"][&session.id]["archived"], true);
        merge_navigation(&mut connection, temp.path(), &[session]).unwrap();
        assert_eq!(read_navigation(&connection).unwrap(), value);
    }

    #[test]
    fn malformed_navigation_is_left_untouched() {
        let mut connection = connection();
        connection
            .execute(
                "INSERT INTO settings VALUES(?1,'{broken')",
                [NAVIGATION_KEY],
            )
            .unwrap();
        assert!(merge_navigation(&mut connection, Path::new("unused"), &[]).is_err());
        let raw: String = connection
            .query_row("SELECT value FROM settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(raw, "{broken");
    }
}
