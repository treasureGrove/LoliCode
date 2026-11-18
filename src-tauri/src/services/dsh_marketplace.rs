//! Native DeepSeek Harness Plugin Marketplace service.
//! Supports official-format (Format 1) plugin market indexes, version compatibility
//! checking against LoliCode's pinned DSH runtime, safe SHA-512 verified npm bundle
//! installation, official on-demand subagent bundles, local/Git installs, and
//! runtime profile synchronization into the isolated SDK carrier.

use super::{
    harness_paths::{self, HarnessPaths},
    harness_plugins::{self, BundleEntry},
    inprocess_agent::InprocessAgentState,
};
use crate::config;
use base64::Engine as _;
use chrono::Utc;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256, Sha512};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    sync::{Mutex as StdMutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex as AsyncMutex;
use url::Url;

pub const DEFAULT_INDEX_URL: &str = "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json";

const PRESET_SOURCES: [(&str, &str, &str); 3] = [
    (
        "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json",
        "Awesome DSH Plugin (CDN 加速)",
        "来自 awesome-dsh-plugin.com 的社区官方格式插件索引，推荐默认开启。",
    ),
    (
        "https://dshmarket.com/index.json",
        "DSH Market 镜像",
        "DeepSeek Harness 社区插件市场镜像源。",
    ),
    (
        "https://awesome-dsh-plugin.com/index.json",
        "Awesome DSH Plugin (官方站)",
        "awesome-dsh-plugin 官方直连索引源。",
    ),
];

const ON_DEMAND_OFFICIAL: [(&str, &str, &str, &str, &str); 2] = [
    (
        "@deepseek-ai/dsh-subagent-claude-code",
        "Claude Code 子智能体",
        "Claude Code subagent",
        "使用 Claude Code 原生认证和设置委派单个任务。",
        "Delegate one task to Claude Code using its native authentication and settings.",
    ),
    (
        "@deepseek-ai/dsh-subagent-codex",
        "Codex 子智能体",
        "Codex subagent",
        "使用 Codex 原生认证和设置委派单个任务。",
        "Delegate one task to Codex using its native authentication and settings.",
    ),
];

const DEFAULT_NPM_REGISTRIES: [&str; 2] = [
    "https://registry.npmjs.org",
    "https://registry.npmmirror.com",
];

const MAX_INDEX_BYTES: usize = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: usize = 24 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PACKAGE_FILES: usize = 4096;
const MAX_DETAIL_BYTES: usize = 512 * 1024;
const MAX_DEPS: usize = 256;
const CACHE_TTL_MS: u64 = 600_000;

static MARKET_WRITE_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
static FEED_MEMORY_CACHE: OnceLock<StdMutex<HashMap<String, CachedFeed>>> = OnceLock::new();

fn write_lock() -> &'static AsyncMutex<()> {
    MARKET_WRITE_LOCK.get_or_init(|| AsyncMutex::new(()))
}

