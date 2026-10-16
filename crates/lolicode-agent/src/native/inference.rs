use super::types::NativeGateway;
use crate::AgentTokenUsage;
use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::sync::{mpsc, watch};

pub(super) const CANCELLED: &str = "任务已停止";
pub(super) const CONTEXT_EXCEEDED: &str = "[context_length_exceeded] 模型网关明确报告上下文超限";
const LIMIT: usize = 8 * 1024 * 1024;
#[derive(Clone)]
pub(super) enum Delta {
    Text(String),
    Reasoning(String),
    Usage(AgentTokenUsage),
    Finished,
    ToolInputProgress,
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
    pub finish_reason: String,
    pub usage: AgentTokenUsage,
}

#[derive(Clone, Copy)]
pub(super) struct ReadPolicy {
    pub progress_timeout: Duration,
    pub terminal_grace: Duration,
}
impl Default for ReadPolicy {
    fn default() -> Self {
        Self {
            progress_timeout: Duration::from_secs(120),
            terminal_grace: Duration::from_secs(2),
        }
    }
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
    reasoning_effort: Option<&str>,
    messages: Vec<Value>,
    tools: Vec<Value>,
    tx: mpsc::UnboundedSender<Delta>,
    cancel: watch::Receiver<bool>,
) -> Result<Turn, String> {
    infer_with_policy(
        client,
        gateway,
        model,
        reasoning_effort,
        messages,
        tools,
        tx,
        cancel,
        ReadPolicy::default(),
    )
    .await
}
pub(super) async fn infer_with_policy(
    client: &Client,
    gateway: &NativeGateway,
    model: &str,
    reasoning_effort: Option<&str>,
    messages: Vec<Value>,
    tools: Vec<Value>,
    tx: mpsc::UnboundedSender<Delta>,
    mut cancel: watch::Receiver<bool>,
    policy: ReadPolicy,
) -> Result<Turn, String> {
    let endpoint = validate_gateway(gateway)?;
    let mut body = json!({"model":model,"messages":messages,"tools":tools,"stream":true,"stream_options":{"include_usage":true}});
    if let Some(effort) = reasoning_effort {
        body["reasoning_effort"] = json!(effort);
    }
    let request = client
        .post(endpoint)
        .bearer_auth(&gateway.bearer_token)
        .json(&body)
        .send();
    let response = tokio::select! { _ = cancelled(&mut cancel) => return Err(CANCELLED.into()), result = tokio::time::timeout(policy.progress_timeout, request) => result.map_err(|_| "模型等待首个响应超时；尚未执行新的工具，可以重试或切换模型。")?.map_err(|_| "无法连接模型网关，请检查渠道后重试")? };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        if matches!(status, 400 | 413 | 422) {
            let mut body = Vec::new();
            let mut stream = response.bytes_stream();
            let deadline =
                tokio::time::Instant::now() + policy.progress_timeout.min(Duration::from_secs(5));
            loop {
                let chunk = tokio::select! {
                    _ = cancelled(&mut cancel) => return Err(CANCELLED.into()),
                    _ = tokio::time::sleep_until(deadline) => break,
                    value = stream.next() => value,
                };
                let Some(Ok(chunk)) = chunk else { break };
                if body.len() + chunk.len() > 8192 {
                    break;
                }
                body.extend_from_slice(&chunk);
            }
            if let Ok(error) = serde_json::from_slice::<Value>(&body) {
                if context_error(&error) {
                    return Err(CONTEXT_EXCEEDED.into());
                }
                if image_input_error(&error) {
                    return Err("当前渠道或模型不支持图片输入，请切换支持视觉的模型或渠道。".into());
                }
            }
        }
        return Err(format!(
            "模型请求失败（HTTP {}），请检查渠道与模型。",
            status
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
        finish_reason: String::new(),
        usage: AgentTokenUsage::default(),
    };
    let mut calls: BTreeMap<usize, ToolCall> = BTreeMap::new();
    let mut finish = None;
    let mut bytes = Vec::new();
    let mut event = String::new();
    let mut total = 0usize;
    let mut done = false;
    let mut progress_deadline = tokio::time::Instant::now() + policy.progress_timeout;
    let mut terminal_deadline = None;
    let mut progressed = false;
    let mut stream = response.bytes_stream();
    loop {
        let deadline = terminal_deadline.unwrap_or(progress_deadline);
        let next = tokio::select! {
            _ = cancelled(&mut cancel) => return Err(CANCELLED.into()),
            _ = tokio::time::sleep_until(deadline) => {
                if terminal_deadline.is_some() { break; }
                return Err(if progressed { "模型流在输出后长时间没有新内容；已收到的文字与已完成工具保留，请重试。" } else { "模型等待首个有效输出超时；心跳不能代替回答，请重试或切换模型。" }.into());
            },
            value = stream.next() => value,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) if terminal_deadline.is_some() => break,
            Err(_) => return Err("模型连接中断，已收到的文字保留，请重试".into()),
        };
        total += chunk.len();
        if total > LIMIT {
            if terminal_deadline.is_some() {
                break;
            }
            return Err("模型返回内容超过本次安全读取上限".into());
        }
        bytes.extend_from_slice(&chunk);
        if json_response {
            if !chunk.is_empty() {
                progress_deadline = tokio::time::Instant::now() + policy.progress_timeout;
            }
            continue;
        }
        let before = progress_key(&result, &calls, &finish);
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
                    if finish.is_some() {
                        if let Ok(value) = serde_json::from_str::<Value>(event.trim()) {
                            consume_usage(&value, &tx, &mut result);
                        }
                    } else {
                        let value: Value = serde_json::from_str(event.trim())
                            .map_err(|_| "模型流格式无效，请检查渠道兼容性")?;
                        consume(&value, &tx, &mut result, &mut calls, &mut finish)?;
                    }
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
        if before != progress_key(&result, &calls, &finish) {
            progressed = true;
            progress_deadline = tokio::time::Instant::now() + policy.progress_timeout;
        }
        if finish.is_some() && terminal_deadline.is_none() {
            terminal_deadline = Some(tokio::time::Instant::now() + policy.terminal_grace);
        }
    }
    if !json_response && !bytes.is_empty() {
        match std::str::from_utf8(&bytes) {
            Ok(remaining) => {
                if let Some(data) = remaining.trim().strip_prefix("data:") {
                    event.push_str(data.trim_start());
                }
            }
            Err(_) if finish.is_some() => {}
            Err(_) => return Err("模型流在不完整的字符处中断".into()),
        }
    }
    if !event.is_empty() && event.trim() != "[DONE]" {
        if finish.is_some() {
            if let Ok(value) = serde_json::from_str::<Value>(event.trim()) {
                consume_usage(&value, &tx, &mut result);
            }
        } else {
            let value: Value =
                serde_json::from_str(event.trim()).map_err(|_| "模型流在结束前中断")?;
            consume(&value, &tx, &mut result, &mut calls, &mut finish)?;
        }
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
    result.finish_reason = finish.unwrap_or_default();
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
        if context_error(value) {
            return Err(CONTEXT_EXCEEDED.into());
        }
        return Err("模型网关返回错误，请检查渠道后重试".into());
    }
    consume_usage(value, tx, result);
    let Some(choice) = value["choices"].get(0) else {
        return Ok(());
    };
    let delta = choice
        .get("delta")
        .or_else(|| choice.get("message"))
        .unwrap_or(&Value::Null);
    if let Some(text) = delta["content"].as_str().filter(|text| !text.is_empty()) {
        result.content.push_str(text);
        let _ = tx.send(Delta::Text(text.into()));
    }
    if let Some(text) = delta["reasoning_content"]
        .as_str()
        .or_else(|| delta["reasoning"].as_str())
        .filter(|text| !text.is_empty())
    {
        result.reasoning.push_str(text);
        let _ = tx.send(Delta::Reasoning(text.into()));
    }
    if let Some(items) = delta["tool_calls"].as_array() {
        if items.iter().any(|item| {
            [
                item.get("id"),
                item.pointer("/function/name"),
                item.pointer("/function/arguments"),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.as_str().is_some_and(|text| !text.is_empty()))
        }) {
            let _ = tx.send(Delta::ToolInputProgress);
        }
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
        if finish.is_none() {
            let _ = tx.send(Delta::Finished);
        }
        *finish = Some(reason.into());
    }
    Ok(())
}

