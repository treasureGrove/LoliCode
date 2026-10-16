//! A content/CLI adapter for ZCode's public marketplace manifest. This is a
//! LoliCode implementation, not the ZCode JS/MCP runtime. Remote packages stay
//! on their original distribution service; installing verifies their published
//! SHA-256 and preserves the complete archive (including attribution/license).
use super::{bounded_file, linked, safe_component, SkillIssue, VerifiedSkill};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Cursor, Read},
    path::{Component, Path},
    time::Duration,
};

const OFFICIAL: &str = "zcode-plugins-official";
const FEED: &str = "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";
const MAX_ARCHIVE: usize = 24 * 1024 * 1024;
const MAX_EXPANDED: u64 = 64 * 1024 * 1024;
const ALLOWED: &[&str] = &[
    "github",
    "gitlab",
    "alibaba-cloud-cli",
    "lark-cli",
    "tencent-meeting-cli",
    "dingtalk-cli",
    "wecom-cli",
    "obsidian",
];
#[cfg(test)]
#[path = "marketplace_native_tests.rs"]
mod native_tests;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Installed {
    name: String,
    version: String,
    enabled: bool,
    installed_at: String,
    sha256: String,
    directory: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Settings {
    revision: u64,
    installed: Vec<Installed>,
}

fn owned(root: &Path) -> Result<(), String> {
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("插件目录无效".into());
    }
    for parent in root.ancestors().filter(|path| path.exists()) {
        if linked(&fs::symlink_metadata(parent).map_err(|_| "无法检查插件目录")?) {
            return Err("插件目录不能经过符号链接或目录联接".into());
        }
    }
    Ok(())
}
fn read_settings(root: &Path) -> Result<Settings, String> {
    owned(root)?;
    let path = root.join("cli-installed.json");
    if !path.exists() {
        return Ok(Settings::default());
    }
    let settings: Settings = serde_json::from_slice(&bounded_file(&path, root, 1024 * 1024)?)
        .map_err(|_| "CLI 插件记录损坏，原文件已保留")?;
    if settings
        .installed
        .iter()
        .any(|entry| !ALLOWED.contains(&entry.name.as_str()) || !safe_component(&entry.directory))
    {
        return Err("CLI 插件记录无效，原文件已保留".into());
    }
    Ok(settings)
}
fn save_settings(root: &Path, settings: &mut Settings) -> Result<(), String> {
    owned(root)?;
    settings.revision = settings.revision.checked_add(1).ok_or("插件版本超出范围")?;
    fs::create_dir_all(root).map_err(|_| "无法创建插件目录")?;
    crate::config::atomic_write_private(
        &root.join("cli-installed.json"),
        &serde_json::to_vec_pretty(settings).map_err(|_| "插件记录无法编码")?,
    )
    .map_err(|error| error.to_string())
}
fn manifest(root: &Path) -> Result<Value, String> {
    let path = root.join("cli-marketplace.json");
    let value = if path.exists() {
        serde_json::from_slice(&bounded_file(&path, root, 2 * 1024 * 1024)?)
            .map_err(|_| "CLI 市场缓存损坏")?
    } else {
        serde_json::from_str(include_str!("cli-marketplace.json"))
            .map_err(|_| "内置 CLI 目录损坏")?
    };
    validate_manifest(&value)?;
    Ok(value)
}
fn validate_manifest(value: &Value) -> Result<(), String> {
    if value["name"] != OFFICIAL || !value["plugins"].is_array() {
        return Err("不是受支持的 ZCode 官方插件目录".into());
    }
    for entry in value["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| ALLOWED.contains(&entry["name"].as_str().unwrap_or_default()))
    {
        source(entry)?;
    }
    Ok(())
}
fn source(entry: &Value) -> Result<(&str, &str, &str), String> {
    let name = entry["name"]
        .as_str()
        .filter(|name| ALLOWED.contains(name))
        .ok_or("此插件依赖尚未接入的宿主，暂不支持安装")?;
    let version = entry["version"]
        .as_str()
        .filter(|value| {
            !value.is_empty()
                && *value != "."
                && *value != ".."
                && value.len() < 80
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
        })
        .ok_or("插件版本无效")?;
    let hash = entry["source"]["sha256"]
        .as_str()
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("插件未提供 SHA-256，已拒绝安装")?;
    let url = entry["source"]["url"].as_str().ok_or("插件下载地址无效")?;
    if url
        != format!(
            "https://cdn-zcode.z.ai/zcode/official-plugin/plugins/{name}/{version}/plugin.zip"
        )
        || entry["source"]["path"] != name
        || entry["source"]["type"] != "zip"
    {
        return Err("插件来源不符合官方隔离下载规则".into());
    }
    Ok((url, hash, version))
}
async fn fetch(url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化插件下载")?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "插件服务连接失败，请稍后重试")?
        .error_for_status()
        .map_err(|_| "插件服务返回错误，请稍后重试")?;
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("插件下载超过大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "插件下载中断，原安装已保留")?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("插件下载超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub fn revision(root: &Path) -> Result<u64, String> {
    Ok(read_settings(root)?.revision)
}
pub fn overview(root: &Path) -> Result<Value, String> {
    let manifest = manifest(root)?;
    let settings = read_settings(root)?;
    let available = manifest["plugins"].as_array().unwrap().iter().filter(|entry| ALLOWED.contains(&entry["name"].as_str().unwrap_or_default())).map(|entry| {
        let name = entry["name"].as_str().unwrap();
        let installed = settings.installed.iter().any(|item| item.name == name);
        let mut listing = entry.clone();
        listing["id"] = json!(format!("cli-{name}")); listing["marketplace"] = json!(OFFICIAL); listing["installed"] = json!(installed);
        listing["componentTypes"] = json!(["CLI 技能"]);
        listing["listing"] = json!({"displayName":entry["displayName"].as_str().unwrap_or(name),"descriptionI18n":entry["description_i18n"],"author":"Z.ai / 上游作者","category":"developer-tools","homepage":"https://github.com/zai-org/ZCode"});
        listing
    }).collect::<Vec<_>>();
    let installed = settings.installed.iter().map(|item| {
        let latest = available.iter().find(|entry| entry["name"] == item.name);
        json!({"id":format!("cli-{}",item.name),"name":item.name,"version":item.version,"marketplace":OFFICIAL,"enabled":item.enabled,"scope":"user","installedAt":item.installed_at,"componentTypes":["CLI 技能"],"latestVersion":latest.map(|entry| &entry["version"]),"updateStatus":if latest.is_some_and(|entry| entry["version"] != item.version) {"update-available"} else {"none"},"listing":latest.map(|entry| &entry["listing"])})
    }).collect::<Vec<_>>();
    let (_, issues) = skills(root)?;
    let diagnostics = issues
        .into_iter()
        .map(|issue| json!({"severity":"warning","pluginId":issue.id,"message":issue.message}))
        .collect::<Vec<_>>();
    Ok(
        json!({"marketplaces":[{"id":OFFICIAL,"name":"ZCode CLI 适配目录","isOfficial":true,"description":"从官方原始分发安装 CLI 技能。仅接入独立 CLI；安装后由 Agent 按需检查依赖与授权。","pluginCount":available.len(),"source":{"url":FEED}}],"availablePlugins":available,"installedPlugins":installed,"restorableBuiltins":[],"diagnostics":diagnostics,"capability":{"supported":true,"customSources":false,"localPluginRuntime":false,"mcpRuntime":false}}),
    )
}
pub async fn invoke(root: &Path, method: &str, args: &Value) -> Result<Value, String> {
    owned(root)?;
    match method {
        "getPluginStore" => {}
        "updatePluginMarketplace" | "addPluginMarketplace" => {
            if method == "addPluginMarketplace" && args["source"].as_str() != Some(FEED) {
                return Err(
                    "当前接入 ZCode 官方 CLI 目录；自定义 JS、MCP 宿主需单独适配，不能直接运行"
                        .into(),
                );
            }
            if args["marketplace"]
                .as_str()
                .is_some_and(|id| id != OFFICIAL)
            {
                return Err("市场来源不存在".into());
            }
            let bytes = fetch(FEED, 2 * 1024 * 1024).await?;
            let manifest: Value =
                serde_json::from_slice(&bytes).map_err(|_| "市场目录无法解析，已保留上次目录")?;
            validate_manifest(&manifest)?;
            fs::create_dir_all(root).map_err(|_| "无法保存市场目录")?;
            crate::config::atomic_write_private(&root.join("cli-marketplace.json"), &bytes)
                .map_err(|error| error.to_string())?;
        }
        "installMarketplacePlugin" | "updateMarketplacePlugin" | "restoreBuiltinPlugin" => {
            let id = args["pluginId"].as_str().unwrap_or_default();
            let name = args["pluginName"]
                .as_str()
                .or_else(|| id.strip_prefix("cli-"))
                .ok_or("插件编号无效")?;
            if args["marketplace"]
                .as_str()
                .is_some_and(|id| id != OFFICIAL)
            {
                return Err("市场来源不存在".into());
            }
            let catalog = manifest(root)?;
            let entry = catalog["plugins"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["name"] == name)
                .ok_or("CLI 插件不存在")?;
            let (url, hash, version) = source(entry)?;
            let bytes = fetch(url, MAX_ARCHIVE).await?;
            let root = root.to_path_buf();
            let name = name.to_owned();
            let version = version.to_owned();
            let hash = hash.to_owned();
            tokio::task::spawn_blocking(move || {
                install_archive(&root, &name, &version, &hash, bytes)
            })
            .await
            .map_err(|_| "插件安装未完成")??;
        }
        "uninstallMarketplacePlugin" | "setCliPluginEnabled" => {
            let id = args["pluginId"]
                .as_str()
                .or_else(|| args["id"].as_str())
                .and_then(|id| id.strip_prefix("cli-"))
                .ok_or("插件编号无效")?;
            let mut settings = read_settings(root)?;
            if !settings.installed.iter().any(|entry| entry.name == id) {
                return Err("CLI 插件尚未安装")?;
            }
            if method == "setCliPluginEnabled" {
                settings
                    .installed
                    .iter_mut()
                    .find(|entry| entry.name == id)
                    .unwrap()
                    .enabled = args["enabled"].as_bool().ok_or("启用状态无效")?;
            } else {
                settings.installed.retain(|entry| entry.name != id);
            }
            // Keep retired immutable versions as a recoverable local cache.
            save_settings(root, &mut settings)?;
        }
        "removePluginMarketplace" => {
            return Err("默认 CLI 目录无需移除，可逐项停用或卸载插件".into())
        }
        _ => return Err("CLI 市场方法无效".into()),
    }
    overview(root)
}

fn install_archive(
    root: &Path,
    name: &str,
    version: &str,
    hash: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if format!("{:x}", Sha256::digest(&bytes)) != hash.to_ascii_lowercase() {
        return Err("插件校验失败，未更改原安装".into());
    }
    owned(root)?;
    fs::create_dir_all(root).map_err(|_| "无法创建插件目录")?;
    let stage = tempfile::Builder::new()
        .prefix(".cli-stage-")
        .tempdir_in(root)
        .map_err(|_| "无法准备插件暂存目录")?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "插件不是有效 ZIP")?;
    if archive.len() > 1500 {
        return Err("插件文件数量过多".into());
    }
    let mut expanded = 0u64;
    let mut seen = BTreeSet::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|_| "插件 ZIP 无法读取")?;
        let filename = file.name().to_owned();
        if filename.contains(['\\', ':'])
            || file
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("插件包含不安全文件".into());
        }
        let path = file.enclosed_name().ok_or("插件路径越界")?;
        if !path.starts_with(name)
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("插件路径越界".into());
        }
        if path.components().any(|part| match part {
            Component::Normal(value) => value.to_str().is_none_or(|value| {
                value.ends_with(['.', ' '])
                    || value.chars().any(char::is_control)
                    || matches!(
                        value
                            .split('.')
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
                    )
            }),
            _ => true,
        }) {
            return Err("插件包含跨平台不安全文件名".into());
        }
        if !seen.insert(filename.to_lowercase()) {
            return Err("插件包含重复文件".into());
        }
        expanded = expanded.checked_add(file.size()).ok_or("插件过大")?;
        if expanded > MAX_EXPANDED || file.size() > 8 * 1024 * 1024 {
            return Err("插件解压大小超过限制".into());
        }
        let target = stage.path().join(path);
        if file.is_dir() {
            fs::create_dir_all(&target).map_err(|_| "无法准备插件目录")?;
            continue;
        }
        fs::create_dir_all(target.parent().ok_or("插件路径无效")?)
            .map_err(|_| "无法准备插件目录")?;
        let mut output = fs::File::create(&target).map_err(|_| "无法保存插件文件")?;
        std::io::copy(&mut file.take(8 * 1024 * 1024 + 1), &mut output)
            .map_err(|_| "插件解压失败")?;
    }
    let plugin_root = stage.path().join(name);
    let plugin = plugin_root.join(".zcode-plugin/plugin.json");
    let definition: Value =
        serde_json::from_slice(&bounded_file(&plugin, stage.path(), 256 * 1024)?)
            .map_err(|_| "插件声明无法解析")?;
    if definition["name"] != name || definition["version"] != version {
        return Err("插件身份与目录不一致".into());
    }
    // Skills can invoke a CLI through the existing permission-controlled shell.
    // Hooks, MCP and custom tools must not silently run in the native process.
    for key in ["hooks", "mcpServers", "mcp", "tools", "server", "runtime"] {
        if definition
            .get(key)
            .is_some_and(|value| !value.is_null() && value != &json!({}) && value != &json!([]))
        {
            return Err("此版本含宿主执行入口，需要单独适配，原插件已保留".into());
        }
    }
    if !plugin_root.join("skills").is_dir() {
        return Err("此插件没有可接入的 CLI 技能".into());
    }
    let mut directory = format!("{name}-{}", &hash[..16]);
    if root.join(&directory).exists() {
        directory.push_str(&format!(
            "-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
    }
    let target = root.join(&directory);
    fs::rename(&plugin_root, &target).map_err(|_| "插件目录激活失败")?;
    let mut settings = read_settings(root)?;
    let enabled = settings
        .installed
        .iter()
        .find(|entry| entry.name == name)
        .is_none_or(|entry| entry.enabled);
    settings.installed.retain(|entry| entry.name != name);
    settings.installed.push(Installed {
        name: name.into(),
        version: version.into(),
        enabled,
        installed_at: chrono::Utc::now().to_rfc3339(),
        sha256: hash.into(),
        directory,
    });
    save_settings(root, &mut settings)
}

pub fn skills(root: &Path) -> Result<(Vec<VerifiedSkill>, Vec<SkillIssue>), String> {
    let mut skills = vec![];
    let mut issues = vec![];
    let settings = match read_settings(root) {
        Ok(settings) => settings,
        Err(message) => {
            return Ok((
                skills,
                vec![SkillIssue {
                    id: "cli-marketplace".into(),
                    message,
                }],
            ))
        }
    };
    for plugin in settings.installed.into_iter().filter(|entry| entry.enabled) {
        let base = root.join(&plugin.directory);
        let entries = match fs::read_dir(base.join("skills")) {
            Ok(entries) => entries,
            Err(_) => {
                issues.push(SkillIssue {
                    id: format!("cli-{}", plugin.name),
                    message: "已安装 CLI 插件技能目录缺失，请重新安装此插件".into(),
                });
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    issues.push(SkillIssue {
                        id: format!("cli-{}", plugin.name),
                        message: "CLI 技能目录无法读取".into(),
                    });
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if !safe_component(&name) {
                continue;
            }
            let id = format!("cli-{}-{name}", plugin.name);
            let result = (|| {
                let bytes = bounded_file(&entry.path().join("SKILL.md"), &base, 128 * 1024)?;
                let mut content = String::from_utf8(bytes).map_err(|_| "CLI 技能不是 UTF-8")?;
                let normalized = content.replace("\r\n", "\n");
                let frontmatter = normalized
                    .strip_prefix("---\n")
                    .and_then(|text| text.split_once("\n---"))
                    .ok_or("CLI 技能声明无效")?
                    .0;
                let meta: serde_yaml::Value =
                    serde_yaml::from_str(frontmatter).map_err(|_| "CLI 技能声明无效")?;
                let description = meta["description"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                    .ok_or("CLI 技能缺少说明")?;
                // Native file tools stay project-scoped. Attach explicitly
                // referenced guides to this on-demand body instead of asking
                // the model to escape that boundary to read plugin files.
                let references = regex::Regex::new(
                    r"(?:\.\./)+(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.(?:md|txt)",
                )
                .map_err(|_| "CLI 引用规则无效")?;
                let paths = references
                    .find_iter(&content)
                    .map(|value| value.as_str().to_owned())
                    .collect::<BTreeSet<_>>();
                let mut supplements = String::new();
                for relative in paths.into_iter().take(16) {
                    let file = fs::canonicalize(entry.path().join(&relative))
                        .map_err(|_| format!("CLI 技能引用缺失：{relative}"))?;
                    let text = String::from_utf8(bounded_file(&file, &base, 64 * 1024)?)
                        .map_err(|_| "CLI 引用不是 UTF-8")?;
                    if content.len() + supplements.len() + text.len() > 128 * 1024 {
                        return Err("CLI 技能与引用总量超出预算".into());
                    }
                    supplements.push_str(&format!(
                        "\n\n## 已随本次 read_skill 读取的参考资料：{relative}\n{text}"
                    ));
                }
                content.push_str(&supplements);
                Ok::<_,String>(VerifiedSkill{id:id.clone(),name:format!("{}:{name}",plugin.name),description:description.chars().take(512).collect(),content:format!("技能资源目录：{}\n插件目录：{}\n相对引用以技能资源目录为起点；现有 shell 权限规则照常适用。先检查 CLI 安装和登录状态，依赖安装或登录需要用户参与。\n\n{}",entry.path().display(),base.display(),content)})
            })();
            match result {
                Ok(skill) => skills.push(skill),
                Err(message) => issues.push(SkillIssue { id, message }),
            }
        }
    }
    skills.sort_by(|a, b| a.id.cmp(&b.id));
    Ok((skills, issues))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn cli_marketplace_source_validation_rejects_unpinned_or_arbitrary_downloads() {
        let manifest: Value = serde_json::from_str(include_str!("cli-marketplace.json")).unwrap();
        let original = manifest["plugins"][0].clone();
        assert!(source(&original).is_ok());
        let mut changed = original.clone();
        changed["source"]["url"] = json!("https://example.test/arbitrary.zip");
        assert!(source(&changed).is_err());
        changed = original.clone();
        changed["source"]["sha256"] = Value::Null;
        assert!(source(&changed).is_err());
        changed = original.clone();
        changed["name"] = json!("unregistered-host");
        assert!(source(&changed).is_err());
        changed = original;
        changed["source"]["path"] = json!("../elsewhere");
        assert!(source(&changed).is_err());
    }
    fn archive(files: &[(&str, &str)]) -> (Vec<u8>, String) {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in files {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        let bytes = writer.finish().unwrap().into_inner();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        (bytes, hash)
    }
    #[test]
    fn cli_marketplace_install_enable_remove_preserves_source_and_isolates_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("owned-cli");
        let (bytes,hash) = archive(&[
            ("github/.zcode-plugin/plugin.json", r#"{"name":"github","version":"0.1.2"}"#),
            ("github/skills/setup/SKILL.md", "---\nname: setup\ndescription: CLI fixture setup\n---\nRead ../../references/preflight.md first.\n"),
            ("github/references/preflight.md", "OWNED_PREFLIGHT"),
            ("github/LICENSE", "OWNED_TEST_LICENSE"),
        ]);
        install_archive(&root, "github", "0.1.2", &hash, bytes.clone()).unwrap();
        let (skills, issues) = skills(&root).unwrap();
        assert!(issues.is_empty());
        assert_eq!(skills[0].id, "cli-github-setup");
        assert!(skills[0].content.contains("插件目录："));
        let settings = read_settings(&root).unwrap();
        let plugin = root.join(&settings.installed[0].directory);
        assert_eq!(
            fs::read_to_string(plugin.join("LICENSE")).unwrap(),
            "OWNED_TEST_LICENSE"
        );
        assert!(!temp.path().join(".zcode").exists());
        assert!(!temp.path().join(".config").exists());
        assert!(install_archive(&root, "github", "0.1.2", &"0".repeat(64), bytes).is_err());
        assert_eq!(read_settings(&root).unwrap().installed[0].sha256, hash);
    }
    #[tokio::test]
    async fn cli_marketplace_enablement_changes_registry_and_uninstall_is_recoverable() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("owned-cli");
        let (bytes, hash) = archive(&[
            (
                "github/.zcode-plugin/plugin.json",
                r#"{"name":"github","version":"0.1.2"}"#,
            ),
            (
                "github/skills/setup/SKILL.md",
                "---\nname: setup\ndescription: Fixture\n---\nFixture",
            ),
        ]);
        install_archive(&root, "github", "0.1.2", &hash, bytes).unwrap();
        let previous = revision(&root).unwrap();
        invoke(
            &root,
            "setCliPluginEnabled",
            &json!({"id":"cli-github","enabled":false}),
        )
        .await
        .unwrap();
        assert!(skills(&root).unwrap().0.is_empty());
        assert!(revision(&root).unwrap() > previous);
        invoke(
            &root,
            "setCliPluginEnabled",
            &json!({"id":"cli-github","enabled":true}),
        )
        .await
        .unwrap();
        assert_eq!(skills(&root).unwrap().0.len(), 1);
        invoke(
            &root,
            "uninstallMarketplacePlugin",
            &json!({"pluginId":"cli-github"}),
        )
        .await
        .unwrap();
        assert!(skills(&root).unwrap().0.is_empty());
        assert!(root.join(format!("github-{}", &hash[..16])).is_dir());
    }
    #[test]
    fn cli_marketplace_rejects_zip_escape_duplicate_paths_and_runtime_hooks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("owned-cli");
        for files in [
            vec![("../escape", "BAD")],
            vec![("github/FILE", "A"), ("github/file", "B")],
            vec![("github/CON", "BAD")],
            vec![(
                "github/.zcode-plugin/plugin.json",
                r#"{"name":"github","version":"0.1.2","hooks":{"start":"bad"}}"#,
            )],
        ] {
            let (bytes, hash) = archive(&files);
            assert!(install_archive(&root, "github", "0.1.2", &hash, bytes).is_err());
        }
        assert!(!temp.path().join("escape").exists());
        assert!(read_settings(&root).unwrap().installed.is_empty());
    }
    #[tokio::test]
    #[ignore = "explicit public CDN acceptance, installs into a temporary directory only"]
    async fn cli_marketplace_public_cdn_acceptance() {
        let temp = tempfile::tempdir().unwrap();
        let extension_root = temp.path().join("owned-extensions");
        let root = extension_root.join("cli-marketplace");
        invoke(&root, "updatePluginMarketplace", &json!({}))
            .await
            .unwrap();
        for name in ALLOWED {
            invoke(
                &root,
                "installMarketplacePlugin",
                &json!({"marketplace":OFFICIAL,"pluginName":name}),
            )
            .await
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        }
        let (skills, issues) = skills(&root).unwrap();
        assert!(issues.is_empty(), "{issues:?}");
        assert!(skills.len() >= ALLOWED.len());
        let store = super::super::InprocessExtensionStore::new(
            extension_root,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/agent/extensions"),
        )
        .unwrap();
        let prepared = store.prepare_skills().unwrap();
        assert_eq!(
            prepared
                .verified_skills
                .iter()
                .filter(|skill| skill.id.starts_with("cli-"))
                .count(),
            skills.len(),
            "Every installed CLI skill must enter the real native registry"
        );
        assert!(prepared.omitted.is_empty(), "{:?}", prepared.omitted);
        let overview = overview(&root).unwrap();
        assert_eq!(
            overview["installedPlugins"].as_array().unwrap().len(),
            ALLOWED.len()
        );
        println!("CLI_CDN_ACCEPTANCE: {} plugins, {} parsed skills, all hashes verified; temp isolation; no dependency installer executed",ALLOWED.len(),skills.len());
    }
}
