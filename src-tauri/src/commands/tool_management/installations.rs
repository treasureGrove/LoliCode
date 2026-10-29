//! Installation discovery, source identification and diagnostic IPC commands.

use super::lifecycle::{last_lines, normalize_requested_tools, plan_command_for, UpdateCommand};
#[cfg(not(target_os = "windows"))]
use super::paths::effective_path_os;
#[cfg(target_os = "windows")]
use super::paths::effective_path_string;
#[cfg(not(target_os = "windows"))]
use super::paths::prepend_search_dir_to_path;
use super::paths::resolve_path_default;
use super::paths::{build_tool_search_paths, tool_executable_candidates};
use super::process::run_probe_version_command;
use super::process::{decode_command_output, CommandDeadline, INSTALL_PROBE_TIMEOUT};
use super::versions::extract_version;
use std::path::Path;

/// 单个工具在系统中的一处安装，用于"多处安装互相打架"的冲突诊断。
/// 字段保持 snake_case（与 `ToolVersion` 一致），前端按同名字段读取。
#[derive(Debug, serde::Serialize)]
pub struct ToolInstallation {
    /// 候选入口路径（用户实际在 PATH 里看到/输入的那个，未解析软链）。
    pub(super) path: String,
    /// `--version` 成功时解析出的版本号。
    pub(super) version: Option<String>,
    /// `--version` 是否 exit 0（装了且能在当前环境跑起来）。
    pub(super) runnable: bool,
    /// 跑不起来时的诊断信息末尾若干行。
    pub(super) error: Option<String>,
    /// 由路径前缀推断的安装来源（nvm/homebrew/...），驱动 UI 徽章。
    pub(super) source: String,
    /// 是否为 PATH 解析到的那处（= 命令行默认，也是升级会作用的目标）。
    pub(super) is_path_default: bool,
    /// canonicalize 解析后的真身路径(brew 形如 `Cellar/<formula>/...`、claude 原生形如
    /// `~/.local/share/claude/versions/...`),用于 `anchored_command_from_paths` 的真身
    /// 判定。`enumerate_tool_installations` 已经为去重算过一次,这里复用避免上游
    /// `installs_anchored_command` 再 canonicalize 一遍——消除冗余 syscall + 闭合
    /// "enumerate 与 anchor 看到同一真身"的一致性边界(否则两次 canonicalize 之间
    /// symlink 被换会让锚定指向不同真身)。`#[serde(skip)]` 不外露给前端。
    #[serde(skip)]
    pub(super) real: std::path::PathBuf,
}

/// 由可执行文件路径前缀推断安装来源。纯字符串匹配、无副作用。
/// 顺序敏感：Homebrew 的 Cellar / Caskroom 真身要先于通用规则命中。
pub(super) fn infer_install_source(path: &Path) -> &'static str {
    let s = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if s.contains("/.nvm/") {
        "nvm"
    } else if s.contains("/homebrew/") || s.contains("/cellar/") || s.contains("/caskroom/") {
        "homebrew"
    // `.volta` 是 macOS/Linux 默认安装(`~/.volta/bin`),`/volta/` 兜底覆盖
    // Windows 的 `%LOCALAPPDATA%\Volta\bin` / `%VOLTA_HOME%\bin`(无前导点)。
    } else if s.contains("/.volta/") || s.contains("/volta/") {
        "volta"
    } else if s.contains("fnm_multishells") {
        "fnm"
    } else if s.contains("/mise/") {
        "mise"
    } else if s.contains("/.bun/") {
        "bun"
    // pnpm 全局包目录: macOS 一般 `~/.local/share/pnpm`(已 normalize 到 `/pnpm/`)
    // 与 Windows `%LOCALAPPDATA%\pnpm` / `%PNPM_HOME%` 都命中 `/pnpm/`。
    } else if s.contains("/pnpm/") {
        "pnpm"
    } else if s.contains("/scoop/") {
        "scoop"
    } else if s.contains("/library/python")
        || s.contains("/scripts/")
        || s.contains("/site-packages/")
    {
        "pip"
    } else {
        "system"
    }
}

