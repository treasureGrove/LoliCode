use super::*;

#[test]
fn external_url_whitelist() {
    assert_eq!(
        validate_external_url("https://example.com/a").unwrap(),
        "https://example.com/a"
    );
    assert!(validate_external_url("http://localhost:3000").is_ok());
    assert!(validate_external_url("mailto:a@example.com").is_ok());
    assert_eq!(
        validate_external_url("example.com/docs").unwrap(),
        "https://example.com/docs"
    );
    for bad in [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        " javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,<script>alert(1)</script>",
        "vscode://open",
        "https://",
        "",
    ] {
        assert!(validate_external_url(bad).is_err(), "{bad}");
    }
}
