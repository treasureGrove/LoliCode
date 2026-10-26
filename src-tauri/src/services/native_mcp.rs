//! Explicitly configured LoliCode MCP servers. Configuration never starts a
//! process: discovery is an explicit host operation, and discovery grants no
//! permission to call a tool. Server annotations are untrusted permissions.
use lolicode_agent::native::applications::{
    ApplicationOutput, ApplicationResult, ApplicationTools, ToolInspection, ToolOutput,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::sync::{watch, Mutex, MutexGuard};

#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod tests;
mod transport;

const MAX_TOOLS: usize = 512;
const MAX_SCHEMA_BYTES: usize = 64 * 1024;
const MAX_ARGUMENT_BYTES: usize = 256 * 1024;
const MAX_TEXT_BYTES: usize = 128 * 1024;
const PREFIX: &str = "mcp_";

#[derive(Clone)]
struct Server {
    id: String,
    fingerprint: String,
    config: Value,
    disabled: bool,
    unsupported: Option<String>,
    secrets: Vec<String>,
}
impl Server {
    fn redact(&self, text: &str) -> String {
        let mut text = text.to_string();
        for secret in &self.secrets {
            text = text.replace(secret, "[已隐藏]");
        }
        text
    }
    fn redact_value(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.redact(text),
            Value::Array(values) => {
                for value in values {
                    self.redact_value(value);
                }
            }
            Value::Object(values) => {
                let previous = std::mem::take(values);
                for (key, mut value) in previous {
                    self.redact_value(&mut value);
                    values.insert(self.redact(&key), value);
                }
            }
            _ => {}
        }
    }
}

#[derive(Clone)]
struct Tool {
    server: Server,
    original_name: String,
    schema: Value,
}
#[derive(Default)]
struct Configuration {
    revision: u64,
    fingerprint: String,
    generation: u64,
    servers: BTreeMap<String, Server>,
}
#[derive(Default)]
struct Catalog {
    tools: HashMap<(String, String), Tool>,
    statuses: HashMap<(String, String), Value>,
}
struct Connection {
    session: Mutex<Option<transport::Session>>,
    stop: watch::Sender<bool>,
}

/// The engine may stop preparing a turn by dropping its future before the
/// transport's cancellation branch is polled. Only a discovery that actually
/// owns the connection may close it; waiting for another call's lock is inert.
struct DiscoveryLease<'a> {
    connection: MutexGuard<'a, Option<transport::Session>>,
    manager: &'a NativeMcpTools,
    project: &'a str,
    server: &'a Server,
    retained: bool,
}
impl std::ops::Deref for DiscoveryLease<'_> {
    type Target = Option<transport::Session>;
    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}
impl std::ops::DerefMut for DiscoveryLease<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.connection
    }
}
impl Drop for DiscoveryLease<'_> {
    fn drop(&mut self) {
        if !self.retained {
            self.manager.status(
                self.project,
                self.server,
                "disconnected",
                Some("MCP 工具发现已中止".into()),
                0,
            );
            if let Some(mut session) = self.connection.take() {
                if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                    runtime.spawn(async move {
                        let _ = session.close().await;
                    });
                }
                // Without a running runtime, transport Drop still kills its
                // owned process group and closes local network handles.
            }
        }
    }
}
impl Connection {
    fn new() -> Self {
        let (stop, _) = watch::channel(false);
        Self {
            session: Mutex::new(None),
            stop,
        }
    }
}

pub struct NativeMcpTools {
    configuration: RwLock<Configuration>,
    catalog: RwLock<Catalog>,
    connections: Mutex<HashMap<(String, String, String), Arc<Connection>>>,
    request_timeout: Duration,
}
impl Default for NativeMcpTools {
    fn default() -> Self {
        Self::new()
    }
}

