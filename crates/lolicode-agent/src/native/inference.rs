use super::types::NativeGateway;
use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tokio::sync::{mpsc, watch};

pub(super) const CANCELLED: &str = "任务已停止";
const LIMIT: usize = 8 * 1024 * 1024;
#[derive(Clone)]
pub(super) enum Delta {
    Text(String),
    Reasoning(String),
}
#[derive(Clone, Default)]
pub(super) struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}
pub(super) struct Turn {
    pub content: String,
    pub reasoning: String,
    pub calls: Vec<ToolCall>,
}

pub(super) async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

pub(super) fn validate_gateway(value: &NativeGateway) -> Result<String, String> {
    let mut url = url::Url::parse(&value.base_url).map_err(|_| "模型网关地址无效")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || value.bearer_token.trim().is_empty()
    {
        return Err("编程核心只能连接应用内受认证的模型网关".into());
    }
    url.set_path(&format!(
        "{}/chat/completions",
        url.path().trim_end_matches('/')
    ));
    Ok(url.to_string())
}

pub(super) async fn infer(
    client: &Client,
    gateway: &NativeGateway,
    model: &str,
    messages: Vec<Value>,
    tools: Vec<Value>,
    tx: mpsc::UnboundedSender<Delta>,
    mut cancel: watch::Receiver<bool>,
) -> Result<Turn, String> {
    let endpoint = validate_gateway(gateway)?;
    let body = json!({"model":model,"messages":messages,"tools":tools,"stream":true});
    let request = client
        .post(endpoint)
        .bearer_auth(&gateway.bearer_token)
        .json(&body)
        .send();
    let response = tokio::select! { _ = cancelled(&mut cancel) => return Err(CANCELLED.into()), result = request => result.map_err(|_| "无法连接模型网关，请检查渠道后重试")? };
    if !response.status().is_success() {
        return Err(format!(
            "模型请求失败（HTTP {}），请检查渠道与模型。",
            response.status().as_u16()
        ));
    }
    let json_response = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("application/json"));
    let mut result = Turn {
        content: String::new(),
        reasoning: String::new(),
        calls: Vec::new(),
    };
    let mut calls: BTreeMap<usize, ToolCall> = BTreeMap::new();
    let mut finish = None;
    let mut bytes = Vec::new();
    let mut event = String::new();
    let mut total = 0usize;
    let mut done = false;
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! { _ = cancelled(&mut cancel) => return Err(CANCELLED.into()), value = stream.next() => value };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|_| "模型连接中断，已收到的文字保留，请重试")?;
        total += chunk.len();
        if total > LIMIT {
            return Err("模型返回内容超过本次安全读取上限".into());
        }
        bytes.extend_from_slice(&chunk);
        if json_response {
            continue;
        }
        while let Some(index) = bytes.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = bytes.drain(..=index).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "模型返回了无效文本编码")?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !event.is_empty() {
                    if event.trim() == "[DONE]" {
                        event.clear();
                        done = true;
                        break;
                    }
                    let value: Value = serde_json::from_str(event.trim())
                        .map_err(|_| "模型流格式无效，请检查渠道兼容性")?;
                    consume(&value, &tx, &mut result, &mut calls, &mut finish)?;
                    event.clear();
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                event.push_str(data.trim_start());
                event.push('\n');
            }
        }
        if done {
            break;
        }
    }
    if !event.is_empty() && event.trim() != "[DONE]" {
        let value: Value = serde_json::from_str(event.trim()).map_err(|_| "模型流在结束前中断")?;
        consume(&value, &tx, &mut result, &mut calls, &mut finish)?;
    }
    // A non-streaming compatible provider can still return a full JSON reply.
    if (json_response || finish.is_none()) && !bytes.is_empty() {
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            consume(&value, &tx, &mut result, &mut calls, &mut finish)?;
        }
    }
    match finish.as_deref() {
        Some("stop" | "tool_calls" | "function_call") => {}
        Some("length") => {
            return Err("模型达到输出长度限制，已收到的内容保留，请继续或更换模型。".into())
        }
        _ => return Err("模型连接未返回明确的完成状态，已收到的内容保留。".into()),
    }
    for (_, call) in calls {
        if call.id.is_empty()
            || call.name.is_empty()
            || call.arguments.len() > 1024 * 1024
            || serde_json::from_str::<Value>(&call.arguments).is_err()
        {
            return Err("模型返回的工具参数不完整，未执行工具".into());
        }
        if result.calls.iter().any(|c| c.id == call.id) {
            return Err("模型重复了工具调用标识，未执行工具".into());
        }
        result.calls.push(call);
    }
    Ok(result)
}

fn consume(
    value: &Value,
    tx: &mpsc::UnboundedSender<Delta>,
    result: &mut Turn,
    calls: &mut BTreeMap<usize, ToolCall>,
    finish: &mut Option<String>,
) -> Result<(), String> {
    if value.get("error").is_some() {
        return Err("模型网关返回错误，请检查渠道后重试".into());
    }
    let Some(choice) = value["choices"].get(0) else {
        return Ok(());
    };
    let delta = choice
        .get("delta")
        .or_else(|| choice.get("message"))
        .unwrap_or(&Value::Null);
    if let Some(text) = delta["content"].as_str() {
        result.content.push_str(text);
        let _ = tx.send(Delta::Text(text.into()));
    }
    if let Some(text) = delta["reasoning_content"]
        .as_str()
        .or_else(|| delta["reasoning"].as_str())
    {
        result.reasoning.push_str(text);
        let _ = tx.send(Delta::Reasoning(text.into()));
    }
    if let Some(items) = delta["tool_calls"].as_array() {
        for (ordinal, item) in items.iter().enumerate() {
            let index = item["index"].as_u64().unwrap_or(ordinal as u64) as usize;
            if index >= 16 {
                return Err("模型请求了过多并行工具，未执行工具".into());
            }
            let call = calls.entry(index).or_default();
            if let Some(id) = item["id"].as_str() {
                if call.id.is_empty() {
                    call.id = id.into();
                } else if call.id != id {
                    return Err("模型流中的工具标识不一致".into());
                }
            }
            if let Some(name) = item["function"]["name"].as_str() {
                call.name.push_str(name);
            }
            if let Some(args) = item["function"]["arguments"].as_str() {
                call.arguments.push_str(args);
            }
        }
    }
    if let Some(reason) = choice["finish_reason"].as_str() {
        *finish = Some(reason.into());
    }
    Ok(())
}
