//! App-owned subprocess groups. Closing the connection reaps descendants too.
use tokio::process::{Child, Command};

pub(super) fn prepare(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
}
pub(super) struct Group {
    #[cfg(windows)]
    job: Option<windows::Job>,
    #[cfg(unix)]
    id: Option<u32>,
}
impl Group {
    pub(super) fn attach(child: &Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            Ok(Self {
                job: Some(windows::Job::attach(child)?),
            })
        }
        #[cfg(unix)]
        {
            Ok(Self { id: child.id() })
        }
    }
    pub(super) async fn stop(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            job.stop().await?;
        }
        #[cfg(unix)]
        if let Some(id) = self.id.take() {
            kill(id);
        }
        Ok(())
    }
}
impl Drop for Group {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(id) = self.id.take() {
            kill(id);
        }
    }
}
#[cfg(unix)]
fn kill(id: u32) {
    if id > 0 && id <= i32::MAX as u32 {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        unsafe {
            kill(-(id as i32), 9);
        }
    }
}

#[cfg(windows)]
mod windows {
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
    unsafe impl Send for Job {}
    impl Job {
        pub(super) fn attach(child: &tokio::process::Child) -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(null(), null());
                if handle.is_null() {
                    return Err("无法创建 MCP 进程组".into());
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
                        child.raw_handle().ok_or("MCP 进程句柄不可用")?,
                    ) == 0
                {
                    return Err("无法隔离 MCP 子进程，已停止执行".into());
                }
                Ok(job)
            }
        }
        pub(super) async fn stop(self) -> Result<(), String> {
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                return Err("[cleanup_uncertain]MCP 进程组终止失败".into());
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
                    return Err("[cleanup_uncertain]MCP 进程组退出状态无法确认".into());
                }
                if info.active_processes == 0 {
                    return Ok(());
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err("[cleanup_uncertain]MCP 进程组仍未退出".into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
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
