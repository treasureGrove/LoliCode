//! Convert SDK questions at the desktop boundary and validate the renderer's
//! answer against the exact choices the Harness session offered.
use lolicode_agent::{AgentPlanReview, AgentQuestion, AgentQuestionField, AgentQuestionOption};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

const MAX_QUESTIONS: usize = 16;
const MAX_OPTIONS: usize = 32;
const MAX_CUSTOM_CHARS: usize = 4096;
const INVALID_QUESTION: &str = "Harness 提问的格式或内容超出支持范围";
const INVALID_ANSWER: &str = "请按提问中显示的选项填写完整答案";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionRequest {
    request_id: String,
    questions: Vec<SdkQuestion>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SdkQuestion {
    id: String,
    question: String,
    detail: Option<String>,
    header: Option<String>,
    #[serde(default)]
    options: Vec<SdkOption>,
    #[serde(default)]
    multi_select: bool,
    intent: Option<QuestionIntent>,
}

#[derive(Deserialize)]
struct SdkOption {
    label: String,
    description: Option<String>,
}

#[derive(Deserialize)]
struct QuestionIntent {
    kind: String,
    approve: Option<String>,
}

pub(super) fn question_from_params(
    public_session_id: &str,
    params: &Value,
) -> Result<AgentQuestion, String> {
    let request = QuestionRequest::deserialize(params).map_err(|_| INVALID_QUESTION)?;
    if !valid_id(&request.request_id)
        || request.questions.is_empty()
        || request.questions.len() > MAX_QUESTIONS
    {
        return Err(INVALID_QUESTION.into());
    }
    let title = request
        .questions
        .first()
        .and_then(|question| question.header.as_ref())
        .filter(|header| bounded_text(header, 256))
        .cloned()
        .unwrap_or_else(|| "Harness 需要你的回答".into());
    let mut ids = BTreeSet::new();
    let mut plan_review = None;
    let question_count = request.questions.len();
    let fields = request
        .questions
        .into_iter()
        .map(|question| {
            if !ids.insert(question.id.clone()) {
                return Err(INVALID_QUESTION.into());
            }
            if let Some(intent) = question
                .intent
                .as_ref()
                .filter(|intent| intent.kind == "plan-review")
            {
                let approve = intent.approve.as_ref().ok_or(INVALID_QUESTION)?;
                if question_count != 1
                    || question.options.len() != 2
                    || !question
                        .options
                        .iter()
                        .any(|option| &option.label == approve)
                    || !question
                        .detail
                        .as_deref()
                        .is_some_and(|detail| bounded_text(detail, 64 * 1024))
                {
                    return Err(INVALID_QUESTION.into());
                }
                let revise = question
                    .options
                    .iter()
                    .find(|option| &option.label != approve)
                    .ok_or(INVALID_QUESTION)?;
                plan_review = Some(AgentPlanReview {
                    approve: approve.clone(),
                    revise: revise.label.clone(),
                });
            }
            question_field(question)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(AgentQuestion {
        id: request.request_id,
        session_id: public_session_id.into(),
        title,
        fields,
        plan_review,
    })
}

fn question_field(question: SdkQuestion) -> Result<AgentQuestionField, String> {
    let fixed_choice = question
        .intent
        .as_ref()
        .is_some_and(|intent| matches!(intent.kind.as_str(), "approval" | "plan-review"));
    if !valid_id(&question.id)
        || !bounded_text(&question.question, 8192)
        || question
            .detail
            .as_ref()
            .is_some_and(|text| !text.is_empty() && !bounded_text(text, 64 * 1024))
        || question.options.len() > MAX_OPTIONS
        || fixed_choice && (question.options.is_empty() || question.multi_select)
    {
        return Err(INVALID_QUESTION.into());
    }
    let mut labels = BTreeSet::new();
    let options = question
        .options
        .into_iter()
        .map(|option| {
            if !bounded_text(&option.label, 512)
                || option.label.chars().any(char::is_control)
                || option
                    .description
                    .as_ref()
                    .is_some_and(|text| !text.is_empty() && !bounded_text(text, 8192))
                || !labels.insert(option.label.clone())
            {
                return Err(INVALID_QUESTION.into());
            }
            Ok(AgentQuestionOption {
                value: option.label.clone(),
                label: option.label,
                description: option.description,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let custom = !fixed_choice;
    let max_items = (options.len() + usize::from(custom)) as u64;
    Ok(AgentQuestionField {
        key: question.id,
        field_type: if question.multi_select {
            "multiselect"
        } else {
            "string"
        }
        .into(),
        title: Some(question.question),
        description: question.detail,
        required: true,
        options,
        custom,
        default_value: None,
        hidden: false,
        when: Vec::new(),
        format: None,
        placeholder: None,
        min_length: None,
        max_length: custom.then_some(MAX_CUSTOM_CHARS as u64),
        pattern: None,
        min_items: question.multi_select.then_some(1),
        max_items: question.multi_select.then_some(max_items),
        minimum: None,
        maximum: None,
        url: None,
    })
}

pub(super) fn answer_for_question(
    question: &AgentQuestion,
    answer: &Value,
) -> Result<Value, String> {
    let answer = answer
        .as_object()
        .filter(|map| map.len() == question.fields.len())
        .ok_or(INVALID_ANSWER)?;
    let answers = question
        .fields
        .iter()
        .map(|field| {
            let value = answer.get(&field.key).ok_or(INVALID_ANSWER)?;
            match &question.plan_review {
                Some(review) => encode_plan_review(field, review, value),
                None => encode_answer(field, value),
            }
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({"answers": answers}))
}

fn encode_plan_review(
    field: &AgentQuestionField,
    review: &AgentPlanReview,
    value: &Value,
) -> Result<Value, String> {
    if let Some(choice) = value.as_str() {
        return encode_answer(field, &json!(choice));
    }
    let items = value
        .as_array()
        .filter(|items| items.len() == 2)
        .ok_or(INVALID_ANSWER)?;
    if items[0].as_str() != Some(review.revise.as_str()) {
        return Err(INVALID_ANSWER.into());
    }
    let feedback = items[1]
        .as_str()
        .filter(|text| {
            bounded_text(text, MAX_CUSTOM_CHARS * 4) && text.chars().count() <= MAX_CUSTOM_CHARS
        })
        .ok_or(INVALID_ANSWER)?;
    Ok(json!({"id": field.key, "selected": [review.revise], "custom": feedback}))
}

fn encode_answer(field: &AgentQuestionField, value: &Value) -> Result<Value, String> {
    let values = match field.field_type.as_str() {
        "string" => vec![value.as_str().ok_or(INVALID_ANSWER)?],
        "multiselect" => value
            .as_array()
            .filter(|values| {
                !values.is_empty()
                    && values.len() <= field.options.len() + usize::from(field.custom)
            })
            .ok_or(INVALID_ANSWER)?
            .iter()
            .map(|value| value.as_str().ok_or(INVALID_ANSWER))
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(INVALID_ANSWER.into()),
    };
    let mut unique = BTreeSet::new();
    let mut selected = Vec::new();
    let mut custom = None;
    for value in values {
        if !unique.insert(value) {
            return Err(INVALID_ANSWER.into());
        }
        if field.options.iter().any(|option| option.value == value) {
            selected.push(value);
        } else if field.custom
            && custom.is_none()
            && bounded_text(value, MAX_CUSTOM_CHARS * 4)
            && value.chars().count() <= MAX_CUSTOM_CHARS
        {
            custom = Some(value);
        } else {
            return Err(INVALID_ANSWER.into());
        }
    }
    let mut result = json!({"id": field.key, "selected": selected});
    if let Some(custom) = custom {
        result["custom"] = json!(custom);
    }
    Ok(result)
}

fn valid_id(id: &str) -> bool {
    bounded_text(id, 128)
        && !id.chars().any(char::is_control)
        && !matches!(id, "__proto__" | "prototype" | "constructor")
}

fn bounded_text(value: &str, max_bytes: usize) -> bool {
    value.len() <= max_bytes && !value.trim().is_empty() && !value.contains('\0')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_exact_choices_and_other_text_to_one_answer_per_sdk_id() {
        let params = json!({
            "requestId": "native-ask", "sessionId": "internal",
            "questions": [
                {"id":"single", "header":"配置任务", "question":"选一个", "options":[{"label":"原样标签 "} ]},
                {"id":"multi", "question":"选多个", "multiSelect":true, "options":[{"label":"A"},{"label":"B"}]},
                {"id":"text", "question":"填写备注"}
            ]
        });
        let question = question_from_params("lc:public", &params).unwrap();
        assert_eq!(question.id, "native-ask");
        assert_eq!(question.session_id, "lc:public");
        assert_eq!(question.title, "配置任务");
        assert_eq!(question.fields[0].options[0].value, "原样标签 ");
        assert_eq!(
            answer_for_question(
                &question,
                &json!({"single":"原样标签 ","multi":["B","补充","A"],"text":"备注"})
            )
            .unwrap(),
            json!({"answers":[
                {"id":"single","selected":["原样标签 "]},
                {"id":"multi","selected":["B","A"],"custom":"补充"},
                {"id":"text","selected":[],"custom":"备注"}
            ]})
        );
        for malformed in [
            json!({"single":"原样标签 ","multi":["B","B"],"text":"备注"}),
            json!({"single":"原样标签 ","multi":["X","Y"],"text":"备注"}),
            json!({"single":"原样标签 ","multi":["A"],"unexpected":"备注"}),
            json!({"single":["原样标签 "],"multi":["A"],"text":"备注"}),
            json!({"single":"原样标签 ","multi":[],"text":"备注"}),
        ] {
            assert!(answer_for_question(&question, &malformed).is_err());
        }
    }

    #[test]
    fn fixed_choices_disallow_other_and_duplicate_identities() {
        let mut params = json!({
            "requestId":"ask",
            "questions":[{
                "id":"approval", "question":"允许本次操作？",
                "intent":{"kind":"approval","approve":"允许","reject":"拒绝"},
                "options":[{"label":"允许"},{"label":"拒绝"}]
            }]
        });
        let question = question_from_params("lc:public", &params).unwrap();
        assert!(!question.fields[0].custom);
        assert_eq!(
            answer_for_question(&question, &json!({"approval":"允许"})).unwrap(),
            json!({"answers":[{"id":"approval","selected":["允许"]}]})
        );
        assert!(answer_for_question(&question, &json!({"approval":"允许 "})).is_err());
        params["questions"][0]["options"][1]["label"] = json!("允许");
        assert!(question_from_params("lc:public", &params).is_err());
        params["questions"] = json!([
            {"id":"duplicate","question":"第一次"},
            {"id":"duplicate","question":"第二次"}
        ]);
        assert!(question_from_params("lc:public", &params).is_err());
    }

    #[test]
    fn plan_review_preserves_native_choices_and_only_allows_feedback_with_revision() {
        let question = question_from_params(
            "lc:public",
            &json!({
                "requestId": "review",
                "questions": [{
                    "id": "plan-review", "question": "Approve this plan and leave plan mode?",
                    "detail": "# Implementation\n- First step",
                    "intent": {"kind": "plan-review", "approve": "Approve", "callId": "exit-1"},
                    "options": [{"label": "Approve"}, {"label": "Keep planning"}]
                }]
            }),
        )
        .unwrap();
        assert_eq!(
            question.plan_review.as_ref().unwrap().revise,
            "Keep planning"
        );
        assert_eq!(
            answer_for_question(
                &question,
                &json!({"plan-review": ["Keep planning", "Add a test"]})
            )
            .unwrap(),
            json!({"answers": [{"id": "plan-review", "selected": ["Keep planning"], "custom": "Add a test"}]})
        );
        assert_eq!(
            answer_for_question(&question, &json!({"plan-review": "Approve"})).unwrap(),
            json!({"answers": [{"id": "plan-review", "selected": ["Approve"]}]})
        );
        assert!(answer_for_question(
            &question,
            &json!({"plan-review": ["Approve", "Add a test"]})
        )
        .is_err());
    }
}
