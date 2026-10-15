//! Bounded local tools. The engine owns approval; paths are revalidated at execution.
use crate::AgentDiff;
use serde_json::{json, Map, Value};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tokio::sync::watch;

mod command;
#[cfg(test)]
mod tests;

const MAX_FILE: usize = 1024 * 1024;
const MAX_OUTPUT: usize = 128 * 1024;
const MAX_ENTRIES: usize = 2000;
/// Successful cancellation after tool cleanup, distinct from cleanup failure.
pub const CANCELLED: &str = "任务已停止";
pub const CLEANUP_UNCERTAIN_PREFIX: &str = "[cleanup_uncertain]";
pub fn cleanup_uncertain(error: &str) -> bool {
    error.starts_with(CLEANUP_UNCERTAIN_PREFIX)
}
fn cleanup_failure(message: &str) -> String {
    format!("{CLEANUP_UNCERTAIN_PREFIX}{message}")
}

pub struct ToolInspection {
    pub action: String,
    pub resources: Vec<String>,
    pub description: String,
    pub mutating: bool,
    pub requires_approval: bool,
    pub dangerous: bool,
}
pub struct ToolOutput {
    pub text: String,
    pub diffs: Vec<AgentDiff>,
    /// Full snapshots are private engine input for cumulative diffs; never
    /// include them in model tool results or IPC snapshots.
    pub file_changes: Vec<FileChange>,
}
pub struct FileChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

pub fn schemas() -> Vec<Value> {
    [
        ("read_file", "Read UTF-8 text inside the project. offset is a 1-based line number; output is bounded.", json!({"path":{"type":"string"},"offset":{"type":"integer","minimum":1},"limit":{"type":"integer","minimum":1,"maximum":2000}}), vec!["path"]),
        ("list_files", "List project entries. Recursive listing skips .git, node_modules and target, and is bounded.", json!({"path":{"type":"string"},"recursive":{"type":"boolean"}}), vec![]),
        ("search_files", "Search literal, case-sensitive text in project UTF-8 files, not a regular expression. Skips dependency/build directories and binary or oversized files.", json!({"path":{"type":"string"},"pattern":{"type":"string","minLength":1},"max_results":{"type":"integer","minimum":1,"maximum":500}}), vec!["pattern"]),
        ("write_file", "Atomically create or replace one UTF-8 project file. expected_content must exactly match an existing file; null means the file must not exist. Read existing files first. Parent directory must exist.", json!({"path":{"type":"string"},"content":{"type":"string"},"expected_content":{"type":["string","null"]}}), vec!["path","content","expected_content"]),
        ("apply_patch", "Atomically replace one exact, unique, non-empty old_text occurrence in an existing UTF-8 project file. Ambiguous or stale text is rejected.", json!({"path":{"type":"string"},"old_text":{"type":"string","minLength":1},"new_text":{"type":"string"}}), vec!["path","old_text","new_text"]),
        ("run_command", "Run a project shell command with bounded output and a 1–120 second timeout. Only a narrow set of read-only version/Git commands can bypass approval; scripts and shell operators require one-time approval.", json!({"command":{"type":"string","minLength":1},"workdir":{"type":"string"},"timeout_seconds":{"type":"integer","minimum":1,"maximum":120}}), vec!["command"]),
    ].into_iter().map(|(name, description, properties, required)| json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}})).collect()
}

fn args<'a>(input: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let object = input.as_object().ok_or("工具参数必须是对象")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("工具包含未知参数".into());
    }
    Ok(object)
}
fn text<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.contains('\0') && s.len() <= MAX_FILE)
        .ok_or_else(|| format!("工具参数 {key} 必须是有效的有界字符串"))
}
fn number(input: &Map<String, Value>, key: &str, default: u64, max: u64) -> Result<u64, String> {
    match input.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|value| *value > 0 && *value <= max)
            .ok_or_else(|| format!("工具参数 {key} 超出范围")),
    }
}
fn boolean(input: &Map<String, Value>, key: &str, default: bool) -> Result<bool, String> {
    input
        .get(key)
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| format!("工具参数 {key} 必须是布尔值"))
        })
        .unwrap_or(Ok(default))
}
fn optional_path<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    if input.contains_key(key) {
        text(input, key)
    } else {
        Ok(".")
    }
}

