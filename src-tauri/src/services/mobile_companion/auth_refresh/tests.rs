use super::*;

#[test]
fn renewal_accepts_only_matching_tls_ack_and_never_unsolicited_deadline() {
    let expiry = now() + 60_000;
    let mut auth = AuthRefresh::new(true);
    assert!(auth
        .accept(&json!({"type":"auth.renewed","v":1,"requestId":"unsolicited","expiresAt":expiry}))
        .is_err());
    let request = auth
        .request("test-ticket-not-a-credential", expiry)
        .unwrap()
        .unwrap();
    assert!(auth
        .request("test-ticket-not-a-credential", expiry)
        .unwrap()
        .is_none());
    let mut ack =
        json!({"type":"auth.renewed","v":1,"requestId":request["requestId"],"expiresAt":expiry+1});
    assert!(auth.accept(&ack).is_err());
    assert!(auth.take_renewed().is_none());
    ack["expiresAt"] = json!(expiry);
    auth.accept(&ack).unwrap();
    assert_eq!(auth.take_renewed(), Some(expiry));
    assert!(auth.accept(&ack).is_err());
    assert!(AuthRefresh::new(false)
        .request("test-ticket-not-a-credential", expiry)
        .unwrap()
        .is_none());
}
