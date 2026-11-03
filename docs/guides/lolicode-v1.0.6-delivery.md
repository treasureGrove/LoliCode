# LoliCode v1.0.6 交付记录

2026-11-03 构建。产品版本 **v1.0.6**，原生更新版本 **4.1.6**。本轮提供 Windows x64 NSIS 安装版、Tauri 更新签名、便携 ZIP 与脱敏构建记录。

已完成冻结构建、本地安装验收及正式发布。GitHub Latest、官网入口和两个正式更新源均为 v1.0.6 / 4.1.6；源码提交和冻结标签均已上传并核验。

## 本轮更新

详见 [v1.0.6 更新说明](../release-notes/v1.0.6.md)。本轮包括 Loli 秘书与工作任务、对话构建自动化、持久消息队列、临时上游错误重试、思考图片预览、普通会话同步、模型品牌图标、桌宠视频与停靠，以及社区个人空间和工作台间距修复。

源码、原始视频、运行素材、制作脚本和来源记录一并纳入提交。约 5.8 GB 可重建中间帧保留在本地并加入忽略规则，未删除原文件。包中不附模型权重、用户配置、凭据或独立 Node/OpenCode/ZCode 执行引擎。

## 冻结源码

- 来源主提交：`584e230a44549ebe9b8db07b83978eb7e93f4f02`。
- 冻结提交：`29870fd46e97aece1c701f4c6b195682292d0239`。
- 源码树：`4fd6a20a66b9032874433a73ba7fb4caa4263f30`，与来源主提交相同。
- 冻结目录：`release/build-v1.0.6-20261103`。
- 私有源码归档：643,031,040 字节，SHA-256 `64f69f061a80a0e3e04e48cda57e7602fa82a0f9b365b783f53246968036a482`，不作为公共发行附件。

来源主提交已通过原生 Git 普通推送上传至[源码仓库](https://github.com/treasureGrove/LoliCode/commit/584e230a44549ebe9b8db07b83978eb7e93f4f02)，原历史保留。原生 `ls-remote` 和 GitHub API 均核对提交及源码树；[源码标签 `lolicode-v1.0.6`](https://github.com/treasureGrove/LoliCode/tree/lolicode-v1.0.6) 精确指向冻结提交 `29870fd46e97aece1c701f4c6b195682292d0239`，与安装包来源一致。

本文在构建完成后补充，不属于该冻结树，也不改变包字节或签名。

## 已完成验收

- 前端相关 51 个文件：831 项通过，0 失败、0 跳过；类型检查和正式 renderer 构建通过。
- 原生核心：239 项单元测试及 1 项公开 API 秘书工作流集成通过。
- 桌面 Agent：160 项通过，1 项原有手动工具发现检查忽略；账号服务 17 项通过。
- 发布及 NSIS 工具：38 项通过；版本、更新说明和更新链路前端检查 19 项通过。
- 实际 NSIS payload：2 项通过，119 个文件及许可字节核对两次，提取后的真实主程序离线检查通过。
- 便携 ZIP：122 个文件逐项核对，解压哈希和真实主程序离线检查通过。
- 实际生产安装器：隔离安装 4.1.5、覆盖升级 4.1.6、重复安装 4.1.6，三步退出码均为 0，各核对 119 个文件；注册项和快捷方式恢复，合成配置及数据库数据保留。

安装回执为 `acceptance/production-overwrite-a65ca249d56f462d8837ac9078bb01b1/result.json`。离线检查没有读取真实用户配置，付费模型调用为 0。该验收不等同于真实用户配置的全面迁移、正常 WebView 手工验收或所有真实模型的生成质量验证；本交付记录不将跨平台 CI 计为已通过，也没有发布新 Android、macOS 或 Linux 包。

## 四份公共附件

- `LoliCode-1.0.6-Windows-x64-Setup.exe`：55,759,773 字节；SHA-256 `e21021377ea8284eb00f73d297700644db76dd41bc93de7d3290833678b018b9`。
- `LoliCode-1.0.6-Windows-x64-Setup.exe.sig`：420 字节；SHA-256 `d31f9008078934bcf8c2cc8098287d8bd6b8c74e2520b9bdb93880c91390c783`。
- `LoliCode-Portable.zip`：61,722,064 字节；SHA-256 `d6ae46542d9f89c52d8c273c78546f276d566bed9da7b08af9d5e7e14c863fe2`。
- `release-build.json`：4,040 字节；SHA-256 `483096aded0194965aa4b74bbd986965e990374e9e413fb7bf1f7c1908eda7a4`。

四附件均已公开发布并核对 GitHub digest，匿名完整下载的长度与 SHA-256 全部一致；安装器 Tauri 签名和独立公钥绑定通过。默认分发继续使用 GitHub，R2 本轮未同步，不能用 GitHub 成功回执代替 R2 镜像验收。

## 正式下载与更新

- [GitHub 正式发布](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v1.0.6)，Release ID `432211936`，已设为 Latest。
- [Windows x64 安装版](https://lolicode.com/downloads/releases/1.0.6/LoliCode-1.0.6-Windows-x64-Setup.exe)。
- [Windows x64 便携 ZIP](https://lolicode.com/downloads/releases/1.0.6/LoliCode-Portable.zip)。
- [公共构建记录](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v1.0.6/release-build.json)。

两个正式 feed `https://tools.treasuregrove.art/lolicode/updates/latest.json` 和 `https://lolicode.com/downloads/updates/latest.json` 内容一致，SHA-256 为 `8ae55c758aaed8be042b05ca6bd4a1470ddb9ee9a49222b9cfed0c957a0d7be8`。官网新增三条本版固定下载路由，原路由字节保留。

由本轮冻结源码新编译的官方 updater SDK harness 完成三步验证：候选源从 4.1.5 完整下载 55,759,773 字节并验签；默认正式源从 4.1.5 完整下载并验签；默认正式源模拟 4.1.6 返回 `up_to_date`、下载 0 字节。此证明使用 MockRuntime，不执行安装器或创建 WebView；实际安装验收另见上文。

最终交付检查 `final-delivery.json` 为 `passed: true`，核验双 feed、GitHub Latest 与三份官网下载附件；第四附件另有 `public-build-record-download.json` 匿名下载证明。官网浏览器验收显示 `LoliCode 1.0.6`，安装版和便携版按钮均指向本版固定路由，截图保存在本轮构建目录 `official-homepage.png`。

发版流程使用本机 `lolicode-release` skill，仓库流程见 [LoliCode 发布指南](lolicode-release.md)。公网下载、候选及默认源 SDK 证明另存本轮发布助手与交付目录。
