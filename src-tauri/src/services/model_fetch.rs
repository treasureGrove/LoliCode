//! 模型列表获取服务
//!
//! 通过 OpenAI 兼容的 GET /v1/models 端点获取供应商可用模型列表。
//! 主要面向第三方聚合站（硅基流动、OpenRouter 等），以及把 Anthropic
//! 协议挂在兼容子路径上的官方供应商（DeepSeek、Kimi、智谱 GLM 等）。

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, USER_AGENT};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;

/// 获取到的模型信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    pub owned_by: Option<String>,
    #[serde(default, flatten)]
    pub metadata: FetchedModelMetadata,
}

/// Only fields actually advertised by the returned directory. No name-based
/// presets or inference requests are used to fill absent capabilities.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModelMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limits: Option<Vec<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_efforts: Option<Vec<String>>,
}

fn declared_efforts(values: &[serde_json::Value]) -> Option<Vec<String>> {
    let mut efforts = Vec::new();
    for value in values {
        let Some(effort) = value.as_str().or_else(|| {
            value
                .get("effort")
                .or_else(|| value.get("value"))
                .and_then(serde_json::Value::as_str)
        }) else {
            continue;
        };
        let effort = effort.trim();
        if !effort.is_empty()
            && effort.len() <= 64
            && effort
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            && !efforts.iter().any(|saved| saved == effort)
        {
            efforts.push(effort.to_string());
        }
    }
    // Empty is an explicit declaration; malformed nonempty input is unknown.
    (values.is_empty() || !efforts.is_empty()).then_some(efforts)
}

/// A window enum describes choices, not additional input/output ceilings.
/// Never infer windows from a model name or turn a numeric range into an enum.
pub(super) fn declared_context_windows(
    entry: &serde_json::Value,
) -> (Option<u64>, Option<Vec<u64>>) {
    use serde_json::Value;
    fn tokens(value: &Value) -> Option<u64> {
        value
            .as_u64()
            .or_else(|| value.as_str()?.parse().ok())
            .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
    }
    fn option(value: &Value) -> Option<u64> {
        tokens(value).or_else(|| {
            [
                "value",
                "tokens",
                "contextLimit",
                "context_window",
                "context_length",
            ]
            .iter()
            .find_map(|key| value.get(*key).and_then(tokens))
        })
    }
    const SCALARS: &[&str] = &[
        "/context_window",
        "/contextWindow",
        "/context_limit",
        "/contextLimit",
        "/context_length",
        "/contextLength",
        "/context/length",
        "/max_context_tokens",
        "/maxContextTokens",
        "/maxContextLength",
        "/maxContextWindowTokens",
        "/max_model_len",
        "/max_model_length",
        "/max_sequence_length",
        "/max_seq_len",
        "/max_position_embeddings",
        "/inputTokenLimit",
        "/maxInputTokens",
        "/max_input_tokens",
        "/input_token_limit",
        "/max_prompt_tokens",
        "/limits/context_length",
        "/limits/context_window",
        "/limits/max_context_tokens",
        "/limits/max_input_tokens",
        "/capabilities/limits/max_prompt_tokens",
        "/capabilities/limits/max_context_tokens",
        "/capabilities/limits/max_context_window_tokens",
        "/limit/context",
    ];
    let default = SCALARS.iter().find_map(|pointer| {
        let value = entry.pointer(pointer)?;
        tokens(value).or_else(|| value.get("default").and_then(tokens))
    });
    // Copilot publishes selectable prompt budgets as billing tiers, not as a
    // `context_windows` array. These are explicit choices; the total model
    // window and the output ceiling are not extra context presets.
    if let Some(prices) = entry.pointer("/billing/token_prices") {
        let tier = |name: &str| {
            let value = prices.get(name)?;
            value
                .get("max_prompt_tokens")
                .and_then(tokens)
                .or_else(|| value.get("context_max").and_then(tokens))
                .map(|limit| default.map_or(limit, |ceiling| limit.min(ceiling)))
        };
        if let Some(standard) = tier("default") {
            // Free long context can omit the separate price tier; the
            // official client still offers the published full prompt budget.
            let windows = tier("long_context")
                .or(default)
                .filter(|long| *long > standard)
                .map(|long| vec![standard, long]);
            return (Some(standard), windows);
        }
    }
    let mut windows = Vec::new();
    for pointer in SCALARS.iter().copied().chain([
        "/context_windows",
        "/contextWindows",
        "/context_limits",
        "/contextLimits",
        "/supported_context_windows",
        "/supported_context_lengths",
        "/supported_context_limits",
        "/limits/context_windows",
        "/capabilities/limits/context_windows",
        "/parameters/context_window/enum",
        "/parameters/context_length/enum",
    ]) {
        let Some(value) = entry.pointer(pointer) else {
            continue;
        };
        let Some(values) = value
            .as_array()
            .or_else(|| value.get("enum").and_then(Value::as_array))
            .or_else(|| value.get("options").and_then(Value::as_array))
        else {
            continue;
        };
        windows.extend(values.iter().filter_map(option));
    }
    if !windows.is_empty() {
        // An input ceiling can reserve space for output and need not be a
        // selectable context window. Only a direct context declaration may
        // add a default outside the enum.
        if let Some(explicit) = SCALARS[..7].iter().find_map(|pointer| {
            let value = entry.pointer(pointer)?;
            tokens(value).or_else(|| value.get("default").and_then(tokens))
        }) {
            windows.push(explicit);
        }
        windows.sort_unstable();
        windows.dedup();
        (
            default
                .filter(|value| windows.contains(value))
                .or_else(|| windows.first().copied()),
            Some(windows),
        )
    } else {
        (default, None)
    }
}

