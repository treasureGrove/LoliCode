//! Read-only GitHub Source for the desktop secretary. CLI credentials stay in
//! gh, and source records provide context, never authority to run a worker.
use crate::database::Database;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, env, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Mutex,
};

const PAGE_SIZE: usize = 20;
const MAX_PAGES: usize = 5;
const MAX_ITEMS: usize = 120;
const MAX_RESPONSE: usize = 8 * 1024 * 1024;
const MAX_BODY: usize = 6000;
const SOURCE_PREFIX: &str = "lolicode_secretary_github:";

/// Network reads do not hold this guard. Serialize only local source commits
/// and task handoffs so refresh cannot drop a concurrent import receipt.
pub(crate) static SOURCE_GATE: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubItem {
    pub id: String,
    pub kind: GithubKind,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub actor: Option<String>,
    pub updated_at: u64,
    pub body: Option<String>,
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pull_request_numbers: Vec<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GithubKind {
    Issue,
    PullRequest,
    Comment,
    Ci,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubState {
    pub repository: Option<String>,
    pub login: Option<String>,
    pub last_synced_at: Option<u64>,
    pub error: Option<String>,
    pub items: Vec<GithubItem>,
    #[serde(default)]
    pub monitoring: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Cursor {
    issues: Option<u64>,
    pulls: Option<u64>,
    comments: Option<u64>,
    #[serde(default)]
    reviews: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(crate) struct Source {
    /// Changes at bind, disconnect and sync. A network response cannot restore
    /// an older binding or overwrite a newer refresh result.
    pub revision: u64,
    pub repository_id: Option<u64>,
    pub account_id: Option<u64>,
    pub cursor: Cursor,
    pub state: GithubState,
}

fn setting_key(session_id: &str) -> String {
    format!("{SOURCE_PREFIX}{:x}", Sha256::digest(session_id.as_bytes()))
}

pub(crate) fn monitoring_configured(db: &Database) -> Result<bool, String> {
    let conn = db.conn.lock().map_err(|_| "无法读取 GitHub 自动收件配置")?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key GLOB ?1 AND
            CASE WHEN json_valid(value) THEN json_extract(value, '$.state.monitoring') = 1 ELSE 0 END)",
        [format!("{SOURCE_PREFIX}*")],
        |row| row.get(0),
    )
    .map_err(|_| "无法读取 GitHub 自动收件配置".into())
}

impl Source {
    pub(crate) fn load(db: &Database, session_id: &str) -> Result<Self, String> {
        match db.get_setting(&setting_key(session_id)) {
            Ok(Some(value)) => serde_json::from_str(&value)
                .map_err(|_| "GitHub 来源记录无法读取，原数据已保留".into()),
            Ok(None) => Ok(Self::default()),
            Err(_) => Err("无法读取 GitHub 来源记录".into()),
        }
    }

    pub(crate) fn save(&self, db: &Database, session_id: &str) -> Result<(), String> {
        let value = serde_json::to_string(self).map_err(|_| "无法编码 GitHub 来源记录")?;
        db.set_setting(&setting_key(session_id), &value)
            .map_err(|_| "无法保存 GitHub 来源记录".into())
    }

    pub(crate) fn merge_items(&mut self, items: Vec<GithubItem>) {
        let mut merged: BTreeMap<_, _> = self
            .state
            .items
            .drain(..)
            .map(|item| (item.id.clone(), item))
            .collect();
        for mut item in items {
            if let Some(old) = merged.get(&item.id) {
                if item.updated_at < old.updated_at {
                    continue;
                }
                item.task_id = old.task_id.clone();
            }
            merged.insert(item.id.clone(), item);
        }
        let mut items: Vec<_> = merged.into_values().collect();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        items.truncate(MAX_ITEMS);
        self.state.items = items;
    }
}

pub(crate) fn repository(value: &str) -> Result<String, String> {
    let invalid = || "请输入 GitHub 仓库的 owner/repo 或 https://github.com/owner/repo 地址";
    let value = value.trim();
    let parsed;
    let path = if value.contains("://") {
        parsed = url::Url::parse(value).map_err(|_| invalid())?;
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("github.com")
            || parsed.port().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(invalid().into());
        }
        parsed.path().trim_start_matches('/')
    } else {
        value
    };
    let (owner, name) = path
        .trim_end_matches('/')
        .split_once('/')
        .ok_or_else(invalid)?;
    let name = name.strip_suffix(".git").unwrap_or(name);
    if owner.is_empty()
        || owner.len() > 39
        || !owner
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || name.is_empty()
        || name.len() > 100
        || matches!(name, "." | "..")
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    {
        return Err(invalid().into());
    }
    Ok(format!("{owner}/{name}"))
}

fn github_cli() -> Result<PathBuf, String> {
    let filename = if cfg!(windows) { "gh.exe" } else { "gh" };
    let mut locations: Vec<_> = env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .filter(|path| path.is_absolute())
        .collect();
    #[cfg(windows)]
    locations.extend(
        env::var_os("ProgramFiles")
            .into_iter()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .map(|path| path.join("GitHub CLI")),
    );
    #[cfg(not(windows))]
    locations.extend(["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map(PathBuf::from));
    locations
        .into_iter()
        .map(|path| path.join(filename))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "未找到 GitHub CLI，请安装 gh 并运行 gh auth login --hostname github.com".into()
        })
}

struct GitHub {
    executable: PathBuf,
    pinned_token: Option<String>,
    #[cfg(test)]
    fixture: Option<fn(&str) -> Result<Value, String>>,
}

fn cli_command(executable: &std::path::Path) -> Command {
    let mut command = Command::new(executable);
    command
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1")
        .env("GH_TELEMETRY", "0")
        .env_remove("GH_DEBUG")
        .env_remove("GH_FORCE_TTY")
        .env_remove("GH_PAGER")
        .env_remove("PAGER")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

async fn capture(
    mut command: Command,
    payload: Option<Vec<u8>>,
    max_bytes: usize,
    seconds: u64,
) -> Result<Vec<u8>, ()> {
    let mut child = command.spawn().map_err(|_| ())?;
    let mut stdout = child.stdout.take().ok_or(())?.take((max_bytes + 1) as u64);
    tokio::time::timeout(Duration::from_secs(seconds), async {
        if let Some(payload) = payload {
            let mut stdin = child.stdin.take().ok_or(())?;
            stdin.write_all(&payload).await.map_err(|_| ())?;
        }
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).await.map_err(|_| ())?;
        if output.len() > max_bytes || !child.wait().await.map_err(|_| ())?.success() {
            return Err(());
        }
        Ok(output)
    })
    .await
    .map_err(|_| ())?
}

impl GitHub {
    async fn get(&self, endpoint: &str, subject: &str) -> Result<Value, String> {
        #[cfg(test)]
        if let Some(fixture) = self.fixture {
            return fixture(endpoint);
        }
        self.request(endpoint, subject, None).await
    }

    async fn request(
        &self,
        endpoint: &str,
        subject: &str,
        payload: Option<&Value>,
    ) -> Result<Value, String> {
        let payload = payload
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| "GitHub 请求无法编码")?;
        if payload
            .as_ref()
            .is_some_and(|payload| payload.len() > 128 * 1024)
        {
            return Err("GitHub 回复超过大小限制".into());
        }
        let mut command = cli_command(&self.executable);
        command.arg("api");
        if payload.is_some() {
            command
                .args(["--input", "-", "--header", "Content-Type: application/json"])
                .stdin(Stdio::piped());
        }
        if let Some(token) = &self.pinned_token {
            command.env("GH_TOKEN", token).env_remove("GITHUB_TOKEN");
        }
        command.args([
            "--hostname",
            "github.com",
            "--method",
            if payload.is_some() { "POST" } else { "GET" },
            "--header",
            "Accept: application/vnd.github+json",
            "--header",
            "X-GitHub-Api-Version: 2022-11-28",
            endpoint,
        ]);
        let output = capture(command, payload, MAX_RESPONSE, 18)
            .await
            .map_err(|_| format!("GitHub {subject} 请求未完成，请检查 gh 登录、仓库权限和网络"))?;
        serde_json::from_slice(&output).map_err(|_| format!("GitHub {subject} 响应格式无效"))
    }
}

