import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE_REVISION = "aac4755666d09fdcd70272fcf063c077a639015f";
export const SOURCE_URL = "https://github.com/zai-org/ZCode";
export const PNPM_VERSION = "10.33.2";
export const UPSTREAM_VERSION = "3.15.1";
export const WORKSPACE_REGISTRY_REFRESH_SOURCE =
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-runtime.ts";
const workspaceRefreshAnchor =
  "  const params = parseParams(zcodeWorkspaceReadPresentationParamsSchema, rawParams);";
const workspaceRefreshBarrier =
  "  await context.deps.refreshProviderRegistry?.('lolicode-channel-catalog');";

/** Build-only integration barrier; original vendored Git blobs stay unchanged. */
export function patchWorkspaceRegistryRefresh(source) {
  if (
    typeof source !== "string" ||
    source.split(workspaceRefreshAnchor).length !== 2 ||
    source.includes(workspaceRefreshBarrier) ||
    !source.includes("export async function readWorkspacePresentation(")
  )
    throw new Error(
      "Pinned workspace presentation registry-refresh anchor changed; refusing an unverified transform",
    );
  return source.replace(
    workspaceRefreshAnchor,
    `${workspaceRefreshAnchor}\n${workspaceRefreshBarrier}`,
  );
}

export async function ownedTransformManifest() {
  const original = await readFile(
    path.join(sourceRoot, WORKSPACE_REGISTRY_REFRESH_SOURCE),
  );
  return [
    {
      id: "lolicode-workspace-presentation-provider-refresh-v1",
      sourcePath: WORKSPACE_REGISTRY_REFRESH_SOURCE,
      sourceRevision: SOURCE_REVISION,
      originalSha256: hash(original),
      transformedSha256: hash(
        patchWorkspaceRegistryRefresh(original.toString("utf8")),
      ),
      purpose:
        "Read-only provider-registry barrier before public workspace presentation; no inference or session deletion",
    },
  ];
}

