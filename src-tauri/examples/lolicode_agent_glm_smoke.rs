//! Explicit, bounded live smoke through the production channel gateway.
//! Requires an explicitly supplied, authorized private key file.
//! cargo run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_agent_glm_smoke -j 2 -- --key-file <absolute-private-key-file> --out <absolute-temp-json>
//! Never prints or exports upstream/local credentials or engine configuration.

#[cfg(not(feature = "test-hooks"))]
fn main() {
    eprintln!("This owned integration example requires --features test-hooks");
    std::process::exit(2);
}

#[cfg(feature = "test-hooks")]
mod live {
    use anyhow::{anyhow, bail, ensure, Context, Result};
    use lolicode_lib::{
        agent_test_support::{
            channel_center::{
                self, AgentCatalog, ChannelCenterSnapshot, ChannelModel, ChannelSource,
            },
            AgentWorkspace, CodexOAuthManager, UsageCache,
        },
        AppState, Database, ProxyService,
    };
    use lolicode_agent::{
        AgentModelRef, AgentPart, AgentSnapshot, AgentStatus, Engine, EngineOptions,
    };
    use serde_json::{json, Value};
    use std::{
        path::{Path, PathBuf},
        sync::Arc,
        time::Duration,
    };
    use tokio::{process::Command, time::Instant};

    const MODEL: &str = "glm-5.3-flash";
    const ROUTE: &str = "glm_live/glm-5.3-flash";
    const BEFORE: &str = "export function add(a, b) { return a - b; }\n";
    const PROMPT: &str = "Fix sum.js: add(2,3) currently returns -1 and must return 5. Read sum.js and make the smallest correction. Only edit this file. Do not run shell commands, access network tools, or read outside this project. Then briefly describe the correction.";

    fn path_key(value: &str) -> String {
        value
            .trim_start_matches(r"\\?\")
            .replace('\\', "/")
            .to_ascii_lowercase()
    }

    fn owned_resource(resource: &str, project: &Path) -> bool {
        let key = path_key(resource);
        if key.is_empty() || key.split('/').any(|component| component == "..") {
            return false;
        }
        let root = path_key(&project.to_string_lossy());
        let absolute = key.starts_with('/') || key.as_bytes().get(1) == Some(&b':');
        if absolute {
            key == root || key.starts_with(&format!("{root}/"))
        } else {
            // Relative paths/patterns are interpreted by the already-bound
            // native session location; external_directory remains hard denied.
            !key.contains(':')
        }
    }

    fn isolated_command(program: &str, project: &Path) -> Command {
        let mut command = Command::new(program);
        command.env_clear().current_dir(project);
        for (key, value) in std::env::vars_os() {
            if matches!(
                key.to_string_lossy().to_ascii_uppercase().as_str(),
                "PATH"
                    | "PATHEXT"
                    | "SYSTEMROOT"
                    | "WINDIR"
                    | "COMSPEC"
                    | "SYSTEMDRIVE"
                    | "PROGRAMFILES"
                    | "PROGRAMFILES(X86)"
                    | "PROGRAMW6432"
            ) {
                command.env(key, value);
            }
        }
        command
    }

    async fn fixture(project: &Path) -> Result<()> {
        tokio::fs::create_dir_all(project.join(".smoke-hooks")).await?;
        tokio::fs::write(project.join("sum.js"), BEFORE).await?;
        tokio::fs::write(project.join("package.json"), "{\"type\":\"module\"}\n").await?;
        tokio::fs::write(project.join("test.mjs"), "import assert from 'node:assert/strict';\nimport { add } from './sum.js';\nassert.equal(add(2,3),5);\nassert.equal(add(-2,3),1);\nconsole.log('JS fixture passed');\n").await?;
        for arguments in [
            vec!["init", "--quiet"],
            vec!["add", "sum.js", "package.json", "test.mjs"],
            vec![
                "-c",
                "user.name=Lolicode Smoke",
                "-c",
                "user.email=smoke@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "Owned live smoke baseline",
            ],
        ] {
            let output = isolated_command("git", project)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", project.join(".smoke-global-config"))
                .arg("-c")
                .arg(format!(
                    "core.hooksPath={}",
                    project.join(".smoke-hooks").to_string_lossy()
                ))
                .args(["-c", "init.templateDir="])
                .args(arguments)
                .output()
                .await?;
            ensure!(
                output.status.success(),
                "cannot initialize owned live Git fixture"
            );
        }
        Ok(())
    }

    fn configure_owned_permissions(config: &mut Value, project: &Path) {
        let project_path = project.to_string_lossy().replace('\\', "/");
        config["permissions"] = json!([
            {"action":"*","resource":"*","effect":"ask"},
            {"action":"read","resource":format!("{project_path}/**"),"effect":"allow"},
            {"action":"glob","resource":format!("{project_path}/**"),"effect":"allow"},
            {"action":"grep","resource":format!("{project_path}/**"),"effect":"allow"},
            {"action":"list","resource":format!("{project_path}/**"),"effect":"allow"},
            {"action":"edit","resource":format!("{project_path}/sum.js"),"effect":"allow"},
            {"action":"shell","resource":"*","effect":"deny"},
            {"action":"external_directory","resource":"*","effect":"deny"},
            {"action":"subagent","resource":"*","effect":"deny"},
            {"action":"webfetch","resource":"*","effect":"deny"},
            {"action":"websearch","resource":"*","effect":"deny"}
        ]);
        // Explicit test budget, not a claim about the provider's full capacity.
        config["providers"]["lolicode"]["body"] =
            json!({"reasoning_effort":"low","max_tokens":1024});
        config["providers"]["lolicode"]["models"][ROUTE]["body"] =
            json!({"reasoning_effort":"low","max_tokens":1024});
    }

    fn redact(value: &mut Value, secrets: &[&str]) {
        match value {
            Value::String(text) => {
                for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
                    *text = text.replace(*secret, "[hidden]");
                }
            }
            Value::Array(array) => {
                for value in array {
                    redact(value, secrets);
                }
            }
            Value::Object(object) => {
                for value in object.values_mut() {
                    redact(value, secrets);
                }
            }
            _ => {}
        }
    }

