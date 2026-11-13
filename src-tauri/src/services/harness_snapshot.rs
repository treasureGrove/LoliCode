//! The desktop transcript is a view of the pinned Harness SDK stream. The
//! caller supplies only notifications belonging to this snapshot's session.
use lolicode_agent::{AgentMessage, AgentModelPhase, AgentPart, AgentSnapshot, AgentStatus};
use serde_json::Value;
use std::collections::BTreeSet;

const LIVE_ID_PREFIX: &str = "dsh-live:";

#[derive(Default)]
pub(super) struct HarnessSnapshotProjection {
    live: Option<LiveAttempt>,
    last_revision: Option<u64>,
}

struct LiveAttempt {
    attempt_id: String,
    message_id: String,
    turn: u64,
    step: u64,
    visible_indices: BTreeSet<u64>,
}

impl HarnessSnapshotProjection {
    pub(super) fn apply(&mut self, snapshot: &mut AgentSnapshot, notification: &Value) -> bool {
        if notification["method"] == "lolicode/session.assistant-stream" {
            return self.apply_stream(snapshot, &notification["params"]["frame"]);
        }
        if notification["method"] == "session.event" {
            let event = &notification["params"]["event"];
            let data = &event["data"];
            if let Some(attempt) = &self.live {
                let same_step = data["turn"].as_u64() == Some(attempt.turn)
                    && data["step"].as_u64() == Some(attempt.step);
                if same_step && event["type"] == "assistant/message" {
                    if let Some(message) = assistant_message(data, event["time"].as_u64()) {
                        if let Some(index) = snapshot
                            .messages
                            .iter()
                            .position(|message| message.id == attempt.message_id)
                        {
                            let duplicate =
                                snapshot.messages.iter().any(|item| item.id == message.id);
                            if duplicate {
                                snapshot.messages.remove(index);
                            } else {
                                snapshot.session.updated_at =
                                    snapshot.session.updated_at.max(message.created_at);
                                snapshot.messages[index] = message;
                            }
                            self.live = None;
                            snapshot.model_phase = None;
                            return true;
                        }
                    }
                }
                if event["type"] == "turn/end"
                    || (same_step && event["type"] == "assistant/attempt")
                    || (same_step && event["type"] == "assistant/message")
                {
                    let removed = self.remove_live(snapshot);
                    return apply(snapshot, notification) || removed;
                }
            }
        }
        apply(snapshot, notification)
    }

    fn remove_live(&mut self, snapshot: &mut AgentSnapshot) -> bool {
        let Some(attempt) = self.live.take() else {
            return false;
        };
        let before = snapshot.messages.len();
        snapshot
            .messages
            .retain(|message| message.id != attempt.message_id);
        snapshot.messages.len() != before
    }

