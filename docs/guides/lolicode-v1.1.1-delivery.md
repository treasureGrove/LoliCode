# LoliCode 1.1.1 交付记录

2026-11-12 发布 Windows x64 NSIS 安装版、Tauri 更新签名、便携 ZIP 和公开构建记录。产品版本、程序原生版本及实装版本均为 `1.1.1`，GitHub Latest 已指向本版。[GitHub 发布](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v1.1.1)

## 更新内容与升级入口

修复侧栏额度按钮的点击和键盘操作：打开额度预览后可进入「管理用量」。保持用量与记忆位于设置、额度整合进用量页的现有设计。

安装版用户可在设置的「关于」页点击「下载并安装」，应用内下载签名包后走 NSIS 覆盖更新；便携版用户从下载页获取 ZIP。

- `1.1.0` 使用正式 `/lolicode/updates/stable.json`，现提供 `1.1.1`。官网代理返回相同清单字节，SHA-256 为 `ed3f2f0795cd90c4305bd3347d5a6b7418e679e9af164ef28472c75a539c3a34`。
- 旧 `/lolicode/updates/latest.json` 的兼容清单保持原字节不变：比较版本 `4.2.0`、产品版本 `1.1.0`，仍指向已发布的 `1.1.0` 迁移安装器。其 SHA-256 为 `9890819f3691137c79f8d8feccfed6359f37d051cdd3d8d44975b4f5caf0c4f3`。旧 4.x 客户端先迁移至 1.1.0，再通过正式清单升级至 1.1.1；本轮未把迁移清单改指新包。
- 官网和工具站下载页均显示 `1.1.1`，安装版和便携版按钮指向本版。已匿名完整下载 GitHub 的四份附件及官网三份下载入口文件，逐件核对字节数与 SHA-256。[官网](https://lolicode.com/) · [工具站](https://tools.treasuregrove.art/lolicode/)

## 下载验签与实际覆盖安装

- 公网候选及正式地址均使用官方 Tauri updater SDK 的 MockRuntime，模拟 `1.1.0` 检测 `1.1.1`，完整下载本次安装器并通过更新签名验证；模拟 `1.1.1` 返回已是最新版且不下载。两次验证绑定本次安装器 SHA-256 `1afc8fdfa91e54f7ab1e45a593b975fdbf31e1f5183391ac8558de329d9deb2f`。MockRuntime 不创建 WebView、不执行安装器，也不读取用户配置；这是下载验签证明，不能替代实装验收。
- 实际安装在隔离标准 Windows 账户中进行：实装已发布的 `1.1.0`，创建真实 Harness 会话与渠道，然后用本次 `1.1.1` 安装器覆盖原目录。覆盖后、应用重启后、重复安装同一个签名包后，均在同一账户、配置目录及会话中继续发出新模型请求，并验证先前上下文。
- 安装及同包重装均保留 Harness 会话文件，三个阶段使用相同的新版可执行文件。此项证据是 `harnessHistoryResumed`，没有把旧引擎迁移的 `legacyHistoryResumed` 当作 Harness 原生会话恢复。测试账户、配置、进程和临时安装器已清理，目录权限已恢复。
- 冻结运行时为 Harness `0.2.2-rc.1`。验收工具提交为 `5374c6a9a547f3eeedd52e6132b9b276ebedcd38`。

另一会话的 Harness `0.2.2-rc.2` 仍有兼容性失败，包括 `subagents.listChildren is not a function`，未纳入本版；本版保留已通过本地用户验证和上述升级验收的 `rc.1`。

## 构建与持续集成

- [正式源码](https://github.com/treasureGrove/LoliCode/tree/5374c6a9a547f3eeedd52e6132b9b276ebedcd38)提交 `5374c6a9a547f3eeedd52e6132b9b276ebedcd38`；本地冻结提交 `ff5a8c3cba4cdab5ae787bbc01a6ab940db056f1`；源码树 `c6ff7635e2cad97580a38dc04b1e385b418fde7b`；归档 SHA-256 `3d5a51b1a4d88e9e8f892d76bb2ff8233d60c153df211ffad8ccadeb5bdd852d`。
- 本轮正式构建为避免本机 LLVM 内存不足，使用 `CARGO_BUILD_JOBS=1`，并通过 Cargo 命令行仅将主 crate 的 `profile.release.package.lolicode.codegen-units` 覆盖为 `64`。构建仍使用 release profile、`opt-level=s` 和 `lto=thin`；此次参数覆盖未修改冻结源码快照。
- NSIS 载荷提取后通过离线运行检查；便携 ZIP 解压核对 70,268 个文件并通过离线运行检查。
- [main CI](https://github.com/treasureGrove/LoliCode/actions/runs/43167464758) 与正式代码提交一致，全部 6 个 job 成功。前端类型、格式、单元测试、Harness 集成测试和前端构建全部通过。
- Backend Checks (Windows + WSL2 home)：1 项通过，0 项失败，4219 项未纳入该专项。
- Backend Checks (ubuntu-22.04)：4,409 项通过，0 项失败，21 项跳过。
- Backend Checks (windows-latest)：4,383 项通过，0 项失败，21 项跳过。
- Backend Checks (macos-latest)：4,423 项通过，0 项失败，21 项跳过。

本轮下载默认使用 GitHub，R2 镜像未同步。更新包使用 Tauri 签名；本轮安装器未配置 Windows Authenticode 签名。

## 公开产物

- `LoliCode-1.1.1-Windows-x64-Setup.exe`：176,815,208 字节，SHA-256 `1afc8fdfa91e54f7ab1e45a593b975fdbf31e1f5183391ac8558de329d9deb2f`。
- `LoliCode-1.1.1-Windows-x64-Setup.exe.sig`：420 字节，SHA-256 `a187621460461b936127906f2e451cc2e90085b7d1bed549b155d404f4a7120c`。
- `LoliCode-Portable.zip`：325,385,164 字节，SHA-256 `e9140fd25990571992387a338cdcb398c50f483b9ae6f787702d470eae13463c`。
- `release-build.json`：1,224 字节，SHA-256 `cefad81ae48884c57ddab62816ae19359cc4a357cdcfffb5135f93e061d2653a`。
