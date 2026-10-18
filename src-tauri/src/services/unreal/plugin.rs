//! Build the editor plugin for the selected engine before enabling it. All
//! build/swap directories live outside Plugins so UE cannot discover duplicates.
use super::*;
use sha2::{Digest, Sha256};
use std::{process::Stdio, time::Duration};

fn platform() -> &'static str {
    if cfg!(windows) {
        "Win64"
    } else if cfg!(target_os = "macos") {
        "Mac"
    } else {
        "Linux"
    }
}

fn json_file(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

pub(super) fn is_ready(root: &Path, engine: &UnrealEngine) -> bool {
    let Some(descriptor) = json_file(&root.join("UnrealAgentLink.uplugin")) else {
        return false;
    };
    if !descriptor["Modules"].as_array().is_some_and(|modules| {
        modules
            .iter()
            .any(|module| module["Name"] == "UnrealAgentLink" && module["Type"] == "Editor")
    }) {
        return false;
    }
    let modules_dir = root.join("Binaries").join(platform());
    let Some(modules) = json_file(&modules_dir.join("UnrealEditor.modules")) else {
        return false;
    };
    let Some(engine_modules) = json_file(
        &Path::new(&engine.path)
            .join("Engine/Binaries")
            .join(platform())
            .join("UnrealEditor.modules"),
    ) else {
        return false;
    };
    let Some(build_id) = engine_modules["BuildId"]
        .as_str()
        .filter(|id| !id.is_empty())
    else {
        return false;
    };
    let expected_binary = if cfg!(windows) {
        "UnrealEditor-UnrealAgentLink.dll"
    } else if cfg!(target_os = "macos") {
        "UnrealEditor-UnrealAgentLink.dylib"
    } else {
        "libUnrealEditor-UnrealAgentLink.so"
    };
    let Some(binary) = modules["Modules"]["UnrealAgentLink"].as_str() else {
        return false;
    };
    modules["BuildId"].as_str() == Some(build_id)
        && binary == expected_binary
        && fs::metadata(modules_dir.join(binary))
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

fn source_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    fn visit(root: &Path, relative: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        for item in fs::read_dir(root.join(relative)).map_err(|_| "无法读取插件源码目录")?
        {
            let item = item.map_err(|_| "无法读取插件源码文件")?;
            let name = item.file_name();
            if relative.as_os_str().is_empty()
                && ["Binaries", "Intermediate", ".git"]
                    .iter()
                    .any(|excluded| name == *excluded)
            {
                continue;
            }
            let kind = item.file_type().map_err(|_| "无法检查插件源码文件")?;
            if kind.is_symlink() {
                return Err("插件源码包含目录联接或符号链接，为保护原文件未执行编译".into());
            }
            let path = relative.join(name);
            if kind.is_dir() {
                visit(root, &path, files)?;
            } else if kind.is_file() {
                files.push(path);
            } else {
                return Err("插件源码包含非普通文件".into());
            }
        }
        Ok(())
    }
    let metadata = fs::symlink_metadata(root).map_err(|_| "插件源码不存在")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("插件目录是联接或符号链接，未覆盖或编译它".into());
    }
    let mut files = vec![];
    visit(root, Path::new(""), &mut files)?;
    files.sort();
    Ok(files)
}

fn copy_source(root: &Path, destination: &Path) -> Result<String, String> {
    let files = source_files(root)?;
    let mut digest = Sha256::new();
    let mut total = 0u64;
    for relative in files {
        let length = fs::metadata(root.join(&relative))
            .map_err(|_| "无法检查插件源码大小")?
            .len();
        if total.saturating_add(length) > MAX_PLUGIN_BYTES {
            return Err("插件源码超过 384 MiB，未执行编译".into());
        }
        let bytes = fs::read(root.join(&relative)).map_err(|_| "无法读取插件源码")?;
        total = total.saturating_add(bytes.len() as u64);
        if total > MAX_PLUGIN_BYTES {
            return Err("插件源码超过 384 MiB，未执行编译".into());
        }
        let name = relative.to_string_lossy().replace('\\', "/");
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(&bytes);
        let target = destination.join(relative);
        fs::create_dir_all(target.parent().ok_or("源码路径无效")?)
            .map_err(|_| "无法创建插件编译目录")?;
        fs::write(target, bytes).map_err(|_| "无法准备插件源码副本")?;
    }
    Ok(format!("{:x}", digest.finalize()))
}

