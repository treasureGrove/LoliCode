//! Private-cache acceptance of the actual signed presentation package.
//! Never reads the user's database, installs an application or changes settings.
use lolicode_lib::agent_test_support::{ResourceEnvelope as Envelope, ResourceStore};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .map_err(|_| "Embedded configuration invalid")?;
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("Embedded public key missing")?
        .to_string();
    let temporary = tempfile::tempdir().map_err(|_| "Private cache unavailable")?;
    let root = temporary.path().join("packs");
    let store = ResourceStore::new(root.clone(), key.clone(), env!("CARGO_PKG_VERSION").into());
    let live = args.as_slice() == ["--live"];
    let view = if live {
        if store.check().await?.is_none() {
            return Err("No independently published resource pack".into());
        }
        store.install().await?
    } else if args.len() == 2 && args[0] == "--directory" {
        let directory = std::path::Path::new(&args[1]);
        let envelope: Envelope = serde_json::from_slice(
            &std::fs::read(directory.join("latest.json")).map_err(|_| "Signed envelope missing")?,
        )
        .map_err(|_| "Signed envelope invalid")?;
        let archive =
            std::fs::read(directory.join("assets.zip")).map_err(|_| "Resource archive missing")?;
        store.install_verified_archive(&envelope, &archive)?
    } else {
        return Err("Use --directory <signed-pack-directory> or --live".into());
    };
    if view.assets.len() != 4 || !view.pending_confirmation {
        return Err(
            "Actual presentation package must provide all four images and await confirmation"
                .into(),
        );
    }
    let id = view.id.clone().ok_or("Resource identity missing")?;
    store.confirm(&id)?;
    let reopened = ResourceStore::new(root, key, env!("CARGO_PKG_VERSION").into());
    reopened.recover_startup()?;
    let after_restart = reopened.view();
    if live {
        let repeated = reopened.install().await;
        if !matches!(repeated, Err(ref error) if error.contains("已是此版本")) {
            return Err("Repeated resource installation was not rejected".into());
        }
    }
    if after_restart.assets != view.assets || after_restart.pending_confirmation {
        return Err("Confirmed resource restart check failed".into());
    }
    let restored = reopened.rollback(&id)?;
    if restored.id.is_some() || !restored.assets.is_empty() {
        return Err("Bundled fallback check failed".into());
    }
    println!(
        "{}",
        json!({"passed":true,"liveHttp":live,"version":view.version,"decodedImages":view.assets.len(),"signatureVerified":true,"restartRetained":true,"bundledRollback":true,"repeatedLiveInstallRejected":live,"userProfileRead":false,"installerExecuted":false})
    );
    Ok(())
}
