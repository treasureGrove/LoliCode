//! Native, local-first roleplay library and conversation service.
//! Character data is stored independently from coding-agent sessions; model
//! credentials remain in the channel center and never cross renderer IPC.

use crate::{
    services::{channel_center, channel_center::AgentCatalog},
    store::AppState,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use flate2::read::ZlibDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::Path,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use uuid::Uuid;

const STORE_KEY: &str = "lolicode_tavern_store_v1";
const MAX_CARD_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CARD_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_MESSAGE_CHARS: usize = 64 * 1024;
const MAX_HISTORY_MESSAGES: usize = 60;
const MAX_MODEL_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const WORLD_INFO_BUDGET_CHARS: usize = 12_000;

mod presets;
pub use presets::{add_preset, preset_catalog, TavernPreset};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TavernCharacter {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub personality: String,
    #[serde(default)]
    pub scenario: String,
    #[serde(default)]
    pub first_mes: String,
    #[serde(default)]
    pub mes_example: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub post_history_instructions: String,
    #[serde(default)]
    pub alternate_greetings: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub creator: String,
    #[serde(default)]
    pub character_version: String,
    pub source_format: String,
    pub has_avatar: bool,
    pub imported_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TavernMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub created_at: i64,
    #[serde(default)]
    pub failed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TavernStory {
    pub id: String,
    pub character_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub messages: Vec<TavernMessage>,
    #[serde(default)]
    pub is_generating: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TavernSnapshot {
    pub characters: Vec<TavernCharacter>,
    pub stories: Vec<TavernStory>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TavernContextPreview {
    pub pre_history: String,
    pub post_history: String,
    pub included_entries: Vec<String>,
    pub excluded_entries: Vec<String>,
    pub world_info_chars: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TavernAvatar {
    pub data_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredCharacter {
    card: TavernCharacter,
    raw_data: Value,
    avatar_relative_path: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct TavernStore {
    #[serde(default)]
    characters: Vec<StoredCharacter>,
    #[serde(default)]
    stories: Vec<TavernStory>,
}

fn store_gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}

fn active_stories() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

struct ActiveStory(String);

impl ActiveStory {
    fn acquire(story_id: &str) -> Result<Self, String> {
        let mut active = active_stories()
            .lock()
            .map_err(|_| "酒馆会话状态暂不可用，请重试".to_string())?;
        if !active.insert(story_id.to_string()) {
            return Err("这个故事正在生成，请等待完成或稍后重试".into());
        }
        Ok(Self(story_id.to_string()))
    }
}

impl Drop for ActiveStory {
    fn drop(&mut self) {
        if let Ok(mut active) = active_stories().lock() {
            active.remove(&self.0);
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn read_store(state: &AppState) -> Result<TavernStore, String> {
    let raw = state
        .db
        .get_setting(STORE_KEY)
        .map_err(|error| error.to_string())?;
    let mut store = match raw {
        Some(value) => serde_json::from_str::<TavernStore>(&value)
            .map_err(|_| "酒馆本地数据无法解析，原数据已保留".to_string())?,
        None => TavernStore::default(),
    };
    let active = active_stories()
        .lock()
        .map_err(|_| "酒馆会话状态暂不可用，请重试".to_string())?;
    for story in &mut store.stories {
        story.is_generating = active.contains(&story.id);
    }
    Ok(store)
}

fn write_store(state: &AppState, store: &TavernStore) -> Result<(), String> {
    let raw = serde_json::to_string(store).map_err(|_| "酒馆数据无法保存".to_string())?;
    state
        .db
        .set_setting(STORE_KEY, &raw)
        .map_err(|error| error.to_string())
}

pub fn snapshot(state: &AppState) -> Result<TavernSnapshot, String> {
    let store = read_store(state)?;
    let mut stories = store.stories;
    stories.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(TavernSnapshot {
        characters: store.characters.into_iter().map(|item| item.card).collect(),
        stories,
    })
}

pub fn import_character(state: &AppState, path: &str) -> Result<TavernCharacter, String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("请选择角色卡文件".into());
    }
    let path = Path::new(path);
    let metadata = std::fs::metadata(path).map_err(|_| "角色卡文件不存在或无法访问")?;
    if !metadata.is_file() || metadata.len() > MAX_CARD_BYTES {
        return Err("角色卡文件超过 32 MB，或不是普通文件".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "角色卡文件无法读取")?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (raw_data, source_format, avatar_bytes) = if extension == "json" {
        if bytes.len() > MAX_CARD_JSON_BYTES {
            return Err("角色卡 JSON 超过 8 MB".into());
        }
        let value = serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "角色卡 JSON 格式无效，原有角色没有改动")?;
        let format = card_format(&value);
        (value, format, None)
    } else if extension == "png" {
        let metadata_json = png_character_json(&bytes)?;
        let value = serde_json::from_str::<Value>(&metadata_json)
            .map_err(|_| "PNG 角色卡中的角色数据不是有效 JSON")?;
        let format = card_format(&value);
        (value, format, Some(bytes.as_slice()))
    } else {
        return Err("目前支持 SillyTavern PNG 角色卡和 JSON 角色卡".into());
    };

    let data = raw_data
        .get("data")
        .filter(|value| value.is_object())
        .unwrap_or(&raw_data);
    let name = string_field(data, "name").trim().to_string();
    if name.is_empty() {
        return Err("角色卡缺少角色名称，原有角色没有改动".into());
    }
    let id = Uuid::new_v4().to_string();
    let avatar_relative_path = if let Some(bytes) = avatar_bytes {
        let relative = format!("tavern/avatars/{id}.png");
        write_avatar(&relative, bytes)?;
        Some(relative)
    } else {
        None
    };
    let card = character_from_data(id, data, source_format, avatar_relative_path.is_some())?;
    let _write = store_gate().lock().map_err(|_| "酒馆存储繁忙，请重试")?;
    let mut store = read_store(state)?;
    store.characters.push(StoredCharacter {
        card: card.clone(),
        raw_data,
        avatar_relative_path,
    });
    write_store(state, &store)?;
    Ok(card)
}

fn character_from_data(
    id: String,
    data: &Value,
    source_format: String,
    has_avatar: bool,
) -> Result<TavernCharacter, String> {
    let name = string_field(data, "name").trim().to_string();
    if name.is_empty() {
        return Err("角色卡缺少角色名称，原有角色没有改动".into());
    }
    Ok(TavernCharacter {
        id,
        name,
        description: string_field(data, "description"),
        personality: string_field(data, "personality"),
        scenario: string_field(data, "scenario"),
        first_mes: string_field(data, "first_mes"),
        mes_example: string_field(data, "mes_example"),
        system_prompt: string_field(data, "system_prompt"),
        post_history_instructions: string_field(data, "post_history_instructions"),
        alternate_greetings: string_array(data, "alternate_greetings"),
        tags: string_array(data, "tags"),
        creator: string_field(data, "creator"),
        character_version: string_field(data, "character_version"),
        source_format,
        has_avatar,
        imported_at: now_ms(),
    })
}

pub fn avatar(state: &AppState, character_id: &str) -> Result<TavernAvatar, String> {
    let store = read_store(state)?;
    let character = store
        .characters
        .iter()
        .find(|item| item.card.id == character_id)
        .ok_or("找不到这个角色")?;
    let relative = character
        .avatar_relative_path
        .as_deref()
        .ok_or("这个角色卡没有内嵌头像")?;
    let root = crate::config::get_app_config_dir()
        .canonicalize()
        .map_err(|_| "酒馆数据目录无法访问")?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "角色卡头像文件不存在")?;
    if !path.starts_with(&root) {
        return Err("角色卡头像路径无效".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "角色卡头像无法读取")?;
    Ok(TavernAvatar {
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
    })
}

pub async fn catalog(state: &AppState) -> Result<AgentCatalog, String> {
    channel_center::prepare_tavern_binding(state)
        .await
        .map(|binding| binding.catalog)
        .map_err(|error| error.to_string())
}

pub fn create_story(
    state: &AppState,
    character_id: &str,
    title: Option<&str>,
) -> Result<TavernStory, String> {
    let _write = store_gate().lock().map_err(|_| "酒馆存储繁忙，请重试")?;
    let mut store = read_store(state)?;
    let character = store
        .characters
        .iter()
        .find(|item| item.card.id == character_id)
        .ok_or("请先选择一个已导入的角色")?;
    let now = now_ms();
    let title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("与{}的新故事", character.card.name));
    let mut story = TavernStory {
        id: Uuid::new_v4().to_string(),
        character_id: character_id.to_string(),
        title,
        created_at: now,
        updated_at: now,
        model_id: None,
        messages: Vec::new(),
        is_generating: false,
    };
    if !character.card.first_mes.trim().is_empty() {
        story.messages.push(TavernMessage {
            id: Uuid::new_v4().to_string(),
            role: "assistant".into(),
            text: character.card.first_mes.clone(),
            created_at: now,
            failed: false,
        });
    }
    store.stories.push(story.clone());
    write_store(state, &store)?;
    Ok(story)
}

pub fn delete_story(state: &AppState, story_id: &str) -> Result<(), String> {
    if active_stories()
        .lock()
        .map_err(|_| "酒馆会话状态暂不可用，请重试".to_string())?
        .contains(story_id)
    {
        return Err("故事正在生成，请等生成结束后再删除".into());
    }
    let _write = store_gate().lock().map_err(|_| "酒馆存储繁忙，请重试")?;
    let mut store = read_store(state)?;
    let previous = store.stories.len();
    store.stories.retain(|story| story.id != story_id);
    if store.stories.len() == previous {
        return Err("找不到这个故事".into());
    }
    write_store(state, &store)
}

pub fn context_preview(state: &AppState, story_id: &str) -> Result<TavernContextPreview, String> {
    let store = read_store(state)?;
    let story = store
        .stories
        .iter()
        .find(|story| story.id == story_id)
        .ok_or("找不到这个故事")?;
    let character = store
        .characters
        .iter()
        .find(|item| item.card.id == story.character_id)
        .ok_or("这个故事对应的角色已不存在")?;
    Ok(build_context(character, story).0)
}

pub async fn send_message(
    state: &AppState,
    story_id: &str,
    text: &str,
    selected_model_id: &str,
) -> Result<TavernStory, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("请输入消息".into());
    }
    if trimmed.chars().count() > MAX_MESSAGE_CHARS {
        return Err("消息超过 64,000 字符，请拆分后发送".into());
    }
    let _active = ActiveStory::acquire(story_id)?;
    let binding = channel_center::prepare_tavern_binding(state)
        .await
        .map_err(|error| error.to_string())?;
    let model = binding
        .catalog
        .models
        .iter()
        .find(|model| model.id == selected_model_id)
        .ok_or("所选模型已不在当前渠道目录中，请重新选择模型")?;
    let route_model_id = model.model_id.clone();

    let (request_story, request_character) = {
        let _write = store_gate().lock().map_err(|_| "酒馆存储繁忙，请重试")?;
        let mut store = read_store(state)?;
        let story = store
            .stories
            .iter_mut()
            .find(|story| story.id == story_id)
            .ok_or("找不到这个故事")?;
        let character = store
            .characters
            .iter()
            .find(|item| item.card.id == story.character_id)
            .ok_or("这个故事对应的角色已不存在")?;
        let user_message = TavernMessage {
            id: Uuid::new_v4().to_string(),
            role: "user".into(),
            text: trimmed.to_string(),
            created_at: now_ms(),
            failed: false,
        };
        story.messages.push(user_message);
        story.model_id = Some(selected_model_id.to_string());
        story.updated_at = now_ms();
        let request_story = story.clone();
        let request_character = character.clone();
        write_store(state, &store)?;
        (request_story, request_character)
    };

    let messages = build_request_messages(&request_character, &request_story);
    let mut request = json!({
        "model": route_model_id,
        "messages": messages,
        "stream": false,
    });
    if let Some(limit) = model.output_limit {
        request["max_tokens"] = json!(limit);
    }
    let answer = async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| "无法初始化模型连接".to_string())?;
        let response = client
            .post(format!(
                "{}/chat/completions",
                binding.base_url.trim_end_matches('/')
            ))
            .bearer_auth(&binding.bearer_token)
            .json(&request)
            .send()
            .await
            .map_err(|error| format!("模型连接失败：{}", short_error(&error.to_string())))?;
        let body = read_model_response(response, MAX_MODEL_RESPONSE_BYTES).await?;
        let value =
            serde_json::from_str::<Value>(&body).map_err(|_| "模型返回内容无法解析".to_string())?;
        response_text(&value)
            .filter(|answer| !answer.trim().is_empty())
            .ok_or_else(|| "模型没有返回文本内容".to_string())
    }
    .await;
    let answer = match answer {
        Ok(answer) => answer,
        Err(error) => return mark_failed_and_report(state, story_id, &error),
    };
    let _write = store_gate().lock().map_err(|_| "酒馆存储繁忙，请重试")?;
    let mut store = read_store(state)?;
    let story = store
        .stories
        .iter_mut()
        .find(|story| story.id == story_id)
        .ok_or("故事在生成期间被删除")?;
    story.messages.push(TavernMessage {
        id: Uuid::new_v4().to_string(),
        role: "assistant".into(),
        text: answer,
        created_at: now_ms(),
        failed: false,
    });
    story.updated_at = now_ms();
    story.model_id = Some(selected_model_id.to_string());
    story.is_generating = false;
    let result = story.clone();
    write_store(state, &store)?;
    Ok(result)
}

async fn read_model_response(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    let status = response.status();
    if !status.is_success() {
        // Never expose raw provider error bodies, which can echo credentials.
        let guidance = match status.as_u16() {
            401 | 403 => "渠道未授权，请检查登录状态和模型权限",
            404 => "所选模型或接口不可用，请刷新模型目录后重试",
            429 => "渠道请求受限，请稍后重试或切换渠道",
            500..=599 => "渠道服务暂时不可用，请稍后重试",
            _ => "渠道未接受此请求，请检查模型配置后重试",
        };
        return Err(format!("HTTP {}：{guidance}", status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err("模型回复过大，请缩短本次生成内容后重试".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取模型响应失败，刚才发送的消息已保留")?
    {
        if bytes.len() + chunk.len() > max_bytes {
            return Err("模型回复过大，请缩短本次生成内容后重试".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "模型返回的文本编码无效".into())
}

fn mark_failed_and_report<T>(state: &AppState, story_id: &str, detail: &str) -> Result<T, String> {
    let _write = store_gate().lock().map_err(|_| "酒馆存储繁忙，请重试")?;
    if let Ok(mut store) = read_store(state) {
        if let Some(story) = store.stories.iter_mut().find(|story| story.id == story_id) {
            if let Some(message) = story
                .messages
                .iter_mut()
                .rev()
                .find(|message| message.role == "user")
            {
                message.failed = true;
            }
            story.updated_at = now_ms();
            let _ = write_store(state, &store);
        }
    }
    Err(format!("模型请求失败：{}", short_error(detail)))
}

fn short_error(value: &str) -> String {
    let cleaned = value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(480)
        .collect::<String>();
    if cleaned.is_empty() {
        "未知错误".into()
    } else {
        cleaned
    }
}

fn response_text(value: &Value) -> Option<String> {
    let content = value.pointer("/choices/0/message/content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let blocks = content.as_array()?;
    let text = blocks
        .iter()
        .filter(|block| {
            block
                .get("type")
                .and_then(Value::as_str)
                .is_none_or(|kind| kind == "text")
        })
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}

fn build_request_messages(character: &StoredCharacter, story: &TavernStory) -> Vec<Value> {
    let context = build_context(character, story).0;
    let mut messages = vec![json!({"role":"system","content":context.pre_history})];
    let start = story.messages.len().saturating_sub(MAX_HISTORY_MESSAGES);
    let history = &story.messages[start..];
    let current_user_index = history
        .last()
        .filter(|message| message.role == "user")
        .map(|_| history.len().saturating_sub(1));
    let has_post_history = !context.post_history.trim().is_empty();
    for (index, message) in history.iter().enumerate() {
        if has_post_history && current_user_index == Some(index) {
            messages.push(json!({"role":"system","content":context.post_history}));
        }
        messages.push(json!({
            "role": if message.role == "assistant" { "assistant" } else { "user" },
            "content": message.text,
        }));
    }
    if has_post_history && current_user_index.is_none() {
        messages.push(json!({"role":"system","content":context.post_history}));
    }
    messages
}

fn build_context(
    character: &StoredCharacter,
    story: &TavernStory,
) -> (TavernContextPreview, usize) {
    let card = &character.card;
    let mut sections = vec![format!("你正在扮演角色「{}」。", card.name)];
    for (label, value) in [
        ("角色设定", card.description.as_str()),
        ("性格", card.personality.as_str()),
        ("场景", card.scenario.as_str()),
        ("示例对话", card.mes_example.as_str()),
        ("角色系统提示", card.system_prompt.as_str()),
    ] {
        if !value.trim().is_empty() {
            sections.push(format!("{label}：\n{}", value.trim()));
        }
    }
    let scan_text = story
        .messages
        .iter()
        .rev()
        .take(20)
        .map(|message| message.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let entries = world_info_entries(&character.raw_data);
    let mut candidates = entries.into_iter().collect::<Vec<_>>();
    candidates.sort_by_key(|entry| entry.get("order").and_then(Value::as_i64).unwrap_or(0));
    let mut included = Vec::new();
    let mut excluded = Vec::new();
    let mut world_info = String::new();
    for entry in candidates {
        let title = world_info_title(&entry);
        if entry.get("enabled").and_then(Value::as_bool) == Some(false) {
            excluded.push(format!("{title}（已停用）"));
            continue;
        }
        let constant = entry.get("constant").and_then(Value::as_bool) == Some(true);
        let keys = string_array(&entry, "keys");
        let secondary = string_array(&entry, "secondary_keys");
        let primary_hit = !keys.is_empty()
            && keys
                .iter()
                .any(|key| contains_case_insensitive(&scan_text, key));
        let selective = entry.get("selective").and_then(Value::as_bool) == Some(true);
        let secondary_hit = !selective
            || secondary.is_empty()
            || secondary
                .iter()
                .any(|key| contains_case_insensitive(&scan_text, key));
        if !constant && !(primary_hit && secondary_hit) {
            excluded.push(format!("{title}（本轮未命中关键词）"));
            continue;
        }
        let content = string_field(&entry, "content");
        if content.trim().is_empty() {
            excluded.push(format!("{title}（没有可注入内容）"));
            continue;
        }
        if world_info.chars().count() + content.chars().count() > WORLD_INFO_BUDGET_CHARS {
            excluded.push(format!("{title}（超出酒馆世界书上下文预算）"));
            continue;
        }
        world_info.push_str(&format!("\n\n### {title}\n{}", content.trim()));
        included.push(title);
    }
    if !world_info.is_empty() {
        sections.push(format!("本轮世界书内容：{world_info}"));
    }
    let pre_history = sections.join("\n\n");
    let post_history = card.post_history_instructions.trim().to_string();
    let world_info_chars = world_info.chars().count();
    (
        TavernContextPreview {
            pre_history,
            post_history,
            included_entries: included,
            excluded_entries: excluded,
            world_info_chars,
        },
        world_info_chars,
    )
}

fn world_info_entries(raw_data: &Value) -> Vec<Value> {
    let data = raw_data
        .get("data")
        .filter(|value| value.is_object())
        .unwrap_or(raw_data);
    data.get("character_book")
        .or_else(|| data.get("characterBook"))
        .and_then(|book| book.get("entries"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn world_info_title(entry: &Value) -> String {
    ["comment", "name", "id"]
        .iter()
        .find_map(|key| {
            entry
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
        })
        .map(str::to_string)
        .unwrap_or_else(|| {
            let keys = string_array(entry, "keys");
            if keys.is_empty() {
                "未命名条目".into()
            } else {
                keys.join("、")
            }
        })
}

fn contains_case_insensitive(haystack: &str, needle: &str) -> bool {
    !needle.is_empty() && haystack.to_lowercase().contains(&needle.to_lowercase())
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn card_format(value: &Value) -> String {
    match value.get("spec").and_then(Value::as_str) {
        Some("chara_card_v3") => "SillyTavern V3".into(),
        Some("chara_card_v2") => "SillyTavern V2".into(),
        Some(_) => "角色卡 JSON".into(),
        None => "TavernAI V1 / JSON".into(),
    }
}

fn png_character_json(bytes: &[u8]) -> Result<String, String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("这不是有效 PNG 文件".into());
    }
    let chunks = png_text_chunks(bytes)?;
    for key in ["ccv3", "chara"] {
        if let Some(encoded) = chunks.get(key) {
            let payload = STANDARD
                .decode(encoded)
                .map_err(|_| format!("PNG 角色卡的 {key} 元数据不是有效 Base64"))?;
            if payload.len() > MAX_CARD_JSON_BYTES {
                return Err("PNG 角色卡中的 JSON 超过 8 MB".into());
            }
            return String::from_utf8(payload).map_err(|_| "PNG 角色卡 JSON 不是 UTF-8".into());
        }
    }
    Err("PNG 中没有找到 SillyTavern 的 chara / ccv3 角色数据".into())
}

fn png_text_chunks(bytes: &[u8]) -> Result<HashMap<String, Vec<u8>>, String> {
    let mut chunks = HashMap::new();
    let mut offset = 8usize;
    while offset.checked_add(12).is_some_and(|end| end <= bytes.len()) {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let kind = &bytes[offset + 4..offset + 8];
        let data_start = offset + 8;
        let data_end = data_start.checked_add(length).ok_or("PNG 块长度无效")?;
        let next = data_end.checked_add(4).ok_or("PNG 块长度无效")?;
        if next > bytes.len() || length > MAX_CARD_JSON_BYTES {
            return Err("PNG 文件块损坏或超过大小限制".into());
        }
        let data = &bytes[data_start..data_end];
        let decoded = match kind {
            b"tEXt" => parse_png_text(data),
            b"zTXt" => parse_png_ztxt(data)?,
            b"iTXt" => parse_png_itxt(data)?,
            _ => None,
        };
        if let Some((key, text)) = decoded {
            if key.eq_ignore_ascii_case("ccv3") || key.eq_ignore_ascii_case("chara") {
                chunks.insert(key.to_ascii_lowercase(), text);
            }
        }
        offset = next;
        if kind == b"IEND" {
            break;
        }
    }
    Ok(chunks)
}

fn split_png_keyword(data: &[u8]) -> Option<(&str, &[u8])> {
    let separator = data.iter().position(|byte| *byte == 0)?;
    let key = std::str::from_utf8(&data[..separator]).ok()?;
    Some((key, &data[separator + 1..]))
}

fn parse_png_text(data: &[u8]) -> Option<(String, Vec<u8>)> {
    let (key, text) = split_png_keyword(data)?;
    Some((key.to_string(), text.to_vec()))
}

fn parse_png_ztxt(data: &[u8]) -> Result<Option<(String, Vec<u8>)>, String> {
    let Some((key, remainder)) = split_png_keyword(data) else {
        return Ok(None);
    };
    if remainder.first() != Some(&0) {
        return Ok(None);
    }
    let decoder = ZlibDecoder::new(&remainder[1..]);
    let mut output = Vec::new();
    decoder
        .take(MAX_CARD_JSON_BYTES as u64 + 1)
        .read_to_end(&mut output)
        .map_err(|_| "PNG 压缩角色数据无法解码")?;
    if output.len() > MAX_CARD_JSON_BYTES {
        return Err("PNG 压缩角色数据超过 8 MB".into());
    }
    Ok(Some((key.to_string(), output)))
}

fn parse_png_itxt(data: &[u8]) -> Result<Option<(String, Vec<u8>)>, String> {
    let Some((key, remainder)) = split_png_keyword(data) else {
        return Ok(None);
    };
    if remainder.len() < 2 {
        return Ok(None);
    }
    let compressed = remainder[0] == 1;
    let mut cursor = 2;
    for _ in 0..2 {
        let Some(relative) = remainder[cursor..].iter().position(|byte| *byte == 0) else {
            return Ok(None);
        };
        cursor += relative + 1;
    }
    let text = &remainder[cursor..];
    let output = if compressed {
        let decoder = ZlibDecoder::new(text);
        let mut output = Vec::new();
        decoder
            .take(MAX_CARD_JSON_BYTES as u64 + 1)
            .read_to_end(&mut output)
            .map_err(|_| "PNG 压缩角色数据无法解码")?;
        output
    } else {
        text.to_vec()
    };
    if output.len() > MAX_CARD_JSON_BYTES {
        return Err("PNG 角色数据超过 8 MB".into());
    }
    Ok(Some((key.to_string(), output)))
}

fn write_avatar(relative: &str, bytes: &[u8]) -> Result<(), String> {
    let root = crate::config::get_app_config_dir();
    let target = root.join(relative);
    let parent = target.parent().ok_or("角色卡头像目录无效")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法创建角色卡头像目录")?;
    let temp = target.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = std::fs::File::create(&temp).map_err(|_| "无法保存角色卡头像")?;
    file.write_all(bytes).map_err(|_| "无法保存角色卡头像")?;
    file.sync_all().map_err(|_| "无法保存角色卡头像")?;
    std::fs::rename(&temp, &target).map_err(|_| {
        let _ = std::fs::remove_file(&temp);
        "无法保存角色卡头像".to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn response_reader_bounds_chunks_and_hides_provider_error_bodies() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = axum::Router::new()
            .route(
                "/error",
                axum::routing::get(|| async {
                    (
                        axum::http::StatusCode::UNAUTHORIZED,
                        "synthetic-private-credential-must-not-be-shown",
                    )
                }),
            )
            .route(
                "/large",
                axum::routing::get(|| async {
                    axum::body::Body::from_stream(futures::stream::iter((0..5).map(|_| {
                        Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"twenty-byte-fixture!!"))
                    })))
                }),
            )
            .route("/ok", axum::routing::get(|| async { "{\"choices\":[]}" }));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let error = read_model_response(
            client
                .get(format!("http://{address}/error"))
                .send()
                .await
                .unwrap(),
            64,
        )
        .await
        .unwrap_err();
        assert!(error.contains("HTTP 401"));
        assert!(!error.contains("synthetic-private"));
        assert!(read_model_response(
            client
                .get(format!("http://{address}/large"))
                .send()
                .await
                .unwrap(),
            64
        )
        .await
        .is_err());
        assert_eq!(
            read_model_response(
                client
                    .get(format!("http://{address}/ok"))
                    .send()
                    .await
                    .unwrap(),
                64
            )
            .await
            .unwrap(),
            "{\"choices\":[]}"
        );
        server.abort();
    }

    #[tokio::test]
    async fn completed_generation_returns_idle_story_and_uses_declared_output_limit() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let observed_limit = Arc::new(AtomicBool::new(false));
        let observed = observed_limit.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = axum::Router::new().route("/v1/chat/completions", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let observed = observed.clone(); async move {
                observed.store(body["max_tokens"]==128, Ordering::SeqCst);
                axum::Json(json!({"choices":[{"message":{"role":"assistant","content":"A completed story reply."},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":6,"total_tokens":18}}))
            }
        }));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let state = AppState::new(Arc::new(crate::database::Database::memory().unwrap()));
        let mut proxy = state.db.get_global_proxy_config().await.unwrap();
        proxy.listen_address = "127.0.0.1".into();
        proxy.listen_port = 0;
        state.db.update_global_proxy_config(proxy).await.unwrap();
        channel_center::save(&state.db, serde_json::from_value(json!({"revision":0,"targets":[],"defaultModel":"owned/model","channels":[{"id":"owned","name":"Loopback only","authKind":"api_key","apiKey":"owned-fixture-key","protocol":"openai_chat","baseUrl":format!("http://{address}/v1"),"models":[{"id":"model","name":"Fixture","enabled":true,"supportsTools":true,"outputLimit":128}]}]})).unwrap()).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let card = temp.path().join("card.json");
        std::fs::write(&card, r#"{"name":"Story fixture"}"#).unwrap();
        let character = import_character(&state, card.to_str().unwrap()).unwrap();
        let story = create_story(&state, &character.id, None).unwrap();
        let model = catalog(&state).await.unwrap().default_model.unwrap();
        let reply = send_message(&state, &story.id, "Hello", &model).await;
        let _ = state.proxy_service.stop().await;
        server.abort();
        let reply = reply.unwrap();
        assert!(
            !reply.is_generating,
            "a completed IPC result must not leave the renderer spinning"
        );
        assert!(observed_limit.load(Ordering::SeqCst));
        assert_eq!(
            reply.messages.last().unwrap().text,
            "A completed story reply."
        );
        assert!(!snapshot(&state).unwrap().stories[0].is_generating);
    }

    #[test]
    fn parses_png_character_metadata_and_prefers_v3() {
        let v2 = STANDARD.encode(br#"{"spec":"chara_card_v2","data":{"name":"old"}}"#);
        let v3 = STANDARD.encode(br#"{"spec":"chara_card_v3","data":{"name":"new"}}"#);
        let png = png_with_text_chunks(&[("chara", &v2), ("ccv3", &v3)]);
        assert_eq!(
            png_character_json(&png).unwrap(),
            r#"{"spec":"chara_card_v3","data":{"name":"new"}}"#
        );
    }

    #[test]
    fn world_info_uses_constant_and_matching_keyword_entries_only() {
        let raw = json!({
            "spec":"chara_card_v2",
            "data":{
                "name":"Mira",
                "character_book":{"entries":[
                    {"comment":"Always","content":"constant lore","constant":true,"enabled":true},
                    {"comment":"Forest","content":"forest lore","keys":["forest"],"enabled":true},
                    {"comment":"Hidden","content":"hidden lore","keys":["ocean"],"enabled":true}
                ]}
            }
        });
        let character = StoredCharacter {
            card: TavernCharacter {
                id: "c1".into(),
                name: "Mira".into(),
                description: String::new(),
                personality: String::new(),
                scenario: String::new(),
                first_mes: String::new(),
                mes_example: String::new(),
                system_prompt: String::new(),
                post_history_instructions: String::new(),
                alternate_greetings: vec![],
                tags: vec![],
                creator: String::new(),
                character_version: String::new(),
                source_format: "V2".into(),
                has_avatar: false,
                imported_at: 1,
            },
            raw_data: raw,
            avatar_relative_path: None,
        };
        let story = TavernStory {
            id: "s1".into(),
            character_id: "c1".into(),
            title: "Test".into(),
            created_at: 1,
            updated_at: 1,
            model_id: None,
            messages: vec![TavernMessage {
                id: "m1".into(),
                role: "user".into(),
                text: "We enter the forest.".into(),
                created_at: 1,
                failed: false,
            }],
            is_generating: false,
        };
        let preview = build_context(&character, &story).0;
        assert_eq!(preview.included_entries, vec!["Always", "Forest"]);
        assert_eq!(preview.excluded_entries, vec!["Hidden（本轮未命中关键词）"]);
        assert!(preview.pre_history.contains("forest lore"));
        assert!(!preview.pre_history.contains("hidden lore"));
    }

    #[test]
    fn post_history_instructions_are_inserted_before_the_current_user_message() {
        let character = StoredCharacter {
            card: TavernCharacter {
                id: "c1".into(),
                name: "Mira".into(),
                description: String::new(),
                personality: String::new(),
                scenario: String::new(),
                first_mes: String::new(),
                mes_example: String::new(),
                system_prompt: String::new(),
                post_history_instructions: "Stay in character.".into(),
                alternate_greetings: vec![],
                tags: vec![],
                creator: String::new(),
                character_version: String::new(),
                source_format: "V2".into(),
                has_avatar: false,
                imported_at: 1,
            },
            raw_data: json!({"spec":"chara_card_v2","data":{"name":"Mira"}}),
            avatar_relative_path: None,
        };
        let story = TavernStory {
            id: "s1".into(),
            character_id: "c1".into(),
            title: "Test".into(),
            created_at: 1,
            updated_at: 1,
            model_id: None,
            messages: vec![
                TavernMessage {
                    id: "m1".into(),
                    role: "user".into(),
                    text: "Hello".into(),
                    created_at: 1,
                    failed: false,
                },
                TavernMessage {
                    id: "m2".into(),
                    role: "assistant".into(),
                    text: "Hi.".into(),
                    created_at: 2,
                    failed: false,
                },
                TavernMessage {
                    id: "m3".into(),
                    role: "user".into(),
                    text: "Continue the scene.".into(),
                    created_at: 3,
                    failed: false,
                },
            ],
            is_generating: false,
        };

        let messages = build_request_messages(&character, &story);
        let roles = messages
            .iter()
            .map(|message| message["role"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(roles, ["system", "user", "assistant", "system", "user"]);
        assert_eq!(messages[3]["content"], "Stay in character.");
        assert_eq!(messages[4]["content"], "Continue the scene.");
    }

    fn png_with_text_chunks(chunks: &[(&str, &str)]) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        for (key, text) in chunks {
            let mut data = key.as_bytes().to_vec();
            data.push(0);
            data.extend_from_slice(text.as_bytes());
            bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
            bytes.extend_from_slice(b"tEXt");
            bytes.extend_from_slice(&data);
            bytes.extend_from_slice(&0u32.to_be_bytes());
        }
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(b"IEND");
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes
    }
}