/// 安装来源：Homebrew 看 canonicalize 真身，node 管理器仍看 launcher。
///
/// Intel Cask 入口是 `/usr/local/bin/codex`，不含 `/homebrew/` / `/caskroom/`，
/// 真身才在 `/usr/local/Caskroom/...`。只看 launcher 会把徽章标成 `system`。
/// nvm/volta/fnm 的分类在 shim 路径上，必须继续用未解析的入口。
pub(super) fn infer_install_source_for_install(launcher: &Path, real: &Path) -> &'static str {
    let real_s = real
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if real_s.contains("/cellar/") || real_s.contains("/caskroom/") {
        "homebrew"
    } else {
        infer_install_source(launcher)
    }
}

/// 枚举工具在系统中的所有安装（不短路）。与 `scan_cli_version` 共用
/// `build_tool_search_paths`，但不在首个命中处停止——而是对每个去重后的真实
/// 可执行文件都跑一次 `--version`，从而能发现"升级写入 A 处、PATH 实际用 B 处"。
pub(super) fn enumerate_tool_installations(tool: &str) -> Vec<ToolInstallation> {
    let search_paths = build_tool_search_paths(tool);
    #[cfg(target_os = "windows")]
    let current_path = effective_path_string();
    #[cfg(not(target_os = "windows"))]
    let current_path = effective_path_os().unwrap_or_default();
    // 必须带超时：deadline 传 None 时 wait_child_output 无限等，登录 shell 一挂
    // 整个预检就永久卡死（且前端此阶段无任何反馈）。定位失败仅丢失 is_path_default
    // 标记，非致命。
    let path_default = resolve_path_default(
        tool,
        CommandDeadline::from_timeout(Some(INSTALL_PROBE_TIMEOUT)),
    )
    .ok()
    .flatten();

    let mut seen: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();
    let mut installs: Vec<ToolInstallation> = Vec::new();

    for dir in &search_paths {
        #[cfg(target_os = "windows")]
        let new_path = format!("{};{}", dir.display(), current_path);
        #[cfg(not(target_os = "windows"))]
        let new_path = prepend_search_dir_to_path(dir, &current_path);

        for tool_path in tool_executable_candidates(tool, dir) {
            if !tool_path.exists() {
                continue;
            }
            // canonicalize 解析软链后去重：/opt/homebrew/bin/x → Cellar/...、nvm shim 等
            // 多个入口可能指向同一真实文件，只算一处安装。
            let real = std::fs::canonicalize(&tool_path).unwrap_or_else(|_| tool_path.clone());
            if !seen.insert(real.clone()) {
                continue;
            }

            let output = run_probe_version_command(&tool_path, &new_path);

            let (version, runnable, error) = match output {
                Ok(out) if out.status.success() => {
                    let stdout = decode_command_output(&out.stdout).trim().to_string();
                    let stderr = decode_command_output(&out.stderr).trim().to_string();
                    let raw = if stdout.is_empty() { stderr } else { stdout };
                    (Some(extract_version(&raw)), true, None)
                }
                Ok(out) => {
                    let stderr = decode_command_output(&out.stderr).trim().to_string();
                    let stdout = decode_command_output(&out.stdout).trim().to_string();
                    let detail = if stderr.is_empty() { stdout } else { stderr };
                    let detail = detail.trim();
                    let error = if detail.is_empty() {
                        None
                    } else {
                        Some(last_lines(detail, 4))
                    };
                    (None, false, error)
                }
                Err(e) => (None, false, Some(e)),
            };

            let is_path_default = path_default.as_ref() == Some(&real);
            let path_str = tool_path.display().to_string();
            let source = infer_install_source_for_install(&tool_path, &real);

            installs.push(ToolInstallation {
                path: path_str,
                version,
                runnable,
                error,
                source: source.to_string(),
                is_path_default,
                // 复用上面 line ~1357 已 canonicalize 的真身,避免下游
                // installs_anchored_command 再 canonicalize 一遍同一文件。
                real: real.clone(),
            });
        }
    }

    // PATH 默认那处排最前，UI 一眼看到"命令行默认用的是哪处"。
    installs.sort_by_key(|i| std::cmp::Reverse(i.is_path_default));
    installs
}

