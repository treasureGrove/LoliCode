# LoliCode 4.0.21-rc.1 测试候选交付记录

2026-10-18 发布 Windows x64 测试候选，不替换稳定版 4.0.20。源码冻结于 `ee68a202b208c26ef3a9a7ead2f9ed6bf0688454`，对应源码归档 SHA256 为 `2a9841dac975dfa2fbe9961f4170d607d48ace047fa55cbd7851088c64a50f23`。版本文件已在该提交内统一，不在构建目录叠加未提交的版本补丁。后续本文等文档提交不改变已发布附件。

[测试版发布页](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v4.0.21-rc.1)已公开且标记 prerelease；GitHub Latest 仍为 `lolicode-v4.0.20`。

- [Windows 安装器](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.21-rc.1/LoliCode-4.0.21-rc.1-Windows-x64-Setup.exe)：23,438,605 字节，SHA256 `f239077c0e3090006db3a9b10c9c267c80a8accaccfd0c405a84f29471b8b10a`。
- [安装器签名](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.21-rc.1/LoliCode-4.0.21-rc.1-Windows-x64-Setup.exe.sig)：428 字节，SHA256 `3d9a8fce7864060d98415fc798b22807e18aa220f8e70ec783fa781d8f9358c4`。
- [便携 ZIP](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.21-rc.1/LoliCode-Portable.zip)：29,471,750 字节，SHA256 `345076fd52d2f41ca82e577fc389c2aff26007dafc35405f0e1c2469654a5fc8`。
- [公开构建回执](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.21-rc.1/candidate-build.json)：仅含公开来源、哈希与验收边界，不含本机私钥路径、账号或凭据。

## 构建与实际下载证据

原打包会话「修复任务执行时的项目切换」从冻结 SHA 单独归档，在 `release/build-4.0.21-rc.1-isolated/` 安装锁定依赖并运行 Tauri NSIS 构建，主工作树不参与构建。独立复核了四个产物的 SHA256 和 LoliCode updater 签名；公钥指纹继续为 `6e5f32bd5f6dd5c1d6257dd65678288769aec4c729a86b7cf497b29668db0b51`。

实际生成 NSIS 脚本引用的 hook 已比对，115 个载荷文件和 5 份许可证执行两轮隔离提取及哈希检查，哨兵保留。便携包 120 个文件与实际解压内容一致；提取主程序的版本为本候选版，离线 Agent 自检验证五个默认技能、真实临时文件读写、工具续接与会话重开，模型使用本机夹具且不读用户配置。看板娘原 PNG 1,807,059 字节仍内嵌在生产 JavaScript。

GitHub CLI 附件上传遇到 uploads 域重定向失败后，保留同一个草稿，通过既有受控发布主机上传四份已验证文件；凭据只经加密 SSH 输入并在请求内存使用，不写入脚本、报告或命令参数。附件大小与 GitHub digest 核对后才公开测试版。随后匿名完整下载安装器、签名及便携包，实际字节数和 SHA256 均与本地一致，见 `release/acceptance/candidate-github-public.json`。

## 更新器检查

独立候选清单为 [updates/4.0.21-rc.1.json](https://tools.treasuregrove.art/lolicode/updates/4.0.21-rc.1.json)，只引用精确版本的 GitHub 安装器。使用独占目标和原子启用发布，不改 `latest.json`。候选清单 SHA256 为 `37e0732d928593b6ce28901cb8580d669f4b3f843a7430dbc4246ee77fe15a67`。

正式 Tauri updater SDK 的隔离 MockRuntime 模拟当前 4.0.20，经公开候选清单实际下载 23,438,605 字节，签名验证通过，SHA256 与本地相同。没有执行安装、退出 hook、重启或 WebView，也没有读取用户配置。模拟当前候选版检查相同候选清单返回无更新；模拟当前 4.0.20 检查默认稳定清单仍返回无更新。证据见 `candidate-native-updater.json`、`candidate-self-no-update.json`、`candidate-stable-no-promotion.json`。

两处稳定 `latest.json` 保持 4.0.20 / `4691d49885f5a2d9ceaf2962d2a9fe78368cc56ada5942d5f674ee1280190936`。本候选暂未上传 R2 或腾讯线路；不能把稳定版的多源覆盖当作候选版已覆盖。

## 网站与待完成范围

官网及工具站更新说明调整为摘要与可展开完整说明，使用文本节点渲染。网站源码已推送 `treasureGrove/TAWEBTOOL` 的 `main`，SHA `577372633b447ff05a0f5630b1efdb57865a7e7c`。145 项网站检查通过；生产浏览器验证了展开、折叠、稳定下载链接和桌面无横向溢出，线上两站静态字节哈希一致于构建，社区与 API 正常。候选版本没有混入稳定首页下载推荐。当前开发桌面进程已按源码重启；实际桌面交互不因进程存在而视为通过。

本次仍未执行真实完整安装、第二台电脑覆盖升级与重启后的项目/Key/记忆保留检查，安装器也未作 Authenticode 签名。macOS/Linux、真实 UE Editor、SSH/WSL、本体完整前端行为热更新、指定 testkey 及腾讯下载证书仍有未完成项。完整 goal 保持 active，范围见[持续验收](../architecture/continuous-acceptance.md)。
