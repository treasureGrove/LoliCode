# Lolicode 编程工作台

Lolicode 将已有渠道与模型配置接到桌面 coding agent。选择项目、模型和“实现”或“分析”模式，输入任务即可开始。执行引擎使用固定版本 OpenCode；桌面界面和后续 CLI 通过同一套会话接口调用它。

## 使用

1. 在“渠道与模型”加入 API 或已支持聚合的订阅账号，保存需要使用的模型。
2. 进入“编程工作台”，选择本机项目文件夹。
3. 选择模型，使用“实现”模式修改代码，或使用“分析”模式先探索与规划。
4. 描述任务。文字实时更新，工具操作可以展开查看，实际文件改动从“查看改动”打开。
5. 工具需要执行命令或补充信息时，在当前会话内应答。权限的“此项目记住授权”会保存到此项目，不是仅限当前会话。
6. 点击停止会请求引擎中断，界面等待真实终态；已经收到的内容保留。切换到渠道页不会停止后台任务。

项目会话保存在 Lolicode 自有数据目录中，可以重新打开并继续。未发送文本按项目和会话隔离保存在桌面会话缓存中。已有会话继续使用它绑定的模型；切换模型请新建会话。

Git 项目提供引擎快照与文件 diff，需要本机可用的 Git。普通文件夹也可以聊天和读写文件，通过工具输出查看执行结果；项目是否初始化 Git 由用户决定。

Claude 和 Gemini 的原生订阅入口只供各自官方 CLI 使用，不能当作这个 agent 的可用模型。API、Copilot、ChatGPT、xAI、ZCode 渠道沿用统一网关的适配与凭据刷新逻辑，实际套餐权限仍由上游决定。

## 代码边界

- `crates/lolicode-agent/`：不依赖 Tauri 的执行引擎宿主、HTTP 会话调用、SSE 文字与工具事件、快照恢复和规范化 DTO。后续 CLI 复用这里，不重新写一套执行循环。
- `src-tauri/src/services/agent.rs`：桌面项目生命周期、会话所属项目校验和模型绑定。
- `src-tauri/src/commands/agent.rs`：桌面 IPC。只返回无凭据的目录及会话数据。
- `src-tauri/src/services/channel_center.rs`：原目录的不可变版本、agent 私有配置投影及共享网关运行保护，不调用外部客户端配置写入器。
- `src/components/agent/` 与 `src/hooks/useAgentSnapshot.ts`：项目选择、聊天、执行状态、权限、问题与实际 diff 展示。
- `scripts/prepare-agent-runtime.mjs`：从锁定的 npm 平台包准备随应用分发的引擎与许可。

固定引擎为 `@opencode/cli` 2.0.12，对应 OpenCode 源码提交 `2670273ff17da96f85c5826ced57aa1b368754fa`。采用它的 V2 `/api/session` 合同，避免混用旧版 SDK 的 `/session` API。npm 包完整性由锁文件记录，资源清单记录实际二进制 SHA-256；这不是源码可复现构建证明。

引擎以独立子进程启动，监听本机临时端口并使用每次启动生成的认证密码。stdin 管道归宿主管理，应用退出时关闭执行引擎。配置、数据库、缓存、临时目录及 home 读取范围置于 Lolicode 自有目录；不导入用户另一个 OpenCode 实例的账号、配置或会话。短期上游凭据留在原认证管理器中，agent 配置只引用本地网关，聊天模型选择器不接收 Key。

流式文字来自真实 SSE 增量，持久消息与实际改动来自引擎快照。界面提交成功表示消息已入队，不能当作任务完成。连接中断会标明状态，恢复时重新读取持久快照。未来 CLI 复用引擎启动、会话、权限与中断接口；此轮交付桌面入口，尚未增加 CLI/TUI。

## 开源来源