/// 取路径的父目录(纯字符串截断,不碰 fs):`/a/b/npm` → `/a/b`、`C:\a\b\npm.cmd`
/// → `C:\a\b`、混合分隔符 `C:\a/b\npm` → `C:\a/b`。无父目录返回空串。
///
/// 平台无关:`\` 和 `/` 都识别,取两者最右出现位置。`Option<usize>` 的 Ord 让
/// `None < Some(_)`,所以 `rfind('\\').max(rfind('/'))` 自动取存在的那个、两者都
/// 存在时取靠右的——比 `or_else` 优先取一种正确(混合分隔符不会拿错父目录)。
/// 跨平台 fs separator 在两侧均接受,使 macOS/Linux 上的 cargo test 也能跑 Windows
/// 路径用例(`parent_dir_cases::mixed_separators_takes_rightmost`)。空串语义由上游
/// `sibling_bin` 的 `is_empty()` 检查转成 None → 锚定整体退化到静态兜底。
pub(super) fn parent_dir(p: &str) -> String {
    match p.rfind('\\').max(p.rfind('/')) {
        Some(i) if i > 0 => p[..i].to_string(),
        _ => String::new(),
    }
}

/// 从 canonicalize 后的真身路径提取 Homebrew formula 名：
/// `/opt/homebrew/Cellar/gemini-cli/0.13.0/...` → `Some("gemini-cli")`。
/// 非 Cellar 路径（= 不是 formula，可能是 Homebrew 的 node 装的 npm 全局包）返回 None。
/// 关键区分：formula 即便内部用 node，真身也落在 `Cellar/<formula>/` 下；而 Homebrew
/// npm 全局包落在 `/opt/homebrew/lib/node_modules`（不含 Cellar）。两者升级命令不同。
#[cfg(not(target_os = "windows"))]
pub(super) fn brew_formula_from_path(real: &str) -> Option<String> {
    brew_token_from_path(real, "Cellar")
}

/// 从 canonicalize 后的真身路径提取 Homebrew cask token：
/// `/opt/homebrew/Caskroom/codex/0.146.0/bin/codex` → `Some("codex")`。
/// 非 Caskroom 路径返回 None。Cask 是预编译二进制，不走 node；若误判成 Homebrew
/// npm 全局包，会用 sibling `npm i -g` 覆盖 `/opt/homebrew/bin/<tool>` 并触发 EEXIST。
#[cfg(not(target_os = "windows"))]
pub(super) fn brew_cask_from_path(real: &str) -> Option<String> {
    brew_token_from_path(real, "Caskroom")
}

/// Homebrew 安装目录形如 `<prefix>/{Cellar,Caskroom}/<token>/<version>/...`。
/// 取出 `marker` 后的第一段作为 formula 名或 cask token；大小写不敏感，兼容
/// `/usr/local/Caskroom`（Intel）与 `/opt/homebrew/Caskroom`（Apple Silicon）。
#[cfg(not(target_os = "windows"))]
pub(super) fn brew_token_from_path(real: &str, marker: &str) -> Option<String> {
    let mut segs = real.split('/');
    while let Some(seg) = segs.next() {
        if seg.eq_ignore_ascii_case(marker) {
            return segs.next().filter(|s| !s.is_empty()).map(|s| s.to_string());
        }
    }
    None
}

