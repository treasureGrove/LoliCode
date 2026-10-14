use crate::{mapping, AgentMessage, AgentPart};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

// Upstream's text/reasoning ordinals are per-kind, not content-array offsets.
#[derive(Debug, Clone)]
struct LivePart {
    ordinal: u64,
    part: AgentPart,
    complete: bool,
    gap: bool,
}

#[derive(Debug, Clone)]
struct LiveMessage {
    session_id: String,
    created_at: u64,
    parts: Vec<LivePart>,
    normal_finished: bool,
}

#[derive(Default)]
pub(crate) struct LiveState {
    pub connected: bool,
    tracked: HashSet<String>,
    messages: HashMap<String, LiveMessage>,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
    pub pending: HashMap<String, (String, u64)>,
}

impl LiveState {
    pub fn track(&mut self, session_id: &str) {
        self.tracked.insert(session_id.into());
    }

    pub fn tracked_sessions(&self) -> Vec<String> {
        self.tracked.iter().cloned().collect()
    }

    pub fn untrack(&mut self, session_id: &str) {
        self.tracked.remove(session_id);
        self.pending.remove(session_id);
        self.messages
            .retain(|_, message| message.session_id != session_id);
    }

    pub fn disconnected(&mut self) {
        self.connected = false;
        for message in self.messages.values_mut() {
            for part in &mut message.parts {
                if !part.complete {
                    part.gap = true;
                }
            }
        }
    }

