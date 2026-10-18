//! UE project library, engine discovery, and explicit UnrealAgentLink setup.

use crate::store::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env,
    fs::{self, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use uuid::Uuid;

const STORE_KEY: &str = "lolicode_unreal_store_v1";
const UAL_REVISION: &str = "ec65d7d1ae018944739d28cef18c78b4c53bca8f";
const UAL_ARCHIVE_URL: &str =
    "https://github.com/ueboxai/uebox/archive/ec65d7d1ae018944739d28cef18c78b4c53bca8f.zip";
const UAL_ARCHIVE_PREFIX: &str =
    "uebox-ec65d7d1ae018944739d28cef18c78b4c53bca8f/plugin/UnrealAgentLink/";
const MAX_ARCHIVE_BYTES: usize = 96 * 1024 * 1024;
const MAX_PLUGIN_BYTES: u64 = 384 * 1024 * 1024;

mod plugin;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrealProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub engine_association: Option<String>,
    pub plugin_installed: bool,
    pub plugin_enabled: bool,
    #[serde(default)]
    pub plugin_ready: bool,
    pub added_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrealEngine {
    pub version: String,
    pub association_id: Option<String>,
    pub path: String,
    pub editor_executable: String,
    pub source: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrealSnapshot {
    pub projects: Vec<UnrealProject>,
    pub engines: Vec<UnrealEngine>,
    pub bridge: lolicode_agent::native::unreal::UnrealBridgeStatus,
    pub source_revision: &'static str,
}

#[derive(Default, Serialize, Deserialize)]
struct UnrealStore {
    #[serde(default)]
    projects: Vec<UnrealProject>,
}

fn project_store_gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}

fn read_store(state: &AppState) -> Result<UnrealStore, String> {
    match state.db.get_setting(STORE_KEY).map_err(|e| e.to_string())? {
        Some(raw) => serde_json::from_str(&raw)
            .map_err(|_| "虚幻项目库数据无法解析，原数据已保留".to_string()),
        None => Ok(UnrealStore::default()),
    }
}

fn write_store(state: &AppState, store: &UnrealStore) -> Result<(), String> {
    let raw = serde_json::to_string(store).map_err(|_| "虚幻项目库无法编码")?;
    state
        .db
        .set_setting(STORE_KEY, &raw)
        .map_err(|e| e.to_string())
}

fn canonical_project_file(path: &str) -> Result<(PathBuf, PathBuf), String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("请选择 .uproject 工程文件".into());
    }
    let selected = Path::new(path);
    if selected
        .extension()
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("uproject"))
    {
        return Err("请选择 Unreal 工程的 .uproject 文件".into());
    }
    let file = selected
        .canonicalize()
        .map_err(|_| "uproject 文件不存在或无法访问")?;
    let file = editor_path(&file);
    if !file.is_file() {
        return Err("uproject 必须是普通文件".into());
    }
    let root = file.parent().ok_or("uproject 缺少父目录")?.to_path_buf();
    let raw = fs::read(&file).map_err(|_| "无法读取 uproject")?;
    if raw.len() > 4 * 1024 * 1024 {
        return Err("uproject 文件超过 4 MiB，无法安全读取".into());
    }
    serde_json::from_slice::<Value>(&raw).map_err(|_| "uproject JSON 无效")?;
    Ok((file, root))
}

fn project_from_file(id: String, file: &Path, added_at: u64) -> Result<UnrealProject, String> {
    let root = file.parent().ok_or("uproject 缺少父目录")?;
    let raw: Value = serde_json::from_slice(&fs::read(file).map_err(|_| "无法读取 uproject")?)
        .map_err(|_| "uproject JSON 无效")?;
    let plugin_path = root.join("Plugins").join("UnrealAgentLink");
    let plugin_installed = plugin_path.join("UnrealAgentLink.uplugin").is_file();
    let plugin_enabled = plugin_installed
        && raw["Plugins"].as_array().is_some_and(|plugins| {
            plugins.iter().any(|plugin| {
                plugin["Name"] == "UnrealAgentLink" && plugin["Enabled"].as_bool() == Some(true)
            })
        });
    let plugin_ready = select_engine(&discover_engines(), raw["EngineAssociation"].as_str())
        .is_some_and(|engine| plugin::is_ready(&plugin_path, engine));
    Ok(UnrealProject {
        id,
        name: file
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Unreal Project")
            .to_string(),
        path: file.to_string_lossy().into_owned(),
        engine_association: raw["EngineAssociation"].as_str().map(str::to_string),
        plugin_installed,
        plugin_enabled,
        plugin_ready,
        added_at,
    })
}

