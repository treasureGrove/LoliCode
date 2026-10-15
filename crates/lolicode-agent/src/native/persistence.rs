use super::types::{Grant, StoredSession};
use crate::{AgentPart, AgentStatus};
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

pub(super) async fn atomic<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "无法编码本地会话记录")?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("本地会话记录超过保存上限，请新建会话，已有记录保留。".into());
    }
    let parent = path.parent().ok_or("本地记录路径无效")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|_| "无法创建本地会话目录")?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let result = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .await
            .map_err(|_| "无法保存本地会话记录")?;
        file.write_all(&bytes)
            .await
            .map_err(|_| "无法写入本地会话记录")?;
        file.sync_all().await.map_err(|_| "无法同步本地会话记录")?;
        drop(file);
        tokio::fs::rename(&temporary, path)
            .await
            .map_err(|_| "无法原子更新本地会话记录")
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(temporary).await;
    }
    Ok(result?)
}

pub(super) fn session_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    let raw = id.strip_prefix("lc:").ok_or("无法识别本地会话")?;
    let uuid = Uuid::parse_str(raw).map_err(|_| "本地会话标识无效")?;
    if uuid.to_string() != raw {
        return Err("本地会话标识无效".into());
    }
    Ok(root.join("sessions").join(format!("{raw}.json")))
}

pub(super) async fn save(root: &Path, value: &StoredSession) -> Result<(), String> {
    atomic(&session_path(root, &value.snapshot.session.id)?, value).await
}

pub(super) async fn load(root: &Path) -> Result<Vec<StoredSession>, String> {
    let directory = root.join("sessions");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| "无法读取本地会话目录")?;
    let mut entries = tokio::fs::read_dir(&directory)
        .await
        .map_err(|_| "无法读取本地会话目录")?;
    let mut sessions = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|_| "无法读取本地会话记录")?
    {
        if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        if !entry
            .file_type()
            .await
            .map_err(|_| "无法读取本地会话记录")?
            .is_file()
        {
            return Err("本地会话记录不是普通文件".into());
        }
        let bytes = tokio::fs::read(entry.path())
            .await
            .map_err(|_| "无法读取本地会话记录")?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("本地会话记录超出读取上限".into());
        }
        let mut stored: StoredSession =
            serde_json::from_slice(&bytes).map_err(|_| "本地会话记录损坏，原文件已保留")?;
        if stored.format != 1 || session_path(root, &stored.snapshot.session.id)? != entry.path() {
            return Err("本地会话记录格式无效，原文件已保留".into());
        }
        // Title requests are ephemeral and are never resumed after a restart.
        let title_interrupted = stored.snapshot.title_pending;
        let compaction_interrupted = stored.snapshot.compacting;
        stored.snapshot.title_pending = false;
        stored.snapshot.compacting = false;
        stored.snapshot.session.activity = None;
        if matches!(
            stored.snapshot.status,
            AgentStatus::Running | AgentStatus::WaitingPermission | AgentStatus::WaitingQuestion
        ) {
            stored.snapshot.status = AgentStatus::Error;
            stored.snapshot.error =
                Some("上次任务随应用关闭而中断；工具不会自动重放，请确认文件状态后继续。".into());
            stored.snapshot.permissions.clear();
            stored.snapshot.questions.clear();
            for message in &mut stored.snapshot.messages {
                if message.role == "assistant" && message.completed_at.is_none() {
                    message.completed_at = Some(super::engine::now());
                }
                for part in &mut message.parts {
                    if let AgentPart::Tool { state, error, .. } = part {
                        if matches!(state.as_str(), "pending" | "running") {
                            *state = "error".into();
                            *error = Some("应用关闭前未收到工具结果，请核对文件状态。".into());
                        }
                    }
                }
            }
            // Repair only missing protocol results; never re-execute a tool.
            repair_history(&mut stored);
            save(root, &stored).await?;
        } else if title_interrupted || compaction_interrupted {
            save(root, &stored).await?;
        }
        sessions.push(stored);
    }
    Ok(sessions)
}

pub(super) fn repair_history(stored: &mut StoredSession) {
    let mut repaired = Vec::new();
    for index in 0..stored.history.len() {
        let message = stored.history[index].clone();
        if message["role"] == "assistant" {
            if let Some(calls) = message["tool_calls"].as_array() {
                repaired.push(message.clone());
                let mut end = index + 1;
                while end < stored.history.len() && stored.history[end]["role"] == "tool" {
                    end += 1;
                }
                for call in calls {
                    if let Some(id) = call["id"].as_str() {
                        if !stored.history[index + 1..end]
                            .iter()
                            .any(|m| m["tool_call_id"] == id)
                        {
                            repaired.push(json!({"role":"tool","tool_call_id":id,"content":"Execution was interrupted; no result is known. Inspect the project before retrying."}));
                        }
                    }
                }
                continue;
            }
        }
        repaired.push(message);
    }
    stored.history = repaired;
}

pub(super) async fn load_grants(root: &Path) -> Result<Vec<Grant>, String> {
    match tokio::fs::read(root.join("project-grants.json")).await {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "项目授权记录损坏，原文件已保留".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err("无法读取项目授权记录".into()),
    }
}
