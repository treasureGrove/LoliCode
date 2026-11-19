# LoliCode

[English](README.md) · [日本語](README_JA.md) · [Deutsch](README_DE.md)

**和二次元桌宠小笨狗一起写代码。LoliCode 是桌面编程 Agent Harness，接入你选的模型，在自己的项目里运行工具、检查测试结果和审阅改动。**

打开项目，让 Agent 读取文件、运行测试，再看具体改了哪几行。也可以把 GitHub Issue 交给 Loli 秘书，在独立工作树里处理，审阅后创建草稿 PR。桌宠会在需要你授权或回答时指向对应任务。

[下载 Windows 版](https://github.com/treasureGrove/LoliCode-Releases/releases/latest) · [观看小笨狗的 43 秒工作台演示](https://lolicode.com/#film) · [秘书如何处理 Issue](docs/guides/lolicode-secretary.md#接收和回复-github-工作) · [文档](docs/README.md)

<a href="https://lolicode.com/#film">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/treasureGrove/LoliCode/main/docs/images/lolicode/companion-tour-still.webp">
    <img src="docs/images/lolicode/companion-tour.webp" width="896" height="504" alt="跟着桌宠小笨狗打开待授权的任务、查看工具调用和代码差异，点击观看完整演示">
  </picture>
</a>

## 现在可以做什么

- **一个主 Agent 工作台**：流式对话、项目文件读写、终端工具、权限确认、提问与选项、停止任务、会话历史和文件变更查看。
- **统一模型与渠道**：管理 API 渠道及支持的账户授权，获取模型目录，选择模型和可用参数。上下文、思考强度等能力取决于上游实际提供的信息与支持情况。
- **集中配置**：将共享模型配置到支持的外部工具，包括 WorkBuddy、DeepSeek Harness、ZCode 和 MiMo，保留原配置并逐项显示结果。
- **记忆与重复任务**：编辑、关闭个人和项目本机记忆，保存 Markdown 工作流、安排定时或闲时任务，按需使用校验后的 CLI 技能。CLI 本体与账户需另行配置，尚不执行通用 JS/MCP 插件。
- **有角色气质的桌面**：二次元主题、粉毛 Q 版看板娘、紧凑工具进度和文件侧栏预览。
- **用量与更新**：查看已记录用量，检查 LoliCode 独立发布的更新。社区账户与模型渠道账户互相独立。

桌面界面使用 **React 和 TypeScript**。**DeepSeek Harness** 运行 Agent 执行循环，**Tauri 2 和 Rust** 提供文件、终端、权限和模型网关等宿主能力。[查看运行架构](ARCHITECTURE.md)

Windows、macOS、Linux 都是产品目标。目前公开提供 **Windows x64 NSIS 安装版和便携 ZIP**，macOS 与 Linux 尚未发布安装包。每个版本的验证范围以发布记录为准。

## 安装与开始使用

1. 从 [LoliCode 下载官网](https://lolicode.com/)获取对应系统的安装包。
2. 在「渠道与模型」添加渠道并选择模型。
3. 在「工作台」打开项目文件夹，描述任务，按需查看权限和文件变更。

左下角头像菜单里的「软件更新」或更新入口可以检查新版。安装版使用 [LoliCode 签名更新源](https://tools.treasuregrove.art/lolicode/updates/stable.json)；便携版请按下载页及发布说明替换程序文件，并保留自己的数据。

LoliCode 为兼容已有数据，继续使用历史目录 `~/.tai-switch`。迁移或替换安装前可查看[安装指南](docs/user-manual/zh/1-getting-started/1.2-installation.md)。

## 后续方向

酒馆已经支持角色卡和对话。后续方向包括更深入的 Unreal Editor 集成、高级记忆、语音和更多桌宠交互。

上述能力尚未全部交付。接入以功能和组件为单位，不把参考项目的整套程序搬进来。详见[产品愿景](docs/guides/lolicode-product-vision.md)、[第一期计划](docs/guides/lolicode-phase-one-plan.md)和[能力与来源清单](docs/guides/lolicode-platform-capabilities.json)。

## 本地开发与热重载

使用 `.node-version` 指定的 Node.js（Harness 要求 24.9+）、pnpm 10.12.3、`rust-toolchain.toml` 指定的 Rust 工具链及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。维护入口见[架构与目录](ARCHITECTURE.md)和 [LoliCode 工作区](LoliCode.code-workspace)。

```sh
git clone https://github.com/treasureGrove/LoliCode.git
cd LoliCode
pnpm install --frozen-lockfile
pnpm prepare:harness-runtime
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

问题与建议请提交到 [LoliCode Issues](https://github.com/treasureGrove/LoliCode/issues)。也可以浏览[社区与账户](https://lolicode.com/all)、[更新记录](CHANGELOG.md)、[获取帮助](SUPPORT.md)、[安全策略](SECURITY.md)与[行为准则](CODE_OF_CONDUCT.md)。

LoliCode 独立维护，配置基础源自 CC Switch。原始 [MIT 许可证](LICENSE)、版权声明和[基线记录](FORK_BASELINE.md)继续保留；其他复用组件见[第三方声明](THIRD_PARTY_NOTICES.md)。参考某个项目不代表已经集成其完整应用或兼容其全部插件生态。
