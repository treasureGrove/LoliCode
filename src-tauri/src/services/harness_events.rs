//! Product receipts from the pinned DeepSeek Harness SDK event stream.
//! Feed notifications in wire order, starting before the first prompt.

use crate::commands::agent_files;
use lolicode_agent::{AgentPreviewRequest, AgentPreviewTarget};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
};

const RETAINED_PREVIEW_RECEIPTS: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum HarnessTurnOutcome {
    Completed,
    Ended(String),
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct HarnessChildOutcome {
    pub parent_session_id: String,
    pub stop_reason: String,
    completed: bool,
}

impl HarnessChildOutcome {
    pub(super) fn is_completed(&self) -> bool {
        self.completed
    }
}

/// The host resolves the SDK session to the public session and its authorized
/// execution directory. For a delegated task this must be the child's worktree.
pub(super) struct PreviewSource {
    pub session_id: String,
    pub working_directory: PathBuf,
}

pub(super) struct HarnessEvents {
    sessions: HashMap<String, SessionEvents>,
    previews: VecDeque<PreviewReceipt>,
    job_settlements: u64,
}

#[derive(Default)]
struct SessionEvents {
    parent: Option<String>,
    last_seq: Option<u64>,
    open_turn: Option<OpenTurn>,
    latest_turn_outcome: Option<HarnessTurnOutcome>,
    turns: HashMap<String, HarnessTurnOutcome>,
    child_outcome: Option<HarnessChildOutcome>,
    jobs: HashSet<String>,
}

struct OpenTurn {
    number: u64,
    prompt_ids: Vec<String>,
}

struct PreviewReceipt {
    session_id: String,
    seq: u64,
    created_at: u64,
    files: Vec<PresentedFile>,
}

#[derive(Deserialize)]
struct EventHeader<'a> {
    seq: u64,
    time: u64,
    #[serde(rename = "type")]
    kind: &'a str,
}

#[derive(Deserialize)]
struct TurnStart {
    turn: u64,
}

#[derive(Deserialize)]
struct TurnEnd {
    turn: u64,
    reason: Kind,
}

#[derive(Deserialize)]
struct Kind {
    kind: String,
}

#[derive(Deserialize)]
struct UserMessage {
    id: String,
    role: String,
    source: Kind,
}

#[derive(Deserialize)]
struct PresentedFile {
    path: String,
}

