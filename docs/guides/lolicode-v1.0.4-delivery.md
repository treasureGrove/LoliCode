# LoliCode v1.0.4 交付记录

2026-10-29 构建。产品版本 **v1.0.4**，Windows 原生更新版本 **4.1.4**。本轮仅交付 Windows x64 NSIS 安装版、对应 Tauri 签名、便携 ZIP 和脱敏 `release-build.json` 四个附件。Android 保留既有 **0.1.0-alpha.4** 下载入口，本轮没有构建或发布新 APK；macOS、Linux 没有本轮安装包。

**已正式发布并完成验收。** GitHub Latest、双正式更新源及官网首页均为本轮版本；四附件匿名完整下载、官方 updater SDK、真实隔离安装升级和完整 CI 均通过。

## 功能与维护范围

本版冻结的 `src/whats-new/4.1.4.json` 记录以下改动：

1. 改进 Agent 上下文预算、限流恢复与模型参数选择。
2. 新增模型榜单，优化渠道配置与账户额度展示。
3. 完善工作台工具面板与界面字号设置。
4. 整理应用启动与工具管理，完善构建和更新验证。

另外修复模型信息不完整时向 MiMo、旧 ZCode 配置写入推测上下文上限的问题，保留 Agent 自身的既有默认行为。

代码维护入口见 [ARCHITECTURE.md](../../ARCHITECTURE.md) 和[文档索引](../README.md)。目录整理不改变既有 IPC 命令契约；本次包内能力以冻结源码及上述更新说明为准。

## 冻结源码与后补检查

本轮安装器和便携 ZIP 来自独立构建目录 `release/build-v1.0.4-20261029-final`，共同绑定以下真实快照：

- 冻结提交：`51dde9e8f0bd28422a15414cdb34437ee49f0f76`。
- 已推送的源码父提交：`0e9c84fbf78beede016fddf6f3ace5784ab3a5cb`。
- Git 源码树：`f6c1002b728309dc03c42aca4716e34b3aefa54c`。
- 私有源码归档：**184,903,680 bytes**，SHA-256 `4059315868fe043649aa65322ea3013795360ca4ce073c67b38255122765366e`，不作为公共附件分发。

冻结提交与上述父提交的 Git 源码树一致。Git 行尾规范化可能使检出文件的原始字节表示不同，因此这里不声称工作目录所有文件的原始字节逐一相同。`release-build.json` 同时记录冻结提交、源码父提交、源码树与归档摘要，以区分公开源码和实际构建快照。

完整验收对应已推送的 `f056d5769904fc950c81653bc3bb5d26432b4c68`。冻结后的 `e6fd2d7b6e0279b79c6facd6d347e98f5c9fbc32` 与该提交仅涉及六个 CI、测试或测试 fixture 文件；其中 `account_tests.rs` 位于 `cfg(test)` 模块，排除在生产包外。这些后补检查变更不算作安装包的新功能，也不改变已冻结包字节。

本文作为构建后的交付说明另行提交到原 `main`，不包含在上述安装包源码树中；本文件所在提交可通过 `git log -1 -- docs/guides/lolicode-v1.0.4-delivery.md` 查询。

## 已完成的自动化检查

本地 Windows Rust 检查对应源码父提交 `0e9c84fbf78beede016fddf6f3ace5784ab3a5cb`，其生产 Git 源码与冻结包一致：

- Rust 格式检查、严格 Clippy（`-D warnings`）通过，警告 **0**。
- 启用 `test-hooks` 的全部 target 检查通过。
- 定向 Rust 回归 **170 项通过、0 失败、2 项忽略**；离线示例 **27 项通过、0 失败、0 忽略**。