fn consume_usage(value: &Value, tx: &mpsc::UnboundedSender<Delta>, result: &mut Turn) {
    if let Some(usage) = value.get("usage") {
        let parsed = parse_usage(usage);
        if parsed.reported() {
            result.usage.merge(&parsed);
            let _ = tx.send(Delta::Usage(result.usage.clone()));
        }
    }
}

fn progress_key(
    result: &Turn,
    calls: &BTreeMap<usize, ToolCall>,
    finish: &Option<String>,
) -> (usize, usize, usize, Option<String>, AgentTokenUsage) {
    (
        result.content.len(),
        result.reasoning.len(),
        calls
            .values()
            .map(|call| call.id.len() + call.name.len() + call.arguments.len())
            .sum(),
        finish.clone(),
        result.usage.clone(),
    )
}
pub(super) fn parse_usage(usage: &Value) -> AgentTokenUsage {
    let value = |paths: &[&str]| {
        paths
            .iter()
            .find_map(|path| usage.pointer(path).and_then(Value::as_u64))
    };
    let cache_read = value(&[
        "/prompt_tokens_details/cached_tokens",
        "/input_tokens_details/cached_tokens",
        "/cache_read_input_tokens",
        "/prompt_cache_hit_tokens",
    ]);
    let cache_write = value(&["/cache_creation_input_tokens", "/cache_write_tokens"]);
    let anthropic = usage.get("cache_read_input_tokens").is_some()
        || usage.get("cache_creation_input_tokens").is_some();
    let input = value(&["/prompt_tokens"]).or_else(|| {
        value(&["/input_tokens"]).map(|input| {
            if anthropic {
                input
                    .saturating_add(cache_read.unwrap_or(0))
                    .saturating_add(cache_write.unwrap_or(0))
            } else {
                input
            }
        })
    });
    let denominator = if usage.get("prompt_tokens").is_some()
        || anthropic
        || usage
            .pointer("/input_tokens_details/cached_tokens")
            .is_some()
    {
        input
    } else {
        None
    };
    AgentTokenUsage {
        input_tokens: input,
        output_tokens: value(&["/completion_tokens", "/output_tokens"]),
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        cache_input_tokens: denominator,
    }
}

fn context_error(value: &Value) -> bool {
    ["/error/code", "/error/type", "/code"]
        .iter()
        .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .any(|code| {
            matches!(
                code,
                "context_length_exceeded"
                    | "max_context_length_exceeded"
                    | "prompt_too_long"
                    | "input_too_long"
            )
        })
}

fn image_input_error(value: &Value) -> bool {
    let message = ["/error/message", "/message", "/error/code", "/error/type"]
        .iter()
        .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    (message.contains("image") || message.contains("vision") || message.contains("multimodal"))
        && [
            "unsupported",
            "not support",
            "does not support",
            "not enabled",
            "invalid content",
            "unavailable",
        ]
        .iter()
        .any(|marker| message.contains(marker))
}