pub fn declared_model_metadata(entry: &serde_json::Value) -> FetchedModelMetadata {
    let positive = |pointers: &[&str]| {
        pointers.iter().find_map(|pointer| {
            let value = entry.pointer(pointer)?;
            value
                .as_u64()
                .or_else(|| value.as_str()?.parse::<u64>().ok())
                .filter(|value| *value > 0)
        })
    };
    let reasoning_efforts = [
        "/supported_reasoning_efforts",
        "/supported_reasoning_levels",
        "/supportedReasoningEfforts",
        "/reasoning_efforts",
        "/reasoningEfforts",
        "/reasoning_effort",
        "/reasoning/efforts",
        "/capabilities/supports/reasoning_effort",
        "/capabilities/reasoning_effort",
        "/capabilities/reasoning/efforts",
        "/capabilities/reasoning/levels",
        "/model_info/supported_reasoning_efforts",
        "/model_info/reasoning_efforts",
        "/supported_parameters/reasoning_effort/enum",
        "/parameters/reasoning_effort/enum",
        "/reasoning/effort/enum",
    ]
    .iter()
    .find_map(|pointer| {
        let values = entry.pointer(pointer)?.as_array()?;
        declared_efforts(values)
    })
    .or_else(|| {
        // Public upstream registries can advertise several independent options.
        // Only a typed effort option supplies legal effort values.
        let options = entry.get("reasoning_options")?.as_array()?;
        let mut values = Vec::new();
        let mut declared = false;
        for option in options {
            if option.get("type").and_then(serde_json::Value::as_str) == Some("effort") {
                if let Some(items) = option.get("values").and_then(serde_json::Value::as_array) {
                    declared = true;
                    values.extend(items.iter().cloned());
                }
            }
        }
        declared.then(|| declared_efforts(&values)).flatten()
    });
    let (context_limit, context_limits) = declared_context_windows(entry);
    FetchedModelMetadata {
        context_limit,
        context_limits,
        output_limit: positive(&[
            "/output_limit",
            "/outputLimit",
            "/maxOutputTokens",
            "/max_output_tokens",
            "/max_completion_tokens",
            "/top_provider/max_completion_tokens",
            "/outputTokenLimit",
            "/output_token_limit",
            "/capabilities/limits/max_output_tokens",
            "/limits/max_output_tokens",
            "/limits/max_completion_tokens",
            "/limit/output",
        ]),
        reasoning_efforts,
    }
}

/// 模型列表响应的兼容格式。
///
/// OpenAI 兼容接口和 Anthropic 接口使用 `data` 字段；Codex 远端模型目录
/// （`{base}/models`，智谱 /api/v1 即此格式）使用 `models[].slug`。
///
/// `models` 收成 `Value` 而非强类型：部分供应商会在 `data` 旁附带任意形状的
/// `models`，而 serde 反序列化的是整个结构体，强类型字段一旦对不上就会连带
/// `data` 一起解析失败（#7593）。
#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Option<Vec<ModelEntry>>,
    models: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
    owned_by: Option<String>,
}

/// `models[]` 条目对应的模型 id：`slug` 优先，回退 OpenAI 风格的 `id`；
/// 非数组、非对象、非字符串或空串一律跳过，绝不报错。
fn catalog_model_ids(models: Option<serde_json::Value>) -> Vec<String> {
    let Some(serde_json::Value::Array(entries)) = models else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|m| {
            ["slug", "id"]
                .iter()
                .find_map(|k| m.get(k)?.as_str().filter(|s| !s.is_empty()))
        })
        .map(str::to_string)
        .collect()
}

