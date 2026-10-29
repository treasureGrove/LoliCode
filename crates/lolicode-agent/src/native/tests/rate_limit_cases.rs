use super::super::inference::{self, Delta, ReadPolicy};
use super::*;

struct HttpReply {
    status: u16,
    retry_after: Option<&'static str>,
    body: String,
    json: bool,
}

fn limited(code: &str, retry_after: Option<&'static str>) -> HttpReply {
    HttpReply {
        status: 429,
        retry_after,
        body:
            json!({"error":{"code":code,"message":"owned-private-gateway PRIVATE_UPSTREAM_SECRET"}})
                .to_string(),
        json: true,
    }
}

fn successful(json_response: bool) -> HttpReply {
    let value = if json_response {
        json!({"choices":[{"message":{"content":"RATE_LIMIT_RECOVERED"},"finish_reason":"stop"}]})
    } else {
        json!({"choices":[{"delta":{"content":"RATE_LIMIT_RECOVERED"},"finish_reason":"stop"}]})
    };
    HttpReply {
        status: 200,
        retry_after: None,
        body: if json_response {
            value.to_string()
        } else {
            format!("data: {value}\n\ndata: [DONE]\n\n")
        },
        json: json_response,
    }
}

struct RateServer {
    gateway: NativeGateway,
    requests: Arc<StdMutex<Vec<(Value, Option<String>)>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for RateServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl RateServer {
    async fn start(handler: impl Fn(usize, &Value) -> HttpReply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let recorded = requests.clone();
        let handler = Arc::new(handler);
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut input = Vec::new();
                let header_end = loop {
                    let mut bytes = [0u8; 8192];
                    let n = socket.read(&mut bytes).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    input.extend_from_slice(&bytes[..n]);
                    if let Some(end) = input.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let headers = String::from_utf8(input[..header_end].to_vec()).unwrap();
                let size = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                while input.len() - header_end < size {
                    let mut bytes = [0u8; 8192];
                    let n = socket.read(&mut bytes).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    input.extend_from_slice(&bytes[..n]);
                }
                let body: Value =
                    serde_json::from_slice(&input[header_end..header_end + size]).unwrap();
                let title = body["messages"][0]["content"]
                    .as_str()
                    .is_some_and(|prompt| prompt.starts_with("You generate a short session title"));
                let reply = if title {
                    successful(true)
                } else {
                    let session = headers.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("x-lolicode-session-id")
                            .then(|| value.trim().to_owned())
                    });
                    let index = {
                        let mut requests = recorded.lock().unwrap();
                        requests.push((body.clone(), session));
                        requests.len()
                    };
                    handler(index, &body)
                };
                let retry = reply
                    .retry_after
                    .map(|value| format!("Retry-After: {value}\r\n"))
                    .unwrap_or_default();
                let content_type = if reply.json {
                    "application/json"
                } else {
                    "text/event-stream"
                };
                let response=format!("HTTP/1.1 {} Response\r\nConnection: close\r\nContent-Type: {content_type}\r\n{retry}Content-Length: {}\r\n\r\n{}",reply.status,reply.body.len(),reply.body);
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        Self {
            gateway: NativeGateway {
                base_url: format!("http://{address}/v1"),
                bearer_token: "owned-private-gateway".into(),
            },
            requests,
            task,
        }
    }

    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

async fn infer(server: &RateServer) -> Result<inference::Turn, String> {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (_sender, cancel) = tokio::sync::watch::channel(false);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    inference::infer_with_policy(&client,&server.gateway,"channel/opaque/model",None,32000,
        vec![json!({"role":"user","content":"Continue after the completed tool"}),
             json!({"role":"assistant","content":null,"tool_calls":[{"id":"completed-tool-once","type":"function","function":{"name":"write_file","arguments":"{}"}}]}),
             json!({"role":"tool","tool_call_id":"completed-tool-once","content":"ALREADY_WRITTEN"})],
        vec![],tx,cancel,ReadPolicy{progress_timeout:Duration::from_secs(2),terminal_grace:Duration::from_millis(10)},
        Some("lc:00000000-0000-4000-8000-000000000001")).await
}

#[tokio::test]
async fn short_rate_limit_retries_identical_request_then_accepts_stream_or_json() {
    for json_response in [false, true] {
        let server = RateServer::start(move |index, _| {
            if index == 1 {
                limited("service_rate_limited", Some("0"))
            } else {
                successful(json_response)
            }
        })
        .await;
        let turn = infer(&server).await.unwrap();
        assert_eq!(turn.content, "RATE_LIMIT_RECOVERED");
        assert_eq!(server.count(), 2);
        let requests = server.requests.lock().unwrap();
        assert_eq!(
            requests[0], requests[1],
            "retry must preserve completed tool history and session attribution"
        );
        assert!(requests[1].0["messages"]
            .to_string()
            .contains("ALREADY_WRITTEN"));
    }
}

#[tokio::test]
async fn missing_invalid_or_long_retry_after_does_not_replay_and_errors_are_safe() {
    for header in [
        None,
        Some("invalid"),
        Some("-1"),
        Some("61"),
        Some("999999999999999999999999"),
    ] {
        let server = RateServer::start(move |_, _| limited("service_rate_limited", header)).await;
        let error = infer(&server).await.err().unwrap();
        assert_eq!(server.count(), 1);
        assert!(error.contains("请求频率受限"));
        assert!(error.contains("HTTP 429"));
        assert!(!error.contains("PRIVATE_UPSTREAM_SECRET"));
        assert!(!error.contains("owned-private-gateway"));
    }
}

#[tokio::test]
async fn retry_after_seconds_are_waited_before_the_next_http_attempt() {
    let server = RateServer::start(|index, _| {
        if index == 1 {
            limited("service_rate_limited", Some("1"))
        } else {
            successful(false)
        }
    })
    .await;
    let started = tokio::time::Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(5), infer(&server))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.content, "RATE_LIMIT_RECOVERED");
    assert_eq!(server.count(), 2);
    assert!(started.elapsed() >= Duration::from_millis(900));
}

