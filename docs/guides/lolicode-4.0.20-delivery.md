# LoliCode 4.0.20 交付记录

本文记录 2026-10-17 的实际交付结果。Windows x64 安装版、便携版、公开附件、稳定下载路由和正式 `latest.json` 切换均已完成验收。另一台实体电脑的完整安装、重装和覆盖更新仍待用户验证。

产品源码冻结于 `cbad951e112055ca13a9970353e664e8974f968f`，构建使用该提交的源码归档。归档 SHA256 为 `6185e827ab2843f478734f49c0a3f0434d5dfb153cf3b51004e102ff8e9d01c9`。后续文档和分发脚本的提交不改变已签名附件；既有版本附件保持不可变。

## 本版本包含的修复

- 记忆面板增加明确的关闭按钮，由工作台控制弹窗关闭；加载、请求失败或保存期间也可退出。现有异步结果保护防止已关闭面板收到迟到结果后回写状态。记忆面板与工作台相关测试共 79 项通过。
- 继承 4.0.19 的安装路径修复：检查脚本以绝对目标解压到 NSIS 的 `$PLUGINSDIR`，不再改变调用方的 `$OUTDIR`。主程序和 `agent/extensions/LICENSE` 等资源解压到选定安装目录，保留原有进程检查、许可文件和用户数据处理。
- 继承 4.0.19 的侧栏看板娘修复：原 PNG 内嵌到前端资源，保持原形象，运行时无需独立请求这张图片。4.0.20 打包检查确认内嵌 PNG 为 1,807,059 字节。这里的离线能力指图片显示，不代表模型调用、外部链接或检查更新也能离线工作。

4.0.18 安装器曾因输出目录错误导致首次安装或重装失败，应使用修正版。具体根因与看板娘回归边界见 [4.0.19 记录](lolicode-4.0.19-delivery.md)。

## 已完成的安装与运行验证

最终 4.0.20 生成的 `installer.nsi` 所包含的实际 hook 与已审查源码一致。隔离测试读取它声明的主程序和资源文件，构建仅执行资源提取与进程检查的 NSIS fixture，在包含中文和空格的私有临时目录执行首次安装和重复安装。

两次提取均逐文件验证 115 个实际文件的 SHA256，包含 5 份 LICENSE；主程序及资源位于指定目录，临时插件目录没有应用资源，用户哨兵文件保留。随后运行提取出的实际 4.0.20 主程序 `--check-agent-runtime`，内置 Agent 的读写文件、工具继续执行、会话重启恢复和 5 个默认技能检查通过。模型请求使用本机回环假模型，付费请求为 0，未读取用户配置，未启动独立 Agent 引擎进程。便携 ZIP 完整性检查也已通过。

这些操作不注册产品、不创建快捷方式、不运行真实卸载器或 WebView 安装器、不覆盖当前电脑的现有安装与账户数据。因此，这些证据不能替代另一台实体电脑的完整覆盖安装验收。

## 已公开并核对的附件

[GitHub 4.0.20 发布页](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v4.0.20) 的附件已匿名完整下载；R2 对应版本目录的三个附件也已匿名完整下载。两边的字节数和 SHA256 与本地签名产物完全相同。

- 安装器 `LoliCode-4.0.20-Windows-x64-Setup.exe`：23,121,161 字节；SHA256 `e54945269861d68b2abe5d2cd03571af9c420d6a414682879cbce7ed63cc7af5`。
- 更新签名 `LoliCode-4.0.20-Windows-x64-Setup.exe.sig`：420 字节；SHA256 `5489a48a18feb97d4d1b403070c1108eea000c500c33a2d14cd0c0b10624cc96`。
- 便携包 `LoliCode-Portable.zip`：27,864,792 字节；SHA256 `7dcdfe7ffb5e7daea3d71654992789961bd6514bcb53538efcdfad7dea71f270`。

已验证的直接备用链接：[GitHub 安装器](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.20/LoliCode-4.0.20-Windows-x64-Setup.exe)、[GitHub 便携包](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.20/LoliCode-Portable.zip)。

R2 的对象内容已通过匿名完整下载验收，正式更新清单使用 `lolicode.com` 的固定下载路径，由路由选择 R2 或 GitHub。R2 的公开开发地址不作为客户端固定更新入口；国内各网络的连通性与下载速度仍需实际测试。

## 更新签名验证与正式分发结果

已使用正式 Tauri updater SDK，在隔离 MockRuntime 中模拟当前版本 4.0.16，通过候选清单下载 GitHub 的完整 4.0.20 安装器并完成签名验证；下载 23,121,161 字节，SHA256 与上文一致。测试未创建 WebView、未读取用户配置、未执行安装、未触发安装退出 hook。此项证明候选附件的下载与验签，不等于已经执行覆盖更新。

