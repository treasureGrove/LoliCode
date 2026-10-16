use super::{cancelled, ToolOutput, MAX_OUTPUT};
use std::{
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::watch,
    task::JoinHandle,
};

pub(super) fn safe_command(command: &str) -> bool {
    if command.is_empty()
        || command.len() > 4096
        || command.chars().any(|c| {
            !c.is_ascii()
                || matches!(
                    c,
                    '\n' | '\r'
                        | '\0'
                        | '\''
                        | '"'
                        | '`'
                        | '$'
                        | '>'
                        | '<'
                        | '|'
                        | '&'
                        | ';'
                        | '('
                        | ')'
                        | '{'
                        | '}'
                        | '!'
                        | '%'
                        | '^'
                        | '\\'
                )
        })
    {
        return false;
    }
    let parts: Vec<_> = command.split_whitespace().collect();
    match parts.as_slice() {
        [program, "--version"] => matches!(
            *program,
            "node" | "python" | "python3" | "git" | "rustc" | "cargo"
        ),
        ["git", "status", args @ ..] => args.iter().all(|a| {
            matches!(
                *a,
                "--short"
                    | "-s"
                    | "--branch"
                    | "-b"
                    | "--porcelain"
                    | "--porcelain=v1"
                    | "--porcelain=v2"
                    | "--untracked-files=all"
                    | "--untracked-files=no"
            )
        }),
        ["git", "diff", args @ ..] => {
            args.contains(&"--no-ext-diff")
                && args.contains(&"--no-textconv")
                && args.iter().all(|a| {
                    matches!(
                        *a,
                        "--stat"
                            | "--numstat"
                            | "--name-only"
                            | "--name-status"
                            | "--shortstat"
                            | "--no-color"
                            | "--no-ext-diff"
                            | "--no-textconv"
                            | "--cached"
                            | "--staged"
                            | "--check"
                    )
                })
        }
        _ => false,
    }
}

async fn capture(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    budget: Arc<AtomicUsize>,
) -> String {
    let mut collected = Vec::new();
    let mut buffer = [0u8; 4096];
    while let Ok(count) = reader.read(&mut buffer).await {
        if count == 0 {
            break;
        }
        let before = budget.fetch_add(count, Ordering::Relaxed);
        let take = MAX_OUTPUT.saturating_sub(before).min(count);
        collected.extend_from_slice(&buffer[..take]);
    }
    String::from_utf8_lossy(&collected).into_owned()
}

struct Running {
    child: Option<Child>,
    #[cfg(windows)]
    job: Option<job::Job>,
    #[cfg(unix)]
    group: Option<u32>,
}
impl Running {
    async fn stop(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        let isolation = match self.job.take() {
            Some(job) => job.stop().await,
            None => Ok(()),
        };
        #[cfg(unix)]
        if let Some(pid) = self.group.take() {
            kill_group(pid);
        }
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
            child
                .wait()
                .await
                .map_err(|_| super::cleanup_failure("命令退出状态无法确认"))?;
        }
        #[cfg(windows)]
        isolation?;
        Ok(())
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            self.job.take();
        }
        #[cfg(unix)]
        if let Some(pid) = self.group.take() {
            kill_group(pid);
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = child.wait().await;
                });
            }
        }
    }
}
#[cfg(unix)]
fn kill_group(pid: u32) {
    // A new group is created only for our child; zero/negative/broadcast targets
    // can never enter this narrowly owned cleanup path.
    if pid > 0 && pid <= i32::MAX as u32 {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        unsafe {
            kill(-(pid as i32), 9);
        }
    }
}

fn safe_program(project: &Path, name: &str) -> Result<std::path::PathBuf, String> {
    // A bare tool in a project directory or a PATH-relative entry is not an
    // automatically trusted system program (Windows also searches cwd first).
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if !directory.is_absolute() {
            continue;
        }
        let names = if cfg!(windows) {
            vec![format!("{name}.exe")]
        } else {
            vec![name.into()]
        };
        for entry in names {
            let candidate = directory.join(entry);
            if let Ok(path) = std::fs::canonicalize(&candidate) {
                if path.is_file() && !path.starts_with(project) {
                    return Ok(path);
                }
            }
        }
    }
    Err("未找到项目目录外的可信命令程序；请使用明确的已安装工具".into())
}

