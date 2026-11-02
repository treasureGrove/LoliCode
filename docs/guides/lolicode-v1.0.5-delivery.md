# LoliCode v1.0.5 交付记录

2026-10-30 构建。产品版本 **v1.0.5**，Windows 原生更新版本 **4.1.5**。本轮提供 Windows x64 NSIS 安装版、对应 Tauri 签名、便携 ZIP 和脱敏 `release-build.json` 四个公共附件；没有构建或发布新的 Android、macOS、Linux 安装包。

**已正式发布并完成本轮验收。** GitHub Latest、双正式更新源及官网首页均为 v1.0.5；候选与默认源 SDK、实际安装升级、三条官网安装资产及第四公共附件的独立验真均通过。R2 未同步，分发继续使用同版 GitHub。

## 功能与服务端范围

冻结的 `src/whats-new/4.1.5.json` 记录四项改动：

1. 统一 Credit 额度，支持按用户管理每日用量。
2. 修复请求完成与账号切换后的额度刷新。
3. 优化模型 Credit 单价，增加人民币参考报价助手。
4. 新前台会话默认完全访问，完善工作台与开发版更新。

配套服务端的个人每日额度覆盖、恢复默认、暂停新调用和用量查询已经上线。每日用量按 Credit 控制，取消每日请求次数上限，并保留并发、RPM 和全站池约束。修改个人额度或暂停账户不会清空用量、重算历史账目或中断已经预留请求的正常结算。

模型报价统一显示为 **Credit / 1,000,000 tokens**。人民币参考助手使用 `参考人民币价/M × 100 × (1 + 上浮比例)` 填写报价草稿，默认上浮比例为 10%，由管理员保存后生效。它是报价辅助，不执行余额换汇。展示精度与结算精度分开：账本仍使用整数 microCredit，结算不会按两位小数截断；旧请求保留原费率快照。

额度页、侧栏和账户入口共享服务端余额。前台可见时约每 25 秒刷新，并在窗口聚焦、手动刷新、账户变化和原生请求完成后更新。此处没有承诺跨设备即时推送。后台按小时巡检符合条件的渠道连通性，繁忙时服从流量保护；系统巡检不扣用户 Credit。

新建前台 Agent 会话默认完全访问；后台会话默认仍为逐次审批，已有会话保留原先明确选择的权限。Credit 同步参考了 LiteLLM 社区实现的查询和预算模式，适用 MIT 归属说明随本轮包保留，未分发 LiteLLM 运行时或企业代码。

## 冻结源码

安装器与便携 ZIP 均来自 `release/build-v1.0.5-20261030`：

- 冻结提交：`7815de01c1cbdc7a8549f8a71ae7f36503b93cac`。
- 源码父提交：`b0f94b21b85b80527b0cc7f43abe0786e908a80e`。
- Git 源码树：`bc8fca5b3067c44bffb2e701e8e7a188ac2edc1d`。
- 审计 ref：`refs/lolicode/builds/4.1.5-d55265d5-aa21-4c83-b6d5-ac40e07ef073`。
- 私有源码归档：**187,299,840 bytes**，SHA-256 `88d686f13a040347eaf25a1b37432734e3eeab906440cccfe6a64c3152ac8be1`，不作为公共附件分发。

本文是构建后补充的交付文档，不属于上述冻结树，也不改变已构建的产品代码、资源、包字节或签名。构建后的 NSIS 验收解析器补充支持安装根目录的精确 `CreateDirectory` 指令；该测试适配不代表冻结产品源码发生变化。

## 已完成的功能回归

`tmp/release-preflight-20261030/publication-v1.0.5/qa-public.json` 记录本轮冻结前的功能检查：

- 前端 **3476 项通过，0 失败、0 跳过**。
- Windows 应用原生测试 **4081 项通过，0 失败、15 项既有忽略**。
- 原生权限默认值专项 **3 项通过，0 失败、0 忽略**；其余 184 项未被该专项选中，不计入此项通过数。
- 门户 **71 项通过，0 失败、0 跳过**。
- 发布工具 **47 项通过，0 失败、0 跳过**。

配套 Credit 与账户管理后端的 **189 项 Python 回归全部通过**。这些检查覆盖个人覆盖额度、恢复默认、暂停、CAS 冲突、权限与同源限制、预留结算、并发余额保护、全站池及历史兼容。