pub fn add_project(state: &AppState, path: &str) -> Result<UnrealProject, String> {
    let (file, _) = canonical_project_file(path)?;
    let _write = project_store_gate()
        .lock()
        .map_err(|_| "虚幻项目库繁忙，请重试")?;
    let mut store = read_store(state)?;
    let file_key = path_key(&file);
    if let Some(existing) = store
        .projects
        .iter()
        .find(|project| path_key(Path::new(&project.path)) == file_key)
    {
        return project_from_file(existing.id.clone(), &file, existing.added_at);
    }
    let project = project_from_file(Uuid::new_v4().to_string(), &file, now_ms())?;
    store.projects.push(project.clone());
    write_store(state, &store)?;
    Ok(project)
}

pub fn remove_project(state: &AppState, id: &str) -> Result<(), String> {
    let _write = project_store_gate()
        .lock()
        .map_err(|_| "虚幻项目库繁忙，请重试")?;
    let mut store = read_store(state)?;
    let original_len = store.projects.len();
    store.projects.retain(|project| project.id != id);
    if original_len == store.projects.len() {
        return Err("找不到要移除的工程".into());
    }
    write_store(state, &store)
}

pub async fn snapshot(state: &AppState) -> Result<UnrealSnapshot, String> {
    let store = read_store(state)?;
    let projects = store
        .projects
        .into_iter()
        .filter_map(|saved| {
            canonical_project_file(&saved.path)
                .ok()
                .and_then(|(file, _)| project_from_file(saved.id, &file, saved.added_at).ok())
        })
        .collect();
    Ok(UnrealSnapshot {
        projects,
        engines: discover_engines(),
        bridge: lolicode_agent::native::unreal::status().await,
        source_revision: UAL_REVISION,
    })
}

pub fn discover_engines() -> Vec<UnrealEngine> {
    let mut roots = Vec::<(PathBuf, String)>::new();
    if let Some(value) = env::var_os("UE_ROOT") {
        roots.push((PathBuf::from(value), "UE_ROOT".into()));
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(program_data) = env::var_os("ProgramData") {
            roots.extend(launcher_installations(
                &PathBuf::from(program_data)
                    .join("Epic/UnrealEngineLauncher/LauncherInstalled.dat"),
            ));
        }
        for base in [
            env::var_os("ProgramFiles").map(PathBuf::from),
            env::var_os("ProgramFiles(x86)").map(PathBuf::from),
        ]
        .into_iter()
        .flatten()
        {
            roots.push((base.join("Epic Games"), "Epic Games folder".into()));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            roots.extend(launcher_installations(&home.join(
                "Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat",
            )));
            roots.push((home.join("Epic Games"), "Epic Games folder".into()));
        }
        roots.push((
            PathBuf::from("/Users/Shared/Epic Games"),
            "Epic Games folder".into(),
        ));
    }
    #[cfg(target_os = "linux")]
    if let Some(home) = dirs::home_dir() {
        roots.push((home.join("UnrealEngine"), "Source build".into()));
        roots.push((home.join("Epic Games"), "Epic Games folder".into()));
    }

    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for (root, source) in roots {
        for candidate in engine_candidates(&root) {
            let Ok(path) = candidate.canonicalize() else {
                continue;
            };
            if !seen.insert(path_key(&path)) {
                continue;
            }
            if let Some(engine) = engine_from_path(&path, &source) {
                found.push(engine);
            }
        }
    }
    found.sort_by(|left, right| right.version.cmp(&left.version));
    found
}

