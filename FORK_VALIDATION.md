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

## 2026-10-14 Astra 太极界面

基线经用户试用确认后，按用户指定由 `gpt-6-astra` 实现太极主题。采用宣纸与玄墨双主题、墨色侧栏、朱砂操作色、太极品牌及应用图标、胶囊模式切换和供应商卡片。切页只对原有元素做透明度动画，不修改页面 key 或导航守卫；侧栏收放继续使用原合成动画，并读取侧栏自身的主题色。增加系统减少动态效果与高对比模式适配。

供应商、路由、计费算法、Rust 源码、依赖和数据库结构均未修改。独立审查修正了深色热力图的最高档颜色和键盘跳转链接的文字对比度。

界面验证：

- 214 个前端测试文件、2,612 项测试全部通过；最终导航动画实现额外复跑 App 集成测试，20 项通过。
- TypeScript 与改动的 TS/TSX、CSS、Tailwind 配置及四份语言文件的 Prettier 检查通过。第一次完整格式检查因本机内存不足退出，随后完成了上述改动文件的精确检查；未修改的文件沿用已验收基线。
- 浏览器使用 repo 外独立模拟入口，加载真实 React 界面；全部供应商、额度与金额为内存示例数据，外部连接被阻止。模拟入口不参与正式构建。
- 验证默认 1000×650 和最小 900×600 窗口，包含手动展开 200px 侧栏；页面无横向溢出，底部导航和窗口操作位于可见范围。
- 实际操作验证明暗主题、供应商新增表单、路由视图、用量统计、侧栏开合及未保存内容确认；选择“继续编辑”后草稿名称保留。
- 前端生产构建通过。原生打包第一次遇到 LLVM 内存不足，结束本次预览与测试后重试；未修改系统内存设置或结束用户的其他应用。

测试证据：`C:/Users/admin/.codex/artifacts/tai-switch-taiji-frontend-tests.json`、`tai-switch-taiji-app-final.json`、`tai-switch-taiji-typecheck.log`（同目录）。界面截图位于 `tai-switch-taiji-ui-evidence/`；截图中的数据不代表真实调用或账户费用。

### 太极 UI Windows 成品

- Release 重试及 NSIS 打包成功；日志为 `C:/Users/admin/.codex/artifacts/tai-switch-taiji-release-build-retry.log`。
- 新交付目录：`D:/projectGithub/TAI-Switch/release/TAI-Switch-4.0.10-taiji-20261014/`。旧基线成品保留且复核哈希未变。
- 直接运行 `tai-switch.exe`：43,290,624 字节，SHA256 `028eb0dde627fe876b3f7e5dfa2534537dc9b17103dd0d3f3e45c6cd016281d5`。
- 安装包 `TAI Switch Test_4.0.10_x64-setup.exe`：12,089,405 字节，SHA256 `54f9b2755ad2cf92f3b37aedf41d49552acde7d972eb759ec6fa1b29715fa25f`。
- 安装包提取校验通过：内含 EXE 与直接运行版仅存在预期 Tauri 标记 `UNK` → `NSS` 差异，其余字节完全相同。
- 用户退出旧 TAI 后，分别在两个全新临时配置目录启动直接运行版和安装包提取版。两者均保持运行、创建隔离数据库并启动 WebView2 子进程；没有创建 `.cc-switch`，原 CC Switch 进程保留，仅结束本次检查自身进程。
- 交付目录保存界面测试摘要、两份启动记录、安装包内容校验、示例截图、试用说明、许可证、源码提交记录与 SHA256 清单。程序继续使用用户已有 `.tai-switch` 配置，截图使用示例数据。
- 本轮没有重新运行未改动的 Rust 业务测试、调用真实渠道或执行修改安装注册表的安装向导；测试包未签名，干净系统安装和升级仍待验证。

服务器任务书已更新为 v0.4.2，SHA256 `39e5d287d82e8d77a80db963d48debd38449d4b73a3dba4971141896912d3d68`；旧稿备份为 `/www/backups/free-gateway/taskbook/TASKBOOK.v0.4.1.20261014.before-taiji-ui.bb2ffc80.md`。未修改服务器网站或定时任务。

## 2026-10-14 桌面导航与连续动效

实现提交为 `39862f91d6c6886f4d4ffcfbfe4ee81b4178ee1d`。根据 `UI_REBUILD_HANDOFF.md` 重组客户端切换和任务导航、供应商工作台、设置与用量布局，统一页面、面板、分段控件、菜单和操作反馈。外壳、设置及用量由 Astra 设计与实现；其余由主执行者与协作代理完成。MCP、Skills、会话及客户端专属复杂编辑器保留业务布局并继承共享系统，未把共享样式覆盖冒称为全部页面重做。逐项范围见 `docs/UI_REBUILD_COVERAGE.md`，设计规则见 `docs/UI_MOTION_DESIGN.md`。

页面动画保持原业务 key 边界；退出面板立即不可交互、隔离重复 ID，并维持底页锁直到真正移除。新增/编辑关闭先完成草稿保护，保存中禁止重复关闭。独立审查发现并修复默认输入框 Esc 误关闭、旧 Skills 发现入口 Esc 返回失效两项回归。Rust 业务源码、依赖版本、数据库结构和计费算法未改。

### 本轮验证

- 最终源码全量前端回归：**218 个文件、2,641 项全部通过，0 失败、0 跳过**；单 worker、关闭文件并发，用时 574.72 秒。证据：`C:/Users/admin/.codex/artifacts/tai-switch-ui-rebuild-final-full-tests.json` 及同名 `.log`。JSON 的 561 是嵌套测试组数量，不是文件数。
- TypeScript 与改动文件的 Prettier 检查通过。最终前端生产构建通过，入口 `index-Dm4iYZGe.js`、样式 `index-7wyBhni3.css`。
- 浏览器使用仓库外隔离入口加载真实 React 组件，明确标记模拟供应商/金额并阻止外部连接，正式构建不含模拟服务。验证 1000×650 明亮工作台、900×600 深色用量、导航、侧栏、详情连续反向切换 10 次、模式视图连续切换 10 次，以及草稿取消/继续/确认放弃。搜索输入框 Esc 后焦点回到搜索按钮。
- 两张示例截图位于 `C:/Users/admin/.codex/artifacts/tai-switch-motion-evidence/`；截图中的供应商和金额不代表真实业务记录。
- 默认并发测试与构建同时运行时发生内存分配失败；保留失败日志后改为低并发串行完成。未修改系统内存设置或结束用户其他应用。

### 原生检查范围

较早的构建在独立临时配置中打开了原生窗口，读取到实际 WebView2 控件结构。窗口截图工具连续报告 `D3D11CreateDevice 0x887A0004`，坐标输入缺少窗口几何；单窗口录制也遇到内存不足，只产生一帧，未作为交互证据。仅结束本任务自建测试进程，未读取或展示真实 Key，未调用真实模型。

用户随后明确要求“**不用录屏，我自己debug**”，因此停止窗口操作和录屏，不再安排该项验收。最终版本的原生交互、125%/150% 系统缩放、减少动态效果实机体验及帧率采样均由用户后续调试；不宣称持续 60fps。没有运行修改注册表的安装向导，也未重复运行未改动的 Rust 业务测试。

本轮交付使用独立目录 `release/TAI-Switch-4.0.10-motion-20261014/`，旧 test/taiji 成品保留。最终程序、安装包及资源核对结果随交付目录的 `README.md`、`SHA256SUMS.txt` 和安装包内容校验记录提供；早期含 `index-B1dkIbPh.js` 的构建不作为最终交付。
