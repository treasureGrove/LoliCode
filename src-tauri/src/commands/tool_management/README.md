# 外部工具管理

`mod.rs` 是模块入口，统一导出原有 IPC 命令；实现按职责分开：

- `versions.rs`：本机版本探测和上游版本信息。
- `paths.rs`：可执行文件搜索目录与 PATH 解析。
- `installations.rs`：安装来源、安装方式和安装路径识别。
- `lifecycle.rs`：安装、更新、卸载计划与操作协调。
- `process.rs`：子进程执行、输出解码、超时与进程清理。
- `terminal.rs`：终端选择、命令转义、Windows/WSL 与其他平台的启动。
- `tool_uninstall.rs`：按已检测的安装方式卸载工具。

`tests.rs` 保存跨模块回归；卸载专用测试在 `tool_uninstall/tests.rs`。桌面通用操作及其测试在相邻的 `desktop.rs`、`desktop/tests.rs`。

在仓库根目录运行相关回归：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::tool_management
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::desktop
```

平台专用行为用 `cfg` 明确标记；内部依赖使用具体模块的显式导入。移动或重命名测试时，也要更新启动子进程所用的测试完整路径，避免过滤条件失效。
