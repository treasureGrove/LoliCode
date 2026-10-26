# LoliCode 第三方组件

手机仅直连使用 [webrtc-rs/webrtc 0.17.2](https://github.com/webrtc-rs/webrtc/tree/v0.17.2)
原生 Rust 数据通道（MIT / Apache-2.0）；固定官方标签的两份原始许可随安装版和
便携版保留在 `licenses/companion/`。Android 使用 Maven Central 的
`io.github.webrtc-sdk:android:150.7871.04`（BSD-3-Clause），完整上游 WebRTC
第三方声明随 APK assets 保留。服务器可独立运行 coturn 的 STUN-only 辅助服务，
不随桌面包分发，不启用 TURN。

本项目保留上游 CC Switch 基线及其原有许可与版权信息。

LoliCode 4.0.15 的新会话使用本项目的 Rust 应用内核心，默认发行版不再分发 Node、ZCode 或 OpenCode 执行引擎。桌面界面、渠道桥接和本体执行代码保留本项目及上游 CC Switch 的许可与版权信息。

历史 4.0.14 版本采用 [ZCode](https://github.com/zai-org/ZCode) 3.15.1 执行器，固定源码提交为 `aac4755666d09fdcd70272fcf063c077a639015f`，许可 Apache-2.0。原始 Git 文件及逐文件摘要仍保存在源码的 `third-party/zcode-runtime/`；旧桥接保留在 `packages/lolicode-zcode-runtime/`，用于历史参考和专门测试。其 Node 与 npm 依赖不属于当前默认安装包。

历史 OpenCode 二进制固定为 `@opencode/cli` 2.0.12，官方源码提交 `2670273ff17da96f85c5826ced57aa1b368754fa`，仓库为 https://github.com/anomalyco/opencode，MIT 许可见 `third-party/opencode/LICENSE`。其锁定开发依赖和手动准备脚本仍保留；本版本只读读取旧会话，不启动或分发该引擎。

默认技能来自 [ZCode](https://github.com/zai-org/ZCode) 源码提交 `aac4755666d09fdcd70272fcf063c077a639015f`：skill-creator、docx、pdf、pptx、xlsx，按该提交的官方 defaultEnabled 清单默认启用。保留原始技能、脚本、引用资料和许可文件，并记录每个文件的 SHA-256；见 `third-party/zcode/manifest.json` 与 `third-party/zcode/NOTICE.md`。文档技能原始 frontmatter 与 LICENSE.txt 的不同许可标注原文保留并在 NOTICE 中解释。

MiMo-Code、DeepSeek Harness 和 Claude Code 的公开流程作为设计参考，未随本版分发其执行引擎。保留的旧 ZCode 复用范围见 `packages/lolicode-zcode-runtime/README.md`；当前本体能力与迁移边界见 `docs/guides/lolicode-inprocess-agent.md`，没有随包提供上游官方账号、云端私有服务或不可用的 Computer Use 实现。

4.0.18 的本机记忆参考 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的有界双存储、工具整理与上下文快照设计，核验提交为 `848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c`（MIT）。存储、权限、上下文与界面由本项目独立实现，未包含 Hermes 运行时或其记忆插件；范围见 `docs/architecture/agent-memory.md`。

4.0.18 新增的 ZCode 官方 CLI 市场适配只随包带入目录元数据及校验值；完整 CLI 技能包由用户按需从原发布服务获取，保留原包声明、许可证与引用文件。未把所有市场条目标为同一开源许可，也不承诺通用 JS/MCP 宿主兼容。八类 CLI 的来源及仍待核实的许可边界见 `docs/guides/agent-workflows-cli-adapter.md`。

外部应用配置与用量解析器依据 WorkBuddy、DeepSeek Harness、ZCode、MiMo 的协议或可读本机记录独立实现；不分发这些应用的程序与账户凭据。来源及配置版本边界见 `docs/architecture/external-model-config.md`、`docs/guides/local-agent-usage.md`。

酒馆可按用户选择下载 [硅基女友 v2 9B GGUF](https://huggingface.co/RX5950XT/silicon-based-girlfriend-v2-GGUF) 与 [llama.cpp b11729](https://github.com/ggml-org/llama.cpp/releases/tag/b11729) 官方 Windows CUDA 13.4 运行时，默认安装包不包含模型权重。模型来源标注 Apache-2.0，llama.cpp 为 MIT；CUDA、OpenMP 等运行时组件保留其各自许可，压缩包中的许可文件原样保留。固定文件、版本、摘要、配置和测试边界见 `docs/guides/tavern-local-companion.md`。

2026-10-25 的本地只读文档查看器使用 [PDF.js](https://github.com/mozilla/pdf.js)（`pdfjs-dist` 5.4.296，Apache-2.0）、quick-xml 0.38.4（MIT）和 lopdf 0.44.0（MIT）。PDF.js 的 worker、CMap、标准字体及 Wasm 编解码器从锁定 npm 包本地打包；其根 LICENSE 与资源目录各自的许可证一同保留在 `pdfjs/` 资源下，字体和编解码器适用各自声明。Office 解析、查看器状态与 MCP 宿主由本项目独立实现；工具搜索的行为参考 ZCode `3c5b227649371507ddc4eb46ac5133afe6db1cab`，未升级或修改固定 vendor 源码，不含上游官方云服务及凭据。
