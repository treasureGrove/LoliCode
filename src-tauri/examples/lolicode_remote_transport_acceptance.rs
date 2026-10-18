//! Explicit non-model acceptance against an operator-selected SSH configuration
//! alias. Creates only its own nonce-marked /tmp fixture and removes it afterwards.
#[cfg(not(feature = "test-hooks"))]
fn main() {
    eprintln!("requires --features test-hooks");
    std::process::exit(2);
}

#[cfg(feature = "test-hooks")]
mod acceptance {
    use anyhow::{anyhow, ensure, Context, Result};
    use cc_switch_lib::agent_test_support::remote_transport::{
        self, RemoteErrorKind, RemoteTarget,
    };
    use serde_json::{json, Value};
    use std::{path::PathBuf, time::Duration};
    use tokio::sync::watch;

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
    fn python(script: &str) -> String {
        format!("python3 -c {}", shell_quote(script))
    }
    async fn rpc(
        target: &RemoteTarget,
        operation: &str,
        root: Option<&str>,
        args: Value,
    ) -> Result<Value> {
        let (_owner, cancel) = watch::channel(false);
        remote_transport::call(target, operation, root, args, cancel)
            .await
            .map_err(|error| anyhow!(error))
    }
    async fn command(target: &RemoteTarget, root: &str, command: String) -> Result<Value> {
        let result = rpc(
            target,
            "run_command",
            Some(root),
            json!({"command":command,"timeout_seconds":10}),
        )
        .await?;
        ensure!(result["exitCode"] == 0, "isolated remote command failed");
        Ok(result)
    }
    async fn expected_error(
        target: &RemoteTarget,
        operation: &str,
        root: &str,
        args: Value,
        expected: RemoteErrorKind,
    ) -> Result<()> {
        let (_owner, cancel) = watch::channel(false);
        let error = remote_transport::call(target, operation, Some(root), args, cancel)
            .await
            .err()
            .context("remote rejection expected")?;
        ensure!(
            error.kind == expected,
            "unexpected remote rejection category: {:?}",
            error.kind
        );
        Ok(())
    }
    async fn read_pid(target: &RemoteTarget, root: &str, filename: &str) -> Result<u32> {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Ok(result) =
                    rpc(target, "read_file", Some(root), json!({"path":filename})).await
                {
                    let text = result["text"].as_str().context("PID receipt missing")?;
                    let value = text
                        .split_once(':')
                        .context("PID line missing")?
                        .1
                        .trim()
                        .parse::<u32>()?;
                    ensure!(value > 1, "invalid owned process id");
                    return Ok::<_, anyhow::Error>(value);
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        })
        .await
        .context("owned remote command did not start")?
    }
    async fn pid_stopped(target: &RemoteTarget, root: &str, pid: u32) -> Result<bool> {
        let code=format!("from pathlib import Path;p=Path('/proc/{pid}/stat');print('stopped' if not p.exists() or p.read_text().rsplit(')',1)[1].split()[0]=='Z' else 'running')");
        let result = command(target, root, python(&code)).await?;
        Ok(result["text"]
            .as_str()
            .is_some_and(|text| text.trim() == "stopped"))
    }

    pub async fn run() -> Result<()> {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        ensure!(
            args.len() == 4 && args[0] == "--ssh-config-alias" && args[2] == "--out",
            "usage: --ssh-config-alias <existing-alias> --out <absolute-proof.json>"
        );
        let output = PathBuf::from(&args[3]);
        ensure!(output.is_absolute(), "proof path must be absolute");
        let target = RemoteTarget::Ssh {
            host: args[1].clone(),
            port: None,
            username: None,
            identity_file: None,
        };
        target.validate().map_err(|error| anyhow!(error))?;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let root = format!("/tmp/lolicode-remote-acceptance-{nonce}");
        let mut proof = json!({"passed":false,"realSsh":true,"realWsl":false,"modelRequests":0,"userProjectsModified":false,"providerCredentialsForwarded":false,"desktopAgentIntegrationExercised":false,"temporaryProjectOnly":true,"checks":{},"cleanupConfirmed":false});
        let result:Result<()>=async {
            let probe=rpc(&target,"probe",None,json!({})).await?;
            ensure!(probe["platform"]=="linux" && probe["protocolVersion"]==1,"this explicit acceptance requires a Linux target");
            proof["remotePlatform"]=probe["platform"].clone();proof["remotePythonVersion"]=probe["pythonVersion"].clone();
            command(&target,"/tmp",python(&format!("from pathlib import Path;p=Path({root:?});p.mkdir(mode=0o700);(p/'.lolicode-owned-fixture').write_text({nonce:?})"))).await?;
            let opened=rpc(&target,"open_project",Some(&root),json!({})).await?;
            ensure!(opened["root"]==root,"temporary project root mismatch");
            command(&target,&root,"mkdir -- 'directory with spaces'".into()).await?;
            let path="directory with spaces/测试.txt";
            let original="第一行\r\nvalue = 'before'\r\n";
            let created=rpc(&target,"write_file",Some(&root),json!({"path":path,"content":original,"expected_content":null})).await?;
            ensure!(created["fileChanges"][0]["before"].is_null() && created["fileChanges"][0]["after"]==original,"create receipt mismatch");
            let read=rpc(&target,"read_file",Some(&root),json!({"path":path})).await?;
            ensure!(read["text"].as_str().is_some_and(|text|text.contains("1: 第一行\r\n") && text.contains("before")),"UTF-8/CRLF read failed");
            let edited=rpc(&target,"apply_patch",Some(&root),json!({"path":path,"old_text":"before","new_text":"after"})).await?;
            let after=original.replace("before","after");
            ensure!(edited["fileChanges"][0]["before"]==original && edited["fileChanges"][0]["after"]==after,"patch receipt mismatch");
            expected_error(&target,"write_file",&root,json!({"path":path,"content":"do not overwrite","expected_content":original}),RemoteErrorKind::Conflict).await?;
            let found=rpc(&target,"search_files",Some(&root),json!({"pattern":"after"})).await?;
            ensure!(found["matches"].as_array().is_some_and(|matches|matches.iter().any(|item|item["path"]==path)),"literal search failed");
            let listing=rpc(&target,"list_files",Some(&root),json!({"recursive":true})).await?;
            ensure!(listing["entries"].as_array().is_some_and(|entries|entries.iter().any(|item|item["path"]==path)),"recursive listing failed");
            proof["checks"]["utf8SpacesCrLfReadWritePatchSearchList"]=json!(true);
            expected_error(&target,"read_file",&root,json!({"path":"../outside"}),RemoteErrorKind::Permission).await?;
            expected_error(&target,"read_file",&root,json!({"path":"/etc/passwd"}),RemoteErrorKind::Permission).await?;
            command(&target,&root,"ln -s /tmp escape; mkfifo bounded-fifo".into()).await?;
            expected_error(&target,"read_file",&root,json!({"path":"escape/never-read"}),RemoteErrorKind::Permission).await?;
            expected_error(&target,"write_file",&root,json!({"path":"escape/never-created","content":"no","expected_content":null}),RemoteErrorKind::Permission).await?;
            expected_error(&target,"read_file",&root,json!({"path":"bounded-fifo"}),RemoteErrorKind::InvalidInput).await?;
            proof["checks"]["traversalSymlinkAndFifoRejected"]=json!(true);
            // A canonical project root that is later replaced by a symlink
            // must not silently redirect an already approved file operation.
            command(&target,&root,python("from pathlib import Path;p=Path('selected-root');p.mkdir();(p/'kept.txt').write_text('preserved');p.rename('moved-root');p.symlink_to('moved-root',target_is_directory=True)")).await?;
            expected_error(&target,"write_file",&format!("{root}/selected-root"),json!({"path":"kept.txt","content":"must-not-write","expected_content":"preserved"}),RemoteErrorKind::Conflict).await?;
            let preserved=rpc(&target,"read_file",Some(&format!("{root}/moved-root")),json!({"path":"kept.txt"})).await?;
            ensure!(preserved["text"].as_str().is_some_and(|s|s.contains("preserved")),"retargeted root changed the real file");
            proof["checks"]["canonicalRootSymlinkRetargetRejectedBeforeWrite"]=json!(true);
            let (_left_owner,left_cancel)=watch::channel(false);let (_right_owner,right_cancel)=watch::channel(false);
            let (left,right)=tokio::join!(remote_transport::call(&target,"write_file",Some(&root),json!({"path":path,"content":"LEFT","expected_content":after}),left_cancel),remote_transport::call(&target,"write_file",Some(&root),json!({"path":path,"content":"RIGHT","expected_content":after}),right_cancel));
            ensure!(usize::from(left.is_ok())+usize::from(right.is_ok())==1,"concurrent stale save overwrote a winner");
            ensure!(left.as_ref().err().or(right.as_ref().err()).is_some_and(|error|error.kind==RemoteErrorKind::Conflict),"missing conflict receipt");
            proof["checks"]["concurrentCompareAndSwapOneWinner"]=json!(true);
            let cwd=rpc(&target,"run_command",Some(&root),json!({"command":"pwd","workdir":"directory with spaces","timeout_seconds":5})).await?;
            ensure!(cwd["text"].as_str().is_some_and(|text|text.trim()==format!("{root}/directory with spaces")),"remote command cwd mismatch");
            let large=command(&target,&root,python("print('x'*200000)")).await?;
            ensure!(large["truncated"]==true && large["text"].as_str().is_some_and(|text|text.len()==128*1024),"command output not bounded");
            proof["checks"]["commandWorkingDirectoryAndBoundedOutput"]=json!(true);
            expected_error(&target,"run_command",&root,json!({"command":"sleep 20","timeout_seconds":1}),RemoteErrorKind::Timeout).await?;
            proof["checks"]["commandTimeoutAcknowledged"]=json!(true);
            let (cancel_owner,cancel)=watch::channel(false);let running_target=target.clone();let running_root=root.clone();
            let pending=tokio::spawn(async move {remote_transport::call(&running_target,"run_command",Some(&running_root),json!({"command":python("import os,time;open('cancel.pid','w').write(str(os.getpid()));time.sleep(30)"),"timeout_seconds":45}),cancel).await});
            let pid=read_pid(&target,&root,"cancel.pid").await?;
            cancel_owner.send(true)?;
            let cancelled=tokio::time::timeout(Duration::from_secs(12),pending).await??.err().context("cancellation receipt missing")?;
            ensure!(cancelled.kind==RemoteErrorKind::Cancelled,"command cancellation was not acknowledged");
            ensure!(pid_stopped(&target,&root,pid).await?,"owned command process survived cancellation");
            proof["checks"]["cancelledCommandProcessStopped"]=json!(true);
            let (already_stopped,cancel)=watch::channel(true);
            let stopped=remote_transport::call(&target,"run_command",Some(&root),json!({"command":"echo should-not-exist > forbidden.txt"}),cancel).await.err().context("pre-cancelled request executed")?;
            drop(already_stopped);
            ensure!(stopped.kind==RemoteErrorKind::Cancelled,"pre-cancellation category mismatch");
            expected_error(&target,"read_file",&root,json!({"path":"forbidden.txt"}),RemoteErrorKind::NotFound).await?;
            proof["checks"]["preCancelledRequestHadNoSideEffect"]=json!(true);
            let (_lost_owner,lost_cancel)=watch::channel(false);
            let lost_target=target.clone();let lost_root=root.clone();
            let lost=tokio::spawn(async move {remote_transport::call(&lost_target,"run_command",Some(&lost_root),json!({"command":python("import os,time;open('disconnect.pid','w').write(str(os.getpid()));time.sleep(30)"),"timeout_seconds":45}),lost_cancel).await});
            let lost_pid=read_pid(&target,&root,"disconnect.pid").await?;
            lost.abort();let _=lost.await;
            let disconnect_deadline=tokio::time::Instant::now()+Duration::from_secs(15);
            loop {
                if pid_stopped(&target,&root,lost_pid).await? {break;}
                ensure!(tokio::time::Instant::now()<disconnect_deadline,"owned process survived disconnected transport");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            proof["checks"]["disconnectedTransportStoppedOwnedProcess"]=json!(true);
            let mut pixel=Vec::new();
            {let mut encoder=png::Encoder::new(&mut pixel,1,1);encoder.set_color(png::ColorType::Rgba);encoder.set_depth(png::BitDepth::Eight);let mut writer=encoder.write_header()?;writer.write_image_data(&[225,110,145,255])?;writer.finish()?;}
            use base64::Engine as _;
            let image=base64::engine::general_purpose::STANDARD.encode(pixel);
            command(&target,&root,python(&format!("import base64;open('sample.png','wb').write(base64.b64decode({image:?}))"))).await?;
            let viewed=rpc(&target,"view_image",Some(&root),json!({"path":"sample.png"})).await?;
            ensure!(viewed["imageBase64"]==image,"remote image bytes changed in transport");
            proof["checks"]["actualPngBytesRoundTripped"]=json!(true);
            Ok(())
        }.await;
        // Always verify the nonce before cleanup, even when a preceding test
        // failed. No generic target, home directory or user project is removed.
        let cleanup=command(&target,"/tmp",python(&format!("from pathlib import Path;import shutil,os;p=Path({root:?});assert p.parent==Path('/tmp') and not p.is_symlink();assert (p/'.lolicode-owned-fixture').read_text()=={nonce:?};assert p.stat().st_uid==os.getuid();shutil.rmtree(p);print('OWNED_FIXTURE_REMOVED')"))).await;
        proof["cleanupConfirmed"] = json!(cleanup.as_ref().ok().is_some_and(|reply| reply["text"]
            .as_str()
            .is_some_and(|text| text.contains("OWNED_FIXTURE_REMOVED"))));
        if let Err(error) = &result {
            proof["failure"] = json!(error.to_string());
        }
        proof["passed"] = json!(result.is_ok() && proof["cleanupConfirmed"] == true);
        if let Some(parent) = output.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&output, serde_json::to_vec_pretty(&proof)?).await?;
        println!(
            "Remote transport acceptance: passed={}, cleanup={}; proof={}",
            proof["passed"],
            proof["cleanupConfirmed"],
            output.display()
        );
        ensure!(
            proof["passed"] == true,
            "remote transport acceptance failed; inspect isolated proof"
        );
        Ok(())
    }
}

#[cfg(feature = "test-hooks")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    acceptance::run().await
}
