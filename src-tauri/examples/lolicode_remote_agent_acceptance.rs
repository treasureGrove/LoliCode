//! Real SSH + the production tool host and NativeEngine, with a deterministic
//! loopback model. No paid model, user DB, real project, or provider key is used.
#[cfg(not(feature = "test-hooks"))]
fn main() {
    eprintln!("requires --features test-hooks");
    std::process::exit(2);
}

#[cfg(feature = "test-hooks")]
mod acceptance {
    use anyhow::{anyhow, ensure, Context, Result};
    use lolicode_lib::{
        agent_test_support::{
            remote_transport::{self, RemoteTarget},
            DesktopApplicationTools, DesktopToolHost, RemoteProjects,
        },
        AppState, Database,
    };
    use lolicode_agent::native::{NativeEngine, NativeGateway};
    use serde_json::{json, Value};
    use std::{
        path::PathBuf,
        sync::{Arc, Mutex},
        time::Duration,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::watch,
    };

    fn python(code: &str) -> String {
        format!("python3 -c '{}'", code.replace('\'', "'\\''"))
    }
    async fn rpc(target: &RemoteTarget, root: &str, op: &str, args: Value) -> Result<Value> {
        let (_owner, cancel) = watch::channel(false);
        remote_transport::call(target, op, Some(root), args, cancel)
            .await
            .map_err(|e| anyhow!(e))
    }
    async fn command(target: &RemoteTarget, root: &str, text: String) -> Result<Value> {
        let result = rpc(
            target,
            root,
            "run_command",
            json!({"command":text,"timeout_seconds":10}),
        )
        .await?;
        ensure!(result["exitCode"] == 0, "isolated fixture command failed");
        Ok(result)
    }
    async fn fake_model() -> Result<(
        NativeGateway,
        Arc<Mutex<Vec<Value>>>,
        tokio::task::JoinHandle<()>,
    )> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let gateway = NativeGateway {
            base_url: format!("http://{}/v1", listener.local_addr()?),
            bearer_token: "owned-remote-fixture-only".into(),
        };
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut input = Vec::new();
                let header_end = loop {
                    let mut chunk = [0u8; 8192];
                    let n = socket.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    input.extend_from_slice(&chunk[..n]);
                    if let Some(end) = input.windows(4).position(|b| b == b"\r\n\r\n") {
                        break end + 4;
                    }
                    assert!(input.len() < 65536);
                };
                let headers = String::from_utf8_lossy(&input[..header_end]);
                assert!(headers.starts_with("POST /v1/chat/completions "));
                let size = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                assert!(size < 1024 * 1024);
                while input.len() - header_end < size {
                    let mut chunk = [0u8; 8192];
                    let n = socket.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    input.extend_from_slice(&chunk[..n]);
                }
                let body: Value =
                    serde_json::from_slice(&input[header_end..header_end + size]).unwrap();
                let messages = body["messages"].as_array().unwrap();
                let cancel = messages.iter().any(|m| {
                    m["role"] == "user"
                        && m["content"].as_str().is_some_and(|s| s == "CANCEL_REMOTE")
                });
                let last_user = messages
                    .iter()
                    .rposition(|m| m["role"] == "user")
                    .unwrap_or(0);
                // Vision payloads are also user messages, so count tool results
                // over the whole edit task; a new cancellation turn starts fresh.
                let count = if cancel {
                    messages
                        .iter()
                        .skip(last_user + 1)
                        .filter(|m| m["role"] == "tool")
                        .count()
                } else {
                    messages.iter().filter(|m| m["role"] == "tool").count()
                };
                let call = if cancel {
                    (count==0).then(||("run_command",json!({"command":python("import os,time;open('native-cancel.pid','w').write(str(os.getpid()));time.sleep(40)"),"timeout_seconds":60})))
                } else {
                    match count {
                        0 => Some(("read_file", json!({"path":"main.js"}))),
                        1 => Some((
                            "apply_patch",
                            json!({"path":"main.js","old_text":"return a-b","new_text":"return a+b"}),
                        )),
                        2 => Some(("view_image", json!({"path":"sample.png"}))),
                        _ => None,
                    }
                };
                {
                    let mut saved = recorded.lock().unwrap();
                    assert!(saved.len() < 8, "bounded loopback budget");
                    saved.push(body);
                }
                let (delta, finish) = if let Some((name, args)) = call {
                    (
                        json!({"tool_calls":[{"index":0,"id":format!("remote-{name}"),"type":"function","function":{"name":name,"arguments":args.to_string()}}]}),
                        "tool_calls",
                    )
                } else {
                    (json!({"content":"REMOTE_NATIVE_TASK_FINISHED"}), "stop")
                };
                let response = format!(
                    "data: {}\n\ndata: [DONE]\n\n",
                    json!({"choices":[{"delta":delta,"finish_reason":finish}]})
                );
                let _=socket.write_all(format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{}",response.len(),response).as_bytes()).await;
            }
        });
        Ok((gateway, requests, task))
    }
    async fn snapshot(engine: &NativeEngine, id: &str) -> Result<Value> {
        engine
            .call("getSession", json!({"sessionId":id}))
            .await
            .map_err(|e| anyhow!(e))
    }
    async fn finish(engine: &NativeEngine, id: &str, root: &str) -> Result<(Value, usize)> {
        tokio::time::timeout(Duration::from_secs(90), async {
            let mut approvals = 0;
            loop {
                let state = snapshot(engine, id).await?;
                if matches!(state["status"].as_str(), Some("idle" | "error")) {
                    return Ok((state, approvals));
                }
                for p in state["permissions"].as_array().into_iter().flatten() {
                    ensure!(
                        matches!(
                            p["toolName"].as_str(),
                            Some("read_file" | "apply_patch" | "view_image")
                        ),
                        "unexpected tool permission"
                    );
                    ensure!(
                        p["resources"].as_array().is_some_and(
                            |r| r.len() == 1 && r[0].as_str().is_some_and(|s| s.contains(root))
                        ),
                        "permission is not scoped to fixture"
                    );
                    engine
                        .call(
                            "replyPermission",
                            json!({"sessionId":id,"requestId":p["id"],"decision":"once"}),
                        )
                        .await
                        .map_err(|e| anyhow!(e))?;
                    approvals += 1;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .context("native remote fixture timed out")?
    }
    pub async fn run() -> Result<()> {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        ensure!(
            args.len() == 4 && args[0] == "--ssh-config-alias" && args[2] == "--out",
            "usage: --ssh-config-alias <existing-alias> --out <absolute-proof.json>"
        );
        let out = PathBuf::from(&args[3]);
        ensure!(out.is_absolute(), "proof path must be absolute");
        let target = RemoteTarget::Ssh {
            host: args[1].clone(),
            port: None,
            username: None,
            identity_file: None,
        };
        target.validate().map_err(|e| anyhow!(e))?;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let root = format!("/tmp/lolicode-native-remote-{nonce}");
        let mut proof = json!({"passed":false,"realSsh":true,"realWsl":false,"productionToolHost":true,"nativeEngine":true,"desktopIpcOrUiExercised":false,"liveProviderRequests":0,"loopbackModel":true,"temporaryProjectAndDatabaseOnly":true,"providerCredentialsForwarded":false,"cleanupConfirmed":false});
        let result:Result<()>=async {
            let mut png=Vec::new();{ let mut enc=png::Encoder::new(&mut png,2,2);enc.set_color(png::ColorType::Rgba);let mut writer=enc.write_header()?;writer.write_image_data(&[255,0,0,255,0,0,255,255,255,0,0,255,0,0,255,255])?;writer.finish()?; }
            use base64::Engine as _;
            let pixel=base64::engine::general_purpose::STANDARD.encode(png);
            command(&target,"/tmp",python(&format!("from pathlib import Path;import base64;p=Path({root:?});p.mkdir(mode=0o700);(p/'.lolicode-owned-fixture').write_text({nonce:?});(p/'main.js').write_text('function sum(a,b){{return a-b}}\\n');(p/'sample.png').write_bytes(base64.b64decode({pixel:?}))"))).await?;
            let temp=tempfile::tempdir()?;
            let db=Arc::new(Database::memory().map_err(|e|anyhow!(e))?);
            let remotes=Arc::new(RemoteProjects::new(db.clone(),temp.path().join("anchors")));
            let connection=remotes.connect("Owned acceptance SSH".into(),target.clone()).await.map_err(|e|anyhow!(e))?;
            let project=remotes.attach(&connection.id,&root).await.map_err(|e|anyhow!(e))?;
            let anchor=remotes.anchor(&project);
            let duplicate=remotes.connect("Owned acceptance SSH".into(),target.clone()).await.map_err(|e|anyhow!(e))?;
            ensure!(duplicate.id==connection.id,"a retry created a duplicate connection identity");
            let listed=remotes.invoke("list",vec![]).await.map_err(|e|anyhow!(e))?;
            ensure!(listed["connections"].as_array().is_some_and(|c|c.len()==1),"saved connection missing or duplicated");
            let document="---\r\n# preserve source\r\ndescription: Remote review\r\ncustom: kept\r\nargs:\r\n  count:\r\n    type: number\r\n    default: 2\r\n---\r\nRead main.js, fix subtraction into addition, then inspect sample.png.\r\n";
            let params=json!({"workspacePath":anchor,"scope":"project","name":"remote-review","document":document});
            use lolicode_lib::agent_test_support::{remote_workflow_files,remote_workflow_prompt,record_run_in_db};
            remote_workflow_files(&remotes,"saveSavedWorkflow",vec![params.clone()]).await.map_err(|e|anyhow!(e))?;
            let loaded=remote_workflow_files(&remotes,"getSavedWorkflow",vec![params.clone()]).await.map_err(|e|anyhow!(e))?;
            ensure!(loaded["document"]==document && loaded["meta"]["custom"]=="kept","remote workflow source was not preserved");
            let edited=document.replace("inspect sample.png.","inspect sample.png and report the result.");
            let mut update=params.clone();update["document"]=json!(edited);update["expectedDocument"]=json!(document);update["overwrite"]=json!(true);
            remote_workflow_files(&remotes,"saveSavedWorkflow",vec![update.clone()]).await.map_err(|e|anyhow!(e))?;
            ensure!(remote_workflow_files(&remotes,"saveSavedWorkflow",vec![update]).await.is_err(),"stale remote edit overwrote new content");
            let workflows=remote_workflow_files(&remotes,"listSavedWorkflows",vec![params.clone()]).await.map_err(|e|anyhow!(e))?;
            ensure!(workflows["workflows"].as_array().is_some_and(|w|w.len()==1) && workflows["invalid"]==json!([]),"remote workflow catalog invalid");
            let prompt=remote_workflow_prompt(&remotes,&anchor.to_string_lossy(),"remote-review","project",&json!({})).await.map_err(|e|anyhow!(e))?;
            ensure!(prompt.contains("report the result") && prompt.contains("\"count\": 2"),"remote workflow did not render declared defaults");
            ensure!(!anchor.join(".zcode").exists(),"remote workflow was accidentally stored in the local identity directory");
            let (preview_path,preview)=remotes.preview_bytes(&anchor,&format!("{root}/main.js")).await.map_err(|e|anyhow!(e))?;
            ensure!(preview_path=="main.js" && String::from_utf8(preview)?.contains("return a-b"),"remote file preview returned the wrong bytes");
            let (_,image_preview)=remotes.preview_bytes(&anchor,"sample.png").await.map_err(|e|anyhow!(e))?;
            ensure!(base64::engine::general_purpose::STANDARD.encode(image_preview)==pixel,"remote raster preview changed bytes");
            ensure!(remotes.preview_bytes(&anchor,"/etc/passwd").await.is_err(),"preview escaped project root");
            proof["remoteConnectionRetryDeduplicated"]=json!(true);proof["remoteWorkflowCrudAndStaleSaveConflict"]=json!(true);proof["remotePreviewBytesAndRootScope"]=json!(true);
            let (gateway,requests,server)=fake_model().await?;
            let data=temp.path().join("engine");
            let engine=NativeEngine::open(data.clone()).await.map_err(|e|anyhow!(e))?;
            engine.set_application_tools(Arc::new(DesktopToolHost {local:DesktopApplicationTools(AppState::new(db.clone())),remote:remotes.clone()})).await;
            engine.bind(anchor.clone(),json!({"revision":1,"models":[{"id":"lolicode/channel/remote-fixture/model","providerId":"lolicode","modelId":"channel/remote-fixture/model","name":"Owned loopback fixture","channelName":"Owned fixture","contextLimit":128000}],"defaultModel":"lolicode/channel/remote-fixture/model","excludedSources":[]}),gateway).await.map_err(|e|anyhow!(e))?;
            let id=engine.call("createSession",json!({"title":"Owned remote acceptance","mode":"build","permissionMode":"ask"})).await.map_err(|e|anyhow!(e))?["id"].as_str().context("session missing")?.to_owned();
            record_run_in_db(&db,&anchor.to_string_lossy(),&id,"remote-review","project","remote-read-edit-image",&prompt).await.map_err(|e|anyhow!(e))?;
            engine.call("sendMessage",json!({"sessionId":id,"requestId":"remote-read-edit-image","text":prompt,"locale":"zh"})).await.map_err(|e|anyhow!(e))?;
            let (state,approvals)=finish(&engine,&id,&root).await?;
            proof["firstTaskStatus"]=state["status"].clone();proof["scopedPermissionApprovals"]=json!(approvals);
            // Read-only calls retain the core's automatic-read policy. Only the
            // file edit asks in ask mode; do not invent extra remote prompts.
            ensure!(state["status"]=="idle" && approvals==1,"remote task did not finish with one scoped write approval");
            ensure!(state["diffs"].as_array().is_some_and(|d|d.len()==1 && d[0]["path"]=="main.js"),"remote diff missing");
            let actual=rpc(&target,&root,"read_file",json!({"path":"main.js"})).await?;
            ensure!(actual["text"].as_str().is_some_and(|s|s.contains("return a+b")),"real remote file was not edited");
            ensure!(!anchor.join("main.js").exists() && !anchor.join("sample.png").exists(),"source leaked into local anchor");
            record_run_in_db(&db,&anchor.to_string_lossy(),&id,"remote-review","project","remote-read-edit-image",&prompt).await.map_err(|e|anyhow!(e))?;
            engine.call("sendMessage",json!({"sessionId":id,"requestId":"remote-read-edit-image","text":prompt,"locale":"zh"})).await.map_err(|e|anyhow!(e))?;
            ensure!(requests.lock().unwrap().len()==4,"lost-response retry replayed the remote workflow");
            let runs:Value=serde_json::from_str(&db.get_setting("lolicode_workflow_runs_v1").map_err(|e|anyhow!(e))?.context("run ledger missing")?)?;
            ensure!(runs.as_array().is_some_and(|r|r.len()==1),"workflow retry duplicated its run record");
            proof["remoteWorkflowPromptAndRunLedgerNoReplay"]=json!(true);
            {
                let calls=requests.lock().unwrap();ensure!(calls.len()==4,"unexpected model request count");
                let final_request=calls.last().unwrap();
                ensure!(final_request["messages"].to_string().contains(&format!("data:image/png;base64,{pixel}")),"remote PNG was not forwarded as model vision");
                ensure!(final_request["messages"][0]["content"].as_str().is_some_and(|s|s.contains(&root) && s.contains("private local identity")),"remote location note missing");
                for call in calls.iter() {
                    for message in call["messages"].as_array().unwrap().iter().filter(|m|m["role"]=="tool") { ensure!(!message["content"].to_string().contains("fileChanges"),"private snapshots leaked into model text"); }
                    ensure!(!call["tools"].to_string().contains("tavern_"),"local-only tools leaked into remote schemas");
                }
            }
            proof["scopedPermissionApprovals"]=json!(approvals);proof["remoteReadPatchAndModelImage"]=json!(true);proof["privateSnapshotsExcludedFromToolText"]=json!(true);
            // Exercise real engine cancellation after the actual remote process starts.
            engine.call("updateSession",json!({"sessionId":id,"permissionMode":"full_access"})).await.map_err(|e|anyhow!(e))?;
            engine.call("sendMessage",json!({"sessionId":id,"requestId":"remote-cancel","text":"CANCEL_REMOTE"})).await.map_err(|e|anyhow!(e))?;
            let pid=tokio::time::timeout(Duration::from_secs(20),async { loop {
                if let Ok(r)=rpc(&target,&root,"read_file",json!({"path":"native-cancel.pid"})).await {
                    if let Some(p)=r["text"].as_str().and_then(|s|s.split_once(':')).and_then(|(_,s)|s.trim().parse::<u32>().ok()) { return p; }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }}).await.context("owned cancellation process did not start")?;
            ensure!(pid>1,"invalid fixture pid");
            engine.call("interruptSession",json!({"sessionId":id})).await.map_err(|e|anyhow!(e))?;
            tokio::time::timeout(Duration::from_secs(15),async { loop { if !engine.busy().await.map_err(|e|anyhow!(e))? {break;}tokio::time::sleep(Duration::from_millis(50)).await;} Ok::<_,anyhow::Error>(()) }).await??;
            let stopped=command(&target,&root,python(&format!("from pathlib import Path;p=Path('/proc/{pid}/stat');print('STOPPED' if not p.exists() or p.read_text().rsplit(')',1)[1].split()[0]=='Z' else 'RUNNING')"))).await?;
            ensure!(stopped["text"].as_str().is_some_and(|s|s.trim()=="STOPPED"),"remote process survived engine cancellation");
            proof["engineCancellationStoppedActualRemoteProcess"]=json!(true);
            remote_workflow_files(&remotes,"deleteSavedWorkflow",vec![params]).await.map_err(|e|anyhow!(e))?;
            let empty=remote_workflow_files(&remotes,"listSavedWorkflows",vec![json!({"workspacePath":anchor,"scope":"project"})]).await.map_err(|e|anyhow!(e))?;
            ensure!(empty["workflows"]==json!([]),"remote workflow deletion did not persist");
            engine.shutdown().await.map_err(|e|anyhow!(e))?;
            let reopened=NativeEngine::open(data).await.map_err(|e|anyhow!(e))?;
            ensure!(snapshot(&reopened,&id).await?["diffs"]==state["diffs"],"remote diffs not persisted across engine reopen");
            reopened.shutdown().await.map_err(|e|anyhow!(e))?;
            remotes.disconnect(&connection.id).map_err(|e|anyhow!(e))?;
            let reloaded=RemoteProjects::new(db,temp.path().join("anchors"));
            ensure!(reloaded.resolve(&anchor).is_err() && reloaded.list().map_err(|e|anyhow!(e))?["projects"].as_array().is_some_and(|p|p.len()==1),"disconnect lost project or failed to revoke binding");
            proof["persistentDiffsAndDisconnectedBindingPreserved"]=json!(true);proof["loopbackModelRequests"]=json!(requests.lock().unwrap().len());
            server.abort();let _=server.await;
            Ok(())
        }.await;
        let cleanup=command(&target,"/tmp",python(&format!("from pathlib import Path;import shutil,os;p=Path({root:?});assert p.parent==Path('/tmp') and not p.is_symlink();assert (p/'.lolicode-owned-fixture').read_text()=={nonce:?};assert p.stat().st_uid==os.getuid();shutil.rmtree(p);print('OWNED_FIXTURE_REMOVED')"))).await;
        proof["cleanupConfirmed"] = json!(cleanup.as_ref().ok().is_some_and(|r| r["text"]
            .as_str()
            .is_some_and(|s| s.contains("OWNED_FIXTURE_REMOVED"))));
        if let Err(error) = &result {
            proof["failure"] = json!(error.to_string());
        }
        proof["passed"] = json!(result.is_ok() && proof["cleanupConfirmed"] == true);
        if let Some(parent) = out.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&out, serde_json::to_vec_pretty(&proof)?).await?;
        println!(
            "Native remote acceptance: passed={}, cleanup={}; proof={}",
            proof["passed"],
            proof["cleanupConfirmed"],
            out.display()
        );
        ensure!(
            proof["passed"] == true,
            "native remote acceptance failed; inspect isolated proof"
        );
        Ok(())
    }
}
#[cfg(feature = "test-hooks")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    acceptance::run().await
}
