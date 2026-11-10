//! Bounded ownership of quiescent SDK processes between ordinary turns.
//!
//! An idle worker owns both the client and its event receiver. The desktop
//! cache contains only a single-use handoff capability, so checkout and
//! expiration can never give the same process to two turns.
use crate::services::harness_runtime::{HarnessClient, HarnessEvent};
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    pin::Pin,
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::{sleep_until, Instant},
};

pub(super) const IDLE_TTL: Duration = Duration::from_secs(10 * 60);
pub(super) const MAX_LIFETIME: Duration = Duration::from_secs(55 * 60);
pub(super) const MAX_IDLE: usize = 3;

pub(super) struct WarmRuntime {
    pub(super) client: HarnessClient,
    pub(super) events: mpsc::Receiver<HarnessEvent>,
    /// Preserve the first process start across every subsequent handoff.
    pub(super) born_at: Instant,
    pub(super) fingerprint: String,
    /// False for a background boot that has not created an Agent yet.
    pub(super) configured: bool,
}

impl WarmRuntime {
    pub(super) async fn retire(self) -> Result<(), String> {
        <Self as IdleResource>::shutdown(self).await
    }
}

#[derive(Default)]
pub(super) struct IdleCache {
    entries: CacheEntries<IdleHandle>,
    retiring: HashMap<String, Vec<RetirementBarrier>>,
}

impl IdleCache {
    /// Start observation now; retire returned replacements outside the lock.
    pub(super) fn insert(&mut self, session: String, runtime: WarmRuntime) -> Vec<IdleHandle> {
        let reader = runtime.configured.then(|| runtime.client.clone());
        let retired = self.entries.insert(
            session.clone(),
            IdleHandle {
                session,
                prior: Vec::new(),
                reader,
                lease: Some(IdleLease::spawn(runtime, IDLE_TTL, MAX_LIFETIME)),
            },
            MAX_IDLE,
        );
        for handle in &retired {
            self.remember_retirement(handle);
        }
        retired
    }

    /// Remove the sole checkout capability while holding the desktop lock.
    pub(super) fn take(&mut self, session: &str) -> Option<IdleHandle> {
        let prior = self.prior_retirements(session);
        let entry = self.entries.take(session);
        match entry {
            Some(mut handle) => {
                handle.prior.extend(prior);
                Some(handle)
            }
            None if !prior.is_empty() => Some(IdleHandle {
                session: session.to_owned(),
                prior,
                reader: None,
                lease: None,
            }),
            None => None,
        }
    }

    pub(super) fn remove(&mut self, session: &str) -> Option<IdleHandle> {
        let handle = self.take(session)?;
        self.remember_retirement(&handle);
        Some(handle)
    }

    pub(super) fn drain(&mut self) -> Vec<IdleHandle> {
        let mut ids = self.retiring.keys().cloned().collect::<Vec<_>>();
        ids.extend(self.entries.entries.iter().map(|(id, _)| id.clone()));
        ids.sort();
        ids.dedup();
        ids.into_iter().filter_map(|id| self.remove(&id)).collect()
    }

    pub(super) fn has_ready(&self, session: &str) -> bool {
        self.entries.entries.iter().any(|(id, handle)| {
            id == session
                && handle.lease.as_ref().is_some_and(|lease| {
                    Instant::now() < lease.deadline && lease.retired.borrow().is_none()
                })
        })
    }

    /// Observation borrows the same carrier without checking out the runtime
    /// or extending its idle deadline. A boot-only SDK has no opened root.
    pub(super) fn reader(&self, session: &str) -> Option<HarnessClient> {
        let (_, handle) = self.entries.entries.iter().find(|(id, _)| id == session)?;
        let lease = handle.lease.as_ref()?;
        if Instant::now() >= lease.deadline || lease.retired.borrow().is_some() {
            return None;
        }
        handle.reader.clone()
    }

    fn prior_retirements(&mut self, session: &str) -> Vec<RetirementBarrier> {
        let Some(prior) = self.retiring.get_mut(session) else {
            return Vec::new();
        };
        // Failures remain visible: an unconfirmed old writer is not a cache miss.
        prior.retain(|barrier| !matches!(*barrier.0.borrow(), Some(Ok(()))));
        let result = prior.clone();
        if result.is_empty() {
            self.retiring.remove(session);
        }
        result
    }

