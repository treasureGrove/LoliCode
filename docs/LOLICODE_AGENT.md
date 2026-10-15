# LoliCode 编程工作台

LoliCode 将已有渠道与模型配置接到桌面 coding agent。选择项目、模型和“实现”或“分析”模式，输入任务即可开始。4.0.14 的新会话使用固定源码的 ZCode 3.15.1 原生运行时；旧 OpenCode 会话按原引擎标识保留，不自动迁移或重新执行。桌面界面与后续 CLI 共用宿主接口。

4.0.12 使用奶油白、莓粉和薰衣草的女仆主题，支持对应深色模式。欢迎区展示透明吉祥物立绘，导航、聊天和桌面图标使用配套小头像。功能名称与代码、权限信息保持清晰。形象资源与生成提示词见 `src/assets/brand/README.md`。

![4.0.12 欢迎页界面演示](images/lolicode/maid/maid-welcome-light-1000x650.png)

![4.0.12 技能弹窗界面演示](images/lolicode/maid/maid-skills-light-1000x650.png)

## 使用

4.0.13 在左侧提供“软件更新”入口，进入后可手动检查并一键下载安装、重启。默认启动后和每 6 小时检查一次；设置中可关闭自动检查，下载与安装始终由用户点击。安装前校验 LoliCode 专用签名，并检查宿主已知项目会话是否执行中、排队或等待权限/问题，忙碌或检查失败时保留当前应用供稍后重试。

