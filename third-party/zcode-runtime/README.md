# Pinned ZCode runtime source

The `upstream/` directory contains unmodified Git blobs from
`https://github.com/zai-org/ZCode` at
`aac4755666d09fdcd70272fcf063c077a639015f` (3.15.1).
`source-manifest.json` records every included Git blob ID, byte length, and SHA-256.
The first-party license and upstream notices are preserved inside that directory.
Third-party dependencies and native binaries retain their separate licenses.

The source subset contains the CLI/runtime packages, Node services, RPC, provider
adapters, remote server, scheduler sources, build inputs, and bundled plugin/skill
assets. It excludes Electron and browser UI packages, tests, Git metadata,
environment files, and developer configuration. Original source files are never
patched for LoliCode; integration code lives in `packages/lolicode-zcode-runtime`.
The pinned Linux x64 bfs, ripgrep and ugrep archives and upstream SHA256SUMS
are also retained as original Git blobs for the owned remote asset builder.

Verify with `node scripts/build/prepare-zcode-runtime.mjs --verify-only`.
Refresh from the exact official checkout with
`node scripts/build/prepare-zcode-runtime.mjs --vendor-source <absolute-checkout> --source-only`.
Build with `node scripts/build/prepare-zcode-runtime.mjs` (Node 24.19.x and pnpm 10.33.2).
Dependency lifecycle scripts are disabled. Only explicitly audited native packages
may be rebuilt; the final manifest records the actual bundled Node executable.

The public upstream Computer Use package is an unavailable placeholder. Vendoring
these sources does not provide ZCode's proprietary cloud services or credentials.