fn reply_endpoint(endpoint: &str, write: bool) -> bool {
    let (path, query) = endpoint.split_once('?').unwrap_or((endpoint, ""));
    if query.len() > 256
        || !query
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"&=._:-".contains(&byte))
        || write && !query.is_empty()
    {
        return false;
    }
    let parts: Vec<_> = path.split('/').collect();
    let coordinate = |owner: &str, repo: &str| repository(&format!("{owner}/{repo}")).is_ok();
    let positive = |number: &str| {
        number.bytes().all(|b| b.is_ascii_digit()) && number.parse::<u64>().is_ok_and(|n| n > 0)
    };
    match parts.as_slice() {
        ["user"] => !write && query.is_empty(),
        ["repos", owner, repo] => !write && query.is_empty() && coordinate(owner, repo),
        ["repos", owner, repo, "issues", number, "comments"] => {
            coordinate(owner, repo) && positive(number)
        }
        ["repos", owner, repo, "pulls", "comments", comment] => {
            !write && query.is_empty() && coordinate(owner, repo) && positive(comment)
        }
        ["repos", owner, repo, "pulls", number, "comments"] => {
            !write && coordinate(owner, repo) && positive(number)
        }
        ["repos", owner, repo, "pulls", number, "comments", comment, "replies"] => {
            write && coordinate(owner, repo) && positive(number) && positive(comment)
        }
        _ => false,
    }
}

