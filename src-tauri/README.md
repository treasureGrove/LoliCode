# 桌面原生宿主

Tauri 负责桌面窗口、系统能力与界面到 Rust 的命令边界。返回[总架构入口](../ARCHITECTURE.md)。

启动从 `src/main.rs` 进入 `src/lib.rs::run()`；`lib.rs` 初始化服务、管理生命周期并注册命令。

- `src/commands/`：界面可调用的命令。`desktop.rs` 管通用桌面操作，`tool_management/` 管外部 CLI 与终端；其余按业务命名。
- `src/services/`：业务流程与宿主接入；内置 Agent 接入从 `inprocess_agent.rs` 开始。
- `src/services/mobile_companion/`：移动伴随的账户与设备通道；`auth_refresh.rs` 管票据续期，`authorization.rs` 管取消和授权到期，通道与独立探针共用这些实现。
- `src/proxy/`：模型网关、路由、协议适配、流处理与请求用量。
- `src/database/`：数据库结构、迁移和数据访问。
- `src/mode/`、`src/tray.rs`：运行模式和托盘；其余顶层配置模块保留各外部客户端的配置兼容逻辑。
- `tests/`、`test-fixtures/`、`examples/`：集成测试、固定输入和能力验证程序；单元测试也位于对应 Rust 模块内。
- `tauri*.conf.json`、`capabilities/`、`nsis/`、`wix/`、`icons/`：应用配置、权限与打包资源。
- `resources/`：随应用分发的资源，部分由准备脚本生成；`target/` 为编译产物。

命令入口保持返回契约稳定，将可复用业务规则放进服务；UI 无关的 Agent 执行逻辑放入 `../crates/lolicode-agent/`。通用模块按职责拆分，避免重新建立杂项文件。

在仓库根目录先运行 `pnpm build:renderer`，再运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib`。开发、平台依赖与隔离测试数据约定见[贡献指南](../CONTRIBUTING.md)。
