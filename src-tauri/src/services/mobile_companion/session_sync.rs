//! Registered desktop-session discovery and explicit attachment are separate
//! from phone-origin execution ownership.
use super::*;

pub(super) fn visible(
    store: &Store,
    room_id: &str,
    projects: &BTreeSet<String>,
    candidates: Vec<AgentSession>,
) -> Vec<AgentSession> {
    let Some(room) = store
        .rooms
        .get(room_id)
        .filter(|r| r.approved && !r.revoked)
    else {
        return Vec::new();
    };
    let account = room.account.as_ref().map(|a| a.account_id.as_str());
    let mut sessions = BTreeMap::new();
    for session in candidates {
        if session.archived || !projects.contains(&session.project_path) {
            continue;
        }
        if account.is_none() && !room.sessions.contains(&session.id) {
            continue;
        }
        if store.rooms.iter().any(|(id, r)| {
            id != room_id
                && r.sessions.contains(&session.id)
                && (r.account.as_ref().map(|a| a.account_id.as_str()) != account
                    || r.account.is_none())
        }) {
            continue;
        }
        sessions.entry(session.id.clone()).or_insert(session);
    }
    let mut values = sessions.into_values().collect::<Vec<_>>();
    values.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    values
}

pub(super) fn is_mobile_flight(snapshot: &AgentSnapshot, request: &str) -> bool {
    !matches!(snapshot.status, AgentStatus::Idle | AgentStatus::Error)
        && snapshot
            .messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .is_some_and(|m| m.id == format!("mobile:{request}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn room(account: Option<&str>) -> Room {
        let mut room = super::super::tests::fixture_room(true);
        room.sessions.clear();
        room.account = account.map(|id| account::AccountRoom {
            account_id: id.into(),
            challenge: "fixture".into(),
            request_id: uuid::Uuid::new_v4().to_string(),
            desktop_device_id: uuid::Uuid::new_v4().to_string(),
            phone_device_id: uuid::Uuid::new_v4().to_string(),
            desktop_fingerprint: "a".repeat(64),
            phone_fingerprint: "b".repeat(64),
            envelope_hash: "c".repeat(64),
        });
        room
    }
    fn session(id: &str, path: &str, updated: u64) -> AgentSession {
        serde_json::from_value(json!({"id":id,"title":id,"projectPath":path,"mode":"build","permissionMode":"ask","model":null,"createdAt":1,"updatedAt":updated})).unwrap()
    }
    #[test]
    fn only_registered_nonarchived_desktop_and_same_account_sessions_are_discoverable() {
        let mut own = room(Some("7"));
        own.sessions.insert("phone-own".into());
        let mut same = room(Some("7"));
        same.sessions.insert("phone-same".into());
        let mut other = room(Some("8"));
        other.sessions.insert("phone-other".into());
        let mut legacy = room(None);
        legacy.sessions.insert("legacy".into());
        let store = Store {
            rooms: BTreeMap::from([
                ("own".into(), own),
                ("same".into(), same),
                ("other".into(), other),
                ("legacy".into(), legacy),
            ]),
        };
        let mut archived = session("archived", "p", 20);
        archived.archived = true;
        let candidates = vec![
            session("desktop", "p", 5),
            session("phone-own", "p", 1),
            session("phone-same", "p", 2),
            session("phone-other", "p", 3),
            session("legacy", "p", 4),
            session("outside", "private", 50),
            archived,
        ];
        let values = visible(&store, "own", &BTreeSet::from(["p".into()]), candidates);
        assert_eq!(
            values.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["desktop", "phone-same", "phone-own"]
        );
        assert!(!store.rooms["own"].shared_sessions.contains("desktop"));
        assert!(visible(&store, "missing", &BTreeSet::from(["p".into()]), values).is_empty());
    }
    #[test]
    fn browsing_or_attaching_a_desktop_session_never_makes_its_current_run_phone_owned() {
        let mut snapshot:AgentSnapshot=serde_json::from_value(json!({"session":session("desktop","p",1),"status":"running","messages":[
            {"id":"mobile:old","role":"user","createdAt":1,"parts":[]}, {"id":"desktop:new","role":"user","createdAt":2,"parts":[]}],
            "permissions":[],"questions":[],"diffs":[],"error":null,"streamConnected":true,"streamGap":false})).unwrap();
        assert!(!is_mobile_flight(&snapshot, "old"));
        snapshot.messages.pop();
        assert!(is_mobile_flight(&snapshot, "old"));
        snapshot.status = AgentStatus::Idle;
        assert!(!is_mobile_flight(&snapshot, "old"));
    }
}
