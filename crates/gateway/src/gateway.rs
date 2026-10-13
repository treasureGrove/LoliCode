use crate::{Channel, Result, SafeError, Store};
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, Request},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

const MAX_RESPONSE: usize = 8 * 1024 * 1024;
const MAX_EVENT: usize = 256 * 1024;
const MAX_CONCURRENT: usize = 8;

#[derive(Clone)]
pub struct Gateway {
    pub store: Arc<Store>,
    client: reqwest::Client,
    permits: Arc<Semaphore>,
    shutdown: CancellationToken,
}
pub struct GatewayHandle {
    pub port: u16,
    shutdown: CancellationToken,
    task: JoinHandle<std::io::Result<()>>,
}
impl GatewayHandle {
    pub fn cancel(&self) {
        self.shutdown.cancel();
    }
    pub async fn stop(self) {
        self.shutdown.cancel();
        let _ = self.task.await;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub non_stream: bool,
    pub stream: bool,
    pub duration_ms: u64,
    pub verified_at: u64,
}

impl Gateway {
    pub fn new(store: Arc<Store>, shutdown: CancellationToken) -> Result<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .user_agent("FreeHub/0.1")
            .build()
            .map_err(|_| SafeError::new(500, "http_initialization", "无法初始化安全网络连接。"))?;
        Ok(Self {
            store,
            client,
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT)),
            shutdown,
        })
    }
    pub fn router(&self) -> Router {
        Router::new().route("/v1/models",get(models)).route("/v1/chat/completions",post(chat))
            .route("/v1/responses",post(unsupported)).route("/v1/messages",post(unsupported))
            .fallback(|| async { SafeError::new(404,"not_found","此接口不存在。") })
            .layer(DefaultBodyLimit::max(1024*1024))
            .route_layer(middleware::from_fn_with_state(self.clone(),authenticate))
            .route("/health",get(|| async { Json(json!({"status":"ok","protocol":"openai-chat-completions","version":"0.1.0"})) }))
            .with_state(self.clone())
    }
    pub async fn start(&self, port: u16) -> Result<GatewayHandle> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|_| {
                SafeError::new(
                    503,
                    "port_unavailable",
                    "本地端口已被占用或无法监听，请关闭占用程序后重试。",
                )
            })?;
        let port = listener
            .local_addr()
            .map_err(|_| SafeError::storage())?
            .port();
        let stop = self.shutdown.child_token();
        let stop_server = stop.clone();
        let mut running = self.clone();
        running.shutdown = stop.clone();
        let router = running.router();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(stop_server.cancelled_owned())
                .await
        });
        Ok(GatewayHandle {
            port,
            shutdown: stop,
            task,
        })
    }
    pub async fn probe(&self, id: &str) -> Result<ProbeResult> {
        let c = self
            .store
            .channels()?
            .into_iter()
            .find(|c| c.id == id && c.enabled && c.confirmed_free)
            .ok_or_else(|| SafeError::invalid("请先保存并启用已确认免费的渠道。"))?;
        let start = Instant::now();
        for stream in [false, true] {
            let mut body = json!({"model":c.model,"messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":32,"stream":stream});
            if c.provider_id == "zhipu-bigmodel" {
                body["thinking"] = json!({"type":"disabled"});
            }
            let response = self.forward(c.clone(), body, stream).await?;
            let bytes = axum::body::to_bytes(response.into_body(), MAX_RESPONSE)
                .await
                .map_err(|_| {
                    SafeError::new(
                        502,
                        "stream_interrupted",
                        "测试流式调用中断，请检查渠道后重试。",
                    )
                })?;
            if stream && !bytes.ends_with(b"data: [DONE]\n\n") {
                return Err(SafeError::new(
                    502,
                    "stream_incomplete",
                    "渠道流式响应没有正常结束。",
                ));
            }
        }
        Ok(ProbeResult {
            non_stream: true,
            stream: true,
            duration_ms: start.elapsed().as_millis() as u64,
            verified_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        })
    }
    async fn forward(&self, c: Channel, mut body: Value, streaming: bool) -> Result<Response> {
        let permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| SafeError::new(429, "gateway_busy", "本地网关正忙，请稍后重试。"))?;
        let mut record = Completion::new(self.store.clone(), c.clone());
        body["model"] = Value::String(c.model.clone());
        let key = self.store.key(&c)?;
        let request = self
            .client
            .post(format!("{}/chat/completions", c.base_url))
            .bearer_auth(key.as_str())
            .json(&body);
        drop(key);
        let sent = tokio::select! {
            _ = self.shutdown.cancelled() => return Err(SafeError::new(503,"gateway_stopping","网关正在退出。")),
            response = tokio::time::timeout(Duration::from_secs(60),request.send()) => response,
        };
        let upstream = match sent {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => {
                record.fail("network_error", 502);
                return Err(SafeError::new(
                    502,
                    "network_error",
                    "无法连接渠道，请检查网络和接口地址。",
                ));
            }
            Err(_) => {
                record.fail("upstream_timeout", 504);
                return Err(SafeError::new(
                    504,
                    "upstream_timeout",
                    "渠道响应超时，请稍后重试。",
                ));
            }
        };
        if !upstream.status().is_success() {
            let error = SafeError::from_upstream(upstream.status().as_u16());
            record.fail(&error.code, upstream.status().as_u16());
            return Err(error);
        }
        if streaming {
            if !upstream
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|h| h.to_str().ok())
                .is_some_and(|s| s.starts_with("text/event-stream"))
            {
                record.fail("invalid_stream", 502);
                return Err(SafeError::new(
                    502,
                    "invalid_stream",
                    "渠道未返回有效的流式响应。",
                ));
            }
            let mut reader = SseReader::new(upstream.bytes_stream());
            // Do not commit local response headers until a valid upstream event is available.
            let first = match reader.next(&self.shutdown, 60).await {
                Ok(Some(v)) => v,
                Ok(None) => {
                    record.fail("empty_stream", 502);
                    return Err(SafeError::new(
                        502,
                        "empty_stream",
                        "渠道返回了空的流式响应。",
                    ));
                }
                Err(e) => {
                    record.fail(&e.code, e.status);
                    return Err(e);
                }
            };
            let shutdown = self.shutdown.clone();
            let stream = async_stream::stream! {
                let _permit: OwnedSemaphorePermit = permit;
                yield Ok::<Bytes,std::io::Error>(first);
                while !reader.done {
                    match reader.next(&shutdown,120).await {
                        Ok(Some(event)) => yield Ok(event),
                        Ok(None) => break,
                        Err(e) => {
                            record.fail(&e.code,e.status);
                            // Error text is controlled; never forward the upstream error payload.
                            let event = format!("event: error\ndata: {}\n\n",json!({"error":{"code":e.code,"message":e.message}}));
                            yield Ok(Bytes::from(event));
                            yield Err(std::io::Error::other("upstream stream interrupted"));
                            return;
                        }
                    }
                }
                if reader.done { record.success(); }
                else { record.fail("stream_incomplete",502); yield Err(std::io::Error::other("upstream ended before DONE")); }
            };
            Ok((
                [
                    (header::CONTENT_TYPE, "text/event-stream"),
                    (header::CACHE_CONTROL, "no-store"),
                    (header::CONNECTION, "keep-alive"),
                ],
                Body::from_stream(stream),
            )
                .into_response())
        } else {
            let mut stream = upstream.bytes_stream();
            let read = async {
                let mut bytes = Vec::new();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|_| {
                        SafeError::new(502, "response_interrupted", "渠道响应中断。")
                    })?;
                    if bytes.len() + chunk.len() > MAX_RESPONSE {
                        return Err(SafeError::new(
                            502,
                            "response_too_large",
                            "渠道响应超过本地大小限制。",
                        ));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| SafeError::new(502, "invalid_response", "渠道返回了无效响应。"))?;
                if value.get("error").is_some()
                    || !value.get("choices").is_some_and(Value::is_array)
                {
                    return Err(SafeError::new(
                        502,
                        "invalid_response",
                        "渠道未返回有效的对话结果。",
                    ));
                }
                Ok(value)
            };
            let result = tokio::select! {
                _ = self.shutdown.cancelled() => Err(SafeError::new(503,"gateway_stopping","网关正在退出。")),
                result = tokio::time::timeout(Duration::from_secs(60),read) => result.unwrap_or_else(|_|Err(SafeError::new(504,"upstream_timeout","渠道响应超时。"))),
            };
            match result {
                Ok(value) => {
                    record.success();
                    Ok(([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response())
                }
                Err(e) => {
                    record.fail(&e.code, e.status);
                    Err(e)
                }
            }
        }
    }
}

