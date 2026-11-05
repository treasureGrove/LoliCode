use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
};

use super::{agent_browser::ProcessTree, harness_paths::HarnessPaths};

const MAX_TERMINALS: usize = 32;
const MAX_REPLAY_BYTES: usize = 1024 * 1024;
const OUTPUT_EVENT: &str = "agent-terminal-output";

#[derive(Default)]
struct Replay {
    cursor: u64,
    bytes: usize,
    frames: VecDeque<String>,
    running: bool,
    exit_code: Option<i32>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalSnapshot {
    instance: Option<String>,
    cursor: u64,
    data: String,
    running: bool,
    exit_code: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output<'a> {
    session_id: &'a str,
    terminal_id: &'a str,
    instance: &'a str,
    cursor: u64,
    data: &'a str,
    exit_code: Option<i32>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ChildEvent {
    Ready,
    Output { data: String },
    Exit { code: i32 },
}

type TerminalKey = (String, String);

struct LiveTerminal {
    instance: String,
    replay: Arc<Mutex<Replay>>,
    sender: mpsc::Sender<Value>,
    _stop: oneshot::Sender<()>,
}

#[derive(Default)]
pub(crate) struct AgentTerminals {
    entries: Mutex<HashMap<TerminalKey, LiveTerminal>>,
    pub(crate) lifecycle: tokio::sync::Mutex<()>,
}

pub(crate) fn dimensions(cols: u16, rows: u16) -> Result<(), String> {
    if !(2..=512).contains(&cols) || !(2..=256).contains(&rows) {
        return Err("终端尺寸无效".into());
    }
    Ok(())
}

impl AgentTerminals {
    pub(crate) async fn start(
        &self,
        app: AppHandle,
        key: TerminalKey,
        project: &Path,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        dimensions(cols, rows)?;
        let paths = HarnessPaths::resolve(&app)?;
        let mut command = Command::new(&paths.node);
        command
            .arg(paths.package.join("host-terminal.mjs"))
            .current_dir(project)
            .env_clear()
            .env("TERM", "xterm-256color")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for name in [
            "PATH",
            "SHELL",
            "HOME",
            "USER",
            "USERNAME",
            "USERPROFILE",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "APPDATA",
            "LOCALAPPDATA",
            "COMSPEC",
            "PATHEXT",
            "LANG",
            "LC_ALL",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        #[cfg(not(windows))]
        command.process_group(0);

        let instance = uuid::Uuid::new_v4().to_string();
        let started = {
            let mut terminals = self.entries.lock().map_err(|_| "终端状态不可用")?;
            if let Some(terminal) = terminals.get(&key) {
                if terminal
                    .replay
                    .lock()
                    .map_err(|_| "终端状态不可用")?
                    .running
                {
                    return Ok(());
                }
            } else if terminals.len() >= MAX_TERMINALS {
                return Err("打开的终端过多，请先关闭部分终端".into());
            }

            let mut child = command.spawn().map_err(|_| "无法启动交互终端")?;
            let tree = ProcessTree::attach(&child).map_err(|_| "无法管理终端进程树")?;
            let mut stdin = child.stdin.take().ok_or("终端输入不可用")?;
            let stdout = child.stdout.take().ok_or("终端输出不可用")?;
            let (sender, mut writes) = mpsc::channel::<Value>(64);
            let (stop, stopped) = oneshot::channel::<()>();
            let (ready, started) = oneshot::channel::<()>();
            let replay = Arc::new(Mutex::new(Replay {
                running: true,
                ..Replay::default()
            }));
            terminals.insert(
                key.clone(),
                LiveTerminal {
                    instance: instance.clone(),
                    replay: Arc::clone(&replay),
                    sender,
                    _stop: stop,
                },
            );

            let start = json!({ "type": "start", "cwd": project, "cols": cols, "rows": rows });
            let task_key = key.clone();
            let task_instance = instance.clone();
            tauri::async_runtime::spawn(async move {
                let mut ready = Some(ready);
                let read = async {
                    let mut lines = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        match serde_json::from_str(&line) {
                            Ok(ChildEvent::Ready) => {
                                if let Some(ready) = ready.take() {
                                    let _ = ready.send(());
                                }
                            }
                            Ok(ChildEvent::Output { data }) => {
                                let cursor = {
                                    let Ok(mut screen) = replay.lock() else {
                                        return 1;
                                    };
                                    screen.cursor += 1;
                                    let cursor = screen.cursor;
                                    screen.bytes += data.len();
                                    screen.frames.push_back(data.clone());
                                    while screen.bytes > MAX_REPLAY_BYTES {
                                        let Some(frame) = screen.frames.pop_front() else {
                                            break;
                                        };
                                        screen.bytes -= frame.len();
                                    }
                                    cursor
                                };
                                let _ = app.emit_to(
                                    "main",
                                    OUTPUT_EVENT,
                                    &Output {
                                        session_id: &task_key.0,
                                        terminal_id: &task_key.1,
                                        instance: &task_instance,
                                        cursor,
                                        data: &data,
                                        exit_code: None,
                                    },
                                );
                            }
                            Ok(ChildEvent::Exit { code }) => return code,
                            Err(_) => return 1,
                        }
                    }
                    1
                };
                let write = async {
                    let mut next = Some(start);
                    while let Some(message) = next {
                        let mut line = message.to_string();
                        line.push('\n');
                        if stdin.write_all(line.as_bytes()).await.is_err() {
                            return;
                        }
                        next = writes.recv().await;
                    }
                };
                let (code, cancelled) = tokio::select! {
                    biased;
                    _ = stopped => (0, true),
                    code = read => (code, false),
                    _ = write => (1, true),
                };
                drop(stdin);
                if cancelled {
                    let _ =
                        tokio::time::timeout(std::time::Duration::from_secs(1), child.wait()).await;
                }
                drop(tree);
                let _ = child.kill().await;
                let cursor = {
                    let Ok(mut screen) = replay.lock() else {
                        return;
                    };
                    screen.running = false;
                    screen.exit_code = Some(code);
                    screen.cursor += 1;
                    screen.cursor
                };
                let _ = app.emit_to(
                    "main",
                    OUTPUT_EVENT,
                    &Output {
                        session_id: &task_key.0,
                        terminal_id: &task_key.1,
                        instance: &task_instance,
                        cursor,
                        data: "",
                        exit_code: Some(code),
                    },
                );
            });
            started
        };
        if matches!(
            tokio::time::timeout(std::time::Duration::from_secs(8), started).await,
            Ok(Ok(()))
        ) {
            return Ok(());
        }
        let mut terminals = self.entries.lock().map_err(|_| "终端状态不可用")?;
        if terminals
            .get(&key)
            .is_some_and(|terminal| terminal.instance == instance)
        {
            terminals.remove(&key);
        }
        Err("交互终端启动失败，请检查系统 shell 后重试".into())
    }

    pub(crate) fn snapshot(&self, key: &TerminalKey) -> Result<TerminalSnapshot, String> {
        let terminals = self.entries.lock().map_err(|_| "终端状态不可用")?;
        let Some(terminal) = terminals.get(key) else {
            return Ok(TerminalSnapshot::default());
        };
        let replay = terminal.replay.lock().map_err(|_| "终端状态不可用")?;
        Ok(TerminalSnapshot {
            instance: Some(terminal.instance.clone()),
            cursor: replay.cursor,
            data: replay.frames.iter().map(String::as_str).collect(),
            running: replay.running,
            exit_code: replay.exit_code,
        })
    }

    pub(crate) fn send(&self, key: &TerminalKey, message: Value) -> Result<(), String> {
        let terminals = self.entries.lock().map_err(|_| "终端状态不可用")?;
        let terminal = terminals.get(key).ok_or("请先启动终端")?;
        terminal
            .sender
            .try_send(message)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Closed(_) => "终端已退出".into(),
                mpsc::error::TrySendError::Full(_) => "终端输入过快，请稍后重试".into(),
            })
    }

    pub(crate) fn close(&self, key: &TerminalKey) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|_| "终端状态不可用")?
            .remove(key);
        Ok(())
    }
}