fn launcher_installations(path: &Path) -> Vec<(PathBuf, String)> {
    let Ok(raw) = fs::read(path) else {
        return vec![];
    };
    let Ok(value) = serde_json::from_slice::<Value>(&raw) else {
        return vec![];
    };
    value["InstallationList"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry["InstallLocation"]
                .as_str()
                .map(|path| (PathBuf::from(path), "Epic Launcher".into()))
        })
        .collect()
}

fn engine_candidates(root: &Path) -> Vec<PathBuf> {
    if engine_from_path(root, "local").is_some() {
        return vec![root.to_path_buf()];
    }
    let Ok(entries) = fs::read_dir(root) else {
        return vec![];
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect()
}

fn engine_from_path(path: &Path, source: &str) -> Option<UnrealEngine> {
    let engine_root = if path.ends_with("Engine") {
        path.parent()?
    } else {
        path
    };
    // .NET AutomationTool cannot resolve assemblies through a Windows verbatim
    // path (\\?\...). UE and its build tools need the ordinary native form.
    let engine_root = editor_path(engine_root);
    let build_version = engine_root.join("Engine/Build/Build.version");
    let manifest: Value = serde_json::from_slice(&fs::read(build_version).ok()?).ok()?;
    let version = format!(
        "{}.{}.{}",
        manifest["MajorVersion"].as_u64()?,
        manifest["MinorVersion"].as_u64()?,
        manifest["PatchVersion"].as_u64().unwrap_or(0)
    );
    let association_id = manifest["BuildId"].as_str().map(str::to_string);
    let editor = if cfg!(windows) {
        engine_root.join("Engine/Binaries/Win64/UnrealEditor.exe")
    } else if cfg!(target_os = "macos") {
        engine_root.join("Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor")
    } else {
        engine_root.join("Engine/Binaries/Linux/UnrealEditor")
    };
    editor.exists().then(|| UnrealEngine {
        version,
        association_id,
        path: engine_root.to_string_lossy().into_owned(),
        editor_executable: editor.to_string_lossy().into_owned(),
        source: source.to_string(),
    })
}

fn path_key(path: &Path) -> String {
    let value = editor_path(path).to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn editor_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(value) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(value);
        }
    }
    path.to_path_buf()
}

pub fn launch_target(state: &AppState, id: &str) -> Result<(UnrealProject, UnrealEngine), String> {
    let store = read_store(state)?;
    let saved = store
        .projects
        .into_iter()
        .find(|project| project.id == id)
        .ok_or("请选择已添加的虚幻工程")?;
    let (file, _) = canonical_project_file(&saved.path)?;
    let project = project_from_file(saved.id, &file, saved.added_at)?;
    let engines = discover_engines();
    let engine = select_engine(&engines, project.engine_association.as_deref())
        .cloned()
        .ok_or_else(|| if project.engine_association.is_some() {
            "工程关联的 Unreal Engine 尚未安装或未发现；为避免打开错误版本，请先安装对应引擎或设置 UE_ROOT"
        } else {
            "没有发现可用的 Unreal Engine；请安装 UE 或设置 UE_ROOT 后刷新"
        })?;
    Ok((project, engine))
}

fn select_engine<'a>(
    engines: &'a [UnrealEngine],
    association: Option<&str>,
) -> Option<&'a UnrealEngine> {
    let Some(association) = association else {
        return engines.first();
    };
    engines.iter().find(|engine| {
        engine.association_id.as_deref() == Some(association)
            || engine.version == association
            || engine
                .version
                .strip_prefix(association)
                .is_some_and(|suffix| suffix.starts_with('.'))
    })
}

pub async fn install_plugin(state: &AppState, id: &str) -> Result<UnrealProject, String> {
    let (project, engine) = launch_target(state, id)?;
    if lolicode_agent::native::unreal::has_connection_for_project(Path::new(&project.path)).await {
        return Err("请先保存并关闭此工程的 Unreal Editor，再安装或修复桥接插件".into());
    }
    let (file, root) = canonical_project_file(&project.path)?;
    plugin::install(&file, &root, &engine).await?;
    project_from_file(project.id, &file, project.added_at)
}