const FETCH_TIMEOUT_SECS: u64 = 15;
const MAX_REQUEST_HEADERS: usize = 64;
const MAX_HEADER_NAME_BYTES: usize = 256;
const MAX_HEADER_VALUE_BYTES: usize = 16 * 1024;

/// 404/405 响应体截断长度：避免把几十 KB HTML 404 页整页保留到错误串里。
const ERROR_BODY_MAX_CHARS: usize = 512;

/// 已知的「Anthropic 协议兼容子路径」后缀；按长度降序，最长前缀优先匹配。
/// baseURL 命中这些后缀时，候选列表会追加「剥离后缀再拼 /v1/models / /models」的版本。
const KNOWN_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

/// 获取供应商的可用模型列表
///
/// 使用 OpenAI 兼容的 GET /v1/models 端点，按候选列表顺序尝试。
pub async fn fetch_models(
    base_url: &str,
    api_key: &str,
    is_full_url: bool,
    models_url_override: Option<&str>,
    user_agent: Option<HeaderValue>,
    api_format: Option<&str>,
    request_headers: Option<&BTreeMap<String, String>>,
) -> Result<Vec<FetchedModel>, String> {
    let value = fetch_model_catalog(
        base_url,
        api_key,
        is_full_url,
        models_url_override,
        user_agent,
        api_format,
        request_headers,
    )
    .await?;
    let raw = value.clone();
    let resp: ModelsResponse =
        serde_json::from_value(value).map_err(|e| format!("Failed to parse response: {e}"))?;
    let mut models: Vec<FetchedModel> = if let Some(data) = resp.data {
        data.into_iter()
            .map(|m| {
                let metadata = raw
                    .get("data")
                    .and_then(serde_json::Value::as_array)
                    .and_then(|entries| {
                        entries.iter().find(|entry| {
                            entry.get("id").and_then(serde_json::Value::as_str)
                                == Some(m.id.as_str())
                        })
                    })
                    .map(declared_model_metadata)
                    .unwrap_or_default();
                FetchedModel {
                    id: m.id,
                    owned_by: m.owned_by,
                    metadata,
                }
            })
            .collect()
    } else {
        catalog_model_ids(resp.models)
            .into_iter()
            .map(|id| FetchedModel {
                metadata: raw
                    .get("models")
                    .and_then(serde_json::Value::as_array)
                    .and_then(|entries| {
                        entries.iter().find(|entry| {
                            ["slug", "id"].iter().any(|field| {
                                entry.get(field).and_then(serde_json::Value::as_str)
                                    == Some(id.as_str())
                            })
                        })
                    })
                    .map(declared_model_metadata)
                    .unwrap_or_default(),
                id,
                owned_by: None,
            })
            .collect()
    };
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

/// Raw catalog access for consumers that retain declared capabilities and protocol metadata.
/// Shares endpoint fallback, auth validation, timeout and strict redaction with the legacy API.
pub async fn fetch_model_catalog(
    base_url: &str,
    api_key: &str,
    is_full_url: bool,
    models_url_override: Option<&str>,
    user_agent: Option<HeaderValue>,
    api_format: Option<&str>,
    request_headers: Option<&BTreeMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let candidates = build_models_url_candidates(base_url, is_full_url, models_url_override)?;
    let headers =
        build_model_fetch_headers(api_key, api_format, user_agent.as_ref(), request_headers)?;
    let client = crate::proxy::http_client::get();
    let mut last_err: Option<String> = None;
    let mut known_secrets = vec![api_key.to_string()];
    if let Some(request_headers) = request_headers {
        known_secrets.extend(request_headers.values().cloned());
    }

    for url in &candidates {
        log::debug!(
            "[ModelFetch] Trying endpoint: {}",
            crate::url_for_log_with_secrets(url, &known_secrets)
        );
        let request = client
            .get(url)
            .headers(headers.clone())
            .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS));
        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                return Err(format!("Request failed: {e}"));
            }
        };

        let status = response.status();

        if status.is_success() {
            let resp: serde_json::Value = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {e}"))?;

            return Ok(resp);
        }

        if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
            let body = redact_model_fetch_error_body(
                response.text().await.unwrap_or_default(),
                &known_secrets,
            );
            last_err = Some(format!("HTTP {status}: {body}"));
            continue;
        }

        let body = redact_model_fetch_error_body(
            response.text().await.unwrap_or_default(),
            &known_secrets,
        );
        return Err(format!("HTTP {status}: {body}"));
    }

    Err(format!(
        "All candidates failed: {}",
        last_err.unwrap_or_else(|| "no candidates".to_string())
    ))
}

fn redact_model_fetch_error_body(body: String, known_secrets: &[String]) -> String {
    truncate_body(crate::redact_known_secrets_strict(&body, known_secrets))
}

