//! Local CLI version probes and latest-release metadata.

#[cfg(target_os = "windows")]
use super::installations::wsl_distro_for_tool;
use super::lifecycle::last_lines;
#[cfg(not(target_os = "windows"))]
use super::paths::effective_path_os;
#[cfg(target_os = "windows")]
use super::paths::effective_path_string;
#[cfg(not(target_os = "windows"))]
use super::paths::prepend_search_dir_to_path;
#[cfg(target_os = "windows")]
use super::paths::resolve_path_default;
use super::paths::{build_tool_search_paths, tool_executable_candidates};
use super::process::decode_command_output;
#[cfg(target_os = "windows")]
use super::process::run_windows_tool_version_command;
use super::terminal::{default_flag_for_shell, is_valid_shell};
#[cfg(target_os = "windows")]
use super::terminal::{is_valid_shell_flag, is_valid_wsl_distro_name};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;
use super::{WslShellPreferenceInput, VALID_TOOLS};
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(serde::Serialize)]
pub struct ToolVersion {
    name: String,
    version: Option<String>,
    latest_version: Option<String>, // 新增字段：最新版本
    error: Option<String>,
    /// 已定位到可执行文件、但 `--version` 报错退出（装了却跑不起来，如 Node 版本不达标）。
    /// 供前端区分"未安装"与"已安装·无法运行"，无需匹配 error 文案反推语义。
    installed_but_broken: bool,
    /// 工具运行环境: "windows", "wsl", "macos", "linux", "unknown"
    env_type: String,
    /// 当 env_type 为 "wsl" 时，返回该工具绑定的 WSL distro（用于按 distro 探测 shells）
    wsl_distro: Option<String>,
}

