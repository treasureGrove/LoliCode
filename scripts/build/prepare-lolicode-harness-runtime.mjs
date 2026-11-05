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
  "sha512-ijR9UEVYkG15Q/Q79JzvzLBzQOQfc63VLr9n6flpwHPhr5IKn2UxthnSoto/P9l7qGd7pPvI1Ra6TW7LH3oKpg==";
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

function verifyLock() {
  const { lockfileVersion, packages } = JSON.parse(
    readFileSync(path.join(runtime, "package-lock.json"), "utf8"),
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

function installHarness(packageRoot = runtime) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 9)) {
    throw new Error(
      "Preparing DeepSeek Harness requires Node.js 24.9 or newer.",
    );
  }
  verifyLock();

  const npm = npmConfiguration(packageRoot);
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
  const cli = path.join(installDir, "lib", "bin.js");
  const { version } = JSON.parse(
    readFileSync(path.join(installDir, "package.json"), "utf8"),
  );
  if (version !== pinnedVersion || !existsSync(cli)) {
    throw new Error(
      "The pinned DeepSeek Harness entry point was not installed.",
    );
  }
  run(process.execPath, [cli, "--version"], process.env, packageRoot);
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

function runtimeInputs() {
  return readdirSync(runtime, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /(?:\.mjs|\.ya?ml|^package(?:-lock)?\.json)$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

function bundleMatches(inputsHash) {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(destination, "runtime-manifest.json"), "utf8"),
    );
    const entry = path.join(
      destination,
      "node_modules/@deepseek-ai/dsh/lib/bin.js",
    );
    return (
      manifest.inputsSha256 === inputsHash &&
      manifest.nodeSha256 ===
        sha(readFileSync(path.join(destination, nodeName))) &&
      manifest.entrySha256 === sha(readFileSync(entry)) &&
      existsSync(path.join(destination, "NODE-LICENSE"))
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

async function bundleHarness() {
  verifyLock();
  const inputs = runtimeInputs();
  const inputsHash = sha(
    JSON.stringify([
      process.platform,
      process.arch,
      nodeVersion,
      sha(readFileSync(fileURLToPath(import.meta.url))),
      ...inputs.map((file) => [
        file,
        sha(readFileSync(path.join(runtime, file))),
      ]),
    ]),
  );
  if (bundleMatches(inputsHash)) {
    console.log(`Verified existing bundled Harness at ${destination}`);
    return;
  }
  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true });
  const canonical = realpathSync(parent);
  const relative = path.relative(realpathSync(repository), canonical);
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
  try {
    const nodeSha256 = await prepareNode(stage, transaction);
    for (const file of inputs)
      copyFileSync(path.join(runtime, file), path.join(stage, file));
    installHarness(stage);
    verifyPackageFiles(path.join(stage, "node_modules"));
    const entry = path.join(stage, "node_modules/@deepseek-ai/dsh/lib/bin.js");
    run(path.join(stage, nodeName), [entry, "--version"]);
    const manifest = {
      format: 1,
      harnessVersion: pinnedVersion,
      nodeVersion,
      platform: process.platform,
      arch: process.arch,
      inputsSha256: inputsHash,
      nodeSha256,
      entrySha256: sha(readFileSync(entry)),
    };
    writeFileSync(
      path.join(stage, "runtime-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    if (existsSync(destination)) {
      if (!lstatSync(destination).isDirectory())
        throw new Error("Harness resource path is not a directory.");
      renameSync(destination, previous);
    }
    try {
      renameSync(stage, destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
    console.log(`Bundled DeepSeek Harness and Node.js at ${destination}`);
  } finally {
    // Keep the original tree available if the replacement and rollback failed.
    if (!existsSync(previous) || existsSync(destination))
      rmSync(transaction, { recursive: true, force: true });
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 0) installHarness();
  else if (args.length === 1 && args[0] === "--bundle") await bundleHarness();
  else throw new Error("Use prepare-lolicode-harness-runtime.mjs [--bundle].");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
