use super::{bounded, command, ToolInspection, ToolOutput, CANCELLED};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{watch, Mutex},
    time::{sleep, timeout},
};
use uuid::Uuid;

const MAX_PROCESSES: usize = 8;
const MAX_LIFETIME_SECONDS: u64 = 2 * 60 * 60;

#[derive(Default)]
pub(in crate::native) struct Processes(Mutex<HashMap<String, Process>>);

struct Process {
    owner: String,
    stop: watch::Sender<bool>,
    result: watch::Receiver<Option<Result<String, String>>>,
    log: Arc<StdMutex<Vec<u8>>>,
}

impl Drop for Process {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

pub(super) enum Operation {
    Start {
        command: String,
        workdir: PathBuf,
        port: Option<u16>,
    },
    Logs(String),
    Stop(String),
}

pub(super) fn parse(root: &Path, input: &Value) -> Result<Operation, String> {
    let action = input["action"].as_str().ok_or("缺少进程操作")?;
    match action {
        "start" => {
            let args = super::args(input, &["action", "command", "workdir", "port"])?;
            let command = super::text(args, "command")?.trim();
            if command.is_empty() || command.len() > 8192 {
                return Err("命令为空或过长".into());
            }
            let workdir = super::resolve(root, super::optional_path(args, "workdir")?, false)?;
            if !workdir.is_dir() {
                return Err("后台进程工作目录不存在".into());
            }
            let port = args
                .get("port")
                .map(|value| {
                    value
                        .as_u64()
                        .and_then(|value| u16::try_from(value).ok())
                        .filter(|value| *value != 0)
                        .ok_or("本机端口必须在 1–65535 之间")
                })
                .transpose()?;
            Ok(Operation::Start {
                command: command.into(),
                workdir,
                port,
            })
        }
        "logs" | "stop" => {
            let args = super::args(input, &["action", "process_id"])?;
            let id = super::text(args, "process_id")?;
            let valid = id
                .strip_prefix("process-")
                .and_then(|id| Uuid::parse_str(id).ok());
            if valid.is_none() || id.len() != 44 {
                return Err("无效的进程 ID".into());
            }
            Ok(if action == "logs" {
                Operation::Logs(id.into())
            } else {
                Operation::Stop(id.into())
            })
        }
        _ => Err("进程操作必须是 start、logs 或 stop".into()),
    }
}

impl Operation {
    pub(super) fn inspect(&self) -> ToolInspection {
        match self {
            Self::Start {
                command, workdir, ..
            } => ToolInspection {
                action: "process-start".into(),
                resources: vec![workdir.to_string_lossy().into_owned(), command.clone()],
                description: "启动本机会话管理的后台命令".into(),
                mutating: true,
                requires_approval: true,
                dangerous: true,
            },
            Self::Logs(id) | Self::Stop(id) => ToolInspection {
                action: if matches!(self, Self::Logs(_)) {
                    "process-logs"
                } else {
                    "process-stop"
                }
                .into(),
                resources: vec![id.clone()],
                description: "读取或停止此会话拥有的后台命令".into(),
                mutating: false,
                requires_approval: false,
                dangerous: false,
            },
        }
    }
}

fn output(value: Value) -> ToolOutput {
    ToolOutput {
        text: value.to_string(),
        image_data_url: None,
        diffs: vec![],
        file_changes: vec![],
    }
}

fn logs(log: &StdMutex<Vec<u8>>) -> String {
    let log = log.lock().unwrap_or_else(|error| error.into_inner());
    bounded(String::from_utf8_lossy(&log).into_owned())
}

async fn finished(result: &mut watch::Receiver<Option<Result<String, String>>>) {
    let _ = result.wait_for(Option::is_some).await;
}

async fn settle(
    result: &mut watch::Receiver<Option<Result<String, String>>>,
) -> Result<(), String> {
    timeout(Duration::from_secs(8), finished(result))
        .await
        .map_err(|_| super::cleanup_failure("后台进程停止超时"))?;
    match &*result.borrow() {
        Some(Err(error)) if super::cleanup_uncertain(error) => Err(error.clone()),
        Some(_) => Ok(()),
        None => Err(super::cleanup_failure("后台进程未返回清理结果")),
    }
}

async fn listens(port: u16) -> bool {
    timeout(
        Duration::from_millis(200),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

impl Processes {
    pub(super) async fn execute(
        &self,
        owner: &str,
        project: &Path,
        operation: Operation,
        isolated: bool,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<ToolOutput, String> {
        super::cancelled(&cancel)?;
        let stopping = matches!(operation, Operation::Stop(_));
        match operation {
            Operation::Start {
                command,
                workdir,
                port,
            } => {
                let mut processes = self.0.lock().await;
                if processes.len() >= MAX_PROCESSES {
                    if let Some(id) = processes
                        .iter()
                        .find(|(_, process)| process.result.borrow().is_some())
                        .map(|(id, _)| id.clone())
                    {
                        processes.remove(&id);
                    } else {
                        return Err("后台进程已达上限，请先停止一个进程".into());
                    }
                }
                if let Some(port) = port {
                    if listens(port).await {
                        return Err(format!("本机端口 {port} 已被占用，请指定其他端口"));
                    }
                }
                super::cancelled(&cancel)?;
                let running = command::spawn(project, &workdir, &command, isolated, None).await?;
                let (stop, stop_rx) = watch::channel(false);
                let (notify, mut result) = watch::channel(None);
                let log = Arc::new(StdMutex::new(Vec::new()));
                let captured = log.clone();
                tokio::spawn(async move {
                    let outcome =
                        command::monitor(running, MAX_LIFETIME_SECONDS, stop_rx, Some(captured))
                            .await
                            .map(|output| output.text);
                    notify.send_replace(Some(outcome));
                });
                let id = format!("process-{}", Uuid::new_v4());
                processes.insert(
                    id.clone(),
                    Process {
                        owner: owner.into(),
                        stop: stop.clone(),
                        result: result.clone(),
                        log: log.clone(),
                    },
                );
                drop(processes);
                if let Some(port) = port {
                    let ready = async {
                        loop {
                            if listens(port).await && result.borrow().is_none() {
                                break;
                            }
                            sleep(Duration::from_millis(75)).await;
                        }
                    };
                    let mut ended = result.clone();
                    let reason = tokio::select! {
                        biased;
                        _ = cancel.changed() => Some(CANCELLED.to_owned()),
                        _ = finished(&mut ended) => Some(format!("后台命令退出，端口 {port} 尚未就绪")),
                        readiness = timeout(Duration::from_secs(12), ready) => readiness.err().map(|_| format!("后台命令启动后 12 秒内端口 {port} 未就绪")),
                    };
                    if let Some(reason) = reason {
                        stop.send_replace(true);
                        settle(&mut result).await?;
                        self.0.lock().await.remove(&id);
                        return Err(if reason == CANCELLED {
                            reason
                        } else {
                            bounded(format!("{reason}\n{}", logs(&log)))
                        });
                    }
                }
                Ok(output(
                    json!({"process_id":id,"status":"running","ready_port":port,"logs":logs(&log)}),
                ))
            }
            Operation::Logs(id) | Operation::Stop(id) => {
                let processes = self.0.lock().await;
                let process = processes
                    .get(&id)
                    .filter(|process| process.owner == owner)
                    .ok_or("进程不存在或不属于当前会话")?;
                let mut result = process.result.clone();
                let log = process.log.clone();
                if stopping {
                    process.stop.send_replace(true);
                }
                drop(processes);
                if stopping {
                    settle(&mut result).await?;
                }
                let status = result.borrow().as_ref().map(|outcome| match outcome {
                    Ok(text) => text.lines().next().unwrap_or("exited").to_owned(),
                    Err(error) if error == CANCELLED => "stopped".into(),
                    Err(error) => bounded(error.clone()),
                });
                Ok(output(
                    json!({"process_id":id,"status":status.as_deref().unwrap_or("running"),"logs":logs(&log)}),
                ))
            }
        }
    }

    pub(in crate::native) async fn shutdown(&self) -> Result<(), String> {
        let processes = std::mem::take(&mut *self.0.lock().await);
        for process in processes.values() {
            process.stop.send_replace(true);
        }
        for process in processes.values() {
            settle(&mut process.result.clone()).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn managed_process_keeps_logs_and_only_the_owner_can_stop_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let processes = Processes::default();
        let (_turn, cancel) = watch::channel(false);
        #[cfg(windows)]
        let command = "echo MANAGED_READY & ping -n 30 127.0.0.1 >nul";
        #[cfg(not(windows))]
        let command = "printf 'MANAGED_READY\\n'; sleep 30";
        let started = processes
            .execute(
                "owner",
                root,
                Operation::Start {
                    command: command.into(),
                    workdir: root.into(),
                    port: None,
                },
                false,
                cancel.clone(),
            )
            .await
            .unwrap();
        let receipt: Value = serde_json::from_str(&started.text).unwrap();
        let id = receipt["process_id"].as_str().unwrap().to_owned();
        let live = timeout(Duration::from_secs(5), async {
            loop {
                let result = processes
                    .execute(
                        "owner",
                        root,
                        Operation::Logs(id.clone()),
                        false,
                        cancel.clone(),
                    )
                    .await
                    .unwrap();
                if result.text.contains("MANAGED_READY") {
                    break result.text;
                }
                sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
        assert!(live.contains("running"));
        assert!(processes
            .execute(
                "other",
                root,
                Operation::Stop(id.clone()),
                false,
                cancel.clone()
            )
            .await
            .is_err());
        let stopped = processes
            .execute("owner", root, Operation::Stop(id), false, cancel)
            .await
            .unwrap();
        assert!(stopped.text.contains("stopped") && stopped.text.contains("MANAGED_READY"));
    }

    #[tokio::test]
    #[ignore = "requires the locally installed Node.js used for browser acceptance"]
    async fn managed_node_server_survives_tool_return_until_explicit_stop() {
        let root = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let browser_test = std::env::var_os("LOLICODE_BROWSER_ACCEPTANCE_BINARY");
        let body = if browser_test.is_some() {
            let project = std::env::var("LOLICODE_BROWSER_ACCEPTANCE_PROJECT").unwrap();
            let page = Path::new(&project).join("index.html");
            format!("fs.readFileSync({})", json!(page.to_str().unwrap()))
        } else {
            "'managed-browser-ok'".into()
        };
        let script = format!(
            r#"
const fs = require('node:fs');
const body = {body};
require('node:http').createServer((req, res) => {{
    fs.appendFileSync('requests.log', req.url + '\n');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(body);
}}).listen({port}, '127.0.0.1', () => console.log('LISTENING'));
"#
        );
        tokio::fs::write(root.path().join("server.cjs"), script)
            .await
            .unwrap();
        let processes = Processes::default();
        let (_turn, cancel) = watch::channel(false);
        let started = processes
            .execute(
                "owner",
                root.path(),
                Operation::Start {
                    command: "node server.cjs".into(),
                    workdir: root.path().into(),
                    port: Some(port),
                },
                false,
                cancel.clone(),
            )
            .await
            .unwrap();
        let receipt: Value = serde_json::from_str(&started.text).unwrap();
        assert_eq!(receipt["ready_port"], port);
        if let Some(browser_test) = browser_test {
            let acceptance = tokio::process::Command::new(browser_test)
                .args([
                    "live_bicycle_demo_browser_acceptance",
                    "--ignored",
                    "--nocapture",
                ])
                .env(
                    "LOLICODE_BROWSER_ACCEPTANCE_URL",
                    format!("http://127.0.0.1:{port}/index.html"),
                )
                .output()
                .await
                .unwrap();
            assert!(
                acceptance.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&acceptance.stdout),
                String::from_utf8_lossy(&acceptance.stderr)
            );
            println!("{}", String::from_utf8_lossy(&acceptance.stdout));
            assert!(tokio::fs::read_to_string(root.path().join("requests.log"))
                .await
                .unwrap()
                .contains("/index.html"));
        } else {
            let response = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(format!("http://127.0.0.1:{port}/"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert_eq!(response, "managed-browser-ok");
        }
        let id = receipt["process_id"].as_str().unwrap();
        let stopped = processes
            .execute(
                "owner",
                root.path(),
                Operation::Stop(id.into()),
                false,
                cancel,
            )
            .await
            .unwrap();
        assert!(stopped.text.contains("LISTENING"));
        assert!(!listens(port).await);
    }
}
