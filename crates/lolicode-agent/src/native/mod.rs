//! Host-owned product capabilities and optional legacy regression fixtures.
pub mod applications;
pub mod automation_proposal;
#[cfg(any(test, feature = "legacy-native-tests"))]
mod engine;
#[cfg(any(test, feature = "legacy-native-tests"))]
mod context;
#[cfg(any(test, feature = "legacy-native-tests"))]
mod inference;
pub mod memory;
#[cfg(any(test, feature = "legacy-native-tests"))]
mod tool_search;
mod persistence;
#[cfg(any(test, feature = "legacy-native-tests"))]
mod project_instructions;
#[cfg(any(test, feature = "legacy-native-tests"))]
mod preview;
mod paths;
mod secretary_worktree;
pub(crate) mod tools;
#[cfg(any(test, feature = "legacy-native-tests"))]
mod types;
pub mod unreal;
#[cfg(any(test, feature = "legacy-native-tests"))]
mod usage;

#[cfg(any(test, feature = "legacy-native-tests"))]
pub use engine::NativeEngine;
pub use secretary_worktree::{
    create as create_secretary_worktree, execution_root as secretary_worktree_root,
};
#[cfg(any(test, feature = "legacy-native-tests"))]
pub use types::NativeGateway;

#[cfg(test)]
mod tests;
