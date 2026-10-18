//! Optional LiteLLM metadata enrichment. `/models` remains the authoritative list.
//!
//! The small, exact model/effort facts below are extracted from ZCode's public
//! modelRules, Apache-2.0, pinned at aac4755666d09fdcd70272fcf063c077a639015f:
//! https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/config/provider/zcode-builtin.json
//! Original license and notices are retained in third-party/zcode-runtime/upstream.
//! These facts describe the mapped upstream model, not proof that a relay accepts
//! its parameters. No upstream program, executable option maps or network calls
//! to public registries are used here.

use super::channel_center::{ChannelModel, ChannelSource};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use url::Url;

pub(super) const REGISTRY_SOURCE: &str = "https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/config/provider/zcode-builtin.json";
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const SUCCESS_TTL: Duration = Duration::from_secs(300);
const FAILURE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Default)]
struct Supplement {
    context: Option<u64>,
    context_limits: Option<Vec<u64>>,
    output: Option<u64>,
    efforts: Option<Vec<String>>,
    source: Option<String>,
    transport: Option<String>,
}

type Catalog = BTreeMap<String, Supplement>;
struct Cached {
    until: Instant,
    catalog: Option<Arc<Catalog>>,
}
type Cache = BTreeMap<[u8; 32], Cached>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

/// Only explicitly identified LiteLLM channels receive this optional request.
pub(super) async fn enrich(channel: &ChannelSource, models: &mut [ChannelModel]) {
    enrich_official(channel, models);
    if channel.auth_kind != "api_key"
        || channel.protocol != "openai_chat"
        || !channel.name.trim().eq_ignore_ascii_case("litellm")
        || channel.api_key.trim().is_empty()
    {
        return;
    }
    let Some(endpoint) = info_endpoint(&channel.base_url) else {
        return;
    };
    let key = cache_key(&endpoint, &channel.api_key);
    let cached = {
        let cache = CACHE.get_or_init(|| Mutex::new(BTreeMap::new()));
        cache.lock().ok().and_then(|entries| {
            entries
                .get(&key)
                .filter(|entry| entry.until > Instant::now())
                .map(|entry| entry.catalog.clone())
        })
    };
    let catalog = if let Some(cached) = cached {
        cached
    } else {
        let fetched = fetch(&endpoint, &channel.api_key).await.map(Arc::new);
        if let Ok(mut cache) = CACHE.get_or_init(|| Mutex::new(BTreeMap::new())).lock() {
            let now = Instant::now();
            cache.retain(|_, entry| entry.until > now);
            if cache.len() >= 64 {
                if let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, entry)| entry.until)
                    .map(|(key, _)| *key)
                {
                    cache.remove(&oldest);
                }
            }
            let ttl = if fetched.is_some() {
                SUCCESS_TTL
            } else {
                FAILURE_TTL
            };
            cache.insert(
                key,
                Cached {
                    until: now + ttl,
                    catalog: fetched.clone(),
                },
            );
        }
        fetched
    };
    if let Some(catalog) = catalog {
        apply(models, &catalog);
    }
}

/// Public, pinned model facts for exact official origins and canonical IDs.
/// This is a local lookup: credentials never go to a public registry, and no
/// thinking/effort option-map is inferred from the upstream model's enum.
fn enrich_official(channel: &ChannelSource, models: &mut [ChannelModel]) {
    let Ok(url) = Url::parse(&channel.base_url) else {
        return;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_some()
    {
        return;
    }
    let path = url.path().trim_end_matches('/');
    let provider = match (url.host_str(), path) {
        (Some("api.deepseek.com"), "" | "/v1" | "/anthropic") => "deepseek",
        (Some("api.openai.com"), "" | "/v1") => "openai",
        (Some("api.anthropic.com"), "" | "/v1") => "anthropic",
        (Some("api.moonshot.cn" | "api.moonshot.ai"), "" | "/v1" | "/anthropic") => "moonshot",
        (
            Some("api.z.ai" | "open.bigmodel.cn"),
            "/api/paas/v4" | "/api/anthropic" | "/api/coding/paas/v4",
        ) => "zai",
        _ => return,
    };
    for model in models {
        if model.reasoning_efforts.is_some() {
            continue;
        }
        // A canonical unprefixed ID is required on official endpoints too.
        if model.id.contains('/') {
            continue;
        }
        if let Some(efforts) = registry_efforts(&model.id, Some(provider)) {
            model.reasoning_efforts = Some(efforts.iter().map(|value| (*value).into()).collect());
            model.reasoning_effort_source = Some(REGISTRY_SOURCE.into());
            model.reasoning_effort_transport = Some("unconfirmed".into());
        }
    }
}

fn info_endpoint(base: &str) -> Option<Url> {
    let mut endpoint = Url::parse(base.trim()).ok()?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return None;
    }
    let path = endpoint.path().trim_end_matches('/');
    let root = path.strip_suffix("/v1").unwrap_or(path);
    endpoint.set_path(&format!("{root}/model/info"));
    Some(endpoint)
}