// Keep platform-specific env detection in one place to avoid repeating cfg blocks.
#[cfg(target_os = "windows")]
pub(super) fn tool_env_type_and_wsl_distro(tool: &str) -> (String, Option<String>) {
    if let Some(distro) = wsl_distro_for_tool(tool) {
        ("wsl".to_string(), Some(distro))
    } else {
        ("windows".to_string(), None)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn tool_env_type_and_wsl_distro(_tool: &str) -> (String, Option<String>) {
    ("macos".to_string(), None)
}

#[cfg(target_os = "linux")]
pub(super) fn tool_env_type_and_wsl_distro(_tool: &str) -> (String, Option<String>) {
    ("linux".to_string(), None)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub(super) fn tool_env_type_and_wsl_distro(_tool: &str) -> (String, Option<String>) {
    ("unknown".to_string(), None)
}

#[tauri::command]
pub async fn get_tool_versions(
    tools: Option<Vec<String>>,
    wsl_shell_by_tool: Option<HashMap<String, WslShellPreferenceInput>>,
) -> Result<Vec<ToolVersion>, String> {
    let requested: Vec<&str> = if let Some(tools) = tools.as_ref() {
        let set: std::collections::HashSet<&str> = tools.iter().map(|s| s.as_str()).collect();
        VALID_TOOLS
            .iter()
            .copied()
            .filter(|t| set.contains(t))
            .collect()
    } else {
        VALID_TOOLS.to_vec()
    };
    let mut results = Vec::new();

    for tool in requested {
        let pref = wsl_shell_by_tool.as_ref().and_then(|m| m.get(tool));
        let tool_wsl_shell = pref.and_then(|p| p.wsl_shell.as_deref());
        let tool_wsl_shell_flag = pref.and_then(|p| p.wsl_shell_flag.as_deref());

        results.push(get_single_tool_version_impl(tool, tool_wsl_shell, tool_wsl_shell_flag).await);
    }

    Ok(results)
}

/// 获取单个工具的版本信息（内部实现）
/// 本机工具的版本（只探测本地，不联网）。
pub(super) fn probe_local_version(
    tool: &str,
    wsl_distro: Option<&str>,
    wsl_shell: Option<&str>,
    wsl_shell_flag: Option<&str>,
) -> ShellProbe {
    if let Some(distro) = wsl_distro {
        try_get_version_wsl(tool, distro, wsl_shell, wsl_shell_flag)
    } else {
        #[cfg(target_os = "windows")]
        {
            // Probe the PATH-default entry (what `tool` resolves to in a
            // terminal) first, and only fall back to the directory scan when it
            // is genuinely absent (NotFound). Two goals:
            // 1. Keep the displayed "current version" aligned with the version
            //    the user actually runs — a stale shim in a hardcoded fallback
            //    dir (e.g. an old `%APPDATA%\npm`) must not override a newer
            //    PATH install (#4701: "updated but still shows the old version").
            // 2. Mirror the non-Windows structure (`try_get_version` →
            //    `scan_cli_version`).
            // `probe_path_default_version` executes only the real executable
            //    resolved by `where` (App Execution Aliases filtered out), so
            //    it never `cmd /C tool` into a protocol handler.
            match probe_path_default_version(tool) {
                ShellProbe::NotFound(_) => scan_cli_version(tool),
                found => found,
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            // PATH 第一个命令优先；只有它确实没装(NotFound)才去常见目录兜底扫描。
            match try_get_version(tool) {
                ShellProbe::NotFound(_) => scan_cli_version(tool),
                found => found,
            }
        }
    }
}

/// 本机实际安装的工具版本（和「关于」页探测的是同一个）；拿不到为 `None`。
pub(crate) fn local_tool_version(tool: &str) -> Option<String> {
    let (_, wsl_distro) = tool_env_type_and_wsl_distro(tool);
    match probe_local_version(tool, wsl_distro.as_deref(), None, None) {
        ShellProbe::Found(version) => Some(version),
        _ => None,
    }
}

pub(super) async fn get_single_tool_version_impl(
    tool: &str,
    wsl_shell: Option<&str>,
    wsl_shell_flag: Option<&str>,
) -> ToolVersion {
    debug_assert!(
        VALID_TOOLS.contains(&tool),
        "unexpected tool name in get_single_tool_version_impl: {tool}"
    );

    // 判断该工具的运行环境 & WSL distro（如有）
    let (env_type, wsl_distro) = tool_env_type_and_wsl_distro(tool);

    // 使用全局 HTTP 客户端（已包含代理配置）
    let client = crate::proxy::http_client::get();

    // 1. 获取本地版本
    let probe = probe_local_version(tool, wsl_distro.as_deref(), wsl_shell, wsl_shell_flag);
    let (local_version, local_error, installed_but_broken) = match probe {
        ShellProbe::Found(v) => (Some(v), None, false),
        ShellProbe::FoundButFailed(e) => (None, Some(e), true),
        ShellProbe::NotFound(e) => (None, Some(e), false),
    };

    // 2. 获取远程最新版本（npm 工具在本地领先 latest 时会按预发布通道补查，见
    //    fetch_npm_latest_for_tool / npm_prerelease_tags）
    let local = local_version.as_deref();
    let latest_version = match tool {
        "claude" => {
            fetch_npm_latest_for_tool(&client, "@anthropic-ai/claude-code", tool, local).await
        }
        "codex" => fetch_npm_latest_for_tool(&client, "@openai/codex", tool, local).await,
        "gemini" => fetch_npm_latest_for_tool(&client, "@google/gemini-cli", tool, local).await,
        "grok" => fetch_npm_latest_for_tool(&client, "@xai-official/grok", tool, local).await,
        "opencode" => {
            if let Some(version) =
                fetch_npm_latest_for_tool(&client, "opencode-ai", tool, local).await
            {
                Some(version)
            } else {
                fetch_github_latest_version(&client, "anomalyco/opencode").await
            }
        }
        "openclaw" => fetch_npm_latest_for_tool(&client, "openclaw", tool, local).await,
        "hermes" => fetch_hermes_latest_version(&client, local).await,
        "pi" => {
            fetch_npm_latest_for_tool(&client, "@earendil-works/pi-coding-agent", tool, local).await
        }
        "mcode" => fetch_npm_latest_for_tool(&client, "@minimax-ai/code", tool, local).await,
        _ => None,
    };

    ToolVersion {
        name: tool.to_string(),
        version: local_version,
        latest_version,
        error: local_error,
        installed_but_broken,
        env_type,
        wsl_distro,
    }
}

/// 该工具在 npm 上的预发布通道 tag(靠前者优先)。仅当本地版本已**严格领先**
/// `latest` 时才会被补查 —— 让主动在抢先通道的用户(如走 Claude Code 的 `next`)
/// 看到与所在通道对齐的"最新版本",同时绝不把稳定通道用户暴露给预发布版。
/// 返回空切片表示该工具只看 `latest`、不补查。
///
/// 为何不通用覆盖所有工具:各家预发布 tag 命名互不统一(codex=alpha/beta/native、
/// gemini=nightly/preview、openclaw=alpha/beta),且 codex 的 beta/native 是
/// `0.1.x` 时间戳式版本、gemini 有误发的 `false` tag —— 这些脏值虽会被
/// `pick_latest_version` 的版本比较挡掉,但维护成本与误报风险不值当,故暂只为
/// Claude Code 启用。
pub(super) fn npm_prerelease_tags(tool: &str) -> &'static [&'static str] {
    match tool {
        "claude" => &["next"],
        _ => &[],
    }
}

/// 解析 "2.1.156" / "2.1.156-beta.1" → (主版本三段, 预发布段)。无法解析返回 None。
/// 与前端 `src/lib/version.ts` 的 parseVersion 语义对称(跨语言各实现一份)。
/// patch 用 u64 以容纳 codex 的 `0.1.2505172116` 时间戳式版本而不溢出。
pub(super) fn parse_semver(v: &str) -> Option<([u64; 3], Vec<String>)> {
    // 忽略 `+build` 元数据,再以首个 `-` 切出预发布段。
    let core_and_pre = v.trim().split('+').next().unwrap_or("");
    let (core, pre) = match core_and_pre.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (core_and_pre, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None; // 多于三段,非法
    }
    let pre_segments = pre
        .map(|p| p.split('.').map(|s| s.to_string()).collect())
        .unwrap_or_default();
    Some(([major, minor, patch], pre_segments))
}

/// 比较两个版本号(遵循 semver:主版本三段优先;core 相等时有预发布 < 无预发布;
/// 预发布段逐段比 —— 数字段按数值、数字段 < 非数字段、非数字段按 ASCII、前缀相同
/// 则段更多者更大)。任一无法解析返回 None,调用方据此保守处理。
pub(super) fn compare_semver(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    let (ac, ap) = parse_semver(a)?;
    let (bc, bp) = parse_semver(b)?;
    for i in 0..3 {
        match ac[i].cmp(&bc[i]) {
            Ordering::Equal => continue,
            other => return Some(other),
        }
    }
    match (ap.is_empty(), bp.is_empty()) {
        (true, true) => return Some(Ordering::Equal),
        (true, false) => return Some(Ordering::Greater),
        (false, true) => return Some(Ordering::Less),
        (false, false) => {}
    }
    for (x, y) in ap.iter().zip(bp.iter()) {
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(xv), Ok(yv)) => xv.cmp(&yv),
            (Ok(_), Err(_)) => Ordering::Less, // 数字段 < 非数字段
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => x.as_str().cmp(y.as_str()),
        };
        if ord != Ordering::Equal {
            return Some(ord);
        }
    }
    Some(ap.len().cmp(&bp.len()))
}

/// 从一次 registry 请求得到的完整 dist-tags 出发,挑选要展示的"最新版本"。
///
/// 规则:默认就是 `latest`;仅当本地版本已**严格领先** `latest`(说明用户主动在
/// 抢先通道)时,才把 `prerelease_tags` 指向的版本纳入比较,取其中能被解析、且
/// 高于 `latest` 的最高者。无法解析或不高于 latest 的脏 tag 一律落选。
pub(super) fn pick_latest_version(
    dist_tags: &serde_json::Map<String, serde_json::Value>,
    prerelease_tags: &[&str],
    local_version: Option<&str>,
) -> Option<String> {
    use std::cmp::Ordering;
    let latest = dist_tags.get("latest").and_then(|v| v.as_str())?;

    // 本地是否严格领先 latest;任一无法解析则按"未领先"保守处理(只看 latest)。
    let local_ahead = local_version
        .and_then(|local| compare_semver(local, latest))
        .map(|ord| ord == Ordering::Greater)
        .unwrap_or(false);
    if prerelease_tags.is_empty() || !local_ahead {
        return Some(latest.to_string());
    }

    let mut best = latest.to_string();
    for tag in prerelease_tags {
        if let Some(candidate) = dist_tags.get(*tag).and_then(|v| v.as_str()) {
            if compare_semver(candidate, &best) == Some(Ordering::Greater) {
                best = candidate.to_string();
            }
        }
    }
    Some(best)
}

/// npm 包 dist-tags 专用端点的 URL。
///
/// 该端点的响应体就是 dist-tags 对象本身(几十到几千字节);而 `/{package}` 返回的是
/// 含每个历史版本元数据的完整 packument,codex / opencode / openclaw 这类高频发版的包
/// 已有十几到二十几 MB,一次刷新要下几十 MB(#7339)。scoped 包名的 `/` 按 registry
/// 约定转义成 `%2f`。
pub(super) fn npm_dist_tags_url(package: &str) -> String {
    format!(
        "https://registry.npmjs.org/-/package/{}/dist-tags",
        package.replace('/', "%2f")
    )
}

/// 拉取 npm 包的完整 dist-tags(单次请求即含 latest/next/beta/...)。
///
/// 与 GitHub / PyPI 两条来源一样套 `LATEST_PROBE_TIMEOUT`:取不到就返回 None,由调用方
/// 显示「未知」,而不是沿用全局客户端的 600s 总超时让卡片一直「加载中」。包不存在时
/// 端点返回 404 与一个 JSON 字符串体,解析成 Map 失败,同样落到 None。
pub(super) async fn fetch_npm_dist_tags(
    client: &reqwest::Client,
    package: &str,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let resp = client
        .get(npm_dist_tags_url(package))
        .timeout(LATEST_PROBE_TIMEOUT)
        .send()
        .await
        .ok()?;
    resp.json::<serde_json::Map<String, serde_json::Value>>()
        .await
        .ok()
}

/// 查询某 npm 工具要展示的"最新版本":取 `latest`,并在本地版本领先时按工具的
/// 预发布通道(见 `npm_prerelease_tags`)补查 —— 复用同一次 registry 响应,无额外请求。
pub(super) async fn fetch_npm_latest_for_tool(
    client: &reqwest::Client,
    package: &str,
    tool: &str,
    local_version: Option<&str>,
) -> Option<String> {
    let dist_tags = fetch_npm_dist_tags(client, package).await?;
    pick_latest_version(&dist_tags, npm_prerelease_tags(tool), local_version)
}

/// 版本探测请求的请求级超时。全局客户端是给代理转发用的（总超时 600s / 连接 30s），
/// 探测 latest 若沿用它，api.github.com / pypi.org 被阻断或握手后挂起时，Hermes 卡片
/// 与「刷新 / 全部升级」按钮会一直等；探测拿不到就退到下一来源或显示未知即可。
pub(super) const LATEST_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Helper function to fetch latest version from GitHub releases
pub(super) async fn fetch_github_latest_version(
    client: &reqwest::Client,
    repo: &str,
) -> Option<String> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let resp = client
        .get(&url)
        .header("User-Agent", "LoliCode")
        .header("Accept", "application/vnd.github+json")
        .timeout(LATEST_PROBE_TIMEOUT)
        .send()
        .await
        .ok()?;
    let json = resp.json::<serde_json::Value>().await.ok()?;
    github_release_version_from_json(&json)
}

