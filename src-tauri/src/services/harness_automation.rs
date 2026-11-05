//! User-confirmed automation saves overlay the read-only Harness tool results.
use lolicode_agent::{native::automation_proposal::mark_saved, AgentPart, AgentSnapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveReceipt {
    automation_id: String,
    fingerprint: String,
    title: String,
}

fn file(profile: &Path, id: &str) -> Option<PathBuf> {
    let raw = id.strip_prefix("lc:")?;
    let uuid = Uuid::parse_str(raw).ok()?;
    (raw == uuid.to_string()).then(|| {
        profile
            .join("agent/harness-automation-receipts")
            .join(format!("{uuid}.json"))
    })
}

fn read(file: &Path) -> Result<BTreeMap<String, SaveReceipt>, String> {
    match fs::symlink_metadata(file) {
        Ok(meta) if meta.is_file() && meta.len() <= 1024 * 1024 => {
            let bytes = fs::read(file).map_err(|_| "无法读取自动化保存回执")?;
            serde_json::from_slice(&bytes).map_err(|_| "自动化保存回执格式无效".into())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        _ => Err("自动化保存回执不可用".into()),
    }
}

fn proposals(snapshot: &mut AgentSnapshot) -> impl Iterator<Item = (&String, &mut String)> {
    snapshot
        .messages
        .iter_mut()
        .flat_map(|message| &mut message.parts)
        .filter_map(|part| match part {
            AgentPart::Tool {
                id,
                name,
                state,
                output: Some(output),
                ..
            } if name == "propose_automation" && state == "completed" => Some((&*id, output)),
            _ => None,
        })
}

pub(super) fn apply(profile: &Path, snapshot: &mut AgentSnapshot) -> Result<(), String> {
    let Some(file) = file(profile, &snapshot.session.id) else {
        return Ok(());
    };
    let receipts = read(&file)?;
    for (id, output) in proposals(snapshot) {
        let Some(receipt) = receipts.get(id) else {
            continue;
        };
        let Ok(mut value) = serde_json::from_str::<Value>(output) else {
            continue;
        };
        if mark_saved(&mut value, &receipt.automation_id).ok().as_ref()
            == Some(&receipt.fingerprint)
        {
            *output = value.to_string();
        }
    }
    Ok(())
}

pub(super) fn save(
    profile: &Path,
    mut snapshot: AgentSnapshot,
    args: &Value,
) -> Result<Value, String> {
    let file = file(profile, &snapshot.session.id).ok_or("无效的自动化会话编号")?;
    let tool = super::harness_sessions::argument(args, "toolCallId")?;
    let automation = super::harness_sessions::argument(args, "automationId")?;
    let (_, output) = proposals(&mut snapshot)
        .find(|(id, _)| id.as_str() == tool)
        .ok_or("找不到此会话的已完成自动化提案")?;
    let mut value: Value = serde_json::from_str(output).map_err(|_| "自动化提案输出无法读取")?;
    let fingerprint = mark_saved(&mut value, automation)?;
    let mut receipts = read(&file)?;
    if let Some(receipt) = receipts.get(tool) {
        if receipt.automation_id != automation || receipt.fingerprint != fingerprint {
            return Err("自动化提案已确认保存为其他任务".into());
        }
    } else {
        if receipts.len() >= 1024 {
            return Err("此会话的自动化保存回执已达上限".into());
        }
        receipts.insert(
            tool.into(),
            SaveReceipt {
                automation_id: automation.into(),
                fingerprint,
                title: value["input"]["title"].as_str().unwrap_or_default().into(),
            },
        );
        crate::config::write_json_file_private(&file, &receipts)
            .map_err(|_| "无法保存自动化回执")?;
    }
    Ok(json!({"status":"saved","automationId":automation,"toolCallId":tool}))
}

pub(super) fn context(profile: &Path, id: &str) -> String {
    let Some(receipts) = file(profile, id).and_then(|file| read(&file).ok()) else {
        return String::new();
    };
    if receipts.is_empty() {
        return String::new();
    }
    let facts: Vec<_> = receipts
        .into_values()
        .take(20)
        .map(|receipt| json!({"title":receipt.title,"savedAutomationId":receipt.automation_id}))
        .collect();
    format!("Desktop-confirmed automation saves. When editing one, pass the corresponding savedAutomationId as automationId.\n{}", json!(facts))
}