本轮发布网络恢复的离线门控 **50 项通过**，包括 31 项原发布门控和 19 项新增传输门控；它们是发布辅助工具检查，不替代上述产品功能测试或现场发布验真。

本轮没有重新运行跨平台 CI，不将 v1.0.4 的 Linux、macOS 或完整跨平台结果计作 v1.0.5 验收。已有在线发现页兼容检查通过，无需重新部署；未重拍的截图也不作为本轮重新采集的证据。

## Windows 实际包与安装验收

实际 NSIS payload 检查 **2 项通过，0 失败、0 跳过**，**119 个文件**逐项核对两次；提取后的实际主程序通过离线运行检查。许可证资源及两份官方 WebRTC 许可字节通过核验。便携 ZIP 解压后 **122 个文件**逐项哈希匹配，实际便携主程序的离线检查通过。Tauri 更新签名、公钥绑定、资产长度和 SHA 均已验证。

使用旧版与本轮真实生产安装器，在隔离目录执行三步，退出码均为 **0**：

1. 安装旧原生版本 **4.1.4**，校验 **117 个文件**。
2. 覆盖升级到 **4.1.5**，校验 **119 个文件**。
3. 再次覆盖同版本 **4.1.5**，校验 **119 个文件**。

三步均通过实际主程序离线检查。测试结束后，安装登记与四个已知快捷方式已恢复，合成配置和 SQLite 数据保留。回执为 `release/build-v1.0.5-20261030/acceptance/production-overwrite-43b48229cdf64130bcc827c2626589ae/result.json`。

该验收未读取真实用户 profile、未渲染正常 WebView，付费模型调用为 0 次，包中未附模型权重。它证明上述隔离安装与合成数据保留，不代表真实用户配置的全面迁移或全部界面业务已完成手工验收。

## 四份公共附件

- Windows NSIS：`LoliCode-1.0.5-Windows-x64-Setup.exe`，**30,516,075 bytes**，SHA-256 `b1ace70333ad33fb93cf4c32dfc87e9718c3cc95c0793ff8f7102bcecbb0a7a2`。
- Tauri 签名：`LoliCode-1.0.5-Windows-x64-Setup.exe.sig`，**420 bytes**，SHA-256 `9edde5886cebe66efb5cc02c97dff28a314df0f3cdf05f6591729013d9658628`。
- 便携 ZIP：`LoliCode-Portable.zip`，**36,368,124 bytes**，SHA-256 `1efdda6aa55f8373b6bc58c55baa76e32f6059c949c926fb55f2fc9373cc5f4e`。
- 公共构建记录：`release-build.json`，**3,989 bytes**，SHA-256 `bbcf082549f03ccd33b2f17f280f211cea7e04cbde0974efd55c0ba0b987884f`。

资产摘要取自本轮 `github-artifacts.json`。公共构建记录仅含脱敏版本、源码摘要、资产与检查范围，不包含用户账户、个人用量、私有路径或凭据。私有源码归档、原始诊断和安装事务不公开。已发布附件保持不可变，后续交付检查另存回执，不回写附件改变哈希。

## 公网发布与更新源