#[tokio::test]
async fn daily_and_billing_quotas_never_retry_even_with_short_header() {
    for code in [
        "daily_requests_exhausted",
        "daily_tokens_exhausted",
        "service_daily_requests_exhausted",
        "service_daily_tokens_exhausted",
        "insufficient_quota",
        "billing_hard_limit_reached",
    ] {
        let server = RateServer::start(move |_, _| limited(code, Some("0"))).await;
        let error = infer(&server).await.err().unwrap();
        assert_eq!(server.count(), 1, "terminal quota: {code}");
        assert!(error.contains("额度") || error.contains("次数"));
        assert!(error.contains("恢复后继续"));
        assert!(!error.contains("PRIVATE_UPSTREAM_SECRET"));
    }
}

#[tokio::test]
async fn transient_and_generic_429_have_a_fixed_retry_count() {
    for code in [
        "account_busy",
        "service_busy",
        "service_rate_limited",
        "rate_limit_exceeded",
        "unknown_busy",
    ] {
        let server = RateServer::start(move |_, _| limited(code, Some("0"))).await;
        let error = infer(&server).await.err().unwrap();
        assert_eq!(
            server.count(),
            4,
            "one admitted attempt and at most three retries"
        );
        assert!(error.contains("HTTP 429"));
    }
}

