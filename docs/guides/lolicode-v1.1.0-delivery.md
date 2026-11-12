# LoliCode 1.1.0 交付记录

2026-11-12 发布 Windows x64 NSIS 安装版、Tauri 更新签名、便携 ZIP 和公开构建记录。产品版本、程序原生版本和安装注册项均为 `1.1.0`。GitHub Latest 已指向本版。 [GitHub 发布](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v1.1.0)

## 旧版更新

Windows 安装版在设置的「关于」页检查更新并点击「下载并安装」，应用内下载签名包后走 NSIS 覆盖更新。便携版通过下载页获取 ZIP。

- 旧客户端继续请求 `/lolicode/updates/latest.json`。这份兼容清单使用 `4.2.0` 通过旧客户端的版本比较，`productVersion` 为 `1.1.0`，下载地址和签名指向实际的 `1.1.0` 安装器。清单 SHA-256 为 `9890819f3691137c79f8d8feccfed6359f37d051cdd3d8d44975b4f5caf0c4f3`。
- `1.1.0` 及后续正式版使用 `/lolicode/updates/stable.json`。官网清单和工具站下载页也读取正式清单。官网代理返回相同字节，SHA-256 为 `a474aebc2e6d8e11b50892f114f88c35e9be6f93ad57493dcf7e0613cce1fe54`。 [官网](https://lolicode.com/) · [工具站下载页](https://tools.treasuregrove.art/lolicode/)
- 公网候选和原正式地址的 Tauri updater SDK 由旧版 `4.1.6` 完整下载并通过签名验证。`1.1.0` 从默认地址检查返回已是最新版。SDK 使用 MockRuntime 执行检查和下载，实际安装由隔离 Windows 账户验证。

## 构建与验收

- 冻结提交 `50cc2e2842c0e8c2cce263ad39c465805656abbb`，代码提交 `9f47c31a40b82c8a0c17df2db7f68e301a080ca8`，源码树 `aeb238876b3fa94c529d4f1589d10323c09fbf28`，源码归档 SHA-256 为 `bf160310c03f13023ca0481cad3cd08fa87535a8e8842d5976f0608a38e7ec4c`。 [冻结源码标签](https://github.com/treasureGrove/LoliCode/tree/lolicode-v1.1.0)
- NSIS 载荷实际提取并逐文件检查，覆盖 70,265 个安装文件。便携 ZIP 解压校验 70,268 个文件。两者均通过打包程序的离线检查。
- 隔离标准 Windows 账户实装公开的 `1.0.6`，覆盖到 `1.1.0`，然后重启及重复安装。既有会话和渠道在三个阶段均可用，测试账户和配置已清理。验收工具提交为 `7c1dda56af27d4dcbcbb1d5bf2c2b6f5d051a2ce`。
- 已匿名完整下载全部四份 GitHub 附件及三份官网下载入口文件，逐件核对长度和 SHA-256。两个下载页均显示 `1.1.0`，安装版和便携版按钮指向本版。默认走 GitHub，R2 镜像本轮未同步。更新器使用 Tauri 签名，本轮安装器未配置 Windows Authenticode。

- `LoliCode-1.1.0-Windows-x64-Setup.exe` 为 176,792,788 字节，SHA-256 为 `f848959df4aca72a924b2fe2e276568bd4058f89f5d648027bbc800527c48a76`。
- `LoliCode-1.1.0-Windows-x64-Setup.exe.sig` 为 420 字节，SHA-256 为 `95bab58bcebc2d53f07db6e9b7fc31b35c7966581d2214aa79c50927315b32d5`。
- `LoliCode-Portable.zip` 为 324,832,702 字节，SHA-256 为 `c6621dbf75d00ee35806ef5d19f5401f0d684a6117523031df61a8f62cfb0251`。
- `release-build.json` 为 1,047 字节，SHA-256 为 `1f27ef1809cd8a018c197a3976138194ea1d22f90659b34ea51fd0c4110ab566`。
