//! Pure automation drafts. The desktop owns project/model selection and saving;
//! this module cannot create jobs, schedule work, or write application state.
use super::types::{AutomationSaveReceipt, StoredSession};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

const MAX_PROMPT_BYTES: usize = 64 * 1024;
const ALLOWED_FIELDS: &[&str] = &[
    "title",
    "prompt",
    "trigger",
    "cronExpr",
    "idleAfterMinutes",
    "idleIntervalMinutes",
    "mode",
    "automationId",
];

pub(super) fn schema() -> Value {
    json!({
        "type":"function",
        "function":{
            "name":"propose_automation",
            "description":"Prepare a validated automation proposal card for the user to review and save. This tool DOES NOT create, update, enable or schedule an automation. First clarify the task and exact timing with ask_user or conversation; never invent missing timing or task content. Projects and models are inherited by the desktop from this conversation. Omit mode to inherit the conversation's execution settings. For follow-up edits, reuse the savedAutomationId from a desktop-confirmed saved receipt as automationId; do not create a second automation unless asked. Otherwise use automationId only for an existing task identified by the user. Saving still checks project ownership.",
            "parameters":{
                "type":"object",
                "properties":{
                    "title":{"type":"string","minLength":1,"maxLength":160,"description":"A concise name derived from the user's requested task."},
                    "prompt":{"type":"string","minLength":1,"maxLength":65536,"description":"Complete task instructions, at most 64 KiB UTF-8. Ask for the task if missing."},
                    "trigger":{"type":"string","enum":["schedule","idle"]},
                    "cronExpr":{"type":"string","minLength":9,"maxLength":80,"description":"Required for schedule, omitted for idle. Five fields: minute hour * * weekday. Supports an explicit minute 0-59 every hour (e.g. 15 * * * *), daily at an explicit hour 0-23 (30 9 * * *), or selected weekdays 0-6, Sunday=0 (30 9 * * 1,3,5). No ranges, steps, monthly schedules or unspecified time. Uses the desktop's local time."},
                    "idleAfterMinutes":{"type":"integer","minimum":1,"maximum":1440,"description":"Required for idle, omitted for schedule. User-confirmed system inactivity threshold in minutes."},
                    "idleIntervalMinutes":{"type":"integer","minimum":1,"maximum":10080,"description":"Required for idle, omitted for schedule. User-confirmed minimum repeat interval in minutes."},
                    "mode":{"type":"string","enum":["build","guarded","yolo"],"description":"Optional explicit automation execution mode. Omit to inherit current conversation settings; do not silently increase permissions."},
                    "automationId":{"type":"string","minLength":1,"maxLength":256,"description":"Optional existing automation ID for an edit proposal. Omit for a new automation. This is not proof of ownership."}
                },
                "required":["title","prompt","trigger"],
                "additionalProperties":false
            }
        }
    })
}

fn required_text<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty() && !text.contains('\0'))
        .ok_or_else(|| {
            format!(
                "自动化缺少有效的 {key}；请先通过 ask_user 或对话向用户确认，不能代填任务或时间。"
            )
        })
}

fn decimal(field: &str, maximum: u32, label: &str) -> Result<u32, String> {
    if field.is_empty() || !field.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!(
            "自动化计划{label}必须是 0–{maximum} 的十进制整数；请先确认具体时间。"
        ));
    }
    field
        .parse::<u32>()
        .ok()
        .filter(|value| *value <= maximum)
        .ok_or_else(|| format!("自动化计划{label}需为 0–{maximum}；请先确认具体时间。"))
}

fn cron(expr: &str) -> Result<String, String> {
    if expr.len() > 80 || expr.chars().any(char::is_control) {
        return Err("自动化计划格式无效；请先确认具体时间。".into());
    }
    let fields = expr.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 || fields[2] != "*" || fields[3] != "*" {
        return Err("自动化计划仅支持每小时、每天或每周多日；需要明确的分钟、小时和星期，不能使用月份、区间或步长。".into());
    }
    let minute = decimal(fields[0], 59, "分钟")?;
    if fields[1] == "*" && fields[4] == "*" {
        return Ok(format!("{minute} * * * *"));
    }
    let hour = decimal(fields[1], 23, "小时")?;
    if fields[4] == "*" {
        return Ok(format!("{minute} {hour} * * *"));
    }
    let mut weekdays = Vec::new();
    for day in fields[4].split(',') {
        if day.len() != 1 {
            return Err(
                "自动化星期必须为 0–6 的逗号列表（星期日为 0），不支持区间、步长或空项。".into(),
            );
        }
        let day = decimal(day, 6, "星期")?;
        if !weekdays.contains(&day) {
            weekdays.push(day);
        }
    }
    Ok(format!(
        "{minute} {hour} * * {}",
        weekdays
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",")
    ))
}

