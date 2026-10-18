use serde_json::{Map, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};
use tauri::Manager;

use crate::error::AppError;

/// Store 中的键名
const STORE_KEY_APP_CONFIG_DIR: &str = "app_config_dir_override";
const MAX_PATH_STORE_BYTES: u64 = 1024 * 1024;
static PATH_STORE_WRITE: Mutex<()> = Mutex::new(());

/// 缓存当前的 app_config_dir 覆盖路径，避免存储 AppHandle
static APP_CONFIG_DIR_OVERRIDE: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

fn override_cache() -> &'static RwLock<Option<PathBuf>> {
    APP_CONFIG_DIR_OVERRIDE.get_or_init(|| RwLock::new(None))
}

fn update_cached_override(value: Option<PathBuf>) {
    if let Ok(mut guard) = override_cache().write() {
        *guard = value;
    }
}

/// 获取缓存中的 app_config_dir 覆盖路径
pub fn get_app_config_dir_override() -> Option<PathBuf> {
    override_cache().read().ok()?.clone()
}

pub fn path_store_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("app_paths.json"))
        .map_err(|e| AppError::Config(format!("无法定位数据目录配置: {e}")))
}

// plugin-store intentionally ignores initial load errors. This particular file
// selects the user's database, so read it strictly before any database is opened.
fn read_path_document(path: &Path) -> Result<Map<String, Value>, AppError> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(AppError::io(path, error)),
    };
    let mut bytes = Vec::new();
    file.take(MAX_PATH_STORE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::io(path, e))?;
    if bytes.len() as u64 > MAX_PATH_STORE_BYTES {
        return Err(AppError::Config(
            "数据目录配置文件过大，请选择原数据目录恢复。".into(),
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        // Do not include malformed source values in diagnostics.
        AppError::Config("数据目录配置文件无法解析，请选择原数据目录恢复。".into())
    })
}

fn document_override(document: &Map<String, Value>) -> Result<Option<PathBuf>, AppError> {
    match document.get(STORE_KEY_APP_CONFIG_DIR) {
        Some(Value::String(raw)) if raw.trim().is_empty() => Ok(None),
        Some(Value::String(raw)) => {
            let path = resolve_path(raw.trim());
            if !path.is_absolute() || raw.contains('\0') {
                return Err(AppError::Config(
                    "数据目录必须是完整的绝对路径，请选择原数据目录恢复。".into(),
                ));
            }
            // A missing directory remains authoritative; startup handles recovery.
            Ok(Some(path))
        }
        Some(_) => Err(AppError::Config(
            "数据目录配置类型错误，请选择原数据目录恢复。".into(),
        )),
        None => Ok(None),
    }
}

/// Read the strict selector without changing the cached database location.
pub(crate) fn read_app_config_dir_override(
    app: &tauri::AppHandle,
) -> Result<Option<PathBuf>, AppError> {
    let _guard = PATH_STORE_WRITE
        .lock()
        .map_err(|e| AppError::Lock(e.to_string()))?;
    document_override(&read_path_document(&path_store_path(app)?)?)
}

/// Refresh the selector only during normal startup; early asset selection must
/// not mutate the database-path cache or create a replacement profile.
pub fn refresh_app_config_dir_override(
    app: &tauri::AppHandle,
) -> Result<Option<PathBuf>, AppError> {
    let _guard = PATH_STORE_WRITE
        .lock()
        .map_err(|e| AppError::Lock(e.to_string()))?;
    let value = document_override(&read_path_document(&path_store_path(app)?)?)?;
    update_cached_override(value.clone());
    Ok(value)
}

/// 写入 app_config_dir 到 Tauri Store
pub fn set_app_config_dir_to_store(
    app: &tauri::AppHandle,
    path: Option<&str>,
) -> Result<(), AppError> {
    let _guard = PATH_STORE_WRITE
        .lock()
        .map_err(|e| AppError::Lock(e.to_string()))?;
    let value = write_path_override(&path_store_path(app)?, path, false)?;
    update_cached_override(value);
    Ok(())
}

