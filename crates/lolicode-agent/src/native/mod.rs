//! In-process Rust agent. Model transport uses the host's private gateway;
//! no engine executable, Node worker, listener or upstream credentials exist.
pub mod applications;
mod engine;
mod context;
mod inference;
mod memory;
mod tool_search;
mod persistence;
pub(crate) mod tools;
mod types;
pub mod unreal;
mod usage;

pub use engine::NativeEngine;
pub use types::NativeGateway;

#[cfg(test)]
mod tests;