fn fingerprint(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn project_key(project: &Path) -> Result<String, String> {
    let path = std::fs::canonicalize(project).map_err(|_| "MCP 项目目录不可用")?;
    if !path.is_dir() {
        return Err("MCP 项目必须是目录".into());
    }
    Ok(path.to_string_lossy().into_owned())
}
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
fn string_map(value: Option<&Value>) -> bool {
    value.is_none_or(|value| {
        value.as_object().is_some_and(|map| {
            map.len() <= 128
                && map.iter().all(|(key, value)| {
                    !key.is_empty()
                        && !key.contains(['\0', '='])
                        && value
                            .as_str()
                            .is_some_and(|text| text.len() <= 16 * 1024 && !text.contains('\0'))
                })
        })
    })
}
fn parse_servers(mcp: &Value) -> Result<BTreeMap<String, Server>, String> {
    if mcp.to_string().len() > 1024 * 1024 {
        return Err("MCP 配置超过 1 MiB".into());
    }
    let servers = mcp
        .get("servers")
        .and_then(Value::as_object)
        .ok_or("MCP 配置需要 servers 对象")?;
    if servers.len() > 32 {
        return Err("MCP 服务器数量超过 32 个".into());
    }
    let mut parsed = BTreeMap::new();
    for (id, config) in servers {
        if !safe_id(id)
            || !config.is_object()
            || !string_map(config.get("environment"))
            || !string_map(config.get("headers"))
            || config.get("disabled").is_some_and(|v| !v.is_boolean())
        {
            return Err("MCP 服务器配置格式无效".into());
        }
        match config["type"].as_str() {
            Some("local") => {
                if !config["command"].as_array().is_some_and(|args| {
                    !args.is_empty()
                        && args.len() <= 128
                        && args.iter().all(|a| {
                            a.as_str().is_some_and(|s| {
                                !s.is_empty() && s.len() <= 16 * 1024 && !s.contains('\0')
                            })
                        })
                }) {
                    return Err("本地 MCP 需要有效 command 数组".into());
                }
                if config.get("cwd").is_some_and(|v| {
                    !v.as_str()
                        .is_some_and(|s| Path::new(s).is_absolute() && !s.contains('\0'))
                }) {
                    return Err("MCP cwd 必须是绝对目录".into());
                }
            }
            Some("remote") => {
                let url = url::Url::parse(config["url"].as_str().unwrap_or_default())
                    .map_err(|_| "远程 MCP URL 无效")?;
                if !matches!(url.scheme(), "http" | "https")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err("远程 MCP URL 仅接受不含凭据、查询或片段的 HTTP(S) 地址".into());
                }
            }
            _ => return Err("MCP type 必须为 local 或 remote".into()),
        }
        let unsupported = if config.get("oauth").is_some_and(|v| !v.is_null()) {
            Some("此原生 MCP 连接尚未实现 OAuth 登录，请使用已配置的 headers 凭据".into())
        } else if config["transport"] == "sse" {
            Some("此连接使用旧版 HTTP+SSE；当前支持 Streamable HTTP 的 JSON/SSE 响应，请配置其 MCP HTTP 端点".into())
        } else {
            None
        };
        let mut secrets = Vec::new();
        for field in ["environment", "headers", "oauth"] {
            if let Some(values) = config[field].as_object() {
                for value in values.values().filter_map(Value::as_str) {
                    if !value.is_empty() {
                        secrets.push(value.to_string());
                    }
                    if let Some(token) = value.strip_prefix("Bearer ").filter(|s| !s.is_empty()) {
                        secrets.push(token.to_string());
                    }
                }
            }
        }
        if let Some(args) = config["command"].as_array() {
            secrets.extend(
                args.iter()
                    .skip(1)
                    .filter_map(Value::as_str)
                    .filter(|s| s.len() >= 4)
                    .map(str::to_string),
            );
        }
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        secrets.dedup();
        parsed.insert(
            id.clone(),
            Server {
                id: id.clone(),
                fingerprint: fingerprint(config),
                config: config.clone(),
                disabled: config["disabled"] == true,
                unsupported,
                secrets,
            },
        );
    }
    Ok(parsed)
}
fn tool_name(server: &Server, original: &str) -> String {
    let readable = |s: &str, n: usize| {
        s.chars()
            .take(n)
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>()
    };
    let hash = fingerprint(&json!([server.id, original]));
    format!(
        "mcp_{}_{}_{}",
        readable(&server.id, 16),
        readable(&server.redact(original), 25),
        &hash[..12]
    )
}
fn truncate(mut text: String, max: usize) -> String {
    if text.len() > max {
        let mut end = max;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n[内容已截断]");
    }
    text
}