fn build_model_fetch_headers(
    api_key: &str,
    api_format: Option<&str>,
    user_agent: Option<&HeaderValue>,
    request_headers: Option<&BTreeMap<String, String>>,
) -> Result<HeaderMap, String> {
    let custom_count = request_headers.map_or(0, BTreeMap::len);
    if api_key.is_empty() && custom_count == 0 {
        return Err("API Key or request headers are required to fetch models".to_string());
    }
    if custom_count > MAX_REQUEST_HEADERS {
        return Err(format!(
            "Too many model-fetch request headers (maximum {MAX_REQUEST_HEADERS})"
        ));
    }

    let mut headers = HeaderMap::new();
    if !api_key.is_empty() {
        let (name, value) = match api_format {
            Some("anthropic-messages") => (
                HeaderName::from_static("x-api-key"),
                HeaderValue::from_str(api_key)
                    .map_err(|error| format!("Invalid API Key header value: {error}"))?,
            ),
            Some("google-generative-ai") => (
                HeaderName::from_static("x-goog-api-key"),
                HeaderValue::from_str(api_key)
                    .map_err(|error| format!("Invalid API Key header value: {error}"))?,
            ),
            _ => (
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {api_key}"))
                    .map_err(|error| format!("Invalid API Key header value: {error}"))?,
            ),
        };
        headers.insert(name, value);
    }

    if let Some(user_agent) = user_agent {
        headers.insert(USER_AGENT, user_agent.clone());
    }

    if let Some(request_headers) = request_headers {
        for (raw_name, raw_value) in request_headers {
            let name = raw_name.trim();
            if name.is_empty() || name.len() > MAX_HEADER_NAME_BYTES {
                return Err(format!("Invalid model-fetch header name: {raw_name}"));
            }
            if raw_value.len() > MAX_HEADER_VALUE_BYTES {
                return Err(format!("Model-fetch header value is too large: {name}"));
            }
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|error| format!("Invalid model-fetch header name {name}: {error}"))?;
            let value = HeaderValue::from_str(raw_value)
                .map_err(|error| format!("Invalid model-fetch header value for {name}: {error}"))?;
            headers.insert(name, value);
        }
    }

    Ok(headers)
}

/// 构造「模型列表端点」的候选 URL 列表
///
/// 候选顺序：
/// 1. `models_url_override` 非空 → 只返回它
/// 2. baseURL 拼 `/v1/models`；若已以版本段 `/v{N}` 结尾（`/v1`、智谱
///    `/api/coding/paas/v4` 等），版本号已在路径里，改拼 `/models`
/// 3. 版本段非 `/v1`（如 `/v4`）时再追加 `/v1/models` 作为兜底次候选
/// 4. 若 baseURL 命中 [`KNOWN_COMPAT_SUFFIXES`]，剥离后缀再拼 `/v1/models`、`/models`
///
/// 结果已去重且保持首次出现顺序。
pub fn build_models_url_candidates(
    base_url: &str,
    is_full_url: bool,
    models_url_override: Option<&str>,
) -> Result<Vec<String>, String> {
    if let Some(raw) = models_url_override {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(vec![trimmed.to_string()]);
        }
    }

    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Base URL is empty".to_string());
    }

    let mut candidates: Vec<String> = Vec::new();

    if is_full_url {
        if let Some(idx) = trimmed.find("/v1/") {
            candidates.push(format!("{}/v1/models", &trimmed[..idx]));
        } else if let Some(idx) = trimmed.rfind('/') {
            let root = &trimmed[..idx];
            if root.contains("://") && root.len() > root.find("://").unwrap() + 3 {
                candidates.push(format!("{root}/v1/models"));
            }
        }
        if candidates.is_empty() {
            return Err("Cannot derive models endpoint from full URL".to_string());
        }
        return Ok(candidates);
    }

    // baseURL 已以版本段 /v{N} 结尾时（如 `/v1`、智谱 `/api/coding/paas/v4`），
    // OpenAI 惯例的模型端点是 `{base}/models`，不能再补 `/v1`
    // （否则 .../coding/paas/v4/v1/models → 404）。
    if ends_with_version_segment(trimmed) {
        candidates.push(format!("{trimmed}/models"));
        // 版本段非 /v1 时，保留旧的 /v1/models 作为兜底次候选（正确路径已在前）。
        if !trimmed.ends_with("/v1") {
            candidates.push(format!("{trimmed}/v1/models"));
        }
    } else {
        candidates.push(format!("{trimmed}/v1/models"));
    }

    if let Some(stripped) = strip_compat_suffix(trimmed) {
        let root = stripped.trim_end_matches('/');
        if !root.is_empty() && root.contains("://") {
            candidates.push(format!("{root}/v1/models"));
            candidates.push(format!("{root}/models"));
        }
    }

    // 候选最多 3 条，线性去重即可，不值得上 HashSet。
    let mut unique: Vec<String> = Vec::with_capacity(candidates.len());
    for url in candidates {
        if !unique.iter().any(|u| u == &url) {
            unique.push(url);
        }
    }

    Ok(unique)
}

