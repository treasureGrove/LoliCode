# Rust 独立库

当前包含 `lolicode-agent/`，为桌面宿主提供共享 DTO、旧会话解码以及工具、记忆等复用能力。各 crate 使用自己的 `Cargo.toml`；桌面通过路径依赖引用它。返回[总架构入口](../ARCHITECTURE.md)。

从 `lolicode-agent/src/lib.rs` 读公共接口，再进入 `src/native/mod.rs`：

- `native/engine.rs`、`native/inference.rs`：执行流程与模型推理。
- `native/context.rs`、`native/memory.rs`、`native/persistence.rs`：上下文、记忆与会话持久化。
- `native/tools.rs`、`native/tool_search.rs` 等：工具执行与发现。
- `dto.rs`、`mapping.rs` 等：公共数据与历史兼容适配。

当前桌面执行循环由 DeepSeek Harness 提供，接入在 `src-tauri/src/services/inprocess_agent.rs` 和 `harness_*.rs`。此处旧 Rust 执行器通过 `legacy-native-tests` 保留给回归夹具；生产宿主以 `default-features = false` 引用。旧 OpenCode sidecar 执行器及其 `legacy-runtime` feature 已移除，历史消息解码保留在 `mapping.rs`。修改共享类型或工具时同时检查宿主调用。

在仓库根目录运行：

```sh
cargo test --manifest-path crates/lolicode-agent/Cargo.toml
```
