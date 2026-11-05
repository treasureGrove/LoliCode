//! Host-owned Git checkout for one secretary worker. The user's project
//! remains the session identity, while files and commands use this checkout.
use super::paths::{canonical_project, project_key, safe_program};
use crate::AgentSecretaryWorktree;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{fs, process::Command, time::timeout};
use uuid::Uuid;

const WORKTREES: &str = "secretary-worktrees";
const BRANCH_PREFIX: &str = "TG/secretary/";

async fn git(
    program: &Path,
    project: &Path,
    args: &[&str],
    seconds: u64,
) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .arg("-C")
        .arg(project)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "worktree.useRelativePaths=false",
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_LFS_SKIP_SMUDGE", "1");
    // An inherited Git override must not redirect these operations to a
    // different repository, index, checkout or configuration.
    for (key, _) in std::env::vars_os() {
        let key_text = key.to_string_lossy().to_ascii_uppercase();
        if key_text.starts_with("GIT_")
            && !matches!(
                key_text.as_str(),
                "GIT_TERMINAL_PROMPT" | "GIT_NO_LAZY_FETCH" | "GIT_LFS_SKIP_SMUDGE"
            )
        {
            command.env_remove(key);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = timeout(Duration::from_secs(seconds), command.output())
        .await
        .map_err(|_| "Git 工作树操作超时".to_owned())?
        .map_err(|_| "无法启动 Git".to_owned())?;
    if !output.status.success() {
        return Err("Git 工作树操作失败".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "无法读取 Git 的 UTF-8 输出".into())
}

pub async fn create(
    private_root: &Path,
    project: &Path,
    task_id: Uuid,
) -> Result<AgentSecretaryWorktree, String> {
    let source = fs::canonicalize(project)
        .await
        .map_err(|_| "无法访问任务所属项目目录")?;
    let program =
        safe_program(&source, "git").map_err(|_| "独立工作树需要安装 Git 并将其加入 PATH")?;
    let top = git(&program, project, &["rev-parse", "--show-toplevel"], 5)
        .await
        .map_err(|_| "独立工作树需要本地 Git 仓库，请打开仓库根目录")?;
    let top = canonical_project(Path::new(top.trim())).await?;
    if project_key(&top) != project_key(project) {
        return Err("请打开 Git 仓库根目录后分派独立工作树任务".into());
    }
    let base_revision = git(
        &program,
        project,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        5,
    )
    .await
    .map_err(|_| "项目还没有可用于工作树的已提交 HEAD")?;
    let base_revision = base_revision.trim();
    if !matches!(base_revision.len(), 40 | 64)
        || !base_revision.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Git 返回了无效的基线提交".into());
    }
    let directory = private_root.join(WORKTREES);
    fs::create_dir_all(&directory)
        .await
        .map_err(|_| "无法创建秘书工作树目录")?;
    if fs::canonicalize(&directory).await.ok().as_deref() != Some(directory.as_path())
        || directory.starts_with(&source)
    {
        return Err("秘书工作树目录必须位于项目之外的应用数据目录".into());
    }
    let id = task_id.simple().to_string();
    let branch = format!("{BRANCH_PREFIX}{id}");
    let path = canonical_project(&directory).await?.join(id);
    if fs::symlink_metadata(&path).await.is_ok() {
        return Err("秘书工作树目标目录已存在".into());
    }
    let path = path.to_str().ok_or("秘书工作树路径无法编码")?;
    git(
        &program,
        project,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            &branch,
            "--",
            path,
            base_revision,
        ],
        60,
    )
    .await
    .map_err(|error| format!("{error}，未启动任务。可检查目录 {path} 和分支 {branch}"))?;
    let worktree = AgentSecretaryWorktree {
        path: path.into(),
        branch,
        base_revision: base_revision.into(),
    };
    execution_root(private_root, &worktree).await?;
    Ok(worktree)
}

pub async fn execution_root(
    private_root: &Path,
    worktree: &AgentSecretaryWorktree,
) -> Result<PathBuf, String> {
    let id = worktree
        .branch
        .strip_prefix(BRANCH_PREFIX)
        .filter(|id| id.len() == 32 && Uuid::parse_str(id).is_ok())
        .ok_or("任务的工作树记录无效")?;
    let expected = private_root.join(WORKTREES).join(id);
    let root = fs::canonicalize(&worktree.path)
        .await
        .map_err(|_| "任务工作树已移除或无法访问，请恢复工作树后继续")?;
    if root != expected
        || !fs::symlink_metadata(root.join(".git"))
            .await
            .is_ok_and(|entry| entry.file_type().is_file())
    {
        return Err("任务工作树目录或 Git 关联发生变化，未执行".into());
    }
    // Use the ordinary Windows path so model-visible paths and command cwd
    // have the same spelling as the task's stored path.
    Ok(PathBuf::from(&worktree.path))
}
