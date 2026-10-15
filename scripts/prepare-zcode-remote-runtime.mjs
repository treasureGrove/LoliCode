import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  exportedPath,
  assertRegistryRefreshBundle,
  ownedTransformManifest,
  patchWorkspaceRegistryRefresh,
  readPackageMap,
  safeRelative,
  SOURCE_REVISION,
  SOURCE_URL,
  UPSTREAM_VERSION,
  WORKSPACE_REGISTRY_REFRESH_SOURCE,
  verifySource,
  verifyRuntime,
} from "./prepare-zcode-runtime.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repo, "third-party/zcode-runtime/upstream");
const buildRoot = path.join(
  repo,
  "packages/lolicode-zcode-runtime/.build/remote",
);
const workspace = path.join(
  repo,
  "packages/lolicode-zcode-runtime/.build/workspace",
);
const runtime = path.join(repo, "src-tauri/resources/zcode-runtime");
export const NODE_VERSION = "24.19.0";
export const PLATFORM = "linux-x64";
export const assetRoot = path.join(runtime, "remote-assets");
let preparationRoot = assetRoot;
let release = path.join(preparationRoot, "releases", UPSTREAM_VERSION);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slash = (value) => value.replaceAll("\\", "/");
const json = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};
const exists = async (file) => {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });

export function assertLinuxElf(bytes, name = "binary") {
  if (
    bytes.length < 20 ||
    bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== 62
  )
    throw new Error(`${name} must be a genuine Linux x86-64 ELF artifact`);
}

