//! Read-only bounded file discovery and regular-expression search. No shell or
//! external executable is involved; the parent validates every search root.
use super::{bounded, cancelled, read_text, relative, MAX_ENTRIES, MAX_OUTPUT};
use glob::{MatchOptions, Pattern};
use regex::{Regex, RegexBuilder};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tokio::sync::watch;

const MAX_PATTERN_BYTES: usize = 4096;
const MAX_SEARCH_BYTES: usize = 16 * 1024 * 1024;
const MAX_SEARCH_LINES: usize = 200_000;
const MAX_MATCH_LINE_CHARS: usize = 2000;
const GLOB_OPTIONS: MatchOptions = MatchOptions {
    case_sensitive: true,
    require_literal_separator: true,
    require_literal_leading_dot: false,
};

pub(super) struct GlobQuery {
    pattern: Pattern,
    max_results: usize,
}

pub(super) struct GrepQuery {
    regex: Regex,
    include: Option<Pattern>,
    include_basename: bool,
    max_results: usize,
}

fn glob_pattern(value: &str) -> Result<Pattern, String> {
    if value.is_empty()
        || value.len() > MAX_PATTERN_BYTES
        || value.chars().any(char::is_control)
        || value.starts_with('/')
        || value.contains('\\')
        || value.contains(':')
        || value.split('/').any(|part| part == "..")
    {
        return Err("glob 必须是项目内使用 / 分隔的相对模式，长度为 1–4096 字节".into());
    }
    Pattern::new(value.strip_prefix("./").unwrap_or(value))
        .map_err(|error| format!("glob 模式无效：{error}"))
}

impl GlobQuery {
    pub(super) fn new(pattern: &str, max_results: usize) -> Result<Self, String> {
        Ok(Self {
            pattern: glob_pattern(pattern)?,
            max_results,
        })
    }
}

impl GrepQuery {
    pub(super) fn new(
        pattern: &str,
        include: Option<&str>,
        case_sensitive: bool,
        max_results: usize,
    ) -> Result<Self, String> {
        if pattern.is_empty() || pattern.len() > MAX_PATTERN_BYTES || pattern.contains('\0') {
            return Err("正则表达式必须为 1–4096 字节".into());
        }
        let regex = RegexBuilder::new(pattern)
            .case_insensitive(!case_sensitive)
            .size_limit(1024 * 1024)
            .dfa_size_limit(1024 * 1024)
            .build()
            .map_err(|error| format!("正则表达式无效或过于复杂：{error}"))?;
        Ok(Self {
            regex,
            include: include.map(glob_pattern).transpose()?,
            include_basename: include.is_some_and(|value| !value.contains('/')),
            max_results,
        })
    }
}

fn ignored(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "coverage"
            | ".next"
            | ".nuxt"
            | ".turbo"
            | ".cache"
            | ".venv"
            | "venv"
            | "__pycache__"
            | "vendor"
    )
}

#[derive(Default)]
struct Scan {
    files: Vec<PathBuf>,
    visited: usize,
    truncated: bool,
}

fn collect(
    root: &Path,
    path: &Path,
    depth: usize,
    scan: &mut Scan,
    cancel: &watch::Receiver<bool>,
) -> Result<(), String> {
    cancelled(cancel)?;
    if depth > 20 || scan.visited >= MAX_ENTRIES {
        scan.truncated = true;
        return Ok(());
    }
    let relative_path = path
        .strip_prefix(root)
        .map_err(|_| "搜索路径越过项目边界")?;
    let is_file = path.is_file();
    let directories = if is_file {
        relative_path.parent().unwrap_or_else(|| Path::new(""))
    } else {
        relative_path
    };
    if directories
        .components()
        .any(|component| ignored(&component.as_os_str().to_string_lossy()))
    {
        return Ok(());
    }
    if is_file {
        scan.files.push(path.to_path_buf());
        return Ok(());
    }
    let remaining = MAX_ENTRIES.saturating_sub(scan.visited);
    let mut children = fs::read_dir(path)
        .map_err(|_| "无法列出搜索目录")?
        .take(remaining + 1)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "无法读取搜索目录条目")?;
    if children.len() > remaining {
        children.truncate(remaining);
        scan.truncated = true;
    }
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        cancelled(cancel)?;
        if scan.visited >= MAX_ENTRIES {
            scan.truncated = true;
            break;
        }
        scan.visited += 1;
        let kind = child.file_type().map_err(|_| "无法检查搜索目录条目")?;
        if kind.is_symlink() || kind.is_dir() && ignored(&child.file_name().to_string_lossy()) {
            continue;
        }
        let target = fs::canonicalize(child.path()).map_err(|_| "搜索目录在读取时发生变化")?;
        if !target.starts_with(root) {
            return Err("搜索目录条目越过项目边界".into());
        }
        if kind.is_file() {
            scan.files.push(target);
        } else if kind.is_dir() {
            collect(root, &target, depth + 1, scan, cancel)?;
        }
    }
    Ok(())
}

