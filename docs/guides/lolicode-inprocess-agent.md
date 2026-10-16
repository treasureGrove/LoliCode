# LoliCode 本体 Agent

从 4.0.15 起，桌面默认入口使用 `crates/lolicode-agent/src/native` 的 `NativeEngine`。它是链接进主程序的 Rust 库，通过 Tokio 任务运行；没有独立 Agent 可执行文件、标准输出握手或 Node 载体。

桌面职责分布：

- `agent_dispatch` 保持渲染层 IPC 合同，并拒绝修改退役引擎会话。
- `inprocess_agent` 管理应用生命周期、项目切换、更新时的空闲锁及技能同步。
- `agent_host` 提供共享桌面数据合同和账户验证；`channel_center` 生成固定版本模型目录与私有网关绑定。
- `native/engine` 管理任务、权限、问答、请求回执、取消和累计差异；`inference` 消费兼容 Chat Completions 的 JSON / SSE 回复。
- `native/tools` 在项目边界内执行文件操作；只有终端工具启动系统命令。Windows 命令及后代进入独立 Job Object，取消或超时后回收；无法确认回收时停止接收新任务和更新。
- `native/persistence` 原子保存本体会话。重启修复中断的消息协议，但绝不自动重放工具。
- `inprocess_extensions` 校验和准备内容技能，正文由 `read_skill` 按需读取；JS 插件与 MCP 尚不执行。
- `agent_history` 从只读副本读取旧 OpenCode 数据，保留源数据库及其 WAL / SHM；旧 ZCode 数据尚未接入历史读取。

模型上下文和推理档位只从上游模型目录公开的元数据自动读取；已兼容常见的上下文字段名。未公开上下文的模型保留为“未知”，不会被伪装成 8K 窗口并在请求前误拦截；请求仍交由上游处理其实际窗口限制。

新会话 ID 为 `lc:<UUID>`。公共快照保留现有 `AgentSnapshot` 结构；完整文件基线、模型网关令牌与内部模型历史不通过公共 IPC 暴露。网关绑定仅允许应用内 `127.0.0.1` HTTP 地址，并禁用重定向和系统代理。上游 Key 留在渠道中心。

4.0.18 在这套核心上接入了可编辑的[本机记忆](../architecture/agent-memory.md)，以及[Markdown 工作流、定时/闲时任务和 CLI 技能市场](agent-workflows-cli-adapter.md)，共用现有权限、取消、回执和更新空闲检查。支持的自动思考档位优先 medium、其次 high；运行中模型/强度修改在下一次模型请求生效，已发出的请求保持原配置。

远程项目、通用 JavaScript/MCP 宿主与高级记忆提供者仍需分别接入。当前能力以核心 `capabilities` / `activity.features` 返回值为准；未迁入功能不会回退启动旧引擎。外部应用配置和日志用量的边界分别见[模型接入](../architecture/external-model-config.md)与[本机用量](local-agent-usage.md)。

默认构建只执行 `prepare:agent-assets` 并打包校验后的技能及许可证内容。保留的旧引擎源码和手动准备脚本用于历史参考与专门测试，不是默认发行版的运行依赖。

本地开发直接运行 `pnpm dev`：Tauri 启动桌面壳，Vite 提供前端热更新；修改 Rust 后由 Tauri 触发增量编译。`pnpm build` 用于生成发行安装包，日常调试 UI 或 Agent 逻辑不需要反复打包。

主程序提供隔离自检 `--check-agent-runtime`：在包含中文和空格的临时项目中走本机模型夹具、真实文件读写、工具续接和重启恢复，验证默认内容资源。该路径在桌面初始化之前执行，不读取用户设置、不启动引擎进程、也不消费上游额度。