export function assertRegistryRefreshBundle(source) {
  if (
    !/await\s+\w+\.deps\.refreshProviderRegistry\?\.\(["']lolicode-channel-catalog["']\)/.test(
      source,
    )
  )
    throw new Error(
      "Embedded registry-refresh barrier is absent from the compiled runtime",
    );
}
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageRoot = path.join(repository, "packages/lolicode-zcode-runtime");
const vendorRoot = path.join(repository, "third-party/zcode-runtime");
const sourceRoot = path.join(vendorRoot, "upstream");
const workspace = path.join(packageRoot, ".build/workspace");
const output = path.join(repository, "src-tauri/resources/zcode-runtime");
const sourceManifest = path.join(vendorRoot, "source-manifest.json");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const slash = (value) => value.replaceAll("\\", "/");
const roots = [
  "@zcode/cli",
  "@zcode/services",
  "@zcode/server",
  "@zcode/server-cli",
  "@zcode/node-repl-host",
  "@zcode/android-emulator-plugin",
  "@zcode/ios-simulator-plugin",
];
const esmBanner =
  'import { createRequire as __lolicodeCreateRequire } from "node:module"; import { fileURLToPath as __lolicodeFileURLToPath } from "node:url"; import { dirname as __lolicodeDirname } from "node:path"; const require = __lolicodeCreateRequire(import.meta.url); const __filename = __lolicodeFileURLToPath(import.meta.url); const __dirname = __lolicodeDirname(__filename);';

export function safeRelative(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export function includeUpstream(file) {
  if (!safeRelative(file)) return false;
  const parts = file.split("/");
  if (
    parts.some(
      (part) =>
        /^\.env(?:\.|$)/i.test(part) ||
        [
          ".git",
          "node_modules",
          ".claude",
          ".codex",
          ".agents",
          ".vscode",
          ".idea",
          "test",
          "tests",
          "__tests__",
          "coverage",
        ].includes(part),
    )
  )
    return false;
  if (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$/.test(file)
  )
    return false;
  if (
    [
      "LICENSE",
      "NOTICE.md",
      "THIRD-PARTY-NOTICES.md",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
    ].includes(file)
  )
    return true;
  if (/^(?:scripts|config\/provider|patches|third-party)\//.test(file))
    return true;
  if (
    /^apps\/zcode-cli\/dependencies\/native-search\/(?:SHA256SUMS|bfs-v4\.1\.1-2\/bfs-v4\.1\.1-2-x86_64-unknown-linux-gnu\.tar\.gz|ripgrep-v14\.1\.1-1\/ripgrep-v14\.1\.1-1-x86_64-unknown-linux-musl\.tar\.gz|ugrep-v7\.8\.4-1\/ugrep-v7\.8\.4-1-x86_64-unknown-linux-gnu\.tar\.gz)$/.test(
      file,
    )
  )
    return true;
  if (/^apps\/zcode-cli\/(?:packages|scripts)\//.test(file)) return true;
  if (
    /^apps\/zcode-cli\/(?:package.json|turbo.json|tsconfig[^/]*\.json)$/.test(
      file,
    )
  )
    return true;
  if (
    /^packages\/(?:services|shared|rpc|provider|provider-node|model-option-map|server|zcode-server-cli|client|zcode-cua)\//.test(
      file,
    )
  )
    return true;
  return /^packages\/desktop\/src\/(?:scheduler\/|main\/desktopCronScheduler\.ts$)/.test(
    file,
  );
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function vendorSource(checkout) {
  if (!path.isAbsolute(checkout))
    throw new Error("--vendor-source must be an absolute path");
  const git = (args, options = {}) =>
    execFileSync("git", ["-C", checkout, ...args], {
      maxBuffer: 512 * 1024 * 1024,
      ...options,
    });
  const revision = git(["rev-parse", `${SOURCE_REVISION}^{commit}`], {
    encoding: "utf8",
  }).trim();
  if (revision !== SOURCE_REVISION)
    throw new Error("Pinned upstream commit is unavailable");
  const tree = git(["ls-tree", "-r", "-z", SOURCE_REVISION], {
    encoding: "utf8",
  });
  const entries = tree
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      return match ? { mode: match[1], blob: match[2], path: match[3] } : null;
    })
    .filter(
      (entry) =>
        entry && entry.mode !== "120000" && includeUpstream(entry.path),
    );
  const blobs = git(["cat-file", "--batch"], {
    input: entries.map((entry) => entry.blob).join("\n") + "\n",
  });
  let cursor = 0;
  for (const entry of entries) {
    const end = blobs.indexOf(10, cursor);
    const header = blobs.subarray(cursor, end).toString("ascii");
    const [id, type, size] = header.split(" ");
    if (id !== entry.blob || type !== "blob" || !/^\d+$/.test(size))
      throw new Error("Invalid Git blob response");
    const bytes = blobs.subarray(end + 1, end + 1 + Number(size));
    cursor = end + 1 + Number(size) + 1;
    const destination = path.join(sourceRoot, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    entry.bytes = bytes.length;
    entry.sha256 = hash(bytes);
  }
  await writeJson(sourceManifest, {
    format: 1,
    source: SOURCE_URL,
    revision,
    version: "3.15.1",
    files: entries,
  });
  return entries.length;
}

export async function verifySource(
  root = sourceRoot,
  manifestFile = sourceManifest,
) {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (
    manifest.format !== 1 ||
    manifest.revision !== SOURCE_REVISION ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw new Error("Invalid pinned ZCode source manifest");
  const seen = new Set();
  for (const file of manifest.files) {
    if (!includeUpstream(file.path) || seen.has(file.path))
      throw new Error("Unsafe or duplicate source manifest path");
    seen.add(file.path);
    const source = path.join(root, file.path);
    if (!(await lstat(source)).isFile())
      throw new Error(`Source is not a regular file: ${file.path}`);
    const bytes = await readFile(source);
    const blob = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (
      bytes.length !== file.bytes ||
      hash(bytes) !== file.sha256 ||
      blob !== file.blob
    )
      throw new Error(`Pinned source integrity mismatch: ${file.path}`);
  }
  return manifest;
}

async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readPackageMap(root) {
  const result = new Map();
  for (const base of ["packages", "apps/zcode-cli/packages"]) {
    for (const name of await readdir(path.join(root, base))) {
      const directory = path.join(root, base, name);
      const file = path.join(directory, "package.json");
      if (await exists(file)) {
        const manifest = JSON.parse(await readFile(file, "utf8"));
        result.set(manifest.name, { directory, manifest });
      }
    }
  }
  return result;
}

export function dependencyClosure(packages, names = roots) {
  const pending = [...names];
  const result = new Map();
  while (pending.length) {
    const name = pending.pop();
    if (result.has(name)) continue;
    const pkg = packages.get(name);
    if (!pkg) throw new Error(`Missing upstream workspace dependency: ${name}`);
    result.set(name, pkg);
    for (const [dependency, spec] of Object.entries(
      pkg.manifest.dependencies ?? {},
    ))
      if (spec.startsWith("workspace:")) pending.push(dependency);
  }
  return result;
}

async function prepareWorkspace(manifest) {
  // Only verified tracked files enter the isolated build tree. No checkout .env or
  // developer account/config directory is copied or consulted by this operation.
  for (const entry of manifest.files) {
    const destination = path.join(workspace, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(sourceRoot, entry.path), destination);
  }
  const packages = dependencyClosure(await readPackageMap(workspace));
  const locked = upstreamImporterVersions(
    await readFile(path.join(sourceRoot, "pnpm-lock.yaml"), "utf8"),
  );
  for (const [name, { directory, manifest: original }] of packages) {
    const importer = slash(path.relative(workspace, directory));
    const dependencies = Object.fromEntries(
      Object.entries(original.dependencies ?? {})
        .filter(([dependency]) => !dependency.startsWith("@lydell/"))
        .map(([dependency, specifier]) => {
          if (specifier.startsWith("workspace:"))
            return [dependency, specifier];
          const version = locked.get(`${importer}\0${dependency}`);
          if (!version)
            throw new Error(
              `Missing pinned dependency resolution: ${name}/${dependency}`,
            );
          return [dependency, version];
        }),
    );
    await writeJson(path.join(directory, "package.json"), {
      name,
      version: original.version ?? "0.0.0",
      private: true,
      type: original.type ?? "module",
      ...(original.exports ? { exports: original.exports } : {}),
      ...(original.imports ? { imports: original.imports } : {}),
      ...(original.main ? { main: original.main } : {}),
      dependencies,
    });
  }
  const workspaceDirectories = [...packages.values()].map((pkg) =>
    slash(path.relative(workspace, pkg.directory)),
  );
  const patched = {
    "@ai-sdk/openai-compatible@2.0.60":
      "patches/@ai-sdk__openai-compatible@2.0.60.patch",
    "@ai-sdk/anthropic@3.0.81": "patches/@ai-sdk__anthropic@3.0.81.patch",
  };
  await writeJson(path.join(workspace, "package.json"), {
    name: "lolicode-zcode-build",
    private: true,
    type: "module",
    packageManager: `pnpm@${PNPM_VERSION}`,
    devDependencies: { esbuild: "0.25.0" },
  });
  await writeFile(
    path.join(workspace, "pnpm-workspace.yaml"),
    `packages:\n${workspaceDirectories.map((value) => `  - '${value}'`).join("\n")}\n\npatchedDependencies:\n${Object.entries(
      patched,
    )
      .map(([name, file]) => `  '${name}': '${file}'`)
      .join("\n")}\n\nonlyBuiltDependencies: []\n`,
  );
  const lock = path.join(packageRoot, "runtime-pnpm-lock.yaml");
  if (await exists(lock))
    await copyFile(lock, path.join(workspace, "pnpm-lock.yaml"));
  else if (await exists(path.join(workspace, "pnpm-lock.yaml")))
    await writeFile(path.join(workspace, "pnpm-lock.yaml"), "");
  return packages;
}

// The upstream lock is trusted, fixed Git content. Read only its importer version
// scalars; never reinterpret arbitrary YAML tags or execute upstream build scripts.
export function upstreamImporterVersions(yaml) {
  const versions = new Map();
  let importer;
  let dependency;
  let section;
  let importers = false;
  const scalar = (value) => value.replace(/^['"]|['"]$/g, "");
  for (const line of yaml.split(/\r?\n/)) {
    if (line === "importers:") {
      importers = true;
      continue;
    }
    if (!importers) continue;
    if (/^\S/.test(line)) break;
    const entry = /^  (\S.*):$/.exec(line);
    if (entry) {
      importer = scalar(entry[1]);
      dependency = undefined;
      section = undefined;
      continue;
    }
    const category = /^    (\w+):$/.exec(line);
    if (category) {
      section = category[1];
      dependency = undefined;
      continue;
    }
    const name = /^      (\S.*):$/.exec(line);
    if (name) {
      dependency = scalar(name[1]);
      continue;
    }
    const version = /^        version: (.+)$/.exec(line);
    if (version && importer && dependency && section === "dependencies") {
      const value = scalar(version[1]).replace(/\(.*/, "");
      if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value))
        versions.set(`${importer}\0${dependency}`, value);
    }
  }
  return versions;
}

function pnpmEntrypoint() {
  const candidates = [
    process.env.LOLICODE_PNPM_CLI,
    process.env.APPDATA &&
      path.join(process.env.APPDATA, "npm/node_modules/pnpm/bin/pnpm.cjs"),
    path.join(path.dirname(process.execPath), "node_modules/pnpm/bin/pnpm.cjs"),
  ].filter(Boolean);
  const require = createRequire(import.meta.url);
  for (const candidate of candidates) {
    try {
      require.resolve(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Set LOLICODE_PNPM_CLI to an installed pnpm CLI .cjs path");
}

function runPnpm(args) {
  const result = spawnSync(process.execPath, [pnpmEntrypoint(), ...args], {
    cwd: workspace,
    stdio: "inherit",
    env: { ...process.env, CI: "1", npm_config_ignore_scripts: "true" },
  });
  if (result.status !== 0)
    throw new Error(
      `Isolated pnpm command failed (${result.status ?? result.error?.code})`,
    );
}

export function exportedPath(pkg, subpath) {
  const key = subpath ? `./${subpath}` : ".";
  let value =
    typeof pkg.manifest.exports === "string"
      ? pkg.manifest.exports
      : pkg.manifest.exports?.[key];
  if (
    !value &&
    pkg.manifest.exports &&
    typeof pkg.manifest.exports === "object"
  ) {
    for (const [pattern, target] of Object.entries(pkg.manifest.exports)) {
      const star = pattern.indexOf("*");
      if (
        star >= 0 &&
        key.startsWith(pattern.slice(0, star)) &&
        key.endsWith(pattern.slice(star + 1))
      ) {
        const middle = key.slice(star, key.length - pattern.length + star + 1);
        value =
          typeof target === "string" ? target.replaceAll("*", middle) : target;
        break;
      }
    }
  }
  if (value && typeof value === "object")
    value = value.import ?? value.node ?? value.default;
  if (!value)
    value = subpath ? `./${subpath}` : (pkg.manifest.main ?? "./src/index.ts");
  return value.replace(/^\.\/dist\//, "./src/").replace(/\.[cm]?js$/, ".ts");
}

async function buildRuntime(packages) {
  // Audited upstream generator: it only embeds the installed TypeScript standard
  // library declaration closure into an owned build-tree source file.
  execFileSync(
    process.execPath,
    [
      path.join(
        packages.get("@zcode/dynamic-workflow").directory,
        "scripts/generate-libs.mjs",
      ),
    ],
    { cwd: workspace, stdio: "inherit" },
  );
  const esbuildFile = createRequire(
    path.join(workspace, "package.json"),
  ).resolve("esbuild");
  const { build } = await import(pathToFileURL(esbuildFile).href);
  const plugin = {
    name: "pinned-zcode-source",
    setup(builder) {
      builder.onLoad(
        { filter: /workspace-model-runtime\.ts$/ },
        async (args) => {
          if (
            path.resolve(args.path) !==
            path.join(workspace, WORKSPACE_REGISTRY_REFRESH_SOURCE)
          )
            throw new Error(
              "Unexpected workspace presentation transform target",
            );
          return {
            contents: patchWorkspaceRegistryRefresh(
              await readFile(args.path, "utf8"),
            ),
            loader: "ts",
            resolveDir: path.dirname(args.path),
          };
        },
      );
      builder.onResolve({ filter: /^@zcode\// }, async (args) => {
        if (args.path === "@zcode/tui")
          return { path: args.path, external: true };
        const [scope, name, ...rest] = args.path.split("/");
        const pkg = packages.get(`${scope}/${name}`);
        if (!pkg) throw new Error(`Unstaged ZCode package: ${scope}/${name}`);
        let candidate = path.resolve(
          pkg.directory,
          exportedPath(pkg, rest.join("/")),
        );
        if (!(await exists(candidate)))
          candidate = candidate.replace(/\.ts$/, ".js");
        if (!(await exists(candidate)))
          throw new Error(`Missing pinned source export: ${args.path}`);
        return { path: candidate };
      });
    },
  };
  const external = [
    "playwright-core",
    "koffi",
    "node-pty",
    "ssh2",
    "@zcode/tui",
  ];
  const common = {
    bundle: true,
    platform: "node",
    target: "node24",
    logLevel: "info",
    sourcemap: false,
    legalComments: "inline",
    plugins: [plugin],
    external,
    metafile: true,
    nodePaths: [path.join(workspace, "node_modules")],
    define: {
      __CLI_VERSION__: JSON.stringify(UPSTREAM_VERSION),
      __ZCODE_VERSION__: JSON.stringify(UPSTREAM_VERSION),
      __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(
        await readFile(
          path.join(workspace, "config/provider/zcode-builtin.json"),
          "utf8",
        ),
      ),
    },
  };
  await mkdir(output, { recursive: true });
  const esm = await build({
    ...common,
    format: "esm",
    splitting: true,
    outdir: output,
    outExtension: { ".js": ".mjs" },
    entryPoints: {
      services: path.join(packageRoot, "src/services.ts"),
      remote: path.join(packageRoot, "src/remote-runtime.ts"),
      protocol: path.join(packageRoot, "src/protocol.ts"),
    },
    banner: { js: esmBanner },
  });
  const emitted = new Set(
    Object.keys(esm.metafile.outputs).map((file) => path.basename(file)),
  );
  // These are exclusively this builder's top-level ESM outputs. Remove old
  // content-addressed chunks individually, never recursively delete a directory.
  for (const entry of await readdir(output, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      /^[\w.-]+\.mjs$/.test(entry.name) &&
      !emitted.has(entry.name)
    )
      await unlink(path.join(output, entry.name));
  }
  const cli = await build({
    ...common,
    format: "cjs",
    entryPoints: [
      path.join(workspace, "apps/zcode-cli/packages/cli/src/main.ts"),
    ],
    outfile: path.join(output, "runtimeCLI.cjs"),
  });
  assertRegistryRefreshBundle(
    await readFile(path.join(output, "runtimeCLI.cjs"), "utf8"),
  );
  assertRegistryRefreshBundle(
    await readFile(path.join(output, "protocol.mjs"), "utf8"),
  );
  await copyFile(
    path.join(output, "runtimeCLI.cjs"),
    path.join(output, "zcode.cjs"),
  );
  const workerFile = path.join(packageRoot, "src/worker.ts");
  if (await exists(workerFile))
    await build({
      ...common,
      format: "cjs",
      entryPoints: [workerFile],
      outfile: path.join(output, "worker.cjs"),
      external: [
        ...external,
        "./services.mjs",
        "./remote.mjs",
        "./protocol.mjs",
      ],
    });
  // Do not dereference pnpm's complete node_modules tree: workspace links point
  // back to their own node_modules and can form cycles. Copy only native/asset
  // packages that remain external plus each package's actual installed closure.
  const externalPackages = new Map([
    ["playwright-core", packages.get("@zcode/adapters").directory],
    ["koffi", packages.get("@zcode/adapters").directory],
    ["node-pty", packages.get("@zcode/services").directory],
    ["ssh2", packages.get("@zcode/server").directory],
  ]);
  const tuiPackage = packages.get("@zcode/tui");
  const tuiDependencies = Object.keys(
    tuiPackage.manifest.dependencies ?? {},
  ).filter((name) => !name.startsWith("@zcode/"));
  const tuiDestination = path.join(output, "node_modules/@zcode/tui");
  await build({
    ...common,
    format: "esm",
    external: tuiDependencies,
    entryPoints: [path.join(tuiPackage.directory, "src/index.ts")],
    outfile: path.join(tuiDestination, "index.js"),
    banner: { js: esmBanner },
  });
  await writeJson(path.join(tuiDestination, "package.json"), {
    name: "@zcode/tui",
    version: "0.1.0",
    type: "module",
    main: "./index.js",
  });
  for (const name of tuiDependencies)
    externalPackages.set(name, {
      directory: tuiPackage.directory,
      targetParent: tuiDestination,
    });
  await stageExternalPackages(externalPackages, output);
  await writeJson(path.join(output, "package.json"), {
    name: "lolicode-zcode-owned-runtime",
    private: true,
    type: "module",
  });
  for (const name of ["LICENSE", "NOTICE.md", "THIRD-PARTY-NOTICES.md"])
    await copyFile(path.join(sourceRoot, name), path.join(output, name));
  await mkdir(path.join(output, "provider"), { recursive: true });
  await copyFile(
    path.join(workspace, "config/provider/zcode-builtin.json"),
    path.join(output, "provider/zcode-builtin.json"),
  );
  // Bundled workflow skill and content plugins keep their upstream relative layout.
  for (const name of await readdir(
    path.join(workspace, "apps/zcode-cli/packages"),
  )) {
    if (
      name.endsWith("-plugin") ||
      name === "bundled-skills" ||
      name === "node-repl-host"
    )
      await cp(
        path.join(workspace, "apps/zcode-cli/packages", name),
        path.join(output, "packages", name),
        {
          recursive: true,
          dereference: true,
          filter: (file) => !file.includes(`${path.sep}node_modules`),
        },
      );
  }
  for (const [name, entry] of [
    ["node-repl-host", "src/server.ts"],
    ["android-emulator-plugin", "src/mcp/server.ts"],
    ["ios-simulator-plugin", "src/mcp/server.ts"],
  ]) {
    await build({
      ...common,
      format: "esm",
      entryPoints: [
        path.join(workspace, "apps/zcode-cli/packages", name, entry),
      ],
      outfile: path.join(output, "packages", name, "dist/mcp/server.js"),
      banner: { js: esmBanner },
    });
  }
  await build({
    ...common,
    format: "esm",
    external: [...external, "sharp"],
    entryPoints: [
      path.join(
        workspace,
        "apps/zcode-cli/packages/browser-use-plugin/src/browser-client.ts",
      ),
    ],
    outfile: path.join(
      output,
      "packages/browser-use-plugin/scripts/browser-client.mjs",
    ),
    banner: { js: esmBanner },
  });
  const nodePath = await realpath(process.execPath);
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  await copyFile(nodePath, path.join(output, nodeName));
  if (process.platform !== "win32")
    await chmod(path.join(output, nodeName), 0o755);
  // Node's accompanying license is part of its redistribution, not covered by MIT.
  const nodeProvenance = await verifyOfficialNode(nodePath);
  await copyFile(nodeProvenance.license, path.join(output, "LICENSE.node.txt"));
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        if (file === path.join(output, "runtime-manifest.json")) continue;
        const bytes = await readFile(file);
        files.push({
          path: slash(path.relative(output, file)),
          bytes: bytes.length,
          sha256: hash(bytes),
        });
      } else throw new Error("Runtime output contains a non-regular entry");
    }
  }
  await walk(output);
  await writeJson(path.join(output, "runtime-manifest.json"), {
    format: 1,
    source: SOURCE_URL,
    sourceRevision: SOURCE_REVISION,
    upstreamVersion: "3.15.1",
    node: {
      version: process.version,
      sourceExecutable: nodePath,
      sha256: hash(await readFile(nodePath)),
      officialChecksumUrl: nodeProvenance.checksumUrl,
      licenseUrl: nodeProvenance.licenseUrl,
      platform: process.platform,
      arch: process.arch,
    },
    dependencyLockSha256: hash(
      await readFile(path.join(packageRoot, "runtime-pnpm-lock.yaml")),
    ),
    build: {
      packageManager: `pnpm@${PNPM_VERSION}`,
      lifecycleScripts: "disabled; explicit audited native rebuild only",
      sourceFiles: (await verifySource()).files.length,
    },
    ownedTransforms: await ownedTransformManifest(),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    modules: {
      cli: "runtimeCLI.cjs",
      services: "services.mjs",
      remote: "remote.mjs",
      protocol: "protocol.mjs",
      worker: (await exists(workerFile)) ? "worker.cjs" : null,
    },
    unavailable: [
      "Computer Use (upstream public placeholder)",
      "Official cloud account services without upstream entitlement",
    ],
  });
  return {
    files: files.length,
    entryInputs:
      Object.keys(esm.metafile.inputs).length +
      Object.keys(cli.metafile.inputs).length,
  };
}

async function verifyOfficialNode(executable) {
  const directory = path.join(packageRoot, ".build/node", process.version);
  await mkdir(directory, { recursive: true });
  const checksumUrl = `https://nodejs.org/dist/${process.version}/SHASUMS256.txt`;
  const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  const checksumFile = path.join(directory, "SHASUMS256.txt");
  const license = path.join(directory, "LICENSE");
  for (const [url, destination] of [
    [checksumUrl, checksumFile],
    [licenseUrl, license],
  ]) {
    if (await exists(destination)) continue;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        `Official Node metadata download failed (${response.status})`,
      );
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  }
  const relative =
    process.platform === "win32" ? `win-${process.arch}/node.exe` : undefined;
  if (!relative)
    throw new Error(
      "Only Windows owned Node executable checksum verification is implemented in this preparation tool",
    );
  const checksums = await readFile(checksumFile, "utf8");
  const expected = checksums
    .split(/\r?\n/)
    .map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line))
    .find((line) => line?.[2] === relative)?.[1];
  if (!expected || expected !== hash(await readFile(executable)))
    throw new Error(
      "Selected Node executable does not match official release SHASUMS256",
    );
  return { checksumUrl, licenseUrl, license };
}

async function resolveInstalledPackage(name, from) {
  for (let current = from; ; current = path.dirname(current)) {
    const file = path.join(current, "node_modules", name, "package.json");
    if (await exists(file)) return path.dirname(await realpath(file));
    if (path.dirname(current) === current) break;
  }
  throw new Error(`Runtime dependency was not installed: ${name}`);
}

export async function stageExternalPackages(entries, root) {
  const copied = new Map();
  const copy = async (name, from, targetParent = root) => {
    const source = await resolveInstalledPackage(name, from);
    const pkg = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    );
    const existing = copied.get(name);
    if (existing === pkg.version) return;
    const destination = path.join(targetParent, "node_modules", name);
    if (existing && targetParent === root)
      throw new Error(`Ambiguous external runtime dependency: ${name}`);
    const identity = `${destination}\0${pkg.version}`;
    if (copied.has(identity)) return;
    copied.set(identity, pkg.version);
    if (targetParent === root) copied.set(name, pkg.version);
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (file) =>
        !slash(path.relative(source, file))
          .split("/")
          .some(
            (part) => part === "node_modules" || /^\.env(?:\.|$)/i.test(part),
          ),
    });
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      const installed = await resolveInstalledPackage(dependency, source);
      const info = JSON.parse(
        await readFile(path.join(installed, "package.json"), "utf8"),
      );
      const target =
        copied.has(dependency) && copied.get(dependency) !== info.version
          ? destination
          : root;
      await copy(dependency, source, target);
    }
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
      try {
        await resolveInstalledPackage(dependency, source);
      } catch {
        continue;
      }
      await copy(dependency, source);
    }
  };
  for (const [name, value] of entries)
    await copy(
      name,
      typeof value === "string" ? value : value.directory,
      typeof value === "string" ? root : value.targetParent,
    );
}

