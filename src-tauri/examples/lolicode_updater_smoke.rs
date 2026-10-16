//! Isolated official updater check/download/signature smoke; never installs.
//!
//! Run only after the publisher has made the signed release available:
//! cargo run --manifest-path src-tauri/Cargo.toml --features "test-hooks,tauri/test" --example lolicode_updater_smoke -- --expect-version 4.0.15
//!
//! Local unsigned/error fixture (HTTP is allowed only for loopback):
//! cargo run --manifest-path src-tauri/Cargo.toml --features "test-hooks,tauri/test" --example lolicode_updater_smoke -- --endpoint http://127.0.0.1:14422/latest.json
//!
//! --help prints the options. --check-only skips the package download.
//! The current version is deliberately 4.0.15, independent of this crate's
//! package version. MockRuntime has no window, WebView, tray, user state, or app
//! event loop. Only the repository's public updater configuration is embedded.
//! A successful Update::download is the official plugin's signature verdict;
//! this example does not implement its own signature verifier or save/run bytes.
//! Without test-hooks, the example is inert, including in default all-target builds.

#[cfg(not(feature = "test-hooks"))]
fn main() -> std::process::ExitCode {
    eprintln!("Use --features \"test-hooks,tauri/test\" for this isolated updater smoke.");
    std::process::ExitCode::FAILURE
}

#[cfg(feature = "test-hooks")]
mod smoke {
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri_plugin_updater::{Error, UpdaterExt};
    use url::Url;

    const CURRENT_VERSION: &str = "4.0.15";
    const HELP: &str = "LoliCode official updater smoke (check/download only)\n\
      --endpoint <URL>       Override metadata with a loopback fixture or HTTPS endpoint\n\
      --expect-version <v>   Fail unless the native check offers exactly this version\n\
      --check-only           Check metadata without downloading a package\n\
      --help                 Print this help\n\
      JSON proof is printed to stdout. Errors are classified without raw URLs,\n\
      signatures, response bodies, headers, configuration, or credentials.\n\
      No install, app cleanup, app restart, or user process action is supported.";

    struct Options {
        endpoint: Option<Url>,
        expected_version: Option<String>,
        check_only: bool,
    }

    fn loopback(url: &Url) -> bool {
        matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
    }

    fn clean_transport(url: &Url) -> bool {
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && (url.scheme() == "https" || (url.scheme() == "http" && loopback(url)))
    }

