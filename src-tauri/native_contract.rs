// Included by build.rs, so the contract is compiled into the executable rather
// than recomputed from mutable source files on the user's computer.
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, path::Path};

fn collect(root: &Path, relative: &str, extension: &str, files: &mut BTreeSet<String>) {
    let directory = root.join(relative);
    println!("cargo:rerun-if-changed={}", directory.display());
    for entry in fs::read_dir(&directory).expect("read native source directory") {
        let entry = entry.expect("read native source entry");
        let relative = format!(
            "{relative}/{}",
            entry.file_name().to_str().expect("UTF-8 source path")
        );
        let metadata = entry.file_type().expect("native source metadata");
        assert!(
            !metadata.is_symlink(),
            "native source directories cannot be linked"
        );
        if metadata.is_dir() {
            collect(root, &relative, extension, files);
        } else if entry.path().extension().is_some_and(|e| e == extension) {
            files.insert(relative);
        }
    }
}
pub fn emit() {
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().expect("repository root");
    let mut files = BTreeSet::from([
        "src-tauri/build.rs".into(),
        "src-tauri/native_contract.rs".into(),
        "src-tauri/Cargo.toml".into(),
        "src-tauri/Cargo.lock".into(),
        "crates/lolicode-agent/Cargo.toml".into(),
    ]);
    collect(root, "src-tauri/src", "rs", &mut files);
    collect(root, "src-tauri/capabilities", "json", &mut files);
    collect(root, "crates/lolicode-agent/src", "rs", &mut files);
    for entry in fs::read_dir(&manifest).expect("read Tauri config directory") {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("tauri.") && name.ends_with(".json") {
            files.insert(format!("src-tauri/{name}"));
        }
    }
    let mut hash = Sha256::new();
    hash.update(b"lolicode-native-contract-v1\0");
    fn record(hash: &mut Sha256, path: &str, text: &str) {
        for bytes in [path.as_bytes(), text.as_bytes()] {
            hash.update((bytes.len() as u64).to_be_bytes());
            hash.update(bytes);
        }
    }
    record(
        &mut hash,
        "@version",
        &std::env::var("CARGO_PKG_VERSION").unwrap(),
    );
    for file in files {
        println!("cargo:rerun-if-changed={}", root.join(&file).display());
        let contents = fs::read_to_string(root.join(&file))
            .expect("read native contract input")
            .replace("\r\n", "\n");
        record(&mut hash, &file, &contents);
    }
    println!(
        "cargo:rustc-env=LOLICODE_NATIVE_CONTRACT={:x}",
        hash.finalize()
    );
}
