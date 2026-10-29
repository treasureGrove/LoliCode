# 代码架构与维护入口

LoliCode 的桌面主程序由 React 界面、Tauri 原生宿主和 Rust Agent 核心组成。第一次维护时，从下面两个入口读起：

- 界面：[src/app/App.tsx](src/app/App.tsx)，组合业务页面与导航。
- 原生宿主：[src-tauri/src/lib.rs](src-tauri/src/lib.rs)，初始化服务并注册界面可调用的命令。

在支持 VS Code 工作区的编辑器中打开 [LoliCode.code-workspace](LoliCode.code-workspace)，可以收起依赖、构建产物、日志和固定版本的第三方上游源码。文件仍保留在磁盘上，普通文件夹视图不受影响。

## 先认清这些目录

- [src/](src/README.md)：桌面界面。`app/` 管启动和应用外壳，`features/` 放业务页面，`components/` 放共用组件。
- [src-tauri/](src-tauri/README.md)：桌面原生宿主。`commands/` 接界面调用，`services/` 实现业务，`proxy/` 管模型网关，`database/` 管存储。
- [crates/](crates/README.md)：独立 Rust 库；`lolicode-agent/` 是内置 Agent 执行核心。
- [apps/](apps/README.md)：独立客户端，目前是 Android companion；桌面源码在 `src/` 和 `src-tauri/`。
- [packages/](packages/README.md)：共享平台协议与适配器，以及各自维护的运行时、伴随服务。工作区成员以 `pnpm-workspace.yaml` 为准。
- `deploy/`：配套服务部署与运维，先读相应子目录 README。
- [scripts/](scripts/README.md)：开发、构建、发布、数据维护脚本及脚本测试。
- [docs/](docs/README.md)：功能说明、架构约定和用户手册；`docs/history/` 保存旧验收与交接材料。
- `assets/`、`design/`：项目素材与设计资料；界面自身资源在 `src/assets/`。
- `specs/`：专项集成规格与验收要求；当前运行时实现边界仍需核对对应 `packages/` 和服务入口。
- `third-party/`：带来源与许可记录的第三方材料；上游更新通过集成脚本完成。
- `.github/`、`flatpak/`：持续集成、社区配置和 Flatpak 打包资料。

根目录保留项目介绍、贡献与安全规则、许可来源及工具配置。`node_modules/`、`.pnpm-store/`、`dist/`、`dist-dev/`、`release/`、`tmp/`、Rust `target/` 属于依赖或本地产物，不作为源码入口。

`deplink.html` 是保留的上游独立深链接生成页，不参与桌面 Vite 构建；桌面 HTML 入口是 `src/index.html`。

## 一次调用经过哪里

```text
src/main.tsx
  → app/bootstrap.tsx           启动检查、配置恢复与后台同步
  → app/AppProviders.tsx       主题、查询、更新等上下文
  → app/App.tsx                页面装配与导航
  → features/<业务>/           具体界面与交互
  → lib/api/                   Tauri 调用与前端数据接口
  → src-tauri/src/commands/    命令入口
  → src-tauri/src/services/    业务服务
  → proxy/、database/ 或 crates/lolicode-agent/
```

原生进程由 `src-tauri/src/main.rs` 进入 `lib.rs::run()`。默认内置 Agent 通过 `services/inprocess_agent.rs` 连接 `crates/lolicode-agent/src/native/`；`packages/` 的平台适配器与独立运行时有各自入口。

## 改什么，去哪里

- 主工作台、模型选择和工具交互：`src/features/agent/`；对应接口在 `src/lib/api/agent*.ts`，原生接入在 `services/inprocess_agent.rs`。
- 渠道与模型：`src/features/channels/`，以及 `commands/channel_center.rs`、`services/channel_center.rs`、`services/model_fetch.rs`。
- 应用导航、侧栏与窗口：`src/app/` 和 `src/app/shell/`。
- 设置、用量、发现、酒馆或 UE 页面：对应的 `src/features/<业务>/`。
- CLI 探测、安装更新、卸载与终端启动：`src-tauri/src/commands/tool_management/`；桌面通用操作在 `commands/desktop.rs`。
- 模型请求、协议适配与路由：`src-tauri/src/proxy/`；Agent 推理与工具执行：`crates/lolicode-agent/src/native/`。
- 文案翻译：`src/i18n/`；版本摘要：`src/whats-new/`；构建与发布：`scripts/build/`、`scripts/release/`。

## 后续维护规则

业务页面和业务专用组件放进对应 `features/` 目录；确认被多个业务复用后再放进 `components/`。应用启动与跨页面装配留在 `app/`，不要继续往入口文件堆业务实现。

界面通过 `lib/api/` 调用原生能力；命令入口负责参数与返回值，业务规则放在服务或独立核心。新增 Rust 模块按职责命名，避免重新出现 `misc` 万能桶。拆分大文件时保留行为测试，并同步直接引用、测试路径与文档链接。

开发和验证命令见 [CONTRIBUTING.md](CONTRIBUTING.md)，更完整的目录说明见[仓库地图](docs/REPOSITORY_MAP.md)。临时日志写入 `tmp/logs/`；已有产物先确认用途再整理。
