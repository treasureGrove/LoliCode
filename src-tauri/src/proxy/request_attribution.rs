use http::{header, HeaderMap, HeaderValue};

pub(crate) const CLIENT_NAME: &str = "LoliCode";
pub(crate) const CLIENT_HEADER: &str = "x-lolicode-client";
pub(crate) const USER_AGENT: &str = concat!(
    "LoliCode/",
    env!("CARGO_PKG_VERSION"),
    " (+https://lolicode.com)"
);

const APP_URL: &str = "https://lolicode.com";
const OPENROUTER_CATEGORIES: &str = "programming-app,cli-agent";

/// Apply defaults after user overrides so either OpenRouter title spelling can win.
pub(super) fn apply_request_attribution(headers: &mut HeaderMap, upstream_host: Option<&str>) {
    headers
        .entry(CLIENT_HEADER)
        .or_insert(HeaderValue::from_static(CLIENT_NAME));

    let Some(host) = upstream_host.map(str::to_ascii_lowercase) else {
        return;
    };
    if host != "openrouter.ai" && !host.ends_with(".openrouter.ai") {
        return;
    }

    if !headers.contains_key("http-referer") {
        let referer = headers
            .get(header::REFERER)
            .cloned()
            .unwrap_or_else(|| HeaderValue::from_static(APP_URL));
        headers.insert("http-referer", referer);
    }
    if !headers.contains_key("x-openrouter-title") && !headers.contains_key("x-title") {
        headers.insert("x-openrouter-title", HeaderValue::from_static(CLIENT_NAME));
        headers.insert("x-title", HeaderValue::from_static(CLIENT_NAME));
    }
    headers
        .entry("x-openrouter-categories")
        .or_insert(HeaderValue::from_static(OPENROUTER_CATEGORIES));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openrouter_defaults_apply_to_the_provider_domain_only() {
        for host in ["openrouter.ai", "api.OPENROUTER.AI"] {
            let mut headers = HeaderMap::new();
            apply_request_attribution(&mut headers, Some(host));
            assert_eq!(headers[CLIENT_HEADER], CLIENT_NAME);
            assert_eq!(headers["http-referer"], APP_URL);
            assert_eq!(headers["x-openrouter-title"], CLIENT_NAME);
            assert_eq!(headers["x-title"], CLIENT_NAME);
            assert_eq!(headers["x-openrouter-categories"], OPENROUTER_CATEGORIES);
        }
        for host in [
            None,
            Some("notopenrouter.ai"),
            Some("openrouter.ai.example.com"),
        ] {
            let mut headers = HeaderMap::new();
            apply_request_attribution(&mut headers, host);
            assert_eq!(headers[CLIENT_HEADER], CLIENT_NAME);
            assert!(!headers.contains_key("http-referer"));
            assert!(!headers.contains_key("x-openrouter-title"));
            assert!(!headers.contains_key("x-openrouter-categories"));
        }
    }

    #[test]
    fn explicit_app_identity_wins_including_legacy_aliases() {
        let mut headers = HeaderMap::new();
        headers.insert(CLIENT_HEADER, HeaderValue::from_static("custom-client"));
        headers.insert(
            header::REFERER,
            HeaderValue::from_static("https://custom.example"),
        );
        headers.insert("x-title", HeaderValue::from_static("Custom App"));
        headers.insert(
            "x-openrouter-categories",
            HeaderValue::from_static("cloud-agent"),
        );
        apply_request_attribution(&mut headers, Some("openrouter.ai"));
        assert_eq!(headers[CLIENT_HEADER], "custom-client");
        assert_eq!(headers["http-referer"], "https://custom.example");
        assert_eq!(headers["x-title"], "Custom App");
        assert!(!headers.contains_key("x-openrouter-title"));
        assert_eq!(headers["x-openrouter-categories"], "cloud-agent");
    }
}