更新清单与下载页位于 [工具站 LoliCode](https://tools.treasuregrove.art/lolicode/)。4.0.12 尚未启用此更新链路，需要先手动安装 4.0.13；此后安装版支持应用内升级。带 `portable.ini` 的便携版从更新入口打开下载页，下载新 ZIP 后手动替换，保留自己的数据。发布流程与签名维护见 `guides/lolicode-release.md`。

1. 在“渠道与模型”加入 API 或已支持聚合的订阅账号，保存需要使用的模型。
2. 进入“编程工作台”，选择本机项目文件夹。
3. 选择模型，使用“实现”模式修改代码，或使用“分析”模式先探索与规划。
4. 描述任务。文字实时更新，工具操作可以展开查看，实际文件改动从“查看改动”打开。
5. 在输入框下方选择“逐次确认”、Auto 或“完整访问”。工具需要权限或补充信息时，在当前会话内应答。原生要求单次确认的操作无法选择永久记住；危险命令及涉及路径直接显示在权限卡中。
6. 点击停止会请求引擎中断，界面等待真实终态；已经收到的内容保留。切换到渠道页不会停止后台任务。

项目会话保存在 LoliCode 自有数据目录中，可以重新打开并继续。项目与会话支持搜索、置顶，会话支持重命名、归档、恢复与删除；移出项目列表保留磁盘文件和引擎中的历史。未发送文本按项目和会话隔离保存在桌面会话缓存中。任务结束或停止后，输入框的模型选择器直接更新当前会话，后续消息使用新模型。实现/分析和权限模式同样写入真实引擎会话，执行中禁止切换。

同一私有宿主支持多个项目；切换项目、会话或渠道页面时，后台任务继续。渠道保存、页面重新打开及回到前台会检查目录版本并自动同步，仍可点击“刷新模型目录”。存在后台任务时延迟同步，沿用已绑定的目录；刷新会等待实际 CLI 完成配置应用。扩展修改后按面板提示重新载入。

项目内生成的 PNG、JPEG、GIF、WebP、BMP、AVIF 和安全 SVG 可直接在聊天中预览、放大及关闭。相对路径、项目内绝对路径和本地图片链接均支持；项目之外或超过 10 MB 的图片显示明确提示，不扩大整个 WebView 的文件访问范围。

“技能与插件”弹窗右上角提供关闭按钮，底部提供“返回工作台”，Esc 同样可以关闭；初始加载和保存等待都不会锁住关闭入口。Windows 与启用应用内窗口按钮的 Linux 在弹窗底部提供可访问的窗口操作，沿用原来的关闭到托盘设置。关闭弹窗不等于撤销已经提交的保存；重新打开时，旧请求不会覆盖新视图。

拒绝权限由原生运行时作为工具拒绝结果交回当前轮，模型可以据此继续说明或选择其他操作；应用重启不会重新执行旧任务。模式切换的原生上下文提醒留给下一次输入。历史通过真实 V4 分页加载，读取失败与容量截断均显示系统提示，不能把不完整历史伪装成完整记录。

## 权限

新会话的“逐次确认”对应 ZCode 原生 build，Auto 对应 guarded，“完整访问”对应 yolo；权限判定由原生执行器负责。Guarded 可直接执行安全读取，危险操作仍要求单次确认，后端也拒绝将其升级为永久授权。旧 OpenCode 会话继续采用旧引擎规则。

“分析”使用独立的原生 Plan 状态，不能被权限模式选择覆盖；写入等操作按照原生 Plan 规则拦截。完整访问按原生 yolo 规则执行。插件是用户主动安装的程序，工具权限不等于操作系统沙箱。

## 默认技能与扩展

内置并默认启用 ZCode 官方默认清单的五项技能：`skill-creator`、`docx`、`pdf`、`pptx`、`xlsx`。完整原文、脚本、参考文件及许可来自固定源码提交 `aac4755666d09fdcd70272fcf063c077a639015f`，每文件摘要见 `third-party/zcode/manifest.json`。入口在“技能与插件”，支持启停、使用技能、导入自己的技能目录，以及删除本地导入项。禁用项重新载入后从引擎目录移除；默认技能可以关闭，不删除随应用提供的资源。

默认清单以 [ZCode 官方插件定义](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts) 为依据。原生 dynamic-workflows 执行器按 onDemand 启用，运行已保存工作流使用真实 V4 命令，支持查看运行结果及从真实运行保存脚本。

技能随包提供内容，不自动安装它们所需的 Python、Node.js、LibreOffice、Poppler 或其他库。各项依赖在技能面板显示；文档生成、渲染与校验依赖本机环境。技能发现与真实激活单独验证，不将“已加载”当作文档转换全部通过。

新会话的扩展页使用 ZCode 原生插件管理服务，支持本地技能、原生插件安装、启停和卸载，以及 MCP 服务器配置。常用远程 MCP 使用名称、地址和可选 Token 表单；敏感配置返回界面时遮蔽，未修改的遮蔽项保留真实凭据。配置启用状态与原生会话实际加载状态分别显示。

ZCode 的 [UI Plugins / MCP Apps](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/UI_PLUGIN.en.md) 的 HTML 内嵌展示宿主尚未接入；普通 MCP 工具与原生本地插件管理已接入。旧 OpenCode JavaScript 插件不能冒充 ZCode 原生插件。

## 工作流、自动化与远程项目

从工作台侧栏打开“工作流、自动化与远程项目”。工作流页读取项目或全局的原生已保存工作流，可查看脚本、填写参数并运行；也可以先让 Agent 按任务生成工作流。运行使用真实原生命令与持久结果，不以合成聊天提示代替执行。

自动化页选择每天、每周或每小时及具体时间，填写任务和模型后保存；无需填写 Cron。应用运行且渠道可用时按计划执行，支持立即运行、暂停与查看真实运行结果。派发成功与任务完成分别记录；重启保留任务和终态历史，已完成任务不会因重启重跑。

SSH / WSL 页可以连接、选远端目录、创建会话、发任务、停止以及回应原生权限和问答，远程会话在该面板操作，主聊天仍显示本地项目。远程运行组件目前提供 Linux x64 / glibc 2.34 及以上，WSL 需要相应发行版；macOS、Linux arm64 和 Windows 远端暂不提供运行组件。上游账号凭据不发送到远端，推理通过独立认证的 stdio 中继。远程连接沿用连接时的渠道目录；渠道变更和安装更新前应先断开远程连接，再重新连接。

Git 项目提供引擎快照与文件 diff，需要本机可用的 Git。普通文件夹也可以聊天和读写文件，通过工具输出查看执行结果；项目是否初始化 Git 由用户决定。

Claude 和 Gemini 的原生订阅入口只供各自官方 CLI 使用，不能当作这个 agent 的可用模型。API、Copilot、ChatGPT、xAI、ZCode 渠道沿用统一网关的适配与凭据刷新逻辑，实际套餐权限仍由上游决定。

## 代码边界

- `packages/lolicode-zcode-runtime/src/`：原生 Host、V4 会话桥接、工作流、持久自动化、远程连接和扩展适配。
- `src-tauri/src/services/zcode_agent.rs`：私有 Node 生命周期、认证 IPC、渠道租约及更新期间的任务保护。
- `src-tauri/src/commands/agent_dispatch.rs`：按会话引擎路由 IPC，保留旧会话；`agent_images.rs` 负责项目内图片预览。
- `crates/lolicode-agent/`、`services/agent.rs`、`agent_preferences.rs`、`agent_policy.rs`、`agent_extensions.rs`：已有 OpenCode 会话与兼容 DTO，继续保留历史及原引擎规则。
- `src-tauri/src/services/channel_center.rs`：原目录的不可变版本、agent 私有配置投影及共享网关运行保护，不调用外部客户端配置写入器。
- `src/components/agent/` 与 `src/hooks/useAgentSnapshot.ts`：项目选择、聊天、执行状态、权限、问题与实际 diff 展示。
- `scripts/prepare-agent-runtime.mjs`：从锁定的 npm 平台包准备随应用分发的引擎与许可。
- `scripts/prepare-zcode-runtime.mjs`、`prepare-zcode-remote-runtime.mjs`：校验固定源码、依赖与 Node 来源，构建私有运行资源及独立 Linux 远程资源。

新引擎固定为 ZCode 3.15.1 / `aac4755666d09fdcd70272fcf063c077a639015f`，使用真实 V4 命令、持久日志、流式帧与分页历史。原始 Git 文件不修改；嵌入构建仅为只读 workspace 展示读取增加同步 Registry 刷新屏障，防止渠道已保存而现有 CLI 仍使用旧模型目录。精确变换、输入摘要和资源摘要写入构建清单。

引擎以独立子进程启动，监听本机临时端口并使用每次启动生成的认证密码。stdin 管道归宿主管理，应用退出时关闭执行引擎。配置、数据库、缓存、临时目录及 home 读取范围置于 LoliCode 自有目录；不导入用户另一个 OpenCode 实例的账号、配置或会话。短期上游凭据留在原认证管理器中，agent 配置只引用本地网关，聊天模型选择器不接收 Key。

流式文字来自真实 V4 订阅，持久消息与实际改动来自原生日志查询。提交前持久化请求身份，未知 ACK 使用同一请求对账和重试；迟到 ACK 不会清掉后来编辑的新草稿。界面提交成功只表示入队，任务完成以原生终态为准。未来 CLI 复用宿主与原生执行模块；此轮交付桌面入口，尚未增加 LoliCode CLI/TUI。

## 开源来源

实际随应用复用并分发的主引擎是 [ZCode 3.15.1 固定源码](https://github.com/zai-org/ZCode/tree/aac4755666d09fdcd70272fcf063c077a639015f)，Apache-2.0 许可、上游 NOTICE 和逐文件摘要在 `third-party/zcode-runtime/`。旧会话继续使用 [OpenCode v2.0.12](https://github.com/anomalyco/opencode/tree/2670273ff17da96f85c5826ced57aa1b368754fa)，MIT 许可保留。

ZCode 的五项默认技能与运行时自带内容插件随本版本分发，许可、原始来源和逐文件摘要见 `third-party/zcode/` 与 `third-party/zcode-runtime/`。其他项目仅作设计参考：

- [ZCode 取消时保存流式内容](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/cancelled-stream-persistence.ts)与[持久事件 reducer](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/contracts/src/events/event-reducer.ts)：保留中断前输出，等待真实结束事件，按持久状态恢复会话。
- [MiMo-Code 记忆路径](https://github.com/XiaomiMiMo/MiMo-Code/blob/e27e87de81a74db5475bd93540f8889dfbc70ec6/packages/cli/src/memory/paths.ts)与[checkpoint 布局](https://github.com/XiaomiMiMo/MiMo-Code/blob/e27e87de81a74db5475bd93540f8889dfbc70ec6/packages/cli/src/session/checkpoint-paths.ts)：项目身份与会话状态分开组织。LoliCode 本版提供项目会话隔离，尚未实现 MiMo 的记忆蒸馏或自我改进系统。
- [DeepSeek Harness 桌面与事件架构](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/architecture.md)与[生命周期清理](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/cordis-tutorial/02-lifecycle-and-effects.md)：固定运行时、宿主管生命周期，UI 消费协议。此轮保持模块边界，未引入 Cordis 插件系统。
- [Claude Code 的公开工作流](https://code.claude.com/docs/en/common-workflows)：项目上下文、分析/实现、测试结果、恢复会话与改动查看。官方 CLI 的[许可](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)指向商业条款，此轮没有复制或分发其执行引擎。

## 验证

验证区分 UI 模拟接口、Rust 离线协议回归和固定真实引擎配合本机假模型的临时项目验证。示例截图不能作为真实上游授权或付费推理成功的证据。交付清单记录本轮实际执行的检查和产物校验值。

4.0.14：前端 240 个文件、2861 项及 TypeScript 检查通过；Rust 后端 3696 项通过、10 项忽略，独立 core 34 项通过；原生适配 49 项、构建与签名发布格式 23 项通过。真实本地运行时验证模型热重载、重复提交幂等、Guarded 危险单次确认、Plan 拒写与退出 Plan 时展示并批准真实计划、分页历史、实际 diff、重启、工作流、自动化终态与更新排他。实际 Linux x64 SSH 验证独立部署目录、7 组件校验、PTY/搜索工具、远程 draft、原生 Read 工具结果经认证中继回到假模型及真实成功终态。全部本轮模型调用使用本机假模型，付费调用为零。UI 截图区分为 Chromium 模拟 IPC 验收；WSL/Docker/其他架构未声称实机通过。逐项证据与执行时 worker 摘要见 `images/lolicode/zcode/acceptance.json` 及其引用的报告。

开发时先执行 `pnpm install` 与 `pnpm prepare:agent-runtime`。独立执行模块的回归用 `cargo test --manifest-path crates/lolicode-agent/Cargo.toml`；完整桌面回归用 `pnpm typecheck`、`pnpm test:unit` 与 `cargo test --manifest-path src-tauri/Cargo.toml --lib`。

真实引擎的离线临时项目检查：`cargo run --manifest-path src-tauri/Cargo.toml --example lolicode_agent_smoke`；扩展用 `cargo run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_agent_extensions_smoke`，桌面行为用 `cargo run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_agent_host_smoke`。需要明确授权的真实智谱测试使用 `cargo run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_agent_glm_smoke -- --key-file <私有临时凭据文件的绝对路径> --out <脱敏结果文件的绝对路径>`。真实测试只操作自己创建的临时项目，经过生产渠道网关；不自动导入这份凭据到用户渠道配置。

Windows 安装包已包含运行资源及 Node。便携版须保留 `LoliCode.exe`、`portable.ini`、`agent/` 和 `zcode-runtime/`，包括其二进制、许可与资源清单。

4.0.10 基线验证：前端 227 个文件、2726 项测试通过，桌面 Rust 后端 3666 项测试通过、10 项忽略，独立 Rust core 的 17 项回归通过。4.0.11 的检查结果另记在交付清单；安装包使用默认 features，`test-hooks` 仅为隔离验证增加测试入口。固定真实引擎配合本机假模型的原六项检查涵盖写文件、流式文字、实际 diff、分析模式拒写、真实中断与重启恢复。

4.0.11 验证：前端 229 个文件、2750 项测试通过，TypeScript 检查通过；桌面 Rust 全套 3677 项通过、10 项忽略，收尾后定向 agent 回归 50 项通过；独立 core 最终 34 项全部通过。真实引擎在自己的临时项目中验证了五项技能发现、原生技能激活、插件启动、MCP 实际调用与禁用重载，还验证了生产 IPC 的已载入标注。桌面宿主验证了 Auto 后台批准、未知 shell 人工确认、拒绝后继续聊天、Ask/Plan、当前模型与模式切换、导航信息持久化、删除与关闭，以及拒绝后同数据库重启不产生任何新的模型调用。上述本轮引擎检查使用本机假模型，不新增付费推理；截图中的 GLM 会话是下述历史真实结果的明确标注回放。

已使用用户授权的智谱凭据经生产渠道网关验证 `glm-5.3-flash`：真实读取并修改临时 Git 项目的 `sum.js`，将减法修成加法，Node 验证 `add(2,3) = 5` 和 `add(-2,3) = 1`，最终会话为 idle 且返回真实 diff。该凭据的通用 API 推理返回余额不足，Coding Plan 推理成功；本次仅验证此模型的推理与工具能力，模型目录读取成功不代表所有模型套餐权限都已验证。测试项目与执行进程已清理，临时凭据文件已删除，交付只包含脱敏记录与明确标注的界面回放。

4.0.12 验证：前端 230 个文件、2766 项测试通过，TypeScript 检查通过。关闭回归覆盖初始加载、保存、重载与迟到回复：关闭入口始终可用，跨重开周期的实际修改保持串行，未提交的迟到文件选择/配置读取不会再发起写入。浏览器检查确认 1000 × 650 欢迎页和技能弹窗、1280 × 940 浅深色聊天与 diff 均可读；X、Esc、底部返回、等待中关闭、焦点恢复及窗口关闭 IPC 调用通过。窗口动作使用隔离 mock，不是原生桌面运行截图；聊天截图回放之前的实际 GLM 记录，没有新增付费调用。该轮未改变 Rust 执行逻辑，后端行为验证沿用上面的 4.0.11 基线。

4.0.13 验证：前端 234 个文件、2793 项通过，TypeScript 通过；桌面 Rust 3684 项通过、10 项忽略，增加便携模式的安装保护后又编译并通过 12 项设置回归。更新页 13 项浏览器检查、下载页 30 项检查通过，均明确标注模拟接口。正式签名包上线后，官方 Tauri SDK 经隔离 MockRuntime 从公开候选清单下载完整安装器并验签，87020838 字节及 SHA256 与本轮包完全一致；默认更新地址另行通过实际检查。六项本机 HTTP 负例包括篡改包被拒绝，均未调用安装或退出回调。公网安装版/便携包完整下载、哈希核对和安装版验签通过，已发布清单与验证后的候选逐字节一致，真实下载页无脚本错误。证据位于 `images/lolicode/updates/`；本轮没有执行 NSIS 安装器、重启用户应用、读取用户账号配置或新增付费推理。
