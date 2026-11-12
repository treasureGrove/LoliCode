import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  bundleHarness,
  bundledDependencyInputsHash,
  commitBundle,
  dependencyInputsHash,
  dependencyInventory,
  installedHarnessMatches,
  reusableBundlePayload,
} from "../build/prepare-lolicode-harness-runtime.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const source = path.join(repository, "packages/lolicode-harness-runtime");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const nodeName = process.platform === "win32" ? "node.exe" : "node";
const harnessVersion = JSON.parse(
  readFileSync(path.join(source, "package.json")),
).dependencies["@deepseek-ai/dsh"];
const nodeVersion = readFileSync(
  path.join(repository, ".node-version"),
  "utf8",
).trim();
const entry = "node_modules/@deepseek-ai/dsh/lib/bin.js";

function put(root, file, bytes) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), bytes);
}
function fixture(t) {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "lolicode-runtime-cache-test-"),
  );
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("lolicode-runtime-cache-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  const packageRoot = path.join(root, "runtime-source");
  const directory = path.join(root, "resources/runtime");
  for (const name of ["package.json", "package-lock.json"]) {
    mkdirSync(packageRoot, { recursive: true });
    copyFileSync(path.join(source, name), path.join(packageRoot, name));
  }
  put(packageRoot, "host.mjs", "export const fixture = 1;\n");
  const binary = "pinned Node fixture";
  const license = "pinned Node license fixture";
  let installs = 0;
  let downloads = 0;
  let executions = 0;
  const identity = {
    platform: process.platform,
    arch: process.arch,
    nodeName,
    harnessVersion,
    nodeVersion,
    nodeChecksum: sha(binary),
    licenseChecksum: sha(license),
  };
  const options = {
    packageRoot,
    directory,
    repositoryRoot: root,
    identity,
    prepareNodePayload(stage) {
      downloads++;
      put(stage, nodeName, binary);
      put(stage, "NODE-LICENSE", license);
      return sha(binary);
    },
    install(stage) {
      installs++;
      put(stage, entry, "console.log('SDK fixture');\n");
      put(
        stage,
        "node_modules/@deepseek-ai/dsh/package.json",
        JSON.stringify({ version: harnessVersion }),
      );
      put(
        stage,
        "node_modules/fixture/sub/dependency.js",
        "unchanged SDK dependency",
      );
    },
    execute() {
      executions++;
    },
  };
  return {
    root,
    packageRoot,
    directory,
    options,
    counters: () => ({ installs, downloads, executions }),
    manifest: () =>
      JSON.parse(readFileSync(path.join(directory, "runtime-manifest.json"))),
  };
}

test("bridge updates reuse immutable SDK/Node and publish a complete replacement", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  const before = f.manifest();
  const originalSdk = readFileSync(path.join(f.directory, entry));
  await bundleHarness(f.options);
  assert.deepEqual(f.counters(), { installs: 1, downloads: 1, executions: 1 });
  put(f.packageRoot, "host.mjs", "export const fixture = 2;\n");
  await bundleHarness(f.options);
  assert.deepEqual(f.counters(), { installs: 1, downloads: 1, executions: 2 });
  assert.equal(
    readFileSync(path.join(f.directory, "host.mjs"), "utf8"),
    "export const fixture = 2;\n",
  );
  assert.deepEqual(readFileSync(path.join(f.directory, entry)), originalSdk);
  assert.equal(
    f.manifest().dependenciesInputsSha256,
    before.dependenciesInputsSha256,
  );
  assert.notEqual(f.manifest().inputsSha256, before.inputsSha256);
  assert(!lstatSync(path.join(f.directory, "node_modules")).isSymbolicLink());
  assert(!lstatSync(path.join(f.directory, entry)).isSymbolicLink());
  // Host files are never shared inodes, even when the SDK was hardlinked.
  put(f.packageRoot, "host.mjs", "unpublished source changes");
  assert.equal(
    readFileSync(path.join(f.directory, "host.mjs"), "utf8"),
    "export const fixture = 2;\n",
  );
});

