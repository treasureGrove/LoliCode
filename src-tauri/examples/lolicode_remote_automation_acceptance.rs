//! Real SSH automation triggers through production scheduling and native tools.
//! Isolated DB/remote root, deterministic loopback model, no provider credentials.
#[cfg(not(feature = "test-hooks"))]
fn main() {
    eprintln!("requires --features test-hooks");
    std::process::exit(2);
}
#[cfg(feature = "test-hooks")]
mod acceptance {
    use anyhow::{anyhow, ensure, Context, Result};
    use axum::{body::Body, response::Response, routing::post, Json};
    use lolicode_lib::{agent_test_support::*, AppState, Database};
    use chrono::Timelike;
    use lolicode_agent::native::{NativeEngine, NativeGateway};
    use serde_json::{json, Value};
    use std::{
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tokio::sync::watch;
    const STORE: &str = "lolicode_agent_automations_v1";
    fn python(code: &str) -> String {
        format!("python3 -c '{}'", code.replace('\'', "'\\''"))
    }
    async fn rpc(
        target: &remote_transport::RemoteTarget,
        root: &str,
        op: &str,
        args: Value,
    ) -> Result<Value> {
        let (_owner, cancel) = watch::channel(false);
        remote_transport::call(target, op, Some(root), args, cancel)
            .await
            .map_err(|e| anyhow!(e))
    }
    async fn command(
        target: &remote_transport::RemoteTarget,
        root: &str,
        code: &str,
    ) -> Result<Value> {
        let r = rpc(
            target,
            root,
            "run_command",
            json!({"command":python(code),"timeout_seconds":10}),
        )
        .await?;
        ensure!(r["exitCode"] == 0, "owned remote command failed");
        Ok(r)
    }
    fn store(db: &Database) -> Result<Value> {
        Ok(serde_json::from_str(
            &db.get_setting(STORE)?.context("missing automation store")?,
        )?)
    }
    struct Runtime {
        engine: NativeEngine,
        remote: Arc<RemoteProjects>,
        catalog: channel_center::AgentCatalog,
        gateway: NativeGateway,
    }
    impl AutomationRuntime for Runtime {
        fn bind_project<'a>(
            &'a self,
            path: &'a str,
        ) -> futures::future::BoxFuture<'a, std::result::Result<channel_center::AgentCatalog, String>>
        {
            Box::pin(async move {
                let resolved = self.remote.resolve(Path::new(path))?;
                let (_owner, cancel) = watch::channel(false);
                let checked = self
                    .remote
                    .call(Path::new(path), "open_project", json!({}), cancel)
                    .await?;
                if checked["root"].as_str() != Some(&resolved.project.root) {
                    return Err("owned root changed".into());
                }
                self.engine
                    .bind_background(
                        path.into(),
                        serde_json::to_value(&self.catalog)
                            .map_err(|_| "catalog encoding failed")?,
                        self.gateway.clone(),
                    )
                    .await?;
                Ok(self.catalog.clone())
            })
        }
        fn call<'a>(
            &'a self,
            method: &'a str,
            params: Value,
            _mutate: bool,
        ) -> futures::future::BoxFuture<'a, std::result::Result<Value, String>> {
            Box::pin(async move { self.engine.call(method, params).await })
        }
    }
    async fn model(Json(body): Json<Value>) -> Response {
        let ms = body["messages"].as_array().unwrap();
        let prompt = ms
            .iter()
            .filter(|m| m["role"] == "user")
            .filter_map(|m| m["content"].as_str())
            .last()
            .unwrap_or_default();
        let done = ms.iter().any(|m| m["role"] == "tool");
        let code=match prompt {
            "AUTO_SCHEDULE"=>"from pathlib import Path;Path('scheduled.out').write_text('SCHEDULE_REMOTE_OK');print('SCHEDULE_REMOTE_OK')",
            "AUTO_IDLE"=>"from pathlib import Path;Path('idle.out').write_text('IDLE_REMOTE_OK');print('IDLE_REMOTE_OK')",
            "AUTO_CANCEL"=>"import os,time;open('automation-cancel.pid','w').write(str(os.getpid()));time.sleep(90)",
            _=>panic!("unexpected isolated prompt")
        };
        let frame = if done {
            json!({"choices":[{"delta":{"content":"REMOTE_AUTOMATION_FINISHED"},"finish_reason":"stop"}]})
        } else {
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"owned-auto-command","type":"function","function":{"name":"run_command","arguments":json!({"command":python(code),"timeout_seconds":120}).to_string()}}]},"finish_reason":"tool_calls"}]})
        };
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(format!("data: {frame}\n\ndata: [DONE]\n\n")))
            .unwrap()
    }
    async fn terminal(db: &Database, job: &str) -> Result<Option<Value>> {
        Ok(store(db)?["runs"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| r["automationId"] == job && r["finishedAt"].is_u64())
            .cloned())
    }
    async fn wait_run(
        runtime: Arc<dyn AutomationRuntime>,
        db: Arc<Database>,
        job: &str,
    ) -> Result<Value> {
        tokio::time::timeout(Duration::from_secs(210), async {
            loop {
                automation_tick(runtime.clone(), db.clone())
                    .await
                    .map_err(|e| anyhow!(e))?;
                if let Some(r) = terminal(&db, job).await? {
                    return Ok(r);
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        })
        .await
        .context("real-clock remote automation timed out")?
    }
    pub async fn run() -> Result<()> {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        if args.first().is_some_and(|a| a == "--verify-restart") {
            ensure!(
                args.len() == 4,
                "restart requires isolated db, engine, proof"
            );
            let db = Arc::new(isolated_database(Path::new(&args[1]))?);
            let engine = NativeEngine::open(PathBuf::from(&args[2]))
                .await
                .map_err(|e| anyhow!(e))?;
            let before = store(&db)?;
            ensure!(
                before["runs"].as_array().is_some_and(|r| r.len() == 3),
                "restart lost run history"
            );
            for row in before["runs"].as_array().unwrap() {
                let id = row["sessionId"]
                    .as_str()
                    .context("persisted session missing")?;
                let command=engine.call("queryCommand",json!({"sessionId":id,"requestId":format!("automation:{}",row["runId"].as_str().unwrap())})).await.map_err(|e|anyhow!(e))?;
                let expected = if row["outcome"] == "succeeded" {
                    "completed"
                } else {
                    "cancelled"
                };
                ensure!(
                    command["results"][0]["result"]["status"] == expected,
                    "restart native receipt changed: outcome={}, expected={}, actual={}",
                    row["outcome"],
                    expected,
                    command["results"][0]["result"]["status"]
                );
            }
            engine.shutdown().await.map_err(|e| anyhow!(e))?;
            std::fs::write(
                &args[3],
                serde_json::to_vec_pretty(
                    &json!({"passed":true,"separateProcess":true,"persistedAutomationAndNativeReceipts":true,"modelGatewayBound":false,"modelRequests":0}),
                )?,
            )?;
            return Ok(());
        }
        ensure!(
            args.len() == 4 && args[0] == "--ssh-config-alias" && args[2] == "--out",
            "usage: --ssh-config-alias <existing-alias> --out <absolute-proof.json>"
        );
        let out = PathBuf::from(&args[3]);
        ensure!(out.is_absolute(), "absolute proof path required");
        let target = remote_transport::RemoteTarget::Ssh {
            host: args[1].clone(),
            port: None,
            username: None,
            identity_file: None,
        };
        target.validate().map_err(|e| anyhow!(e))?;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let root = format!("/tmp/lolicode-remote-auto-{nonce}");
        let mut proof = json!({"passed":false,"realSsh":true,"realWsl":false,"productionSchedulerAndCancelService":true,"desktopIpcOrUiExercised":false,"designatedTestkeyAcceptance":false,"liveProviderRequests":0,"loopbackModel":true,"temporaryProjectAndDatabaseOnly":true,"cleanupConfirmed":false});
        let result:Result<()>=async {
            command(&target,"/tmp",&format!("from pathlib import Path;p=Path({root:?});p.mkdir(mode=0o700);(p/'.owned').write_text({nonce:?})")).await?;
            let temp=tempfile::tempdir()?;let dbpath=temp.path().join("fixture.sqlite");let enginepath=temp.path().join("engine");let anchors=temp.path().join("anchors");
            let db=Arc::new(isolated_database(&dbpath)?);let remote=Arc::new(RemoteProjects::new(db.clone(),anchors.clone()));
            let c=remote.connect("Owned remote automation".into(),target.clone()).await.map_err(|e|anyhow!(e))?;
            let p=remote.attach(&c.id,&root).await.map_err(|e|anyhow!(e))?;let anchor=remote.anchor(&p);
            let path=anchor.canonicalize()?.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
            let mut prefs=load_workspace_preferences(&db).map_err(|e|anyhow!(e))?;
            prefs.projects.insert(workspace_path_key(&path),AgentProject{path:path.clone(),name:"Owned remote automation".into(),standalone:false,pinned:false,last_opened_at:chrono::Utc::now().timestamp_millis() as u64});
            save_workspace_preferences(&db,&prefs).map_err(|e|anyhow!(e))?;
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await?;let address=listener.local_addr()?;
            let requests=Arc::new(AtomicUsize::new(0));let counted=requests.clone();
            let app=axum::Router::new().route("/v1/chat/completions",post(move |body:Json<Value>|{let counted=counted.clone();async move {assert!(counted.fetch_add(1,Ordering::SeqCst)<8,"loopback request budget exceeded");model(body).await}}));
            struct Server(tokio::task::JoinHandle<()>);impl Drop for Server{fn drop(&mut self){self.0.abort();}}
            let _server=Server(tokio::spawn(async move{axum::serve(listener,app).await.unwrap();}));
            let engine=NativeEngine::open(enginepath.clone()).await.map_err(|e|anyhow!(e))?;
            engine.set_application_tools(Arc::new(DesktopToolHost{local:DesktopApplicationTools(AppState::new(db.clone())),remote:remote.clone(),mcp:None})).await;
            let catalog=serde_json::from_value(json!({"revision":1,"models":[{"id":"lolicode/owned/fixture","providerId":"lolicode","modelId":"owned/fixture","name":"Owned fixture","channelName":"Owned"}],"defaultModel":"lolicode/owned/fixture","excludedSources":[]}))?;
            let runtime:Arc<dyn AutomationRuntime>=Arc::new(Runtime{engine:engine.clone(),remote:remote.clone(),catalog,gateway:NativeGateway{base_url:format!("http://{address}/v1"),bearer_token:"owned-loopback-only".into()}});
            // Foreground remains on a different local workspace throughout.
            let foreground=temp.path().join("foreground");std::fs::create_dir(&foreground)?;
            engine.bind(foreground.clone(),json!({"revision":1,"models":[{"id":"lolicode/owned/fixture","providerId":"lolicode","modelId":"owned/fixture","name":"Owned","channelName":"Owned"}],"defaultModel":"lolicode/owned/fixture","excludedSources":[]}),NativeGateway{base_url:format!("http://{address}/v1"),bearer_token:"owned-loopback-only".into()}).await.map_err(|e|anyhow!(e))?;
            let mut records=Vec::new();
            for (trigger,prompt,file,marker) in [("schedule","AUTO_SCHEDULE","scheduled.out","SCHEDULE_REMOTE_OK"),("idle","AUTO_IDLE","idle.out","IDLE_REMOTE_OK")] {
                let minute=(chrono::Local::now().minute()+1)%60;
                let job=create_automation(&db,&json!({"workspacePath":path,"title":prompt,"prompt":prompt,"trigger":trigger,"cronExpr":format!("{minute} * * * *"),"idleAfterMinutes":1,"idleIntervalMinutes":1,"recurring":false,"mode":"yolo","modelSelection":{"providerId":"lolicode","modelId":"owned/fixture"}})).await.map_err(|e|anyhow!(e))?;
                let observed_before=automation_system_idle_ms().await.map_err(|e|anyhow!(e))?;
                let run=wait_run(runtime.clone(),db.clone(),job["automationId"].as_str().unwrap()).await?;
                ensure!(run["outcome"]=="succeeded","remote automation did not succeed");
                let real=rpc(&target,&root,"read_file",json!({"path":file})).await?;
                ensure!(real["text"].as_str().is_some_and(|s|s.contains(marker)),"remote automation output missing");
                ensure!(!anchor.join(file).exists() && !foreground.join(file).exists(),"background remote write landed locally");
                let observed_after=automation_system_idle_ms().await.map_err(|e|anyhow!(e))?;
                if trigger=="idle" {ensure!(observed_after>=60_000,"idle trigger did not observe real inactivity");}
                records.push(json!({"trigger":trigger,"realClockDue":job["nextRunAt"],"createdAt":job["createdAt"],"runCreatedAt":run["createdAt"],"finishedAt":run["finishedAt"],"outcome":run["outcome"],"idleMsBefore":observed_before,"idleMsAfter":observed_after,"actualRemoteOutputVerified":true}));
            }
            let job=create_automation(&db,&json!({"workspacePath":path,"title":"Owned remote cancellation","prompt":"AUTO_CANCEL","trigger":"idle","idleAfterMinutes":1,"idleIntervalMinutes":1,"recurring":false,"mode":"yolo","modelSelection":{"providerId":"lolicode","modelId":"owned/fixture"}})).await.map_err(|e|anyhow!(e))?;
            let jobid=job["automationId"].as_str().unwrap();
            let (run,pid)=tokio::time::timeout(Duration::from_secs(210),async {loop {
                automation_tick(runtime.clone(),db.clone()).await.map_err(|e|anyhow!(e))?;
                let current=store(&db)?;let run=current["runs"].as_array().unwrap().iter().find(|r|r["automationId"]==jobid).cloned();
                if let (Some(run),Ok(value))=(run,rpc(&target,&root,"read_file",json!({"path":"automation-cancel.pid"})).await){
                    if let Some(pid)=value["text"].as_str().and_then(|s|s.split_once(':')).and_then(|(_,s)|s.trim().parse::<u32>().ok()) {break Ok::<_,anyhow::Error>((run,pid));}
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }}).await.context("remote cancel process did not start")??;
            ensure!(pid>1,"invalid remote test pid");
            let wrong=temp.path().join("wrong");std::fs::create_dir(&wrong)?;
            ensure!(cancel_automation_run(runtime.clone(),db.clone(),run["runId"].as_str().unwrap(),&wrong.to_string_lossy()).await.is_err(),"cross-workspace cancellation accepted");
            // Recovery against an already live carrier must keep monitoring, not
            // label its still-running command as failed or send the prompt twice.
            recover_automation_runs(runtime.clone(),db.clone()).await;
            ensure!(terminal(&db,jobid).await?.is_none(),"live recovery prematurely finished task");
            cancel_automation_run(runtime.clone(),db.clone(),run["runId"].as_str().unwrap(),&path).await.map_err(|e|anyhow!(e))?;
            let stopped=wait_run(runtime.clone(),db.clone(),jobid).await?;ensure!(stopped["outcome"]=="stopped","cancelled remote task not stopped");
            let process=command(&target,&root,&format!("from pathlib import Path;p=Path('/proc/{pid}/stat');print('STOPPED' if not p.exists() or p.read_text().rsplit(')',1)[1].split()[0]=='Z' else 'RUNNING')")).await?;
            ensure!(process["text"].as_str().is_some_and(|s|s.trim()=="STOPPED"),"cancelled remote process survived");
            let count=requests.load(Ordering::SeqCst);ensure!(count==5,"unexpected number of model requests");
            automation_tick(runtime.clone(),db.clone()).await.map_err(|e|anyhow!(e))?;ensure!(requests.load(Ordering::SeqCst)==count && store(&db)?["runs"].as_array().unwrap().len()==3,"completed jobs replayed");
            proof["runs"]=json!(records);proof["cancelServiceStoppedActualRemoteProcess"]=json!(true);proof["crossWorkspaceCancelRejected"]=json!(true);proof["liveRecoveryDidNotPrematurelyFailOrReplay"]=json!(true);proof["foregroundLocalProjectNotWritten"]=json!(true);proof["loopbackModelRequests"]=json!(count);proof["completedRunsNotReplayed"]=json!(true);
            let mut pre_restart=Vec::new();
            for row in store(&db)?["runs"].as_array().unwrap() {
                let value=engine.call("queryCommand",json!({"sessionId":row["sessionId"],"requestId":format!("automation:{}",row["runId"].as_str().unwrap())})).await.map_err(|e|anyhow!(e))?;
                pre_restart.push(json!({"outcome":row["outcome"],"commandStatus":value["results"][0]["result"]["status"]}));
            }
            proof["beforeRestartReceipts"]=json!(pre_restart);
            engine.shutdown().await.map_err(|e|anyhow!(e))?;drop(runtime);drop(engine);drop(remote);drop(db);
            let restartout=temp.path().join("restart.json");let exe=std::env::current_exe()?;
            let status=tokio::process::Command::new(exe).arg("--verify-restart").arg(&dbpath).arg(&enginepath).arg(&restartout).status().await?;
            ensure!(status.success(),"separate restart verification failed");let restart:Value=serde_json::from_slice(&std::fs::read(restartout)?)?;
            proof["runs"]=json!(records);proof["cancelServiceStoppedActualRemoteProcess"]=json!(true);proof["crossWorkspaceCancelRejected"]=json!(true);proof["liveRecoveryDidNotPrematurelyFailOrReplay"]=json!(true);proof["foregroundLocalProjectNotWritten"]=json!(true);proof["loopbackModelRequests"]=json!(count);proof["completedRunsNotReplayed"]=json!(true);proof["separateProcessRestart"]=restart;
            Ok(())
        }.await;
        let cleanup=command(&target,"/tmp",&format!("from pathlib import Path;import os,shutil;p=Path({root:?});assert p.parent==Path('/tmp') and not p.is_symlink();assert (p/'.owned').read_text()=={nonce:?};assert p.stat().st_uid==os.getuid();shutil.rmtree(p);print('OWNED_REMOVED')")).await;
        proof["cleanupConfirmed"] = json!(cleanup.as_ref().ok().is_some_and(|r| r["text"]
            .as_str()
            .is_some_and(|s| s.contains("OWNED_REMOVED"))));
        if let Err(error) = &result {
            proof["failure"] = json!(error.to_string());
        }
        proof["passed"] = json!(result.is_ok() && proof["cleanupConfirmed"] == true);
        std::fs::write(&out, serde_json::to_vec_pretty(&proof)?)?;
        println!(
            "Remote automation: passed={}, cleanup={}; proof={}",
            proof["passed"],
            proof["cleanupConfirmed"],
            out.display()
        );
        ensure!(
            proof["passed"] == true,
            "remote automation acceptance failed; inspect isolated proof"
        );
        Ok(())
    }
}
#[cfg(feature = "test-hooks")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    acceptance::run().await
}
