# LoliCode Android 伴随端：实现状态与联调验收

2026-10-26 更新：新客户端改为同账户登录和仅直连，任务内容不经服务器
转发，也不回退中继。当前流程见[账户与直连指南](lolicode-mobile-account-direct.md)。
本文以下保留 2026-10-23 的 v1 配对、中继及已公开测试通道记录，不能作为
新账户直连的验收结果；旧二维码入口已从新桌面 UI 移除。

日期：2026-10-23。

状态：已进入实现阶段，原生 Android 客户端、电脑后台桥接和设备中转已有代码与自动化验证。公网 WSS 的加密往返及撤销凭据检查已通过；真实手机、电脑 Win+L 锁屏执行和窗口焦点仍待验收。当前桌面正式旧版不具有手机配对入口，联调需要本次开发版。

## 框架与双端目录

Android 使用 **Kotlin + Jetpack Compose**，是可独立在 Android Studio 打开的 Gradle 工程。手机界面按移动交互单独实现，通过 OkHttp WebSocket 通信；不依赖桌面 React 界面、Tauri Android、桌面 Rust 编译或 NDK。

- 电脑主目录：`D:\projectGithub\TAI-Switch`，分支 `TG/freehub-m0`。保留现有电脑工作及未提交修改，负责桌面配对入口、原生后台通信和任务执行。
- Android 工作树：`C:\Users\admin\.codex\worktrees\lolicode-android\TAI-Switch`，分支 `TG/android-companion`。Android Studio 打开其中的 `apps/android`；Android 客户端、`packages/companion-relay`、`deploy/companion` 和 Android 下载准备脚本在此开发。
- 两端保留本指南与[冻结的 companion v1 协议](../architecture/companion-protocol-v1.md)。协议调整须同步验证兼容性。

两个目录可同时开发，各自分支、源码编辑和构建输出分开。Android 工作树中的桌面文件是仓库基线，当前电脑桥接实现从电脑主目录运行。本机 JDK／SDK 路径、`local.properties`、APK 输出和私钥不作为跨机器源码依赖。

Android 包名为 `art.treasuregrove.lolicode.mobile`，测试版本 `0.1.0-alpha.1`，最低 Android 8.0，版本与电脑发行版本独立。

## 已实现的任务路径

手机负责输入和展示，电脑负责模型请求和任务执行，模型配置与凭据留在电脑。当前支持：

- 电脑生成五分钟有效的新配对二维码，手机扫码或粘贴 JSON，电脑明确确认设备；每台手机单独配对，可撤销。
- 手机读取电脑已打开的项目和可用模型，创建手机所属会话、发送任务、读取进度与结果、查看文本及文件差异。
- 处理当前有效的单次审批与提问、停止任务。服务端校验会话所属配对，不能访问其他手机或本机私有会话。
- 手机切后台、锁屏或断线时关闭前台连接，电脑持有任务；返回后重新认证并读取快照，不自动重发有副作用的任务。
- 已保存但未收到确认的配对可以重连查询电脑批准状态，避免手机在后台时批准后被原二维码有效期困住。

电脑入口为 `src-tauri/src/services/mobile_companion/`、`src-tauri/src/commands/mobile_companion.rs` 和 `src/components/shell/MobileCompanionDialog.tsx`；执行复用 `inprocess_agent.rs` 和 `crates/lolicode-agent`。通信与任务监测由 Rust 后台持有，不依赖工作台页面打开，也不通过再次启动程序或前台选择项目投递任务。

## 静默后台模式与边界

手机会话使用持久化的 `backgroundOnly` 策略和 `permissionMode:"ask"`。当前开放文件／图片读取、目录与内容检索、逐次审批的文件写入和补丁，以及提问、技能读取和受限记忆能力。工具在模型可见目录及实际执行入口均受策略限制。

**首版禁用 shell／终端命令、Git 命令、构建测试命令和交互桌面工具。** 不能声称远程任务已运行测试、提交 Git 或操作可见应用。后续完成执行环境隔离和静默验收后，才考虑开放这些工具。

