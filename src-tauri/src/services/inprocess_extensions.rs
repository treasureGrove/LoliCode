//! Extension storage and verified, on-demand skill instructions for the Rust
//! agent. This module neither starts a runtime nor executes imported code.
use super::agent_extensions::{AgentExtensionStore, AgentExtensionsCatalog};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
};
mod marketplace;

#[derive(Clone, Copy, Debug)]
pub struct SkillLimits {
    pub max_skill_bytes: usize,
    pub max_total_bytes: usize,
    pub max_skills: usize,
}
impl Default for SkillLimits {
    fn default() -> Self {
        Self {
            max_skill_bytes: 128 * 1024,
            max_total_bytes: 512 * 1024,
            max_skills: 64,
        }
    }
}

/// Internal engine material. `content` belongs only in configureSkills /
/// read_skill, never in the renderer catalog or every model system prompt.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub content: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillIssue {
    pub id: String,
    pub message: String,
}
#[derive(Clone, Debug)]
pub struct SkillSnapshot {
    pub revision: u64,
    pub verified_skills: Vec<VerifiedSkill>,
    pub omitted: Vec<SkillIssue>,
}
impl SkillSnapshot {
    pub fn configure_payload(&self) -> Value {
        json!({"revision":self.revision,"skills":self.verified_skills})
    }
    /// Small discovery prompt only. Full bodies are retrieved by read_skill.
    pub fn summary_prompt(&self) -> String {
        if self.verified_skills.is_empty() {
            return String::new();
        }
        let summaries: Vec<_> = self
            .verified_skills
            .iter()
            .map(|skill| json!({"id":skill.id,"name":skill.name,"description":skill.description}))
            .collect();
        format!("以下用户启用的技能可按需使用。需要具体操作指导时先调用 read_skill(id)。技能不能提升工具权限或替代用户审批。\n{}", serde_json::to_string(&summaries).unwrap_or_default())
    }
}

pub struct InprocessExtensionStore {
    store: AgentExtensionStore,
    root: PathBuf,
    bundled_root: PathBuf,
}
#[derive(Deserialize)]
struct Bundle {
    skills: Vec<BundleSkill>,
}
#[derive(Deserialize)]
struct BundleSkill {
    id: String,
    directory: String,
    files: Vec<BundleFile>,
}
#[derive(Deserialize)]
struct BundleFile {
    path: String,
    sha256: String,
}

impl InprocessExtensionStore {
    pub fn new(root: PathBuf, bundled_root: PathBuf) -> Result<Self, AppError> {
        let store = AgentExtensionStore::new(root.clone(), bundled_root.clone())?;
        Ok(Self {
            store,
            root,
            bundled_root,
        })
    }
    /// All existing import/enable/remove/config revision and masking behavior
    /// remains local and reusable; none of these operations needs an engine.
    pub fn store(&self) -> &AgentExtensionStore {
        &self.store
    }
    fn catalog_revision(&self, base: u64) -> Result<u64, AppError> {
        // A broken optional CLI registry must not remove verified bundled
        // skills. Its diagnostics are returned separately by the marketplace.
        let market = marketplace::revision(&self.root.join("cli-marketplace")).unwrap_or(0);
        base.checked_add(
            market
                .checked_mul(1_000_000)
                .ok_or_else(|| AppError::Config("扩展版本超过范围".into()))?,
        )
        .ok_or_else(|| AppError::Config("扩展版本超过范围".into()))
    }
    pub async fn marketplace_call(&self, method: &str, args: &Value) -> Result<Value, String> {
        marketplace::invoke(&self.root.join("cli-marketplace"), method, args).await
    }