    fn remember_retirement(&mut self, handle: &IdleHandle) {
        if let Some(lease) = &handle.lease {
            self.retiring
                .entry(handle.session.clone())
                .or_default()
                .push(RetirementBarrier(lease.retired.clone()));
        }
    }

    pub(super) fn len(&self) -> usize {
        self.entries.entries.len()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.entries.entries.is_empty()
    }
}

pub(super) struct IdleHandle {
    session: String,
    prior: Vec<RetirementBarrier>,
    reader: Option<HarnessClient>,
    lease: Option<IdleLease<WarmRuntime>>,
}

#[derive(Clone)]
struct RetirementBarrier(watch::Receiver<Option<Result<(), String>>>);

impl IdleHandle {
    /// A miss waits for retirement, releasing the old session's write lease.
    pub(super) async fn take(self, fingerprint: &str) -> Result<Option<WarmRuntime>, String> {
        self.take_any(&[fingerprint.to_owned()]).await
    }

    pub(super) async fn take_any(
        self,
        fingerprints: &[String],
    ) -> Result<Option<WarmRuntime>, String> {
        let Self {
            mut prior, lease, ..
        } = self;
        let previous = wait_prior(&mut prior).await;
        if let Err(error) = previous {
            if let Some(lease) = lease {
                let _ = lease.retire().await;
            }
            return Err(error);
        }
        match lease {
            Some(lease) => lease.take_any(fingerprints).await,
            None => Ok(None),
        }
    }

    /// Return only after graceful shutdown or the transport's forced cleanup.
    pub(super) async fn retire(self) -> Result<(), String> {
        let Self {
            mut prior, lease, ..
        } = self;
        let previous = wait_prior(&mut prior).await;
        let current = match lease {
            Some(lease) => lease.retire().await,
            None => Ok(()),
        };
        previous.and(current)
    }
}

async fn wait_prior(prior: &mut [RetirementBarrier]) -> Result<(), String> {
    let mut failure = None;
    for barrier in prior {
        if let Err(error) = wait_retired(&mut barrier.0).await {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

struct CacheEntries<H> {
    entries: VecDeque<(String, H)>,
}

impl<H> Default for CacheEntries<H> {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
        }
    }
}

impl<H> CacheEntries<H> {
    fn insert(&mut self, session: String, handle: H, limit: usize) -> Vec<H> {
        let mut retired = self.take(&session).into_iter().collect::<Vec<_>>();
        self.entries.push_back((session, handle));
        while self.entries.len() > limit {
            if let Some((_, oldest)) = self.entries.pop_front() {
                retired.push(oldest);
            }
        }
        retired
    }

    fn take(&mut self, session: &str) -> Option<H> {
        let index = self.entries.iter().position(|(id, _)| id == session)?;
        self.entries.remove(index).map(|(_, handle)| handle)
    }

    #[cfg(test)]
    fn drain(&mut self) -> Vec<H> {
        self.entries.drain(..).map(|(_, handle)| handle).collect()
    }
}

type Shutdown = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

trait IdleResource: Send + 'static {
    type Event: Send + 'static;

    fn born_at(&self) -> Instant;
    fn fingerprint(&self) -> &str;
    fn events(&mut self) -> &mut mpsc::Receiver<Self::Event>;
    fn benign(event: Self::Event) -> bool;
    fn shutdown(self) -> Shutdown;
}

impl IdleResource for WarmRuntime {
    type Event = HarnessEvent;

    fn born_at(&self) -> Instant {
        self.born_at
    }

    fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    fn events(&mut self) -> &mut mpsc::Receiver<Self::Event> {
        &mut self.events
    }

    fn benign(event: Self::Event) -> bool {
        let HarnessEvent::Notification(value) = event else {
            // Dropping a host request refuses it through the existing transport.
            return false;
        };
        if !value["error"].is_null() || !value["params"]["error"].is_null() {
            return false;
        }
        match value["method"].as_str() {
            Some("lolicode/session.mode") => {
                let goal = &value["params"]["goal"];
                (goal.is_null() || goal["activation"] == "disarmed")
                    && value["params"]["plan"]["pending"].is_null()
            }
            Some("session.status") => value["params"]["status"] == "idle",
            // A parked process promised to be quiescent. New durable events,
            // subagents, stream frames and unknown notifications invalidate it.
            _ => false,
        }
    }

