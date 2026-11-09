use crate::dto::*;
use crate::images::ImageMarkdown;
use serde_json::Value;

pub(crate) fn string(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").into()
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub(crate) fn timestamp(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

pub(crate) fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

pub(crate) fn structured_error(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned).or_else(|| {
        optional_string(value, "message").or_else(|| optional_string(&value["data"], "message"))
    })
}

fn tool_output(content: &Value) -> Option<String> {
    let text: Vec<_> = array(content)
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    (!text.is_empty()).then(|| text.join("\n"))
}

pub(crate) fn message(value: &Value) -> Option<AgentMessage> {
    let message_type = string(value, "type");
    // An idle marker is a lifecycle record, never a user-visible chat message.
    if message_type == "idle" {
        return None;
    }
    let id = string(value, "id");
    if id.is_empty() {
        return None;
    }
    let role = match message_type.as_str() {
        "user" => "user",
        "assistant" => "assistant",
        _ => "system",
    }
    .into();
    let mut parts = Vec::new();
    if message_type == "assistant" {
        let mut images = ImageMarkdown::default();
        let mut image_parts = Vec::new();
        let completed = value["time"]["completed"].as_u64().is_some();
        for content in array(&value["content"]) {
            match string(content, "type").as_str() {
                "text" | "output_text" => parts.push(AgentPart::Text {
                    text: string(content, "text"),
                }),
                "image" | "image_url" | "output_image" => {
                    if let Some(text) = completed.then(|| images.block(content)).flatten() {
                        image_parts.push(AgentPart::Text { text });
                    }
                }
                "reasoning" => parts.push(AgentPart::Reasoning {
                    text: string(content, "text"),
                }),
                "tool" => {
                    let state = &content["state"];
                    let normalized = match string(state, "status").as_str() {
                        "streaming" => "pending",
                        "running" => "running",
                        "completed" => "completed",
                        "error" => "error",
                        _ => "pending",
                    };
                    parts.push(AgentPart::Tool {
                        id: string(content, "id"),
                        name: string(content, "name"),
                        state: normalized.into(),
                        input: state.get("input").cloned().unwrap_or(Value::Null),
                        output: tool_output(&state["content"]),
                        error: structured_error(&state["error"]),
                    });
                }
                _ => {}
            }
        }
        for image in array(&value["images"]) {
            if let Some(text) = completed.then(|| images.block(image)).flatten() {
                image_parts.push(AgentPart::Text { text });
            }
        }
        // Keep the original text blocks in order. Append image markdown only
        // for completed historical messages; partial records stay partial.
        parts.extend(image_parts);
    } else if let Some(text) = optional_string(value, "text") {
        parts.push(AgentPart::Text { text });
    } else if message_type == "shell" {
        parts.push(AgentPart::Tool {
            id: string(value, "shellID"),
            name: "shell".into(),
            state: string(value, "status"),
            input: serde_json::json!({ "command": string(value, "command") }),
            output: value["output"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| optional_string(&value["output"], "text")),
            error: None,
        });
    } else if message_type == "compaction" {
        parts.push(AgentPart::Text {
            text: "会话上下文已整理".into(),
        });
    } else if message_type == "model-switched" {
        parts.push(AgentPart::Text {
            text: format!("已切换模型：{}", string(&value["model"], "id")),
        });
    } else if message_type == "agent-switched" {
        parts.push(AgentPart::Text {
            text: format!("已切换模式：{}", string(value, "agent")),
        });
    }
    if parts.is_empty() && message_type != "assistant" {
        return None;
    }
    Some(AgentMessage {
        id,
        role,
        created_at: timestamp(&value["time"], "created"),
        completed_at: value["time"]["completed"].as_u64(),
        parts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn completed_legacy_history_keeps_text_and_deduplicates_safe_image_outputs() {
        let message = message(&json!({
            "id":"image-reply", "type":"assistant", "time":{"created":1000,"completed":1002},
            "content":[
                {"type":"output_text","text":"The generated previews:"},
                {"type":"image_url","image_url":{"url":"https://example.com/a.png"},"alt":"A"},
                {"type":"image","source":{"type":"url","url":"generated/b (2).png"},"alt":"B"},
                {"type":"image","url":"javascript:alert(1)"},
                {"type":"reasoning","text":"kept reasoning"}
            ],
            "images":[{"url":"https://example.com/a.png"},{"path":"generated/c.svg"}]
        }))
        .unwrap();
        assert_eq!(message.role, "assistant");
        assert_eq!(message.completed_at, Some(1002));
        assert_eq!(
            message.parts,
            vec![
                AgentPart::Text {
                    text: "The generated previews:".into()
                },
                AgentPart::Reasoning {
                    text: "kept reasoning".into()
                },
                AgentPart::Text {
                    text: "\n\n![A](<https://example.com/a.png>)\n\n".into()
                },
                AgentPart::Text {
                    text: "\n\n![B](<generated/b (2).png>)\n\n".into()
                },
                AgentPart::Text {
                    text: "\n\n![图片](<generated/c.svg>)\n\n".into()
                },
            ]
        );
    }

    #[test]
    fn incomplete_legacy_records_do_not_invent_final_images_or_visible_idle_messages() {
        assert!(message(&json!({"id":"idle", "type":"idle"})).is_none());
        assert!(message(&json!({"type":"user", "text":"missing identity"})).is_none());
        let message = message(&json!({
            "id":"partial", "type":"assistant", "time":{"created":1000},
            "content":[
                {"type":"text","text":"partial answer"},
                {"type":"image","path":"generated/unfinished.png"},
                {"type":"tool","id":"read-1","name":"read","state":{
                    "status":"completed", "input":{"path":"README.md"},
                    "content":[{"type":"text","text":"stored output"}]
                }}
            ]
        }))
        .unwrap();
        assert_eq!(message.completed_at, None);
        assert_eq!(
            message.parts,
            vec![
                AgentPart::Text {
                    text: "partial answer".into()
                },
                AgentPart::Tool {
                    id: "read-1".into(),
                    name: "read".into(),
                    state: "completed".into(),
                    input: json!({"path":"README.md"}),
                    output: Some("stored output".into()),
                    error: None,
                },
            ]
        );
    }
}