async fn download_source(destination: &Path) -> Result<(), String> {
    let cache_dir = crate::config::get_app_config_dir().join("unreal/downloads");
    fs::create_dir_all(&cache_dir).map_err(|_| "无法创建插件下载缓存")?;
    let cache = cache_dir.join(format!("UnrealAgentLink-{UAL_REVISION}.zip"));
    if let Ok(metadata) = fs::metadata(&cache) {
        if metadata.len() <= MAX_ARCHIVE_BYTES as u64 {
            if let Ok(bytes) = fs::read(&cache) {
                if extract_plugin_archive(&bytes, destination).is_ok() {
                    return Ok(());
                }
            }
        }
    }
    let mut response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "无法初始化插件下载")?
        .get(UAL_ARCHIVE_URL)
        .send()
        .await
        .map_err(|_| "插件源码下载失败，请检查 GitHub 网络连接后重试")?;
    if !response.status().is_success() {
        return Err(format!("插件源码下载返回 HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_ARCHIVE_BYTES as u64)
    {
        return Err("插件源码压缩包超过 96 MiB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "插件源码下载中断")? {
        if bytes.len().saturating_add(chunk.len()) > MAX_ARCHIVE_BYTES {
            return Err("插件源码压缩包超过 96 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    extract_plugin_archive(&bytes, destination)?;
    // The cache is disposable. A failed cache write must not fail installation.
    if let Ok(mut temporary) = tempfile::NamedTempFile::new_in(&cache_dir) {
        if temporary.write_all(&bytes).is_ok() {
            let _ = temporary.persist(&cache);
        }
    }
    Ok(())
}

fn dotnet(engine_root: &Path) -> Option<PathBuf> {
    let base = engine_root.join("Engine/Binaries/ThirdParty/DotNet");
    let runtime = if cfg!(windows) {
        "win-x64"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mac-arm64"
        } else {
            "mac-x64"
        }
    } else {
        "linux-x64"
    };
    let name = if cfg!(windows) {
        "dotnet.exe"
    } else {
        "dotnet"
    };
    let mut versions: Vec<_> = fs::read_dir(base)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    versions.sort_by_key(|path| {
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .split('.')
            .map(|part| part.parse::<u32>().unwrap_or(0))
            .collect::<Vec<_>>()
    });
    versions.reverse();
    versions
        .into_iter()
        .flat_map(|version| [version.join(runtime).join(name), version.join(name)])
        .find(|path| path.is_file())
}

async fn build(
    engine: &UnrealEngine,
    source: &Path,
    output: &Path,
    log: &Path,
) -> Result<(), String> {
    let engine_root = Path::new(&engine.path);
    let runtime = dotnet(engine_root)
        .ok_or("未找到此 UE 自带的 .NET 运行时，请在 Epic Launcher 验证或补全引擎组件")?;
    let uat = engine_root.join("Engine/Binaries/DotNET/AutomationTool/AutomationTool.dll");
    if !uat.is_file() {
        return Err("此引擎缺少 AutomationTool，无法编译连接插件；请先补全 UE 开发组件".into());
    }
    let output_log = fs::File::create(log).map_err(|_| "无法创建插件编译日志")?;
    let mut command = tokio::process::Command::new(&runtime);
    command
        .arg(&uat)
        .args(["BuildPlugin", "-Unattended", "-NoP4", "-UTF8Output"])
        .arg(format!(
            "-Plugin={}",
            source.join("UnrealAgentLink.uplugin").display()
        ))
        .arg(format!("-Package={}", output.display()))
        .arg(format!("-TargetPlatforms={}", platform()))
        .current_dir(uat.parent().ok_or("UE 构建路径无效")?)
        .env("DOTNET_ROOT", runtime.parent().ok_or("UE .NET 路径无效")?)
        .stdin(Stdio::null())
        .stdout(output_log.try_clone().map_err(|_| "无法打开编译日志")?)
        .stderr(output_log)
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 UE 插件编译：{error}"))?;
    let status = match tokio::time::timeout(Duration::from_secs(30 * 60), child.wait()).await {
        Ok(result) => result.map_err(|_| "无法读取插件编译结果")?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(format!(
                "插件编译超过 30 分钟，已停止。日志：{}",
                log.display()
            ));
        }
    };
    if !status.success() {
        return Err(format!("UE {} 插件编译失败，工程配置未修改。请检查 C++ 编译工具链和 Windows SDK（macOS 为 Xcode）。日志：{}",engine.version,log.display()));
    }
    if !is_ready(output, engine) {
        return Err(format!(
            "编译未产生与此引擎 BuildId 匹配的编辑器模块，未启用插件。日志：{}",
            log.display()
        ));
    }
    Ok(())
}

fn promote(
    project_file: &Path,
    source: &Path,
    built: &Path,
    target: &Path,
    scratch: &Path,
    existing: bool,
) -> Result<(), String> {
    if existing {
        // Only derived binaries are replaced. User Source, Content, descriptor,
        // custom files and existing Intermediate are never overwritten.
        let old = target.join("Binaries");
        let backup = scratch.join("previous-binaries");
        let had_old = old.exists();
        if had_old {
            fs::rename(&old, &backup).map_err(|_| {
                "插件模块被占用，请先保存并关闭此工程的 Unreal Editor；原插件未覆盖"
            })?;
        }
        if let Err(error) = fs::rename(built.join("Binaries"), &old) {
            if had_old {
                let _ = fs::rename(&backup, &old);
            }
            return Err(format!("插件模块安装失败，原模块已保留：{error}"));
        }
        if let Err(error) = enable_plugin_in_project(project_file) {
            let retired = scratch.join("uncommitted-binaries");
            let _ = fs::rename(&old, retired);
            if had_old {
                let _ = fs::rename(&backup, &old);
            }
            return Err(error);
        }
    } else {
        // UAT's packaging filter may omit the standalone license.
        fs::copy(source.join("LICENSE"), built.join("LICENSE"))
            .map_err(|_| "无法保留插件 MIT 许可证")?;
        fs::create_dir_all(target.parent().ok_or("插件路径无效")?)
            .map_err(|_| "无法创建 Plugins 目录")?;
        if target.exists() {
            return Err("插件目录在编译期间已发生变化，未覆盖它".into());
        }
        fs::rename(built, target).map_err(|_| "无法安装编译完成的插件")?;
        if let Err(error) = enable_plugin_in_project(project_file) {
            let _ = fs::rename(target, scratch.join("uncommitted-plugin"));
            return Err(error);
        }
    }
    Ok(())
}

pub(super) async fn install(
    project_file: &Path,
    project_root: &Path,
    engine: &UnrealEngine,
) -> Result<(), String> {
    static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _install = INSTALL
        .try_lock()
        .map_err(|_| "另一个 UE 桥正在安装或编译，请等待完成后重试")?;
    let target = project_root.join("Plugins/UnrealAgentLink");
    if is_ready(&target, engine) {
        return enable_plugin_in_project(project_file);
    }
    let existing = target.exists();
    if existing && !target.join("UnrealAgentLink.uplugin").is_file() {
        return Err("插件目录已存在但描述文件无效，未覆盖现有文件".into());
    }
    let scratch_parent = project_root.join("Intermediate/LoliCode");
    fs::create_dir_all(&scratch_parent).map_err(|_| "无法创建工程 Intermediate/LoliCode 目录")?;
    let scratch = tempfile::Builder::new()
        .prefix("ual-build-")
        .tempdir_in(&scratch_parent)
        .map_err(|_| "无法创建插件编译暂存目录")?;
    let source = scratch.path().join("SourcePlugin");
    let fingerprint = if existing {
        Some(copy_source(&target, &source)?)
    } else {
        download_source(&source).await?;
        None
    };
    if !source
        .join("Source/UnrealAgentLink/UnrealAgentLink.Build.cs")
        .is_file()
    {
        return Err("插件缺少 UnrealAgentLink 源码，无法为此引擎修复编译；现有文件未覆盖".into());
    }
    let log_dir = crate::config::get_app_config_dir().join("logs/unreal");
    fs::create_dir_all(&log_dir).map_err(|_| "无法创建 UE 桥日志目录")?;
    let log = log_dir.join(format!("plugin-build-{}.log", Uuid::new_v4().simple()));
    let built = scratch.path().join("BuiltPlugin");
    build(engine, &source, &built, &log).await?;
    if let Some(before) = fingerprint {
        let after = copy_source(&target, &scratch.path().join("SourceCheck"))?;
        if before != after {
            return Err("插件源码在编译期间已被修改，未安装旧编译结果，请重试".into());
        }
    }
    let result = promote(
        project_file,
        &source,
        &built,
        &target,
        scratch.path(),
        existing,
    );
    if result.is_err() {
        // In particular, never drop the only surviving old Binaries if a
        // rollback rename failed (locked DLL, disk error, concurrent edit).
        let retained = scratch.keep();
        return result.map_err(|error| format!("{error}；安装现场已保留：{}", retained.display()));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn engine(root: &Path) -> UnrealEngine {
        UnrealEngine {
            version: "5.8.3".into(),
            association_id: None,
            path: root.to_string_lossy().into_owned(),
            editor_executable: "editor".into(),
            source: "fixture".into(),
        }
    }
    fn module(root: &Path, build_id: &str) {
        let directory = root.join("Binaries").join(platform());
        fs::create_dir_all(&directory).unwrap();
        let binary = if cfg!(windows) {
            "UnrealEditor-UnrealAgentLink.dll"
        } else if cfg!(target_os = "macos") {
            "UnrealEditor-UnrealAgentLink.dylib"
        } else {
            "libUnrealEditor-UnrealAgentLink.so"
        };
        fs::write(directory.join(binary), "binary fixture").unwrap();
        fs::write(
            directory.join("UnrealEditor.modules"),
            json!({"BuildId":build_id,"Modules":{"UnrealAgentLink":binary}}).to_string(),
        )
        .unwrap();
    }
    fn source(root: &Path) {
        fs::create_dir_all(root.join("Source/UnrealAgentLink")).unwrap();
        fs::write(
            root.join("UnrealAgentLink.uplugin"),
            json!({"Modules":[{"Name":"UnrealAgentLink","Type":"Editor"}]}).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("Source/UnrealAgentLink/UnrealAgentLink.Build.cs"),
            "custom source kept",
        )
        .unwrap();
        fs::write(root.join("LICENSE"), "license fixture").unwrap();
    }
    #[test]
    fn source_only_wrong_engine_or_missing_binary_are_never_ready() {
        let temp = tempfile::tempdir().unwrap();
        let plugin = temp.path().join("Plugin");
        source(&plugin);
        let editor = temp.path().join("Engine/Binaries").join(platform());
        fs::create_dir_all(&editor).unwrap();
        fs::write(
            editor.join("UnrealEditor.modules"),
            json!({"BuildId":"engine-58"}).to_string(),
        )
        .unwrap();
        let engine = engine(temp.path());
        assert!(!is_ready(&plugin, &engine));
        module(&plugin, "different-engine");
        assert!(!is_ready(&plugin, &engine));
        module(&plugin, "engine-58");
        assert!(is_ready(&plugin, &engine));
        let modules = plugin
            .join("Binaries")
            .join(platform())
            .join("UnrealEditor.modules");
        fs::write(
            modules,
            json!({"BuildId":"engine-58","Modules":{"UnrealAgentLink":"../../other.dll"}})
                .to_string(),
        )
        .unwrap();
        assert!(!is_ready(&plugin, &engine));
    }
    #[test]
    fn repairing_only_replaces_derived_binaries_and_preserves_source_and_unknown_files() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("Plugins/UnrealAgentLink");
        source(&target);
        module(&target, "old");
        fs::write(target.join("custom.txt"), "user data").unwrap();
        let scratch = temp.path().join("Intermediate/LoliCode/test");
        fs::create_dir_all(&scratch).unwrap();
        let file = temp.path().join("Game.uproject");
        fs::write(&file, r#"{"EngineAssociation":"5.8","Custom":true}"#).unwrap();
        let source = scratch.join("source");
        let before = copy_source(&target, &source).unwrap();
        let built = scratch.join("built");
        module(&built, "new");
        promote(&file, &source, &built, &target, &scratch, true).unwrap();
        assert_eq!(
            copy_source(&target, &scratch.join("after")).unwrap(),
            before
        );
        assert_eq!(
            fs::read_to_string(target.join("custom.txt")).unwrap(),
            "user data"
        );
        assert!(json_file(&file).unwrap()["Custom"].as_bool().unwrap());
        assert_eq!(
            json_file(
                &target
                    .join("Binaries")
                    .join(platform())
                    .join("UnrealEditor.modules")
            )
            .unwrap()["BuildId"],
            "new"
        );
    }
    #[test]
    fn failed_project_enable_restores_original_binaries_and_project_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("Plugins/UnrealAgentLink");
        source(&target);
        module(&target, "old");
        let file = temp.path().join("Game.uproject");
        let original = r#"{"Plugins":"invalid user data"}"#;
        fs::write(&file, original).unwrap();
        let scratch = temp.path().join("Intermediate/LoliCode/test");
        fs::create_dir_all(&scratch).unwrap();
        let built = scratch.join("built");
        module(&built, "new");
        assert!(promote(&file, &target, &built, &target, &scratch, true).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), original);
        assert_eq!(
            json_file(
                &target
                    .join("Binaries")
                    .join(platform())
                    .join("UnrealEditor.modules")
            )
            .unwrap()["BuildId"],
            "old"
        );
    }
}
