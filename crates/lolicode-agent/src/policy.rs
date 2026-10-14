//! Ordered v2 permissions, persisted in the upstream session, not a UI flag.
use serde_json::{json, Value};

const READ_ACTIONS: &[&str] = &[
    "read",
    "glob",
    "grep",
    "list",
    "skill",
    "webfetch",
    "websearch",
    "question",
];
const WRITE_ACTIONS: &[&str] = &["edit", "shell", "subagent", "task"];

pub(crate) fn rules(mode: &str, policy: &str) -> Result<Value, String> {
    if !matches!(mode, "build" | "plan") {
        return Err("请选择编程或分析模式".into());
    }
    if !matches!(policy, "ask" | "auto" | "full_access") {
        return Err("请选择有效的权限模式".into());
    }
    let mut rules = vec![
        json!({"action":"*","resource":"*","effect":if policy == "full_access" { "allow" } else { "ask" }}),
    ];
    for action in READ_ACTIONS {
        rules.push(json!({"action":action,"resource":"*","effect":"allow"}));
    }
    for action in WRITE_ACTIONS {
        let effect = if policy == "full_access" || (policy == "auto" && *action == "edit") {
            "allow"
        } else {
            "ask"
        };
        rules.push(json!({"action":action,"resource":"*","effect":effect}));
    }
    // Full access is explicit for this project; leaving it and repeated failures
    // retain a user gate. Stored project grants may satisfy ask, never deny.
    for action in ["external_directory", "doom_loop", "question"] {
        rules.push(json!({"action":action,"resource":"*","effect":"ask"}));
    }
    if mode == "plan" {
        // Unknown plugin/MCP actions cannot bypass Plan through full_access.
        rules.push(json!({"action":"*","resource":"*","effect":"deny"}));
        for action in READ_ACTIONS {
            rules.push(json!({"action":action,"resource":"*","effect":"allow"}));
        }
        rules.push(json!({"action":"external_directory","resource":"*","effect":"ask"}));
        for action in WRITE_ACTIONS {
            rules.push(json!({"action":action,"resource":"*","effect":"deny"}));
        }
    }
    Ok(Value::Array(rules))
}

pub(crate) fn identify(mode: &str, value: &Value) -> String {
    for policy in ["ask", "auto", "full_access"] {
        if rules(mode, policy).as_ref() == Ok(value) {
            return policy.into();
        }
    }
    // Earlier adapter releases used the private config's edit-allow policy,
    // with only these four extra denies for Plan. Preserve that real behavior.
    let legacy_plan = json!([
        {"action":"edit","resource":"*","effect":"deny"},
        {"action":"shell","resource":"*","effect":"deny"},
        {"action":"subagent","resource":"*","effect":"deny"},
        {"action":"task","resource":"*","effect":"deny"}
    ]);
    if value.is_null() || value == &json!([]) || (mode == "plan" && value == &legacy_plan) {
        return "auto".into();
    }
    "custom".into()
}
