# LoliCode

[简体中文](README_ZH.md) · [日本語](README_JA.md) · [Deutsch](README_DE.md)

**A simple, extensible anime-girl Agent for work, creation, and companionship.**

LoliCode combines a capable desktop Agent, shared model configuration, and an expanding set of business tools. Our product vision includes a distinctive anime character, persistent memory, Pet, voice, and expressive interaction; the current implementation and planned capabilities are listed separately below.

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

**Simple to use. Highly extensible. An anime-girl Agent for work, creation, and companionship.**

LoliCode centers on one capable Agent with a distinctive anime, moe, and petite character identity. The long-term experience brings together a coherent personality, persistent memory, an anime-inspired interface, a desktop Pet, voice, and character interaction. These are product goals, not a claim that all of them ship today.

The main Agent chat is always available. Applications do not create additional Agent chat windows. Users can add built-in business applications to a workspace, similar to adding applications in Feishu or DingTalk, then either open their business pages or let the shared Agent use their exposed tools. Third-party applications come later.

Getting started should take a few necessary choices: reuse a model account, choose a workspace, and start a conversation. Recommended defaults come first; native model options, tools, Skills, MCP, memory policies, and diagnostics remain available through advanced settings.

Agent capabilities draw on DSH, OpenCode, ZCode, and other mature implementations. Configuration builds on CC Switch. Hermes memory mechanisms, selected UE Box tools, and open-source Tavern implementations are integration candidates, adopted as capabilities and components rather than complete upstream programs.

**SillyTavern is the primary Tavern reference**, with RisuAI as a secondary reference for character presentation and long-conversation memory. The [Tavern integration plan](docs/guides/lolicode-tavern-reference.md) records feature boundaries, source entry points, and licensing considerations. These application features have not shipped yet.

Implementation order:

1. Prioritize the main Agent and its interactions: questions, direction choices, thinking state, tool progress, cancellation, and recovery.
2. Integrate UE and Tavern as two built-in business applications.
3. Complete the first acceptance milestone against real behavior and recovery cases.
4. Unify the broader frontend visual system later; expand memory, Pet, voice, and character interactions through subsequent iterations.

The target architecture remains **Electron + React + an owned TypeScript Host/Agent Kernel + existing Rust native services**, targeting Windows, macOS, and Linux. The current default is still Tauri with the native Rust Agent.

Read the [product vision](docs/guides/lolicode-product-vision.md), [architecture and migration plan](docs/guides/lolicode-platform-architecture.md), and [capability/source ledger](docs/guides/lolicode-platform-capabilities.json). Proposed applications, memory providers, Pet, voice, and the new shell must not be presented as shipped features.

## Download

Use the [LoliCode download page](https://tools.treasuregrove.art/lolicode/) for published packages. The recorded 4.0.15 delivery covers Windows packages; macOS and Linux release validation remains separate work.

CC Switch release links and packages belong to the upstream project and are not LoliCode downloads.

## Local development

Requirements:

- Node.js compatible with the installed Vite version: ^20.19.0 or >=22.12.0.
- pnpm 10.12.3, as recorded in package.json.
- Rust and the platform build tools required by Tauri 2; see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/treasureGrove/LoliCode.git
cd LoliCode
pnpm install --frozen-lockfile
pnpm dev
```

Vite updates the frontend during development. Rust changes require incremental compilation and a development-process restart, rather than an installer rebuild. To also watch the agent crate outside src-tauri:

```sh
pnpm dev --additional-watch-folders ../crates/lolicode-agent
```

Production packaging:

```sh
pnpm build
```

The proposed Electron/Host development workflow is documented in the architecture plan; it is not the current default entry point.

## Validation

Run checks appropriate to the change:

```sh
pnpm typecheck
pnpm test:unit
cargo test --manifest-path crates/lolicode-agent/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

The built desktop executable also supports --check-agent-runtime, an isolated local-fixture check of the native agent. It does not require a real model key. Historical test results are not a substitute for validating the current checkout.

## Project layout

- src/ — React workspace, configuration pages, components, and desktop client APIs.
- src-tauri/ — current desktop shell, Rust services, account/channel management, and configuration persistence.
- crates/lolicode-agent/ — current native agent implementation.
- docs/guides/ — architecture, development, release notes, and delivery evidence.
- third-party/ — retained upstream provenance and reference material.

Existing local workspaces may retain the historical TAI-Switch directory name. Default application data uses ~/.tai-switch; a portable build has its own documented data behavior. Do not point development or parallel application instances at the same production data directory.

## Contributing

Open an issue or pull request in [this repository](https://github.com/treasureGrove/LoliCode). Keep existing configuration fields and data compatible, describe the actual behavior change, and include relevant validation.

New integrations should identify the capability, owning module, execution target, source revision, and license impact. Preserve provider-specific model capabilities rather than flattening every model into a text-only interface.

## Attribution and license

The repository retains the [MIT license](LICENSE). Its CC Switch baseline is pinned to farion1231/cc-switch at 479964f2ef59e291f563218ac674a1fd82dcdbd3; see [FORK_BASELINE.md](FORK_BASELINE.md).

Research and selected integration candidates include [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [OpenCode](https://github.com/anomalyco/opencode), [ZCode](https://github.com/zai-org/ZCode), [UE Box](https://github.com/ueboxai/uebox), [Hermes Agent](https://github.com/NousResearch/hermes-agent), and [SillyTavern](https://github.com/SillyTavern/SillyTavern). Mentioning a project does not mean its code or complete application is included.

Reused code retains its applicable notices and license obligations. Future source adoption and the product's licensing decision are tracked separately in the capability/source ledger.
