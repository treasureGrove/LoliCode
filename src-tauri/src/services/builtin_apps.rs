//! Built-in business applications are opt-in. Removal preserves domain data.
use crate::database::Database;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinApp {
    Tavern,
    Unreal,
    Rankings,
    #[serde(rename = "free-ai")]
    FreeAi,
}

impl BuiltinApp {
    fn key(self) -> &'static str {
        match self {
            Self::Tavern => "lolicode_builtin_tavern_enabled_v1",
            Self::Unreal => "lolicode_builtin_unreal_enabled_v1",
            Self::Rankings => "lolicode_builtin_rankings_enabled_v1",
            Self::FreeAi => "lolicode_builtin_free_ai_enabled_v1",
        }
    }
    fn legacy_store(self) -> &'static str {
        match self {
            Self::Tavern => "lolicode_tavern_store_v1",
            Self::Unreal => "lolicode_unreal_store_v1",
            Self::Rankings => "lolicode_rankings_store_v1",
            Self::FreeAi => "lolicode_free_ai_store_v1",
        }
    }
}

#[derive(Serialize)]
pub struct BuiltinAppState {
    pub id: BuiltinApp,
    pub enabled: bool,
}

pub fn enabled(db: &Database, app: BuiltinApp) -> Result<bool, String> {
    match db
        .get_setting(app.key())
        .map_err(|e| e.to_string())?
        .as_deref()
    {
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => Err("应用添加状态无效，原数据已保留".into()),
        // Existing users retain their applications, fresh profiles start opt-in.
        None => Ok(db
            .get_setting(app.legacy_store())
            .map_err(|e| e.to_string())?
            .is_some()),
    }
}

pub fn require(db: &Database, app: BuiltinApp) -> Result<(), String> {
    if enabled(db, app)? {
        Ok(())
    } else {
        Err("请先在应用中心添加此应用".into())
    }
}

pub fn list(db: &Database) -> Result<Vec<BuiltinAppState>, String> {
    [
        BuiltinApp::Tavern,
        BuiltinApp::Unreal,
        BuiltinApp::Rankings,
        BuiltinApp::FreeAi,
    ]
    .into_iter()
    .map(|id| {
        Ok(BuiltinAppState {
            id,
            enabled: enabled(db, id)?,
        })
    })
    .collect()
}

pub fn set_enabled(db: &Database, app: BuiltinApp, enabled: bool) -> Result<(), String> {
    // One independent key per app: simultaneous changes cannot overwrite peers.
    db.set_setting(app.key(), if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opt_in_survives_reopen_and_removal_keeps_domain_data() {
        let db = Database::memory().unwrap();
        assert!(!enabled(&db, BuiltinApp::Tavern).unwrap());
        db.set_setting("lolicode_tavern_store_v1", "{\"stories\":[\"kept\"]}")
            .unwrap();
        assert!(enabled(&db, BuiltinApp::Tavern).unwrap());
        set_enabled(&db, BuiltinApp::Tavern, false).unwrap();
        assert!(require(&db, BuiltinApp::Tavern).is_err());
        assert!(db
            .get_setting("lolicode_tavern_store_v1")
            .unwrap()
            .unwrap()
            .contains("kept"));
        set_enabled(&db, BuiltinApp::Unreal, true).unwrap();
        assert!(!enabled(&db, BuiltinApp::Tavern).unwrap());
        assert!(enabled(&db, BuiltinApp::Unreal).unwrap());
        set_enabled(&db, BuiltinApp::Tavern, true).unwrap();
        assert!(require(&db, BuiltinApp::Tavern).is_ok());
    }

    #[test]
    fn persistent_flags_are_read_from_disk_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("application-state.db");
        let open = || {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute(
                "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)",
                [],
            )
            .unwrap();
            Database {
                conn: std::sync::Mutex::new(conn),
                log_count_cache: std::sync::Mutex::new(None),
            }
        };
        let db = open();
        set_enabled(&db, BuiltinApp::Tavern, true).unwrap();
        drop(db);
        let db = open();
        assert!(enabled(&db, BuiltinApp::Tavern).unwrap());
        set_enabled(&db, BuiltinApp::Tavern, false).unwrap();
        drop(db);
        assert!(!enabled(&open(), BuiltinApp::Tavern).unwrap());
    }
}
