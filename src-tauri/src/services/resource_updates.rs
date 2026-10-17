//! Signed, inert presentation assets. No downloaded scripts, CSS, or IPC changes.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::Duration,
};

pub const FEED: &str = "https://tools.treasuregrove.art/lolicode/resources/latest.json";
const MAX_MANIFEST: usize = 32 * 1024;
const MAX_ARCHIVE: usize = 48 * 1024 * 1024;
const MAX_IMAGE: usize = 16 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub manifest: String,
    pub signature: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: u32,
    kind: String,
    version: u64,
    min_app_version: String,
    max_app_version: String,
    archive_url: String,
    archive_sha256: String,
    archive_bytes: usize,
    files: Vec<AssetFile>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AssetFile {
    slot: String,
    path: String,
    sha256: String,
    bytes: usize,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Activation {
    active: Option<String>,
    previous: Option<String>,
    confirmed: bool,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackView {
    pub id: Option<String>,
    pub version: Option<u64>,
    pub can_rollback: bool,
    pub pending_confirmation: bool,
    pub assets: BTreeMap<String, String>,
    pub warning: Option<String>,
}

#[derive(Clone)]
pub struct ResourceStore {
    root: PathBuf,
    public_key: String,
    app_version: String,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path).map_err(|_| "资源文件不可读取")?;
    if !file
        .metadata()
        .map_err(|_| "资源文件信息不可读取")?
        .is_file()
    {
        return Err("资源必须为普通文件".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "资源读取失败")?;
    if bytes.len() > limit {
        return Err("资源文件超过大小限制".into());
    }
    Ok(bytes)
}

fn validate_png(bytes: &[u8]) -> Result<(), String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 64 * 1024 * 1024,
    });
    let mut reader = decoder.read_info().map_err(|_| "资源不是有效的 PNG 图片")?;
    let info = reader.info();
    if info.width == 0
        || info.height == 0
        || info.width > 8192
        || info.height > 8192
        || u64::from(info.width) * u64::from(info.height) > 16_000_000
    {
        return Err("资源图片尺寸超过限制".into());
    }
    let size = reader
        .output_buffer_size()
        .filter(|n| *n <= 64 * 1024 * 1024)
        .ok_or("图片解码超过限制")?;
    reader
        .next_frame(&mut vec![0; size])
        .map_err(|_| "资源图片无法完整解码")?;
    Ok(())
}

impl ResourceStore {
    pub fn new(root: PathBuf, public_key: String, app_version: String) -> Self {
        Self {
            root,
            public_key,
            app_version,
        }
    }

    fn manifest(&self, envelope: &Envelope) -> Result<(Manifest, String), String> {
        if envelope.manifest.len() > MAX_MANIFEST * 2 || envelope.signature.len() > 16384 {
            return Err("资源签名清单过大".into());
        }
        let raw = STANDARD
            .decode(&envelope.manifest)
            .map_err(|_| "资源清单编码无效")?;
        if raw.len() > MAX_MANIFEST {
            return Err("资源清单过大".into());
        }
        let key = STANDARD
            .decode(&self.public_key)
            .map_err(|_| "内置资源公钥无效")?;
        let key = PublicKey::decode(std::str::from_utf8(&key).map_err(|_| "内置资源公钥无效")?)
            .map_err(|_| "内置资源公钥无效")?;
        let signature = STANDARD
            .decode(&envelope.signature)
            .map_err(|_| "资源签名编码无效")?;
        let signature =
            Signature::decode(std::str::from_utf8(&signature).map_err(|_| "资源签名无效")?)
                .map_err(|_| "资源签名无效")?;
        key.verify(&raw, &signature, false)
            .map_err(|_| "资源签名不匹配，未启用此资源包")?;
        let manifest: Manifest = serde_json::from_slice(&raw).map_err(|_| "资源清单格式无效")?;
        let current = semver::Version::parse(&self.app_version).map_err(|_| "当前应用版本无效")?;
        let min =
            semver::Version::parse(&manifest.min_app_version).map_err(|_| "资源最低版本无效")?;
        let max =
            semver::Version::parse(&manifest.max_app_version).map_err(|_| "资源最高版本无效")?;
        if manifest.format != 1
            || manifest.kind != "lolicode-presentation"
            || manifest.version == 0
            || current < min
            || current > max
            || min > max
        {
            return Err("此资源包与当前应用版本不兼容，请先更新应用".into());
        }
        if manifest.files.is_empty()
            || manifest.files.len() > 4
            || manifest.archive_bytes == 0
            || manifest.archive_bytes > MAX_ARCHIVE
            || !digest(&manifest.archive_sha256)
        {
            return Err("资源清单超出限制".into());
        }
        let mut slots = HashSet::new();
        let mut total = 0;
        for file in &manifest.files {
            if !["companion", "scene", "sidebar", "brooch"].contains(&file.slot.as_str())
                || file.path != format!("{}.png", file.slot)
                || !slots.insert(&file.slot)
                || !digest(&file.sha256)
                || file.bytes == 0
                || file.bytes > MAX_IMAGE
            {
                return Err("资源文件清单无效".into());
            }
            total += file.bytes;
        }
        if total > MAX_ARCHIVE {
            return Err("资源总大小超过限制".into());
        }
        official_archive_url(&manifest.archive_url)?;
        Ok((manifest, hash(&raw)))
    }

