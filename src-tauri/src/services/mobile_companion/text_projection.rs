//! Explicit phone text view. Never serialize an agent snapshot or tool payload verbatim.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(super) const MAX_RESULT_BYTES: usize = 4_000;
pub(super) const MAX_REQUEST_PARAMS_BYTES: usize = 4_096;
const RESULT_RESERVE: usize = 80; // SHA-256 revision plus its JSON key and quotes.
const DIRECT: &str = "内容超过文本中继范围，请直连查看完整内容；未执行任何审批";
const NOTICE: &str = "文本模式仅显示文字和有限历史；工具详情、媒体和差异请直连查看。";

fn size(value: &Value) -> Result<usize, String> {
    serde_json::to_vec(value)
        .map(|v| v.len())
        .map_err(|_| DIRECT.into())
}

fn forbidden_key(key: &str) -> bool {
    let key: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    matches!(
        key.as_str(),
        "image"
            | "images"
            | "imageurl"
            | "attachment"
            | "attachments"
            | "file"
            | "files"
            | "base64"
            | "dataurl"
            | "blob"
            | "binary"
            | "audio"
            | "video"
            | "toolinput"
            | "tooloutput"
            | "input"
            | "output"
            | "diff"
            | "diffs"
            | "patch"
    )
}

fn has_encoded_or_media(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if [
        "data:image/",
        "data:audio/",
        "data:video/",
        "data:application/",
        ";base64,",
        "file://",
        "![",
        "```diff",
        "diff --git ",
        "\n@@ ",
    ]
    .iter()
    .any(|p| lower.contains(p))
    {
        return true;
    }
    // A text frame is not evidence that its contents are text: reject large encoded blobs.
    let mut run = 0;
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'_' | b'-' | b'=') {
            run += 1;
            if run >= 256 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

fn text_tree(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
    *nodes += 1;
    if depth > 12 || *nodes > 512 {
        return Err(DIRECT.into());
    }
    match value {
        Value::String(s) if s.contains('\0') || has_encoded_or_media(s) => Err(DIRECT.into()),
        Value::Array(a) => {
            if a.len() > 64 {
                return Err(DIRECT.into());
            }
            for v in a {
                text_tree(v, depth + 1, nodes)?;
            }
            Ok(())
        }
        Value::Object(o) => {
            if o.len() > 64 {
                return Err(DIRECT.into());
            }
            for (key, v) in o {
                if forbidden_key(key) {
                    return Err(DIRECT.into());
                }
                text_tree(v, depth + 1, nodes)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn exact(value: &Value, key: &str, max: usize) -> Result<String, String> {
    let value = value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= max
                && !s.chars().any(char::is_control)
                && !has_encoded_or_media(s)
        })
        .ok_or(DIRECT)?;
    Ok(value.into())
}

/// Return a UTF-8-safe suffix, including the ellipsis in the byte budget.
fn tail(text: &str, budget: usize) -> String {
    if text.len() <= budget {
        return text.into();
    }
    if budget < 3 {
        return String::new();
    }
    let mut start = text.len().saturating_sub(budget - 3);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &text[start..])
}

fn label(value: &Value, key: &str, max: usize) -> String {
    let text = value.get(key).and_then(Value::as_str).unwrap_or("");
    if has_encoded_or_media(text) {
        "相关内容需直连查看".into()
    } else {
        tail(text, max)
    }
}

pub(super) fn validate_request(method: &str, params: &Value) -> Result<(), String> {
    if size(params)? > MAX_REQUEST_PARAMS_BYTES {
        return Err("文本请求超过 4096 字节，请缩短输入或使用直连".into());
    }
    let allowed: &[&str] = match method {
        "status" | "projects.list" | "sessions.list" => &[],
        "models.list" => &["projectPath"],
        "session.create" => &["projectPath", "modelId", "title"],
        "session.get" => &["sessionId", "knownRevision", "offset", "limit"],
        "message.send" => &["sessionId", "text"],
        "run.cancel" => &["sessionId"],
        "permission.reply" => &["sessionId", "permissionId", "decision"],
        "question.reply" => &["sessionId", "questionId", "answers"],
        _ => return Err("此方法未开放给文本中继".into()),
    };
    let object = params.as_object().ok_or("文本请求参数必须为对象")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("文本请求包含未开放的参数".into());
    }
    text_tree(params, 0, &mut 0)?;
    if allowed.contains(&"sessionId") {
        exact(params, "sessionId", 128)?;
    }
    if allowed.contains(&"projectPath") {
        exact(params, "projectPath", 2048)?;
    }
    match method {
        "session.create" => {
            exact(params, "modelId", 512)?;
            if params.get("title").is_some() {
                exact(params, "title", 160)?;
            }
        }
        "message.send" => {
            if params["text"].as_str().is_none_or(|s| s.trim().is_empty()) {
                return Err("文本消息不能为空".into());
            }
        }
        "session.get" => {
            if let Some(value) = params.get("knownRevision") {
                let revision = value.as_str().ok_or("修订编号无效")?;
                if revision.len() != 64
                    || !revision
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                {
                    return Err("修订编号无效".into());
                }
            }
            if params
                .get("offset")
                .is_some_and(|v| v.as_u64().is_none_or(|n| n > 100_000))
                || params
                    .get("limit")
                    .is_some_and(|v| v.as_u64().is_none_or(|n| n == 0 || n > 12))
            {
                return Err("历史分页参数无效".into());
            }
        }
        "permission.reply" => {
            exact(params, "permissionId", 128)?;
            if params["decision"] != "reject" {
                return Err(
                    "文本模式不提供完整操作输入，请直连查看详情后批准；当前仅可拒绝".into(),
                );
            }
        }
        "question.reply" => {
            exact(params, "questionId", 128)?;
            let answers = params["answers"].as_object().ok_or("问题答案必须为对象")?;
            if answers.len() > 16
                || answers.values().any(|v| {
                    v.is_object()
                        || v.as_array()
                            .is_some_and(|a| a.iter().any(|v| v.is_array() || v.is_object()))
                })
            {
                return Err(DIRECT.into());
            }
        }
        _ => {}
    }
    Ok(())
}

fn session(value: &Value) -> Result<Value, String> {
    Ok(
        json!({"id":exact(value,"id",128)?,"title":label(value,"title",160),"projectPath":exact(value,"projectPath",2048)?}),
    )
}

fn pick(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| value.get(*key).map(|v| ((*key).into(), v.clone())))
            .collect(),
    )
}

