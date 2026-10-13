//! Local acceptance tool: reads credentials from the OS vault, prints metadata only.
use freehub_gateway::{
    credentials::{Credentials, SystemCredentials},
    SafeError, Store,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

async fn check() -> Result<Value, SafeError> {
    let dir = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| SafeError::invalid("请指定 FreeHub 的应用数据目录。"))?;
    if !dir.join("freehub.db").is_file() {
        return Err(SafeError::invalid("未找到已配置的 FreeHub 数据库。"));
    }
    let store = Store::open(&dir, Arc::new(SystemCredentials::default()))?;
    let channels = store.channels()?;
    let channel = channels
        .iter()
        .find(|c| c.enabled && c.confirmed_free && c.key_present)
        .ok_or_else(|| SafeError::invalid("请先在应用中保存并启用已确认免费的渠道。"))?;
    let key = SystemCredentials::default()
        .get(&format!("channel:{}", channel.id))?
        .ok_or_else(SafeError::credentials)?;
    let mut scanned = 0;
    for file in std::fs::read_dir(&dir).map_err(|_| SafeError::storage())? {
        let file = file.map_err(|_| SafeError::storage())?;
        if file
            .file_type()
            .map_err(|_| SafeError::storage())?
            .is_file()
        {
            let bytes = std::fs::read(file.path()).map_err(|_| SafeError::storage())?;
            if !key.is_empty()
                && bytes
                    .windows(key.len())
                    .any(|window| window == key.as_bytes())
            {
                return Err(SafeError::new(
                    500,
                    "credential_persistence",
                    "持久化检查发现密钥明文，需要立即修复。",
                ));
            }
            scanned += 1;
        }
    }
    drop(key);
    if std::env::args().nth(2).as_deref() == Some("--privacy-only") {
        return Ok(
            json!({"passed":true,"checks":["upstream credential absent from persisted application database files"],"files_scanned":scanned,"provider":channel.provider_id,"model":channel.model}),
        );
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(150))
        .build()
        .map_err(|_| SafeError::storage())?;
    let token = store.local_token()?;
    let start = Instant::now();
    let models = client
        .get("http://127.0.0.1:4310/v1/models")
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|_| {
            SafeError::new(
                503,
                "gateway_unreachable",
                "本地网关无法连接，请先启动 FreeHub。",
            )
        })?;
    if !models.status().is_success() {
        return Err(SafeError::new(
            503,
            "gateway_authentication",
            "本地网关鉴权或模型列表请求失败。",
        ));
    }
    let models: Value = models
        .json()
        .await
        .map_err(|_| SafeError::new(502, "invalid_models", "模型列表格式无效。"))?;
    if !models["data"]
        .as_array()
        .is_some_and(|a| a.iter().any(|m| m["id"] == channel.public_model()))
    {
        return Err(SafeError::new(
            502,
            "missing_model",
            "已保存模型没有出现在网关列表中。",
        ));
    }
    for streaming in [false, true] {
        let mut body = json!({"model":channel.public_model(),"messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":32,"stream":streaming});
        if channel.provider_id == "zhipu-bigmodel" {
            body["thinking"] = json!({"type":"disabled"});
        }
        let response = client
            .post("http://127.0.0.1:4310/v1/chat/completions")
            .bearer_auth(token.as_str())
            .json(&body)
            .send()
            .await
            .map_err(|_| SafeError::new(503, "gateway_request_failed", "本地网关测试请求失败。"))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            // Only consume controlled error identifiers; never print the response body.
            let value: Value = response.json().await.unwrap_or(Value::Null);
            let code = value["error"]["code"]
                .as_str()
                .unwrap_or("gateway_request_failed");
            let known = [
                "upstream_authentication",
                "upstream_permission",
                "upstream_rate_limit",
                "upstream_request",
                "upstream_unavailable",
                "network_error",
                "upstream_timeout",
                "invalid_stream",
                "model_not_found",
                "unauthorized",
            ];
            return Err(SafeError::new(
                status,
                if known.contains(&code) {
                    code
                } else {
                    "gateway_request_failed"
                },
                "真实渠道调用未通过，请按错误类别检查账户、网络和模型。",
            ));
        }
        if streaming {
            let mut source = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(piece) = source.next().await {
                let piece = piece
                    .map_err(|_| SafeError::new(502, "stream_interrupted", "真实流式测试中断。"))?;
                if bytes.len() + piece.len() > 1024 * 1024 {
                    return Err(SafeError::new(502, "response_limit", "测试响应超出预期。"));
                }
                bytes.extend_from_slice(&piece);
            }
            if !bytes.ends_with(b"data: [DONE]\n\n") {
                return Err(SafeError::new(
                    502,
                    "stream_incomplete",
                    "真实流式测试没有正常结束。",
                ));
            }
        } else {
            let value: Value = response
                .json()
                .await
                .map_err(|_| SafeError::new(502, "invalid_response", "真实普通调用格式无效。"))?;
            if !value["choices"].as_array().is_some_and(|a| !a.is_empty()) {
                return Err(SafeError::new(
                    502,
                    "empty_response",
                    "真实普通调用没有返回结果。",
                ));
            }
        }
    }
    Ok(
        json!({"passed":true,"provider":channel.provider_id,"model":channel.model,"checks":["saved channel appears in authenticated local model list","real non-streaming inference through desktop gateway","real SSE inference through desktop gateway with DONE"],"duration_ms":start.elapsed().as_millis(),"cherry_studio":"pending actual client acceptance"}),
    )
}

#[tokio::main]
async fn main() {
    match check().await {
        Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap()),
        Err(error) => {
            println!(
                "{}",
                json!({"passed":false,"code":error.code,"message":error.message,"status":error.status})
            );
            std::process::exit(1);
        }
    }
}
