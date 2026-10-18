# LoliCode 4.0.21-rc.2 测试候选交付记录

2026-10-18 已公开 Windows x64 RC2，不替换稳定版 4.0.20。源码冻结提交为 `de3f21a76f033513ba611fc5b8ca77f0d0910343`；独立源码归档 SHA256 为 `64017eb8fca31aadc3c2558afec8661f109a2cb1e2c63f85f5fc4e622d1c1aa9`。源码版本、锁文件和更新摘要在冻结提交内一致；本交付文档的后续提交不改变冻结包。

[公开测试版发布页](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v4.0.21-rc.2)包含 GitHub 附件和 R2 手动下载链接。GitHub 的自动 Source code 归档属于分发仓库；应用源码以 [LoliCode 冻结提交](https://github.com/treasureGrove/LoliCode/tree/de3f21a76f033513ba611fc5b8ca77f0d0910343)为准。

## 下载

- [R2 Windows 安装版](https://pub-250df9737586416fbd6e8cb0a843b249.r2.dev/lolicode/releases/4.0.21-rc.2/LoliCode-4.0.21-rc.2-Windows-x64-Setup.exe)：23,791,063 字节，SHA256 `5c4233c5ecd72e4f7a2b8f063dfc74cba0f4a2a4ff982f6c672c02edc4a6abbb`。
- [R2 便携版](https://pub-250df9737586416fbd6e8cb0a843b249.r2.dev/lolicode/releases/4.0.21-rc.2/LoliCode-Portable.zip)：29,921,199 字节，SHA256 `ec23d19afcbb556cc1459918d0526ea223d3787be5bba7230e99c16c7ffbc2d7`。
- [GitHub Windows 安装版](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.21-rc.2/LoliCode-4.0.21-rc.2-Windows-x64-Setup.exe)与 [GitHub 便携版](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.21-rc.2/LoliCode-Portable.zip)是相同字节的手动备用。
- [公开构建回执](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.21-rc.2/candidate-build.json)不含本机路径、账号或私钥位置。安装器 `.sig` 为 428 字节，SHA256 `2b1616c0a925f092241ecd31fdf9d1e36e6e6d2f186ab7f9fa9d0fa202f2af83`。

此候选未上传腾讯 COS/CDN，也未加入稳定版的自动 R2/GitHub 路由。上述候选链接是 R2 与 GitHub 手动选线，不能声称 RC2 已具备腾讯或自动降级。稳定版现有三线路保留。

## 构建与独立复核

原打包会话“修复任务执行时的项目切换”在全新 release/build-4.0.21-rc.2-isolated 中从冻结归档构建，锁定依赖、Cargo target、dist 和 NSIS 都独立；源工作树未参加构建。更新签名公钥指纹继续为 `6e5f32bd5f6dd5c1d6257dd65678288769aec4c729a86b7cf497b29668db0b51`。

本会话随后独立读取并核对四个本地产物与源码归档哈希，使用配置公钥验签；再次运行实际生成 NSIS 脚本的受限载荷提取器，115 文件和 5 份许可证两轮提取均一致，提取程序的离线原生 Agent 自检通过。便携 ZIP 120 个文件与实际暂存字节逐项匹配。看板娘原 PNG 1,807,059 字节已嵌入生产 JavaScript；原生后端集成在主程序内，无独立后台引擎进程。

这套载荷测试不会写正式安装注册项，不等同于完整交互式安装/升级。Windows Authenticode 签名未执行。

## 发布和实际公网字节

GitHub 草稿 ID 416233256 仅接受该候选的三个附件和公开构建回执；逐个校对 size/digest 后才以 prerelease 公开，make_latest=false。上传经过已有受控 SSH 发布主机；凭据仅在请求内存和加密 stdin 中使用，不写入文件或日志。

R2 使用原 lolicode-releases 桶的新版本前缀，浏览器上传四份已验证公开文件，不改变权限或旧对象。GitHub 与 R2 四份文件分别完成匿名完整下载、大小和 SHA256 对照。默认 Python UA 曾收到 Cloudflare 1010；使用现有产品用途 UA 的真实下载与官方 updater SDK 均正常，未关闭 Cloudflare 安全设置。相关错误定义见 [Cloudflare 官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)。

证据：rc2-local-verification.json、rc2-independent-nsis.log、rc2-github-public.json、rc2-r2-public.json、rc2-r2-uploaded.png、rc2-published-state.json，均保留在本机 release/acceptance。

## 更新器与渠道边界

独立候选清单为 [updates/4.0.21-rc.2.json](https://tools.treasuregrove.art/lolicode/updates/4.0.21-rc.2.json)，默认包地址使用 R2，附带 GitHub 手动备用元数据。清单 SHA256 为 `ae2766c02d91cffc776c80288ffb206d159912f40a47384a8380f29405ddbbcb`。使用不可覆盖目标和原子链接发布，没有修改 latest.json。

正式 Tauri updater SDK 的隔离 MockRuntime 模拟当前 RC1，从公开候选清单识别 RC2、实际下载 23,791,063 字节并通过签名，哈希与本地相同。当前为 RC2 时检查候选清单返回无更新；模拟 4.0.20 或 RC2 检查稳定清单也返回无更新，没有降级。未运行安装器、退出钩子、重启或 WebView，未读取用户配置。

两处稳定清单仍为 4.0.20，SHA256 `3dffe99d58afb1a4b6ddc2350a8db21548974ad24a0cc4a3666b9d98698e28f0`；GitHub Latest 仍为 lolicode-v4.0.20，RC1 的四份资产身份/哈希也保持不变。证据为 rc2-public-native-updater.json、rc2-self-no-update.json、rc2-stable-no-promotion.json、rc2-stable-no-downgrade.json、rc2-publication-boundaries.json。

## 仍需验收

真实覆盖安装及项目/Key/会话/记忆保留、实际桌面点击、异常断线/强杀、WSL、macOS/Linux、完整 UE Editor 与指定 testkey 等范围未完成。完整前端行为热更新尚未实现；RC2 包含独立签名 PNG 图片更新客户端。持续目标保持 active，不能把候选发布和下载验签称为上述全量功能验收完成。
