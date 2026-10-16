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
        let mut reported = requests
            .iter()
            .filter_map(|request| field(&request.tokens))
            .peekable();
        if reported.peek().is_none() {
            return None;
        }
        Some(reported.fold(0u64, u64::saturating_add))
    }
    let cache_read = sum(requests, |usage| usage.cache_read_tokens);
    // A pending request must not erase history. For the rate, however, both
    // sides must describe the same requests; never divide unrelated partial sums.
    let cache_pairs = requests
        .iter()
        .filter_map(|request| {
            Some((
                request.tokens.cache_read_tokens?,
                request.tokens.cache_input_tokens?,
            ))
        })
        .filter(|(read, input)| read <= input)
        .collect::<Vec<_>>();
    let cache_input = sum(requests, |usage| usage.cache_input_tokens);
    let (rate_read, rate_input) = cache_pairs
        .iter()
        .fold((0u64, 0u64), |(read, input), pair| {
            (read.saturating_add(pair.0), input.saturating_add(pair.1))
        });
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
        total_tokens: sum(requests, |usage| {
            Some(usage.input_tokens?.saturating_add(usage.output_tokens?))
        }),
        token_reported_requests: requests
            .iter()
            .filter(|request| {
                request.tokens.input_tokens.is_some() && request.tokens.output_tokens.is_some()
            })
            .count() as u64,
        cache_hit_rate: (rate_input > 0).then(|| rate_read as f64 / rate_input as f64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(tokens: AgentTokenUsage) -> Request {
        Request {
            message_id: "m".into(),
            task_id: "t".into(),
            started_at: 1,
            completed_at: None,
            tokens,
            generated_at: None,
            duration_unknown: false,
        }
    }

    #[test]
    fn pending_and_unreported_requests_do_not_erase_previous_usage() {
        let done = request(AgentTokenUsage {
            input_tokens: Some(100),
            output_tokens: Some(20),
            cache_read_tokens: Some(80),
            cache_input_tokens: Some(100),
            ..Default::default()
        });
        let pending = request(AgentTokenUsage::default());
        let aggregate = totals(&[&done, &pending]);
        assert_eq!(aggregate.tokens.input_tokens, Some(100));
        assert_eq!(aggregate.total_tokens, Some(120));
        assert_eq!(aggregate.cache_hit_rate, Some(0.8));
        assert_eq!(aggregate.token_reported_requests, 1);
        assert_eq!(aggregate.model_requests, 2);
    }

    #[test]
    fn cache_rate_and_total_use_paired_measurements_only() {
        let input_only = request(AgentTokenUsage {
            input_tokens: Some(100),
            cache_input_tokens: Some(100),
            ..Default::default()
        });
        let output_only = request(AgentTokenUsage {
            output_tokens: Some(20),
            cache_read_tokens: Some(80),
            ..Default::default()
        });
        let aggregate = totals(&[&input_only, &output_only]);
        assert_eq!(aggregate.total_tokens, None);
        assert_eq!(aggregate.cache_hit_rate, None);
        assert_eq!(aggregate.token_reported_requests, 0);
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