async fn authenticate(State(g): State<Gateway>, request: Request<Body>, next: Next) -> Response {
    if request.headers().contains_key(header::ORIGIN) {
        return SafeError::new(403, "origin_not_allowed", "此来源不允许访问本地模型接口。")
            .into_response();
    }
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|s| s.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    if !token.is_some_and(|t| g.store.authenticate(t)) {
        return SafeError::new(401, "unauthorized", "本地令牌无效或缺失。").into_response();
    }
    next.run(request).await
}
async fn unsupported() -> SafeError {
    SafeError::new(
        501,
        "unsupported_protocol",
        "此版本支持 Chat Completions；该协议尚未实现。",
    )
}
async fn models(State(g): State<Gateway>) -> Result<Json<Value>> {
    let data:Vec<Value> = g.store.channels()?.iter().filter(|c|c.enabled && c.confirmed_free && c.key_present)
        .map(|c|json!({"id":c.public_model(),"object":"model","created":0,"owned_by":c.provider_id})).collect();
    Ok(Json(json!({"object":"list","data":data})))
}
async fn chat(
    State(g): State<Gateway>,
    _headers: HeaderMap,
    body: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Response> {
    let Json(body) = body.map_err(|e| {
        SafeError::new(
            e.status().as_u16(),
            "invalid_request",
            "请求体不是有效 JSON 或超过 1 MiB 限制。",
        )
    })?;
    let obj = body
        .as_object()
        .ok_or_else(|| SafeError::invalid("请求体必须是 JSON 对象。"))?;
    let allowed = [
        "model",
        "messages",
        "stream",
        "max_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "stop",
        "n",
        "presence_penalty",
        "frequency_penalty",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "response_format",
        "seed",
        "stream_options",
        "thinking",
    ];
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(SafeError::invalid("请求包含此版本尚未支持的参数。"));
    }
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| SafeError::invalid("请选择网关模型列表中的模型 ID。"))?;
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty() && v.len() <= 500)
        .ok_or_else(|| SafeError::invalid("请提供有效的对话消息列表。"))?;
    if messages.iter().any(|m| {
        !m.get("role")
            .and_then(Value::as_str)
            .is_some_and(|r| ["system", "user", "assistant", "tool", "developer"].contains(&r))
            || m.get("content")
                .is_some_and(|v| !v.is_string() && !v.is_null())
    }) {
        return Err(SafeError::invalid(
            "此版本仅支持文本与工具消息，不支持多模态消息。",
        ));
    }
    let streaming = match body.get("stream") {
        Some(Value::Bool(v)) => *v,
        None => false,
        _ => return Err(SafeError::invalid("stream 必须为 true 或 false。")),
    };
    let c = g
        .store
        .channels()?
        .into_iter()
        .find(|c| c.enabled && c.confirmed_free && c.key_present && c.public_model() == model)
        .ok_or_else(|| {
            SafeError::new(
                404,
                "model_not_found",
                "模型不存在或渠道未启用，请获取最新网关模型列表。",
            )
        })?;
    g.forward(c, body, streaming).await
}

