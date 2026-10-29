//! Pinned, app-owned local companion runtime. Never changes shared channels.
use super::super::channel_center::{AgentCatalog, AgentCatalogModel};
use futures::{stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use uuid::Uuid;

pub const MODEL_ID: &str = "tavern-local:sbg-v2-9b-q4-16k";
pub const MODEL_NAME: &str = "硅基女友 v2 9B · Q4_K_M · 16K";
const ALIAS: &str = "sbg-v2-9b";
const CONTEXT: usize = 16_384;
const OUTPUT: usize = 1024;
const CHUNK: u64 = 16 * 1024 * 1024;
const PARTS: u64 = 6;
const MODEL_FILE: &str = "sbg-v2-9b.imat-Q4_K_M.gguf";
const MODEL_SHA: &str = "f3db124770a54961bb703929f584f8616f3cbc181c952dce4293d2ad1d103034";
const MODEL_BYTES: u64 = 5_780_091_104;

#[derive(Clone, Copy)]
struct Asset {
    name: &'static str,
    url: &'static str,
    bytes: u64,
    sha: &'static str,
}
const ASSETS: [Asset; 3] = [
    Asset { name: "llama-b11729-bin-win-cuda-13.4-x64.zip", url: "https://github.com/ggml-org/llama.cpp/releases/download/b11729/llama-b11729-bin-win-cuda-13.4-x64.zip", bytes:155_124_217, sha:"ea675c73c7436c73654ca3faf45fc5a667966db7df9490a9455fb3f833b3574a" },
    Asset { name: "cudart-llama-bin-win-cuda-13.4-x64.zip", url: "https://github.com/ggml-org/llama.cpp/releases/download/b11729/cudart-llama-bin-win-cuda-13.4-x64.zip", bytes:423_535_356, sha:"738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668" },
    Asset { name: MODEL_FILE, url: "https://huggingface.co/RX5950XT/silicon-based-girlfriend-v2-GGUF/resolve/6a1bb825afbc8cf3363c4a201f231f378cfc0123/sbg-v2-9b.imat-Q4_K_M.gguf", bytes:MODEL_BYTES, sha:MODEL_SHA },
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelStatus {
    pub supported: bool,
    pub installed: bool,
    pub enabled: bool,
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
    pub cpu_ffn_layers: usize,
}

#[derive(Serialize, Deserialize)]
struct Installation {
    model_sha256: String,
    enabled: bool,
    runtime_files: BTreeMap<String, String>,
}

struct Runtime {
    child: Child,
    url: String,
    token: String,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct LocalModelManager {
    root: PathBuf,
    state: Mutex<LocalModelStatus>,
    runtime: Mutex<Option<Runtime>>,
    operation: Arc<tokio::sync::Mutex<()>>,
    cancelled: AtomicBool,
    exiting: AtomicBool,
}

pub fn manager() -> Arc<LocalModelManager> {
    static INSTANCE: OnceLock<Arc<LocalModelManager>> = OnceLock::new();
    INSTANCE
        .get_or_init(|| {
            // Unit tests must never discover or start the user's installed model.
            #[cfg(test)]
            let root =
                std::env::temp_dir().join(format!("lolicode-tavern-unit-{}", Uuid::new_v4()));
            #[cfg(not(test))]
            let root = crate::config::get_app_config_dir().join("tavern/local-models/sbg-v2-9b");
            Arc::new(LocalModelManager::new(root))
        })
        .clone()
}

impl LocalModelManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            state: Mutex::new(LocalModelStatus {
                supported: cfg!(all(target_os = "windows", target_arch = "x86_64")),
                installed: false,
                enabled: false,
                stage: "notInstalled".into(),
                downloaded_bytes: 0,
                total_bytes: ASSETS.iter().map(|a| a.bytes).sum(),
                error: None,
                cpu_ffn_layers: 0,
            }),
            runtime: Mutex::new(None),
            operation: Arc::new(tokio::sync::Mutex::new(())),
            cancelled: AtomicBool::new(false),
            exiting: AtomicBool::new(false),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    fn read_marker(&self) -> Result<Installation, String> {
        let bytes =
            fs::read(self.root.join("installation.json")).map_err(|_| "本地模型尚未配置")?;
        let marker: Installation =
            serde_json::from_slice(&bytes).map_err(|_| "本地模型安装记录无效，请重新配置")?;
        if marker.model_sha256 != MODEL_SHA
            || !marker.runtime_files.contains_key("llama-server.exe")
            || !marker.runtime_files.contains_key("ggml-cuda.dll")
            || marker.runtime_files.iter().any(|(name, sha)| {
                name.is_empty()
                    || name == "."
                    || name == ".."
                    || name.contains(['/', '\\', ':'])
                    || sha.len() != 64
                    || !sha.bytes().all(|c| c.is_ascii_hexdigit())
            })
        {
            return Err("本地模型版本不匹配，请重新配置".into());
        }
        Ok(marker)
    }
    fn marker(&self) -> Result<Installation, String> {
        let marker = self.read_marker()?;
        if fs::metadata(self.root.join(MODEL_FILE))
            .map(|m| m.len())
            .unwrap_or(0)
            != MODEL_BYTES
            || marker
                .runtime_files
                .keys()
                .any(|name| !self.root.join("runtime").join(name).is_file())
        {
            return Err("本地模型文件缺失，请重新配置".into());
        }
        Ok(marker)
    }
    fn write_marker(&self, marker: &Installation) -> Result<(), String> {
        crate::config::write_json_file(&self.root.join("installation.json"), marker)
            .map_err(|_| "无法保存本地模型配置".into())
    }
    fn update(&self, stage: &str, error: Option<String>) {
        if let Ok(mut s) = self.state.lock() {
            s.stage = stage.into();
            s.error = error;
        }
    }
    fn check_cancel(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Relaxed) || self.exiting.load(Ordering::Relaxed) {
            Err("配置已暂停，可以继续".into())
        } else {
            Ok(())
        }
    }
    pub fn status(&self) -> LocalModelStatus {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Ok(marker) = self.marker() {
            s.installed = true;
            s.enabled = marker.enabled;
        } else {
            s.installed = false;
            // Missing files must not silently switch a selected local session
            // to a cloud channel. The user can repair or explicitly switch.
            s.enabled = self.enabled();
        }
        if let Ok(mut runtime) = self.runtime.lock() {
            if runtime
                .as_mut()
                .is_some_and(|r| r.child.try_wait().ok().flatten().is_some())
            {
                runtime.take();
                s.stage = "error".into();
                s.error = Some("本地模型进程已退出，请重试启动".into());
                self.update(&s.stage, s.error.clone());
            } else if runtime.is_some() && s.stage != "starting" {
                s.stage = "running".into();
            }
        }
        if !s.supported {
            s.stage = "unsupported".into();
        } else if s.stage == "notInstalled" && s.installed {
            s.stage = "ready".into();
        }
        s
    }
    pub fn enabled(&self) -> bool {
        self.read_marker().is_ok_and(|m| m.enabled)
    }
    pub fn catalog(&self) -> AgentCatalog {
        AgentCatalog {
            revision: 1,
            default_model: Some(MODEL_ID.into()),
            excluded_sources: vec![],
            models: vec![AgentCatalogModel {
                id: MODEL_ID.into(),
                provider_id: "tavern-local".into(),
                model_id: ALIAS.into(),
                name: MODEL_NAME.into(),
                channel_name: "本机运行".into(),
                is_free: false,
                context_limit: Some(CONTEXT as u64),
                context_limits: Some(vec![CONTEXT as u64]),
                max_request_bytes: None,
                output_limit: Some(OUTPUT as u64),
                reasoning_efforts: None,
                reasoning_effort_source: None,
                reasoning_effort_transport: None,
            }],
        }
    }

    pub fn begin_install(self: &Arc<Self>) -> Result<LocalModelStatus, String> {
        if !self.status().supported {
            return Err("一键本地模型目前支持 Windows x64 NVIDIA 显卡".into());
        }
        let guard = self
            .operation
            .clone()
            .try_lock_owned()
            .map_err(|_| "本地模型正在配置或生成，请稍后重试")?;
        self.cancelled.store(false, Ordering::Relaxed);
        self.update("downloading", None);
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            if let Err(error) = manager.install().await {
                manager.update(
                    if manager.cancelled.load(Ordering::Relaxed) {
                        "paused"
                    } else {
                        "error"
                    },
                    Some(error),
                );
            }
        });
        Ok(self.status())
    }

    pub fn cancel_install(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
    pub fn shutdown(&self) {
        self.exiting.store(true, Ordering::Relaxed);
        self.cancel_install();
        self.stop_runtime();
    }
    fn stop_runtime(&self) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.take();
        }
        self.update("ready", None);
    }
    pub async fn stop(&self) -> Result<LocalModelStatus, String> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| "本地模型正在配置或生成，暂时不能释放显存")?;
        self.stop_runtime();
        Ok(self.status())
    }
    pub async fn set_enabled(&self, enabled: bool) -> Result<LocalModelStatus, String> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| "本地模型正在配置或生成，请稍后切换")?;
        let mut marker = if enabled {
            self.marker()?
        } else {
            self.read_marker()?
        };
        marker.enabled = enabled;
        self.write_marker(&marker)?;
        if enabled {
            self.cancelled.store(false, Ordering::Relaxed);
            if let Err(error) = self.ensure_runtime().await {
                self.update("error", Some(error.clone()));
                return Err(error);
            }
        } else {
            self.stop_runtime();
        }
        Ok(self.status())
    }

    async fn install(self: &Arc<Self>) -> Result<(), String> {
        self.stop_runtime();
        self.update("downloading", None);
        self.hardware().await?;
        fs::create_dir_all(self.root.join("downloads")).map_err(|_| "无法创建模型下载目录")?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(90))
            .user_agent("LoliCode-Tavern-Local/1")
            .build()
            .map_err(|_| "无法初始化下载连接")?;
        let mut completed = 0;
        for asset in ASSETS {
            self.download_asset(&client, asset, completed).await?;
            completed += asset.bytes;
        }
        self.check_cancel()?;
        self.update("verifying", None);
        let root = self.root.clone();
        let runtime_files = tokio::task::spawn_blocking(move || install_runtime(&root))
            .await
            .map_err(|_| "运行时安装任务中断")??;
        self.check_cancel()?;
        self.write_marker(&Installation {
            model_sha256: MODEL_SHA.into(),
            enabled: true,
            runtime_files,
        })?;
        self.ensure_runtime().await?;
        Ok(())
    }

    async fn download_asset(
        self: &Arc<Self>,
        client: &reqwest::Client,
        asset: Asset,
        completed: u64,
    ) -> Result<(), String> {
        let target = if asset.name == MODEL_FILE {
            self.root.join(asset.name)
        } else {
            self.root.join("downloads").join(asset.name)
        };
        if fs::metadata(&target).is_ok_and(|m| m.len() == asset.bytes) {
            self.update("verifying", None);
            let path = target.clone();
            let sha = tokio::task::spawn_blocking(move || hash_file(&path))
                .await
                .map_err(|_| "校验任务中断")??;
            if sha == asset.sha {
                self.state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .downloaded_bytes = completed + asset.bytes;
                return Ok(());
            }
        }
        self.update("downloading", None);
        let mut initial = 0;
        let mut ranges = Vec::new();
        for i in 0..PARTS {
            let start = asset.bytes * i / PARTS;
            let end = asset.bytes * (i + 1) / PARTS - 1;
            let path = self
                .root
                .join("downloads")
                .join(format!("{}.part{i}", asset.name));
            let have = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            if have > end - start + 1 {
                return Err("下载分段大小异常，请检查本地模型下载目录".into());
            }
            initial += have;
            ranges.push((path, start, end));
        }
        let progress = Arc::new(AtomicU64::new(initial));
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .downloaded_bytes = completed + initial;
        stream::iter(ranges.into_iter().map(|(path, start, end)| {
            let manager = self.clone();
            let client = client.clone();
            let progress = progress.clone();
            async move {
                manager
                    .download_range(&client, asset, path, start, end, completed, progress)
                    .await
            }
        }))
        .buffer_unordered(PARTS as usize)
        .try_collect::<Vec<_>>()
        .await?;
        self.check_cancel()?;
        self.update("verifying", None);
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || assemble_asset(&root, asset, &target))
            .await
            .map_err(|_| "文件合并任务中断")??;
        Ok(())
    }

    async fn download_range(
        &self,
        client: &reqwest::Client,
        asset: Asset,
        path: PathBuf,
        start: u64,
        end: u64,
        completed: u64,
        progress: Arc<AtomicU64>,
    ) -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|_| "无法写入下载文件")?;
        let mut have = file.metadata().map_err(|_| "无法读取下载进度")?.len();
        let mut failures = 0;
        while start + have <= end {
            self.check_cancel()?;
            let from = start + have;
            let to = end.min(from + CHUNK - 1);
            let before = have;
            let outcome = async {
                // Distinct range URLs avoid stale intermediary responses for large HF files.
                let url = format!(
                    "{}?download=true&range_start={from}&range_end={to}",
                    asset.url
                );
                let mut response = client
                    .get(url)
                    .header(reqwest::header::RANGE, format!("bytes={from}-{to}"))
                    .send()
                    .await
                    .map_err(|_| "下载连接中断")?;
                if response.status() != reqwest::StatusCode::PARTIAL_CONTENT
                    || !check_range(
                        response
                            .headers()
                            .get(reqwest::header::CONTENT_RANGE)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or(""),
                        from,
                        to,
                        asset.bytes,
                    )
                {
                    return Err("下载服务器未返回正确的分段数据");
                }
                let mut received = 0;
                while let Some(bytes) = response.chunk().await.map_err(|_| "下载连接中断")? {
                    self.check_cancel().map_err(|_| "配置已暂停，可以继续")?;
                    if received + bytes.len() as u64 > to - from + 1 {
                        return Err("下载分段超过预期大小");
                    }
                    file.write_all(&bytes)
                        .map_err(|_| "下载文件写入失败，请检查磁盘空间")?;
                    have += bytes.len() as u64;
                    received += bytes.len() as u64;
                    let total = progress.fetch_add(bytes.len() as u64, Ordering::Relaxed)
                        + bytes.len() as u64;
                    self.state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .downloaded_bytes = completed + total;
                }
                if received != to - from + 1 {
                    return Err("下载分段不完整");
                }
                Ok::<(), &str>(())
            }
            .await;
            if let Err(error) = outcome {
                self.check_cancel()?;
                failures = if have > before { 0 } else { failures + 1 };
                if failures >= 5 {
                    return Err(format!("{error}，可点击继续配置从断点重试"));
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            } else {
                failures = 0;
            }
        }
        file.sync_all().map_err(|_| "无法保存下载文件")?;
        Ok(())
    }

    async fn hardware(&self) -> Result<(u64, u64), String> {
        if !self.status().supported {
            return Err("一键本地模型目前支持 Windows x64 NVIDIA 显卡".into());
        }
        let mut command = tokio::process::Command::new("nvidia-smi");
        command
            .args([
                "--query-gpu=memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ])
            .stdin(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let output = tokio::time::timeout(Duration::from_secs(10), command.output())
            .await
            .map_err(|_| "显卡检测超时，请检查 NVIDIA 驱动")?
            .map_err(|_| "未检测到 NVIDIA 驱动，请安装驱动后重试")?;
        if !output.status.success() {
            return Err("NVIDIA 显卡检测失败，请检查驱动".into());
        }
        let first = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .to_string();
        let values: Vec<u64> = first
            .split(',')
            .filter_map(|v| v.trim().parse().ok())
            .collect();
        if values.len() != 2 || values[0] < 5500 {
            return Err("此预设面向 6GB 及以上 NVIDIA 显卡".into());
        }
        Ok((values[0], values[1]))
    }

    async fn ensure_runtime(&self) -> Result<(String, String), String> {
        self.check_cancel()?;
        {
            let mut slot = self.runtime.lock().map_err(|_| "本地模型状态暂不可用")?;
            if let Some(runtime) = slot.as_mut() {
                if runtime
                    .child
                    .try_wait()
                    .map_err(|_| "无法检查本地模型进程")?
                    .is_none()
                {
                    return Ok((runtime.url.clone(), runtime.token.clone()));
                }
                slot.take();
            }
        }
        let marker = self.marker()?;
        if !marker.enabled {
            return Err("请先启用本地陪伴模型".into());
        }
        self.update("starting", None);
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            if hash_file(&root.join(MODEL_FILE))? != MODEL_SHA {
                return Err("模型校验失败，请重新配置".to_string());
            }
            for (name, sha) in marker.runtime_files {
                if hash_file(&root.join("runtime").join(name))? != sha {
                    return Err("运行时校验失败，请重新配置".into());
                }
            }
            Ok(())
        })
        .await
        .map_err(|_| "启动校验任务中断")??;
        let (total, free) = self.hardware().await?;
        let cpu_ffn = if total <= 7168 || free < 6400 { 8 } else { 0 };
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cpu_ffn_layers = cpu_ffn;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "无法分配本地模型端口")?;
        let port = listener
            .local_addr()
            .map_err(|_| "无法读取本地模型端口")?
            .port();
        drop(listener);
        let token = Uuid::new_v4().to_string();
        let url = format!("http://127.0.0.1:{port}");
        let log = File::create(self.root.join("server.log")).map_err(|_| "无法创建本地模型日志")?;
        let mut command = Command::new(self.root.join("runtime/llama-server.exe"));
        command
            .args(["-m"])
            .arg(self.root.join(MODEL_FILE))
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--api-key",
                &token,
                "--alias",
                ALIAS,
                "-c",
                "16384",
                "-np",
                "1",
                "-ngl",
                "99",
                "--fit",
                "off",
                "-fa",
                "on",
                "-ctk",
                "q8_0",
                "-ctv",
                "q8_0",
                "-b",
                "256",
                "-ub",
                "128",
                "-t",
                "8",
                "-tb",
                "12",
                "--no-context-shift",
                "--no-webui",
                "--no-warmup",
                "--reasoning",
                "off",
                "--temp",
                "0.7",
                "--top-p",
                "0.8",
                "--top-k",
                "20",
                "--min-p",
                "0",
                "--repeat-penalty",
                "1",
                "--presence-penalty",
                "1.5",
            ])
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|_| "无法写入本地模型日志")?)
            .stderr(log);
        if cpu_ffn > 0 {
            command.args(["--n-cpu-ffn", &cpu_ffn.to_string()]);
        }
        quiet(&mut command);
        self.check_cancel()?;
        let child = command
            .spawn()
            .map_err(|_| "本地模型无法启动，请重新配置运行时")?;
        *self.runtime.lock().map_err(|_| "本地模型状态暂不可用")? = Some(Runtime {
            child,
            url: url.clone(),
            token: token.clone(),
        });
        let client = local_client()?;
        for _ in 0..960 {
            if self.exiting.load(Ordering::Relaxed) {
                self.stop_runtime();
                return Err("应用正在退出".into());
            }
            let alive = self
                .runtime
                .lock()
                .map_err(|_| "本地模型状态暂不可用")?
                .as_mut()
                .is_some_and(|r| r.child.try_wait().ok().flatten().is_none());
            if !alive {
                self.stop_runtime();
                return Err(format!(
                    "本地模型启动失败，请检查显卡驱动与可用显存。日志：{}",
                    self.root.join("server.log").display()
                ));
            }
            if let Ok(response) = client
                .get(format!("{url}/v1/models"))
                .bearer_auth(&token)
                .timeout(Duration::from_secs(1))
                .send()
                .await
            {
                if response.status().is_success() {
                    self.update("running", None);
                    return Ok((url, token));
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        self.stop_runtime();
        Err("本地模型启动超时，请检查日志后重试".into())
    }

    pub async fn chat(&self, messages: Vec<Value>) -> Result<String, String> {
        let _guard = self.operation.lock().await;
        let (url, token) = self.ensure_runtime().await.map_err(|e| {
            self.update("error", Some(e.clone()));
            e
        })?;
        let client = local_client()?;
        let mut messages = normalize_messages(messages)?;
        loop {
            let rendered=local_json(&client,&url,&token,"/apply-template",json!({"messages":messages,"add_generation_prompt":true,"chat_template_kwargs":{"enable_thinking":false}})).await?;
            let prompt = rendered["prompt"].as_str().ok_or("本地模型模板无法应用")?;
            let tokens = local_json(
                &client,
                &url,
                &token,
                "/tokenize",
                json!({"content":prompt,"add_special":false,"parse_special":true}),
            )
            .await?;
            let count = tokens["tokens"]
                .as_array()
                .ok_or("本地模型无法计算上下文")?
                .len();
            if count + OUTPUT + 256 <= CONTEXT {
                break;
            }
            if !trim_oldest_exchange(&mut messages) {
                return Err("角色设定或本次消息超出 16K 窗口，请缩短后重试".into());
            }
        }
        let request = json!({"model":ALIAS,"messages":messages,"stream":false,"max_tokens":OUTPUT,
            "temperature":0.85,"top_p":0.9,"top_k":40,"min_p":0.0,"repeat_penalty":1.0,"presence_penalty":1.5,
            "dry_multiplier":0.8,"dry_base":1.75,"dry_allowed_length":4,"dry_penalty_last_n":2048,
            "chat_template_kwargs":{"enable_thinking":false}});
        let response = local_json(&client, &url, &token, "/v1/chat/completions", request).await?;
        super::response_text(&response)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| "本地模型没有返回正文".into())
    }
}