/// A short-lived credential for one explicit reply operation. Verification
/// and POST share the same auth even if the active gh account changes while
/// the reply is being prepared. Never logged or serialized.
pub(crate) struct GithubReplyClient(GitHub);

pub(crate) async fn reply_client() -> Result<GithubReplyClient, String> {
    let executable = github_cli()?;
    let mut command = cli_command(&executable);
    command.args(["auth", "token", "--hostname", "github.com"]);
    let output = capture(command, None, 16 * 1024, 8)
        .await
        .map_err(|_| "无法验证 gh 登录，请先登录 github.com")?;
    let token = std::str::from_utf8(&output)
        .ok()
        .map(str::trim)
        .filter(|token| !token.is_empty() && token.bytes().all(|byte| byte.is_ascii_graphic()))
        .ok_or("gh 凭据格式无效")?;
    Ok(GithubReplyClient(GitHub {
        executable,
        pinned_token: Some(token.into()),
        #[cfg(test)]
        fixture: None,
    }))
}

impl GithubReplyClient {
    pub(crate) async fn request(
        &self,
        endpoint: &str,
        body: Option<&Value>,
    ) -> Result<Value, String> {
        if !reply_endpoint(endpoint, body.is_some())
            || body.is_some_and(|value| {
                !value.as_object().is_some_and(|map| {
                    map.len() == 1 && map.get("body").and_then(Value::as_str).is_some()
                })
            })
        {
            return Err("GitHub 回复目标或内容无效".into());
        }
        if let Some(body) = body {
            self.0.request(endpoint, "回复", Some(body)).await
        } else {
            self.0.get(endpoint, "回复核对").await
        }
    }
}

