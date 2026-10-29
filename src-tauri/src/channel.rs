//! Build identity is compiled into the executable so shortcuts and the renderer
//! cannot accidentally select a different installation's profile at runtime.

pub fn is_development() -> bool {
    match option_env!("LOLICODE_BUILD_CHANNEL") {
        Some("development") => true,
        Some("stable") => false,
        // Official development commands set the channel explicitly. Ordinary
        // Cargo tests and existing low-level builds keep the stable profile.
        _ => false,
    }
}

pub fn name() -> &'static str {
    if is_development() {
        "LoliCode Dev"
    } else {
        "LoliCode"
    }
}

pub fn development_build_number() -> Option<&'static str> {
    is_development()
        .then_some(option_env!("LOLICODE_BUILD_NUMBER"))
        .flatten()
}

pub fn profile_directory() -> &'static str {
    if is_development() {
        ".lolicode-dev"
    } else {
        ".tai-switch"
    }
}

pub fn default_proxy_port() -> u16 {
    if is_development() {
        15731
    } else {
        15721
    }
}

pub fn credential_service(stable: &str) -> String {
    if is_development() {
        format!("{stable}.dev")
    } else {
        stable.to_string()
    }
}

pub fn require_stable_updates() -> Result<(), String> {
    if is_development() {
        Err("开发版通过本地构建更新，不连接正式版更新通道。".into())
    } else {
        Ok(())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    channel: &'static str,
    app_name: &'static str,
    data_directory: String,
    default_proxy_port: u16,
    development_build_number: Option<&'static str>,
    source_branch: Option<&'static str>,
    source_revision: Option<&'static str>,
    built_at: Option<&'static str>,
    working_tree_dirty: Option<bool>,
}

#[tauri::command]
pub fn get_build_info() -> BuildInfo {
    BuildInfo {
        channel: if is_development() {
            "development"
        } else {
            "stable"
        },
        app_name: name(),
        data_directory: crate::config::get_app_config_dir().display().to_string(),
        default_proxy_port: default_proxy_port(),
        development_build_number: development_build_number(),
        source_branch: is_development()
            .then_some(option_env!("LOLICODE_BUILD_BRANCH"))
            .flatten(),
        source_revision: is_development()
            .then_some(option_env!("LOLICODE_BUILD_REVISION"))
            .flatten(),
        built_at: is_development()
            .then_some(option_env!("LOLICODE_BUILD_TIMESTAMP"))
            .flatten(),
        working_tree_dirty: is_development()
            .then_some(option_env!("LOLICODE_BUILD_DIRTY") == Some("true")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_identity_keeps_profile_port_and_updates_separate() {
        let expected_development = option_env!("LOLICODE_BUILD_CHANNEL") == Some("development");
        assert_eq!(is_development(), expected_development);
        if expected_development {
            assert_eq!(name(), "LoliCode Dev");
            assert_eq!(profile_directory(), ".lolicode-dev");
            assert_eq!(default_proxy_port(), 15731);
            assert!(require_stable_updates().is_err());
        } else {
            assert_eq!(name(), "LoliCode");
            assert_eq!(profile_directory(), ".tai-switch");
            assert_eq!(default_proxy_port(), 15721);
            assert!(require_stable_updates().is_ok());
        }
    }
}
