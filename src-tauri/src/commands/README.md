# 界面命令

这里是前端 `src/lib/api/` 调用的 Tauri 命令边界。`mod.rs` 统一导出，`../lib.rs` 注册命令；从桌面应用的入口阅读时，使用 [src-tauri/README.md](../../README.md)。

按业务寻找同名模块：Agent 在 `agent_*.rs`，渠道与模型在 `channel_center.rs`、`model_fetch.rs`，会话在 `session_manager.rs`，设置在 `settings.rs`，其他功能也按职责命名。

- `desktop.rs`：外部链接、剪贴板、启动状态、更新与窗口主题。
- [tool_management/](tool_management/README.md)：外部 CLI 的发现、安装、更新、卸载与终端。
- 业务服务位于相邻的 `../services/`，模型网关在 `../proxy/`，独立 Agent 核心在根目录 `crates/lolicode-agent/`。

拆分命令时保留前端调用名和参数格式，同步 `mod.rs` 导出、桌面注册、其他命令的内部引用以及测试中的完整模块路径。命令之间需要共享的业务能力优先提取到服务或所属核心。
