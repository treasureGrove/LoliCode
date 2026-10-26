//! A small, public navigation directory. No account or model credentials leave the app.
use crate::{
    database::Database,
    services::builtin_apps::{self, BuiltinApp},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const CACHE_KEY: &str = "lolicode_discovery_catalog_v1";
const FAVORITES_KEY: &str = "lolicode_discovery_favorites_v1";
pub const CATALOG_URL: &str = "https://lolicode.com/desktop-assets/discovery-v1.json";
const MAX_BYTES: usize = 256 * 1024;
const BUNDLED: &str = include_str!("../../../src/public/discovery-v1.json");

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LocalizedText {
    pub zh: String,
    pub en: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub category: String,
    pub url: String,
    pub source_url: String,
    pub summary: LocalizedText,
    pub offer: String,
    pub access: String,
    pub limits: LocalizedText,
    pub checked_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<Preview>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preview {
    pub filename: String,
    pub sha256: String,
    pub captured_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewImage {
    pub data_url: String,
    pub captured_at: String,
    pub stale: bool,
}

const PREVIEW_BYTES: [(&str, &[u8]); 3] = [
    (
        "artificial-analysis",
        include_bytes!("../../../src/assets/discovery/artificial-analysis.jpg"),
    ),
    (
        "livebench",
        include_bytes!("../../../src/assets/discovery/livebench.jpg"),
    ),
    (
        "aider",
        include_bytes!("../../../src/assets/discovery/aider.jpg"),
    ),
];
const MAX_PREVIEW_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub schema_version: u32,
    pub revision: u64,
    pub updated_at: String,
    pub entries: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub catalog: Catalog,
    pub source: &'static str,
    pub favorites: Vec<String>,
}

fn valid_date(value: &str) -> bool {
    value.len() == 10 && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}
fn valid_link(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|u| {
        u.scheme()=="https" && u.username().is_empty() && u.password().is_none()
            && u.port().is_none() && matches!(u.host(),Some(url::Host::Domain(domain))
                if domain.trim_end_matches('.').contains('.') && !domain.trim_end_matches('.').ends_with(".local") && !domain.trim_end_matches('.').ends_with(".localhost"))
    })
}
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max
        && !value.chars().any(|c| c.is_control())
}

pub fn parse(raw: &str) -> Result<Catalog, String> {
    if raw.len() > MAX_BYTES {
        return Err("目录超过大小限制".into());
    }
    let catalog: Catalog = serde_json::from_str(raw).map_err(|_| "目录格式无效")?;
    if catalog.schema_version != 1
        || catalog.revision == 0
        || !valid_date(&catalog.updated_at)
        || catalog.entries.is_empty()
        || catalog.entries.len() > 100
    {
        return Err("目录版本或条目数量无效".into());
    }
    let mut ids = HashSet::new();
    for e in &catalog.entries {
        let ranking = e.kind == "rankings";
        if e.id.is_empty()
            || e.id.len() > 64
            || !e
                .id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || !ids.insert(e.id.clone())
            || (!ranking && e.kind != "free-ai")
            || !["general", "coding", "multimodal", "platform"].contains(&e.category.as_str())
            || !["public", "account", "varies"].contains(&e.access.as_str())
            || (ranking && e.offer != "ranking")
            || (!ranking && !["free-tier", "limited-free", "trial"].contains(&e.offer.as_str()))
            || !text(&e.name, 100)
            || !text(&e.summary.zh, 400)
            || !text(&e.summary.en, 600)
            || !text(&e.limits.zh, 400)
            || !text(&e.limits.en, 600)
            || !valid_link(&e.url)
            || !valid_link(&e.source_url)
            || !valid_date(&e.checked_at)
            || e.expires_at.as_ref().is_some_and(|v| !valid_date(v))
            || e.preview.as_ref().is_some_and(|p| {
                !ranking
                    || !valid_date(&p.captured_at)
                    || p.sha256.len() != 64
                    || !p
                        .sha256
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    || !["png", "jpg"].iter().any(|ext| {
                        p.filename
                            == format!("{}-{}.{}", e.id, &p.sha256[..12.min(p.sha256.len())], ext)
                    })
            })
        {
            return Err("目录包含无效条目或链接".into());
        }
    }
    Ok(catalog)
}