fn memory_cache() -> &'static StdMutex<HashMap<String, CachedFeed>> {
    FEED_MEMORY_CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMarketPlugin {
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub installed_at: String,
    pub source_type: String,
    pub source_spec: String,
    #[serde(default)]
    pub registry: Option<String>,
    #[serde(default)]
    pub marketplace_url: Option<String>,
    #[serde(default)]
    pub title: Option<Value>,
    #[serde(default)]
    pub description: Option<Value>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub repository: Option<Value>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub has_bundle: bool,
    #[serde(default)]
    pub has_client: bool,
    #[serde(default)]
    pub patch_files: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceState {
    revision: u64,
    #[serde(default)]
    initialized: bool,
    #[serde(default)]
    sources: Vec<String>,
    #[serde(default)]
    selected_source: Option<String>,
    #[serde(default)]
    installed: Vec<InstalledMarketPlugin>,
    #[serde(default)]
    exemptions: BTreeMap<String, Vec<String>>,
}

impl MarketplaceState {
    fn ensure_defaults(&mut self) -> bool {
        let mut changed = false;
        if !self.initialized {
            self.initialized = true;
            if self.sources.is_empty() {
                self.sources.push(DEFAULT_INDEX_URL.to_owned());
            }
            if self.selected_source.is_none() {
                self.selected_source = self.sources.first().cloned();
            }
            changed = true;
        }
        if self.selected_source.as_ref().is_none_or(|url| !self.sources.contains(url)) {
            let next = self.sources.first().cloned();
            if next != self.selected_source {
                self.selected_source = next;
                changed = true;
            }
        }
        changed
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedMarketBundle {
    pub name: String,
    pub version: String,
    pub patch_files: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSourceSummary {
    pub url: String,
    pub title: Option<Value>,
    pub description: Option<Value>,
    pub plugin_count: Option<usize>,
    pub fetched_at: Option<u64>,
    pub from_cache: bool,
    pub error: Option<String>,
    pub preset_label: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialOnDemandItem {
    pub name: String,
    pub title: String,
    pub title_en: String,
    pub description: String,
    pub description_en: String,
    pub target_version: String,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketOverview {
    pub runtime_version: String,
    pub sources: Vec<MarketSourceSummary>,
    pub presets: Vec<MarketSourcePreset>,
    pub selected_source: Option<String>,
    pub installed: Vec<InstalledMarketPlugin>,
    pub on_demand_official: Vec<OfficialOnDemandItem>,
    pub harness_bundles: Vec<BundleEntry>,
    pub pending_reload: bool,
    pub enabled_count: usize,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSourcePreset {
    pub url: String,
    pub label: String,
    pub description: String,
    pub added: bool,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceQuery {
    pub source_url: Option<String>,
    #[serde(default)]
    pub text: String,
    pub category: Option<String>,
    #[serde(default)]
    pub compatible_only: bool,
    #[serde(default)]
    pub installed_only: bool,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub offset: usize,
    pub limit: Option<usize>,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceCategoryItem {
    pub id: String,
    pub title: Value,
    pub count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedVersionEntry {
    pub version: String,
    pub publish_timestamp: u64,
    pub source_type: String,
    pub registry: Option<String>,
    pub git_url: Option<String>,
    pub git_commit: Option<String>,
    pub git_path: Option<String>,
    pub engines_dsh: Option<String>,
    pub compatible: bool,
    pub exempted: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePluginItem {
    pub name: String,
    pub title: Option<Value>,
    pub description: Option<Value>,
    pub icon: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub repository: Option<Value>,
    pub category: Option<String>,
    pub category_title: Option<Value>,
    pub keywords: Vec<String>,
    pub latest_version: Option<String>,
    pub default_version: Option<String>,
    pub published_at: Option<u64>,
    pub engines_dsh: Option<String>,
    pub compatible: bool,
    pub exempted: bool,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub enabled: bool,
    pub update_available: bool,
    pub source_type: String,
    pub registry: Option<String>,
    pub versions_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePage {
    pub source_url: String,
    pub feed_title: Option<Value>,
    pub feed_description: Option<Value>,
    pub total: usize,
    pub total_in_feed: usize,
    pub fetched_at: Option<u64>,
    pub from_cache: bool,
    pub categories: Vec<MarketplaceCategoryItem>,
    pub items: Vec<MarketplacePluginItem>,
    pub next_offset: Option<usize>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceDetail {
    pub name: String,
    pub runtime_version: String,
    pub title: Option<Value>,
    pub description: Option<Value>,
    pub icon: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub repository: Option<Value>,
    pub category: Option<String>,
    pub category_title: Option<Value>,
    pub keywords: Vec<String>,
    pub versions: Vec<ParsedVersionEntry>,
    pub default_version: Option<String>,
    pub latest_version: Option<String>,
    pub compatible: bool,
    pub exempted: bool,
    pub compatibility_issue: Option<String>,
    pub installed: bool,
    pub enabled: bool,
    pub installed_version: Option<String>,
    pub has_bundle: Option<bool>,
    pub has_client: Option<bool>,
    pub readme: Option<String>,
    pub readme_origin: Option<String>,
    pub readme_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ParsedFeedPlugin {
    name: String,
    title: Option<Value>,
    description: Option<Value>,
    icon: Option<String>,
    author: Option<String>,
    homepage: Option<String>,
    repository: Option<Value>,
    category: Option<String>,
    keywords: Vec<String>,
    versions: Vec<ParsedFeedVersion>,
    search_blob: String,
    title_blob: String,
    latest_timestamp: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ParsedFeedVersion {
    version: String,
    publish_timestamp: u64,
    source_type: String,
    registry: Option<String>,
    git_url: Option<String>,
    git_commit: Option<String>,
    git_path: Option<String>,
    engines_dsh: Option<String>,
}

#[derive(Clone, Debug)]
struct CachedFeed {
    title: Option<Value>,
    description: Option<Value>,
    categories: BTreeMap<String, Value>,
    plugins: Vec<ParsedFeedPlugin>,
    fetched_at: u64,
    error: Option<String>,
    from_cache: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiskCacheRecord {
    fetched_at: u64,
    raw: Value,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn market_root(profile: &Path) -> PathBuf {
    profile.join("agent/dsh-marketplace")
}

fn state_path(profile: &Path) -> PathBuf {
    market_root(profile).join("state.json")
}

fn profile_dir(profile: &Path) -> PathBuf {
    market_root(profile).join("profile")
}

fn cache_dir(profile: &Path) -> PathBuf {
    market_root(profile).join("cache")
}

fn cache_file(profile: &Path, url: &str) -> PathBuf {
    let hex = format!("{:x}", Sha256::digest(url.as_bytes()));
    cache_dir(profile).join(format!("{hex}.json"))
}

fn load_state(profile: &Path) -> Result<MarketplaceState, String> {
    let path = state_path(profile);
    let mut state = if path.is_file() {
        let bytes = fs::read(&path).map_err(|_| "无法读取插件市场配置".to_owned())?;
        serde_json::from_slice::<MarketplaceState>(&bytes)
            .map_err(|_| "插件市场配置格式无效，已保留原文件".to_owned())?
    } else {
        MarketplaceState::default()
    };
    state.ensure_defaults();
    Ok(state)
}

fn save_state(profile: &Path, state: &mut MarketplaceState) -> Result<(), String> {
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or("插件市场版本号溢出")?;
    let root = market_root(profile);
    fs::create_dir_all(&root).map_err(|_| "无法创建插件市场配置目录")?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|_| "插件市场配置编码失败")?;
    config::atomic_write_private(&state_path(profile), &bytes).map_err(|e| e.to_string())
}

pub fn normalize_index_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let parsed = Url::parse(trimmed).map_err(|_| "索引地址格式无效")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("索引地址仅支持 http 或 https 协议".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err("索引地址不能包含用户名、密码或 # 片段".into());
    }
    if parsed.host_str().is_none() {
        return Err("索引地址缺少主机名".into());
    }
    Ok(parsed.to_string())
}

pub fn valid_npm_package_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 214 || name.contains("..") {
        return false;
    }
    let valid_segment = |seg: &str| -> bool {
        if seg.is_empty() || seg == "." || seg == ".." {
            return false;
        }
        let mut chars = seg.bytes();
        let Some(first) = chars.next() else {
            return false;
        };
        if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
            return false;
        }
        seg.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._~-".contains(&b))
    };
    if let Some(rest) = name.strip_prefix('@') {
        let Some((scope, pkg)) = rest.split_once('/') else {
            return false;
        };
        !pkg.contains('/') && valid_segment(scope) && valid_segment(pkg)
    } else {
        !name.contains('/') && valid_segment(name)
    }
}

fn is_installation_owned_peer(name: &str, runtime_modules_dir: Option<&Path>) -> bool {
    if let Some(dir) = runtime_modules_dir {
        if dir.join(name).join("package.json").is_file() {
            return true;
        }
    }
    matches!(
        name,
        "@deepseek-ai/cordis"
            | "@deepseek-ai/schemastery"
            | "@deepseek-ai/dsh"
            | "@deepseek-ai/dsh-base"
            | "@deepseek-ai/dsh-sdk-app"
            | "@deepseek-ai/dsh-app-boot"
    ) || name.starts_with("@deepseek-ai/cordis-")
}

/// Evaluate npm SemVer ranges against a runtime version (matching DSH's `includePrerelease: true`).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ParsedSemver {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<PreIdent>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PreIdent {
    Num(u64),
    Alpha(String),
}

impl Ord for PreIdent {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            (PreIdent::Num(a), PreIdent::Num(b)) => a.cmp(b),
            (PreIdent::Num(_), PreIdent::Alpha(_)) => std::cmp::Ordering::Less,
            (PreIdent::Alpha(_), PreIdent::Num(_)) => std::cmp::Ordering::Greater,
            (PreIdent::Alpha(a), PreIdent::Alpha(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for PreIdent {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn cmp_semver(a: &ParsedSemver, b: &ParsedSemver) -> std::cmp::Ordering {
    (a.major, a.minor, a.patch)
        .cmp(&(b.major, b.minor, b.patch))
        .then_with(|| match (a.pre.is_empty(), b.pre.is_empty()) {
            (true, true) => std::cmp::Ordering::Equal,
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            (false, false) => a.pre.cmp(&b.pre),
        })
}

fn parse_semver(raw: &str) -> Option<ParsedSemver> {
    let trimmed = raw.trim().trim_start_matches(['v', '=']);
    let without_build = trimmed.split('+').next()?;
    let (core, pre_str) = match without_build.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (without_build, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let pre = if let Some(pre_raw) = pre_str {
        if pre_raw.is_empty() {
            return None;
        }
        pre_raw
            .split('.')
            .map(|part| {
                if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) {
                    PreIdent::Num(part.parse().unwrap_or(0))
                } else {
                    PreIdent::Alpha(part.to_owned())
                }
            })
            .collect()
    } else {
        Vec::new()
    };
    Some(ParsedSemver {
        major,
        minor,
        patch,
        pre,
    })
}

fn parse_partial_tuple(raw: &str) -> Option<(Option<u64>, Option<u64>, Option<u64>, Vec<PreIdent>)> {
    let s = raw.trim().trim_start_matches(['v', '=']);
    if s.is_empty() || s == "*" || s.eq_ignore_ascii_case("x") {
        return Some((None, None, None, Vec::new()));
    }
    let without_build = s.split('+').next()?;
    let (core, pre_str) = match without_build.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (without_build, None),
    };
    let mut parts = core.split('.');
    let p0 = parts.next().and_then(|v| {
        if v == "*" || v.eq_ignore_ascii_case("x") {
            None
        } else {
            v.parse::<u64>().ok()
        }
    });
    let p1 = parts.next().and_then(|v| {
        if v == "*" || v.eq_ignore_ascii_case("x") {
            None
        } else {
            v.parse::<u64>().ok()
        }
    });
    let p2 = parts.next().and_then(|v| {
        if v == "*" || v.eq_ignore_ascii_case("x") {
            None
        } else {
            v.parse::<u64>().ok()
        }
    });
    if p0.is_none() && core != "*" && !core.eq_ignore_ascii_case("x") {
        return None;
    }
    let pre = pre_str
        .map(|raw_pre| {
            raw_pre
                .split('.')
                .map(|part| {
                    if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) {
                        PreIdent::Num(part.parse().unwrap_or(0))
                    } else {
                        PreIdent::Alpha(part.to_owned())
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Some((p0, p1, p2, pre))
}

fn comparator_matches(runtime: &ParsedSemver, token: &str) -> Option<bool> {
    let token = token.trim();
    if token.is_empty() || token == "*" || token.eq_ignore_ascii_case("x") {
        return Some(true);
    }
    if let Some(rest) = token.strip_prefix('^') {
        let (maj, min, pat, pre) = parse_partial_tuple(rest)?;
        let Some(maj) = maj else { return Some(true) };
        let lower = ParsedSemver {
            major: maj,
            minor: min.unwrap_or(0),
            patch: pat.unwrap_or(0),
            pre,
        };
        let upper = if maj > 0 {
            ParsedSemver {
                major: maj + 1,
                minor: 0,
                patch: 0,
                pre: vec![PreIdent::Num(0)],
            }
        } else if let Some(m) = min.filter(|&m| m > 0) {
            ParsedSemver {
                major: 0,
                minor: m + 1,
                patch: 0,
                pre: vec![PreIdent::Num(0)],
            }
        } else if let Some(p) = pat {
            ParsedSemver {
                major: 0,
                minor: 0,
                patch: p + 1,
                pre: vec![PreIdent::Num(0)],
            }
        } else {
            ParsedSemver {
                major: 0,
                minor: 1,
                patch: 0,
                pre: vec![PreIdent::Num(0)],
            }
        };
        return Some(cmp_semver(runtime, &lower) != std::cmp::Ordering::Less
            && cmp_semver(runtime, &upper) == std::cmp::Ordering::Less);
    }
    if let Some(rest) = token.strip_prefix('~') {
        let (maj, min, pat, pre) = parse_partial_tuple(rest)?;
        let Some(maj) = maj else { return Some(true) };
        let lower = ParsedSemver {
            major: maj,
            minor: min.unwrap_or(0),
            patch: pat.unwrap_or(0),
            pre,
        };
        let upper = if let Some(m) = min {
            ParsedSemver {
                major: maj,
                minor: m + 1,
                patch: 0,
                pre: vec![PreIdent::Num(0)],
            }
        } else {
            ParsedSemver {
                major: maj + 1,
                minor: 0,
                patch: 0,
                pre: vec![PreIdent::Num(0)],
            }
        };
        return Some(cmp_semver(runtime, &lower) != std::cmp::Ordering::Less
            && cmp_semver(runtime, &upper) == std::cmp::Ordering::Less);
    }
    let (op, ver_str) = if let Some(r) = token.strip_prefix(">=") {
        (">=", r)
    } else if let Some(r) = token.strip_prefix("<=") {
        ("<=", r)
    } else if let Some(r) = token.strip_prefix('>') {
        (">", r)
    } else if let Some(r) = token.strip_prefix('<') {
        ("<", r)
    } else if let Some(r) = token.strip_prefix('=') {
        ("=", r)
    } else {
        ("=", token)
    };
    let (maj, min, pat, pre) = parse_partial_tuple(ver_str)?;
    let Some(maj) = maj else { return Some(true) };
    if op == "=" && (min.is_none() || pat.is_none()) {
        let lower = ParsedSemver {
            major: maj,
            minor: min.unwrap_or(0),
            patch: pat.unwrap_or(0),
            pre: vec![PreIdent::Num(0)],
        };
        let upper = if let Some(m) = min {
            ParsedSemver {
                major: maj,
                minor: m + 1,
                patch: 0,
                pre: vec![PreIdent::Num(0)],
            }
        } else {
            ParsedSemver {
                major: maj + 1,
                minor: 0,
                patch: 0,
                pre: vec![PreIdent::Num(0)],
            }
        };
        return Some(cmp_semver(runtime, &lower) != std::cmp::Ordering::Less
            && cmp_semver(runtime, &upper) == std::cmp::Ordering::Less);
    }
    let target = ParsedSemver {
        major: maj,
        minor: min.unwrap_or(0),
        patch: pat.unwrap_or(0),
        pre,
    };
    let ord = cmp_semver(runtime, &target);
    Some(match op {
        ">=" => ord != std::cmp::Ordering::Less,
        "<=" => ord != std::cmp::Ordering::Greater,
        ">" => ord == std::cmp::Ordering::Greater,
        "<" => ord == std::cmp::Ordering::Less,
        _ => ord == std::cmp::Ordering::Equal,
    })
}

pub fn semver_satisfies_with_prerelease(runtime_version: &str, range: &str) -> bool {
    let trimmed = range.trim();
    if trimmed.is_empty() {
        return false;
    }
    let Some(runtime) = parse_semver(runtime_version) else {
        return false;
    };
    if trimmed == "*" {
        return true;
    }
    trimmed.split("||").any(|clause| {
        let clause = clause.trim();
        if clause.is_empty() {
            return false;
        }
        // Support hyphen ranges (`a - b`) as well as whitespace-separated comparators.
        if let Some((left, right)) = clause.split_once(" - ") {
            return comparator_matches(&runtime, &format!(">={}", left.trim())).unwrap_or(false)
                && comparator_matches(&runtime, &format!("<={}", right.trim())).unwrap_or(false);
        }
        let tokens: Vec<&str> = clause.split_whitespace().collect();
        !tokens.is_empty()
            && tokens
                .into_iter()
                .all(|token| comparator_matches(&runtime, token).unwrap_or(false))
    })
}

fn localized_text_strings(value: Option<&Value>, out: &mut Vec<String>) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Object(map) => {
            for v in map.values() {
                if let Some(s) = v.as_str() {
                    out.push(s.to_owned());
                }
            }
        }
        _ => {}
    }
}

fn resolve_relative_icon(raw_icon: Option<&str>, base_url: &str) -> Option<String> {
    let icon = raw_icon?.trim();
    if icon.is_empty() {
        return None;
    }
    if icon.starts_with("data:image/") {
        return Some(icon.to_owned());
    }
    if let Ok(base) = Url::parse(base_url) {
        if let Ok(joined) = base.join(icon) {
            if matches!(joined.scheme(), "https" | "http") {
                return Some(joined.to_string());
            }
        }
    }
    None
}

fn parse_feed(url: &str, raw: &Value, fetched_at: u64, from_cache: bool) -> Result<CachedFeed, String> {
    if raw["format"] != 1 {
        return Err("插件索引格式不是受支持的 format: 1".into());
    }
    let raw_plugins = raw["plugins"]
        .as_array()
        .ok_or("插件索引缺少 plugins 数组")?;
    let title = raw.get("title").filter(|v| !v.is_null()).cloned();
    if title.is_none() {
        return Err("插件索引缺少 title 字段".into());
    }
    let description = raw.get("description").filter(|v| !v.is_null()).cloned();
    let mut categories = BTreeMap::new();
    if let Some(cat_map) = raw["metadata"]["categories"].as_object() {
        for (id, entry) in cat_map {
            if !id.is_empty() {
                if let Some(cat_title) = entry.get("title") {
                    categories.insert(id.clone(), cat_title.clone());
                }
            }
        }
    }

    let mut plugins = Vec::with_capacity(raw_plugins.len());
    for entry in raw_plugins {
        let Some(name) = entry["name"].as_str().filter(|n| valid_npm_package_name(n)) else {
            continue;
        };
        let Some(raw_versions) = entry["versions"].as_array() else {
            continue;
        };
        let mut versions = Vec::with_capacity(raw_versions.len());
        for ver in raw_versions {
            let Some(version_str) = ver["version"].as_str() else {
                continue;
            };
            if parse_semver(version_str).is_none() {
                continue;
            }
            let publish_timestamp = ver["publishTimestamp"].as_u64().unwrap_or(0);
            let source_obj = &ver["source"];
            let source_type = source_obj["type"].as_str().unwrap_or("npm").to_owned();
            let registry = source_obj["registry"]
                .as_str()
                .map(|s| s.trim_end_matches('/').to_owned());
            let git_url = source_obj["url"].as_str().map(str::to_owned);
            let git_commit = source_obj["commit"].as_str().map(str::to_owned);
            let git_path = source_obj["path"].as_str().map(str::to_owned);
            let engines_dsh = ver["engines"]["dsh"].as_str().map(str::to_owned);
            versions.push(ParsedFeedVersion {
                version: version_str.to_owned(),
                publish_timestamp,
                source_type,
                registry,
                git_url,
                git_commit,
                git_path,
                engines_dsh,
            });
        }
        if versions.is_empty() {
            continue;
        }
        versions.sort_by(|a, b| {
            let va = parse_semver(&a.version);
            let vb = parse_semver(&b.version);
            match (vb, va) {
                (Some(vb), Some(va)) => cmp_semver(&vb, &va),
                _ => b.version.cmp(&a.version),
            }
        });
        let latest_timestamp = versions
            .iter()
            .map(|v| v.publish_timestamp)
            .max()
            .unwrap_or(0);
        let category = entry["metadata"]["category"]
            .as_str()
            .filter(|id| categories.contains_key(*id))
            .map(str::to_owned);
        let keywords: Vec<String> = entry["metadata"]["keywords"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let plugin_title = entry.get("title").filter(|v| !v.is_null()).cloned();
        let plugin_desc = entry.get("description").filter(|v| !v.is_null()).cloned();
        let author = entry["author"].as_str().map(str::to_owned);
        let homepage = entry["homepage"].as_str().map(str::to_owned);
        let repository = entry.get("repository").filter(|v| !v.is_null()).cloned();
        let icon = resolve_relative_icon(entry["icon"].as_str(), url);

        let mut title_parts = vec![name.to_owned()];
        localized_text_strings(plugin_title.as_ref(), &mut title_parts);
        let title_blob = title_parts.join(" ").to_lowercase();

        let mut all_parts = title_parts;
        localized_text_strings(plugin_desc.as_ref(), &mut all_parts);
        if let Some(a) = &author {
            all_parts.push(a.clone());
        }
        all_parts.extend(keywords.iter().cloned());
        if let Some(cat_id) = &category {
            all_parts.push(cat_id.clone());
            localized_text_strings(categories.get(cat_id), &mut all_parts);
        }
        let search_blob = all_parts.join(" ").to_lowercase();

        plugins.push(ParsedFeedPlugin {
            name: name.to_owned(),
            title: plugin_title,
            description: plugin_desc,
            icon,
            author,
            homepage,
            repository,
            category,
            keywords,
            versions,
            search_blob,
            title_blob,
            latest_timestamp,
        });
    }

    Ok(CachedFeed {
        title,
        description,
        categories,
        plugins,
        fetched_at,
        error: None,
        from_cache,
    })
}

fn read_disk_cache(profile: &Path, url: &str) -> Option<(DiskCacheRecord, CachedFeed)> {
    let path = cache_file(profile, url);
    let bytes = fs::read(path).ok()?;
    if bytes.len() > MAX_INDEX_BYTES {
        return None;
    }
    let record: DiskCacheRecord = serde_json::from_slice(&bytes).ok()?;
    let feed = parse_feed(url, &record.raw, record.fetched_at, true).ok()?;
    Some((record, feed))
}

fn write_disk_cache(profile: &Path, url: &str, fetched_at: u64, raw: &Value) {
    let dir = cache_dir(profile);
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let record = DiskCacheRecord {
        fetched_at,
        raw: raw.clone(),
    };
    if let Ok(bytes) = serde_json::to_vec(&record) {
        let _ = config::atomic_write_private(&cache_file(profile, url), &bytes);
    }
}

async fn http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .connect_timeout(Duration::from_secs(12))
        .user_agent("LoliCode-DSH-Marketplace/1.0")
        .build()
        .map_err(|_| "无法初始化网络客户端".to_owned())
}

async fn fetch_bounded_bytes(url: &str, max_bytes: usize, timeout_secs: u64) -> Result<Vec<u8>, String> {
    let client = http_client(timeout_secs).await?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("无法连接 {url}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("请求返回错误: {e}"))?;
    if response
        .content_length()
        .is_some_and(|len| len > max_bytes as u64)
    {
        return Err("响应内容超过安全大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取网络响应失败: {e}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err("响应内容超过安全大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn load_feed(profile: &Path, url: &str, refresh: bool) -> Result<CachedFeed, String> {
    let now = now_ms();
    if !refresh {
        if let Ok(cache) = memory_cache().lock() {
            if let Some(hit) = cache.get(url) {
                if now.saturating_sub(hit.fetched_at) < CACHE_TTL_MS {
                    return Ok(hit.clone());
                }
            }
        }
        if let Some((_, disk_feed)) = read_disk_cache(profile, url) {
            if now.saturating_sub(disk_feed.fetched_at) < CACHE_TTL_MS {
                if let Ok(mut cache) = memory_cache().lock() {
                    cache.insert(url.to_owned(), disk_feed.clone());
                }
                return Ok(disk_feed);
            }
        }
    }

    match fetch_bounded_bytes(url, MAX_INDEX_BYTES, 25).await {
        Ok(bytes) => {
            let raw: Value =
                serde_json::from_slice(&bytes).map_err(|_| "索引文件不是有效的 JSON 文档")?;
            let fetched_at = now_ms();
            let feed = parse_feed(url, &raw, fetched_at, false)?;
            write_disk_cache(profile, url, fetched_at, &raw);
            if let Ok(mut cache) = memory_cache().lock() {
                cache.insert(url.to_owned(), feed.clone());
            }
            Ok(feed)
        }
        Err(fetch_err) => {
            if let Some((_, mut fallback)) = read_disk_cache(profile, url) {
                fallback.from_cache = true;
                fallback.error = Some(format!("{fetch_err}（已展示本地缓存索引）"));
                if let Ok(mut cache) = memory_cache().lock() {
                    cache.insert(url.to_owned(), fallback.clone());
                }
                return Ok(fallback);
            }
            Err(fetch_err)
        }
    }
}

fn peer_dsh_compatible(manifest: &Value, runtime_version: &str) -> Option<String> {
    let peers = manifest["peerDependencies"].as_object()?;
    for (peer_name, req_val) in peers {
        if peer_name != "@deepseek-ai/dsh" && !peer_name.starts_with("@deepseek-ai/dsh-") {
            continue;
        }
        let Some(range) = req_val.as_str() else {
            return Some(format!("{peer_name}: invalid"));
        };
        let resolved = if matches!(range.trim(), "workspace:^" | "workspace:~" | "workspace:*") {
            runtime_version
        } else {
            range
        };
        if !semver_satisfies_with_prerelease(runtime_version, resolved) {
            return Some(format!("{peer_name} {range}"));
        }
    }
    None
}

fn is_version_compatible(
    engines_dsh: Option<&str>,
    runtime_version: &str,
    pkg_name: &str,
    pkg_version: &str,
    exemptions: &BTreeMap<String, Vec<String>>,
) -> (bool, bool) {
    let ok = match engines_dsh {
        None => true,
        Some(range) => semver_satisfies_with_prerelease(runtime_version, range),
    };
    if ok {
        return (true, false);
    }
    let key = format!("{pkg_name}@{pkg_version}");
    let exempted = exemptions
        .get(&key)
        .is_some_and(|list| list.iter().any(|v| v == runtime_version));
    (exempted, exempted)
}

fn pick_default_version<'a>(
    versions: &'a [ParsedFeedVersion],
    runtime_version: &str,
    pkg_name: &str,
    exemptions: &BTreeMap<String, Vec<String>>,
) -> Option<&'a ParsedFeedVersion> {
    let is_compat = |v: &ParsedFeedVersion| -> bool {
        is_version_compatible(
            v.engines_dsh.as_deref(),
            runtime_version,
            pkg_name,
            &v.version,
            exemptions,
        )
        .0
    };
    versions
        .iter()
        .find(|v| is_compat(v) && !v.version.split('+').next().unwrap_or("").contains('-'))
        .or_else(|| versions.iter().find(|v| is_compat(v)))
        .or_else(|| versions.first())
}

pub(super) fn selected_bundles(profile: &Path) -> Result<Vec<SelectedMarketBundle>, String> {
    let state = load_state(profile)?;
    Ok(state
        .installed
        .into_iter()
        .filter(|item| item.enabled && item.has_bundle && !item.patch_files.is_empty())
        .map(|item| SelectedMarketBundle {
            name: item.name,
            version: item.version,
            patch_files: item.patch_files,
        })
        .collect())
}

pub(super) fn sync_home_sdk_profile(
    profile: &Path,
    home: &Path,
    bundles: &[SelectedMarketBundle],
) -> Result<(), String> {
    let sdk_dir = home.join("profiles/sdk");
    let manifest_path = sdk_dir.join("package.json");
    let sdk_modules = sdk_dir.join("node_modules");
    let compat_path = sdk_dir.join("compatibility.json");
    if bundles.is_empty() {
        // Restore plain SDK template only when previously written by LoliCode Marketplace sync.
        if manifest_path.is_file() {
            if let Ok(existing) = fs::read(&manifest_path) {
                if serde_json::from_slice::<Value>(&existing)
                    .ok()
                    .and_then(|v| v["_lolicodeMarketplace"].as_bool())
                    == Some(true)
                {
                    let base_manifest = json!({
                        "name": "dsh-profile-sdk",
                        "private": true,
                        "dependencies": {},
                        "dsh": {
                            "profile": {
                                "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"]
                            }
                        }
                    });
                    let _ = config::atomic_write_private(
                        &manifest_path,
                        &serde_json::to_vec_pretty(&base_manifest).unwrap_or_default(),
                    );
                    if sdk_modules.exists() {
                        let _ = fs::remove_dir_all(&sdk_modules);
                    }
                    if compat_path.exists() {
                        let _ = fs::remove_file(&compat_path);
                    }
                }
            }
        }
        return Ok(());
    }

    let source_modules = profile_dir(profile).join("node_modules");
    if !source_modules.is_dir() {
        return Ok(());
    }

    fs::create_dir_all(&sdk_dir).map_err(|_| "无法创建 Harness SDK 扩展配置目录")?;
    sync_directory_hardlinked(&source_modules, &sdk_modules)?;

    let mut deps = Map::new();
    let mut bundle_list = vec![
        Value::String("@deepseek-ai/dsh-base".into()),
        Value::String("@deepseek-ai/dsh-sdk-app".into()),
    ];
    for bundle in bundles {
        deps.insert(bundle.name.clone(), Value::String(bundle.version.clone()));
        bundle_list.push(Value::String(bundle.name.clone()));
    }
    let sdk_manifest = json!({
        "name": "dsh-profile-sdk",
        "private": true,
        "_lolicodeMarketplace": true,
        "dependencies": deps,
        "dsh": {
            "profile": {
                "bundles": bundle_list
            }
        }
    });
    let bytes =
        serde_json::to_vec_pretty(&sdk_manifest).map_err(|_| "无法编码 Harness SDK 扩展清单")?;
    config::atomic_write_private(&manifest_path, &bytes).map_err(|e| e.to_string())?;

    // dsh-app-boot reads exact package@version keys at top level of compatibility.json.
    let state = load_state(profile)?;
    if state.exemptions.is_empty() {
        if compat_path.exists() {
            let _ = fs::remove_file(&compat_path);
        }
    } else if let Ok(compat_bytes) = serde_json::to_vec_pretty(&state.exemptions) {
        let _ = config::atomic_write_private(&compat_path, &compat_bytes);
    }
    let workspace_yaml = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
    let _ = fs::write(sdk_dir.join("pnpm-workspace.yaml"), workspace_yaml);
    let patch_path = sdk_dir.join("cordis.patch.yml");
    if !patch_path.exists() {
        let _ = fs::write(&patch_path, "[]\n");
    }
    Ok(())
}

fn sync_directory_hardlinked(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Ok(());
    }
    // Rebuild clean target directory when syncing so removed plugins don't linger.
    if dst.exists() {
        fs::remove_dir_all(dst).map_err(|_| "无法清理旧版 Harness 插件缓存目录")?;
    }
    copy_or_hardlink_dir(src, dst, 0)
}

fn copy_or_hardlink_dir(src: &Path, dst: &Path, depth: usize) -> Result<(), String> {
    if depth > 24 {
        return Err("插件目录层级过深".into());
    }
    fs::create_dir_all(dst).map_err(|_| "无法创建插件同步目录")?;
    for entry in fs::read_dir(src).map_err(|_| "无法读取插件缓存目录")? {
        let entry = entry.map_err(|_| "无法枚举插件缓存目录")?;
        let file_type = entry
            .file_type()
            .map_err(|_| "无法检查插件文件类型")?;
        if file_type.is_symlink() {
            continue;
        }
        let target_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_or_hardlink_dir(&entry.path(), &target_path, depth + 1)?;
        } else if file_type.is_file() {
            if fs::hard_link(entry.path(), &target_path).is_err() {
                fs::copy(entry.path(), &target_path)
                    .map_err(|_| "无法同步插件文件到会话环境")?;
            }
        }
    }
    Ok(())
}

pub async fn overview(app: &AppHandle) -> Result<MarketOverview, String> {
    let profile = config::get_app_config_dir();
    let runtime_version = harness_paths::pinned_version().to_owned();
    let mut state = load_state(&profile)?;
    if state.ensure_defaults() {
        let _guard = write_lock().lock().await;
        save_state(&profile, &mut state)?;
    }

    let harness_catalog = harness_plugins::catalog(app, None).await?;
    let mut summaries = Vec::with_capacity(state.sources.len());
    for url in &state.sources {
        let preset_label = PRESET_SOURCES
            .iter()
            .find(|(u, _, _)| *u == url)
            .map(|(_, label, _)| (*label).to_owned());
        let cached = memory_cache()
            .lock()
            .ok()
            .and_then(|map| map.get(url).cloned())
            .or_else(|| read_disk_cache(&profile, url).map(|(_, f)| f));
        if let Some(feed) = cached {
            summaries.push(MarketSourceSummary {
                url: url.clone(),
                title: feed.title,
                description: feed.description,
                plugin_count: Some(feed.plugins.len()),
                fetched_at: Some(feed.fetched_at),
                from_cache: feed.from_cache,
                error: feed.error,
                preset_label,
            });
        } else {
            summaries.push(MarketSourceSummary {
                url: url.clone(),
                title: preset_label.as_ref().map(|l| json!(l)),
                description: None,
                plugin_count: None,
                fetched_at: None,
                from_cache: false,
                error: None,
                preset_label,
            });
        }
    }

    let presets = PRESET_SOURCES
        .iter()
        .map(|(url, label, desc)| MarketSourcePreset {
            url: (*url).to_owned(),
            label: (*label).to_owned(),
            description: (*desc).to_owned(),
            added: state.sources.iter().any(|s| s == url),
        })
        .collect();

    let on_demand_official = ON_DEMAND_OFFICIAL
        .iter()
        .map(|(name, zh_t, en_t, zh_d, en_d)| {
            let found = state.installed.iter().find(|p| p.name == *name);
            OfficialOnDemandItem {
                name: (*name).to_owned(),
                title: (*zh_t).to_owned(),
                title_en: (*en_t).to_owned(),
                description: (*zh_d).to_owned(),
                description_en: (*en_d).to_owned(),
                target_version: runtime_version.clone(),
                installed: found.is_some(),
                installed_version: found.map(|p| p.version.clone()),
                enabled: found.is_some_and(|p| p.enabled),
            }
        })
        .collect();

    let enabled_market = state.installed.iter().filter(|p| p.enabled).count();
    let enabled_harness = harness_catalog
        .bundles
        .iter()
        .filter(|b| b.enabled)
        .count();

    Ok(MarketOverview {
        runtime_version,
        sources: summaries,
        presets,
        selected_source: state.selected_source,
        installed: state.installed,
        on_demand_official,
        harness_bundles: harness_catalog.bundles,
        pending_reload: harness_catalog.pending_reload,
        enabled_count: enabled_market + enabled_harness,
        revision: state.revision,
    })
}

pub async fn query(query: MarketplaceQuery) -> Result<MarketplacePage, String> {
    let profile = config::get_app_config_dir();
    let runtime_version = harness_paths::pinned_version();
    let state = load_state(&profile)?;
    let source_url = match query.source_url {
        Some(url) if !url.trim().is_empty() => normalize_index_url(&url)?,
        _ => state
            .selected_source
            .clone()
            .or_else(|| state.sources.first().cloned())
            .ok_or("请先添加一个 DeepSeek 插件市场索引源")?,
    };
    if !state.sources.iter().any(|s| s == &source_url) {
        return Err("所选索引源尚未添加到市场列表".into());
    }

    let feed = load_feed(&profile, &source_url, query.refresh).await?;
    let total_in_feed = feed.plugins.len();
    let installed_map: HashMap<&str, &InstalledMarketPlugin> = state
        .installed
        .iter()
        .map(|item| (item.name.as_str(), item))
        .collect();

    let mut category_counts: HashMap<&str, usize> = HashMap::new();
    for p in &feed.plugins {
        if let Some(cat) = p.category.as_deref() {
            *category_counts.entry(cat).or_insert(0) += 1;
        }
    }
    let mut categories: Vec<MarketplaceCategoryItem> = feed
        .categories
        .iter()
        .filter_map(|(id, title)| {
            let count = *category_counts.get(id.as_str()).unwrap_or(&0);
            (count > 0).then(|| MarketplaceCategoryItem {
                id: id.clone(),
                title: title.clone(),
                count,
            })
        })
        .collect();
    categories.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.id.cmp(&b.id)));

    let query_terms: Vec<String> = query
        .text
        .trim()
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect();

    struct Ranked<'a> {
        plugin: &'a ParsedFeedPlugin,
        default_v: Option<&'a ParsedFeedVersion>,
        compatible: bool,
        exempted: bool,
        installed_entry: Option<&'a InstalledMarketPlugin>,
        score: i64,
        idx: usize,
    }

    let mut matches: Vec<Ranked<'_>> = Vec::new();
    for (idx, plugin) in feed.plugins.iter().enumerate() {
        if let Some(ref cat) = query.category {
            if plugin.category.as_deref() != Some(cat.as_str()) {
                continue;
            }
        }
        let installed_entry = installed_map.get(plugin.name.as_str()).copied();
        if query.installed_only && installed_entry.is_none() {
            continue;
        }
        let mut score: i64 = 0;
        if !query_terms.is_empty() {
            let mut all_hit = true;
            for term in &query_terms {
                if !plugin.search_blob.contains(term.as_str()) {
                    all_hit = false;
                    break;
                }
                if plugin.name == *term {
                    score += 100;
                } else if plugin.name.starts_with(term.as_str()) {
                    score += 40;
                } else if plugin.title_blob.contains(term.as_str()) {
                    score += 20;
                } else {
                    score += 5;
                }
            }
            if !all_hit {
                continue;
            }
        }
        let default_v =
            pick_default_version(&plugin.versions, runtime_version, &plugin.name, &state.exemptions);
        let (compatible, exempted) = match default_v {
            Some(v) => is_version_compatible(
                v.engines_dsh.as_deref(),
                runtime_version,
                &plugin.name,
                &v.version,
                &state.exemptions,
            ),
            None => (true, false),
        };
        if query.compatible_only && !compatible {
            continue;
        }
        matches.push(Ranked {
            plugin,
            default_v,
            compatible,
            exempted,
            installed_entry,
            score,
            idx,
        });
    }

    let sort_kind = query.sort.as_deref().unwrap_or_else(|| {
        if query_terms.is_empty() {
            "index"
        } else {
            "relevance"
        }
    });
    match sort_kind {
        "relevance" => matches.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| b.plugin.latest_timestamp.cmp(&a.plugin.latest_timestamp))
                .then_with(|| a.idx.cmp(&b.idx))
        }),
        "published" => matches.sort_by(|a, b| {
            b.plugin
                .latest_timestamp
                .cmp(&a.plugin.latest_timestamp)
                .then_with(|| a.idx.cmp(&b.idx))
        }),
        "name" => matches.sort_by(|a, b| a.plugin.name.cmp(&b.plugin.name)),
        _ => {}
    }

    let total = matches.len();
    let limit = query.limit.unwrap_or(24).clamp(1, 60);
    let offset = query.offset.min(total);
    let end = offset.saturating_add(limit).min(total);
    let next_offset = (end < total).then_some(end);

    let items = matches[offset..end]
        .iter()
        .map(|entry| {
            let p = entry.plugin;
            let dv = entry.default_v;
            let update_available = match (entry.installed_entry, dv) {
                (Some(inst), Some(v)) => match (parse_semver(&v.version), parse_semver(&inst.version)) {
                    (Some(nv), Some(iv)) => cmp_semver(&nv, &iv) == std::cmp::Ordering::Greater,
                    _ => v.version != inst.version,
                },
                _ => false,
            };
            MarketplacePluginItem {
                name: p.name.clone(),
                title: p.title.clone(),
                description: p.description.clone(),
                icon: p.icon.clone(),
                author: p.author.clone(),
                homepage: p.homepage.clone(),
                repository: p.repository.clone(),
                category: p.category.clone(),
                category_title: p
                    .category
                    .as_deref()
                    .and_then(|c| feed.categories.get(c).cloned()),
                keywords: p.keywords.clone(),
                latest_version: p.versions.first().map(|v| v.version.clone()),
                default_version: dv.map(|v| v.version.clone()),
                published_at: dv.map(|v| v.publish_timestamp),
                engines_dsh: dv.and_then(|v| v.engines_dsh.clone()),
                compatible: entry.compatible,
                exempted: entry.exempted,
                installed: entry.installed_entry.is_some(),
                installed_version: entry.installed_entry.map(|i| i.version.clone()),
                enabled: entry.installed_entry.is_some_and(|i| i.enabled),
                update_available,
                source_type: dv
                    .map(|v| v.source_type.clone())
                    .unwrap_or_else(|| "npm".to_owned()),
                registry: dv.and_then(|v| v.registry.clone()),
                versions_count: p.versions.len(),
            }
        })
        .collect();

    Ok(MarketplacePage {
        source_url,
        feed_title: feed.title,
        feed_description: feed.description,
        total,
        total_in_feed,
        fetched_at: Some(feed.fetched_at),
        from_cache: feed.from_cache,
        categories,
        items,
        next_offset,
        error: feed.error,
    })
}

async fn fetch_readme_for_package(
    profile: &Path,
    name: &str,
    version: Option<&str>,
    repository: Option<&Value>,
) -> (Option<String>, Option<String>, Option<String>) {
    // Prefer installed local README first when installed.
    let installed_pkg_dir = profile_dir(profile).join("node_modules").join(name);
    if installed_pkg_dir.is_dir() {
        for candidate in [
            "README.zh-CN.md",
            "README.zh.md",
            "README.md",
            "readme.md",
        ] {
            let path = installed_pkg_dir.join(candidate);
            if path.is_file() {
                if let Ok(text) = read_bounded_utf8(&path, MAX_DETAIL_BYTES) {
                    return (Some(text), Some("local".into()), None);
                }
            }
        }
    }

    let spec = match version {
        Some(v) if !v.is_empty() => format!("{name}@{v}"),
        _ => name.to_owned(),
    };
    let mut candidates = Vec::new();
    for file in ["README.zh-CN.md", "README.zh.md", "README.md"] {
        candidates.push((
            format!("https://cdn.jsdelivr.net/npm/{spec}/{file}"),
            "jsdelivr",
        ));
    }
    candidates.push((
        format!("https://unpkg.com/{spec}/README.md"),
        "unpkg",
    ));
    if let Some(repo_url) = repository.and_then(|r| r["url"].as_str()) {
        if let Some(raw_base) = github_raw_base(repo_url, repository.and_then(|r| r["directory"].as_str())) {
            for file in ["README.zh-CN.md", "README.zh.md", "README.md"] {
                candidates.push((format!("{raw_base}/{file}"), "repository"));
            }
        }
    }

    for (url, origin) in candidates {
        if let Ok(bytes) = fetch_bounded_bytes(&url, MAX_DETAIL_BYTES, 8).await {
            if let Ok(text) = String::from_utf8(bytes) {
                let cleaned = strip_leading_frontmatter(&text);
                if !cleaned.trim().is_empty() {
                    return (Some(cleaned), Some(origin.to_owned()), None);
                }
            }
        }
    }
    (
        None,
        None,
        Some("未能从 npm CDN 或代码仓库获取到 README 说明文档。".into()),
    )
}

fn github_raw_base(repo_url: &str, directory: Option<&str>) -> Option<String> {
    let url = Url::parse(repo_url).ok()?;
    if url.host_str()? != "github.com" {
        return None;
    }
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    if segments.len() < 2 {
        return None;
    }
    let owner = segments[0];
    let repo = segments[1].trim_end_matches(".git");
    let sub = directory
        .map(|d| d.trim_matches('/'))
        .filter(|d| !d.is_empty());
    match sub {
        Some(dir) => Some(format!(
            "https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{dir}"
        )),
        None => Some(format!(
            "https://raw.githubusercontent.com/{owner}/{repo}/HEAD"
        )),
    }
}

fn strip_leading_frontmatter(text: &str) -> String {
    let trimmed = text.trim_start_matches('\u{feff}');
    if let Some(rest) = trimmed.strip_prefix("---\n") {
        if let Some((_, body)) = rest.split_once("\n---\n") {
            return body.to_owned();
        }
    } else if let Some(rest) = trimmed.strip_prefix("---\r\n") {
        if let Some((_, body)) = rest.split_once("\r\n---\r\n") {
            return body.to_owned();
        }
    }
    trimmed.to_owned()
}

fn read_bounded_utf8(path: &Path, limit: usize) -> Result<String, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "无法读取文件")?;
    if meta.file_type().is_symlink() || meta.len() > limit as u64 {
        return Err("文件大小超出限制或包含符号链接".into());
    }
    let bytes = fs::read(path).map_err(|_| "无法读取文件")?;
    let text = String::from_utf8(bytes).map_err(|_| "文档不是有效的 UTF-8 文本")?;
    Ok(strip_leading_frontmatter(&text))
}

pub async fn get_detail(
    name: String,
    version: Option<String>,
    source_url: Option<String>,
) -> Result<MarketplaceDetail, String> {
    if !valid_npm_package_name(&name) {
        return Err("无效的插件包名".into());
    }
    let profile = config::get_app_config_dir();
    let runtime_version = harness_paths::pinned_version().to_owned();
    let state = load_state(&profile)?;
    let target_url = source_url
        .filter(|u| !u.trim().is_empty())
        .or_else(|| state.selected_source.clone())
        .or_else(|| state.sources.first().cloned());

    let feed = if let Some(ref url) = target_url {
        load_feed(&profile, url, false).await.ok()
    } else {
        None
    };

    let installed_entry = state.installed.iter().find(|p| p.name == name);
    let feed_entry = feed
        .as_ref()
        .and_then(|f| f.plugins.iter().find(|p| p.name == name));

    let pkg_dir = profile_dir(&profile).join("node_modules").join(&name);
    let local_pkg = if pkg_dir.join("package.json").is_file() {
        fs::read(pkg_dir.join("package.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    } else {
        None
    };

    let versions: Vec<ParsedVersionEntry> = if let Some(entry) = feed_entry {
        entry
            .versions
            .iter()
            .map(|v| {
                let (compatible, exempted) = is_version_compatible(
                    v.engines_dsh.as_deref(),
                    &runtime_version,
                    &name,
                    &v.version,
                    &state.exemptions,
                );
                ParsedVersionEntry {
                    version: v.version.clone(),
                    publish_timestamp: v.publish_timestamp,
                    source_type: v.source_type.clone(),
                    registry: v.registry.clone(),
                    git_url: v.git_url.clone(),
                    git_commit: v.git_commit.clone(),
                    git_path: v.git_path.clone(),
                    engines_dsh: v.engines_dsh.clone(),
                    compatible,
                    exempted,
                }
            })
            .collect()
    } else if let Some(inst) = installed_entry {
        vec![ParsedVersionEntry {
            version: inst.version.clone(),
            publish_timestamp: 0,
            source_type: inst.source_type.clone(),
            registry: inst.registry.clone(),
            git_url: None,
            git_commit: None,
            git_path: None,
            engines_dsh: local_pkg
                .as_ref()
                .and_then(|m| m["engines"]["dsh"].as_str().map(str::to_owned)),
            compatible: true,
            exempted: false,
        }]
    } else {
        Vec::new()
    };

    let chosen_version = version
        .as_deref()
        .and_then(|v| versions.iter().find(|item| item.version == v))
        .or_else(|| versions.iter().find(|v| v.compatible))
        .or_else(|| versions.first());

    let compatibility_issue = chosen_version
        .filter(|v| !v.compatible)
        .and_then(|v| {
            v.engines_dsh.as_ref().map(|req| {
                format!(
                    "{}@{} 要求 DeepSeek Harness {}（当前为 {}）",
                    name, v.version, req, runtime_version
                )
            })
        });

    let repository = feed_entry
        .and_then(|e| e.repository.clone())
        .or_else(|| installed_entry.and_then(|i| i.repository.clone()))
        .or_else(|| local_pkg.as_ref().and_then(|m| m.get("repository").cloned()));

    let readme_version = chosen_version
        .map(|v| v.version.as_str())
        .or_else(|| installed_entry.map(|i| i.version.as_str()));
    let (readme, readme_origin, readme_error) =
        fetch_readme_for_package(&profile, &name, readme_version, repository.as_ref()).await;

    let category = feed_entry
        .and_then(|e| e.category.clone())
        .or_else(|| installed_entry.and_then(|i| i.category.clone()));
    let category_title = category.as_deref().and_then(|cid| {
        feed.as_ref()
            .and_then(|f| f.categories.get(cid).cloned())
    });

    Ok(MarketplaceDetail {
        name: name.clone(),
        runtime_version,
        title: feed_entry
            .and_then(|e| e.title.clone())
            .or_else(|| installed_entry.and_then(|i| i.title.clone())),
        description: feed_entry
            .and_then(|e| e.description.clone())
            .or_else(|| installed_entry.and_then(|i| i.description.clone()))
            .or_else(|| {
                local_pkg
                    .as_ref()
                    .and_then(|m| m.get("description").filter(|v| v.is_string()).cloned())
            }),
        icon: feed_entry
            .and_then(|e| e.icon.clone())
            .or_else(|| installed_entry.and_then(|i| i.icon.clone())),
        author: feed_entry
            .and_then(|e| e.author.clone())
            .or_else(|| installed_entry.and_then(|i| i.author.clone())),
        homepage: feed_entry
            .and_then(|e| e.homepage.clone())
            .or_else(|| installed_entry.and_then(|i| i.homepage.clone())),
        repository,
        category,
        category_title,
        keywords: feed_entry
            .map(|e| e.keywords.clone())
            .unwrap_or_default(),
        default_version: chosen_version.map(|v| v.version.clone()),
        latest_version: versions.first().map(|v| v.version.clone()),
        compatible: chosen_version.map(|v| v.compatible).unwrap_or(true),
        exempted: chosen_version.map(|v| v.exempted).unwrap_or(false),
        compatibility_issue,
        versions,
        installed: installed_entry.is_some(),
        enabled: installed_entry.is_some_and(|i| i.enabled),
        installed_version: installed_entry.map(|i| i.version.clone()),
        has_bundle: installed_entry.map(|i| i.has_bundle),
        has_client: installed_entry.map(|i| i.has_client),
        readme,
        readme_origin,
        readme_error,
    })
}

pub async fn add_source(app: &AppHandle, raw_url: String) -> Result<MarketOverview, String> {
    let url = normalize_index_url(&raw_url)?;
    let profile = config::get_app_config_dir();
    {
        let _guard = write_lock().lock().await;
        let mut state = load_state(&profile)?;
        if state.sources.iter().any(|s| s == &url) {
            return Err("这个索引源已经添加过了".into());
        }
        // Validate the feed can be fetched & parsed before committing.
        load_feed(&profile, &url, true).await?;
        state.sources.push(url.clone());
        state.selected_source = Some(url);
        save_state(&profile, &mut state)?;
    }
    overview(app).await
}

pub async fn remove_source(app: &AppHandle, raw_url: String) -> Result<MarketOverview, String> {
    let url = raw_url.trim().to_owned();
    let profile = config::get_app_config_dir();
    {
        let _guard = write_lock().lock().await;
        let mut state = load_state(&profile)?;
        let before = state.sources.len();
        state.sources.retain(|s| s != &url);
        if state.sources.len() == before {
            return Err("索引源不存在".into());
        }
        if state.selected_source.as_deref() == Some(url.as_str()) {
            state.selected_source = state.sources.first().cloned();
        }
        save_state(&profile, &mut state)?;
    }
    overview(app).await
}

pub async fn select_source(app: &AppHandle, raw_url: String) -> Result<MarketOverview, String> {
    let url = normalize_index_url(&raw_url)?;
    let profile = config::get_app_config_dir();
    {
        let _guard = write_lock().lock().await;
        let mut state = load_state(&profile)?;
        if !state.sources.iter().any(|s| s == &url) {
            return Err("索引源不存在".into());
        }
        state.selected_source = Some(url);
        save_state(&profile, &mut state)?;
    }
    overview(app).await
}

pub async fn refresh_source(app: &AppHandle, source_url: Option<String>) -> Result<MarketOverview, String> {
    let profile = config::get_app_config_dir();
    let state = load_state(&profile)?;
    let targets = if let Some(url) = source_url.filter(|u| !u.trim().is_empty()) {
        vec![normalize_index_url(&url)?]
    } else {
        state.sources
    };
    for url in targets {
        let _ = load_feed(&profile, &url, true).await?;
    }
    overview(app).await
}

fn registry_candidates(preferred: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(p) = preferred {
        let trimmed = p.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            out.push(trimmed.to_owned());
        }
    }
    for default_reg in DEFAULT_NPM_REGISTRIES {
        if !out.iter().any(|item| item == default_reg) {
            out.push(default_reg.to_owned());
        }
    }
    out
}

fn encode_npm_package_for_url(name: &str) -> String {
    if name.starts_with('@') {
        name.replacen('/', "%2f", 1)
    } else {
        name.to_owned()
    }
}

async fn fetch_npm_package_doc(
    name: &str,
    preferred_registry: Option<&str>,
) -> Result<(Value, String), String> {
    let client = http_client(20).await?;
    let encoded = encode_npm_package_for_url(name);
    let mut errors = Vec::new();
    for registry in registry_candidates(preferred_registry) {
        let url = format!("{registry}/{encoded}");
        let resp = client
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await;
        match resp {
            Ok(res) if res.status().is_success() => {
                if let Ok(doc) = res.json::<Value>().await {
                    if doc["versions"].is_object() {
                        return Ok((doc, registry));
                    }
                }
                errors.push(format!("{registry}: 包清单无效"));
            }
            Ok(res) => errors.push(format!("{registry}: HTTP {}", res.status())),
            Err(e) => errors.push(format!("{registry}: {e}")),
        }
    }
    Err(format!(
        "无法获取 npm 包 {name} 信息（{}）",
        errors.join("；")
    ))
}

fn pick_matching_npm_version(doc: &Value, requested_range: Option<&str>) -> Result<String, String> {
    let versions_obj = doc["versions"]
        .as_object()
        .ok_or("npm 包不包含可用版本")?;
    if let Some(range) = requested_range.map(str::trim).filter(|r| !r.is_empty()) {
        if versions_obj.contains_key(range) {
            return Ok(range.to_owned());
        }
        if let Some(tag_ver) = doc["dist-tags"][range].as_str() {
            if versions_obj.contains_key(tag_ver) {
                return Ok(tag_ver.to_owned());
            }
        }
        let mut matched: Vec<(&str, ParsedSemver)> = versions_obj
            .keys()
            .filter_map(|ver| {
                let parsed = parse_semver(ver)?;
                semver_satisfies_with_prerelease(ver, range).then_some((ver.as_str(), parsed))
            })
            .collect();
        matched.sort_by(|a, b| cmp_semver(&b.1, &a.1));
        if let Some((best, _)) = matched.first() {
            return Ok((*best).to_owned());
        }
        return Err(format!("未找到满足版本约束 {range} 的发布版本"));
    }
    if let Some(latest) = doc["dist-tags"]["latest"].as_str() {
        if versions_obj.contains_key(latest) {
            return Ok(latest.to_owned());
        }
    }
    versions_obj
        .keys()
        .max()
        .cloned()
        .ok_or_else(|| "npm 包没有任何可用版本".to_owned())
}

fn verify_sri_sha512(bytes: &[u8], integrity: &str) -> Result<(), String> {
    for token in integrity.split_whitespace() {
        if let Some(expected_b64) = token.strip_prefix("sha512-") {
            let expected = base64::engine::general_purpose::STANDARD
                .decode(expected_b64)
                .map_err(|_| "安装包 SHA-512 摘要格式无效")?;
            let actual = Sha512::digest(bytes);
            if actual.as_slice() != expected.as_slice() {
                return Err("安装包 SHA-512 校验失败，已取消安装".into());
            }
            return Ok(());
        }
    }
    Err("安装包缺少可验证的 SHA-512 摘要".into())
}

fn sanitize_archive_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim_start_matches("./");
    let stripped = trimmed
        .split_once('/')
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    if stripped.is_empty() {
        return None;
    }
    let mut clean = PathBuf::new();
    for component in Path::new(stripped).components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_string_lossy();
                if text.is_empty()
                    || text == "."
                    || text == ".."
                    || text.contains('\\')
                    || text.contains(':')
                    || text.contains('\0')
                {
                    return None;
                }
                clean.push(part);
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!clean.as_os_str().is_empty()).then_some(clean)
}

fn parse_octal(field: &[u8]) -> u64 {
    let end = field
        .iter()
        .position(|&b| b == 0 || b == b' ')
        .unwrap_or(field.len());
    let text = std::str::from_utf8(&field[..end]).unwrap_or("").trim();
    if text.is_empty() {
        0
    } else {
        u64::from_str_radix(text, 8).unwrap_or(0)
    }
}

fn parse_pax_path(data: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(data).ok()?;
    for line in text.lines() {
        if let Some((_, kv)) = line.split_once(' ') {
            if let Some(path) = kv.strip_prefix("path=") {
                return Some(path.to_owned());
            }
        }
    }
    None
}

fn unpack_npm_tgz(tgz_bytes: &[u8], destination: &Path) -> Result<(), String> {
    let mut decoder = GzDecoder::new(tgz_bytes);
    let mut header = [0u8; 512];
    let mut total_bytes: u64 = 0;
    let mut file_count: usize = 0;
    let mut next_pax_path: Option<String> = None;
    let mut next_long_name: Option<String> = None;

    loop {
        match decoder.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(_) => return Err("压缩包内容损坏，无法读取".into()),
        }
        if header.iter().all(|&b| b == 0) {
            break;
        }
        let typeflag = header[156];
        let size = parse_octal(&header[124..136]);
        if size > MAX_FILE_BYTES {
            return Err("插件单文件大小超出 16 MiB 安全上限".into());
        }
        total_bytes = total_bytes
            .checked_add(size)
            .filter(|&sum| sum <= MAX_EXPANDED_BYTES)
            .ok_or("插件解压体积超出 64 MiB 上限")?;

        let mut data = vec![0u8; size as usize];
        if size > 0 {
            decoder
                .read_exact(&mut data)
                .map_err(|_| "插件压缩包数据不完整")?;
        }
        let pad = (512 - (size % 512)) % 512;
        if pad > 0 {
            let mut scratch = [0u8; 512];
            decoder
                .read_exact(&mut scratch[..pad as usize])
                .map_err(|_| "插件压缩包对齐损坏")?;
        }

        if typeflag == b'x' || typeflag == b'g' {
            if typeflag == b'x' {
                next_pax_path = parse_pax_path(&data);
            }
            continue;
        }
        if typeflag == b'L' {
            next_long_name = Some(
                String::from_utf8_lossy(&data)
                    .trim_end_matches('\0')
                    .to_owned(),
            );
            continue;
        }

        let raw_name = if let Some(p) = next_pax_path.take() {
            p
        } else if let Some(l) = next_long_name.take() {
            l
        } else {
            let name_part = String::from_utf8_lossy(
                header[..100]
                    .split(|&b| b == 0)
                    .next()
                    .unwrap_or(&[]),
            );
            let prefix_part = String::from_utf8_lossy(
                header[345..500]
                    .split(|&b| b == 0)
                    .next()
                    .unwrap_or(&[]),
            );
            if prefix_part.is_empty() {
                name_part.into_owned()
            } else {
                format!("{prefix_part}/{name_part}")
            }
        };

        // Reject symlinks and hardlinks strictly.
        if typeflag == b'1' || typeflag == b'2' {
            return Err("插件包包含不安全的链接条目，已拒绝安装".into());
        }
        if typeflag == b'5' {
            continue;
        }
        if typeflag != 0 && typeflag != b'0' {
            continue;
        }

        file_count += 1;
        if file_count > MAX_PACKAGE_FILES {
            return Err("插件文件数量过多，已拒绝安装".into());
        }

        let Some(rel) = sanitize_archive_path(&raw_name) else {
            if raw_name.contains("..") || raw_name.starts_with('/') {
                return Err("插件包含越界路径，已拒绝安装".into());
            }
            continue;
        };
        let target = destination.join(&rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| "无法创建插件文件目录")?;
        }
        fs::write(&target, &data).map_err(|_| "无法写入插件文件")?;
    }
    Ok(())
}

fn inspect_bundle_manifest(pkg_dir: &Path, expected_name: Option<&str>) -> Result<(String, String, bool, bool, Vec<String>, Option<Value>, Option<Value>), String> {
    let manifest_path = pkg_dir.join("package.json");
    let bytes = fs::read(&manifest_path).map_err(|_| "插件目录缺少有效的 package.json")?;
    let manifest: Value =
        serde_json::from_slice(&bytes).map_err(|_| "插件 package.json 无法解析")?;
    let name = manifest["name"]
        .as_str()
        .filter(|n| valid_npm_package_name(n))
        .ok_or("插件缺少有效的包名")?
        .to_owned();
    if let Some(expected) = expected_name {
        if expected != name {
            return Err(format!("安装包的实际包名 {name} 与预期 {expected} 不符"));
        }
    }
    let version = manifest["version"]
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("0.0.0")
        .to_owned();

    let patch_val = &manifest["dsh"]["bundle"]["patch"];
    let mut patch_files = Vec::new();
    match patch_val {
        Value::String(single) => {
            if sanitize_bundle_patch_path(pkg_dir, single).is_some() {
                patch_files.push(single.clone());
            }
        }
        Value::Array(list) => {
            for item in list {
                if let Some(s) = item.as_str() {
                    if sanitize_bundle_patch_path(pkg_dir, s).is_some() {
                        patch_files.push(s.to_owned());
                    }
                }
            }
        }
        _ => {}
    }
    let has_bundle = !patch_files.is_empty();
    let has_client = manifest["dsh"]["client"].is_object();
    let description = manifest
        .get("description")
        .filter(|v| v.is_string())
        .cloned();
    let repository = manifest.get("repository").filter(|v| !v.is_null()).cloned();
    Ok((
        name,
        version,
        has_bundle,
        has_client,
        patch_files,
        description,
        repository,
    ))
}

fn sanitize_bundle_patch_path(pkg_dir: &Path, relative: &str) -> Option<PathBuf> {
    let rel = Path::new(relative.trim_start_matches("./"));
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return None;
    }
    let full = pkg_dir.join(rel);
    full.is_file().then_some(full)
}

async fn install_npm_package_tree(
    modules_dir: &Path,
    name: &str,
    version_or_range: Option<&str>,
    preferred_registry: Option<&str>,
    runtime_version: &str,
    runtime_modules_dir: Option<&Path>,
    accept_incompatible: bool,
    exemptions: &mut BTreeMap<String, Vec<String>>,
) -> Result<(String, Value), String> {
    let mut visited: BTreeSet<String> = BTreeSet::new();
    let mut queue: VecDeque<(String, Option<String>, Option<String>, bool)> = VecDeque::new();
    queue.push_back((
        name.to_owned(),
        version_or_range.map(str::to_owned),
        preferred_registry.map(str::to_owned),
        true,
    ));

    let mut root_version = String::new();
    let mut root_manifest = Value::Null;

    while let Some((pkg_name, range_opt, reg_opt, is_root)) = queue.pop_front() {
        if visited.contains(&pkg_name) {
            continue;
        }
        if visited.len() >= MAX_DEPS {
            return Err("依赖包数量超过安装上限（256），请改用 pnpm 手动管理".into());
        }
        if !valid_npm_package_name(&pkg_name) {
            return Err(format!("包含无效的依赖包名: {pkg_name}"));
        }
        visited.insert(pkg_name.clone());

        let (doc, used_registry) = fetch_npm_package_doc(&pkg_name, reg_opt.as_deref()).await?;
        let exact_version = pick_matching_npm_version(&doc, range_opt.as_deref())?;
        let version_obj = doc["versions"][&exact_version].clone();

        if is_root {
            let engines_dsh = version_obj["engines"]["dsh"].as_str();
            let (mut compatible, _) = is_version_compatible(
                engines_dsh,
                runtime_version,
                &pkg_name,
                &exact_version,
                exemptions,
            );
            let mut unmet_reason = engines_dsh.map(str::to_owned);
            if compatible && engines_dsh.is_none() {
                if let Some(peer_mismatch) = peer_dsh_compatible(&version_obj, runtime_version) {
                    let key = format!("{pkg_name}@{exact_version}");
                    let exempted = exemptions
                        .get(&key)
                        .is_some_and(|list| list.iter().any(|v| v == runtime_version));
                    if !exempted {
                        compatible = false;
                        unmet_reason = Some(peer_mismatch);
                    }
                }
            }
            if !compatible {
                if !accept_incompatible {
                    return Err(format!(
                        "版本不兼容：{}@{} 声明需要 DeepSeek Harness {}，当前运行版本为 {}",
                        pkg_name,
                        exact_version,
                        unmet_reason.as_deref().unwrap_or("*"),
                        runtime_version
                    ));
                }
                exemptions
                    .entry(format!("{pkg_name}@{exact_version}"))
                    .or_default()
                    .push(runtime_version.to_owned());
            }
            root_version = exact_version.clone();
            root_manifest = version_obj.clone();
        }

        let tarball_url = version_obj["dist"]["tarball"]
            .as_str()
            .ok_or_else(|| format!("{pkg_name}@{exact_version} 缺少压缩包下载地址"))?;
        let tgz_bytes = fetch_bounded_bytes(tarball_url, MAX_ARCHIVE_BYTES, 45).await?;
        if let Some(integrity) = version_obj["dist"]["integrity"].as_str() {
            verify_sri_sha512(&tgz_bytes, integrity)?;
        }

        let target_dir = modules_dir.join(&pkg_name);
        let staging_parent = modules_dir.join(".staging");
        fs::create_dir_all(&staging_parent).map_err(|_| "无法创建暂存目录")?;
        let staging = tempfile::Builder::new()
            .prefix("pkg-")
            .tempdir_in(&staging_parent)
            .map_err(|_| "无法创建插件暂存目录")?;
        let staging_path = staging.path().to_path_buf();
        let pkg_name_clone = pkg_name.clone();
        tokio::task::spawn_blocking(move || unpack_npm_tgz(&tgz_bytes, &staging_path))
            .await
            .map_err(|_| "解压插件包失败")??;

        if is_root {
            let (_, _, has_bundle, _, _, _, _) =
                inspect_bundle_manifest(staging.path(), Some(&pkg_name))?;
            if !has_bundle {
                return Err(format!(
                    "{pkg_name}@{exact_version} 未声明有效的 dsh.bundle.patch 配置文件，无法作为 Harness 插件启用"
                ));
            }
        }

        // Swap atomically under node_modules/<pkg>
        if let Some(parent) = target_dir.parent() {
            fs::create_dir_all(parent).map_err(|_| "无法创建包作用域目录")?;
        }
        if target_dir.exists() {
            fs::remove_dir_all(&target_dir)
                .map_err(|_| format!("无法替换旧版本包 {pkg_name_clone}"))?;
        }
        let persisted = staging.keep();
        if fs::rename(&persisted, &target_dir).is_err() {
            copy_or_hardlink_dir(&persisted, &target_dir, 0)?;
            let _ = fs::remove_dir_all(&persisted);
        }

        if let Some(deps) = version_obj["dependencies"].as_object() {
            for (dep_name, dep_range) in deps {
                if is_installation_owned_peer(dep_name, runtime_modules_dir)
                    || visited.contains(dep_name)
                {
                    continue;
                }
                if let Some(range) = dep_range.as_str() {
                    queue.push_back((
                        dep_name.clone(),
                        Some(range.to_owned()),
                        Some(used_registry.clone()),
                        false,
                    ));
                }
            }
        }
    }

    Ok((root_version, root_manifest))
}

fn parse_spec_name_and_version(spec: &str) -> (String, Option<String>) {
    let trimmed = spec.trim();
    if let Some(rest) = trimmed.strip_prefix('@') {
        if let Some((pkg, ver)) = rest.split_once('@') {
            return (format!("@{pkg}"), (!ver.is_empty()).then_some(ver.to_owned()));
        }
        return (trimmed.to_owned(), None);
    }
    if let Some((pkg, ver)) = trimmed.split_once('@') {
        return (pkg.to_owned(), (!ver.is_empty()).then_some(ver.to_owned()));
    }
    (trimmed.to_owned(), None)
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallPluginRequest {
    pub name_or_spec: String,
    pub version: Option<String>,
    pub registry: Option<String>,
    pub source_url: Option<String>,
    #[serde(default)]
    pub accept_incompatible: bool,
}

pub async fn install_plugin(
    app: &AppHandle,
    req: InstallPluginRequest,
) -> Result<MarketOverview, String> {
    let profile = config::get_app_config_dir();
    let runtime_version = harness_paths::pinned_version().to_owned();
    let spec = req.name_or_spec.trim().to_owned();
    if spec.is_empty() {
        return Err("请输入插件包名、市场条目或本地目录路径".into());
    }

    let _guard = write_lock().lock().await;
    let mut state = load_state(&profile)?;
    let p_dir = profile_dir(&profile);
    let modules_dir = p_dir.join("node_modules");
    fs::create_dir_all(&modules_dir).map_err(|_| "无法初始化插件安装目录")?;

    let candidate_path = PathBuf::from(&spec);
    let installed_record = if candidate_path.is_dir() {
        let canonical = fs::canonicalize(&candidate_path)
            .map_err(|_| "无法访问所选本地插件目录")?;
        let (pkg_name, pkg_ver, has_bundle, has_client, patch_files, description, repository) =
            inspect_bundle_manifest(&canonical, None)?;
        if !has_bundle {
            return Err("所选本地目录未声明有效的 dsh.bundle.patch 配置文件".into());
        }
        let target_dir = modules_dir.join(&pkg_name);
        if target_dir.exists() {
            fs::remove_dir_all(&target_dir).map_err(|_| "无法更新已安装的本地插件目录")?;
        }
        copy_local_plugin_dir(&canonical, &target_dir, 0)?;
        InstalledMarketPlugin {
            name: pkg_name,
            version: pkg_ver,
            enabled: true,
            installed_at: Utc::now().to_rfc3339(),
            source_type: "local".into(),
            source_spec: canonical.to_string_lossy().into_owned(),
            registry: None,
            marketplace_url: None,
            title: None,
            description,
            icon: None,
            author: None,
            homepage: None,
            repository,
            category: None,
            has_bundle,
            has_client,
            patch_files,
        }
    } else {
        let (pkg_name, parsed_ver) = parse_spec_name_and_version(&spec);
        if !valid_npm_package_name(&pkg_name) {
            return Err("请输入有效的 npm 包名（例如 dsh-plan-note）或存在的本地插件目录".into());
        }
        let target_ver = req.version.clone().or(parsed_ver);

        // Look up catalog metadata when installing from a configured marketplace feed.
        let feed_meta = if let Some(ref url) = req.source_url {
            load_feed(&profile, url, false)
                .await
                .ok()
                .and_then(|f| f.plugins.into_iter().find(|p| p.name == pkg_name))
        } else {
            None
        };
        let preferred_reg = req.registry.clone().or_else(|| {
            feed_meta.as_ref().and_then(|m| {
                target_ver
                    .as_deref()
                    .and_then(|tv| m.versions.iter().find(|v| v.version == tv))
                    .or_else(|| m.versions.first())
                    .and_then(|v| v.registry.clone())
            })
        });

        let runtime_modules = HarnessPaths::resolve(app)
            .ok()
            .map(|paths| paths.package.join("node_modules"));
        let (resolved_version, version_manifest) = install_npm_package_tree(
            &modules_dir,
            &pkg_name,
            target_ver.as_deref(),
            preferred_reg.as_deref(),
            &runtime_version,
            runtime_modules.as_deref(),
            req.accept_incompatible,
            &mut state.exemptions,
        )
        .await?;

        let installed_pkg_dir = modules_dir.join(&pkg_name);
        let (_, _, has_bundle, has_client, patch_files, pkg_desc, pkg_repo) =
            inspect_bundle_manifest(&installed_pkg_dir, Some(&pkg_name))?;

        let on_demand = ON_DEMAND_OFFICIAL.iter().find(|(n, ..)| *n == pkg_name);
        let title = feed_meta
            .as_ref()
            .and_then(|m| m.title.clone())
            .or_else(|| on_demand.map(|(_, zh_t, en_t, ..)| json!({ "zh": zh_t, "en": en_t })));
        let description = feed_meta
            .as_ref()
            .and_then(|m| m.description.clone())
            .or_else(|| on_demand.map(|(_, _, _, zh_d, en_d)| json!({ "zh": zh_d, "en": en_d })))
            .or(pkg_desc);

        InstalledMarketPlugin {
            name: pkg_name.clone(),
            version: resolved_version.clone(),
            enabled: true,
            installed_at: Utc::now().to_rfc3339(),
            source_type: if on_demand.is_some() {
                "on-demand".into()
            } else {
                "npm".into()
            },
            source_spec: format!("{pkg_name}@{resolved_version}"),
            registry: preferred_reg.or_else(|| Some(DEFAULT_NPM_REGISTRIES[0].to_owned())),
            marketplace_url: req.source_url.clone(),
            title,
            description,
            icon: feed_meta.as_ref().and_then(|m| m.icon.clone()),
            author: feed_meta
                .as_ref()
                .and_then(|m| m.author.clone())
                .or_else(|| version_manifest["author"]["name"].as_str().map(str::to_owned)),
            homepage: feed_meta
                .as_ref()
                .and_then(|m| m.homepage.clone())
                .or_else(|| version_manifest["homepage"].as_str().map(str::to_owned)),
            repository: feed_meta
                .as_ref()
                .and_then(|m| m.repository.clone())
                .or(pkg_repo),
            category: feed_meta.as_ref().and_then(|m| m.category.clone()),
            has_bundle,
            has_client,
            patch_files,
        }
    };

    state
        .installed
        .retain(|item| item.name != installed_record.name);
    state.installed.insert(0, installed_record);
    save_state(&profile, &mut state)?;
    drop(state);

    // Retire idle warm runtimes so the next session picks up newly enabled bundles immediately.
    let _ = app
        .state::<InprocessAgentState>()
        .harness
        .retire_idle(None)
        .await;

    overview(app).await
}

fn copy_local_plugin_dir(src: &Path, dst: &Path, depth: usize) -> Result<(), String> {
    if depth > 24 {
        return Err("本地插件目录层级过深".into());
    }
    fs::create_dir_all(dst).map_err(|_| "无法创建本地插件目标目录")?;
    for entry in fs::read_dir(src).map_err(|_| "无法读取本地插件目录")? {
        let entry = entry.map_err(|_| "无法遍历本地插件目录")?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == ".git" || name_str == "node_modules" {
            continue;
        }
        let ft = entry.file_type().map_err(|_| "无法识别本地文件类型")?;
        if ft.is_symlink() {
            continue;
        }
        let target = dst.join(&name);
        if ft.is_dir() {
            copy_local_plugin_dir(&entry.path(), &target, depth + 1)?;
        } else if ft.is_file() {
            fs::copy(entry.path(), &target).map_err(|_| "复制本地插件文件失败")?;
        }
    }
    Ok(())
}

pub async fn set_plugin_enabled(
    app: &AppHandle,
    name: String,
    enabled: bool,
) -> Result<MarketOverview, String> {
    let profile = config::get_app_config_dir();
    {
        let _guard = write_lock().lock().await;
        let mut state = load_state(&profile)?;
        let item = state
            .installed
            .iter_mut()
            .find(|p| p.name == name)
            .ok_or("找不到已安装的插件")?;
        if item.enabled != enabled {
            item.enabled = enabled;
            save_state(&profile, &mut state)?;
        }
    }
    let _ = app
        .state::<InprocessAgentState>()
        .harness
        .retire_idle(None)
        .await;
    overview(app).await
}

pub async fn update_plugin(
    app: &AppHandle,
    name: String,
    version: Option<String>,
    registry: Option<String>,
    accept_incompatible: bool,
) -> Result<MarketOverview, String> {
    let profile = config::get_app_config_dir();
    let existing = load_state(&profile)?
        .installed
        .into_iter()
        .find(|p| p.name == name)
        .ok_or("找不到需要更新的插件")?;
    install_plugin(
        app,
        InstallPluginRequest {
            name_or_spec: name,
            version,
            registry: registry.or(existing.registry),
            source_url: existing.marketplace_url,
            accept_incompatible,
        },
    )
    .await
}

pub async fn uninstall_plugin(app: &AppHandle, name: String) -> Result<MarketOverview, String> {
    if !valid_npm_package_name(&name) {
        return Err("无效的插件包名".into());
    }
    let profile = config::get_app_config_dir();
    {
        let _guard = write_lock().lock().await;
        let mut state = load_state(&profile)?;
        let before = state.installed.len();
        state.installed.retain(|p| p.name != name);
        if state.installed.len() == before {
            return Err("插件尚未安装".into());
        }
        let target_dir = profile_dir(&profile).join("node_modules").join(&name);
        if target_dir.exists() {
            fs::remove_dir_all(&target_dir).map_err(|_| "无法移除插件目录")?;
        }
        save_state(&profile, &mut state)?;
    }
    let _ = app
        .state::<InprocessAgentState>()
        .harness
        .retire_idle(None)
        .await;
    overview(app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;

    #[test]
    fn validates_npm_names_and_index_urls() {
        assert!(valid_npm_package_name("dsh-plan-note"));
        assert!(valid_npm_package_name("@yolk_vat-y/dsh-project-memory"));
        assert!(!valid_npm_package_name("../escape"));
        assert!(!valid_npm_package_name("UPPERCASE"));
        assert!(!valid_npm_package_name("a/b/c"));

        assert_eq!(
            normalize_index_url("https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json").unwrap(),
            "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json"
        );
        assert!(normalize_index_url("file:///etc/passwd").is_err());
        assert!(normalize_index_url("https://user:pass@example.com/index.json").is_err());
        assert!(normalize_index_url("https://example.com/index.json#frag").is_err());
    }

    #[test]
    fn evaluates_semver_ranges_with_prerelease_like_dsh() {
        assert!(semver_satisfies_with_prerelease("0.2.2-rc.2", ">=0.2.1-rc.1"));
        assert!(semver_satisfies_with_prerelease("0.2.2-rc.2", ">=0.2.1-rc.4 <0.3.0-0"));
        assert!(semver_satisfies_with_prerelease("0.2.2-rc.2", "^0.2.2-rc.1"));
        assert!(!semver_satisfies_with_prerelease("0.2.2-rc.2", ">=0.2.3"));
        assert!(!semver_satisfies_with_prerelease("0.2.2-rc.2", "0.2.1-rc.5"));
    }

    #[test]
    fn parse_feed_and_reject_invalid_format() {
        let valid = json!({
            "format": 1,
            "title": { "en": "Test Feed", "zh": "测试源" },
            "metadata": {
                "categories": {
                    "tools": { "title": { "en": "Tools", "zh": "工具" } }
                }
            },
            "plugins": [
                {
                    "name": "dsh-sample",
                    "title": { "en": "Sample", "zh": "示例插件" },
                    "metadata": { "category": "tools", "keywords": ["git"] },
                    "versions": [
                        { "version": "0.1.0", "publishTimestamp": 100, "source": { "type": "npm" }, "engines": {} },
                        { "version": "0.2.0", "publishTimestamp": 200, "source": { "type": "npm" }, "engines": { "dsh": ">=0.2.1-rc.1" } }
                    ]
                }
            ]
        });
        let feed = parse_feed("https://example.com/index.json", &valid, 1000, false).unwrap();
        assert_eq!(feed.plugins.len(), 1);
        assert_eq!(feed.plugins[0].versions[0].version, "0.2.0");

        let invalid = json!({ "format": 2, "title": "Bad", "plugins": [] });
        assert!(parse_feed("https://example.com/index.json", &invalid, 1000, false).is_err());
    }

    fn build_tgz_with_entry(entry_name: &str, typeflag: u8, body: &[u8]) -> Vec<u8> {
        let mut header = [0u8; 512];
        let name_bytes = entry_name.as_bytes();
        header[..name_bytes.len()].copy_from_slice(name_bytes);
        header[100..108].copy_from_slice(b"0000644\0");
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        let size_str = format!("{:011o}\0", body.len());
        header[124..136].copy_from_slice(size_str.as_bytes());
        header[136..148].copy_from_slice(b"00000000000\0");
        header[148..156].fill(b' ');
        header[156] = typeflag;
        let checksum: u32 = header.iter().map(|&b| b as u32).sum();
        let chk_str = format!("{checksum:06o}\0 ");
        header[148..156].copy_from_slice(chk_str.as_bytes());

        let mut tar = Vec::new();
        tar.extend_from_slice(&header);
        tar.extend_from_slice(body);
        let pad = (512 - (body.len() % 512)) % 512;
        tar.extend(std::iter::repeat_n(0u8, pad));
        tar.extend(std::iter::repeat_n(0u8, 1024));

        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        io::Write::write_all(&mut enc, &tar).unwrap();
        enc.finish().unwrap()
    }

    #[test]
    fn tgz_unpacker_extracts_valid_files_and_rejects_symlinks_and_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let valid_tgz = build_tgz_with_entry("package/package.json", b'0', br#"{"name":"a"}"#);
        let ok_dir = temp.path().join("ok");
        unpack_npm_tgz(&valid_tgz, &ok_dir).unwrap();
        assert_eq!(fs::read_to_string(ok_dir.join("package.json")).unwrap(), r#"{"name":"a"}"#);

        let symlink_tgz = build_tgz_with_entry("package/evil", b'2', b"");
        assert!(unpack_npm_tgz(&symlink_tgz, &temp.path().join("sym")).is_err());

        let escape_tgz = build_tgz_with_entry("package/../escape.txt", b'0', b"bad");
        assert!(unpack_npm_tgz(&escape_tgz, &temp.path().join("esc")).is_err());
    }

    #[test]
    fn sync_home_sdk_profile_materializes_enabled_bundle_without_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("app");
        let home = temp.path().join("session-home");
        let src_pkg = profile_dir(&profile).join("node_modules/dsh-plan-note");
        fs::create_dir_all(&src_pkg).unwrap();
        fs::write(src_pkg.join("package.json"), r#"{"name":"dsh-plan-note","version":"0.1.2"}"#).unwrap();

        let mut state = MarketplaceState::default();
        state
            .exemptions
            .insert("dsh-plan-note@0.1.2".into(), vec!["0.2.2-rc.2".into()]);
        save_state(&profile, &mut state).unwrap();

        let selected = vec![SelectedMarketBundle {
            name: "dsh-plan-note".into(),
            version: "0.1.2".into(),
            patch_files: vec!["./cordis.patch.yml".into()],
        }];
        sync_home_sdk_profile(&profile, &home, &selected).unwrap();

        let sdk = home.join("profiles/sdk");
        let manifest: Value = serde_json::from_slice(&fs::read(sdk.join("package.json")).unwrap()).unwrap();
        assert_eq!(manifest["dependencies"]["dsh-plan-note"], "0.1.2");
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app", "dsh-plan-note"])
        );
        assert!(sdk.join("node_modules/dsh-plan-note/package.json").is_file());
        let compat: Value = serde_json::from_slice(&fs::read(sdk.join("compatibility.json")).unwrap()).unwrap();
        assert_eq!(compat["dsh-plan-note@0.1.2"], json!(["0.2.2-rc.2"]));

        // Disabling clears marketplace bundles and stale files cleanly.
        sync_home_sdk_profile(&profile, &home, &[]).unwrap();
        let cleared: Value = serde_json::from_slice(&fs::read(sdk.join("package.json")).unwrap()).unwrap();
        assert_eq!(
            cleared["dsh"]["profile"]["bundles"],
            json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"])
        );
        assert!(!sdk.join("node_modules").exists());
        assert!(!sdk.join("compatibility.json").exists());
    }
}
