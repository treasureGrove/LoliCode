# Android Studio 开发与真机调试

当前开发版为 `0.1.0-alpha.4`（`versionCode=4`）：同账号发现、电脑逐次设备授权、独立设备密钥和原生 WebRTC 直连。服务器只协调账号与加密信令，任务不经过中继，无 TURN、无失败回退。Debug 包名增加 `.debug`，与已签名安装包共存。登录密码不保存，设备票据仅在内存，账号资料和私钥由 AndroidKeyStore AES 密封。

小米 8 Lite 已通过真实原生双端点、UDP host 候选与 AES 任务包往返；这不等于手机跨网络 NAT 已验收。首轮手机↔Rust host-only 测试在两端不同网段时失败，保留失败记录。手机熄屏时界面 instrumentation 未产生结果，未冒称 UI 点击通过。详细记录在构建目录 `build/account-v2-evidence/`；真实账号登录仍须用户自行输入。

Android 35 只读模拟器随后通过 Rust↔Android 原生跨端测试：双向各 20 KiB，55,265 字节加密直连数据，HTTP 只传两次 SDP 信令，无任务 WS 数据。10 项 Compose 交互、原生与 Keystore 共 12 项 instrumentation 通过；35 项 JVM 测试通过。小米非 UI 原生与 Keystore 共 2 项通过。自动协调重连最少 30 秒，直连建立失败需用户显式重试；空闲任务不轮询完整快照。

