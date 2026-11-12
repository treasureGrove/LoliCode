import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(
  new URL("../../packages/lolicode-harness-runtime/", import.meta.url),
);
const packageName = "@deepseek-ai/dsh";
const pinnedVersion = JSON.parse(
  readFileSync(path.join(runtime, "package.json"), "utf8"),
).dependencies[packageName];
const pinnedIntegrity =
  "sha512-J727r2C471x2cYXGjqZ0D9T1ZyaYQDFH/Ynx8iq+85oslM4nky5YTBnbAuTtxMhW7nhY8wuAEfjjFCQ+K6Swgw==";
const registry = "https://registry.npmjs.org/";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const destination = path.join(
  repository,
  "src-tauri/resources/agent/harness-runtime",
);
const nodeVersion = "24.19.0";
const nodeDownload = `https://nodejs.org/dist/v${nodeVersion}/`;
const nodeLicenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`;
const nodeLicenseHash =
  "148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5";
// Checksums from the Node.js 24.19.0 release announcement and signed SHASUMS.
// https://nodejs.org/en/blog/release/v24.19.0#shasums
const nodeChecksums = {
  "win32-x64":
    "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237",
  "win32-arm64":
    "3958e4bb3f2d4ef37c938215dfc65a9d3c9d839b5060fec103bd2345fa78e951",
  "darwin-x64":
    "d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316",
  "darwin-arm64":
    "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
  "linux-x64":
    "f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4",
  "linux-arm64":
    "d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f",
};
const nodeName = process.platform === "win32" ? "node.exe" : "node";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Dependency payloads are immutable after npm ci. Bridge changes must not
// reinstall the same pinned 70,000-file SDK tree on every desktop build.
export function dependencyInputsHash(
  packageRoot = runtime,
  {
    platform = process.platform,
    arch = process.arch,
    targetNodeVersion = nodeVersion,
    policy = [verifyLock, npmConfiguration, installHarness, verifyPackageFiles]
      .map(String)
      .join("\0"),
  } = {},
) {
  return sha(
    JSON.stringify([
      "harness-dependencies-v1",
      platform,
      arch,
      targetNodeVersion,
      sha(policy),
      nodeChecksums[`${platform}-${arch}`],
      ...["package.json", "package-lock.json"].map((name) => [
        name,
        sha(readFileSync(path.join(packageRoot, name))),
      ]),
    ]),
  );
}

export function dependencyInventory(directory) {
  const hash = createHash("sha256");
  function visit(parent, prefix = "") {
    for (const entry of readdirSync(parent, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      // npm launcher wrappers are unused by our absolute Node/SDK invocation.
      if (entry.name === ".bin" || entry.name === ".lolicode-install.json")
        continue;
      const file = path.join(parent, entry.name);
      const relative = prefix + entry.name;
      if (entry.isDirectory()) visit(file, relative + "/");
      else if (entry.isFile()) {
        const value = statSync(file);
        hash.update(
          JSON.stringify([relative, value.size, value.mtimeMs, value.mode]) +
            "\0",
        );
      } else
        throw new Error(`Unexpected non-regular SDK cache file: ${relative}`);
    }
  }
  visit(directory);
  return hash.digest("hex");
}

export function commitBundle(
  stage,
  directory,
  previous,
  reuseDependencies,
  rename = renameSync,
) {
  const stageIdentity = lstatSync(stage, { bigint: true });
  const oldIdentity = existsSync(directory)
    ? lstatSync(directory, { bigint: true })
    : null;
  const sdkIdentity = reuseDependencies
    ? lstatSync(path.join(directory, "node_modules"), { bigint: true })
    : null;
  const isSameDirectory = (file, identity) => {
    if (!identity || !existsSync(file)) return false;
    const value = lstatSync(file, { bigint: true });
    return (
      value.isDirectory() &&
      value.dev === identity.dev &&
      value.ino === identity.ino
    );
  };
  try {
    if (existsSync(directory)) {
      if (!lstatSync(directory).isDirectory())
        throw new Error("Harness resource path is not a directory.");
      rename(directory, previous);
    }
    if (reuseDependencies) {
      // Both paths share the canonical parent/volume. Transfer the immutable
      // SDK in O(1), rather than copying or recreating 70,000 file entries.
      rename(
        path.join(previous, "node_modules"),
        path.join(stage, "node_modules"),
      );
    }
    rename(stage, directory);
  } catch (error) {
    try {
      // Detect completed renames by file identity too: recovery must work even
      // if an I/O wrapper reported failure after completing its operation.
      if (isSameDirectory(directory, stageIdentity)) rename(directory, stage);
      if (isSameDirectory(path.join(stage, "node_modules"), sdkIdentity))
        rename(
          path.join(stage, "node_modules"),
          path.join(previous, "node_modules"),
        );
      if (isSameDirectory(previous, oldIdentity)) rename(previous, directory);
      if (oldIdentity && !isSameDirectory(directory, oldIdentity))
        throw new Error(
          "The original Harness runtime directory was not restored.",
        );
      if (
        sdkIdentity &&
        !isSameDirectory(path.join(directory, "node_modules"), sdkIdentity)
      )
        throw new Error(
          "The original Harness SDK payload was not restored; preserving its transaction.",
        );
    } catch (rollback) {
      const failure = new AggregateError(
        [error, rollback],
        "Harness replacement and rollback failed; recovery files were preserved.",
      );
      failure.code = "HARNESS_RUNTIME_ROLLBACK_FAILED";
      throw failure;
    }
    throw error;
  }
}

function run(command, args, env = process.env, cwd = runtime) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Harness preparation failed (${result.signal || result.status}).`,
    );
  }
}

