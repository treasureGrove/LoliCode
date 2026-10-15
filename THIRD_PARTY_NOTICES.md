# LoliCode 第三方组件

本项目保留 CC Switch/TAI Switch 基线及其原有许可与版权信息。

LoliCode 4.0.14 的新会话采用 [ZCode](https://github.com/zai-org/ZCode) 3.15.1 的原生 CLI/runtime、Node services、V4 协议、工作流、调度和远程服务，固定源码提交为 `aac4755666d09fdcd70272fcf063c077a639015f`，许可 Apache-2.0。未经改动的原始 Git 文件、许可及逐文件摘要保存在 `third-party/zcode-runtime/`；LoliCode 桥接与构建适配位于 `packages/lolicode-zcode-runtime/` 和 `scripts/prepare-zcode-runtime.mjs`。构建清单另行记录嵌入运行时的适配变换、依赖版本、Node.js 官方校验值及资源摘要。Node.js 与依赖各自的许可证随运行资源保留。

为继续访问已有会话，应用仍分发 OpenCode 的官方 npm 平台二进制，固定版本为 `@opencode/cli` 2.0.12。官方源码对应提交 `2670273ff17da96f85c5826ced57aa1b368754fa`，仓库为 https://github.com/anomalyco/opencode，许可为 MIT。完整许可见 `third-party/opencode/LICENSE`，构建脚本也将其放入实际运行资源目录。

二进制来自固定 npm 平台包，包完整性记录在 `pnpm-lock.yaml`，实际文件摘要记录在生成的 `runtime-manifest.json`。未声称该 npm 二进制已由源码复现。

默认技能来自 [ZCode](https://github.com/zai-org/ZCode) 源码提交 `aac4755666d09fdcd70272fcf063c077a639015f`：skill-creator、docx、pdf、pptx、xlsx，按该提交的官方 defaultEnabled 清单默认启用。保留原始技能、脚本、引用资料和许可文件，并记录每个文件的 SHA-256；见 `third-party/zcode/manifest.json` 与 `third-party/zcode/NOTICE.md`。文档技能原始 frontmatter 与 LICENSE.txt 的不同许可标注原文保留并在 NOTICE 中解释。

桌面界面、共享适配库和渠道桥接为 LoliCode 本地实现。MiMo-Code、DeepSeek Harness 和 Claude Code 的公开流程作为设计参考，未随本版分发其执行引擎。ZCode 的实际源码复用范围与公开源码不具备的能力边界见 `packages/lolicode-zcode-runtime/README.md`，没有随包提供其官方账号、云端私有服务或不可用的 Computer Use 实现。
