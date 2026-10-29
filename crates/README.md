# Rust 独立库

当前包含 `lolicode-agent/`，为桌面宿主提供不依赖界面的内置 Agent 核心。各 crate 使用自己的 `Cargo.toml`；桌面通过路径依赖引用它。返回[总架构入口](../ARCHITECTURE.md)。

从 `lolicode-agent/src/lib.rs` 读公共接口，再进入 `src/native/mod.rs`：

- `native/engine.rs`、`native/inference.rs`：执行流程与模型推理。
- `native/context.rs`、`native/memory.rs`、`native/persistence.rs`：上下文、记忆与会话持久化。
- `native/tools.rs`、`native/tool_search.rs` 等：工具执行与发现。
- `dto.rs`、`mapping.rs` 等：公共数据与历史兼容适配。

核心经 `NativeGateway` 使用宿主网关；桌面侧接线在 `src-tauri/src/services/inprocess_agent.rs`。修改会话、推理或工具行为时同时检查核心测试和宿主接入。

在仓库根目录运行：

```sh
cargo test --manifest-path crates/lolicode-agent/Cargo.toml
```
