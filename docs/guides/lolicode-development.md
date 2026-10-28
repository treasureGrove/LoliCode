# LoliCode 开发版与正式版

日常调试从桌面或 Windows 开始菜单的 **LoliCode 开发版** 进入；正式安装与线上版本验收从 **LoliCode** 进入。应用内的开发标识用于确认当前运行渠道。

## 构建与启动

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` 等同于 `pnpm build:dev`。Windows 开发构建成功后，自动更新 `%LOCALAPPDATA%\Programs\LoliCode Dev` 下的程序，并注册桌面、开始菜单「程序」目录中的 **LoliCode 开发版** 快捷方式，以及 Windows「已安装的应用」中的开发版记录。快捷方式始终启动最后一次成功构建；修改源码后再次构建即可更新。

每次构建按新加坡时间生成独立开发号，例如 `DEV-20261028-174243`，与源码提交 SHA 一起显示在应用内和 Windows 开发版版本信息中。完整记录保存在产物目录的 `development-build.json` 中，便于确认本次调试和验收使用的构建。

开发版页头常驻显示构建分支；关于页同时显示分支、提交、是否包含未提交改动及构建时间。这些信息记录构建时的源码状态，切换分支或修改代码后需要重新构建桌面开发版。

前端热重载和 Rust 增量重启使用：

```powershell
pnpm dev
```

此命令直接运行仓库中的开发进程。桌面入口适合检查完整构建行为；`pnpm dev` 适合修改代码时实时调试。

已有开发构建需要修复入口时运行 `pnpm dev:register`；移除开发版注册使用 `pnpm dev:unregister`，保留开发数据。CI 或仅需产物时使用 `pnpm build:dev --no-register`，完整可运行目录输出到 `src-tauri/target/development/app`。

## 身份与数据

- 正式版名称为 **LoliCode**，延续现有应用身份、安装位置、`~/.tai-switch` 数据和正式签名更新源。
- 开发版程序名称为 **LoliCode Dev**，应用身份为 `art.treasuregrove.lolicode.dev`，使用独立的 `~/.lolicode-dev`。开发版首次运行需要配置自己的渠道和设置。
- 开发构建使用 `dist-dev` 前端产物与 `src-tauri/target/development` 原生产物。它们与正式构建目录分开，可在保留正式版的同时反复构建开发版。
- 开发版不安装正式渠道更新。更新开发版请重新构建，避免调试程序被线上包替换。

两版中显式修改同一个项目文件或外部工具配置，仍会影响该共享目标。调试写操作时选择对应测试项目。

## 正式验收与远端标识

正式安装包使用 `pnpm build:release` 构建，签名、冻结源码和发布验收遵循[正式发布指南](lolicode-release.md)。官网和公开 [LoliCode Releases](https://github.com/treasureGrove/LoliCode-Releases/releases) 提供正式版。

源码仓库提供独立的 [LoliCode Windows development](https://github.com/treasureGrove/LoliCode/actions/workflows/development.yml) 手动工作流，使用所选分支构建，下载产物名称含 **Development**、开发号和源码提交 SHA。该工作流不发布 GitHub Release，也不修改正式更新清单。正式打包在 [LoliCode Windows stable release](https://github.com/treasureGrove/LoliCode/actions/workflows/release.yml) 中执行。
