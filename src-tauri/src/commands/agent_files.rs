//! User-invoked project previews. No asset-protocol or arbitrary URL access.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const MAX_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

/// Open a selected agent project directory in the system file manager.
#[tauri::command]
pub async fn open_agent_project_directory(app: AppHandle, path: String) -> Result<(), String> {
    let directory = tokio::task::spawn_blocking(move || {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("项目文件夹路径必须是绝对路径".to_string());
        }
        let path = path
            .canonicalize()
            .map_err(|_| "项目文件夹不存在或无法访问".to_string())?;
        if !path.is_dir() {
            return Err("所选路径不是文件夹".to_string());
        }
        Ok(path)
    })
    .await
    .map_err(|_| "无法验证项目文件夹".to_string())??;

    app.opener()
        .open_path(directory.to_string_lossy().to_string(), None::<String>)
        .map_err(|_| "无法打开项目文件夹".to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFilePreview {
    kind: &'static str,
    path: String,
    name: String,
    mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_url: Option<String>,
    truncated: bool,
    size_bytes: u64,
}

fn resolve(project: &Path, value: &str) -> Result<(PathBuf, PathBuf), String> {
    if value.trim().is_empty() || value.contains(['\0', '\n', '\r']) || value.starts_with('~') {
        return Err("请选择当前项目内的文件或文件夹".into());
    }
    let root = project.canonicalize().map_err(|_| "当前项目无法访问")?;
    if !root.is_dir() {
        return Err("当前项目无法访问".into());
    }
    let candidate = Path::new(value);
    let path = if candidate.is_absolute() {
        candidate.to_owned()
    } else {
        root.join(candidate)
    }
    .canonicalize()
    .map_err(|_| "文件不存在或无法访问；已删除的文件可从差异中查看")?;
    if !path.starts_with(&root) {
        return Err("此文件位于当前会话项目之外".into());
    }
    Ok((root, path))
}

// Verify the opened handle too, so replacing a symlink between resolution and
// opening cannot cause a preview to return bytes from outside the project.
#[cfg(windows)]
fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 512];
    loop {
        let len = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if len == 0 || len > 32768 {
            return Err("无法验证文件读取范围".into());
        }
        if len < buffer.len() as u32 {
            return Ok(PathBuf::from(std::ffi::OsString::from_wide(
                &buffer[..len as usize],
            )));
        }
        buffer.resize(len as usize + 1, 0);
    }
}
#[cfg(target_os = "linux")]
fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map_err(|_| "无法验证文件读取范围".into())
}
#[cfg(target_os = "macos")]
fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::{fd::AsRawFd, unix::ffi::OsStrExt};
    let mut bytes = [0u8; 4096];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, bytes.as_mut_ptr()) } == -1 {
        return Err("无法验证文件读取范围".into());
    }
    let len = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..len])))
}

fn read_preview(project: &Path, value: &str) -> Result<AgentFilePreview, String> {
    let (root, path) = resolve(project, value)?;
    let mut file = File::open(&path).map_err(|_| "文件无法读取")?;
    if !opened_path(&file)?.starts_with(&root) {
        return Err("文件读取范围已变化，请重新选择".into());
    }
    let metadata = file.metadata().map_err(|_| "无法读取文件信息")?;
    if !metadata.is_file() {
        return Err("请选择文件；文件夹可以在文件管理器中打开".into());
    }
    if metadata.len() > MAX_BYTES {
        return Err("预览最大支持 10 MB，请打开文件或所在文件夹查看".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "文件读取失败")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("文件超过预览大小限制".into());
    }
    let mut result = AgentFilePreview {
        kind: "text",
        path: path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/"),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        mime_type: "text/plain".into(),
        content: None,
        data_url: None,
        truncated: false,
        size_bytes: metadata.len(),
    };
    if let Some(mime) = super::agent_images::image_media_type(&bytes) {
        result.kind = "image";
        result.mime_type = mime.into();
        result.data_url = Some(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)));
        return Ok(result);
    }
    let html = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"));
    if html && bytes.len() > MAX_TEXT_BYTES {
        return Err("HTML 超过 2 MB，请在浏览器中打开完整文件".into());
    }
    result.truncated = bytes.len() > MAX_TEXT_BYTES;
    bytes.truncate(MAX_TEXT_BYTES);
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(error) if result.truncated && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])
                .map_err(|_| "不支持预览此文件编码")?
        }
        Err(_) => return Err("此文件为二进制或非 UTF-8 编码，请打开文件或所在文件夹查看".into()),
    };
    if text.contains('\0') {
        return Err("不支持文本预览此二进制文件".into());
    }
    result.kind = if html { "html" } else { "text" };
    result.mime_type = if html { "text/html" } else { "text/plain" }.into();
    result.content = Some(text.into());
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn preview_agent_file(
    app: AppHandle,
    session_id: String,
    path: String,
) -> Result<AgentFilePreview, String> {
    let project = super::agent_dispatch::session_project(&app, &session_id).await?;
    tokio::task::spawn_blocking(move || read_preview(Path::new(&project), &path))
        .await
        .map_err(|_| "文件预览未完成，请重试".to_string())?
}