export function validateArchivePaths(listing) {
  const paths = listing.trim().split(/\r?\n/).filter(Boolean);
  if (!paths.length) throw new Error("Empty remote asset archive");
  for (const original of paths) {
    const file = original.replace(/^\.\//, "").replace(/\/$/, "");
    if (!safeRelative(file))
      throw new Error("Unsafe remote asset archive path");
  }
  return paths;
}

async function downloadVerified(url, destination, expected) {
  if (await exists(destination)) {
    if (sha(await readFile(destination)) === expected) return;
    throw new Error(
      `Cached download checksum mismatch: ${path.basename(destination)}`,
    );
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(180_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Official asset download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha(bytes) !== expected)
    throw new Error(
      `Official asset checksum mismatch: ${path.basename(destination)}`,
    );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

async function prepareNode() {
  const archiveName = `node-v${NODE_VERSION}-linux-x64.tar.gz`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}/`;
  const sums = await fetch(`${base}SHASUMS256.txt`, {
    signal: AbortSignal.timeout(60_000),
    redirect: "error",
  });
  if (!sums.ok) throw new Error("Cannot verify official Linux Node checksums");
  const text = await sums.text();
  const line = text
    .split(/\r?\n/)
    .find((line) => line.endsWith(`  ${archiveName}`));
  const checksum = line?.split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(checksum ?? ""))
    throw new Error("Official Linux Node checksum is absent");
  const archive = path.join(buildRoot, archiveName);
  await downloadVerified(`${base}${archiveName}`, archive, checksum);
  await writeFile(path.join(buildRoot, "SHASUMS256.node.txt"), text);
  const destination = path.join(release, "node", PLATFORM);
  await mkdir(destination, { recursive: true });
  run("tar", [
    "-xzf",
    archive,
    "-C",
    destination,
    "--strip-components",
    "2",
    `node-v${NODE_VERSION}-linux-x64/bin/node`,
  ]);
  run("tar", [
    "-xzf",
    archive,
    "-C",
    destination,
    "--strip-components",
    "1",
    `node-v${NODE_VERSION}-linux-x64/LICENSE`,
  ]);
  const bytes = await readFile(path.join(destination, "node"));
  assertLinuxElf(bytes, "Node runtime");
  await chmod(path.join(destination, "node"), 0o755);
  return {
    archive,
    url: `${base}${archiveName}`,
    sha256: checksum,
    version: NODE_VERSION,
    binarySha256: sha(bytes),
  };
}

async function prepareTools() {
  const { resolveNativeSearchPrebuiltPlan } = await import(
    pathToFileURL(path.join(source, "scripts/native-search-tools-config.mjs"))
      .href
  );
  const plan = resolveNativeSearchPrebuiltPlan({
    platform: "linux",
    arch: "x64",
    env: {},
  });
  const provenance = [];
  for (const artifact of plan.artifacts) {
    const bytes = await readFile(artifact.archivePath);
    if (sha(bytes) !== artifact.archiveSha256)
      throw new Error(
        `Pinned upstream tool archive changed: ${artifact.toolId}`,
      );
    const entries = validateArchivePaths(
      run("tar", ["-tzf", artifact.archivePath]),
    );
    const binary = entries.find(
      (file) =>
        file.replace(/\/$/, "").split("/").at(-1) === artifact.binaryName,
    );
    if (!binary)
      throw new Error(`Pinned tool archive lacks ${artifact.binaryName}`);
    const destination = path.join(release, "tools", PLATFORM, artifact.toolId);
    await mkdir(destination, { recursive: true });
    // Extract only the already validated, pinned binary; no archive-supplied links.
    const tool = execFileSync("tar", ["-xOzf", artifact.archivePath, binary], {
      maxBuffer: 32 * 1024 * 1024,
    });
    assertLinuxElf(tool, artifact.toolId);
    await writeFile(path.join(destination, artifact.binaryName), tool);
    await chmod(path.join(destination, artifact.binaryName), 0o755);
    for (const name of ["LICENSE", "THIRD-PARTY-NOTICES.md"])
      await copyFile(
        path.join(source, name),
        path.join(destination, name === "LICENSE" ? "LICENSE.zcode" : name),
      );
    provenance.push({
      id: artifact.toolId,
      version: artifact.release,
      sourcePath: slash(path.relative(source, artifact.archivePath)),
      archiveSha256: artifact.archiveSha256,
      binarySha256: sha(tool),
    });
  }
  return provenance;
}

async function buildBundles() {
  const packages = await readPackageMap(workspace);
  const esbuild = await import(
    pathToFileURL(
      createRequire(path.join(workspace, "package.json")).resolve("esbuild"),
    ).href
  );
  const plugin = {
    name: "pinned-zcode-remote-source",
    setup(builder) {
      builder.onLoad(
        { filter: /workspace-model-runtime\.ts$/ },
        async (args) => {
          if (
            path.resolve(args.path) !==
            path.join(workspace, WORKSPACE_REGISTRY_REFRESH_SOURCE)
          )
            throw new Error(
              "Unexpected remote registry-refresh transform target",
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
        if (!pkg)
          throw new Error(`Missing remote source package ${scope}/${name}`);
        let file = path.resolve(
          pkg.directory,
          exportedPath(pkg, rest.join("/")),
        );
        if (!(await exists(file))) file = file.replace(/\.ts$/, ".js");
        if (!(await exists(file)))
          throw new Error(`Missing remote source export ${args.path}`);
        return { path: file };
      });
      builder.onResolve({ filter: /\.node$/ }, (args) => ({
        path: args.path,
        external: true,
      }));
    },
  };
  const common = {
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    plugins: [plugin],
    logLevel: "info",
    legalComments: "inline",
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
      "import.meta.url": "__import_meta_url",
      "import.meta.dirname": "__dirname",
    },
    banner: {
      js: 'var __import_meta_url = require("node:url").pathToFileURL(__filename).href; module.paths.unshift(require("node:path").join(__dirname, "packages", "node_modules"));',
    },
  };
  // Match the native deployment contract: server is a self-contained CJS bundle,
  // while the headless agent has its external/native closure inside packages/.
  await esbuild.build({
    ...common,
    entryPoints: [path.join(workspace, "packages/server/src/entry-stdio.ts")],
    outfile: path.join(release, "server/zcode-server.cjs"),
  });
  await esbuild.build({
    ...common,
    external: ["playwright-core", "koffi", "node-pty", "ssh2", "@zcode/tui"],
    entryPoints: [
      path.join(workspace, "apps/zcode-cli/packages/cli/src/main.ts"),
    ],
    outfile: path.join(release, "glm", PLATFORM, "zcode.cjs"),
  });
  const agent = path.join(release, "glm", PLATFORM);
  assertRegistryRefreshBundle(
    await readFile(path.join(agent, "zcode.cjs"), "utf8"),
  );
  await cp(path.join(runtime, "packages"), path.join(agent, "packages"), {
    recursive: true,
    dereference: false,
  });
  await esbuild.build({
    ...common,
    format: "esm",
    external: ["sharp"],
    define: {
      __CLI_VERSION__: JSON.stringify(UPSTREAM_VERSION),
      __ZCODE_VERSION__: JSON.stringify(UPSTREAM_VERSION),
    },
    banner: {
      js: 'import {createRequire as __lolicodeRequire} from "node:module"; const require=__lolicodeRequire(import.meta.url);',
    },
    entryPoints: [
      path.join(
        workspace,
        "apps/zcode-cli/packages/browser-use-plugin/src/browser-client.ts",
      ),
    ],
    outfile: path.join(
      agent,
      "packages/browser-use-plugin/scripts/browser-client.mjs",
    ),
  });
  const assetContractFile = path.join(
    buildRoot,
    "official-plugin-asset-contract.cjs",
  );
  await esbuild.build({
    bundle: true,
    platform: "node",
    format: "cjs",
    entryPoints: [
      path.join(
        workspace,
        "packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts",
      ),
    ],
    outfile: assetContractFile,
  });
  const assetContract = createRequire(import.meta.url)(assetContractFile);
  for (const relative of assetContract.REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
    if (
      !safeRelative(relative) ||
      !(await exists(path.join(agent, "packages", relative)))
    )
      throw new Error(
        `Required native remote plugin resource is absent: ${relative}`,
      );
  }
  // The CLI's external requires and content-plugin subprocesses share this
  // platform-local, pnpm-free dependency closure, never the host's node.exe.
  await cp(
    path.join(runtime, "node_modules"),
    path.join(agent, "packages/node_modules"),
    {
      recursive: true,
      dereference: false,
      filter: (file) => {
        const parts = slash(
          path.relative(path.join(runtime, "node_modules"), file),
        ).split("/");
        return (
          !parts.some(
            (part) =>
              /^\.env(?:\.|$)/i.test(part) ||
              part === ".git" ||
              /^(?:win32|darwin|freebsd|openbsd|musl)[_-]/.test(part),
          ) && !/\.(?:exe|dll)$/i.test(file)
        );
      },
    },
  );
  for (const directory of [path.join(release, "server"), agent]) {
    for (const name of ["LICENSE", "NOTICE.md", "THIRD-PARTY-NOTICES.md"])
      await copyFile(path.join(source, name), path.join(directory, name));
  }
}

export function assertOwnedRemoteBuildPath(value) {
  if (!/^\/tmp\/lolicode-zcode-native-[A-Za-z0-9]{6,16}$/.test(value))
    throw new Error("Unexpected remote build directory");
  return value;
}
const q = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function prepareNative(node, sshAlias) {
  const binary = path.join(buildRoot, "native-linux-x64/pty.node");
  const metadata = path.join(buildRoot, "native-linux-x64/provenance.json");
  if (!sshAlias) {
    if (!(await exists(binary)) || !(await exists(metadata)))
      throw new Error(
        "Linux node-pty has not been built. Use --ssh-builder <authorized-build-host>",
      );
  } else {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(sshAlias))
      throw new Error("Invalid SSH builder alias");
    const remote = assertOwnedRemoteBuildPath(
      run("ssh", [
        "-o",
        "BatchMode=yes",
        sshAlias,
        "mktemp -d /tmp/lolicode-zcode-native-XXXXXXXX",
      ]).trim(),
    );
    const nativeSource = path.join(buildRoot, `native-source-${randomUUID()}`);
    await mkdir(nativeSource, { recursive: true });
    const installed = path.join(runtime, "node_modules");
    for (const name of ["node-pty", "node-addon-api"])
      await cp(
        path.join(installed, name),
        path.join(nativeSource, "node_modules", name),
        {
          recursive: true,
          filter: (file) =>
            !slash(path.relative(path.join(installed, name), file))
              .split("/")
              .some((part) =>
                ["node_modules", "build", "prebuilds", ".git"].includes(part),
              ),
        },
      );
    const tar = path.join(buildRoot, "native-source.tar.gz");
    run("tar", ["-czf", tar, "-C", nativeSource, "node_modules"]);
    run("scp", ["-q", node.archive, tar, `${sshAlias}:${remote}/`]);
    const script = `set -eu
task_root=${q(remote)}
case "$task_root" in /tmp/lolicode-zcode-native-????????) ;; *) exit 90;; esac
cd "$task_root"
tar -xf node-v${NODE_VERSION}-linux-x64.tar.gz
tar -xzf native-source.tar.gz
export PATH="$task_root/node-v${NODE_VERSION}-linux-x64/bin:/usr/bin:/bin"
export HOME="$task_root/home" npm_config_cache="$task_root/npm-cache"
mkdir -p "$HOME"
node node-v${NODE_VERSION}-linux-x64/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --directory "$task_root/node_modules/node-pty" --nodedir "$task_root/node-v${NODE_VERSION}-linux-x64" --jobs 2 > native-build.log 2>&1 || { tail -n 25 native-build.log; exit 1; }
node -e 'const p=require("./node_modules/node-pty").spawn("/bin/sh",["-c","printf LOLICODE_PTY_OK"],{cwd:process.cwd(),env:{PATH:"/usr/bin:/bin"}});let data="";const t=setTimeout(()=>process.exit(3),10000);p.onData(x=>data+=x);p.onExit(({exitCode})=>{clearTimeout(t);if(exitCode!==0||!data.includes("LOLICODE_PTY_OK"))process.exit(4);console.log("Linux node-pty native terminal PASS")});'
cp node_modules/node-pty/build/Release/pty.node pty.node
node -e 'const c=require("node:child_process"),fs=require("node:fs"),crypto=require("node:crypto"); const text=c.execFileSync("readelf",["--version-info","pty.node"],{encoding:"utf8"}); const versions=[...new Set(text.match(/GLIBC_[0-9.]+/g)||[])].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));fs.writeFileSync("provenance.json",JSON.stringify({node:process.version,nodePty:"1.1.0",platform:process.platform,arch:process.arch,glibc:c.execFileSync("getconf",["GNU_LIBC_VERSION"],{encoding:"utf8"}).trim(),requiredGlibcSymbols:versions,sha256:crypto.createHash("sha256").update(fs.readFileSync("pty.node")).digest("hex"),terminalSpawnTest:true},null,2)+"\\n")'
`;
    run("ssh", ["-o", "BatchMode=yes", sshAlias, "sh", "-s"], {
      input: script,
      stdio: ["pipe", "inherit", "inherit"],
    });
    await mkdir(path.dirname(binary), { recursive: true });
    run("scp", ["-q", `${sshAlias}:${remote}/pty.node`, binary]);
    run("scp", ["-q", `${sshAlias}:${remote}/provenance.json`, metadata]);
    console.log(
      `Native build retained only in owned temporary directory: ${remote}`,
    );
  }
  const provenance = JSON.parse(await readFile(metadata, "utf8"));
  const bytes = await readFile(binary);
  assertLinuxElf(bytes, "node-pty");
  if (
    provenance.sha256 !== sha(bytes) ||
    provenance.node !== `v${NODE_VERSION}` ||
    provenance.platform !== "linux" ||
    provenance.arch !== "x64" ||
    !provenance.terminalSpawnTest
  )
    throw new Error(
      "Linux native provenance does not match the verified artifact",
    );
  const target = path.join(release, "node-pty", PLATFORM);
  await mkdir(target, { recursive: true });
  await copyFile(binary, path.join(target, "pty.node"));
  await copyFile(
    path.join(runtime, "node_modules/node-pty/LICENSE"),
    path.join(target, "LICENSE"),
  );
  const agentNative = path.join(
    release,
    "glm",
    PLATFORM,
    "packages/node_modules/node-pty/prebuilds/linux-x64",
  );
  await mkdir(agentNative, { recursive: true });
  await copyFile(binary, path.join(agentNative, "pty.node"));
  return provenance;
}

async function inventory(root, excluded = new Set()) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name),
        relative = slash(path.relative(root, file));
      if (excluded.has(relative)) continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const bytes = await readFile(file);
        files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
      } else
        throw new Error(
          "Remote assets may contain only regular files and directories",
        );
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function writeManifests(node, native, tools) {
  const toolVersions = Object.fromEntries(
    tools.map((tool) => [tool.id, tool.version]),
  );
  const components = [];
  for (const [id, mount, version] of [
    ["server-bundle", "server", UPSTREAM_VERSION],
    ["node-runtime", `node/${PLATFORM}`, NODE_VERSION],
    ["node-pty", `node-pty/${PLATFORM}`, "1.1.0"],
    ["glm", `glm/${PLATFORM}`, UPSTREAM_VERSION],
    ...["bfs", "ripgrep", "ugrep"].map((id) => [
      id,
      `tools/${PLATFORM}/${id}`,
      toolVersions[id],
    ]),
  ]) {
    const artifactPath = `artifacts/${id}-${PLATFORM}.tar.gz`;
    await mkdir(path.join(release, "artifacts"), { recursive: true });
    const entries = await readdir(path.join(release, mount));
    run("tar", [
      "-czf",
      path.join(release, artifactPath),
      "-C",
      path.join(release, mount),
      ...entries,
    ]);
    components.push({
      id,
      version,
      sha256: sha(await readFile(path.join(release, artifactPath))),
      artifactPath,
      mount,
    });
  }
  await json(path.join(release, `manifest-${PLATFORM}.json`), {
    schemaVersion: 1,
    appVersion: UPSTREAM_VERSION,
    platformArch: PLATFORM,
    components,
  });
  const { archive: _localArchive, ...nodeProvenance } = node;
  await json(path.join(preparationRoot, "asset-manifest.json"), {
    format: 1,
    source: SOURCE_URL,
    sourceRevision: SOURCE_REVISION,
    upstreamVersion: UPSTREAM_VERSION,
    platform: PLATFORM,
    node: nodeProvenance,
    native,
    ownedTransforms: await ownedTransformManifest(),
    tools,
    files: await inventory(preparationRoot, new Set(["asset-manifest.json"])),
  });
}

async function publishPreparedAssets() {
  await verifyRemoteAssets(preparationRoot);
  const previous = path.join(buildRoot, `previous-assets-${randomUUID()}`);
  const hadPrevious = await exists(assetRoot);
  if (hadPrevious) await rename(assetRoot, previous);
  try {
    await rename(preparationRoot, assetRoot);
  } catch (error) {
    if (hadPrevious) await rename(previous, assetRoot);
    throw error;
  }
  try {
    await refreshRuntimeInventory();
  } catch (error) {
    await rename(
      assetRoot,
      path.join(buildRoot, `unpublished-assets-${randomUUID()}`),
    );
    if (hadPrevious) await rename(previous, assetRoot);
    throw error;
  }
}

async function refreshRuntimeInventory() {
  // Tauri's resource manifest continues to cover every byte, including the
  // optional Linux assets; preparation never changes another harness config.
  const runtimeManifest = JSON.parse(
    await readFile(path.join(runtime, "runtime-manifest.json"), "utf8"),
  );
  runtimeManifest.files = await inventory(
    runtime,
    new Set(["runtime-manifest.json"]),
  );
  await json(path.join(runtime, "runtime-manifest.json"), runtimeManifest);
}

export async function verifyRemoteAssets(root = assetRoot) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "asset-manifest.json"), "utf8"),
  );
  if (
    manifest.format !== 1 ||
    manifest.sourceRevision !== SOURCE_REVISION ||
    manifest.platform !== PLATFORM ||
    !manifest.files?.length
  )
    throw new Error("Invalid owned remote assets manifest");
  if (
    JSON.stringify(manifest.ownedTransforms) !==
    JSON.stringify(await ownedTransformManifest())
  )
    throw new Error(
      "Owned remote runtime integration transforms are stale or missing",
    );
  const expected = new Map();
  for (const file of manifest.files) {
    if (
      !safeRelative(file.path) ||
      expected.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Unsafe owned remote asset manifest");
    expected.set(file.path, file);
  }
  const actual = await inventory(root, new Set(["asset-manifest.json"]));
  if (actual.length !== expected.size)
    throw new Error("Unexpected or missing owned remote assets");
  for (const file of actual) {
    const saved = expected.get(file.path);
    if (!saved || saved.sha256 !== file.sha256 || saved.bytes !== file.bytes)
      throw new Error(`Owned remote asset checksum mismatch: ${file.path}`);
  }
  for (const name of [
    `node/${PLATFORM}/node`,
    `node-pty/${PLATFORM}/pty.node`,
    ...["bfs/bfs", "ripgrep/rg", "ugrep/ugrep"].map(
      (name) => `tools/${PLATFORM}/${name}`,
    ),
  ])
    assertLinuxElf(
      await readFile(path.join(root, "releases", UPSTREAM_VERSION, name)),
      name,
    );
  const base = path.join(root, "releases", UPSTREAM_VERSION);
  const components = JSON.parse(
    await readFile(path.join(base, `manifest-${PLATFORM}.json`), "utf8"),
  );
  const mounts = {
    "server-bundle": "server",
    "node-runtime": `node/${PLATFORM}`,
    "node-pty": `node-pty/${PLATFORM}`,
    glm: `glm/${PLATFORM}`,
    ...Object.fromEntries(
      ["bfs", "ripgrep", "ugrep"].map((id) => [id, `tools/${PLATFORM}/${id}`]),
    ),
  };
  if (
    components.schemaVersion !== 1 ||
    components.appVersion !== UPSTREAM_VERSION ||
    components.platformArch !== PLATFORM ||
    components.components?.length !== 7
  )
    throw new Error("Invalid native remote release manifest");
  const ids = new Set();
  for (const component of components.components) {
    if (
      !mounts[component.id] ||
      ids.has(component.id) ||
      component.mount !== mounts[component.id] ||
      !safeRelative(component.artifactPath)
    )
      throw new Error("Unsafe native remote release component");
    ids.add(component.id);
    if (
      sha(await readFile(path.join(base, component.artifactPath))) !==
      component.sha256
    )
      throw new Error("Native remote release archive checksum mismatch");
  }
  for (const required of [
    "server/zcode-server.cjs",
    `glm/${PLATFORM}/zcode.cjs`,
    `glm/${PLATFORM}/packages/node-repl-host/dist/mcp/server.js`,
  ])
    if (!expected.has(`releases/${UPSTREAM_VERSION}/${required}`))
      throw new Error("Incomplete native remote runtime");
  return manifest;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--verify-only")) {
    const manifest = await verifyRemoteAssets();
    console.log(
      `Verified ${manifest.files.length} owned Linux remote asset files.`,
    );
    return;
  }
  const index = args.indexOf("--ssh-builder");
  if (index >= 0 && !args[index + 1])
    throw new Error("--ssh-builder needs an explicitly authorized host alias");
  await verifySource();
  await verifyRuntime();
  await mkdir(buildRoot, { recursive: true });
  preparationRoot = path.join(buildRoot, `staging-assets-${randomUUID()}`);
  release = path.join(preparationRoot, "releases", UPSTREAM_VERSION);
  const node = await prepareNode();
  const tools = await prepareTools();
  await buildBundles();
  const native = await prepareNative(
    node,
    index >= 0 ? args[index + 1] : undefined,
  );
  await writeManifests(node, native, tools);
  await publishPreparedAssets();
  const manifest = await verifyRemoteAssets();
  console.log(
    `Prepared ${manifest.files.length} Linux remote asset files in ${assetRoot}`,
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
