# LoliCode 1.1.3 交付记录

2026-11-18 发布 Windows x64 NSIS 安装版、Tauri 更新签名、便携 ZIP 和公开构建记录。产品与原生更新版本均为 `1.1.3`。[GitHub 发布](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v1.1.3)

## 包体积

- 安装器从 213,531,382 字节降到 148,480,479 字节，减少 30.5%。[下载安装版](https://lolicode.com/downloads/releases/1.1.3/LoliCode-1.1.3-Windows-x64-Setup.exe)
- 便携包从 308,936,949 字节降到 224,302,840 字节，减少 27.4%。[下载便携版](https://lolicode.com/downloads/releases/1.1.3/LoliCode-Portable.zip)
- 主程序从 109,928,448 字节降到 62,364,672 字节。正式构建使用 `opt-level = "z"`、`lto = "fat"` 和一个代码生成单元。
- 压缩了桌面素材。Windows Harness 移除了已由本机 Office 引擎覆盖的 WASM 载荷、无关架构资源和调试文件等 1,027 个文件，共 183,504,601 字节。裁剪后的原生 DOCX 转 PDF 与终端启动已实际通过。

## 发布验收

- 在隔离标准 Windows 账户中覆盖安装已发布的 `1.1.2`。原渠道和会话可继续使用，重启及重复安装同一签名包后均复验通过。测试账户、配置目录和授权已按记录清理。
- NSIS 载荷共 27,569 个文件，便携 ZIP 共 27,572 个文件。文件哈希及解包后的离线自检通过。
- GitHub 附件和官网入口已匿名完整下载，大小和 SHA-256 与本地发布记录一致。官网及工具站显示 `1.1.3`。R2 镜像未同步。[官网](https://lolicode.com/) · [工具站](https://tools.treasuregrove.art/lolicode/)
- 官方 Tauri updater SDK 从公网候选和正式源完整下载并验签。`1.1.2` 获得 `1.1.3`，`1.1.3` 检查结果为已是最新版。实装升级由隔离 Windows 测试单独验证。
- 两个正式更新入口返回同一清单，SHA-256 为 `d3c510a0ac147781df709d2ed926159809246c05f32a4b11411fdc278d9fdb3a`。兼容源为旧版客户端提供 `4.2.0` 到产品 `1.1.0` 的迁移入口。[正式更新源](https://tools.treasuregrove.art/lolicode/updates/stable.json)

## 源码与摘要

- 正式源码提交为 `102711bbb052b04efc291ddcd9840cabee9546b5`，冻结树为 `341c0efb39b7269a5efe1155d68242939ea840d8`，源归档 SHA-256 为 `902242285daab09e46058b6700d7c6bdc545611b8a1a7007e03757da90424ffc`。[源码](https://github.com/treasureGrove/LoliCode/tree/102711bbb052b04efc291ddcd9840cabee9546b5)
- 源码 CI 的六个作业全部通过。正式冻结相比 CI 提交补充了随包分发的 DeepSeek Chat Demo MIT 许可。全量前端测试通过 4,043 项，CLI 通过 8 项。[CI 运行](https://github.com/treasureGrove/LoliCode/actions/runs/44250879964)
- `LoliCode-1.1.3-Windows-x64-Setup.exe` 共 148,480,479 字节，SHA-256 为 `bf1aa48202e9204ed9ce13992b221d26e0588ab73217d8011ba00e3c73e59139`。
- `LoliCode-1.1.3-Windows-x64-Setup.exe.sig` 共 420 字节，SHA-256 为 `bc56679db575ef746eee2c6b60cc8e428422246a0164a476480c58a7a85d4318`。
- `LoliCode-Portable.zip` 共 224,302,840 字节，SHA-256 为 `61b48b1af103e8114fdc08e449a0c5e08736069455a7c8dbee3e193901a39ddb`。

[发布附件](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v1.1.3)
