//! Local estimates from upstream usage. Monetary values never pass through floating point.
use crate::{Channel, Result, SafeError, Store};
use chrono::{DateTime, FixedOffset};
use rusqlite::{params, OptionalExtension};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    str::FromStr,
    sync::atomic::Ordering,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSettings {
    pub model: String,
    pub billing_mode: String,
    pub input_cost_per_million: Option<String>,
    pub output_cost_per_million: Option<String>,
    pub cache_read_cost_per_million: Option<String>,
    pub cache_creation_cost_per_million: Option<String>,
    pub quota_type: String,
    pub quota_total: String,
    pub quota_period: String,
    #[serde(default)]
    pub quota_used: Option<String>,
}
impl ModelSettings {
    pub fn default_for(_c: &Channel, model: &str) -> Self {
        Self {
            model: model.into(),
            billing_mode: "metered".into(),
            input_cost_per_million: None,
            output_cost_per_million: None,
            cache_read_cost_per_million: None,
            cache_creation_cost_per_million: None,
            quota_type: "tokens".into(),
            quota_total: "0".into(),
            quota_period: "once".into(),
            quota_used: None,
        }
    }
    fn validate(&mut self) -> Result<()> {
        if !["metered", "free", "quota"].contains(&self.billing_mode.as_str())
            || !["tokens", "usd", "requests"].contains(&self.quota_type.as_str())
            || !["once", "daily", "monthly"].contains(&self.quota_period.as_str())
        {
            return Err(SafeError::invalid("无效的计费或额度类型。"));
        }
        for price in [
            &mut self.input_cost_per_million,
            &mut self.output_cost_per_million,
            &mut self.cache_read_cost_per_million,
            &mut self.cache_creation_cost_per_million,
        ]
        .into_iter()
        .flatten()
        {
            *price = parse_amount(price, 1_000_000)?.normalize().to_string();
        }
        let total = parse_amount(&self.quota_total, 1_000_000_000_000)?;
        if self.quota_type != "usd" && !total.fract().is_zero() {
            return Err(SafeError::invalid("Token 和请求次数额度必须为整数。"));
        }
        self.quota_total = total.normalize().to_string();
        self.quota_used = None; // Derived ledger value, never trust a client supplied counter.
        Ok(())
    }
}
fn parse_amount(s: &str, limit: u64) -> Result<Decimal> {
    if s.len() > 40 || s.is_empty() || s.chars().any(|c| !c.is_ascii_digit() && c != '.') {
        return Err(SafeError::invalid("金额和额度应为非负十进制数字。"));
    }
    let d = Decimal::from_str(s).map_err(|_| SafeError::invalid("金额或额度格式不正确。"))?;
    if d < Decimal::ZERO || d > Decimal::from(limit) || d.scale() > 12 {
        return Err(SafeError::invalid(
            "金额或额度超出范围，最多支持 12 位小数。",
        ));
    }
    Ok(d)
}
pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
pub(crate) fn period_key(period: &str, timestamp: i64) -> String {
    if period == "once" {
        return "once".into();
    }
    let dt = DateTime::from_timestamp(timestamp, 0)
        .unwrap_or_default()
        .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap());
    dt.format(if period == "daily" {
        "%Y-%m-%d"
    } else {
        "%Y-%m"
    })
    .to_string()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}