- **GitHub 已发布并核对为 Latest。** [发布页](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v1.0.5)，release ID `428898670`，tag `lolicode-v1.0.5`，发布时间 **2026-10-30 10:38:51 UTC**。四附件的名称、长度及 digest 均已核对。
- **官网三条精确路由匿名完整下载通过。** [安装版](https://lolicode.com/downloads/releases/1.0.5/LoliCode-1.0.5-Windows-x64-Setup.exe)、[签名](https://lolicode.com/downloads/releases/1.0.5/LoliCode-1.0.5-Windows-x64-Setup.exe.sig)和[便携 ZIP](https://lolicode.com/downloads/releases/1.0.5/LoliCode-Portable.zip)均 302 到同版 GitHub，完整下载字节与上述摘要一致；官网不代理包正文，历史下载入口保留。
- **第四附件匿名完整下载通过。** [公共构建记录](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v1.0.5/release-build.json)下载 **3,989 bytes**，完整 SHA、来源及源码、产品/原生版本字段匹配。
- **新编官方 SDK 的候选源验收通过。** 从[独立候选源](https://tools.treasuregrove.art/lolicode/updates/1.0.5-router.json)，模拟当前 **4.1.4** 检查到 **4.1.5**，完整下载 **30,516,075 bytes** 并通过官方插件验签，SHA 为 `b1ace70333ad33fb93cf4c32dfc87e9718c3cc95c0793ff8f7102bcecbb0a7a2`。工具由本轮冻结源码新编，未复用旧 SDK 成功回执；MockRuntime 未执行安装器或创建 WebView，真实安装验收另记于前节。

候选清单为 **1711 bytes**，SHA-256 `6f81cf7ae1257c7cfd722b0810fb32a621afe965b4365be0093fcd1303b9f171`。本轮候选、匿名下载与第四附件证据分别保存在 helper 目录的 `candidate-updater-proof.json`、`public-download-acceptance.json`、`public-build-record-download.json`。

正式清单已经原子提升并完成匿名回读。[工具站正式源](https://tools.treasuregrove.art/lolicode/updates/latest.json)与[官网正式源](https://lolicode.com/downloads/updates/latest.json)均为 **4.1.5 / productVersion 1.0.5**，共同 **1711 bytes**，SHA-256 `6f81cf7ae1257c7cfd722b0810fb32a621afe965b4365be0093fcd1303b9f171`，与候选清单字节一致。

本轮新编官方 SDK 从配置默认源模拟当前 **4.1.4**，完整下载 **30,516,075 bytes** 并返回 `signature_verified`，SHA 与安装器一致；模拟当前 **4.1.5** 返回 `up_to_date`，未尝试下载，下载量 **0 bytes**。此结果没有复用旧版 SDK 验收；MockRuntime 不执行安装器或正常 WebView。

正式 delivery verifier 的实际退出码为 **0**，`release/build-v1.0.5-20261030/final-delivery.json` 为 `passed: true`，覆盖双正式 feed、GitHub Latest，以及安装器、签名和便携 ZIP **三份安装资产**的公开下载。第四附件 `release-build.json` 另由 `verify-public-record.mjs` 独立匿名完整下载，并由发布服务器现场重新验真 **3,989 bytes / SHA bbcf082549f03ccd33b2f17f280f211cea7e04cbde0974efd55c0ba0b987884f**，不混计到该脚本的三资产结果中。

官网首页通过真实浏览器验收，显示 **LoliCode 1.0.5**；安装版、便携版和 GitHub 备用按钮均指向同版文件。截图保存在 `tmp/relay-credit-evidence/release-1.0.5/official-homepage-20261030.png`。

## 一次发布网络恢复

tools 主机通过 GitHub canonical 首跳读取第四附件时超时。本轮以新私有 wrapper 仅替换原模块中该附件的精确网络 opener，使用官方公开 asset API `691769098`，以 `application/octet-stream` 匿名请求并转至官方 storage，现场重读相同的 **3,989 bytes**。这一方式符合 [GitHub release asset 官方说明](https://docs.github.com/en/rest/releases/assets)。正常 TLS、全部字节和回执校验、旧源 CAS、发布锁及原子替换逻辑保持原样；原 staged 发布脚本与源码、四份资产均未改动。

wrapper 的现场 `check` 和 `finalize` 均以退出码 **0** 完成，日志分别为 `logs/public-api-gate-check.log`、`logs/public-api-feed-finalize.log`。原发布脚本 SHA 为 `8bdd725189019741a6d190c75051243a19dfd92eb8e5b89cb605d576cecf6305`，wrapper SHA 为 `c2d031674d2ac2257bb5a77fd608543fa01a51e5e73f190ffa5adfec611a6718`。这没有证明 tools 的该 canonical 首跳已经恢复；客户端 SDK 安装器下载与本机三份 canonical 安装资产下载已分别通过实测。

**R2 未同步。** 默认分发沿用同版 GitHub，不能用 GitHub 或候选验收代替 R2 镜像验收。Android 等其他平台的历史下载和旧验收保持原范围，不计作本轮新包测试。

本轮使用 `lolicode-release` skill，流程见 [LoliCode 发布指南](lolicode-release.md)。聚合最终交付索引为 `release/build-v1.0.5-20261030/final-release-receipt.json`，由实际 feed、下载、SDK 和官网验收结果校验后生成；三安装资产的 delivery 原始回执为同目录 `final-delivery.json`。SDK 与第四附件的独立回执保存在本轮 helper 目录，真实安装回执位置见前节。
