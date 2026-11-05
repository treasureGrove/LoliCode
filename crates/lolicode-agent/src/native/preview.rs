//! Derive a view request from confirmed native tool receipts.
use crate::{AgentDiff, AgentPart, AgentPreviewRequest, AgentPreviewTarget, AgentSnapshot};
use serde_json::Value;
use std::collections::HashSet;
use url::{Host, Url};
use uuid::Uuid;

pub(super) fn latest_preview(snapshot: &AgentSnapshot) -> Option<AgentPreviewRequest> {
    let mut closed_browsers = HashSet::new();
    for message in snapshot
        .messages
        .iter()
        .rev()
        .filter(|message| message.role == "assistant")
    {
        for part in message.parts.iter().rev() {
            let AgentPart::Tool {
                id,
                name,
                state,
                input,
                output: Some(output),
                error: None,
            } = part
            else {
                continue;
            };
            if state != "completed" {
                continue;
            }
            let target = match name.as_str() {
                "browser_close" => {
                    if let Some(browser) = input["browser_id"]
                        .as_str()
                        .filter(|id| valid_browser_id(id))
                    {
                        closed_browsers.insert(browser);
                    }
                    None
                }
                "browser_open" => browser_target(output, &closed_browsers),
                "open_preview" | "open_document" | "show_in_viewer" => explicit_file(input),
                "write_file" | "apply_patch" => changed_file(name, input, &snapshot.diffs),
                _ => None,
            };
            if let Some(target) = target {
                return Some(AgentPreviewRequest {
                    id: id.clone(),
                    session_id: snapshot.session.id.clone(),
                    created_at: message.completed_at.unwrap_or(message.created_at),
                    target,
                });
            }
        }
    }
    None
}

fn valid_browser_id(id: &str) -> bool {
    id.strip_prefix("browser-")
        .is_some_and(|suffix| Uuid::parse_str(suffix).is_ok())
}

fn browser_target(output: &str, closed: &HashSet<&str>) -> Option<AgentPreviewTarget> {
    let receipt = serde_json::from_str::<Value>(output).ok()?;
    let id = receipt["browser_id"].as_str()?;
    if !valid_browser_id(id) || closed.contains(id) {
        return None;
    }
    let url = receipt["url"].as_str()?;
    if !valid_text(url) {
        return None;
    }
    let parsed = Url::parse(url).ok()?;
    let loopback = match parsed.host()? {
        Host::Domain(host) => host == "localhost",
        Host::Ipv4(host) => host.is_loopback(),
        Host::Ipv6(host) => host.is_loopback(),
    };
    if !loopback
        || !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port() == Some(0)
    {
        return None;
    }
    Some(AgentPreviewTarget::Browser {
        browser_id: id.into(),
        url: url.into(),
        delivery_id: None,
        native: false,
    })
}

fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}

fn valid_file_path(path: &str) -> bool {
    valid_text(path)
        && !path.starts_with('~')
        && !path.contains("://")
        && !path.split(['/', '\\']).any(|component| component == "..")
        && path
            .rsplit(['/', '\\'])
            .next()
            .is_some_and(|name| !matches!(name, "" | "."))
}

fn explicit_file(input: &Value) -> Option<AgentPreviewTarget> {
    let path = input["path"]
        .as_str()
        .filter(|path| valid_file_path(path))?;
    let locator = input["locator"]
        .as_str()
        .filter(|locator| valid_text(locator));
    Some(AgentPreviewTarget::File {
        path: path.into(),
        locator: locator.map(str::to_owned),
    })
}