#[tokio::test]
async fn a_stream_error_after_output_does_not_retry_or_duplicate_text() {
    let server=RateServer::start(|_,_|HttpReply{status:200,retry_after:Some("0"),json:false,
        body:format!("data: {}\n\ndata: {}\n\n",json!({"choices":[{"delta":{"content":"PRESERVED_PARTIAL_TEXT"},"finish_reason":null}]}),
            json!({"error":{"code":"service_rate_limited","message":"PRIVATE_UPSTREAM_SECRET"}}))}).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (_sender, cancel) = tokio::sync::watch::channel(false);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let error = inference::infer_with_policy(
        &client,
        &server.gateway,
        "channel/opaque/model",
        None,
        32000,
        vec![],
        vec![],
        tx,
        cancel,
        ReadPolicy::default(),
        None,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(server.count(), 1);
    assert!(error.contains("请求频率受限"));
    let mut text = String::new();
    while let Ok(delta) = rx.try_recv() {
        if let Delta::Text(value) = delta {
            text.push_str(&value);
        }
    }
    assert_eq!(text, "PRESERVED_PARTIAL_TEXT");
    assert!(!error.contains("PRIVATE_UPSTREAM_SECRET"));
}

#[tokio::test]
async fn engine_remains_running_while_rate_limited_and_stop_interrupts_the_wait() {
    let server = RateServer::start(|_, _| limited("service_rate_limited", Some("30"))).await;
    let data = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let engine = NativeEngine::open(data.path().into()).await.unwrap();
    engine
        .bind(project.path().into(), catalog(), server.gateway.clone())
        .await
        .unwrap();
    let session = engine
        .call(
            "createSession",
            json!({"mode":"build","permissionMode":"auto"}),
        )
        .await
        .unwrap();
    let id = session["id"].as_str().unwrap();
    send(
        &engine,
        id,
        "rate-wait-stop",
        "Observe waiting and stop safely",
    )
    .await;
    let value = wait(&engine, id, |value| {
        value["modelPhase"] == "waiting" && server.count() == 1
    })
    .await;
    assert_eq!(value["status"], "running");
    assert!(value["error"].is_null());
    tokio::time::timeout(
        Duration::from_secs(1),
        engine.call("interruptSession", json!({"sessionId":id})),
    )
    .await
    .unwrap()
    .unwrap();
    let stopped = wait(&engine, id, |value| value["status"] == "idle").await;
    assert!(stopped["error"].is_null());
    assert_eq!(server.count(), 1);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn relay_context_too_long_code_uses_existing_safe_checkpoint_signal() {
    let server = RateServer::start(|_, _| HttpReply {
        status: 400,
        retry_after: None,
        json: true,
        body: json!({"error":{"code":"context_too_long","message":"PRIVATE_UPSTREAM_SECRET"}})
            .to_string(),
    })
    .await;
    assert_eq!(
        infer(&server).await.err().unwrap(),
        inference::CONTEXT_EXCEEDED
    );
    assert_eq!(server.count(), 1);
}

fn parameter_error(status: u16, code: &str, param: &str) -> HttpReply {
    HttpReply { status, retry_after: None, json: true,
        body: json!({"error":{"code":code,"param":param,"message":"owned-private-gateway secret upstream detail"}}).to_string() }
}

async fn infer_alias_fixture(server: &RateServer) -> Result<inference::Turn, String> {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (_sender, cancel) = tokio::sync::watch::channel(false);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    inference::infer_with_policy(
        &client, &server.gateway, "channel/opaque/model", Some("high"), 32000,
        vec![json!({"role":"user","content":"Continue the existing task"}),
             json!({"role":"assistant","content":null,"tool_calls":[{"id":"already-completed","type":"function","function":{"name":"write_file","arguments":"{}"}}]}),
             json!({"role":"tool","tool_call_id":"already-completed","content":"COMPLETED_DO_NOT_REPLAY"})],
        vec![json!({"type":"function","function":{"name":"read_file","parameters":{"type":"object"}}})],
        tx, cancel, ReadPolicy::default(), Some("lc:00000000-0000-4000-8000-000000000001"),
    ).await
}

#[tokio::test]
async fn explicit_unsupported_max_tokens_switches_alias_once_with_identical_history_and_headers() {
    for json_response in [false, true] {
        let server = RateServer::start(move |index, body| {
            if index == 1 {
                assert_eq!(body["max_tokens"], 32000);
                assert!(body.get("max_completion_tokens").is_none());
                parameter_error(400, "unsupported_parameter", "max_tokens")
            } else {
                assert_eq!(body["max_completion_tokens"], 32000);
                assert!(body.get("max_tokens").is_none());
                successful(json_response)
            }
        })
        .await;
        assert!(infer_alias_fixture(&server).await.is_ok());
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let mut original = requests[0].0.clone();
        let mut retried = requests[1].0.clone();
        original.as_object_mut().unwrap().remove("max_tokens");
        retried
            .as_object_mut()
            .unwrap()
            .remove("max_completion_tokens");
        assert_eq!(original, retried);
        assert_eq!(retried["reasoning_effort"], "high");
        assert_eq!(requests[0].1, requests[1].1);
        assert_eq!(
            requests[0].1.as_deref(),
            Some("lc:00000000-0000-4000-8000-000000000001")
        );
    }
}

#[tokio::test]
async fn alias_rejection_does_not_loop_and_other_http_errors_never_switch_parameters() {
    for second_param in ["max_tokens", "max_completion_tokens"] {
        let server = RateServer::start(move |index, _| {
            parameter_error(
                400,
                "unsupported_parameter",
                if index == 1 {
                    "max_tokens"
                } else {
                    second_param
                },
            )
        })
        .await;
        let error = infer_alias_fixture(&server).await.err().unwrap();
        assert_eq!(server.count(), 2);
        assert!(!error.contains("secret"));
    }
    for (status, code, param) in [
        (400, "unsupported_value", "max_tokens"),
        (400, "unsupported_parameter", "temperature"),
        (400, "context_too_long", "max_tokens"),
        (429, "daily_tokens_exhausted", "max_tokens"),
        (422, "unsupported_parameter", "max_tokens"),
    ] {
        let server = RateServer::start(move |_, _| parameter_error(status, code, param)).await;
        assert!(infer_alias_fixture(&server).await.is_err());
        assert_eq!(server.count(), 1, "{status} {code} {param}");
    }
}

#[tokio::test]
async fn unsupported_parameter_after_successful_http_never_replays_the_stream() {
    for partial_stream in [false, true] {
        let server = RateServer::start(move |_, _| {
            let error = json!({"error":{"code":"unsupported_parameter","param":"max_tokens"}});
            HttpReply { status:200, retry_after:None, json:!partial_stream,
                body:if partial_stream { format!("data: {}\n\ndata: {error}\n\n", json!({"choices":[{"delta":{"content":"PARTIAL_RETAINED"},"finish_reason":null}]})) } else { error.to_string() } }
        }).await;
        assert!(infer_alias_fixture(&server).await.is_err());
        assert_eq!(server.count(), 1);
    }
}