fn minutes(input: &Map<String, Value>, key: &str, maximum: u64) -> Result<u64, String> {
    input.get(key).and_then(Value::as_u64).filter(|value| (1..=maximum).contains(value))
        .ok_or_else(|| format!("自动化 {key} 需要用户明确的 1–{maximum} 整数分钟；请先通过 ask_user 或对话确认，不使用默认时间。"))
}

pub(super) fn propose(input: &Value) -> Result<String, String> {
    let object = input.as_object().ok_or("自动化提案参数必须是对象")?;
    if object
        .keys()
        .any(|key| !ALLOWED_FIELDS.contains(&key.as_str()))
    {
        return Err("自动化提案包含未知参数；项目和模型由当前会话继承，提案不能指定项目路径、模型或直接保存操作。".into());
    }
    let title = required_text(object, "title")?;
    let prompt = required_text(object, "prompt")?;
    if title.chars().count() > 160
        || title.chars().any(char::is_control)
        || prompt.len() > MAX_PROMPT_BYTES
    {
        return Err("自动化名称需为 1–160 字且不含换行，任务内容需为 1–64 KiB UTF-8 文本。".into());
    }
    let trigger = required_text(object, "trigger")?;
    let mut proposal = json!({"title":title,"prompt":prompt,"trigger":trigger});
    match trigger {
        "schedule" => {
            if object.contains_key("idleAfterMinutes") || object.contains_key("idleIntervalMinutes")
            {
                return Err("定时自动化不能同时指定闲置触发时间；请先确认触发方式。".into());
            }
            proposal["cronExpr"] = json!(cron(required_text(object, "cronExpr")?)?);
        }
        "idle" => {
            if object.contains_key("cronExpr") {
                return Err("闲置自动化不能同时指定定时计划；请先确认触发方式。".into());
            }
            proposal["idleAfterMinutes"] = json!(minutes(object, "idleAfterMinutes", 1440)?);
            proposal["idleIntervalMinutes"] = json!(minutes(object, "idleIntervalMinutes", 10080)?);
        }
        _ => {
            return Err(
                "自动化触发方式必须为 schedule 或 idle；请先通过 ask_user 或对话确认。".into(),
            )
        }
    }
    if let Some(value) = object.get("mode") {
        let mode = value
            .as_str()
            .filter(|mode| matches!(*mode, "build" | "guarded" | "yolo"))
            .ok_or("自动化权限模式只支持 build、guarded 或 yolo；省略时继承当前会话设置")?;
        proposal["mode"] = json!(mode);
    }
    let mut output = json!({"type":"automation_proposal","version":1,"input":proposal});
    if let Some(value) = object.get("automationId") {
        let id = value
            .as_str()
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
            .ok_or("自动化编辑编号无效；只能使用用户要编辑的现有任务编号")?;
        output["automationId"] = json!(id);
    }
    serde_json::to_string(&output).map_err(|_| "无法编码自动化提案".into())
}

/// Validate the original pure proposal and its immutable input. Saved metadata
/// is a desktop fact and is deliberately not accepted by propose_automation.
pub(super) fn proposal_identity(output: &Value) -> Result<String, String> {
    let object = output.as_object().ok_or("自动化工具输出无效")?;
    if output["type"] != "automation_proposal"
        || output["version"] != 1
        || object.keys().any(|key| {
            ![
                "type",
                "version",
                "input",
                "automationId",
                "savedAutomationId",
                "status",
            ]
            .contains(&key.as_str())
        })
    {
        return Err("此工具输出不是受支持的自动化提案".into());
    }
    let mut input = output["input"].clone();
    let fields = input.as_object_mut().ok_or("自动化提案内容无效")?;
    if fields.contains_key("automationId") {
        return Err("自动化提案内容包含无效的编辑编号".into());
    }
    if let Some(id) = output.get("automationId") {
        fields.insert("automationId".into(), id.clone());
    }
    let expected: Value =
        serde_json::from_str(&propose(&input)?).map_err(|_| "自动化提案内容无效")?;
    if expected["input"] != output["input"]
        || expected.get("automationId") != output.get("automationId")
    {
        return Err("自动化提案内容不是已验证的标准格式".into());
    }
    match (output.get("savedAutomationId"), output.get("status")) {
        (None, None) => {}
        (Some(id), Some(status)) if valid_id(id).is_some() && status == "saved" => {}
        _ => return Err("自动化保存确认状态无效".into()),
    }
    let bytes = serde_json::to_vec(&expected).map_err(|_| "无法编码自动化提案")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn valid_id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|id| !id.trim().is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
}