fn pending(snapshot: &Value, key: &str) -> Result<Vec<Value>, String> {
    let values = snapshot.get(key).and_then(Value::as_array).ok_or(DIRECT)?;
    if values.len() > 8 {
        return Err("待处理项目过多，请直连查看；文本模式未省略或处理任何待审批项".into());
    }
    values.iter().map(|v| {
        let id = exact(v, "id", 128)?;
        if key == "permissions" {
            // Parsed resources omit operators and exact input. Never offer approval from this view.
            Ok(json!({"id":id,"sessionId":exact(v,"sessionId",128)?,"action":label(v,"action",64),
                "toolName":label(v,"toolName",96),"description":"完整操作输入需直连查看；文本模式仅可拒绝。",
                "resources":[],"requiresDirect":true,"canApprove":false}))
        } else {
            let fields = v["fields"].as_array().filter(|a| a.len() <= 16).ok_or(DIRECT)?;
            let mut projected = Vec::new();
            for field in fields {
                let field = pick(field, &["key","type","title","description","required","options","custom","default","hidden","when","format","placeholder","minLength","maxLength","pattern","minItems","maxItems","minimum","maximum","url"]);
                if field["type"].as_str().is_some_and(forbidden_key) { return Err(DIRECT.into()); }
                exact(&field, "key", 128)?;
                text_tree(&field, 0, &mut 0)?;
                // No truncation of field keys, choices, defaults or conditional validation.
                projected.push(field);
            }
            let result = json!({"id":id,"sessionId":exact(v,"sessionId",128)?,"title":v.get("title").cloned().unwrap_or(json!("需要你回答")),"fields":projected});
            text_tree(&result, 0, &mut 0)?;
            Ok(result)
        }
    }).collect()
}

