# LoliCode 文档 / Documentation

LoliCode 是简单易用、扩展性强的二次元桌面 Agent。当前功能、开发计划与历史参考资料分别列在下面。

LoliCode is a simple, extensible desktop Agent with an anime-inspired identity. Current behavior, plans, and historical reference material are listed separately.

## 开始使用 / Start here

- 项目介绍：[中文](../README_ZH.md) · [English](../README.md) · [日本語](../README_JA.md) · [Deutsch](../README_DE.md)。
- [下载与安装包 / Downloads](https://lolicode.com/)。
- [社区与账户 / Community and account](https://lolicode.com/all)。
- 安装与更新：[中文](user-manual/zh/1-getting-started/1.2-installation.md) · [English](user-manual/en/1-getting-started/1.2-installation.md) · [日本語](user-manual/ja/1-getting-started/1.2-installation.md)。
- [更新记录 / Changelog](../CHANGELOG.md)与 [GitHub Releases](https://github.com/treasureGrove/LoliCode-Releases/releases)。
- [获取帮助 / Support](../SUPPORT.md)与[安全报告 / Security](../SECURITY.md)。

## 当前实现 / Current implementation

- [内置 Agent 的实际能力与限制](guides/lolicode-inprocess-agent.md)。
- [Agent 交互约定](guides/lolicode-agent-interactions.md)。
- [渠道中心与模型配置](CHANNEL_CENTER.md)。
- [本机记忆](architecture/agent-memory.md)、[外部模型接入](architecture/external-model-config.md)与[本机用量](guides/local-agent-usage.md)。
- [工作流、闲时任务与 CLI 市场](guides/agent-workflows-cli-adapter.md)。
- [原生 Agent 的实际 GLM 验收](architecture/native-agent-live-acceptance.md)。
- [Cherry Atelier 界面与装饰资源](guides/cherry-atelier-ui.md)。
- [4.0.15 交付记录](guides/lolicode-4.0.15-delivery.md)：该版本的历史验证证据，不替代当前版本验收。

配置管理与内置 Agent 的执行能力并不等同；具体以当前运行时能力说明为准。

Configuration support does not imply execution support in the built-in Agent.

## 开发与发布 / Development and release

- [贡献指南与热重载](../CONTRIBUTING.md)。
- [独立发布、打包与签名](guides/lolicode-release.md)。
- [应用内更新摘要格式](../src/whats-new/README.md)。
- [来源基线](../FORK_BASELINE.md)、[第三方声明](../THIRD_PARTY_NOTICES.md)与 [LICENSE](../LICENSE)。

## 规划 / Plans

以下文档包含未来方向或历史架构讨论，不代表全部能力已经交付。

These documents include future work or architectural proposals, not a list of shipped features.

- [产品愿景](guides/lolicode-product-vision.md)。
- [第一期计划](guides/lolicode-phase-one-plan.md)。
- [架构与迁移讨论](guides/lolicode-platform-architecture.md)。
- [能力、来源与许可影响清单](guides/lolicode-platform-capabilities.json)。
- [酒馆功能参考与接入边界](guides/lolicode-tavern-reference.md)。

UE 工具、酒馆、高级记忆提供者、语音及更多角色交互按阶段接入；它们尚未全部实现。本机个人/项目记忆已在当前原生核心中实现。

## 配置参考与历史资料 / Configuration reference and history

[配置参考手册](user-manual/README.md)保留了源自 CC Switch 的章节，供外部工具配置、路由、导入等功能查阅。除已更新的安装页外，部分操作和截图可能与当前 LoliCode 界面不同。旧发布说明、迁移材料和第三方版权记录保留历史语境。

The [configuration reference](user-manual/README.md) retains chapters inherited from CC Switch. Some navigation, screenshots, and capability descriptions differ from current LoliCode. Historical release notes and provenance records preserve their original context.