    fn marker(&self) -> Result<Activation, String> {
        let path = self.root.join("active.json");
        if !path.exists() {
            return Ok(Activation::default());
        }
        let marker: Activation =
            serde_json::from_slice(&read_bounded(&path, 4096)?).map_err(|_| "资源启用记录无效")?;
        if marker
            .active
            .iter()
            .chain(marker.previous.iter())
            .any(|id| !digest(id))
        {
            return Err("资源启用记录无效".into());
        }
        Ok(marker)
    }

    fn save_marker(&self, marker: &Activation) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|_| "无法创建资源缓存目录")?;
        let mut temp =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "无法暂存资源启用记录")?;
        serde_json::to_writer(&mut temp, marker).map_err(|_| "资源启用记录编码失败")?;
        temp.as_file()
            .sync_all()
            .map_err(|_| "资源启用记录写入失败")?;
        temp.persist(self.root.join("active.json"))
            .map_err(|_| "资源启用记录替换失败")?;
        Ok(())
    }

    fn pack(&self, id: &str) -> Result<(Manifest, BTreeMap<String, String>), String> {
        if !digest(id) {
            return Err("资源版本标识无效".into());
        }
        let root = self.root.canonicalize().map_err(|_| "资源目录不可访问")?;
        let dir = root.join(id).canonicalize().map_err(|_| "资源包不存在")?;
        if !dir.starts_with(&root) {
            return Err("资源目录超出缓存范围".into());
        }
        let envelope: Envelope =
            serde_json::from_slice(&read_bounded(&dir.join("signed.json"), MAX_MANIFEST * 3)?)
                .map_err(|_| "缓存资源清单无效")?;
        let (manifest, actual_id) = self.manifest(&envelope)?;
        if actual_id != id {
            return Err("缓存资源版本不匹配".into());
        }
        let mut assets = BTreeMap::new();
        for file in &manifest.files {
            let path = dir
                .join(&file.path)
                .canonicalize()
                .map_err(|_| "资源图片不存在")?;
            if !path.starts_with(&dir) {
                return Err("资源图片路径超出缓存范围".into());
            }
            let bytes = read_bounded(&path, MAX_IMAGE)?;
            if bytes.len() != file.bytes || hash(&bytes) != file.sha256 {
                return Err("缓存资源校验失败".into());
            }
            validate_png(&bytes)?;
            assets.insert(
                file.slot.clone(),
                format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
            );
        }
        Ok((manifest, assets))
    }

    /// Re-entering the process never automatically retries an unconfirmed pack.
    pub fn recover_startup(&self) -> Result<(), String> {
        let mut marker = self.marker()?;
        if marker.active.is_some() && !marker.confirmed {
            marker.active = marker.previous.take();
            marker.confirmed = true;
            self.save_marker(&marker)?;
        }
        Ok(())
    }

    pub fn view(&self) -> PackView {
        let mut marker = match self.marker() {
            Ok(v) => v,
            Err(error) => {
                return PackView {
                    warning: Some(error),
                    ..Default::default()
                }
            }
        };
        let Some(id) = marker.active.clone() else {
            return PackView::default();
        };
        match self.pack(&id) {
            Ok((manifest, assets)) => PackView {
                id: Some(id),
                version: Some(manifest.version),
                can_rollback: true,
                pending_confirmation: !marker.confirmed,
                assets,
                warning: None,
            },
            Err(error) => {
                marker.active = marker.previous.take();
                marker.confirmed = true;
                // Failure to persist must not load the invalid pack in this process.
                let _ = self.save_marker(&marker);
                let fallback = marker.active.as_deref().and_then(|previous| {
                    self.pack(previous)
                        .ok()
                        .map(|(manifest, assets)| (previous.to_string(), manifest, assets))
                });
                match fallback {
                    Some((id, manifest, assets)) => PackView {
                        id: Some(id),
                        version: Some(manifest.version),
                        can_rollback: true,
                        assets,
                        warning: Some(error),
                        pending_confirmation: false,
                    },
                    None => PackView {
                        warning: Some(error),
                        ..Default::default()
                    },
                }
            }
        }
    }

    pub fn confirm(&self, expected_id: &str) -> Result<(), String> {
        let mut marker = self.marker()?;
        if marker.active.as_deref() != Some(expected_id) {
            return Err("资源版本已变化，请刷新后重试".into());
        }
        self.pack(expected_id)?;
        marker.confirmed = true;
        self.save_marker(&marker)
    }

    pub fn rollback(&self, expected_id: &str) -> Result<PackView, String> {
        let mut marker = self.marker()?;
        if marker.active.as_deref() != Some(expected_id) {
            return Err("资源版本已变化，请刷新后重试".into());
        }
        marker.active = marker.previous.take();
        marker.confirmed = true;
        self.save_marker(&marker)?;
        Ok(self.view())
    }

    pub fn install_verified_archive(
        &self,
        envelope: &Envelope,
        bytes: &[u8],
    ) -> Result<PackView, String> {
        let (manifest, id) = self.manifest(envelope)?;
        let current = self.install_eligible(manifest.version)?;
        if bytes.len() != manifest.archive_bytes || hash(bytes) != manifest.archive_sha256 {
            return Err("资源下载不完整或哈希不匹配".into());
        }
        fs::create_dir_all(&self.root).map_err(|_| "无法创建资源目录")?;
        let stage = tempfile::tempdir_in(&self.root).map_err(|_| "无法暂存资源包")?;
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "资源 ZIP 无效")?;
        if archive.len() != manifest.files.len() {
            return Err("资源包含未声明文件或缺少文件".into());
        }
        let mut seen = HashSet::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|_| "资源 ZIP 无法读取")?;
            let file = manifest
                .files
                .iter()
                .find(|file| file.path == entry.name())
                .ok_or("资源包含未声明文件")?;
            if !seen.insert(file.path.clone())
                || entry.is_dir()
                || entry
                    .unix_mode()
                    .is_some_and(|mode| mode & 0o170000 == 0o120000)
                || entry.size() != file.bytes as u64
            {
                return Err("资源 ZIP 条目无效".into());
            }
            let mut content = Vec::new();
            entry
                .by_ref()
                .take(file.bytes as u64 + 1)
                .read_to_end(&mut content)
                .map_err(|_| "资源解压失败")?;
            if content.len() != file.bytes || hash(&content) != file.sha256 {
                return Err("资源图片哈希不匹配".into());
            }
            validate_png(&content)?;
            fs::write(stage.path().join(&file.path), content).map_err(|_| "资源缓存写入失败")?;
        }
        fs::write(
            stage.path().join("signed.json"),
            serde_json::to_vec(envelope).map_err(|_| "资源签名保存失败")?,
        )
        .map_err(|_| "资源签名保存失败")?;
        let target = self.root.join(&id);
        if target.exists() {
            self.pack(&id)?;
        } else {
            fs::rename(stage.path(), &target).map_err(|_| "资源缓存启用失败")?;
        }
        self.pack(&id)?;
        self.save_marker(&Activation {
            active: Some(id),
            previous: current.id,
            confirmed: false,
        })?;
        Ok(self.view())
    }

    fn install_eligible(&self, version: u64) -> Result<PackView, String> {
        let current = self.view();
        if current.pending_confirmation {
            return Err("上一个资源包尚未完成显示校验".into());
        }
        if current
            .version
            .is_some_and(|installed| installed >= version)
        {
            return Err("当前资源已是此版本或更新版本".into());
        }
        Ok(current)
    }

    pub async fn check(&self) -> Result<Option<u64>, String> {
        let Some(envelope) = fetch_envelope().await? else {
            return Ok(None);
        };
        let (manifest, _) = self.manifest(&envelope)?;
        Ok((self.view().version.unwrap_or(0) < manifest.version).then_some(manifest.version))
    }

    pub async fn install(&self) -> Result<PackView, String> {
        let envelope = fetch_envelope().await?.ok_or("尚未发布独立资源更新")?;
        let (manifest, _) = self.manifest(&envelope)?;
        // Avoid downloading an archive already installed or awaiting display confirmation.
        let preflight = self.clone();
        let version = manifest.version;
        tokio::task::spawn_blocking(move || preflight.install_eligible(version))
            .await
            .map_err(|_| "资源更新准备未完成")??;
        let bytes = download(&manifest.archive_url, manifest.archive_bytes)
            .await?
            .ok_or("资源包不存在")?;
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.install_verified_archive(&envelope, &bytes))
            .await
            .map_err(|_| "资源解压任务未完成")?
    }
}