test("lock, target and install-policy changes invalidate the dependency key", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  const before = dependencyInputsHash(f.packageRoot);
  put(f.packageRoot, "host.mjs", "different bridge bytes");
  assert.equal(dependencyInputsHash(f.packageRoot), before);
  for (const overrides of [
    { platform: "different" },
    { arch: "different" },
    { targetNodeVersion: "different" },
    { policy: "changed npm install policy" },
  ])
    assert.notEqual(dependencyInputsHash(f.packageRoot, overrides), before);
  writeFileSync(
    path.join(f.packageRoot, "package-lock.json"),
    readFileSync(path.join(f.packageRoot, "package-lock.json"), "utf8") + "\n",
  );
  assert.notEqual(dependencyInputsHash(f.packageRoot), before);
  await bundleHarness(f.options);
  assert.equal(f.counters().installs, 2);
});

test("only the bundled stage is pruned and legacy unpruned cache keys are rejected", async (t) => {
  const f = fixture(t);
  const debugMap = JSON.stringify({
    version: 3,
    sources: ["index.ts"],
    names: [],
    mappings: "",
  });
  const sourceMap = "node_modules/fixture/sub/dependency.js.map";
  put(f.packageRoot, sourceMap, debugMap);
  const install = f.options.install;
  f.options.install = (stage) => {
    install(stage);
    put(stage, sourceMap, debugMap);
    put(
      stage,
      "node_modules/fixture/sub/dependency.d.ts",
      "export declare const value: number;",
    );
  };
  await bundleHarness(f.options);
  assert.equal(
    readFileSync(path.join(f.packageRoot, sourceMap), "utf8"),
    debugMap,
  );
  assert(!existsSync(path.join(f.directory, sourceMap)));
  assert(
    existsSync(
      path.join(f.directory, "node_modules/fixture/sub/dependency.d.ts"),
    ),
  );
  const manifest = f.manifest();
  assert.equal(manifest.distribution.removedFiles, 1);
  assert.equal(manifest.distribution.removedBytes, Buffer.byteLength(debugMap));
  assert.notEqual(
    manifest.dependenciesInputsSha256,
    dependencyInputsHash(f.packageRoot),
  );
  assert(
    !reusableBundlePayload(
      f.directory,
      manifest,
      dependencyInputsHash(f.packageRoot),
      f.options.identity,
    ),
  );
  put(f.packageRoot, "host.mjs", "changed bridge");
  await bundleHarness(f.options);
  assert.equal(f.counters().installs, 1);
  assert.deepEqual(f.manifest().distribution, manifest.distribution);
  assert(!existsSync(path.join(f.directory, sourceMap)));
});

test("a distribution policy change invalidates only bundled dependencies", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  const sourceKey = dependencyInputsHash(f.packageRoot);
  const bundleKey = bundledDependencyInputsHash(f.packageRoot);
  const originalRead = fs.readFileSync;
  try {
    fs.readFileSync = function (file, ...args) {
      const bytes = originalRead.call(this, file, ...args);
      if (
        file instanceof URL &&
        file.pathname.endsWith("/harness-distribution.mjs")
      )
        return Buffer.concat([
          bytes,
          Buffer.from("\n// changed distribution policy\n"),
        ]);
      return bytes;
    };
    syncBuiltinESMExports();
    assert.equal(dependencyInputsHash(f.packageRoot), sourceKey);
    assert.notEqual(bundledDependencyInputsHash(f.packageRoot), bundleKey);
    await bundleHarness(f.options);
    assert.equal(f.counters().installs, 2);
    assert.equal(
      f.manifest().dependenciesInputsSha256,
      bundledDependencyInputsHash(f.packageRoot),
    );
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
});

test("a pruning I/O failure preserves the published bundle and source SDK", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  const originalManifest = readFileSync(
    path.join(f.directory, "runtime-manifest.json"),
  );
  const originalSdk = readFileSync(path.join(f.directory, entry));
  const debugMap = JSON.stringify({
    version: 3,
    sources: [],
    names: [],
    mappings: "",
  });
  const map = "node_modules/fixture/sub/dependency.js.map";
  put(f.packageRoot, map, debugMap);
  // A legitimate lock revision requires a new dependency stage.
  put(
    f.packageRoot,
    "package-lock.json",
    readFileSync(path.join(f.packageRoot, "package-lock.json"), "utf8") + "\n",
  );
  const install = f.options.install;
  const originalUnlink = fs.unlinkSync;
  let published = false;
  let failedFile;
  try {
    fs.unlinkSync = function (file) {
      if (String(file).endsWith("dependency.js.map")) {
        failedFile = String(file);
        throw new Error("fixture map removal failed");
      }
      return originalUnlink.call(this, file);
    };
    syncBuiltinESMExports();
    await assert.rejects(
      bundleHarness({
        ...f.options,
        install(stage) {
          install(stage);
          put(stage, map, debugMap);
        },
        publish() {
          published = true;
        },
      }),
      /map removal failed/,
    );
  } finally {
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
  }
  assert(failedFile?.includes(`${path.sep}.harness-runtime-`));
  assert.equal(published, false);
  assert.deepEqual(
    readFileSync(path.join(f.directory, "runtime-manifest.json")),
    originalManifest,
  );
  assert.deepEqual(readFileSync(path.join(f.directory, entry)), originalSdk);
  assert.equal(readFileSync(path.join(f.packageRoot, map), "utf8"), debugMap);
});

