//! Whole-renderer packages. Only publisher-signed code matching this exact native
//! build contract may load; downloaded data never changes CSP, IPC or DB schemas.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const FEED: &str = "https://tools.treasuregrove.art/lolicode/renderer/latest.json";
const MAX_MANIFEST: usize = 256 * 1024;
const MAX_ARCHIVE: usize = 96 * 1024 * 1024;
const MAX_FILE: usize = 32 * 1024 * 1024;
const MAX_TOTAL: usize = 128 * 1024 * 1024;

/// Compiled fingerprint of native sources, dependency lock and permissions.
/// Canonical LF and length framing match the publisher's Node implementation.
pub fn native_contract() -> String {
    env!("LOLICODE_NATIVE_CONTRACT").into()
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn guard(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("界面更新缓存必须为绝对路径".into());
    }
    for p in path.ancestors() {
        match fs::symlink_metadata(p) {
            Ok(m) if linked(&m) => return Err("界面更新缓存不能经过符号链接或目录联接".into()),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法检查界面更新缓存".into()),
        }
    }
    Ok(())
}
fn read(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    guard(path)?;
    let m = fs::symlink_metadata(path).map_err(|_| "界面更新文件不可读取")?;
    if !m.is_file() {
        return Err("界面更新需要普通文件".into());
    }
    let mut b = Vec::new();
    fs::File::open(path)
        .map_err(|_| "界面更新文件不可读取")?
        .take(limit as u64 + 1)
        .read_to_end(&mut b)
        .map_err(|_| "界面更新读取失败")?;
    if b.len() > limit {
        return Err("界面更新文件超过限制".into());
    }
    Ok(b)
}
fn file_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 240 || path.starts_with('/') {
        return false;
    }
    let parts: Vec<_> = path.split('/').collect();
    if parts.iter().any(|part| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.starts_with('.')
            || part.ends_with('.')
            || !part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            || {
                let stem = part.split('.').next().unwrap().to_ascii_lowercase();
                matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
                    || (stem.len() == 4
                        && (stem.starts_with("com") || stem.starts_with("lpt"))
                        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
            }
    }) {
        return false;
    }
    if path == "index.html" {
        return true;
    }
    if !path.starts_with("assets/") {
        return false;
    }
    path.rsplit('.').next().is_some_and(|ext| {
        matches!(
            ext,
            "js" | "css"
                | "png"
                | "jpg"
                | "jpeg"
                | "webp"
                | "gif"
                | "svg"
                | "ico"
                | "woff"
                | "woff2"
                | "ttf"
                | "otf"
        )
    })
}
pub fn official_url(raw: &str) -> Result<(), String> {
    let u = url::Url::parse(raw).map_err(|_| "界面更新地址无效")?;
    let valid = match u.host_str() {
        Some("tools.treasuregrove.art") => u.path().starts_with("/lolicode/renderer/"),
        Some("lolicode.com") => u.path().starts_with("/downloads/renderer/"),
        Some("pub-250df9737586416fbd6e8cb0a843b249.r2.dev") => {
            u.path().starts_with("/lolicode/renderer/")
        }
        _ => false,
    };
    if !valid
        || u.scheme() != "https"
        || u.as_str() != raw
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || raw.contains('\\')
    {
        return Err("界面更新仅接受官方 HTTPS 目录".into());
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub manifest: String,
    pub signature: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: u32,
    pub kind: String,
    pub version: u64,
    pub native_version: String,
    pub native_contract: String,
    pub archive_url: String,
    pub archive_sha256: String,
    pub archive_bytes: usize,
    pub files: Vec<PackFile>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackFile {
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Pending {
    Bundled,
    Pack { id: String },
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Activation {
    active: Option<String>,
    previous: Option<String>,
    next: Option<Pending>,
    boot_ticket: Option<String>,
    highest_version: u64,
}
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackView {
    pub active_id: Option<String>,
    pub active_version: Option<u64>,
    pub staged_version: Option<u64>,
    pub restart_required: bool,
    pub pending_confirmation: bool,
    pub highest_version: u64,
    pub can_rollback: bool,
}
pub struct LoadedPack {
    pub id: String,
    pub version: u64,
    pub files: BTreeMap<String, Vec<u8>>,
}
#[derive(Default)]
pub struct Boot {
    pub pack: Option<LoadedPack>,
    pub ticket: Option<String>,
    pub warning: Option<String>,
}
pub struct RendererStore {
    root: PathBuf,
    key: String,
    native_version: String,
    contract: String,
    gate: Mutex<()>,
}
impl RendererStore {
    pub fn new(root: PathBuf, key: String, native_version: String, contract: String) -> Self {
        Self {
            root,
            key,
            native_version,
            contract,
            gate: Mutex::new(()),
        }
    }
    pub fn inspect(&self, envelope: &Envelope) -> Result<(Manifest, String), String> {
        if envelope.manifest.len() > MAX_MANIFEST * 2 || envelope.signature.len() > 16384 {
            return Err("界面签名清单超过限制".into());
        }
        let raw = STANDARD
            .decode(&envelope.manifest)
            .map_err(|_| "界面清单编码无效")?;
        if raw.len() > MAX_MANIFEST {
            return Err("界面清单超过限制".into());
        }
        let key = STANDARD.decode(&self.key).map_err(|_| "界面公钥无效")?;
        let key = PublicKey::decode(std::str::from_utf8(&key).map_err(|_| "界面公钥无效")?)
            .map_err(|_| "界面公钥无效")?;
        let sig = STANDARD
            .decode(&envelope.signature)
            .map_err(|_| "界面签名编码无效")?;
        let sig = Signature::decode(std::str::from_utf8(&sig).map_err(|_| "界面签名无效")?)
            .map_err(|_| "界面签名无效")?;
        key.verify(&raw, &sig, false)
            .map_err(|_| "界面签名校验失败，保留本地界面")?;
        let m: Manifest = serde_json::from_slice(&raw).map_err(|_| "界面清单格式无效")?;
        if m.format != 1
            || m.kind != "lolicode-renderer"
            || m.version == 0
            || m.version > 9_007_199_254_740_991
            || m.native_version != self.native_version
            || m.native_contract != self.contract
            || !digest(&m.native_contract)
        {
            return Err("界面更新与当前原生版本或接口不兼容，请先更新应用".into());
        }
        official_url(&m.archive_url)?;
        if m.archive_bytes == 0
            || m.archive_bytes > MAX_ARCHIVE
            || !digest(&m.archive_sha256)
            || m.files.is_empty()
            || m.files.len() > 512
        {
            return Err("界面包清单超过限制".into());
        }
        let mut seen = HashSet::new();
        let mut total = 0usize;
        for f in &m.files {
            if !file_path(&f.path)
                || !seen.insert(f.path.to_ascii_lowercase())
                || f.bytes == 0
                || f.bytes > MAX_FILE
                || !digest(&f.sha256)
                || (f.path == "index.html" && f.bytes > 128 * 1024)
            {
                return Err("界面包文件声明无效".into());
            }
            total = total.checked_add(f.bytes).ok_or("界面包大小溢出")?;
        }
        if total > MAX_TOTAL
            || !m.files.iter().any(|f| f.path == "index.html")
            || !m.files.iter().any(|f| f.path.ends_with(".js"))
        {
            return Err("界面包缺少入口或超过大小限制".into());
        }
        Ok((m, hash(&raw)))
    }
    fn marker(&self) -> Result<Activation, String> {
        guard(&self.root)?;
        let path = self.root.join("active.json");
        let raw = match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Activation::default()),
            _ => read(&path, 8192)?,
        };
        let m: Activation =
            serde_json::from_slice(&raw).map_err(|_| "界面启用记录损坏，原始记录已保留")?;
        if m.active
            .iter()
            .chain(m.previous.iter())
            .any(|id| !digest(id))
            || matches!(&m.next,Some(Pending::Pack{id}) if !digest(id))
            || m.boot_ticket
                .as_ref()
                .is_some_and(|s| uuid::Uuid::parse_str(s).is_err())
            || (m.boot_ticket.is_some() && (m.active.is_none() || m.next.is_some()))
            || (m.active.is_some() && m.active == m.previous)
        {
            return Err("界面启用记录无效，原始记录已保留".into());
        }
        Ok(m)
    }
    fn save(&self, m: &Activation) -> Result<(), String> {
        guard(&self.root)?;
        fs::create_dir_all(&self.root).map_err(|_| "无法创建界面更新缓存")?;
        let mut temp =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "无法暂存界面状态")?;
        temp.write_all(&serde_json::to_vec(m).map_err(|_| "界面状态编码失败")?)
            .map_err(|_| "界面状态写入失败")?;
        temp.as_file().sync_all().map_err(|_| "界面状态同步失败")?;
        temp.persist(self.root.join("active.json"))
            .map_err(|_| "界面状态替换失败")?;
        Ok(())
    }
    fn manifest_for(&self, id: &str) -> Result<(Manifest, String), String> {
        if !digest(id) {
            return Err("界面版本标识无效".into());
        }
        let e: Envelope = serde_json::from_slice(&read(
            &self.root.join(id).join("signed.json"),
            MAX_MANIFEST * 3,
        )?)
        .map_err(|_| "缓存界面签名无效")?;
        let (m, actual) = self.inspect(&e)?;
        if actual != id {
            return Err("缓存界面身份不匹配".into());
        }
        Ok((m, actual))
    }
    fn load_pack(&self, id: &str) -> Result<LoadedPack, String> {
        let (m, _) = self.manifest_for(id)?;
        let mut files = BTreeMap::new();
        for f in m.files {
            let bytes = read(&self.root.join(id).join(&f.path), f.bytes)?;
            if bytes.len() != f.bytes || hash(&bytes) != f.sha256 {
                return Err("缓存界面文件不完整或已改变".into());
            }
            files.insert(f.path, bytes);
        }
        Ok(LoadedPack {
            id: id.into(),
            version: m.version,
            files,
        })
    }
    fn view_inner(&self, m: &Activation) -> PackView {
        PackView {
            active_id: m.active.clone(),
            active_version: m
                .active
                .as_deref()
                .and_then(|id| self.manifest_for(id).ok().map(|(m, _)| m.version)),
            staged_version: match &m.next {
                Some(Pending::Pack { id }) => self.manifest_for(id).ok().map(|(m, _)| m.version),
                _ => None,
            },
            restart_required: m.next.is_some(),
            pending_confirmation: m.boot_ticket.is_some(),
            highest_version: m.highest_version,
            can_rollback: m.active.is_some(),
        }
    }
    pub fn view(&self) -> Result<PackView, String> {
        let _guard = self.gate.lock().map_err(|_| "界面更新锁不可用")?;
        Ok(self.view_inner(&self.marker()?))
    }
    /// Stage only. The running asset provider never changes under an active task.
    pub fn install_verified_archive(
        &self,
        envelope: &Envelope,
        bytes: &[u8],
    ) -> Result<PackView, String> {
        let _guard = self.gate.lock().map_err(|_| "界面更新锁不可用")?;
        let (m, id) = self.inspect(envelope)?;
        let mut marker = self.marker()?;
        if marker.next.is_some() || marker.boot_ticket.is_some() {
            return Err("上一份界面更新正在等待重启或显示确认".into());
        }
        if m.version <= marker.highest_version {
            return Err("此界面版本已经安装或被回退，不会重复应用".into());
        }
        if bytes.len() != m.archive_bytes || hash(bytes) != m.archive_sha256 {
            return Err("界面下载不完整或哈希不匹配".into());
        }
        fs::create_dir_all(&self.root).map_err(|_| "无法创建界面缓存")?;
        let stage = tempfile::tempdir_in(&self.root).map_err(|_| "无法暂存界面包")?;
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "界面 ZIP 无效")?;
        if zip.len() != m.files.len() {
            return Err("界面 ZIP 包含未声明或缺失文件".into());
        }
        let mut seen = HashSet::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|_| "界面 ZIP 读取失败")?;
            let f = m
                .files
                .iter()
                .find(|f| f.path == entry.name())
                .ok_or("界面 ZIP 包含未声明文件")?;
            if entry.is_dir()
                || !seen.insert(f.path.clone())
                || entry.size() != f.bytes as u64
                || entry
                    .unix_mode()
                    .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err("界面 ZIP 条目无效".into());
            }
            let mut raw = Vec::new();
            entry
                .by_ref()
                .take(f.bytes as u64 + 1)
                .read_to_end(&mut raw)
                .map_err(|_| "界面文件解压失败")?;
            if raw.len() != f.bytes || hash(&raw) != f.sha256 {
                return Err("界面文件哈希不匹配".into());
            }
            let target = stage.path().join(&f.path);
            fs::create_dir_all(target.parent().unwrap()).map_err(|_| "界面目录写入失败")?;
            fs::write(target, raw).map_err(|_| "界面文件写入失败")?;
        }
        fs::write(
            stage.path().join("signed.json"),
            serde_json::to_vec(envelope).map_err(|_| "界面签名编码失败")?,
        )
        .map_err(|_| "界面签名写入失败")?;
        let target = self.root.join(&id);
        if target.exists() {
            self.load_pack(&id)?;
        } else {
            fs::rename(stage.path(), &target).map_err(|_| "界面缓存启用失败")?;
        }
        self.load_pack(&id)?;
        marker.highest_version = m.version;
        marker.next = Some(Pending::Pack { id });
        self.save(&marker)?;
        Ok(self.view_inner(&marker))
    }
    /// Called once, before any application window is created. Failed selection
    /// cannot supply any hot bytes; a whole known-good pack or bundled UI wins.
    pub fn begin_boot(&self) -> Boot {
        let Ok(_guard) = self.gate.lock() else {
            return Boot {
                warning: Some("界面更新锁不可用".into()),
                ..Boot::default()
            };
        };
        let result = (|| -> Result<Boot, String> {
            let mut m = self.marker()?;
            let mut warning = None;
            let mut changed = false;
            if m.boot_ticket.take().is_some() {
                m.active = m.previous.take();
                warning = Some("上次新界面未确认启动，已回退".into());
                changed = true;
            }
            if let Some(next) = m.next.take() {
                match next {
                    Pending::Bundled => {
                        m.active = None;
                        m.previous = None;
                        m.boot_ticket = None;
                    }
                    Pending::Pack { id } => match self.load_pack(&id) {
                        Ok(_) => {
                            m.previous = m.active.take();
                            m.active = Some(id);
                            m.boot_ticket = Some(uuid::Uuid::new_v4().to_string());
                        }
                        Err(_) => {
                            warning = Some("待更新界面校验失败，继续使用原界面".into());
                        }
                    },
                }
                changed = true;
            }
            let pack = if let Some(id) = m.active.clone() {
                match self.load_pack(&id) {
                    Ok(pack) => Some(pack),
                    Err(_) => {
                        warning = Some("本地界面更新损坏，已回退到可用界面".into());
                        m.active = m.previous.take();
                        m.boot_ticket = None;
                        changed = true;
                        if let Some(previous) = m.active.clone() {
                            match self.load_pack(&previous) {
                                Ok(p) => Some(p),
                                Err(_) => {
                                    m.active = None;
                                    None
                                }
                            }
                        } else {
                            None
                        }
                    }
                }
            } else {
                None
            };
            if changed {
                self.save(&m)?;
            }
            Ok(Boot {
                pack,
                ticket: m.boot_ticket,
                warning,
            })
        })();
        result.unwrap_or_else(|error| Boot {
            warning: Some(error),
            ..Boot::default()
        })
    }
    pub fn confirm(&self, id: &str, ticket: &str) -> Result<(), String> {
        let _guard = self.gate.lock().map_err(|_| "界面更新锁不可用")?;
        let mut m = self.marker()?;
        if m.active.as_deref() != Some(id) || m.boot_ticket.as_deref() != Some(ticket) {
            return Err("界面启动回执已过期".into());
        }
        self.load_pack(id)?;
        m.boot_ticket = None;
        self.save(&m)
    }
    pub fn rollback(&self, id: &str) -> Result<PackView, String> {
        let _guard = self.gate.lock().map_err(|_| "界面更新锁不可用")?;
        let mut m = self.marker()?;
        if m.boot_ticket.is_some() {
            return Err("请先完成当前界面更新的重启与显示确认".into());
        }
        if m.active.as_deref() != Some(id) {
            return Err("界面版本已变化，请刷新后重试".into());
        }
        // Explicit recovery may cancel a waiting stage. A damaged predecessor
        // must not strand an otherwise confirmed-but-broken renderer: the
        // bundled application remains the final known-good recovery target.
        m.next = Some(match &m.previous {
            Some(id) if self.load_pack(id).is_ok() => Pending::Pack { id: id.clone() },
            _ => Pending::Bundled,
        });
        self.save(&m)?;
        Ok(self.view_inner(&m))
    }
    pub async fn check(&self) -> Result<Option<u64>, String> {
        let Some(e) = fetch_envelope().await? else {
            return Ok(None);
        };
        let (m, _) = self.inspect(&e)?;
        let v = self.view()?;
        Ok(
            (m.version > v.highest_version && !v.restart_required && !v.pending_confirmation)
                .then_some(m.version),
        )
    }
    pub async fn download(&self) -> Result<(Envelope, Vec<u8>), String> {
        self.download_feed(FEED).await
    }
    /// Explicit candidate feeds are exposed only to isolated acceptance tools,
    /// never to IPC or application preferences.
    #[cfg(feature = "test-hooks")]
    pub async fn download_candidate(&self, feed: &str) -> Result<(Envelope, Vec<u8>), String> {
        self.download_feed(feed).await
    }
    async fn download_feed(&self, feed: &str) -> Result<(Envelope, Vec<u8>), String> {
        let e = fetch_envelope_at(feed)
            .await?
            .ok_or("尚未发布适合当前应用的界面更新")?;
        let (m, _) = self.inspect(&e)?;
        let view = self.view()?;
        if view.restart_required || view.pending_confirmation || m.version <= view.highest_version {
            return Err("界面版本已安装或正在等待应用".into());
        }
        let bytes = download(&m.archive_url, m.archive_bytes)
            .await?
            .ok_or("界面资源包不存在")?;
        Ok((e, bytes))
    }
}
async fn download(url: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
    official_url(url)?;
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "LoliCode-Interface-Updater/",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "界面连接初始化失败")?;
    let mut r = client
        .get(url)
        .send()
        .await
        .map_err(|_| "界面更新连接失败，保留本地界面")?;
    if r.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !r.status().is_success() || r.content_length().is_some_and(|n| n > limit as u64) {
        return Err("界面下载响应无效".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|_| "界面下载中断，保留本地界面")?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("界面下载超过限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
}
async fn fetch_envelope() -> Result<Option<Envelope>, String> {
    fetch_envelope_at(FEED).await
}
async fn fetch_envelope_at(feed: &str) -> Result<Option<Envelope>, String> {
    download(feed, MAX_MANIFEST * 3)
        .await?
        .map(|b| serde_json::from_slice(&b).map_err(|_| "界面更新清单无效".into()))
        .transpose()
}

#[cfg(test)]
#[path = "renderer_updates_tests.rs"]
mod tests;
