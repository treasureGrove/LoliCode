//! Explicit local-model installation and real chat acceptance. Conversation data
//! uses an empty in-memory database; only the requested model installation persists.
use lolicode_lib::{agent_test_support::tavern_test as tavern, AppState, Database};
use serde_json::json;
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

struct Cleanup;
impl Drop for Cleanup {
    fn drop(&mut self) {
        tavern::local_model::manager().shutdown();
    }
}

fn seed(source: &Path, destination: &Path) -> Result<(), String> {
    if !destination.exists() {
        // create_new refuses to overwrite any existing installation file.
        let mut input = std::fs::File::open(source).map_err(|e| e.to_string())?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("Use <verified-model-file> <runtime-archive-directory> <proof-json>".into());
    }
    let manager = tavern::local_model::manager();
    let _cleanup = Cleanup;
    println!(
        "Installing requested local companion in {}",
        manager.root().display()
    );
    std::fs::create_dir_all(manager.root().join("downloads")).map_err(|e| e.to_string())?;
    seed(
        Path::new(&args[0]),
        &manager.root().join("sbg-v2-9b.imat-Q4_K_M.gguf"),
    )?;
    for file in [
        "llama-b11729-bin-win-cuda-13.4-x64.zip",
        "cudart-llama-bin-win-cuda-13.4-x64.zip",
    ] {
        seed(
            &Path::new(&args[1]).join(file),
            &manager.root().join("downloads").join(file),
        )?;
    }
    let start = Instant::now();
    manager.begin_install()?;
    let mut previous = String::new();
    loop {
        let status = manager.status();
        if status.stage != previous {
            println!("{} ({:.1}s)", status.stage, start.elapsed().as_secs_f64());
            previous = status.stage.clone();
        }
        match status.stage.as_str() {
            "running" => break,
            "error" | "paused" => return Err(status.error.unwrap_or(status.stage)),
            _ => {}
        }
        if start.elapsed() > Duration::from_secs(600) {
            return Err("Installation timed out".into());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let state = AppState::new(Arc::new(Database::memory().map_err(|e| e.to_string())?));
    let catalog = tavern::catalog(&state).await?;
    assert_eq!(catalog.models.len(), 1);
    assert_eq!(
        catalog.default_model.as_deref(),
        Some(tavern::local_model::MODEL_ID)
    );
    assert_eq!(catalog.models[0].context_limit, Some(16384));
    let card_file = tempfile::Builder::new()
        .suffix(".json")
        .tempfile()
        .map_err(|e| e.to_string())?;
    std::fs::write(card_file.path(), serde_json::to_vec(&json!({
        "spec":"chara_card_v2", "spec_version":"2.0", "data":{
            "name":"沈晚晴", "description":"沈晚晴，26岁的银杏书屋店主。与用户是彼此尊重的成年恋人。",
            "personality":"温柔、细心、有自己的判断，不说教，不机械复述。",
            "scenario":"雨夜，银杏书屋刚刚打烊。", "first_mes":"回来啦。外面雨很大，先把伞放好吧。",
            "post_history_instructions":"始终用简体中文，以沈晚晴的口吻和简短动作继续场景。不替用户说话或行动。每次不超过150字。",
            "character_book":{"entries":[{"keys":["银杏书屋"],"constant":true,"enabled":true,"content":"银杏书屋每周二休息，柜台有一盏琥珀色台灯。","insertion_order":1}]}
        }
    })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let card = tavern::import_character(
        &state,
        card_file.path().to_str().ok_or("Card path invalid")?,
    )?;
    let mut story = tavern::create_story(&state, &card.id, Some("本地陪伴安装验收"))?;
    let preview = tavern::context_preview(&state, &story.id)?;
    assert!(
        preview.pre_history.contains("琥珀色台灯") || preview.post_history.contains("琥珀色台灯")
    );
    let mut timings = Vec::new();
    for (index, text) in ["晚晴，我叫林舟，记得叫我小舟。我今天有点累，想喝不加糖的热红茶。陪我在银杏书屋坐一会儿吧。", "你还记得我希望你怎么叫我、想喝什么吗？我们书屋周几休息？"].iter().enumerate() {
        let turn = Instant::now();
        story = tavern::send_message(&state, &story.id, text, tavern::local_model::MODEL_ID).await?;
        let answer = story.messages.last().ok_or("No persisted response")?;
        assert_eq!(answer.role, "assistant");
        assert!(!answer.failed && !answer.text.trim().is_empty());
        assert!(!answer.text.contains("<think>"));
        timings.push(turn.elapsed().as_secs_f64());
        println!("Turn {}: {}", index+1, answer.text);
    }
    let stopped = manager.stop().await?;
    assert!(stopped.enabled && stopped.stage == "ready");
    let turn = Instant::now();
    story = tavern::send_message(
        &state,
        &story.id,
        "台灯还亮着，我还想听你说一句晚安。",
        tavern::local_model::MODEL_ID,
    )
    .await?;
    timings.push(turn.elapsed().as_secs_f64());
    assert_eq!(manager.status().stage, "running");
    let saved = tavern::snapshot(&state)?;
    assert_eq!(saved.stories.len(), 1);
    assert_eq!(saved.stories[0].messages.len(), 7);
    assert!(saved.stories[0]
        .messages
        .iter()
        .all(|message| !message.failed));
    let running = manager.status();
    let stopped = manager.stop().await?;
    let proof = json!({"status":"passed", "installationRoot":manager.root(),
        "modelId":tavern::local_model::MODEL_ID,"catalog":catalog,"running":running,
        "afterRelease":stopped,"autoRestartVerified":true,"cloudChannelsConfigured":false,
        "conversationDatabase":"memory-only", "turnSeconds":timings,"story":story,
        "worldbook":preview,"setupSeconds":start.elapsed().as_secs_f64()});
    std::fs::write(
        &args[2],
        serde_json::to_vec_pretty(&proof).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    println!("Passed: real roleplay, worldbook, persistence and automatic restart; GPU released.");
    Ok(())
}
