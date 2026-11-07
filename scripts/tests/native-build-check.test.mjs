import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parsers } from "prettier/plugins/yaml";
import {
  binaryArchitecture,
  parseMacOSMinimum,
  compareTree,
  targets,
  verifyInputs,
  verifyRuntime,
} from "./verify-native-build.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function temporary(t) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "native-build-check-test-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function put(directory, name, content) {
  const file = path.join(directory, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof content === "object" && !Buffer.isBuffer(content)
      ? JSON.stringify(content)
      : content,
  );
}
function header(platform, arch) {
  const bytes = Buffer.alloc(32);
  if (platform === "linux") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(arch === "x64" ? 62 : 183, 18);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arch === "x64" ? 0x01000007 : 0x0100000c, 4);
  }
  return bytes;
}
function runtimeFixture(t, platform = "linux", arch = "x64") {
  const directory = temporary(t);
  const expected = {
    platform,
    arch,
    harnessVersion: "0.2.2-rc.1",
    nodeVersion: "24.19.0",
  };
  const node = header(platform, arch);
  put(directory, "node", node);
  put(directory, "NODE-LICENSE", "Node license fixture");
  put(directory, "node_modules/@deepseek-ai/dsh/lib/bin.js", "fixture");
  put(
    directory,
    "node_modules/@deepseek-ai/dsh/LICENSE",
    "Harness license fixture",
  );
  put(directory, "node_modules/@deepseek-ai/dsh/package.json", {
    version: expected.harnessVersion,
  });
  const manifest = {
    format: 1,
    ...expected,
    inputsSha256: "a".repeat(64),
    nodeSha256: sha(node),
    entrySha256: sha("fixture"),
  };
  put(directory, "runtime-manifest.json", manifest);
  return { directory, expected, manifest };
}

// Use the existing Prettier YAML parser, rather than adding a CI-only dependency.
// Scalar values stay strings; reject tags/anchors and duplicate mapping keys.
function decode(node) {
  assert(
    !node.anchor && !node.tag,
    "Workflow aliases/tags need explicit review",
  );
  if (node.type === "mapping") {
    const entries = node.children.map((item) => item.children.map(decode));
    assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
    return Object.fromEntries(entries);
  }
  if (node.type === "sequence" || node.type === "flowSequence")
    return node.children.map(decode);
  if ("value" in node) return node.value;
  if (node.type === "document")
    return decode(node.children.find((child) => child.type === "documentBody"));
  assert(
    (node.children?.length ?? 0) <= 1,
    `Unsupported YAML node: ${node.type}`,
  );
  return node.children?.length ? decode(node.children[0]) : null;
}

// YAML parsing cannot detect GitHub Actions expression-context scope errors.
// These contexts exist in steps but are not available in jobs.<job_id>.env.
function assertJobEnvironmentContexts(workflow) {
  for (const job of Object.values(workflow.jobs)) {
    for (const value of Object.values(job.env || {})) {
      for (const [, expression] of String(value).matchAll(
        /\$\{\{([\s\S]*?)\}\}/g,
      )) {
        assert.doesNotMatch(
          expression,
          /\b(?:runner|steps|env|job)\s*[.\[]/,
          "Step-only context is unavailable in job.env",
        );
      }
    }
  }
}

test("committed product, Cargo, Tauri, Node and Harness pins agree", () => {
  const expected = verifyInputs(root);
  assert(
    expected.productVersion &&
      expected.buildVersion &&
      expected.nodeVersion &&
      expected.harnessVersion,
  );
});

test("version verifier rejects a mismatched native version", (t) => {
  const directory = temporary(t);
  for (const name of [
    "product-release.json",
    "package.json",
    ".node-version",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "packages/lolicode-harness-runtime/package.json",
    "packages/lolicode-harness-runtime/package-lock.json",
    ".github/native-build-check.conf.json",
  ]) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    copyFileSync(path.join(root, name), path.join(directory, name));
  }
  const pkg = JSON.parse(
    readFileSync(path.join(directory, "package.json"), "utf8"),
  );
  put(directory, "package.json", { ...pkg, version: "0.0.0" });
  assert.throws(() => verifyInputs(directory), /version mapping differs/);
});

test("native headers distinguish macOS Intel, Apple Silicon and Linux x64", () => {
  for (const key of Object.keys(targets)) {
    const [platform, arch] = key.split("-");
    assert.deepEqual(binaryArchitecture(header(platform, arch)), {
      platform,
      arch,
    });
  }
  assert.throws(() => binaryArchitecture(Buffer.from("MZ")), /header/);
  assert.throws(() => binaryArchitecture(Buffer.alloc(32)), /Mach-O/);
  const universal = Buffer.alloc(32);
  universal.writeUInt32BE(0xcafebabe);
  assert.throws(() => binaryArchitecture(universal), /thin/);
});

