use std::path::{Path, PathBuf};

pub(super) fn project_key(project: &Path) -> String {
    let value = project.to_string_lossy().into_owned();
    #[cfg(windows)]
    return value.to_lowercase();
    #[cfg(not(windows))]
    value
}

pub(super) async fn canonical_project(path: &Path) -> Result<PathBuf, String> {
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| "项目文件夹不存在或无法访问")?;
    if !path.is_dir() {
        return Err("请选择项目文件夹".into());
    }
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(path)
}

pub(super) fn safe_program(project: &Path, name: &str) -> Result<PathBuf, String> {
    // Ignore relative PATH entries and programs inside the project. Windows
    // may search the current directory before PATH for a bare executable.
    let name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if !directory.is_absolute() {
            continue;
        }
        if let Ok(path) = std::fs::canonicalize(directory.join(&name)) {
            if path.is_file() && !path.starts_with(project) {
                return Ok(path);
            }
        }
    }
    Err("未找到项目目录外的可信命令程序；请使用明确的已安装工具".into())
}
