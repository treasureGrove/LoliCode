//! Cancellation and account authorization deadlines shared by transport workers.
//! This module has no desktop host or socket dependency.
use super::crypto::now;
use std::time::Duration;
use tokio::sync::mpsc;

pub(super) enum Control {
    Approved,
    Revoke,
    Stop,
}

#[cfg(test)]
pub(super) async fn fence_text_work<F>(
    work: F,
    teardown: tokio::sync::watch::Receiver<u64>,
    expires: u64,
    controls: &mut mpsc::Receiver<Control>,
) -> Result<(), String>
where
    F: std::future::Future<Output = Result<(), String>>,
{
    let (_deadline_tx, deadline_rx) = tokio::sync::watch::channel(expires);
    fence_authorized_work(work, teardown, deadline_rx, controls).await
}
pub(super) async fn fence_authorized_work<F>(
    work: F,
    mut teardown: tokio::sync::watch::Receiver<u64>,
    mut authorization: tokio::sync::watch::Receiver<u64>,
    controls: &mut mpsc::Receiver<Control>,
) -> Result<(), String>
where
    F: std::future::Future<Output = Result<(), String>>,
{
    let mut work = Box::pin(work);
    loop {
        let expires = *authorization.borrow();
        tokio::select! {
            biased;
            _ = teardown.changed() => return Ok(()),
            changed = authorization.changed() => { if changed.is_err() { return Err("账号认证已关闭".into()); } continue; },
            _ = tokio::time::sleep(Duration::from_millis(expires.saturating_sub(now()))) => return Err("账号设备认证已到期，连接已关闭".into()),
            control = controls.recv() => match control {
                Some(Control::Approved) => continue,
                Some(Control::Stop | Control::Revoke) | None => return Ok(()),
            },
            result = &mut work => return result,
        }
    }
}
