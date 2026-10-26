//! Project image references stay in the existing text/history format. Provider
//! image blocks become bounded Markdown, with local reads still authorized by
//! the host against the actual session project.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::collections::HashSet;

const MAX_IMAGES: usize = 16;
const MAX_INLINE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_TEXT: usize = 7 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct ImageMarkdown {
    seen: HashSet<String>,
    bytes: usize,
}

impl ImageMarkdown {
    /// Repeated cumulative images in streaming chunks must appear only once.
    pub fn block(&mut self, value: &Value) -> Option<String> {
        if self.seen.len() >= MAX_IMAGES {
            return None;
        }
        let source = image_source(value)?;
        let source = valid_source(&source)?;
        if self.seen.contains(&source) || self.bytes + source.len() > MAX_IMAGE_TEXT {
            return None;
        }
        self.bytes += source.len();
        self.seen.insert(source.clone());
        let alt = value
            .get("alt")
            .or_else(|| value.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("图片");
        let mut escaped = String::new();
        for c in alt.chars().take(256) {
            if c.is_control() {
                escaped.push(' ');
            } else {
                if matches!(c, '\\' | '[' | ']' | '*' | '_' | '`' | '<' | '>' | '!') {
                    escaped.push('\\');
                }
                escaped.push(c);
            }
        }
        Some(format!("\n\n![{escaped}](<{source}>)\n\n"))
    }
}

/// Pixels remain in the persisted UI snapshot, but replaying their base64 as
/// assistant prose would charge text tokens and can immediately exhaust the
/// next turn's context. Project paths and HTTP images stay useful in history.
pub(crate) fn model_history_text(text: &str) -> String {
    let mut output = String::new();
    let mut copied = 0;
    let mut scan = 0;
    while let Some(offset) = text[scan..].find("![") {
        let start = scan + offset;
        scan = start + 2;
        if text[..start]
            .bytes()
            .rev()
            .take_while(|b| *b == b'\\')
            .count()
            % 2
            != 0
        {
            continue;
        }
        if let Some(end) = inline_raster_end(text, start, &mut scan) {
            output.push_str(&text[copied..start]);
            output.push_str("[image retained in conversation]");
            copied = end;
            scan = end;
        }
    }
    output.push_str(&text[copied..]);
    output
}

fn inline_raster_end(text: &str, start: usize, scan: &mut usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut cursor = start + 2;
    let mut depth = 1;
    while let Some(byte) = bytes.get(cursor) {
        match byte {
            b'\\' => cursor += 1,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        cursor += 1;
    }
    // Advance past inspected labels even when malformed, avoiding quadratic
    // rescans of a long response containing many unmatched nested image labels.
    *scan = cursor.min(text.len());
    if bytes.get(cursor..cursor + 2) != Some(b"](") {
        return None;
    }
    cursor += 2;
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    let angle = bytes.get(cursor) == Some(&b'<');
    cursor += usize::from(angle);
    let source_start = cursor;
    let closing = if angle { b'>' } else { b')' };
    let Some(offset) = bytes[cursor..].iter().position(|byte| *byte == closing) else {
        *scan = text.len();
        return None;
    };
    cursor += offset;
    *scan = cursor + 1;
    let source = text[source_start..cursor].trim();
    // No large decode is needed: this is a history placeholder, not a display
    // authorization. Even a malformed raster payload should not inflate tokens.
    let (header, _) = source.split_once(',')?;
    if header.len() > 64 {
        return None;
    }
    let header = header.to_ascii_lowercase();
    let mime = header.strip_prefix("data:")?.strip_suffix(";base64")?;
    if !matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/avif"
    ) {
        return None;
    }
    if angle {
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b')') {
            return None;
        }
    }
    Some(cursor + 1)
}

fn image_source(value: &Value) -> Option<String> {
    if let Some(value) = value.as_str() {
        return Some(value.into());
    }
    let image_url = value.get("image_url");
    let source = value.get("source");
    for candidate in [
        image_url.and_then(Value::as_str),
        image_url.and_then(|v| v.get("url")).and_then(Value::as_str),
        value.get("url").and_then(Value::as_str),
        value.get("dataUrl").and_then(Value::as_str),
        value.get("data_url").and_then(Value::as_str),
        value.get("path").and_then(Value::as_str),
        source.and_then(|v| v.get("url")).and_then(Value::as_str),
    ] {
        if let Some(candidate) = candidate {
            return Some(candidate.into());
        }
    }
    let source = source.unwrap_or(value);
    let mime = source
        .get("media_type")
        .or_else(|| source.get("mediaType"))?
        .as_str()?;
    let data = source.get("data")?.as_str()?;
    // Check before constructing another potentially large base64 string.
    if data.len() > MAX_INLINE_BYTES.div_ceil(3) * 4 {
        return None;
    }
    Some(format!("data:{mime};base64,{data}"))
}

