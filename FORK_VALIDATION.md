# 完整复制基线验证

日期：2026-10-13。上游 `479964f2ef59e291f563218ac674a1fd82dcdbd3`。下面保留首次纯复制时的验证记录；后续用户授权修复见末尾。

## 已通过

- 1,568 个文件 blob 哈希全部一致；纯复制提交 `b04540d` 的 Git tree 与上游相同。原许可证、文件执行标记和完整前后端均保留。
- pnpm 10.12.3 冻结锁文件安装、TypeScript 检查、Vite 前端构建与原前端 Prettier 检查。
- 原 Rust 1.95 工具链下编译检查、格式检查与 Windows debug 可执行程序构建。
- 后端单元测试 3,600 项通过；14 个后端集成测试目标合计 143 项通过，无失败。
- 前端全量低并发复核 2,610 项通过；App 集成测试单独运行 20 项全部通过。
- 原生程序使用独立测试应用标识与隔离空白配置启动，进程保持运行并成功初始化自己的数据库；验证后仅结束测试自身进程。

原生验证包使用仓库外的 Tauri 配置覆盖标识、禁用测试 URI 注册与更新入口；源 tauri.conf.json 不变。构建后保存独立验证程序，避免后续 Cargo 测试重建同名程序时覆盖验证配置。WebView2 使用已安装的运行时和独立用户数据目录。

## 尚未通过的原测试

- 前端首次并发全量结果：2,607 通过、5 失败。降低并发后的全量结果：2,610 通过、2 失败。
- 剩余前端失败位于 App 集成测试：基本供应商流程超时，随后滚动重置用例发现重复 provider-list。该文件单独运行 20 项通过，因此记录全量运行不稳定，不宣称整个前端测试全绿。
- 后端单元测试有 1 项失败、10 项忽略。失败项 `services::provider::tests::import_hermes_providers_from_live_updates_existing_provider_from_live` 期望 1 个对象，实际 2 个；单独复跑仍失败。
- 首次默认并发编译全部后端测试触及 Windows 内存/页面文件限制；单并发编译后测试可执行。没有改动系统页面文件设置或上游源码。

本轮按用户“先完整复制”的要求保留这些原始用例和实现，后续修改时可作为回归依据。

## 验证范围

Node 实际使用 24.19，仓库 .node-version 原样保留为 22.12.0；pnpm 与 Rust 使用原固定版本，未更新锁文件。

原生启动验证没有导入用户真实 Key、切换真实客户端、迁移旧 FreeHub 数据或覆盖正在运行的原 CC Switch。后续复查发现，原后端 Hermes 测试 helper 未隔离 Windows 平台目录，曾向本机 Hermes YAML 留下一条测试记录；修复和清理记录见下方。真实供应商、全部原生 UI 操作、干净 Windows 安装与升级尚未验收。

Windows 程序输出：`src-tauri/target/debug/cc-switch.exe`。它是本轮原版基线的验证构建，当前产品界面仍为 CC Switch，TAI 品牌和发布安装包留到后续定制阶段。

## 本机证据

以下文件仅保存在本机，不提交测试运行数据：

- `C:/Users/admin/.codex/artifacts/tai-switch-upstream-copy-verification.json`
- `C:/Users/admin/.codex/artifacts/tai-switch-frontend-full-tests.json`
- `C:/Users/admin/.codex/artifacts/tai-switch-app-tests.json`
- `C:/Users/admin/.codex/artifacts/tai-switch-backend-tests-serial-build.log`
- `C:/Users/admin/.codex/artifacts/tai-switch-hermes-test.log`
- `C:/Users/admin/.codex/artifacts/tai-switch-backend-integration-tests.log`
- `C:/Users/admin/.codex/artifacts/tai-switch-native-startup.json`
- `C:/Users/admin/.codex/artifacts/tai-switch-native-verification-build.log`

服务器任务书已更新为 v0.4，旧稿备份：`/www/backups/free-gateway/taskbook/TASKBOOK.v0.3.20261013-180108.38c18fe2.md`。新稿 SHA256 为 `4dd3d64a8f6aa0e6cced1f31816b4ea383f23c979bf86c51d79b94dabed8b873`。

## 2026-10-13 测试修复与 TAI 打包

用户要求检查失败代码、修复并交付 Windows EXE。修复基于纯复制提交，未更改供应商切换、路由、模型和计费算法。