/// Only the explicit recovery action may replace an unreadable/invalid selector,
/// and only after retaining its exact bytes in a new, non-overwriting backup.
pub fn recover_app_config_dir_to_store(app: &tauri::AppHandle, path: &str) -> Result<(), AppError> {
    let _guard = PATH_STORE_WRITE
        .lock()
        .map_err(|e| AppError::Lock(e.to_string()))?;
    let value = write_path_override(&path_store_path(app)?, Some(path), true)?;
    update_cached_override(value);
    Ok(())
}

fn write_path_override(
    store_path: &Path,
    path: Option<&str>,
    recovery: bool,
) -> Result<Option<PathBuf>, AppError> {
    let loaded = read_path_document(store_path);
    let original = loaded
        .as_ref()
        .map_err(ToString::to_string)
        .and_then(|document| document_override(document).map_err(|error| error.to_string()));
    let mut document = match original {
        Ok(_) => loaded?,
        Err(error) if recovery => {
            let mut source =
                std::fs::File::open(store_path).map_err(|e| AppError::io(store_path, e))?;
            let backup_path = store_path.with_file_name(format!(
                "app_paths.recovery-{}.json.bak",
                uuid::Uuid::new_v4()
            ));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut backup = options
                .open(&backup_path)
                .map_err(|e| AppError::io(&backup_path, e))?;
            std::io::copy(&mut source, &mut backup).map_err(|e| AppError::io(&backup_path, e))?;
            backup
                .flush()
                .and_then(|_| backup.sync_all())
                .map_err(|e| AppError::io(&backup_path, e))?;
            log::warn!(
                "保留数据目录配置备份 {} 后恢复: {error}",
                backup_path.display()
            );
            loaded.unwrap_or_default()
        }
        Err(error) => return Err(AppError::Config(error)),
    };
    match path.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => {
            document.insert(STORE_KEY_APP_CONFIG_DIR.into(), Value::String(path.into()));
        }
        None => {
            document.remove(STORE_KEY_APP_CONFIG_DIR);
        }
    }
    let value = document_override(&document)?;
    let bytes = serde_json::to_vec_pretty(&document)
        .map_err(|source| AppError::JsonSerialize { source })?;
    crate::config::atomic_write_private(store_path, &bytes)?;
    Ok(value)
}

/// 解析路径，支持 ~ 开头的相对路径
fn resolve_path(raw: &str) -> PathBuf {
    if raw == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    } else if let Some(stripped) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    } else if let Some(stripped) = raw.strip_prefix("~\\") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }

    PathBuf::from(raw)
}

