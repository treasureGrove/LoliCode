//! Extensions owned exclusively by the LoliCode agent. Original client configs,
//! credentials, source skill directories, and global OpenCode installs are untouched.

use crate::{config::atomic_write_private, error::AppError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const SETTINGS_FILE: &str = "extensions.json";
const OWNER_FILE: &str = ".lolicode-agent-extensions";
const OWNER: &str = "LoliCode agent extensions v1\n";
const HIDDEN: &str = "[hidden]";
const MAX_FILES: usize = 512;
const MAX_BYTES: u64 = 16 * 1024 * 1024;
#[cfg(any(test, feature = "test-hooks"))]
const PROJECTION_VERSION: &[u8] = b"LoliCode extension projection 2: directory plugin wrappers";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub installed: bool,
    pub enabled: bool,
    pub license: Option<String>,
    pub source_url: Option<String>,
    pub requirements: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginEntry {
    pub id: String,
    pub name: String,
    pub entry: String,
    pub source: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub server_type: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExtensionsCatalog {
    pub revision: u64,
    pub skills: Vec<AgentSkillEntry>,
    pub plugins: Vec<AgentPluginEntry>,
    pub mcp_servers: Vec<AgentMcpEntry>,
}

/// Only masked extension configuration crosses IPC. The full engine config and
/// channel credentials are deliberately not part of this structure.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExtensionConfig {
    pub revision: u64,
    pub mcp: Value,
    #[serde(default)]
    pub plugin_options: BTreeMap<String, Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSkill {
    id: String,
    name: String,
    description: String,
    enabled: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPlugin {
    id: String,
    name: String,
    entry: String,
    enabled: bool,
    #[serde(default = "empty_options")]
    options: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    disabled_bundled: BTreeSet<String>,
    #[serde(default)]
    removed_bundled: BTreeSet<String>,
    #[serde(default)]
    skills: Vec<StoredSkill>,
    #[serde(default)]
    plugins: Vec<StoredPlugin>,
    #[serde(default = "empty_mcp")]
    mcp: Value,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            revision: 0,
            disabled_bundled: BTreeSet::new(),
            removed_bundled: BTreeSet::new(),
            skills: Vec::new(),
            plugins: Vec::new(),
            mcp: empty_mcp(),
        }
    }
}
fn empty_mcp() -> Value {
    json!({"servers":{}})
}
fn empty_options() -> Value {
    json!({})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
    version: u32,
    source_revision: String,
    skills: Vec<BundledSkill>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledSkill {
    id: String,
    directory: String,
    license: String,
    source_url: String,
    #[serde(default)]
    requirements: Vec<String>,
    files: Vec<BundleFile>,
}
#[derive(Deserialize)]
struct BundleFile {
    path: String,
    sha256: String,
}

pub struct AgentExtensionStore {
    root: PathBuf,
    bundled_root: PathBuf,
}

fn operation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
fn input(message: &str) -> AppError {
    AppError::InvalidInput(message.into())
}
fn config_error(message: &str) -> AppError {
    AppError::Config(message.into())
}
fn io(path: &Path, error: std::io::Error) -> AppError {
    AppError::io(path, error)
}
fn json_bytes(value: &impl Serialize) -> Result<Vec<u8>, AppError> {
    serde_json::to_vec_pretty(value).map_err(|source| AppError::JsonSerialize { source })
}
fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
fn link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
fn absolute_owned(path: &Path) -> Result<(), AppError> {
    if !path.is_absolute()
        || path.parent().is_none()
        || path.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(input("扩展目录必须是独立的绝对路径"));
    }
    for ancestor in path.ancestors() {
        if ancestor.exists() && link(&fs::symlink_metadata(ancestor).map_err(|e| io(ancestor, e))?)
        {
            return Err(input("扩展目录不能经过符号链接或目录联接"));
        }
    }
    Ok(())
}
fn safe_relative(value: &str) -> Result<PathBuf, AppError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || value.contains(':')
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(input("扩展文件包含不安全的相对路径"));
    }
    Ok(path.to_path_buf())
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, AppError> {
    let bytes = fs::read(path).map_err(|e| io(path, e))?;
    if bytes.len() > MAX_BYTES as usize {
        return Err(config_error("扩展配置超过大小限制"));
    }
    serde_json::from_slice(&bytes).map_err(|_| config_error("扩展配置无法解析，原文件已保留"))
}
fn skill_metadata(path: &Path) -> Result<(String, String), AppError> {
    let bytes = fs::read(path).map_err(|e| io(path, e))?;
    if bytes.len() > 512 * 1024 {
        return Err(input("SKILL.md 超过大小限制"));
    }
    let text = String::from_utf8(bytes).map_err(|_| input("SKILL.md 必须使用 UTF-8"))?;
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let yaml = text
        .strip_prefix("---\n")
        .and_then(|s| s.split_once("\n---").map(|(yaml, _)| yaml))
        .ok_or_else(|| input("技能需要带 name 和 description 的 YAML frontmatter"))?;
    let value: serde_yaml::Value =
        serde_yaml::from_str(yaml).map_err(|_| input("技能 frontmatter 无法解析"))?;
    let name = value["name"]
        .as_str()
        .filter(|name| valid_name(name))
        .ok_or_else(|| input("技能 name 需要使用字母、数字或短横线"))?;
    let description = value["description"]
        .as_str()
        .filter(|description| !description.trim().is_empty())
        .ok_or_else(|| input("技能 description 不能为空"))?;
    Ok((name.into(), description.into()))
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), AppError> {
    absolute_owned(source)?;
    absolute_owned(target)?;
    // Resolve the existing ancestor of a new destination to reject self-copy,
    // including Windows case differences and aliased directory spellings.
    fn resolved(path: &Path) -> Result<PathBuf, AppError> {
        if path.exists() {
            return fs::canonicalize(path).map_err(|e| io(path, e));
        }
        let parent = path.parent().ok_or_else(|| input("扩展路径无效"))?;
        Ok(resolved(parent)?.join(path.file_name().ok_or_else(|| input("扩展路径无效"))?))
    }
    let resolved_source = resolved(source)?;
    let resolved_target = resolved(target)?;
    if resolved_target.starts_with(&resolved_source)
        || resolved_source.starts_with(&resolved_target)
    {
        return Err(input("导入来源与私有扩展目录不能互相包含"));
    }
    fn walk(
        source: &Path,
        target: &Path,
        count: &mut usize,
        bytes: &mut u64,
        nodes: &mut usize,
        depth: usize,
    ) -> Result<(), AppError> {
        absolute_owned(target)?;
        *nodes += 1;
        if depth > 48 || *nodes > 4096 {
            return Err(input("扩展目录层级或条目超过限制"));
        }
        let metadata = fs::symlink_metadata(source).map_err(|e| io(source, e))?;
        if link(&metadata) {
            return Err(input("不能导入带符号链接或目录联接的扩展"));
        }
        if metadata.is_file() {
            *count += 1;
            *bytes = bytes
                .checked_add(metadata.len())
                .ok_or_else(|| input("扩展超过大小限制"))?;
            if *count > MAX_FILES || *bytes > MAX_BYTES {
                return Err(input("扩展超过 512 文件或 16 MiB 限制"));
            }
            fs::copy(source, target).map_err(|e| io(target, e))?;
        } else if metadata.is_dir() {
            fs::create_dir_all(target).map_err(|e| io(target, e))?;
            for entry in fs::read_dir(source).map_err(|e| io(source, e))? {
                let entry = entry.map_err(|e| io(source, e))?;
                walk(
                    &entry.path(),
                    &target.join(entry.file_name()),
                    count,
                    bytes,
                    nodes,
                    depth + 1,
                )?;
            }
        } else {
            return Err(input("只能导入普通文件和目录"));
        }
        Ok(())
    }
    walk(source, target, &mut 0, &mut 0, &mut 0, 0)
}