[完整 CI 运行 40863057349](https://github.com/treasureGrove/LoliCode/actions/runs/40863057349) 对应 `f056d5769904fc950c81653bc3bb5d26432b4c68`，最终 **6/6 个任务成功，整个工作流成功，无跳过任务**：

- 前端 **289 个测试文件 / 3413 项测试通过，0 失败、0 跳过**；类型、格式和 renderer 构建通过。
- Windows 原生 **4254 项通过、0 失败、15 项既有忽略**。
- Linux 原生 **4281 项通过、0 失败、14 项既有忽略**。
- macOS 原生 **4295 项通过、0 失败、14 项既有忽略**；物理临时目录下重跑了此前受路径别名影响的 56 个用例，逐项通过。
- Windows 到真实 WSL2 文件系统专项 **1 项通过、0 失败**，运行 2.96 秒。
- 三系统 Rust 格式及严格 Clippy 全部通过。

这次采用完整 `workflow_dispatch` 执行全部任务，抑制的重复 push 事件不作为测试证据。构建后的测试夹具修正另有新编译的 5 项定向回归通过；上述完整 CI 已再次覆盖这些用例。

发布 QA 还保留了对字节未变模块的既有真实检查：Native Agent **184 项通过、0 忽略**；脚本测试 **96 项通过**，构建前 **1 项条件跳过**，构建后已完成 **2 项真实 NSIS 检查**。这些结果依据模块源码一致性复用，未声称它们全部在本次最终冻结目录重新执行。线上模型榜单与发现页数据的兼容性检查同样保留原执行时间，并已核对相关解析器和发现页源码未变。

公共 `release-build.json` 中的额外 QA 是准备附件时的不可变观察快照，其中完整 CI 仍标记为 pending。完整工作流最终结果见本节链接和上述实测数量；不回写已发布附件改变其哈希。

## Windows 包与真实安装验收

本轮实际 NSIS payload 检查 **2 项通过**，**117 个文件**逐项核对；默认扩展的 **5 份许可证**与 **2 份官方 WebRTC 许可证**完整。提取后的实际主程序通过离线运行检查。便携 ZIP 解压后 **122 个文件**逐项哈希匹配，实际便携主程序的离线检查通过。Tauri 安装器签名、公钥绑定和产物长度、SHA 校验通过。

使用已发布的旧生产安装器与本轮新生产安装器，在隔离目录真实执行三步，退出码均为 **0**，每步均校验 **117 个文件**并通过实际离线运行检查：

1. 安装旧原生版本 **4.1.3**。
2. 覆盖升级到本轮 **4.1.4**。
3. 再次覆盖同版本 **4.1.4**。

测试后安装登记和已知快捷方式已恢复，虚构配置与合成 SQLite 数据保持不变。验收未读取真实用户配置、未创建正常 WebView，付费模型调用 **0 次**，包中未附模型权重。此结果证明上述隔离安装和合成数据保留，不代表真实用户 profile 的全面迁移或全部人工界面业务验收。

## 本轮四份公共附件

- Windows NSIS：`LoliCode-1.0.4-Windows-x64-Setup.exe`，**30,442,291 bytes**，SHA-256 `3e7d7a279c26832d4b8e1d97cbb0588893f293948202a8912740227dcb98248a`。
- Tauri 签名：`LoliCode-1.0.4-Windows-x64-Setup.exe.sig`，**420 bytes**，SHA-256 `3ca20cf57eca643789a7a8d92e2294feaf6903561071a1f8d00db266d2f04682`。
- 便携 ZIP：`LoliCode-Portable.zip`，**36,306,401 bytes**，SHA-256 `8d695666bc31adb8fd27f44aed6b907de3645769a9844f7669b3709ee4a00bed`。
- 公共构建记录：`release-build.json`，**11,160 bytes**，SHA-256 `d447115362ce2969e903b492b6525471ae5cae2475428882d5740a5a431f042b`。

公共构建记录仅含脱敏版本、源码及产物摘要、真实检查数量和适用范围，不包含本机路径、注册表原值、私有安装事务、用户账号或凭证。源码归档、安装备份及原始诊断日志不在公共四附件中。

## 公网发布与更新源

- **GitHub：正式发布并核对为 Latest。** [发布页](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v1.0.4)，ID `427759905`，tag `lolicode-v1.0.4`，发布时间 **2026-10-29 11:30:37 UTC**。精确四附件的上传状态、长度、digest 和正式下载 URL 均已核对。
- **四附件匿名完整下载通过。** 安装器、签名、便携 ZIP 和[公共构建记录](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v1.0.4/release-build.json) 的完整字节与上文 SHA 相同。正式提升前，服务器再次匿名下载了第 4 附件，重新校验全部字节和源码、双版本字段；未用已有成功回执代替这次下载。
- **官网三条精确路由已部署并实测。** [Windows 安装版](https://lolicode.com/downloads/releases/1.0.4/LoliCode-1.0.4-Windows-x64-Setup.exe)、对应签名和[便携 ZIP](https://lolicode.com/downloads/releases/1.0.4/LoliCode-Portable.zip) 均返回 302 到同版 GitHub，官网不代理包正文。历史配置原字节保留，只追加三条新路由，未改 router 配置或重启其服务。
- **候选源 SDK 验收通过。** 从 `https://tools.treasuregrove.art/lolicode/updates/1.0.4-router.json`，模拟当前原生 **4.1.3** 检查到 **4.1.4**，官方插件完整下载 **30,442,291 bytes** 并验签通过，SHA 与上文相同。
- **双正式 feed 已原子提升并回读一致。** [工具站正式源](https://tools.treasuregrove.art/lolicode/updates/latest.json) 与[官网正式源](https://lolicode.com/downloads/updates/latest.json) 均为原生 **4.1.4 / productVersion 1.0.4**，绑定冻结源码 `51dde9e8f0bd28422a15414cdb34437ee49f0f76`；完整 **2144 bytes**，共同 SHA-256 `6de492c081423953daf979bb8150de58eeb5cb3f6eb41ab4378bc949dafdd98e`。旧源基线的私有备份保留。
- **默认更新源验收通过。** 模拟当前原生 **4.1.3**，从配置默认源完整下载本轮安装器并由官方插件验签；模拟当前 **4.1.4**，结果为 `up_to_date`，下载 **0 bytes**。复用的官方 SDK MockRuntime 工具编译标签为 **4.1.0**，源码、公钥、默认端点与锁定 SDK 依赖已核对一致，通过显式参数模拟版本；它未安装或运行正常 WebView。真实安装验收另见前节。
- **官网首页真实浏览器验收通过。** 在 **2026-10-29 11:52:28 UTC** 刷新[下载入口](https://lolicode.com/#download)，实际 DOM 显示 **LoliCode 1.0.4**；安装版、便携版及 GitHub 备用按钮的实际 href 均指向同版已验证产物。页面由正式 feed 动态更新；已打开页面需刷新或“重新读取”，没有后台轮询。
- **R2：未同步。** 默认分发沿用已授权的同版 GitHub 下载通道；本轮不另建桶或改变默认源。R2 状态不能由 GitHub 上传回执代替。
- **Android：保留既有 alpha.4。** 不上传新 APK，不修改既有手机页、历史包和路由，不把上一版手机验收写作本轮重新执行。

工具站对默认 GitHub 边缘地址的读取曾超时。恢复时仅在当次复核进程选择另一条经实时 DNS 与 GitHub 官方 web 地址范围核对的线路，保持 canonical URL、Host/SNI、正常证书验证及全部原始发布门控；原发布脚本哈希未变，仍在加锁和旧源 CAS 之前实际下载、验真第 4 附件。没有修改系统 DNS、防火墙、证书、原验收回执或公共附件。

本轮使用 `lolicode-release` skill 与 [LoliCode 发布指南](lolicode-release.md)。最终本地验收索引为 `release/build-v1.0.4-20261029-final/stable-delivery-verification.json`；公开附件和上述链接可独立核对。