fn valid_source(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    if value
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
    {
        let (header, data) = value.split_once(',')?;
        let mime = header
            .get(5..)?
            .strip_suffix(";base64")?
            .to_ascii_lowercase();
        if data.len() > MAX_INLINE_BYTES.div_ceil(3) * 4 {
            return None;
        }
        let decoded = STANDARD.decode(data).ok()?;
        if decoded.len() > MAX_INLINE_BYTES || raster_mime(&decoded) != Some(mime.as_str()) {
            return None;
        }
        return Some(format!("data:{mime};base64,{data}"));
    }
    if value.len() > 8192 {
        return None;
    }
    if let Ok(url) = url::Url::parse(value) {
        if matches!(url.scheme(), "http" | "https") {
            return (url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none())
            .then(|| url.to_string());
        }
    }
    let path = value.replace('\\', "/");
    let drive_path = path.as_bytes().get(0).is_some_and(u8::is_ascii_alphabetic)
        && path.as_bytes().get(1..3) == Some(b":/");
    if path.len() > 4096
        || path.starts_with("//")
        || path.starts_with('~')
        || path.contains(['<', '>', '"'])
        || (path.contains(':') && !drive_path)
        || (drive_path && path[2..].contains(':'))
    {
        return None;
    }
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "svg"
    )
    .then_some(path)
}

fn raster_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.get(4..8) == Some(b"ftyp")
        && bytes
            .get(8..12)
            .is_some_and(|v| v == b"avif" || v == b"avis")
    {
        Some("image/avif")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn image_blocks_escape_labels_preserve_space_and_parentheses_and_deduplicate() {
        let mut images = ImageMarkdown::default();
        assert_eq!(
            images.block(&json!({"image_url":{"url":"C:\\project\\图 (1).png"},"alt":"](javascript:alert(1))\n[preview]"})).unwrap(),
            "\n\n![\\](javascript:alert(1)) \\[preview\\]](<C:/project/图 (1).png>)\n\n"
        );
        assert!(images
            .block(&json!({"path":"C:/project/图 (1).png"}))
            .is_none());
        assert!(images
            .block(&json!({"url":"https://example.com/picture.png"}))
            .is_some());
    }

    #[test]
    fn unsafe_and_oversized_image_sources_never_become_markdown() {
        for value in [
            "javascript:alert(1)",
            "data:text/html;base64,PHNjcmlwdD4=",
            "data:image/svg+xml;base64,PHN2Zy8+",
            "data:image/png;base64,PHN2Zy8+",
            "data:image/png;base64,broken!",
            "https://user:secret@example.com/a.png",
            "https://",
            "file:///private/a.png",
            "//example.com/a.png",
            "~/a.png",
            "picture.png\n![injected](https://example.com/a.png)",
            "a<evil>.png",
        ] {
            assert!(
                ImageMarkdown::default().block(&json!(value)).is_none(),
                "{value}"
            );
        }
        let oversized = format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_INLINE_BYTES.div_ceil(3) * 4 + 4)
        );
        assert!(ImageMarkdown::default().block(&json!(oversized)).is_none());
    }

    #[test]
    fn base64_images_require_matching_raster_bytes_and_have_a_count_limit() {
        let encoded = STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture");
        let mut images = ImageMarkdown::default();
        assert!(images.block(&json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":encoded}})).unwrap().contains("data:image/png;base64,"));
        assert!(ImageMarkdown::default()
            .block(&json!({"dataUrl":format!("data:image/jpeg;base64,{encoded}")}))
            .is_none());
        for i in 1..MAX_IMAGES {
            assert!(images
                .block(&json!({"path":format!("generated/{i}.png")}))
                .is_some());
        }
        assert!(images.block(&json!({"path":"extra.png"})).is_none());
    }

    #[test]
    fn inline_raster_image_history_omits_pixels_and_preserves_prose_and_other_image_references() {
        let text = "Before ![a\\]b](<data:image/png;base64,iVBORw0KGgo=>) between ![second](data:image/jpeg;base64,/9j/) after.\n![remote](https://example.com/a.png) ![local](<generated/a (1).svg>)";
        assert_eq!(model_history_text(text), "Before [image retained in conversation] between [image retained in conversation] after.\n![remote](https://example.com/a.png) ![local](<generated/a (1).svg>)");
        for text in [
            "\\![literal](data:image/png;base64,unmodified)",
            "![incomplete](<data:image/png;base64,unfinished",
            "![vector](data:image/svg+xml;base64,PHN2Zy8+)",
            "![broken [label](data:image/png;base64,unmodified)",
            "![remote](https://example.com/a.png)",
        ] {
            assert_eq!(model_history_text(text), text);
        }
    }
}