- App 测试原本在第一条测试内动态导入庞大的应用模块，冷加载超过 10 秒会在超时清理后继续挂载，再污染下一条测试。改为测试收集阶段静态导入、提升 mock 初始化并清理每次创建的 QueryClient；原 10 秒操作断言仍保留。
- Hermes 的额外导入记录来自 Windows `%LOCALAPPDATA%` / `HERMES_HOME` 绕过旧测试 helper 的 HOME 隔离。统一复用 RAII TempHome，隔离并恢复这些变量，包括 panic 路径；增加环境覆盖隔离回归，并验证重复导入返回 0。导入算法保持原实现。
- 同时检查前次测试遗留：本机 Hermes YAML 中确有 `existing-hermes` 测试条目。仅在名称、地址、模型、测试凭据和完整字段集合全部匹配固定测试数据时移除；先在 Hermes 目录备份，比较移除前后的全部 YAML 语义，确保除了这一条测试记录之外的内容一致。清理后再次核对，测试条目为 0；没有导出或记录真实凭据。
- TAI 的应用标识、数据、设备设置、备份、自动启动名称与窗口文案独立。默认目录为 `~/.tai-switch`，不回退到原 CC Switch 的数据库。数据库文件名及数据结构保留，MIT 许可证和原作者署名保留。
- 本测试版关闭原 CC Switch 更新源和 `ccswitch://` 注册，安装包使用独立的 `TAI Switch Test` 产品目录。详细试用和构建步骤见 `TESTING_TAI.md`。

修复后验证：

- 前端完整 214 个测试文件、2,612 项测试全部通过。
- 后端单元测试 3,602 项通过、0 失败、10 项原有忽略；全部集成测试含 Golden 41 项合计 184 项通过、0 失败。
- TypeScript、Prettier、Rustfmt、Clippy（警告视为错误）均通过。
- 使用原固定 Rust 1.95 / pnpm 10.12.3。Cargo 锁文件仅更改本地项目包名；第三方依赖版本未更新。

本机证据：`C:/Users/admin/.codex/artifacts/tai-switch-fixed-frontend-tests.json`、`tai-switch-fixed-backend-tests.log`、`tai-switch-fixed-clippy.log`、`tai-switch-fixed-typecheck-final.log`（后三个同目录）。

### Windows 成品

- Release 构建与 NSIS 打包成功，Windows x64 GUI 程序（无控制台窗口），版本 4.0.10，产品名称 `TAI Switch Test`。
- 交付目录：`D:/projectGithub/TAI-Switch/release/TAI-Switch-4.0.10-test/`。
- 直接运行 `tai-switch.exe`：43,282,432 字节，SHA256 `954dffaba68480dfa73014c3fae307d1fd27e14b879c3914ff49bfe254ec9de7`。
- 安装包 `TAI Switch Test_4.0.10_x64-setup.exe`：12,086,265 字节，SHA256 `7b60cf166da51d19638a132c90aecaac8deb471124794d4f1672848b6b11505d`。
- 7-Zip 提取校验通过。安装包内程序与直接运行版仅存在 Tauri 预期的 bundle 类型标记差异（`UNK` → `NSS`），其余字节全部相同；对应 `tauri-utils::platform::bundle_type()` 的原实现。
- 直接运行版和提取的安装版分别在独立空白配置中启动，均存活、创建 `~/.tai-switch/cc-switch.db` 并启动 WebView2 子进程；测试目录没有 `.cc-switch`，原 CC Switch 进程均保留。验证仅结束自己创建的测试进程。
- 测试包未签名。未执行会修改安装注册表的安装向导，也未宣称已完成干净系统安装、升级、全部原生界面或真实供应商验收。

成品验证证据：`tai-switch-fixed-release-build.log`、`tai-switch-fixed-native-startup.json`、`tai-switch-fixed-installer-native-startup.json`、`tai-switch-fixed-installer-payload-verification.json`（均位于上述 artifacts 目录）。交付目录包含许可证、说明、测试摘要、启动验证与 SHA256SUMS.txt，全部构建产物不纳入 Git。

服务器任务书更新为 v0.4.1，SHA256 `bb2ffc80281730a934271623b08fe2bc9de4d7c86116acf0053fcacf194080c3`；旧稿备份到 `/www/backups/free-gateway/taskbook/TASKBOOK.v0.4.20261013.before-test-fixes.4dd3d64a.md`。服务器仍只负责任务书与 Git 备份。
