//! Durable save identities; retries never create a second job or replay an old edit.
use super::{preferences, Job, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SaveReceipt {
    workspace_path: String,
    client_request_id: String,
    method: String,
    automation_id: String,
    fingerprint: String,
}

pub(super) fn request_id(input: &Value) -> Result<Option<&str>, String> {
    match input.get("clientRequestId") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value))
            if !value.trim().is_empty() && value.len() <= 256 && !value.contains('\0') =>
        {
            Ok(Some(value))
        }
        _ => Err("自动化保存请求标识无效，请保留原提案后重试".into()),
    }
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let mut result = serde_json::Map::new();
            for key in keys {
                result.insert(key.clone(), canonical(&object[key]));
            }
            Value::Object(result)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}

pub(super) fn fingerprint(
    input: &Value,
    workspace: &str,
    method: &str,
    target_id: Option<&str>,
) -> Result<String, String> {
    let mut payload = input.as_object().cloned().ok_or("自动化内容无效")?;
    payload.remove("clientRequestId");
    payload.insert(
        "workspacePath".into(),
        json!(preferences::path_key(workspace)),
    );
    let bytes = serde_json::to_vec(&canonical(&json!({
        "method": method,
        "automationId": target_id,
        "input": payload,
    })))
    .map_err(|_| "无法编码自动化保存请求")?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

pub(super) fn replay(
    store: &Store,
    workspace: &str,
    request_id: &str,
    method: &str,
    fingerprint: &str,
) -> Result<Option<Job>, String> {
    let Some(receipt) = store.save_receipts.iter().find(|receipt| {
        preferences::path_key(&receipt.workspace_path) == preferences::path_key(workspace)
            && receipt.client_request_id == request_id
    }) else {
        return Ok(None);
    };
    if receipt.method != method || receipt.fingerprint != fingerprint {
        return Err("此保存请求已用于其他自动化内容，未重复创建或覆盖现有任务".into());
    }
    store
        .jobs
        .iter()
        .find(|job| {
            job.automation_id == receipt.automation_id
                && preferences::path_key(&job.workspace_path) == preferences::path_key(workspace)
        })
        .cloned()
        .map(Some)
        .ok_or_else(|| "该保存请求对应的自动化已删除，未重新创建；请生成新的提案".into())
}

pub(super) fn remember(
    store: &mut Store,
    workspace: &str,
    request_id: &str,
    method: &str,
    automation_id: &str,
    fingerprint: String,
) {
    store.save_receipts.push(SaveReceipt {
        workspace_path: workspace.into(),
        client_request_id: request_id.into(),
        method: method.into(),
        automation_id: automation_id.into(),
        fingerprint,
    });
}

/// A proposal may be acknowledged in its conversation only after this exact
/// card has durably saved the same project-owned automation.
pub(super) fn validate_proposal_receipt(
    store: &Store,
    workspace: &str,
    automation_id: &str,
    session_id: &str,
    tool_call_id: &str,
) -> Result<(), String> {
    let job = store
        .jobs
        .iter()
        .find(|job| job.automation_id == automation_id)
        .ok_or("自动化任务不存在或已删除，未确认配置卡")?;
    super::ensure_job_scope(job, workspace)?;
    let client_request_id = format!("proposal:{session_id}:{tool_call_id}");
    if store.save_receipts.iter().any(|receipt| {
        preferences::path_key(&receipt.workspace_path) == preferences::path_key(workspace)
            && receipt.client_request_id == client_request_id
            && receipt.automation_id == automation_id
            && matches!(receipt.method.as_str(), "create" | "update")
    }) {
        Ok(())
    } else {
        Err("此配置卡没有对应的自动化保存回执，请先保存原配置卡".into())
    }
}
