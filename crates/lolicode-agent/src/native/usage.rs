use crate::{AgentSessionUsage, AgentTaskUsage, AgentTokenUsage, AgentUsage, AgentUsageTotals};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Ledger {
    pub since: u64,
    pub complete: bool,
    pub task: Option<Task>,
    pub requests: Vec<Request>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Task {
    pub id: String,
    pub started_at: u64,
    pub completed_at: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Request {
    pub message_id: String,
    pub task_id: String,
    pub started_at: u64,
    pub completed_at: Option<u64>,
    pub tokens: AgentTokenUsage,
    #[serde(default)]
    pub generated_at: Option<u64>,
    #[serde(default)]
    pub duration_unknown: bool,
}
impl Ledger {
    pub fn new(since: u64, complete: bool) -> Self {
        Self {
            since,
            complete,
            task: None,
            requests: Vec::new(),
        }
    }
}
fn totals(requests: &[&Request]) -> AgentUsageTotals {
    fn sum(requests: &[&Request], field: impl Fn(&AgentTokenUsage) -> Option<u64>) -> Option<u64> {
        if requests.is_empty() {
            return None;
        }
        requests.iter().try_fold(0u64, |sum, request| {
            field(&request.tokens).map(|count| sum.saturating_add(count))
        })
    }
    let cache_read = sum(requests, |usage| usage.cache_read_tokens);
    let cache_input = sum(requests, |usage| usage.cache_input_tokens);
    AgentUsageTotals {
        tokens: AgentTokenUsage {
            input_tokens: sum(requests, |usage| usage.input_tokens),
            output_tokens: sum(requests, |usage| usage.output_tokens),
            cache_read_tokens: cache_read,
            cache_write_tokens: sum(requests, |usage| usage.cache_write_tokens),
            cache_input_tokens: cache_input,
        },
        model_requests: requests.len() as u64,
        reported_requests: requests
            .iter()
            .filter(|request| request.tokens.reported())
            .count() as u64,
        cache_hit_rate: match (cache_read, cache_input) {
            (Some(read), Some(input)) if input > 0 && read <= input => {
                Some(read as f64 / input as f64)
            }
            _ => None,
        },
    }
}
pub(super) fn snapshot(ledger: &Ledger, now: u64) -> AgentUsage {
    let requests = ledger.requests.iter().collect::<Vec<_>>();
    AgentUsage {
        session: AgentSessionUsage {
            totals: totals(&requests),
            since: ledger.since,
            complete: ledger.complete,
        },
        task: ledger.task.as_ref().map(|task| {
            let requests = requests
                .into_iter()
                .filter(|request| request.task_id == task.id)
                .collect::<Vec<_>>();
            AgentTaskUsage {
                totals: totals(&requests),
                started_at: task.started_at,
                completed_at: task.completed_at,
                elapsed_ms: task
                    .completed_at
                    .unwrap_or(now)
                    .saturating_sub(task.started_at),
                generation_ms: requests.iter().try_fold(0u64, |sum, request| {
                    (!request.duration_unknown).then(|| {
                        sum.saturating_add(
                            request
                                .generated_at
                                .or(request.completed_at)
                                .unwrap_or(now)
                                .saturating_sub(request.started_at),
                        )
                    })
                }),
            }
        }),
    }
}
