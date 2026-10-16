# LoliCode 4.0.16 交付记录

2026-10-16 已发布 Windows x64 安装版、便携包与独立签名更新，并上线新版下载官网。

- [官网](https://lolicode.com/)
- [安装版 EXE](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.16/LoliCode-4.0.16-Windows-x64-Setup.exe)
- [便携 ZIP](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.16/LoliCode-Portable.zip)
- [GitHub 发布记录](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v4.0.16)
- [应用内更新清单](https://tools.treasuregrove.art/lolicode/updates/latest.json)

同日已将软件官网迁至 lolicode.com 首页，社区入口为 `/all`，安装包改由公开的
LoliCode-Releases 分发仓库托管。源码仓库保持私有，现有更新清单地址继续兼容；
详见[官网与 GitHub 下载交付](lolicode-home-github-delivery.md)。

## 源码与范围

应用从提交 `0b10f5941cc3b8528cf3afb5514ca6ce78d2837f` 的独立干净目录构建；标签为 `lolicode-v4.0.16`。工作区中其他尚未提交的 Agent、平台与界面原型未混入本次发布，原工作保留。

本版包含 LoliCode 账户昵称与头像、头像菜单中的设置与更新、导航整理、自有文档和更新入口。官网源码为 TAWEBTOOL 提交 `06d5c4c3bff4a5248054f0cfbf07d240df7b6ba4`，发布仅替换 `/lolicode/` 子站，保留工具站其他内容和更新。

必要 MIT 版权、固定上游来源和第三方许可继续保留。UE、酒馆、语音、长期记忆与更多角色交互仍为后续计划；macOS、Linux 安装包本轮未发布。

## 文件与校验

- 安装器：21,746,554 字节；SHA256 `18b9388d68e12e281d465215738a108b84c791984f60a5abe45017e76c284ba0`。
- 便携包：26,186,973 字节；SHA256 `1abc2bf82e9295e270486d200d64408ac102ad7468a8484ed2c1c48b3dec3e45`。
- Tauri 公钥指纹：`6e5f32bd5f6dd5c1d6257dd65678288769aec4c729a86b7cf497b29668db0b51`。私钥未进入仓库、产物或服务器。

发布器完成 SCP、远端字节数与哈希核对、公网完整下载安装器/便携包及签名复验后，最后原子替换 `updates/latest.json`。网页角色图片另加版本参数，消除旧缓存；最终公网 HTML 与网站提交中的 HTML 哈希一致。

## 已验证

- 独立目录 TypeScript 检查、Vite 构建和正式 NSIS 签名构建成功。
- 前端全量 3,032 项检查中，3,031 项首轮通过；一条仍期待旧官网的断言修正后，包含该用例的 29 项更新界面相关检查复验通过。
- 发布/验签工具 15 项测试、官网实际下载脚本 8 种清单场景通过。官网桌面和手机布局已检查。
- 安装器解包后资源精确包含 5 个默认技能、110 个源文件和 4 个元数据/许可文件，逐文件 SHA256 与固定来源一致。
- 便携包通过 ZIP 完整性检查；安装器解包的实际程序与便携实际程序均通过 `--check-agent-runtime`，验证读写、继续任务及会话重启。本体引擎为 Rust，无外部引擎进程，没有付费模型调用。
- 官方 Tauri updater SDK 使用默认公开更新源，从固定旧版本 **4.0.15** 识别 **4.0.16**，下载 21,746,554 字节并成功验签。见[原始结果](../images/lolicode/4.0.16/native-updater-public-proof.json)。

## 验收边界

上述检查没有代替用户运行安装器或做原地安装/重启，也未使用真实 LoliCode 账号登录。另一台 Windows 电脑上的首次安装、真实渠道配置及真实账户体验仍由用户验收。Tauri 更新签名与 Windows Authenticode 代码签名是独立机制，不能混称。

便携版需要完整解压整个目录，保留 `agent/` 和 `portable.ini`。安装版支持应用内更新；Windows 需要 WebView2，安装器按需引导安装。