    fn apply_stream(&mut self, snapshot: &mut AgentSnapshot, frame: &Value) -> bool {
        let (Some(attempt_id), Some(revision), Some(kind)) = (
            frame["attemptId"].as_str(),
            frame["revision"].as_u64(),
            frame["type"].as_str(),
        ) else {
            return false;
        };
        if self
            .last_revision
            .is_some_and(|previous| revision <= previous)
        {
            return false;
        }
        self.last_revision = Some(revision);
        if kind == "start" {
            let (Some(turn), Some(step)) = (frame["turn"].as_u64(), frame["step"].as_u64()) else {
                return false;
            };
            let removed = self.remove_live(snapshot);
            self.live = Some(LiveAttempt {
                attempt_id: attempt_id.to_owned(),
                message_id: format!("{LIVE_ID_PREFIX}{attempt_id}"),
                turn,
                step,
                visible_indices: BTreeSet::new(),
            });
            return set_phase(snapshot, Some(AgentModelPhase::Streaming)) || removed;
        }
        let Some(attempt) = self
            .live
            .as_mut()
            .filter(|attempt| attempt.attempt_id == attempt_id)
        else {
            return false;
        };
        if kind == "end" {
            let removed = self.remove_live(snapshot);
            return set_phase(snapshot, None) || removed;
        }
        if kind != "chunk" {
            return false;
        }
        let chunk = &frame["chunk"];
        let Some(index) = chunk["index"].as_u64() else {
            return false;
        };
        let (part, append) = match chunk["type"].as_str() {
            Some("text-delta") => (
                chunk["text"].as_str().map(|text| AgentPart::Text {
                    text: text.to_owned(),
                }),
                true,
            ),
            Some("reasoning-delta") => (
                chunk["text"].as_str().map(|text| AgentPart::Reasoning {
                    text: text.to_owned(),
                }),
                true,
            ),
            Some("block-end") => (text_part(&chunk["block"]), false),
            _ => return false,
        };
        let Some(part) = part else {
            return false;
        };
        let created_at = frame["time"]
            .as_u64()
            .unwrap_or(snapshot.session.updated_at);
        let message_index = match snapshot
            .messages
            .iter()
            .rposition(|message| message.id == attempt.message_id)
        {
            Some(index) => index,
            None => {
                attempt.visible_indices.clear();
                snapshot.messages.push(AgentMessage {
                    id: attempt.message_id.clone(),
                    role: "assistant".into(),
                    created_at,
                    completed_at: None,
                    parts: Vec::new(),
                });
                snapshot.messages.len() - 1
            }
        };
        let message = &mut snapshot.messages[message_index];
        let position = attempt.visible_indices.range(..index).count();
        if attempt.visible_indices.insert(index) {
            message.parts.insert(position, part);
        } else if append {
            match (&mut message.parts[position], part) {
                (AgentPart::Text { text }, AgentPart::Text { text: delta })
                | (AgentPart::Reasoning { text }, AgentPart::Reasoning { text: delta }) => {
                    text.push_str(&delta);
                }
                _ => return false,
            }
        } else {
            message.parts[position] = part;
        }
        true
    }
}

/// Persist the durable view only. The SDK may commit a different message id or
/// abandon an attempt after any number of transient frames.
pub(super) fn is_live_message(id: &str) -> bool {
    id.starts_with(LIVE_ID_PREFIX)
}

/// Apply the durable SDK view. This can also replay an owned session's log in
/// sequence when the app reconnects without live stream frames.
pub(super) fn apply(snapshot: &mut AgentSnapshot, notification: &Value) -> bool {
    let params = &notification["params"];
    let changed = match notification["method"].as_str() {
        Some("session.status") => match params["status"].as_str() {
            Some("running") if snapshot.permissions.is_empty() && snapshot.questions.is_empty() => {
                set_status(snapshot, AgentStatus::Running)
            }
            Some("idle") if snapshot.status == AgentStatus::Running => {
                let cleared = set_phase(snapshot, None);
                set_status(snapshot, AgentStatus::Idle) || cleared
            }
            _ => false,
        },
        Some("session.event") => apply_event(snapshot, &params["event"]),
        Some("lolicode/session.mode") => {
            let (Ok(goal), Ok(plan)) = (
                serde_json::from_value(params["goal"].clone()),
                serde_json::from_value(params["plan"].clone()),
            ) else {
                return false;
            };
            let changed = snapshot.goal != goal || snapshot.plan != plan;
            snapshot.goal = goal;
            snapshot.plan = plan;
            changed
        }
        _ => return false,
    };
    let connected = !snapshot.stream_connected;
    snapshot.stream_connected = true;
    changed || connected
}

