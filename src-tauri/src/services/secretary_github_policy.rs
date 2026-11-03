//! Host-side explicit admission inspired by dsh-superagent's GitHub Source,
//! Policy gate and durable Mandate. External text can select a saved rule by
//! exact command; only the locally saved instruction grants worker scope.
use super::{GithubItem, GithubKind, Source, ThreadFeed};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const MAX_RULES: usize = 8;
const MAX_ACTORS: usize = 16;
const MAX_DECISIONS: usize = 120;
pub(crate) const MAX_AUTO_PER_SYNC: usize = 2;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GithubRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub actors: Vec<String>,
    pub kinds: Vec<GithubKind>,
    pub keyword: String,
    pub instructions: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPolicy {
    pub enabled: bool,
    pub revision: u64,
    pub rules: Vec<GithubRule>,
    pub decisions: Vec<PolicyDecision>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DecisionStatus {
    Queued,
    Dispatched,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub(crate) item_id: String,
    title: String,
    url: String,
    pub(crate) rule_id: String,
    rule_name: String,
    pub(crate) policy_revision: u64,
    pub(crate) actor_id: u64,
    pub(crate) status: DecisionStatus,
    decided_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(crate) struct PolicyAuthority {
    pub(crate) actors: BTreeMap<String, u64>,
    /// Absence means this feed still needs a successful baseline observation.
    baselines: BTreeMap<ThreadFeed, u64>,
}

#[derive(Clone, Debug)]
pub(crate) struct AutoCandidate {
    pub(crate) item: GithubItem,
    pub(crate) decision: PolicyDecision,
    pub(crate) instructions: String,
}

fn safe_slug(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

pub(crate) fn validate_rules(rules: &mut [GithubRule]) -> Result<BTreeSet<String>, String> {
    if rules.len() > MAX_RULES {
        return Err("最多可保存 8 条自动派工规则".into());
    }
    let (mut ids, mut keywords, mut actors) = (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    for rule in rules {
        rule.name = rule.name.trim().into();
        rule.keyword = rule.keyword.trim().to_ascii_lowercase();
        rule.instructions = rule.instructions.trim().into();
        if !safe_slug(&rule.id, 64) || !ids.insert(rule.id.clone()) {
            return Err("规则编号无效或重复".into());
        }
        if rule.name.is_empty() || rule.name.len() > 160 || rule.name.chars().any(char::is_control)
        {
            return Err("请填写规则名称，最多 160 字节".into());
        }
        if !safe_slug(&rule.keyword, 48) || !keywords.insert(rule.keyword.clone()) {
            return Err("规则关键词必须唯一，使用最多 48 个英文字母、数字、连字符或下划线".into());
        }
        if rule.instructions.is_empty()
            || rule.instructions.len() > 8000
            || rule.instructions.contains('\0')
        {
            return Err("请填写规则的工作要求，最多 8000 字节".into());
        }
        rule.kinds.sort_unstable();
        rule.kinds.dedup();
        if rule.kinds.is_empty() || rule.kinds.contains(&GithubKind::Ci) {
            return Err("请选择 Issue、PR 或评论作为触发范围".into());
        }
        if rule.actors.is_empty() || rule.actors.len() > 8 {
            return Err("每条规则需指定 1 到 8 个 GitHub 账户".into());
        }
        for actor in &mut rule.actors {
            *actor = actor.trim().trim_start_matches('@').to_ascii_lowercase();
            if !safe_slug(actor, 39)
                || actor.contains('_')
                || actor.starts_with('-')
                || actor.ends_with('-')
            {
                return Err("GitHub 账户名无效".into());
            }
            if rule.enabled {
                actors.insert(actor.clone());
            }
        }
        rule.actors.sort_unstable();
        rule.actors.dedup();
    }
    if actors.len() > MAX_ACTORS {
        return Err("启用的规则合计最多信任 16 个账户".into());
    }
    Ok(actors)
}

impl Source {
    pub(crate) fn disable_policy(&mut self, reason: &str) -> Result<(), String> {
        if self.state.policy.enabled {
            self.state.policy.enabled = false;
            self.state.policy.revision = self
                .state
                .policy
                .revision
                .checked_add(1)
                .ok_or("自动派工规则版本溢出")?;
        }
        self.policy_authority = PolicyAuthority::default();
        self.fail_queued_decisions(reason);
        Ok(())
    }

    pub(crate) fn set_policy(
        &mut self,
        enabled: bool,
        rules: Vec<GithubRule>,
        actors: BTreeMap<String, u64>,
    ) -> Result<(), String> {
        let revision = self
            .state
            .policy
            .revision
            .checked_add(1)
            .ok_or("自动派工规则版本溢出")?;
        self.fail_queued_decisions("自动派工规则已更新，请手动交办该条目");
        self.state.policy.enabled = enabled;
        self.state.policy.revision = revision;
        self.state.policy.rules = rules;
        self.policy_authority = PolicyAuthority {
            actors,
            baselines: BTreeMap::new(),
        };
        Ok(())
    }

    pub(crate) fn fail_queued_decisions(&mut self, reason: &str) {
        for decision in &mut self.state.policy.decisions {
            if decision.status == DecisionStatus::Queued {
                decision.status = DecisionStatus::Failed;
                decision.error = Some(reason.into());
            }
        }
    }

    pub(super) fn observe_policy_feed(
        &mut self,
        before: &Source,
        feed: ThreadFeed,
        items: &[GithubItem],
        previous_cursor: Option<u64>,
        cursor: Option<u64>,
        observed_at: u64,
    ) {
        if !self.state.policy.enabled || !self.state.monitoring {
            return;
        }
        let Some(baseline) = self.policy_authority.baselines.get(&feed).copied() else {
            // First successful observation establishes the boundary. Use the
            // newest API timestamp as well as the local instant so clock skew
            // cannot turn existing GitHub history into new authorization.
            self.policy_authority
                .baselines
                .insert(feed, cursor.unwrap_or_default().max(observed_at));
            return;
        };
        for item in items {
            let Some(created) = item.created_at else {
                continue;
            };
            if created <= baseline
                // The inbox and audit views are bounded. A strict cursor
                // boundary prevents replay after both views evict an event.
                || created <= previous_cursor.unwrap_or_default()
                || before.state.items.iter().any(|seen| seen.id == item.id)
                || before
                    .state
                    .policy
                    .decisions
                    .iter()
                    .any(|seen| seen.item_id == item.id)
                || item.task_id.is_some()
            {
                continue;
            }
            let Some(candidate) = self.match_policy(item, observed_at) else {
                continue;
            };
            self.auto_candidates.push(candidate);
        }
    }

    fn match_policy(&self, item: &GithubItem, observed_at: u64) -> Option<AutoCandidate> {
        let actor_id = item.human_actor_id?;
        let login = item.actor.as_deref()?.to_ascii_lowercase();
        if self.policy_authority.actors.get(&login).copied() != Some(actor_id)
            || item.created_at != Some(item.updated_at)
            || item.kind == GithubKind::Ci
            || (matches!(item.kind, GithubKind::Issue | GithubKind::PullRequest)
                && item.state != "open")
        {
            return None;
        }
        // The command must occupy a whole unquoted line at the start of the
        // body. Remote details are reference context, not worker instructions.
        let line = item
            .body
            .as_deref()?
            .lines()
            .find(|line| !line.trim().is_empty())?;
        let keyword = line.trim_end().strip_prefix("/loli ")?;
        let rule = self.state.policy.rules.iter().find(|rule| {
            rule.enabled
                && rule.kinds.contains(&item.kind)
                && rule.actors.contains(&login)
                && rule.keyword.eq_ignore_ascii_case(keyword)
        })?;
        Some(AutoCandidate {
            item: item.clone(),
            instructions: rule.instructions.clone(),
            decision: PolicyDecision {
                item_id: item.id.clone(),
                title: item.title.clone(),
                url: item.url.clone(),
                rule_id: rule.id.clone(),
                rule_name: rule.name.clone(),
                policy_revision: self.state.policy.revision,
                actor_id,
                status: DecisionStatus::Queued,
                decided_at: observed_at,
                task_id: None,
                error: None,
            },
        })
    }

    /// Reserve before the native call. Overflow remains available for manual
    /// assignment. A queued record left by interruption is reconciled using
    /// the native receipt and never automatically replayed.
    pub(crate) fn reserve_candidates(&mut self) -> Vec<AutoCandidate> {
        let mut candidates = std::mem::take(&mut self.auto_candidates);
        candidates
            .sort_by(|a, b| (a.item.updated_at, &a.item.id).cmp(&(b.item.updated_at, &b.item.id)));
        candidates.dedup_by(|a, b| a.item.id == b.item.id);
        let mut admitted = Vec::new();
        for mut candidate in candidates {
            if admitted.len() == MAX_AUTO_PER_SYNC {
                candidate.decision.status = DecisionStatus::Failed;
                candidate.decision.error = Some("已达本轮自动派工上限，可手动交办该条目".into());
            } else {
                admitted.push(candidate.clone());
            }
            self.state.policy.decisions.insert(0, candidate.decision);
        }
        while self.state.policy.decisions.len() > MAX_DECISIONS {
            let Some(index) = self
                .state
                .policy
                .decisions
                .iter()
                .rposition(|entry| entry.status != DecisionStatus::Queued)
            else {
                break;
            };
            self.state.policy.decisions.remove(index);
        }
        admitted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn rule() -> GithubRule {
        GithubRule {
            id: "review".into(),
            name: "Review".into(),
            enabled: true,
            actors: vec!["octocat".into()],
            kinds: vec![GithubKind::Issue, GithubKind::Comment],
            keyword: "review".into(),
            instructions: "Inspect the repository for a regression".into(),
        }
    }

    fn item(id: &str, created: u64, body: &str) -> GithubItem {
        GithubItem {
            id: id.into(),
            kind: GithubKind::Issue,
            number: 17,
            title: "Test".into(),
            url: "https://github.com/test/repo/issues/17".into(),
            state: "open".into(),
            actor: Some("Octocat".into()),
            updated_at: created,
            body: Some(body.into()),
            task_id: None,
            created_at: Some(created),
            human_actor_id: Some(17),
            head_sha: None,
            pull_request_numbers: vec![],
        }
    }

    fn enabled_source() -> Source {
        let mut source = Source::default();
        source.state.monitoring = true;
        source
            .set_policy(true, vec![rule()], BTreeMap::from([("octocat".into(), 17)]))
            .unwrap();
        source
    }

    #[test]
    fn successful_baseline_and_policy_revision_exclude_existing_history() {
        let mut source = enabled_source();
        let historical = item("issue:1", 100, "/loli review");
        source.observe_policy_feed(
            &source.clone(),
            ThreadFeed::Issue,
            &[historical.clone()],
            None,
            Some(100),
            110,
        );
        assert!(source.reserve_candidates().is_empty());
        let fresh = item(
            "issue:2",
            120,
            "/loli REVIEW\nRemote body cannot change worker instructions",
        );
        source.observe_policy_feed(
            &source.clone(),
            ThreadFeed::Issue,
            &[historical, fresh.clone()],
            Some(100),
            Some(120),
            130,
        );
        let accepted = source.reserve_candidates();
        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].item.id, fresh.id);
        assert_eq!(accepted[0].instructions, rule().instructions);
        assert_eq!(accepted[0].decision.policy_revision, 1);

        source
            .set_policy(true, vec![rule()], BTreeMap::from([("octocat".into(), 17)]))
            .unwrap();
        source.observe_policy_feed(
            &source.clone(),
            ThreadFeed::Issue,
            &[fresh],
            Some(120),
            Some(120),
            140,
        );
        assert!(source.reserve_candidates().is_empty());
        assert_eq!(
            source.state.policy.decisions[0].status,
            DecisionStatus::Failed
        );
    }

    #[test]
    fn exact_address_and_verified_human_gate_exclude_edits_bots_and_ci() {
        let mut source = enabled_source();
        source.observe_policy_feed(&source.clone(), ThreadFeed::Issue, &[], None, None, 100);
        let mut other_id = item("issue:2", 110, "/loli review");
        other_id.human_actor_id = Some(18);
        let mut bot = item("issue:3", 110, "/loli review");
        bot.human_actor_id = None;
        let mut edited = item("issue:4", 110, "/loli review");
        edited.updated_at = 115;
        let mut ci = item("ci:5", 110, "/loli review");
        ci.kind = GithubKind::Ci;
        let quoted = item("issue:6", 110, "> /loli review");
        let in_code = item("issue:7", 110, "    /loli review");
        let suffix = item("issue:8", 110, "/loli review anything");
        source.observe_policy_feed(
            &source.clone(),
            ThreadFeed::Issue,
            &[other_id, bot, edited, ci, quoted, in_code, suffix],
            None,
            Some(115),
            120,
        );
        assert!(source.reserve_candidates().is_empty());
    }

    #[test]
    fn decisions_persist_before_launch_and_never_replay_from_storage() {
        let mut source = enabled_source();
        source.observe_policy_feed(&source.clone(), ThreadFeed::Issue, &[], None, None, 100);
        let items = [
            item("issue:1", 110, "/loli review"),
            item("issue:2", 110, "/loli review"),
            item("issue:3", 110, "/loli review"),
        ];
        source.observe_policy_feed(
            &source.clone(),
            ThreadFeed::Issue,
            &items,
            None,
            Some(110),
            120,
        );
        assert_eq!(source.reserve_candidates().len(), MAX_AUTO_PER_SYNC);
        assert_eq!(
            source.state.policy.decisions[0].status,
            DecisionStatus::Failed
        );
        let db = Database::memory().unwrap();
        source.save(&db, "lc:secretary").unwrap();
        let mut restored = Source::load(&db, "lc:secretary").unwrap();
        assert_eq!(restored.state.policy.decisions.len(), 3);
        restored.observe_policy_feed(
            &restored.clone(),
            ThreadFeed::Issue,
            &items,
            None,
            Some(110),
            130,
        );
        assert!(restored.reserve_candidates().is_empty());
        restored.disable_policy("已暂停").unwrap();
        assert!(!restored.state.policy.enabled);
        assert!(restored
            .state
            .policy
            .decisions
            .iter()
            .all(|entry| entry.status == DecisionStatus::Failed));
    }
}