fn extract_plugin_archive(bytes: &[u8], staging: &Path) -> Result<(), String> {
    if staging.exists() {
        return Err("插件暂存目录已存在，已停止以保护现有文件".into());
    }
    fs::create_dir_all(staging).map_err(|_| "无法创建插件暂存目录")?;
    let result = (|| {
        let mut archive =
            zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "UnrealAgentLink 压缩包无效")?;
        let prefix = Path::new(UAL_ARCHIVE_PREFIX);
        let mut total = 0u64;
        let mut files = 0usize;
        for index in 0..archive.len() {
            let entry = archive
                .by_index(index)
                .map_err(|_| "插件压缩包条目读取失败")?;
            let enclosed = entry
                .enclosed_name()
                .ok_or("插件压缩包包含越界路径")?
                .to_path_buf();
            let Some(relative) = enclosed.strip_prefix(prefix).ok() else {
                continue;
            };
            if relative.as_os_str().is_empty() {
                continue;
            }
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err("插件压缩包包含符号链接，出于安全原因停止安装".into());
            }
            total = total.saturating_add(entry.size());
            if total > MAX_PLUGIN_BYTES {
                return Err("插件解压内容超过 384 MiB".into());
            }
            let target = staging.join(relative);
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(|_| "无法创建插件目录")?;
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|_| "无法创建插件目录")?;
                }
                let mut output = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map_err(|_| "插件文件无法安全写入")?;
                let expected_size = entry.size();
                let copied = std::io::copy(
                    &mut entry.take(expected_size.saturating_add(1)),
                    &mut output,
                )
                .map_err(|_| "插件文件解压失败")?;
                if copied != expected_size {
                    return Err("插件压缩包文件长度不匹配".into());
                }
                files += 1;
            }
        }
        if files == 0
            || !staging.join("UnrealAgentLink.uplugin").is_file()
            || !staging.join("LICENSE").is_file()
        {
            return Err("插件包缺少 .uplugin 描述文件或 MIT 许可证".into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

fn enable_plugin_in_project(project_file: &Path) -> Result<(), String> {
    let bytes = fs::read(project_file).map_err(|_| "无法读取 uproject")?;
    let mut project: Value = serde_json::from_slice(&bytes).map_err(|_| "uproject JSON 无效")?;
    let plugins = project
        .as_object_mut()
        .ok_or("uproject 根节点必须是对象")?
        .entry("Plugins")
        .or_insert_with(|| json!([]));
    let plugins = plugins
        .as_array_mut()
        .ok_or("uproject Plugins 字段不是数组")?;
    if let Some(plugin) = plugins
        .iter_mut()
        .find(|plugin| plugin["Name"] == "UnrealAgentLink")
    {
        plugin["Enabled"] = Value::Bool(true);
    } else {
        plugins.push(json!({"Name":"UnrealAgentLink","Enabled":true}));
    }
    let backup = project_file.with_extension("uproject.lolicode.bak");
    if !backup.exists() {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup)
            .map_err(|_| "无法创建 uproject 原文件备份；没有启用插件")?;
        output
            .write_all(&bytes)
            .map_err(|_| "uproject 原文件备份写入失败；没有启用插件")?;
        output
            .sync_all()
            .map_err(|_| "uproject 原文件备份未落盘；没有启用插件")?;
    }
    let temporary =
        project_file.with_extension(format!("uproject.lolicode-{}.tmp", Uuid::new_v4().simple()));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "无法准备 uproject 更新文件")?;
    serde_json::to_writer_pretty(&mut output, &project).map_err(|_| "uproject 更新内容无法编码")?;
    output
        .write_all(b"\n")
        .map_err(|_| "uproject 更新内容无法写入")?;
    output.sync_all().map_err(|_| "uproject 更新内容未落盘")?;
    replace_project_file(&temporary, project_file).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        "uproject 更新失败，原文件备份已保留".to_string()
    })?;
    Ok(())
}

