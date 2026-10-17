# State preservation and hot update direction

## Current boundaries

The desktop client is a Tauri application: the React interface and Rust runtime are shipped together in signed, versioned application packages. The updater replaces that package; it does not update Rust code or execute arbitrary downloaded files inside the running process.

User state lives outside the installation directory. The default root is `~/.tai-switch`; an optional path override is stored separately by Tauri. The SQLite database contains provider/channel configuration and credentials, while projects and agent memory are stored alongside it. A normal application update should not remove this root.

Two protections now apply to this boundary:

- Before an update installs, LoliCode creates and verifies a SQLite snapshot after the signed package has downloaded and the local agent has gone idle. A failed snapshot cancels installation.
- If a configured data directory is missing, startup stops before opening a database. The recovery screen accepts only a directory containing the existing database or legacy config, then restarts against that directory. It does not silently create a blank profile.

## Update policy

Keep Rust IPC, database schema changes, filesystem and process permissions, credential handling, and native dependencies inside the signed application updater. These changes affect trust boundaries or require coordinated migrations; replacing them while the process is running is unsafe.

Move presentation and content that do not change executable behavior toward separately versioned resource packs. Suitable candidates include themes, mascot and decorative images, prompt templates, and declarative skill metadata. Each pack should have a signed manifest containing its pack version, minimum application version, file list, and SHA-256 hashes. The client should download to a staging directory, verify the signature and every hash, validate compatibility, and atomically activate the new pack. Keep the previous pack until the new one has loaded successfully so rollback is immediate.

Resource packs must not contain executable JavaScript, native libraries, permission declarations, or database migrations. A future plugin system needs its own permission review and isolation design; it must not inherit trust merely because it is delivered as a resource pack.

## Migration sequence

1. Keep the existing stable user-data root, fail closed when it is unavailable, and back up before signed application updates.
2. Add a versioned signed resource manifest and an atomic local cache for non-executable assets.
3. Migrate themes and mascot/decorative assets first; retain bundled defaults for offline use and failed updates.
4. Consider prompt and declarative skill bundles after compatibility and rollback behavior are proven.
5. Continue shipping runtime, permission, and schema changes through the signed desktop updater with backward-compatible database migrations and automatic pre-update snapshots.

## Implemented presentation-pack path (source, not yet shipped in an installer)

The source now includes a separately signed PNG resource updater. The initial live feed is `https://tools.treasuregrove.art/lolicode/resources/latest.json`; immutable version 1 assets are published below `resources/1/`. The application updater feed and installer artifacts were not changed by this resource publication.

A user installs a desktop release containing this client once. Subsequent artwork-only changes can be applied in Settings → About → Decorative resources, without an installer or restart. Startup reads only the local cache, and the bundled inline mascot remains the first paint and offline fallback. Network checks/downloads are explicit; neither opening the workbench nor displaying the mascot fetches a remote image.

The signed manifest specifies the resource kind, integer version, minimum/maximum application SemVer, archive size/SHA-256, and each slot's size/SHA-256. Version 1 supports only `companion`, `scene`, `sidebar` and `brooch` PNGs. The client uses the release public key already embedded in the application. It verifies the signature before downloading the archive, refuses non-official HTTPS origins/paths and redirects, bounds download/uncompressed/image sizes, rejects undeclared ZIP entries/symlinks, and decodes actual PNG frames before activation. It cannot install scripts, SVG, CSS, native code, permissions or database changes.

Packs live under the selected user-data root's `presentation-packs/` directory, outside the application installation. The content-addressed pack directory is immutable. An atomically replaced activation marker retains the previous pack; the frontend must decode all images before confirming activation. An unconfirmed pack rolls back on the next process's first local read. Invalid cache hashes or browser image decode errors fall back to the preceding or bundled assets. Stale confirmation/rollback receipts cannot switch a different active version. No database, channel Key or project record is modified by this updater.

`cargo run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_resource_acceptance -- --directory <signed-pack-directory>` validates an actual signed package in a temporary cache. `--live` runs the actual HTTP check/download/verification path, confirms activation, reopens the same private cache, and restores bundled assets. This is not actual desktop WebView acceptance or an installed-release upgrade test.

This implements the raster resource portion of step 2–3. Runtime, renderer JavaScript/UI behavior, prompts and skills still follow their existing delivery paths. In particular, frontend behavior hot updates are **not** implemented by this picture updater. A16 remains incomplete until those remaining requested small-update paths and real installed upgrades are verified. The signed Tauri application updater continues to deliver Rust, IPC, permission and schema changes.

## Preparing a resource-only publication

1. Use `node scripts/lolicode-resource-pack.mjs prepare --source src/assets/atelier --output <new-directory> --version <integer> --min-app <SemVer> --max-app <SemVer> --archive-url https://tools.treasuregrove.art/lolicode/resources/<version>/assets.zip`.
2. Sign the exact `manifest.json` with Tauri's signer. Supply the signing key path and password through the controlled signing environment (`TAURI_SIGNING_PRIVATE_KEY_PATH` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), never inline private-key contents or committed configuration.
3. Run `node scripts/lolicode-resource-pack.mjs finalize --directory <directory> --signature <manifest.json.sig> --public-key <public-key.pub>`. This verifies the signer against the application's embedded public key and checks the actual archive bytes. The tool preserves existing outputs rather than overwriting a prepared version.
4. Run the isolated native acceptance example against that directory. Publish immutable files first, read the final public archive back and compare its length/SHA-256, then atomically replace only the resource `latest.json` envelope. Preserve the previous immutable version and keep the application updater feed unchanged.
5. Run the native example with `--live`, then verify actual desktop display/apply/rollback and the newly shipped desktop release separately.
