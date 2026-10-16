# Contributing to LoliCode / 贡献指南

LoliCode is maintained in [treasureGrove/LoliCode](https://github.com/treasureGrove/LoliCode). Use this repository for code, documentation, translations, bugs, and feature suggestions.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through the process in [SECURITY.md](SECURITY.md), without posting credentials or exploit details in public issues.

## Start developing

Requirements are recorded in `.node-version`, `package.json`, and `rust-toolchain.toml`: Node.js 22.12.0 is the repository default, pnpm is pinned to 10.12.3, and Rust is pinned to 1.95. Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```sh
git clone https://github.com/treasureGrove/LoliCode.git
cd LoliCode
pnpm install --frozen-lockfile
pnpm dev
```

The frontend updates through Vite. Rust changes rebuild and restart the development process. To also watch the Agent crate outside `src-tauri`:

```sh
pnpm dev --additional-watch-folders ../crates/lolicode-agent
```

## Validate your change

Run checks relevant to the affected behavior:

```sh
pnpm typecheck
pnpm test:unit
pnpm build:renderer
cargo test --manifest-path crates/lolicode-agent/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Building the renderer first provides the `dist/` directory needed by desktop Rust builds. Tests that replace the application data directory use the historical `CC_SWITCH_TEST_HOME` override; use an isolated directory instead of your normal profile. Never replace the system `HOME` or share production data between parallel test instances.

For a UI change, check a real window at practical sizes, including keyboard navigation, scrolling, disabled states, and errors. Tests should verify meaningful behavior rather than mirror the implementation.

## Prepare a pull request

- Explain the user-visible problem and resulting behavior.
- Include relevant verification and any platform or upstream limitations.
- Preserve existing user data, configuration fields, provider-specific capabilities, and unsaved work.
- Keep secrets, personal conversations, local account files, signing keys, and private model endpoints out of commits and screenshots.
- For an integration, record its source, revision, license, owning module, and execution boundary. Do not remove copyright notices when adapting code.
- Separate implemented behavior from proposals. A configuration page does not establish that the built-in Agent can execute that integration.

Use [LoliCode Issues](https://github.com/treasureGrove/LoliCode/issues) for discussion when a change affects product direction. Routine fixes can be submitted directly as pull requests.

## Packaging and documentation

The current desktop uses Tauri with the native Rust Agent. Packaging and signing are documented in [the LoliCode release guide](docs/guides/lolicode-release.md); update summaries are documented in [src/whats-new/README.md](src/whats-new/README.md).

Keep the four root README translations consistent. [docs/README.md](docs/README.md) is the documentation entry point. Historical CC Switch configuration chapters remain reference material; they must not be presented as current LoliCode installation instructions.

## 中文说明

欢迎向 [LoliCode 仓库](https://github.com/treasureGrove/LoliCode)提交代码、文档、翻译与反馈。

- 按上面的工具链和命令启动开发环境，前端热更新、Rust 增量重启，无需每次打安装包。
- 按改动范围验证功能；界面改动还应检查真实窗口、窄屏、键盘、滚动和错误状态。
- 保留用户数据、现有字段、模型原生能力及未保存内容，不提交密钥、账户文件、私聊和签名私钥。
- 接入功能时记录来源版本、许可证、模块归属与执行边界，保留必要版权声明。
- PR 写清实际行为、验证结果与限制，规划中的功能单独标明。方向性变化可先开 Issue 讨论。
- 安全问题走[安全报告流程](SECURITY.md)；打包和发布走[发布指南](docs/guides/lolicode-release.md)。
