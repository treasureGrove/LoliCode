//! A relay request refreshes its canonical balance even when local usage logging
//! is disabled or the upstream omits usage. No response data enters the event.
use super::ProxyError;
use axum::{body::Body, response::Response};
use bytes::Bytes;
use http_body::{Body as HttpBody, Frame, SizeHint};
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

struct Completion;

impl Drop for Completion {
    fn drop(&mut self) {
        crate::usage_events::notify_relay_request_completed();
    }
}

/// The guard starts before forwarding, so an error or cancelled request future
/// also refreshes the balance. Successful responses transfer it to their body.
pub(super) async fn track(
    relay: bool,
    request: impl Future<Output = Result<Response, ProxyError>>,
) -> Result<Response, ProxyError> {
    let completion = if relay { Some(Completion) } else { None };
    let response = request.await?;
    let Some(completion) = completion else {
        return Ok(response);
    };
    let (parts, body) = response.into_parts();
    Ok(Response::from_parts(
        parts,
        Body::new(CompletionBody {
            body: Some(body),
            completion: Some(completion),
        }),
    ))
}

struct CompletionBody {
    body: Option<Body>,
    completion: Option<Completion>,
}

impl CompletionBody {
    fn finish(&mut self) {
        // Close the upstream stream/connection before telling the UI to read.
        // Its server-side cancellation can settle asynchronously; the regular
        // foreground poll remains the fallback for that uncertain finalization.
        drop(self.body.take());
        drop(self.completion.take());
    }
}

impl HttpBody for CompletionBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        let Some(body) = this.body.as_mut() else {
            return Poll::Ready(None);
        };
        let frame = Pin::new(body).poll_frame(cx);
        if matches!(frame, Poll::Ready(None | Some(Err(_)))) {
            this.finish();
        }
        frame
    }

    fn is_end_stream(&self) -> bool {
        self.body.as_ref().is_none_or(HttpBody::is_end_stream)
    }

    fn size_hint(&self) -> SizeHint {
        self.body
            .as_ref()
            .map(HttpBody::size_hint)
            .unwrap_or_default()
    }
}

impl Drop for CompletionBody {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_events::take_test_relay_notify_count as notifications;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn completion_waits_for_stream_end_and_never_emits_per_chunk() {
        notifications();
        let stream = futures::stream::iter([
            Ok::<_, std::io::Error>(Bytes::from_static(b"data: first\n\n")),
            Ok(Bytes::from_static(b"data: [DONE]\n\n")),
        ]);
        let response = track(true, async { Ok(Response::new(Body::from_stream(stream))) })
            .await
            .unwrap();
        let mut body = response.into_body();
        assert_eq!(notifications(), 0);
        assert!(body.frame().await.unwrap().is_ok());
        assert_eq!(notifications(), 0);
        assert!(body.frame().await.unwrap().is_ok());
        assert_eq!(notifications(), 0);
        assert!(body.frame().await.is_none());
        assert_eq!(notifications(), 1);
        drop(body);
        assert_eq!(notifications(), 0);
    }

    #[tokio::test]
    async fn stream_errors_and_unpolled_response_cancellation_emit_once() {
        for error in [false, true] {
            notifications();
            let stream = futures::stream::once(async {
                Err::<Bytes, _>(std::io::Error::other("fixture stream failed"))
            });
            let response = track(true, async { Ok(Response::new(Body::from_stream(stream))) })
                .await
                .unwrap();
            let mut body = response.into_body();
            if error {
                assert!(body.frame().await.unwrap().is_err());
                assert_eq!(notifications(), 1);
                assert!(body.frame().await.is_none());
            }
            drop(body);
            assert_eq!(notifications(), u32::from(!error));
        }
    }

    #[tokio::test]
    async fn cancelled_inflight_request_and_forward_error_emit_once() {
        notifications();
        let mut request = Box::pin(track(true, futures::future::pending()));
        assert!(futures::poll!(&mut request).is_pending());
        assert_eq!(notifications(), 0);
        drop(request);
        assert_eq!(notifications(), 1);
        assert!(track(true, async {
            Err(ProxyError::InvalidRequest("fixture failure".into()))
        })
        .await
        .is_err());
        assert_eq!(notifications(), 1);
    }

    #[tokio::test]
    async fn cancellation_releases_the_request_or_upstream_body_before_notifying() {
        use std::sync::{Arc, Mutex};

        struct Pending(Arc<Mutex<Vec<u32>>>);
        impl Drop for Pending {
            fn drop(&mut self) {
                self.0.lock().unwrap().push(notifications());
            }
        }
        impl Future for Pending {
            type Output = Result<Response, ProxyError>;

            fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
                Poll::Pending
            }
        }
        impl HttpBody for Pending {
            type Data = Bytes;
            type Error = std::io::Error;

            fn poll_frame(
                self: Pin<&mut Self>,
                _cx: &mut Context<'_>,
            ) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
                Poll::Pending
            }
        }

        for before_headers in [true, false] {
            notifications();
            let at_release = Arc::new(Mutex::new(Vec::new()));
            let pending = Pending(at_release.clone());
            if before_headers {
                let mut request = Box::pin(track(true, pending));
                assert!(futures::poll!(&mut request).is_pending());
                drop(request);
            } else {
                let response = track(true, async { Ok(Response::new(Body::new(pending))) })
                    .await
                    .unwrap();
                drop(response);
            }
            assert_eq!(*at_release.lock().unwrap(), vec![0]);
            assert_eq!(notifications(), 1);
        }
    }

    #[tokio::test]
    async fn unrelated_requests_never_emit_a_relay_completion() {
        notifications();
        let response = track(false, async { Ok(Response::new(Body::from("ordinary"))) })
            .await
            .unwrap();
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "ordinary"
        );
        assert!(track(false, async {
            Err(ProxyError::InvalidRequest("ordinary failure".into()))
        })
        .await
        .is_err());
        assert_eq!(notifications(), 0);
    }
}
