# LoliCode

[English](README.md) · [日本語](README_JA.md) · [Deutsch](README_DE.md)

**简单易用、扩展性强的二次元美少女 Agent。**

LoliCode 把桌面编程 Agent、统一模型渠道和二次元工作空间放在一起。选好模型、打开文件夹就能开始；需要更多能力时，再探索高级配置。

[下载官网](https://lolicode.com/) · [社区与账户](https://lolicode.com/all) · [源码仓库](https://github.com/treasureGrove/LoliCode) · [文档](docs/README.md) · [更新记录](CHANGELOG.md)

维护代码先读[架构与目录入口](ARCHITECTURE.md)；用 [LoliCode.code-workspace](LoliCode.code-workspace) 打开工程，可收起依赖、构建产物和日志。

## 现在可以做什么

- **一个主 Agent 工作台**：流式对话、项目文件读写、终端工具、权限确认、提问与选项、停止任务、会话历史和文件变更查看。
- **统一模型与渠道**：管理 API 渠道及支持的账户授权，获取模型目录，选择模型和可用参数。上下文、思考强度等能力取决于上游实际提供的信息与支持情况。
- **集中配置**：将共享模型配置到支持的外部工具，包括 WorkBuddy、DeepSeek Harness、ZCode 和 MiMo，保留原配置并逐项显示结果。
- **记忆与重复任务**：编辑、关闭个人和项目本机记忆，保存 Markdown 工作流、安排定时或闲时任务，按需使用校验后的 CLI 技能。CLI 本体与账户需另行配置，尚不执行通用 JS/MCP 插件。
- **有角色气质的桌面**：二次元主题、粉毛 Q 版看板娘、紧凑工具进度和文件侧栏预览。
- **用量与更新**：查看已记录用量，检查 LoliCode 独立发布的更新。社区账户与模型渠道账户互相独立。

当前采用 **Tauri 2、React、TypeScript 与 Rust**，默认 Agent 在应用内 Rust 核心运行，不要求另装 OpenCode 或 ZCode。具体边界见[当前 Agent 能力说明](docs/guides/lolicode-inprocess-agent.md)。

Windows、macOS、Linux 都是产品目标。目前公开提供 **Windows x64 NSIS 安装版和便携 ZIP**，macOS 与 Linux 尚未发布安装包。每个版本的验证范围以发布记录为准。

## 安装与开始使用

1. 从 [LoliCode 下载官网](https://lolicode.com/)获取对应系统的安装包。
2. 在「渠道与模型」添加渠道并选择模型。
3. 在「工作台」打开项目文件夹，描述任务，按需查看权限和文件变更。

左下角头像菜单里的「软件更新」或更新入口可以检查新版。安装版使用 [LoliCode 签名更新源](https://tools.treasuregrove.art/lolicode/updates/latest.json)；便携版请按下载页及发布说明替换程序文件，并保留自己的数据。

LoliCode 为兼容已有数据，继续使用历史目录 `~/.tai-switch`。迁移或替换安装前可查看[安装指南](docs/user-manual/zh/1-getting-started/1.2-installation.md)。

## 后续方向

围绕同一个主 Agent，逐步接入 **UE 工具应用**和**酒馆式角色交互应用**。它们是并列业务应用，按需共享 Agent 能力。高级记忆提供者、语音、更多看板娘交互，以及侧重前端和 3D 的轻量模型 **sillyDog（小笨狗，暂定名）**，也在后续方向中。

上述能力尚未全部交付。接入以功能和组件为单位，不把参考项目的整套程序搬进来。详见[产品愿景](docs/guides/lolicode-product-vision.md)、[第一期计划](docs/guides/lolicode-phase-one-plan.md)和[能力与来源清单](docs/guides/lolicode-platform-capabilities.json)。

## 本地开发与热重载

准备 Node.js 22.12+（或 Vite 支持的版本）、pnpm 10.12.3、`rust-toolchain.toml` 固定的 Rust 工具链及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
git clone https://github.com/treasureGrove/LoliCode.git
cd LoliCode
pnpm install --frozen-lockfile
pnpm dev
```

前端由 Vite 热更新；Rust 修改后增量编译并重启开发进程，无需重新制作安装包。同时监听 Agent crate：

```sh
pnpm dev --additional-watch-folders ../crates/lolicode-agent
```

需要可直接点击的 Windows 开发版入口时，运行：

```sh
pnpm build
```

构建成功后会安装 **LoliCode Dev** 到 `%LOCALAPPDATA%\Programs\LoliCode Dev`，并在桌面和 Windows 开始菜单创建 **LoliCode 开发版**。每次构建显示 `DEV-20261028-174243` 形式的开发号及源码版本。这个入口打开最后一次成功构建的程序；需要实时热重载时使用 `pnpm dev`。开发版数据使用独立的 `~/.lolicode-dev`，不安装正式渠道更新；官网下载的 **LoliCode** 继续使用原安装目录和 `~/.tai-switch` 数据。

正式安装包验收与签名使用 `pnpm build:release`。远端 [开发构建](https://github.com/treasureGrove/LoliCode/actions/workflows/development.yml) 的产物明确标注 **Development**，公开正式下载仍在 [LoliCode Releases](https://github.com/treasureGrove/LoliCode-Releases/releases)。入口注册和渠道说明见[开发指南](docs/guides/lolicode-development.md)。

常用验证：

```sh
pnpm typecheck
pnpm test:unit
pnpm build:renderer
cargo test --manifest-path crates/lolicode-agent/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

开发约定见[贡献指南](CONTRIBUTING.md)，打包与签名见[发布指南](docs/guides/lolicode-release.md)。

## 反馈、来源与许可

问题与建议请提交到 [LoliCode Issues](https://github.com/treasureGrove/LoliCode/issues)。另见[获取帮助](SUPPORT.md)、[安全策略](SECURITY.md)与[行为准则](CODE_OF_CONDUCT.md)。

LoliCode 独立维护，配置基础源自 CC Switch。原始 [MIT 许可证](LICENSE)、版权声明和[基线记录](FORK_BASELINE.md)继续保留；其他复用组件见[第三方声明](THIRD_PARTY_NOTICES.md)。参考某个项目不代表已经集成其完整应用或兼容其全部插件生态。