test("SDK corruption, additions and missing files cause a fresh pinned install", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  const sdk = path.join(f.directory, "node_modules/fixture/sub/dependency.js");
  writeFileSync(sdk, "changed dependency bytes");
  utimesSync(sdk, new Date(), new Date(Date.now() + 60_000));
  await bundleHarness(f.options);
  assert.equal(f.counters().installs, 2);
  assert.equal(readFileSync(sdk, "utf8"), "unchanged SDK dependency");
  put(f.directory, "node_modules/unexpected.js", "added payload");
  await bundleHarness(f.options);
  assert.equal(f.counters().installs, 3);
  assert(!existsSync(path.join(f.directory, "node_modules/unexpected.js")));
  rmSync(sdk);
  await bundleHarness(f.options);
  assert.equal(f.counters().installs, 4);
  assert(existsSync(sdk));
});

test("old manifests and changed Node/license bytes cannot seed dependency reuse", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  const key = bundledDependencyInputsHash(f.packageRoot);
  const manifest = f.manifest();
  assert(reusableBundlePayload(f.directory, manifest, key, f.options.identity));
  assert(
    !reusableBundlePayload(
      f.directory,
      { ...manifest, packageFilesSha256: undefined },
      key,
      f.options.identity,
    ),
  );
  assert(
    !reusableBundlePayload(
      f.directory,
      manifest,
      "different-lock",
      f.options.identity,
    ),
  );
  assert(
    !reusableBundlePayload(
      f.directory,
      { ...manifest, arch: "different" },
      key,
      f.options.identity,
    ),
  );
  put(f.directory, nodeName, "wrong Node bytes");
  assert(
    !reusableBundlePayload(f.directory, manifest, key, f.options.identity),
  );
  await bundleHarness(f.options);
  put(f.directory, "NODE-LICENSE", "wrong license bytes");
  assert(
    !reusableBundlePayload(f.directory, f.manifest(), key, f.options.identity),
  );
});

test("an unsuccessful staged refresh leaves the existing complete runtime intact", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  const before = readFileSync(path.join(f.directory, "runtime-manifest.json"));
  put(f.packageRoot, "host.mjs", "new bridge");
  await assert.rejects(
    bundleHarness({
      ...f.options,
      execute() {
        throw new Error("fixture smoke failed");
      },
    }),
    /smoke failed/,
  );
  assert.deepEqual(
    readFileSync(path.join(f.directory, "runtime-manifest.json")),
    before,
  );
  assert.equal(
    readFileSync(path.join(f.directory, "host.mjs"), "utf8"),
    "export const fixture = 1;\n",
  );
});

test("SDK directory transfer rolls back failures before and after each commit rename", async (t) => {
  for (const point of [1, 2, 3])
    for (const after of [false, true]) {
      const f = fixture(t);
      await bundleHarness(f.options);
      const transaction = path.join(f.root, "transaction");
      const stage = path.join(transaction, "stage");
      const previous = path.join(transaction, "previous");
      put(stage, "host.mjs", "not yet published");
      const before = readFileSync(
        path.join(f.directory, "runtime-manifest.json"),
      );
      let calls = 0;
      assert.throws(
        () =>
          commitBundle(stage, f.directory, previous, true, (from, to) => {
            const fail = ++calls === point;
            if (fail && !after) throw new Error("fixture commit failure");
            renameSync(from, to);
            if (fail && after) throw new Error("fixture commit failure");
          }),
        /fixture commit failure/,
      );
      assert.deepEqual(
        readFileSync(path.join(f.directory, "runtime-manifest.json")),
        before,
      );
      assert(existsSync(path.join(f.directory, entry)));
      assert.equal(
        readFileSync(path.join(f.directory, "host.mjs"), "utf8"),
        "export const fixture = 1;\n",
      );
    }
});