远程任务要求不显示、恢复或聚焦 LoliCode 窗口，不切换电脑当前项目、会话、页面，不发出电脑端审批或完成弹窗。用户对“不会被电脑窥屏”的澄清是电脑屏幕不会跳出 LoliCode；任务历史仍正常保存在电脑，不承诺对本机管理员隐藏数据。

电脑需要开机联网、用户已登录且 LoliCode 后台实例运行。Win+L 与睡眠、休眠、关机和注销不同；本轮不实现注销后运行或远程开机，不自动修改电源、Windows 登录及防护设置。任务仍消耗计算与磁盘资源。显式项目绑定避免前台选择变化，但不保证用户同时编辑同一文件时没有冲突；并行联调使用独立测试工程或工作树。

## 配对与传输

当前使用 `wss://lolicode.com/companion/ws` 公网设备中转，与现有模型额度／推理转发服务分开。每个配对有独立房间、电脑令牌、手机令牌和 AES-256-GCM 密钥；中转认证角色并转发加密包，密钥不进入中转。端点校验消息方向、认证数据、时间窗及重放；变更请求有持久回执与去重，只读轮询不占永久变更回执额度。

电脑凭据进入系统凭据库，手机凭据经 Android Keystore 加密后保存。二维码／JSON 含访问凭据，只展示给自己的手机。手机移除设备仅清除本地记录，彻底停止访问使用电脑端撤销。撤销先在本机拒绝任务和审批，再使中转凭据失效，离线时保留撤销重试能力。

公网检查已验证 WSS 建连、测试房间双向加密往返、撤销后旧令牌拒绝和健康接口 `pushConfigured:false`。该检查使用临时测试端点模拟业务消息，**没有调用真实桌面 Agent，也没有操作真实手机或验证锁屏行为**。

P2P／WebRTC DataChannel 为后续优化，当前未实现直连、ICE 协商或直连失败回落，不列为本轮验收通过项。

## 系统推送由用户明确暂缓

本轮没有 Firebase 项目或实际推送配置。FCM 适配代码保留，Android 显示“系统推送暂未启用”，中转报告未配置；**手机锁屏后不会收到审批或完成系统通知**。当前在应用前台查看审批与进度，返回应用读取最新状态，电脑任务不依赖手机前台存活。

恢复推送时需提供真实 `google-services.json`，仅在中转服务器配置 FCM 服务账号，再验收通知权限、Doze、省电限制与送达。通知只包含通用提示与事件标识，点击解锁后获取快照并再次确认审批，无锁屏直接批准。服务商接受发送不能代替真机送达证据。

验收设备为红米 Turbo4p 和小米 8 Lite，两台均有 Google Play／Google Play 服务。系统版本、相机扫码、Keystore 和锁屏行为仍需分别实测。

## 已记录的自动化验证

本轮通过结果如下，均不能替代真实设备体验验收：

- 电脑 mobile companion：9 项，包括加密认证、所有权、撤销、变更去重、只读轮询及批准状态恢复。
- 原生 Agent：118 项；其中静默后台专项 3 项覆盖工具封锁、独立项目绑定、持久化及单次审批策略。
- Android JVM：11 项，覆盖跨语言 AES-GCM 向量、篡改／方向／重放／时间／大小限制、本地真实 WebSocket 往返及已保存配对恢复；debug、R8 release 构建和 lint 已验证。
- 电脑手机连接 UI：6 项；Sidebar 回归：15 项。
- 独立中转：17 项，包括角色认证、传输边界、撤销持久化及模拟 FCM 行为。

## 可重复构建与联调

Android Studio 打开 Android 工作树的 `apps/android`。使用 JDK 17、SDK platform 35 和 Build Tools 35.0.0，Gradle wrapper 固定版本。本机可复用已有工具链，以下环境变量只作用于当前终端；其他机器替换为自己的路径：

```powershell
Set-Location -LiteralPath 'C:\Users\admin\.codex\worktrees\lolicode-android\TAI-Switch\apps\android'
$env:JAVA_HOME = 'D:\projectGithub\TAI-Switch\tmp\android-toolchain\jdk-17.0.20.1+1'
$env:ANDROID_HOME = 'D:\projectGithub\TAI-Switch\tmp\android-toolchain\sdk'
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:lintDebug --console=plain
```