    pub fn prepare_skills(&self) -> Result<SkillSnapshot, AppError> {
        self.prepare_skills_with_limits(SkillLimits::default())
    }
    pub fn prepare_skills_with_limits(
        &self,
        limits: SkillLimits,
    ) -> Result<SkillSnapshot, AppError> {
        if limits.max_skill_bytes > 512 * 1024
            || limits.max_total_bytes > 1024 * 1024
            || limits.max_skills > 64
        {
            return Err(AppError::InvalidInput("技能读取限制超过允许范围".into()));
        }
        // A concurrent settings edit must not combine two enablement revisions.
        for _ in 0..3 {
            let catalog = self.store.list()?;
            let result = self.prepare_catalog(&catalog, limits)?;
            if self.catalog_revision(self.store.list()?.revision)? == result.revision {
                return Ok(result);
            }
        }
        Err(AppError::Conflict(
            "技能配置已变化，请重新读取技能目录".into(),
        ))
    }
    fn prepare_catalog(
        &self,
        catalog: &AgentExtensionsCatalog,
        limits: SkillLimits,
    ) -> Result<SkillSnapshot, AppError> {
        // AgentExtensionStore.list has already validated the manifest schema.
        // Read only its paths/hashes here; do not project an OpenCode config or
        // copy/execute plugins just to make skills available.
        let bytes = bounded_file(
            &self.bundled_root.join("manifest.json"),
            &self.bundled_root,
            16 * 1024 * 1024,
        )
        .map_err(|message| AppError::Config(format!("内置技能清单不可用：{message}")))?;
        let bundle: Bundle = serde_json::from_slice(&bytes)
            .map_err(|_| AppError::Config("内置技能清单无法解析".into()))?;
        let bundled: BTreeMap<_, _> = bundle
            .skills
            .into_iter()
            .map(|skill| (skill.id.clone(), skill))
            .collect();
        let mut snapshot = SkillSnapshot {
            revision: self.catalog_revision(catalog.revision)?,
            verified_skills: vec![],
            omitted: vec![],
        };
        let mut total = 0usize;
        for skill in catalog
            .skills
            .iter()
            .filter(|skill| skill.installed && skill.enabled)
        {
            let result = (|| -> Result<String, String> {
                if snapshot.verified_skills.len() >= limits.max_skills {
                    return Err("已达到本轮可用技能数量上限".into());
                }
                let (file, base, expected) = if skill.source == "bundled" {
                    let source = bundled.get(&skill.id).ok_or("内置技能记录缺失")?;
                    if !safe_component(&source.directory) {
                        return Err("内置技能目录无效".into());
                    }
                    let relative = format!("skills/{}/SKILL.md", source.directory);
                    let hash = source
                        .files
                        .iter()
                        .find(|file| file.path == relative)
                        .ok_or("内置技能清单缺少 SKILL.md")?;
                    (
                        self.bundled_root.join(relative),
                        &self.bundled_root,
                        Some(hash.sha256.as_str()),
                    )
                } else if skill.source == "local" && safe_component(&skill.id) {
                    (
                        self.root.join("skills").join(&skill.id).join("SKILL.md"),
                        &self.root,
                        None,
                    )
                } else {
                    return Err("技能来源无效".into());
                };
                let bytes = bounded_file(&file, base, limits.max_skill_bytes)?;
                if let Some(expected) = expected {
                    if format!("{:x}", Sha256::digest(&bytes)) != expected {
                        return Err("内置技能校验失败，请重新安装完整资源".into());
                    }
                }
                if total
                    .checked_add(bytes.len())
                    .is_none_or(|size| size > limits.max_total_bytes)
                {
                    return Err("已达到本轮技能正文总量上限".into());
                }
                let text = String::from_utf8(bytes).map_err(|_| "SKILL.md 必须使用 UTF-8")?;
                let normalized = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
                let frontmatter = normalized
                    .strip_prefix("---\n")
                    .and_then(|body| body.split_once("\n---").map(|parts| parts.0))
                    .ok_or("技能 frontmatter 无效")?;
                let metadata: serde_yaml::Value =
                    serde_yaml::from_str(frontmatter).map_err(|_| "技能 frontmatter 无法解析")?;
                if metadata["name"].as_str() != Some(skill.name.as_str()) {
                    return Err("技能名称与已保存目录不一致，请重新导入".into());
                }
                Ok(text)
            })();
            match result {
                Ok(content) => {
                    total += content.len();
                    snapshot.verified_skills.push(VerifiedSkill {
                        id: skill.id.clone(),
                        name: skill.name.clone(),
                        // Discovery text stays small even when a local skill
                        // uses a very long YAML description. Its actual body
                        // remains complete for the explicit read_skill call.
                        description: skill.description.chars().take(512).collect(),
                        content,
                    });
                }
                Err(message) => snapshot.omitted.push(SkillIssue {
                    id: skill.id.clone(),
                    message,
                }),
            }
        }
        let (cli_skills, cli_issues) =
            marketplace::skills(&self.root.join("cli-marketplace")).map_err(AppError::Config)?;
        snapshot.omitted.extend(cli_issues);
        for skill in cli_skills {
            if snapshot.verified_skills.len() >= limits.max_skills
                || total.saturating_add(skill.content.len()) > limits.max_total_bytes
            {
                snapshot.omitted.push(SkillIssue {
                    id: skill.id,
                    message: "当前模型技能目录达到预算上限，请停用暂不使用的插件".into(),
                });
            } else {
                total += skill.content.len();
                snapshot.verified_skills.push(skill);
            }
        }
        Ok(snapshot)
    }