/// Cellar formula 或 Caskroom cask 都由 Homebrew 拥有，升级必须走 brew，
/// 不能落到 sibling npm。任一命中即视为 brew-managed。
#[cfg(not(target_os = "windows"))]
pub(super) fn is_brew_managed_path(real: &str) -> bool {
    brew_formula_from_path(real).is_some() || brew_cask_from_path(real).is_some()
}

/// xAI's native installer uses `~/.grok/bin` for its launchers and
/// `~/.grok/downloads/grok-<platform>` for the downloaded binary. The launcher
/// directory also covers the default Windows layout, where the executable is
/// copied instead of symlinked. Checking the real target additionally supports
/// a custom `$GROK_BIN_DIR` on POSIX, whose launcher still points into the
/// standard downloads directory.
pub(super) fn is_grok_native_install(bin_path: &str, real_target: &str) -> bool {
    [bin_path, real_target].iter().any(|path| {
        let normalized = path.replace('\\', "/").to_ascii_lowercase();
        normalized.contains("/.grok/bin/") || normalized.contains("/.grok/downloads/grok-")
    })
}

pub(super) fn last_path_segment_lower(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// MiniMax Code 官方 installer 的入口布局（见 `mcode_extra_search_paths`）：POSIX 为
/// `<root>/bin/mcode`（读 `<root>/current` 再转发的 sh launcher，不是软链），Windows 的
/// `mcode.cmd` 直接放在 `<root>` 下。显式传参而不是在函数里 `cfg`，两种布局都能在任一
/// 平台上单测。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum McodeLayout {
    Posix,
    Windows,
}

impl McodeLayout {
    pub(super) const NATIVE: Self = if cfg!(target_os = "windows") {
        Self::Windows
    } else {
        Self::Posix
    };
}

/// 从入口路径推出安装根目录候选（installer 的 `MCODE_INSTALL_DIR`）。只是候选，是否真
/// 属于 installer 由调用方判定。只有 POSIX 布局才去掉入口所在的那层 `bin`：Windows 的
/// 根目录本身可以叫 `bin`（如 `MCODE_INSTALL_DIR=C:\Users\me\bin`），不能再上跳一级。
pub(super) fn mcode_install_root_candidate(path: &str, layout: McodeLayout) -> String {
    let dir = parent_dir(path);
    if layout == McodeLayout::Posix && last_path_segment_lower(&dir) == "bin" {
        parent_dir(&dir)
    } else {
        dir
    }
}

/// 若入口位于默认安装目录 `.minimax-code`，返回该目录。纯字符串、不碰 fs（与 POSIX
/// 锚定的纯函数约定一致）；自定义 `MCODE_INSTALL_DIR` 由 `installs_anchored_command`
/// 里的 `mcode_receipt_install_root` 按回执认领，这里只兜底回执缺失的情况。
/// 先看 `bin_path`：Windows 的 `real` 是 canonicalize 出的 `\\?\` verbatim 路径，
/// 不宜原样交给 installer；`real_target` 覆盖用户自建软链指向 launcher 的情况。
pub(super) fn mcode_script_install_root(
    bin_path: &str,
    real_target: &str,
    layout: McodeLayout,
) -> Option<String> {
    [bin_path, real_target].iter().find_map(|path| {
        let root = mcode_install_root_candidate(path, layout);
        (last_path_segment_lower(&root) == ".minimax-code").then_some(root)
    })
}

