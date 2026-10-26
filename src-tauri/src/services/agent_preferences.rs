//! Desktop navigation metadata; engine messages remain in the engine database.
use crate::database::Database;
use lolicode_agent::AgentSession;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const KEY: &str = "lolicode_agent_workspace_preferences";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProject {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub standalone: bool,
    #[serde(default)]
    pub pinned: bool,
    pub last_opened_at: u64,
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct SessionView {
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Preferences {
    #[serde(default)]
    pub projects: BTreeMap<String, AgentProject>,
    #[serde(default)]
    pub sessions: BTreeMap<String, SessionView>,
}

pub fn path_key(path: &str) -> String {
    let path = path.trim_end_matches(['/', '\\']);
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

pub fn load(db: &Database) -> Result<Preferences, String> {
    match db.get_setting(KEY).map_err(|error| error.to_string())? {
        Some(value) => serde_json::from_str(&value)
            .map_err(|_| "工作台导航记录无法读取，请检查应用数据备份".into()),
        None => Ok(Preferences::default()),
    }
}

pub fn save(db: &Database, preferences: &Preferences) -> Result<(), String> {
    let value = serde_json::to_string(preferences).map_err(|_| "工作台记录编码失败")?;
    db.set_setting(KEY, &value)
        .map_err(|error| error.to_string())
}

pub fn decorate(preferences: &Preferences, session: &mut AgentSession) {
    if let Some(view) = preferences.sessions.get(&session.id) {
        session.pinned = view.pinned;
        session.archived = view.archived;
    }
}

pub fn sorted_projects(preferences: &Preferences) -> Vec<AgentProject> {
    let mut projects: Vec<_> = preferences.projects.values().cloned().collect();
    projects.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.last_opened_at.cmp(&a.last_opened_at))
            .then(a.path.cmp(&b.path))
    });
    projects
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_metadata_survives_reload_and_project_removal_keeps_sessions() {
        let db = Database::memory().unwrap();
        let mut preferences = load(&db).unwrap();
        preferences.projects.insert(
            "p".into(),
            AgentProject {
                standalone: false,
                path: "project".into(),
                name: "project".into(),
                pinned: true,
                last_opened_at: 1,
            },
        );
        preferences.sessions.insert(
            "ses_test".into(),
            SessionView {
                pinned: true,
                archived: true,
            },
        );
        save(&db, &preferences).unwrap();
        let mut loaded = load(&db).unwrap();
        assert!(loaded.sessions["ses_test"].archived);
        loaded.projects.remove("p");
        save(&db, &loaded).unwrap();
        assert!(load(&db).unwrap().sessions["ses_test"].pinned);
    }

    #[test]
    fn malformed_metadata_is_preserved_for_recovery() {
        let db = Database::memory().unwrap();
        db.set_setting(KEY, "broken record").unwrap();
        assert!(load(&db).is_err());
        assert_eq!(
            db.get_setting(KEY).unwrap().as_deref(),
            Some("broken record")
        );
    }
}