struct Completion {
    store: Arc<Store>,
    channel: Channel,
    start: Instant,
    status: u16,
    result: String,
}
impl Completion {
    fn new(store: Arc<Store>, channel: Channel) -> Self {
        Self {
            store,
            channel,
            start: Instant::now(),
            status: 499,
            result: "cancelled".into(),
        }
    }
    fn fail(&mut self, code: &str, status: u16) {
        self.result = code.into();
        self.status = status;
    }
    fn success(&mut self) {
        self.status = 200;
        self.result = "completed".into();
    }
}
impl Drop for Completion {
    fn drop(&mut self) {
        self.store.record(
            &self.channel.id,
            &self.channel.model,
            self.status,
            self.start.elapsed().as_millis() as u64,
            &self.result,
        );
    }
}

struct SseReader {
    stream: Pin<Box<dyn Stream<Item = std::result::Result<Bytes, reqwest::Error>> + Send>>,
    buffer: Vec<u8>,
    done: bool,
}
impl SseReader {
    fn new(
        stream: impl Stream<Item = std::result::Result<Bytes, reqwest::Error>> + Send + 'static,
    ) -> Self {
        Self {
            stream: Box::pin(stream),
            buffer: Vec::new(),
            done: false,
        }
    }
    async fn next(&mut self, cancel: &CancellationToken, seconds: u64) -> Result<Option<Bytes>> {
        let work = async {
            loop {
                if let Some((at, len)) = boundary(&self.buffer) {
                    let frame: Vec<u8> = self.buffer.drain(..at + len).collect();
                    let text = std::str::from_utf8(&frame).map_err(|_| {
                        SafeError::new(502, "invalid_stream", "渠道流式数据编码无效。")
                    })?;
                    let data = text
                        .lines()
                        .filter_map(|l| {
                            l.strip_prefix("data:")
                                .map(|s| s.strip_prefix(' ').unwrap_or(s))
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if data.is_empty() {
                        continue;
                    }
                    if data == "[DONE]" {
                        self.done = true;
                        return Ok(Some(Bytes::from_static(b"data: [DONE]\n\n")));
                    }
                    let value: Value = serde_json::from_str(&data).map_err(|_| {
                        SafeError::new(502, "invalid_stream", "渠道流式数据格式无效。")
                    })?;
                    if value.get("error").is_some() {
                        return Err(SafeError::new(
                            502,
                            "upstream_stream_error",
                            "渠道在流式调用中返回错误，请检查账户和模型。",
                        ));
                    }
                    if !value.get("choices").is_some_and(Value::is_array) {
                        return Err(SafeError::new(
                            502,
                            "invalid_stream",
                            "渠道返回了不支持的流式事件。",
                        ));
                    }
                    return Ok(Some(Bytes::from(format!("data: {value}\n\n"))));
                }
                match self.stream.next().await {
                    Some(Ok(bytes)) => {
                        if self.buffer.len() + bytes.len() > MAX_EVENT {
                            return Err(SafeError::new(
                                502,
                                "stream_event_too_large",
                                "渠道流式事件超过大小限制。",
                            ));
                        }
                        self.buffer.extend_from_slice(&bytes);
                    }
                    Some(Err(_)) => {
                        return Err(SafeError::new(
                            502,
                            "stream_interrupted",
                            "渠道流式连接中断。",
                        ))
                    }
                    None => {
                        return if self.done {
                            Ok(None)
                        } else {
                            Err(SafeError::new(
                                502,
                                "stream_incomplete",
                                "渠道流式响应没有正常结束。",
                            ))
                        }
                    }
                }
            }
        };
        tokio::select! {
            _ = cancel.cancelled() => Err(SafeError::new(503,"gateway_stopping","网关正在退出。")),
            result = tokio::time::timeout(Duration::from_secs(seconds),work) => result.unwrap_or_else(|_|Err(SafeError::new(504,"stream_timeout","渠道流式响应超时。"))),
        }
    }
}
fn boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    for i in 0..bytes.len() {
        if bytes.get(i..i + 2) == Some(b"\n\n") {
            return Some((i, 2));
        }
        if bytes.get(i..i + 4) == Some(b"\r\n\r\n") {
            return Some((i, 4));
        }
    }
    None
}
