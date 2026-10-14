use crate::{
    error::AppError,
    services::{
        agent::AgentState,
        agent_extensions::{AgentExtensionConfig, AgentExtensionStore, AgentExtensionsCatalog},
    },
};
use lolicode_agent::{AgentMcpServer, AgentPlugin, AgentSkill};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, State};

/// Stored enablement and the running native registry describe different states.
/// Keep the actual loaded catalog even when a newer saved revision awaits reload.
pub(crate) async fn runtime_catalog(
    agent: &AgentState,
    catalog: AgentExtensionsCatalog,
) -> Result<Value, String> {
    let mut value = serde_json::to_value(&catalog).map_err(|_| "扩展目录编码失败")?;
    let context = agent.runtime_extensions().await;
    let mut skills: Option<Vec<AgentSkill>> = None;
    let mut plugins: Option<Vec<AgentPlugin>> = None;
    let mut mcp: Option<Vec<AgentMcpServer>> = None;
    let mut runtime_revision = None;
    let mut running = false;
    let mut pending_reload = false;
    let mut status_unavailable = false;
    let mut starting = false;
    if let Some((engine, workspace, revision)) = context {
        let project = Path::new(&workspace.path);
        let (mut s, mut p, mut m) = tokio::join!(
            engine.list_skills(project),
            engine.list_plugins(project),
            engine.list_mcp(project)
        );
        // Native location activation runs asynchronously. Its initial empty
        // inventory is not evidence that enabled extensions failed to load.
        let expects_skills = catalog.skills.iter().any(|s| s.enabled);
        let expects_extensions = expects_skills
            || catalog.plugins.iter().any(|p| p.enabled)
            || catalog.mcp_servers.iter().any(|m| m.enabled);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while expects_extensions
            && p.as_ref()
                .is_ok_and(|items| !inventory_ready(items, expects_skills))
            && engine.is_running()
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            (s, p, m) = tokio::join!(
                engine.list_skills(project),
                engine.list_plugins(project),
                engine.list_mcp(project)
            );
        }
        starting = expects_extensions
            && p.as_ref()
                .is_ok_and(|items| !inventory_ready(items, expects_skills));
        running = engine.is_running();
        if running {
            runtime_revision = Some(revision);
            pending_reload = revision != catalog.revision;
            status_unavailable = starting || s.is_err() || p.is_err() || m.is_err();
            if !starting {
                skills = s.ok();
                plugins = p.ok();
                mcp = m.ok();
            }
        }
    }
    for item in value["skills"].as_array_mut().into_iter().flatten() {
        let matched = skills.as_ref().and_then(|items| {
            items
                .iter()
                .find(|s| Some(s.name.as_str()) == item["name"].as_str())
        });
        let loaded = skills.as_ref().map(|_| matched.is_some());
        let status = if matched.is_some() {
            "loaded"
        } else {
            fallback_status(
                running,
                skills.is_some(),
                pending_reload,
                item["enabled"] == true,
            )
        };
        annotate(item, loaded, status);
        item["runtimeId"] = json!(matched.map(|skill| &skill.id));
    }
    for item in value["plugins"].as_array_mut().into_iter().flatten() {
        let matched = plugins
            .as_ref()
            .and_then(|items| items.iter().find(|p| matches_local_plugin(p, item)));
        // Match the owned asset path when the module exports a different ID.
        // With no source/identity match, don't invent a successful load.
        let unmatched_local = matched.is_none()
            && plugins
                .as_ref()
                .is_some_and(|items| items.iter().any(|p| p.source_type == "local"));
        let loaded = if unmatched_local {
            None
        } else {
            plugins
                .as_ref()
                .map(|_| matched.is_some_and(|p| p.status == "active"))
        };
        let status = matched.map(|p| p.status.as_str()).unwrap_or_else(|| {
            if unmatched_local {
                "unknown"
            } else {
                fallback_status(
                    running,
                    plugins.is_some(),
                    pending_reload,
                    item["enabled"] == true,
                )
            }
        });
        annotate(item, loaded, status);
    }
    for item in value["mcpServers"].as_array_mut().into_iter().flatten() {
        let matched = mcp.as_ref().and_then(|items| {
            items
                .iter()
                .find(|m| Some(m.name.as_str()) == item["id"].as_str())
        });
        let loaded = mcp
            .as_ref()
            .map(|_| matched.is_some_and(|m| m.status == "connected"));
        let status = matched.map(|m| m.status.as_str()).unwrap_or_else(|| {
            fallback_status(
                running,
                mcp.is_some(),
                pending_reload,
                item["enabled"] == true,
            )
        });
        annotate(item, loaded, status);
    }
    value["runtimeRevision"] = json!(runtime_revision);
    value["runtimeRunning"] = json!(running);
    value["pendingReload"] = json!(pending_reload);
    value["loadedSkills"] = json!(skills);
    value["loadedPlugins"] = json!(plugins);
    value["loadedMcpServers"] = json!(mcp);
    value["runtimeStatusError"] = if status_unavailable {
        json!(if starting {
            "扩展仍在启动，请稍后重新打开此面板"
        } else {
            "运行中的扩展状态暂时无法读取"
        })
    } else {
        Value::Null
    };
    Ok(value)
}

fn annotate(item: &mut Value, loaded: Option<bool>, status: &str) {
    item["loaded"] = json!(loaded);
    item["runtimeStatus"] = json!(status);
}

fn inventory_ready(plugins: &[AgentPlugin], expects_skills: bool) -> bool {
    if expects_skills {
        return plugins.iter().any(|plugin| {
            plugin.id.as_deref() == Some("opencode.config.skill")
                && matches!(plugin.status.as_str(), "active" | "failed")
        });
    }
    !plugins.is_empty()
}