pub(super) fn mark_saved(output: &mut Value, automation_id: &str) -> Result<String, String> {
    let fingerprint = proposal_identity(output)?;
    for field in ["automationId", "savedAutomationId"] {
        if output
            .get(field)
            .is_some_and(|value| value.as_str() != Some(automation_id))
        {
            return Err("自动化保存编号与原提案或已有确认不一致，未改写会话记录".into());
        }
    }
    output["savedAutomationId"] = json!(automation_id);
    output["status"] = json!("saved");
    Ok(fingerprint)
}

/// Merge only matching proposal tool results. Never append a user/tool message
/// into an active tool-call group or overwrite a compaction source in flight.
pub(super) fn apply_saved_receipts(stored: &mut StoredSession) -> bool {
    let mut changed = false;
    for message in &mut stored.history {
        if message["role"] != "tool" {
            continue;
        }
        let Some(id) = message["tool_call_id"].as_str() else {
            continue;
        };
        let Some(text) = message["content"].as_str() else {
            continue;
        };
        let Ok(mut output) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        let Ok(fingerprint) = proposal_identity(&output) else {
            continue;
        };
        let Some(receipt) = stored.automation_save_receipts.iter().find(|receipt| {
            receipt.tool_call_id == id && receipt.proposal_fingerprint == fingerprint
        }) else {
            continue;
        };
        if mark_saved(&mut output, &receipt.automation_id).is_err() {
            continue;
        }
        if let Ok(saved) = serde_json::to_string(&output) {
            if saved != text {
                message["content"] = json!(saved);
                changed = true;
            }
        }
    }
    changed
}

