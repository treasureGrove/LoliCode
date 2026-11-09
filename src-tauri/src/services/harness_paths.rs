//! Locations shared by the development, installed, and portable Harness hosts.
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tauri::{AppHandle, Manager};

const RESOURCE_PATH: &str = "agent/harness-runtime";
const NODE_VERSION: &str = "24.19.0";

pub(super) struct HarnessPaths {
    pub(super) node: PathBuf,
    pub(super) package: PathBuf,
    pub(super) native_reader: PathBuf,
    pub(super) version: String,
}

fn pinned_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| {
        let package: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../packages/lolicode-harness-runtime/package.json"
        )))
        .expect("invalid LoliCode Harness runtime package manifest");
        package["dependencies"]["@deepseek-ai/dsh"]
            .as_str()
            .expect("missing LoliCode Harness runtime pin")
            .to_owned()
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    format: u32,
    harness_version: String,
    node_version: String,
    platform: String,
    arch: String,
}

impl HarnessPaths {
    pub(super) fn resolve(app: &AppHandle) -> Result<Self, String> {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|_| "无法定位应用资源目录")?;
        if resources.join(RESOURCE_PATH).exists() {
            return Self::from_resource_dir(&resources);
        }
        #[cfg(debug_assertions)]
        if crate::channel::is_development() {
            let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
            return Self::from_resource_dir(&source);
        }
        Err("找不到内置 DeepSeek Harness，请重新安装完整的 LoliCode 安装包".into())
    }

    pub(super) fn from_resource_dir(resource_dir: &Path) -> Result<Self, String> {
        // Tauri can return a verbatim Windows path (\\?\D:\...). Node's CLI
        // realpath rejects that form as its module entry point even when the
        // file is readable by Rust. Use the host's canonical native spelling.
        let resources = super::agent_host::canonical_project(&resource_dir.to_string_lossy())
            .map_err(|_| "无法解析内置 Harness 资源目录")?;
        let package = resources.join(RESOURCE_PATH);
        let data = std::fs::read(package.join("runtime-manifest.json"))
            .map_err(|_| "内置 Harness 运行时清单缺失")?;
        let manifest: RuntimeManifest =
            serde_json::from_slice(&data).map_err(|_| "内置 Harness 运行时清单无效")?;
        let platform = match std::env::consts::OS {
            "windows" => "win32",
            "macos" => "darwin",
            value => value,
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            value => value,
        };
        if manifest.format != 1
            || manifest.harness_version != pinned_version()
            || manifest.node_version != NODE_VERSION
            || manifest.platform != platform
            || manifest.arch != arch
        {
            return Err("内置 Harness 运行时版本或平台不匹配".into());
        }
        let node = package.join(if cfg!(windows) { "node.exe" } else { "node" });
        if !node.is_file()
            || !package
                .join("node_modules/@deepseek-ai/dsh/lib/bin.js")
                .is_file()
            || !package.join("profile.cordis.patch.yml").is_file()
            || !package.join("host-operations.cordis.patch.yml").is_file()
            || !package.join("host-operations.mjs").is_file()
            || !package.join("host-mcp.mjs").is_file()
            || !package.join("host-session-markdown.mjs").is_file()
            || !package.join("host-session-native.mjs").is_file()
        {
            return Err("内置 Harness 文件不完整，请重新安装完整的 LoliCode 安装包".into());
        }
        Ok(Self {
            node,
            native_reader: package.join("host-session-native.mjs"),
            package,
            version: manifest.harness_version,
        })
    }
}
