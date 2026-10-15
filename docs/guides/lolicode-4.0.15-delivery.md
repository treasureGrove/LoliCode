# LoliCode 4.0.15 交付记录

2026-10-15 已发布到[工具站](https://tools.treasuregrove.art/lolicode/)。安装版可从“软件更新”升级，便携版下载完整新版 ZIP。主程序源码为 `32d85b8282107f1c4507667ce247572cd2ba568a`。

Agent 的模型请求、任务循环、文件工具、权限、问答、取消、会话存储和按需技能现运行于应用内 Rust 核心。系统终端工具仍按需启动命令进程，Windows 使用独立 Job Object 管理其后代。默认包不再携带 Node、OpenCode 或 ZCode 执行引擎。

本次按逐步迁移发布：工作流、自动化、SSH / WSL 项目、JS 插件及 MCP 执行尚未迁入，界面按实际能力明确标记。旧数据保留；旧 OpenCode 历史只读，旧 ZCode 历史读取待迁移。整体视觉等待后续设计稿。

验证包括前端全量 2,869 项、后续两项历史警告回归、TypeScript 与 Renderer 构建；桌面 Rust 3,711 项通过、10 项忽略；本体核心 25 项、内容构建 3 项、发布工具 15 项通过。真实生产渠道绑定和内置网关将完整模型 ID 转发给本机上游夹具，并验证凭据隔离和请求幂等。

安装器和便携主程序分别执行 `--check-agent-runtime`，在独立中文和空格临时项目内完成真实读写、模型工具续轮、五项技能校验及会话恢复。安装器提取的 114 个内容资源文件与固定源文件逐一匹配，其中五项技能有 110 个原始文件。安装版 `NSS` 与便携版 `UNK` 只相差 Tauri 的三个包类型字节，代码与界面资源相同。

正式文件已从外部 Windows 客户端经公开 HTTPS 完整下载，安装器 SHA-256 与签名及便携包 SHA-256 均匹配；最后切换的公开 `latest.json` 与候选逐字节一致。真实 Chromium 核对版本、固定下载链接、迁移说明、图片及桌面/窄屏布局，页面与控制台无错误。上述验证没有调用付费上游、读取真实账户配置、运行安装器或重启用户应用。

官方 Tauri 更新组件在隔离 MockRuntime 中使用应用默认 HTTPS 地址验证 `4.0.14 → 4.0.15`，完整下载 15,476,097 bytes，SHA-256 匹配且签名验证成功，没有执行安装或退出回调。该检查不等同于已在用户电脑执行安装覆盖。

- 安装器：15,476,097 bytes，SHA-256 `4a5d78f7c349e4d4f4d3687bf481d5f692e579cdae9512cd651b4d2d99b08c9f`。
- 便携 ZIP：20,048,991 bytes，SHA-256 `f4d93da6e23ec0f9a38c2676501a85fc4a7b47c16c7b9cdef26d7e465f795f33`。
- 便携主程序：50,637,824 bytes，SHA-256 `d2221d1087ebaeb3a3c7a912bc8337587e9d6def1af14c61ace417124ce17054`。

逐项证据见[验收清单](../images/lolicode/inprocess/acceptance.json)、[实际安装包自检](../images/lolicode/inprocess/installer-resource-proof.json)、[便携包自检](../images/lolicode/inprocess/native-portable-check-proof.json)、[官方更新组件验证](../images/lolicode/inprocess/native-updater-public-proof.json)、[公网页面](../images/lolicode/inprocess/public-download-page-proof.json)和[发布核对](../images/lolicode/inprocess/publication-proof.json)。
