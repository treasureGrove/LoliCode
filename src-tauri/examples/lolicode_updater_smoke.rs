//! Isolated official updater check/download/signature smoke; never installs.
//!
//! Run only after the publisher has made the signed release available:
//! cargo run --manifest-path src-tauri/Cargo.toml --features "test-hooks,tauri/test" --example lolicode_updater_smoke -- --expect-version 4.0.15
//!
//! Local unsigned/error fixture (HTTP is allowed only for loopback):
//! cargo run --manifest-path src-tauri/Cargo.toml --features "test-hooks,tauri/test" --example lolicode_updater_smoke -- --endpoint http://127.0.0.1:14422/latest.json
//!
//! --help prints the options. --check-only skips the package download.
//! The simulated current version defaults to 4.0.15 and is configurable,
//! independent of this crate's package version. MockRuntime has no window, WebView, tray, user state, or app
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
      --current-version <v>  Simulate an installed version (default: 4.0.15)\n\
      --package-base-url <URL> Allow the standard versioned installer under this exact HTTPS directory (ending in /)\n\
      --check-only           Check metadata without downloading a package\n\
      --help                 Print this help\n\
      JSON proof is printed to stdout. Errors are classified without raw URLs,\n\
      signatures, response bodies, headers, configuration, or credentials.\n\
      No install, app cleanup, app restart, or user process action is supported.";

    struct Options {
        endpoint: Option<Url>,
        expected_version: Option<String>,
        current_version: String,
        check_only: bool,
        package_base_url: Option<Url>,
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

    fn package_base(raw: &str) -> Result<Url, &'static str> {
        let base = Url::parse(raw).map_err(|_| "invalid_package_base_url")?;
        // Keep the operator's directory unambiguous. In particular, do not
        // silently normalize traversal, backslashes, credentials or URL suffixes.
        if base.scheme() != "https"
            || !base.has_host()
            || !clean_transport(&base)
            || !base.path().ends_with('/')
            || base.as_str() != raw
            || raw.contains('\\')
        {
            return Err("unsafe_package_base_url");
        }
        Ok(base)
    }

    fn explicit_package_matches(base: &Url, package: &Url, version: &str) -> bool {
        // check() already parses the release's semver. Also prevent path syntax
        // from entering this helper's filename when testing synthetic metadata.
        if version.is_empty()
            || version.len() > 128
            || !version
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '+'))
            || !clean_transport(package)
        {
            return false;
        }
        base.join(&format!("LoliCode-{version}-Windows-x64-Setup.exe"))
            .is_ok_and(|expected| expected.as_str() == package.as_str())
    }

    fn parse_options(
        mut args: impl Iterator<Item = String>,
    ) -> Result<Option<Options>, &'static str> {
        let mut options = Options {
            endpoint: None,
            expected_version: None,
            current_version: CURRENT_VERSION.into(),
            check_only: false,
            package_base_url: None,
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
                "--package-base-url" => {
                    let raw = args.next().ok_or("missing_package_base_url")?;
                    if options.package_base_url.is_some() {
                        return Err("duplicate_package_base_url");
                    }
                    options.package_base_url = Some(package_base(&raw)?);
                }
                "--expect-version" => {
                    options.expected_version = Some(args.next().ok_or("missing_expected_version")?);
                }
                "--current-version" => {
                    options.current_version = args.next().ok_or("missing_current_version")?;
                }
                _ => return Err("unknown_option"),
            }
        }
        Ok(Some(options))
    }

    fn options() -> Result<Option<Options>, &'static str> {
        parse_options(std::env::args().skip(1))
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
        context.package_info_mut().version = match options.current_version.parse() {
            Ok(version) => version,
            Err(_) => {
                reject(proof, "arguments", "invalid_current_version");
                return;
            }
        };
        proof["currentVersion"] = json!(options.current_version);
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
        let explicit_package = options.package_base_url.as_ref().is_some_and(|base| {
            explicit_package_matches(base, &update.download_url, &update.version)
        });
        if !clean_transport(&update.download_url)
            || (update.download_url.origin() != endpoint.origin()
                && !official_github_asset
                && !explicit_package)
        {
            reject(proof, "downloading", "unsafe_package_url");
            return;
        }
        proof["packageSourceKind"] = json!(if explicit_package {
            "explicit_https_directory"
        } else if official_github_asset {
            "official_github_release"
        } else {
            "same_origin"
        });
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

    #[cfg(test)]
    mod tests {
        use super::*;

        const BASE: &str =
            "https://lolicode-fixture.cos.ap-singapore.myqcloud.com/releases/4.0.18/";

        #[test]
        fn package_base_is_one_explicit_clean_https_directory() {
            assert_eq!(package_base(BASE).unwrap().as_str(), BASE);
            for raw in [
                "http://bucket.test/releases/",
                "https://user:secret@bucket.test/releases/",
                "https://bucket.test/releases/?token=synthetic",
                "https://bucket.test/releases/#fragment",
                "https://bucket.test/releases",
                "https://bucket.test/releases/../other/",
                "https://bucket.test/releases/%2e%2e/other/",
                "https://bucket.test\\releases/",
            ] {
                assert!(
                    package_base(raw).is_err(),
                    "unsafe synthetic base was accepted"
                );
            }
        }

        #[test]
        fn explicit_package_requires_the_exact_origin_path_version_and_filename() {
            let base = package_base(BASE).unwrap();
            let package = format!("{BASE}LoliCode-4.0.18-Windows-x64-Setup.exe");
            assert!(explicit_package_matches(
                &base,
                &Url::parse(&package).unwrap(),
                "4.0.18"
            ));
            for raw in [
                "https://another.test/releases/4.0.18/LoliCode-4.0.18-Windows-x64-Setup.exe",
                "https://lolicode-fixture.cos.ap-singapore.myqcloud.com.evil.test/releases/4.0.18/LoliCode-4.0.18-Windows-x64-Setup.exe",
                "https://lolicode-fixture.cos.ap-singapore.myqcloud.com:8443/releases/4.0.18/LoliCode-4.0.18-Windows-x64-Setup.exe",
                "https://lolicode-fixture.cos.ap-singapore.myqcloud.com/releases/4.0.18/../LoliCode-4.0.18-Windows-x64-Setup.exe",
                "https://lolicode-fixture.cos.ap-singapore.myqcloud.com/releases/4.0.18/%2e%2e/LoliCode-4.0.18-Windows-x64-Setup.exe",
                "https://lolicode-fixture.cos.ap-singapore.myqcloud.com/releases/4.0.18-other/LoliCode-4.0.18-Windows-x64-Setup.exe",
            ] {
                assert!(!explicit_package_matches(&base, &Url::parse(raw).unwrap(), "4.0.18"));
            }
            for suffix in [
                "LoliCode-4.0.19-Windows-x64-Setup.exe",
                "arbitrary.exe",
                "LoliCode-4.0.18-Windows-x64-Setup.exe.sig",
                "nested/LoliCode-4.0.18-Windows-x64-Setup.exe",
                "LoliCode-4.0.18-Windows-x64-Setup.exe?token=synthetic",
                "LoliCode-4.0.18-Windows-x64-Setup.exe#fragment",
                "%4coliCode-4.0.18-Windows-x64-Setup.exe",
                "..%2fLoliCode-4.0.18-Windows-x64-Setup.exe",
            ] {
                let package = Url::parse(&format!("{BASE}{suffix}")).unwrap();
                assert!(!explicit_package_matches(&base, &package, "4.0.18"));
            }
            assert!(!explicit_package_matches(
                &base,
                &Url::parse(&package).unwrap(),
                "4.0.18/../other"
            ));
        }

        #[test]
        fn package_source_override_is_optional_and_never_a_list() {
            let options = parse_options(std::iter::empty()).unwrap().unwrap();
            assert!(options.package_base_url.is_none());
            let options =
                parse_options(["--package-base-url", BASE].into_iter().map(str::to_owned))
                    .unwrap()
                    .unwrap();
            assert_eq!(options.package_base_url.unwrap().as_str(), BASE);
            assert!(parse_options(["--package-base-url"].into_iter().map(str::to_owned)).is_err());
            assert!(parse_options(
                ["--package-base-url", BASE, "--package-base-url", BASE]
                    .into_iter()
                    .map(str::to_owned)
            )
            .is_err());
        }
    }
}

#[cfg(feature = "test-hooks")]
#[tokio::main]
async fn main() -> std::process::ExitCode {
    smoke::run().await
}