    fn shutdown(self) -> Shutdown {
        Box::pin(async move {
            let Self {
                client, mut events, ..
            } = self;
            let shutdown = client.shutdown_for_reuse();
            tokio::pin!(shutdown);
            loop {
                tokio::select! {
                    biased;
                    result = &mut shutdown => return result,
                    event = events.recv() => {
                        if event.is_none() {
                            return shutdown.await;
                        }
                        // Keep stdout draining while shutdown flushes the SDK.
                        // Host operations are refused, never executed here.
                    }
                }
            }
        })
    }
}

enum Command<R> {
    Take {
        fingerprints: Vec<String>,
        reply: oneshot::Sender<R>,
    },
    Retire,
}

struct IdleLease<R> {
    command: oneshot::Sender<Command<R>>,
    retired: watch::Receiver<Option<Result<(), String>>>,
    deadline: Instant,
}

impl<R: IdleResource> IdleLease<R> {
    fn spawn(resource: R, idle_ttl: Duration, max_lifetime: Duration) -> Self {
        let deadline = (Instant::now() + idle_ttl).min(resource.born_at() + max_lifetime);
        let (command, commands) = oneshot::channel();
        let (finished, retired) = watch::channel(None);
        tokio::spawn(idle_worker(resource, commands, finished, deadline));
        Self {
            command,
            retired,
            deadline,
        }
    }

    #[cfg(test)]
    async fn take(self, fingerprint: &str) -> Result<Option<R>, String> {
        self.take_any(&[fingerprint.to_owned()]).await
    }

    async fn take_any(self, fingerprints: &[String]) -> Result<Option<R>, String> {
        let Self {
            command,
            mut retired,
            ..
        } = self;
        let (reply, response) = oneshot::channel();
        let _ = command.send(Command::Take {
            fingerprints: fingerprints.to_vec(),
            reply,
        });
        if let Ok(resource) = response.await {
            return Ok(Some(resource));
        }
        wait_retired(&mut retired).await?;
        Ok(None)
    }

    async fn retire(self) -> Result<(), String> {
        let Self {
            command,
            mut retired,
            ..
        } = self;
        let _ = command.send(Command::Retire);
        wait_retired(&mut retired).await
    }
}

async fn wait_retired(
    retired: &mut watch::Receiver<Option<Result<(), String>>>,
) -> Result<(), String> {
    loop {
        if let Some(result) = retired.borrow_and_update().clone() {
            return result;
        }
        retired
            .changed()
            .await
            .map_err(|_| "Harness 空闲进程回收未完成".to_owned())?;
    }
}

fn reusable<R: IdleResource>(resource: &mut R, fingerprint: &str, deadline: Instant) -> bool {
    if Instant::now() >= deadline
        || resource.fingerprint() != fingerprint
        || resource.events().is_closed()
    {
        return false;
    }
    loop {
        match resource.events().try_recv() {
            Ok(event) => {
                if !R::benign(event) {
                    return false;
                }
            }
            Err(mpsc::error::TryRecvError::Disconnected) => return false,
            Err(mpsc::error::TryRecvError::Empty) => return true,
        }
    }
}

