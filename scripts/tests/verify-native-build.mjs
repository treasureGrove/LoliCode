#!/usr/bin/env node
// Native validation only. Does not install/launch the GUI or publish anything.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const sha256 = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const read = (base, file) => json(path.join(base, file));
export const targets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${path.basename(command)} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

export function binaryArchitecture(bytes) {
  assert(bytes.length >= 32, "Native executable header is missing");
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    assert.equal(bytes[4], 2, "Expected 64-bit ELF");
    assert.equal(bytes[5], 1, "Expected little-endian ELF");
    const machine = bytes.readUInt16LE(18);
    assert([62, 183].includes(machine), "Unsupported ELF architecture");
    return { platform: "linux", arch: machine === 62 ? "x64" : "arm64" };
  }
  assert.equal(
    bytes.readUInt32LE(0),
    0xfeedfacf,
    "Expected thin 64-bit Mach-O",
  );
  const cpu = bytes.readUInt32LE(4);
  assert([0x01000007, 0x0100000c].includes(cpu), "Unsupported Mach-O CPU");
  return { platform: "darwin", arch: cpu === 0x01000007 ? "x64" : "arm64" };
}

export function parseMacOSMinimum(output) {
  const records = output
    .split(/\r?\nLoad command \d+\r?\n/)
    .flatMap((block) => {
      const modern = /^\s*cmd LC_BUILD_VERSION\s*$/m.test(block);
      const legacy = /^\s*cmd LC_VERSION_MIN_MACOSX\s*$/m.test(block);
      if (!modern && !legacy) return [];
      if (modern)
        assert.match(
          block,
          /^\s*platform (?:1|MACOS|macos)\s*$/m,
          "Expected macOS build platform",
        );
      const minimum = block.match(
        modern
          ? /^\s*minos ([0-9]+(?:\.[0-9]+){1,2})\s*$/m
          : /^\s*version ([0-9]+(?:\.[0-9]+){1,2})\s*$/m,
      )?.[1];
      const sdk = block.match(/^\s*sdk ([0-9]+(?:\.[0-9]+){1,2})\s*$/m)?.[1];
      assert(minimum && sdk, "Mach-O minimum version or SDK is missing");
      return [
        {
          minimumSystemVersion: minimum,
          sdkVersion: sdk,
          loadCommand: modern ? "LC_BUILD_VERSION" : "LC_VERSION_MIN_MACOSX",
        },
      ];
    });
  assert.equal(
    records.length,
    1,
    "Expected one minimum OS record in a thin Mach-O executable",
  );
  return records[0];
}

function readMacOSMinimum(file) {
  return parseMacOSMinimum(run("xcrun", ["otool", "-l", file]));
}

