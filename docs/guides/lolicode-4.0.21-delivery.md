# LoliCode 4.0.21 正式更新交付

2026-10-18 已上线 Windows x64 正式版。4.0.20 的默认检查地址、官网正式清单与 GitHub Latest 都已指向 4.0.21；历史 RC1／RC2 的附件和独立清单保留。

实际操作请使用[逐项人工验收清单](../acceptance/LoliCode-4.0.21-验收清单.md)，其中包含操作、预期结果、待条件事项和问题反馈模板。

- [官网](https://lolicode.com/)
- [安装版：自动选线](https://lolicode.com/downloads/releases/4.0.21/LoliCode-4.0.21-Windows-x64-Setup.exe)
- [便携版：自动选线](https://lolicode.com/downloads/releases/4.0.21/LoliCode-Portable.zip)
- [GitHub 正式发布页](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v4.0.21)
- [公开构建回执](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.21/release-build.json)

安装器 23,869,353 字节，SHA256 `c0d4558b875f60598346cea3f70ee196aac1caff64eb63060100c333d7f8ff80`。签名文件 420 字节，SHA256 `503a8dca50aba8775f718c5465f13e4b277712c7ac53fe0abfbe1ab5d19e3970`。便携 ZIP 30,026,181 字节，SHA256 `223c0ca681bceb8f2843e8ccaf3ad47eff5c19890805b2889247edad2bcffc04`。

源码冻结于 `2c0723825e5e11e4f4670a680d50262f400484e2`，在全新隔离目录导出归档并构建，归档 SHA256 `e42d14d033585b44d2e9d397cebfa26fca55700baedf880c157dbb3d36ff9685`。沿用原 LoliCode updater 公钥，应用标识和数据目录未变。NSIS 更新签名有效；没有 Windows Authenticode 证书。打包之后的发布脚本与文档提交不改变此冻结包。

## 实际验证

前端 3,094 项、桌面 Rust 3,852 项通过，12 项既有忽略。签名与发布／安装保护专项通过；实际生产包 115 份资源、5 份许可证两次提取匹配，便携 ZIP 的 120 份文件匹配；离线本体自检通过，看板娘 PNG 已内嵌。

另行运行了真实原始安装器：在专用 UUID 目录中安装 4.0.20，覆盖到 4.0.21，再重复安装 4.0.21，三次均返回 0。每步检查 5 份许可证及独立测试 profile 的项目／伪 Key／记忆哨兵文件不变；升级后实际安装程序离线自检通过。安装器写入的产品注册项在 finally 恢复后，逐项核对两个注册视图的值与类型均匹配原快照。没有运行卸载器或打开真实用户配置。

Tauri 在 NSIS 中嵌入安装类型标记，安装版程序与便携程序因此有明确的 3 字节差异。以冻结程序和唯一标记计算的预期完整安装哈希为 `1df9f39a1f68379a15bd7cc3e22e217abe3267e11298ff3b369600054803da7b`，实际安装文件匹配；没有忽略其他差异。首次辅助校验误将 LICENSE.txt 漏算、第二次未处理安装标记的失败记录均保留，修正后重新完整验证。

官方 Tauri updater SDK 模拟 4.0.20，从实际默认正式地址识别 4.0.21，并完整下载 23,869,353 字节、通过公钥验签。4.0.21 自查无重复更新。官网浏览器页面已刷新，版本、安装版、便携版和 GitHub 备用都指向 4.0.21。两个公开清单字节相同，SHA256 `3fa1dfa2739819696cf1834c366aa1966bc43a9b0b1ef828f31fa6d008d060e3`。

## 下载与后续小更新

官网仅选路，安装包正文不经官网服务器。默认选 R2，健康检查失败选同版本 GitHub；受控停止新版选线服务时，三个 Nginx 入口均回退同版本 GitHub，服务随后恢复。原 4.0.20 入口保留。4.0.21 腾讯镜像尚未同步，页面不会拿旧版腾讯文件冒充本版；下载中断后的自动跨来源续传仍未实现。

此包包含完整前端更新加载器。后续兼容的界面整包可独立签名发布，下载校验后在下次启动启用，未确认启动或资源损坏时恢复。Rust、权限、数据库变化仍需要完整安装包。目前默认界面更新清单尚未发布；不能把此加载器交付说成真实 WebView 热更新已通过。

真实账户的 SQLite／项目／凭据迁移连续性、桌面点击后的完整安装重启、真实 WebView 界面更新、WSL、UE Editor 与 macOS／Linux 等仍需各自验收。下载验签与上述隔离安装不替代这些范围。

本机完整证据位于 `release/acceptance/stable21-*`：实际安装、注册项恢复、安装程序自检、默认更新器、正式清单、多版本路由、故障回退、正式交付检查器及官网截图。持续目标保持 active。
