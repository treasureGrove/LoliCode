# LoliCode

[简体中文](README_ZH.md) · [日本語](README_JA.md) · [Deutsch](README_DE.md)

**Code alongside 小笨狗, LoliCode’s anime desktop companion. This desktop coding agent harness connects your model to your project so you can run tools, check test results, and review edits.**

Open a folder and ask the agent to read files, run tests, and show its edits. For GitHub work, hand an issue to Loli Secretary. It can work in an isolated Git worktree and prepare a draft pull request for your review. Your desktop companion points you to tasks that need permission or an answer.

[Download for Windows](https://github.com/treasureGrove/LoliCode-Releases/releases/latest) · [Watch the 43-second companion demo](https://lolicode.com/#film) · [Secretary workflow (中文)](docs/guides/lolicode-secretary.md) · [Documentation](docs/README.md)

<a href="https://lolicode.com/#film">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/treasureGrove/LoliCode/main/docs/images/lolicode/companion-tour-still.webp">
    <img src="docs/images/lolicode/companion-tour.webp" width="896" height="504" alt="Watch the desktop companion open a task for approval, then inspect the tool calls and code diff">
  </picture>
</a>

## What you can use today

- **One main Agent workspace:** streaming conversations, project files, terminal tools, permissions, questions, cancellation, session history, and file-change review.
- **Shared channels and models:** manage API providers and supported account authorizations, discover models, and select available model options. Context limits and reasoning settings depend on the information and capabilities supplied by the upstream service.
- **Configuration in one place:** apply shared models to supported external tools, including WorkBuddy, DeepSeek Harness, ZCode, and MiMo. Preserve existing configuration and show per-tool results.
- **Memory and reusable tasks:** edit or disable local personal/project memory, save Markdown workflows, schedule tasks, and use verified CLI skills on demand. CLI tools and their accounts require separate setup; custom JS/MCP execution is not included.
- **A characterful desktop:** an anime-inspired theme and a pink-haired chibi companion, with compact tool progress and a file-preview panel.
- **Usage and updates:** view recorded usage and check for independently published LoliCode updates. The LoliCode community account is separate from model-provider accounts.

The desktop interface uses **React and TypeScript**. The bundled **DeepSeek Harness** runs the agent loop. The **Tauri 2 and Rust** host supplies file and terminal tools, permissions, and the model gateway. [Architecture guide](ARCHITECTURE.md)

Windows, macOS, and Linux are product targets. Current public packages are **Windows x64 NSIS installers and portable ZIPs**; macOS and Linux packages have not been published. Check each release for its actual validation coverage.

## Install and get started

1. Download a matching package from the [LoliCode download page](https://lolicode.com/).
2. Add a channel and select a model in **Channels and models**.
3. Open a project folder in **Workbench**, describe a task, and review requested permissions and changes.

Use **Software updates** from the lower-left avatar menu or the update entry to check for new versions. The installer update channel uses the [signed LoliCode update manifest](https://tools.treasuregrove.art/lolicode/updates/stable.json). For portable editions, follow the download page and release notes to replace the application files while retaining your data.

LoliCode keeps the historical `~/.tai-switch` data directory for compatibility. See the [installation guide](docs/user-manual/en/1-getting-started/1.2-installation.md) before moving or replacing an existing installation.

## What comes next

Tavern already supports character cards and conversations. Future directions include deeper Unreal Editor integration, advanced memory providers, voice, and richer companion interaction.

Read the [product vision](docs/guides/lolicode-product-vision.md), [first milestone plan](docs/guides/lolicode-phase-one-plan.md), and [source/capability ledger](docs/guides/lolicode-platform-capabilities.json).

## Develop locally

Start with the [architecture guide](ARCHITECTURE.md) and open [LoliCode.code-workspace](LoliCode.code-workspace) for a focused source view.

Use the Node.js version pinned in `.node-version` (Harness requires 24.9+), pnpm 10.12.3, the Rust toolchain pinned in `rust-toolchain.toml`, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/treasureGrove/LoliCode.git
cd LoliCode
pnpm install --frozen-lockfile
pnpm prepare:harness-runtime
pnpm dev
```

Frontend changes reload through Vite. Rust changes rebuild and restart the development process; an installer rebuild is unnecessary. To watch the Agent crate as well:

```sh
pnpm dev --additional-watch-folders ../crates/lolicode-agent
```

For a desktop development build on Windows, run:

```sh
pnpm build
```

This builds **LoliCode Dev**, installs it under `%LOCALAPPDATA%\Programs\LoliCode Dev`, and creates **LoliCode 开发版** shortcuts on the desktop and in the Start menu. Each build displays a development number such as `DEV-20261028-174243` and its source revision. The shortcut opens the last successful build; use `pnpm dev` for live reload. Development builds use `~/.lolicode-dev` and do not install stable-channel updates. The downloaded **LoliCode** application keeps its existing installation and `~/.tai-switch` data.

Use `pnpm build:release` for stable installer acceptance and signing. Remote [development builds](https://github.com/treasureGrove/LoliCode/actions/workflows/development.yml) are labeled **Development**; public stable downloads remain in [LoliCode Releases](https://github.com/treasureGrove/LoliCode-Releases/releases). See the [development guide](docs/guides/lolicode-development.md) for registration and channel details.

Useful checks:

```sh
pnpm typecheck
pnpm test:unit
pnpm build:renderer
cargo test --manifest-path crates/lolicode-agent/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

See [Contributing](CONTRIBUTING.md) for development and [the release guide](docs/guides/lolicode-release.md) for packaging and signing.

## Help, sources, and license

Report problems in [LoliCode Issues](https://github.com/treasureGrove/LoliCode/issues). See the [community](https://lolicode.com/all), [release notes](CHANGELOG.md), [Support](SUPPORT.md), [Security](SECURITY.md), and the [Code of Conduct](CODE_OF_CONDUCT.md).

LoliCode is maintained independently. Its configuration foundation originates from CC Switch; the original [MIT license](LICENSE), copyright notices, and [pinned baseline](FORK_BASELINE.md) remain intact. Other reused components and their notices are listed in [Third-party notices](THIRD_PARTY_NOTICES.md). Reference projects and future integration candidates do not imply that their complete programs or plugin ecosystems are included.
