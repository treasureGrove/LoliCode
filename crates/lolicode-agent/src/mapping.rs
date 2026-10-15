use crate::dto::*;
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

pub(crate) fn session(value: &Value) -> Result<AgentSession, String> {
    let id = string(value, "id");
    let project_path = string(&value["location"], "directory");
    if id.is_empty() || project_path.is_empty() {
        return Err("引擎返回了无法识别的会话，请检查引擎版本".into());
    }
    let model = value.get("model").and_then(|model| {
        let provider_id = string(model, "providerID");
        let model_id = string(model, "id");
        (!provider_id.is_empty() && !model_id.is_empty()).then_some(AgentModelRef {
            provider_id,
            model_id,
        })
    });
    Ok(AgentSession {
        id,
        title: optional_string(value, "title").unwrap_or_else(|| "新会话".into()),
        project_path,
        mode: optional_string(value, "agent").unwrap_or_else(|| "build".into()),
        permission_mode: crate::policy::identify(
            value["agent"].as_str().unwrap_or("build"),
            &value["permissions"],
        ),
        pinned: false,
        archived: false,
        model,
        created_at: timestamp(&value["time"], "created"),
        updated_at: timestamp(&value["time"], "updated"),
        activity: None,
        reasoning_effort: None,
    })
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
        for content in array(&value["content"]) {
            match string(content, "type").as_str() {
                "text" => parts.push(AgentPart::Text {
                    text: string(content, "text"),
                }),
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

pub(crate) fn permission(value: &Value, messages: &[AgentMessage]) -> AgentPermission {
    let tool_id = string(&value["source"], "id");
    let source_message = string(&value["source"], "messageID");
    let tool = messages
        .iter()
        .filter(|message| source_message.is_empty() || source_message == message.id)
        .flat_map(|message| message.parts.iter())
        .find_map(|part| match part {
            AgentPart::Tool {
                id, name, input, ..
            } if !tool_id.is_empty() && id == &tool_id => Some((name.clone(), input.clone())),
            _ => None,
        });
    AgentPermission {
        id: string(value, "id"),
        session_id: string(value, "sessionID"),
        action: string(value, "action"),
        resources: array(&value["resources"])
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        description: optional_string(value, "message"),
        tool_name: tool.as_ref().map(|(name, _)| name.clone()),
        tool_input: tool.map(|(_, input)| input),
        approval_mode: None,
    }
}

pub(crate) fn question(value: &Value) -> AgentQuestion {
    AgentQuestion {
        id: string(value, "id"),
        session_id: string(value, "sessionID"),
        title: string(value, "title"),
        fields: array(&value["fields"]).iter().map(question_field).collect(),
    }
}

fn question_field(value: &Value) -> AgentQuestionField {
    AgentQuestionField {
        key: string(value, "key"),
        field_type: string(value, "type"),
        title: optional_string(value, "title"),
        description: optional_string(value, "description"),
        required: value["required"].as_bool().unwrap_or(false),
        options: array(&value["options"])
            .iter()
            .map(|option| AgentQuestionOption {
                value: string(option, "value"),
                label: string(option, "label"),
                description: optional_string(option, "description"),
            })
            .collect(),
        custom: value["custom"].as_bool().unwrap_or(false),
        default_value: value.get("default").cloned(),
        hidden: value["hidden"].as_bool().unwrap_or(false),
        when: array(&value["when"]).to_vec(),
        format: optional_string(value, "format"),
        placeholder: optional_string(value, "placeholder"),
        min_length: value["minLength"].as_u64(),
        max_length: value["maxLength"].as_u64(),
        pattern: optional_string(value, "pattern"),
        min_items: value["minItems"].as_u64(),
        max_items: value["maxItems"].as_u64(),
        minimum: value["minimum"].as_f64(),
        maximum: value["maximum"].as_f64(),
        url: optional_string(value, "url"),
    }
}

pub(crate) fn diff(value: &Value) -> AgentDiff {
    AgentDiff {
        path: string(value, "file"),
        patch: string(value, "patch"),
        additions: timestamp(value, "additions"),
        deletions: timestamp(value, "deletions"),
        status: string(value, "status"),
    }
}