test("runtime verifies all supported platform and architecture manifests", (t) => {
  for (const key of Object.keys(targets)) {
    const { directory, expected } = runtimeFixture(t, ...key.split("-"));
    verifyRuntime(directory, expected);
    assert.throws(
      () => verifyRuntime(directory, { ...expected, arch: "wrong" }),
      /arch mismatch/,
    );
    assert.throws(
      () => verifyRuntime(directory, { ...expected, platform: "win32" }),
      /platform mismatch/,
    );
    assert.throws(
      () => verifyRuntime(directory, { ...expected, nodeVersion: "0.0.0" }),
      /nodeVersion mismatch/,
    );
    assert.throws(
      () => verifyRuntime(directory, { ...expected, harnessVersion: "0.0.0" }),
      /harnessVersion mismatch/,
    );
  }
});

test("Mach-O deployment metadata records modern and legacy minimum OS without guessing", () => {
  assert.deepEqual(
    parseMacOSMinimum(
      "node:\nLoad command 1\n      cmd LC_BUILD_VERSION\n cmdsize 32\n platform 1\n    minos 13.5\n      sdk 15.0\n   ntools 1\nLoad command 2\n      cmd LC_MAIN\n",
    ),
    {
      minimumSystemVersion: "13.5",
      sdkVersion: "15.0",
      loadCommand: "LC_BUILD_VERSION",
    },
  );
  assert.deepEqual(
    parseMacOSMinimum(
      "app:\nLoad command 1\n      cmd LC_VERSION_MIN_MACOSX\n cmdsize 16\n  version 12.0\n      sdk 14.5\n",
    ),
    {
      minimumSystemVersion: "12.0",
      sdkVersion: "14.5",
      loadCommand: "LC_VERSION_MIN_MACOSX",
    },
  );
  assert.throws(
    () => parseMacOSMinimum("no load command"),
    /one minimum OS record/,
  );
  assert.throws(
    () =>
      parseMacOSMinimum(
        "\nLoad command 1\n cmd LC_BUILD_VERSION\n platform 2\n minos 13.5\n sdk 15.0\n",
      ),
    /macOS build platform/,
  );
});

test("runtime rejects altered Node and Harness bytes", (t) => {
  const first = runtimeFixture(t);
  put(first.directory, "node", "altered");
  assert.throws(() => verifyRuntime(first.directory, first.expected));
  const second = runtimeFixture(t);
  put(second.directory, "node_modules/@deepseek-ai/dsh/lib/bin.js", "altered");
  assert.throws(() => verifyRuntime(second.directory, second.expected));
});

test("runtime rejects missing licenses and false native architecture", (t) => {
  const first = runtimeFixture(t);
  rmSync(path.join(first.directory, "NODE-LICENSE"));
  assert.throws(() => verifyRuntime(first.directory, first.expected), /ENOENT/);
  const second = runtimeFixture(t);
  const wrong = header("darwin", "arm64");
  put(second.directory, "node", wrong);
  put(second.directory, "runtime-manifest.json", {
    ...second.manifest,
    nodeSha256: sha(wrong),
  });
  assert.throws(() => verifyRuntime(second.directory, second.expected));
});

test("resource comparison detects changed, missing and extra bundled files", (t) => {
  const directory = temporary(t);
  const source = path.join(directory, "source");
  const output = path.join(directory, "output");
  put(source, "licenses/LICENSE", "license bytes");
  cpSync(source, output, { recursive: true });
  compareTree(source, output);
  put(output, "licenses/LICENSE", "changed");
  assert.throws(() => compareTree(source, output), /hash differs/);
  put(output, "licenses/LICENSE", "license bytes");
  put(output, "extra", "unintended");
  assert.throws(() => compareTree(source, output), /file list differs/);
  rmSync(path.join(output, "extra"));
  rmSync(path.join(output, "licenses/LICENSE"));
  assert.throws(() => compareTree(source, output), /file list differs/);
});

