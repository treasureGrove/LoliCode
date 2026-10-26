//! Read-only document IPC is scoped through an existing, authorized session.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::{AppHandle, Manager};

#[tauri::command(rename_all = "camelCase")]
pub async fn invoke_agent_document(
    app: AppHandle,
    session_id: String,
    method: String,
    args: Value,
) -> Result<Value, String> {
    let project = super::agent_dispatch::session_project(&app, &session_id).await?;
    let remote = app
        .state::<crate::services::inprocess_agent::InprocessAgentState>()
        .remote_projects(&app.state::<crate::store::AppState>())
        .await;
    if remote.owns(Path::new(&project)) {
        return Err("文档查看器暂仅支持本地项目，不会读取远程工程的本机占位目录".into());
    }
    let root = Path::new(&project);
    let fields = match method.as_str() {
        "open" => &["path"][..],
        "pdf" => &["path", "expectedRevision"][..],
        "read" => &["path", "locator", "offset", "limit"][..],
        "search" => &["path", "query"][..],
        "report" => &["path", "locator", "selection", "expectedRevision"][..],
        _ => return Err("未知文档操作".into()),
    };
    let object = args.as_object().ok_or("文档参数必须为对象")?;
    if object.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err("文档操作包含未知参数".into());
    }
    for (key, value) in object {
        let valid = match key.as_str() {
            "offset" | "limit" => value.as_u64().is_some_and(|v| v <= usize::MAX as u64),
            "locator" | "selection" | "expectedRevision" if value.is_null() => true,
            _ => value
                .as_str()
                .is_some_and(|s| s.len() <= 32 * 1024 && !s.contains('\0')),
        };
        if !valid {
            return Err(format!("文档参数 {key} 无效"));
        }
    }
    let path = args["path"].as_str().ok_or("缺少文档路径")?;
    use crate::services::agent_documents as docs;
    let value = match method.as_str() {
        "open" => serde_json::to_value(docs::open_document(root, path).await?),
        "read" => serde_json::to_value(
            docs::read_document(
                root,
                path,
                args["locator"].as_str(),
                args["offset"].as_u64().map(|v| v as usize),
                args["limit"].as_u64().map(|v| v as usize),
            )
            .await?,
        ),
        "search" => serde_json::to_value(
            docs::search_document(
                root,
                path,
                args["query"].as_str().ok_or("缺少搜索文字")?,
                None,
                None,
            )
            .await?,
        ),
        "report" => serde_json::to_value(
            docs::report_view_checked(
                root,
                path,
                args["locator"].as_str(),
                args["selection"].as_str(),
                args["expectedRevision"].as_str(),
            )
            .await?,
        ),
        "pdf" => {
            let expected = pdf_expected_revision(&args)?;
            let bytes = docs::read_bytes(root, path).await?;
            return encode_pdf_revision(&bytes, expected);
        }
        _ => unreachable!(),
    };
    value.map_err(|_| "文档结果无法编码".into())
}

fn pdf_expected_revision(args: &Value) -> Result<&str, String> {
    args["expectedRevision"]
        .as_str()
        .filter(|revision| {
            revision.len() == 64 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .ok_or_else(|| "PDF 请求必须提供当前文档的 expectedRevision（SHA256）".into())
}

fn encode_pdf_revision(bytes: &[u8], expected_revision: &str) -> Result<Value, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("请选择 PDF 文档".into());
    }
    let revision = format!("{:x}", Sha256::digest(bytes));
    if !revision.eq_ignore_ascii_case(expected_revision) {
        return Err("PDF 已在预览加载后变更，请重新读取文档后查看页面".into());
    }
    Ok(json!(STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_requests_require_a_complete_sha256_revision() {
        for args in [
            json!({}),
            json!({"expectedRevision":null}),
            json!({"expectedRevision":42}),
            json!({"expectedRevision":"abc"}),
            json!({"expectedRevision":"g".repeat(64)}),
        ] {
            assert!(pdf_expected_revision(&args).is_err());
        }
        let args = json!({"expectedRevision":"a".repeat(64)});
        assert_eq!(pdf_expected_revision(&args).unwrap(), "a".repeat(64));
    }

    #[test]
    fn pdf_response_is_encoded_only_when_actual_bytes_match_the_preview_revision() {
        let original = b"%PDF-1.7\noriginal";
        let replacement = b"%PDF-1.7\nreplacement";
        let expected = format!("{:x}", Sha256::digest(original));
        let value = encode_pdf_revision(original, &expected).unwrap();
        assert_eq!(STANDARD.decode(value.as_str().unwrap()).unwrap(), original);
        assert!(encode_pdf_revision(replacement, &expected).is_err());
        assert!(encode_pdf_revision(b"PK\x03\x04not a PDF", &expected).is_err());
    }
}