    pub fn apply(&mut self, event: &Value) {
        let event_type = mapping::string(event, "type");
        if event_type == "server.connected" {
            self.connected = true;
            return;
        }
        let data = &event["data"];
        let session_id = mapping::string(data, "sessionID");
        if !self.tracked.contains(&session_id) {
            return;
        }
        let event_id = mapping::string(event, "id");
        if !event_id.is_empty() {
            if !self.seen.insert(event_id.clone()) {
                return;
            }
            self.seen_order.push_back(event_id);
            if self.seen_order.len() > 2048 {
                if let Some(old) = self.seen_order.pop_front() {
                    self.seen.remove(&old);
                }
            }
        }
        let message_id = mapping::string(data, "assistantMessageID");
        if message_id.is_empty() {
            return;
        }
        if event_type == "session.step.ended" {
            if let Some(message) = self.messages.get_mut(&message_id) {
                message.normal_finished = true;
            }
            self.prune_success(&message_id);
            return;
        }
        // Failed/interrupted steps can finish before ephemeral text has been
        // captured by the DB. Keep their arrived prefix until a snapshot proves
        // that the terminal message contains it.
        if !event_type.starts_with("session.text.")
            && !event_type.starts_with("session.reasoning.")
            && !event_type.starts_with("session.tool.")
            && event_type != "session.step.started"
        {
            return;
        }
        // Completed messages are pruned on snapshots. Bound unsnapshotted state too.
        if !self.messages.contains_key(&message_id) && self.messages.len() >= 256 {
            self.disconnected();
            return;
        }
        let cache_key = message_id.clone();
        let message = self
            .messages
            .entry(message_id)
            .or_insert_with(|| LiveMessage {
                session_id,
                created_at: mapping::timestamp(event, "created"),
                parts: Vec::new(),
                normal_finished: false,
            });
        if event_type.starts_with("session.text.") || event_type.starts_with("session.reasoning.") {
            let reasoning = event_type.starts_with("session.reasoning.");
            let ordinal = mapping::timestamp(data, "ordinal");
            let existing = message.parts.iter().position(|part| {
                part.ordinal == ordinal
                    && matches!(
                        (&part.part, reasoning),
                        (AgentPart::Text { .. }, false) | (AgentPart::Reasoning { .. }, true)
                    )
            });
            let index = existing.unwrap_or_else(|| {
                message.parts.push(LivePart {
                    ordinal,
                    part: if reasoning {
                        AgentPart::Reasoning {
                            text: String::new(),
                        }
                    } else {
                        AgentPart::Text {
                            text: String::new(),
                        }
                    },
                    complete: false,
                    gap: !event_type.ends_with(".started"),
                });
                message.parts.len() - 1
            });
            let live = &mut message.parts[index];
            let text = match &mut live.part {
                AgentPart::Text { text } | AgentPart::Reasoning { text } => text,
                _ => unreachable!(),
            };
            if event_type.ends_with(".delta") {
                // A disconnected fragment cannot be honestly concatenated over a gap.
                // Text.Ended supplies the authoritative full text to repair it.
                if !live.gap && !live.complete {
                    text.push_str(data["delta"].as_str().unwrap_or(""));
                }
            } else if event_type.ends_with(".ended") {
                *text = mapping::string(data, "text");
                live.complete = true;
                live.gap = false;
            }
            self.prune_success(&cache_key);
            return;
        }
        if !event_type.starts_with("session.tool.") {
            return;
        }
        let tool_id = mapping::string(data, "id");
        let index = message
            .parts
            .iter()
            .position(|part| matches!(&part.part, AgentPart::Tool { id, .. } if id == &tool_id))
            .unwrap_or_else(|| {
                message.parts.push(LivePart {
                    ordinal: 0,
                    part: AgentPart::Tool {
                        id: tool_id.clone(),
                        name: mapping::string(data, "name"),
                        state: "pending".into(),
                        input: Value::String(String::new()),
                        output: None,
                        error: None,
                    },
                    complete: false,
                    gap: !event_type.ends_with(".started"),
                });
                message.parts.len() - 1
            });
        let live = &mut message.parts[index];
        if let AgentPart::Tool {
            name,
            state,
            input,
            output,
            error,
            ..
        } = &mut live.part
        {
            if let Some(value) = data["name"].as_str() {
                *name = value.into();
            }
            match event_type.as_str() {
                "session.tool.input.delta" if !live.gap => {
                    if let Value::String(text) = input {
                        text.push_str(data["delta"].as_str().unwrap_or(""));
                    }
                }
                "session.tool.input.ended" => {
                    *input = Value::String(mapping::string(data, "text"));
                    live.gap = false;
                }
                "session.tool.called" => {
                    *input = data["input"].clone();
                    *state = "running".into();
                    live.gap = false;
                }
                "session.tool.success" | "session.tool.failed" => {
                    let failed = event_type == "session.tool.failed";
                    let raw = json!({"type":"assistant","id":"msg_mapping","content":[{
                    "type":"tool","id":tool_id,"name":name,"state":{
                        "status":if failed {"error"}else{"completed"},
                        "input":input,"content":data["content"],"error":data["error"]
                    }}]});
                    if let Some(mapped) = mapping::message(&raw) {
                        if let Some(AgentPart::Tool {
                            output: final_output,
                            error: final_error,
                            ..
                        }) = mapped.parts.into_iter().next()
                        {
                            *output = final_output;
                            *error = final_error;
                        }
                    }
                    *state = if failed { "error" } else { "completed" }.into();
                    live.complete = true;
                    live.gap = false;
                }
                _ => {}
            }
        }
        self.prune_success(&cache_key);
    }

    fn prune_success(&mut self, message_id: &str) {
        if self.messages.get(message_id).is_some_and(|message| {
            message.normal_finished && message.parts.iter().all(|part| part.complete)
        }) {
            self.messages.remove(message_id);
        }
    }

    #[cfg(test)]
    pub(crate) fn cached_messages(&self) -> usize {
        self.messages.len()
    }

