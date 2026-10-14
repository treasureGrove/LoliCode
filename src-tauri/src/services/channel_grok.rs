//! Publish the channel center's complete Grok model catalog through the existing
//! transactional live writer. User-owned model tables and global options survive.

use crate::database::Database;
use crate::error::AppError;
use crate::live::engine::LiveFile;
use crate::live::patch::toml::TomlPatch;
use crate::live::patch::{Guarded, KeyPath, WholeFile};
use crate::mode::operation::{AppWrite, FileChange};
use crate::mode::state::{self, ModeState, PendingTarget, Written};
use crate::provider::Provider;
use std::collections::HashSet;
use toml_edit::{DocumentMut, Item};

const PREFIX: &str = "tai-channel-";

fn catalog_patch(
    text: &str,
    owned: &[String],
    live: &DocumentMut,
) -> Result<(TomlPatch, Vec<String>), AppError> {
    crate::grok_config::validate_config_toml(text)?;
    let desired = text
        .parse::<DocumentMut>()
        .map_err(|e| AppError::Message(e.to_string()))?;
    let models = desired
        .get("model")
        .and_then(Item::as_table_like)
        .ok_or_else(|| AppError::Message("渠道模型目录缺少模型表".into()))?;
    let default = desired["models"]["default"]
        .as_str()
        .ok_or_else(|| AppError::Message("请选择默认模型".into()))?;
    let owned: HashSet<&str> = owned.iter().map(String::as_str).collect();
    let mut patch = TomlPatch::default();
    let mut names = Vec::new();
    for (name, table) in models.iter() {
        if !name.starts_with(PREFIX) || !table.is_table_like() {
            return Err(AppError::Message("渠道模型目录包含无效的模型表".into()));
        }
        if live.get("model").and_then(|m| m.get(name)).is_some() && !owned.contains(name) {
            return Err(AppError::Message(format!(
                "模型配置 {name} 已由其他配置使用，请先更换名称"
            )));
        }
        // Validate every table, rather than only the selected default.
        let mut check = desired.clone();
        check["models"]["default"] = toml_edit::value(name);
        crate::grok_config::validate_config_toml(&check.to_string())?;
        names.push(name.to_string());
        patch
            .set
            .push((KeyPath(vec!["model".into(), name.into()]), table.clone()));
    }
    for name in owned.iter().filter(|name| name.starts_with(PREFIX)) {
        patch
            .remove
            .push(KeyPath(vec!["model".into(), (*name).into()]));
    }
    patch.set.push((
        KeyPath(vec!["models".into(), "default".into()]),
        toml_edit::value(default),
    ));
    Ok((patch, names))
}

pub fn apply_catalog(db: &Database, provider: &Provider) -> Result<(), AppError> {
    let text = provider
        .settings_config
        .get("config")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AppError::Message("渠道模型目录没有可用配置".into()))?;
    let write = AppWrite::begin(db, "grokbuild")?;
    let file = LiveFile::private(crate::grok_config::get_grok_config_path());
    let bytes = crate::live::engine::read_current(&file.path)?;
    let mut live = crate::live::patch::toml::parse(&file.path, bytes.as_deref())?;
    let owned = state::written(&write.store, "grokbuild")?
        .map(|w| w.tables)
        .unwrap_or_default();
    let (patch, names) = catalog_patch(text, &owned, &live)?;
    patch.apply_to(&file.path, &mut live)?;
    let patch = Guarded {
        expected_pre: crate::live::engine::digest(bytes.as_deref()),
        then: WholeFile::Write(live.to_string().into_bytes()),
    };
    write.run(
        "channel-catalog",
        &[FileChange {
            file,
            patch: &patch,
        }],
        PendingTarget {
            pointer: Some(provider.id.clone()),
            state: Some(ModeState::default()),
            written: Some(Written {
                tables: names,
                ..Written::default()
            }),
            ..PendingTarget::default()
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn source() -> &'static str {
        r#"[models]
default = "tai-channel-a"
[model.tai-channel-a]
model = "channel-a/model-a"
name = "Model A"
base_url = "http://127.0.0.1:15721/tai/v1"
api_key = "local-test-key"
api_backend = "responses"
context_window = 32768
[model.tai-channel-b]
model = "channel-b/model-b"
name = "Model B"
base_url = "http://127.0.0.1:15721/tai/v1"
api_key = "local-test-key"
api_backend = "responses"
context_window = 32768
"#
    }

    #[test]
    fn publishes_all_models_and_preserves_unrelated_tables() {
        let mut live = "# user's options\n[model.personal]\nmodel = 'keep-me'\n[model.tai-channel-old]\nmodel = 'retired'\n".parse::<DocumentMut>().unwrap();
        let (patch, names) = catalog_patch(source(), &["tai-channel-old".into()], &live).unwrap();
        patch.apply_to(Path::new("config.toml"), &mut live).unwrap();
        assert_eq!(names.len(), 2);
        assert_eq!(live["model"]["personal"]["model"].as_str(), Some("keep-me"));
        assert!(live["model"].get("tai-channel-old").is_none());
        assert!(live["model"].get("tai-channel-b").is_some());
        assert!(live.to_string().contains("# user's options"));
    }

    #[test]
    fn refuses_to_overwrite_unowned_name_or_invalid_secondary_model() {
        let live = "[model.tai-channel-a]\nmodel = 'user'\n"
            .parse::<DocumentMut>()
            .unwrap();
        assert!(catalog_patch(source(), &[], &live).is_err());
        let invalid = source().replace("context_window = 32768\n", "context_window = 0\n");
        assert!(catalog_patch(&invalid, &[], &DocumentMut::new()).is_err());
    }
}
