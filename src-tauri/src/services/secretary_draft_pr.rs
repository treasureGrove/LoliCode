//! GitHub publication uses an immutable Git tree reviewed in the desktop.
//! Only private Git objects/refs and an absent remote task branch are created.
use super::secretary_github as github;
use lolicode_agent::AgentSecretaryWorktree;
use serde::Serialize;
use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{fs, io::AsyncReadExt, process::Command, time::timeout};

const MAX_OUTPUT: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct ChangedFile {
    pub status: String,
    pub path: String,
}

pub(crate) struct Snapshot {
    pub head: String,
    pub tree: String,
    pub changes: Vec<ChangedFile>,
    pub patch: String,
    pub patch_truncated: bool,
}

pub(crate) struct TaskGit {
    executable: PathBuf,
    checkout: PathBuf,
    objects: PathBuf,
    task_key: String,
    branch: String,
    original_base: String,
}

fn git_program(project: &Path, checkout: &Path) -> Result<PathBuf, String> {
    let file = if cfg!(windows) { "git.exe" } else { "git" };
    env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .filter(|path| path.is_absolute())
        .map(|path| path.join(file))
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .find(|path| path.is_file() && !path.starts_with(project) && !path.starts_with(checkout))
        .ok_or_else(|| "请安装 Git 并将其加入 PATH".into())
}