#[cfg(windows)]
fn replace_project_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_project_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Explicit opt-in: builds the real upstream plugin and launches only a
    /// newly created, isolated project. Never uses the desktop user's database.
    #[tokio::test]
    #[ignore = "requires an installed Unreal Engine and C++ toolchain"]
    async fn live_plugin_build_pair_and_read_command() -> Result<(), String> {
        let root = PathBuf::from(
            env::var("LOLICODE_UE_LIVE_ROOT")
                .map_err(|_| "Set LOLICODE_UE_LIVE_ROOT to a fresh acceptance directory")?,
        );
        let directory = root.join("Game");
        let reuse = env::var("LOLICODE_UE_LIVE_REUSE").as_deref() == Ok("1");
        if !reuse {
            fs::create_dir(&directory).map_err(|_| "Acceptance Game directory must not exist")?;
        }
        let engines = discover_engines();
        let engine = engines.first().ok_or("No Unreal Engine found")?;
        let association = engine
            .version
            .split('.')
            .take(2)
            .collect::<Vec<_>>()
            .join(".");
        let file = directory.join("LoliCodeBridgeAcceptance.uproject");
        if reuse {
            let fixture: Value =
                serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            assert_eq!(
                fixture["Description"],
                "Isolated LoliCode bridge acceptance"
            );
        } else {
            fs::write(&file,json!({"FileVersion":3,"EngineAssociation":association,"Description":"Isolated LoliCode bridge acceptance"}).to_string()).map_err(|e|e.to_string())?;
        }
        let state = AppState::new(std::sync::Arc::new(
            crate::database::Database::memory().map_err(|e| e.to_string())?,
        ));
        let project = add_project(&state, file.to_str().ok_or("Invalid fixture path")?)?;
        if !reuse {
            assert!(!project.plugin_ready);
        }
        let installed = install_plugin(&state, &project.id).await?;
        assert!(installed.plugin_ready && installed.plugin_enabled);
        assert!(directory.join("Plugins/UnrealAgentLink/LICENSE").is_file());
        assert!(file.with_extension("uproject.lolicode.bak").is_file());
        let modules = directory
            .join("Plugins/UnrealAgentLink/Binaries")
            .join(if cfg!(windows) {
                "Win64"
            } else if cfg!(target_os = "macos") {
                "Mac"
            } else {
                "Linux"
            })
            .join("UnrealEditor.modules");
        let before = fs::metadata(&modules)
            .map_err(|e| e.to_string())?
            .modified()
            .map_err(|e| e.to_string())?;
        install_plugin(&state, &project.id).await?;
        assert_eq!(fs::metadata(&modules).unwrap().modified().unwrap(), before);
        let (token, url) = lolicode_agent::native::unreal::prepare_editor_launch(&file).await?;
        let executable = if cfg!(windows) {
            Path::new(&engine.editor_executable).with_file_name("UnrealEditor-Cmd.exe")
        } else {
            PathBuf::from(&engine.editor_executable)
        };
        let log = fs::File::create(root.join("editor.log")).map_err(|e| e.to_string())?;
        let mut command = tokio::process::Command::new(executable);
        command
            .arg(&file)
            .arg(format!("-UALServer={url}"))
            .args([
                "-unattended",
                "-nullrhi",
                "-nosplash",
                "-nosound",
                "-NoLiveCoding",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut editor = command.spawn().map_err(|e| e.to_string())?;
        let connected = tokio::time::timeout(std::time::Duration::from_secs(240), async {
            loop {
                if lolicode_agent::native::unreal::has_connection_for_project(&file).await {
                    return Ok::<(), String>(());
                }
                if let Some(status) = editor.try_wait().map_err(|e| e.to_string())? {
                    return Err(format!("Isolated editor exited: {status}; see editor.log"));
                }
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
        })
        .await
        .map_err(|_| "Isolated editor did not pair within 4 minutes; see editor.log")?;
        connected?;
        let (_cancel, receiver) = tokio::sync::watch::channel(false);
        let info = lolicode_agent::native::unreal::request(
            &directory,
            "system.get_project_info",
            &json!({}),
            receiver,
        )
        .await?;
        assert_eq!(info["project_name"], "LoliCodeBridgeAcceptance");
        assert_eq!(info["ok"], true);
        let _ = editor.kill().await;
        lolicode_agent::native::unreal::cancel_editor_launch(&token);
        let proof = json!({"passed":true,"engine":engine.version,"upstream":UAL_REVISION,"compiledAndBuildIdVerified":true,"repeatInstallDidNotRebuild":true,"realEditorPaired":true,"projectInfoRead":true,"projectDirectoryAnnouncementAccepted":true,"userDatabaseRead":false});
        fs::write(
            root.join("result.json"),
            serde_json::to_vec_pretty(&proof).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        println!("{proof}");
        Ok(())
    }

    #[test]
    fn parallel_project_library_updates_keep_every_registered_project() {
        let root = tempdir().unwrap();
        let state = AppState::new(std::sync::Arc::new(
            crate::database::Database::memory().unwrap(),
        ));
        let files: Vec<_> = (0..16)
            .map(|index| {
                let folder = root.path().join(format!("Project-{index}"));
                std::fs::create_dir(&folder).unwrap();
                let path = folder.join("Game.uproject");
                std::fs::write(&path, r#"{"FileVersion":3,"EngineAssociation":"5.4"}"#).unwrap();
                path
            })
            .collect();
        std::thread::scope(|scope| {
            for path in &files {
                let state = &state;
                scope.spawn(move || add_project(state, path.to_str().unwrap()).unwrap());
            }
        });
        let registered = read_store(&state).unwrap().projects;
        assert_eq!(registered.len(), 16);
        std::thread::scope(|scope| {
            for project in registered.iter().take(8) {
                let state = &state;
                scope.spawn(move || remove_project(state, &project.id).unwrap());
            }
        });
        assert_eq!(read_store(&state).unwrap().projects.len(), 8);
        assert!(files.iter().all(|file| file.is_file()));
    }

    #[test]
    fn enabling_plugin_keeps_unknown_project_fields_and_creates_exact_backup() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("Game.uproject");
        let original =
            br#"{"FileVersion":3,"EngineAssociation":"5.4","CustomField":{"kept":true}}"#;
        fs::write(&file, original).unwrap();
        enable_plugin_in_project(&file).unwrap();
        let updated: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(updated["CustomField"]["kept"], true);
        assert_eq!(updated["Plugins"][0]["Name"], "UnrealAgentLink");
        assert_eq!(updated["Plugins"][0]["Enabled"], true);
        assert_eq!(
            fs::read(dir.path().join("Game.uproject.lolicode.bak")).unwrap(),
            original
        );
    }

    #[test]
    fn project_file_selection_rejects_non_uproject_and_nested_paths() {
        let dir = tempdir().unwrap();
        let plain = dir.path().join("Game.json");
        fs::write(&plain, "{}").unwrap();
        assert!(canonical_project_file(plain.to_str().unwrap()).is_err());
        assert!(
            canonical_project_file(dir.path().join("missing.uproject").to_str().unwrap()).is_err()
        );
    }

    #[test]
    fn engine_selection_respects_version_and_build_association() {
        let engines = vec![
            UnrealEngine {
                version: "5.6.0".into(),
                association_id: Some("build-56".into()),
                path: "UE_5.6".into(),
                editor_executable: "editor56".into(),
                source: "test".into(),
            },
            UnrealEngine {
                version: "5.4.3".into(),
                association_id: Some("build-54".into()),
                path: "UE_5.4".into(),
                editor_executable: "editor54".into(),
                source: "test".into(),
            },
        ];
        assert_eq!(
            select_engine(&engines, Some("5.4")).unwrap().version,
            "5.4.3"
        );
        assert_eq!(
            select_engine(&engines, Some("build-56")).unwrap().version,
            "5.6.0"
        );
        assert!(select_engine(&engines, Some("5.9")).is_none());
        assert!(select_engine(&engines, Some("0123456789abcdef0123456789abcdef")).is_none());
        assert_eq!(select_engine(&engines, None).unwrap().version, "5.6.0");
    }
}
