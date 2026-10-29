//! Local development renderer snapshots. No network feed, signature bypass or
//! arbitrary filesystem path is exposed through the public command.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
};

const MAX_MANIFEST: usize = 64 * 1024;
const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_TOTAL: usize = 256 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const MAX_OUTPUT: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevelopmentFrontendBuild {
    pub channel: String,
    pub development_build_number: String,
    pub source_branch: String,
    pub revision: String,
    pub built_at: String,
    pub working_tree_dirty: bool,
    pub output_directory: PathBuf,
    pub native_contract: String,
    pub native_version: String,
}

pub(super) struct DevelopmentSnapshot {
    pub metadata: DevelopmentFrontendBuild,
    pub files: BTreeMap<String, Vec<u8>>,
}
pub(super) struct DevelopmentSelection {
    pub current: Arc<DevelopmentSnapshot>,
    pub previous: Option<Arc<DevelopmentSnapshot>>,
}

pub(super) fn source_directory() -> Result<PathBuf, String> {
    let source = option_env!("LOLICODE_DEV_SOURCE_DIR")
        .filter(|value| !value.is_empty())
        .ok_or("此开发版未绑定源码目录，请运行 pnpm build:dev 完整重建一次")?;
    let root = PathBuf::from(source);
    guard(&root)?;
    if !root.join("scripts/dev/lolicode-development.mjs").is_file() {
        return Err("开发源码目录不可用，请恢复仓库后重试".into());
    }
    guard(&root.join("scripts/dev/lolicode-development.mjs"))?;
    Ok(root)
}

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn guard(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("开发界面必须位于绝对路径".into());
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if linked(&metadata) => {
                return Err("开发界面路径不能经过符号链接或目录联接".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("开发界面路径无法检查".into()),
        }
    }
    Ok(())
}
fn read_limited(path: &Path, maximum: usize) -> Result<Vec<u8>, String> {
    guard(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "开发界面文件不可读取")?;
    if !metadata.is_file() || metadata.len() > maximum as u64 {
        return Err("开发界面文件类型或大小无效".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "开发界面文件不可读取")?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "开发界面文件读取失败")?;
    if bytes.len() > maximum {
        return Err("开发界面文件超过大小限制".into());
    }
    Ok(bytes)
}

pub(super) fn pointer_path(source: &Path) -> PathBuf {
    source.join("src-tauri/target/development/current-renderer.json")
}