fn official_archive_url(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|_| "资源下载地址无效")?;
    let official = match url.host_str() {
        Some("tools.treasuregrove.art") => url.path().starts_with("/lolicode/resources/"),
        Some("lolicode.com") => url.path().starts_with("/downloads/resources/"),
        _ => false,
    };
    if !official
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err("资源下载地址不属于官方资源目录".into());
    }
    Ok(())
}

async fn download(url: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
    official_archive_url(url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "资源连接无法初始化")?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "资源连接失败，继续使用本地资源")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success()
        || response.content_length().is_some_and(|n| n > limit as u64)
    {
        return Err("资源下载响应无效，继续使用本地资源".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "资源下载中断，继续使用本地资源")?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("资源下载超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
}

async fn fetch_envelope() -> Result<Option<Envelope>, String> {
    download(FEED, MAX_MANIFEST * 3)
        .await?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| "资源更新清单无效".into()))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../test-fixtures/resource-packs.json")).unwrap()
    }
    fn store(root: &Path) -> ResourceStore {
        ResourceStore::new(
            root.to_path_buf(),
            fixture()["publicKey"].as_str().unwrap().into(),
            "4.0.20".into(),
        )
    }
    fn case(name: &str) -> (Envelope, Vec<u8>) {
        let f = fixture();
        (
            serde_json::from_value(f[name]["envelope"].clone()).unwrap(),
            STANDARD
                .decode(f[name]["archive"].as_str().unwrap())
                .unwrap(),
        )
    }
    fn apply(store: &ResourceStore, name: &str, confirm: bool) -> PackView {
        let (envelope, bytes) = case(name);
        let view = store.install_verified_archive(&envelope, &bytes).unwrap();
        if confirm {
            store.confirm(view.id.as_deref().unwrap()).unwrap();
        }
        store.view()
    }

    #[test]
    fn verified_pack_survives_restart_and_unconfirmed_pack_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("packs");
        let current = store(&root);
        let first = apply(&current, "first", true);
        assert_eq!(first.version, Some(1));
        assert!(first.assets["companion"].starts_with("data:image/png;base64,"));
        let new = apply(&current, "second", false);
        assert!(new.pending_confirmation);
        let restarted = store(&root);
        restarted.recover_startup().unwrap();
        let recovered = restarted.view();
        assert_eq!(recovered.version, Some(1));
        assert_eq!(recovered.assets, first.assets);
        assert!(!recovered.pending_confirmation);
        assert!(root.join(new.id.unwrap()).is_dir()); // rollback never deletes data
    }

    #[test]
    fn failed_first_render_restores_bundled_assets_and_stale_receipts_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let current = store(dir.path());
        let first = apply(&current, "first", false);
        current.recover_startup().unwrap();
        assert!(current.view().assets.is_empty());
        assert!(current.confirm(first.id.as_deref().unwrap()).is_err());
        let first = apply(&current, "first", true);
        let second = apply(&current, "second", true);
        assert!(current.rollback(first.id.as_deref().unwrap()).is_err());
        assert_eq!(
            current
                .rollback(second.id.as_deref().unwrap())
                .unwrap()
                .version,
            Some(1)
        );
        assert!(current
            .rollback(first.id.as_deref().unwrap())
            .unwrap()
            .assets
            .is_empty());
    }

    #[test]
    fn bad_signatures_hashes_paths_and_compatibility_cannot_replace_active_resources() {
        let dir = tempfile::tempdir().unwrap();
        let current = store(dir.path());
        let first = apply(&current, "first", true);
        for name in [
            "incompatible",
            "unsafePath",
            "wrongFileHash",
            "extraFile",
            "undeclaredFile",
            "symlink",
            "disallowedOrigin",
        ] {
            let (envelope, bytes) = case(name);
            assert!(
                current.install_verified_archive(&envelope, &bytes).is_err(),
                "{name}"
            );
            assert_eq!(current.view().id, first.id);
        }
        let (mut envelope, mut bytes) = case("second");
        bytes[0] ^= 1;
        assert!(current.install_verified_archive(&envelope, &bytes).is_err());
        let mut raw = STANDARD.decode(&envelope.manifest).unwrap();
        raw[0] ^= 1;
        envelope.manifest = STANDARD.encode(raw);
        assert!(current
            .install_verified_archive(&envelope, &case("second").1)
            .is_err());
        assert_eq!(current.view().id, first.id);
        assert!(current
            .install_verified_archive(&case("first").0, &case("first").1)
            .is_err());
    }

    #[test]
    fn corrupted_cache_falls_back_without_touching_profile_or_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("packs");
        let sentinel = dir.path().join("cc-switch.db");
        fs::write(&sentinel, b"user profile and keys stay here").unwrap();
        let current = store(&root);
        let first = apply(&current, "first", true);
        let second = apply(&current, "second", true);
        fs::write(
            root.join(second.id.as_ref().unwrap()).join("companion.png"),
            b"corrupted",
        )
        .unwrap();
        let recovered = current.view();
        assert_eq!(recovered.version, Some(1));
        assert!(recovered.warning.is_some());
        assert_eq!(recovered.assets, first.assets);
        assert_eq!(
            fs::read(&sentinel).unwrap(),
            b"user profile and keys stay here"
        );
        fs::write(
            root.join("active.json"),
            br#"{"active":"../cc-switch.db","previous":null,"confirmed":true}"#,
        )
        .unwrap();
        assert!(current.view().assets.is_empty());
        assert!(current.view().warning.is_some());
        assert_eq!(
            fs::read(&sentinel).unwrap(),
            b"user profile and keys stay here"
        );
    }

    #[test]
    fn arbitrary_urls_and_active_formats_are_rejected() {
        for value in [
            "http://tools.treasuregrove.art/lolicode/resources/x",
            "https://tools.treasuregrove.art.evil.test/lolicode/resources/x",
            "https://user@tools.treasuregrove.art/lolicode/resources/x",
            "https://lolicode.com/api/account",
            "https://127.0.0.1/assets.zip",
            "file:///C:/secret.png",
        ] {
            assert!(official_archive_url(value).is_err());
        }
        assert!(validate_png(b"<svg onload='alert(1)'/>").is_err());
        assert!(validate_png(b"\x89PNG\r\n\x1a\ntruncated").is_err());
    }
}