    /// Apply live-only partials without duplicating authoritative persisted text.
    pub fn overlay(&mut self, session_id: &str, messages: &mut Vec<AgentMessage>) -> bool {
        let mut gap = false;
        let mut completed = Vec::new();
        let mut live: Vec<_> = self
            .messages
            .iter()
            .filter(|(_, m)| m.session_id == session_id)
            .collect();
        live.sort_by_key(|(_, message)| message.created_at);
        for (id, partial) in live {
            let index = messages.iter().position(|message| message.id == *id);
            if index.is_some_and(|index| {
                messages[index].completed_at.is_some()
                    && !partial
                        .parts
                        .iter()
                        .any(|part| needs_terminal_prefix(part, &messages[index]))
            }) {
                completed.push(id.clone());
                continue;
            }
            let index = index.unwrap_or_else(|| {
                messages.push(AgentMessage {
                    id: id.clone(),
                    role: "assistant".into(),
                    created_at: partial.created_at,
                    completed_at: None,
                    parts: Vec::new(),
                });
                messages.len() - 1
            });
            for part in &partial.parts {
                gap |= part.gap;
                let target = match &part.part {
                    AgentPart::Tool { id, .. } => messages[index].parts.iter().position(
                        |p| matches!(p, AgentPart::Tool { id: existing, .. } if id == existing),
                    ),
                    AgentPart::Text { .. } => messages[index]
                        .parts
                        .iter()
                        .enumerate()
                        .filter(|(_, p)| matches!(p, AgentPart::Text { .. }))
                        .nth(part.ordinal as usize)
                        .map(|(i, _)| i),
                    AgentPart::Reasoning { .. } => messages[index]
                        .parts
                        .iter()
                        .enumerate()
                        .filter(|(_, p)| matches!(p, AgentPart::Reasoning { .. }))
                        .nth(part.ordinal as usize)
                        .map(|(i, _)| i),
                };
                if let Some(target) = target {
                    // Ended fields in DB are authoritative. An incomplete empty DB
                    // part is replaced, never appended to the same token prefix.
                    let db_text = match &messages[index].parts[target] {
                        AgentPart::Text { text } | AgentPart::Reasoning { text } => Some(text),
                        _ => None,
                    };
                    let terminal_tool = matches!(&messages[index].parts[target], AgentPart::Tool { state, .. } if state == "completed" || state == "error");
                    if terminal_tool {
                        continue;
                    }
                    if part.complete
                        || db_text.is_some_and(|text| text.is_empty())
                        || (messages[index].completed_at.is_some()
                            && needs_terminal_prefix(part, &messages[index]))
                    {
                        messages[index].parts[target] = part.part.clone();
                    } else if db_text.is_none() {
                        let mut replacement = part.part.clone();
                        if let (
                            AgentPart::Tool { name, .. },
                            AgentPart::Tool { name: existing, .. },
                        ) = (&mut replacement, &messages[index].parts[target])
                        {
                            if name.is_empty() {
                                *name = existing.clone();
                            }
                        }
                        messages[index].parts[target] = replacement;
                    }
                } else {
                    messages[index].parts.push(part.part.clone());
                }
            }
        }
        for id in completed {
            self.messages.remove(&id);
        }
        messages.sort_by_key(|message| message.created_at);
        gap
    }
}

fn needs_terminal_prefix(part: &LivePart, message: &AgentMessage) -> bool {
    let (text, reasoning) = match &part.part {
        AgentPart::Text { text } => (text, false),
        AgentPart::Reasoning { text } => (text, true),
        _ => return false,
    };
    if text.is_empty() {
        return false;
    }
    let persisted = message
        .parts
        .iter()
        .filter_map(|part| match (part, reasoning) {
            (AgentPart::Text { text }, false) | (AgentPart::Reasoning { text }, true) => Some(text),
            _ => None,
        })
        .nth(part.ordinal as usize);
    persisted.is_none_or(|persisted| persisted.len() < text.len())
}

#[derive(Default)]
pub(crate) struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > 4 * 1024 * 1024 {
            return Err("引擎事件帧过大，正在重新连接".into());
        }
        let mut events = Vec::new();
        loop {
            let lf = self
                .buffer
                .windows(2)
                .position(|b| b == b"\n\n")
                .map(|i| (i, 2));
            let crlf = self
                .buffer
                .windows(4)
                .position(|b| b == b"\r\n\r\n")
                .map(|i| (i, 4));
            let boundary = match (lf, crlf) {
                (Some(a), Some(b)) => Some(if a.0 < b.0 { a } else { b }),
                (a, b) => a.or(b),
            };
            let Some((end, size)) = boundary else {
                break;
            };
            let frame: Vec<_> = self.buffer.drain(..end + size).collect();
            let text = std::str::from_utf8(&frame).map_err(|_| "引擎事件编码无效".to_string())?;
            let data = text
                .lines()
                .filter_map(|line| {
                    line.strip_prefix("data:")
                        .map(|v| v.strip_prefix(' ').unwrap_or(v))
                })
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() {
                continue;
            }
            let value: Value =
                serde_json::from_str(&data).map_err(|_| "引擎事件格式无效".to_string())?;
            events.push(value);
        }
        Ok(events)
    }
}