/// 按 installer 写在 `<root>/install.json` 的回执认领安装目录——自定义
/// `MCODE_INSTALL_DIR` 的目录名不固定，只能靠它（schema 1/2 都有 `product` /
/// `updateOwner` / `prefix`）。返回回执里的 `prefix` 原值：installer 以
/// `path.resolve(prefix) === path.resolve(MCODE_INSTALL_DIR)` 判定归属，传原值才会
/// 原地升级而非走 repair 迁移。要求 `prefix` 与回执所在目录是同一目录，挡住拷贝来的回执。
pub(super) fn mcode_receipt_install_root(entry: &str, layout: McodeLayout) -> Option<String> {
    let root = std::path::PathBuf::from(mcode_install_root_candidate(entry, layout));
    let text = std::fs::read_to_string(root.join("install.json")).ok()?;
    // install.ps1 用 `Set-Content -Encoding UTF8` 写回执，Windows PowerShell 5.1 会带
    // UTF-8 BOM；serde_json 不跳过 BOM，不剥掉就在第 1 列报错、退回全局 npm。
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let receipt: serde_json::Value = serde_json::from_str(text).ok()?;
    let field = |key: &str| receipt.get(key).and_then(serde_json::Value::as_str);
    if field("product")? != "minimax-code" || field("updateOwner")? != "npm-prefix" {
        return None;
    }
    let prefix = field("prefix")?;
    let same_dir = std::fs::canonicalize(prefix).ok()? == std::fs::canonicalize(&root).ok()?;
    same_dir.then(|| prefix.to_string())
}

/// 从枚举结果里取"命令行实际命中的那处"：优先 `is_path_default`；否则（解析不到
/// PATH 默认、但只有一处）取唯一那处；多处且无默认标记 → None（无从锚定）。
///
/// 全平台共用——POSIX 和 Windows 版的 `anchored_command_from_paths` 都通过
/// `installs_anchored_command` 调它,取默认那处再 canonicalize 拿真身。
pub(super) fn default_install(installs: &[ToolInstallation]) -> Option<&ToolInstallation> {
    installs.iter().find(|i| i.is_path_default).or_else(|| {
        if installs.len() == 1 {
            installs.first()
        } else {
            None
        }
    })
}

pub(super) fn locate_default_tool(
    tool: &str,
    deadline: Option<CommandDeadline>,
) -> Result<std::path::PathBuf, String> {
    let path_default = resolve_path_default(tool, deadline)?;

    let mut seen = std::collections::HashSet::new();
    let mut candidates = Vec::new();
    for dir in build_tool_search_paths(tool) {
        for candidate in tool_executable_candidates(tool, &dir) {
            if !candidate.exists() {
                continue;
            }
            let real = std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
            if path_default.as_ref() == Some(&real) {
                return Ok(candidate);
            }
            if seen.insert(real) {
                candidates.push(candidate);
            }
        }
    }

    if let Some(path) = path_default {
        return Ok(path);
    }

    match candidates.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(format!("{tool} is not installed")),
        _ => Err(format!(
            "{tool} is installed but its default installation is ambiguous"
        )),
    }
}

/// 多处安装是否构成"真冲突"：≥2 处，且(版本分歧 或 有的能跑有的跑不起来)。
/// 同版本装两份且都能跑不算冲突（不打扰用户）。诊断展示据此判定。
pub(super) fn is_conflicting(installs: &[ToolInstallation]) -> bool {
    if installs.len() < 2 {
        return false;
    }
    let distinct_versions: std::collections::HashSet<&Option<String>> =
        installs.iter().map(|i| &i.version).collect();
    let runnable_mixed =
        installs.iter().any(|i| i.runnable) && installs.iter().any(|i| !i.runnable);
    distinct_versions.len() > 1 || runnable_mixed
}

/// 一次"探测工具安装分布"的结果：枚举到的所有安装 + 各项衍生判定。同时服务两条
/// 路径——诊断展示（`is_conflict`）与升级确认（`needs_confirmation`/`command`/`anchored`）。
/// 字段保持 snake_case（与 `ToolInstallation` 一致），前端按同名读取。
#[derive(Debug, serde::Serialize)]
pub struct ToolInstallationReport {
    tool: String,
    /// 该工具枚举到的所有安装。
    installs: Vec<ToolInstallation>,
    /// 严阈值：≥2 且(版本分歧或运行态混合)。诊断按钮/自动补诊据此展示冲突。
    is_conflict: bool,
    /// 宽阈值：≥2 处。升级确认据此弹窗（升级只动一处，任何多处都该让用户知情）。
    needs_confirmation: bool,
    /// 锚定后将执行的升级命令（仅展示；真正执行时后端会重新生成，不信任前端回传）。
    command: String,
    /// 是否成功锚定到某处具体安装。false = 退到裸 fallback 命令（无法确定命令行实际
    /// 命中哪处，或该处无同级 npm）；前端据此给出"默认入口无法确定"的诚实文案。
    anchored: bool,
    /// 默认那处是认不出安装渠道的原生可执行文件（见 `UpdateCommand::Unmanaged`）：
    /// 不会执行升级，此时 `command` 为空；前端跳过该工具并提示用原安装方式升级。
    unmanaged: bool,
}