fn text_editor(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let name = path.to_string_lossy();
        let compatible = if let Some(tail) = name.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{tail}")
        } else {
            name.strip_prefix(r"\\?\").unwrap_or(&name).to_string()
        };
        std::process::Command::new("notepad.exe")
            .arg(compatible)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| "无法打开文本编辑器，请打开所在文件夹选择编辑器")?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("-t")
            .arg(path)
            .spawn()
            .map_err(|_| "无法打开文本编辑器")?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        for program in ["gnome-text-editor", "gedit", "kate", "mousepad", "xed"] {
            if std::process::Command::new(program)
                .arg(path)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("未找到文本编辑器，请打开所在文件夹选择编辑器".into())
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn open_agent_path(
    app: AppHandle,
    session_id: String,
    path: String,
    action: String,
) -> Result<(), String> {
    if !matches!(action.as_str(), "file" | "directory") {
        return Err("无法识别文件操作".into());
    }
    let project = super::agent_dispatch::session_project(&app, &session_id).await?;
    let (root, target) = resolve_action(Path::new(&project), &path, &action)?;
    if action == "directory" || target.is_dir() {
        let directory = if target.is_dir() {
            target.as_path()
        } else {
            target.parent().ok_or("找不到文件夹")?
        };
        return app
            .opener()
            .open_path(directory.to_string_lossy().to_string(), None::<String>)
            .map_err(|_| "无法打开文件夹".into());
    }
    let external_viewer = tokio::task::spawn_blocking({
        let target = target.clone();
        move || safe_viewer(&root, &target)
    })
    .await
    .map_err(|_| "无法验证文件类型")??;
    if external_viewer {
        app.opener()
            .open_path(target.to_string_lossy().to_string(), None::<String>)
            .map_err(|_| "无法打开文件".into())
    } else {
        // Source scripts go to a text editor; never run a shell/file association.
        text_editor(&target)
    }
}

fn resolve_action(project: &Path, value: &str, action: &str) -> Result<(PathBuf, PathBuf), String> {
    match resolve(project, value) {
        Ok(resolved) => Ok(resolved),
        Err(error)
            if action == "directory"
                && !value.trim().is_empty()
                && !value.contains(['\0', '\n', '\r']) =>
        {
            // Deleted generated files still have an existing parent to reveal.
            let candidate = Path::new(value);
            let candidate = if candidate.is_absolute() {
                candidate.to_owned()
            } else {
                project.join(candidate)
            };
            let parent = candidate.parent().ok_or(error)?;
            resolve(project, &parent.to_string_lossy())
        }
        Err(error) => Err(error),
    }
}

fn safe_viewer(root: &Path, path: &Path) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|_| "无法读取文件类型")?;
    if !opened_path(&file)?.starts_with(root) {
        return Err("文件读取范围已变化".into());
    }
    if !file.metadata().map_err(|_| "无法读取文件信息")?.is_file() {
        return Err("请选择普通文件".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(4096)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取文件类型")?;
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let image_ext = matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "svg"
    );
    if image_ext && super::agent_images::image_media_type(&bytes).is_some() {
        return Ok(true);
    }
    // Never let an executable or renamed source script reach its OS association.
    if matches!(
        ext.as_str(),
        "exe" | "com" | "msi" | "dll" | "lnk" | "desktop" | "app" | "scr"
    ) || bytes.contains(&0)
    {
        return Err("此文件不能作为文档打开，请打开所在文件夹查看".into());
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).map_err(|_| "文件编码不受支持")?
        }
        Err(_) => return Err("文件编码不受支持，请打开所在文件夹查看".into()),
    };
    Ok(matches!(ext.as_str(), "html" | "htm") && !text.contains('\0'))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_project_html_images_and_source_are_typed_without_asset_access() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("demo.html"),
            "<canvas></canvas><script>window.demo=1</script>",
        )
        .unwrap();
        std::fs::write(dir.path().join("demo.png"), b"\x89PNG\r\n\x1a\nfixture").unwrap();
        std::fs::write(dir.path().join("demo.rs"), "fn main() {}\n").unwrap();
        let html = read_preview(dir.path(), "demo.html").unwrap();
        assert_eq!(html.kind, "html");
        assert_eq!(html.path, "demo.html");
        assert!(html.content.unwrap().contains("<script>"));
        assert!(read_preview(dir.path(), "demo.png")
            .unwrap()
            .data_url
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(read_preview(dir.path(), "demo.rs").unwrap().kind, "text");
    }
    #[test]
    fn project_boundaries_and_binary_or_oversized_files_are_enforced() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(dir.path().join("private.txt"), "outside").unwrap();
        std::fs::write(project.join("binary"), b"binary\0content").unwrap();
        let file = File::create(project.join("large.html")).unwrap();
        file.set_len(MAX_BYTES + 1).unwrap();
        assert!(read_preview(&project, "../private.txt").is_err());
        assert!(read_preview(&project, "binary").is_err());
        assert!(read_preview(&project, "large.html").is_err());
        assert!(resolve(&project, "https://example.test/private").is_err());
        assert!(resolve(&project, "").is_err());
        assert!(resolve_action(&project, "deleted.txt", "directory")
            .unwrap()
            .1
            .is_dir());
        assert!(resolve_action(&project, "../outside-deleted.txt", "directory").is_err());
    }
    #[test]
    fn long_text_truncates_only_at_valid_utf8_boundaries_and_html_is_not_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let text = "中".repeat(MAX_TEXT_BYTES / 3 + 100);
        std::fs::write(dir.path().join("long.txt"), &text).unwrap();
        let preview = read_preview(dir.path(), "long.txt").unwrap();
        assert!(preview.truncated);
        assert!(text.starts_with(preview.content.as_ref().unwrap()));
        std::fs::write(dir.path().join("long.html"), &text).unwrap();
        assert!(read_preview(dir.path(), "long.html").is_err());
        let root = dir.path().canonicalize().unwrap();
        assert!(safe_viewer(&root, &dir.path().join("long.html")).unwrap());
        std::fs::write(
            dir.path().join("source.js"),
            "console.log('do not execute')",
        )
        .unwrap();
        assert!(!safe_viewer(&root, &dir.path().join("source.js")).unwrap());
        std::fs::write(
            dir.path().join("disguised.exe"),
            b"\x89PNG\r\n\x1a\nfixture",
        )
        .unwrap();
        assert!(safe_viewer(&root, &dir.path().join("disguised.exe")).is_err());
    }
    #[test]
    fn project_junction_or_symlink_cannot_preview_external_content() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("private.txt"), "secret").unwrap();
        #[cfg(windows)]
        {
            let result = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(project.join("escape"))
                .arg(&outside)
                .output()
                .unwrap();
            assert!(result.status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, project.join("escape")).unwrap();
        assert!(read_preview(&project, "escape/private.txt").is_err());
    }
}