以下为已发布旧版的历史记录：`0.1.0-alpha.3`（`versionCode=3`），二次元主题已在 Android 35
模拟器运行。最终构建的 6 项原生界面测试在 360dp／1.3 倍字体下全部通过，另有一轮
约 393dp 下的 6 项通过记录；11 项 JVM 测试通过，签名 APK 安装与冷启动通过。
历史 `alpha.2` 已在 Android 35 WHPX 模拟器实际运行，6 项界面测试与 11 项 JVM 测试通过。
模拟器不是红米／小米实机；Android Studio Preview、真实手机配对、电脑 Win+L
锁屏执行和 FCM 推送仍未完成验收。`alpha.3` 已于 2026-10-26 发布至
[官网手机端页面](https://lolicode.com/mobile/)，[签名 APK](https://lolicode.com/downloads/android/0.1.0-alpha.3/LoliCode-Android-0.1.0-alpha.3.apk)
及配套 ZIP 已通过匿名 HTTPS 完整下载核验，长度和 SHA-256 与本地一致。

## 打开独立安卓工程

安卓代码位于 Codex worktree 的 `apps/android/`，与主目录电脑端分开开发。
在 Android Studio 欢迎页选择 **Open**，打开包含 `settings.gradle.kts` 的
`apps/android` 文件夹；不要把仓库根目录作为 Android Gradle 工程打开。

也可以在该文件夹手动运行：

```powershell
.\open-studio.ps1 -DryRun  # 仅发现 IDE，绝不启动窗口
.\open-studio.ps1          # 明确打开此 worktree 的 Android 工程
# 非默认安装位置：
.\open-studio.ps1 -StudioPath 'D:\software\Android Studio'
```

IDE 不存在时脚本给出错误与[官方下载地址](https://developer.android.com/studio)，
不会安装软件或修改 PATH。

## 设置 JDK 和 SDK

工程固定使用 AGP 8.9.2、Gradle 8.11.1、Kotlin/Compose compiler 2.1.20。
Android SDK API 为 35，Build Tools 为 35.0.0，最低运行版本 Android 8.0/API 26；
不需要 NDK。

1. 打开 **Settings → Build, Execution, Deployment → Build Tools → Gradle**。
   Gradle distribution 选择 **Wrapper**，Gradle JDK 选择 **JDK 17**。
   当前独立工具链的 JDK 位于
   `D:\projectGithub\TAI-Switch\tmp\android-toolchain\jdk-17...`，选择实际存在的
   目录。不要用 Unity 自带的 JDK 11。
2. 在 **Settings → Languages & Frameworks → Android SDK** / **SDK Manager**
   选择 SDK 目录。当前可复用
   `D:\projectGithub\TAI-Switch\tmp\android-toolchain\sdk`，其中已有平台 35、
   Build Tools 35.0.0 和 Platform Tools。不要修改 Unity 的 SDK 安装。
3. `local.properties` 只保存在本地，`sdk.dir` 应指向实际 SDK；它已被忽略。
   点击 **Sync Project with Gradle Files**，等待依赖与索引完成。
4. 在 **Build Variants** 里把 `app` 的 active build variant 设为 **debug**，
   运行配置选 Android App 的 **app**。不要选 unsigned release 做断点调试。

不用 IDE 时，在任意 worktree 都可显式引用同一套工具链：

```powershell
.\build-local.ps1 -Variant Debug -Test `
    -ToolchainRoot 'D:\projectGithub\TAI-Switch\tmp\android-toolchain'
```

该参数优先于当前进程环境中的工具链。脚本只临时设置自身构建过程的
`JAVA_HOME` / `ANDROID_HOME`，退出时恢复原值，不写用户或系统环境变量。
没有显式参数时沿用已有环境变量，或尝试本仓库 `tmp/android-toolchain/`。

AGP 重新打包会清理 `app/build/outputs/apk/release/`，不要把需要保留的旧 APK
放在该目录下面。当前已将上一份签名测试包另存到被忽略的
`app/build/release/backup/`，SHA-256 为
`5d8a1b9a4fd66364d0875d09c687d5717d28293816d713fb27c2d5469b3fca7b`。

## 手机界面与离线 Preview

界面与电脑端前端独立，位于 `app/src/main/java/art/treasuregrove/lolicode/mobile/ui/`：

- `CompanionRoute.kt`：运行时路由，负责读取 ViewModel 状态、扫码启动器与通知权限。
- `CompanionApp.kt` 的 `CompanionScreen`：只接收状态与事件回调的 Compose 界面。
- `CompanionActions.kt`：界面事件，Preview 使用无操作回调。
- `app/src/debug/.../ui/CompanionPreviews.kt`：未配对（含 360dp）、已配对运行进度、
  等待一次审批和设备管理的静态样例；不构造 ViewModel、网络客户端、Keystore 或 Firebase。

`alpha.3` 使用樱花粉／淡紫、静态星光、贴纸感卡片和悬浮圆角导航。首页角色复用
仓库 `src/assets/atelier/companion.png`，头像复用 `src/assets/brand/lolicode-icon.png`，
分别随 APK 打包为 `drawable-nodpi/lolicode_companion.png` 与 `lolicode_avatar.png`。
素材不新增下载或网络调用，任务／审批／配对／草稿逻辑和原有能力边界不变。
审批详情和连接状态仍独立显示，Firebase／手机锁屏系统推送继续按用户要求暂缓。

打开 `CompanionPreviews.kt` 后选择编辑器 **Split** 或 **Design**，必要时点
**Build & Refresh**。大屏预览可以使用缩放、Focus 或单独预览一个状态。静态预览
不表示真实电脑在线，预览中的按钮不会发任务。先调整 `CompanionScreen` 或其
小组件，保持通信/执行逻辑在路由和 ViewModel，避免 UI 设计需要连接电脑。

Android Studio 的 Preview 渲染仍待在 IDE 内验证。与静态 Preview 不同，`alpha.3`
已在模拟器执行真实 Compose Activity 和交互测试，不能将其称为物理手机验收。
具体操作见[官方 Compose Preview 文档](https://developer.android.com/develop/ui/compose/tooling/previews)。

## 已完成的模拟器验证（alpha.3，2026-10-26）

本轮在 Android 35 WHPX 模拟器 `emulator-5554` 验证二次元主题，所有 ADB 命令
明确指定该模拟器，未操作任何物理手机。最终构建的 6 项 `CompanionUiTest` 在
360dp 宽、1.3 倍字体下全部通过，另有一轮约 393dp 宽的 6 项通过记录；11 项 JVM
测试通过。Release lint 为 0 错误、13 项建议：10 项依赖更新、1 项 KTX 与 2 项
adaptive icon 目录版本／monochrome 建议。

最终签名 APK 为 5,535,942 字节，SHA-256 为
`1a895a06d4909ad63f63f05d7f499ced6b7e46d2b6c363c545a6f1e596214d75`。
沿用原 Android 签名身份，已在模拟器安装并冷启动正常 `MainActivity`。这些检查不
连接真实电脑、不执行真实远程任务，也不能证明 Win+L、窗口焦点或 FCM 送达已验收。

## 历史模拟器验证（alpha.2，2026-10-25）

以下为保留的上一版结果，与上述 `alpha.3` 记录分别标识。
当时运行环境为 Android 35、WHPX 硬件加速模拟器 `emulator-5554`，屏幕
1080 × 2400 像素、440 dpi。`alpha.2` 原生界面包含工作台、任务和设备三个页面。
6 项 `CompanionUiTest` 已在该模拟器全量执行并全部通过，覆盖显式配对、底部导航、
离线审批禁用、单次允许／拒绝、发送确认前保留草稿、切页保留草稿，以及切页后收到
迟到确认时清除已发送草稿。
11 项 JVM 测试通过，release lint 为 0 错误、11 项依赖更新／KTX 提示。

已经从实际运行的应用截图：正常 `MainActivity` 未配对首页，以及 debug 演示工作台
与审批页面。演示入口明确标注“演示数据 · 离线”，不连接电脑；这些截图证明原生
布局实际运行，不证明已完成真实远程任务。

正式签名 `alpha.2` APK 也已在该模拟器安装并正常冷启动 `MainActivity`，录屏包含
三个底部页面的导航和配对弹窗空输入禁用／取消。这些操作未连接真实电脑或执行远程任务。

后续可在连接测试设备后用 `:app:connectedDebugAndroidTest` 复跑交互测试；
单独运行 `assembleDebugAndroidTest` 仍然只会编译，不会执行测试。

需要在模拟器查看布局样例时，安装 debug APK 后可运行：

```powershell
adb shell am start -n art.treasuregrove.lolicode.mobile/.debug.UiShowcaseActivity --es scenario empty
adb shell am start -n art.treasuregrove.lolicode.mobile/.debug.UiShowcaseActivity --es scenario running
adb shell am start -n art.treasuregrove.lolicode.mobile/.debug.UiShowcaseActivity --es scenario approval
adb shell am start -n art.treasuregrove.lolicode.mobile/.debug.UiShowcaseActivity --es scenario completed
```

该入口固定显示“演示数据 · 离线”，仅修改内存样例，支持真正点击底栏；它不读
设备凭据、不连接电脑、不发真实任务，也不包含在正式 release APK 中。应用正常
启动入口仍为 `MainActivity`，用于检查真实未配对首页与实际业务路由。

## USB 真机调试

真实 Redmi／小米手机尚未完成验收。下面是后续连接真机的操作步骤，不能以
上述模拟器结果替代扫码、配对、Keystore、电脑锁屏和不抢焦点的端到端验证。

在自己要测试的手机上开启开发者选项和 USB 调试，使用数据线连接，解锁并确认
这台电脑的 RSA 授权。小米/红米部分系统还会提示“通过 USB 安装”授权，按设备
实际提示处理，不需要开启与本任务无关的安全选项。

在 IDE 设备列表选中该手机，然后点击 **Run app**。也可先确认连接：

```powershell
& 'D:\projectGithub\TAI-Switch\tmp\android-toolchain\sdk\platform-tools\adb.exe' devices -l
```

设备应显示 `device`。`unauthorized` 时重新确认手机授权；没有设备时检查数据线、
USB 连接模式和 Windows 的 OEM ADB 驱动。多个设备时在 IDE 明确选中目标手机。

官网签名测试 APK 与 IDE 的 debug APK 使用不同签名。如果系统报
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`，保留已安装版本，选择另一台测试手机，
或由你决定是否卸载再装 debug 版本；卸载会清除该手机现有配对数据，之后需重新配对。
本指南和脚本都不会自动卸载任何应用。

## Wi-Fi 真机调试

Android 11 及以上可以在手机开发者选项开启 **Wireless debugging**；手机与电脑
连接同一可信 Wi-Fi，在 IDE 设备选择器选 **Pair Devices Using Wi-Fi**，按二维码
或配对码完成 ADB 配对，再选中手机运行 `app/debug`。

这是 Android Studio/ADB 调试配对，与 LoliCode 的电脑配对码不同。ADB 配对只用于
开发安装、日志和断点；应用仍需扫描 LoliCode 电脑端生成的独立配对码。
网络不支持无线发现时先用 USB；不要为调试把电脑 ADB 暴露到公网。
详见[官方真机调试说明](https://developer.android.com/studio/run/device)。

## 断点和 Logcat

在 `MainActivity`、`CompanionViewModel` 的 `pair` / `handlePlaintext` /
`replyPermission`、`RemoteClient` 的 `onMessage` 等位置下断点，然后点击
**Debug app**。需要附加到已运行的 debug 应用时用 **Attach debugger to Android process**，
选择 `art.treasuregrove.lolicode.mobile`。

在 **View → Tool Windows → Logcat** 中选择目标设备与该包名，先观察启动、
崩溃堆栈和网络错误。不要把 QR、phoneToken、AES key、FCM token 或任务正文
加入日志；当前通信错误信息不会输出收到的数据或加密材料。

先用静态 Preview 调界面，再在 debug 真机检查扫码、前后台重连、停止、一次审批，
最后与实际电脑端做锁屏与不抢焦点验收。Firebase / 锁屏系统推送仍暂缓，当前包
显示“系统推送暂未启用”；不应把前台事件刷新视为推送已通过。