稳定路由上线后，已再次使用正式 SDK，允许精确的 `https://lolicode.com/downloads/releases/4.0.20/` 包目录，从路由候选清单下载完整安装器并通过签名验证，字节数与 SHA256 同样匹配。三个固定下载入口均实际返回 302 到本次 R2 对象，随后匿名完整下载、逐件核对字节数与 SHA256：

- [Windows x64 安装器](https://lolicode.com/downloads/releases/4.0.20/LoliCode-4.0.20-Windows-x64-Setup.exe)
- [安装器更新签名](https://lolicode.com/downloads/releases/4.0.20/LoliCode-4.0.20-Windows-x64-Setup.exe.sig)
- [Windows x64 便携包](https://lolicode.com/downloads/releases/4.0.20/LoliCode-Portable.zip)

路由在请求开始时短暂探测对应 R2 对象，健康时返回 R2 地址，不可用时返回同版本 GitHub 附件地址；网站不转发大文件。该机制属于下载前选路，客户端收到 302 后的大文件传输若中断，不会因此自动续传到另一来源。清单中的 GitHub 备用字段也不代表旧版客户端已实现中途自动切源。

所有附件和路由验收通过后，正式清单已从 4.0.16 切换到 4.0.20。[客户端默认 tools 清单](https://tools.treasuregrove.art/lolicode/updates/latest.json)与[根域清单](https://lolicode.com/downloads/updates/latest.json)均已公开读回，SHA256 一致为 `4691d49885f5a2d9ceaf2962d2a9fe78368cc56ada5942d5f674ee1280190936`，引用上面的固定安装器、便携包路径，并保留精确 GitHub 安装器备用信息。

对两个正式入口分别运行 SDK `--check-only`：模拟 4.0.16、4.0.18、4.0.19 均发现 4.0.20；模拟当前 4.0.20 均返回无更新，共 8 项通过。默认 tools 检查直接使用仓库配置，根域检查显式指定入口；本轮检查未下载包、未安装、未读取用户配置。

更新公钥延续既有版本，公钥指纹为 `6e5f32bd5f6dd5c1d6257dd65678288769aec4c729a86b7cf497b29668db0b51`。这里的签名为 Tauri updater 签名；安装器未作 Windows Authenticode 签名。

以下项目仍需实际验收，不将隔离验证描述为已完成真实覆盖更新：

- 另一台实体 Windows 电脑验证首次安装、重装和旧版覆盖更新。便携版需退出程序后完整解压新版 ZIP，不把其交付方式描述为已经支持原生自动安装更新。
- 不同实际网络下的下载速度、Range／断点续传行为，以及真实应用内安装退出、覆盖安装与重启后的配置保留。

R2 主源用于减少按下载字节计费的出口流量；存储和操作请求仍受 R2 的独立额度与计费规则约束。域名接入与路由操作不应迁移全域 DNS、改动社区／账户 API，或自动开通额外收费计划。旧客户端原生下载器是否在单个包 URL 失败时自动切源，需要以实际实现和验收为准，不能仅凭候选清单中保留 GitHub 地址作出保证。

## 开发热重载与生产更新的边界

本地开发使用 `pnpm dev` 启动 Tauri 开发实例。React／CSS 修改通过 Vite HMR 更新；Rust 修改需要重新编译并重启开发应用。这是开发调试路径，不要求每次生成发行安装包。

已发布应用的 React 前端与 Rust 后端仍属于发行包内容；修改后需重新构建、生成更新签名并发布新版本。服务器上的官网页面可以独立更新，但不会因此替换用户已安装应用中的前端。

后续可以另行设计带签名、版本约束、兼容检查与回滚的独立资源包更新方案。本轮未实现或交付此能力，不宣称现有生产应用已支持免打包热替换。

## 本机验收证据

详细日志位于忽略提交的 `release/` 目录，不包含私钥或访问令牌：

- `4.0.20-package.log`：冻结源码、产物哈希、内嵌看板娘和离线自检。
- `4.0.20-final-payload-acceptance.log`：最终生成脚本的 115 文件、5 份 LICENSE、两次提取与实际主程序自检。
- `4.0.20-public-artifacts.json`、`public-download-acceptance-4.0.20.json`：GitHub 匿名完整下载和候选更新验签。
- `4.0.20-r2-anonymous-proof.json`：R2 三个附件的匿名完整下载与同字节证明。
- `4.0.20-candidate-updater-proof.json`：隔离正式 updater SDK 的完整下载、签名验证及未执行安装的边界。
- `4.0.20-router-candidate-updater-proof.json`、`public-download-acceptance-4.0.20-router.json`：固定根域路由的 SDK 完整下载验签、三个实际 302 目标、匿名下载与不可变候选清单哈希。
- `4.0.20-default-updater-checks.json`：切换后两个正式清单的公开版本与 SHA256，以及 4.0.16／18／19／20 的 8 项 SDK 只检查结果。

macOS／Linux 的本次安装包尚未发布。第二台实体电脑的安装与升级结果需在实际验收后补充本文。
