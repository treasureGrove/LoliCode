//! MCP newline JSON-RPC stdio and Streamable HTTP (JSON or SSE POST response).
//! Every request has a deadline. A failed/cancelled call is never replayed.
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{watch, Mutex, MutexGuard},
};

mod process;
const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_MESSAGES: usize = 256;
const PROTOCOL: &str = "2025-06-18";

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}
pub(super) async fn lock<'a, T>(
    mutex: &'a Mutex<T>,
    mut cancel: watch::Receiver<bool>,
    timeout: Duration,
) -> Result<MutexGuard<'a, T>, String> {
    tokio::select! { biased; _=cancelled(&mut cancel)=>Err("MCP 操作已取消".into()), result=tokio::time::timeout(timeout,mutex.lock())=>result.map_err(|_|"MCP 连接正忙，请稍后重试".into()) }
}

struct StdioTransport {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    stderr: tokio::task::JoinHandle<()>,
    group: process::Group,
}
impl StdioTransport {
    fn spawn(config: &Value, project: &Path) -> Result<Self, String> {
        let args = config["command"].as_array().ok_or("MCP command 无效")?;
        let mut command = Command::new(args[0].as_str().ok_or("MCP 启动程序无效")?);
        command.args(args.iter().skip(1).map(|a| a.as_str().unwrap_or_default()));
        command.current_dir(config["cwd"].as_str().map(Path::new).unwrap_or(project));
        if let Some(environment) = config["environment"].as_object() {
            for (name, value) in environment {
                command.env(name, value.as_str().unwrap_or_default());
            }
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        process::prepare(&mut command);
        let mut child = command
            .spawn()
            .map_err(|_| "本地 MCP 无法启动，请检查已配置的程序和工作目录")?;
        let group = match process::Group::attach(&child) {
            Ok(group) => group,
            Err(error) => {
                let _ = child.start_kill();
                return Err(error);
            }
        };
        let input = child.stdin.take().ok_or("MCP stdin 不可用")?;
        let output = child.stdout.take().ok_or("MCP stdout 不可用")?;
        let mut error = child.stderr.take().ok_or("MCP stderr 不可用")?;
        // Drain without retaining or logging server stderr: it may contain
        // credentials, and a full pipe must not deadlock a valid server.
        let stderr = tokio::spawn(async move {
            let mut buffer = [0u8; 4096];
            while let Ok(count) = error.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input: Some(input),
            output: BufReader::new(output),
            stderr,
            group,
        })
    }
    async fn send(&mut self, message: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(message).map_err(|_| "MCP 请求编码失败")?;
        if bytes.len() > MAX_FRAME {
            return Err("MCP 请求过大".into());
        }
        bytes.push(b'\n');
        let input = self.input.as_mut().ok_or("MCP 连接已关闭")?;
        input
            .write_all(&bytes)
            .await
            .map_err(|_| "MCP 进程输入已断开")?;
        input
            .flush()
            .await
            .map_err(|_| "MCP 进程输入已断开".to_string())
    }
    async fn receive(&mut self) -> Result<Value, String> {
        let mut bytes = Vec::new();
        loop {
            let available = self
                .output
                .fill_buf()
                .await
                .map_err(|_| "MCP 进程输出读取失败")?;
            if available.is_empty() {
                return Err("MCP 进程在返回结果前退出".into());
            }
            let count = available
                .iter()
                .position(|c| *c == b'\n')
                .map(|i| i + 1)
                .unwrap_or(available.len());
            if bytes.len() + count > MAX_FRAME {
                return Err("MCP 消息超过 8 MiB 上限".into());
            }
            let ended = available[count - 1] == b'\n';
            bytes.extend_from_slice(&available[..count]);
            self.output.consume(count);
            if ended {
                return serde_json::from_slice(&bytes)
                    .map_err(|_| "MCP stdout 包含无效 JSON-RPC 消息".into());
            }
        }
    }
    async fn rpc(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        for _ in 0..MAX_MESSAGES {
            let message = self.receive().await?;
            match classify(message, id)? {
                Message::Response(value) => return Ok(value),
                Message::Reply(reply) => self.send(&reply).await?,
                Message::Ignore => {}
            }
        }
        Err("MCP 响应消息数量超过上限".into())
    }
    async fn close(&mut self) -> Result<(), String> {
        self.input.take();
        self.group.stop().await?;
        let _ = self.child.start_kill();
        tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .map_err(|_| "[cleanup_uncertain]MCP 进程退出状态无法确认")?
            .map_err(|_| "[cleanup_uncertain]MCP 进程回收失败")?;
        self.stderr.abort();
        Ok(())
    }
}
impl Drop for StdioTransport {
    fn drop(&mut self) {
        self.input.take();
        self.stderr.abort();
        let _ = self.child.start_kill();
    }
}

struct HttpTransport {
    client: reqwest::Client,
    url: String,
    headers: reqwest::header::HeaderMap,
    session: Option<String>,
    version: Option<String>,
}
impl HttpTransport {
    fn new(config: &Value) -> Result<Self, String> {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(configured) = config["headers"].as_object() {
            for (name, value) in configured {
                let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| "MCP HTTP 请求头名称无效")?;
                if matches!(
                    name.as_str(),
                    "host"
                        | "content-length"
                        | "content-type"
                        | "accept"
                        | "mcp-session-id"
                        | "mcp-protocol-version"
                ) {
                    return Err("MCP 配置不能覆盖协议保留请求头".into());
                }
                headers.insert(
                    name,
                    reqwest::header::HeaderValue::from_str(value.as_str().unwrap_or_default())
                        .map_err(|_| "MCP HTTP 请求头值无效")?,
                );
            }
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "MCP HTTP 客户端无法初始化")?;
        Ok(Self {
            client,
            url: config["url"].as_str().ok_or("MCP URL 无效")?.into(),
            headers,
            session: None,
            version: None,
        })
    }
    fn request(&self, method: reqwest::Method) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .request(method, &self.url)
            .headers(self.headers.clone())
            .header("Accept", "application/json, text/event-stream");
        if let Some(session) = &self.session {
            request = request.header("Mcp-Session-Id", session);
        }
        if let Some(version) = &self.version {
            request = request.header("MCP-Protocol-Version", version);
        }
        request
    }
    async fn post(&mut self, message: &Value) -> Result<reqwest::Response, String> {
        let response = self
            .request(reqwest::Method::POST)
            .json(message)
            .send()
            .await
            .map_err(|_| "MCP HTTP 连接失败")?;
        if !response.status().is_success() {
            return Err(format!(
                "MCP HTTP {}，请检查连接或凭据配置",
                response.status().as_u16()
            ));
        }
        if let Some(session) = response.headers().get("Mcp-Session-Id") {
            let value = session
                .to_str()
                .ok()
                .filter(|s| !s.is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control))
                .ok_or("MCP 会话标识无效")?;
            if self.session.as_deref().is_some_and(|old| old != value) {
                return Err("MCP HTTP 会话标识意外变化".into());
            }
            self.session = Some(value.into());
        }
        Ok(response)
    }
    async fn notify(&mut self, message: &Value) -> Result<(), String> {
        self.post(message).await.map(|_| ())
    }
    async fn rpc(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        let mut response = self
            .post(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_FRAME as u64)
        {
            return Err("MCP HTTP 响应超过 8 MiB 上限".into());
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if content_type == "application/json" {
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "MCP HTTP 响应读取失败")?
            {
                if body.len() + chunk.len() > MAX_FRAME {
                    return Err("MCP HTTP 响应超过 8 MiB 上限".into());
                }
                body.extend_from_slice(&chunk);
            }
            let message =
                serde_json::from_slice(&body).map_err(|_| "MCP HTTP 返回无效 JSON-RPC")?;
            return match classify(message, id)? {
                Message::Response(value) => Ok(value),
                _ => Err("MCP HTTP 响应缺少对应请求结果".into()),
            };
        }
        if content_type != "text/event-stream" {
            return Err("MCP HTTP 端点必须返回 JSON 或 SSE".into());
        }
        let mut decoder = Sse::default();
        let mut total = 0;
        let mut messages = 0;
        while let Some(chunk) = response.chunk().await.map_err(|_| "MCP SSE 响应读取失败")? {
            total += chunk.len();
            if total > MAX_FRAME * 2 {
                return Err("MCP SSE 响应超过大小上限".into());
            }
            for message in decoder.push(&chunk)? {
                messages += 1;
                if messages > MAX_MESSAGES {
                    return Err("MCP SSE 消息数量超过上限".into());
                }
                match classify(message, id)? {
                    Message::Response(value) => return Ok(value),
                    Message::Reply(reply) => self.notify(&reply).await?,
                    Message::Ignore => {}
                }
            }
        }
        Err("MCP SSE 在对应结果返回前断开".into())
    }
    async fn close(&mut self) {
        if self.session.is_some() {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                self.request(reqwest::Method::DELETE).send(),
            )
            .await;
        }
        self.session = None;
    }
}
impl Drop for HttpTransport {
    fn drop(&mut self) {
        if self.session.is_some() {
            let request = self.request(reqwest::Method::DELETE);
            self.session = None;
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(1), request.send()).await;
                });
            }
        }
    }
}