#[derive(Deserialize)]
struct Presented {
    turn: u64,
    #[serde(rename = "callId")]
    call_id: String,
    files: Vec<PresentedFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildEdge {
    parent_session_id: String,
    child_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildFinished {
    #[serde(flatten)]
    edge: ChildEdge,
    agent_id: String,
    status: ChildStatus,
    stop_reason: String,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ChildStatus {
    Ok,
    Error,
}

impl HarnessEvents {
    pub(super) fn new(root: &str) -> Self {
        Self {
            sessions: HashMap::from([(root.to_owned(), SessionEvents::default())]),
            previews: VecDeque::new(),
            job_settlements: 0,
        }
    }

    pub(super) fn apply(&mut self, notification: &Value) -> Result<(), String> {
        let Some(method @ ("session.event" | "subagent.started" | "subagent.finished")) =
            notification["method"].as_str()
        else {
            return Ok(());
        };
        if notification["jsonrpc"] != "2.0" || notification.get("id").is_some() {
            return Err(invalid(method));
        }
        let params = &notification["params"];
        match method {
            "session.event" => self.session_event(params),
            "subagent.started" => self.child_started(decode(params, method)?),
            "subagent.finished" => self.child_finished(decode(params, method)?),
            _ => unreachable!(),
        }
    }

    pub(super) fn turn_outcome(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Option<&HarnessTurnOutcome> {
        self.sessions.get(session_id)?.turns.get(message_id)
    }

    pub(super) fn child_outcome(&self, child_id: &str) -> Option<&HarnessChildOutcome> {
        self.sessions.get(child_id)?.child_outcome.as_ref()
    }

    pub(super) fn has_open_turn(&self) -> bool {
        self.sessions
            .values()
            .any(|session| session.open_turn.is_some())
    }

    pub(super) fn active_jobs(&self) -> usize {
        self.sessions
            .values()
            .map(|session| session.jobs.len())
            .sum()
    }

    pub(super) fn active_jobs_for(&self, session_id: &str) -> usize {
        self.sessions
            .get(session_id)
            .map_or(0, |session| session.jobs.len())
    }

    pub(super) fn job_settlements(&self) -> u64 {
        self.job_settlements
    }

    /// An explicit continuation already verified the direct parent with the
    /// upstream subagent API. Cold resume does not create a new Session.
    pub(super) fn track_child(&mut self, parent: &str, child: &str) -> Result<(), String> {
        self.child_started(ChildEdge {
            parent_session_id: parent.into(),
            child_session_id: child.into(),
        })
    }

    pub(super) fn latest_preview(
        &self,
        mut resolve_source: impl FnMut(&str) -> Option<PreviewSource>,
    ) -> Option<AgentPreviewRequest> {
        self.previews.iter().rev().find_map(|receipt| {
            let source = resolve_source(&receipt.session_id)?;
            let (index, path) = receipt.files.iter().enumerate().find_map(|(index, file)| {
                preview_path(&source.working_directory, &file.path).map(|path| (index, path))
            })?;
            Some(AgentPreviewRequest {
                id: format!("dsh:{}:{}:{index}", receipt.session_id, receipt.seq),
                session_id: source.session_id,
                created_at: receipt.created_at,
                target: AgentPreviewTarget::File {
                    path,
                    locator: None,
                },
            })
        })
    }

    fn session_event(&mut self, params: &Value) -> Result<(), String> {
        let session_id = params["sessionId"]
            .as_str()
            .ok_or_else(|| invalid("session.event"))?;
        let Some(session) = self.sessions.get_mut(session_id) else {
            return Ok(());
        };
        let event = &params["event"];
        let header: EventHeader<'_> = decode(event, "session.event")?;
        if session.last_seq.is_some_and(|last| header.seq <= last) {
            return Ok(());
        }
        let data = &event["data"];
        let mut present = None;
        match header.kind {
            "job/registered" | "job/settled" => {
                if let Some(job) = data["jobId"].as_str() {
                    if header.kind == "job/registered" {
                        session.jobs.insert(job.into());
                    } else if session.jobs.remove(job) {
                        self.job_settlements += 1;
                    }
                }
            }
            "turn/start" => {
                let TurnStart { turn } = decode(data, header.kind)?;
                session.open_turn = Some(OpenTurn {
                    number: turn,
                    prompt_ids: Vec::new(),
                });
                session.latest_turn_outcome = None;
                session.child_outcome = None;
            }
            "user/message" => {
                let message: UserMessage = decode(data, header.kind)?;
                if let Some(turn) = &mut session.open_turn {
                    if message.role == "user" && message.source.kind == "user" {
                        turn.prompt_ids.push(message.id);
                    }
                }
            }
            "turn/end" => {
                let end: TurnEnd = decode(data, header.kind)?;
                if session
                    .open_turn
                    .as_ref()
                    .is_some_and(|turn| turn.number == end.turn)
                {
                    let outcome = if end.reason.kind == "completed" {
                        HarnessTurnOutcome::Completed
                    } else {
                        HarnessTurnOutcome::Ended(end.reason.kind)
                    };
                    if let Some(turn) = session.open_turn.take() {
                        for id in turn.prompt_ids {
                            session.turns.entry(id).or_insert_with(|| outcome.clone());
                        }
                    }
                    session.latest_turn_outcome = Some(outcome);
                }
            }
            "deliverables/presented" => {
                let receipt: Presented = decode(data, header.kind)?;
                if session
                    .open_turn
                    .as_ref()
                    .is_some_and(|turn| turn.number == receipt.turn)
                    && !receipt.call_id.is_empty()
                    && !receipt.files.is_empty()
                {
                    present = Some(PreviewReceipt {
                        session_id: session_id.to_owned(),
                        seq: header.seq,
                        created_at: header.time,
                        files: receipt.files,
                    });
                }
            }
            _ => {}
        }
        session.last_seq = Some(header.seq);
        if let Some(present) = present {
            self.push_preview(present);
        }
        Ok(())
    }

    fn child_started(&mut self, edge: ChildEdge) -> Result<(), String> {
        if !self.sessions.contains_key(&edge.parent_session_id) {
            return Ok(());
        }
        if let Some(known) = self.sessions.get(&edge.child_session_id) {
            return if known.parent.as_deref() == Some(edge.parent_session_id.as_str()) {
                Ok(())
            } else {
                Err(invalid("subagent.started"))
            };
        }
        self.sessions.insert(
            edge.child_session_id,
            SessionEvents {
                parent: Some(edge.parent_session_id),
                ..SessionEvents::default()
            },
        );
        Ok(())
    }

    fn child_finished(&mut self, finished: ChildFinished) -> Result<(), String> {
        let Some(child) = self.sessions.get_mut(&finished.edge.child_session_id) else {
            return Ok(());
        };
        if child.parent.as_deref() != Some(finished.edge.parent_session_id.as_str())
            || finished.agent_id != finished.edge.child_session_id
        {
            return Err(invalid("subagent.finished"));
        }
        if child.child_outcome.is_none() {
            let completed = finished.status == ChildStatus::Ok
                && finished.stop_reason == "completed"
                && child.latest_turn_outcome == Some(HarnessTurnOutcome::Completed);
            child.child_outcome = Some(HarnessChildOutcome {
                parent_session_id: finished.edge.parent_session_id,
                stop_reason: finished.stop_reason,
                completed,
            });
        }
        Ok(())
    }

    fn push_preview(&mut self, receipt: PreviewReceipt) {
        if self.previews.len() == RETAINED_PREVIEW_RECEIPTS {
            self.previews.pop_front();
        }
        self.previews.push_back(receipt);
    }
}

fn decode<'a, T: Deserialize<'a>>(value: &'a Value, method: &str) -> Result<T, String> {
    T::deserialize(value).map_err(|_| invalid(method))
}

fn invalid(method: &str) -> String {
    format!("Invalid Harness {method} notification")
}

fn preview_path(directory: &std::path::Path, value: &str) -> Option<String> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return None;
    }
    let (root, path) = agent_files::resolve(directory, value).ok()?;
    if !path.is_file() {
        return None;
    }
    Some(path.strip_prefix(root).ok()?.to_str()?.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn apply(events: &mut HarnessEvents, method: &str, params: Value) -> Result<(), String> {
        events.apply(&json!({"jsonrpc":"2.0", "method":method, "params":params}))
    }

    fn session_event(events: &mut HarnessEvents, session: &str, seq: u64, kind: &str, data: Value) {
        apply(
            events,
            "session.event",
            json!({
                "sessionId":session,
                "event":{"seq":seq, "time":1700000000000_u64 + seq, "type":kind, "data":data}
            }),
        )
        .unwrap();
    }

    fn edge(parent: &str, child: &str) -> Value {
        json!({"parentSessionId":parent, "childSessionId":child})
    }

    fn finished(parent: &str, child: &str, reason: &str) -> Value {
        json!({
            "parentSessionId":parent, "childSessionId":child, "agentId":child,
            "provider":"local", "status":"ok", "stopReason":reason
        })
    }

    #[test]
    fn prompt_outcome_requires_the_exact_message_and_matching_terminal_turn() {
        let mut events = HarnessEvents::new("secretary");
        session_event(&mut events, "secretary", 1, "turn/start", json!({"turn":1}));
        session_event(
            &mut events,
            "secretary",
            2,
            "user/message",
            json!({"id":"prompt-a", "role":"user", "source":{"kind":"user"}, "content":[]}),
        );
        session_event(
            &mut events,
            "secretary",
            3,
            "user/message",
            json!({"id":"injected", "role":"user", "source":{"kind":"injected"}, "content":[]}),
        );
        apply(
            &mut events,
            "session.status",
            json!({"sessionId":"secretary","status":"idle"}),
        )
        .unwrap();
        session_event(
            &mut events,
            "secretary",
            4,
            "assistant/message",
            json!({"content":[{"type":"text","text":"Completed"}]}),
        );
        assert_eq!(events.turn_outcome("secretary", "prompt-a"), None);
        session_event(
            &mut events,
            "secretary",
            5,
            "turn/end",
            json!({"turn":2,"reason":{"kind":"completed"}}),
        );
        assert_eq!(events.turn_outcome("secretary", "prompt-a"), None);
        session_event(
            &mut events,
            "secretary",
            6,
            "turn/end",
            json!({"turn":1,"reason":{"kind":"max-tokens"}}),
        );
        assert_eq!(
            events.turn_outcome("secretary", "prompt-a"),
            Some(&HarnessTurnOutcome::Ended("max-tokens".into()))
        );
        assert_eq!(events.turn_outcome("secretary", "injected"), None);
        assert_eq!(events.turn_outcome("other", "prompt-a"), None);

        session_event(&mut events, "secretary", 7, "turn/start", json!({"turn":2}));
        session_event(
            &mut events,
            "secretary",
            8,
            "user/message",
            json!({"id":"prompt-b", "role":"user", "source":{"kind":"user"}, "content":[]}),
        );
        session_event(
            &mut events,
            "secretary",
            9,
            "turn/end",
            json!({"turn":2,"reason":{"kind":"completed"}}),
        );
        assert_eq!(
            events.turn_outcome("secretary", "prompt-b"),
            Some(&HarnessTurnOutcome::Completed)
        );
    }

    #[test]
    fn child_outcome_requires_owned_lineage_and_a_completed_child_turn() {
        let mut events = HarnessEvents::new("secretary");
        apply(&mut events, "subagent.started", edge("external", "stray")).unwrap();
        apply(
            &mut events,
            "subagent.finished",
            finished("external", "stray", "completed"),
        )
        .unwrap();
        assert!(events.child_outcome("stray").is_none());

        apply(&mut events, "subagent.started", edge("secretary", "worker")).unwrap();
        apply(&mut events, "subagent.started", edge("worker", "helper")).unwrap();
        assert!(apply(&mut events, "subagent.started", edge("secretary", "helper")).is_err());
        assert!(apply(
            &mut events,
            "subagent.finished",
            finished("secretary", "helper", "completed")
        )
        .is_err());
        apply(
            &mut events,
            "subagent.finished",
            finished("worker", "helper", "completed"),
        )
        .unwrap();
        assert!(!events.child_outcome("helper").unwrap().is_completed());
        session_event(&mut events, "helper", 1, "turn/start", json!({"turn":1}));
        session_event(
            &mut events,
            "helper",
            2,
            "turn/end",
            json!({"turn":1,"reason":{"kind":"completed"}}),
        );
        assert!(events.child_outcome("helper").is_none());
        apply(
            &mut events,
            "subagent.finished",
            finished("worker", "helper", "completed"),
        )
        .unwrap();
        let outcome = events.child_outcome("helper").unwrap();
        assert_eq!(outcome.parent_session_id, "worker");
        assert!(outcome.is_completed());

        session_event(&mut events, "worker", 1, "turn/start", json!({"turn":1}));
        session_event(
            &mut events,
            "worker",
            2,
            "turn/end",
            json!({"turn":1,"reason":{"kind":"max-tokens"}}),
        );
        apply(
            &mut events,
            "subagent.finished",
            finished("secretary", "worker", "max-tokens"),
        )
        .unwrap();
        let outcome = events.child_outcome("worker").unwrap();
        assert_eq!(outcome.stop_reason, "max-tokens");
        assert!(!outcome.is_completed());
    }

    #[test]
    fn preview_uses_only_present_receipts_in_the_resolved_child_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let page = workspace.path().join("index.html");
        let external = outside.path().join("private.html");
        fs::write(&page, "<h1>Worker page</h1>").unwrap();
        fs::write(&external, "private").unwrap();
        let resolve = |sdk: &str| {
            (sdk == "worker").then(|| PreviewSource {
                session_id: "lc:worker".into(),
                working_directory: workspace.path().into(),
            })
        };

        let mut events = HarnessEvents::new("secretary");
        apply(&mut events, "subagent.started", edge("secretary", "worker")).unwrap();
        session_event(&mut events, "worker", 1, "turn/start", json!({"turn":1}));
        session_event(
            &mut events,
            "worker",
            2,
            "tool/result",
            json!({"callId":"fake", "content":[{"type":"text","text":"Presented index.html"}]}),
        );
        assert!(events.latest_preview(resolve).is_none());

        let receipt =
            json!({"turn":1,"callId":"present", "files":[{"path":external},{"path":page}]});
        session_event(
            &mut events,
            "worker",
            3,
            "deliverables/presented",
            receipt.clone(),
        );
        session_event(&mut events, "worker", 3, "deliverables/presented", receipt);
        assert_eq!(events.previews.len(), 1);
        let preview = events.latest_preview(resolve).unwrap();
        assert_eq!(preview.id, "dsh:worker:3:1");
        assert_eq!(preview.session_id, "lc:worker");
        assert_eq!(preview.created_at, 1700000000003);
        assert_eq!(
            preview.target,
            AgentPreviewTarget::File {
                path: "index.html".into(),
                locator: None,
            }
        );
        assert!(events.latest_preview(|_| None).is_none());
        fs::remove_file(page).unwrap();
        assert!(events.latest_preview(resolve).is_none());
    }
}