    fn options() -> Result<Option<Options>, &'static str> {
        let mut args = std::env::args().skip(1);
        let mut options = Options {
            endpoint: None,
            expected_version: None,
            check_only: false,
        };
        while let Some(option) = args.next() {
            match option.as_str() {
                "--help" | "-h" => return Ok(None),
                "--check-only" => options.check_only = true,
                "--endpoint" => {
                    let raw = args.next().ok_or("missing_endpoint")?;
                    let endpoint = Url::parse(&raw).map_err(|_| "invalid_endpoint")?;
                    if !clean_transport(&endpoint) {
                        return Err("unsafe_endpoint");
                    }
                    options.endpoint = Some(endpoint);
                }
                "--expect-version" => {
                    options.expected_version = Some(args.next().ok_or("missing_expected_version")?);
                }
                _ => return Err("unknown_option"),
            }
        }
        Ok(Some(options))
    }

    fn classify(error: &Error) -> &'static str {
        match error {
            Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => "signature_rejected",
            Error::ReleaseNotFound => "release_unavailable",
            Error::Serialization(_) | Error::Semver(_) | Error::FormatDate => "invalid_release",
            Error::TargetNotFound(_) | Error::TargetsNotFound(_) => "target_not_available",
            Error::Reqwest(error) if error.is_decode() => "invalid_release",
            Error::Reqwest(_) | Error::Network(_) | Error::Http(_) => "network_or_http_error",
            Error::EmptyEndpoints | Error::InsecureTransportProtocol | Error::UrlParse(_) => {
                "invalid_updater_configuration"
            }
            _ => "updater_error",
        }
    }

    fn reject(proof: &mut Value, stage: &str, category: &str) {
        proof["result"] = json!("error");
        proof["stage"] = json!(stage);
        proof["errorCategory"] = json!(category);
    }

    async fn execute(options: Options, proof: &mut Value) {
        // This is repository public metadata, not generate_context! or user settings.
        let repository: Value = match serde_json::from_str(include_str!("../tauri.conf.json")) {
            Ok(repository) => repository,
            Err(_) => {
                reject(proof, "configuration", "invalid_repository_configuration");
                return;
            }
        };
        let Some(mut updater_config) = repository["plugins"]["updater"].as_object().cloned() else {
            reject(proof, "configuration", "missing_repository_updater");
            return;
        };
        let endpoint = match options.endpoint {
            Some(endpoint) => endpoint,
            None => match repository["plugins"]["updater"]["endpoints"][0]
                .as_str()
                .and_then(|raw| Url::parse(raw).ok())
            {
                Some(endpoint) if clean_transport(&endpoint) => endpoint,
                _ => {
                    reject(proof, "configuration", "invalid_repository_endpoint");
                    return;
                }
            },
        };
        let fixture_http = loopback(&endpoint) && endpoint.scheme() == "http";
        proof["endpointKind"] = json!(if loopback(&endpoint) {
            "loopback_fixture"
        } else {
            "https_release"
        });
        updater_config.insert("endpoints".into(), json!([endpoint.as_str()]));
        updater_config.insert(
            "dangerousInsecureTransportProtocol".into(),
            json!(fixture_http),
        );
        updater_config.insert("dangerousAcceptInvalidCerts".into(), json!(false));
        updater_config.insert("dangerousAcceptInvalidHostnames".into(), json!(false));

        let mut context = mock_context::<MockRuntime, _>(noop_assets());
        context.package_info_mut().name = "lolicode-updater-isolated-smoke".into();
        context.package_info_mut().version = CURRENT_VERSION.parse().expect("fixed valid semver");
        context.config_mut().identifier = "art.treasuregrove.lolicode.updater-smoke".into();
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), Value::Object(updater_config));
        let app = match mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
        {
            Ok(app) => app,
            Err(_) => {
                reject(proof, "configuration", "mock_runtime_initialization_failed");
                return;
            }
        };
        let exit_hook_called = Arc::new(AtomicBool::new(false));
        let exit_probe = exit_hook_called.clone();
        let builder = app
            .updater_builder()
            .target("windows-x86_64")
            .timeout(Duration::from_secs(600))
            .on_before_exit(move || {
                exit_probe.store(true, Ordering::Release);
            });
        let builder = if loopback(&endpoint) {
            builder.no_proxy()
        } else {
            builder
        };
        let updater = match builder.build() {
            Ok(updater) => updater,
            Err(error) => {
                reject(proof, "configuration", classify(&error));
                return;
            }
        };
        let update = match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                if options.expected_version.is_some() {
                    reject(proof, "checking", "expected_update_not_available");
                } else {
                    proof["result"] = json!("up_to_date");
                    proof["stage"] = json!("checked");
                }
                return;
            }
            Err(error) => {
                reject(proof, "checking", classify(&error));
                return;
            }
        };
        proof["latestVersion"] = json!(&update.version);
        if options
            .expected_version
            .as_ref()
            .is_some_and(|expected| expected != &update.version)
        {
            reject(proof, "checking", "unexpected_release_version");
            return;
        }
        if options.check_only {
            proof["result"] = json!("update_available_check_only");
            proof["stage"] = json!("checked");
            return;
        }
        // Keep fixtures local. The two owned HTTPS feeds may also use the
        // exact, version-bound public distribution attachment on GitHub.
        // No package is persisted or executed.
        let official_github_asset = matches!(
            endpoint.host_str(),
            Some("lolicode.com" | "tools.treasuregrove.art")
        ) && endpoint.scheme() == "https"
            && update.download_url.as_str()
                == format!(
                    "https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v{0}/LoliCode-{0}-Windows-x64-Setup.exe",
                    update.version
                );
        if !clean_transport(&update.download_url)
            || (update.download_url.origin() != endpoint.origin() && !official_github_asset)
        {
            reject(proof, "downloading", "unsafe_package_url");
            return;
        }
        proof["downloadAttempted"] = json!(true);
        let downloaded = AtomicU64::new(0);
        let finished = AtomicBool::new(false);
        match update
            .download(
                |chunk, _| {
                    downloaded.fetch_add(chunk as u64, Ordering::Relaxed);
                },
                || {
                    finished.store(true, Ordering::Release);
                },
            )
            .await
        {
            Ok(bytes) => {
                proof["result"] = json!("signature_verified");
                proof["stage"] = json!("verified");
                proof["downloadedBytes"] = json!(bytes.len());
                proof["sha256"] = json!(format!("{:x}", Sha256::digest(&bytes)));
                proof["signatureVerified"] = json!(true);
                // bytes are dropped here: no file, install, extraction or restart.
            }
            Err(error) => {
                proof["downloadedBytes"] = json!(downloaded.load(Ordering::Relaxed));
                reject(
                    proof,
                    if finished.load(Ordering::Acquire) {
                        "verification"
                    } else {
                        "downloading"
                    },
                    classify(&error),
                );
            }
        }
        proof["installerExitHookInvoked"] = json!(exit_hook_called.load(Ordering::Acquire));
    }

    pub async fn run() -> std::process::ExitCode {
        let mut proof = json!({
            "runtime": "tauri_mockruntime",
            "currentVersion": CURRENT_VERSION,
            "target": "windows-x86_64",
            "latestVersion": null,
            "downloadAttempted": false,
            "downloadedBytes": 0,
            "sha256": null,
            "signatureVerified": false,
            "installerExitHookInvoked": false,
            "installationSupported": false,
            "userConfigurationRead": false,
            "webviewCreated": false,
            "result": "pending"
        });
        match options() {
            Ok(None) => {
                println!("{HELP}");
                return std::process::ExitCode::SUCCESS;
            }
            Ok(Some(options)) => execute(options, &mut proof).await,
            Err(category) => reject(&mut proof, "arguments", category),
        }
        let passed = proof["result"] != "error" && proof["installerExitHookInvoked"] == false;
        println!(
            "{}",
            serde_json::to_string_pretty(&proof).expect("proof is JSON")
        );
        if passed {
            std::process::ExitCode::SUCCESS
        } else {
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(feature = "test-hooks")]
#[tokio::main]
async fn main() -> std::process::ExitCode {
    smoke::run().await
}