enum Message {
    Response(Value),
    Reply(Value),
    Ignore,
}
fn classify(message: Value, id: u64) -> Result<Message, String> {
    if !message.is_object() || message["jsonrpc"] != "2.0" {
        return Err("MCP JSON-RPC 格式无效".into());
    }
    if let Some(method) = message["method"].as_str() {
        return Ok(if let Some(id) = message.get("id") {
            Message::Reply(if method == "ping" {
                json!({"jsonrpc":"2.0","id":id,"result":{}})
            } else {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Client capability is not enabled"}})
            })
        } else {
            Message::Ignore
        });
    }
    if message["id"] != id {
        return Ok(Message::Ignore);
    }
    if let Some(error) = message.get("error") {
        return Err(format!(
            "MCP 服务器返回 JSON-RPC 错误（{}）",
            error["code"]
                .as_i64()
                .map(|n| n.to_string())
                .unwrap_or_else(|| "unknown".into())
        ));
    }
    message
        .get("result")
        .cloned()
        .map(Message::Response)
        .ok_or_else(|| "MCP JSON-RPC 响应缺少 result".into())
}
#[derive(Default)]
struct Sse {
    pending: Vec<u8>,
    data: String,
}
impl Sse {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        if self.pending.len() + bytes.len() > MAX_FRAME {
            return Err("MCP SSE 单条消息过大".into());
        }
        self.pending.extend_from_slice(bytes);
        let mut messages = Vec::new();
        while let Some(end) = self.pending.iter().position(|c| *c == b'\n') {
            let line = self.pending.drain(..=end).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "MCP SSE 必须为 UTF-8")?
                .trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    if messages.len() >= MAX_MESSAGES {
                        return Err("MCP SSE 消息数量超过上限".into());
                    }
                    messages.push(
                        serde_json::from_str(&self.data)
                            .map_err(|_| "MCP SSE data 不是有效 JSON-RPC")?,
                    );
                    self.data.clear();
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                let data = data.strip_prefix(' ').unwrap_or(data);
                if self.data.len() + data.len() + 1 > MAX_FRAME {
                    return Err("MCP SSE 单条消息过大".into());
                }
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(data);
            }
        }
        Ok(messages)
    }
}