export async function verifyRuntime(root = output) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "runtime-manifest.json"), "utf8"),
  );
  if (
    manifest.format !== 1 ||
    manifest.sourceRevision !== SOURCE_REVISION ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw new Error("Invalid ZCode runtime manifest");
  const seen = new Set();
  for (const file of manifest.files) {
    if (
      !safeRelative(file.path) ||
      seen.has(file.path) ||
      file.path
        .split("/")
        .some((part) => /^\.env(?:\.|$)/i.test(part) || part === ".git")
    )
      throw new Error("Unsafe runtime manifest path");
    seen.add(file.path);
    const target = path.join(root, file.path);
    if (!(await lstat(target)).isFile())
      throw new Error(`Runtime resource is not a regular file: ${file.path}`);
    const bytes = await readFile(target);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error(`Runtime resource checksum mismatch: ${file.path}`);
  }
  for (const required of [
    "node.exe",
    "runtimeCLI.cjs",
    "zcode.cjs",
    "services.mjs",
    "remote.mjs",
    "protocol.mjs",
    "LICENSE",
    "NOTICE.md",
    "THIRD-PARTY-NOTICES.md",
    "LICENSE.node.txt",
    "packages/bundled-skills/skills/dynamic-workflows/SKILL.md",
  ])
    if (!seen.has(required))
      throw new Error(`Missing required runtime resource: ${required}`);
  async function audit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await audit(file);
      else if (!entry.isFile())
        throw new Error("Runtime contains a non-regular entry");
      else if (
        file !== path.join(root, "runtime-manifest.json") &&
        !seen.has(slash(path.relative(root, file)))
      )
        throw new Error("Runtime contains a resource absent from its manifest");
    }
  }
  await audit(root);
  return manifest;
}