pub(super) fn load(
    source: &Path,
    metadata: DevelopmentFrontendBuild,
) -> Result<DevelopmentSnapshot, String> {
    if metadata.channel != "development"
        || !metadata.development_build_number.starts_with("DEV-")
        || metadata.development_build_number.len() > 96
        || metadata.source_branch.is_empty()
        || metadata.source_branch.len() > 512
        || metadata.revision.is_empty()
        || metadata.revision.len() > 128
        || chrono::DateTime::parse_from_rfc3339(&metadata.built_at).is_err()
    {
        return Err("开发界面构建记录无效".into());
    }
    if metadata.native_contract != super::super::renderer_updates::native_contract()
        || metadata.native_version != env!("CARGO_PKG_VERSION")
    {
        return Err("后端代码已变化，请运行 pnpm build:dev 完整重建开发版".into());
    }
    let root = source.join("src-tauri/target/development/renderers");
    guard(&root)?;
    guard(&metadata.output_directory)?;
    let canonical_root = root.canonicalize().map_err(|_| "开发界面构建目录不存在")?;
    let directory = metadata
        .output_directory
        .canonicalize()
        .map_err(|_| "开发界面构建尚未完成")?;
    if directory.parent() != Some(canonical_root.as_path()) || !directory.is_dir() {
        return Err("开发界面不属于当前源码仓库的构建目录".into());
    }
    let recorded: DevelopmentFrontendBuild = serde_json::from_slice(&read_limited(
        &directory.join("development-renderer.json"),
        MAX_MANIFEST,
    )?)
    .map_err(|_| "开发界面构建记录不可读取")?;
    if recorded != metadata {
        return Err("开发界面构建记录与产物不一致".into());
    }
    let mut files = BTreeMap::new();
    let mut total = 0;
    read_tree(&directory, &directory, &mut files, &mut total)?;
    if !files
        .get("index.html")
        .is_some_and(|bytes| !bytes.is_empty())
        || !files
            .keys()
            .any(|key| key.starts_with("assets/") && key.ends_with(".js"))
    {
        return Err("开发界面缺少完整的 HTML 或脚本入口，继续使用当前界面".into());
    }
    let index = String::from_utf8_lossy(files.get("index.html").expect("checked index"));
    let references = regex::Regex::new(r#"(?:src|href)=["'](?:\./|/)?([^"']+)["']"#)
        .expect("static development asset expression");
    for reference in references.captures_iter(&index) {
        let path = reference[1].split(['?', '#']).next().unwrap_or_default();
        if path.starts_with("assets/") && !files.contains_key(path) {
            return Err("开发界面引用的脚本或样式不完整，继续使用当前界面".into());
        }
    }
    Ok(DevelopmentSnapshot { metadata, files })
}

fn read_tree(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    total: &mut usize,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|_| "开发界面目录无法读取")? {
        let entry = entry.map_err(|_| "开发界面目录无法读取")?;
        let path = entry.path();
        guard(&path)?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| "开发界面文件无法检查")?;
        if metadata.is_dir() {
            read_tree(root, &path, files, total)?;
        } else if metadata.is_file() {
            let relative = path.strip_prefix(root).map_err(|_| "开发界面文件越界")?;
            let components = relative
                .components()
                .map(|component| match component {
                    Component::Normal(value) => value.to_str().ok_or("开发界面文件名无效"),
                    _ => Err("开发界面文件路径无效"),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let key = components.join("/");
            if key == "development-renderer.json" {
                continue;
            }
            if metadata.len() > MAX_FILE || files.len() >= MAX_FILES {
                return Err("开发界面文件超过大小或数量限制".into());
            }
            let bytes = read_limited(&path, MAX_FILE as usize)?;
            *total = total.checked_add(bytes.len()).ok_or("开发界面大小无效")?;
            if *total > MAX_TOTAL {
                return Err("开发界面产物超过总大小限制".into());
            }
            files.insert(key, bytes);
        } else {
            return Err("开发界面包含不支持的文件类型".into());
        }
    }
    Ok(())
}

pub(super) fn load_current(source: &Path) -> Result<DevelopmentSnapshot, String> {
    let metadata = serde_json::from_slice(&read_limited(&pointer_path(source), MAX_MANIFEST)?)
        .map_err(|_| "开发界面指针无效")?;
    load(source, metadata)
}

fn capture(mut reader: impl Read) -> Result<(Vec<u8>, bool), String> {
    let mut captured = Vec::new();
    let mut over_limit = false;
    let mut buffer = [0; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| "开发界面构建输出读取失败")?;
        if count == 0 {
            break;
        }
        let remaining = MAX_OUTPUT.saturating_sub(captured.len());
        captured.extend_from_slice(&buffer[..count.min(remaining)]);
        over_limit |= count > remaining;
        // Continue draining the pipe after reaching the memory limit so a
        // verbose builder cannot deadlock while the parent waits for it.
    }
    Ok((captured, over_limit))
}

pub(super) fn build() -> Result<(PathBuf, DevelopmentSnapshot), String> {
    let source = source_directory()?;
    let node = option_env!("LOLICODE_DEV_NODE_PATH")
        .filter(|value| !value.is_empty())
        .ok_or("此开发版未绑定 Node，请运行 pnpm build:dev 完整重建一次")?;
    if !Path::new(node).is_absolute() || !Path::new(node).is_file() {
        return Err("构建时的 Node 已不可用，请恢复 Node 后完整重建开发版".into());
    }
    let mut command = Command::new(node);
    command
        .current_dir(&source)
        .arg(source.join("scripts/dev/lolicode-development.mjs"))
        .arg("renderer")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if name == "NODE_OPTIONS"
            || name == "NODE_PATH"
            || name.starts_with("VITE_")
            || name.starts_with("LOLICODE_")
            || name.starts_with("TAURI_")
        {
            command.env_remove(key);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动前端构建，请检查源码与 Node")?;
    let stdout = child.stdout.take().ok_or("无法读取前端构建输出")?;
    let stderr = child.stderr.take().ok_or("无法读取前端构建输出")?;
    let out = std::thread::spawn(move || capture(stdout));
    let err = std::thread::spawn(move || capture(stderr));
    let status = child
        .wait()
        .map_err(|_| "前端构建未完成，当前界面保持不变")?;
    let (output, output_exceeded) = out.join().map_err(|_| "前端构建输出读取失败")??;
    let (error, error_exceeded) = err.join().map_err(|_| "前端构建输出读取失败")??;
    if output_exceeded || error_exceeded {
        return Err("前端构建日志超过 32 MiB，当前界面保持不变".into());
    }
    if !status.success() {
        let error = String::from_utf8_lossy(&error);
        let detail = error
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("请在仓库中检查前端构建错误");
        return Err(format!(
            "前端构建失败，当前界面保持不变：{}",
            detail.chars().take(600).collect::<String>()
        ));
    }
    let output = String::from_utf8(output).map_err(|_| "前端构建返回了无效记录")?;
    let record = output
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or("前端构建未返回记录")?;
    let metadata =
        serde_json::from_str(record).map_err(|_| "前端构建记录无效，当前界面保持不变")?;
    let snapshot = load(&source, metadata)?;
    Ok((source, snapshot))
}