test("a failed rollback preserves the only SDK payload in its transaction", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  const stage = path.join(f.root, "transaction/stage");
  const previous = path.join(f.root, "transaction/previous");
  put(stage, "host.mjs", "new bridge");
  let calls = 0;
  assert.throws(
    () =>
      commitBundle(stage, f.directory, previous, true, (from, to) => {
        if (++calls >= 3) throw new Error("fixture publish/rollback failure");
        renameSync(from, to);
      }),
    (error) => error.code === "HARNESS_RUNTIME_ROLLBACK_FAILED",
  );
  assert(
    existsSync(path.join(stage, entry)),
    "the unique SDK stayed in the staged recovery directory",
  );
  assert(
    existsSync(path.join(previous, "runtime-manifest.json")),
    "the original manifest stayed in the backup",
  );
});

test("bundle cleanup never deletes the recovery transaction after rollback failure", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  put(f.packageRoot, "host.mjs", "new bridge");
  let recoveryStage;
  let recoveryPrevious;
  await assert.rejects(
    bundleHarness({
      ...f.options,
      publish(stage, directory, previous, reuse) {
        recoveryStage = stage;
        recoveryPrevious = previous;
        let calls = 0;
        commitBundle(stage, directory, previous, reuse, (from, to) => {
          if (++calls >= 3) throw new Error("fixture publish/rollback failure");
          renameSync(from, to);
        });
      },
    }),
    (error) => error.code === "HARNESS_RUNTIME_ROLLBACK_FAILED",
  );
  assert(existsSync(path.join(recoveryStage, entry)));
  assert(existsSync(path.join(recoveryPrevious, "runtime-manifest.json")));
});

test("rollback verifies SDK restoration when existsSync suppresses an access failure", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  put(f.packageRoot, "host.mjs", "new bridge");
  let recoveryStage;
  let recoveryPrevious;
  let hideSdk = false;
  const originalExists = fs.existsSync;
  const mock = t.mock.method(fs, "existsSync", (file) =>
    hideSdk && String(file) === path.join(recoveryStage, "node_modules")
      ? false
      : originalExists(file),
  );
  syncBuiltinESMExports();
  let failure;
  try {
    await bundleHarness({
      ...f.options,
      publish(stage, directory, previous, reuse) {
        recoveryStage = stage;
        recoveryPrevious = previous;
        let calls = 0;
        commitBundle(stage, directory, previous, reuse, (from, to) => {
          if (++calls === 3) {
            hideSdk = true;
            throw new Error("fixture publication failed");
          }
          renameSync(from, to);
        });
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert(
    existsSync(path.join(recoveryStage, entry)),
    "the only SDK must survive in the recovery transaction",
  );
  assert(
    existsSync(path.join(f.directory, "runtime-manifest.json")) ||
      existsSync(path.join(recoveryPrevious, "runtime-manifest.json")),
  );
  assert.equal(failure?.code, "HARNESS_RUNTIME_ROLLBACK_FAILED");
});

test("workspace preparation receipts validate installed payload and exclude their own cache file", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  const modules = path.join(f.directory, "node_modules");
  const key = dependencyInputsHash(f.packageRoot);
  const receipt = {
    format: 1,
    harnessVersion,
    inputsSha256: key,
    entrySha256: sha(readFileSync(path.join(f.directory, entry))),
    packageFilesSha256: dependencyInventory(modules),
  };
  put(modules, ".lolicode-install.json", JSON.stringify(receipt));
  assert(installedHarnessMatches(f.directory, key));
  assert(!installedHarnessMatches(f.directory, "different input"));
  put(f.directory, entry, "corrupted entry");
  assert(!installedHarnessMatches(f.directory, key));
});

test("SDK inventory rejects symlinks instead of trusting files outside the payload", async (t) => {
  const f = fixture(t);
  await bundleHarness(f.options);
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  try {
    symlinkSync(
      outside,
      path.join(f.directory, "node_modules/escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error.code === "EPERM")
      return t.skip("symlink creation requires permission");
    throw error;
  }
  assert.throws(
    () => dependencyInventory(path.join(f.directory, "node_modules")),
    /non-regular/,
  );
});