fn message_text(message: &Value) -> String {
    let mut pieces = Vec::new();
    let mut remaining: usize = 1024;
    if let Some(parts) = message["parts"].as_array() {
        for part in parts
            .iter()
            .rev()
            .filter(|part| part["type"] == "text")
            .take(64)
        {
            let Some(text) = part["text"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            if remaining <= 3 {
                break;
            }
            let text = if has_encoded_or_media(text) {
                "媒体、编码内容或差异请直连查看。"
            } else {
                text
            };
            let text = tail(text, remaining);
            remaining = remaining.saturating_sub(text.len() + 1);
            pieces.push(text);
        }
    }
    pieces.reverse();
    pieces.join("\n")
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(o) => serde_json::to_value(
            o.iter()
                .map(|(k, v)| (k.clone(), canonical(v)))
                .collect::<BTreeMap<_, _>>(),
        )
        .unwrap_or(Value::Null),
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        v => v.clone(),
    }
}

fn snapshot(params: &Value, value: &Value) -> Result<Value, String> {
    let status = value["status"]
        .as_str()
        .filter(|s| {
            matches!(
                *s,
                "idle" | "running" | "waiting_permission" | "waiting_question" | "error"
            )
        })
        .ok_or(DIRECT)?;
    let messages = value["messages"]
        .as_array()
        .filter(|a| a.len() <= 100_000)
        .ok_or(DIRECT)?;
    let eligible: Vec<_> = messages
        .iter()
        .filter(|m| {
            matches!(m["role"].as_str(), Some("user" | "assistant"))
                && m["parts"].as_array().is_some_and(|parts| {
                    parts.iter().any(|p| {
                        p["type"] == "text" && p["text"].as_str().is_some_and(|s| !s.is_empty())
                    })
                })
        })
        .collect();
    let offset = params["offset"].as_u64().unwrap_or(0) as usize;
    let limit = params["limit"].as_u64().unwrap_or(6) as usize;
    let mut selected = Vec::new();
    for m in eligible.iter().rev().skip(offset).take(limit) {
        let mut message =
            json!({"role":m["role"],"parts":[{"type":"text","text":message_text(m)}]});
        if m.get("id").is_some() {
            message["id"] = json!(exact(m, "id", 128)?);
        }
        selected.push(message);
    }
    selected.reverse();
    let minimum = selected.len().min(2);
    let mut result = json!({"session":session(&value["session"])?,"status":status,"messages":selected,
        "permissions":pending(value,"permissions")?,"questions":pending(value,"questions")?,"diffs":[],
        "error":if value["error"].as_str().is_some_and(|s|!s.is_empty()) {"会话发生错误，请直连查看完整详情"} else {""},
        "truncated":true,"truncationMessage":NOTICE,"historyOffset":offset,"historyTotal":eligible.len()});
    loop {
        let count = result["messages"].as_array().map_or(0, Vec::len);
        result["hasMore"] = json!(offset.saturating_add(count) < eligible.len());
        result["nextOffset"] = if result["hasMore"] == true {
            json!(offset + count)
        } else {
            Value::Null
        };
        if size(&result)? <= MAX_RESULT_BYTES - RESULT_RESERVE {
            break;
        }
        let messages = result["messages"].as_array_mut().ok_or(DIRECT)?;
        if let Some((index, length)) = messages
            .iter()
            .enumerate()
            .filter_map(|(i, m)| m["parts"][0]["text"].as_str().map(|s| (i, s.len())))
            .filter(|(_, n)| *n > 64)
            .max_by_key(|(_, n)| *n)
        {
            let text = messages[index]["parts"][0]["text"].as_str().unwrap_or("");
            messages[index]["parts"][0]["text"] = json!(tail(text, (length / 2).max(64)));
        } else if messages.len() > minimum {
            messages.remove(0);
        } else {
            return Err(
                "审批、提问或会话元数据超出文本预算，请直连查看；待处理项未被省略或处理".into(),
            );
        }
    }
    let bytes = serde_json::to_vec(&canonical(&result)).map_err(|_| DIRECT)?;
    let revision: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if params["knownRevision"].as_str() == Some(revision.as_str()) {
        return Ok(json!({"notModified":true,"revision":revision}));
    }
    result["revision"] = json!(revision);
    Ok(result)
}