async fn idle_worker<R: IdleResource>(
    mut resource: R,
    commands: oneshot::Receiver<Command<R>>,
    finished: watch::Sender<Option<Result<(), String>>>,
    deadline: Instant,
) {
    tokio::pin!(commands);
    loop {
        tokio::select! {
            biased;
            command = &mut commands => {
                if let Ok(Command::Take { fingerprints, reply }) = command {
                    let matching = fingerprints.iter().find(|fingerprint| *fingerprint == resource.fingerprint());
                    if matching.is_some_and(|fingerprint| reusable(&mut resource, fingerprint, deadline)) {
                        match reply.send(resource) {
                            Ok(()) => return,
                            Err(returned) => resource = returned,
                        }
                    }
                }
                break;
            }
            _ = sleep_until(deadline) => break,
            event = resource.events().recv() => {
                match event {
                    Some(event) => {
                        if !R::benign(event) {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }
    let result = resource.shutdown().await;
    finished.send_replace(Some(result));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::Semaphore;

    struct MockResource {
        events: mpsc::Receiver<bool>,
        born_at: Instant,
        fingerprint: String,
        shutdowns: Arc<AtomicUsize>,
        started: Option<oneshot::Sender<()>>,
        release: Arc<Semaphore>,
        shutdown_error: Option<String>,
    }

    impl IdleResource for MockResource {
        type Event = bool;

        fn born_at(&self) -> Instant {
            self.born_at
        }
        fn fingerprint(&self) -> &str {
            &self.fingerprint
        }
        fn events(&mut self) -> &mut mpsc::Receiver<bool> {
            &mut self.events
        }
        fn benign(event: bool) -> bool {
            event
        }
        fn shutdown(mut self) -> Shutdown {
            Box::pin(async move {
                self.shutdowns.fetch_add(1, Ordering::SeqCst);
                if let Some(started) = self.started.take() {
                    let _ = started.send(());
                }
                let _permit = self.release.acquire().await.map_err(|e| e.to_string())?;
                self.shutdown_error.map_or(Ok(()), Err)
            })
        }
    }

    fn mock(born_at: Instant) -> (MockResource, mpsc::Sender<bool>, Arc<AtomicUsize>) {
        let (send, events) = mpsc::channel(16);
        let shutdowns = Arc::new(AtomicUsize::new(0));
        (
            MockResource {
                events,
                born_at,
                fingerprint: "same-owner-config".into(),
                shutdowns: shutdowns.clone(),
                started: None,
                release: Arc::new(Semaphore::new(1)),
                shutdown_error: None,
            },
            send,
            shutdowns,
        )
    }

    #[test]
    fn cache_replacement_and_lru_evict_only_the_owned_old_handles() {
        let mut cache = CacheEntries::default();
        assert!(cache.insert("first".into(), 1, 2).is_empty());
        assert!(cache.insert("second".into(), 2, 2).is_empty());
        assert_eq!(cache.insert("first".into(), 3, 2), vec![1]);
        assert_eq!(cache.insert("third".into(), 4, 2), vec![2]);
        assert_eq!(cache.take("first"), Some(3));
        assert_eq!(cache.take("first"), None);
        assert_eq!(cache.drain(), vec![4]);
        assert!(cache.entries.is_empty());
    }

    #[tokio::test]
    async fn checkout_transfers_the_single_resource_and_preserves_its_birth() {
        let born_at = Instant::now() - Duration::from_secs(10);
        let (resource, _send, shutdowns) = mock(born_at);
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        let runtime = lease.take("same-owner-config").await.unwrap().unwrap();
        assert_eq!(runtime.born_at, born_at);
        assert_eq!(shutdowns.load(Ordering::SeqCst), 0);
        runtime.shutdown().await.unwrap();
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn expired_checkout_cannot_win_even_when_take_is_already_queued() {
        let (resource, _send, shutdowns) = mock(Instant::now() - MAX_LIFETIME);
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        assert!(lease.take("same-owner-config").await.unwrap().is_none());
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn config_change_and_closed_event_carrier_retire_before_checkout_misses() {
        let (resource, _send, shutdowns) = mock(Instant::now());
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        assert!(lease
            .take("changed-channel-or-workspace")
            .await
            .unwrap()
            .is_none());
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);

        let (resource, send, shutdowns) = mock(Instant::now());
        drop(send);
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        assert!(lease.take("same-owner-config").await.unwrap().is_none());
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn queued_unsafe_event_prevents_a_simultaneous_checkout() {
        let (resource, send, shutdowns) = mock(Instant::now());
        send.send(false).await.unwrap();
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        assert!(lease.take("same-owner-config").await.unwrap().is_none());
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn benign_notifications_are_drained_without_losing_the_resource() {
        let (resource, send, shutdowns) = mock(Instant::now());
        send.send(true).await.unwrap();
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        tokio::task::yield_now().await;
        let runtime = lease.take("same-owner-config").await.unwrap().unwrap();
        assert!(runtime.events.is_empty());
        assert_eq!(shutdowns.load(Ordering::SeqCst), 0);
        runtime.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn retirement_acknowledges_only_after_the_resource_releases_its_lease() {
        let (mut resource, _send, shutdowns) = mock(Instant::now());
        let release = Arc::new(Semaphore::new(0));
        resource.release = release.clone();
        let (started, starting) = oneshot::channel();
        resource.started = Some(started);
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        let retired = tokio::spawn(lease.retire());
        starting.await.unwrap();
        assert!(!retired.is_finished());
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        release.add_permits(1);
        retired.await.unwrap().unwrap();
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_retirement_cannot_be_reported_as_a_safe_cold_start() {
        let (mut resource, _send, shutdowns) = mock(Instant::now());
        resource.shutdown_error = Some("write lease was not released".into());
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        let result = lease.take("changed-channel-or-workspace").await;
        assert!(matches!(result, Err(error) if error == "write lease was not released"));
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn boot_or_configured_keys_can_checkout_without_accepting_other_configurations() {
        let (resource, _send, shutdowns) = mock(Instant::now());
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        let runtime = lease
            .take_any(&["complete-turn-config".into(), "same-owner-config".into()])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(shutdowns.load(Ordering::SeqCst), 0);
        runtime.shutdown().await.unwrap();

        let (resource, send, shutdowns) = mock(Instant::now());
        send.send(false).await.unwrap();
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        assert!(lease
            .take_any(&["same-owner-config".into(), "same-owner-config".into()])
            .await
            .unwrap()
            .is_none());
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_evicted_owner_waits_for_retirement_before_a_cold_cache_miss() {
        let (mut resource, _send, shutdowns) = mock(Instant::now());
        let release = Arc::new(Semaphore::new(0));
        resource.release = release.clone();
        let (started, starting) = oneshot::channel();
        resource.started = Some(started);
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        let mut cache = IdleCache::default();
        // insert's LRU branch retains this same shutdown completion capability
        // after removing the old ready entry from the visible cache.
        cache.retiring.insert(
            "evicted-owner".into(),
            vec![RetirementBarrier(lease.retired.clone())],
        );
        let eviction = tokio::spawn(lease.retire());
        starting.await.unwrap();
        let handle = cache.take("evicted-owner").unwrap();
        let checkout = tokio::spawn(async move { handle.take("same-owner-config").await });
        tokio::task::yield_now().await;
        assert!(!checkout.is_finished());
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        release.add_permits(1);
        eviction.await.unwrap().unwrap();
        assert!(checkout.await.unwrap().unwrap().is_none());
        assert!(cache.take("evicted-owner").is_none());
    }

    #[tokio::test]
    async fn mutations_also_wait_for_already_evicted_owners_and_keep_failure_visible() {
        let (finished, retired) = watch::channel(None);
        let mut cache = IdleCache::default();
        cache
            .retiring
            .insert("evicted-owner".into(), vec![RetirementBarrier(retired)]);
        let handles = cache.drain();
        assert_eq!(handles.len(), 1);
        // Removing a waiting handle must not erase another caller's barrier.
        let concurrent = cache.remove("evicted-owner").unwrap();
        let retirement =
            tokio::spawn(async move { handles.into_iter().next().unwrap().retire().await });
        let mutation = tokio::spawn(concurrent.retire());
        tokio::task::yield_now().await;
        assert!(!retirement.is_finished());
        assert!(!mutation.is_finished());
        finished.send_replace(Some(Err("old writer still owns its lease".into())));
        assert!(retirement.await.unwrap().is_err());
        assert!(mutation.await.unwrap().is_err());
        let retry = cache
            .take("evicted-owner")
            .unwrap()
            .take("same-owner-config")
            .await;
        assert!(retry.is_err());
    }

    #[tokio::test]
    async fn dropping_an_unused_handle_retires_instead_of_leaking_the_resource() {
        let (mut resource, _send, shutdowns) = mock(Instant::now());
        let (started, starting) = oneshot::channel();
        resource.started = Some(started);
        let lease = IdleLease::spawn(resource, IDLE_TTL, MAX_LIFETIME);
        drop(lease);
        starting.await.unwrap();
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn only_benign_idle_notifications_can_be_discarded() {
        let notification = |method, params| {
            HarnessEvent::Notification(serde_json::json!({"method":method,"params":params}))
        };
        assert!(WarmRuntime::benign(notification(
            "session.status",
            serde_json::json!({"status":"idle"})
        )));
        assert!(WarmRuntime::benign(notification(
            "lolicode/session.mode",
            serde_json::json!({"goal":null,"plan":null})
        )));
        for (method, params) in [
            ("session.status", serde_json::json!({"status":"running"})),
            (
                "session.event",
                serde_json::json!({"event":{"type":"turn/start"}}),
            ),
            ("subagent.started", serde_json::json!({})),
            ("unknown.future-event", serde_json::json!({})),
            (
                "lolicode/session.mode",
                serde_json::json!({"error":"failed"}),
            ),
            (
                "lolicode/session.mode",
                serde_json::json!({"goal":{"phase":"active","activation":"armed"}}),
            ),
            (
                "lolicode/session.mode",
                serde_json::json!({"goal":null,"plan":{"pending":{"id":"review"}}}),
            ),
        ] {
            assert!(!WarmRuntime::benign(notification(method, params)));
        }
    }
}