fn mask_value(value: &mut Value, key: Option<&str>) {
    match value {
        Value::Object(object) => {
            for (name, value) in object {
                mask_value(value, Some(name));
            }
        }
        Value::Array(array) => {
            if key == Some("command") {
                // A local server defines its own argument schema. Arguments can
                // contain positional passwords, header expressions or inline
                // scripts; retain them privately rather than guessing flag names.
                for value in array.iter_mut().skip(1) {
                    if value.is_string() {
                        *value = json!(HIDDEN);
                    }
                }
            } else {
                for value in array {
                    mask_value(value, key);
                }
            }
        }
        Value::String(_) => {
            let name = key.unwrap_or_default().to_ascii_lowercase();
            if name.contains("token")
                || name.contains("secret")
                || name.contains("password")
                || name.contains("api_key")
                || name.contains("apikey")
                || name == "authorization"
            {
                *value = json!(HIDDEN);
            }
        }
        _ => {}
    }
    if let Value::Object(object) = value {
        for name in ["headers", "environment"] {
            if let Some(Value::Object(values)) = object.get_mut(name) {
                for value in values.values_mut() {
                    if value.is_string() {
                        *value = json!(HIDDEN);
                    }
                }
            }
        }
    }
}
fn restore_hidden(next: &mut Value, previous: &Value) -> Result<(), AppError> {
    match next {
        Value::String(value) if value == HIDDEN => {
            if !previous.is_string() || previous.as_str() == Some(HIDDEN) {
                return Err(input("新的凭据不能使用隐藏占位，请填写实际值或删除该字段"));
            }
            *next = previous.clone();
        }
        Value::Object(object) => {
            for (key, value) in object {
                restore_hidden(value, &previous[key])?;
            }
        }
        Value::Array(array) => {
            for (index, value) in array.iter_mut().enumerate() {
                restore_hidden(value, &previous[index])?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn mask_plugin_options(value: &mut Value) {
    // Third-party plugins define arbitrary option names. Without their schema,
    // strings may be credentials even when the key is not called "token".
    match value {
        Value::String(_) => *value = json!(HIDDEN),
        Value::Array(values) => values.iter_mut().for_each(mask_plugin_options),
        Value::Object(values) => values.values_mut().for_each(mask_plugin_options),
        _ => {}
    }
}

fn validate_mcp(mcp: &Value) -> Result<(), AppError> {
    let servers = mcp
        .get("servers")
        .and_then(Value::as_object)
        .ok_or_else(|| input("MCP 配置需要 servers 对象"))?;
    for (id, server) in servers {
        if !valid_name(id) || !server.is_object() {
            return Err(input("MCP 服务标识或配置无效"));
        }
        match server["type"].as_str() {
            Some("local") => {
                let command = server["command"]
                    .as_array()
                    .filter(|args| !args.is_empty())
                    .ok_or_else(|| input("本地 MCP 服务需要 command 字符串数组"))?;
                if !command.iter().all(|arg| {
                    arg.as_str()
                        .is_some_and(|arg| !arg.is_empty() && !arg.contains('\0'))
                }) {
                    return Err(input("MCP command 不能为空或含无效字符"));
                }
                if let Some(cwd) = server.get("cwd") {
                    let cwd = cwd
                        .as_str()
                        .ok_or_else(|| input("MCP cwd 必须是绝对目录"))?;
                    if !Path::new(cwd).is_absolute() {
                        return Err(input("MCP cwd 必须是绝对目录"));
                    }
                }
            }
            Some("remote") => {
                let url = url::Url::parse(server["url"].as_str().unwrap_or_default())
                    .map_err(|_| input("远程 MCP 需要完整 HTTP(S) 地址"))?;
                if !matches!(url.scheme(), "http" | "https")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err(input(
                        "MCP 地址不能夹带查询凭据或密码，请使用 headers 或原生 OAuth",
                    ));
                }
            }
            _ => return Err(input("MCP type 需要为 local 或 remote")),
        }
        for field in ["environment", "headers"] {
            if let Some(value) = server.get(field) {
                if !value
                    .as_object()
                    .is_some_and(|values| values.values().all(Value::is_string))
                {
                    return Err(input("MCP environment 和 headers 必须是字符串对象"));
                }
            }
        }
        if server
            .get("disabled")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err(input("MCP disabled 必须是布尔值"));
        }
    }
    Ok(())
}

impl AgentExtensionStore {
    /// bundled_root = resource_dir/agent/extensions; root = app_data/agent/extensions.
    pub fn new(root: PathBuf, bundled_root: PathBuf) -> Result<Self, AppError> {
        absolute_owned(&root)?;
        absolute_owned(&bundled_root)?;
        Ok(Self { root, bundled_root })
    }
    fn settings(&self) -> Result<Settings, AppError> {
        absolute_owned(&self.root)?;
        let path = self.root.join(SETTINGS_FILE);
        if !path.exists() {
            return Ok(Settings::default());
        }
        let marker = self.root.join(OWNER_FILE);
        absolute_owned(&path)?;
        absolute_owned(&marker)?;
        if fs::read_to_string(&marker)
            .map_err(|_| config_error("扩展目录缺少归属标记，原数据已保留"))?
            != OWNER
        {
            return Err(config_error("扩展目录归属无效，原数据已保留"));
        }
        let settings: Settings = read_json(&path)?;
        validate_mcp(&settings.mcp)?;
        let mut ids = BTreeSet::new();
        for skill in &settings.skills {
            if !valid_name(&skill.id) || !valid_name(&skill.name) || !ids.insert(skill.id.clone()) {
                return Err(config_error("本地技能记录无效，原数据已保留"));
            }
        }
        for plugin in &settings.plugins {
            safe_relative(&plugin.entry)?;
            if !valid_name(&plugin.id)
                || !ids.insert(plugin.id.clone())
                || !plugin.options.is_object()
            {
                return Err(config_error("本地插件记录无效，原数据已保留"));
            }
        }
        Ok(settings)
    }
    fn bundle(&self) -> Result<Bundle, AppError> {
        absolute_owned(&self.bundled_root.join("manifest.json"))?;
        let bundle: Bundle = read_json(&self.bundled_root.join("manifest.json"))?;
        if bundle.version != 1
            || bundle.source_revision.len() != 40
            || !bundle
                .source_revision
                .bytes()
                .all(|c| c.is_ascii_hexdigit())
        {
            return Err(config_error("内置技能资源版本无效，请安装完整 LoliCode"));
        }
        let mut ids = BTreeSet::new();
        let mut directories = BTreeSet::new();
        for skill in &bundle.skills {
            if !valid_name(&skill.id)
                || !valid_name(&skill.directory)
                || !ids.insert(&skill.id)
                || !directories.insert(&skill.directory)
            {
                return Err(config_error("内置技能资源目录无效"));
            }
            let mut paths = BTreeSet::new();
            for file in &skill.files {
                safe_relative(&file.path)?;
                if file.sha256.len() != 64
                    || !file.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                    || !paths.insert(&file.path)
                {
                    return Err(config_error("内置技能文件清单无效"));
                }
            }
        }
        Ok(bundle)
    }
    fn ensure_root(&self) -> Result<(), AppError> {
        absolute_owned(&self.root)?;
        fs::create_dir_all(&self.root).map_err(|e| io(&self.root, e))?;
        let marker = self.root.join(OWNER_FILE);
        if marker.exists() {
            if fs::read_to_string(&marker).map_err(|e| io(&marker, e))? != OWNER {
                return Err(config_error("扩展目录已被其它数据使用，原目录已保留"));
            }
        } else {
            if fs::read_dir(&self.root)
                .map_err(|e| io(&self.root, e))?
                .next()
                .is_some()
            {
                return Err(config_error("扩展目录缺少归属标记，原目录已保留"));
            }
            atomic_write_private(&marker, OWNER.as_bytes())?;
        }
        Ok(())
    }
    fn catalog_with(&self, settings: &Settings) -> Result<AgentExtensionsCatalog, AppError> {
        let bundle = self.bundle()?;
        let mut skills = Vec::new();
        for skill in bundle.skills {
            let (name, description) = skill_metadata(
                &self
                    .bundled_root
                    .join("skills")
                    .join(&skill.directory)
                    .join("SKILL.md"),
            )?;
            let installed = !settings.removed_bundled.contains(&skill.id);
            skills.push(AgentSkillEntry {
                id: skill.id.clone(),
                name,
                description,
                source: "bundled".into(),
                installed,
                enabled: installed && !settings.disabled_bundled.contains(&skill.id),
                license: Some(skill.license),
                source_url: Some(skill.source_url),
                requirements: skill.requirements,
            });
        }
        skills.extend(settings.skills.iter().map(|skill| AgentSkillEntry {
            id: skill.id.clone(),
            name: skill.name.clone(),
            description: skill.description.clone(),
            source: "local".into(),
            installed: true,
            enabled: skill.enabled,
            license: None,
            source_url: None,
            requirements: Vec::new(),
        }));
        let plugins = settings
            .plugins
            .iter()
            .map(|plugin| AgentPluginEntry {
                id: plugin.id.clone(),
                name: plugin.name.clone(),
                entry: plugin.entry.clone(),
                source: "local".into(),
                enabled: plugin.enabled,
            })
            .collect();
        let mcp_servers = settings.mcp["servers"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(id, server)| AgentMcpEntry {
                id: id.clone(),
                server_type: server["type"].as_str().unwrap_or_default().into(),
                enabled: server["disabled"] != true,
            })
            .collect();
        Ok(AgentExtensionsCatalog {
            revision: settings.revision,
            skills,
            plugins,
            mcp_servers,
        })
    }
    pub fn list(&self) -> Result<AgentExtensionsCatalog, AppError> {
        let _guard = operation_lock().lock()?;
        self.catalog_with(&self.settings()?)
    }
    pub fn config(&self) -> Result<AgentExtensionConfig, AppError> {
        let _guard = operation_lock().lock()?;
        let settings = self.settings()?;
        let mut mcp = settings.mcp;
        mask_value(&mut mcp, None);
        let mut plugin_options = BTreeMap::new();
        for plugin in settings.plugins {
            let mut options = plugin.options;
            mask_plugin_options(&mut options);
            plugin_options.insert(plugin.id, options);
        }
        Ok(AgentExtensionConfig {
            revision: settings.revision,
            mcp,
            plugin_options,
        })
    }
    fn change(
        &self,
        operation: impl FnOnce(&mut Settings) -> Result<(), AppError>,
    ) -> Result<AgentExtensionsCatalog, AppError> {
        let _guard = operation_lock().lock()?;
        self.ensure_root()?;
        let mut settings = self.settings()?;
        operation(&mut settings)?;
        settings.revision = settings
            .revision
            .checked_add(1)
            .ok_or_else(|| config_error("扩展版本已超出范围"))?;
        let catalog = self.catalog_with(&settings)?;
        atomic_write_private(&self.root.join(SETTINGS_FILE), &json_bytes(&settings)?)?;
        Ok(catalog)
    }
    pub fn set_skill_enabled(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<AgentExtensionsCatalog, AppError> {
        let bundled = self.bundle()?.skills.iter().any(|skill| skill.id == id);
        self.change(|settings| {
            if bundled {
                settings.removed_bundled.remove(id);
                if enabled {
                    settings.disabled_bundled.remove(id);
                } else {
                    settings.disabled_bundled.insert(id.into());
                }
            } else if let Some(skill) = settings.skills.iter_mut().find(|skill| skill.id == id) {
                skill.enabled = enabled;
            } else {
                return Err(input("此技能不存在"));
            }
            Ok(())
        })
    }
    pub fn import_skill(&self, source: &Path) -> Result<AgentExtensionsCatalog, AppError> {
        if !source.is_absolute() || !source.is_dir() {
            return Err(input("请选择包含 SKILL.md 的本地技能目录"));
        }
        let (name, description) = skill_metadata(&source.join("SKILL.md"))?;
        let id = format!("local-{}", uuid::Uuid::new_v4().simple());
        self.change(|settings| {
            if self
                .catalog_with(settings)?
                .skills
                .iter()
                .any(|skill| skill.name == name)
            {
                return Err(input("技能名称已存在，请先修改导入技能的 name"));
            }
            let target = self.root.join("skills").join(&id);
            copy_tree(source, &target)?;
            settings.skills.push(StoredSkill {
                id,
                name,
                description,
                enabled: true,
            });
            Ok(())
        })
    }
    pub fn remove_skill(&self, id: &str) -> Result<AgentExtensionsCatalog, AppError> {
        let bundled = self.bundle()?.skills.iter().any(|skill| skill.id == id);
        let catalog = self.change(|settings| {
            if bundled {
                settings.removed_bundled.insert(id.into());
                settings.disabled_bundled.remove(id);
            } else if let Some(index) = settings.skills.iter().position(|skill| skill.id == id) {
                settings.skills.remove(index);
            } else {
                return Err(input("此技能不存在"));
            }
            Ok(())
        })?;
        if !bundled {
            self.retire_asset("skills", id)?;
        }
        Ok(catalog)
    }
    pub fn install_plugin(&self, source: &Path) -> Result<AgentExtensionsCatalog, AppError> {
        if !source.is_absolute() {
            return Err(input("请选择本地 OpenCode v2 插件文件或目录"));
        }
        let (entry, name) = plugin_entry(source)?;
        let id = format!("plugin-{}", uuid::Uuid::new_v4().simple());
        self.change(|settings| {
            let target = self.root.join("plugins").join(&id);
            if source.is_dir() {
                copy_tree(source, &target)?;
            } else {
                fs::create_dir_all(&target).map_err(|e| io(&target, e))?;
                copy_tree(source, &target.join(&entry))?;
            }
            settings.plugins.push(StoredPlugin {
                id,
                name,
                entry,
                enabled: true,
                options: json!({}),
            });
            Ok(())
        })
    }
    pub fn set_plugin_enabled(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<AgentExtensionsCatalog, AppError> {
        self.change(|settings| {
            let plugin = settings
                .plugins
                .iter_mut()
                .find(|plugin| plugin.id == id)
                .ok_or_else(|| input("此插件不存在"))?;
            plugin.enabled = enabled;
            Ok(())
        })
    }
    pub fn uninstall_plugin(&self, id: &str) -> Result<AgentExtensionsCatalog, AppError> {
        let catalog = self.change(|settings| {
            let index = settings
                .plugins
                .iter()
                .position(|plugin| plugin.id == id)
                .ok_or_else(|| input("此插件不存在"))?;
            settings.plugins.remove(index);
            Ok(())
        })?;
        self.retire_asset("plugins", id)?;
        Ok(catalog)
    }
    // Removing an extension detaches its installed copy. Retain it in owned
    // trash for recovery; prior running engines have independent catalog copies.
    fn retire_asset(&self, kind: &str, id: &str) -> Result<(), AppError> {
        let _guard = operation_lock().lock()?;
        if !valid_name(id) {
            return Err(input("扩展标识无效"));
        }
        let source = self.root.join(kind).join(id);
        absolute_owned(&source)?;
        if source.exists() {
            let trash = self.root.join("trash");
            absolute_owned(&trash)?;
            fs::create_dir_all(&trash).map_err(|e| io(&trash, e))?;
            let target = trash.join(format!("{id}-{}", uuid::Uuid::new_v4().simple()));
            fs::rename(&source, &target).map_err(|e| io(&source, e))?;
        }
        Ok(())
    }
    pub fn save_config(
        &self,
        mut next: AgentExtensionConfig,
    ) -> Result<AgentExtensionsCatalog, AppError> {
        self.change(|settings| {
            if settings.revision != next.revision {
                return Err(AppError::Conflict(
                    "扩展配置已在另一处变化，请重新加载后保存".into(),
                ));
            }
            restore_hidden(&mut next.mcp, &settings.mcp)?;
            validate_mcp(&next.mcp)?;
            for (id, options) in &mut next.plugin_options {
                let plugin = settings
                    .plugins
                    .iter_mut()
                    .find(|plugin| plugin.id == *id)
                    .ok_or_else(|| input("配置引用了未安装插件"))?;
                if !options.is_object() {
                    return Err(input("插件 options 必须是 JSON 对象"));
                }
                restore_hidden(options, &plugin.options)?;
                plugin.options = options.clone();
            }
            settings.mcp = next.mcp;
            Ok(())
        })
    }
    /// Build an immutable, engine-owned mount. Caller restarts only its idle
    /// private engine; active sessions keep their already-mounted revision.
    #[cfg(any(test, feature = "test-hooks"))]
    pub fn project_runtime(
        &self,
        private_root: &Path,
        config: &mut Value,
    ) -> Result<u64, AppError> {
        let _guard = operation_lock().lock()?;
        absolute_owned(private_root)?;
        if !config.is_object() {
            return Err(input("引擎配置必须是对象"));
        }
        let settings = self.settings()?;
        let bundle = self.bundle()?;
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                [
                    PROJECTION_VERSION.to_vec(),
                    json_bytes(&settings)?,
                    fs::read(self.bundled_root.join("manifest.json"))
                        .map_err(|e| io(&self.bundled_root, e))?
                ]
                .concat()
            )
        );
        let catalog = private_root.join("extensions/catalogs").join(format!(
            "{}-{}",
            settings.revision,
            &fingerprint[..16]
        ));
        let marker = catalog.join(".prepared");
        absolute_owned(&catalog)?;
        if !marker.exists() {
            fs::create_dir_all(&catalog).map_err(|e| io(&catalog, e))?;
            for skill in &bundle.skills {
                if settings.disabled_bundled.contains(&skill.id)
                    || settings.removed_bundled.contains(&skill.id)
                {
                    continue;
                }
                let prefix = format!("skills/{}/", skill.directory);
                for file in &skill.files {
                    let relative = safe_relative(&file.path)?;
                    let source = self.bundled_root.join(relative);
                    absolute_owned(&source)?;
                    let bytes = fs::read(&source).map_err(|e| io(&source, e))?;
                    if format!("{:x}", Sha256::digest(&bytes)) != file.sha256 {
                        return Err(config_error("内置技能资源校验失败，请重新准备或安装应用"));
                    }
                    let suffix = file
                        .path
                        .strip_prefix(&prefix)
                        .ok_or_else(|| config_error("内置技能资源路径不属于此技能"))?;
                    let target = catalog
                        .join("skills")
                        .join(&skill.directory)
                        .join(safe_relative(suffix)?);
                    absolute_owned(&target)?;
                    fs::create_dir_all(
                        target
                            .parent()
                            .ok_or_else(|| config_error("技能资源路径无效"))?,
                    )
                    .map_err(|e| io(&target, e))?;
                    fs::write(&target, bytes).map_err(|e| io(&target, e))?;
                }
            }
            for skill in settings.skills.iter().filter(|skill| skill.enabled) {
                copy_tree(
                    &self.root.join("skills").join(&skill.id),
                    &catalog.join("skills").join(&skill.name),
                )?;
            }
            for plugin in settings.plugins.iter().filter(|plugin| plugin.enabled) {
                let plugin_root = catalog.join("plugins").join(&plugin.id);
                copy_tree(
                    &self.root.join("plugins").join(&plugin.id),
                    &plugin_root.join("source"),
                )?;
                // v2 configured sources must be directories. Its Host.resolve
                // looks for server/index entrypoints, not an arbitrary file URL.
                atomic_write_private(
                    &plugin_root.join("package.json"),
                    b"{\"type\":\"module\",\"private\":true}\n",
                )?;
                let import = serde_json::to_string(&format!("./source/{}", plugin.entry))
                    .map_err(|source| AppError::JsonSerialize { source })?;
                atomic_write_private(
                    &plugin_root.join("index.js"),
                    format!("export {{ default }} from {import};\n").as_bytes(),
                )?;
            }
            atomic_write_private(&marker, fingerprint.as_bytes())?;
        } else if fs::read_to_string(&marker).map_err(|e| io(&marker, e))? != fingerprint {
            return Err(config_error("此私有扩展版本已被不同内容占用"));
        }
        let mut skills = Vec::new();
        for skill in &bundle.skills {
            if !settings.disabled_bundled.contains(&skill.id)
                && !settings.removed_bundled.contains(&skill.id)
            {
                skills.push(
                    catalog
                        .join("skills")
                        .join(&skill.directory)
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        for skill in settings.skills.iter().filter(|skill| skill.enabled) {
            skills.push(
                catalog
                    .join("skills")
                    .join(&skill.name)
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        config["skills"] = json!(skills);
        let mut plugins = Vec::new();
        for plugin in settings.plugins.iter().filter(|plugin| plugin.enabled) {
            let entry = catalog.join("plugins").join(&plugin.id);
            let package = url::Url::from_file_path(&entry)
                .map_err(|_| config_error("本地插件路径无法转换"))?
                .to_string();
            plugins.push(json!({"package":package,"options":plugin.options}));
        }
        config["plugins"] = Value::Array(plugins);
        config["mcp"] = settings.mcp;
        Ok(settings.revision)
    }
}

fn plugin_entry(source: &Path) -> Result<(String, String), AppError> {
    let metadata = fs::symlink_metadata(source).map_err(|e| io(source, e))?;
    if link(&metadata) {
        return Err(input("插件来源不能是符号链接或目录联接"));
    }
    if metadata.is_file() {
        if !matches!(
            source.extension().and_then(|ext| ext.to_str()),
            Some("js" | "mjs" | "ts")
        ) {
            return Err(input("请选择 OpenCode v2 的 JS/MJS/TS 插件"));
        }
        let entry = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| input("插件文件名无效"))?;
        safe_relative(entry)?;
        return Ok((
            entry.into(),
            source
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("Local plugin")
                .into(),
        ));
    }
    if !metadata.is_dir() {
        return Err(input("插件来源必须是普通文件或目录"));
    }
    if source.join(".zcode-plugin/plugin.json").exists() {
        return Err(input(
            "ZCode 插件清单不是 OpenCode v2 引擎插件；请将技能或 MCP 服务分别导入",
        ));
    }
    let manifest = source.join("package.json");
    let package: Value = if manifest.exists() {
        read_json(&manifest)?
    } else {
        json!({})
    };
    let candidate = package["exports"]
        .as_str()
        .or_else(|| package["exports"]["."].as_str())
        .or_else(|| package["module"].as_str())
        .or_else(|| package["main"].as_str());
    let entry = if let Some(candidate) = candidate {
        candidate.trim_start_matches("./").to_string()
    } else {
        ["index.mjs", "index.js", "index.ts"]
            .iter()
            .find(|name| source.join(name).is_file())
            .ok_or_else(|| input("插件目录缺少本地 JS/MJS/TS 入口"))?
            .to_string()
    };
    safe_relative(&entry)?;
    if !source.join(&entry).is_file()
        || !matches!(
            Path::new(&entry).extension().and_then(|ext| ext.to_str()),
            Some("js" | "mjs" | "ts")
        )
    {
        return Err(input("插件入口不存在或不是 JS/MJS/TS"));
    }
    Ok((
        entry,
        package["name"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                source
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, AgentExtensionStore) {
        let temp = TempDir::new().unwrap();
        let bundle = temp.path().join("bundle");
        fs::create_dir_all(bundle.join("skills/test-bundled")).unwrap();
        let content = b"---\nname: test-bundled\ndescription: Bundled fixture skill.\n---\nUse this fixture.\n";
        fs::write(bundle.join("skills/test-bundled/SKILL.md"), content).unwrap();
        fs::write(bundle.join("manifest.json"), json!({"version":1,"sourceRevision":"aac4755666d09fdcd70272fcf063c077a639015f","skills":[{"id":"zcode-test","directory":"test-bundled","license":"MIT","sourceUrl":"https://github.com/zai-org/ZCode","files":[{"path":"skills/test-bundled/SKILL.md","sha256":format!("{:x}",Sha256::digest(content))}]}]}).to_string()).unwrap();
        let store = AgentExtensionStore::new(temp.path().join("store"), bundle).unwrap();
        (temp, store)
    }

    #[test]
    fn agent_extensions_listing_is_read_only_and_defaults_are_mounted() {
        let (temp, store) = fixture();
        assert!(store.list().unwrap().skills[0].enabled);
        assert!(!store.root.exists());
        let mut config = json!({"providers":{"fixture":{}},"model":"fixture/test"});
        assert_eq!(
            store
                .project_runtime(&temp.path().join("runtime"), &mut config)
                .unwrap(),
            0
        );
        let skill = PathBuf::from(config["skills"][0].as_str().unwrap());
        assert!(skill.join("SKILL.md").is_file());
        assert_eq!(config["model"], "fixture/test");
        assert!(!store.root.exists());
    }

    #[test]
    fn agent_extensions_disable_preserves_old_immutable_mount() {
        let (temp, store) = fixture();
        let runtime = temp.path().join("runtime");
        let mut before = json!({});
        store.project_runtime(&runtime, &mut before).unwrap();
        let original = PathBuf::from(before["skills"][0].as_str().unwrap());
        assert_eq!(
            store
                .set_skill_enabled("zcode-test", false)
                .unwrap()
                .revision,
            1
        );
        let mut after = json!({});
        store.project_runtime(&runtime, &mut after).unwrap();
        assert_eq!(after["skills"], json!([]));
        assert!(original.join("SKILL.md").is_file());
        store.remove_skill("zcode-test").unwrap();
        assert!(!store.list().unwrap().skills[0].installed);
        store.set_skill_enabled("zcode-test", true).unwrap();
        assert!(store.list().unwrap().skills[0].enabled);
    }

    #[test]
    fn agent_extensions_local_import_and_removal_keep_original_source() {
        let (temp, store) = fixture();
        let source = temp.path().join("import");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: imported\ndescription: Real imported skill.\n---\nBody\n",
        )
        .unwrap();
        fs::write(source.join("asset.txt"), "asset").unwrap();
        let catalog = store.import_skill(&source).unwrap();
        let local = catalog.skills.iter().find(|s| s.source == "local").unwrap();
        let id = local.id.clone();
        assert!(store
            .root
            .join("skills")
            .join(&id)
            .join("asset.txt")
            .is_file());
        assert!(store.import_skill(&source).is_err());
        store.remove_skill(&id).unwrap();
        assert!(!store.root.join("skills").join(&id).exists());
        assert!(source.join("SKILL.md").is_file());
        assert!(store
            .root
            .join("trash")
            .read_dir()
            .unwrap()
            .next()
            .is_some());
    }

    #[test]
    fn agent_extensions_plugin_projection_uses_v2_file_package() {
        let (temp, store) = fixture();
        let source = temp.path().join("fixture.mjs");
        fs::write(&source, "export default {id:'fixture',async setup(){}};").unwrap();
        let entry = store.install_plugin(&source).unwrap().plugins.remove(0);
        let mut config = json!({});
        store
            .project_runtime(&temp.path().join("runtime"), &mut config)
            .unwrap();
        let url = url::Url::parse(config["plugins"][0]["package"].as_str().unwrap()).unwrap();
        assert_eq!(url.scheme(), "file");
        let package = url.to_file_path().unwrap();
        assert!(package.join("index.js").is_file());
        assert!(package.join("source/fixture.mjs").is_file());
        assert_eq!(config["plugins"][0]["options"], json!({}));
        store.set_plugin_enabled(&entry.id, false).unwrap();
        let mut disabled = json!({});
        store
            .project_runtime(&temp.path().join("runtime"), &mut disabled)
            .unwrap();
        assert_eq!(disabled["plugins"], json!([]));
        store.uninstall_plugin(&entry.id).unwrap();
        assert!(store.list().unwrap().plugins.is_empty());
        assert!(source.is_file());
        let incompatible = temp.path().join("zcode");
        fs::create_dir_all(incompatible.join(".zcode-plugin")).unwrap();
        fs::write(incompatible.join(".zcode-plugin/plugin.json"), "{}").unwrap();
        assert!(store.install_plugin(&incompatible).is_err());
    }

    #[test]
    fn agent_extensions_mcp_secret_placeholders_roundtrip_without_renderer_leak() {
        let (temp, store) = fixture();
        let raw = json!({"servers":{"fixture":{"type":"local","command":["node","server.mjs","--token","test-secret-123"],"environment":{"UNUSUAL_CREDENTIAL":"env-secret-456"}},"remote":{"type":"remote","url":"http://127.0.0.1:1234/mcp","headers":{"Authorization":"Bearer secret-789","X-Arbitrary":"opaque-secret"}}}});
        store
            .save_config(AgentExtensionConfig {
                revision: 0,
                mcp: raw.clone(),
                plugin_options: BTreeMap::new(),
            })
            .unwrap();
        let safe = store.config().unwrap();
        let serialized = serde_json::to_string(&safe).unwrap();
        for secret in [
            "test-secret-123",
            "env-secret-456",
            "secret-789",
            "opaque-secret",
        ] {
            assert!(!serialized.contains(secret));
        }
        store.save_config(safe).unwrap();
        let mut config = json!({});
        store
            .project_runtime(&temp.path().join("runtime"), &mut config)
            .unwrap();
        assert_eq!(config["mcp"], raw);
        let stale = AgentExtensionConfig {
            revision: 0,
            mcp: empty_mcp(),
            plugin_options: BTreeMap::new(),
        };
        assert!(store.save_config(stale).is_err());
        let mut invalid = store.config().unwrap();
        invalid.mcp["servers"]["new"] = json!({"type":"remote","url":"https://example.com/mcp","headers":{"Authorization":HIDDEN}});
        assert!(store.save_config(invalid).is_err());
    }

    #[test]
    fn agent_extensions_rejects_corrupt_settings_and_bundle_without_overwrite() {
        let (temp, store) = fixture();
        store.set_skill_enabled("zcode-test", false).unwrap();
        let path = store.root.join(SETTINGS_FILE);
        fs::write(&path, "not json").unwrap();
        assert!(store.list().is_err());
        assert!(store.set_skill_enabled("zcode-test", true).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "not json");
        let (_other_temp, other) = fixture();
        fs::write(
            other.bundled_root.join("skills/test-bundled/SKILL.md"),
            "changed",
        )
        .unwrap();
        assert!(other
            .project_runtime(&temp.path().join("bad-runtime"), &mut json!({}))
            .is_err());
    }

    #[test]
    fn agent_extensions_import_rejects_self_copy_traversal_and_deep_trees() {
        let (temp, store) = fixture();
        assert!(safe_relative("../escape").is_err());
        assert!(safe_relative("C:/escape").is_err());
        assert!(copy_tree(temp.path(), &temp.path().join("descendant")).is_err());
        let source = temp.path().join("deep");
        fs::create_dir(&source).unwrap();
        let mut path = source.clone();
        for _ in 0..50 {
            path = path.join("a");
            fs::create_dir(&path).unwrap();
        }
        assert!(copy_tree(&source, &store.root.join("copy")).is_err());
    }
}
