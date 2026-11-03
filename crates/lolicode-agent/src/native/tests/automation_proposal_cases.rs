use super::*;

fn last_receipt(input: &Value) -> &str {
    input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap()
}

fn proposal_part(snapshot: &Value) -> &Value {
    snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["parts"].as_array().unwrap())
        .find(|part| part["type"] == "tool" && part["name"] == "propose_automation")
        .unwrap()
}

#[tokio::test]
async fn conversation_collects_a_missing_time_then_returns_a_real_proposal_tool_result_in_plan_mode(
) {
    let fake = Fake::start(|input| {
        assert!(input["tools"].as_array().unwrap().iter().any(|schema| schema["function"]["name"] == "propose_automation"));
        let system = input["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("Never invent missing times"));
        assert!(system.contains("never say it has been created"));
        assert!(system.contains("Do not use shell commands"));
        match last_tool(input) {
            None => tool("ask_user", json!({"questions":[{"question":"每天几点检查测试？","options":[{"label":"每天 09:30"},{"label":"每天 18:00"}]}]})),
            Some("call-ask_user") => {
                assert!(last_receipt(input).contains("每天 09:30"));
                tool("propose_automation", json!({"title":"每日测试检查","prompt":"运行当前项目的测试并报告失败项。","trigger":"schedule","cronExpr":"30 9 * * *"}))
            }
            Some("call-propose_automation") => {
                let result: Value = serde_json::from_str(last_receipt(input)).unwrap();
                assert_eq!(result["type"], "automation_proposal");
                assert_eq!(result["version"], 1);
                assert_eq!(result["input"]["cronExpr"], "30 9 * * *");
                assert!(result["input"].get("workspacePath").is_none());
                assert!(result["input"].get("modelSelection").is_none());
                assert!(result["input"].get("mode").is_none());
                text("请检查这张自动化配置卡，点击保存后才会生效。")
            }
            unexpected => panic!("unexpected tool: {unexpected:?}"),
        }
    }).await;
    let (data, project, engine, id) = setup(&fake).await;
    engine
        .call(
            "updateSession",
            json!({"sessionId":id,"mode":"plan","permissionMode":"ask"}),
        )
        .await
        .unwrap();
    send(
        &engine,
        &id,
        "automation-conversation",
        "帮我每天自动检查项目测试。",
    )
    .await;
    let pending = wait(&engine, &id, |snapshot| {
        snapshot["status"] == "waiting_question"
    })
    .await;
    assert_eq!(
        fake.count(),
        1,
        "no proposal before the user supplies a time"
    );
    assert!(!pending.to_string().contains("automation_proposal"));
    engine.call("replyQuestion", json!({"sessionId":id,"requestId":pending["questions"][0]["id"],"answer":{"answer_0":"每天 09:30"}})).await.unwrap();
    let done = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert_eq!(
        done["session"]["mode"], "plan",
        "a proposal never grants implementation permissions"
    );
    let part = proposal_part(&done);
    assert_eq!(part["state"], "completed");
    let result: Value = serde_json::from_str(part["output"].as_str().unwrap()).unwrap();
    assert_eq!(result["input"]["title"], "每日测试检查");
    assert_eq!(done["diffs"], json!([]));
    assert_eq!(
        std::fs::read_dir(project.path()).unwrap().count(),
        0,
        "no cron/script/file or external store may be created"
    );
    let names = done["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["parts"].as_array().unwrap())
        .filter(|part| part["type"] == "tool")
        .map(|part| part["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, ["ask_user", "propose_automation"]);
    assert_eq!(fake.count(), 3);
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    assert_eq!(
        proposal_part(&snapshot(&reopened, &id).await)["output"],
        part["output"],
        "the review card survives reload without pretending to be saved"
    );
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn idle_edit_proposals_are_available_in_background_scope_without_running_host_tools() {
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() {
            assert!(input["tools"].as_array().unwrap().iter().any(|schema| schema["function"]["name"] == "propose_automation"));
            assert!(!input["tools"].as_array().unwrap().iter().any(|schema| schema["function"]["name"] == "run_command"));
            tool("propose_automation", json!({"title":"闲置整理","prompt":"检查当前项目待办并总结。","trigger":"idle","idleAfterMinutes":15,"idleIntervalMinutes":120,"mode":"guarded","automationId":"existing-task-id"}))
        } else {
            let result: Value = serde_json::from_str(last_receipt(input)).unwrap();
            assert_eq!(result["automationId"], "existing-task-id");
            assert_eq!(result["input"]["trigger"], "idle");
            assert_eq!(result["input"]["idleAfterMinutes"], 15);
            assert_eq!(result["input"]["idleIntervalMinutes"], 120);
            assert_eq!(result["input"]["mode"], "guarded");
            assert!(result["input"].get("cronExpr").is_none());
            text("这是更新建议，请在配置卡确认保存。")
        }
    }).await;
    let (_data, project, engine, id) = setup(&fake).await;
    engine.call("sendMessage", json!({"sessionId":id,"requestId":"idle-automation-draft","text":"把这个任务改成空闲15分钟后运行，每两小时最多一次，只读审查。","backgroundOnly":true})).await.unwrap();
    let done = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert_eq!(proposal_part(&done)["state"], "completed");
    assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 0);
    assert_eq!(fake.count(), 2);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_incomplete_proposal_reports_a_tool_error_without_inventing_a_schedule_or_creating_files(
) {
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() {
            tool(
                "propose_automation",
                json!({"title":"检查测试","prompt":"检查测试结果。","trigger":"schedule"}),
            )
        } else {
            assert!(last_receipt(input).contains("ask_user"));
            assert!(last_receipt(input).contains("cronExpr"));
            text("请先告诉我运行时间。")
        }
    })
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    send(
        &engine,
        &id,
        "missing-automation-time",
        "帮我自动检查测试。",
    )
    .await;
    let done = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    let part = proposal_part(&done);
    assert_eq!(part["state"], "error");
    assert!(serde_json::from_str::<Value>(part["output"].as_str().unwrap_or("")).is_err(), "an error must not be a renderable proposal card");
    assert!(part["error"].as_str().unwrap().contains("ask_user"));
    assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 0);
    engine.shutdown().await.unwrap();
}
