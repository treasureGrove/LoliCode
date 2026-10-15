//! In-process Rust agent. Model transport uses the host's private gateway;
//! no engine executable, Node worker, listener or upstream credentials exist.
mod engine;
mod context;
mod inference;
mod persistence;
pub(crate) mod tools;
mod types;

pub use engine::NativeEngine;
pub use types::NativeGateway;

#[cfg(test)]
mod tests;