pub(super) async fn execute(
    project: &Path,
    workdir: &Path,
    input: &str,
    seconds: u64,
    mut cancel: watch::Receiver<bool>,
) -> Result<ToolOutput, String> {
    cancelled(&cancel)?;
    let safe = safe_command(input);
    let mut command = if safe {
        let mut words = input.split_whitespace();
        let program = words.next().ok_or("命令为空")?;
        let mut command = Command::new(safe_program(project, program)?);
        if program == "git" {
            command.args([
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.hooksPath=",
                "--no-optional-locks",
            ]);
        }
        command.args(words);
        command
    } else {
        #[cfg(windows)]
        {
            if shell_directory(workdir)
                .to_string_lossy()
                .starts_with(r"\\")
            {
                return Err("Windows命令解释器不支持UNC项目工作目录；请使用本地项目目录".into());
            }
            let shell = std::env::var_os("SYSTEMROOT")
                .map(std::path::PathBuf::from)
                .ok_or("无法定位Windows命令解释器")?
                .join("System32")
                .join("cmd.exe");
            let mut command = Command::new(shell);
            // cmd.exe does not use CommandLineToArgvW escaping. Its command
            // language must remain intact after the explicit /C boundary.
            command.raw_arg("/D /S /C").raw_arg(input);
            command
        }
        #[cfg(not(windows))]
        {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", input]);
            command
        }
    };
    command
        .current_dir(shell_directory(workdir))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if safe {
        for key in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "PYTHONSTARTUP",
            "RUSTC_WRAPPER",
            "RUSTC_WORKSPACE_WRAPPER",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG_COUNT",
        ] {
            command.env_remove(key);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let child = command.spawn().map_err(|_| "无法启动已授权的命令")?;
    #[cfg(unix)]
    let group = child.id();
    let mut running = Running {
        child: Some(child),
        #[cfg(unix)]
        group,
        #[cfg(windows)]
        job: None,
    };
    #[cfg(windows)]
    {
        match job::Job::attach(running.child.as_ref().unwrap()) {
            Ok(job) => running.job = Some(job),
            Err(error) => {
                running.stop().await?;
                return Err(super::cleanup_failure(&error));
            }
        }
    }
    let budget = Arc::new(AtomicUsize::new(0));
    let child = running.child.as_mut().unwrap();
    let stdout = child.stdout.take().ok_or("命令输出通道不可用")?;
    let stderr = child.stderr.take().ok_or("命令错误通道不可用")?;
    struct Readers(Vec<JoinHandle<String>>);
    impl Drop for Readers {
        fn drop(&mut self) {
            for task in &self.0 {
                task.abort();
            }
        }
    }
    let mut readers = Readers(vec![
        tokio::spawn(capture(stdout, budget.clone())),
        tokio::spawn(capture(stderr, budget.clone())),
    ]);
    enum End {
        Exited(std::io::Result<std::process::ExitStatus>),
        Cancelled,
        TimedOut,
    }
    let end = tokio::select! {
        status=running.child.as_mut().unwrap().wait()=>End::Exited(status),
        _=async{loop{if *cancel.borrow(){break;}if cancel.changed().await.is_err(){std::future::pending::<()>().await;}}}=>End::Cancelled,
        _=tokio::time::sleep(Duration::from_secs(seconds))=>End::TimedOut,
    };
    match end {
        End::Cancelled => {
            running.stop().await?;
            return Err(super::CANCELLED.into());
        }
        End::TimedOut => {
            running.stop().await?;
            return Err("命令超时，所属进程已回收".into());
        }
        End::Exited(status) => {
            let status = status.map_err(|_| super::cleanup_failure("无法读取命令退出状态"))?;
            // Job handles also reclaim explicitly backgrounded descendants.
            #[cfg(windows)]
            if let Some(job) = running.job.take() {
                job.stop().await?;
            }
            #[cfg(unix)]
            {
                if let Some(pid) = running.group.take() {
                    kill_group(pid);
                }
            }
            let mut output = String::new();
            for task in &mut readers.0 {
                match tokio::time::timeout(Duration::from_secs(2), task).await {
                    Ok(Ok(text)) => output.push_str(&text),
                    _ => return Err("命令退出后输出通道未关闭".into()),
                }
            }
            if budget.load(Ordering::Relaxed) > MAX_OUTPUT {
                output.push_str("\n[输出已截断]");
            }
            Ok(ToolOutput {
                text: super::bounded(format!(
                    "exit_code={}\n{}",
                    status
                        .code()
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "signal".into()),
                    output
                )),
                image_data_url: None,
                diffs: vec![],
                file_changes: vec![],
            })
        }
    }
}

pub(super) fn shell_directory(path: &Path) -> std::path::PathBuf {
    // canonicalize returns an extended Windows path; cmd treats that cwd as
    // UNC and silently changes directory. Filesystem checks still use the
    // canonical path, while this OS-only representation retains the same dir.
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return std::path::PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(drive) = value.strip_prefix(r"\\?\") {
            return std::path::PathBuf::from(drive);
        }
    }
    path.to_path_buf()
}

#[cfg(windows)]
mod job {
    use std::{ffi::c_void, mem::size_of, ptr::null};
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct Basic {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working: usize,
        max_working: usize,
        active: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Io {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Extended {
        basic: Basic,
        io: Io,
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Accounting {
        user_time: i64,
        kernel_time: i64,
        period_user_time: i64,
        period_kernel_time: i64,
        page_faults: u32,
        total_processes: u32,
        active_processes: u32,
        terminated_processes: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: u32, info: *const c_void, bytes: u32)
            -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            class: u32,
            info: *mut c_void,
            bytes: u32,
            returned: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    pub(super) struct Job(Handle);
    // The unique owned OS handle is moved with its command, never shared.
    unsafe impl Send for Job {}
    impl Job {
        pub(super) async fn stop(self) -> Result<(), String> {
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                return Err(super::super::cleanup_failure(
                    "命令进程组终止失败，无法确认回收完成",
                ));
            }
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let mut info = Accounting::default();
                if unsafe {
                    QueryInformationJobObject(
                        self.0,
                        1,
                        (&mut info as *mut Accounting).cast(),
                        size_of::<Accounting>() as u32,
                        std::ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(super::super::cleanup_failure(
                        "无法确认命令进程组的退出状态",
                    ));
                }
                if info.active_processes == 0 {
                    return Ok(());
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(super::super::cleanup_failure(
                        "命令进程组仍未退出，无法确认回收完成",
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
        pub(super) fn attach(child: &tokio::process::Child) -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(null(), null());
                if handle.is_null() {
                    return Err("无法创建命令进程组".into());
                }
                let job = Self(handle);
                let mut info = Extended::default();
                info.basic.flags = 0x2000;
                if SetInformationJobObject(
                    handle,
                    9,
                    (&info as *const Extended).cast(),
                    size_of::<Extended>() as u32,
                ) == 0
                    || AssignProcessToJobObject(
                        handle,
                        child.raw_handle().ok_or("命令进程句柄不可用")?,
                    ) == 0
                {
                    return Err("无法隔离命令子进程；已停止执行".into());
                }
                Ok(job)
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
