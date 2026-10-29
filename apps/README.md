# 独立客户端

目前只有 [android/](android/README.md)：Kotlin 与 Jetpack Compose 编写的 Android companion，使用自身 Gradle 配置、版本和测试。

桌面应用仍由根目录 `src/` 与 `src-tauri/` 构建；`apps/` 不是桌面源码的副本。返回[总架构入口](../ARCHITECTURE.md)。

Android 入口是 `android/app/src/main/java/art/treasuregrove/lolicode/mobile/MainActivity.kt`；界面、数据与连接逻辑在同一包下分组。设备与桌面通信的协议文档位于 `docs/architecture/companion-*.md`，桌面接入在 `src-tauri/src/services/mobile_companion/`。

构建、模拟器与设备验证先读 [Android README](android/README.md) 和 [Android Studio 说明](android/ANDROID_STUDIO.md)。不要以桌面构建成功替代 Android 验证。