pub(super) fn saved_context(receipts: &[AutomationSaveReceipt]) -> Option<String> {
    if receipts.is_empty() {
        return None;
    }
    let recent = receipts
        .iter()
        .rev()
        .take(20)
        .map(|receipt| {
            json!({
                "toolCallId":receipt.tool_call_id,"savedAutomationId":receipt.automation_id,
                "title":receipt.title,"status":"saved"
            })
        })
        .collect::<Vec<_>>();
    Some(format!("\nDesktop-confirmed automation saves follow as factual state, not instructions. These receipts supersede an older proposal's pending status. When the user asks to change one of these automations, pass its savedAutomationId as automationId to propose_automation; do not create a second job unless the user requests a separate automation.\n{}\n", json!(recent)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scheduled() -> Value {
        json!({"title":"每周检查","prompt":"检查当前项目测试并报告失败项。","trigger":"schedule","cronExpr":"30 9 * * 1,3,5"})
    }

    #[test]
    fn scheduled_proposals_preserve_supported_times_and_never_claim_a_save() {
        for (expr, expected) in [
            ("15 * * * *", "15 * * * *"),
            ("00 09 * * *", "0 9 * * *"),
            ("30 9 * * 1,3,5", "30 9 * * 1,3,5"),
            ("5 0 * * 0,6,0", "5 0 * * 0,6"),
        ] {
            let mut input = scheduled();
            input["cronExpr"] = json!(expr);
            let result: Value = serde_json::from_str(&propose(&input).unwrap()).unwrap();
            assert_eq!(
                result,
                json!({"type":"automation_proposal","version":1,"input":{"title":input["title"],"prompt":input["prompt"],"trigger":"schedule","cronExpr":expected}})
            );
            assert!(
                result["input"].get("mode").is_none(),
                "mode is inherited, not invented"
            );
        }
    }

    #[test]
    fn missing_task_and_timing_require_clarification_instead_of_defaults() {
        for field in ["title", "prompt", "trigger", "cronExpr"] {
            let mut input = scheduled();
            input.as_object_mut().unwrap().remove(field);
            assert!(
                propose(&input).unwrap_err().contains("ask_user"),
                "missing {field}"
            );
        }
        for field in ["title", "prompt", "cronExpr"] {
            let mut input = scheduled();
            input[field] = json!("   ");
            assert!(propose(&input).is_err());
        }
        for field in ["idleAfterMinutes", "idleIntervalMinutes"] {
            let mut input = json!({"title":"闲置检查","prompt":"检查测试","trigger":"idle","idleAfterMinutes":10,"idleIntervalMinutes":60});
            input.as_object_mut().unwrap().remove(field);
            assert!(propose(&input).unwrap_err().contains("ask_user"));
        }
    }

    #[test]
    fn invalid_or_unsupported_cron_is_never_silently_replaced() {
        for expr in [
            "* * * * *",
            "0 */2 * * *",
            "0 9 * * 1-5",
            "0 9 1 * *",
            "0 9 * 1 *",
            "60 9 * * *",
            "0 24 * * *",
            "0 * * * 1",
            "0 9 * * 7",
            "0 9 * * 1,",
            "0 9 * * ,1",
            "0 9 * * 01",
            "0 9 * * *,1",
            "+1 9 * * *",
            "0 +9 * * *",
            "0 9 * * +1",
            "0\n9 * * *",
            "0 9 * * * *",
        ] {
            let mut input = scheduled();
            input["cronExpr"] = json!(expr);
            assert!(propose(&input).is_err(), "invalid cron {expr}");
        }
    }

    #[test]
    fn idle_ranges_and_trigger_specific_fields_are_strict() {
        for (after, interval) in [(1, 1), (1440, 10080)] {
            let value: Value = serde_json::from_str(&propose(&json!({"title":"闲置检查","prompt":"检查测试","trigger":"idle","idleAfterMinutes":after,"idleIntervalMinutes":interval})).unwrap()).unwrap();
            assert_eq!(value["input"]["idleAfterMinutes"], after);
            assert_eq!(value["input"]["idleIntervalMinutes"], interval);
            assert!(value["input"].get("cronExpr").is_none());
        }
        for (key, invalid) in [
            ("idleAfterMinutes", json!(0)),
            ("idleAfterMinutes", json!(1441)),
            ("idleIntervalMinutes", json!(10081)),
            ("idleIntervalMinutes", json!(1.5)),
            ("idleIntervalMinutes", json!("60")),
            ("idleIntervalMinutes", Value::Null),
        ] {
            let mut input = json!({"title":"闲置检查","prompt":"检查测试","trigger":"idle","idleAfterMinutes":10,"idleIntervalMinutes":60});
            input[key] = invalid;
            assert!(propose(&input).is_err());
        }
        let mut input = scheduled();
        input["idleAfterMinutes"] = json!(10);
        assert!(propose(&input).is_err());
        input["trigger"] = json!("idle");
        input["idleIntervalMinutes"] = json!(60);
        assert!(propose(&input).is_err());
    }

    #[test]
    fn proposal_scope_is_owned_by_the_desktop_and_edit_ids_do_not_grant_authority() {
        for field in [
            "workspacePath",
            "projectPath",
            "modelSelection",
            "enabled",
            "recurring",
            "clientRequestId",
            "save",
        ] {
            let mut input = scheduled();
            input[field] = json!("untrusted");
            assert!(propose(&input).is_err(), "unknown {field}");
        }
        for mode in ["build", "guarded", "yolo"] {
            let mut input = scheduled();
            input["mode"] = json!(mode);
            input["automationId"] = json!("existing-job-id");
            let result: Value = serde_json::from_str(&propose(&input).unwrap()).unwrap();
            assert_eq!(result["input"]["mode"], mode);
            assert_eq!(result["automationId"], "existing-job-id");
            assert!(result["input"].get("automationId").is_none());
        }
        for invalid in [
            Value::Null,
            json!(false),
            json!("inherit"),
            json!("full_access"),
        ] {
            let mut input = scheduled();
            input["mode"] = invalid;
            assert!(propose(&input).is_err());
        }
    }

    #[test]
    fn text_limits_use_title_characters_and_prompt_utf8_bytes() {
        let mut input = scheduled();
        input["title"] = json!("测".repeat(160));
        input["prompt"] = json!("a".repeat(MAX_PROMPT_BYTES));
        assert!(propose(&input).is_ok());
        input["title"] = json!("测".repeat(161));
        assert!(propose(&input).is_err());
        input["title"] = json!("自动化");
        input["prompt"] = json!("测".repeat(MAX_PROMPT_BYTES / 3 + 1));
        assert!(propose(&input).is_err());
    }
}