fn root(project: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(project).map_err(|_| "项目目录不存在或无法访问")?;
    if !root.is_dir() {
        return Err("项目必须是文件夹".into());
    }
    Ok(root)
}

fn resolve(root: &Path, input: &str, allow_new: bool) -> Result<PathBuf, String> {
    if input.is_empty() || input.len() > 4096 || input.contains('\0') {
        return Err("文件路径无效".into());
    }
    let path = Path::new(input);
    for part in path.components() {
        if matches!(part, Component::ParentDir) {
            return Err("路径不能包含上级目录跳转".into());
        }
        if let Component::Normal(name) = part {
            let name = name.to_string_lossy();
            if cfg!(windows)
                && (name.contains(':')
                    || name.ends_with([' ', '.'])
                    || matches!(
                        name.split('.')
                            .next()
                            .unwrap_or_default()
                            .to_ascii_uppercase()
                            .as_str(),
                        "CON"
                            | "PRN"
                            | "AUX"
                            | "NUL"
                            | "COM1"
                            | "COM2"
                            | "COM3"
                            | "COM4"
                            | "COM5"
                            | "COM6"
                            | "COM7"
                            | "COM8"
                            | "COM9"
                            | "LPT1"
                            | "LPT2"
                            | "LPT3"
                            | "LPT4"
                            | "LPT5"
                            | "LPT6"
                            | "LPT7"
                            | "LPT8"
                            | "LPT9"
                    ))
            {
                return Err("不支持设备或备用数据流路径".into());
            }
        }
    }
    #[cfg(windows)]
    if let Some(Component::Prefix(prefix)) = path.components().next() {
        use std::path::Prefix;
        if !matches!(
            prefix.kind(),
            Prefix::Disk(_)
                | Prefix::UNC(_, _)
                | Prefix::VerbatimDisk(_)
                | Prefix::VerbatimUNC(_, _)
        ) {
            return Err("不支持设备路径".into());
        }
    }
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let resolved = match fs::canonicalize(&candidate) {
        Ok(path) => path,
        Err(error) if allow_new && error.kind() == std::io::ErrorKind::NotFound => {
            // A dangling symlink is not a new file and must never be replaced.
            if fs::symlink_metadata(&candidate).is_ok() {
                return Err("不能写入失效的符号链接".into());
            }
            let parent = fs::canonicalize(candidate.parent().ok_or("路径缺少父目录")?)
                .map_err(|_| "父目录不存在或无法访问")?;
            parent.join(candidate.file_name().ok_or("路径缺少文件名")?)
        }
        Err(_) => return Err("路径不存在或无法访问".into()),
    };
    if !resolved.starts_with(root) {
        return Err("此工具暂不支持项目目录外的路径；符号链接也不能越过项目边界".into());
    }
    Ok(resolved)
}