function verifyLock(packageRoot = runtime) {
  const { lockfileVersion, packages } = JSON.parse(
    readFileSync(path.join(packageRoot, "package-lock.json"), "utf8"),
  );
  const artifact = packages?.[`node_modules/${packageName}`];
  if (
    lockfileVersion !== 3 ||
    packages?.[""]?.dependencies?.[packageName] !== pinnedVersion ||
    artifact?.version !== pinnedVersion ||
    artifact?.integrity !== pinnedIntegrity
  ) {
    throw new Error("The Harness lock does not match the pinned npm artifact.");
  }
  for (const [name, entry] of Object.entries(packages)) {
    if (!name) continue;
    if (
      !entry.resolved?.startsWith(registry) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? "")
    ) {
      throw new Error(
        `The Harness dependency ${name} lacks a registry integrity pin.`,
      );
    }
  }
}

function npmConfiguration(packageRoot) {
  const userConfig = path.join(packageRoot, ".isolated-user.npmrc");
  const globalConfig = path.join(packageRoot, ".isolated-global.npmrc");
  for (const file of [
    path.join(packageRoot, ".npmrc"),
    userConfig,
    globalConfig,
  ]) {
    if (existsSync(file)) {
      throw new Error(
        `Harness preparation requires an isolated npm directory: ${file}`,
      );
    }
  }
  // A root pnpm invocation exports npm_config_* flags that npm may interpret
  // as a different install policy. Only carry cache and network settings.
  const allowed = new Set([
    "npm_config_cache",
    "npm_config_cafile",
    "npm_config_https_proxy",
    "npm_config_noproxy",
    "npm_config_proxy",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      const key = name.toLowerCase();
      return !key.startsWith("npm_config_") || allowed.has(key);
    }),
  );
  return {
    env,
    args: [`--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`],
  };
}

export function installedHarnessMatches(packageRoot, inputsHash) {
  try {
    const modules = path.join(packageRoot, "node_modules");
    const cached = JSON.parse(
      readFileSync(path.join(modules, ".lolicode-install.json"), "utf8"),
    );
    const entry = path.join(modules, packageName, "lib/bin.js");
    return (
      cached.format === 1 &&
      cached.inputsSha256 === inputsHash &&
      cached.harnessVersion === pinnedVersion &&
      cached.entrySha256 === sha(readFileSync(entry)) &&
      cached.packageFilesSha256 === dependencyInventory(modules) &&
      JSON.parse(
        readFileSync(path.join(modules, packageName, "package.json"), "utf8"),
      ).version === pinnedVersion
    );
  } catch {
    return false;
  }
}