enum Transport {
    Stdio(Box<StdioTransport>),
    Http(HttpTransport),
}
pub(super) struct Session {
    transport: Transport,
    next_id: u64,
    closed: bool,
    lifetime: watch::Receiver<bool>,
}
impl Session {
    pub(super) async fn connect(
        config: &Value,
        project: &Path,
        cancel: watch::Receiver<bool>,
        lifetime: watch::Receiver<bool>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let deadline = tokio::time::Instant::now() + timeout;
        let transport = if config["type"] == "local" {
            Transport::Stdio(Box::new(StdioTransport::spawn(config, project)?))
        } else {
            Transport::Http(HttpTransport::new(config)?)
        };
        let mut session = Self {
            transport,
            next_id: 1,
            closed: false,
            lifetime,
        };
        let response=session.request("initialize",json!({"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"LoliCode","version":env!("CARGO_PKG_VERSION")}}),cancel.clone(),timeout).await?;
        let version = response["protocolVersion"]
            .as_str()
            .filter(|v| matches!(*v, "2025-06-18" | "2025-03-26" | "2024-11-05"))
            .map(str::to_string);
        let Some(version) = version else {
            session.close().await?;
            return Err("MCP 服务器协议版本不受支持".into());
        };
        if matches!(&session.transport, Transport::Http(_)) && version == "2024-11-05" {
            session.close().await?;
            return Err(
                "MCP HTTP 服务器协商了旧版 SSE 协议，当前 Streamable HTTP 连接不支持该版本".into(),
            );
        }
        if !response
            .pointer("/capabilities/tools")
            .is_some_and(Value::is_object)
        {
            session.close().await?;
            return Err("MCP 服务器未声明 tools 能力".into());
        }
        if let Transport::Http(http) = &mut session.transport {
            http.version = Some(version);
        }
        let mut cancel = cancel;
        let mut lifetime = session.lifetime.clone();
        let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
        let initialized = json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        let result = tokio::select! {biased;_=cancelled(&mut cancel)=>Err("MCP 初始化已取消".into()),_=cancelled(&mut lifetime)=>Err("MCP 配置已关闭".into()),result=tokio::time::timeout(timeout,session.notify(&initialized))=>result.unwrap_or_else(|_|Err("MCP initialized 通知超时".into()))};
        match result {
            Ok(()) => Ok(session),
            Err(error) => {
                session.close().await?;
                Err(error)
            }
        }
    }
    async fn notify(&mut self, message: &Value) -> Result<(), String> {
        match &mut self.transport {
            Transport::Stdio(stdio) => stdio.send(message).await,
            Transport::Http(http) => http.notify(message).await,
        }
    }
    pub(super) async fn request(
        &mut self,
        method: &str,
        params: Value,
        mut cancel: watch::Receiver<bool>,
        timeout: Duration,
    ) -> Result<Value, String> {
        if self.closed {
            return Err("MCP 连接已关闭，请重新发现工具".into());
        }
        let id = self.next_id;
        self.next_id += 1;
        let mut lifetime = self.lifetime.clone();
        let work = async {
            match &mut self.transport {
                Transport::Stdio(stdio) => stdio.rpc(id, method, params).await,
                Transport::Http(http) => http.rpc(id, method, params).await,
            }
        };
        let (result, interrupted) = tokio::select! {biased;_=cancelled(&mut cancel)=>(Err("MCP 操作已取消".into()),true),_=cancelled(&mut lifetime)=>(Err("MCP 配置已关闭".into()),true),result=tokio::time::timeout(timeout,work)=>match result {Ok(value)=>(value,false),Err(_)=>(Err("MCP 请求超时".into()),true)}};
        if interrupted {
            let _=tokio::time::timeout(Duration::from_millis(250),self.notify(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":"Client cancelled or timed out"}}))).await;
            let remote = matches!(self.transport, Transport::Http(_));
            self.close().await?;
            if remote && method == "tools/call" {
                return Err("[cleanup_uncertain]MCP 远程请求已取消或超时，已发送取消通知；服务器此前的副作用无法确认，请勿自动重试".into());
            }
        } else if result.is_err() {
            self.close().await?;
        }
        result
    }
    pub(super) fn is_closed(&self) -> bool {
        self.closed
    }
    pub(super) async fn close(&mut self) -> Result<(), String> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        match &mut self.transport {
            Transport::Stdio(stdio) => stdio.close().await,
            Transport::Http(http) => {
                http.close().await;
                Ok(())
            }
        }
    }
}
