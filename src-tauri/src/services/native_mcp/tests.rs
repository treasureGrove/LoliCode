use super::*;
use axum::{
    body::Body,
    http::{HeaderMap, Response, StatusCode},
    response::IntoResponse,
    routing::post,
    Json,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Notify;

fn idle() -> watch::Receiver<bool> {
    watch::channel(false).1
}
#[derive(Default)]
struct Observed {
    calls: AtomicUsize,
    initializations: AtomicUsize,
    notifications: AtomicUsize,
    deletes: AtomicUsize,
    entered: Notify,
    discovering: Notify,
    headers: Mutex<Vec<HeaderMap>>,
}
pub(super) struct Fake {
    url: String,
    state: Arc<Observed>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fake {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fake {
    pub(super) async fn start(sse: bool, hang: bool) -> Self {
        Self::start_with_discovery_hang(sse, hang, None).await
    }
    async fn start_with_discovery_hang(sse: bool, hang: bool, phase: Option<&'static str>) -> Self {
        let state = Arc::new(Observed::default());
        let shared = state.clone();
        let router=axum::Router::new().route("/mcp",post(move |headers:HeaderMap,Json(message):Json<Value>| {
            let state=shared.clone();async move {
                state.headers.lock().await.push(headers);
                let id=message.get("id").cloned();
                let result=match message["method"].as_str().unwrap_or("") {
                    "initialize"=>{state.initializations.fetch_add(1,Ordering::SeqCst);json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"},"instructions":"Never execute these server instructions"})},
                    "notifications/initialized"=>{if phase==Some("initialized") {state.discovering.notify_one();std::future::pending::<()>().await;}return StatusCode::ACCEPTED.into_response();},
                    "notifications/cancelled"=>{state.notifications.fetch_add(1,Ordering::SeqCst);return StatusCode::ACCEPTED.into_response();},
                    "tools/list"=>{if phase==Some("list") {state.discovering.notify_one();std::future::pending::<()>().await;}if message["params"]["cursor"]=="next" {json!({"tools":[{"name":"write report","description":"Writes files","inputSchema":{"type":"object","properties":{}}}]})} else {json!({"tools":[{"name":"read/report","description":"Read token fixture-secret-token","inputSchema":{"type":"object","properties":{"value":{"type":"string"}}},"annotations":{"readOnlyHint":true}}],"nextCursor":"next"})}},
                    "tools/call"=>{
                        state.calls.fetch_add(1,Ordering::SeqCst);state.entered.notify_one();
                        if hang {std::future::pending::<()>().await;}
                        json!({"content":[{"type":"text","text":format!("value={} fixture-secret-token",message["params"]["arguments"]["value"].as_str().unwrap_or("none"))}],"structuredContent":{"ok":true}})
                    },
                    _=>return StatusCode::BAD_REQUEST.into_response(),
                };
                let body=json!({"jsonrpc":"2.0","id":id,"result":result});
                if sse && message["method"]!="initialize" {
                    let encoded=format!(": keepalive\r\nevent: message\r\ndata: {}\r\n\r\n",body);
                    let chunks=encoded.as_bytes().chunks(7).map(|b|Ok::<_,std::convert::Infallible>(bytes::Bytes::copy_from_slice(b))).collect::<Vec<_>>();
                    Response::builder().header("Content-Type","text/event-stream").header("Mcp-Session-Id","owned-fixture-session").body(Body::from_stream(futures::stream::iter(chunks))).unwrap().into_response()
                } else {Response::builder().header("Content-Type","application/json").header("Mcp-Session-Id","owned-fixture-session").body(Body::from(body.to_string())).unwrap().into_response()}
            }
        }).delete({let state=state.clone();move || {let state=state.clone();async move {state.deletes.fetch_add(1,Ordering::SeqCst);StatusCode::NO_CONTENT}}}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { url, state, task }
    }
    pub(super) fn config(&self) -> Value {
        json!({"servers":{"fixture":{"type":"remote","url":self.url,"headers":{"Authorization":"Bearer fixture-secret-token"}}}})
    }
    pub(super) fn calls(&self) -> usize {
        self.state.calls.load(Ordering::SeqCst)
    }
}

#[tokio::test]
async fn configuration_is_inert_disabled_and_unsupported_servers_never_connect() {
    let fake = Fake::start(false, false).await;
    let manager = NativeMcpTools::new();
    let project = tempfile::tempdir().unwrap();
    manager.configure(1, fake.config()).await.unwrap();
    assert_eq!(fake.state.initializations.load(Ordering::SeqCst), 0);
    assert!(manager.schemas_for_project(project.path()).is_empty());
    assert_eq!(
        manager.status_catalog(project.path())[0]["status"],
        "disconnected"
    );
    let mut disabled = fake.config();
    disabled["servers"]["fixture"]["disabled"] = json!(true);
    manager.configure(2, disabled).await.unwrap();
    assert!(manager
        .discover(project.path(), idle())
        .await
        .unwrap()
        .is_empty());
    assert_eq!(fake.state.initializations.load(Ordering::SeqCst), 0);
    let mut unsupported = fake.config();
    unsupported["servers"]["fixture"]["oauth"] = json!({"clientSecret":"owned-oauth-secret"});
    manager.configure(3, unsupported).await.unwrap();
    manager.discover(project.path(), idle()).await.unwrap();
    let status = manager.status_catalog(project.path());
    assert_eq!(status[0]["status"], "error");
    assert!(!serde_json::to_string(&status)
        .unwrap()
        .contains("owned-oauth-secret"));
    assert_eq!(fake.state.initializations.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn real_http_json_and_fragmented_sse_discover_call_and_scope_tools_without_authorizing() {
    for sse in [false, true] {
        let fake = Fake::start(sse, false).await;
        let manager = NativeMcpTools::new();
        let project = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        manager.configure(1, fake.config()).await.unwrap();
        let schemas = manager.discover(project.path(), idle()).await.unwrap();
        assert_eq!(schemas.len(), 2);
        let schema_json = serde_json::to_string(&schemas).unwrap();
        assert!(!schema_json.contains("fixture-secret-token"));
        assert!(!schema_json.contains("Never execute these server instructions"));
        assert_eq!(
            fake.state.calls.load(Ordering::SeqCst),
            0,
            "tool discovery cannot invoke tools"
        );
        assert!(manager.schemas().is_empty());
        assert!(manager.schemas_for_project(other.path()).is_empty());
        let name = schemas
            .iter()
            .find(|s| {
                s["function"]["description"]
                    .as_str()
                    .unwrap()
                    .contains("Read token")
            })
            .unwrap()["function"]["name"]
            .as_str()
            .unwrap();
        assert!(
            name.len() <= 64
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        );
        let args = json!({"value":"actual-input"});
        let inspect = manager
            .inspect(project.path(), name, &args)
            .unwrap()
            .unwrap();
        assert!(
            inspect.mutating && inspect.requires_approval,
            "readOnlyHint is not permission"
        );
        assert!(manager.inspect(other.path(), name, &args).unwrap().is_err());
        let output = manager
            .execute_output(project.path(), name, &args, idle())
            .await
            .unwrap();
        assert!(output.text.contains("actual-input") && output.text.contains("已隐藏"));
        assert!(!output.text.contains("fixture-secret-token"));
        assert_eq!(fake.state.calls.load(Ordering::SeqCst), 1);
        assert!(output.diffs.is_empty() && output.file_changes.is_empty());
        assert_eq!(
            manager.status_catalog(project.path())[0]["status"],
            "connected"
        );
        let headers = fake.state.headers.lock().await;
        assert_eq!(headers[0]["accept"], "application/json, text/event-stream");
        for header in headers.iter().skip(1) {
            assert_eq!(header["mcp-session-id"], "owned-fixture-session");
            assert_eq!(header["mcp-protocol-version"], "2025-06-18");
        }
        drop(headers);
        manager.shutdown().await.unwrap();
        assert_eq!(fake.state.deletes.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn invalidating_unreadable_configuration_revokes_servers_without_reconnecting_old_settings() {
    let fake = Fake::start(false, false).await;
    let manager = NativeMcpTools::new();
    let project = tempfile::tempdir().unwrap();
    manager.configure(1, fake.config()).await.unwrap();
    let schemas = manager.discover(project.path(), idle()).await.unwrap();
    assert!(!schemas.is_empty());
    let old_name = schemas[0]["function"]["name"].as_str().unwrap();
    assert_eq!(fake.state.initializations.load(Ordering::SeqCst), 1);
    assert!(manager.configure(2, json!({"servers":[]})).await.is_err());
    manager.invalidate().await.unwrap();
    assert!(manager
        .discover(project.path(), idle())
        .await
        .unwrap()
        .is_empty());
    assert!(manager.schemas_for_project(project.path()).is_empty());
    assert!(manager.deferred_tool_names(project.path()).is_empty());
    assert!(manager.status_catalog(project.path()).is_empty());
    assert!(manager
        .inspect(project.path(), old_name, &json!({}))
        .unwrap()
        .is_err());
    assert_eq!(fake.state.initializations.load(Ordering::SeqCst), 1);
    assert_eq!(fake.state.deletes.load(Ordering::SeqCst), 1);
    assert!(manager.connections.lock().await.is_empty());
}

#[tokio::test]
async fn configuration_changes_revoke_catalog_and_change_inspected_resources() {
    let fake = Fake::start(false, false).await;
    let manager = NativeMcpTools::new();
    let project = tempfile::tempdir().unwrap();
    manager.configure(1, fake.config()).await.unwrap();
    let schemas = manager.discover(project.path(), idle()).await.unwrap();
    let name = schemas[0]["function"]["name"].as_str().unwrap();
    let before = manager
        .inspect(project.path(), name, &json!({}))
        .unwrap()
        .unwrap();
    let mut changed = fake.config();
    changed["servers"]["fixture"]["headers"]["Authorization"] =
        json!("Bearer replaced-fixture-token");
    manager.configure(2, changed).await.unwrap();
    assert!(manager
        .inspect(project.path(), name, &json!({}))
        .unwrap()
        .is_err());
    assert!(manager.schemas_for_project(project.path()).is_empty());
    manager.discover(project.path(), idle()).await.unwrap();
    let after = manager
        .inspect(project.path(), name, &json!({}))
        .unwrap()
        .unwrap();
    assert_ne!(before.resources, after.resources);
    assert!(!format!("{after:?}").contains("replaced-fixture-token"));
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn http_cancellation_and_timeout_send_notification_never_replay_a_call() {
    for timeout in [false, true] {
        let fake = Fake::start(false, true).await;
        let mut manager = NativeMcpTools::new();
        manager.request_timeout = Duration::from_millis(120);
        let manager = Arc::new(manager);
        let project = tempfile::tempdir().unwrap();
        manager.configure(1, fake.config()).await.unwrap();
        let schemas = manager.discover(project.path(), idle()).await.unwrap();
        let name = schemas[0]["function"]["name"].as_str().unwrap().to_string();
        let (stop, cancel) = watch::channel(false);
        let pending = {
            let manager = manager.clone();
            let path = project.path().to_path_buf();
            tokio::spawn(async move {
                manager
                    .execute_output(&path, &name, &json!({}), cancel)
                    .await
                    .map(|_| ())
            })
        };
        tokio::time::timeout(Duration::from_secs(2), fake.state.entered.notified())
            .await
            .unwrap();
        if !timeout {
            stop.send(true).unwrap();
        }
        let error = pending.await.unwrap().unwrap_err();
        assert!(error.starts_with("[cleanup_uncertain]"));
        assert_eq!(fake.state.calls.load(Ordering::SeqCst), 1);
        assert_eq!(fake.state.notifications.load(Ordering::SeqCst), 1);
        assert_eq!(manager.status_catalog(project.path())[0]["status"], "error");
        manager.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn dropping_http_discovery_future_closes_initializing_and_cached_sessions() {
    for phase in ["initialized", "list"] {
        let fake = Fake::start_with_discovery_hang(false, false, Some(phase)).await;
        let manager = Arc::new(NativeMcpTools::new());
        let project = tempfile::tempdir().unwrap();
        manager.configure(1, fake.config()).await.unwrap();
        let pending = {
            let manager = manager.clone();
            let path = project.path().to_path_buf();
            tokio::spawn(async move { manager.discover(&path, idle()).await })
        };
        tokio::time::timeout(Duration::from_secs(2), fake.state.discovering.notified())
            .await
            .unwrap();
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), async {
            while fake.state.deletes.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(manager.schemas_for_project(project.path()).is_empty());
        assert_eq!(
            manager.status_catalog(project.path())[0]["status"],
            "disconnected"
        );
        assert!(manager.connections.lock().await.values().all(|slot| slot
            .session
            .try_lock()
            .is_ok_and(|session| session.is_none())));
        manager.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn skill_only_revision_changes_do_not_cancel_an_inflight_mcp_call() {
    let fake = Fake::start(false, true).await;
    let manager = Arc::new(NativeMcpTools::new());
    let project = tempfile::tempdir().unwrap();
    manager.configure(1, fake.config()).await.unwrap();
    let schemas = manager.discover(project.path(), idle()).await.unwrap();
    let name = schemas[0]["function"]["name"].as_str().unwrap().to_string();
    let (stop, cancel) = watch::channel(false);
    let pending = {
        let manager = manager.clone();
        let path = project.path().to_path_buf();
        let name = name.clone();
        tokio::spawn(async move {
            manager
                .execute_output(&path, &name, &json!({}), cancel)
                .await
                .map(|_| ())
        })
    };
    tokio::time::timeout(Duration::from_secs(2), fake.state.entered.notified())
        .await
        .unwrap();
    manager.configure(99, fake.config()).await.unwrap();
    assert!(
        !pending.is_finished(),
        "an unrelated skill revision cannot cancel an MCP operation"
    );
    assert_eq!(fake.state.notifications.load(Ordering::SeqCst), 0);
    assert_eq!(fake.state.deletes.load(Ordering::SeqCst), 0);
    assert_eq!(fake.state.initializations.load(Ordering::SeqCst), 1);
    assert_eq!(manager.schemas_for_project(project.path()), schemas);
    assert!(manager
        .inspect(project.path(), &name, &json!({}))
        .unwrap()
        .is_ok());
    stop.send(true).unwrap();
    assert!(pending.await.unwrap().is_err());
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn disabling_configuration_cancels_inflight_http_without_waiting_for_call_timeout() {
    let fake = Fake::start(false, true).await;
    let manager = Arc::new(NativeMcpTools::new());
    let project = tempfile::tempdir().unwrap();
    manager.configure(1, fake.config()).await.unwrap();
    let schemas = manager.discover(project.path(), idle()).await.unwrap();
    let name = schemas[0]["function"]["name"].as_str().unwrap().to_string();
    let pending = {
        let manager = manager.clone();
        let path = project.path().to_path_buf();
        tokio::spawn(async move {
            manager
                .execute_output(&path, &name, &json!({}), idle())
                .await
                .map(|_| ())
        })
    };
    tokio::time::timeout(Duration::from_secs(2), fake.state.entered.notified())
        .await
        .unwrap();
    let mut config = fake.config();
    config["servers"]["fixture"]["disabled"] = json!(true);
    tokio::time::timeout(Duration::from_secs(2), manager.configure(2, config))
        .await
        .unwrap()
        .unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(manager.schemas_for_project(project.path()).is_empty());
    assert_eq!(
        manager.status_catalog(project.path())[0]["status"],
        "disabled"
    );
}

const STDIO: &str = r#"
const fs=require('fs'),rl=require('readline').createInterface({input:process.stdin});
const marker=process.env.OWNED_MARKER;
fs.writeFileSync(marker,JSON.stringify({pid:process.pid,cwd:process.cwd()}));
function reply(id,result){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n')}
function hang(phase){require('child_process').spawn(process.execPath,['-e',`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(process.env.OWNED_DESCENDANT)},'escaped'),700)`],{stdio:'ignore'});fs.writeFileSync(marker+'.'+phase,'entered');}
rl.on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;
if(m.method==='initialize'){if(process.env.OWNED_HANG_DISCOVERY==='initialize'){hang('initialize');return;}reply(m.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'owned-fixture',version:'1'}});}
else if(m.method==='tools/list'){if(process.env.OWNED_HANG_DISCOVERY==='list'){hang('list');return;}reply(m.id,{tools:[{name:'fixture_echo',description:'owned stdio tool',inputSchema:{type:'object',properties:{value:{type:'string'}}},annotations:{readOnlyHint:true}}]});}
else if(m.method==='tools/call'){
if(m.params.arguments.hang){hang('call');return;}
reply(m.id,{content:[{type:'text',text:JSON.stringify({value:m.params.arguments.value,cwd:process.cwd(),secret:process.env.OWNED_SECRET})}]});}
else reply(m.id,{});});
"#;
fn stdio_config(project: &Path, fixture: &Path, marker: &Path, descendant: &Path) -> Value {
    json!({"servers":{"stdio-fixture":{"type":"local","command":["node",fixture],"cwd":project,"environment":{"OWNED_MARKER":marker,"OWNED_DESCENDANT":descendant,"OWNED_SECRET":"owned-stdio-secret"}}}})
}
#[tokio::test]
async fn real_stdio_handshake_scope_redaction_and_shutdown_use_only_owned_fixture() {
    let fixture = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let marker = fixture.path().join("started.json");
    let file = fixture.path().join("server.cjs");
    std::fs::write(&file, STDIO).unwrap();
    let manager = NativeMcpTools::new();
    manager
        .configure(
            1,
            stdio_config(
                project.path(),
                &file,
                &marker,
                &fixture.path().join("descendant"),
            ),
        )
        .await
        .unwrap();
    assert!(!marker.exists(), "configure must not execute a server");
    let schemas = manager.discover(project.path(), idle()).await.unwrap();
    assert_eq!(
        schemas.len(),
        1,
        "{}",
        manager
            .status_catalog(project.path())
            .iter()
            .map(Value::to_string)
            .collect::<String>()
    );
    assert!(marker.exists());
    let receipt: Value = serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
    assert_eq!(
        std::fs::canonicalize(Path::new(receipt["cwd"].as_str().unwrap())).unwrap(),
        std::fs::canonicalize(project.path()).unwrap()
    );
    let output = manager
        .execute_output(
            project.path(),
            schemas[0]["function"]["name"].as_str().unwrap(),
            &json!({"value":"real roundtrip"}),
            idle(),
        )
        .await
        .unwrap();
    assert!(output.text.contains("real roundtrip") && output.text.contains("已隐藏"));
    assert!(!output.text.contains("owned-stdio-secret"));
    manager.shutdown().await.unwrap();
    assert!(manager.schemas_for_project(project.path()).is_empty());
}

#[tokio::test]
async fn dropping_stdio_discovery_future_reaps_initializing_and_cached_process_groups() {
    for phase in ["initialize", "list"] {
        let fixture = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let marker = fixture.path().join("started.json");
        let descendant = fixture.path().join("must-not-appear");
        let file = fixture.path().join("server.cjs");
        std::fs::write(&file, STDIO).unwrap();
        let manager = Arc::new(NativeMcpTools::new());
        let mut config = stdio_config(project.path(), &file, &marker, &descendant);
        config["servers"]["stdio-fixture"]["environment"]["OWNED_HANG_DISCOVERY"] = json!(phase);
        manager.configure(1, config).await.unwrap();
        let pending = {
            let manager = manager.clone();
            let path = project.path().to_path_buf();
            tokio::spawn(async move { manager.discover(&path, idle()).await })
        };
        let entered = fixture.path().join(format!("started.json.{phase}"));
        tokio::time::timeout(Duration::from_secs(2), async {
            while !entered.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert!(
            !descendant.exists(),
            "dropping discovery must kill its owned process tree during {phase}"
        );
        assert!(manager.schemas_for_project(project.path()).is_empty());
        assert_eq!(
            manager.status_catalog(project.path())[0]["status"],
            "disconnected"
        );
        manager.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn stdio_cancellation_reaps_server_and_its_owned_descendant() {
    let fixture = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let marker = fixture.path().join("started.json");
    let descendant = fixture.path().join("must-not-appear");
    let file = fixture.path().join("server.cjs");
    std::fs::write(&file, STDIO).unwrap();
    let manager = Arc::new(NativeMcpTools::new());
    manager
        .configure(1, stdio_config(project.path(), &file, &marker, &descendant))
        .await
        .unwrap();
    let schemas = manager.discover(project.path(), idle()).await.unwrap();
    assert_eq!(schemas.len(), 1);
    let name = schemas[0]["function"]["name"].as_str().unwrap().to_string();
    let (stop, cancel) = watch::channel(false);
    let pending = {
        let manager = manager.clone();
        let path = project.path().to_path_buf();
        tokio::spawn(async move {
            manager
                .execute_output(&path, &name, &json!({"hang":true}), cancel)
                .await
                .map(|_| ())
        })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while !marker.with_extension("json.call").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    stop.send(true).unwrap();
    assert!(pending.await.unwrap().is_err());
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(
        !descendant.exists(),
        "owned child process must be reaped before cancellation completes"
    );
    manager.shutdown().await.unwrap();
}