/// 从旧的 settings.json 迁移 app_config_dir 到 Store
pub fn migrate_app_config_dir_from_settings(app: &tauri::AppHandle) -> Result<(), AppError> {
    // app_config_dir 已从 settings.json 移除，此函数保留但不再执行迁移
    // 如果用户在旧版本设置过 app_config_dir，需要在 Store 中手动配置
    log::info!("app_config_dir 迁移功能已移除，请在设置中重新配置");

    refresh_app_config_dir_override(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fresh_profile_has_no_override_and_read_does_not_create_files() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("app_paths.json");
        assert!(document_override(&read_path_document(&store).unwrap())
            .unwrap()
            .is_none());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn malformed_or_wrong_typed_selector_never_becomes_a_fresh_profile() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("app_paths.json");
        for bytes in [
            b"{broken-private-path".as_slice(),
            b"null",
            b"[]",
            b"{\"app_config_dir_override\":false}",
            b"{\"app_config_dir_override\":\"relative/data\"}",
        ] {
            std::fs::write(&store, bytes).unwrap();
            let error = read_path_document(&store)
                .and_then(|doc| document_override(&doc))
                .unwrap_err();
            assert!(!error.to_string().contains("broken-private-path"));
            assert!(write_path_override(&store, None, false).is_err());
            assert_eq!(std::fs::read(&store).unwrap(), bytes);
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn missing_custom_volume_stays_authoritative_and_does_not_create_database() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("disconnected/data");
        let store = directory.path().join("app_paths.json");
        std::fs::write(
            &store,
            json!({STORE_KEY_APP_CONFIG_DIR: missing}).to_string(),
        )
        .unwrap();
        assert_eq!(
            document_override(&read_path_document(&store).unwrap()).unwrap(),
            Some(missing.clone())
        );
        assert!(!missing.exists());
        assert!(!directory.path().join("cc-switch.db").exists());
    }

    #[test]
    fn normal_writes_preserve_unknown_keys_and_allow_explicit_reset() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("app_paths.json");
        let data = directory.path().join("existing-profile");
        std::fs::write(
            &store,
            json!({"future_setting": {"enabled": true}}).to_string(),
        )
        .unwrap();
        assert_eq!(
            write_path_override(&store, Some(data.to_str().unwrap()), false).unwrap(),
            Some(data)
        );
        assert_eq!(
            read_path_document(&store).unwrap()["future_setting"],
            json!({"enabled":true})
        );
        assert!(write_path_override(&store, None, false).unwrap().is_none());
        let document = read_path_document(&store).unwrap();
        assert!(!document.contains_key(STORE_KEY_APP_CONFIG_DIR));
        assert_eq!(document["future_setting"], json!({"enabled":true}));
    }

    #[test]
    fn explicit_recovery_keeps_exact_corrupt_bytes_before_replacing_selector() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("app_paths.json");
        let data = directory.path().join("original-profile");
        std::fs::create_dir(&data).unwrap();
        let sentinel = data.join("cc-switch.db");
        std::fs::write(&sentinel, b"original-database-not-opened-or-modified").unwrap();
        let original = b"{broken config\r\n\x00";
        std::fs::write(&store, original).unwrap();
        write_path_override(&store, Some(data.to_str().unwrap()), true).unwrap();
        let backups: Vec<_> = std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read(backups[0].path()).unwrap(), original);
        assert_eq!(
            document_override(&read_path_document(&store).unwrap()).unwrap(),
            Some(data)
        );
        assert_eq!(
            std::fs::read(sentinel).unwrap(),
            b"original-database-not-opened-or-modified"
        );
    }

    #[test]
    fn type_error_recovery_keeps_other_settings_and_original_backup() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("app_paths.json");
        let original =
            json!({STORE_KEY_APP_CONFIG_DIR: 73, "future_setting": "retained"}).to_string();
        std::fs::write(&store, &original).unwrap();
        write_path_override(&store, Some(directory.path().to_str().unwrap()), true).unwrap();
        assert_eq!(
            read_path_document(&store).unwrap()["future_setting"],
            json!("retained")
        );
        let backup = std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
            .unwrap();
        assert_eq!(std::fs::read_to_string(backup.path()).unwrap(), original);
    }

    #[test]
    fn oversized_or_unreadable_selector_is_an_error_and_is_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("app_paths.json");
        std::fs::write(&store, vec![b' '; MAX_PATH_STORE_BYTES as usize + 1]).unwrap();
        assert!(read_path_document(&store)
            .unwrap_err()
            .to_string()
            .contains("过大"));
        assert!(write_path_override(&store, None, false).is_err());
        assert_eq!(
            std::fs::metadata(&store).unwrap().len(),
            MAX_PATH_STORE_BYTES + 1
        );
        let bad_store = directory.path().join("directory-not-a-file");
        std::fs::create_dir(&bad_store).unwrap();
        assert!(read_path_document(&bad_store).is_err());
        assert!(write_path_override(&bad_store, None, true).is_err());
        assert!(bad_store.is_dir());
    }
}
