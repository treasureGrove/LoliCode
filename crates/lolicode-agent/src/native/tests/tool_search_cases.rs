use super::*;

fn catalog_result(input: &Value) -> Value {
    let message = input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap();
    serde_json::from_str(message["content"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn tool_search_finds_real_tools_then_glob_and_grep_run_in_plan_mode() {
    let fake = Fake::start(|input| match last_tool(input) {
        None => tool("tool_search", json!({"query":"glob","limit":1})),
        Some("call-tool_search") => {
            let found = catalog_result(input);
            assert_eq!(found["tools"][0]["name"], "glob");
            assert!(found["totalMatches"].as_u64().unwrap() >= 1);
            tool("glob", json!({"pattern":"**/*.rs"}))
        }
        Some("call-glob") => {
            let receipt = input["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap();
            assert!(receipt.contains("src/main.rs"));
            assert!(!receipt.contains("ignored.rs"));
            tool("grep", json!({"pattern":"fn\\s+main", "include":"**/*.rs"}))
        }
        Some("call-grep") => {
            let receipt = input["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap();
            assert!(receipt.contains("src/main.rs:1:"));
            text("SEARCH_TOOLS_EXECUTED")
        }
        other => panic!("unexpected search flow: {other:?}"),
    })
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    std::fs::create_dir(project.path().join("src")).unwrap();
    std::fs::create_dir(project.path().join("node_modules")).unwrap();
    std::fs::write(project.path().join("src/main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(
        project.path().join("node_modules/ignored.rs"),
        "fn ignored() {}\n",
    )
    .unwrap();
    engine
        .call(
            "updateSession",
            json!({"sessionId":id,"mode":"plan","permissionMode":"ask"}),
        )
        .await
        .unwrap();
    send(&engine, &id, "search-chain", "Inspect Rust entry points").await;
    let result = wait(&engine, &id, |s| s["status"] == "idle").await;
    assert!(result.to_string().contains("SEARCH_TOOLS_EXECUTED"));
    assert!(result["permissions"].as_array().unwrap().is_empty());
    assert!(result["diffs"].as_array().unwrap().is_empty());
    assert_eq!(fake.count(), 4);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn tool_search_rechecks_application_revocation_after_the_model_request() {
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() {
            assert!(input["tools"].to_string().contains("tavern_fixture"));
            let mut reply = tool("tool_search", json!({"query":"tavern_fixture"}));
            reply.pause = true;
            reply
        } else {
            assert_eq!(catalog_result(input)["totalMatches"], 0);
            text("REVOKED_TOOL_NOT_DISCOVERED")
        }
    })
    .await;
    let (_data, _project, engine, id) = setup(&fake).await;
    let host = Arc::new(HostedFixture {
        enabled: true.into(),
        executions: 0.into(),
    });
    engine.set_application_tools(host.clone()).await;
    send(&engine, &id, "catalog-revoke", "Find an application tool").await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while fake.count() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    host.enabled
        .store(false, std::sync::atomic::Ordering::SeqCst);
    fake.resume.notify_one();
    let result = wait(&engine, &id, |s| s["status"] == "idle").await;
    assert!(result.to_string().contains("REVOKED_TOOL_NOT_DISCOVERED"));
    assert_eq!(host.executions.load(std::sync::atomic::Ordering::SeqCst), 0);
    engine.shutdown().await.unwrap();
}

struct CatalogOnlyRemote;
impl applications::ApplicationTools for CatalogOnlyRemote {
    fn schemas(&self) -> Vec<Value> {
        vec![
            json!({"type":"function","function":{"name":"local_domain_only","description":"Local app"}}),
        ]
    }
    fn project_schemas(&self, _: &std::path::Path) -> Option<Vec<Value>> {
        Some(
            applications::core_tool_schemas()
                .into_iter()
                .filter(|s| s["function"]["name"] == "read_file")
                .collect(),
        )
    }
    fn inspect(
        &self,
        _: &std::path::Path,
        _: &str,
        _: &Value,
    ) -> Option<Result<applications::ToolInspection, String>> {
        None
    }
    fn execute<'a>(
        &'a self,
        _: &'a std::path::Path,
        _: &'a str,
        _: &'a Value,
        _: tokio::sync::watch::Receiver<bool>,
    ) -> applications::ApplicationResult<'a> {
        Box::pin(async { panic!("catalog lookup must not execute a domain tool") })
    }
}

#[tokio::test]
async fn tool_search_respects_remote_replacement_and_background_scope() {
    for (background, query) in [
        (false, "glob"),
        (false, "local_domain_only"),
        (true, "run_command"),
        (true, "tavern_fixture"),
    ] {
        let search = query.to_string();
        let fake = Fake::start(move |input| {
            if last_tool(input).is_none() {
                tool("tool_search", json!({"query":search}))
            } else {
                assert_eq!(catalog_result(input)["totalMatches"], 0);
                text("CATALOG_SCOPE_PRESERVED")
            }
        })
        .await;
        let (_data, _project, engine, original_id) = setup(&fake).await;
        let id = if background {
            engine
                .set_application_tools(Arc::new(HostedFixture {
                    enabled: true.into(),
                    executions: 0.into(),
                }))
                .await;
            engine
                .call(
                    "createSession",
                    json!({"backgroundOnly":true,"permissionMode":"ask"}),
                )
                .await
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_string()
        } else {
            engine
                .set_application_tools(Arc::new(CatalogOnlyRemote))
                .await;
            original_id
        };
        send(&engine, &id, "catalog-scope", "Find only available tools").await;
        let result = wait(&engine, &id, |s| s["status"] == "idle").await;
        assert!(result.to_string().contains("CATALOG_SCOPE_PRESERVED"));
        engine.shutdown().await.unwrap();
    }
}