function exceedsMinimum(actual, declared) {
  const parts = (value) => {
    assert.match(value, /^[0-9]+(?:\.[0-9]+){1,2}$/);
    return [...value.split(".").map(Number), 0].slice(0, 3);
  };
  const left = parts(actual);
  const right = parts(declared);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

export function verifyInputs(base = root) {
  const product = read(base, "product-release.json");
  const pkg = read(base, "package.json");
  const tauri = read(base, "src-tauri/tauri.conf.json");
  const cargo = parseToml(
    readFileSync(path.join(base, "src-tauri/Cargo.toml"), "utf8"),
  );
  const lock = parseToml(
    readFileSync(path.join(base, "src-tauri/Cargo.lock"), "utf8"),
  );
  assert.match(product.productVersion, /^\d+\.\d+\.\d+$/);
  assert.match(product.buildVersion, /^\d+\.\d+\.\d+$/);
  for (const version of [
    pkg.version,
    tauri.version,
    cargo.package.version,
    lock.package.find((item) => item.name === cargo.package.name)?.version,
  ]) {
    assert.equal(
      version,
      product.buildVersion,
      "Product/build version mapping differs",
    );
  }
  const harness = read(base, "packages/lolicode-harness-runtime/package.json");
  const harnessLock = read(
    base,
    "packages/lolicode-harness-runtime/package-lock.json",
  );
  const harnessVersion = harness.dependencies["@deepseek-ai/dsh"];
  assert.equal(
    harnessLock.packages["node_modules/@deepseek-ai/dsh"].version,
    harnessVersion,
  );
  const nodeVersion = readFileSync(
    path.join(base, ".node-version"),
    "utf8",
  ).trim();
  const overlay = read(base, ".github/native-build-check.conf.json");
  assert.equal(overlay.productName, "LoliCode Validation");
  assert.equal(overlay.mainBinaryName, "lolicode-validation");
  assert.equal(overlay.identifier, "art.treasuregrove.lolicode.validation");
  assert.equal(overlay.bundle.createUpdaterArtifacts, false);
  assert.equal(overlay.bundle.macOS.signingIdentity, null);
  assert.deepEqual(overlay.plugins.updater.endpoints, []);
  return {
    productVersion: product.productVersion,
    buildVersion: product.buildVersion,
    harnessVersion,
    nodeVersion,
  };
}

export function verifyRuntime(runtime, expected) {
  const manifest = read(runtime, "runtime-manifest.json");
  assert.equal(manifest.format, 1);
  for (const field of ["platform", "arch", "harnessVersion", "nodeVersion"]) {
    assert.equal(manifest[field], expected[field], `Runtime ${field} mismatch`);
  }
  assert.match(manifest.inputsSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.nodeSha256, sha256(path.join(runtime, "node")));
  assert.equal(
    manifest.entrySha256,
    sha256(path.join(runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js")),
  );
  assert.equal(
    read(runtime, "node_modules/@deepseek-ai/dsh/package.json").version,
    expected.harnessVersion,
  );
  for (const name of [
    "NODE-LICENSE",
    "node_modules/@deepseek-ai/dsh/LICENSE",
  ]) {
    assert(lstatSync(path.join(runtime, name)).isFile());
    assert(
      readFileSync(path.join(runtime, name)).length > 0,
      `Empty license: ${name}`,
    );
  }
  assert.deepEqual(
    binaryArchitecture(readFileSync(path.join(runtime, "node"))),
    {
      platform: expected.platform,
      arch: expected.arch,
    },
  );
  return manifest;
}

function executable(file, expected) {
  assert(lstatSync(file).isFile(), `Missing executable: ${file}`);
  assert(lstatSync(file).mode & 0o111, `Executable bit missing: ${file}`);
  assert.deepEqual(binaryArchitecture(readFileSync(file)), {
    platform: expected.platform,
    arch: expected.arch,
  });
}

function smokeRuntime(runtime, expected) {
  const node = path.join(runtime, "node");
  executable(node, expected);
  // Never use a developer's real home or model account. No model/API calls.
  const home = mkdtempSync(path.join(os.tmpdir(), "lolicode-native-smoke-"));
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
  };
  const actual = JSON.parse(
    run(
      node,
      [
        "-p",
        "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})",
      ],
      { env },
    ),
  );
  assert.deepEqual(actual, {
    version: expected.nodeVersion,
    platform: expected.platform,
    arch: expected.arch,
  });
  const version = run(
    node,
    [
      path.join(runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
      "--version",
    ],
    { env, cwd: home },
  );
  assert(
    version.includes(expected.harnessVersion),
    "Harness CLI version mismatch",
  );
  const marker = "LOLICODE_NATIVE_PTY_OK";
  const ptyScript = `
    const pty = require(process.argv[1]);
    let output = '';
    const child = pty.spawn('/bin/sh', ['-c', 'printf ${marker}'], {
      name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
    });
    const timer = setTimeout(() => { child.kill(); process.exit(1); }, 10000);
    child.onData((data) => { output += data; });
    child.onExit(({exitCode}) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !output.includes('${marker}')) process.exit(1);
      console.log('${marker}');
    });
  `;
  assert.equal(
    run(node, ["-e", ptyScript, path.join(runtime, "node_modules/node-pty")], {
      env,
      cwd: home,
    }),
    marker,
  );
}

export function compareTree(source, destination) {
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    assert(lstatSync(destination).isDirectory());
    assert.deepEqual(
      readdirSync(destination).sort(),
      readdirSync(source).sort(),
      `Resource file list differs: ${destination}`,
    );
    for (const name of readdirSync(source))
      compareTree(path.join(source, name), path.join(destination, name));
  } else {
    assert(stat.isFile(), `Non-regular source resource: ${source}`);
    assert(lstatSync(destination).isFile());
    assert.equal(
      sha256(destination),
      sha256(source),
      `Resource hash differs: ${destination}`,
    );
    if (stat.mode & 0o111)
      assert(
        lstatSync(destination).mode & 0o111,
        `Lost executable bit: ${destination}`,
      );
  }
}

function verifyResources(resources, expected) {
  const mappings = read(root, "src-tauri/tauri.conf.json").bundle.resources;
  assert(
    mappings && !Array.isArray(mappings),
    "Expected explicit resource mapping",
  );
  for (const [source, destination] of Object.entries(mappings)) {
    compareTree(
      path.resolve(root, "src-tauri", source),
      path.join(resources, destination),
    );
  }
  const runtime = path.join(resources, "agent/harness-runtime");
  const manifest = verifyRuntime(runtime, expected);
  smokeRuntime(runtime, expected);
  return manifest;
}

function verifyBundle(expected) {
  const target = path.resolve(process.env.CARGO_TARGET_DIR);
  const bundle = path.join(target, expected.target, "release/bundle");
  const output = path.join(root, "tmp/native-build-check/artifacts");
  // Refuse stale evidence instead of silently replacing an earlier build.
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(output);
  const stem = `LoliCode-${expected.productVersion}-VALIDATION-${expected.platform}-${expected.arch}`;
  let artifact;
  let runtime;
  let macOSCompatibility;
  if (expected.platform === "darwin") {
    const application = path.join(bundle, "macos/LoliCode Validation.app");
    const contents = path.join(application, "Contents");
    const plist = JSON.parse(
      run("plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        path.join(contents, "Info.plist"),
      ]),
    );
    assert.equal(
      plist.CFBundleIdentifier,
      "art.treasuregrove.lolicode.validation",
    );
    assert.equal(plist.CFBundleShortVersionString, expected.buildVersion);
    assert.equal(plist.CFBundleExecutable, "lolicode-validation");
    executable(path.join(contents, "MacOS/lolicode-validation"), expected);
    runtime = verifyResources(path.join(contents, "Resources"), expected);
    const configuredMinimum = read(root, "src-tauri/tauri.conf.json").bundle
      .macOS.minimumSystemVersion;
    const mainExecutable = readMacOSMinimum(
      path.join(contents, "MacOS/lolicode-validation"),
    );
    const bundledNode = readMacOSMinimum(
      path.join(contents, "Resources/agent/harness-runtime/node"),
    );
    const mismatch = [mainExecutable, bundledNode].some((item) =>
      exceedsMinimum(item.minimumSystemVersion, configuredMinimum),
    );
    macOSCompatibility = {
      configuredMinimumSystemVersion: configuredMinimum,
      bundleMinimumSystemVersion: plist.LSMinimumSystemVersion,
      mainExecutable,
      bundledNode,
      status: mismatch
        ? "declared-minimum-mismatch"
        : "oldest-OS-runtime-not-tested",
      nativeAddonMinimumVersionsVerified: false,
      note: "Load commands are evidence of minimum deployment targets, not proof of compatibility. No product configuration is changed.",
    };
    if (mismatch)
      console.warn(
        `::warning title=macOS minimum mismatch::Configured minimum ${configuredMinimum}; app ${mainExecutable.minimumSystemVersion}; bundled Node ${bundledNode.minimumSystemVersion}. Resolve before claiming minimum OS support or releasing.`,
      );
    artifact = path.join(output, `${stem}.app.tar.gz`);
    run("tar", [
      "-czf",
      artifact,
      "-C",
      path.dirname(application),
      path.basename(application),
    ]);
    assert(run("tar", ["-tzf", artifact]).includes("Contents/Info.plist"));
  } else {
    const files = readdirSync(path.join(bundle, "deb")).filter((file) =>
      file.endsWith(".deb"),
    );
    assert.equal(files.length, 1, "Expected exactly one newly built .deb");
    const deb = path.join(bundle, "deb", files[0]);
    assert.equal(run("dpkg-deb", ["-f", deb, "Architecture"]), "amd64");
    assert.equal(
      run("dpkg-deb", ["-f", deb, "Version"]),
      expected.buildVersion,
    );
    const extracted = mkdtempSync(
      path.join(os.tmpdir(), "lolicode-native-deb-"),
    );
    run("dpkg-deb", ["-x", deb, extracted]);
    executable(path.join(extracted, "usr/bin/lolicode-validation"), expected);
    // Tauri's Debian bundler uses productName for resources, not mainBinaryName.
    runtime = verifyResources(
      path.join(extracted, "usr/lib/LoliCode Validation"),
      expected,
    );
    artifact = path.join(output, `${stem}.deb`);
    copyFileSync(deb, artifact);
  }
  assert(lstatSync(artifact).size > 0, "Empty bundle artifact");
  const commit = run("git", ["rev-parse", "HEAD"], { cwd: root });
  assert.equal(
    commit,
    process.env.GITHUB_SHA,
    "Checkout differs from dispatched commit",
  );
  const report = {
    format: 1,
    purpose: "VALIDATION ONLY - NOT A RELEASE / 仅验证用，非正式版",
    ...expected,
    sourceCommit: commit,
    workflowRun: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    runtime,
    ...(macOSCompatibility ? { macOSCompatibility } : {}),
    artifact: {
      name: path.basename(artifact),
      bytes: lstatSync(artifact).size,
      sha256: sha256(artifact),
    },
    verified: [
      "native executable architecture",
      "package version",
      "all mapped resource hashes and licenses",
      "bundled Node identity",
      "Harness CLI version",
      "native PTY spawn",
    ],
    notVerified: [
      "GUI launch and interaction",
      "installation and upgrade",
      "minimum supported OS",
      "Gatekeeper/signing/notarization",
      "AppImage/DMG",
      "production updater",
    ],
    artifactVisibility: "public",
    artifactRetentionDays: 7,
    releasePublished: false,
  };
  writeFileSync(
    path.join(output, "validation-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  writeFileSync(
    path.join(output, "SHA256SUMS"),
    `${report.artifact.sha256}  ${report.artifact.name}\n`,
  );
  writeFileSync(
    path.join(output, "VALIDATION-ONLY.txt"),
    `${report.purpose}\nSource: ${commit}\nPublic validation artifact, retained for 7 days. Only the validation package, checksum, report and this notice are uploaded.\nNo user configuration, credentials, diagnostic logs or source archive is uploaded.\nNo release signing, notarization or production update support.\nDo not redistribute as an official release. Native GUI acceptance is still required.\nFor manual testing use a disposable OS account; the development profile is shared with other development builds.\nSee docs/guides/native-build-check.md.\n`,
  );
  assert.deepEqual(
    readdirSync(output).sort(),
    [
      path.basename(artifact),
      "SHA256SUMS",
      "VALIDATION-ONLY.txt",
      "validation-report.json",
    ].sort(),
    "Only the approved public validation files may be staged",
  );
  console.log(JSON.stringify(report, null, 2));
}

function main() {
  const platform = process.env.EXPECTED_PLATFORM;
  const arch = process.env.EXPECTED_ARCH;
  const target = targets[`${platform}-${arch}`];
  assert(target, "Unsupported or missing native validation target");
  assert.equal(process.platform, platform, "Must execute on the target OS");
  assert.equal(process.arch, arch, "Must execute on the target architecture");
  assert.equal(process.env.EXPECTED_RUST_TARGET, target);
  for (const [name, value] of Object.entries(process.env)) {
    if (
      /^(TAURI_SIGNING_|APPLE_(CERTIFICATE|CERTIFICATE_PASSWORD|SIGNING_IDENTITY|API_KEY|API_KEY_PATH|API_ISSUER|ID|PASSWORD|TEAM_ID|PROVIDER_SHORT_NAME)$)/.test(
        name,
      )
    ) {
      assert(
        !value,
        "Validation must not receive signing or notarization credentials",
      );
    }
  }
  const expected = { ...verifyInputs(), platform, arch, target };
  assert.equal(
    process.versions.node,
    expected.nodeVersion,
    "Use the committed Node toolchain",
  );
  const command = process.argv[2];
  if (command === "inputs") console.log(JSON.stringify(expected, null, 2));
  else if (command === "runtime") {
    const runtime = path.join(
      root,
      "src-tauri/resources/agent/harness-runtime",
    );
    verifyRuntime(runtime, expected);
    smokeRuntime(runtime, expected);
    if (platform === "darwin") {
      const nodeMinimum = readMacOSMinimum(path.join(runtime, "node"));
      const configured = read(root, "src-tauri/tauri.conf.json").bundle.macOS
        .minimumSystemVersion;
      console.log(
        JSON.stringify({
          configuredMacOSMinimum: configured,
          bundledNodeMachO: nodeMinimum,
        }),
      );
      if (exceedsMinimum(nodeMinimum.minimumSystemVersion, configured))
        console.warn(
          `::warning title=macOS runtime minimum mismatch::Configured minimum ${configured}; bundled Node requires ${nodeMinimum.minimumSystemVersion}. macOS runner success does not establish oldest-OS compatibility.`,
        );
    }
    console.log(`Verified native Harness, Node and PTY: ${platform}-${arch}`);
  } else if (command === "bundle") verifyBundle(expected);
  else throw new Error("Use verify-native-build.mjs inputs|runtime|bundle");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
