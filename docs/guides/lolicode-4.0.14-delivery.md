# LoliCode 4.0.14 交付记录

2026-10-15 已发布至[工具站下载页](https://tools.treasuregrove.art/lolicode/)。安装版可通过“软件更新”从 4.0.13 检查到 4.0.14；便携版下载新版 ZIP。整体视觉保持现状，等待后续设计稿。

本轮修复项目内本地图片的聊天预览、渠道保存后的编程模型目录同步及手动刷新、模型状态说明，以及上游明确提供的上下文、输出上限和思考档位获取。缺失的上游能力信息保留待补充，不冒充已验证结果。

新会话使用 ZCode 3.15.1 原生运行时，源码固定为 `aac4755666d09fdcd70272fcf063c077a639015f`；提供原生权限、Plan、工作流、自动化和远程项目入口。旧 OpenCode 会话保留。Linux x64 / glibc 2.34+ SSH 已实测；WSL、ARM 和旧 glibc 尚未实机验证。公开上游缺失的 Computer Use 和内嵌 MCP Apps 展示宿主未包含在此版，CLI/TUI 尚未作为用户入口发布。

交付校验：

- 应用源码提交 `39caf4e3f2d7c2bfaa77529943cd365731d7de06`，后续 `60025004` 只修正异步权限测试时序，`13df3dd` 只延长发布工具的可配置下载预算。
- TypeScript 检查、前端 2,861 项、Rust 3,696 项、运行时 facade 49 项、发布工具 15 项及构建工具 10 项通过；Rust 另有 10 项忽略。
- 正式候选运行资源完成 7 组原生权限与 Plan 用例。自动化、工作流及 Linux SSH Agent 实际工具往返通过，模型推理均使用假模型，没有新增付费调用。
- 安装包解包后，12,389 个运行资源文件的完整目录与逐文件 SHA-256 一致。默认技能、远程组件和许可证齐全；便携 ZIP 完整性及主程序字节核对通过。
- 安装器从真实 Windows 客户端经公网 HTTPS 完整下载，整包 SHA-256 与签名一致；便携包在发布服务器通过相同公开域名/SNI、证书校验和回环连接完整下载核对，另由外部客户端核对公开范围响应。便携包未在外部客户端重复完整下载。
- 官方 Tauri 更新组件从本机分发服务完整下载同一公网候选并验证签名；正式默认 HTTPS 地址独立确认 `4.0.13 → 4.0.14`。未运行安装器、重启应用或修改真实用户配置。
- 公网清单与预制清单逐字节相同。真实 Chromium 下载页的版本、固定版本链接、资源、桌面及窄屏布局检查通过，无页面或控制台错误。

安装器为 **263,829,458 bytes**，SHA-256：`0999b25697039226ad29d942b3b4b4d0e907872de77e9ca82fff1501a581d016`。便携 ZIP 为 **384,878,884 bytes**，SHA-256：`d1db4163b9f3fe5c1f4ca26871436cbcbdc19fff85e4df2ac98bf070501bffde`。

Tauri 安装版主程序的三字节 `NSS` 标记和便携版的 `UNK` 标记按打包机制保留；除此之外代码与渲染资源相同。[完整交付证据](../images/lolicode/zcode/release-proof.json)、[安装包证据](../images/lolicode/zcode/installer-resource-proof.json)、[正式更新检查](../images/lolicode/zcode/native-updater-public-check-proof.json)、[公网页面截图](../images/lolicode/zcode/public-download-page.png)。

验收临时解包目录约 1 GB，自动审批以 `blocked by policy` 拒绝清理，未提供详细原因，因而暂留；发布文件不受影响。