    /// `active` is the registry actually configured in the in-process engine;
    /// `loaded_ids` must come from successful read_skill executions. Preparing
    /// a snapshot alone does not mean any full skill body reached the model.
    pub fn catalog(
        &self,
        active: Option<&SkillSnapshot>,
        loaded_ids: &BTreeSet<String>,
    ) -> Result<Value, AppError> {
        let catalog = self.store.list()?;
        let mut value =
            serde_json::to_value(&catalog).map_err(|source| AppError::JsonSerialize { source })?;
        let revision = self.catalog_revision(catalog.revision)?;
        value["revision"] = json!(revision);
        let pending = active.is_some_and(|snapshot| snapshot.revision != revision);
        let available: BTreeSet<_> = active
            .into_iter()
            .flat_map(|snapshot| &snapshot.verified_skills)
            .map(|skill| skill.id.as_str())
            .collect();
        let (cli_skills, _) =
            marketplace::skills(&self.root.join("cli-marketplace")).map_err(AppError::Config)?;
        if let Some(entries) = value["skills"].as_array_mut() {
            entries.extend(cli_skills.into_iter().map(|skill| json!({"id":skill.id,"name":skill.name,"description":skill.description,"source":"marketplace","installed":true,"enabled":true,"license":"以安装包内上游声明为准","sourceUrl":"https://github.com/zai-org/ZCode","requirements":["安装并登录对应 CLI；首次使用时按需检查"]})));
        }
        for entry in value["skills"].as_array_mut().into_iter().flatten() {
            let id = entry["id"].as_str().unwrap_or_default().to_owned();
            let verified = available.contains(id.as_str());
            let loaded = verified && loaded_ids.contains(&id);
            let issue =
                active.and_then(|snapshot| snapshot.omitted.iter().find(|issue| issue.id == id));
            let status = if pending {
                "pending_reload"
            } else if loaded {
                "loaded"
            } else if entry["enabled"] != true {
                "disabled"
            } else if issue.is_some() {
                "failed"
            } else if verified {
                "available"
            } else {
                "not_loaded"
            };
            entry["loaded"] = json!(loaded);
            entry["runtimeStatus"] = json!(status);
            entry["runtimeId"] = if verified { json!(id) } else { Value::Null };
            entry["error"] = json!(issue.map(|issue| &issue.message));
        }
        for entry in value["plugins"].as_array_mut().into_iter().flatten() {
            entry["loaded"] = json!(false);
            entry["runtimeStatus"] = json!(if entry["enabled"] == true {
                "not_loaded"
            } else {
                "disabled"
            });
            entry["error"] = json!(if entry["enabled"] == true {
                Some("插件配置已保存；当前 Rust 编程循环尚未执行 JS 插件")
            } else {
                None
            });
        }
        for entry in value["mcpServers"].as_array_mut().into_iter().flatten() {
            entry["loaded"] = json!(false);
            entry["runtimeStatus"] = json!(if entry["enabled"] == true {
                "disconnected"
            } else {
                "disabled"
            });
            entry["error"] = json!(if entry["enabled"] == true {
                Some("MCP 配置已保存；当前尚未连接服务器或注册工具")
            } else {
                None
            });
        }
        value["runtimeRevision"] = json!(active.map(|snapshot| snapshot.revision));
        value["runtimeRunning"] = json!(active.is_some());
        value["pendingReload"] = json!(pending);
        value["loadedSkills"] = json!(active.into_iter().flat_map(|snapshot| &snapshot.verified_skills).filter(|skill| loaded_ids.contains(&skill.id)).map(|skill| json!({"id":skill.id,"name":skill.name,"description":skill.description,"autoinvoke":false})).collect::<Vec<_>>());
        value["loadedPlugins"] = json!([]);
        value["loadedMcpServers"] = json!([]);
        value["runtimeStatusError"] = Value::Null;
        Ok(value)
    }
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
fn linked(metadata: &fs::Metadata) -> bool {
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
fn bounded_file(file: &Path, base: &Path, maximum: usize) -> Result<Vec<u8>, String> {
    if !file.is_absolute()
        || file
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("技能路径无效".into());
    }
    for ancestor in file.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| "技能文件不存在或无法读取")?;
        if linked(&metadata) {
            return Err("技能文件不能经过符号链接或目录联接".into());
        }
    }
    let canonical_base = fs::canonicalize(base).map_err(|_| "技能目录无法读取")?;
    let canonical_file = fs::canonicalize(file).map_err(|_| "技能文件无法读取")?;
    if !canonical_file.starts_with(canonical_base) {
        return Err("技能文件超出私有技能目录".into());
    }
    let handle = File::open(file).map_err(|_| "技能文件无法读取")?;
    let metadata = handle.metadata().map_err(|_| "技能文件状态无法读取")?;
    if !metadata.is_file() {
        return Err("技能正文必须是普通文件".into());
    }
    if metadata.len() > maximum as u64 {
        return Err("技能正文超过单文件读取上限".into());
    }
    let mut bytes = Vec::new();
    handle
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "技能文件读取失败")?;
    if bytes.len() > maximum {
        return Err("技能正文超过单文件读取上限".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn skill(name: &str, body: &str) -> String {
        format!("---\nname: {name}\ndescription: {name} fixture.\n---\n{body}\n")
    }
    fn fixture() -> (TempDir, InprocessExtensionStore) {
        let temp = TempDir::new().unwrap();
        let bundle = temp.path().join("bundle");
        fs::create_dir_all(bundle.join("skills/fixture")).unwrap();
        let content = skill("fixture", "WHOLE_BUNDLED_BODY");
        fs::write(bundle.join("skills/fixture/SKILL.md"), &content).unwrap();
        fs::write(bundle.join("manifest.json"),json!({"version":1,"sourceRevision":"aac4755666d09fdcd70272fcf063c077a639015f","skills":[{"id":"bundle-fixture","directory":"fixture","license":"MIT","sourceUrl":"https://github.com/zai-org/ZCode","files":[{"path":"skills/fixture/SKILL.md","sha256":format!("{:x}",Sha256::digest(content.as_bytes()))}]}]}).to_string()).unwrap();
        let store = InprocessExtensionStore::new(temp.path().join("store"), bundle).unwrap();
        (temp, store)
    }
    #[test]
    fn inprocess_extensions_prepare_is_read_only_and_bodies_are_on_demand() {
        let (_temp, store) = fixture();
        let prepared = store.prepare_skills().unwrap();
        assert!(!store.root.exists());
        assert_eq!(prepared.verified_skills.len(), 1);
        assert!(prepared.configure_payload()["skills"][0]["content"]
            .as_str()
            .unwrap()
            .contains("WHOLE_BUNDLED_BODY"));
        assert!(!prepared.summary_prompt().contains("WHOLE_BUNDLED_BODY"));
        let available = store.catalog(Some(&prepared), &BTreeSet::new()).unwrap();
        assert_eq!(available["skills"][0]["loaded"], false);
        assert_eq!(available["skills"][0]["runtimeStatus"], "available");
        assert_eq!(available["loadedSkills"], json!([]));
        let loaded = store
            .catalog(Some(&prepared), &BTreeSet::from(["bundle-fixture".into()]))
            .unwrap();
        assert_eq!(loaded["skills"][0]["loaded"], true);
        assert!(!loaded.to_string().contains("WHOLE_BUNDLED_BODY"));
    }
    #[test]
    fn inprocess_extensions_broken_optional_cli_registry_does_not_disable_bundled_skills() {
        let (_temp, store) = fixture();
        let root = store.root.join("cli-marketplace");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("cli-installed.json"), "{damaged").unwrap();
        let prepared = store.prepare_skills().unwrap();
        assert_eq!(prepared.verified_skills.len(), 1);
        assert_eq!(prepared.verified_skills[0].id, "bundle-fixture");
        assert!(prepared
            .omitted
            .iter()
            .any(|issue| issue.id == "cli-marketplace"));
        assert_eq!(
            fs::read_to_string(root.join("cli-installed.json")).unwrap(),
            "{damaged"
        );
    }
    #[test]
    fn inprocess_extensions_import_enable_and_old_registry_revision_are_real() {
        let (temp, store) = fixture();
        let source = temp.path().join("import");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            skill("local-skill", "LOCAL_COMPLETE_BODY"),
        )
        .unwrap();
        let entry = store
            .store()
            .import_skill(&source)
            .unwrap()
            .skills
            .into_iter()
            .find(|s| s.source == "local")
            .unwrap();
        let before = store.prepare_skills().unwrap();
        assert!(before
            .verified_skills
            .iter()
            .any(|s| s.content.contains("LOCAL_COMPLETE_BODY")));
        store.store().set_skill_enabled(&entry.id, false).unwrap();
        let current = store.prepare_skills().unwrap();
        assert!(current.verified_skills.iter().all(|s| s.id != entry.id));
        assert_eq!(
            store.catalog(Some(&before), &BTreeSet::new()).unwrap()["pendingReload"],
            true
        );
        assert!(source.join("SKILL.md").is_file());
        store.store().remove_skill(&entry.id).unwrap();
        assert!(source.join("SKILL.md").is_file());
    }
    #[test]
    fn inprocess_extensions_limits_never_inject_a_truncated_skill() {
        let (_temp, store) = fixture();
        let limited = store
            .prepare_skills_with_limits(SkillLimits {
                max_skill_bytes: 10,
                max_total_bytes: 100,
                max_skills: 32,
            })
            .unwrap();
        assert!(limited.verified_skills.is_empty());
        assert_eq!(limited.omitted.len(), 1);
        let total = store
            .prepare_skills_with_limits(SkillLimits {
                max_skill_bytes: 1024,
                max_total_bytes: 10,
                max_skills: 32,
            })
            .unwrap();
        assert!(total.verified_skills.is_empty());
        assert_eq!(total.omitted.len(), 1);
        assert!(store
            .prepare_skills_with_limits(SkillLimits {
                max_skill_bytes: 1024 * 1024,
                max_total_bytes: 1024 * 1024,
                max_skills: 32
            })
            .is_err());
    }
    #[test]
    fn inprocess_extensions_discovery_description_is_bounded_but_body_is_complete() {
        let (temp, store) = fixture();
        let source = temp.path().join("verbose");
        fs::create_dir(&source).unwrap();
        let content = format!(
            "---\nname: verbose\ndescription: {}\n---\nFULL_INSTRUCTIONS\n",
            "字".repeat(4000)
        );
        fs::write(source.join("SKILL.md"), &content).unwrap();
        store.store().import_skill(&source).unwrap();
        let snapshot = store.prepare_skills().unwrap();
        let skill = snapshot
            .verified_skills
            .iter()
            .find(|skill| skill.name == "verbose")
            .unwrap();
        assert_eq!(skill.description.chars().count(), 512);
        assert_eq!(skill.content, content);
        assert!(!snapshot.summary_prompt().contains("FULL_INSTRUCTIONS"));
    }
    #[test]
    fn inprocess_extensions_bundled_hash_tampering_is_not_available() {
        let (_temp, store) = fixture();
        fs::write(
            store.bundled_root.join("skills/fixture/SKILL.md"),
            skill("fixture", "TAMPERED_BODY"),
        )
        .unwrap();
        let prepared = store.prepare_skills().unwrap();
        assert!(prepared.verified_skills.is_empty());
        assert!(prepared.omitted[0].message.contains("校验失败"));
        assert_eq!(
            store.catalog(Some(&prepared), &BTreeSet::new()).unwrap()["skills"][0]["runtimeStatus"],
            "failed"
        );
    }
    #[test]
    fn inprocess_extensions_imported_body_replacement_is_rejected_without_overwrite() {
        let (temp, store) = fixture();
        let source = temp.path().join("import");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SKILL.md"), skill("imported", "original")).unwrap();
        let id = store
            .store()
            .import_skill(&source)
            .unwrap()
            .skills
            .into_iter()
            .find(|s| s.source == "local")
            .unwrap()
            .id;
        let target = store.root.join("skills").join(&id).join("SKILL.md");
        fs::write(&target, [0xff, 0xfe, 0x61]).unwrap();
        let result = store.prepare_skills().unwrap();
        assert!(result
            .omitted
            .iter()
            .any(|issue| issue.id == id && issue.message.contains("UTF-8")));
        assert_eq!(fs::read(&target).unwrap(), [0xff, 0xfe, 0x61]);
        fs::remove_file(&target).unwrap();
        fs::create_dir(&target).unwrap();
        assert!(store
            .prepare_skills()
            .unwrap()
            .omitted
            .iter()
            .any(|issue| issue.id == id));
    }
    #[test]
    fn inprocess_extensions_plugins_and_mcp_are_not_reported_as_executed() {
        let (temp, store) = fixture();
        let plugin = temp.path().join("never-run.mjs");
        fs::write(&plugin, "throw new Error('MUST_NOT_EXECUTE');").unwrap();
        store.store().install_plugin(&plugin).unwrap();
        let mut config = store.store().config().unwrap();
        config.mcp = json!({"servers":{"fixture":{"type":"remote","url":"https://example.invalid/mcp","headers":{"Authorization":"private-mcp-fixture"}}}});
        store.store().save_config(config).unwrap();
        let prepared = store.prepare_skills().unwrap();
        let catalog = store.catalog(Some(&prepared), &BTreeSet::new()).unwrap();
        assert_eq!(catalog["plugins"][0]["loaded"], false);
        assert_eq!(catalog["mcpServers"][0]["loaded"], false);
        assert_eq!(catalog["loadedPlugins"], json!([]));
        assert_eq!(catalog["loadedMcpServers"], json!([]));
        assert!(!catalog.to_string().contains("private-mcp-fixture"));
        assert!(!store
            .store()
            .config()
            .unwrap()
            .mcp
            .to_string()
            .contains("private-mcp-fixture"));
    }
    #[test]
    fn inprocess_extensions_bounded_reader_rejects_escape_and_parent_segments() {
        let (temp, store) = fixture();
        let outside = temp.path().join("outside.md");
        fs::write(&outside, "outside").unwrap();
        assert!(bounded_file(&outside, &store.bundled_root, 1024).is_err());
        assert!(bounded_file(
            &store.bundled_root.join("../outside.md"),
            &store.bundled_root,
            1024
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn inprocess_extensions_bounded_reader_rejects_symlinks() {
        let (temp, store) = fixture();
        let outside = temp.path().join("outside.md");
        fs::write(&outside, "outside").unwrap();
        let alias = store.bundled_root.join("alias.md");
        std::os::unix::fs::symlink(&outside, &alias).unwrap();
        assert!(bounded_file(&alias, &store.bundled_root, 1024)
            .unwrap_err()
            .contains("符号链接"));
    }
}