/// 探测各工具的安装分布：枚举所有安装、标记冲突、生成锚定升级命令。只读、无副作用。
/// 诊断按钮、升级前确认、升级后补诊共用此命令，各取所需字段——避免对同一份枚举结果
/// 散落多套下游判定。
#[tauri::command]
pub async fn probe_tool_installations(
    tools: Vec<String>,
) -> Result<Vec<ToolInstallationReport>, String> {
    let requested = normalize_requested_tools(&tools);
    if requested.is_empty() {
        return Err("No supported tools selected".to_string());
    }
    tokio::task::spawn_blocking(move || {
        requested
            .into_iter()
            .map(|tool| {
                let installs = enumerate_tool_installations(tool);
                let (update, needs_confirmation) = plan_command_for(tool, &installs);
                let (command, anchored, unmanaged) = match update {
                    UpdateCommand::Anchored(command) => (command, true, false),
                    UpdateCommand::Static(command) => (command, false, false),
                    UpdateCommand::Unmanaged => (String::new(), false, true),
                };
                let is_conflict = is_conflicting(&installs);
                ToolInstallationReport {
                    tool: tool.to_string(),
                    installs,
                    is_conflict,
                    needs_confirmation,
                    command,
                    anchored,
                    unmanaged,
                }
            })
            .collect()
    })
    .await
    .map_err(|e| format!("probe task join error: {e}"))
}

/// 「应用」页显示每个工具的路径、安装来源和多处安装。和升级前的预检是同一份枚举，
/// 单列一个命令只为把「打开页面时的展示」和「点升级时的预检」分开调用。
#[tauri::command]
pub async fn list_tool_installations(
    tools: Vec<String>,
) -> Result<Vec<ToolInstallationReport>, String> {
    probe_tool_installations(tools).await
}

#[cfg(target_os = "windows")]
pub(super) fn wsl_distro_for_tool(tool: &str) -> Option<String> {
    let override_dir = match tool {
        "claude" => crate::settings::get_claude_override_dir(),
        "codex" => crate::settings::get_codex_override_dir(),
        "gemini" => crate::settings::get_gemini_override_dir(),
        "grok" => crate::settings::get_grok_override_dir(),
        "opencode" => crate::settings::get_opencode_override_dir(),
        "openclaw" => crate::settings::get_openclaw_override_dir(),
        "hermes" => crate::settings::get_hermes_override_dir(),
        "pi" => crate::settings::get_pi_override_dir(),
        _ => None,
    }?;

    wsl_distro_from_path(&override_dir)
}

/// 从 UNC 路径中提取 WSL 发行版名称
/// 支持 `\\wsl$\Ubuntu\...` 和 `\\wsl.localhost\Ubuntu\...` 两种格式
#[cfg(target_os = "windows")]
pub(super) fn wsl_distro_from_path(path: &Path) -> Option<String> {
    use std::path::{Component, Prefix};
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return None;
    };
    match prefix.kind() {
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
            let server_name = server.to_string_lossy();
            if server_name.eq_ignore_ascii_case("wsl$")
                || server_name.eq_ignore_ascii_case("wsl.localhost")
            {
                let distro = share.to_string_lossy().to_string();
                if !distro.is_empty() {
                    return Some(distro);
                }
            }
            None
        }
        _ => None,
    }
}
