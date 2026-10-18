//! Generated image previews remain scoped to the session's actual project.
//! Bytes cross private IPC; the WebView asset protocol is not widened.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use tauri::{AppHandle, Manager};

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentImage {
    data_url: String,
    media_type: String,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_agent_image(
    app: AppHandle,
    session_id: String,
    path: String,
) -> Result<AgentImage, String> {
    let project = super::agent_dispatch::session_project(&app, &session_id).await?;
    let remote = app
        .state::<crate::services::inprocess_agent::InprocessAgentState>()
        .remote_projects(&app.state::<crate::store::AppState>())
        .await;
    if remote.owns(Path::new(&project)) {
        let (_, bytes) = remote.preview_bytes(Path::new(&project), &path).await?;
        let data_url =
            crate::services::remote_agent_tools::image_data_url(&STANDARD.encode(bytes))?;
        let media_type = data_url
            .split_once(';')
            .ok_or("图片格式无效")?
            .0
            .trim_start_matches("data:")
            .to_string();
        return Ok(AgentImage {
            data_url,
            media_type,
        });
    }
    tokio::task::spawn_blocking(move || load_project_image(Path::new(&project), &path))
        .await
        .map_err(|_| "图片读取未完成，请重试".to_string())?
}

fn load_project_image(project: &Path, value: &str) -> Result<AgentImage, String> {
    if value.is_empty() || value.contains('\0') || value.starts_with('~') {
        return Err("请选择项目目录内的图片".into());
    }
    let root = project.canonicalize().map_err(|_| "项目目录无法访问")?;
    if !root.is_dir() {
        return Err("项目目录无法访问".into());
    }
    let candidate = Path::new(value);
    let path = if candidate.is_absolute() {
        candidate.to_owned()
    } else {
        root.join(candidate)
    }
    .canonicalize()
    .map_err(|_| "图片不存在或无法访问")?;
    // Canonicalize first: a symlink/junction inside the project cannot expose a
    // private file outside the project through a model-authored image link.
    if !path.starts_with(&root) {
        return Err("图片位于当前项目之外，请把图片保存到项目目录后预览".into());
    }
    let mut file = std::fs::File::open(&path).map_err(|_| "图片无法读取")?;
    let metadata = file.metadata().map_err(|_| "图片无法读取")?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Err("图片超过 10 MB，请在文件管理器中查看".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "图片无法读取")?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("图片超过 10 MB，请在文件管理器中查看".into());
    }
    let media_type = image_media_type(&bytes)
        .ok_or("此文件不是支持的图片格式（PNG、JPEG、GIF、WebP、BMP、AVIF、SVG）")?;
    Ok(AgentImage {
        data_url: format!("data:{media_type};base64,{}", STANDARD.encode(bytes)),
        media_type: media_type.into(),
    })
}

pub(super) fn image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.get(4..8) == Some(b"ftyp")
        && bytes
            .get(8..12)
            .is_some_and(|brand| brand == b"avif" || brand == b"avis")
    {
        return Some("image/avif");
    }
    let svg = std::str::from_utf8(bytes)
        .ok()?
        .trim_start_matches('\u{feff}')
        .trim_start()
        .to_ascii_lowercase();
    if !(svg.starts_with("<svg") || (svg.starts_with("<?xml") && svg.contains("<svg"))) {
        return None;
    }
    // SVG is always an <img> resource, never injected HTML. Also reject active
    // content and external references rather than granting local/network access.
    if [
        "<!doctype",
        "<!entity",
        "<script",
        "<foreignobject",
        "javascript:",
        "file:",
        "http:",
        "https:",
    ]
    .iter()
    .any(|item| svg.contains(item))
    {
        // The standard SVG namespace is a declaration, not an external load.
        let without_namespaces = svg
            .replace("http://www.w3.org/2000/svg", "")
            .replace("http://www.w3.org/1999/xlink", "");
        if [
            "<!doctype",
            "<!entity",
            "<script",
            "<foreignobject",
            "javascript:",
            "file:",
            "http:",
            "https:",
        ]
        .iter()
        .any(|item| without_namespaces.contains(item))
        {
            return None;
        }
    }
    if svg
        .split_whitespace()
        .any(|token| token.starts_with("on") && token.contains('='))
    {
        return None;
    }
    Some("image/svg+xml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_project_png_is_returned_with_content_mime() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("generated.png");
        std::fs::write(&file, b"\x89PNG\r\n\x1a\nfixture").unwrap();
        let image = load_project_image(dir.path(), "generated.png").unwrap();
        assert_eq!(image.media_type, "image/png");
        assert!(image.data_url.starts_with("data:image/png;base64,"));
        assert!(load_project_image(dir.path(), file.to_str().unwrap()).is_ok());
    }

    #[test]
    fn outside_and_disguised_files_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(dir.path().join("outside.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(project.join("fake.png"), b"private credentials").unwrap();
        assert!(load_project_image(&project, "../outside.png").is_err());
        assert!(load_project_image(&project, "fake.png").is_err());
        assert!(load_project_image(&project, "~/.ssh/id_rsa").is_err());
    }

    #[test]
    fn active_svg_is_not_returned_as_an_image() {
        assert_eq!(
            image_media_type(
                br#"<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>"#
            ),
            Some("image/svg+xml")
        );
        for value in [
            "<svg><script>alert(1)</script></svg>",
            "<svg onload='alert(1)'/>",
            "<svg><image href='https://example.com/private'/></svg>",
            "<!DOCTYPE svg><svg/>",
        ] {
            assert!(image_media_type(value.as_bytes()).is_none(), "{value}");
        }
    }

    #[test]
    fn image_limit_is_enforced_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let file = std::fs::File::create(dir.path().join("large.png")).unwrap();
        file.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(load_project_image(dir.path(), "large.png")
            .unwrap_err()
            .contains("10 MB"));
    }
}
