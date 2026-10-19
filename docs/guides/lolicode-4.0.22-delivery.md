# LoliCode 4.0.22 正式交付

2026-10-19 已发布 Windows x64 安装版与便携版，官网、两个正式更新清单及 GitHub Latest 同步为 4.0.22。

- [安装版](https://lolicode.com/downloads/releases/4.0.22/LoliCode-4.0.22-Windows-x64-Setup.exe)
- [便携版](https://lolicode.com/downloads/releases/4.0.22/LoliCode-Portable.zip)
- [GitHub 备用](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v4.0.22)
- [逐项验收清单](../acceptance/LoliCode-4.0.22-验收清单.md)

冻结源码 `459b0e2e69a2017c8b03aa8451640a99be1843e4`；归档 SHA256 `70b22a97826f89e744420887ddcdc33483e008eb193068ebc3f0d22e0dddc40e`。构建使用归档导出的独立工作目录，复用锁定依赖及 Cargo 缓存；后续交付文档提交不改变此安装包。

安装器 25,896,015 字节，SHA256 `88c994e29cbeb61a9a05112226212ff01d77b708026e9988c402aaf946a3de90`。便携 ZIP 30,660,786 字节，SHA256 `fb070dba5795ef3b15376050fe10b62c1975f1a6030821cf58940fff68391460`。公开构建回执为发布附件 `release-build.json`。

本版包含 MiMo、DSH、ZCode 配置修复，Copilot 多上下文目录，Codex／Claude 原生与路由切换，LoliCode 用量归属，本地国产 Agent 管理，酒馆人物卡和 UE 桥修复，以及产品／网关更名。具体能力和待人工验收项见清单。

原 updater 密钥、应用标识 `art.treasuregrove.tai-switch` 和已有数据路径保持兼容。资源与许可证提取、看板娘内嵌、便携程序离线自检、真实安装器隔离覆盖升级／重复安装、注册项恢复均通过。安装程序与便携程序仅有 Tauri 安装类型标记导致的 3 字节差异，实际完整哈希已验证。

R2 保存完整发布资产；GitHub 保存相同字节。官网安装包正文不经网站服务器，固定下载路由优先选择 R2，异常时回退同版本 GitHub。新增 4.0.22 路由后保留 4.0.20／4.0.21 路由。腾讯镜像本轮未同步，官网不会拿旧腾讯文件冒充新版。

两个正式清单字节相同，SHA256 `89041509d54683c9f5971c87cbb18a6a089431cb474b7424602ce93c0e8eb7ac`。官方 Tauri updater SDK 从默认地址识别新版并完整下载 25,896,015 字节、验签通过；4.0.22 自查无重复更新。该 SDK 检查不运行安装器或 WebView。

本地回执位于 `release/acceptance/stable22-*`，打包归档及构建日志位于 `release/build-4.0.22-final-isolated/`。没有 Windows Authenticode 证书；macOS／Linux 包未在本次发布。跨电脑真实账户迁移及 UE Editor 的人工验证保留在验收清单中。
