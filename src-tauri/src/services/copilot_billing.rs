//! Official personal Copilot monthly billing. This ledger is deliberately separate
//! from local request estimates: syncing the same month replaces its snapshot.

use crate::{database::Database, error::AppError};
use chrono::{Datelike, Utc};
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};

const REPORTS_KEY: &str = "copilot.billing.reports.v1";
const SOURCE: &str = "github-billing-api";
const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
static LEDGER_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CopilotBillingKind {
    AiCredits,
    PremiumRequests,
}

impl CopilotBillingKind {
    fn endpoint(self) -> &'static str {
        match self {
            Self::AiCredits => "ai_credit",
            Self::PremiumRequests => "premium_request",
        }
    }

    fn accepts_unit(self, unit: &str) -> bool {
        match self {
            Self::AiCredits => matches!(unit, "credits" | "ai-credits"),
            Self::PremiumRequests => unit == "requests",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CopilotBillingItem {
    pub product: String,
    pub sku: String,
    pub model: String,
    pub unit_type: String,
    pub price_per_unit: f64,
    pub gross_quantity: f64,
    pub gross_amount: f64,
    pub discount_quantity: f64,
    pub discount_amount: f64,
    pub net_quantity: f64,
    pub net_amount: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CopilotBillingReport {
    pub account_login: String,
    pub year: i32,
    pub month: u32,
    pub kind: CopilotBillingKind,
    pub fetched_at: i64,
    pub source: String,
    pub items: Vec<CopilotBillingItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BillingResponse {
    time_period: TimePeriod,
    user: String,
    // Filter by product before parsing product-specific billing fields. Other
    // GitHub products do not necessarily have a model or the same quantities.
    usage_items: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct TimePeriod {
    year: i32,
    month: Option<u32>,
}

fn message(text: &str) -> AppError {
    AppError::Message(text.to_owned())
}

pub fn validate_username(username: &str) -> Result<(), AppError> {
    if username.is_empty()
        || username.len() > 39
        || username.starts_with('-')
        || username.ends_with('-')
        || username.contains("--")
        || !username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(message("请输入有效的 GitHub.com 用户名（不是网址或邮箱）"));
    }
    Ok(())
}

pub fn validate_query(username: &str, year: i32, month: u32) -> Result<(), AppError> {
    validate_username(username)?;
    if !(1000..=9999).contains(&year) || !(1..=12).contains(&month) {
        return Err(message("账单年月无效"));
    }
    let now = Utc::now();
    let age = now.year() * 12 + now.month() as i32 - (year * 12 + month as i32);
    if !(0..24).contains(&age) {
        return Err(message(
            "GitHub 官方账单只能同步最近 24 个月，且不能查询未来月份",
        ));
    }
    Ok(())
}

fn validate_item(item: &CopilotBillingItem, kind: CopilotBillingKind) -> Result<(), AppError> {
    if !kind.accepts_unit(&item.unit_type)
        || [
            item.price_per_unit,
            item.gross_quantity,
            item.gross_amount,
            item.discount_quantity,
            item.discount_amount,
            item.net_quantity,
            item.net_amount,
        ]
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err(message(
            "GitHub 账单条目的单位或数值格式无效，本次同步未保存",
        ));
    }
    Ok(())
}

fn is_copilot(product: &str, kind: CopilotBillingKind) -> bool {
    product.eq_ignore_ascii_case("Copilot")
        || product.eq_ignore_ascii_case("GitHub Copilot")
        || (kind == CopilotBillingKind::AiCredits
            && product.eq_ignore_ascii_case("Copilot AI Credits"))
}

fn parse_response(
    bytes: &[u8],
    username: &str,
    year: i32,
    month: u32,
    kind: CopilotBillingKind,
) -> Result<CopilotBillingReport, AppError> {
    // Never include serde errors or the body: a remote service may echo a secret.
    let response: BillingResponse = serde_json::from_slice(bytes)
        .map_err(|_| message("GitHub 账单响应格式无效，本次同步未保存"))?;
    if !response.user.eq_ignore_ascii_case(username)
        || response.time_period.year != year
        || response
            .time_period
            .month
            .is_some_and(|value| value != month)
    {
        return Err(message("GitHub 返回的账单账号或月份不匹配，本次同步未保存"));
    }
    let mut items = Vec::new();
    for raw_item in response.usage_items {
        let product = raw_item
            .get("product")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| message("GitHub 账单产品字段无效，本次同步未保存"))?;
        if !is_copilot(product, kind) {
            // Never silently turn an unfamiliar Copilot schema into zero spend.
            if product.to_ascii_lowercase().contains("copilot") {
                return Err(message(
                    "GitHub 返回了不支持的 Copilot 账单产品，本次同步未保存",
                ));
            }
            continue;
        }
        let item: CopilotBillingItem = serde_json::from_value(raw_item)
            .map_err(|_| message("GitHub 账单条目格式无效，本次同步未保存"))?;
        validate_item(&item, kind)?;
        items.push(item);
    }
    Ok(CopilotBillingReport {
        account_login: response.user,
        year,
        month,
        kind,
        fetched_at: Utc::now().timestamp(),
        source: SOURCE.to_owned(),
        items,
    })
}

fn status_error(status: u16) -> AppError {
    message(match status {
        401 => "GitHub 凭据无效或已过期，请重新登录或提供有效的账单 PAT",
        403 => "GitHub 拒绝读取账单。请使用本人账号的 fine-grained PAT，并开启账号权限 Plan: read（Plan 只读）；Copilot 登录凭据可能没有账单权限",
        404 => "GitHub 未找到个人账单：请确认用户名、个人订阅和凭据的 Plan 只读权限",
        429 => "GitHub 请求过于频繁，请稍后重试",
        500..=599 => "GitHub 账单服务暂时不可用，请稍后重试",
        _ => "GitHub 账单请求失败，请检查账号和账单读取权限",
    })
}

pub async fn fetch_report(
    username: &str,
    token: &str,
    year: i32,
    month: u32,
    kind: CopilotBillingKind,
) -> Result<CopilotBillingReport, AppError> {
    validate_query(username, year, month)?;
    if token.is_empty()
        || token.len() > 4096
        || !token.is_ascii()
        || token
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    {
        return Err(message("GitHub 账单凭据格式无效，请检查是否包含空格或换行"));
    }
    // Do not follow redirects, even to another GitHub host, with this credential.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| message("无法初始化 GitHub 账单连接"))?;
    let url = format!(
        "https://api.github.com/users/{username}/settings/billing/{}/usage",
        kind.endpoint()
    );
    let mut response = client
        .get(url)
        .query(&[("year", year.to_string()), ("month", month.to_string())])
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2026-03-10")
        .header("User-Agent", "LoliCode-Copilot-Billing")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| message("GitHub 账单连接失败或超时，请稍后重试"))?;
    if response.status().as_u16() != 200 {
        return Err(status_error(response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
    {
        return Err(message("GitHub 账单响应过大，本次同步未保存"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| message("GitHub 账单响应读取失败或超时，本次同步未保存"))?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(message("GitHub 账单响应过大，本次同步未保存"));
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_response(&bytes, username, year, month, kind)
}

fn read_reports(db: &Database) -> Result<Vec<CopilotBillingReport>, AppError> {
    let Some(raw) = db.get_setting(REPORTS_KEY)? else {
        return Ok(Vec::new());
    };
    let reports: Vec<CopilotBillingReport> = serde_json::from_str(&raw)
        .map_err(|_| message("本地 Copilot 官方账本格式无效，已保留原数据"))?;
    for report in &reports {
        validate_username(&report.account_login)?;
        if report.source != SOURCE
            || !(1000..=9999).contains(&report.year)
            || !(1..=12).contains(&report.month)
            || report.fetched_at < 0
        {
            return Err(message("本地 Copilot 官方账本格式无效，已保留原数据"));
        }
        for item in &report.items {
            if !is_copilot(&item.product, report.kind) {
                return Err(message("本地 Copilot 官方账本包含其他产品，已保留原数据"));
            }
            validate_item(item, report.kind)?;
        }
    }
    Ok(reports)
}

pub fn list_reports(db: &Database) -> Result<Vec<CopilotBillingReport>, AppError> {
    let _guard = LEDGER_LOCK
        .lock()
        .map_err(|_| message("Copilot 账本暂时忙碌"))?;
    read_reports(db)
}

pub fn save_report(db: &Database, report: CopilotBillingReport) -> Result<(), AppError> {
    let _guard = LEDGER_LOCK
        .lock()
        .map_err(|_| message("Copilot 账本暂时忙碌"))?;
    let mut reports = read_reports(db)?;
    reports.retain(|previous| {
        !(previous
            .account_login
            .eq_ignore_ascii_case(&report.account_login)
            && previous.kind == report.kind
            && previous.year == report.year
            && previous.month == report.month)
    });
    reports.push(report);
    reports.sort_by_key(|report| std::cmp::Reverse((report.year, report.month, report.fetched_at)));
    let raw = serde_json::to_string(&reports).map_err(|_| message("无法保存 Copilot 官方账本"))?;
    db.set_setting(REPORTS_KEY, &raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn body() -> Value {
        json!({"timePeriod":{"year":2026,"month":10},"user":"Alice","usageItems":[{
            "product":"Copilot","sku":"Copilot AI Credits","model":"GPT-5","unitType":"credits",
            "pricePerUnit":0.01,"grossQuantity":100.5,"grossAmount":1.005,
            "discountQuantity":10.5,"discountAmount":0.105,"netQuantity":90,"netAmount":0.9
        }]})
    }

    fn parse(value: Value, kind: CopilotBillingKind) -> Result<CopilotBillingReport, AppError> {
        parse_response(
            &serde_json::to_vec(&value).unwrap(),
            "alice",
            2026,
            10,
            kind,
        )
    }

    #[test]
    fn preserves_official_quantities_and_amounts_without_recalculation() {
        let mut response = body();
        // Deliberately differ from gross minus discount and quantity times price:
        // GitHub's supplied totals, including its adjustments, remain authoritative.
        response["usageItems"][0]["netAmount"] = json!(0.91);
        response["usageItems"][0]["netQuantity"] = json!(88.75);
        let report = parse(response, CopilotBillingKind::AiCredits).unwrap();
        let item = &report.items[0];
        assert_eq!(item.gross_amount, 1.005);
        assert_eq!(item.discount_amount, 0.105);
        assert_eq!(item.net_amount, 0.91);
        assert_eq!(item.gross_quantity, 100.5);
        assert_eq!(item.discount_quantity, 10.5);
        assert_eq!(item.net_quantity, 88.75);
    }

    #[test]
    fn accepts_current_official_personal_ai_credit_product_and_unit() {
        let response = json!({
            "timePeriod": {"year": 2026}, "user": "alice", "usageItems": [{
                "product": "Copilot AI Credits", "sku": "AI Credit", "model": "GPT-5",
                "unitType": "ai-credits", "pricePerUnit": 0.01,
                "grossQuantity": 100, "grossAmount": 1,
                "discountQuantity": 0, "discountAmount": 0,
                "netQuantity": 100, "netAmount": 1
            }]
        });
        let report = parse(response.clone(), CopilotBillingKind::AiCredits).unwrap();
        assert_eq!(report.items.len(), 1);
        assert_eq!(report.items[0].net_amount, 1.0);
        assert_eq!(report.items[0].product, "Copilot AI Credits");
        assert!(parse(response, CopilotBillingKind::PremiumRequests).is_err());
    }

    #[test]
    fn units_cannot_cross_ledgers() {
        assert!(parse(body(), CopilotBillingKind::PremiumRequests).is_err());
        let mut requests = body();
        requests["usageItems"][0]["unitType"] = json!("requests");
        assert!(parse(requests.clone(), CopilotBillingKind::PremiumRequests).is_ok());
        assert!(parse(requests, CopilotBillingKind::AiCredits).is_err());
        let mut ai = body();
        ai["usageItems"][0]["unitType"] = json!("ai-credits");
        assert!(parse(ai, CopilotBillingKind::AiCredits).is_ok());
    }

    #[test]
    fn identity_period_schema_and_numbers_are_checked() {
        for product in [json!(""), json!(null), json!({"name": "Copilot"})] {
            let mut response = body();
            response["usageItems"][0]["product"] = product;
            assert!(parse(response, CopilotBillingKind::AiCredits).is_err());
        }
        for (field, value) in [
            ("user", json!("bob")),
            ("timePeriod", json!({"year":2025,"month":10})),
        ] {
            let mut response = body();
            response[field] = value;
            assert!(parse(response, CopilotBillingKind::AiCredits).is_err());
        }
        let mut wrong_month = body();
        wrong_month["timePeriod"]["month"] = json!(9);
        assert!(parse(wrong_month, CopilotBillingKind::AiCredits).is_err());
        for field in [
            "netAmount",
            "grossAmount",
            "netQuantity",
            "discountAmount",
            "pricePerUnit",
        ] {
            let mut missing = body();
            missing["usageItems"][0]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(parse(missing, CopilotBillingKind::AiCredits).is_err());
            let mut negative = body();
            negative["usageItems"][0][field] = json!(-1);
            assert!(parse(negative, CopilotBillingKind::AiCredits).is_err());
        }
        let mut infinite = parse(body(), CopilotBillingKind::AiCredits)
            .unwrap()
            .items
            .remove(0);
        infinite.net_amount = f64::INFINITY;
        assert!(validate_item(&infinite, CopilotBillingKind::AiCredits).is_err());
    }

    #[test]
    fn empty_items_and_omitted_month_are_valid_but_missing_items_are_not() {
        let mut response = body();
        response["usageItems"] = json!([]);
        response["timePeriod"]
            .as_object_mut()
            .unwrap()
            .remove("month");
        assert!(parse(response.clone(), CopilotBillingKind::AiCredits)
            .unwrap()
            .items
            .is_empty());
        response.as_object_mut().unwrap().remove("usageItems");
        assert!(parse(response, CopilotBillingKind::AiCredits).is_err());
    }

    #[test]
    fn filters_non_copilot_products() {
        let mut response = body();
        response["usageItems"].as_array_mut().unwrap().push(json!({
            "product": "Actions", "sku": "actions_linux", "unitType": "minutes",
            "pricePerUnit": 0.008, "grossQuantity": 1000, "grossAmount": 8,
            "discountQuantity": 0, "discountAmount": 0, "netQuantity": 1000, "netAmount": 8
        }));
        assert_eq!(
            parse(response, CopilotBillingKind::AiCredits)
                .unwrap()
                .items
                .len(),
            1
        );
    }

    #[test]
    fn sync_replaces_exact_month_and_preserves_accounts_kinds_and_history() {
        let db = Database::memory().unwrap();
        let mut report = parse(body(), CopilotBillingKind::AiCredits).unwrap();
        save_report(&db, report.clone()).unwrap();
        report.account_login = "alice".into();
        report.items[0].net_amount = 2.5;
        save_report(&db, report.clone()).unwrap();
        assert_eq!(list_reports(&db).unwrap().len(), 1);
        assert_eq!(list_reports(&db).unwrap()[0].items[0].net_amount, 2.5);
        report.account_login = "bob".into();
        save_report(&db, report.clone()).unwrap();
        report.month = 9;
        save_report(&db, report.clone()).unwrap();
        report.year = 2020;
        save_report(&db, report.clone()).unwrap();
        report.kind = CopilotBillingKind::PremiumRequests;
        report.items[0].unit_type = "requests".into();
        save_report(&db, report).unwrap();
        assert_eq!(list_reports(&db).unwrap().len(), 5);
        assert!(db
            .get_setting(REPORTS_KEY)
            .unwrap()
            .unwrap()
            .contains(SOURCE));
    }

    #[test]
    fn rejects_unsafe_queries_and_keeps_errors_free_of_remote_body() {
        for name in [
            "",
            "a/b",
            "https://github.com/alice",
            "a?x=1",
            "a\n",
            "-alice",
            "a--b",
        ] {
            assert!(validate_username(name).is_err());
        }
        assert!(validate_username("alice-123").is_ok());
        assert!(validate_query("alice", 2026, 13).is_err());
        assert!(validate_query("alice", 9999, 1).is_err());
        let secret = b"{\"message\":\"github_pat_secret\"}";
        let error =
            parse_response(secret, "alice", 2026, 10, CopilotBillingKind::AiCredits).unwrap_err();
        assert!(!error.to_string().contains("github_pat_secret"));
        assert!(status_error(403).to_string().contains("Plan"));
    }
}