test("workflow triggers only on the authorized branch or manually, without publication", () => {
  const source = readFileSync(
    path.join(root, ".github/workflows/native-build-check.yml"),
    "utf8",
  );
  const workflow = decode(parsers.yaml.parse(source));
  assertJobEnvironmentContexts(workflow);
  const invalid = structuredClone(workflow);
  invalid.jobs["windows-tests"].env.CC_SWITCH_TEST_HOME =
    "${{ runner.temp }}/lolicode-native-check-home";
  assert.throws(
    () => assertJobEnvironmentContexts(invalid),
    /Step-only context is unavailable in job.env/,
  );
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    "push",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.push, {
    branches: ["fix/mail-ui-main-20261107"],
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [
    "native",
    "windows-tests",
  ]);
  const job = workflow.jobs.native;
  assert.equal(job.if, "github.repository == 'treasureGrove/LoliCode'");
  assert.equal(job.environment, undefined);
  assert.equal(job.permissions, undefined);
  assert.deepEqual(job.strategy.matrix.include, [
    {
      runner: "macos-15",
      platform: "darwin",
      arch: "arm64",
      target: targets["darwin-arm64"],
      bundle: "app",
    },
    {
      runner: "macos-15-intel",
      platform: "darwin",
      arch: "x64",
      target: targets["darwin-x64"],
      bundle: "app",
    },
    {
      runner: "ubuntu-22.04",
      platform: "linux",
      arch: "x64",
      target: targets["linux-x64"],
      bundle: "deb",
    },
  ]);
  assert.equal(
    job.steps.find((step) => step.uses === "actions/checkout@v6").with[
      "persist-credentials"
    ],
    "false",
  );
  assert.equal(
    job.steps.find((step) => step.uses === "actions/upload-artifact@v7").with[
      "retention-days"
    ],
    "7",
  );
  const upload = job.steps.find(
    (step) => step.uses === "actions/upload-artifact@v7",
  );
  assert.match(upload.name, /public validation artifact/);
  assert.equal(upload.with["include-hidden-files"], "false");
  assert.deepEqual(upload.with.path.trim().split("\n"), [
    "tmp/native-build-check/artifacts/*.app.tar.gz",
    "tmp/native-build-check/artifacts/*.deb",
    "tmp/native-build-check/artifacts/validation-report.json",
    "tmp/native-build-check/artifacts/SHA256SUMS",
    "tmp/native-build-check/artifacts/VALIDATION-ONLY.txt",
  ]);
  assert.doesNotMatch(
    source,
    /secrets\.|contents:\s*write|gh\s+release|git\s+(push|tag)|workflow_call|pull_request_target|tauri-action/,
  );
  const build = job.steps.find(
    (step) =>
      step.name === "Build validation bundle without release credentials",
  );
  assert.match(build.run, /--no-sign/);
  assert.match(build.run, /-- --locked/);
  assert.equal(build.env.LOLICODE_BUILD_CHANNEL, "development");
  assert.equal(build.env.VITE_LOLICODE_BUILD_CHANNEL, "development");
  assert.match(source, /cargo nextest run --locked/);
  assert.match(source, /verify-native-build\.mjs bundle/);
  const windows = workflow.jobs["windows-tests"];
  assert.equal(windows.if, "github.repository == 'treasureGrove/LoliCode'");
  assert.equal(windows["runs-on"], "windows-2022");
  assert.equal(
    windows.needs,
    undefined,
    "Windows tests must run independently",
  );
  assert.deepEqual(windows.permissions, { contents: "read" });
  assert.equal(windows.environment, undefined);
  assert.equal(windows.env.CC_SWITCH_TEST_HOME, undefined);
  assert.equal(
    windows.steps.find((step) => step.uses === "actions/checkout@v6").with[
      "persist-credentials"
    ],
    "false",
  );
  assert.equal(
    windows.steps.find((step) => step.uses === "actions/setup-node@v6").with[
      "node-version-file"
    ],
    ".node-version",
  );
  const suite = windows.steps.find(
    (step) => step.name === "Run full native Windows Rust suite",
  );
  assert.equal(
    suite.run,
    "cargo nextest run --locked --manifest-path src-tauri/Cargo.toml --profile ci",
  );
  assert(!windows.steps.some((step) => step["continue-on-error"]));
  assert(
    !windows.steps.some((step) =>
      /upload-artifact|tauri-action/.test(step.uses || ""),
    ),
  );
  const commands = windows.steps.map((step) => step.run || "").join("\n");
  assert.match(commands, /RUNNER_ENVIRONMENT -ne 'github-hosted'/);
  assert.match(
    commands,
    /\$env:CC_SWITCH_TEST_HOME = Join-Path \$env:RUNNER_TEMP 'lolicode-native-check-home'/,
  );
  assert.match(
    commands,
    /"CC_SWITCH_TEST_HOME=\$env:CC_SWITCH_TEST_HOME" >> \$env:GITHUB_ENV/,
  );
  assert.match(commands, /prepare-lolicode-harness-runtime\.mjs --bundle/);
  assert.match(commands, /npm ci --prefix packages\/companion-relay/);
  assert.match(commands, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(
    commands,
    /tauri build|build:release|gh release|verify-native-build\.mjs bundle/,
  );
});