/// 从 GitHub latest release 的 JSON 中提取展示用版本号。
///
/// 优先取 release `name` 里能解析为语义版本的数字，其次才是 `tag_name`（去 `v` 前缀）：
/// Hermes 的 tag 是日历式（`v2026.8.31`），CLI 自报的语义版本 `0.21.0` 只出现在
/// name（"Hermes Agent v0.21.0 (v2026.8.31)"）里。两条路都经 `release_display_version`
/// 过滤——日历式数字若被当成版本号，前端三段解析会成功（2026 > 0）并永久判定
/// "有可用更新"，点升级后版本不变又触发"版本未变"误报；拿不到语义版本宁可返回
/// None，让调用方退到别的来源。限流（403 JSON 只有 message）同样落到 None。
pub(super) fn github_release_version_from_json(json: &serde_json::Value) -> Option<String> {
    let from_name = json
        .get("name")
        .and_then(|v| v.as_str())
        .and_then(|name| release_display_version(&extract_version(name)));
    from_name.or_else(|| {
        json.get("tag_name")
            .and_then(|v| v.as_str())
            .and_then(|tag| release_display_version(tag.strip_prefix('v').unwrap_or(tag)))
    })
}

/// 只接受能按语义版本解析、且首段不像年份（< 1000）的字符串作展示版本。
pub(super) fn release_display_version(candidate: &str) -> Option<String> {
    match parse_semver(candidate) {
        Some(([major, ..], _)) if major < 1000 => Some(candidate.to_string()),
        _ => None,
    }
}