pub(super) fn project(method: &str, params: &Value, result: Value) -> Result<Value, String> {
    validate_request(method, params)?;
    let value = match method {
        "status" => {
            json!({"hostName":label(&result,"hostName",160),"protocol":result["protocol"].as_u64().ok_or(DIRECT)?,"quietMode":result["quietMode"].as_bool().ok_or(DIRECT)?})
        }
        "projects.list" => {
            let list = result.as_array().filter(|a| a.len() <= 128).ok_or(DIRECT)?;
            Value::Array(
                list.iter()
                    .map(|p| Ok(json!({"path":exact(p,"path",2048)?,"name":label(p,"name",160)})))
                    .collect::<Result<_, String>>()?,
            )
        }
        "sessions.list" => Value::Array(
            result
                .as_array()
                .filter(|a| a.len() <= 128)
                .ok_or(DIRECT)?
                .iter()
                .map(session)
                .collect::<Result<_, _>>()?,
        ),
        "models.list" => {
            let models = result["models"]
                .as_array()
                .filter(|a| a.len() <= 128)
                .ok_or(DIRECT)?;
            json!({"models":models.iter().map(|m|Ok(json!({"id":exact(m,"id",512)?,"name":label(m,"name",160)}))).collect::<Result<Vec<_>,String>>()?})
        }
        "session.create" => session(&result)?,
        "session.get" => snapshot(params, &result)?,
        "message.send" => {
            json!({"accepted":result["accepted"].as_bool().ok_or(DIRECT)?,"requestId":exact(&result,"requestId",128)?})
        }
        "run.cancel" | "permission.reply" | "question.reply" => {
            json!({"accepted":result["accepted"].as_bool().ok_or(DIRECT)?})
        }
        _ => return Err("此方法未开放给文本中继".into()),
    };
    if size(&value)? > MAX_RESULT_BYTES {
        Err(DIRECT.into())
    } else {
        Ok(value)
    }
}

/// Host errors can contain tool inputs, provider bodies, or encoded media.
pub(super) fn project_outcome(
    method: &str,
    params: &Value,
    result: Result<Value, String>,
) -> Result<Value, String> {
    match result {
        Ok(value) => project(method, params, value),
        Err(_) => Err("文本操作未完成，请刷新会话确认当前状态；完整错误请直连查看".into()),
    }
}