enum Call {
    Read(PathBuf, u64, u64),
    List(PathBuf, bool),
    Search(PathBuf, String, usize),
    Write(PathBuf, String, Option<String>),
    Patch(PathBuf, String, String),
    Command(PathBuf, String, u64),
}
fn parse(project: &Path, name: &str, input: &Value) -> Result<(PathBuf, Call), String> {
    let root = root(project)?;
    let call = match name {
        "read_file" => {
            let a = args(input, &["path", "offset", "limit"])?;
            Call::Read(
                resolve(&root, text(a, "path")?, false)?,
                number(a, "offset", 1, u32::MAX as u64)?,
                number(a, "limit", 400, 2000)?,
            )
        }
        "list_files" => {
            let a = args(input, &["path", "recursive"])?;
            Call::List(
                resolve(&root, optional_path(a, "path")?, false)?,
                boolean(a, "recursive", false)?,
            )
        }
        "search_files" => {
            let a = args(input, &["path", "pattern", "max_results"])?;
            let pattern = text(a, "pattern")?;
            if pattern.is_empty() || pattern.len() > 4096 {
                return Err("搜索文本必须为1–4096字节".into());
            }
            Call::Search(
                resolve(&root, optional_path(a, "path")?, false)?,
                pattern.into(),
                number(a, "max_results", 100, 500)? as usize,
            )
        }
        "write_file" => {
            let a = args(input, &["path", "content", "expected_content"])?;
            let expected = match a.get("expected_content") {
                Some(Value::Null) => None,
                Some(Value::String(value)) if value.len() <= MAX_FILE => Some(value.clone()),
                _ => return Err("必须提供 expected_content；null 仅用于新文件".into()),
            };
            Call::Write(
                resolve(&root, text(a, "path")?, true)?,
                text(a, "content")?.into(),
                expected,
            )
        }
        "apply_patch" => {
            let a = args(input, &["path", "old_text", "new_text"])?;
            let old = text(a, "old_text")?;
            if old.is_empty() {
                return Err("old_text 不能为空".into());
            }
            Call::Patch(
                resolve(&root, text(a, "path")?, false)?,
                old.into(),
                text(a, "new_text")?.into(),
            )
        }
        "run_command" => {
            let a = args(input, &["command", "workdir", "timeout_seconds"])?;
            let command = text(a, "command")?;
            if command.trim().is_empty() || command.len() > 8192 {
                return Err("命令为空或过长".into());
            }
            Call::Command(
                resolve(&root, optional_path(a, "workdir")?, false)?,
                command.into(),
                number(a, "timeout_seconds", 60, 120)?,
            )
        }
        _ => return Err("未知本地工具".into()),
    };
    match &call {
        Call::Read(path, ..) | Call::Patch(path, ..) if !path.is_file() => {
            return Err("此工具需要普通文件".into())
        }
        Call::Write(path, ..) if path.exists() && !path.is_file() => {
            return Err("不能用文件覆盖目录或设备".into())
        }
        Call::List(path, ..) | Call::Command(path, ..) if !path.is_dir() => {
            return Err("此工具需要工作目录".into())
        }
        _ => {}
    }
    Ok((root, call))
}

