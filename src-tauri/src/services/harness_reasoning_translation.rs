use super::harness_paths::HarnessPaths;
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    process::Stdio,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{oneshot, Semaphore},
};
use uuid::Uuid;

const FAILED: &str = "思考内容翻译失败";
const CANCELLED: &str = "思考内容翻译已取消";
const MAX_PENDING: usize = 24;
const MAX_EARLY_CANCELLATIONS: usize = 128;
const CANCELLATION_WINDOW: Duration = Duration::from_secs(30);
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;
static REQUESTS: LazyLock<Mutex<TranslationRequests>> = LazyLock::new(Mutex::default);
static SLOTS: Semaphore = Semaphore::const_new(3);

#[derive(Default)]
struct TranslationRequests {
    active: HashMap<Uuid, Option<oneshot::Sender<()>>>,
    cancelled_before_start: VecDeque<(Uuid, Instant)>,
}

impl TranslationRequests {
    fn start(&mut self, id: Uuid) -> Result<oneshot::Receiver<()>, &'static str> {
        self.cancelled_before_start
            .retain(|(_, time)| time.elapsed() < CANCELLATION_WINDOW);
        if self
            .cancelled_before_start
            .iter()
            .any(|(value, _)| *value == id)
        {
            return Err(CANCELLED);
        }
        if self.active.len() >= MAX_PENDING || self.active.contains_key(&id) {
            return Err("思考内容翻译请求过多，请稍后重试");
        }
        let (cancel, cancelled) = oneshot::channel();
        self.active.insert(id, Some(cancel));
        Ok(cancelled)
    }

    fn cancel(&mut self, id: Uuid) {
        if let Some(slot) = self.active.get_mut(&id) {
            if let Some(cancel) = slot.take() {
                let _ = cancel.send(());
            }
            return;
        }
        // A synchronous cancel can arrive before Tauri polls the async request.
        self.cancelled_before_start
            .retain(|(value, time)| *value != id && time.elapsed() < CANCELLATION_WINDOW);
        if self.cancelled_before_start.len() == MAX_EARLY_CANCELLATIONS {
            self.cancelled_before_start.pop_front();
        }
        self.cancelled_before_start.push_back((id, Instant::now()));
    }
}

struct ActiveTranslation(Uuid);

impl Drop for ActiveTranslation {
    fn drop(&mut self) {
        REQUESTS.lock().unwrap().active.remove(&self.0);
    }
}

pub(crate) fn cancel(request_id: &str) -> Result<(), String> {
    let id = Uuid::parse_str(request_id).map_err(|_| "无效的翻译请求编号")?;
    REQUESTS.lock().unwrap().cancel(id);
    Ok(())
}

pub(crate) async fn translate(
    app: &AppHandle,
    text: String,
    target_language: String,
    request_id: &str,
    provider: Option<String>,
) -> Result<String, String> {
    let id = Uuid::parse_str(request_id).map_err(|_| "无效的翻译请求编号")?;
    let provider = provider.as_deref().unwrap_or("bing");
    if text.len() > 16_000
        || text.encode_utf16().count() > 4_000
        || text.trim().is_empty()
        || !matches!(target_language.as_str(), "zh-CN" | "zh-TW" | "en" | "ja")
        || !matches!(provider, "bing" | "google")
    {
        return Err("无效的思考内容翻译参数".into());
    }

    let cancelled = REQUESTS.lock().unwrap().start(id)?;
    let _request = ActiveTranslation(id);

    tokio::select! {
        biased;
        _ = cancelled => Err(CANCELLED.into()),
        result = tokio::time::timeout(Duration::from_secs(18), invoke_translator(app, text, target_language, provider)) => {
            result.map_err(|_| "思考内容翻译超时，请重试")?
        }
    }
}

async fn invoke_translator(
    app: &AppHandle,
    text: String,
    target_language: String,
    provider: &str,
) -> Result<String, String> {
    let _permit = SLOTS.acquire().await.map_err(|_| FAILED)?;
    let paths = HarnessPaths::resolve(app)?;
    let payload = serde_json::to_vec(&json!({
        "text": text,
        "targetLanguage": target_language,
        "provider": provider,
    }))
    .map_err(|_| FAILED)?;
    let mut command = Command::new(&paths.node);
    command
        .arg(paths.package.join("host-reasoning-translation.mjs"))
        .current_dir(&paths.package)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
        if let Some(directory) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", directory);
        }
    }
    let mut child = command.spawn().map_err(|_| FAILED)?;
    {
        // Pass the text via stdin so it never appears in the process arguments.
        let mut stdin = child.stdin.take().ok_or(FAILED)?;
        stdin.write_all(&payload).await.map_err(|_| FAILED)?;
    }
    let stdout = child.stdout.take().ok_or(FAILED)?;
    let mut bytes = Vec::new();
    stdout
        .take(MAX_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| FAILED)?;
    if bytes.len() as u64 > MAX_OUTPUT_BYTES || !child.wait().await.map_err(|_| FAILED)?.success() {
        return Err(FAILED.into());
    }
    serde_json::from_slice::<String>(&bytes).map_err(|_| FAILED.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancels_before_and_after_translation_registration() {
        let mut requests = TranslationRequests::default();
        let early = Uuid::new_v4();
        requests.cancel(early);
        assert!(matches!(requests.start(early), Err(CANCELLED)));

        let active = Uuid::new_v4();
        let mut cancelled = requests.start(active).unwrap();
        requests.cancel(active);
        assert_eq!(cancelled.try_recv(), Ok(()));
        assert!(requests.start(active).is_err());
    }
}