fn apply_event(snapshot: &mut AgentSnapshot, event: &Value) -> bool {
    let data = &event["data"];
    let time = event["time"].as_u64();
    let changed = match event["type"].as_str() {
        Some("turn/start") => {
            let cleared = snapshot.error.take().is_some();
            let status = set_status(snapshot, AgentStatus::Running);
            set_phase(snapshot, Some(AgentModelPhase::Waiting)) || cleared || status
        }
        Some("step/start") => set_phase(snapshot, Some(AgentModelPhase::Waiting)),
        Some("user/message") if data["source"]["kind"] == "user" => {
            add_message(snapshot, message(data, "user", time))
        }
        Some("assistant/message") => {
            let cleared = set_phase(snapshot, None);
            add_message(snapshot, assistant_message(data, time)) || cleared
        }
        Some("assistant/attempt" | "step/end") => set_phase(snapshot, None),
        Some("tool/call") => update_tool(snapshot, data, false),
        Some("tool/result") => update_tool(snapshot, data, true),
        Some("turn/end") => finish_turn(snapshot, &data["reason"]),
        _ => false,
    };
    if changed {
        if let Some(time) = time {
            snapshot.session.updated_at = snapshot.session.updated_at.max(time);
        }
    }
    changed
}

fn finish_turn(snapshot: &mut AgentSnapshot, reason: &Value) -> bool {
    let Some(kind) = reason["kind"].as_str() else {
        return false;
    };
    let error = match kind {
        "completed" | "aborted" | "forked" => None,
        "blocked" => Some("本轮请求被阻止".into()),
        "max-tokens" => Some("本轮达到模型输出上限".into()),
        "interrupted" => Some("上次任务中断，可继续会话".into()),
        "error" if reason["error"]["code"] == "AUTH" => Some(
            "模型服务认证失败（AUTH），请检查当前渠道的 API Key 或登录状态后重试；会话已保留"
                .into(),
        ),
        // Error text may originate in a provider or its response body. Show
        // the structured code without passing that raw body into the renderer.
        "error" => Some(
            reason["error"]["code"]
                .as_str()
                .filter(|code| {
                    !code.is_empty()
                        && code.len() <= 64
                        && code.bytes().all(|byte| {
                            byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                        })
                })
                .map_or_else(
                    || "本轮运行失败".into(),
                    |code| format!("本轮运行失败（{code}）"),
                ),
        ),
        _ => Some("本轮提前结束".into()),
    };
    let status = if error.is_some() {
        AgentStatus::Error
    } else {
        AgentStatus::Idle
    };
    let changed = snapshot.error != error;
    snapshot.error = error;
    let cleared = set_phase(snapshot, None);
    set_status(snapshot, status) || changed || cleared
}

fn set_status(snapshot: &mut AgentSnapshot, status: AgentStatus) -> bool {
    let changed = snapshot.status != status;
    snapshot.status = status;
    changed
}

fn set_phase(snapshot: &mut AgentSnapshot, phase: Option<AgentModelPhase>) -> bool {
    let changed = snapshot.model_phase != phase;
    snapshot.model_phase = phase;
    changed
}

fn assistant_message(data: &Value, time: Option<u64>) -> Option<AgentMessage> {
    message(&data["message"], "assistant", time)
}

fn message(value: &Value, role: &str, time: Option<u64>) -> Option<AgentMessage> {
    let id = value["id"].as_str().filter(|id| !id.is_empty())?;
    let created_at = time?;
    if value["role"] != role {
        return None;
    }
    let parts = value["content"]
        .as_array()?
        .iter()
        .filter_map(|block| {
            if role == "assistant" && block["type"] == "tool-call" {
                Some(AgentPart::Tool {
                    id: block["id"].as_str()?.into(),
                    name: block["name"].as_str()?.into(),
                    state: "pending".into(),
                    input: tool_input(&block["arguments"]),
                    output: None,
                    error: None,
                })
            } else {
                text_part(block)
            }
        })
        .collect::<Vec<_>>();
    if parts.is_empty() && role != "user" {
        return None;
    }
    Some(AgentMessage {
        id: id.into(),
        role: role.into(),
        created_at,
        completed_at: Some(created_at),
        parts,
    })
}

fn text_part(block: &Value) -> Option<AgentPart> {
    let text = block["text"].as_str()?.to_owned();
    match block["type"].as_str()? {
        "text" => Some(AgentPart::Text { text }),
        "reasoning" => Some(AgentPart::Reasoning { text }),
        _ => None,
    }
}

