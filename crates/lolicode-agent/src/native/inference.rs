use super::types::NativeGateway;
use crate::images::ImageMarkdown;
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
const MAX_RATE_RETRIES: usize = 3;
const MAX_RATE_DELAY: Duration = Duration::from_secs(60);
const MAX_RATE_WAIT: Duration = Duration::from_secs(120);
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
    session_id: &str,
    model: &str,
    reasoning_effort: Option<&str>,
    max_tokens: u64,
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
        max_tokens,
        messages,
        tools,
        tx,
        cancel,
        ReadPolicy::default(),
        Some(session_id),
    )
    .await
}
pub(super) async fn infer_with_policy(
    client: &Client,
    gateway: &NativeGateway,
    model: &str,
    reasoning_effort: Option<&str>,
    max_tokens: u64,
    messages: Vec<Value>,
    tools: Vec<Value>,
    tx: mpsc::UnboundedSender<Delta>,
    mut cancel: watch::Receiver<bool>,
    policy: ReadPolicy,
    session_id: Option<&str>,
) -> Result<Turn, String> {
    let endpoint = validate_gateway(gateway)?;
    if session_id.is_some_and(|session| {
        !session
            .strip_prefix("lc:")
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
            .is_some_and(|id| session == format!("lc:{id}"))
    }) {
        return Err("模型请求的 LoliCode 会话标识无效".into());
    }
    if max_tokens < 16 {
        return Err("模型输出预算不足 16 tokens，未发送请求".into());
    }
    let mut body = json!({"model":model,"messages":messages,"tools":tools,"max_tokens":max_tokens,"stream":true,"stream_options":{"include_usage":true}});
    if let Some(effort) = reasoning_effort {
        body["reasoning_effort"] = json!(effort);
    }
    let mut rate_retries = 0;
    let mut rate_wait = Duration::ZERO;
    let mut output_alias_retried = false;
    // Retry only an explicit pre-response refusal. The request and completed
    // tool history stay identical; a stream is never replayed after it starts.
    let response = loop {
        let mut request = client
            .post(endpoint.clone())
            .bearer_auth(&gateway.bearer_token)
            .json(&body);
        if let Some(session_id) = session_id {
            request = request.header("x-lolicode-session-id", session_id);
        }
        let response = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => return Err(CANCELLED.into()),
            result = tokio::time::timeout(policy.progress_timeout, request.send()) =>
                result.map_err(|_| "模型等待首个响应超时；尚未执行新的工具，可以重试或切换模型。")?
                    .map_err(|_| "无法连接模型网关，请检查渠道后重试")?,
        };
        if response.status().is_success() {
            break response;
        }
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(Duration::from_secs)
            .filter(|delay| *delay <= MAX_RATE_DELAY);
        if matches!(status, 400 | 413 | 422 | 429) {
            let error = read_error(response, &mut cancel, policy.progress_timeout).await?;
            if status == 429 {
                let terminal = error.as_ref().is_some_and(terminal_quota_error);
                if let Some(delay) = retry_after.filter(|delay| {
                    !terminal
                        && rate_retries < MAX_RATE_RETRIES
                        && rate_wait + *delay <= MAX_RATE_WAIT
                }) {
                    rate_retries += 1;
                    rate_wait += delay;
                    // The engine's model phase remains Waiting until this infer
                    // resolves, and stopping the task interrupts the wait.
                    tokio::select! {
                        biased;
                        _ = cancelled(&mut cancel) => return Err(CANCELLED.into()),
                        _ = tokio::time::sleep(delay) => {},
                    }
                    continue;
                }
                let reason = error
                    .as_ref()
                    .and_then(rate_error_reason)
                    .unwrap_or(if terminal {
                        "模型渠道额度不足"
                    } else {
                        "模型渠道请求过于频繁"
                    });
                let wait = if terminal {
                    "已保留会话记录，请在额度恢复后继续。".into()
                } else {
                    retry_after
                        .filter(|delay| !delay.is_zero())
                        .map(|delay| format!("建议等待 {} 秒后再继续。", delay.as_secs()))
                        .unwrap_or_else(|| "请稍后继续，或检查渠道额度。".into())
                };
                return Err(format!("{reason}（HTTP 429）。{wait}"));
            }
            if let Some(error) = error {
                if context_error(&error) {
                    return Err(CONTEXT_EXCEEDED.into());
                }
                if status == 400
                    && !output_alias_retried
                    && !terminal_quota_error(&error)
                    && error.pointer("/error/code").and_then(Value::as_str)
                        == Some("unsupported_parameter")
                    && error.pointer("/error/param").and_then(Value::as_str) == Some("max_tokens")
                    && body["max_tokens"].as_u64() == Some(max_tokens)
                    && body.get("max_completion_tokens").is_none()
                {
                    body.as_object_mut()
                        .expect("constructed request")
                        .remove("max_tokens");
                    body["max_completion_tokens"] = json!(max_tokens);
                    output_alias_retried = true;
                    continue;
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
    };
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
    let mut images = ImageMarkdown::default();
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
                        consume(
                            &value,
                            &tx,
                            &mut result,
                            &mut calls,
                            &mut finish,
                            &mut images,
                        )?;
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
            consume(
                &value,
                &tx,
                &mut result,
                &mut calls,
                &mut finish,
                &mut images,
            )?;
        }
    }
    // A non-streaming compatible provider can still return a full JSON reply.
    if (json_response || finish.is_none()) && !bytes.is_empty() {
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            consume(
                &value,
                &tx,
                &mut result,
                &mut calls,
                &mut finish,
                &mut images,
            )?;
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
    images: &mut ImageMarkdown,
) -> Result<(), String> {
    if value.get("error").is_some() {
        if context_error(value) {
            return Err(CONTEXT_EXCEEDED.into());
        }
        if let Some(reason) = rate_error_reason(value) {
            return Err(format!(
                "{reason}；已收到的内容和已完成工具保留，请稍后继续。"
            ));
        }
        return Err("模型网关返回错误，请检查渠道后重试".into());
    }
    consume_usage(value, tx, result);
    let Some(choice) = value["choices"].get(0) else {
        return Ok(());
    };
    let delta = choice
        .get("delta")
        .filter(|value| !value.is_null())
        .or_else(|| choice.get("message"))
        .unwrap_or(&Value::Null);
    if let Some(text) = delta["content"].as_str() {
        append_text(text, tx, result);
    } else if let Some(parts) = delta["content"].as_array() {
        for part in parts {
            match part["type"].as_str() {
                Some("text" | "output_text") => {
                    if let Some(text) = part["text"].as_str() {
                        append_text(text, tx, result);
                    }
                }
                Some("image_url" | "image" | "output_image") => {
                    if let Some(markdown) = images.block(part) {
                        append_text(&markdown, tx, result);
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(parts) = delta["images"].as_array() {
        for part in parts {
            if let Some(markdown) = images.block(part) {
                append_text(&markdown, tx, result);
            }
        }
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

fn append_text(text: &str, tx: &mpsc::UnboundedSender<Delta>, result: &mut Turn) {
    if !text.is_empty() {
        result.content.push_str(text);
        let _ = tx.send(Delta::Text(text.into()));
    }
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

async fn read_error(
    response: reqwest::Response,
    cancel: &mut watch::Receiver<bool>,
    timeout: Duration,
) -> Result<Option<Value>, String> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    let deadline = tokio::time::Instant::now() + timeout.min(Duration::from_secs(5));
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancelled(cancel) => return Err(CANCELLED.into()),
            _ = tokio::time::sleep_until(deadline) => break,
            value = stream.next() => value,
        };
        let Some(Ok(chunk)) = chunk else { break };
        if body.len() + chunk.len() > 8192 {
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice::<Value>(&body).ok())
}

fn error_codes(value: &Value) -> impl Iterator<Item = &str> {
    ["/error/code", "/error/type", "/code"]
        .into_iter()
        .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
}

fn terminal_quota_error(value: &Value) -> bool {
    error_codes(value).any(|code| {
        [
            "daily",
            "quota",
            "credit",
            "balance",
            "billing",
            "insufficient",
        ]
        .iter()
        .any(|marker| code.to_ascii_lowercase().contains(marker))
    })
}

fn rate_error_reason(value: &Value) -> Option<&'static str> {
    error_codes(value).find_map(|code| match code {
        "service_rate_limited" => Some("公益模型全站请求频率受限"),
        "account_busy" => Some("当前账号已有模型请求处理中"),
        "service_busy" => Some("公益模型服务繁忙"),
        "daily_requests_exhausted" => Some("今日公益请求次数已用完，零点后恢复"),
        "daily_tokens_exhausted" => Some("今日公益 token 额度已用完，零点后恢复"),
        "service_daily_requests_exhausted" => Some("今日公益请求总额度已用完，零点后恢复"),
        "service_daily_tokens_exhausted" => Some("今日公益 token 总额度已用完，零点后恢复"),
        "rate_limit_exceeded" | "rate_limit_error" | "rate_limited" | "too_many_requests" => {
            Some("模型渠道请求频率受限")
        }
        "insufficient_quota" | "quota_exceeded" => Some("模型渠道额度不足"),
        _ => None,
    })
}

fn context_error(value: &Value) -> bool {
    ["/error/code", "/error/type", "/code"]
        .iter()
        .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .any(|code| {
            matches!(
                code,
                "context_length_exceeded"
                    | "context_too_long"
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