fn local_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(240))
        .build()
        .map_err(|_| "无法初始化本地模型连接".into())
}
async fn local_json(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    route: &str,
    body: Value,
) -> Result<Value, String> {
    let response = client
        .post(format!("{url}{route}"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|_| "本地模型连接中断，请重试")?;
    let text = super::read_model_response(response, super::MAX_MODEL_RESPONSE_BYTES).await?;
    serde_json::from_str(&text).map_err(|_| "本地模型返回数据无法解析".into())
}

fn assemble_asset(root: &Path, asset: Asset, target: &Path) -> Result<(), String> {
    let temp = target.with_extension(format!("{}.verified", Uuid::new_v4()));
    let result = (|| {
        let mut output = File::create(&temp).map_err(|_| "无法合并下载文件")?;
        for i in 0..PARTS {
            let part = root
                .join("downloads")
                .join(format!("{}.part{i}", asset.name));
            let expected = asset.bytes * (i + 1) / PARTS - asset.bytes * i / PARTS;
            if fs::metadata(&part).map(|m| m.len()).unwrap_or(0) != expected {
                return Err("下载分段不完整，请继续配置".into());
            }
            std::io::copy(
                &mut File::open(part).map_err(|_| "下载分段无法读取")?,
                &mut output,
            )
            .map_err(|_| "模型文件合并失败，请检查磁盘空间")?;
        }
        output.sync_all().map_err(|_| "模型文件无法保存")?;
        drop(output);
        if hash_file(&temp)? != asset.sha {
            // Corrupt completed ranges cannot be resumed into a valid artifact.
            for i in 0..PARTS {
                let _ = fs::remove_file(
                    root.join("downloads")
                        .join(format!("{}.part{i}", asset.name)),
                );
            }
            return Err("下载文件 SHA256 校验失败，请重试配置".into());
        }
        // Only replace a fixed, app-owned asset after its replacement has verified.
        if target.exists() {
            fs::rename(
                target,
                target.with_extension(format!("{}.old", Uuid::new_v4())),
            )
            .map_err(|_| "旧模型文件暂时无法替换")?;
        }
        fs::rename(&temp, target).map_err(|_| "无法保存已校验的模型文件")?;
        for i in 0..PARTS {
            let _ = fs::remove_file(
                root.join("downloads")
                    .join(format!("{}.part{i}", asset.name)),
            );
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn install_runtime(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let staging = root.join(format!("runtime-{}.staging", Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|_| "无法创建运行时目录")?;
    let mut files = BTreeMap::new();
    let mut total = 0u64;
    for asset in &ASSETS[..2] {
        let archive =
            File::open(root.join("downloads").join(asset.name)).map_err(|_| "运行时压缩包缺失")?;
        let mut archive = zip::ZipArchive::new(archive).map_err(|_| "运行时压缩包无效")?;
        if archive.len() > 512 {
            return Err("运行时压缩包文件过多".into());
        }
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|_| "运行时压缩包无法读取")?;
            let relative = entry.enclosed_name().ok_or("运行时包含无效路径")?;
            if relative.components().count() != 1
                || entry.is_dir()
                || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            {
                return Err("运行时包含不支持的文件路径".into());
            }
            total = total.checked_add(entry.size()).ok_or("运行时文件过大")?;
            if total > 2_000_000_000 {
                return Err("运行时解压超过大小限制".into());
            }
            let name = relative.to_string_lossy().to_string();
            let path = staging.join(&relative);
            let mut output = File::create(&path).map_err(|_| "运行时文件无法写入")?;
            let expected_size = entry.size();
            let copied = std::io::copy(&mut entry.by_ref().take(expected_size + 1), &mut output)
                .map_err(|_| "运行时解压失败")?;
            if copied != expected_size {
                return Err("运行时文件大小不匹配".into());
            }
            drop(output);
            files.insert(name, hash_file(&path)?);
        }
    }
    if !files.contains_key("llama-server.exe") || !files.contains_key("ggml-cuda.dll") {
        return Err("运行时缺少必要文件".into());
    }
    let runtime = root.join("runtime");
    if runtime.exists() {
        fs::rename(
            &runtime,
            root.join(format!("runtime-{}.old", Uuid::new_v4())),
        )
        .map_err(|_| "运行时正在使用，无法更新")?;
    }
    fs::rename(staging, runtime).map_err(|_| "无法保存运行时")?;
    Ok(files)
}

fn quiet(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let _ = command;
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "文件无法读取")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|_| "文件校验失败")?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn check_range(header: &str, start: u64, end: u64, total: u64) -> bool {
    header == format!("bytes {start}-{end}/{total}")
}

fn normalize_messages(mut messages: Vec<Value>) -> Result<Vec<Value>, String> {
    let mut system = String::new();
    for m in &messages {
        if m["role"] == "system" {
            if !system.is_empty() {
                system.push_str("\n\n本轮补充约束：\n");
            }
            system.push_str(m["content"].as_str().unwrap_or(""));
        }
    }
    messages.retain(|m| m["role"] != "system");
    if messages.last().is_none_or(|m| m["role"] != "user") {
        return Err("本地对话缺少当前用户消息".into());
    }
    messages.insert(0, json!({"role":"system","content":system}));
    Ok(messages)
}

fn trim_oldest_exchange(messages: &mut Vec<Value>) -> bool {
    if messages.len() <= 2 {
        return false;
    }
    messages.remove(1);
    while messages.len() > 2 && messages[1]["role"] == "assistant" {
        messages.remove(1);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_model_files_keep_local_selection_until_an_explicit_channel_switch() {
        let temp = tempfile::tempdir().unwrap();
        let manager = LocalModelManager::new(temp.path().to_path_buf());
        manager
            .write_marker(&Installation {
                model_sha256: MODEL_SHA.into(),
                enabled: true,
                runtime_files: [
                    ("llama-server.exe".into(), "a".repeat(64)),
                    ("ggml-cuda.dll".into(), "b".repeat(64)),
                ]
                .into(),
            })
            .unwrap();
        assert!(manager.enabled());
        assert!(!manager.status().installed);
        assert!(manager.status().enabled);
        assert!(manager.set_enabled(true).await.is_err());
        manager.set_enabled(false).await.unwrap();
        assert!(!manager.enabled());
    }

    #[test]
    fn folds_post_history_system_constraints_and_keeps_current_user_when_trimming() {
        let mut messages = normalize_messages(vec![
            json!({"role":"system","content":"角色与世界书"}),
            json!({"role":"assistant","content":"开场"}),
            json!({"role":"user","content":"旧问题"}),
            json!({"role":"assistant","content":"旧回答"}),
            json!({"role":"system","content":"不替用户行动"}),
            json!({"role":"user","content":"当前问题"}),
        ])
        .unwrap();
        assert_eq!(messages.iter().filter(|m| m["role"] == "system").count(), 1);
        assert!(messages[0]["content"]
            .as_str()
            .unwrap()
            .contains("不替用户行动"));
        assert!(trim_oldest_exchange(&mut messages));
        assert_eq!(messages[1]["content"], "旧问题");
        assert!(trim_oldest_exchange(&mut messages));
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["content"], "当前问题");
        assert!(!trim_oldest_exchange(&mut messages));
    }

    #[test]
    fn range_validation_rejects_ignored_or_misaligned_responses() {
        assert!(check_range("bytes 10-19/100", 10, 19, 100));
        for value in ["", "bytes 0-99/100", "bytes 10-19/*", "bytes 10-19/101"] {
            assert!(!check_range(value, 10, 19, 100));
        }
    }

    #[tokio::test]
    async fn resumes_existing_ranges_and_verifies_the_assembled_file() {
        let directory = tempfile::tempdir().unwrap();
        let manager = Arc::new(LocalModelManager::new(directory.path().to_path_buf()));
        fs::create_dir_all(directory.path().join("downloads")).unwrap();
        let bytes = Arc::new((0..60000).map(|n| (n % 251) as u8).collect::<Vec<_>>());
        let expected = bytes.clone();
        let starts = Arc::new(Mutex::new(Vec::<usize>::new()));
        let observed = starts.clone();
        let handler = move |headers: axum::http::HeaderMap| {
            let bytes = bytes.clone();
            let starts = starts.clone();
            async move {
                let range = headers["range"]
                    .to_str()
                    .unwrap()
                    .strip_prefix("bytes=")
                    .unwrap();
                let (start, end) = range.split_once('-').unwrap();
                let start: usize = start.parse().unwrap();
                let end: usize = end.parse().unwrap();
                starts.lock().unwrap().push(start);
                (
                    axum::http::StatusCode::PARTIAL_CONTENT,
                    [(
                        "content-range",
                        format!("bytes {start}-{end}/{}", bytes.len()),
                    )],
                    bytes[start..=end].to_vec(),
                )
            }
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().route("/asset", axum::routing::get(handler)),
            )
            .await
            .unwrap();
        });
        let asset = Asset {
            name: "fixture.bin",
            url: Box::leak(format!("http://{address}/asset").into_boxed_str()),
            bytes: expected.len() as u64,
            sha: Box::leak(format!("{:x}", Sha256::digest(expected.as_slice())).into_boxed_str()),
        };
        fs::write(
            directory.path().join("downloads/fixture.bin.part0"),
            &expected[..137],
        )
        .unwrap();
        manager
            .download_asset(&local_client().unwrap(), asset, 0)
            .await
            .unwrap();
        assert_eq!(
            fs::read(directory.path().join("downloads/fixture.bin")).unwrap(),
            *expected
        );
        assert!(observed.lock().unwrap().contains(&137));
        assert_eq!(manager.status().downloaded_bytes, asset.bytes);
        assert!(!directory
            .path()
            .join("downloads/fixture.bin.part0")
            .exists());
        // Repeated configuration accepts the verified asset without a network call.
        server.abort();
        manager
            .download_asset(&local_client().unwrap(), asset, 0)
            .await
            .unwrap();
    }

    #[test]
    fn failed_checksum_preserves_existing_asset_and_discards_corrupt_ranges() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("downloads")).unwrap();
        let target = dir.path().join("keep.bin");
        fs::write(&target, b"existing").unwrap();
        let asset = Asset {
            name: "bad.bin",
            url: "https://example.invalid",
            bytes: 60,
            sha: MODEL_SHA,
        };
        for i in 0..PARTS {
            fs::write(
                dir.path()
                    .join("downloads")
                    .join(format!("bad.bin.part{i}")),
                [0u8; 10],
            )
            .unwrap();
        }
        assert!(assemble_asset(dir.path(), asset, &target)
            .unwrap_err()
            .contains("SHA256"));
        assert_eq!(fs::read(&target).unwrap(), b"existing");
        assert!(!dir.path().join("downloads/bad.bin.part0").exists());
    }

    #[test]
    fn runtime_archive_rejects_escape_paths() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("downloads")).unwrap();
        let file = File::create(dir.path().join("downloads").join(ASSETS[0].name)).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("../escaped.dll", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"bad").unwrap();
        zip.finish().unwrap();
        assert!(install_runtime(dir.path()).unwrap_err().contains("路径"));
        assert!(!dir.path().join("escaped.dll").exists());
    }
}
