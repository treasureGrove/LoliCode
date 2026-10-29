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

/// Update display metadata only; paths and session ownership remain unchanged.
pub fn update_project_metadata(
    db: &Database,
    path: &str,
    pinned: Option<bool>,
    name: Option<&str>,
) -> Result<AgentProject, String> {
    let name = name
        .map(|value| {
            let value = value.trim();
            if value.is_empty() {
                return Err("请填写项目名称".to_string());
            }
            if value.chars().count() > 128 || value.chars().any(char::is_control) {
                return Err("项目名称最多 128 个字符，不能含换行或控制字符".to_string());
            }
            Ok(value.to_string())
        })
        .transpose()?;
    let mut preferences = load(db)?;
    let project = preferences
        .projects
        .get_mut(&path_key(path))
        .ok_or("这个项目还没有加入工作台")?;
    if let Some(pinned) = pinned {
        project.pinned = pinned;
    }
    if let Some(name) = name {
        project.name = name;
    }
    let project = project.clone();
    save(db, &preferences)?;
    Ok(project)
}

/// Reopening a project refreshes activity without discarding its display name.
pub fn remembered_project_name(preferences: &Preferences, path: &str) -> Option<String> {
    preferences
        .projects
        .get(&path_key(path))
        .filter(|project| !project.name.trim().is_empty())
        .map(|project| project.name.clone())
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

    #[test]
    fn project_rename_persists_without_changing_path_pin_activity_or_sessions() {
        let db = Database::memory().unwrap();
        let path = "D:/fixture/project";
        let mut preferences = Preferences::default();
        preferences.projects.insert(
            path_key(path),
            AgentProject {
                path: path.into(),
                name: "project".into(),
                standalone: false,
                pinned: true,
                last_opened_at: 123,
            },
        );
        preferences.sessions.insert(
            "lc:session".into(),
            SessionView {
                pinned: true,
                archived: true,
            },
        );
        save(&db, &preferences).unwrap();

        let renamed = update_project_metadata(&db, path, None, Some("  新的项目名称  ")).unwrap();
        assert_eq!(renamed.name, "新的项目名称");
        assert_eq!(renamed.path, path);
        assert!(renamed.pinned);
        assert_eq!(renamed.last_opened_at, 123);
        let loaded = load(&db).unwrap();
        assert_eq!(
            remembered_project_name(&loaded, path).as_deref(),
            Some("新的项目名称")
        );
        assert!(loaded.sessions["lc:session"].pinned && loaded.sessions["lc:session"].archived);
        let unpinned = update_project_metadata(&db, path, Some(false), None).unwrap();
        assert!(!unpinned.pinned);
        assert_eq!(unpinned.name, renamed.name);
    }

    #[test]
    fn invalid_project_names_preserve_the_saved_record() {
        let db = Database::memory().unwrap();
        let mut preferences = Preferences::default();
        preferences.projects.insert(
            "p".into(),
            AgentProject {
                path: "p".into(),
                name: "Original".into(),
                standalone: false,
                pinned: true,
                last_opened_at: 7,
            },
        );
        save(&db, &preferences).unwrap();
        let initial = db.get_setting(KEY).unwrap();
        for invalid in [
            "".to_owned(),
            "   ".to_owned(),
            "bad\nname".to_owned(),
            "x".repeat(129),
        ] {
            assert!(update_project_metadata(&db, "p", Some(false), Some(&invalid)).is_err());
            assert_eq!(db.get_setting(KEY).unwrap(), initial);
        }
        assert!(update_project_metadata(&db, "missing", None, Some("New")).is_err());
        assert_eq!(db.get_setting(KEY).unwrap(), initial);
    }
}