fn matches_local_plugin(plugin: &AgentPlugin, item: &Value) -> bool {
    if plugin.source_type != "local" {
        return false;
    }
    let (Some(id), Some(entry)) = (item["id"].as_str(), item["entry"].as_str()) else {
        return false;
    };
    if let Some(target) = &plugin.target {
        if target.starts_with("plugins/") {
            let path = Path::new(target);
            let asset = Path::new("plugins").join(id);
            return path.ends_with(asset.join(entry)) || path.ends_with(asset.join("index.js"));
        }
        let Ok(uri) = url::Url::parse(target) else {
            return false;
        };
        let Ok(path) = uri.to_file_path() else {
            return false;
        };
        return path.ends_with(Path::new("plugins").join(id).join(entry));
    }
    plugin.id.as_deref() == Some(id)
}

fn fallback_status(running: bool, verified: bool, pending: bool, enabled: bool) -> &'static str {
    if !running {
        "not_running"
    } else if !verified {
        "unknown"
    } else if pending {
        "pending_reload"
    } else if !enabled {
        "disabled"
    } else {
        "not_loaded"
    }
}

async fn edit(
    app: &AppHandle,
    agent: &AgentState,
    operation: impl FnOnce(&AgentExtensionStore) -> Result<AgentExtensionsCatalog, AppError>
        + Send
        + 'static,
) -> Result<Value, String> {
    let store = agent.extensions(app).await?;
    let catalog =
        tokio::task::spawn_blocking(move || operation(&store).map_err(|error| error.to_string()))
            .await
            .map_err(|_| "扩展操作未完成，请重新加载目录".to_string())??;
    runtime_catalog(agent, catalog).await
}

#[tauri::command]
pub async fn get_agent_extensions(
    app: AppHandle,
    agent: State<'_, AgentState>,
) -> Result<Value, String> {
    edit(&app, agent.inner(), |store| store.list()).await
}

#[tauri::command]
pub async fn set_agent_skill_enabled(
    app: AppHandle,
    agent: State<'_, AgentState>,
    id: String,
    enabled: bool,
) -> Result<Value, String> {
    edit(&app, agent.inner(), move |store| {
        store.set_skill_enabled(&id, enabled)
    })
    .await
}

#[tauri::command]
pub async fn import_agent_skill(
    app: AppHandle,
    agent: State<'_, AgentState>,
    path: String,
) -> Result<Value, String> {
    edit(&app, agent.inner(), move |store| {
        store.import_skill(Path::new(&path))
    })
    .await
}

#[tauri::command]
pub async fn remove_agent_skill(
    app: AppHandle,
    agent: State<'_, AgentState>,
    id: String,
) -> Result<Value, String> {
    edit(&app, agent.inner(), move |store| store.remove_skill(&id)).await
}

#[tauri::command]
pub async fn install_agent_plugin(
    app: AppHandle,
    agent: State<'_, AgentState>,
    path: String,
) -> Result<Value, String> {
    edit(&app, agent.inner(), move |store| {
        store.install_plugin(Path::new(&path))
    })
    .await
}

#[tauri::command]
pub async fn set_agent_plugin_enabled(
    app: AppHandle,
    agent: State<'_, AgentState>,
    id: String,
    enabled: bool,
) -> Result<Value, String> {
    edit(&app, agent.inner(), move |store| {
        store.set_plugin_enabled(&id, enabled)
    })
    .await
}

#[tauri::command]
pub async fn uninstall_agent_plugin(
    app: AppHandle,
    agent: State<'_, AgentState>,
    id: String,
) -> Result<Value, String> {
    edit(&app, agent.inner(), move |store| {
        store.uninstall_plugin(&id)
    })
    .await
}

#[tauri::command]
pub async fn get_agent_extension_config(
    app: AppHandle,
    agent: State<'_, AgentState>,
) -> Result<AgentExtensionConfig, String> {
    let store = agent.extensions(&app).await?;
    tokio::task::spawn_blocking(move || store.config().map_err(|error| error.to_string()))
        .await
        .map_err(|_| "扩展配置读取失败，请重试".to_string())?
}

#[tauri::command]
pub async fn save_agent_extension_config(
    app: AppHandle,
    agent: State<'_, AgentState>,
    config: AgentExtensionConfig,
) -> Result<Value, String> {
    edit(&app, agent.inner(), move |store| store.save_config(config)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_plugin_runtime_match_uses_owned_asset_identity_not_display_name() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary
            .path()
            .join("rev-2/plugins/local-asset/plugin file.mjs");
        let mut plugin = AgentPlugin {
            id: Some("exported.plugin.id".into()),
            source_type: "local".into(),
            target: Some(url::Url::from_file_path(target).unwrap().to_string()),
            version: None,
            server: true,
            tui: false,
            rpc: false,
            status: "active".into(),
            error: None,
        };
        let stored = json!({"id":"local-asset", "entry":"plugin file.mjs"});
        assert!(matches_local_plugin(&plugin, &stored));
        assert!(!matches_local_plugin(
            &plugin,
            &json!({"id":"other-asset", "entry":"plugin file.mjs"})
        ));
        plugin.source_type = "npm".into();
        assert!(!matches_local_plugin(&plugin, &stored));
        plugin.source_type = "local".into();
        plugin.target =
            Some("https://registry.example/plugins/local-asset/plugin%20file.mjs".into());
        assert!(!matches_local_plugin(&plugin, &stored));
        plugin.target = None;
        assert!(!matches_local_plugin(&plugin, &stored));
        plugin.target = Some("plugins/local-asset/plugin file.mjs".into());
        assert!(matches_local_plugin(&plugin, &stored));
        plugin.target = Some("plugins/local-asset/index.js".into());
        assert!(matches_local_plugin(&plugin, &stored));
    }
}