/// 兜底来源给出的 latest 若已被本地版本严格超过，则不展示（返回 None）——
/// 展示一个比当前还旧的"最新版本"只会复现用户报告的"最新 < 当前"矛盾。
/// 任一侧无法解析时按"未领先"保守处理，照常展示。
pub(super) fn drop_latest_behind_local(
    latest: Option<String>,
    local_version: Option<&str>,
) -> Option<String> {
    let latest = latest?;
    let local_leads = local_version
        .and_then(|local| compare_semver(local, &latest))
        .is_some_and(|ord| ord == std::cmp::Ordering::Greater);
    (!local_leads).then_some(latest)
}

/// Hermes 的「最新版本」：GitHub Releases 为主，PyPI 兜底。
///
/// cc-switch 安装/升级 Hermes 走的是官方 install.sh（`git clone` main 分支）与
/// `hermes update`（`git pull`），整条链路与 PyPI 无关；而 PyPI 的 `hermes-agent`
/// 自 0.19.0（2026-07-20）起停更，上游只在 GitHub Releases 发版
/// （#6475 / #6618 / #7033：「最新版本」长期停在 0.19.0、比当前还旧、升级按钮不出现）。
/// 仅当 GitHub 不可达或被限流时才退到 PyPI，且该值已被本地超过时不展示，宁可显示未知。
pub(super) async fn fetch_hermes_latest_version(
    client: &reqwest::Client,
    local_version: Option<&str>,
) -> Option<String> {
    if let Some(version) = fetch_github_latest_version(client, "NousResearch/hermes-agent").await {
        return Some(version);
    }
    let pypi = fetch_pypi_latest_version(client, "hermes-agent").await;
    drop_latest_behind_local(pypi, local_version)
}

