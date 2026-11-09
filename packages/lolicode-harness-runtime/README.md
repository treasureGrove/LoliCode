# LoliCode Harness runtime

This directory pins the official `@deepseek-ai/dsh` npm distribution to
`0.2.2-rc.1`, whose upstream release tag resolves to
`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`. The lock records the artifact
integrity and the complete npm dependency closure. This package is independent
of the desktop app's pnpm workspace.

Use Node.js 24.9 or newer with npm. From the repository root, run:

```sh
node scripts/build/prepare-lolicode-harness-runtime.mjs
```

Preparation uses the public npm registry and installs the lock without
dependency lifecycle scripts. The installed entry point is
`packages/lolicode-harness-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`.
Prepare this package before the desktop TypeScript check as well: the native
session preview imports the pinned official public declarations as types only.
For desktop packaging, pass `--bundle` or use the regular Tauri build command.
The builder installs a separate lockfile-resolved dependency tree and verifies
the official Node.js 24.19.0 artifact. It stages the runtime, profile overlays,
and licenses under `src-tauri/resources/agent/harness-runtime`. The installer
and portable ZIP carry this directory as `agent/harness-runtime`. The installed
app launches its bundled Node.js and requires no runtime download.

Launch the installed CLI with an absolute `DSH_HOME` owned by the app for the
runtime instance. Set the process working directory to the intended project and
use absolute paths for the CLI and patches.

```sh
node <cli> --profile sdk --patch <profile.cordis.patch.yml> --patch <host-operations.cordis.patch.yml> --patch <gateway-patch>
```

The gateway patch supplies the local model route and capability metadata. Keep
the gateway lease out of the patch and set `DSH_LOLICODE_GATEWAY_TOKEN` in the
child environment when the gateway patch references that variable. Set
`DSH_TELEMETRY_DISABLED=1` for the child. The packaged patch disables the
model-facing plugin manager and session telemetry. SDK traffic is newline-
delimited JSON-RPC over stdio, beginning with `initialize`.

The host operations patch delegates standard requests to the upstream SDK
server. It adds the desktop operations for owned sessions, secretary trees,
pending prompts, bounded legacy context, and approved MCP calls. The tests use
disposable projects and loopback models.

The optional native session preview reads `lolicode/session/read-native` over
the same private stdio connection. The bridge verifies root/worker ownership,
then lazily mounts the official Session Controller dependencies and invokes
its generated `events`, `projections`, and `state` contracts through the official
Gateway with a fixed, noninteractive owner peer. It preserves event envelopes
and projection cursors and does not add an HTTP listener. Page requests are
bounded to 200 messages and responses to 8 MiB; oversized events are rejected
without truncation. Projection and state cursors may be newer than a fixed
history page while the Agent is running.

`host-session-native.mjs` handles cold reads in a disposable Harness HOME with
the original JSONL directory mounted as the read backend. The SDK server and
startup entry are disabled, no Agent is restored, and user channel credentials
are not inherited. The helper deliberately returns the same upstream result
shapes as the live bridge. The existing main transcript remains available while
the development-only preview is evaluated.

```sh
node --test packages/lolicode-harness-runtime/tests/*.test.mjs
```

## Updating from DeepSeek

Update the exact `@deepseek-ai/dsh` version and regenerate this directory's
`package-lock.json` together. Verify the upstream release commit and registry
integrity, then update the pin above and the expected integrity in
`scripts/build/prepare-lolicode-harness-runtime.mjs`. Keep the official
packages intact. Put desktop integration in the host overlays and the Rust
and renderer adapters.

### Capability coverage

The bundled CLI runs the official SDK profile. LoliCode exposes it through
its own desktop host and client. The upstream desktop and web clients use
additional controllers and UI plugins, so each upgrade needs a separate
coverage check for those features.

Compare the accepted upstream commit with the candidate, including intervening
release notes, profile and plugin registrations, tool schemas, SDK requests
and events, persisted session data, and the official clients. For every
user-facing addition or change, record its upstream source, the LoliCode
surface, and the validation result. Identify whether it comes through the
runtime, has a verified LoliCode equivalent, requires a host or UI adapter, or
depends on an unavailable platform or service. Reuse public upstream
components and contracts where they fit the desktop. Track SuperAgent changes
against its separate upstream repository.

An SDK smoke test confirms the SDK path only. For an in-scope feature with a
public implementation, verify the corresponding LoliCode behavior before
accepting the upgrade as complete. Keep unresolved features and platform or
service blockers visible with their acceptance cases. Current examples are
remote interactive terminals and the Feishu and full thread subscription
flows listed in the SuperAgent adaptation record.

### Acceptance

The session menu can copy a complete native session as Markdown using the
official `formatSessionMarkdown` export. The host reads a live owned session
through `sessionQuery`, or a cold log through a credential-free JSONL reader.
It does not resume the Agent or render only the currently visible messages.
See [the integration boundary and limitations](../../docs/architecture/harness-session-markdown.md).
Run `--session-export` for the Windows menu, full history, child session,
read-only and restart cases. ZIP export remains a separate capability gap.

Run the runtime preparation and SDK tests against the updated package. On
Windows, use the isolated desktop acceptance runner to verify the normal flow
and its `--background-jobs`, `--native-modes`, and `--dock-tools` cases. These
exercise the model gateway, task delivery, native lifecycle, and the right
dock. The interactive terminal uses the same upstream local subprocess
provider as Harness.