function installHarness(packageRoot = runtime, { cache = false } = {}) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 9)) {
    throw new Error(
      "Preparing DeepSeek Harness requires Node.js 24.9 or newer.",
    );
  }
  verifyLock(packageRoot);

  const inputsHash = dependencyInputsHash(packageRoot);
  const npm = npmConfiguration(packageRoot);
  const cli = path.join(packageRoot, "node_modules", packageName, "lib/bin.js");
  if (cache && installedHarnessMatches(packageRoot, inputsHash)) {
    run(process.execPath, [cli, "--version"], process.env, packageRoot);
    console.log(`Verified existing pinned Harness SDK at ${cli}`);
    return;
  }

  const args = [
    "ci",
    "--ignore-scripts",
    "--include=optional",
    "--no-audit",
    "--no-fund",
    `--registry=${registry}`,
    ...npm.args,
  ];
  const npmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (existsSync(npmCli)) {
    run(process.execPath, [npmCli, ...args], npm.env, packageRoot);
  } else if (process.platform === "win32") {
    throw new Error("Use a Node.js installation with npm alongside node.exe.");
  } else {
    run("npm", args, npm.env, packageRoot);
  }

  if (process.platform === "darwin") {
    // The published node-pty archive strips this executable bit. Reproduce the
    // Harness postinstall's repair without running dependency lifecycle scripts.
    const helper = path.join(
      packageRoot,
      "node_modules",
      "node-pty",
      "prebuilds",
      `darwin-${process.arch}`,
      "spawn-helper",
    );
    chmodSync(helper, 0o755);
  }

  const installDir = path.join(packageRoot, "node_modules", packageName);
  const { version } = JSON.parse(
    readFileSync(path.join(installDir, "package.json"), "utf8"),
  );
  if (version !== pinnedVersion || !existsSync(cli)) {
    throw new Error(
      "The pinned DeepSeek Harness entry point was not installed.",
    );
  }
  run(process.execPath, [cli, "--version"], process.env, packageRoot);
  if (cache)
    writeFileSync(
      path.join(packageRoot, "node_modules/.lolicode-install.json"),
      JSON.stringify({
        format: 1,
        harnessVersion: pinnedVersion,
        inputsSha256: inputsHash,
        entrySha256: sha(readFileSync(cli)),
        packageFilesSha256: dependencyInventory(
          path.join(packageRoot, "node_modules"),
        ),
      }),
    );
  console.log(`Prepared DeepSeek Harness SDK at ${cli}`);
}

async function download(url, expected) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(180_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Official Node download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha(bytes) !== expected)
    throw new Error(
      "Official Node download did not match its pinned checksum.",
    );
  return bytes;
}

async function prepareNode(stage, transaction) {
  const platform = `${process.platform}-${process.arch}`;
  const checksum = nodeChecksums[platform];
  if (!checksum) throw new Error(`No pinned Node.js archive for ${platform}.`);
  const bundledNode = path.join(stage, nodeName);
  if (process.platform === "win32") {
    const installed = readFileSync(process.execPath);
    // Reuse a byte-identical official executable when the build machine has it.
    const binary =
      sha(installed) === checksum
        ? installed
        : await download(
            `${nodeDownload}win-${process.arch}/node.exe`,
            checksum,
          );
    writeFileSync(bundledNode, binary);
    writeFileSync(
      path.join(stage, "NODE-LICENSE"),
      await download(nodeLicenseUrl, nodeLicenseHash),
    );
  } else {
    const archiveRoot = `node-v${nodeVersion}-${platform}`;
    const archive = path.join(transaction, `${archiveRoot}.tar.gz`);
    writeFileSync(
      archive,
      await download(`${nodeDownload}${archiveRoot}.tar.gz`, checksum),
    );
    run("tar", [
      "-xzf",
      archive,
      "-C",
      stage,
      "--strip-components",
      "2",
      `${archiveRoot}/bin/node`,
    ]);
    run("tar", [
      "-xzf",
      archive,
      "-C",
      stage,
      "--strip-components",
      "1",
      `${archiveRoot}/LICENSE`,
    ]);
    renameSync(path.join(stage, "LICENSE"), path.join(stage, "NODE-LICENSE"));
    chmodSync(bundledNode, 0o755);
  }
  return sha(readFileSync(bundledNode));
}