impl Usage {
    pub fn parse(value: &Value) -> Option<Self> {
        let u = value.get("usage")?;
        let input = u
            .get("prompt_tokens")
            .or_else(|| u.get("input_tokens"))?
            .as_u64()?;
        let output = u
            .get("completion_tokens")
            .or_else(|| u.get("output_tokens"))?
            .as_u64()?;
        let first_nonzero = |paths: &[&str]| {
            paths
                .iter()
                .filter_map(|p| u.pointer(p).and_then(Value::as_u64))
                .find(|n| *n > 0)
                .unwrap_or(0)
        };
        let read = first_nonzero(&[
            "/cache_read_input_tokens",
            "/prompt_tokens_details/cached_tokens",
            "/input_tokens_details/cached_tokens",
            "/prompt_cache_hit_tokens",
        ]);
        let write = first_nonzero(&[
            "/cache_creation_input_tokens",
            "/prompt_tokens_details/cache_write_tokens",
            "/input_tokens_details/cache_write_tokens",
        ]);
        if input > 1_000_000_000 || output > 1_000_000_000 || read.checked_add(write)? > input {
            return None;
        }
        Some(Self {
            input: input - read - write,
            output,
            cache_read: read,
            cache_creation: write,
        })
    }
    pub fn total(self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_creation
    }
    fn gross(self, config: &ModelSettings) -> Option<Decimal> {
        let mut sum = Decimal::ZERO;
        for (tokens, price) in [
            (self.input, &config.input_cost_per_million),
            (self.output, &config.output_cost_per_million),
            (self.cache_read, &config.cache_read_cost_per_million),
            (self.cache_creation, &config.cache_creation_cost_per_million),
        ] {
            if tokens > 0 {
                sum += Decimal::from(tokens) * Decimal::from_str(price.as_deref()?).ok()?
                    / Decimal::from(1_000_000u64);
            }
        }
        Some(sum)
    }
}
#[derive(Clone)]
pub(crate) struct BillingSnapshot {
    pub config: ModelSettings,
    pub revision: i64,
    pub period: String,
}
pub(crate) struct RequestAccounting<'a> {
    pub channel: &'a Channel,
    pub status: u16,
    pub duration_ms: u64,
    pub result: &'a str,
    pub streaming: bool,
    pub usage: Option<Usage>,
    pub snapshot: &'a BillingSnapshot,
}
struct Cost {
    gross: Option<Decimal>,
    discount: Option<Decimal>,
    billable: Option<Decimal>,
    consumed: Decimal,
    status: &'static str,
}
fn calculate(config: &ModelSettings, usage: Option<Usage>, completed: bool, used: Decimal) -> Cost {
    let gross = usage.and_then(|u| u.gross(config));
    let mut cost = Cost {
        gross,
        discount: gross.map(|_| Decimal::ZERO),
        billable: gross,
        consumed: Decimal::ZERO,
        status: if usage.is_none() {
            "unreported"
        } else if gross.is_none() {
            "unpriced"
        } else {
            "estimated"
        },
    };
    if config.billing_mode == "free" {
        cost.discount = gross;
        cost.billable = Some(Decimal::ZERO);
        cost.status = "free";
    } else if config.billing_mode == "quota" {
        let remaining =
            (Decimal::from_str(&config.quota_total).unwrap_or_default() - used).max(Decimal::ZERO);
        let requested = match config.quota_type.as_str() {
            "usd" => gross,
            "requests" if completed => Some(Decimal::ONE),
            "tokens" => usage.map(|u| Decimal::from(u.total())),
            _ => None,
        };
        if let Some(requested) = requested {
            cost.consumed = remaining.min(requested);
            if requested.is_zero() || cost.consumed == requested {
                cost.discount = gross;
                cost.billable = Some(Decimal::ZERO);
                cost.status = "quota";
            } else if let Some(gross) = gross {
                let discount = if config.quota_type == "usd" {
                    cost.consumed
                } else {
                    gross * cost.consumed / requested
                };
                cost.discount = Some(discount);
                cost.billable = Some(gross - discount);
                cost.status = "estimated";
            }
        }
    }
    if !completed && cost.billable.is_some() && config.billing_mode != "free" {
        cost.status = "partial_estimate";
    }
    cost
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    pub date: String,
    pub requests: u64,
    pub tokens: u64,
    pub billable_cost_usd: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_requests: u64,
    pub failed_requests: u64,
    pub unknown_cost_requests: u64,
    pub unknown_usage_requests: u64,
    pub unknown_gross_cost_requests: u64,
    pub unknown_discount_requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub gross_cost_usd: String,
    pub free_discount_usd: String,
    pub billable_cost_usd: String,
    pub currency: &'static str,
    pub daily: Vec<DailyUsage>,
}