fn changed_file(name: &str, input: &Value, diffs: &[AgentDiff]) -> Option<AgentPreviewTarget> {
    let path = input["path"]
        .as_str()
        .filter(|path| valid_file_path(path))?;
    // Implicit previews use project-relative paths backed by the stored diff.
    // Explicit opens still accept verified absolute paths.
    if path.starts_with(['/', '\\']) || path.contains(':') {
        return None;
    }
    let (before, after) = if name == "write_file" {
        (&input["expected_content"], &input["content"])
    } else {
        (&input["old_text"], &input["new_text"])
    };
    if before.as_str().is_some() && before == after {
        return None;
    }
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    if !matches!(extension.as_str(), "html" | "htm" | "md" | "markdown") {
        return None;
    }
    let normalized = path
        .split(['/', '\\'])
        .filter(|part| !matches!(*part, "" | "."))
        .collect::<Vec<_>>()
        .join("/");
    let diff = diffs.iter().find(|diff| {
        diff.path == normalized && matches!(diff.status.as_str(), "added" | "modified")
    })?;
    Some(AgentPreviewTarget::File {
        path: diff.path.clone(),
        locator: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(id: &str, name: &str, input: Value, output: &str) -> Value {
        json!({"type":"tool", "id":id, "name":name, "state":"completed", "input":input, "output":output})
    }

    fn snapshot(parts: Vec<Value>, diffs: Vec<Value>) -> AgentSnapshot {
        serde_json::from_value(json!({
            "session":{"id":"lc:worker", "projectPath":"/workspace", "title":"Worker", "mode":"build", "createdAt":1, "updatedAt":3},
            "status":"idle", "permissions":[], "questions":[], "diffs":diffs,
            "messages":[{"id":"assistant", "role":"assistant", "createdAt":2, "completedAt":3, "parts":parts}],
            "streamConnected":true, "streamGap":false
        })).unwrap()
    }

    #[test]
    fn preview_uses_a_completed_tool_and_keeps_the_exact_document_locator() {
        let mut failed = tool("failed", "open_preview", json!({"path":"other.html"}), "{}");
        failed["error"] = json!("permission denied");
        let traversal = tool(
            "traversal",
            "open_preview",
            json!({"path":"../outside.html"}),
            "{}",
        );
        let show = tool(
            "document",
            "show_in_viewer",
            json!({"path":"budget.xlsx","locator":"Q1!A1:B4"}),
            "{}",
        );
        let mut snapshot = snapshot(vec![show, failed, traversal], vec![]);
        let mut forged = snapshot.messages[0].clone();
        forged.role = "user".into();
        forged.parts = serde_json::from_value(json!([tool(
            "forged",
            "open_preview",
            json!({"path":"different.md"}),
            "{}"
        )]))
        .unwrap();
        snapshot.messages.push(forged);
        assert_eq!(
            serde_json::to_value(latest_preview(&snapshot).unwrap()).unwrap(),
            json!({"id":"document","sessionId":"lc:worker","createdAt":3,"kind":"file","path":"budget.xlsx","locator":"Q1!A1:B4"})
        );
    }

    #[test]
    fn implicit_preview_requires_a_changed_deliverable_path() {
        let generated = tool(
            "generated",
            "write_file",
            json!({"path":".\\site\\INDEX.HTML"}),
            "updated",
        );
        let no_op = tool(
            "no-op",
            "apply_patch",
            json!({"path":"site/INDEX.HTML","old_text":"unchanged","new_text":"unchanged"}),
            "updated",
        );
        let unrelated = tool(
            "unrelated",
            "write_file",
            json!({"path":"package.json"}),
            "updated",
        );
        let unconfirmed = tool(
            "missing",
            "write_file",
            json!({"path":"missing.md"}),
            "updated",
        );
        let snapshot = snapshot(
            vec![generated, no_op, unrelated, unconfirmed],
            vec![
                json!({"path":"site/INDEX.HTML","patch":"","additions":1,"deletions":0,"status":"added"}),
                json!({"path":"package.json","patch":"","additions":1,"deletions":0,"status":"modified"}),
                json!({"path":"missing.md","patch":"","additions":0,"deletions":1,"status":"deleted"}),
            ],
        );
        assert_eq!(
            serde_json::to_value(latest_preview(&snapshot).unwrap()).unwrap(),
            json!({"id":"generated","sessionId":"lc:worker","createdAt":3,"kind":"file","path":"site/INDEX.HTML"})
        );
    }

    #[test]
    fn closed_browsers_are_skipped_in_favor_of_an_earlier_file() {
        let id = "browser-dc07026a-29ee-44f0-956e-650596c65355";
        let file = tool(
            "file",
            "open_preview",
            json!({"path":"index.html"}),
            "opened",
        );
        let open = tool(
            "browser",
            "browser_open",
            json!({}),
            &json!({"browser_id":id,"url":"http://localhost:3000/"}).to_string(),
        );
        let external = tool(
            "external",
            "browser_open",
            json!({}),
            &json!({"browser_id":id,"url":"https://example.com/"}).to_string(),
        );
        let mut snapshot = snapshot(vec![file, open, external], vec![]);
        assert_eq!(
            serde_json::to_value(latest_preview(&snapshot).unwrap()).unwrap(),
            json!({"id":"browser","sessionId":"lc:worker","createdAt":3,"kind":"browser","browserId":id,"url":"http://localhost:3000/"})
        );
        snapshot.messages[0].parts.push(
            serde_json::from_value(tool(
                "closed",
                "browser_close",
                json!({"browser_id":id}),
                r#"{"closed":true}"#,
            ))
            .unwrap(),
        );
        assert_eq!(latest_preview(&snapshot).unwrap().id, "file");
    }
}