实际随应用复用并分发的 agent 引擎是 [OpenCode v2.0.12](https://github.com/anomalyco/opencode/tree/2670273ff17da96f85c5826ced57aa1b368754fa)，许可为 MIT，完整许可在 `third-party/opencode/LICENSE` 与运行资源中。

其他项目作为设计参考，并未宣称同时整合它们的执行引擎：

- [ZCode 取消时保存流式内容](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/cancelled-stream-persistence.ts)与[持久事件 reducer](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/contracts/src/events/event-reducer.ts)：保留中断前输出，等待真实结束事件，按持久状态恢复会话。
- [MiMo-Code 记忆路径](https://github.com/XiaomiMiMo/MiMo-Code/blob/e27e87de81a74db5475bd93540f8889dfbc70ec6/packages/cli/src/memory/paths.ts)与[checkpoint 布局](https://github.com/XiaomiMiMo/MiMo-Code/blob/e27e87de81a74db5475bd93540f8889dfbc70ec6/packages/cli/src/session/checkpoint-paths.ts)：项目身份与会话状态分开组织。Lolicode 本版提供项目会话隔离，尚未实现 MiMo 的记忆蒸馏或自我改进系统。
- [DeepSeek Harness 桌面与事件架构](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/architecture.md)与[生命周期清理](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/cordis-tutorial/02-lifecycle-and-effects.md)：固定运行时、宿主管生命周期，UI 消费协议。此轮保持模块边界，未引入 Cordis 插件系统。
- [Claude Code 的公开工作流](https://code.claude.com/docs/en/common-workflows)：项目上下文、分析/实现、测试结果、恢复会话与改动查看。官方 CLI 的[许可](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)指向商业条款，此轮没有复制或分发其执行引擎。

## 验证

验证区分 UI 模拟接口、Rust 离线协议回归和固定真实引擎配合本机假模型的临时项目验证。示例截图不能作为真实上游授权或付费推理成功的证据。交付清单记录本轮实际执行的检查和产物校验值。

开发时先执行 `pnpm install` 与 `pnpm prepare:agent-runtime`。独立执行模块的回归用 `cargo test --manifest-path crates/lolicode-agent/Cargo.toml`；完整桌面回归用 `pnpm typecheck`、`pnpm test:unit` 与 `cargo test --manifest-path src-tauri/Cargo.toml --lib`。

真实引擎的离线临时项目检查：`cargo run --manifest-path src-tauri/Cargo.toml --example lolicode_agent_smoke`。需要明确授权的真实智谱测试使用 `cargo run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_agent_glm_smoke -- --key-file <私有临时凭据文件的绝对路径> --out <脱敏结果文件的绝对路径>`。真实测试只操作自己创建的临时项目，经过生产渠道网关；不自动导入这份凭据到用户渠道配置。

Windows 安装包已包含 agent 运行资源。便携版须将 `Lolicode.exe` 与 `agent/` 文件夹放在一起，保留其中的二进制、许可和资源清单。

2026-10-14 本机验证：前端 227 个文件、2726 项测试通过，桌面 Rust 后端 3666 项测试通过、10 项忽略，独立 Rust core 的 17 项回归通过。桌面后端此次使用 `--features test-hooks --lib -- --test-threads=2`，test-hooks 仅增加隔离测试所需的内部类型导出；安装包使用默认 features。固定真实引擎配合本机假模型的六项检查涵盖写文件、流式文字、实际 diff、分析模式拒写、真实中断与重启恢复。

已使用用户授权的智谱凭据经生产渠道网关验证 `glm-5.3-flash`：真实读取并修改临时 Git 项目的 `sum.js`，将减法修成加法，Node 验证 `add(2,3) = 5` 和 `add(-2,3) = 1`，最终会话为 idle 且返回真实 diff。该凭据的通用 API 推理返回余额不足，Coding Plan 推理成功；本次仅验证此模型的推理与工具能力，模型目录读取成功不代表所有模型套餐权限都已验证。测试项目与执行进程已清理，临时凭据文件已删除，交付只包含脱敏记录与明确标注的界面回放。
