# LoliCode 第三方组件

本项目保留 CC Switch/TAI Switch 基线及其原有许可与版权信息。

LoliCode 4.0.15 的新会话使用本项目的 Rust 应用内核心，默认发行版不再分发 Node、ZCode 或 OpenCode 执行引擎。桌面界面、渠道桥接和本体执行代码保留本项目及 CC Switch / TAI Switch 的许可与版权信息。

历史 4.0.14 版本采用 [ZCode](https://github.com/zai-org/ZCode) 3.15.1 执行器，固定源码提交为 `aac4755666d09fdcd70272fcf063c077a639015f`，许可 Apache-2.0。原始 Git 文件及逐文件摘要仍保存在源码的 `third-party/zcode-runtime/`；旧桥接保留在 `packages/lolicode-zcode-runtime/`，用于历史参考和专门测试。其 Node 与 npm 依赖不属于当前默认安装包。

历史 OpenCode 二进制固定为 `@opencode/cli` 2.0.12，官方源码提交 `2670273ff17da96f85c5826ced57aa1b368754fa`，仓库为 https://github.com/anomalyco/opencode，MIT 许可见 `third-party/opencode/LICENSE`。其锁定开发依赖和手动准备脚本仍保留；本版本只读读取旧会话，不启动或分发该引擎。

默认技能来自 [ZCode](https://github.com/zai-org/ZCode) 源码提交 `aac4755666d09fdcd70272fcf063c077a639015f`：skill-creator、docx、pdf、pptx、xlsx，按该提交的官方 defaultEnabled 清单默认启用。保留原始技能、脚本、引用资料和许可文件，并记录每个文件的 SHA-256；见 `third-party/zcode/manifest.json` 与 `third-party/zcode/NOTICE.md`。文档技能原始 frontmatter 与 LICENSE.txt 的不同许可标注原文保留并在 NOTICE 中解释。

MiMo-Code、DeepSeek Harness 和 Claude Code 的公开流程作为设计参考，未随本版分发其执行引擎。保留的旧 ZCode 复用范围见 `packages/lolicode-zcode-runtime/README.md`；当前本体能力与迁移边界见 `docs/guides/lolicode-inprocess-agent.md`，没有随包提供上游官方账号、云端私有服务或不可用的 Computer Use 实现。
