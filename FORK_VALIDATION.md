# 完整复制基线验证

日期：2026-10-13。上游 `479964f2ef59e291f563218ac674a1fd82dcdbd3`。本记录只描述复制与验证，未修改原业务源文件。

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

验证没有导入用户真实 Key、切换真实客户端、迁移旧 FreeHub 数据或覆盖正在运行的原 CC Switch。真实供应商、全部原生 UI 操作、干净 Windows 安装与升级尚未验收。

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
