# LoliCode ZCode runtime build boundary

This package assembles the official ZCode source pinned in
`third-party/zcode-runtime/`. It does not implement an independent tool loop.
Host/application code is separate from the unchanged vendored source.
The embedded build records its explicit integration transforms in
`runtime-manifest.json.ownedTransforms`. The current transform adds one awaited
provider-registry refresh at the start of the native public workspace-presentation
read, so an already running CLI observes a newly published channel catalog before
selecting its model. It performs no inference and deletes no session. Its exact
anchor fails closed on source drift; original and transformed SHA-256 are recorded.

Run from the repository root:

```powershell
node scripts/build/prepare-zcode-runtime.mjs --verify-only
node --test scripts/tests/prepare-zcode-runtime.test.mjs
node scripts/build/prepare-zcode-runtime.mjs
node scripts/build/prepare-zcode-runtime.mjs --worker-only
node scripts/build/prepare-zcode-runtime.mjs --verify-runtime-only
node scripts/tests/zcode-runtime-import-smoke.mjs
node scripts/tests/zcode-facades.mjs
```

Preparation currently targets Windows x64/arm64 with an installed official Node
24.19 or newer Node 24 executable. It copies that executable into the application;
end users do not install Node. The executable must match the corresponding
`https://nodejs.org/dist/v24.x.x/SHASUMS256.txt`. Its source executable path,
actual version, official checksum URL and full Node license are recorded.
The active package manager is pinned to pnpm 10.33.2, without replacing a global
installation. `LOLICODE_PNPM_CLI` can select an installed pnpm `.cjs` launcher.

The isolated `.build/workspace` contains only verified source files. Production
workspace dependencies use exact versions from the upstream lockfile. The smaller
`runtime-pnpm-lock.yaml` locks their transitive closure and official AI SDK patches.
Install lifecycle scripts remain disabled; the audited workflow stdlib generator
is run explicitly. Bundled Windows node-pty/koffi prebuilds are exercised by the
offline import smoke, without spawning a shell or opening an FFI library.

Public resource entries under `src-tauri/resources/zcode-runtime/`:

- `runtimeCLI.cjs` and the equivalent upstream-compatible name `zcode.cjs`:
  official CLI entry, including `app-server --stdio`.
- `services.mjs`: `Services`, `NodeServices`, `Rpc`, `Shared`, `Provider`, and
  `ProviderNode` namespaces. These and the following two modules are generated in
  one ESM graph, sharing chunks and service identities.
- `remote.mjs`: `Remote` namespace and direct official remote exports.
- `protocol.mjs`: `Bootstrap`, `Contracts`, and `SharedV4` namespaces.
- `worker.cjs`: built when the LoliCode host's `src/worker.ts` is present. Its
  relative imports of the public `.mjs` modules remain external.
- `packages/`: unchanged default skill/plugin content plus compiled official
  node-repl-host, Android and iOS MCP runtime entries. Platform availability,
  service/SDK requirements and public upstream placeholders still apply.
- `runtime-manifest.json`: every resource's size/SHA-256, source revision, package
  lock hash, actual Node provenance, and unavailable capability boundaries.

The host must set owned home/data/storage/provider paths before importing service
modules, project model catalogs through the authenticated LoliCode channel gateway,
and keep upstream credentials out of renderer/configuration DTOs. Importing the
public entries proves the runtime can load; it does not prove every service has
been started, every plugin has loaded, or a remote endpoint is reachable.

The public Computer Use package intentionally returns unavailable. Official cloud
accounts, Coding Plan quota/Off-Peak services, cloud sharing/marketing and private
resources are not supplied by this build. SSH/WSL/Docker use the actual upstream
remote service, whose current remote execution environment is POSIX-only.

Linux x64 assets use a separate, verified preparation step:

```powershell
node scripts/build/prepare-zcode-remote-runtime.mjs --ssh-builder <authorized-build-host>
node scripts/build/prepare-zcode-remote-runtime.mjs --verify-only
node scripts/tests/zcode-remote-runtime-smoke.mjs --ssh-host <authorized-test-host>
```

The native build writes only a unique `/tmp/lolicode-zcode-native-*` directory
on the explicitly named build host. It uses the official checksummed Node
24.19.0 Linux archive and its bundled node-gyp, with lifecycle scripts disabled.
Rebuilds reuse the locally verified native artifact when `--ssh-builder` is
omitted. The remote integration gate uses another `/tmp/lolicode-zcode-smoke-*`
private HOME; no original remote `.zcode` account/project is imported. It runs
the native deployer, stdio/RPC server, file service, search binaries, PTY and
gateway relay, then a real scoped native Agent task against an owned loopback
SSE fake model. The task must execute the native Read tool, return its actual
temporary-file result to the model, and reach a successful native terminal event
and authoritative assistant snapshot. No paid inference or account is used.
Its retained evidence is printed
only after all checks pass. SSH credentials stay with the system SSH client.

`remote-assets/releases/3.15.1/manifest-linux-x64.json` has the native seven
component layout and real archive hashes. Node, node-pty, server, CLI, content
plugins, and bfs/ripgrep/ugrep are included; the search binaries are verified
original archives from the pinned official ZCode Git commit. The native PTY
provenance records actual required glibc symbols. The current native artifact
requires glibc 2.34 or newer; older Linux systems, Linux arm64 and macOS remote
assets are not prepared by this builder and must fail clearly. Windows Node
is never substituted for a Linux runtime. The remote owner rewrites the native
install root into LoliCode's own namespace, including encoded lock scripts.
The current complete Windows-plus-Linux runtime occupies approximately 771 MiB
after extraction (about 768 MiB of payload plus its complete inventory). Both the seven compressed release archives and their unpacked
payloads are retained: the native `mockCdnDir` deployment path directly consumes
the unpacked files, while its CDN/cache path consumes the archives. Removing the
unpacked payload without introducing a separately verified extraction cache
would break the current deployment contract.

Asset preparation is staged under the owned build directory and atomically
published only after required plugin paths and all checksums validate. A failed
build retains the previous asset set. `asset-manifest.json` covers the entire
asset directory; the main `runtime-manifest.json` also covers these resources.
Normal full preparation preserves and independently verifies an existing remote
asset set before producing the main manifest. Production builders should append
`--require-remote-assets`; a fresh machine must explicitly prepare its verified
native asset first, rather than implicitly connecting to a build host.

The source is Apache-2.0 with its upstream notices. Runtime dependencies and Node
have their own retained licenses. This package's LoliCode build adapters are MIT.
