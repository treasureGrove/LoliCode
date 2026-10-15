# LoliCode

[English](README.md) · [日本語](README_JA.md) · [Deutsch](README_DE.md)

LoliCode 是一个共享模型渠道的桌面智能体工作台。它把模型接入、可视化配置、本地项目任务、工具执行和结果检查放在同一个应用中。

本仓库独立维护，配置底座源自 CC Switch，保留原项目来源与许可声明。

## 当前可以做什么

当前桌面实现使用 **Tauri 2、React、TypeScript 和 Rust**。从 4.0.15 起，默认编程 Agent 运行在主程序内的 Rust 核心中，不需要另装 OpenCode 或 ZCode 完整程序。

现有实现包含：

- 共享渠道、模型目录、账户授权与供应商配置。
- 编程工作台：流式会话、项目文件工具、终端执行、权限询问、取消任务和变更查看。
- 会话持久化与内容型 Skills；高级执行能力以运行时实际返回为准，配置页面存在不代表 Agent 已能执行。
- 外部 AI 工具配置管理，包括供应商预设、MCP、Skills 与提示词。
- 用量视图、桌面设置和 LoliCode 独立更新链路。

以上描述实现范围，不代表所有功能都已在所有操作系统、模型上完成验收。当前行为见[本体 Agent 说明](docs/guides/lolicode-inprocess-agent.md)，已发布版本的证据见[4.0.15 交付记录](docs/guides/lolicode-4.0.15-delivery.md)。

## 我们要做成什么

目标架构是 **Electron＋React＋自有 TypeScript 后台与 Agent 内核＋保留现有 Rust 原生服务**，面向 Windows、macOS、Linux 桌面。

产品入口采用应用中心：

1. 添加需要的应用，例如编程助手、通用工作助手、酒馆或 UE 工作台。
2. 复用已有模型渠道，完成简短的配置检查。
3. 使用推荐默认值开始任务。
4. 有需要时，再展开模型参数、工具、Skills、MCP 和工作流等高级能力。

Agent 综合参考 DSH、OpenCode、ZCode；配置延续 CC Switch 的成熟方案；UE Box、酒馆及后续项目按具体功能接入自有模块。应用共用底层服务，各自保留领域规则。

**这部分正在迁移规划中。应用中心的新使用流程、TypeScript Host、Electron 桌面壳、酒馆和 UE 能力尚不能作为已交付功能。** 接入单位是功能和组件，不是整套上游程序，也不追求兼容 DSH 插件生态。

详细范围见[架构与迁移方案](docs/guides/lolicode-platform-architecture.md)和[功能、来源与许可清单](docs/guides/lolicode-platform-capabilities.json)。

## 下载

已发布安装包请使用 [LoliCode 下载页](https://tools.treasuregrove.art/lolicode/)。现有 4.0.15 交付记录覆盖 Windows 包，macOS、Linux 的发行验收仍需单独完成。

CC Switch 上游的发布链接与安装包属于原项目，不是 LoliCode 下载。

## 本地开发与热更新

环境要求：

- Node.js 满足当前 Vite 要求：^20.19.0 或 >=22.12.0。
- pnpm 10.12.3，与 package.json 的 packageManager 保持一致。
- Rust 及对应平台的 Tauri 2 构建工具，见 [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)。

~~~sh
git clone https://github.com/treasureGrove/TAI-Switch.git
cd TAI-Switch
pnpm install --frozen-lockfile
pnpm dev
~~~

日常前端修改由 Vite 热更新；Rust 修改通过增量编译重启开发进程，不需要每次打包安装。额外监听 src-tauri 目录外的 Agent crate：

~~~sh
pnpm dev --additional-watch-folders ../crates/lolicode-agent
~~~

只有制作发行包时才运行：

~~~sh
pnpm build
~~~

目标 Electron/Host 的自动重载流程见架构文档，目前默认开发入口仍是 Tauri。

## 验证

根据修改范围运行相应检查：

~~~sh
pnpm typecheck
pnpm test:unit
cargo test --manifest-path crates/lolicode-agent/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
~~~

编译后的桌面主程序支持 --check-agent-runtime，用隔离临时项目和本机模型夹具检查原生 Agent，无需真实模型 Key。历史验收记录不能代替当前代码验证。

## 代码与数据

- src/：React 工作台、配置界面、公共组件和桌面 API。
- src-tauri/：当前桌面壳、Rust 服务、账户渠道与配置持久化。
- crates/lolicode-agent/：当前原生 Agent 核心。
- docs/guides/：架构、开发、发布和交付证据。
- third-party/：保留的上游来源及参考资料。

仓库目录沿用历史名称 TAI-Switch。默认应用数据目录为 ~/.tai-switch，便携版按对应说明保存数据。开发实例和并行应用实例不要共用生产数据目录。

## 参与开发

问题与改进建议请提交到[本仓库](https://github.com/treasureGrove/TAI-Switch)。改动需保留已有配置字段和数据兼容性，说明实际行为变化，并提供对应验证。

新增接入需写清功能、所属模块、执行目标、源码版本与许可影响。模型原生参数、多模态和工具调用语义应保留，不为统一界面削减能力。

## 来源与许可

仓库保留 [MIT 许可证](LICENSE)。配置底座来自 farion1231/cc-switch 的 479964f2ef59e291f563218ac674a1fd82dcdbd3 快照，详细来源见 [FORK_BASELINE.md](FORK_BASELINE.md)。

研究与候选接入项目包括 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[OpenCode](https://github.com/anomalyco/opencode)、[ZCode](https://github.com/zai-org/ZCode)、[UE Box](https://github.com/ueboxai/uebox) 和 [SillyTavern](https://github.com/SillyTavern/SillyTavern)。提及某个项目不代表已经包含其源码或完整程序。

复用代码保留适用的版权、许可与 NOTICE。后续采用哪些源码以及产品许可如何安排，分别记录在功能与来源清单中。