pub fn inspect(project: &Path, name: &str, input: &Value) -> Result<ToolInspection, String> {
    let (_, call) = parse(project, name, input)?;
    let (action, resource, mutating, approval, dangerous) = match call {
        Call::Read(path, ..) => (
            "read",
            path.to_string_lossy().into_owned(),
            false,
            false,
            false,
        ),
        Call::List(path, ..) | Call::Search(path, ..) => (
            "read",
            path.to_string_lossy().into_owned(),
            false,
            false,
            false,
        ),
        Call::Write(path, ..) | Call::Patch(path, ..) => {
            let special = path
                .components()
                .any(|p| p.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"));
            (
                "edit",
                path.to_string_lossy().into_owned(),
                true,
                special,
                special,
            )
        }
        Call::Command(_, command, _) => {
            let safe = command::safe_command(&command);
            ("shell", command, !safe, !safe, !safe)
        }
    };
    Ok(ToolInspection {
        action: action.into(),
        resources: vec![resource],
        description: format!("执行 {name}"),
        mutating,
        requires_approval: approval,
        dangerous,
    })
}
fn cancelled(cancel: &watch::Receiver<bool>) -> Result<(), String> {
    if *cancel.borrow() {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}
fn bounded(mut value: String) -> String {
    if value.len() > MAX_OUTPUT {
        let mut end = MAX_OUTPUT;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
        value.push_str("\n[输出已截断]");
    }
    value
}
fn read_text(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|_| "无法读取文件元数据")?;
    if !meta.is_file() || meta.len() > MAX_FILE as u64 {
        return Err("只支持不超过1MiB的普通UTF-8文本文件".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "无法读取文件")?
        .take((MAX_FILE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取文件")?;
    if bytes.len() > MAX_FILE || bytes.contains(&0) {
        return Err("文件过大或为二进制文件".into());
    }
    String::from_utf8(bytes).map_err(|_| "文件不是UTF-8文本".into())
}
fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
fn walk(
    root: &Path,
    path: &Path,
    recursive: bool,
    depth: usize,
    entries: &mut Vec<(PathBuf, bool)>,
    cancel: &watch::Receiver<bool>,
) -> Result<(), String> {
    cancelled(cancel)?;
    if depth > 20 || entries.len() >= MAX_ENTRIES {
        return Ok(());
    }
    if path.is_file() {
        entries.push((path.to_path_buf(), false));
        return Ok(());
    }
    let mut children = fs::read_dir(path)
        .map_err(|_| "无法列出目录")?
        .take(MAX_ENTRIES.saturating_sub(entries.len()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "无法读取目录条目")?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        cancelled(cancel)?;
        if entries.len() >= MAX_ENTRIES {
            break;
        }
        let typ = child.file_type().map_err(|_| "无法检查目录条目")?;
        if typ.is_symlink() {
            continue;
        }
        let target = fs::canonicalize(child.path()).map_err(|_| "目录在读取时发生变化")?;
        if !target.starts_with(root) {
            return Err("目录条目越过项目边界".into());
        }
        if typ.is_file() {
            entries.push((target, false));
        } else if typ.is_dir() {
            entries.push((target.clone(), true));
            if recursive
                && !matches!(
                    child.file_name().to_str(),
                    Some(".git" | "node_modules" | "target")
                )
            {
                walk(root, &target, true, depth + 1, entries, cancel)?;
            }
        }
    }
    Ok(())
}
fn patch_diff(root: &Path, path: &Path, before: Option<&str>, after: &str) -> Vec<AgentDiff> {
    cumulative_diff(&relative(root, path), before, Some(after))
}

/// Format the original baseline against the latest successful snapshot.
/// None is distinct from an empty file, including empty-file additions/removals.
pub(crate) fn cumulative_diff(
    path: &str,
    before: Option<&str>,
    after: Option<&str>,
) -> Vec<AgentDiff> {
    if before == after {
        return vec![];
    }
    let old: Vec<_> = before.unwrap_or_default().split_inclusive('\n').collect();
    let new: Vec<_> = after.unwrap_or_default().split_inclusive('\n').collect();
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let start = prefix.saturating_sub(3);
    let old_end = old.len() - suffix;
    let new_end = new.len() - suffix;
    let tail = suffix.min(3);
    let mut patch = format!(
        "--- {}\n+++ {}\n@@ -{},{} +{},{} @@\n",
        if before.is_some() {
            format!("a/{path}")
        } else {
            "/dev/null".into()
        },
        if after.is_some() {
            format!("b/{path}")
        } else {
            "/dev/null".into()
        },
        if old.is_empty() { 0 } else { start + 1 },
        old_end - start + tail,
        if new.is_empty() { 0 } else { start + 1 },
        new_end - start + tail
    );
    let mut line = |prefix: char, text: &str| {
        patch.push(prefix);
        patch.push_str(text);
        if !text.ends_with('\n') {
            patch.push_str("\n\\ No newline at end of file\n");
        }
    };
    for text in &old[start..prefix] {
        line(' ', text);
    }
    for text in &old[prefix..old_end] {
        line('-', text);
    }
    for text in &new[prefix..new_end] {
        line('+', text);
    }
    for text in &old[old_end..old_end + tail] {
        line(' ', text);
    }
    vec![AgentDiff {
        path: path.into(),
        patch,
        additions: (new_end - prefix) as u64,
        deletions: (old_end - prefix) as u64,
        status: if before.is_none() {
            "added"
        } else if after.is_none() {
            "deleted"
        } else {
            "modified"
        }
        .into(),
    }]
}
fn atomic_write(
    root: &Path,
    path: &Path,
    before: Option<&str>,
    after: &str,
    cancel: &watch::Receiver<bool>,
) -> Result<Vec<AgentDiff>, String> {
    if after.len() > MAX_FILE {
        return Err("写入结果超过1MiB".into());
    }
    let lock = static_lock().lock().map_err(|_| "文件写入锁不可用")?;
    let current = if path.exists() {
        Some(read_text(path)?)
    } else {
        None
    };
    if current.as_deref() != before {
        return Err("文件内容已变化或expected_content不匹配；请重新读取后再修改".into());
    }
    let diffs = patch_diff(root, path, before, after);
    if diffs.is_empty() {
        return Ok(diffs);
    }
    let parent = path.parent().ok_or("目标缺少父目录")?;
    if fs::canonicalize(parent).map_err(|_| "父目录发生变化")? != parent
        || !parent.starts_with(root)
    {
        return Err("写入目录发生变化".into());
    }
    let temp = parent.join(format!(".lolicode-{}.tmp", uuid::Uuid::new_v4().simple()));
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let cleanup = Temp(temp.clone());
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|_| "无法创建原子写入临时文件")?;
    file.write_all(after.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法写入文件")?;
    if let Ok(metadata) = fs::metadata(path) {
        fs::set_permissions(&temp, metadata.permissions()).map_err(|_| "无法保留文件权限")?;
    }
    drop(file);
    cancelled(cancel)?;
    let revalidated = resolve(root, &path.to_string_lossy(), true)?;
    let latest = if revalidated.exists() {
        Some(read_text(&revalidated)?)
    } else {
        None
    };
    if revalidated != path || latest.as_deref() != before {
        return Err("提交前文件已变化，请重新读取".into());
    }
    fs::rename(&temp, path).map_err(|_| "无法原子替换文件，原内容已保留")?;
    drop(cleanup);
    drop(lock);
    Ok(diffs)
}
fn static_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub async fn execute(
    project: &Path,
    name: &str,
    input: &Value,
    cancel: watch::Receiver<bool>,
) -> Result<ToolOutput, String> {
    cancelled(&cancel)?;
    let (root, call) = parse(project, name, input)?;
    if let Call::Command(workdir, command, seconds) = call {
        return command::execute(&root, &workdir, &command, seconds, cancel).await;
    }
    tokio::task::spawn_blocking(move || {
        cancelled(&cancel)?;
        let mut file_changes = Vec::new();
        let (text, diffs) = match call {
            Call::Read(path, offset, limit) => {
                let content = read_text(&path)?;
                let text = content
                    .lines()
                    .skip((offset - 1) as usize)
                    .take(limit as usize)
                    .enumerate()
                    .map(|(i, line)| format!("{}: {line}\n", offset + i as u64))
                    .collect::<String>();
                (format!("{}\n{}", relative(&root, &path), text), vec![])
            }
            Call::List(path, recursive) => {
                let mut entries = vec![];
                walk(&root, &path, recursive, 0, &mut entries, &cancel)?;
                (
                    entries
                        .iter()
                        .map(|(path, dir)| {
                            format!("{}{}\n", relative(&root, path), if *dir { "/" } else { "" })
                        })
                        .collect(),
                    vec![],
                )
            }
            Call::Search(path, pattern, max) => {
                let mut entries = vec![];
                walk(&root, &path, true, 0, &mut entries, &cancel)?;
                let mut output = String::new();
                let mut found = 0;
                for (path, dir) in entries {
                    cancelled(&cancel)?;
                    if dir {
                        continue;
                    }
                    let Ok(content) = read_text(&path) else {
                        continue;
                    };
                    for (i, line) in content.lines().enumerate() {
                        if line.contains(&pattern) {
                            output.push_str(&format!(
                                "{}:{}: {line}\n",
                                relative(&root, &path),
                                i + 1
                            ));
                            found += 1;
                            if found >= max || output.len() >= MAX_OUTPUT {
                                break;
                            }
                        }
                    }
                    if found >= max || output.len() >= MAX_OUTPUT {
                        break;
                    }
                }
                (output, vec![])
            }
            Call::Write(path, content, expected) => {
                let diffs = atomic_write(&root, &path, expected.as_deref(), &content, &cancel)?;
                if !diffs.is_empty() {
                    file_changes.push(FileChange {
                        path: relative(&root, &path),
                        before: expected,
                        after: Some(content),
                    });
                }
                (format!("已写入 {}", relative(&root, &path)), diffs)
            }
            Call::Patch(path, old, new) => {
                let before = read_text(&path)?;
                if before.match_indices(&old).count() != 1 {
                    return Err("old_text必须在当前文件中恰好出现一次".into());
                }
                let after = before.replacen(&old, &new, 1);
                let diffs = atomic_write(&root, &path, Some(&before), &after, &cancel)?;
                if !diffs.is_empty() {
                    file_changes.push(FileChange {
                        path: relative(&root, &path),
                        before: Some(before),
                        after: Some(after),
                    });
                }
                (format!("已更新 {}", relative(&root, &path)), diffs)
            }
            Call::Command(..) => unreachable!(),
        };
        Ok(ToolOutput {
            text: bounded(text),
            diffs,
            file_changes,
        })
    })
    .await
    .map_err(|_| "本地工具执行线程失败")?
}