export async function verifyAttachedRemoteAssets(required = false) {
  const attached = path.join(output, "remote-assets");
  if (!(await exists(attached))) {
    if (required)
      throw new Error(
        "Owned Linux remote assets are required. Run prepare-zcode-remote-runtime.mjs with a verified native artifact first.",
      );
    return;
  }
  const { verifyRemoteAssets } = await import(
    "./prepare-zcode-remote-runtime.mjs"
  );
  await verifyRemoteAssets(attached);
}

export async function buildWorker() {
  const manifest = await verifyRuntime();
  await verifyAttachedRemoteAssets();
  const esbuildFile = createRequire(
    path.join(workspace, "package.json"),
  ).resolve("esbuild");
  const { build } = await import(pathToFileURL(esbuildFile).href);
  const workerFile = path.join(packageRoot, "src/worker.ts");
  if (!(await exists(workerFile)))
    throw new Error("LoliCode worker source is not present");
  const result = await build({
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    entryPoints: [workerFile],
    outfile: path.join(output, "worker.cjs"),
    external: ["./services.mjs", "./remote.mjs", "./protocol.mjs"],
    metafile: true,
    sourcemap: false,
    legalComments: "inline",
    logLevel: "info",
  });
  const bytes = await readFile(path.join(output, "worker.cjs"));
  manifest.files = manifest.files.filter((file) => file.path !== "worker.cjs");
  manifest.files.push({
    path: "worker.cjs",
    bytes: bytes.length,
    sha256: hash(bytes),
  });
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  manifest.modules.worker = "worker.cjs";
  const sourceInputs = [];
  for (const input of Object.keys(result.metafile.inputs).sort()) {
    const absolute = path.resolve(input);
    sourceInputs.push([
      slash(path.relative(repository, absolute)),
      hash(await readFile(absolute)),
    ]);
  }
  manifest.hostAdapter = {
    sourceInputsSha256: hash(JSON.stringify(sourceInputs)),
    files: sourceInputs,
  };
  await writeJson(path.join(output, "runtime-manifest.json"), manifest);
  return { bytes: bytes.length, sha256: hash(bytes) };
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set([
    "--vendor-source",
    "--source-only",
    "--verify-only",
    "--verify-runtime-only",
    "--skip-install",
    "--worker-only",
    "--require-remote-assets",
  ]);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Unknown option: ${args[i]}`);
    if (args[i] === "--vendor-source") i++;
  }
  const sourceIndex = args.indexOf("--vendor-source");
  if (args.includes("--worker-only")) {
    if (args.includes("--require-remote-assets"))
      await verifyAttachedRemoteAssets(true);
    const worker = await buildWorker();
    console.log(
      `Prepared LoliCode worker (${worker.bytes} bytes, SHA-256 ${worker.sha256}).`,
    );
    return;
  }
  if (args.includes("--verify-runtime-only")) {
    const manifest = await verifyRuntime();
    await verifyAttachedRemoteAssets(args.includes("--require-remote-assets"));
    console.log(`Verified ${manifest.files.length} owned runtime files.`);
    return;
  }
  if (sourceIndex >= 0) {
    if (!args[sourceIndex + 1]) throw new Error("--vendor-source needs a path");
    await vendorSource(path.resolve(args[sourceIndex + 1]));
  }
  const manifest = await verifySource();
  if (args.includes("--verify-only") || args.includes("--source-only")) {
    console.log(
      `Verified ${manifest.files.length} original ZCode Git blobs at ${SOURCE_REVISION}.`,
    );
    return;
  }
  // Never re-hash an invalid attached remote set into a seemingly healthy main
  // manifest. Rebuilds preserve previously verified Linux assets unchanged.
  await verifyAttachedRemoteAssets(args.includes("--require-remote-assets"));
  const nodeVersion = /^v24\.(\d+)\.(\d+)$/.exec(process.version);
  if (!nodeVersion || Number(nodeVersion[1]) < 19)
    throw new Error(
      "Use official Node 24.19 or newer Node 24 for the owned ZCode runtime",
    );
  if (process.platform !== "win32")
    throw new Error(
      "This preparation tool currently packages Windows owned runtimes only",
    );
  const packages = await prepareWorkspace(manifest);
  if (!args.includes("--skip-install")) {
    runPnpm([
      "install",
      "--ignore-scripts",
      (await exists(path.join(packageRoot, "runtime-pnpm-lock.yaml")))
        ? "--frozen-lockfile"
        : "--no-frozen-lockfile",
    ]);
    await copyFile(
      path.join(workspace, "pnpm-lock.yaml"),
      path.join(packageRoot, "runtime-pnpm-lock.yaml"),
    );
  }
  const prepared = await buildRuntime(packages);
  console.log(
    `Prepared pinned ZCode 3.15.1: ${prepared.files} runtime files; ${prepared.entryInputs} bundled source modules; no cloud/model requests executed.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