/// Helper function to fetch latest version from PyPI
pub(super) async fn fetch_pypi_latest_version(
    client: &reqwest::Client,
    package: &str,
) -> Option<String> {
    let url = format!("https://pypi.org/pypi/{package}/json");
    match client.get(&url).timeout(LATEST_PROBE_TIMEOUT).send().await {
        Ok(resp) => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                json.get("info")
                    .and_then(|info| info.get("version"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

/// 预编译的版本号正则表达式
pub(super) static VERSION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\d+\.\d+\.\d+(-[\w.]+)?").expect("Invalid version regex"));

/// WSL 版本探测载荷先打印的哨兵。用户 shell 的启动文件（Ubuntu 的 update-motd、
/// `/etc/bash.bashrc` 的 sudo 提示、nvm 的 `Using Node vX.Y.Z` 等）输出都在它前面，
/// 解析时只看它之后的内容（#7347）。
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) const VERSION_PROBE_SENTINEL: &str = "__LOLICODE_VERSION__";

/// 版本探测交给用户 shell 执行的命令：先打哨兵，再跑 `--version`。
/// 不含单引号，可以直接嵌进外层 `'...'`。
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn version_probe_payload(tool: &str) -> String {
    format!("echo {VERSION_PROBE_SENTINEL}; {tool} --version")
}

/// WSL 未指定 shell 时依次尝试的 flag：交互式初始化（nvm 等写在 rc 里）优先。
/// 卸载探测（`tool_uninstall`）按同一顺序选 flag，否则两边可能命中不同的安装。
#[cfg(any(target_os = "windows", test))]
pub(super) const WSL_AUTO_SHELL_FLAGS: [&str; 3] = ["-lic", "-lc", "-c"];

/// WSL 未指定 shell 时的版本检测命令（由外层 `sh -c` 执行）：在 `$SHELL` 里按
/// `WSL_AUTO_SHELL_FLAGS` 依次重试，或只用调用方已校验过的 `flag`。
#[cfg(any(target_os = "windows", test))]
pub(super) fn wsl_auto_shell_command(payload: &str, flag: Option<&str>) -> String {
    let flags = flag.map_or(WSL_AUTO_SHELL_FLAGS.to_vec(), |flag| vec![flag]);
    let last = flags.len() - 1;
    flags
        .iter()
        .enumerate()
        .map(|(i, flag)| {
            // 只有最后一次尝试保留 stderr，供报错展示
            let quiet = if i < last { " 2>/dev/null" } else { "" };
            format!("\"${{SHELL:-sh}}\" {flag} '{payload}'{quiet}")
        })
        .collect::<Vec<_>>()
        .join(" || ")
}

/// 取哨兵**最后一次**出现之后的输出。
///
/// 取最后一次：兜底链 `-lic || -lc || -c` 失败重试时会多次打印哨兵。
/// 按子串而非整行查找：OSC 序列可能没有换行、直接粘在哨兵前面。
/// 找不到哨兵（shell 在执行载荷之前就失败）时原样返回，保持原有行为。
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn after_version_sentinel(output: &str) -> &str {
    match output.rfind(VERSION_PROBE_SENTINEL) {
        Some(i) => output[i + VERSION_PROBE_SENTINEL.len()..].trim(),
        None => output,
    }
}

/// 从版本输出中提取纯版本号
pub(super) fn extract_version(raw: &str) -> String {
    VERSION_RE
        .find(raw)
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| raw.to_string())
}

/// 工具未安装时的统一错误文案；WSL 路径会再拼上 `[WSL:{distro}] ` 前缀。
pub(super) const NOT_INSTALLED: &str = "not installed or not executable";

/// CLI 版本探测的三态结果，跨平台统一各 probe（`try_get_version` /
/// `try_get_version_wsl` / `scan_cli_version`）的返回，进而在 `ToolVersion` 上给出
/// 结构化的 `installed_but_broken` 信号——避免前端靠匹配错误文案反推语义。
///
/// 关键区分"没装"与"装了但 `--version` 自身报错退出"（如工具要求更高的 Node 版本）：
/// 后者必须如实上报、不去别处捞旧版掩盖，否则"升级到新版却跑不起来"会被旧版盖住，
/// 表现为"升级成功但版本号不变"。
pub(super) enum ShellProbe {
    /// 成功拿到版本号
    Found(String),
    /// 可执行存在、但 `--version` 非零退出（携带诊断信息，如 stderr 末尾若干行）
    FoundButFailed(String),
    /// 没找到该命令（携带描述性消息，供 UI 展示）
    NotFound(String),
}

/// 在非 Windows 平台用用户 shell 执行 `{tool} --version` 探测版本。
///
/// Windows 不走此路径：`cmd /C {tool}` 可能误触发 App Execution Alias /
/// 协议处理器（曾导致 Windows 版整体被禁用），那里改由 `scan_cli_version`
/// 只执行已定位到的真实可执行文件。
#[cfg(not(target_os = "windows"))]
pub(super) fn try_get_version(tool: &str) -> ShellProbe {
    use std::process::Command;

    let output = {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| is_valid_shell(s))
            .unwrap_or_else(|| "sh".to_string());
        let flag = default_flag_for_shell(&shell);
        Command::new(shell)
            .arg(flag)
            .arg(format!("{tool} --version"))
            .output()
    };

    match output {
        Ok(out) => {
            let stdout = decode_command_output(&out.stdout).trim().to_string();
            let stderr = decode_command_output(&out.stderr).trim().to_string();
            if out.status.success() {
                let raw = if stdout.is_empty() { &stderr } else { &stdout };
                if raw.is_empty() {
                    ShellProbe::NotFound(NOT_INSTALLED.to_string())
                } else {
                    ShellProbe::Found(extract_version(raw))
                }
            } else {
                // exit 127 = shell 找不到命令（可放心 fallback 到搜索路径）；其它非零码
                // = 命令存在但 --version 自身报错退出，须如实上报、不 fallback 掩盖。
                let err = if stderr.is_empty() { stdout } else { stderr };
                if out.status.code() == Some(127) || err.is_empty() {
                    ShellProbe::NotFound(NOT_INSTALLED.to_string())
                } else {
                    ShellProbe::FoundButFailed(last_lines(err.trim(), 4))
                }
            }
        }
        Err(_) => ShellProbe::NotFound(NOT_INSTALLED.to_string()),
    }
}

#[cfg(target_os = "windows")]
pub(super) fn try_get_version_wsl(
    tool: &str,
    distro: &str,
    force_shell: Option<&str>,
    force_shell_flag: Option<&str>,
) -> ShellProbe {
    use std::process::Command;

    // 防御性断言：tool 只能是预定义的值
    debug_assert!(VALID_TOOLS.contains(&tool), "unexpected tool name: {tool}");

    // 校验 distro 名称，防止命令注入
    if !is_valid_wsl_distro_name(distro) {
        return ShellProbe::NotFound(format!("[WSL:{distro}] invalid distro name"));
    }

    // 构建 Shell 脚本检测逻辑
    let (shell, flag, cmd) = if let Some(shell) = force_shell {
        // Defensive validation: never allow an arbitrary executable name here.
        if !is_valid_shell(shell) {
            return ShellProbe::NotFound(format!("[WSL:{distro}] invalid shell: {shell}"));
        }
        let shell = shell.rsplit('/').next().unwrap_or(shell);
        let flag = if let Some(flag) = force_shell_flag {
            if !is_valid_shell_flag(flag) {
                return ShellProbe::NotFound(format!("[WSL:{distro}] invalid shell flag: {flag}"));
            }
            flag
        } else {
            default_flag_for_shell(shell)
        };

        (shell.to_string(), flag, version_probe_payload(tool))
    } else {
        if let Some(flag) = force_shell_flag {
            if !is_valid_shell_flag(flag) {
                return ShellProbe::NotFound(format!("[WSL:{distro}] invalid shell flag: {flag}"));
            }
        }
        let cmd = wsl_auto_shell_command(&version_probe_payload(tool), force_shell_flag);

        ("sh".to_string(), "-c", cmd)
    };

    let output = Command::new("wsl.exe")
        .args(["-d", distro, "--", &shell, flag, &cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match output {
        Ok(out) => {
            let stdout = decode_command_output(&out.stdout).trim().to_string();
            let stderr = decode_command_output(&out.stderr).trim().to_string();
            // 启动文件的输出都在哨兵之前，只看它之后（#7347）
            let payload_out = after_version_sentinel(&stdout).to_string();
            if out.status.success() {
                let raw = if payload_out.is_empty() {
                    &stderr
                } else {
                    &payload_out
                };
                if raw.is_empty() {
                    ShellProbe::NotFound(format!("[WSL:{distro}] {NOT_INSTALLED}"))
                } else {
                    ShellProbe::Found(extract_version(raw))
                }
            } else {
                let err = if stderr.is_empty() {
                    payload_out
                } else {
                    stderr
                };
                // wsl.exe 透传的退出码不总可靠，故同时用 exit 127 与 "command not found"
                // 文本兜底判别"没装"；其余非零退出视作"装了但 --version 报错"。
                let not_found = err.is_empty()
                    || out.status.code() == Some(127)
                    || err.contains("command not found")
                    || err.contains("not found");
                if not_found {
                    ShellProbe::NotFound(format!("[WSL:{distro}] {NOT_INSTALLED}"))
                } else {
                    ShellProbe::FoundButFailed(format!(
                        "[WSL:{distro}] {}",
                        last_lines(err.trim(), 4)
                    ))
                }
            }
        }
        Err(e) => ShellProbe::NotFound(format!("[WSL:{distro}] exec failed: {e}")),
    }
}

/// 非 Windows 平台的 WSL 版本检测存根
/// 注意：此函数实际上不会被调用，因为 `wsl_distro_from_path` 在非 Windows 平台总是返回 None。
/// 保留此函数是为了保持 API 一致性，防止未来重构时遗漏。
#[cfg(not(target_os = "windows"))]
pub(super) fn try_get_version_wsl(
    _tool: &str,
    _distro: &str,
    _force_shell: Option<&str>,
    _force_shell_flag: Option<&str>,
) -> ShellProbe {
    ShellProbe::NotFound("WSL check not supported on this platform".to_string())
}

/// Probe the version of the PATH-default entry on Windows. Uses
/// `resolve_path_default` (which merges the registry PATH and filters out
/// App Execution Aliases) to get the executable the user actually runs, then
/// runs `--version` on it. Consumed by `get_single_tool_version_impl` before
/// the directory scan, so the displayed version matches what `tool` resolves
/// to in a terminal (#4701).
///
/// Returns `NotFound` when no entry is resolved on PATH (the caller falls back
/// to `scan_cli_version` over the hardcoded/registry dirs); `FoundButFailed`
/// when an entry was resolved but `--version` exited non-zero (installed but
/// not runnable), which is reported as-is without falling back, so an old
/// install elsewhere cannot mask a broken default.
#[cfg(target_os = "windows")]
pub(super) fn probe_path_default_version(tool: &str) -> ShellProbe {
    let path_default = match resolve_path_default(tool, None) {
        Ok(Some(p)) => p,
        _ => return ShellProbe::NotFound(NOT_INSTALLED.to_string()),
    };
    let current_path = effective_path_string();
    match run_windows_tool_version_command(&path_default, &current_path) {
        Ok(out) => {
            let stdout = decode_command_output(&out.stdout).trim().to_string();
            let stderr = decode_command_output(&out.stderr).trim().to_string();
            if out.status.success() {
                let raw = if stdout.is_empty() { &stderr } else { &stdout };
                if raw.is_empty() {
                    ShellProbe::NotFound(NOT_INSTALLED.to_string())
                } else {
                    ShellProbe::Found(extract_version(raw))
                }
            } else {
                let err = if stderr.is_empty() { stdout } else { stderr };
                if err.is_empty() {
                    ShellProbe::NotFound(NOT_INSTALLED.to_string())
                } else {
                    ShellProbe::FoundButFailed(last_lines(err.trim(), 4))
                }
            }
        }
        Err(_) => ShellProbe::NotFound(NOT_INSTALLED.to_string()),
    }
}

/// 扫描常见路径查找 CLI（PATH 主命令未命中时的兜底单探）。
pub(super) fn scan_cli_version(tool: &str) -> ShellProbe {
    #[cfg(not(target_os = "windows"))]
    use std::process::Command;

    let search_paths = build_tool_search_paths(tool);
    #[cfg(target_os = "windows")]
    let current_path = effective_path_string();
    #[cfg(not(target_os = "windows"))]
    let current_path = effective_path_os().unwrap_or_default();

    // 记录"可执行文件存在、但 `--version` 非零退出"时的首个诊断信息。
    // 典型场景：工具已安装但当前环境跑不起来（如 openclaw 要求 Node v22.19+）。
    // 这类信息比笼统的 "not installed" 有用得多，循环结束未探到版本时回传。
    let mut exec_diagnostic: Option<String> = None;

    for path in &search_paths {
        #[cfg(target_os = "windows")]
        let new_path = format!("{};{}", path.display(), current_path);

        #[cfg(not(target_os = "windows"))]
        let new_path = prepend_search_dir_to_path(path, &current_path);

        for tool_path in tool_executable_candidates(tool, path) {
            if !tool_path.exists() {
                continue;
            }

            #[cfg(target_os = "windows")]
            let output = run_windows_tool_version_command(&tool_path, &new_path);

            #[cfg(not(target_os = "windows"))]
            let output = {
                Command::new(&tool_path)
                    .arg("--version")
                    .env("PATH", &new_path)
                    .output()
            };

            if let Ok(out) = output {
                let stdout = decode_command_output(&out.stdout).trim().to_string();
                let stderr = decode_command_output(&out.stderr).trim().to_string();
                if out.status.success() {
                    let raw = if stdout.is_empty() { &stderr } else { &stdout };
                    if !raw.is_empty() {
                        return ShellProbe::Found(extract_version(raw));
                    }
                } else if exec_diagnostic.is_none() {
                    let detail = if stderr.is_empty() { stdout } else { stderr };
                    let detail = detail.trim();
                    if !detail.is_empty() {
                        exec_diagnostic = Some(last_lines(detail, 4));
                    }
                }
            }
        }
    }

    // 有诊断 = 找到了可执行文件但 --version 报错（装了跑不起来）；否则视作未安装。
    match exec_diagnostic {
        Some(detail) => ShellProbe::FoundButFailed(detail),
        None => ShellProbe::NotFound(NOT_INSTALLED.to_string()),
    }
}
