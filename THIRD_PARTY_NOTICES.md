# Lolicode 第三方组件

本项目保留 CC Switch/TAI Switch 基线及其原有许可与版权信息。

Lolicode 的编程工作台随桌面应用分发 OpenCode 的官方 npm 平台二进制，固定版本为 `@opencode/cli` 2.0.12。官方源码对应提交 `2670273ff17da96f85c5826ced57aa1b368754fa`，仓库为 https://github.com/anomalyco/opencode，许可为 MIT。完整许可见 `third-party/opencode/LICENSE`，构建脚本也将其放入实际运行资源目录。

二进制来自固定 npm 平台包，包完整性记录在 `pnpm-lock.yaml`，实际文件摘要记录在生成的 `runtime-manifest.json`。未声称该 npm 二进制已由源码复现。

桌面界面、共享适配库和渠道桥接为 Lolicode 本地实现。ZCode、MiMo-Code、DeepSeek Harness 和 Claude Code 的公开流程作为设计参考，具体来源与本轮复用范围见 `docs/LOLICODE_AGENT.md`；没有将这些项目的整个引擎并入或随本版分发。
