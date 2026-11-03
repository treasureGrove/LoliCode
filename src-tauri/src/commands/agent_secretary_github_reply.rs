//! Explicit, recoverable GitHub delivery. This IPC is never a model tool.
use super::agent_secretary_github::{secretary_project, task_registry};
use crate::{
    services::secretary_github::{self as github, GithubItem, Source, SOURCE_GATE},
    store::AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{future::Future, time::Duration};
use tauri::{AppHandle, Manager};

const BODY_LIMIT: usize = 16_000;
const PAGE_LIMIT: u32 = 5;
const PAGE_SIZE: usize = 50;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReplyStatus {
    Pending,
    Sent,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GithubReply {
    status: ReplyStatus,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Destination {
    repository: String,
    repository_id: u64,
    account_id: u64,
    number: u64,
    thread_url: String,
    review_id: Option<u64>,
}

impl Destination {
    fn from_source(source: &Source, item: &GithubItem) -> Result<Self, String> {
        let repository = github::repository(
            source
                .state
                .repository
                .as_deref()
                .ok_or("请先连接 GitHub")?,
        )?;
        let number = item.number;
        if number == 0 {
            return Err("GitHub 条目编号无效".into());
        }
        let issue = format!("https://github.com/{repository}/issues/{number}");
        let pull = format!("https://github.com/{repository}/pull/{number}");
        let (thread, fragment) = item.url.split_once('#').unwrap_or((&item.url, ""));
        if thread != issue && thread != pull {
            return Err("该条目没有可回复的 Issue 或 PR 线程".into());
        }
        let review_id = if let Some(id) = item.id.strip_prefix("review-comment:") {
            let id: u64 = id.parse().map_err(|_| "Review 评论编号无效")?;
            if id == 0 || thread != pull || fragment != format!("discussion_r{id}") {
                return Err("Review 回复地址与来源不一致".into());
            }
            Some(id)
        } else {
            None
        };
        Ok(Self {
            repository,
            repository_id: source.repository_id.ok_or("仓库身份记录不完整")?,
            account_id: source.account_id.ok_or("GitHub 账户身份记录不完整")?,
            number,
            thread_url: thread.into(),
            review_id,
        })
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct Delivery {
    destination: Destination,
    reply: GithubReply,
}

async fn target(
    app: &AppHandle,
    session_id: &str,
    item_id: &str,
) -> Result<(Destination, String, bool), String> {
    secretary_project(app, session_id).await?;
    let source = Source::load(&app.state::<AppState>().db, session_id)?;
    let item = source
        .state
        .items
        .iter()
        .find(|item| item.id == item_id)
        .ok_or("此条目不在当前 GitHub 收件箱中")?;
    let destination = Destination::from_source(&source, item)?;
    let request = github::import_request_id(destination.repository_id, item_id);
    let registry = task_registry(app, session_id).await?;
    let task = registry
        .tasks
        .iter()
        .find(|task| task.request_id == request)
        .ok_or("请先交办该 GitHub 条目")?;
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{session_id}:{}", task.id).as_bytes())
    );
    Ok((destination, key, task.status == "completed"))
}

fn load(db: &crate::database::Database, key: &str) -> Result<Option<Delivery>, String> {
    db.get_setting(&format!("lolicode_secretary_reply:{key}"))
        .map_err(|_| "无法读取 GitHub 回报记录".to_owned())?
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| "GitHub 回报记录损坏，原记录已保留".into())
        })
        .transpose()
}

fn save(db: &crate::database::Database, key: &str, value: &Delivery) -> Result<(), String> {
    let record = serde_json::to_string(value).map_err(|_| "无法编码 GitHub 回报记录")?;
    db.set_setting(&format!("lolicode_secretary_reply:{key}"), &record)
        .map_err(|_| "无法保存 GitHub 回报记录".into())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_agent_secretary_github_reply(
    app: AppHandle,
    session_id: String,
    item_id: String,
) -> Result<Option<GithubReply>, String> {
    let (destination, key, _) = target(&app, &session_id, &item_id).await?;
    let record = load(&app.state::<AppState>().db, &key)?;
    if record
        .as_ref()
        .is_some_and(|delivery| delivery.destination != destination)
    {
        return Err("请用原 GitHub 账户和仓库查看该回报".into());
    }
    Ok(record.map(|record| record.reply))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn send_agent_secretary_github_reply(
    app: AppHandle,
    session_id: String,
    item_id: String,
    body: String,
) -> Result<GithubReply, String> {
    let body = body.trim();
    if body.is_empty()
        || body.len() > BODY_LIMIT
        || body.contains('\0')
        || body.contains("<!-- lolicode-reply:")
    {
        return Err("请输入有效的回报正文，最多 16000 字节".into());
    }
    // Serializes source changes and sends so a double click, timeout, or an
    // account rebind cannot overwrite the pending payload or send it twice.
    let _gate = SOURCE_GATE.lock().await;
    let (destination, key, completed) = target(&app, &session_id, &item_id).await?;
    let app_state = app.state::<AppState>();
    let db = &app_state.db;
    let mut delivery = if let Some(saved) = load(db, &key)? {
        if saved.destination != destination || saved.reply.body != body {
            return Err("已有回报记录，请使用原账户、目标及正文核对或重试".into());
        }
        if matches!(saved.reply.status, ReplyStatus::Sent) {
            return Ok(saved.reply);
        }
        saved
    } else {
        Delivery {
            destination,
            reply: GithubReply {
                status: ReplyStatus::Pending,
                body: body.into(),
                url: None,
                error: None,
            },
        }
    };
    if !completed {
        return Err("任务完成后才能发送回报".into());
    }
    save(db, &key, &delivery)?;
    let marker = format!("<!-- lolicode-reply:{key} -->");
    let result = tokio::time::timeout(Duration::from_secs(23), async {
        let client = github::reply_client().await?;
        deliver(&delivery, &marker, |path, value| {
            let client = &client;
            async move { client.request(&path, value.as_ref()).await }
        })
        .await
    })
    .await
    .unwrap_or_else(|_| Err("GitHub 回报结果尚未确认，请重试核对".into()));
    match result {
        Ok(url) => {
            delivery.reply.status = ReplyStatus::Sent;
            delivery.reply.url = Some(url);
            delivery.reply.error = None;
        }
        Err(error) => delivery.reply.error = Some(error),
    }
    save(db, &key, &delivery)?;
    Ok(delivery.reply)
}

fn confirmed_url(
    destination: &Destination,
    response: &Value,
    marker: &str,
    review_thread: Option<u64>,
) -> Option<String> {
    if response["user"]["id"].as_u64()? != destination.account_id
        || !response["body"].as_str()?.trim_end().ends_with(marker)
        || review_thread.is_some_and(|id| response["in_reply_to_id"].as_u64() != Some(id))
    {
        return None;
    }
    let id = response["id"].as_u64().filter(|id| *id > 0)?;
    let fragment = if review_thread.is_some() {
        "discussion_r"
    } else {
        "issuecomment-"
    };
    let expected = format!("{}#{fragment}{id}", destination.thread_url);
    (response["html_url"].as_str()? == expected).then_some(expected)
}

async fn deliver<F, Fut>(delivery: &Delivery, marker: &str, request: F) -> Result<String, String>
where
    F: Fn(String, Option<Value>) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let target = &delivery.destination;
    let repo = format!("repos/{}", target.repository);
    let (user, repository) =
        tokio::try_join!(request("user".into(), None), request(repo.clone(), None))?;
    if user["id"].as_u64() != Some(target.account_id)
        || repository["id"].as_u64() != Some(target.repository_id)
        || !repository["full_name"]
            .as_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(&target.repository))
    {
        return Err("GitHub 当前账户或仓库身份已变化，请恢复原连接后重试".into());
    }
    let review_thread = if let Some(id) = target.review_id {
        let review = request(format!("{repo}/pulls/comments/{id}"), None).await?;
        let parent = format!("https://api.github.com/{repo}/pulls/{}", target.number);
        if review["id"].as_u64() != Some(id)
            || review["pull_request_url"].as_str() != Some(parent.as_str())
        {
            return Err("行内评论与原 PR 不一致".into());
        }
        Some(
            review["in_reply_to_id"]
                .as_u64()
                .filter(|id| *id > 0)
                .unwrap_or(id),
        )
    } else {
        None
    };
    let list = match review_thread {
        Some(_) => format!("{repo}/pulls/{}/comments", target.number),
        None => format!("{repo}/issues/{}/comments", target.number),
    };
    // Always reconcile first, even if a previous request lost its result before
    // the local receipt was saved. Stop safely if reconciliation is incomplete.
    for page in 1..=PAGE_LIMIT {
        let data = request(format!("{list}?per_page={PAGE_SIZE}&page={page}"), None).await?;
        let rows = data.as_array().ok_or("GitHub 评论列表格式无效")?;
        if let Some(url) = rows
            .iter()
            .find_map(|row| confirmed_url(target, row, marker, review_thread))
        {
            return Ok(url);
        }
        if rows.len() < PAGE_SIZE {
            let post =
                review_thread.map_or_else(|| list.clone(), |id| format!("{list}/{id}/replies"));
            let response = request(
                post,
                Some(json!({"body":format!("{}\n\n{marker}",delivery.reply.body)})),
            )
            .await?;
            return confirmed_url(target, &response, marker, review_thread)
                .ok_or_else(|| "GitHub 回报结果尚未确认，请重试核对".into());
        }
    }
    Err("原线程评论较多，无法完成去重检查。请在 GitHub 打开线程核对并回复".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{future::ready, sync::Mutex};

    fn fixture(review_id: Option<u64>) -> Delivery {
        let route = if review_id.is_some() {
            "pull"
        } else {
            "issues"
        };
        Delivery {
            destination: Destination {
                repository: "example/repo".into(),
                repository_id: 31,
                account_id: 72,
                thread_url: format!("https://github.com/example/repo/{route}/9"),
                number: 9,
                review_id,
            },
            reply: GithubReply {
                status: ReplyStatus::Pending,
                body: "Reviewed result".into(),
                url: None,
                error: None,
            },
        }
    }

    #[tokio::test]
    async fn retry_after_lost_review_reply_response_reconciles_original_thread() {
        let delivery = fixture(Some(96));
        let marker = "<!-- lolicode-reply:fixture -->";
        let reply_url = "https://github.com/example/repo/pull/9#discussion_r99";
        let sent = Mutex::new(None::<Value>);
        let api = |path: String, body: Option<Value>| {
            ready(match path.as_str() {
                "user" => Ok(json!({"id":72})),
                "repos/example/repo" => Ok(json!({"id":31,"full_name":"example/repo"})),
                "repos/example/repo/pulls/comments/96" => Ok(
                    json!({"id":96,"in_reply_to_id":95,"pull_request_url":"https://api.github.com/repos/example/repo/pulls/9"}),
                ),
                "repos/example/repo/pulls/9/comments?per_page=50&page=1" => {
                    assert!(body.is_none());
                    let entries: Vec<_> = sent.lock().unwrap().iter().cloned().collect();
                    Ok(json!(entries))
                }
                "repos/example/repo/pulls/9/comments/95/replies" => {
                    let mut entry = sent.lock().unwrap();
                    assert!(entry.is_none(), "must not POST twice");
                    let body = body.unwrap();
                    assert_eq!(body["body"], format!("Reviewed result\n\n{marker}"));
                    *entry = Some(
                        json!({"id":99,"user":{"id":72},"body":body["body"],"in_reply_to_id":95,"html_url":reply_url}),
                    );
                    Err("simulated connection loss after the server stored the reply".into())
                }
                _ => panic!("unexpected endpoint: {path}"),
            })
        };
        assert!(deliver(&delivery, marker, api).await.is_err());
        assert_eq!(deliver(&delivery, marker, api).await.unwrap(), reply_url);
    }

    #[tokio::test]
    async fn a_changed_account_prevents_a_reply_before_posting() {
        let api = |path: String, body: Option<Value>| {
            ready(match path.as_str() {
                "user" => Ok(json!({"id":99})),
                "repos/example/repo" => Ok(json!({"id":31,"full_name":"example/repo"})),
                _ => panic!("unexpected endpoint: {path}, body: {body:?}"),
            })
        };
        assert!(deliver(&fixture(None), "marker", api)
            .await
            .unwrap_err()
            .contains("身份已变化"));
    }
}
