# LoliCode

[简体中文](README_ZH.md) · [日本語](README_JA.md) · [Deutsch](README_DE.md)

LoliCode is a desktop agent workspace with shared model channels and visual configuration. Use one place to manage model access, work on local projects, review tool activity, and inspect generated files and code changes.

This repository is maintained independently from CC Switch. Its configuration foundation originates from CC Switch; attribution and license notices are preserved.

## Current state

The current desktop implementation uses **Tauri 2, React, TypeScript, and Rust**. Since 4.0.15, the default coding agent runs as an in-process Rust core. It does not require a separate OpenCode or ZCode application.

The existing implementation includes:

- Shared channels, model catalog, account authorization, and provider configuration.
- A coding workspace with streaming conversations, project file tools, terminal execution, permission requests, cancellation, and change review.
- Session persistence and content-based Skills. Advanced execution support is reported by the runtime instead of inferred from available configuration pages.
- Configuration management for supported external AI tools, including provider presets, MCP, Skills, and prompts.
- Usage views, desktop settings, and a separate LoliCode update path.

These are implementation areas, not a claim that every feature has been validated on every operating system or model. See the [current agent behavior](docs/guides/lolicode-inprocess-agent.md) and [4.0.15 delivery evidence](docs/guides/lolicode-4.0.15-delivery.md).

## Product direction

The next architecture is **Electron + React + an owned TypeScript Host and agent kernel + the existing Rust native services**, with Windows, macOS, and Linux as desktop targets.

The intended experience is an application center:

1. Add an application such as a coding assistant, general work assistant, Tavern, or UE workspace.
2. Reuse an existing model channel and complete a short setup check.
3. Start working with recommended defaults.
4. Explore advanced model parameters, tools, Skills, MCP, and workflows when needed.

Applications share agent and platform services while retaining their own domain rules. DSH, OpenCode, and ZCode inform agent capabilities; CC Switch informs configuration; selected UE Box and Tavern capabilities become functional modules.

This is an ongoing migration. The application-center workflow, new Host, Electron shell, Tavern, and UE capabilities must not be treated as shipped features. Whole upstream applications and DSH's plugin ecosystem are not the integration target.

Read the [architecture and migration plan](docs/guides/lolicode-platform-architecture.md) and [capability/source ledger](docs/guides/lolicode-platform-capabilities.json).

## Download

Use the [LoliCode download page](https://tools.treasuregrove.art/lolicode/) for published packages. The recorded 4.0.15 delivery covers Windows packages; macOS and Linux release validation remains separate work.

CC Switch release links and packages belong to the upstream project and are not LoliCode downloads.

## Local development

Requirements:

- Node.js compatible with the installed Vite version: ^20.19.0 or >=22.12.0.
- pnpm 10.12.3, as recorded in package.json.
- Rust and the platform build tools required by Tauri 2; see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

~~~sh
git clone https://github.com/treasureGrove/TAI-Switch.git
cd TAI-Switch
pnpm install --frozen-lockfile
pnpm dev
~~~

Vite updates the frontend during development. Rust changes require incremental compilation and a development-process restart, rather than an installer rebuild. To also watch the agent crate outside src-tauri:

~~~sh
pnpm dev --additional-watch-folders ../crates/lolicode-agent
~~~

Production packaging:

~~~sh
pnpm build
~~~

The proposed Electron/Host development workflow is documented in the architecture plan; it is not the current default entry point.

## Validation

Run checks appropriate to the change:

~~~sh
pnpm typecheck
pnpm test:unit
cargo test --manifest-path crates/lolicode-agent/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
~~~

The built desktop executable also supports --check-agent-runtime, an isolated local-fixture check of the native agent. It does not require a real model key. Historical test results are not a substitute for validating the current checkout.

## Project layout

- src/ — React workspace, configuration pages, components, and desktop client APIs.
- src-tauri/ — current desktop shell, Rust services, account/channel management, and configuration persistence.
- crates/lolicode-agent/ — current native agent implementation.
- docs/guides/ — architecture, development, release notes, and delivery evidence.
- third-party/ — retained upstream provenance and reference material.

The repository directory keeps the historical TAI-Switch name. Default application data uses ~/.tai-switch; a portable build has its own documented data behavior. Do not point development or parallel application instances at the same production data directory.

## Contributing

Open an issue or pull request in [this repository](https://github.com/treasureGrove/TAI-Switch). Keep existing configuration fields and data compatible, describe the actual behavior change, and include relevant validation.

New integrations should identify the capability, owning module, execution target, source revision, and license impact. Preserve provider-specific model capabilities rather than flattening every model into a text-only interface.

## Attribution and license

The repository retains the [MIT license](LICENSE). Its CC Switch baseline is pinned to farion1231/cc-switch at 479964f2ef59e291f563218ac674a1fd82dcdbd3; see [FORK_BASELINE.md](FORK_BASELINE.md).

Research and selected integration candidates include [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [OpenCode](https://github.com/anomalyco/opencode), [ZCode](https://github.com/zai-org/ZCode), [UE Box](https://github.com/ueboxai/uebox), and [SillyTavern](https://github.com/SillyTavern/SillyTavern). Mentioning a project does not mean its code or complete application is included.

Reused code retains its applicable notices and license obligations. Future source adoption and the product's licensing decision are tracked separately in the capability/source ledger.