fn current(db: &Database) -> Result<(Catalog, &'static str), String> {
    let bundled = parse(BUNDLED)?;
    if let Some(raw) = db.get_setting(CACHE_KEY).map_err(|e| e.to_string())? {
        if let Ok(cached) = parse(&raw) {
            if cached.revision >= bundled.revision {
                return Ok((cached, "cache"));
            }
        }
    }
    Ok((bundled, "builtin"))
}
fn check_app(db: &Database, app: BuiltinApp) -> Result<(), String> {
    if !matches!(app, BuiltinApp::Rankings | BuiltinApp::FreeAi) {
        return Err("应用不支持导航目录".into());
    }
    builtin_apps::require(db, app)
}
pub fn snapshot(db: &Database, app: BuiltinApp) -> Result<Snapshot, String> {
    check_app(db, app)?;
    let (catalog, source) = current(db)?;
    let favorites = db
        .get_setting(FAVORITES_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default();
    Ok(Snapshot {
        catalog,
        source,
        favorites,
    })
}

fn store(db: &Database, next: Catalog) -> Result<(), String> {
    // Read/compare/write under the same lock: a late refresh cannot roll back another refresh.
    let conn = db.conn.lock().map_err(|_| "目录存储忙")?;
    let old = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [CACHE_KEY],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| parse(&s).ok())
        .unwrap_or(parse(BUNDLED)?);
    if next.revision < old.revision || (next.revision == old.revision && next != old) {
        return Err("目录修订较旧或相同修订内容不一致，已保留原目录".into());
    }
    let raw = serde_json::to_string(&next).map_err(|_| "目录格式无效")?;
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![CACHE_KEY,raw]).map_err(|e|e.to_string())?;
    Ok(())
}

