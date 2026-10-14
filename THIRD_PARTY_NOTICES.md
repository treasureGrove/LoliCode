# LoliCode 第三方组件

本项目保留 CC Switch/TAI Switch 基线及其原有许可与版权信息。

LoliCode 的编程工作台随桌面应用分发 OpenCode 的官方 npm 平台二进制，固定版本为 `@opencode/cli` 2.0.12。官方源码对应提交 `2670273ff17da96f85c5826ced57aa1b368754fa`，仓库为 https://github.com/anomalyco/opencode，许可为 MIT。完整许可见 `third-party/opencode/LICENSE`，构建脚本也将其放入实际运行资源目录。

二进制来自固定 npm 平台包，包完整性记录在 `pnpm-lock.yaml`，实际文件摘要记录在生成的 `runtime-manifest.json`。未声称该 npm 二进制已由源码复现。

默认技能来自 [ZCode](https://github.com/zai-org/ZCode) 源码提交 `aac4755666d09fdcd70272fcf063c077a639015f`：skill-creator、docx、pdf、pptx、xlsx，按该提交的官方 defaultEnabled 清单默认启用。保留原始技能、脚本、引用资料和许可文件，并记录每个文件的 SHA-256；见 `third-party/zcode/manifest.json` 与 `third-party/zcode/NOTICE.md`。文档技能原始 frontmatter 与 LICENSE.txt 的不同许可标注原文保留并在 NOTICE 中解释。

桌面界面、共享适配库和渠道桥接为 LoliCode 本地实现。ZCode 的布局与权限交互、MiMo-Code、DeepSeek Harness 和 Claude Code 的公开流程作为设计参考，具体复用范围见 `docs/LOLICODE_AGENT.md`；没有将这些项目的整个引擎并入或随本版分发。
