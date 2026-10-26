//! UI-independent in-process Rust coding core and legacy history DTO adapter.
//!
//! The retained legacy mapping follows anomalyco/opencode commit
//! 2670273ff17da96f85c5826ced57aa1b368754fa. The current `native::NativeEngine`
//! runs inside its host and calls only the host gateway; public DTOs contain
//! session data, never gateway or upstream credentials.

mod dto;
mod images;
mod mapping;
pub mod native;
mod policy;
mod runtime;
mod stream;

pub use dto::*;
pub use native::{NativeEngine, NativeGateway};
pub use runtime::{Engine, EngineOptions};

/// Decode stored legacy history without initializing or launching an engine.
pub fn decode_legacy_message(value: &serde_json::Value) -> Option<AgentMessage> {
    mapping::message(value)
}

pub const ENGINE_VERSION: &str = "2.0.12";
pub const ENGINE_SOURCE_REVISION: &str = "2670273ff17da96f85c5826ced57aa1b368754fa";

#[cfg(test)]
mod tests;
