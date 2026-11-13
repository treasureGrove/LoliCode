use super::*;
use std::sync::Mutex;

const MODEL: &str = "fixture-model";
const ROUTE: &str = "fixture-channel/selected-route";
const STREAM: &str =
    "data: {\"choices\":[{\"delta\":{\"content\":\"fixture\"}}]}\n\ndata: [DONE]\n\n";

type Requests = Arc<Mutex<Vec<(HeaderMap, Value)>>>;

async fn upstream(
    State(requests): State<Requests>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    requests.lock().unwrap().push((headers, body));
    ([(header::CONTENT_TYPE, "text/event-stream")], STREAM).into_response()
}

struct ServerTask(JoinHandle<()>);

impl Drop for ServerTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[tokio::test]
async fn active_runtime_keeps_gateway_after_one_hour_and_drop_revokes_its_token() {
    let requests: Requests = Arc::new(Mutex::new(Vec::new()));
    let upstream_listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let upstream_url = format!(
        "http://{}/chat/completions",
        upstream_listener.local_addr().unwrap()
    );
    let upstream_router = Router::new()
        .route("/chat/completions", post(upstream))
        .with_state(requests.clone());
    let _upstream = ServerTask(tokio::spawn(async move {
        axum::serve(upstream_listener, upstream_router)
            .await
            .unwrap();
    }));
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let token = uuid::Uuid::new_v4().simple().to_string();
    let active = Arc::new(AtomicBool::new(true));
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let lease = Arc::new(Lease {
        token: token.clone(),
        active: active.clone(),
        model: MODEL.into(),
        route: ROUTE.into(),
        upstream: reqwest::Url::parse(&upstream_url).unwrap(),
        gateway_bearer: "private-upstream-fixture-token".into(),
        client: client.clone(),
    });
    let owner = HarnessGateway {
        model: MODEL.into(),
        profile_patch: Value::Null,
        token: token.clone(),
        reuse_fingerprint: "fixture-route".into(),
        active,
        task: serve_lease(listener, lease.clone()),
    };
    let started = tokio::time::Instant::now();
    let send = |bearer: &str, model: &str| {
        client
            .post(&endpoint)
            .bearer_auth(bearer)
            .json(&json!({ "model": model, "stream": true, "messages": [] }))
            .send()
    };

    // Establish real HTTP forwarding before advancing virtual time. Resume
    // time before further I/O so Tokio cannot auto-advance connection deadlines.
    let first = send(&token, MODEL).await.unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.headers()[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(first.text().await.unwrap(), STREAM);
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(60 * 60 + 18)).await;
    tokio::time::resume();
    assert!(started.elapsed() >= Duration::from_secs(60 * 60 + 18));
    let after_hour = send(&token, MODEL).await.unwrap();
    assert_eq!(after_hour.status(), StatusCode::OK);
    assert_eq!(after_hour.text().await.unwrap(), STREAM);

    let wrong_token = send("wrong-fixture-token", MODEL).await.unwrap();
    assert_eq!(wrong_token.status(), StatusCode::UNAUTHORIZED);
    let wrong_model = send(&token, "other-model").await.unwrap();
    assert_eq!(wrong_model.status(), StatusCode::BAD_REQUEST);
    {
        let forwarded = requests.lock().unwrap();
        assert_eq!(forwarded.len(), 2);
        for (headers, body) in forwarded.iter() {
            assert_eq!(body["model"], ROUTE);
            assert_eq!(
                headers[header::AUTHORIZATION],
                "Bearer private-upstream-fixture-token"
            );
            assert_eq!(body["stream"], true);
        }
    }

    drop(owner);
    assert!(!lease.active.load(Ordering::Acquire));
    // An accepted connection may survive listener cancellation; both a closed
    // connection and a revoked-token response must prevent upstream forwarding.
    match send(&token, MODEL).await {
        Ok(response) => assert_eq!(response.status(), StatusCode::UNAUTHORIZED),
        Err(error) => assert!(error.is_connect() || error.is_request()),
    }
    let headers = HeaderMap::from_iter([(
        header::AUTHORIZATION,
        header::HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    )]);
    let revoked = complete(State(lease), headers, Json(json!({ "model": MODEL }))).await;
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(requests.lock().unwrap().len(), 2);
}
