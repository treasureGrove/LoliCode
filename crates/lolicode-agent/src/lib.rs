//! Shared desktop/CLI adapter for OpenCode v2.0.12.
//!
//! Upstream contract: anomalyco/opencode, commit
//! 2670273ff17da96f85c5826ced57aa1b368754fa. Credentials and listener URLs
//! deliberately stay inside the runtime; public DTOs contain session data only.

mod dto;
mod mapping;
mod policy;
mod runtime;
mod stream;

pub use dto::*;
pub use runtime::{Engine, EngineOptions};

pub const ENGINE_VERSION: &str = "2.0.12";
pub const ENGINE_SOURCE_REVISION: &str = "2670273ff17da96f85c5826ced57aa1b368754fa";

#[cfg(test)]
mod tests;