fn command(executable: &Path, cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(executable);
    command
        .current_dir(cwd)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (key, _) in env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

async fn run(mut command: Command, seconds: u64, operation: &str) -> Result<String, String> {
    let mut child = command
        .spawn()
        .map_err(|_| format!("无法启动 Git：{operation}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("Git 输出不可用")?
        .take((MAX_OUTPUT + 1) as u64);
    timeout(Duration::from_secs(seconds), async {
        let mut bytes = Vec::new();
        stdout
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "无法读取 Git 输出")?;
        if bytes.len() > MAX_OUTPUT {
            return Err(format!("Git 输出过大：{operation}"));
        }
        if !child.wait().await.map_err(|_| "无法等待 Git")?.success() {
            return Err(format!("Git 操作未完成：{operation}"));
        }
        String::from_utf8(bytes).map_err(|_| format!("Git 输出不是 UTF-8：{operation}"))
    })
    .await
    .map_err(|_| format!("Git 操作超时：{operation}"))?
}

pub(crate) fn revision(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err("Git 提交或快照编号无效".into())
    }
}

fn origin_repository(url: &str) -> Result<String, String> {
    let url = url.trim();
    if let Some(repo) = url.strip_prefix("git@github.com:") {
        return github::repository(repo);
    }
    if let Some(repo) = url.strip_prefix("ssh://git@github.com/") {
        return github::repository(repo);
    }
    if url.starts_with("https://github.com/") {
        return github::repository(url);
    }
    Err("当前项目的 origin 必须指向已绑定的 GitHub 仓库".into())
}

impl TaskGit {
    pub(crate) async fn open(
        private_root: &Path,
        project: &Path,
        task_id: &str,
        worktree: &AgentSecretaryWorktree,
        repository: &str,
    ) -> Result<Self, String> {
        let id = task_id
            .strip_prefix("task-")
            .and_then(|value| uuid::Uuid::parse_str(value).ok())
            .ok_or("任务编号无效")?
            .simple()
            .to_string();
        let branch = format!("TG/secretary/{id}");
        if worktree.branch != branch {
            return Err("任务分支与秘书记录不一致".into());
        }
        let root = fs::canonicalize(private_root)
            .await
            .map_err(|_| "无法读取秘书数据目录")?;
        let checkout = fs::canonicalize(&worktree.path)
            .await
            .map_err(|_| "工作树不存在")?;
        let project = fs::canonicalize(project)
            .await
            .map_err(|_| "项目目录不存在")?;
        if checkout != root.join("secretary-worktrees").join(&id)
            || !fs::symlink_metadata(checkout.join(".git"))
                .await
                .is_ok_and(|meta| meta.is_file())
        {
            return Err("无法验证秘书工作树".into());
        }
        let executable = git_program(&project, &checkout)?;
        let common = |cwd| {
            command(
                &executable,
                cwd,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )
        };
        let project_git = run(common(&project), 8, "读取项目 Git 目录").await?;
        let task_git = run(common(&checkout), 8, "读取工作树 Git 目录").await?;
        let project_git = fs::canonicalize(project_git.trim())
            .await
            .map_err(|_| "项目 Git 目录不可用")?;
        let task_git = fs::canonicalize(task_git.trim())
            .await
            .map_err(|_| "工作树 Git 目录不可用")?;
        if project_git != task_git {
            return Err("工作树和项目不属于同一 Git 仓库".into());
        }
        let task_gitdir = run(
            command(&executable, &checkout, &["rev-parse", "--absolute-git-dir"]),
            8,
            "读取工作树索引归属",
        )
        .await?;
        let task_gitdir = fs::canonicalize(task_gitdir.trim())
            .await
            .map_err(|_| "工作树 Git 索引不可用")?;
        if task_gitdir.parent() != Some(project_git.join("worktrees").as_path()) {
            return Err("当前目录没有独立的 Git 工作树索引".into());
        }
        let this = Self {
            executable,
            checkout,
            objects: project_git.join("objects"),
            task_key: id,
            branch,
            original_base: revision(&worktree.base_revision)?.into(),
        };
        this.check_branch().await?;
        for args in [
            &["remote", "get-url", "--all", "origin"][..],
            &["remote", "get-url", "--push", "--all", "origin"][..],
        ] {
            let url = this.local(args, "检查 origin").await?;
            if !origin_repository(&url)?.eq_ignore_ascii_case(repository) {
                return Err("当前项目的 origin 与已绑定的 GitHub 仓库不一致".into());
            }
        }
        Ok(this)
    }

    async fn local(&self, args: &[&str], operation: &str) -> Result<String, String> {
        run(
            command(&self.executable, &self.checkout, args),
            12,
            operation,
        )
        .await
    }

    pub(crate) async fn check_branch(&self) -> Result<(), String> {
        let branch = self
            .local(&["symbolic-ref", "--quiet", "HEAD"], "核对任务分支")
            .await?;
        if branch.trim() == format!("refs/heads/{}", self.branch) {
            Ok(())
        } else {
            Err("工作树已切换分支，请先恢复任务分支".into())
        }
    }

    pub(crate) async fn check_reviewed_base(
        &self,
        reviewed: &str,
        current: &str,
        commit: &str,
    ) -> Result<(), String> {
        let reviewed = revision(reviewed)?;
        let current = revision(current)?;
        let commit = revision(commit)?;
        if reviewed == current {
            return Ok(());
        }
        let recover = || {
            "GitHub 基线已变化。请先获取默认分支再重试；若比较范围已改变，请在 GitHub 审阅任务分支。".to_owned()
        };
        self.local(
            &["merge-base", "--is-ancestor", reviewed, current],
            "核对 GitHub 基线",
        )
        .await
        .map_err(|_| recover())?;
        let before = self
            .local(&["merge-base", reviewed, commit], "读取审阅时的比较基线")
            .await?;
        let after = self
            .local(&["merge-base", current, commit], "读取当前比较基线")
            .await?;
        if revision(&before)? != revision(&after)? {
            return Err(recover());
        }
        Ok(())
    }

    pub(crate) async fn snapshot(&self, remote_base: &str) -> Result<Snapshot, String> {
        let remote_base = revision(remote_base)?;
        self.local(
            &[
                "merge-base",
                "--is-ancestor",
                &self.original_base,
                remote_base,
            ],
            "核对 GitHub 基线，请先同步默认分支",
        )
        .await?;
        let head = self
            .local(&["rev-parse", "--verify", "HEAD^{commit}"], "读取任务提交")
            .await?;
        let head = revision(&head)?.to_owned();
        self.local(
            &["merge-base", "--is-ancestor", &self.original_base, &head],
            "核对任务分支历史",
        )
        .await?;
        let merge_base = self
            .local(&["merge-base", remote_base, &head], "读取 PR 比较基线")
            .await?;
        let merge_base = revision(&merge_base)?;
        let temp = tempfile::tempdir().map_err(|_| "无法创建临时 Git 索引")?;
        let index = temp.path().join("index");
        for args in [&["read-tree", &head][..], &["add", "--all", "--", "."][..]] {
            let mut git = command(&self.executable, &self.checkout, args);
            git.env("GIT_INDEX_FILE", &index);
            run(git, 25, "准备任务文件快照").await?;
        }
        let mut git = command(&self.executable, &self.checkout, &["write-tree"]);
        git.env("GIT_INDEX_FILE", index);
        let tree = run(git, 12, "读取任务文件快照").await?;
        let tree = revision(&tree)?.to_owned();
        // Check the worker or another Git client did not move HEAD during review.
        self.check_branch().await?;
        if self
            .local(&["rev-parse", "HEAD"], "再次核对任务提交")
            .await?
            .trim()
            != head
        {
            return Err("工作树提交已变化，请重新预览".into());
        }
        let changes = self
            .local(
                &[
                    "diff",
                    "--name-status",
                    "-z",
                    "--no-renames",
                    "--no-ext-diff",
                    merge_base,
                    &tree,
                    "--",
                ],
                "读取变更文件",
            )
            .await?;
        let mut parts = changes.split_terminator('\0');
        let mut changes = Vec::new();
        while let Some(status) = parts.next() {
            let path = parts.next().ok_or("Git 变更文件格式无效")?;
            changes.push(ChangedFile {
                status: status.into(),
                path: path.into(),
            });
        }
        if changes.is_empty() || changes.len() > 250 {
            return Err("草稿 PR 需要 1 至 250 个可审阅的变更文件".into());
        }
        let patch = self
            .local(
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--no-renames",
                    "--submodule=short",
                    merge_base,
                    &tree,
                    "--",
                ],
                "生成变更预览",
            )
            .await;
        let (patch, patch_truncated) = match patch {
            Ok(mut patch) if patch.len() > 80_000 => {
                let end = (0..=80_000)
                    .rev()
                    .find(|index| patch.is_char_boundary(*index))
                    .unwrap_or_default();
                patch.truncate(end);
                (patch, true)
            }
            Ok(patch) => (patch, false),
            Err(_) => (String::new(), true),
        };
        Ok(Snapshot {
            head,
            tree,
            changes,
            patch,
            patch_truncated,
        })
    }

    pub(crate) async fn commit(
        &self,
        head: &str,
        tree: &str,
        login: &str,
        account_id: u64,
    ) -> Result<String, String> {
        let head_tree = self
            .local(&["rev-parse", &format!("{head}^{{tree}}")], "核对原提交")
            .await?;
        if head_tree.trim() == tree {
            return Ok(head.into());
        }
        let anchor = format!(
            "refs/lolicode/secretary-drafts/{}/{head}-{tree}",
            self.task_key
        );
        if let Ok(existing) = self
            .local(&["rev-parse", "--verify", &anchor], "读取已保存的 PR 快照")
            .await
        {
            let existing = revision(&existing)?;
            let object_tree = self
                .local(
                    &["rev-parse", &format!("{existing}^{{tree}}")],
                    "验证已保存的 PR 快照",
                )
                .await?;
            let parent = self
                .local(
                    &["rev-parse", &format!("{existing}^")],
                    "验证已保存的 PR 父提交",
                )
                .await?;
            if object_tree.trim() == tree && parent.trim() == head {
                return Ok(existing.into());
            }
            return Err("已保存的 PR 快照与审阅内容不一致".into());
        }
        let email = format!("{account_id}+{login}@users.noreply.github.com");
        let mut git = command(
            &self.executable,
            &self.checkout,
            &[
                "-c",
                "commit.gpgSign=false",
                "commit-tree",
                tree,
                "-p",
                head,
                "-m",
                "Loli Secretary task snapshot",
            ],
        );
        git.env("GIT_AUTHOR_NAME", login)
            .env("GIT_COMMITTER_NAME", login)
            .env("GIT_AUTHOR_EMAIL", &email)
            .env("GIT_COMMITTER_EMAIL", &email);
        let sha = run(git, 12, "保存审阅的 PR 提交").await?;
        let sha = revision(&sha)?.to_owned();
        self.local(&["update-ref", &anchor, &sha, ""], "保留 PR 快照供重试")
            .await?;
        Ok(sha)
    }

    pub(crate) async fn push(
        &self,
        repository: &str,
        sha: &str,
        header: &str,
    ) -> Result<(), String> {
        let repository = github::repository(repository)?;
        self.push_to(&format!("https://github.com/{repository}.git"), sha, header)
            .await
    }

    async fn push_to(&self, url: &str, sha: &str, header: &str) -> Result<(), String> {
        let sha = revision(sha)?;
        let temp = tempfile::tempdir().map_err(|_| "无法创建临时 Git 传输目录")?;
        let empty_config = temp.path().join("empty-config");
        fs::write(&empty_config, b"")
            .await
            .map_err(|_| "无法准备 Git 传输配置")?;
        let isolated = |args: &[&str]| {
            let mut cmd = command(&self.executable, temp.path(), args);
            cmd.env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", &empty_config);
            cmd
        };
        run(
            isolated(&["init", "--bare", "--template=", "."]),
            8,
            "准备独立 Git 传输",
        )
        .await?;
        let reference = format!("refs/heads/{}", self.branch);
        let authenticated = |args: &[&str]| {
            let mut cmd = isolated(args);
            cmd.env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &self.objects)
                .env("GIT_CONFIG_COUNT", "3")
                .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraHeader")
                .env("GIT_CONFIG_VALUE_0", header)
                .env("GIT_CONFIG_KEY_1", "http.followRedirects")
                .env("GIT_CONFIG_VALUE_1", "false")
                .env("GIT_CONFIG_KEY_2", "http.sslVerify")
                .env("GIT_CONFIG_VALUE_2", "true");
            cmd
        };
        let lookup = || authenticated(&["ls-remote", "--heads", "--", url, &reference]);
        let matches = |output: &str| output.trim() == format!("{sha}\t{reference}");
        let before = run(lookup(), 14, "核对远端任务分支").await?;
        if matches(&before) {
            return Ok(());
        }
        if !before.trim().is_empty() {
            return Err("远端任务分支已指向其他提交，未覆盖".into());
        }
        // An empty expected value is a create-only lease. Even if the branch
        // appears after ls-remote, this command cannot replace it.
        let lease = format!("--force-with-lease={reference}:");
        let refspec = format!("{sha}:{reference}");
        run(
            authenticated(&[
                "push",
                "--porcelain",
                "--no-verify",
                &lease,
                "--",
                url,
                &refspec,
            ]),
            60,
            "发布已审阅的任务分支",
        )
        .await?;
        let after = run(lookup(), 14, "验证已发布的任务分支").await?;
        if matches(&after) {
            Ok(())
        } else {
            Err("远端任务分支尚未核对，请重试".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn review_and_commit_preserve_main_and_both_worktree_indices() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let app_data = dir.path().join("app");
        let uuid = uuid::Uuid::new_v4();
        let id = uuid.simple().to_string();
        let branch = format!("TG/secretary/{id}");
        let checkout = app_data.join("secretary-worktrees").join(&id);
        fs::create_dir_all(&project).await.unwrap();
        fs::create_dir_all(checkout.parent().unwrap())
            .await
            .unwrap();
        let executable = git_program(&project, &checkout).unwrap();
        let git = |args: &[&str]| {
            let mut process = command(&executable, &project, args);
            process
                .env("GIT_AUTHOR_NAME", "Fixture")
                .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
                .env("GIT_COMMITTER_NAME", "Fixture")
                .env("GIT_COMMITTER_EMAIL", "fixture@example.test");
            process
        };
        run(git(&["init", "-b", "main"]), 12, "fixture")
            .await
            .unwrap();
        run(
            git(&["remote", "add", "origin", "git@github.com:example/repo.git"]),
            12,
            "fixture",
        )
        .await
        .unwrap();
        fs::write(project.join("tracked.txt"), "before")
            .await
            .unwrap();
        run(git(&["add", "."]), 12, "fixture").await.unwrap();
        run(
            git(&["-c", "commit.gpgSign=false", "commit", "-m", "baseline"]),
            12,
            "fixture",
        )
        .await
        .unwrap();
        let base = run(git(&["rev-parse", "HEAD"]), 12, "fixture")
            .await
            .unwrap()
            .trim()
            .to_owned();
        run(
            git(&["worktree", "add", "-b", &branch, checkout.to_str().unwrap()]),
            12,
            "fixture",
        )
        .await
        .unwrap();
        fs::write(project.join("tracked.txt"), "user changes")
            .await
            .unwrap();
        fs::write(checkout.join("tracked.txt"), "worker changes")
            .await
            .unwrap();
        fs::write(checkout.join("new.txt"), "worker result")
            .await
            .unwrap();
        let worktree = AgentSecretaryWorktree {
            path: checkout.to_string_lossy().into_owned(),
            branch,
            base_revision: base.clone(),
        };
        let worker = TaskGit::open(
            &app_data,
            &project,
            &format!("task-{uuid}"),
            &worktree,
            "example/repo",
        )
        .await
        .unwrap();
        let before = worker
            .local(&["status", "--porcelain"], "fixture")
            .await
            .unwrap();
        let review = worker.snapshot(&base).await.unwrap();
        assert_eq!(review.head, base);
        assert_eq!(review.changes.len(), 2);
        assert!(review.patch.contains("worker result"));
        assert!(!review.patch.contains("user changes"));
        let commit = worker
            .commit(&review.head, &review.tree, "fixture", 42)
            .await
            .unwrap();
        assert_ne!(commit, base);
        assert_eq!(
            worker
                .commit(&review.head, &review.tree, "fixture", 42)
                .await
                .unwrap(),
            commit
        );
        assert_eq!(
            worker
                .local(&["status", "--porcelain"], "fixture")
                .await
                .unwrap(),
            before
        );
        assert_eq!(
            worker
                .local(&["rev-parse", "HEAD"], "fixture")
                .await
                .unwrap()
                .trim(),
            base
        );
        assert_eq!(
            fs::read_to_string(project.join("tracked.txt"))
                .await
                .unwrap(),
            "user changes"
        );
        assert_eq!(
            run(git(&["branch", "--show-current"]), 12, "fixture")
                .await
                .unwrap()
                .trim(),
            "main"
        );
        // The transfer repo resolves the exact retained commit without
        // reading the source checkout's local push config.
        let transfer = dir.path().join("transfer");
        fs::create_dir(&transfer).await.unwrap();
        run(
            command(
                &executable,
                &transfer,
                &["init", "--bare", "--template=", "."],
            ),
            12,
            "fixture",
        )
        .await
        .unwrap();
        let mut lookup = command(&executable, &transfer, &["cat-file", "-t", &commit]);
        lookup.env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &worker.objects);
        assert_eq!(run(lookup, 12, "fixture").await.unwrap().trim(), "commit");
        let transfer_url = url::Url::from_file_path(&transfer).unwrap();
        worker
            .push_to(transfer_url.as_str(), &commit, "unused in file fixture")
            .await
            .unwrap();
        worker
            .push_to(transfer_url.as_str(), &commit, "unused in file fixture")
            .await
            .unwrap();
        assert!(worker
            .push_to(transfer_url.as_str(), &base, "unused in file fixture")
            .await
            .is_err());
        let published = run(
            command(
                &executable,
                &transfer,
                &["rev-parse", &format!("refs/heads/{}", worktree.branch)],
            ),
            12,
            "fixture",
        )
        .await
        .unwrap();
        assert_eq!(published.trim(), commit);
        assert!(TaskGit::open(
            &app_data,
            &project,
            &format!("task-{uuid}"),
            &worktree,
            "wrong/repo"
        )
        .await
        .is_err());
    }
}