fn bounded(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.into();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn stamp(value: &Value) -> Option<u64> {
    let time = DateTime::parse_from_rfc3339(value.as_str()?).ok()?;
    time.timestamp_millis().try_into().ok()
}

fn item(value: &Value, kind: GithubKind, repo: &str) -> Option<GithubItem> {
    let id = value["id"].as_u64().filter(|id| *id > 0)?;
    let updated_at = stamp(&value["updated_at"])?;
    let base = format!("https://github.com/{repo}");
    let (prefix, number, title, url, state) = match kind {
        GithubKind::Issue | GithubKind::PullRequest => {
            let number = value["number"].as_u64().filter(|n| *n > 0)?;
            let (prefix, route) = if kind == GithubKind::Issue {
                ("issue", "issues")
            } else {
                ("pr", "pull")
            };
            let state = if !value["merged_at"].is_null() {
                "merged"
            } else {
                value["state"].as_str()?
            };
            (
                prefix,
                number,
                bounded(value["title"].as_str()?, 500),
                format!("{base}/{route}/{number}"),
                state,
            )
        }
        GithubKind::Comment => {
            let raw_url = value["html_url"].as_str()?;
            let route = ["issues", "pull"].into_iter().find_map(|route| {
                let tail = raw_url.strip_prefix(&format!("{base}/{route}/"))?;
                let (number, fragment) = tail.split_once('#')?;
                let prefix = if route == "pull" && fragment == format!("discussion_r{id}") {
                    "review-comment"
                } else if fragment == format!("issuecomment-{id}") {
                    "comment"
                } else {
                    return None;
                };
                Some((
                    route,
                    number.parse::<u64>().ok().filter(|n| *n > 0)?,
                    fragment,
                    prefix,
                ))
            })?;
            (
                route.3,
                route.1,
                if route.3 == "review-comment" {
                    let file = bounded(value["path"].as_str().unwrap_or_default(), 320);
                    format!("PR #{} · {file}", route.1)
                } else {
                    format!(
                        "{} #{}",
                        if route.0 == "pull" { "PR" } else { "Issue" },
                        route.1
                    )
                },
                format!("{base}/{}/{}#{}", route.0, route.1, route.2),
                "commented",
            )
        }
        GithubKind::Ci => (
            "ci",
            value["run_number"].as_u64()?,
            bounded(value["name"].as_str().unwrap_or("GitHub Actions"), 500),
            format!("{base}/actions/runs/{id}"),
            value["conclusion"]
                .as_str()
                .filter(|v| !v.is_empty())
                .or_else(|| value["status"].as_str())?,
        ),
    };
    let actor = if kind == GithubKind::Ci {
        &value["actor"]
    } else {
        &value["user"]
    };
    let head_sha = if kind == GithubKind::Ci {
        &value["head_sha"]
    } else {
        &value["head"]["sha"]
    };
    let pull_request_numbers = value["pull_requests"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|pull| {
            pull["base"]["repo"]["url"].as_str().is_some_and(|url| {
                url.eq_ignore_ascii_case(&format!("https://api.github.com/repos/{repo}"))
            })
        })
        .filter_map(|pull| pull["number"].as_u64().filter(|n| *n > 0))
        .take(10)
        .collect();
    let body = if kind == GithubKind::Ci {
        Some(bounded(
            &format!(
                "{} · {}",
                value["event"].as_str().unwrap_or_default(),
                value["head_branch"].as_str().unwrap_or_default()
            ),
            MAX_BODY,
        ))
    } else {
        value["body"].as_str().map(|text| bounded(text, MAX_BODY))
    };
    Some(GithubItem {
        id: format!("{prefix}:{id}"),
        kind,
        number,
        title,
        url,
        state: bounded(state, 80),
        actor: actor["login"].as_str().map(|value| bounded(value, 100)),
        updated_at,
        body,
        task_id: None,
        head_sha: head_sha
            .as_str()
            .filter(|sha| sha.len() == 40 && sha.bytes().all(|c| c.is_ascii_hexdigit()))
            .map(str::to_owned),
        pull_request_numbers,
    })
}

struct Page {
    items: Vec<GithubItem>,
    cursor: Option<u64>,
}

#[derive(Clone, Copy)]
enum ThreadFeed {
    Issue,
    Pull,
    Comment,
    ReviewComment,
}

async fn read_threads(
    api: &GitHub,
    repo: &str,
    feed: ThreadFeed,
    old_cursor: Option<u64>,
) -> Result<Page, String> {
    let (kind, path, subject, extra) = match feed {
        ThreadFeed::Issue => (GithubKind::Issue, "issues", "Issue", "&state=all"),
        ThreadFeed::Pull => (GithubKind::PullRequest, "pulls", "PR", "&state=all"),
        ThreadFeed::Comment => (GithubKind::Comment, "issues/comments", "对话评论", ""),
        ThreadFeed::ReviewComment => (GithubKind::Comment, "pulls/comments", "PR 行内评论", ""),
    };
    // Overlap the last second so identical timestamps and edits on a page
    // boundary are reconciled by immutable object IDs instead of being lost.
    let cutoff = old_cursor.map(|time| time.saturating_sub(1000));
    let since = cutoff
        .filter(|_| kind != GithubKind::PullRequest)
        .and_then(|time| DateTime::<Utc>::from_timestamp_millis(time.try_into().ok()?))
        .map(|time| format!("&since={}", time.to_rfc3339_opts(SecondsFormat::Secs, true)))
        .unwrap_or_default();
    let mut result = Page {
        items: Vec::new(),
        cursor: old_cursor,
    };
    for page in 1..=MAX_PAGES {
        let endpoint = format!("repos/{repo}/{path}?per_page={PAGE_SIZE}&page={page}&sort=updated&direction=desc{extra}{since}");
        let response = api.get(&endpoint, subject).await?;
        let rows = response
            .as_array()
            .ok_or_else(|| format!("GitHub {subject} 列表格式无效"))?;
        let mut reached_cursor = false;
        for row in rows {
            let updated = stamp(&row["updated_at"])
                .ok_or_else(|| format!("GitHub {subject} 更新时间无效"))?;
            if cutoff.is_some_and(|time| updated < time) {
                reached_cursor = true;
                continue;
            }
            result.cursor = Some(result.cursor.unwrap_or_default().max(updated));
            // The issues endpoint also returns PRs; the pulls endpoint has
            // their own state and head SHA, so keep a single PR record.
            if kind == GithubKind::Issue && row.get("pull_request").is_some() {
                continue;
            }
            result.items.push(
                item(row, kind, repo).ok_or_else(|| format!("GitHub {subject} 条目格式无效"))?,
            );
        }
        if old_cursor.is_none() || rows.len() < PAGE_SIZE || reached_cursor {
            return Ok(result);
        }
    }
    Err(format!(
        "GitHub {subject} 更新超出单次同步范围，已保留原游标"
    ))
}

async fn read_ci(api: &GitHub, repo: &str) -> Result<Vec<GithubItem>, String> {
    let response = api
        .get(
            &format!("repos/{repo}/actions/runs?per_page={PAGE_SIZE}"),
            "Actions",
        )
        .await?;
    let rows = response["workflow_runs"]
        .as_array()
        .ok_or("GitHub Actions 列表格式无效")?;
    rows.iter()
        .map(|row| {
            item(row, GithubKind::Ci, repo).ok_or_else(|| "GitHub Actions 条目格式无效".into())
        })
        .collect()
}

pub(crate) async fn synchronize(repo: &str, previous: &Source) -> Result<Source, String> {
    let api = GitHub {
        executable: github_cli()?,
        pinned_token: None,
        #[cfg(test)]
        fixture: None,
    };
    synchronize_with(&api, repo, previous).await
}

async fn synchronize_with(api: &GitHub, repo: &str, previous: &Source) -> Result<Source, String> {
    // Validate persisted configuration again before constructing an endpoint.
    let requested = repository(repo)?;
    let repo_endpoint = format!("repos/{requested}");
    let (account, repo) =
        tokio::try_join!(api.get("user", "账户"), api.get(&repo_endpoint, "仓库"))?;
    let account_id = account["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or("GitHub 账户身份无效")?;
    let login = account["login"]
        .as_str()
        .filter(|name| !name.is_empty() && name.len() <= 100)
        .ok_or("GitHub 账户名称无效")?;
    let repo_id = repo["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or("GitHub 仓库身份无效")?;
    let canonical = repository(repo["full_name"].as_str().ok_or("GitHub 仓库名称无效")?)?;
    if !canonical.eq_ignore_ascii_case(&requested) {
        return Err(format!("仓库地址已变更，请重新绑定 {canonical}"));
    }
    if previous.account_id.is_some_and(|id| id != account_id) {
        return Err("gh 当前账户已更换，请重新绑定 GitHub 来源".into());
    }
    if previous.repository_id.is_some_and(|id| id != repo_id) {
        return Err("GitHub 仓库身份已变更，请重新绑定来源".into());
    }
    if repo["permissions"]["pull"] == false {
        return Err("gh 当前账户没有此 GitHub 仓库的读取权限".into());
    }

    let (issues, pulls, comments, reviews, ci) = tokio::join!(
        read_threads(api, &canonical, ThreadFeed::Issue, previous.cursor.issues),
        read_threads(api, &canonical, ThreadFeed::Pull, previous.cursor.pulls),
        read_threads(
            api,
            &canonical,
            ThreadFeed::Comment,
            previous.cursor.comments
        ),
        read_threads(
            api,
            &canonical,
            ThreadFeed::ReviewComment,
            previous.cursor.reviews
        ),
        read_ci(api, &canonical),
    );
    let mut next = previous.clone();
    next.repository_id = Some(repo_id);
    next.account_id = Some(account_id);
    next.state.repository = Some(canonical);
    next.state.login = Some(login.into());
    next.state.last_synced_at = Some(Utc::now().timestamp_millis().try_into().unwrap_or_default());
    let mut items = Vec::new();
    let mut errors = Vec::new();
    for (result, cursor) in [
        (issues, &mut next.cursor.issues),
        (pulls, &mut next.cursor.pulls),
        (comments, &mut next.cursor.comments),
        (reviews, &mut next.cursor.reviews),
    ] {
        match result {
            Ok(page) => {
                *cursor = page.cursor;
                items.extend(page.items);
            }
            Err(error) => errors.push(error),
        }
    }
    match ci {
        Ok(ci) => items.extend(ci),
        Err(error) => errors.push(error),
    }
    if errors.len() == 5 {
        return Err(errors.join("；"));
    }
    next.state.error = (!errors.is_empty()).then(|| errors.join("；"));
    next.merge_items(items);
    Ok(next)
}

pub(crate) fn import_request_id(repo_id: u64, item_id: &str) -> String {
    let identity = format!("{repo_id}:{item_id}");
    format!("github:{:x}", Sha256::digest(identity.as_bytes()))
}

pub(crate) fn source_context(repo: &str, item: &GithubItem, inbox: &[GithubItem]) -> String {
    let related_ci: Vec<_> = inbox
        .iter()
        .filter(|run| {
            item.kind == GithubKind::PullRequest
                && run.kind == GithubKind::Ci
                && (run.pull_request_numbers.contains(&item.number)
                    || item.head_sha.is_some() && run.head_sha == item.head_sha)
        })
        .take(5)
        .map(|run| json!({"title": run.title, "url": run.url, "state": run.state, "headSha": run.head_sha}))
        .collect();
    json!({
        "source": "github",
        "repository": repo,
        "id": item.id,
        "kind": item.kind,
        "number": item.number,
        "url": item.url,
        "actor": item.actor,
        "updatedAt": item.updated_at,
        "state": item.state,
        "title": item.title,
        "body": item.body,
        "headSha": item.head_sha,
        "pullRequestNumbers": item.pull_request_numbers,
        "relatedCi": related_ci,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO: &str = "example/loli";
    const SHA: &str = "1234567890abcdef1234567890abcdef12345678";
    const STAMP: &str = "2026-11-03T09:10:11Z";

    fn fixture(endpoint: &str) -> Result<Value, String> {
        let response = match endpoint.split('?').next().unwrap_or_default() {
            "user" => json!({"id": 42, "login": "member"}),
            "repos/example/loli" => {
                json!({"id": 87, "full_name": REPO, "permissions": {"pull": true}})
            }
            "repos/example/loli/issues" => json!([
                {"id": 2, "number": 7, "state": "open", "title": "Fix queue", "updated_at": STAMP,
                 "body": "External body.", "user": {"login": "reporter"}},
                {"id": 3, "number": 8, "updated_at": STAMP, "pull_request": {"url": "provided separately"}}
            ]),
            "repos/example/loli/pulls" => json!([
                {"id": 4, "number": 8, "state": "open", "title": "Improve queue",
                 "head": {"sha": SHA}, "updated_at": STAMP, "user": {"login": "contributor"}}
            ]),
            "repos/example/loli/issues/comments" => json!([
                {"id": 5, "html_url": "https://github.com/example/loli/pull/8#issuecomment-5",
                 "updated_at": STAMP, "body": "Comment body.", "user": {"login": "reviewer"}}
            ]),
            "repos/example/loli/pulls/comments" => json!([
                {"id": 5, "html_url": "https://github.com/example/loli/pull/8#discussion_r5",
                 "updated_at": STAMP, "path": "src/queue.rs", "body": "Review body.",
                 "user": {"login": "reviewer"}}
            ]),
            "repos/example/loli/actions/runs" => json!({
                "workflow_runs": [{"id": 6, "run_number": 1, "name": "Test", "status": "completed",
                    "conclusion": "failure", "head_sha": SHA, "updated_at": STAMP,
                    "pull_requests": [{"number": 8, "base": {"repo": {"url": "https://api.github.com/repos/example/loli"}}}]}]
            }),
            other => panic!("unexpected GitHub endpoint {other}"),
        };
        Ok(response)
    }

    fn api(fixture: fn(&str) -> Result<Value, String>) -> GitHub {
        GitHub {
            executable: PathBuf::new(),
            pinned_token: None,
            fixture: Some(fixture),
        }
    }

    #[test]
    fn repository_coordinates_pin_host_and_two_safe_segments() {
        assert_eq!(repository("example/loli").unwrap(), REPO);
        assert_eq!(
            repository("https://github.com/example/loli.git/").unwrap(),
            REPO
        );
        for input in [
            "https://github.com.example.org/example/loli",
            "http://github.com/example/loli",
            "https://user@github.com/example/loli",
            "https://github.com/example/loli/issues/7",
            "https://github.com/example/loli?x=y",
            "https://github.com/example/loli#readme",
            "example/%2floli",
            "example/../loli",
        ] {
            assert!(repository(input).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn explicit_reply_transport_limits_posts_to_conversation_and_inline_replies() {
        assert!(reply_endpoint("repos/example/loli/issues/8/comments", true));
        assert!(reply_endpoint(
            "repos/example/loli/pulls/8/comments/5/replies",
            true
        ));
        assert!(reply_endpoint("repos/example/loli/pulls/comments/5", false));
        assert!(reply_endpoint(
            "repos/example/loli/pulls/8/comments?per_page=100&page=1",
            false
        ));
        for invalid in [
            "user",
            "https://api.github.com/repos/example/loli/issues/8/comments",
            "repos/example/loli/issues/8",
            "repos/example/loli/issues/8/comments?method=PATCH",
            "repos/example/loli/pulls/comments/5",
            "repos/example/loli/pulls/8/comments",
            "repos/example/loli/pulls/8/comments/0/replies",
            "repos/example/../issues/8/comments",
        ] {
            assert!(!reply_endpoint(invalid, true), "accepted {invalid}");
        }
    }

    #[tokio::test]
    async fn sync_persists_identities_and_reconciles_same_version_without_losing_task_receipt() {
        let api = api(fixture);
        let mut first = synchronize_with(&api, REPO, &Source::default())
            .await
            .unwrap();
        assert_eq!(first.account_id, Some(42));
        assert_eq!(first.repository_id, Some(87));
        assert_eq!(first.state.items.len(), 5);
        assert!(first
            .state
            .items
            .iter()
            .any(|item| item.id == "review-comment:5"));
        assert_eq!(first.cursor.issues, stamp(&json!(STAMP)));
        assert!(!first.state.monitoring);
        first.state.monitoring = true;
        first
            .state
            .items
            .iter_mut()
            .find(|item| item.id == "issue:2")
            .unwrap()
            .task_id = Some("task-7".into());
        let db = Database::memory().unwrap();
        assert!(!monitoring_configured(&db).unwrap());
        first.save(&db, "lc:secretary").unwrap();
        assert!(monitoring_configured(&db).unwrap());
        let restored = Source::load(&db, "lc:secretary").unwrap();
        let next = synchronize_with(&api, REPO, &restored).await.unwrap();
        assert!(next.state.monitoring);
        assert_eq!(next.state.items.len(), 5);
        let issue = next
            .state
            .items
            .iter()
            .find(|item| item.id == "issue:2")
            .unwrap();
        assert_eq!(issue.task_id.as_deref(), Some("task-7"));
        assert_eq!(issue.url, "https://github.com/example/loli/issues/7");
        assert!(Source::load(&db, "lc:other")
            .unwrap()
            .state
            .items
            .is_empty());
        let pull = next
            .state
            .items
            .iter()
            .find(|item| item.kind == GithubKind::PullRequest)
            .unwrap();
        let context: Value =
            serde_json::from_str(&source_context(REPO, pull, &next.state.items)).unwrap();
        assert_eq!(context["relatedCi"][0]["state"], "failure");
        assert_eq!(context["actor"], "contributor");
        assert_eq!(context["url"], "https://github.com/example/loli/pull/8");
        assert_ne!(
            import_request_id(87, &issue.id),
            import_request_id(88, &issue.id)
        );
    }

    #[tokio::test]
    async fn partial_failure_keeps_previous_cursor_and_account_switch_stops_before_source_reads() {
        let mut before = synchronize_with(&api(fixture), REPO, &Source::default())
            .await
            .unwrap();
        before.cursor.comments = Some(7);
        let partial = api(|endpoint| {
            if endpoint.starts_with("repos/example/loli/issues/comments?") {
                Err("comment permission denied".into())
            } else {
                fixture(endpoint)
            }
        });
        let after = synchronize_with(&partial, REPO, &before).await.unwrap();
        assert_eq!(
            after.state.error.as_deref(),
            Some("comment permission denied")
        );
        assert_eq!(after.cursor.comments, Some(7));
        assert_eq!(after.state.items.len(), 5);
        let switched = api(|endpoint| match endpoint {
            "user" => Ok(json!({"id": 999, "login": "other"})),
            "repos/example/loli" => fixture(endpoint),
            _ => panic!("account mismatch must stop before reading items"),
        });
        let error = synchronize_with(&switched, REPO, &before)
            .await
            .unwrap_err();
        assert!(error.contains("账户已更换"));
    }
}
