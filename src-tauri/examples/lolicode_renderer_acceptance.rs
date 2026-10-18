//! Production renderer downloader/store/Tauri resolver and IPC acceptance.
//! Uses an explicitly created private cache across separate process launches.
//! MockRuntime has no WebView or installer: this does not prove GUI rendering.
use cc_switch_lib::agent_test_support::{
    renderer_native_contract, wrap_renderer_assets, RendererEnvelope, RendererHost, RendererStore,
};
use serde_json::{json, Value};
use std::{borrow::Cow, path::Path, sync::Arc};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::Assets;

struct Bundled;
impl<R: tauri::Runtime> Assets<R> for Bundled {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        (key.as_ref() == "/index.html").then_some(Cow::Borrowed(
            b"<html><body>BUNDLED_ACCEPTANCE_CONTROL</body></html>",
        ))
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::once((
            Cow::Borrowed("/index.html"),
            Cow::Borrowed(b"<html><body>BUNDLED_ACCEPTANCE_CONTROL</body></html>".as_slice()),
        )))
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
fn owner(root: &Path, phase: &str, contract: &str) -> Result<(), String> {
    if !root.is_absolute()
        || !root.file_name().and_then(|s| s.to_str()).is_some_and(|s| {
            s.strip_prefix("renderer-acceptance-")
                .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
        })
    {
        return Err(
            "Cache must be an absolute, dedicated renderer-acceptance-<UUID> directory".into(),
        );
    }
    let marker = root.join("acceptance-owner.json");
    let expected = json!({"kind":"lolicode-renderer-acceptance", "nativeVersion":env!("CARGO_PKG_VERSION"), "contract":contract});
    if phase == "stage" {
        std::fs::create_dir(root).map_err(|_| "Acceptance directory must not already exist")?;
        std::fs::write(marker, expected.to_string())
            .map_err(|_| "Cannot create acceptance owner marker")?;
    } else {
        let m = std::fs::symlink_metadata(root).map_err(|_| "Acceptance root unavailable")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                return Err("Linked acceptance root rejected".into());
            }
        }
        if m.file_type().is_symlink() || !m.is_dir() {
            return Err("Acceptance directory required".into());
        }
        let bytes = std::fs::read(marker).map_err(|_| "Acceptance owner marker unavailable")?;
        if bytes.len() > 8192
            || serde_json::from_slice::<Value>(&bytes).ok().as_ref() != Some(&expected)
        {
            return Err("Not a cache owned by this acceptance build".into());
        }
    }
    Ok(())
}
#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 || args[0] != "--phase" || args[2] != "--cache" {
        return Err("Use --phase stage|boot|confirm|rollback --cache <new-private-path> [--feed <official-HTTPS> | --directory <signed-directory>]".into());
    }
    let phase = args[1].as_str();
    if !["stage", "boot", "confirm", "rollback"].contains(&phase) {
        return Err("Unknown acceptance phase".into());
    }
    let root = Path::new(&args[3]);
    let contract = renderer_native_contract();
    owner(root, phase, &contract)?;
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .map_err(|_| "Native configuration invalid")?;
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("Public key unavailable")?;
    let store = Arc::new(RendererStore::new(
        root.join("packs"),
        key.into(),
        env!("CARGO_PKG_VERSION").into(),
        contract.clone(),
    ));
    let mut live = false;
    if phase == "stage" {
        let (e, b) = if args.len() == 6 && args[4] == "--feed" {
            live = true;
            store.download_candidate(&args[5]).await?
        } else if args.len() == 6 && args[4] == "--directory" {
            let directory = Path::new(&args[5]);
            let e: RendererEnvelope = serde_json::from_slice(
                &std::fs::read(directory.join("latest.json"))
                    .map_err(|_| "Signed envelope unavailable")?,
            )
            .map_err(|_| "Envelope invalid")?;
            let b =
                std::fs::read(directory.join("renderer.zip")).map_err(|_| "Archive unavailable")?;
            (e, b)
        } else {
            return Err(
                "Stage requires exactly one signed directory or official candidate feed".into(),
            );
        };
        let state = store.install_verified_archive(&e, &b)?;
        if state.active_id.is_some() || !state.restart_required {
            return Err("Download changed running generation".into());
        }
        println!(
            "{}",
            json!({"phase":phase,"nativeContract":contract,"version":state.staged_version,"liveHttp":live,"signatureVerified":true,"stagedOnly":true,"userProfileRead":false,"webviewRendered":false})
        );
        return Ok(());
    }
    if args.len() != 4 {
        return Err("Unexpected boot arguments".into());
    }
    let host = RendererHost::isolated(store.clone());
    let status = host.status()?;
    let mut context = tauri::test::mock_context(Bundled);
    context.config_mut().identifier = "art.treasuregrove.lolicode.renderer-acceptance".into();
    context.config_mut().app.security = serde_json::from_value(config["app"]["security"].clone())
        .map_err(|_| "Native CSP unavailable")?;
    wrap_renderer_assets(&mut context, host.clone());
    let app = tauri::test::mock_builder()
        .manage(host.clone())
        .invoke_handler(tauri::generate_handler![
            cc_switch_lib::get_renderer_status,
            cc_switch_lib::confirm_renderer_boot,
            cc_switch_lib::rollback_renderer_update
        ])
        .build(context)
        .map_err(|_| "Tauri resolver construction failed")?;
    let resolver = app.asset_resolver();
    let index = resolver
        .get("index.html".into())
        .ok_or("Tauri HTML missing")?;
    if index.mime_type() != "text/html" || index.csp_header().is_none() {
        return Err("Native HTML/CSP resolution failed".into());
    }
    let count = resolver.iter().count();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .map_err(|_| "Mock IPC window failed")?;
    let invoke = |name: &str, body: Value| -> Result<Value, String> {
        tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: name.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .map_err(|_| "Production renderer IPC rejected")?
        .deserialize::<Value>()
        .map_err(|_| "Renderer IPC response invalid".into())
    };
    let ipc = invoke("get_renderer_status", json!({}))?;
    if ipc["runningId"] != serde_json::to_value(&status.running_id).unwrap() {
        return Err("IPC and selected asset generation disagree".into());
    }
    let mut js = 0usize;
    for (name, expected) in resolver.iter() {
        if name.ends_with(".js") {
            let resolved = resolver.get(name.to_string()).ok_or("Tauri JS missing")?;
            if resolved.bytes() != expected.as_ref() {
                return Err("Tauri mixed renderer byte generations".into());
            }
            js += 1;
        }
    }
    if phase == "confirm" {
        invoke(
            "confirm_renderer_boot",
            json!({"id":status.running_id.as_deref().ok_or("No hot renderer to confirm")?,"ticket":status.boot_ticket.as_deref().ok_or("No boot ticket")?}),
        )?;
        if store.view()?.pending_confirmation {
            return Err("IPC failed to persist health receipt".into());
        }
    } else if phase == "rollback" {
        invoke(
            "rollback_renderer_update",
            json!({"id":status.running_id.as_deref().ok_or("No hot renderer to rollback")?}),
        )?;
    }
    println!(
        "{}",
        json!({"phase":phase,"nativeContract":contract,"runningVersion":status.running_version,"assetFiles":count,"resolvedJavaScriptFiles":js,"nativeCsp":index.csp_header().is_some(),"productionIpc":true,"pendingConfirmation":store.view()?.pending_confirmation,"bundledControl":String::from_utf8_lossy(index.bytes()).contains("BUNDLED_ACCEPTANCE_CONTROL"),"webviewRendered":false,"installerExecuted":false,"userProfileRead":false})
    );
    Ok(())
}