fn cache_key(endpoint: &Url, credential: &str) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(endpoint.as_str().as_bytes());
    digest.update([0]);
    digest.update(credential.as_bytes());
    digest.finalize().into()
}

async fn fetch(endpoint: &Url, credential: &str) -> Option<Catalog> {
    // A separate no-redirect client is essential: a directory's Location header
    // must never send the channel credential to another host (or another path).
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .connect_timeout(Duration::from_millis(1500));
    if let Some(proxy) = crate::proxy::http_client::get_current_proxy_url() {
        builder = builder.proxy(reqwest::Proxy::all(proxy).ok()?);
    } else if endpoint.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    }) {
        builder = builder.no_proxy();
    }
    let client = builder.build().ok()?;
    let mut response = client
        .get(endpoint.clone())
        .bearer_auth(credential)
        .send()
        .await
        .ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    parse(&value)
}

fn parse(value: &Value) -> Option<Catalog> {
    let entries = value.get("data")?.as_array()?;
    if entries.len() > 10_000 {
        return None;
    }
    let mut grouped: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for entry in entries {
        let Some(name) = entry
            .get("model_name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty() && name.len() <= 2048)
        else {
            continue;
        };
        grouped.entry(name).or_default().push(entry);
    }
    Some(
        grouped
            .into_iter()
            .map(|(name, deployments)| (name.into(), aggregate(&deployments)))
            .collect(),
    )
}

fn aggregate(deployments: &[&Value]) -> Supplement {
    let mut supplement = Supplement::default();
    let mut efforts: Option<Vec<String>> = None;
    let mut complete = true;
    let mut registry_used = false;
    let mut declared = 0;
    let mut windows: Option<Vec<u64>> = None;
    let mut windows_complete = true;
    for deployment in deployments {
        let info = deployment.get("model_info").unwrap_or(&Value::Null);
        let metadata = super::model_fetch::declared_model_metadata(info);
        supplement.context = minimum(supplement.context, metadata.context_limit);
        match metadata.context_limits {
            Some(current) => match &mut windows {
                Some(shared) => shared.retain(|limit| current.contains(limit)),
                None => windows = Some(current),
            },
            None => windows_complete = false,
        }
        supplement.output = minimum(
            supplement.output,
            metadata
                .output_limit
                .or_else(|| positive(info.get("max_tokens"))),
        );
        let transport_declared = info
            .get("supported_openai_params")
            .and_then(Value::as_array)
            .is_some_and(|params| {
                params
                    .iter()
                    .any(|param| param.as_str() == Some("reasoning_effort"))
            });
        declared += usize::from(transport_declared);
        let values = if info.get("supports_reasoning").and_then(Value::as_bool) == Some(false) {
            // An explicit relay denial outranks a registry's upstream capability.
            Some(Vec::new())
        } else {
            metadata.reasoning_efforts.or_else(|| {
                let mapped = mapped_efforts(deployment);
                registry_used |= mapped.is_some();
                mapped
            })
        };
        match values {
            Some(values) => match &mut efforts {
                None => efforts = Some(values),
                Some(common) => common.retain(|value| values.contains(value)),
            },
            None => complete = false,
        }
    }
    // Missing mappings are unknown, rather than permission to borrow another
    // deployment's enum. This also prevents alias-prefix/name heuristics.
    if complete {
        supplement.efforts = efforts;
        supplement.source = supplement.efforts.as_ref().map(|_| {
            if registry_used {
                REGISTRY_SOURCE
            } else {
                "litellm:model-info"
            }
            .into()
        });
    }
    supplement.transport = Some(
        if declared == deployments.len() {
            "declared"
        } else if declared > 0 {
            "mixed"
        } else {
            // An omitted parameter is not proof that the route rejects it.
            "unconfirmed"
        }
        .into(),
    );
    if windows_complete {
        supplement.context_limits = windows.filter(|windows| !windows.is_empty());
    }
    supplement
}

fn minimum(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}
fn positive(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .filter(|value| *value > 0)
}

fn mapped_efforts(deployment: &Value) -> Option<Vec<String>> {
    let provider = deployment
        .pointer("/model_info/litellm_provider")
        .and_then(Value::as_str);
    let mapped = [
        deployment.pointer("/litellm_params/model"),
        deployment.pointer("/model_info/base_model"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .find_map(|model| registry_efforts(model, provider));
    mapped.map(|values| values.iter().map(|value| (*value).into()).collect())
}

fn registry_efforts(model: &str, provider: Option<&str>) -> Option<&'static [&'static str]> {
    // Only explicit upstream mappings are matched. In particular, a published
    // relay alias such as `claude-gpt-*` never enters this lookup by itself.
    let (kind, id) = model
        .split_once('/')
        .map(|(kind, id)| (Some(kind), id))
        .unwrap_or((provider, model));
    match (kind?, id) {
        ("openai", "gpt-6-astra") | ("anthropic", "claude-opus-5-5" | "claude-sonnet-5-5") => {
            Some(&["low", "medium", "high", "xhigh", "max"])
        }
        ("zai", "glm-5.1") => Some(&["disabled", "enabled"]),
        ("zai", "glm-5.3-flash") | ("moonshot", "kimi-k3") => Some(&["low", "high", "max"]),
        (
            "deepseek",
            "deepseek-flash"
            | "deepseek-v4-pro"
            | "deepseek-v4-flash"
            | "deepseek-v4.1-flash"
            | "deepseek-v4-1-flash",
        ) => Some(&["disabled", "low", "high", "max"]),
        _ => None,
    }
}

fn apply(models: &mut [ChannelModel], catalog: &Catalog) {
    for model in models {
        let Some(extra) = catalog.get(&model.id) else {
            // Failed requests never call apply; a valid directory missing this
            // alias invalidates earlier helper inferences for that alias.
            if model.reasoning_efforts.is_none() {
                model.reasoning_effort_transport = Some("unconfirmed".into());
            }
            continue;
        };
        model.context_limit = model.context_limit.or(extra.context);
        model.context_limits = model
            .context_limits
            .take()
            .or_else(|| extra.context_limits.clone());
        model.output_limit = model.output_limit.or(extra.output);
        if model.reasoning_efforts.is_none() {
            model.reasoning_efforts = extra.efforts.clone();
            model.reasoning_effort_source = extra.source.clone();
            model.reasoning_effort_transport = extra.transport.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Json, Router};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn model(id: &str) -> ChannelModel {
        serde_json::from_value(json!({"id":id,"enabled":false})).unwrap()
    }
    fn channel(base: String) -> ChannelSource {
        serde_json::from_value(json!({"id":"fixture","name":"LiteLLM","baseUrl":base,"apiKey":"fixture-private-key","authKind":"api_key","protocol":"openai_chat"})).unwrap()
    }
    fn deployment(name: &str, upstream: &str, context: u64, params: Value) -> Value {
        json!({"model_name":name,"litellm_params":{"model":upstream,"api_key":"never-publish-me"},"model_info":{"max_input_tokens":context,"max_output_tokens":8000,"supported_openai_params":params}})
    }
    async fn server(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        (
            format!("http://{address}/v1"),
            tokio::spawn(async move { axum::serve(listener, router).await.unwrap() }),
        )
    }

    #[test]
    fn context_windows_require_explicit_choices_shared_by_every_deployment() {
        let a = json!({"model_info":{"context_window":128000,"context_windows":[128000,1000000]}});
        let b = json!({"model_info":{"context_window":128000,"context_windows":[128000,256000]}});
        assert_eq!(aggregate(&[&a, &b]).context_limits, Some(vec![128000]));
        let scalar = json!({"model_info":{"context_window":1000000}});
        assert_eq!(aggregate(&[&a, &scalar]).context_limits, None);
    }

    #[test]
    fn exact_mappings_intersect_all_routes_without_overwriting_relay_metadata() {
        let raw = json!({"data":[
            deployment("alias", "openai/gpt-6-astra", 200000, json!(["reasoning_effort"])),
            deployment("alias", "deepseek/deepseek-flash", 128000, json!(["thinking"])),
            deployment("claude-gpt-6-astra", "unknown-company-model", 64000, json!([])),
            deployment("not-published", "openai/gpt-6-astra", 32000, json!([]))
        ]});
        let catalog = parse(&raw).unwrap();
        let mut models = vec![model("alias"), model("claude-gpt-6-astra")];
        models[0].output_limit = Some(4000);
        apply(&mut models, &catalog);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].context_limit, Some(128000));
        assert_eq!(models[0].output_limit, Some(4000));
        assert_eq!(
            models[0].reasoning_efforts,
            Some(vec!["low".into(), "high".into(), "max".into()])
        );
        assert_eq!(
            models[0].reasoning_effort_transport.as_deref(),
            Some("mixed")
        );
        assert_eq!(
            models[0].reasoning_effort_source.as_deref(),
            Some(REGISTRY_SOURCE)
        );
        assert_eq!(models[0].enabled, Some(false));
        assert!(models[1].reasoning_efforts.is_none());
        assert!(!serde_json::to_string(&models)
            .unwrap()
            .contains("never-publish-me"));
    }

    #[test]
    fn absent_mappings_and_unconfirmed_parameters_are_not_invented() {
        let catalog = parse(&json!({"data":[
            deployment("incomplete", "openai/gpt-6-astra", 200000, json!(["reasoning_effort"])),
            deployment("incomplete", "unknown/model", 64000, json!([])),
            deployment("glm", "zai/glm-5.1", 200000, json!(["thinking"]))
        ]}))
        .unwrap();
        assert!(catalog["incomplete"].efforts.is_none());
        let mut models = vec![model("incomplete"), model("missing")];
        apply(&mut models, &catalog);
        assert!(models[0].reasoning_efforts.is_none());
        assert_eq!(
            models[0].reasoning_effort_transport.as_deref(),
            Some("mixed")
        );
        assert!(models[1].reasoning_efforts.is_none());
        assert_eq!(
            models[1].reasoning_effort_transport.as_deref(),
            Some("unconfirmed")
        );
        assert_eq!(catalog["glm"].transport.as_deref(), Some("unconfirmed"));
        assert!(parse(&json!({"models":[]})).is_none());
        assert!(info_endpoint("https://key@example.test/v1").is_none());
        assert!(info_endpoint("https://example.test/v1?key=secret").is_none());
        assert_eq!(
            info_endpoint("https://example.test/tenant/v1")
                .unwrap()
                .path(),
            "/tenant/model/info"
        );
    }

    #[test]
    fn explicit_relay_enum_and_limits_always_remain_authoritative() {
        let catalog = parse(&json!({"data":[deployment("alias", "openai/gpt-6-astra", 200000, json!(["reasoning_effort"]))]})).unwrap();
        let mut models = vec![model("alias")];
        models[0].context_limit = Some(32000);
        models[0].reasoning_efforts = Some(Vec::new());
        apply(&mut models, &catalog);
        assert_eq!(models[0].context_limit, Some(32000));
        assert_eq!(models[0].reasoning_efforts, Some(Vec::new()));
        assert!(models[0].reasoning_effort_source.is_none());
    }

    #[tokio::test]
    async fn official_origins_enrich_exact_canonical_ids_without_requests_or_alias_guesses() {
        let mut source = channel("https://api.deepseek.com/v1".into());
        source.name = "My DeepSeek account".into();
        let mut models = vec![
            model("deepseek-flash"),
            model("deepseek-v4-pro"),
            model("claude-deepseek-flash"),
            model("deepseek-chat"),
        ];
        enrich(&source, &mut models).await;
        assert_eq!(
            models[0].reasoning_efforts.as_deref(),
            Some(&["disabled".into(), "low".into(), "high".into(), "max".into()][..])
        );
        assert_eq!(
            models[1].reasoning_effort_source.as_deref(),
            Some(REGISTRY_SOURCE)
        );
        assert_eq!(
            models[1].reasoning_effort_transport.as_deref(),
            Some("unconfirmed")
        );
        assert!(models[2].reasoning_efforts.is_none());
        assert!(models[3].reasoning_efforts.is_none());
        for base in [
            "https://api.deepseek.com.evil.test/v1",
            "https://company.test/v1",
            "https://api.deepseek.com/tenant/v1",
        ] {
            source.base_url = base.into();
            let mut models = vec![model("deepseek-flash")];
            enrich(&source, &mut models).await;
            assert!(models[0].reasoning_efforts.is_none());
        }
        source.base_url = "https://api.deepseek.com/v1".into();
        let mut models = vec![model("deepseek-flash")];
        models[0].reasoning_efforts = Some(vec!["relay-specific".into()]);
        enrich(&source, &mut models).await;
        assert_eq!(
            models[0].reasoning_efforts,
            Some(vec!["relay-specific".into()])
        );
    }

    #[test]
    fn declared_info_enums_work_without_registry_mapping_and_denials_win() {
        let catalog = parse(&json!({"data":[
            {"model_name":"custom","model_info":{"supported_reasoning_efforts":["minimal","high"],"supported_openai_params":["reasoning_effort"]}},
            {"model_name":"denied","litellm_params":{"model":"openai/gpt-6-astra"},"model_info":{"supports_reasoning":false}},
            {"model_name":"base","litellm_params":{"model":"private/unknown"},"model_info":{"base_model":"openai/gpt-6-astra","supported_openai_params":[]}}
        ]})).unwrap();
        assert_eq!(
            catalog["custom"].efforts,
            Some(vec!["minimal".into(), "high".into()])
        );
        assert_eq!(
            catalog["custom"].source.as_deref(),
            Some("litellm:model-info")
        );
        assert_eq!(catalog["custom"].transport.as_deref(), Some("declared"));
        assert_eq!(catalog["denied"].efforts, Some(Vec::new()));
        assert_eq!(
            catalog["denied"].source.as_deref(),
            Some("litellm:model-info")
        );
        assert!(catalog["base"]
            .efforts
            .as_ref()
            .unwrap()
            .contains(&"xhigh".into()));
    }

    #[tokio::test]
    async fn auxiliary_errors_and_redirects_never_send_the_key_elsewhere() {
        let leaked = Arc::new(AtomicUsize::new(0));
        let received = leaked.clone();
        let (other, other_task) = server(Router::new().fallback(get(move || {
            received.fetch_add(1, Ordering::SeqCst);
            async { "unexpected" }
        })))
        .await;
        let target = format!("{other}/model/info");
        let (base, task) = server(Router::new().route(
            "/model/info",
            get(move || {
                let target = target.clone();
                async move {
                    (
                        axum::http::StatusCode::FOUND,
                        [(axum::http::header::LOCATION, target)],
                    )
                }
            }),
        ))
        .await;
        let mut models = vec![model("keep")];
        enrich(&channel(base), &mut models).await;
        assert_eq!(models[0].id, "keep");
        assert_eq!(leaked.load(Ordering::SeqCst), 0);
        task.abort();
        other_task.abort();
        let (base, task) = server(Router::new()).await;
        enrich(&channel(base), &mut models).await;
        assert_eq!(models[0].id, "keep");
        task.abort();
    }

    #[tokio::test]
    async fn same_origin_metadata_is_cached_per_credential_and_never_for_other_channels() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let (base, task) = server(Router::new().route("/model/info", get(move |headers: axum::http::HeaderMap| {
            observed.fetch_add(1, Ordering::SeqCst);
            assert!(headers.get("authorization").unwrap().to_str().unwrap().starts_with("Bearer fixture-"));
            async { Json(json!({"data":[deployment("alias", "openai/gpt-6-astra", 200000, json!(["reasoning_effort"]))]})) }
        }))).await;
        let mut source = channel(base);
        let mut models = vec![model("alias")];
        enrich(&source, &mut models).await;
        assert_eq!(
            models[0].reasoning_effort_transport.as_deref(),
            Some("declared")
        );
        enrich(&source, &mut models).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        source.api_key = "fixture-another-key".into();
        enrich(&source, &mut models).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        source.protocol = "anthropic".into();
        source.api_key = "fixture-never-send-native-protocol".into();
        enrich(&source, &mut models).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        source.protocol = "openai_chat".into();
        source.name = "Other relay".into();
        enrich(&source, &mut models).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        task.abort();
    }
}