async fn download(client: &reqwest::Client, endpoint: &str) -> Result<Catalog, String> {
    let mut response = client
        .get(endpoint)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| "在线目录暂不可用，已保留当前内容")?;
    if !response.status().is_success() {
        return Err("在线目录暂不可用，已保留当前内容".into());
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err("在线目录超过大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "目录下载中断，已保留当前内容")?
    {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("在线目录超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse(std::str::from_utf8(&bytes).map_err(|_| "目录编码无效")?)
}

pub async fn refresh(db: &Database, app: BuiltinApp) -> Result<Snapshot, String> {
    check_app(db, app)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("LoliCode-Discovery/1")
        .build()
        .map_err(|_| "无法连接目录服务")?;
    let catalog = download(&client, CATALOG_URL).await?;
    store(db, catalog)?;
    snapshot(db, app)
}

pub fn favorite(db: &Database, app: BuiltinApp, id: &str, saved: bool) -> Result<Snapshot, String> {
    check_app(db, app)?;
    let (catalog, _) = current(db)?;
    if !catalog.entries.iter().any(|e| {
        e.id == id
            && e.kind
                == if app == BuiltinApp::Rankings {
                    "rankings"
                } else {
                    "free-ai"
                }
    }) {
        return Err("目录条目不存在".into());
    }
    {
        let conn = db.conn.lock().map_err(|_| "收藏存储忙")?;
        let mut ids = conn
            .query_row(
                "SELECT value FROM settings WHERE key=?1",
                [FAVORITES_KEY],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default();
        ids.retain(|x| x != id);
        if saved {
            ids.push(id.to_string());
        }
        ids.sort();
        ids.dedup();
        if ids.len() > 1000 {
            return Err("收藏数量超过限制".into());
        }
        let raw = serde_json::to_string(&ids).map_err(|_| "收藏格式无效")?;
        conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![FAVORITES_KEY,raw]).map_err(|e|e.to_string())?;
    }
    snapshot(db, app)
}

fn image(
    data: &[u8],
    expected: &str,
    captured_at: &str,
    stale: bool,
) -> Result<PreviewImage, String> {
    if data.len() < 24
        || data.len() > MAX_PREVIEW_BYTES
        || format!("{:x}", Sha256::digest(data)) != expected
    {
        return Err("榜单图片校验失败".into());
    }
    let reader = ::image::ImageReader::new(std::io::Cursor::new(data))
        .with_guessed_format()
        .map_err(|_| "榜单图片格式无效")?;
    let mime = match reader.format() {
        Some(::image::ImageFormat::Png) => "image/png",
        Some(::image::ImageFormat::Jpeg) => "image/jpeg",
        _ => return Err("榜单图片格式无效".into()),
    };
    let (w, h) = reader.into_dimensions().map_err(|_| "榜单图片尺寸无效")?;
    if w == 0 || h == 0 || w > 5000 || h > 5000 || (w as u64) * (h as u64) > 20_000_000 {
        return Err("榜单图片尺寸无效".into());
    }
    Ok(PreviewImage {
        data_url: format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(data)
        ),
        captured_at: captured_at.into(),
        stale,
    })
}

#[derive(Deserialize, Serialize)]
struct SavedPreview {
    sha256: String,
    captured_at: String,
    data: String,
}

async fn preview_with_client(
    db: &Database,
    id: &str,
    client: &reqwest::Client,
    base: &str,
) -> Result<PreviewImage, String> {
    builtin_apps::require(db, BuiltinApp::Rankings)?;
    let (catalog, _) = current(db)?;
    let entry = catalog
        .entries
        .iter()
        .find(|e| e.id == id && e.kind == "rankings")
        .ok_or("榜单不存在")?;
    let expected = entry.preview.as_ref().ok_or("此来源暂未提供快照")?;
    let key = format!("lolicode_discovery_preview_{id}_v1");
    let saved = db
        .get_setting(&key)
        .map_err(|e| e.to_string())?
        .filter(|raw| raw.len() < 3 * 1024 * 1024)
        .and_then(|raw| serde_json::from_str::<SavedPreview>(&raw).ok());
    let cached = saved.as_ref().and_then(|old| {
        if !valid_date(&old.captured_at) {
            return None;
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(&old.data)
            .ok()?;
        image(
            &data,
            &old.sha256,
            &old.captured_at,
            old.sha256 != expected.sha256,
        )
        .ok()
    });
    if let Some(ref old) = cached {
        if !old.stale {
            return Ok(old.clone());
        }
    }
    let bundled = PREVIEW_BYTES
        .iter()
        .find(|(name, _)| *name == id)
        .and_then(|(_, data)| {
            let original = parse(BUNDLED)
                .ok()?
                .entries
                .into_iter()
                .find(|e| e.id == id)?
                .preview?;
            image(
                data,
                &original.sha256,
                &original.captured_at,
                original.sha256 != expected.sha256,
            )
            .ok()
        });
    if let Some(ref original) = bundled {
        if !original.stale {
            return Ok(original.clone());
        }
    }
    let fetched = async {
        let mut response = client
            .get(format!("{base}{}", expected.filename))
            .send()
            .await
            .map_err(|_| "快照暂不可用")?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|n| n > MAX_PREVIEW_BYTES as u64)
        {
            return Err("快照暂不可用");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "快照下载中断")? {
            if bytes.len() + chunk.len() > MAX_PREVIEW_BYTES {
                return Err("快照超过大小限制");
            }
            bytes.extend_from_slice(&chunk);
        }
        image(&bytes, &expected.sha256, &expected.captured_at, false).map_err(|_| "快照校验失败")
    }
    .await;
    match fetched {
        Ok(result) => {
            let saved = SavedPreview {
                sha256: expected.sha256.clone(),
                captured_at: expected.captured_at.clone(),
                data: result
                    .data_url
                    .split_once(',')
                    .ok_or("图片缓存无效")?
                    .1
                    .into(),
            };
            let _ = db.set_setting(
                &key,
                &serde_json::to_string(&saved).map_err(|_| "图片缓存无效")?,
            );
            Ok(result)
        }
        Err(_) => cached
            .or(bundled)
            .ok_or_else(|| "暂无可用榜单快照，请稍后更新目录".into()),
    }
}

pub async fn preview(db: &Database, id: &str) -> Result<PreviewImage, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("LoliCode-Discovery/1")
        .build()
        .map_err(|_| "快照服务不可用")?;
    preview_with_client(
        db,
        id,
        &client,
        "https://lolicode.com/desktop-assets/rankings/",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Database {
        let d = Database::memory().unwrap();
        builtin_apps::set_enabled(&d, BuiltinApp::Rankings, true).unwrap();
        builtin_apps::set_enabled(&d, BuiltinApp::FreeAi, true).unwrap();
        d
    }

    #[tokio::test]
    async fn bundled_previews_are_local_and_corrupt_remote_images_keep_previous_snapshot() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let d = db();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for id in ["artificial-analysis", "livebench", "aider"] {
            let local = preview_with_client(&d, id, &client, "http://127.0.0.1:1/")
                .await
                .unwrap();
            assert!(!local.stale);
        }
        let original =
            preview_with_client(&d, "artificial-analysis", &client, "http://127.0.0.1:1/")
                .await
                .unwrap();
        assert!(!original.stale);
        assert!(original.data_url.starts_with("data:image/jpeg;base64,"));
        let mut c = parse(BUNDLED).unwrap();
        c.revision += 1;
        let p = c
            .entries
            .iter_mut()
            .find(|e| e.id == "artificial-analysis")
            .unwrap()
            .preview
            .as_mut()
            .unwrap();
        p.sha256 = "a".repeat(64);
        p.filename = format!("artificial-analysis-{}.png", &p.sha256[..12]);
        store(&d, c).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut b = [0; 2048];
            s.read(&mut b).await.unwrap();
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad")
                .await
                .unwrap();
        });
        let fallback = preview_with_client(&d, "artificial-analysis", &client, &base)
            .await
            .unwrap();
        assert!(fallback.stale);
        assert_eq!(fallback.data_url, original.data_url);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn downloaded_preview_is_validated_cached_and_available_without_network() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let d = db();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        // A real, different bundled JPEG serves as the future update fixture.
        let data = PREVIEW_BYTES[1].1;
        let sha = format!("{:x}", Sha256::digest(data));
        let mut c = parse(BUNDLED).unwrap();
        c.revision += 1;
        let p = c
            .entries
            .iter_mut()
            .find(|e| e.id == "artificial-analysis")
            .unwrap()
            .preview
            .as_mut()
            .unwrap();
        p.sha256 = sha.clone();
        p.filename = format!("artificial-analysis-{}.jpg", &sha[..12]);
        p.captured_at = "2026-10-20".into();
        store(&d, c).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            s.read(&mut request).await.unwrap();
            s.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    data.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
            s.write_all(data).await.unwrap();
        });
        let downloaded = preview_with_client(&d, "artificial-analysis", &client, &endpoint)
            .await
            .unwrap();
        task.await.unwrap();
        assert!(!downloaded.stale);
        let offline =
            preview_with_client(&d, "artificial-analysis", &client, "http://127.0.0.1:1/")
                .await
                .unwrap();
        assert_eq!(offline.data_url, downloaded.data_url);
        assert_eq!(offline.captured_at, "2026-10-20");
        assert!(!offline.stale);
    }
    #[test]
    fn bundled_is_valid_and_apps_are_opt_in() {
        let d = Database::memory().unwrap();
        assert!(snapshot(&d, BuiltinApp::Rankings).is_err());
        let catalog = parse(BUNDLED).unwrap();
        assert!(catalog.entries.iter().any(|e| e.id == "opencode-zen"));
        assert_eq!(
            snapshot(&db(), BuiltinApp::Rankings).unwrap().source,
            "builtin"
        );
    }
    #[test]
    fn favorites_survive_removal_and_catalog_refresh() {
        let d = db();
        favorite(&d, BuiltinApp::FreeAi, "opencode-zen", true).unwrap();
        builtin_apps::set_enabled(&d, BuiltinApp::FreeAi, false).unwrap();
        assert!(snapshot(&d, BuiltinApp::FreeAi).is_err());
        builtin_apps::set_enabled(&d, BuiltinApp::FreeAi, true).unwrap();
        let mut next = parse(BUNDLED).unwrap();
        next.revision += 1;
        next.entries.retain(|e| e.id != "opencode-zen");
        store(&d, next).unwrap();
        assert_eq!(
            snapshot(&d, BuiltinApp::FreeAi).unwrap().favorites,
            vec!["opencode-zen"]
        );
        assert!(favorite(&d, BuiltinApp::Rankings, "openrouter-free", true).is_err());
    }
    #[test]
    fn bad_cache_and_older_update_do_not_destroy_directory() {
        let d = db();
        d.set_setting(CACHE_KEY, "invalid").unwrap();
        assert_eq!(
            snapshot(&d, BuiltinApp::Rankings).unwrap().source,
            "builtin"
        );
        let mut next = parse(BUNDLED).unwrap();
        next.revision += 1;
        store(&d, next.clone()).unwrap();
        assert!(store(&d, parse(BUNDLED).unwrap()).is_err());
        assert_eq!(snapshot(&d, BuiltinApp::Rankings).unwrap().catalog, next);
    }
    #[test]
    fn rejects_unsafe_links_duplicate_ids_and_wrong_offers() {
        for address in [
            "javascript:alert(1)",
            "https://127.0.0.1/",
            "https://localhost/",
            "https://user:pass@example.com/",
            "http://example.com/",
        ] {
            let mut c = parse(BUNDLED).unwrap();
            c.entries[0].url = address.into();
            assert!(parse(&serde_json::to_string(&c).unwrap()).is_err());
        }
        let mut c = parse(BUNDLED).unwrap();
        c.entries.push(c.entries[0].clone());
        assert!(parse(&serde_json::to_string(&c).unwrap()).is_err());
        let mut c = parse(BUNDLED).unwrap();
        c.entries[0].offer = "free-tier".into();
        assert!(parse(&serde_json::to_string(&c).unwrap()).is_err());
    }
    #[tokio::test]
    async fn downloads_a_real_http_fixture_and_preserves_cache_on_failure() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            for body in [BUNDLED, "{broken}"] {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = [0; 2048];
                s.read(&mut buf).await.unwrap();
                s.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let d = db();
        let good = download(&client, &endpoint).await.unwrap();
        store(&d, good.clone()).unwrap();
        assert!(download(&client, &endpoint).await.is_err());
        assert_eq!(snapshot(&d, BuiltinApp::Rankings).unwrap().catalog, good);
        task.await.unwrap();
    }
}