/// 截断响应体到 [`ERROR_BODY_MAX_CHARS`] 字符，避免 HTML 404 页占用错误串。
fn truncate_body(body: String) -> String {
    if body.chars().count() <= ERROR_BODY_MAX_CHARS {
        body
    } else {
        let mut s: String = body.chars().take(ERROR_BODY_MAX_CHARS).collect();
        s.push('…');
        s
    }
}

/// 若 baseURL 以任一已知兼容子路径结尾，返回剥离后的剩余部分；否则 `None`。
///
/// 依赖 [`KNOWN_COMPAT_SUFFIXES`] 按长度降序排列，确保最长前缀优先命中
/// （否则 `/anthropic` 会提前匹配掉 `/api/anthropic` 的场景）。
fn strip_compat_suffix(base_url: &str) -> Option<&str> {
    for suffix in KNOWN_COMPAT_SUFFIXES {
        if base_url.ends_with(*suffix) {
            return Some(&base_url[..base_url.len() - suffix.len()]);
        }
    }
    None
}

/// 判断 baseURL 是否以 OpenAI 风格的版本段 `/v{N}` 结尾（`N` 为一个或多个数字），
/// 例如 `/v1`、`.../paas/v4`。这类 URL 版本号已在路径中，模型端点应为
/// `{base}/models`，不能再补 `/v1`（智谱 Coding Plan 即 `.../coding/paas/v4`）。
fn ends_with_version_segment(url: &str) -> bool {
    let last = url.rsplit('/').next().unwrap_or("");
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copilot_billing_tiers_keep_prompt_choices_separate_from_total_and_output_limits() {
        let entry: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/copilot-tiered-model.json"
        ))
        .unwrap();
        for field in ["context_max", "max_prompt_tokens"] {
            let mut value = entry.clone();
            for (name, limit) in [("default", 272000), ("long_context", 922000)] {
                value["billing"]["token_prices"][name] = serde_json::json!({field:limit});
            }
            let metadata = declared_model_metadata(&value);
            assert_eq!(metadata.context_limit, Some(272000));
            assert_eq!(metadata.context_limits, Some(vec![272000, 922000]));
            assert_eq!(metadata.output_limit, Some(128000));
        }
        let mut free = entry.clone();
        free["billing"]["token_prices"]
            .as_object_mut()
            .unwrap()
            .remove("long_context");
        assert_eq!(
            declared_model_metadata(&free).context_limits,
            Some(vec![272000, 922000])
        );
        let mut capped = entry.clone();
        capped["capabilities"]["limits"]["max_prompt_tokens"] = serde_json::json!(272000);
        assert_eq!(declared_model_metadata(&capped).context_limits, None);
        let mut legacy = entry;
        legacy.as_object_mut().unwrap().remove("billing");
        let metadata = declared_model_metadata(&legacy);
        assert_eq!(metadata.context_limit, Some(922000));
        assert_eq!(
            metadata.context_limits, None,
            "different input/output/total ceilings are not presets"
        );
    }

    #[test]
    fn context_window_enums_are_retained_without_inventing_ranges_or_variants() {
        for entry in [
            serde_json::json!({"context_window":[128000,1000000,128000,0,-1,"invalid"]}),
            serde_json::json!({"context_limits":[{"value":128000},{"tokens":"1000000"}]}),
            serde_json::json!({"context_window":{"default":128000,"enum":[128000,1000000]}}),
            serde_json::json!({"parameters":{"context_length":{"enum":["128000",1000000]}}}),
        ] {
            let metadata = declared_model_metadata(&entry);
            assert_eq!(metadata.context_limit, Some(128000));
            assert_eq!(metadata.context_limits, Some(vec![128000, 1000000]));
        }
        assert_eq!(
            declared_model_metadata(&serde_json::json!({"context_window":1000000})).context_limits,
            None
        );
        assert_eq!(
            declared_model_metadata(
                &serde_json::json!({"context_window":{"min":128000,"max":1000000}})
            )
            .context_limits,
            None
        );
        assert_eq!(
            declared_model_metadata(&serde_json::json!({"id":"model-1m"})).context_limit,
            None
        );
        let reserved = declared_model_metadata(&serde_json::json!({
            "max_input_tokens":900000,"context_windows":[128000,1000000]
        }));
        assert_eq!(reserved.context_limit, Some(128000));
        assert_eq!(reserved.context_limits, Some(vec![128000, 1000000]));
    }

    #[test]
    fn capability_enums_and_typed_upstream_options_are_read_without_guessing() {
        for entry in [
            serde_json::json!({"parameters":{"reasoning_effort":{"enum":[" low ",{"value":"high"},"high"]}}}),
            serde_json::json!({"reasoning_options":[{"type":"budget","values":["1024"]},{"type":"effort","values":["low", "high"]}]}),
            serde_json::json!({"model_info":{"supported_reasoning_efforts":["low", "high"]}}),
        ] {
            assert_eq!(
                declared_model_metadata(&entry).reasoning_efforts,
                Some(vec!["low".into(), "high".into()])
            );
        }
        for entry in [
            serde_json::json!({"supports_reasoning":true,"supported_openai_params":["reasoning_effort"]}),
            serde_json::json!({"reasoning_options":[{"type":"budget","values":["1024"]}]}),
            serde_json::json!({"reasoning_efforts":[null, "not an identifier"]}),
        ] {
            assert_eq!(declared_model_metadata(&entry).reasoning_efforts, None);
        }
    }

    #[test]
    fn channel_metadata_retains_codex_efforts_and_router_output_without_model_name_guesses() {
        let metadata = declared_model_metadata(&serde_json::json!({
            "slug":"future-model", "context_window":922000,
            "supported_reasoning_levels":[{"effort":"none","description":"Off"},{"effort":"xhigh","description":"Extra"},{"effort":"xhigh"}],
            "top_provider":{"max_completion_tokens":8192}
        }));
        assert_eq!(metadata.context_limit, Some(922000));
        assert_eq!(metadata.output_limit, Some(8192));
        assert_eq!(
            metadata.reasoning_efforts,
            Some(vec!["none".into(), "xhigh".into()])
        );
        let missing = declared_model_metadata(&serde_json::json!({"id":"gpt-5.3-reasoning"}));
        assert_eq!(missing.context_limit, None);
        assert_eq!(missing.reasoning_efforts, None);
        assert_eq!(
            declared_model_metadata(&serde_json::json!({"reasoning_efforts":[]})).reasoning_efforts,
            Some(vec![])
        );
        assert_eq!(
            declared_model_metadata(
                &serde_json::json!({"context_length":0,"max_output_tokens":-3})
            )
            .output_limit,
            None
        );
    }

    #[test]
    fn model_fetch_headers_follow_pi_api_format() {
        let anthropic =
            build_model_fetch_headers("anthropic-key", Some("anthropic-messages"), None, None)
                .unwrap();
        assert_eq!(anthropic["x-api-key"], "anthropic-key");
        assert!(!anthropic.contains_key(AUTHORIZATION));

        let google =
            build_model_fetch_headers("google-key", Some("google-generative-ai"), None, None)
                .unwrap();
        assert_eq!(google["x-goog-api-key"], "google-key");
        assert!(!google.contains_key(AUTHORIZATION));

        let openai =
            build_model_fetch_headers("openai-key", Some("openai-responses"), None, None).unwrap();
        assert_eq!(openai[AUTHORIZATION], "Bearer openai-key");
    }

    #[test]
    fn model_fetch_headers_allow_validated_header_only_auth_and_overrides() {
        let custom = BTreeMap::from([
            ("Authorization".to_string(), "Token literal".to_string()),
            ("X-Tenant".to_string(), "tenant-a".to_string()),
        ]);
        let headers =
            build_model_fetch_headers("", Some("openai-completions"), None, Some(&custom)).unwrap();
        assert_eq!(headers[AUTHORIZATION], "Token literal");
        assert_eq!(headers["x-tenant"], "tenant-a");

        let override_default =
            BTreeMap::from([("x-api-key".to_string(), "header-managed-key".to_string())]);
        let headers = build_model_fetch_headers(
            "provider-key",
            Some("anthropic-messages"),
            None,
            Some(&override_default),
        )
        .unwrap();
        assert_eq!(headers["x-api-key"], "header-managed-key");
    }

    #[test]
    fn model_fetch_headers_reject_invalid_or_missing_credentials() {
        assert!(build_model_fetch_headers("", None, None, None).is_err());
        let invalid = BTreeMap::from([("bad header".to_string(), "literal-value".to_string())]);
        assert!(build_model_fetch_headers("", None, None, Some(&invalid)).is_err());
    }

    #[test]
    fn model_fetch_error_body_redacts_known_header_credentials() {
        let secrets = vec![
            "short".to_string(),
            "Bearer literal-header-secret".to_string(),
        ];
        let body = redact_model_fetch_error_body(
            "invalid short / Bearer literal-header-secret".to_string(),
            &secrets,
        );
        assert_eq!(body, "invalid [REDACTED] / [REDACTED]");
    }

    #[test]
    fn test_candidates_plain_root() {
        let c = build_models_url_candidates("https://api.siliconflow.cn", false, None).unwrap();
        assert_eq!(c, vec!["https://api.siliconflow.cn/v1/models"]);
    }

    #[test]
    fn test_candidates_trailing_slash() {
        let c = build_models_url_candidates("https://api.example.com/", false, None).unwrap();
        assert_eq!(c, vec!["https://api.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_with_v1() {
        let c = build_models_url_candidates("https://api.example.com/v1", false, None).unwrap();
        assert_eq!(c, vec!["https://api.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_zhipu_coding_paas_v4() {
        // 智谱 Coding Plan 端点以 /v4 版本段结尾：模型端点是 {base}/models，
        // 正确路径必须排在 .../v4/v1/models（404）之前。
        let c =
            build_models_url_candidates("https://open.bigmodel.cn/api/coding/paas/v4", false, None)
                .unwrap();
        assert_eq!(
            c,
            vec![
                "https://open.bigmodel.cn/api/coding/paas/v4/models",
                "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
            ]
        );
    }

    #[test]
    fn test_candidates_zai_coding_paas_v4() {
        let c = build_models_url_candidates("https://api.z.ai/api/coding/paas/v4", false, None)
            .unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.z.ai/api/coding/paas/v4/models",
                "https://api.z.ai/api/coding/paas/v4/v1/models",
            ]
        );
    }

    #[test]
    fn test_ends_with_version_segment() {
        assert!(ends_with_version_segment("https://x.com/v1"));
        assert!(ends_with_version_segment(
            "https://open.bigmodel.cn/api/coding/paas/v4"
        ));
        assert!(ends_with_version_segment("https://x.com/v10"));
        assert!(!ends_with_version_segment("https://x.com/api"));
        assert!(!ends_with_version_segment("https://x.com/vX"));
        assert!(!ends_with_version_segment("https://x.com/models"));
        assert!(!ends_with_version_segment("https://api.siliconflow.cn"));
    }

    #[test]
    fn test_candidates_full_url() {
        let c = build_models_url_candidates(
            "https://proxy.example.com/v1/chat/completions",
            true,
            None,
        )
        .unwrap();
        assert_eq!(c, vec!["https://proxy.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_empty() {
        assert!(build_models_url_candidates("", false, None).is_err());
    }

    #[test]
    fn test_candidates_override_returns_single() {
        let c = build_models_url_candidates(
            "https://api.deepseek.com/anthropic",
            false,
            Some("https://api.deepseek.com/models"),
        )
        .unwrap();
        assert_eq!(c, vec!["https://api.deepseek.com/models"]);
    }

    #[test]
    fn test_candidates_override_empty_falls_through() {
        let c =
            build_models_url_candidates("https://api.siliconflow.cn", false, Some("   ")).unwrap();
        assert_eq!(c, vec!["https://api.siliconflow.cn/v1/models"]);
    }

    #[test]
    fn test_candidates_deepseek_strip_anthropic() {
        let c =
            build_models_url_candidates("https://api.deepseek.com/anthropic", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/v1/models",
                "https://api.deepseek.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_zhipu_strip_api_anthropic() {
        let c = build_models_url_candidates("https://open.bigmodel.cn/api/anthropic", false, None)
            .unwrap();
        assert_eq!(
            c,
            vec![
                "https://open.bigmodel.cn/api/anthropic/v1/models",
                "https://open.bigmodel.cn/v1/models",
                "https://open.bigmodel.cn/models",
            ]
        );
    }

    #[test]
    fn test_candidates_bailian_strip_apps_anthropic() {
        let c = build_models_url_candidates(
            "https://dashscope.aliyuncs.com/apps/anthropic",
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            c,
            vec![
                "https://dashscope.aliyuncs.com/apps/anthropic/v1/models",
                "https://dashscope.aliyuncs.com/v1/models",
                "https://dashscope.aliyuncs.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_stepfun_strip_step_plan() {
        let c =
            build_models_url_candidates("https://api.stepfun.com/step_plan", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.stepfun.com/step_plan/v1/models",
                "https://api.stepfun.com/v1/models",
                "https://api.stepfun.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_doubao_strip_api_coding() {
        let c = build_models_url_candidates(
            "https://ark.cn-beijing.volces.com/api/coding",
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            c,
            vec![
                "https://ark.cn-beijing.volces.com/api/coding/v1/models",
                "https://ark.cn-beijing.volces.com/v1/models",
                "https://ark.cn-beijing.volces.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_rightcode_strip_claude() {
        let c = build_models_url_candidates("https://www.right.codes/claude", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://www.right.codes/claude/v1/models",
                "https://www.right.codes/v1/models",
                "https://www.right.codes/models",
            ]
        );
    }

    #[test]
    fn test_candidates_longer_suffix_wins() {
        // baseURL 以 /api/anthropic 结尾时，应剥离整个 /api/anthropic，
        // 而不是只剥离 /anthropic（那样会得到残缺的 https://.../api 根）。
        let c = build_models_url_candidates("https://api.z.ai/api/anthropic", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.z.ai/api/anthropic/v1/models",
                "https://api.z.ai/v1/models",
                "https://api.z.ai/models",
            ]
        );
    }

    #[test]
    fn test_candidates_no_suffix_no_strip() {
        let c = build_models_url_candidates("https://openrouter.ai/api", false, None).unwrap();
        assert_eq!(c, vec!["https://openrouter.ai/api/v1/models"]);
    }

    #[test]
    fn test_candidates_deduplicate() {
        // 虚构 case：baseURL 就是 "scheme://host"，剥不出子路径，应只有一个候选。
        let c = build_models_url_candidates("https://host.example.com", false, None).unwrap();
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn test_parse_response() {
        let json = r#"{"object":"list","data":[{"id":"gpt-4","object":"model","owned_by":"openai"},{"id":"claude-3-sonnet","object":"model","owned_by":"anthropic"}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();
        assert_eq!(data.len(), 2);
        assert_eq!(data[0].id, "gpt-4");
        assert_eq!(data[0].owned_by.as_deref(), Some("openai"));
        assert_eq!(data[1].id, "claude-3-sonnet");
    }

    #[test]
    fn test_parse_response_no_owned_by() {
        let json = r#"{"object":"list","data":[{"id":"my-model","object":"model"}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();
        assert_eq!(data[0].id, "my-model");
        assert!(data[0].owned_by.is_none());
    }

    #[test]
    fn test_parse_response_empty_data() {
        let json = r#"{"object":"list","data":[]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        assert!(resp.data.unwrap().is_empty());
    }

    #[test]
    fn test_parse_response_with_non_zhipu_models_field() {
        // 回归 #7593：部分供应商的 /models 响应在标准 `data` 之外还附带顶层
        // `models` 字段（条目为 OpenAI 风格的 {id, ...}，无 slug）。整个响应
        // 的反序列化不应因此失败。
        let json = r#"{
            "data": [
                {"id": "model-a", "name": "model-a", "max_tokens": 32000, "context_window": 400000},
                {"id": "model-b", "name": "model-b", "max_tokens": 32000, "context_window": 1000000}
            ],
            "models": [
                {"id": "model-a", "name": "model-a", "max_tokens": 32000, "context_window": 400000},
                {"id": "model-b", "name": "model-b", "max_tokens": 32000, "context_window": 1000000}
            ],
            "success": true
        }"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();
        assert_eq!(data.len(), 2);
        assert_eq!(data[0].id, "model-a");
        assert_eq!(data[1].id, "model-b");
    }

    #[test]
    fn test_catalog_model_ids_slug_then_id() {
        // `models` 条目解析：slug 优先，回退 id，两者皆缺时跳过。
        let json = r#"{"models": [
            {"slug": "glm-4.7"},
            {"id": "openai-shaped"},
            {"name": "neither-slug-nor-id"},
            {}
        ]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let ids = catalog_model_ids(resp.models);
        assert_eq!(
            ids,
            vec!["glm-4.7".to_string(), "openai-shaped".to_string()]
        );
    }

    #[test]
    fn test_parse_response_tolerates_any_models_shape() {
        // #7593：data 合法时，任意形状的 models 都不能让整体解析失败
        for models in [
            r#"["a","b"]"#,
            r#"{"count":1}"#,
            "2",
            r#"[{"slug":"glm","id":123}]"#,
            r#"[{"slug":1}]"#,
        ] {
            let json = format!(r#"{{"data":[{{"id":"model-a"}}],"models":{models}}}"#);
            let resp: ModelsResponse = serde_json::from_str(&json).unwrap();
            assert_eq!(resp.data.unwrap()[0].id, "model-a");
        }
        // 无 data 时：非字符串 id 跳过，slug 照常可用
        let resp: ModelsResponse =
            serde_json::from_str(r#"{"models":[{"slug":"glm","id":123}]}"#).unwrap();
        assert_eq!(catalog_model_ids(resp.models), vec!["glm".to_string()]);
    }
}