APK 输出在 Android 工作树的 `apps/android/app/build/outputs/apk/`，测试报告在 `app/build/reports/tests/testDebugUnitTest/`。原始 release 输出未签名；`sign-release.ps1` 使用独立 Android 应用签名身份生成并验证测试 APK，私钥不进入源码和下载目录。具体流程见 Android 工作树的 `apps/android/README.md`。

电脑和中转回归可在各自目录重复：

```powershell
Set-Location -LiteralPath 'D:\projectGithub\TAI-Switch'
cargo test --manifest-path .\src-tauri\Cargo.toml --lib mobile_companion::tests
cargo test --manifest-path .\crates\lolicode-agent\Cargo.toml --lib
pnpm exec vitest run tests/components/MobileCompanionDialog.test.tsx tests/components/Sidebar.test.tsx

Set-Location -LiteralPath 'C:\Users\admin\.codex\worktrees\lolicode-android\TAI-Switch\packages\companion-relay'
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
```

公网传输复验使用 Node.js 24，在 Android 工作树根目录运行：

```powershell
node .\scripts\tests\companion-public-smoke.mjs wss://lolicode.com/companion/ws
```

该脚本创建并撤销自己的测试房间，不使用用户配对，结果仍只证明传输层。每次产生持久撤销记录，按实际复验需要运行。

真实联调从电脑主目录启动支持手机连接的开发版，在头像菜单“连接手机”生成二维码。安装测试 APK、扫码并在电脑确认后，用独立测试工程发送简单读取任务，再触发一次修改审批，检查拒绝／批准与结果。先完成普通前台闭环，再分别测试锁屏和焦点。

## 真实设备待验收

执行时记录手机型号／系统版本、电脑版与 APK 构建、步骤和结果：

- [ ] 两台手机首次安装、相机授权、扫码／粘贴、Keystore 保存及重开恢复。
- [ ] 手机切后台后电脑批准配对，超过原二维码五分钟再返回，仍能恢复授权状态。
- [ ] 电脑正在其他软件输入时，手机发送任务、处理审批／提问、完成或失败，焦点和窗口保持原状。
- [ ] LoliCode 最小化或关闭到托盘时，上述操作不显示、恢复或聚焦窗口，不弹出电脑通知。
- [ ] 电脑工作台打开时，手机操作不切换当前项目、会话或页面。
- [ ] 电脑 Win+L 后，手机新建会话与任务、查看进度、回复单次审批、停止并读取结果。
- [ ] 手机锁屏、切换 Wi-Fi／移动网络后，电脑任务继续；返回应用读取正确状态，无重复变更。
- [ ] 旧审批已处理、任务已停止或配对已撤销时，手机旧操作不能继续授权；重新配对可使用。
- [ ] 要求 shell、Git、构建或交互桌面操作时，报告不支持，未启动终端或操纵电脑桌面。

FCM 真机锁屏通知和 P2P 直连分别待用户恢复推送工作、后续直连实现后验收。

## 官网下载交付

测试通道已上线：[官网扫码下载页](https://lolicode.com/mobile/)。页面提供 Android APK、APK 直链二维码和配套 Windows 电脑预览 ZIP；新配对需要电脑预览版提供的“连接手机”入口。先退出已有 LoliCode 及托盘，将 ZIP 完整解压到独立目录后运行；电脑预览版沿用现有配置。

2026-10-23 已通过匿名 HTTPS 完整下载并核对 APK 和 ZIP 的长度与 SHA-256，页面、清单、重定向与缓存头也已验证。APK SHA-256 为 `c06bb9e59d74bcaf1476b4f0cbc7c3edd307ff47327e19fbdfa350e02d65909b`；公开清单提供应用签名证书指纹。下载准备脚本 7 项测试通过，发布器在 Linux 上 9 项测试通过。生成入口为 `scripts/lolicode-android-download.mjs`，发布器为 `deploy/companion/publish-download.py`。

Android 测试通道与电脑正式更新源使用各自版本及交付流程。公网下载通过不代表真机安装、IDE 预览渲染、Win+L 或窗口焦点已经验收；系统锁屏推送继续按用户决定暂缓。