function runtimeInputs(packageRoot = runtime) {
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /(?:\.mjs|\.ya?ml|^package(?:-lock)?\.json)$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

function readBundleManifest(directory = destination) {
  try {
    return JSON.parse(
      readFileSync(path.join(directory, "runtime-manifest.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

function runtimeIdentity() {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion,
    harnessVersion: pinnedVersion,
    nodeName,
    nodeChecksum:
      process.platform === "win32"
        ? nodeChecksums[`${process.platform}-${process.arch}`]
        : null,
    licenseChecksum: process.platform === "win32" ? nodeLicenseHash : null,
  };
}

export function reusableBundlePayload(
  directory,
  manifest,
  dependencyHash,
  expected = runtimeIdentity(),
) {
  try {
    return (
      manifest?.format === 1 &&
      manifest.harnessVersion === expected.harnessVersion &&
      manifest.nodeVersion === expected.nodeVersion &&
      manifest.platform === expected.platform &&
      manifest.arch === expected.arch &&
      manifest.dependenciesInputsSha256 === dependencyHash &&
      (!expected.nodeChecksum ||
        manifest.nodeSha256 === expected.nodeChecksum) &&
      manifest.nodeSha256 ===
        sha(readFileSync(path.join(directory, expected.nodeName))) &&
      (!expected.licenseChecksum ||
        manifest.nodeLicenseSha256 === expected.licenseChecksum) &&
      sha(readFileSync(path.join(directory, "NODE-LICENSE"))) ===
        manifest.nodeLicenseSha256 &&
      manifest.entrySha256 ===
        sha(
          readFileSync(
            path.join(directory, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
          ),
        ) &&
      manifest.packageFilesSha256 ===
        dependencyInventory(path.join(directory, "node_modules"))
    );
  } catch {
    return false;
  }
}

function bundleMatches(
  inputsHash,
  dependencyHash,
  directory = destination,
  expected = runtimeIdentity(),
) {
  try {
    const manifest = readBundleManifest(directory);
    return (
      manifest.inputsSha256 === inputsHash &&
      reusableBundlePayload(directory, manifest, dependencyHash, expected)
    );
  } catch {
    return false;
  }
}

function verifyPackageFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // npm's launcher wrappers are unnecessary for the host's absolute Node
      // and CLI paths, and can be symlinks on Linux/macOS.
      if (entry.name === ".bin") rmSync(file, { recursive: true, force: true });
      else verifyPackageFiles(file);
    } else if (!entry.isFile()) {
      throw new Error(
        `Unexpected non-regular file in Harness package: ${entry.name}`,
      );
    }
  }
}

export async function bundleHarness({
  packageRoot = runtime,
  directory = destination,
  repositoryRoot = repository,
  prepareNodePayload = prepareNode,
  install = installHarness,
  execute = run,
  publish = commitBundle,
  identity = runtimeIdentity(),
} = {}) {
  verifyLock(packageRoot);
  const inputs = runtimeInputs(packageRoot);
  const inputsHash = sha(
    JSON.stringify([
      process.platform,
      process.arch,
      nodeVersion,
      sha(readFileSync(fileURLToPath(import.meta.url))),
      ...inputs.map((file) => [
        file,
        sha(readFileSync(path.join(packageRoot, file))),
      ]),
    ]),
  );
  const dependenciesHash = dependencyInputsHash(packageRoot);
  if (bundleMatches(inputsHash, dependenciesHash, directory, identity)) {
    console.log(`Verified existing bundled Harness at ${directory}`);
    return;
  }
  const parent = path.dirname(directory);
  mkdirSync(parent, { recursive: true });
  const canonical = realpathSync(parent);
  const relative = path.relative(realpathSync(repositoryRoot), canonical);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "Refusing to stage Harness resources outside the repository.",
    );
  }
  const transaction = mkdtempSync(path.join(canonical, ".harness-runtime-"));
  const stage = path.join(transaction, "package");
  const previous = path.join(transaction, "previous");
  mkdirSync(stage);
  let preserveTransaction = false;
  try {
    const cached = readBundleManifest(directory);
    const reuse = reusableBundlePayload(
      directory,
      cached,
      dependenciesHash,
      identity,
    );
    const nodeSha256 = reuse
      ? cached.nodeSha256
      : await prepareNodePayload(stage, transaction);
    if (reuse) {
      copyFileSync(path.join(directory, nodeName), path.join(stage, nodeName));
      copyFileSync(
        path.join(directory, "NODE-LICENSE"),
        path.join(stage, "NODE-LICENSE"),
      );
      console.log(
        "Reused verified immutable Harness dependencies and Node; refreshing bridge files.",
      );
    }
    for (const file of inputs)
      copyFileSync(path.join(packageRoot, file), path.join(stage, file));
    if (!reuse) install(stage);
    if (!reuse) verifyPackageFiles(path.join(stage, "node_modules"));
    const entry = path.join(
      reuse ? directory : stage,
      "node_modules/@deepseek-ai/dsh/lib/bin.js",
    );
    execute(path.join(stage, nodeName), [entry, "--version"]);
    const manifest = {
      format: 1,
      harnessVersion: pinnedVersion,
      nodeVersion,
      platform: process.platform,
      arch: process.arch,
      inputsSha256: inputsHash,
      dependenciesInputsSha256: dependenciesHash,
      packageFilesSha256: reuse
        ? cached.packageFilesSha256
        : dependencyInventory(path.join(stage, "node_modules")),
      nodeSha256,
      nodeLicenseSha256: sha(readFileSync(path.join(stage, "NODE-LICENSE"))),
      entrySha256: sha(readFileSync(entry)),
    };
    writeFileSync(
      path.join(stage, "runtime-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    publish(stage, directory, previous, reuse);
    console.log(`Bundled DeepSeek Harness and Node.js at ${directory}`);
  } catch (error) {
    preserveTransaction = error.code === "HARNESS_RUNTIME_ROLLBACK_FAILED";
    throw error;
  } finally {
    // Keep the original tree available if the replacement and rollback failed.
    if (!preserveTransaction)
      rmSync(transaction, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) installHarness(runtime, { cache: true });
    else if (args.length === 1 && args[0] === "--bundle") await bundleHarness();
    else
      throw new Error("Use prepare-lolicode-harness-runtime.mjs [--bundle].");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
