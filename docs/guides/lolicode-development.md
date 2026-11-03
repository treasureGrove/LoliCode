# LoliCode 开发版与正式版

日常调试从桌面或 Windows 开始菜单的 **LoliCode 开发版** 进入；正式安装与线上版本验收从 **LoliCode** 进入。应用内的开发标识用于确认当前运行渠道。

## 构建与启动

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` 等同于 `pnpm build:dev`。Windows 开发构建成功后，自动更新 `%LOCALAPPDATA%\Programs\LoliCode Dev` 下的程序，并注册桌面、开始菜单「程序」目录中的 **LoliCode 开发版** 快捷方式，以及 Windows「已安装的应用」中的开发版记录。

本机构建注册的快捷方式会检查绑定仓库中的源码，包括未提交的改动；有变化时先完整构建并更新安装，再打开新程序。没有变化时直接启动。构建期间无需操作终端，日志保存在安装目录的 `launch.log`；构建失败会显示原因并保留原安装。若开发版已经运行而源码需要重建，会提示先退出开发版，避免中断后台任务或覆盖正在使用的程序。Node.js、构建工具与绑定的源码仓库需要仍在本机可用。CI 下载的开发包没有本地源码绑定，直接运行包内程序。

每次构建按新加坡时间生成独立开发号，例如 `DEV-20261028-174243`，与源码提交 SHA 一起显示在应用内和 Windows 开发版版本信息中。完整记录保存在产物目录的 `development-build.json` 中，便于确认本次调试和验收使用的构建。

开发版页头常驻显示构建分支；关于页同时显示分支、提交、是否包含未提交改动及构建时间，并分别记录界面与原生开发号。这些信息记录构建时的源码状态。

日常修改界面后，点击分支标识旁的 **热更新界面**。开发版会在独立目录构建完整界面，成功后自动刷新前台，原生进程和后台 Agent 任务继续运行。构建失败保留当前界面；有未保存修改时会在刷新前提示。源码仓库与 Node.js 需要仍在本机可用。

如果 Rust 后端、原生依赖或权限配置发生变化，热更新会提示完整重建。退出开发版后再次打开桌面快捷方式即可自动构建，也可运行 `pnpm build:dev`。热更新不会安装正式渠道的界面包。

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
- 开发版不安装正式渠道更新。本机开发版由桌面快捷方式检查源码并构建更新；CI 开发包需重新下载或手动构建。

两版中显式修改同一个项目文件或外部工具配置，仍会影响该共享目标。调试写操作时选择对应测试项目。

## 手动同步会话

仅在**开发版**的工作台左侧提供 **同步会话**，可选择双向同步、同步到正式版，或从正式版同步过来。正式包不显示入口，也不允许调用同步操作；正式版仍可接收开发版同步过去的会话。两版需至少在本机启动过一次，以建立各自的数据目录。开发版立即显示导入的会话；正式版如果已经打开，退出并重新启动后显示收到的会话。

同步包含本体会话的完整聊天上下文、文件变更记录和已暂停的消息队列。相同内容会去重；同编号内容不同会保留副本，不覆盖任一版已有的内容，也不传播删除操作。正在执行任务、生成标题或压缩上下文的会话会跳过，可等任务结束后再次同步。两版都继续过的同一会话会保留各自的分叉，不能自动拼接成一段对话。

渠道、登录和应用设置仍分别管理。旧引擎历史和依赖 SSH / WSL 连接的远程会话不在此次同步范围内；独立任务保留来源工作目录，以便继续访问原来的文件。同步结果会显示新增、副本、重复和跳过的数量。

## 正式验收与远端标识

正式安装包使用 `pnpm build:release` 构建，签名、冻结源码和发布验收遵循[正式发布指南](lolicode-release.md)。官网和公开 [LoliCode Releases](https://github.com/treasureGrove/LoliCode-Releases/releases) 提供正式版。

源码仓库提供独立的 [LoliCode Windows development](https://github.com/treasureGrove/LoliCode/actions/workflows/development.yml) 手动工作流，使用所选分支构建，下载产物名称含 **Development**、开发号和源码提交 SHA。该工作流不发布 GitHub Release，也不修改正式更新清单。正式打包在 [LoliCode Windows stable release](https://github.com/treasureGrove/LoliCode/actions/workflows/release.yml) 中执行。