fn add_message(snapshot: &mut AgentSnapshot, message: Option<AgentMessage>) -> bool {
    let Some(message) = message else {
        return false;
    };
    if snapshot.messages.iter().any(|item| item.id == message.id) {
        return false;
    }
    snapshot.messages.push(message);
    true
}

fn tool_input(arguments: &Value) -> Value {
    arguments.as_str().map_or(Value::Null, |text| {
        serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.into()))
    })
}

fn update_tool(snapshot: &mut AgentSnapshot, data: &Value, result: bool) -> bool {
    let call_id = if result {
        data["message"]["toolCallId"].as_str()
    } else {
        data["callId"].as_str()
    };
    let Some(call_id) = call_id else {
        return false;
    };
    let part = snapshot
        .messages
        .iter_mut()
        .rev()
        .filter(|message| message.role == "assistant")
        .flat_map(|message| message.parts.iter_mut())
        .find(|part| matches!(part, AgentPart::Tool { id, .. } if id == call_id));
    let Some(AgentPart::Tool {
        state,
        input,
        output,
        error,
        ..
    }) = part
    else {
        return false;
    };
    if result {
        let failed = data["message"]["isError"] == true;
        let text = data["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        *state = if failed { "error" } else { "completed" }.into();
        *output = (!text.is_empty()).then_some(text);
        *error = failed.then(|| {
            data["error"]["reason"]
                .as_str()
                .or(output.as_deref())
                .unwrap_or("工具执行失败")
                .into()
        });
    } else if state == "pending" {
        *state = "running".into();
        *input = tool_input(&data["arguments"]);
    } else {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> AgentSnapshot {
        serde_json::from_value(json!({
            "session": {
                "id": "lc:local", "title": "Chat", "projectPath": "project", "mode": "build",
                "model": null, "createdAt": 1, "updatedAt": 1, "coordination": null
            },
            "status": "idle", "messages": [], "permissions": [], "questions": [],
            "diffs": [], "error": null, "streamConnected": false, "streamGap": false
        }))
        .unwrap()
    }

    fn event(kind: &str, data: Value) -> Value {
        json!({
            "method": "session.event",
            "params": {"event": {"type": kind, "time": 2, "data": data}}
        })
    }

    fn stream(frame: Value) -> Value {
        json!({"method": "lolicode/session.assistant-stream", "params": {"frame": frame}})
    }

    #[test]
    fn applies_only_human_prompts_and_resolves_tool_results_on_the_assistant_message() {
        let mut snapshot = snapshot();
        apply(&mut snapshot, &event("turn/start", json!({"turn": 1})));
        for (id, source) in [("hidden", "runtime-context"), ("request", "user")] {
            apply(
                &mut snapshot,
                &event(
                    "user/message",
                    json!({"id": id, "source": {"kind": source}, "role": "user",
                        "content": [{"type": "text", "text": "read a file"}]}),
                ),
            );
        }
        let response = event(
            "assistant/message",
            json!({"turn": 1, "step": 1, "message": {"id": "reply", "role": "assistant",
                "content": [{"type": "reasoning", "text": "inspect the source"},
                    {"type": "tool-call", "id": "read1", "name": "read",
                        "arguments": "{\"path\":\"README.md\"}"}]}}),
        );
        apply(&mut snapshot, &response);
        assert!(!apply(&mut snapshot, &response));
        assert_eq!(snapshot.messages.len(), 2);
        assert_eq!(snapshot.messages[0].id, "request");
        assert!(matches!(
            &snapshot.messages[1].parts[0],
            AgentPart::Reasoning { .. }
        ));

        apply(
            &mut snapshot,
            &event(
                "tool/call",
                json!({"callId": "read1", "arguments": "{\"path\":\"README.md\"}"}),
            ),
        );
        assert!(matches!(
            &snapshot.messages[1].parts[1],
            AgentPart::Tool { state, input, .. } if state == "running" && input["path"] == "README.md"
        ));
        apply(
            &mut snapshot,
            &event(
                "tool/result",
                json!({"message": {"toolCallId": "read1", "isError": true,
                "content": [{"type": "text", "text": "File missing"}]}}),
            ),
        );
        assert!(matches!(
            &snapshot.messages[1].parts[1],
            AgentPart::Tool { state, error: Some(error), .. }
                if state == "error" && error == "File missing"
        ));
        apply(
            &mut snapshot,
            &event("turn/end", json!({"reason": {"kind": "completed"}})),
        );
        assert_eq!(snapshot.status, AgentStatus::Idle);
    }

    #[test]
    fn stream_replaces_transient_message_with_durable_result_and_ignores_duplicate_frame() {
        let mut snapshot = snapshot();
        let mut view = HarnessSnapshotProjection::default();
        view.apply(
            &mut snapshot,
            &stream(json!({
                "type": "start", "attemptId": "session:1", "revision": 1, "turn": 1, "step": 1
            })),
        );
        let frame = stream(json!({
            "type": "chunk", "attemptId": "session:1", "revision": 2, "time": 2,
            "chunk": {"type": "text-delta", "index": 1, "text": "Hello"}
        }));
        assert!(view.apply(&mut snapshot, &frame));
        assert!(!view.apply(&mut snapshot, &frame));
        assert_eq!(snapshot.model_phase, Some(AgentModelPhase::Streaming));
        assert!(is_live_message(&snapshot.messages[0].id));
        view.apply(
            &mut snapshot,
            &stream(json!({
                "type": "chunk", "attemptId": "session:1", "revision": 3, "time": 2,
                "chunk": {"type": "reasoning-delta", "index": 0, "text": "Consider"}
            })),
        );
        assert!(
            matches!(&snapshot.messages[0].parts[1], AgentPart::Text { text } if text == "Hello")
        );
        view.apply(
            &mut snapshot,
            &event(
                "assistant/message",
                json!({
                    "turn": 1, "step": 1, "message": {"id": "reply", "role": "assistant",
                        "content": [{"type": "text", "text": "Hello world"}]}
                }),
            ),
        );
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].id, "reply");
        assert!(
            matches!(&snapshot.messages[0].parts[0], AgentPart::Text { text } if text == "Hello world")
        );
        assert!(snapshot.messages[0].completed_at.is_some());
        assert!(!view.apply(
            &mut snapshot,
            &stream(json!({
                "type": "end", "attemptId": "session:1", "revision": 4
            }))
        ));
    }

    #[test]
    fn failed_attempt_discards_live_text_and_preserves_terminal_error_on_idle() {
        let mut snapshot = snapshot();
        let mut view = HarnessSnapshotProjection::default();
        view.apply(
            &mut snapshot,
            &stream(json!({
                "type": "start", "attemptId": "session:1", "revision": 1, "turn": 1, "step": 1
            })),
        );
        view.apply(
            &mut snapshot,
            &stream(json!({
                "type": "chunk", "attemptId": "session:1", "revision": 2, "time": 2,
                "chunk": {"type": "text-delta", "index": 0, "text": "Do not save"}
            })),
        );
        view.apply(
            &mut snapshot,
            &event("assistant/attempt", json!({"turn": 1, "step": 1})),
        );
        view.apply(
            &mut snapshot,
            &event(
                "turn/end",
                json!({"reason": {"kind": "error",
            "error": {"code": "HTTP_429", "message": "raw provider error"}}}),
            ),
        );
        view.apply(
            &mut snapshot,
            &json!({"method":"session.status", "params":{"status":"idle"}}),
        );
        assert!(snapshot.messages.is_empty());
        assert_eq!(snapshot.status, AgentStatus::Error);
        assert_eq!(snapshot.error.as_deref(), Some("本轮运行失败（HTTP_429）"));
    }
}