impl NativeMcpTools {
    pub fn new() -> Self {
        Self {
            configuration: RwLock::new(Configuration::default()),
            catalog: RwLock::new(Catalog::default()),
            connections: Mutex::new(HashMap::new()),
            request_timeout: Duration::from_secs(120),
        }
    }
    /// Only the host supplies LoliCode's validated private configuration here.
    /// No external application's settings or credentials are discovered.
    pub async fn configure(&self, revision: u64, mcp: Value) -> Result<(), String> {
        let servers = parse_servers(&mcp)?;
        let next = fingerprint(&mcp);
        let mut connections = self.connections.lock().await;
        {
            let mut current = self
                .configuration
                .write()
                .map_err(|_| "MCP 配置状态不可用")?;
            if current.fingerprint == next {
                current.revision = revision;
                return Ok(());
            }
            *current = Configuration {
                revision,
                fingerprint: next,
                generation: current.generation + 1,
                servers,
            };
            *self.catalog.write().map_err(|_| "MCP 工具目录不可用")? = Catalog::default();
        }
        let previous = std::mem::take(&mut *connections);
        drop(connections);
        Self::close_owned_connections(previous).await
    }
    async fn close_owned_connections(
        connections: HashMap<(String, String, String), Arc<Connection>>,
    ) -> Result<(), String> {
        for connection in connections.values() {
            connection.stop.send_replace(true);
        }
        let mut failure = None;
        for slot in connections.into_values() {
            if let Some(mut session) = slot.session.lock().await.take() {
                if let Err(error) = session.close().await {
                    failure.get_or_insert(error);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        let connections = std::mem::take(&mut *self.connections.lock().await);
        let result = Self::close_owned_connections(connections).await;
        if let Ok(mut catalog) = self.catalog.write() {
            *catalog = Catalog::default();
        }
        result
    }
    /// Fail closed when the host cannot read or parse the current settings.
    /// Unlike a transient network failure, invalid settings revoke the saved
    /// server definitions as well as their connections and discovered tools.
    pub async fn invalidate(&self) -> Result<(), String> {
        let mut connections = self.connections.lock().await;
        {
            let mut current = self
                .configuration
                .write()
                .map_err(|_| "MCP 配置状态不可用")?;
            *current = Configuration {
                generation: current.generation + 1,
                ..Configuration::default()
            };
            *self.catalog.write().map_err(|_| "MCP 工具目录不可用")? = Catalog::default();
        }
        let previous = std::mem::take(&mut *connections);
        drop(connections);
        Self::close_owned_connections(previous).await
    }
    fn current(&self, server: &Server, generation: u64) -> bool {
        self.configuration.read().ok().is_some_and(|config| {
            config.generation == generation
                && config
                    .servers
                    .get(&server.id)
                    .is_some_and(|s| !s.disabled && s.fingerprint == server.fingerprint)
        })
    }
    fn status(
        &self,
        project: &str,
        server: &Server,
        status: &str,
        error: Option<String>,
        count: usize,
    ) {
        let Ok(config) = self.configuration.read() else {
            return;
        };
        if !{
            config.servers.get(&server.id).is_some_and(|current| {
                current.fingerprint == server.fingerprint && current.disabled == server.disabled
            })
        } {
            return;
        }
        if let Ok(mut catalog) = self.catalog.write() {
            catalog.statuses.insert((project.into(),server.id.clone()),json!({"name":server.id,"status":status,"error":error.map(|e| server.redact(&e)),"toolCount":count}));
        }
    }
    pub fn status_catalog(&self, project: &Path) -> Vec<Value> {
        let Ok(project) = project_key(project) else {
            return Vec::new();
        };
        let Ok(config) = self.configuration.read() else {
            return Vec::new();
        };
        let Ok(catalog) = self.catalog.read() else {
            return Vec::new();
        };
        config.servers.values().map(|server| catalog.statuses.get(&(project.clone(),server.id.clone())).cloned().unwrap_or_else(|| json!({"name":server.id,"status":if server.disabled {"disabled"} else {"disconnected"},"error":Value::Null,"toolCount":0}))).collect()
    }
    pub fn schemas_for_project(&self, project: &Path) -> Vec<Value> {
        let Ok(project) = project_key(project) else {
            return Vec::new();
        };
        let Ok(catalog) = self.catalog.read() else {
            return Vec::new();
        };
        let mut schemas = catalog
            .tools
            .iter()
            .filter(|((scope, _), _)| scope == &project)
            .map(|(_, tool)| tool.schema.clone())
            .collect::<Vec<_>>();
        schemas.sort_by(|a, b| {
            a["function"]["name"]
                .as_str()
                .cmp(&b["function"]["name"].as_str())
        });
        schemas
    }
    pub fn deferred_tool_names(&self, project: &Path) -> Vec<String> {
        self.schemas_for_project(project)
            .into_iter()
            .filter_map(|schema| schema["function"]["name"].as_str().map(str::to_string))
            .collect()
    }
    async fn slot(&self, project: &str, server: &Server) -> Result<Arc<Connection>, String> {
        let mut connections = self.connections.lock().await;
        let key = (
            project.into(),
            server.id.clone(),
            server.fingerprint.clone(),
        );
        if connections.len() >= 64 && !connections.contains_key(&key) {
            return Err("MCP 活跃连接达到上限，请断开不再使用的项目".into());
        }
        Ok(connections
            .entry(key)
            .or_insert_with(|| Arc::new(Connection::new()))
            .clone())
    }
    pub async fn discover(
        &self,
        project: &Path,
        cancel: watch::Receiver<bool>,
    ) -> Result<Vec<Value>, String> {
        let project = project_key(project)?;
        let (generation, servers) = {
            let config = self
                .configuration
                .read()
                .map_err(|_| "MCP 配置状态不可用")?;
            (
                config.generation,
                config.servers.values().cloned().collect::<Vec<_>>(),
            )
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        for server in servers {
            if *cancel.borrow() {
                return Err("MCP 工具发现已取消".into());
            }
            if server.disabled {
                self.status(&project, &server, "disabled", None, 0);
                continue;
            }
            if let Some(error) = &server.unsupported {
                self.status(&project, &server, "error", Some(error.clone()), 0);
                continue;
            }
            self.status(&project, &server, "connecting", None, 0);
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let result = if remaining.is_zero() {
                Err("MCP 工具发现达到 30 秒总时间上限".into())
            } else {
                self.discover_server(&project, &server, generation, cancel.clone(), deadline)
                    .await
            };
            let config = self
                .configuration
                .read()
                .map_err(|_| "MCP 配置状态不可用")?;
            if config.generation != generation
                || !config.servers.get(&server.id).is_some_and(|current| {
                    !current.disabled && current.fingerprint == server.fingerprint
                })
            {
                continue;
            }
            let mut catalog = self.catalog.write().map_err(|_| "MCP 工具目录不可用")?;
            catalog
                .tools
                .retain(|(scope, _), tool| scope != &project || tool.server.id != server.id);
            match result {
                Ok(tools) => {
                    let count = tools.len();
                    if catalog
                        .tools
                        .keys()
                        .filter(|(scope, _)| scope == &project)
                        .count()
                        + count
                        > MAX_TOOLS
                    {
                        catalog.statuses.insert((project.clone(),server.id.clone()),json!({"name":server.id,"status":"error","error":"当前项目 MCP 工具总数超过 512 项上限","toolCount":0}));
                        continue;
                    }
                    for tool in tools {
                        catalog.tools.insert(
                            (
                                project.clone(),
                                tool.schema["function"]["name"].as_str().unwrap().into(),
                            ),
                            tool,
                        );
                    }
                    catalog.statuses.insert((project.clone(),server.id.clone()),json!({"name":server.id,"status":"connected","error":Value::Null,"toolCount":count}));
                }
                Err(error) => {
                    catalog.statuses.insert((project.clone(),server.id.clone()),json!({"name":server.id,"status":"error","error":server.redact(&error),"toolCount":0}));
                }
            }
        }
        Ok(self.schemas_for_project(Path::new(&project)))
    }
    async fn discover_server(
        &self,
        project: &str,
        server: &Server,
        generation: u64,
        cancel: watch::Receiver<bool>,
        deadline: tokio::time::Instant,
    ) -> Result<Vec<Tool>, String> {
        let slot = self.slot(project, server).await?;
        let timeout = || {
            deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .min(Duration::from_secs(20))
        };
        let mut connection = DiscoveryLease {
            connection: transport::lock(&slot.session, cancel.clone(), timeout()).await?,
            manager: self,
            project,
            server,
            retained: false,
        };
        if !self.current(server, generation) {
            return Err("MCP 配置已变化，请重新发现工具".into());
        }
        if connection
            .as_ref()
            .is_some_and(|session| session.is_closed())
        {
            connection.take();
        }
        if connection.is_none() {
            *connection = Some(
                transport::Session::connect(
                    &server.config,
                    Path::new(project),
                    cancel.clone(),
                    slot.stop.subscribe(),
                    timeout(),
                )
                .await?,
            );
        }
        let session = connection.as_mut().unwrap();
        let mut cursor = None;
        let mut tools = Vec::new();
        for _ in 0..16 {
            let result = session
                .request(
                    "tools/list",
                    cursor
                        .as_ref()
                        .map(|c| json!({"cursor":c}))
                        .unwrap_or_else(|| json!({})),
                    cancel.clone(),
                    timeout(),
                )
                .await?;
            let entries = result["tools"]
                .as_array()
                .ok_or("MCP tools/list 未返回工具数组")?;
            for entry in entries {
                if tools.len() >= MAX_TOOLS {
                    return Err("MCP 工具目录超过 512 项上限".into());
                }
                let original = entry["name"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
                    .ok_or("MCP 工具名称无效")?;
                let mut parameters = entry["inputSchema"].clone();
                if !parameters.is_object()
                    || parameters.get("type").is_some_and(|v| v != "object")
                    || parameters.to_string().len() > MAX_SCHEMA_BYTES
                {
                    return Err("MCP 工具参数 schema 无效或超过 64 KiB".into());
                }
                parameters["type"] = json!("object");
                server.redact_value(&mut parameters);
                let name = tool_name(server, original);
                if tools
                    .iter()
                    .any(|tool: &Tool| tool.schema["function"]["name"] == name)
                {
                    return Err("MCP 工具目录含重复工具名".into());
                }
                let description =
                    server.redact(entry["description"].as_str().unwrap_or("MCP external tool"));
                tools.push(Tool { server:server.clone(), original_name:original.into(), schema:json!({"type":"function","function":{"name":name,"description":truncate(format!("MCP server {}: {}. External tool; execution requires approval.",server.id,description),4096),"parameters":parameters}}) });
            }
            let next = result["nextCursor"].as_str().map(str::to_string);
            if next.is_none() {
                connection.retained = true;
                return Ok(tools);
            }
            if next == cursor || next.as_ref().is_some_and(|c| c.len() > 4096) {
                return Err("MCP 工具分页游标无效".into());
            }
            cursor = next;
        }
        Err("MCP 工具目录分页超过上限".into())
    }
    fn lookup(&self, project: &Path, name: &str, input: &Value) -> Result<(String, Tool), String> {
        if !input.is_object() || input.to_string().len() > MAX_ARGUMENT_BYTES {
            return Err("MCP 参数必须是 256 KiB 以内的 JSON 对象".into());
        }
        let project = project_key(project)?;
        let tool = self
            .catalog
            .read()
            .map_err(|_| "MCP 工具目录不可用")?
            .tools
            .get(&(project.clone(), name.into()))
            .cloned()
            .ok_or("此 MCP 工具尚未在当前项目发现，或配置已变化")?;
        let config = self
            .configuration
            .read()
            .map_err(|_| "MCP 配置状态不可用")?;
        if !config
            .servers
            .get(&tool.server.id)
            .is_some_and(|server| !server.disabled && server.fingerprint == tool.server.fingerprint)
        {
            return Err("MCP 服务器已禁用或配置已变化".into());
        }
        Ok((project, tool))
    }
    async fn call(
        &self,
        project: &Path,
        name: &str,
        input: &Value,
        cancel: watch::Receiver<bool>,
    ) -> Result<ToolOutput, String> {
        let (project, tool) = self.lookup(project, name, input)?;
        let slot = self.slot(&project, &tool.server).await?;
        let mut connection =
            transport::lock(&slot.session, cancel.clone(), self.request_timeout).await?;
        self.lookup(Path::new(&project), name, input)?;
        let session = connection
            .as_mut()
            .ok_or("MCP 连接已关闭，请重新发现工具后重试")?;
        let result = session
            .request(
                "tools/call",
                json!({"name":tool.original_name,"arguments":input}),
                cancel,
                self.request_timeout,
            )
            .await;
        let result = match result {
            Ok(value) => value,
            Err(error) => {
                self.status(&project, &tool.server, "error", Some(error.clone()), 0);
                return Err(tool.server.redact(&error));
            }
        };
        if !result.is_object()
            || (!result["content"].is_array() && !result["structuredContent"].is_object())
        {
            return Err("MCP 工具返回了无效结果，未确认执行成功".into());
        }
        let mut parts = Vec::new();
        let mut image_data_url = None;
        for block in result["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(text) = block["text"].as_str() {
                        parts.push(tool.server.redact(text));
                    }
                }
                Some("image") if image_data_url.is_none() => {
                    let data = block["data"].as_str().ok_or("MCP 图片缺少数据")?;
                    image_data_url = Some(
                        super::remote_agent_tools::image_data_url(data)
                            .map_err(|_| "MCP 图片格式或大小不受支持")?,
                    );
                }
                Some("resource_link") => parts.push(
                    tool.server
                        .redact(&json!({"name":block["name"],"uri":block["uri"]}).to_string()),
                ),
                Some("resource") => {
                    if let Some(text) = block.pointer("/resource/text").and_then(Value::as_str) {
                        parts.push(tool.server.redact(text));
                    }
                }
                _ => parts.push("[MCP 返回了未展示的内容块]".into()),
            }
        }
        if let Some(structured) = result.get("structuredContent") {
            let mut structured = structured.clone();
            tool.server.redact_value(&mut structured);
            parts.push(structured.to_string());
        }
        let text = truncate(parts.join("\n"), MAX_TEXT_BYTES);
        if result["isError"] == true {
            return Err(format!("MCP 工具报告执行失败：{}", truncate(text, 2048)));
        }
        Ok(ToolOutput {
            text: if text.is_empty() {
                "MCP 工具已返回。".into()
            } else {
                text
            },
            image_data_url,
            diffs: Vec::new(),
            file_changes: Vec::new(),
        })
    }
}

impl ApplicationTools for NativeMcpTools {
    fn prepare<'a>(
        &'a self,
        project: &'a Path,
        cancel: watch::Receiver<bool>,
    ) -> ApplicationResult<'a> {
        Box::pin(async move {
            self.discover(project, cancel).await?;
            Ok(String::new())
        })
    }
    fn schemas(&self) -> Vec<Value> {
        Vec::new()
    }
    fn schemas_for_project(&self, project: &Path) -> Vec<Value> {
        NativeMcpTools::schemas_for_project(self, project)
    }
    fn deferred_tool_names(&self, project: &Path) -> Vec<String> {
        NativeMcpTools::deferred_tool_names(self, project)
    }
    fn inspect(
        &self,
        project: &Path,
        name: &str,
        input: &Value,
    ) -> Option<Result<ToolInspection, String>> {
        if !name.starts_with(PREFIX) {
            return None;
        }
        Some(
            self.lookup(project, name, input)
                .map(|(project, tool)| ToolInspection {
                    action: "mcp-call".into(),
                    resources: vec![format!(
                        "{project} · MCP {} · {}",
                        tool.server.id, tool.server.fingerprint
                    )],
                    description: format!(
                        "调用 MCP 工具 {}",
                        tool.server.redact(&tool.original_name)
                    ),
                    mutating: true,
                    requires_approval: true,
                    dangerous: false,
                }),
        )
    }
    fn execute<'a>(
        &'a self,
        project: &'a Path,
        name: &'a str,
        input: &'a Value,
        cancel: watch::Receiver<bool>,
    ) -> ApplicationResult<'a> {
        Box::pin(async move {
            self.call(project, name, input, cancel)
                .await
                .map(|out| out.text)
        })
    }
    fn execute_output<'a>(
        &'a self,
        project: &'a Path,
        name: &'a str,
        input: &'a Value,
        cancel: watch::Receiver<bool>,
    ) -> ApplicationOutput<'a> {
        Box::pin(self.call(project, name, input, cancel))
    }
}