/// Re-project a durable receipt without dispatching its mutation again.
pub(super) fn project_receipt(
    method: &str,
    params: &Value,
    reply: &Value,
) -> Result<Value, String> {
    if reply["ok"] == true {
        project(
            method,
            params,
            reply.get("result").cloned().unwrap_or(Value::Null),
        )
    } else {
        Err("原请求未获确认或已被拒绝；请刷新状态，不要重复提交".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"session":{"id":"lc:test","title":"测试","projectPath":"D:/sandbox","model":{"secret":"never"}},"status":"running","messages":[
        {"id":"a","role":"user","parts":[{"type":"text","text":"你好"}]},
        {"id":"b","role":"assistant","parts":[{"type":"tool","input":{"secret":"TOOL_INPUT"},"output":"TOOL_OUTPUT"},{"type":"reasoning","text":"PRIVATE_THOUGHT"},{"type":"text","text":"回答"}]}],
        "permissions":[],"questions":[],"diffs":[{"patch":"FULL_PATCH"}],"usage":{"secret":"usage"},"updatedAt":123})
    }
    #[test]
    fn only_visible_text_and_allowlisted_metadata_leave_the_host() {
        let value = project("session.get", &json!({"sessionId":"lc:test"}), fixture()).unwrap();
        let encoded = value.to_string();
        for forbidden in [
            "TOOL_INPUT",
            "TOOL_OUTPUT",
            "PRIVATE_THOUGHT",
            "FULL_PATCH",
            "usage",
            "model",
        ] {
            assert!(!encoded.contains(forbidden), "{forbidden}");
        }
        assert_eq!(
            value["messages"][1]["parts"],
            json!([{"type":"text","text":"回答"}])
        );
        assert!(encoded.len() <= MAX_RESULT_BYTES);
    }
    #[test]
    fn revision_ignores_hidden_tool_and_usage_changes_but_tracks_visible_text() {
        let params = json!({"sessionId":"lc:test"});
        let first = project("session.get", &params, fixture()).unwrap();
        let known = json!({"sessionId":"lc:test","knownRevision":first["revision"]});
        let mut changed = fixture();
        changed["usage"] = json!({"tokens":9999});
        changed["messages"][1]["parts"][0]["output"] = json!("changed hidden tool");
        assert_eq!(
            project("session.get", &known, changed.clone()).unwrap(),
            json!({"notModified":true,"revision":first["revision"]})
        );
        changed["messages"][1]["parts"][2]["text"] = json!("新的回答");
        assert!(project("session.get", &known, changed)
            .unwrap()
            .get("notModified")
            .is_none());
    }
    #[test]
    fn chinese_suffix_and_json_escaping_fit_the_total_budget() {
        let mut source = fixture();
        source["messages"]=json!((0..12).map(|i|json!({"id":format!("m{i}"),"role":"assistant","parts":[{"type":"text","text":format!("{}终点", "中文🙂\"\\\n".repeat(1000))}]})).collect::<Vec<_>>());
        let value = project(
            "session.get",
            &json!({"sessionId":"lc:test","limit":12}),
            source,
        )
        .unwrap();
        assert!(size(&value).unwrap() <= MAX_RESULT_BYTES);
        assert!(value["messages"].as_array().unwrap().len() >= 2);
        for message in value["messages"].as_array().unwrap() {
            assert!(message["parts"][0]["text"]
                .as_str()
                .unwrap()
                .ends_with("终点"));
        }
        assert_eq!(tail("中文🙂尾", 7), "…尾");
    }
    #[test]
    fn media_encoded_and_diff_text_are_replaced_instead_of_relayed() {
        let mut source = fixture();
        source["messages"][1]["parts"] =
            json!([{"type":"text","text":format!("data:image/png;base64,{}","A".repeat(400))}]);
        let value = project("session.get", &json!({"sessionId":"lc:test"}), source).unwrap();
        assert!(!value.to_string().contains("data:image"));
        assert!(!value.to_string().contains(&"A".repeat(256)));
    }
    #[test]
    fn pending_permissions_are_present_but_cannot_be_blindly_approved() {
        let mut source = fixture();
        source["permissions"] = json!([{"id":"p","sessionId":"lc:test","action":"write","toolName":"Patch","toolInput":{"patch":"SECRET_PATCH"},"resources":["SECRET_RESOURCE"]}]);
        let value = project("session.get", &json!({"sessionId":"lc:test"}), source).unwrap();
        assert_eq!(value["permissions"][0]["id"], "p");
        assert_eq!(value["permissions"][0]["canApprove"], false);
        assert_eq!(value["permissions"][0]["requiresDirect"], true);
        assert!(!value.to_string().contains("SECRET_"));
        assert!(validate_request(
            "permission.reply",
            &json!({"sessionId":"lc:test","permissionId":"p","decision":"once"})
        )
        .is_err());
        assert!(validate_request(
            "permission.reply",
            &json!({"sessionId":"lc:test","permissionId":"p","decision":"reject"})
        )
        .is_ok());
    }
    #[test]
    fn question_options_defaults_and_when_remain_exact() {
        let mut source = fixture();
        let fields = json!([{"key":"choice","type":"select","required":true,"options":[{"value":"a","label":"选项甲"}],"default":"a","when":[{"key":"mode","equals":"advanced"}],"hidden":false}]);
        source["questions"] =
            json!([{"id":"q","sessionId":"lc:test","title":"请选择","fields":fields}]);
        let result = project("session.get", &json!({"sessionId":"lc:test"}), source).unwrap();
        assert_eq!(result["questions"][0]["fields"], fields);
    }
    #[test]
    fn oversized_question_is_an_error_not_a_missing_pending_item() {
        let mut source = fixture();
        source["questions"] =
            json!([{"id":"q","sessionId":"lc:test","title":"中文".repeat(2000),"fields":[]}]);
        assert!(
            project("session.get", &json!({"sessionId":"lc:test"}), source)
                .unwrap_err()
                .contains("直连")
        );
    }
    #[test]
    fn request_whitelist_rejects_nested_media_and_oversized_utf8() {
        assert!(validate_request("shell.exec", &json!({})).is_err());
        assert!(validate_request(
            "message.send",
            &json!({"sessionId":"s","text":"ok","attachment":{"data":"x"}})
        )
        .is_err());
        assert!(validate_request(
            "question.reply",
            &json!({"sessionId":"s","questionId":"q","answers":{"nested":{"image":"x"}}})
        )
        .is_err());
        assert!(validate_request(
            "message.send",
            &json!({"sessionId":"s","text":"汉".repeat(1400)})
        )
        .is_err());
        assert!(validate_request(
            "message.send",
            &json!({"sessionId":"s","text":"你好\n请继续"})
        )
        .is_ok());
    }
    #[test]
    fn paging_is_from_the_latest_visible_messages_and_revision_is_page_scoped() {
        let mut source = fixture();
        source["messages"]=json!((0..8).map(|i|json!({"id":format!("m{i}"),"role":"assistant","parts":[{"type":"text","text":format!("消息{i}")}]})).collect::<Vec<_>>());
        let value = project(
            "session.get",
            &json!({"sessionId":"lc:test","offset":2,"limit":2}),
            source,
        )
        .unwrap();
        assert_eq!(value["messages"][0]["id"], "m4");
        assert_eq!(value["messages"][1]["id"], "m5");
        assert_eq!(value["nextOffset"], 4);
        assert_eq!(value["historyTotal"], 8);
    }
    #[test]
    fn catalogs_and_mutation_receipts_never_copy_extra_data() {
        let model = project(
            "models.list",
            &json!({"projectPath":"D:/sandbox"}),
            json!({"models":[{"id":"m","name":"模型","apiKey":"secret"}],"config":"secret"}),
        )
        .unwrap();
        assert_eq!(model, json!({"models":[{"id":"m","name":"模型"}]}));
        assert_eq!(
            project(
                "message.send",
                &json!({"sessionId":"s","text":"继续"}),
                json!({"accepted":true,"requestId":"r","output":"secret"})
            )
            .unwrap(),
            json!({"accepted":true,"requestId":"r"})
        );
        let projects = json!((0..64)
            .map(|i| json!({"path":format!("D:/{}", "路径".repeat(100)),"name":format!("p{i}")}))
            .collect::<Vec<_>>());
        assert!(project("projects.list", &json!({}), projects).is_err());
    }
    #[test]
    fn old_direct_receipt_is_reprojected_without_forwarding_its_blob() {
        let params = json!({"sessionId":"lc:test","text":"继续"});
        let reply = json!({"type":"response","ok":true,"requestId":"request",
            "result":{"accepted":true,"requestId":"request","toolInput":{"secret":"DIRECT_SECRET"},
                "output":format!("data:image/png;base64,{}", "A".repeat(30_000))},
            "originalSnapshot":{"messages":[{"secret":"CACHED_SNAPSHOT"}]}});
        // Pure value projection has no host or dispatch handle with which to replay a mutation.
        let first = project_receipt("message.send", &params, &reply).unwrap();
        assert_eq!(first, json!({"accepted":true,"requestId":"request"}));
        assert_eq!(
            project_receipt("message.send", &params, &reply).unwrap(),
            first
        );
        assert!(size(&first).unwrap() <= MAX_RESULT_BYTES);
        for secret in ["DIRECT_SECRET", "CACHED_SNAPSHOT", "base64", "toolInput"] {
            assert!(!first.to_string().contains(secret));
        }
    }
    #[test]
    fn host_and_uncertain_receipt_errors_are_fixed_safe_messages() {
        let raw = format!(
            "tool.input SECRET_PATCH data:image/png;base64,{}",
            "B".repeat(10_000)
        );
        let params = json!({"sessionId":"lc:test","text":"继续"});
        let outcome = project_outcome("message.send", &params, Err(raw.clone())).unwrap_err();
        let cached = project_receipt(
            "message.send",
            &params,
            &json!({"ok":false,"error":{"message":raw},"result":{"output":"SECRET_OUTPUT"}}),
        )
        .unwrap_err();
        assert!(outcome.contains("刷新"));
        assert!(cached.contains("不要重复提交"));
        for safe in [&outcome, &cached] {
            for secret in ["SECRET", "base64", "tool.input"] {
                assert!(!safe.contains(secret));
            }
        }
        assert!(project_receipt(
            "message.send",
            &params,
            &json!({"ok":true,"result":{"output":"SECRET_OUTPUT"}})
        )
        .is_err());
    }
}