    async fn wait_for_result(
        engine: &Engine,
        session: &str,
        project: &Path,
    ) -> Result<AgentSnapshot> {
        let deadline = Instant::now() + Duration::from_secs(70);
        let sum_path = format!("{}/sum.js", path_key(&project.to_string_lossy()));
        loop {
            if Instant::now() >= deadline {
                let _ = engine.interrupt(session).await;
                bail!("live turn reached the 70-second bound");
            }
            let snapshot = engine
                .snapshot(session)
                .await
                .map_err(|error| anyhow!(error))?;
            let calls = snapshot
                .messages
                .iter()
                .flat_map(|message| &message.parts)
                .filter(|part| matches!(part, AgentPart::Tool { .. }))
                .count();
            if calls > 5 {
                let _ = engine.interrupt(session).await;
                bail!("live turn reached the five-tool budget");
            }
            for permission in &snapshot.permissions {
                let safe = !permission.resources.is_empty()
                    && permission.resources.iter().all(|resource| {
                        if permission.action == "edit" {
                            let key = path_key(resource);
                            key == sum_path || key == "sum.js"
                        } else {
                            matches!(
                                permission.action.as_str(),
                                "read" | "list" | "glob" | "grep"
                            ) && owned_resource(resource, project)
                        }
                    });
                println!(
                    "Bounded permission: action={}, owned_scope={safe}",
                    permission.action
                );
                engine
                    .reply_permission(
                        session,
                        &permission.id,
                        if safe { "once" } else { "reject" },
                    )
                    .await
                    .map_err(|error| anyhow!(error))?;
                // A rejected request is returned to the real model for recovery;
                // the hard turn/tool budgets still bound the entire exercise.
            }
            ensure!(
                snapshot.questions.is_empty(),
                "live agent requested unexpected interactive input"
            );
            if snapshot.status == AgentStatus::Error {
                bail!(
                    "live engine returned an execution error: {}",
                    snapshot
                        .error
                        .unwrap_or_else(|| "see normalized tool result".into())
                );
            }
            if snapshot.status == AgentStatus::Idle
                && snapshot
                    .messages
                    .iter()
                    .any(|message| message.role == "assistant" && message.completed_at.is_some())
            {
                return Ok(snapshot);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn execute(engine: &Engine, project: &Path) -> Result<(AgentSnapshot, Value)> {
        let model = AgentModelRef {
            provider_id: "lolicode".into(),
            model_id: ROUTE.into(),
        };
        let session = engine
            .create_session(project, &model, "build", Some("真实 GLM 临时项目测试记录"))
            .await
            .map_err(|error| anyhow!(error))?;
        engine
            .send_message(&session.id, PROMPT, "authorized_glm_fixture")
            .await
            .map_err(|error| anyhow!(error))?;
        let mut snapshot = wait_for_result(engine, &session.id, project).await?;
        let diff_deadline = Instant::now() + Duration::from_secs(4);
        while snapshot.diffs.is_empty() && Instant::now() < diff_deadline {
            tokio::time::sleep(Duration::from_millis(200)).await;
            snapshot = engine
                .snapshot(&session.id)
                .await
                .map_err(|error| anyhow!(error))?;
        }
        ensure!(snapshot.error.is_none(), "live result contains an error");
        ensure!(snapshot.stream_connected, "live SSE did not stay connected");
        ensure!(snapshot.messages.iter().flat_map(|message| &message.parts).any(|part| {
            matches!(part, AgentPart::Tool { name, state, .. } if matches!(name.as_str(), "write"|"patch"|"edit") && state == "completed")
        }), "live model did not complete an actual file edit tool");
        let after = tokio::fs::read_to_string(project.join("sum.js")).await?;
        ensure!(after != BEFORE, "live model did not modify the JS fixture");
        ensure!(
            snapshot
                .diffs
                .iter()
                .any(|diff| diff.path.ends_with("sum.js") && diff.additions > 0),
            "live engine did not report the actual JS diff"
        );
        let checked = tokio::time::timeout(
            Duration::from_secs(5),
            isolated_command("node", project).arg("test.mjs").output(),
        )
        .await??;
        ensure!(
            checked.status.success(),
            "actual modified JS failed the owned fixture tests"
        );
        let sessions = engine
            .list_sessions(project)
            .await
            .map_err(|error| anyhow!(error))?;
        Ok((
            snapshot,
            json!({"sessions":sessions,"fixture":{"file":"sum.js","before":BEFORE,"after":after},
            "validation":{"add_2_3":5,"add_minus2_3":1,"nodeFixturePassed":true}}),
        ))
    }

    async fn live_run(
        state: &AppState,
        project: &Path,
        private_root: PathBuf,
    ) -> Result<(AgentCatalog, AgentSnapshot, Value)> {
        let prepared = channel_center::prepare_agent_catalog(state).await?;
        let mut config = prepared.config;
        configure_owned_permissions(&mut config, project);
        let executable =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent/opencode.exe");
        let engine = Engine::launch(EngineOptions {
            executable,
            private_root,
            config,
        })
        .await
        .map_err(|error| anyhow!(error))?;
        let result = tokio::time::timeout(Duration::from_secs(90), execute(&engine, project)).await;
        let stopped = engine.shutdown().await.map_err(|error| anyhow!(error));
        ensure!(!engine.is_running(), "owned live engine did not stop");
        stopped?;
        let (snapshot, extra) = result.context("authorized live run timed out")??;
        Ok((prepared.catalog, snapshot, extra))
    }

    fn options() -> Result<(PathBuf, Option<PathBuf>)> {
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        ensure!(
            args.len() == 2 || args.len() == 4,
            "usage: --key-file <absolute-private-key-file> [--out <absolute-temp-json>]"
        );
        let mut key = None;
        let mut out = None;
        for pair in args.chunks_exact(2) {
            if pair[0] == "--key-file" && key.is_none() {
                key = Some(PathBuf::from(&pair[1]));
            } else if pair[0] == "--out" && out.is_none() {
                out = Some(PathBuf::from(&pair[1]));
            } else {
                bail!("unknown or repeated smoke option");
            }
        }
        let key = key.ok_or_else(|| anyhow!("an explicit --key-file is required"))?;
        ensure!(
            key.is_absolute() && key.is_file(),
            "key file must be an existing absolute path"
        );
        let Some(path) = out else {
            return Ok((key, None));
        };
        ensure!(path.is_absolute(), "evidence path must be absolute");
        let temp = std::fs::canonicalize(std::env::temp_dir())?;
        let parent = std::fs::canonicalize(
            path.parent()
                .ok_or_else(|| anyhow!("evidence path has no parent"))?,
        )?;
        ensure!(
            parent.starts_with(temp),
            "evidence may only be written inside Temp"
        );
        ensure!(
            parent.join(
                path.file_name()
                    .ok_or_else(|| anyhow!("evidence path has no filename"))?
            ) != std::fs::canonicalize(&key)?,
            "evidence cannot overwrite the private key file"
        );
        Ok((key, Some(path)))
    }

    pub async fn run() -> Result<()> {
        let (key_file, out) = options()?;
        // The human-authorized temporary credential is read only inside Rust.
        let key = tokio::fs::read_to_string(key_file)
            .await
            .context("authorized private credential file unavailable")?;
        let key = key.trim().to_owned();
        ensure!(!key.is_empty(), "authorized credential file is empty");
        let temporary = tempfile::tempdir()?;
        let project = temporary.path().join("glm-project");
        fixture(&project).await?;
        let db = Arc::new(Database::memory()?);
        let state = AppState {
            db: db.clone(),
            proxy_service: ProxyService::new(db.clone()),
            usage_cache: Arc::new(UsageCache::new()),
            codex_oauth_manager: Arc::new(CodexOAuthManager::new(temporary.path().join("oauth"))),
        };
        let mut global = db.get_global_proxy_config().await?;
        global.listen_address = "127.0.0.1".into();
        global.listen_port = 0;
        db.update_global_proxy_config(global).await?;
        for app in ["codex", "claude"] {
            let mut limits = db.get_proxy_config_for_app(app).await?;
            limits.max_retries = 0;
            limits.streaming_first_byte_timeout = 30;
            limits.streaming_idle_timeout = 20;
            limits.non_streaming_timeout = 45;
            db.update_proxy_config_for_app(limits).await?;
        }
        channel_center::save(
            &db,
            ChannelCenterSnapshot {
                channels: vec![ChannelSource {
                    id: "glm_live".into(),
                    name: "GLM Coding Plan · 临时验证".into(),
                    base_url: "https://open.bigmodel.cn/api/coding/paas/v4".into(),
                    api_key: key.clone(),
                    auth_kind: "api_key".into(),
                    account_id: None,
                    protocol: "openai_chat".into(),
                    enabled: true,
                    models: vec![ChannelModel {
                        id: MODEL.into(),
                        name: Some(MODEL.into()),
                        context_limit: None,
                        output_limit: Some(1024),
                        supports_tools: Some(true),
                        input_modalities: None,
                        protocol: None,
                        enabled: Some(true),
                    }],
                }],
                targets: vec![],
                default_model: Some(ROUTE.into()),
                revision: 0,
            },
        )?;
        let result = live_run(&state, &project, temporary.path().join("private-engine")).await;
        let stopped = state
            .proxy_service
            .stop()
            .await
            .map_err(|error| anyhow!(error));
        stopped?;
        let (catalog, snapshot, extra) = result?;
        let workspace = AgentWorkspace {
            standalone: false,
            path: project.to_string_lossy().into_owned(),
            name: "真实 GLM 临时项目测试记录".into(),
        };
        let mut evidence = json!({"provenance":{"model":MODEL,"testedAt":chrono::Utc::now().to_rfc3339(),"description":"真实 GLM 临时项目测试记录 · 界面回放"},"evidence":{"kind":"real_glm_temp_project","model":MODEL,"engineVersion":lolicode_agent::ENGINE_VERSION,
            "productionChannelGateway":true,"fixtureCleanedAfterRun":true,"turnTimeoutSeconds":70,"maxToolCalls":5},
            "catalog":catalog,"workspace":workspace,"snapshot":snapshot});
        evidence
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let local_key = channel_center::gateway_token(&db)?;
        redact(&mut evidence, &[&key, &local_key]);
        let serialized = serde_json::to_string_pretty(&evidence)?;
        ensure!(
            !serialized.contains(&key) && !serialized.contains(&local_key),
            "evidence retained a credential"
        );
        if let Some(path) = out {
            tokio::fs::write(&path, serialized).await?;
            println!("Sanitized evidence: {}", path.display());
        }
        println!("PASS: real GLM -> production channel gateway -> owned engine -> actual JS edit -> Node tests -> normalized diff; owned engine/gateway stopped");
        Ok(())
    }
}

#[cfg(feature = "test-hooks")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    live::run().await
}
