//! Explicit phone text view. Never serialize an agent snapshot or tool payload verbatim.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(super) const MAX_RESULT_BYTES: usize = 1_048_576;
pub(super) const MAX_PAGE_BYTES: usize = 4_000;
pub(super) const MAX_DIRECT_RESULT_BYTES: usize = 27 * 1024;
pub(super) const MAX_REQUEST_PARAMS_BYTES: usize = 1_048_576;
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
        return Err("请求参数超过 1 MiB UTF-8 上限，请缩短输入".into());
    }
    let allowed: &[&str] = match method {
        "status" | "projects.list" => &[],
        "sessions.list" => &["offset", "limit", "knownRevision"],
        "models.list" => &["projectPath", "offset", "limit", "knownRevision"],
        "session.create" => &["projectPath", "modelId", "title"],
        "session.get" => &["sessionId", "knownRevision", "offset", "limit"],
        "session.attach" => &["sessionId"],
        "message.get" => &["sessionId", "messageId", "offset", "limit"],
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
        "session.get" | "sessions.list" | "message.get" | "models.list" => {
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
            if params.get("offset").is_some_and(|v| {
                v.as_u64().is_none_or(|n| {
                    n > if method == "message.get" {
                        1024 * 1024
                    } else {
                        100_000
                    }
                })
            }) || params.get("limit").is_some_and(|v| {
                v.as_u64().is_none_or(|n| {
                    n < if method == "message.get" { 4 } else { 1 }
                        || n > if method == "message.get" { 2500 } else { 12 }
                })
            }) {
                return Err("历史分页参数无效".into());
            }
            if method == "message.get" {
                exact(params, "messageId", 128)?;
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

fn full_message_text(message: &Value) -> String {
    let mut pieces = Vec::new();
    if let Some(parts) = message["parts"].as_array() {
        for part in parts.iter().filter(|part| part["type"] == "text") {
            let Some(text) = part["text"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            let text = if has_encoded_or_media(text) {
                "媒体、编码内容或差异请直连查看。"
            } else {
                text
            };
            pieces.push(text.to_owned());
        }
    }
    pieces.join("\n")
}

fn revision(value: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(&canonical(value)).map_err(|_| DIRECT)?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Small pages make a large desktop directory usable without sending the whole
/// directory at every poll. The generation fences cross-page inserts/deletes.
pub(super) fn session_directory(params: &Value, value: Value) -> Result<Value, String> {
    validate_request("sessions.list", params)?;
    let sessions = value
        .as_array()
        .filter(|a| a.len() <= 20_000)
        .ok_or(DIRECT)?
        .iter()
        .map(session)
        .collect::<Result<Vec<_>, _>>()?;
    let generation = revision(&json!(sessions))?;
    let offset = params["offset"].as_u64().unwrap_or(0) as usize;
    let limit = params["limit"].as_u64().unwrap_or(6) as usize;
    let mut selected = Vec::new();
    for item in sessions.iter().skip(offset).take(limit) {
        let mut candidate = selected.clone();
        candidate.push(item.clone());
        let overhead = json!({"sessions":candidate,"offset":offset,"nextOffset":offset+candidate.len(),"hasMore":true,"total":sessions.len(),"directoryRevision":generation});
        if size(&overhead)? > MAX_PAGE_BYTES - RESULT_RESERVE {
            break;
        }
        selected = candidate;
    }
    if offset < sessions.len() && selected.is_empty() {
        return Err("此会话元数据超出文本页预算，请在电脑端缩短标题或项目路径后重试".into());
    }
    let next = offset.saturating_add(selected.len());
    let more = next < sessions.len();
    let mut result = json!({"sessions":selected,"offset":offset,"nextOffset":if more{json!(next)}else{Value::Null},"hasMore":more,"total":sessions.len(),"directoryRevision":generation});
    let page_revision = revision(&result)?;
    if params["knownRevision"].as_str() == Some(page_revision.as_str()) {
        return Ok(json!({"notModified":true,"revision":page_revision}));
    }
    result["revision"] = json!(page_revision);
    Ok(result)
}

/// All models remain addressable; the transport budget only determines page
/// length. Both the complete safe catalog and page scope have stable revisions.
pub(super) fn model_directory(params: &Value, value: &Value) -> Result<Value, String> {
    validate_request("models.list", params)?;
    let project = exact(params, "projectPath", 2048)?;
    let source = value["models"]
        .as_array()
        .filter(|models| models.len() <= 20_000)
        .ok_or("模型目录格式无效或超过手机目录限制")?;
    let mut seen = std::collections::BTreeSet::new();
    let models = source
        .iter()
        .map(|model| {
            let id = exact(model, "id", 512)?;
            if !seen.insert(id.clone()) {
                return Err("模型目录包含重复编号，请刷新电脑目录".into());
            }
            Ok(json!({"id":id,"name":label(model,"name",160)}))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let catalog_revision = revision(&json!({"projectPath":project,"models":models}))?;
    let full = !["offset", "limit", "knownRevision"]
        .iter()
        .any(|key| params.get(*key).is_some());
    if full {
        let mut result = json!({"models":models,"offset":0,"nextOffset":null,"hasMore":false,"total":models.len(),"catalogRevision":catalog_revision});
        let full_revision =
            revision(&json!({"projectPath":project,"scope":"complete","catalog":result}))?;
        result["revision"] = json!(full_revision);
        if size(&result)? > MAX_RESULT_BYTES {
            return Err("完整模型目录超过 1 MiB UTF-8 上限，请使用分页读取".into());
        }
        return Ok(result);
    }
    let offset = params["offset"].as_u64().unwrap_or(0) as usize;
    let limit = params["limit"].as_u64().unwrap_or(6) as usize;
    if offset > models.len() {
        return Err("模型分页位置已失效，请从第一页刷新".into());
    }
    let page = |selected: &Vec<Value>| {
        let next = offset + selected.len();
        let more = next < models.len();
        json!({"models":selected,"offset":offset,"nextOffset":if more {json!(next)}else{Value::Null},
            "hasMore":more,"total":models.len(),"catalogRevision":catalog_revision})
    };
    let mut selected = Vec::new();
    for model in models.iter().skip(offset).take(limit) {
        let mut candidate = selected.clone();
        candidate.push(model.clone());
        if size(&page(&candidate))? > MAX_PAGE_BYTES - RESULT_RESERVE {
            break;
        }
        selected = candidate;
    }
    if offset < models.len() && selected.is_empty() {
        return Err("单条模型元数据超过手机页预算，请在电脑端缩短模型名称或编号".into());
    }
    let mut result = page(&selected);
    // Bind the requested limit too: the final short page may otherwise have
    // identical visible rows for two different request scopes.
    let page_revision =
        revision(&json!({"projectPath":project,"offset":offset,"limit":limit,"page":result}))?;
    if params["knownRevision"].as_str() == Some(page_revision.as_str()) {
        return Ok(json!({"notModified":true,"revision":page_revision}));
    }
    result["revision"] = json!(page_revision);
    if size(&result)? > MAX_PAGE_BYTES {
        return Err("模型目录页超过文本预算".into());
    }
    Ok(result)
}

/// Offset and limit are UTF-8 byte positions. No long text is irretrievably
/// discarded merely because its preview must fit in a small snapshot frame.
pub(super) fn message_page(params: &Value, snapshot: &Value) -> Result<Value, String> {
    validate_request("message.get", params)?;
    if snapshot["session"]["id"] != params["sessionId"] {
        return Err("会话身份不匹配".into());
    }
    let id = params["messageId"].as_str().ok_or(DIRECT)?;
    let message = snapshot["messages"]
        .as_array()
        .ok_or(DIRECT)?
        .iter()
        .find(|m| m["id"] == id && matches!(m["role"].as_str(), Some("user" | "assistant")))
        .ok_or("消息已移除，请刷新会话")?;
    let text = full_message_text(message);
    if text.len() > 1024 * 1024 {
        return Err("此消息超过手机文字预算，请在电脑端查看完整内容".into());
    }
    let offset = params["offset"].as_u64().unwrap_or(0) as usize;
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err("消息分页位置已失效，请从头重新加载".into());
    }
    let limit = params["limit"].as_u64().unwrap_or(2000) as usize;
    let message_revision = revision(&json!({"id":id,"text":text}))?;
    let mut end = text.len().min(offset.saturating_add(limit));
    while end > offset && !text.is_char_boundary(end) {
        end -= 1;
    }
    loop {
        let more = end < text.len();
        let result = json!({"sessionId":params["sessionId"],"messageId":id,"text":&text[offset..end],"offset":offset,"nextOffset":if more{json!(end)}else{Value::Null},"hasMore":more,"total":text.len(),"revision":message_revision});
        if size(&result)? <= MAX_PAGE_BYTES {
            return Ok(result);
        }
        if end <= offset {
            return Err(DIRECT.into());
        }
        end = offset + (end - offset) / 2;
        while end > offset && !text.is_char_boundary(end) {
            end -= 1;
        }
    }
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
    snapshot_page(params, value, true)
}

/// Direct clients opt into the same stable pagination and message text protocol,
/// while retaining exact pending approval inputs in the larger native budget.
pub(super) fn direct_snapshot_page(params: &Value, snapshot: &Value) -> Result<Value, String> {
    validate_request("session.get", params)?;
    snapshot_page(params, snapshot, false)
}

fn direct_pending(value: &Value, key: &str) -> Result<Vec<Value>, String> {
    let items = value[key].as_array().ok_or("直连待处理信息格式无效")?;
    if size(&value[key])? > MAX_DIRECT_RESULT_BYTES || items.len() > 1024 {
        return Err(
            "待审批或提问信息超过直连页预算，请在电脑端处理；未省略或执行任何待处理项".into(),
        );
    }
    items
        .iter()
        .map(|item| {
            exact(item, "id", 128)?;
            exact(item, "sessionId", 128)?;
            let mut item = item.clone();
            if key == "permissions" {
                // Missing historical input must never be represented as reviewable.
                item["canApprove"] =
                    json!(item.get("toolInput").is_some_and(|input| !input.is_null()));
                item["requiresDirect"] = json!(false);
            }
            Ok(item)
        })
        .collect()
}

fn direct_diffs(value: &Value) -> Result<(Vec<Value>, bool), String> {
    let original = value["diffs"].as_array().ok_or("直连差异格式无效")?;
    let mut selected = Vec::new();
    for item in original {
        if selected.len() >= 16 || size(item)? > 8192 {
            break;
        }
        let mut candidate = selected.clone();
        candidate.push(item.clone());
        if size(&json!(candidate))? > 8192 {
            break;
        }
        selected = candidate;
    }
    let truncated = selected.len() < original.len();
    Ok((selected, truncated))
}

fn snapshot_page(params: &Value, value: &Value, text_only: bool) -> Result<Value, String> {
    let budget = if text_only {
        MAX_PAGE_BYTES
    } else {
        MAX_DIRECT_RESULT_BYTES
    };
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
        let body = full_message_text(m);
        let preview = tail(&body, 1024);
        let mut message = json!({"role":m["role"],"parts":[{"type":"text","text":preview}],"textTruncated":body.len()>1024,"textTotal":body.len(),"textRevision":revision(&json!({"id":m["id"],"text":body}))?});
        if m.get("id").is_some() {
            message["id"] = json!(exact(m, "id", 128)?);
        }
        selected.push(message);
    }
    selected.reverse();
    let minimum = selected.len().min(2);
    let permissions = if text_only {
        pending(value, "permissions")?
    } else {
        direct_pending(value, "permissions")?
    };
    let questions = if text_only {
        pending(value, "questions")?
    } else {
        direct_pending(value, "questions")?
    };
    let (diffs, diffs_truncated) = if text_only {
        (vec![], false)
    } else {
        direct_diffs(value)?
    };
    let mut result = json!({"session":session(&value["session"])?,"status":status,"messages":selected,
        "permissions":permissions,"questions":questions,"diffs":diffs,
        "error":if value["error"].as_str().is_some_and(|s|!s.is_empty()) {"会话发生错误，请直连查看完整详情"} else {""},
        "truncated":true,"truncationMessage":if text_only {NOTICE}else{"手机按页显示文字预览；可继续加载历史和长消息。"},"historyOffset":offset,"historyTotal":eligible.len(),
        "historyRevision":revision(&json!(eligible.iter().map(|m|m["id"].clone()).collect::<Vec<_>>()))?});
    if !text_only {
        result["diffsTruncated"] = json!(diffs_truncated);
    }
    loop {
        let count = result["messages"].as_array().map_or(0, Vec::len);
        result["hasMore"] = json!(offset.saturating_add(count) < eligible.len());
        result["nextOffset"] = if result["hasMore"] == true {
            json!(offset + count)
        } else {
            Value::Null
        };
        if size(&result)? <= budget - RESULT_RESERVE {
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
            messages[index]["textTruncated"] = json!(true);
        } else if messages.len() > minimum {
            messages.remove(0);
        } else if !text_only
            && result["diffs"]
                .as_array()
                .is_some_and(|diffs| !diffs.is_empty())
        {
            result["diffs"].as_array_mut().ok_or(DIRECT)?.pop();
            result["diffsTruncated"] = json!(true);
        } else {
            return Err(if text_only {
                "审批、提问或会话元数据超出文本预算，请直连查看；待处理项未被省略或处理"
            } else {
                "审批、提问或会话元数据超出直连页预算，请在电脑端处理；待处理项未被省略或执行"
            }
            .into());
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
        "sessions.list" => session_directory(params, result)?,
        "models.list" => model_directory(params, &result)?,
        "session.create" | "session.attach" => session(&result)?,
        "session.get" => snapshot(params, &result)?,
        "message.get" => message_page(params, &result)?,
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
    fn embedded_media_bytes_are_replaced_instead_of_relayed() {
        let mut source = fixture();
        source["messages"][1]["parts"] =
            json!([{"type":"text","text":format!("data:image/png;base64,{}","A".repeat(400))}]);
        let value = project("session.get", &json!({"sessionId":"lc:test"}), source).unwrap();
        assert!(!value.to_string().contains("data:image"));
        assert!(!value.to_string().contains(&"A".repeat(256)));
    }
    #[test]
    fn directory_pages_are_bounded_complete_and_fenced_against_same_count_reordering() {
        let source=json!((0..80).map(|i|json!({"id":format!("session-{i}"),"title":format!("会话{i}"),"projectPath":format!("D:/{}", "项目目录".repeat(80))})).collect::<Vec<_>>());
        let first = session_directory(&json!({"offset":0,"limit":6}), source.clone()).unwrap();
        assert!(first["sessions"].as_array().unwrap().len() < 6);
        let mut offset = 0;
        let mut ids = BTreeMap::new();
        loop {
            let page =
                session_directory(&json!({"offset":offset,"limit":6}), source.clone()).unwrap();
            assert!(size(&page).unwrap() <= MAX_RESULT_BYTES);
            assert_eq!(page["directoryRevision"], first["directoryRevision"]);
            for s in page["sessions"].as_array().unwrap() {
                assert!(ids
                    .insert(s["id"].as_str().unwrap().to_owned(), ())
                    .is_none());
            }
            if page["hasMore"] == false {
                break;
            }
            let next = page["nextOffset"].as_u64().unwrap();
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(ids.len(), 80);
        assert_eq!(
            session_directory(
                &json!({"offset":0,"limit":6,"knownRevision":first["revision"]}),
                source.clone()
            )
            .unwrap()["notModified"],
            true
        );
        let mut reordered = source.clone();
        reordered.as_array_mut().unwrap().swap(1, 70);
        let changed = session_directory(&json!({"offset":0,"limit":6}), reordered).unwrap();
        assert_ne!(first["directoryRevision"], changed["directoryRevision"]);
    }
    #[test]
    fn long_chinese_message_pages_reconstruct_the_complete_text_without_utf8_gaps() {
        let mut source = fixture();
        let body = "完整文字与代码🙂\n```diff\n+新增一行\n```\n".repeat(180);
        source["messages"][1]["parts"] = json!([{"type":"text","text":body}]);
        let preview = project(
            "session.get",
            &json!({"sessionId":"lc:test"}),
            source.clone(),
        )
        .unwrap();
        assert_eq!(preview["messages"][1]["textTruncated"], true);
        let generation = preview["historyRevision"].clone();
        let mut rebuilt = String::new();
        let mut offset = 0;
        loop {
            let page = message_page(
                &json!({"sessionId":"lc:test","messageId":"b","offset":offset,"limit":2000}),
                &source,
            )
            .unwrap();
            assert!(size(&page).unwrap() <= MAX_RESULT_BYTES);
            assert_eq!(page["offset"], offset);
            rebuilt.push_str(page["text"].as_str().unwrap());
            if page["hasMore"] == false {
                break;
            }
            let next = page["nextOffset"].as_u64().unwrap();
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(rebuilt, body);
        assert!(message_page(
            &json!({"sessionId":"lc:test","messageId":"b","offset":1}),
            &source
        )
        .is_err());
        source["messages"][1]["parts"][0]["text"] = json!(format!("{body}新回复"));
        let changed = project("session.get", &json!({"sessionId":"lc:test"}), source).unwrap();
        assert_eq!(changed["historyRevision"], generation);
        assert_ne!(changed["revision"], preview["revision"]);
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
            &json!({"sessionId":"s","text":"汉".repeat(MAX_REQUEST_PARAMS_BYTES/3+1)})
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
        assert_eq!(model["models"], json!([{"id":"m","name":"模型"}]));
        assert_eq!(model["total"], 1);
        assert_eq!(model["hasMore"], false);
        assert!(!model.to_string().contains("secret"));
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
        assert_eq!(
            project("projects.list", &json!({}), projects)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            64
        );
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

    #[test]
    fn direct_history_pages_cover_all_messages_and_keep_page_scoped_revisions() {
        let mut source = fixture();
        source["messages"]=json!((0..14).map(|i|json!({"id":format!("m{i:02}"),"role":if i%2==0{"user"}else{"assistant"},"parts":[{"type":"text","text":format!("中文历史第{i}条") }]})).collect::<Vec<_>>());
        let mut ids = std::collections::BTreeSet::new();
        let mut offset = 0;
        let mut generation = None;
        loop {
            let params = json!({"sessionId":"lc:test","offset":offset,"limit":6});
            let page = direct_snapshot_page(&params, &source).unwrap();
            assert!(size(&page).unwrap() <= MAX_DIRECT_RESULT_BYTES);
            assert_eq!(page["historyTotal"], 14);
            if let Some(previous) = &generation {
                assert_eq!(&page["historyRevision"], previous);
            } else {
                generation = Some(page["historyRevision"].clone());
            }
            for message in page["messages"].as_array().unwrap() {
                assert!(ids.insert(message["id"].as_str().unwrap().to_owned()));
            }
            let acknowledged=direct_snapshot_page(&json!({"sessionId":"lc:test","offset":offset,"limit":6,"knownRevision":page["revision"]}),&source).unwrap();
            assert_eq!(
                acknowledged,
                json!({"notModified":true,"revision":page["revision"]})
            );
            if page["hasMore"] != true {
                break;
            }
            offset = page["nextOffset"].as_u64().unwrap();
        }
        assert_eq!(ids, (0..14).map(|i| format!("m{i:02}")).collect());
        assert!(direct_snapshot_page(&json!({"sessionId":"lc:test","limit":0}), &source).is_err());
    }

    #[test]
    fn direct_approval_keeps_exact_input_and_questions_while_text_stays_reject_only() {
        let mut source = fixture();
        let input = json!({"command":"printf 'review' && echo next | cat > report.txt","content":"准确输入".repeat(700),"nested":{"file":"exact.txt"}});
        source["permissions"] = json!([{"id":"permission","sessionId":"lc:test","action":"write","resources":["report.txt"],"description":"检查完整输入","toolName":"write_file","toolInput":input,"approvalMode":"user-once"}]);
        source["questions"] = json!([{"id":"question","sessionId":"lc:test","title":"问题","fields":[{"key":"choice","type":"select","options":[{"value":"yes","label":"保留"}],"default":"yes","when":{"key":"mode","equals":"review"}}]}]);
        let direct =
            direct_snapshot_page(&json!({"sessionId":"lc:test","limit":6}), &source).unwrap();
        assert!(size(&direct).unwrap() > MAX_PAGE_BYTES);
        assert_eq!(direct["permissions"][0]["toolInput"], input);
        assert_eq!(direct["permissions"][0]["approvalMode"], "user-once");
        assert_eq!(direct["permissions"][0]["canApprove"], true);
        assert_eq!(direct["questions"], source["questions"]);
        let text = project(
            "session.get",
            &json!({"sessionId":"lc:test","limit":6}),
            source,
        )
        .unwrap();
        assert!(text["permissions"][0].get("toolInput").is_none());
        assert_eq!(text["permissions"][0]["canApprove"], false);
        assert!(validate_request(
            "permission.reply",
            &json!({"sessionId":"lc:test","permissionId":"permission","decision":"once"})
        )
        .is_err());
    }

    #[test]
    fn direct_page_never_drops_pending_items_to_fit_and_marks_omitted_diffs() {
        let mut source = fixture();
        source["permissions"] = json!([{"id":"p","sessionId":"lc:test","toolInput":{"content":"超大输入".repeat(5000)}}]);
        assert!(
            direct_snapshot_page(&json!({"sessionId":"lc:test"}), &source)
                .unwrap_err()
                .contains("未省略")
        );
        source["permissions"] = json!([]);
        source["questions"] =
            json!([{"id":"q","sessionId":"lc:test","fields":[{"title":"保留问题".repeat(5000)}]}]);
        assert!(direct_snapshot_page(&json!({"sessionId":"lc:test"}), &source).is_err());
        source["questions"] = json!([{"id":"q","sessionId":"lc:test","fields":[]}]);
        source["diffs"] = json!([{"path":"large.txt","patch":"大差异".repeat(2000)}]);
        let page = direct_snapshot_page(&json!({"sessionId":"lc:test"}), &source).unwrap();
        assert_eq!(page["questions"], source["questions"]);
        assert_eq!(page["diffsTruncated"], true);
        assert_eq!(page["diffs"], json!([]));
    }

    fn large_model_fixture() -> Value {
        json!({"models":(0..45).map(|i|json!({
            "id":format!("lolicode/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/provider-model-{i:02}"),
            "name":format!("公开渠道 · 自有工具模型 {i:02}"),"apiKey":"NEVER_COPY_MODEL_SECRET"
        })).collect::<Vec<_>>(),"config":"NEVER_COPY_CATALOG_SECRET"})
    }

    #[test]
    fn real_sized_45_model_directory_reconstructs_without_loss_or_oversized_frames() {
        let source = large_model_fixture();
        let expected = source["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| json!({"id":m["id"],"name":m["name"]}))
            .collect::<Vec<_>>();
        assert!(size(&json!({"models":expected})).unwrap() > 5000);
        let mut all = Vec::new();
        let mut offset = 0;
        let mut generation = None;
        let mut pages = 0;
        loop {
            let params = json!({"projectPath":"D:/registered","offset":offset,"limit":6});
            let page = project("models.list", &params, source.clone()).unwrap();
            assert!(size(&page).unwrap() <= MAX_RESULT_BYTES);
            assert_eq!(page["offset"], offset);
            assert_eq!(page["total"], 45);
            assert!(size(&page).unwrap() <= MAX_PAGE_BYTES);
            assert!(!page.to_string().contains("SECRET"));
            if let Some(previous) = &generation {
                assert_eq!(&page["catalogRevision"], previous);
            } else {
                generation = Some(page["catalogRevision"].clone());
            }
            all.extend(page["models"].as_array().unwrap().iter().cloned());
            pages += 1;
            if page["hasMore"] != true {
                assert!(page["nextOffset"].is_null());
                break;
            }
            let next = page["nextOffset"].as_u64().unwrap();
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(pages, 8);
        assert_eq!(all.len(), 45);
        assert_eq!(
            revision(&json!(all)).unwrap(),
            revision(&json!(expected)).unwrap()
        );
        let legacy = project(
            "models.list",
            &json!({"projectPath":"D:/registered"}),
            source,
        )
        .unwrap();
        assert_eq!(legacy["models"].as_array().unwrap().len(), 45);
        assert_eq!(legacy["hasMore"], false);
        assert!(size(&legacy).unwrap() > MAX_PAGE_BYTES);
        assert!(size(&legacy).unwrap() <= MAX_RESULT_BYTES);
        assert_eq!(
            revision(&legacy["models"]).unwrap(),
            revision(&json!(expected)).unwrap()
        );
    }

    #[test]
    fn model_revisions_bind_project_limit_and_complete_safe_catalog_generation() {
        let source = large_model_fixture();
        let params = json!({"projectPath":"D:/a","offset":42,"limit":6});
        let first = model_directory(&params, &source).unwrap();
        let ack = model_directory(
            &json!({"projectPath":"D:/a","offset":42,"limit":6,"knownRevision":first["revision"]}),
            &source,
        )
        .unwrap();
        assert_eq!(
            ack,
            json!({"notModified":true,"revision":first["revision"]})
        );
        let other_limit = model_directory(
            &json!({"projectPath":"D:/a","offset":42,"limit":12,"knownRevision":first["revision"]}),
            &source,
        )
        .unwrap();
        assert_ne!(other_limit["revision"], first["revision"]);
        assert_eq!(other_limit["models"], first["models"]);
        let other_project = model_directory(
            &json!({"projectPath":"D:/b","offset":42,"limit":6,"knownRevision":first["revision"]}),
            &source,
        )
        .unwrap();
        assert_ne!(other_project["catalogRevision"], first["catalogRevision"]);
        let mut changed = source.clone();
        changed["models"][0]["name"] = json!("另一页的模型更新");
        let new_catalog = model_directory(&params, &changed).unwrap();
        assert_ne!(new_catalog["catalogRevision"], first["catalogRevision"]);
        assert_ne!(new_catalog["revision"], first["revision"]);
        changed = source;
        changed["models"][0]["apiKey"] = json!("HIDDEN_CHANGED");
        assert_eq!(model_directory(&params, &changed).unwrap(), first);
    }

    #[test]
    fn model_page_budget_counts_chinese_and_json_escaping_and_always_advances() {
        let source = json!({"models":(0..12).map(|i|json!({"id":format!("model-{i:02}:{}","\\\"".repeat(150)),"name":"汉字\"\\\n".repeat(45)})).collect::<Vec<_>>()});
        let first = model_directory(&json!({"projectPath":"D:/中文","limit":12}), &source).unwrap();
        assert!(first["models"].as_array().unwrap().len() < 12);
        let mut ids = std::collections::BTreeSet::new();
        let mut offset = 0;
        loop {
            let page = model_directory(
                &json!({"projectPath":"D:/中文","offset":offset,"limit":12}),
                &source,
            )
            .unwrap();
            assert!(size(&page).unwrap() <= MAX_RESULT_BYTES);
            for m in page["models"].as_array().unwrap() {
                assert!(ids.insert(m["id"].as_str().unwrap().to_owned()));
            }
            assert!(size(&page).unwrap() <= MAX_PAGE_BYTES);
            if page["hasMore"] != true {
                break;
            }
            let next = page["nextOffset"].as_u64().unwrap();
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(ids.len(), 12);
    }

    #[test]
    fn model_page_validation_requires_project_and_rejects_invalid_cursors_and_duplicates() {
        for params in [
            json!({}),
            json!({"projectPath":""}),
            json!({"projectPath":"D:/p","offset":-1}),
            json!({"projectPath":"D:/p","offset":100001}),
            json!({"projectPath":"D:/p","limit":0}),
            json!({"projectPath":"D:/p","limit":13}),
            json!({"projectPath":"D:/p","knownRevision":"A".repeat(64)}),
            json!({"projectPath":"D:/p","attachments":[]}),
        ] {
            assert!(validate_request("models.list", &params).is_err());
        }
        assert!(model_directory(
            &json!({"projectPath":"D:/p","offset":46}),
            &large_model_fixture()
        )
        .is_err());
        assert!(model_directory(
            &json!({"projectPath":"D:/p"}),
            &json!({"models":[{"id":"same","name":"a"},{"id":"same","name":"b"}]})
        )
        .is_err());
    }

    #[test]
    fn logical_parameter_budget_accepts_one_mib_but_rejects_the_next_utf8_byte() {
        let empty = json!({"sessionId":"s","text":""});
        let remaining = MAX_REQUEST_PARAMS_BYTES - size(&empty).unwrap();
        let text = format!(
            "{}{}",
            "汉".repeat(remaining / 3),
            "x".repeat(remaining % 3)
        );
        let exact = json!({"sessionId":"s","text":text});
        assert_eq!(size(&exact).unwrap(), MAX_REQUEST_PARAMS_BYTES);
        assert!(validate_request("message.send", &exact).is_ok());
        let mut over = exact;
        let mut text = over["text"].as_str().unwrap().to_owned();
        text.push('x');
        over["text"] = json!(text);
        assert_eq!(size(&over).unwrap(), MAX_REQUEST_PARAMS_BYTES + 1);
        assert!(validate_request("message.send", &over).is_err());
    }
}
