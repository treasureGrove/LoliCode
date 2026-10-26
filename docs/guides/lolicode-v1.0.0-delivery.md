# LoliCode v1.0.0 交付记录

2026-10-20 已正式发布。产品版 **v1.0.0** 对应原生更新版本 **4.1.0**，用于从 Legacy 4.0.22 单调升级。官网、两个正式更新清单和 GitHub Latest 已同步。

- [Windows x64 安装版](https://lolicode.com/downloads/releases/1.0.0/LoliCode-1.0.0-Windows-x64-Setup.exe)
- [便携 ZIP](https://lolicode.com/downloads/releases/1.0.0/LoliCode-Portable.zip)
- [GitHub 发行记录](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v1.0.0)

## 本轮内容

- 酒馆接入硅基女友 v2 9B imat Q4_K_M，本地 16K 非思考对话，一键下载、断点续传、文件校验、显存释放和自动启动。角色卡、世界书与消息继续使用酒馆存储，模型和 llama.cpp 首次按需下载，不包含在安装包里。
- 保留当前工作区已准备的模型榜单、免费 AI 导航、截图查看，以及主界面和记忆相关改动。v1.0.0 与原生版本分别管理，保留 Legacy 下载入口。
- 维护者发布 skill：`$lolicode-release`，默认位于 `%USERPROFILE%/.codex/skills/lolicode-release/SKILL.md`。包含冻结源码、签名、NSIS payload、便携包、候选更新、公开下载和正式发布后验证，已通过 skill 校验。

## 构建来源与字节

冻结源树通过独立 index 和审计 ref 保存，未移动原当前分支或修改用户 index。快照提交 `7612ad2007ce8a778bbda23d38fcec91ebe744fb`，源码归档 177,172,480 bytes，SHA-256 `eba87272df8c197bdf68e2dd9d4c3bcc1f28c919af3334c17ebebe99ccc121d6`。构建目录为 `release/build-v1.0.0-20261020/work/`，完整回执在相邻 `source-snapshot.json`。

- 安装器：26,139,817 bytes，SHA-256 `e210467556a518e5c0f101f1d3ff0b7e92bb42bb8dc1a3fc9cf5ea36e7b1c430`。
- 安装器签名：420 bytes，SHA-256 `4579c3bbce4d292f9e0dd4c927ac2ad5e3da1d14fd195eb56cc13a4e0291fc99`。
- 便携 ZIP：30,972,351 bytes，SHA-256 `0732ee734ddbc2f9dcad5e0cd7a1bd4cec11862d6d2d2f68700039b4342df4d9`。

沿用既有 updater 公钥，指纹 `6e5f32bd5f6dd5c1d6257dd65678288769aec4c729a86b7cf497b29668db0b51`。Tauri 更新签名校验通过；没有 Windows Authenticode 证书。当前发布平台为 Windows x64。

## 已完成的本机验证

发布工具、版本说明、版本映射、updater、酒馆、发现页面、主界面与记忆相关测试通过，类型检查和冻结目录的生产 renderer 构建通过。

真实生成的 NSIS payload 验证 115 个文件及 5 份许可证，两次提取的文件哈希一致，提取程序离线自检通过。便携 ZIP 解压后的 120 个文件与暂存逐一匹配，实际便携程序离线自检通过；不含模型权重、独立 Node 或 llama-server 程序。

实际执行安装器，在隔离目录完成 4.0.22 → 4.1.0 → 4.1.0 的升级和重复安装，三个安装器退出码均为 0。安装后的主程序完整哈希符合已知的 UNK→NSS 三字节类型标记变化，114 个资源与便携暂存逐文件一致，安装后的程序也通过原生离线自检。测试涉及的 6 组安装注册项视图已恢复并复核原值与类型，虚构数据保持不变；没有打开真实用户配置或 WebView，也没有代替跨机账户迁移验证。

真实本地模型安装、角色卡/世界书、三轮中文对话、消息保存、显存释放和自动重启验收通过。16K、CPU FFN 8 层的两个 14,080 token 冷输入请求均完成，结构化事实回忆 9/9；模型进程专用显存峰值 4.59 GiB，RSS 峰值 5.72 GiB，生成约 29–32 token/s。这些资源测量来自 RTX 5060 Ti 16GB，物理 6GB 卡及成人内容专项测评尚未执行。详见 [本地陪伴配置说明](tavern-local-companion.md)。

## 发布验收

四份公共附件的大小和 SHA 与本地一致；三个官网固定地址均返回同版本 GitHub 跳转，匿名完整下载、签名比对通过。本轮使用 GitHub 下载通道，R2 未同步；历史版本的 R2 路由没有变动，正文不经过官网服务器。

候选清单通过官方 Tauri updater SDK 的 4.0.22 检查、完整下载和签名验证后才提升正式清单。两个正式清单字节相同，SHA-256 `e04e3a488bc0c91632b35302f26ae33693163b7e9512131a7a4568b1b7113059`；最终交付检查验证了两份 feed、GitHub Latest 和三份完整下载。默认更新源上的 4.0.22 完整下载 26,139,817 字节并验签通过，4.1.0 自查返回 `up_to_date`。

官网及工具站下载脚本兼容原生版本和产品版本，增加 Legacy 4.0.22 入口。在线发现目录 revision `2026101902` 与三张榜单快照已在两个站点上线，8 个公开文件均完整下载并核对哈希和 Content-Type，内容与冻结源码一致。目录不是实时排名，不改变截图的原始来源与日期。

完整证据保存在 `release/publish-v1.0.0-20261020/`，包括 `stable-delivery.json`、默认源与候选 SDK 回执、安装/注册项/资源校验、官网字节与在线目录验证。公共 `release-build.json` 只包含脱敏构建信息；私有配置、签名密钥与完整诊断日志未作为公共附件发布。