fn scan(root: &Path, path: &Path, cancel: &watch::Receiver<bool>) -> Result<Scan, String> {
    let mut scan = Scan::default();
    collect(root, path, 0, &mut scan, cancel)?;
    scan.files.sort();
    Ok(scan)
}

fn finish(mut output: String, found: usize, truncated: bool, empty: &str) -> String {
    if found == 0 {
        output.push_str(empty);
        output.push('\n');
    }
    if truncated {
        output.push_str("[搜索已截断：达到遍历、扫描或结果上限；可缩小 path 或模式后继续]\n");
    }
    bounded(output)
}

pub(super) fn glob(
    root: &Path,
    path: &Path,
    query: GlobQuery,
    cancel: &watch::Receiver<bool>,
) -> Result<String, String> {
    let scan = scan(root, path, cancel)?;
    let mut truncated = scan.truncated;
    let mut output = String::new();
    let mut found = 0;
    for file in scan.files {
        cancelled(cancel)?;
        let candidate = file
            .strip_prefix(path)
            .map_err(|_| "匹配文件越过搜索目录")?;
        if !query.pattern.matches_path_with(candidate, GLOB_OPTIONS) {
            continue;
        }
        if found >= query.max_results || output.len() >= MAX_OUTPUT {
            truncated = true;
            break;
        }
        output.push_str(&relative(root, &file));
        output.push('\n');
        found += 1;
    }
    Ok(finish(
        output,
        found,
        truncated,
        "在本次已扫描范围内未找到匹配文件",
    ))
}

pub(super) fn grep(
    root: &Path,
    path: &Path,
    query: GrepQuery,
    cancel: &watch::Receiver<bool>,
) -> Result<String, String> {
    let scan = scan(root, path, cancel)?;
    let mut truncated = scan.truncated;
    let mut output = String::new();
    let mut found = 0;
    let mut bytes = 0;
    let mut lines = 0;
    'files: for file in scan.files {
        cancelled(cancel)?;
        if let Some(include) = &query.include {
            let candidate = if query.include_basename {
                Path::new(file.file_name().ok_or("搜索文件缺少文件名")?)
            } else if path.is_file() {
                Path::new(file.file_name().ok_or("搜索文件缺少文件名")?)
            } else {
                file.strip_prefix(path)
                    .map_err(|_| "匹配文件越过搜索目录")?
            };
            if !include.matches_path_with(candidate, GLOB_OPTIONS) {
                continue;
            }
        }
        let current = fs::canonicalize(&file).map_err(|_| "搜索文件在读取时发生变化")?;
        if !current.starts_with(root) {
            return Err("搜索文件越过项目边界".into());
        }
        let Ok(content) = read_text(&current) else {
            continue;
        };
        if bytes + content.len() > MAX_SEARCH_BYTES {
            truncated = true;
            break;
        }
        bytes += content.len();
        for (index, line) in content.lines().enumerate() {
            cancelled(cancel)?;
            if lines >= MAX_SEARCH_LINES {
                truncated = true;
                break 'files;
            }
            lines += 1;
            if !query.regex.is_match(line) {
                continue;
            }
            if found >= query.max_results || output.len() >= MAX_OUTPUT {
                truncated = true;
                break 'files;
            }
            output.push_str(&format!("{}:{}: ", relative(root, &file), index + 1));
            let mut characters = line.chars();
            output.extend(characters.by_ref().take(MAX_MATCH_LINE_CHARS));
            if characters.next().is_some() {
                output.push_str(" [匹配行已截断]");
            }
            output.push('\n');
            found += 1;
        }
    }
    Ok(finish(
        output,
        found,
        truncated,
        "在本次已扫描范围内未找到匹配内容",
    ))
}
