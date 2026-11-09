# 仓库地图 / Repository map

这份地图帮助开发者区分应用源码、配套服务、第三方源码和本地生成物。先读[架构与维护入口](../ARCHITECTURE.md)了解调用链；开发与验证命令见[贡献指南](../CONTRIBUTING.md)，文档入口见[文档索引](README.md)。

## 从哪里开始

- 桌面界面：`src/main.tsx` → `src/app/bootstrap.tsx` → `src/app/App.tsx`；业务页面在 `src/features/`，共享组件在 `src/components/`，API 封装在 `src/lib/api/`，翻译在 `src/i18n/`。详见[src/README.md](../src/README.md)。
- 桌面原生层：`src-tauri/src/lib.rs`，Tauri 命令在 `src-tauri/src/commands/`，服务实现主要在 `src-tauri/src/services/`。
- Agent：`packages/lolicode-harness-runtime/` 固定 DeepSeek Harness 发行物；桌面接入在 `src-tauri/src/services/inprocess_agent.rs` 和 `harness_*.rs`。`crates/lolicode-agent/src/` 保留共享数据、宿主复用能力及旧会话解码。
- 移动端：[apps/android/README.md](../apps/android/README.md)，独立的 Kotlin/Compose 项目。
- 测试：前端主要在 `tests/`，Rust 测试在对应 crate 内，脚本测试在 `scripts/tests/`。

## 目录职责

- `src/`：React/TypeScript 桌面界面、资源和本地化。
- `src-tauri/`：Tauri 桌面宿主、Rust 命令、服务、代理和打包配置。
- `crates/`：独立 Rust crate，提供共享数据、工具能力及旧会话兼容。
- `packages/`：Harness 运行时和 companion relay，分别管理依赖及锁文件；根目录 [pnpm-workspace.yaml](../pnpm-workspace.yaml) 不包含子包。
- `apps/`：独立客户端，目前包括 Android companion。
- `deploy/`：配套服务的部署、运维和验证代码；部署前阅读各子目录说明。
- `scripts/`：按 `dev/`、`build/`、`release/`、`data/` 分组的工程脚本，回归测试在 `tests/`；见[脚本入口](../scripts/README.md)。
- `docs/`：架构、指南、验收、发布记录及多语言用户手册。部分手册保留历史参考语境，见[文档索引](README.md)。
- `assets/`、`design/`：项目素材和设计资料；界面运行时使用的素材也有一部分在 `src/assets/`。
- `third-party/`：保留来源的第三方材料。`zcode/` 是仍在分发的五个默认内容技能、原始清单与许可；`deepseek-superagent/` 和 `notices/` 保留来源及许可记录。旧 ZCode vendor 源码和 OpenCode 平台实验已移除，可从 Git 历史查阅；旧集成规格归档在 [docs/history/lolicode-zcode-runtime.md](history/lolicode-zcode-runtime.md)。
- `.github/`、`flatpak/`：CI、社区配置和 Flatpak 相关文件。

LiteLLM 没有作为运行时引入；Credit 实现的参考记录与 MIT 许可统一保存在 `third-party/notices/litellm.md`、`litellm-LICENSE`，原 `third_party/` 目录已合并。

根目录的 `package.json` 是桌面前端开发命令入口；`src-tauri/Cargo.toml` 和 `crates/lolicode-agent/Cargo.toml` 分别管理桌面宿主与 Agent 的 Rust 构建。发布步骤以[发布指南](guides/lolicode-release.md)为准。

旧版测试说明、验收记录、UI 交接书和会话管理需求已归档到 [docs/history/](history/README.md)。根目录保留当前开发入口与必要的项目、社区、许可和工具配置。

## 生成物与日常搜索

`node_modules/`、`.pnpm-store/`、`dist/`、`dist-dev/`、`release/`、`tmp/` 和各 Rust `target/` 是依赖、构建结果或本地工作目录。具体忽略规则以 [.gitignore](../.gitignore) 及子目录规则为准；忽略不代表内容一定可以删除，例如 `release/` 可能有尚需保留的交付物。

手动保存的临时测试或构建日志建议放在已忽略的 `tmp/logs/`，避免继续堆在根目录。现有日志和生成物应先确认用途，再自行归档或清理。

查找项目自身代码时，可从具体目录搜索，或显式排除第三方源码：

```sh
rg -n '搜索内容' src src-tauri/src crates packages tests
rg -n '搜索内容' -g '!third-party/**'
```

需要排查上游或许可证时再搜索 `third-party/`。重构大文件时按职责和测试覆盖逐步拆分，避免把文件搬迁与无关功能改动混在一起。
