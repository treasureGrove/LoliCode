//! LoliCode host contracts and stored history adapters.
//!
//! The retained legacy mapping follows anomalyco/opencode commit
//! 2670273ff17da96f85c5826ced57aa1b368754fa. Public DTOs contain session data
//! and the desktop model routes all Agent turns to DeepSeek Harness.
//! The `legacy-runtime` feature enables the historical sidecar executor.
//! `legacy-native-tests` retains the previous Rust executor for regression fixtures.

mod dto;
mod images;
mod mapping;
pub mod native;
#[cfg(feature = "legacy-runtime")]
mod policy;
#[cfg(feature = "legacy-runtime")]
mod runtime;
#[cfg(feature = "legacy-runtime")]
mod stream;

pub use dto::*;
#[cfg(any(test, feature = "legacy-native-tests"))]
pub use native::{NativeEngine, NativeGateway};
#[cfg(feature = "legacy-runtime")]
pub use runtime::{Engine, EngineOptions};

/// Decode stored legacy history without initializing or launching an engine.
pub fn decode_legacy_message(value: &serde_json::Value) -> Option<AgentMessage> {
    mapping::message(value)
}

pub const ENGINE_VERSION: &str = "2.0.12";
pub const ENGINE_SOURCE_REVISION: &str = "2670273ff17da96f85c5826ced57aa1b368754fa";

#[cfg(all(test, feature = "legacy-runtime"))]
mod tests;