impl Store {
    pub fn model_settings(&self, channel_id: &str) -> Result<Vec<ModelSettings>> {
        let c = self
            .channels()?
            .into_iter()
            .find(|c| c.id == channel_id)
            .ok_or_else(|| SafeError::invalid("渠道不存在。"))?;
        let db = self.db.lock().map_err(|_| SafeError::storage())?;
        c.models
            .iter()
            .map(|model| {
                let (mut config, revision) = read_settings(&db, &c, model)?;
                config.quota_used = Some(
                    read_used(
                        &db,
                        channel_id,
                        model,
                        revision,
                        &period_key(&config.quota_period, now()),
                    )?
                    .normalize()
                    .to_string(),
                );
                Ok(config)
            })
            .collect()
    }
    pub fn save_model_settings(
        &self,
        channel_id: &str,
        mut settings: Vec<ModelSettings>,
    ) -> Result<()> {
        let _update = self.updates.lock().map_err(|_| SafeError::storage())?;
        let c = self
            .channels()?
            .into_iter()
            .find(|c| c.id == channel_id)
            .ok_or_else(|| SafeError::invalid("渠道不存在。"))?;
        let mut seen = std::collections::HashSet::new();
        for s in &mut settings {
            if !c.models.contains(&s.model) || !seen.insert(s.model.clone()) {
                return Err(SafeError::invalid("价格设置包含重复或未配置的模型。"));
            }
            s.validate()?;
        }
        let mut db = self.db.lock().map_err(|_| SafeError::storage())?;
        let tx = db.transaction().map_err(|_| SafeError::storage())?;
        for s in settings {
            let (old, revision) = read_settings(&tx, &c, &s.model)?;
            // Total and price edits preserve consumption. Unit/period/mode changes create a new allowance.
            let revision = revision
                + i64::from(
                    old.quota_type != s.quota_type
                        || old.quota_period != s.quota_period
                        || old.billing_mode != s.billing_mode,
                );
            let config = serde_json::to_string(&s).map_err(|_| SafeError::storage())?;
            tx.execute("INSERT INTO model_settings(channel_id,model,config,revision) VALUES (?1,?2,?3,?4) ON CONFLICT(channel_id,model) DO UPDATE SET config=excluded.config,revision=excluded.revision", params![channel_id,s.model,config,revision]).map_err(|_|SafeError::storage())?;
        }
        tx.commit().map_err(|_| SafeError::storage())
    }
    pub(crate) fn billing_snapshot(&self, c: &Channel) -> Result<BillingSnapshot> {
        let db = self.db.lock().map_err(|_| SafeError::storage())?;
        let (config, revision) = read_settings(&db, c, &c.model)?;
        let period = period_key(&config.quota_period, now());
        Ok(BillingSnapshot {
            config,
            revision,
            period,
        })
    }
    pub(crate) fn record_accounting(&self, a: RequestAccounting<'_>) {
        if self.write_accounting(a).is_err() {
            self.billing_fault.store(true, Ordering::SeqCst);
        }
    }
    fn write_accounting(&self, a: RequestAccounting<'_>) -> Result<()> {
        let mut db = self.db.lock().map_err(|_| SafeError::storage())?;
        let tx = db.transaction().map_err(|_| SafeError::storage())?;
        let snap = a.snapshot;
        let used = read_used(
            &tx,
            &a.channel.id,
            &a.channel.model,
            snap.revision,
            &snap.period,
        )?;
        let cost = calculate(&snap.config, a.usage, a.result == "completed", used);
        if cost.consumed > Decimal::ZERO {
            tx.execute("INSERT INTO quota_ledger(channel_id,model,revision,period,used) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(channel_id,model,revision,period) DO UPDATE SET used=excluded.used",params![a.channel.id,a.channel.model,snap.revision,snap.period,(used+cost.consumed).normalize().to_string()]).map_err(|_|SafeError::storage())?;
        }
        let money = |d: Option<Decimal>| d.map(|x| x.normalize().to_string());
        tx.execute("INSERT INTO requests(timestamp,channel_id,model,status,duration_ms,result,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,gross_cost_usd,free_discount_usd,billable_cost_usd,billing_status,is_streaming) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",params![now(),a.channel.id,a.channel.model,a.status,a.duration_ms,a.result,a.usage.map(|u|u.input),a.usage.map(|u|u.output),a.usage.map(|u|u.cache_read),a.usage.map(|u|u.cache_creation),money(cost.gross),money(cost.discount),money(cost.billable),cost.status,a.streaming]).map_err(|_|SafeError::storage())?;
        tx.execute(
            "DELETE FROM requests WHERE timestamp < ?1",
            [now() - 30 * 86400],
        )
        .map_err(|_| SafeError::storage())?;
        tx.commit().map_err(|_| SafeError::storage())
    }
    pub fn usage_summary(&self) -> Result<UsageSummary> {
        if self.billing_fault.load(Ordering::SeqCst) {
            return Err(SafeError::new(
                500,
                "billing_storage_error",
                "部分调用账本写入失败，统计可能不完整，请检查磁盘后重启。",
            ));
        }
        let db = self.db.lock().map_err(|_| SafeError::storage())?;
        let mut q = db.prepare("SELECT timestamp,status,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,gross_cost_usd,free_discount_usd,billable_cost_usd FROM requests WHERE timestamp>=?1 ORDER BY id").map_err(|_|SafeError::storage())?;
        let rows = q
            .query_map([now() - 30 * 86400], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, u16>(1)?,
                    r.get::<_, Option<u64>>(2)?,
                    r.get::<_, Option<u64>>(3)?,
                    r.get::<_, Option<u64>>(4)?,
                    r.get::<_, Option<u64>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                ))
            })
            .map_err(|_| SafeError::storage())?;
        let mut summary = UsageSummary {
            total_requests: 0,
            failed_requests: 0,
            unknown_cost_requests: 0,
            unknown_usage_requests: 0,
            unknown_gross_cost_requests: 0,
            unknown_discount_requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            gross_cost_usd: "0".into(),
            free_discount_usd: "0".into(),
            billable_cost_usd: "0".into(),
            currency: "USD",
            daily: vec![],
        };
        let (mut gross, mut discount, mut billable) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
        let mut daily = BTreeMap::<String, (u64, u64, Decimal)>::new();
        for row in rows {
            let (time, status, input, output, read, write, g, d, b) =
                row.map_err(|_| SafeError::storage())?;
            let dec = |s: Option<String>| {
                s.and_then(|s| Decimal::from_str(&s).ok())
                    .unwrap_or_default()
            };
            summary.total_requests += 1;
            summary.failed_requests += u64::from(status != 200);
            summary.unknown_cost_requests += u64::from(b.is_none());
            summary.unknown_usage_requests += u64::from(input.is_none() || output.is_none());
            summary.unknown_gross_cost_requests += u64::from(g.is_none());
            summary.unknown_discount_requests += u64::from(d.is_none());
            summary.input_tokens += input.unwrap_or(0);
            summary.output_tokens += output.unwrap_or(0);
            summary.cache_read_tokens += read.unwrap_or(0);
            summary.cache_creation_tokens += write.unwrap_or(0);
            gross += dec(g);
            discount += dec(d);
            let b = dec(b);
            billable += b;
            let day = daily.entry(period_key("daily", time)).or_default();
            day.0 += 1;
            day.1 +=
                input.unwrap_or(0) + output.unwrap_or(0) + read.unwrap_or(0) + write.unwrap_or(0);
            day.2 += b;
        }
        summary.gross_cost_usd = gross.normalize().to_string();
        summary.free_discount_usd = discount.normalize().to_string();
        summary.billable_cost_usd = billable.normalize().to_string();
        summary.daily = daily
            .into_iter()
            .map(|(date, (requests, tokens, b))| DailyUsage {
                date,
                requests,
                tokens,
                billable_cost_usd: b.normalize().to_string(),
            })
            .collect();
        Ok(summary)
    }
}
fn read_settings(
    db: &rusqlite::Connection,
    c: &Channel,
    model: &str,
) -> Result<(ModelSettings, i64)> {
    let row: Option<(String, i64)> = db
        .query_row(
            "SELECT config,revision FROM model_settings WHERE channel_id=?1 AND model=?2",
            params![c.id, model],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| SafeError::storage())?;
    match row {
        Some((s, revision)) => Ok((
            serde_json::from_str(&s).map_err(|_| SafeError::storage())?,
            revision,
        )),
        None => Ok((ModelSettings::default_for(c, model), 0)),
    }
}
fn read_used(
    db: &rusqlite::Connection,
    channel: &str,
    model: &str,
    revision: i64,
    period: &str,
) -> Result<Decimal> {
    let s:Option<String> = db.query_row("SELECT used FROM quota_ledger WHERE channel_id=?1 AND model=?2 AND revision=?3 AND period=?4",params![channel,model,revision,period],|r|r.get(0)).optional().map_err(|_|SafeError::storage())?;
    match s {
        Some(s) => Decimal::from_str(&s).map_err(|_| SafeError::storage()),
        None => Ok(Decimal::ZERO),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::memory::MemoryCredentials;
    use serde_json::json;
    use std::sync::Arc;

    fn config() -> ModelSettings {
        ModelSettings {
            model: "test-model".into(),
            billing_mode: "metered".into(),
            input_cost_per_million: Some("2".into()),
            output_cost_per_million: Some("6".into()),
            cache_read_cost_per_million: Some("0.5".into()),
            cache_creation_cost_per_million: Some("3".into()),
            quota_type: "tokens".into(),
            quota_total: "0".into(),
            quota_period: "once".into(),
            quota_used: None,
        }
    }
    fn record(store: &Store, c: &Channel, s: &BillingSnapshot, u: Option<Usage>) {
        store.record_accounting(RequestAccounting {
            channel: c,
            status: 200,
            duration_ms: 1,
            result: "completed",
            streaming: false,
            usage: u,
            snapshot: s,
        });
    }
    fn decimal(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }
    #[test]
    fn cache_usage_and_decimal_prices_do_not_double_count() {
        let usage=Usage::parse(&json!({"usage":{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":400,"cache_write_tokens":100},"cache_read_input_tokens":0}})).unwrap();
        assert_eq!(
            usage,
            Usage {
                input: 500,
                output: 200,
                cache_read: 400,
                cache_creation: 100
            }
        );
        assert_eq!(usage.gross(&config()).unwrap(), decimal("0.0027"));
        assert!(Usage::parse(
            &json!({"usage":{"prompt_tokens":5,"completion_tokens":1,"cache_read_input_tokens":6}})
        )
        .is_none());
        assert!(Usage::parse(&json!({"usage":{"prompt_tokens":5}})).is_none());
    }
    #[test]
    fn quota_boundary_and_unpriced_calls_are_explicit() {
        let mut c = config();
        c.billing_mode = "quota".into();
        c.quota_total = "600".into();
        let u = Usage {
            input: 1000,
            output: 200,
            cache_read: 0,
            cache_creation: 0,
        };
        let cost = calculate(&c, Some(u), true, Decimal::ZERO);
        assert_eq!(cost.gross, Some(decimal("0.0032")));
        assert_eq!(cost.discount, Some(decimal("0.0016")));
        assert_eq!(cost.billable, Some(decimal("0.0016")));
        c.input_cost_per_million = None;
        let cost = calculate(&c, Some(u), true, Decimal::ZERO);
        assert!(cost.billable.is_none());
        assert_eq!(cost.consumed, decimal("600"));
        c.quota_total = "1200".into();
        assert_eq!(
            calculate(&c, Some(u), true, Decimal::ZERO).billable,
            Some(Decimal::ZERO)
        );
        assert!(calculate(&c, None, true, Decimal::ZERO).billable.is_none());
        c.billing_mode = "free".into();
        assert_eq!(
            calculate(&c, None, true, Decimal::ZERO).billable,
            Some(Decimal::ZERO)
        );
    }
    #[test]
    fn usd_and_request_quotas_and_failures() {
        let mut c = config();
        c.billing_mode = "quota".into();
        c.quota_type = "usd".into();
        c.quota_total = "0.001".into();
        let u = Usage {
            input: 1000,
            output: 0,
            cache_read: 0,
            cache_creation: 0,
        };
        let cost = calculate(&c, Some(u), true, Decimal::ZERO);
        assert_eq!(cost.billable, Some(decimal("0.001")));
        c.quota_type = "requests".into();
        c.quota_total = "1".into();
        assert_eq!(
            calculate(&c, None, true, Decimal::ZERO).billable,
            Some(Decimal::ZERO)
        );
        let failed = calculate(&c, None, false, Decimal::ZERO);
        assert!(failed.billable.is_none());
        assert_eq!(failed.consumed, Decimal::ZERO);
        let exhausted = calculate(&c, Some(u), true, Decimal::ONE);
        assert_eq!(exhausted.billable, Some(decimal("0.002")));
    }
    #[test]
    fn periods_are_stable_at_utc8_boundary() {
        let time = DateTime::parse_from_rfc3339("2026-10-31T16:00:00Z")
            .unwrap()
            .timestamp();
        assert_eq!(period_key("daily", time - 1), "2026-10-31");
        assert_eq!(period_key("daily", time), "2026-11-01");
        assert_eq!(period_key("monthly", time), "2026-11");
        assert_eq!(period_key("once", time), "once");
    }
    #[test]
    fn invalid_prices_and_non_integer_quotas_are_rejected() {
        for value in ["-1", "NaN", "1e3", "1.0000000000001", "1000001"] {
            let mut c = config();
            c.input_cost_per_million = Some(value.into());
            assert!(c.validate().is_err());
        }
        let mut c = config();
        c.quota_total = "1.5".into();
        assert!(c.validate().is_err());
        c.quota_type = "usd".into();
        assert!(c.validate().is_ok());
    }
    #[test]
    fn atomic_concurrent_consumption_survives_restart_and_price_edits() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = Arc::new(MemoryCredentials::default());
        let store = Store::open(dir.path(), credentials.clone()).unwrap();
        let c = store.test_channel("http://127.0.0.1:1/v1".into(), "fixture-billing-key");
        let mut settings = config();
        settings.billing_mode = "quota".into();
        settings.quota_total = "5".into();
        settings.quota_type = "requests".into();
        store
            .save_model_settings(&c.id, vec![settings.clone()])
            .unwrap();
        let snapshot = store.billing_snapshot(&c).unwrap();
        let handles: Vec<_> = (0..20)
            .map(|_| {
                let store = store.clone();
                let c = c.clone();
                let s = snapshot.clone();
                std::thread::spawn(move || {
                    record(
                        &store,
                        &c,
                        &s,
                        Some(Usage {
                            input: 1000,
                            output: 0,
                            cache_read: 0,
                            cache_creation: 0,
                        }),
                    )
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(store.usage_summary().unwrap().billable_cost_usd, "0.03");
        assert_eq!(
            store.model_settings(&c.id).unwrap()[0]
                .quota_used
                .as_deref(),
            Some("5")
        );
        settings.input_cost_per_million = Some("4".into());
        settings.quota_total = "6".into();
        store.save_model_settings(&c.id, vec![settings]).unwrap();
        assert_eq!(
            store.model_settings(&c.id).unwrap()[0]
                .quota_used
                .as_deref(),
            Some("5")
        );
        drop(store);
        let store = Store::open(dir.path(), credentials).unwrap();
        assert_eq!(store.usage_summary().unwrap().billable_cost_usd, "0.03");
        let fresh = store.billing_snapshot(&c).unwrap();
        record(
            &store,
            &c,
            &fresh,
            Some(Usage {
                input: 1000,
                output: 0,
                cache_read: 0,
                cache_creation: 0,
            }),
        );
        assert_eq!(store.usage_summary().unwrap().billable_cost_usd, "0.03");
        assert_eq!(
            store.model_settings(&c.id).unwrap()[0]
                .quota_used
                .as_deref(),
            Some("6")
        );
    }
    #[test]
    fn snapshots_unknown_usage_and_ledger_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), Arc::new(MemoryCredentials::default())).unwrap();
        let c = store.test_channel("http://127.0.0.1:1/v1".into(), "fixture-billing-key");
        store.save_model_settings(&c.id, vec![config()]).unwrap();
        let old = store.billing_snapshot(&c).unwrap();
        let mut edited = config();
        edited.input_cost_per_million = Some("20".into());
        store.save_model_settings(&c.id, vec![edited]).unwrap();
        record(
            &store,
            &c,
            &old,
            Some(Usage {
                input: 1000,
                output: 0,
                cache_read: 0,
                cache_creation: 0,
            }),
        );
        record(&store, &c, &old, None);
        let summary = store.usage_summary().unwrap();
        assert_eq!(summary.billable_cost_usd, "0.002");
        assert_eq!(summary.unknown_cost_requests, 1);
        assert_eq!(summary.unknown_usage_requests, 1);
        let mut free = config();
        free.billing_mode = "free".into();
        store.save_model_settings(&c.id, vec![free]).unwrap();
        record(&store, &c, &store.billing_snapshot(&c).unwrap(), None);
        let summary = store.usage_summary().unwrap();
        assert_eq!(summary.unknown_cost_requests, 1);
        assert_eq!(summary.unknown_usage_requests, 2);
        assert_eq!(store.logs().unwrap()[0].input_tokens, None);
        store.delete_channel(&c.id).unwrap();
        assert_eq!(store.usage_summary().unwrap().total_requests, 3);
    }
    #[test]
    fn legacy_database_migration_keeps_model_and_unknown_cost() {
        let dir = tempfile::tempdir().unwrap();
        let db = rusqlite::Connection::open(dir.path().join("freehub.db")).unwrap();
        db.execute_batch("CREATE TABLE channels (id TEXT PRIMARY KEY,name TEXT,provider_id TEXT,base_url TEXT,model TEXT,enabled INTEGER,confirmed_free INTEGER);CREATE TABLE requests (id INTEGER PRIMARY KEY,timestamp INTEGER,channel_id TEXT,model TEXT,status INTEGER,duration_ms INTEGER,result TEXT); INSERT INTO channels VALUES('legacy','old','test','https://example.com/v1','old-model',1,1);").unwrap();
        db.execute(
            "INSERT INTO requests VALUES(1,?1,'legacy','old-model',200,1,'completed')",
            [now()],
        )
        .unwrap();
        drop(db);
        let store = Store::open(dir.path(), Arc::new(MemoryCredentials::default())).unwrap();
        assert_eq!(store.channels().unwrap()[0].models, vec!["old-model"]);
        assert_eq!(
            store.model_settings("legacy").unwrap()[0].billing_mode,
            "free"
        );
        assert_eq!(store.logs().unwrap()[0].billing_status, "legacy");
        assert_eq!(store.usage_summary().unwrap().unknown_cost_requests, 1);
        let edited = store
            .save_channel(crate::SaveChannel {
                id: Some("legacy".into()),
                name: "old".into(),
                provider_id: "test".into(),
                base_url: "https://example.com/v1".into(),
                model: "old-model".into(),
                models: vec!["old-model".into(), "paid-new-model".into()],
                enabled: true,
                confirmed_free: true,
                api_key: Some("fixture-migration-key".into()),
            })
            .unwrap();
        let settings = store.model_settings(&edited.id).unwrap();
        assert_eq!(settings[0].billing_mode, "free");
        assert_eq!(settings[1].billing_mode, "metered");
    }
}
