// Boundary-only tests. All files/junctions are synthetic and inside one new
// temporary directory. Never compile NSIS, launch an installer or touch a build.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSnapshotBoundary,
  createWorkspaceBoundary,
} from "./lolicode-nsis-payload-boundary.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture({ nestedTarget = false } = {}) {
  const parent = realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(parent, "lolicode-boundary-"));
  const repositoryRoot = path.join(root, "reviewed-repo");
  const build = path.join(root, "build");
  const directory = path.join(build, "release/d");
  const work = path.join(directory, "work");
  const priorWork = path.join(build, "release/c/work");
  const target = path.join(repositoryRoot, "src-tauri/target");
  const shared = path.join(build, "src-tauri/target");
  const alias = path.join(work, "src-tauri/target");
  const external = path.join(root, "outside-input-roots");
  for (const folder of [
    path.join(work, "src-tauri/nsis"),
    path.join(priorWork, "src-tauri/nsis"),
    path.dirname(shared),
    target,
    external,
  ])
    mkdirSync(folder, { recursive: true });
  const output = path.join(target, nestedTarget ? "real-release" : "release");
  mkdirSync(path.join(output, "nsis/x64"), { recursive: true });
  if (nestedTarget)
    symlinkSync(output, path.join(target, "release"), "junction");
  symlinkSync(target, shared, "junction");
  symlinkSync(shared, alias, "junction");
  symlinkSync(shared, path.join(priorWork, "src-tauri/target"), "junction");
  writeFileSync(
    path.join(output, "LoliCode.exe"),
    "synthetic data only; never executed",
  );
  writeFileSync(
    path.join(output, "nsis/x64/installer.nsi"),
    "synthetic reference list only; never compiled",
  );
  for (const source of [work, priorWork]) {
    writeFileSync(path.join(source, "LICENSE"), "synthetic license");
    writeFileSync(
      path.join(source, "src-tauri/nsis/lolicode-installer-hooks.nsh"),
      "synthetic hooks",
    );
  }
  writeFileSync(path.join(external, "private-input"), "must never be accepted");
  const archive = Buffer.from(
    "synthetic archive bytes for boundary tests only",
  );
  writeFileSync(path.join(directory, "source.tar"), archive);
  const receipt = {
    schemaVersion: 1,
    product: "LoliCode",
    productVersion: "1.0.7",
    buildVersion: "4.1.7",
    sourceCommit: "a".repeat(40),
    sourceTree: "b".repeat(40),
    parentCommit: "c".repeat(40),
    work,
    sharedTarget: shared,
    sourceArchiveBytes: archive.length,
    sourceArchiveSha256: digest(archive),
  };
  const snapshotFile = path.join(directory, "source-snapshot.json");
  function options(patch = {}) {
    const bytes = JSON.stringify({ ...receipt, ...patch });
    writeFileSync(snapshotFile, bytes);
    return {
      repositoryRoot,
      snapshotFile,
      expectedSnapshotSha256: digest(bytes),
      expectedVersion: "4.1.7",
    };
  }
  const originalOptions = options();
  return {
    root,
    work,
    priorWork,
    target,
    shared,
    alias,
    external,
    repositoryRoot,
    directory,
    options,
    originalOptions,
    script: path.join(alias, "release/nsis/x64/installer.nsi"),
    executable: path.join(alias, "release/LoliCode.exe"),
    dispose() {
      // No computed recursive deletion outside this exact, physical test root.
      assert.equal(path.dirname(path.resolve(root)), parent);
      assert(path.basename(root).startsWith("lolicode-boundary-"));
      assert.equal(realpathSync(root), root);
      assert(!lstatSync(root).isSymbolicLink());
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function withFixture(action, options) {
  const value = fixture(options);
  try {
    await action(value);
  } finally {
    value.dispose();
  }
}

test("default mode stays inside the reviewed repository and admits no junction escape", async () => {
  await withFixture(async (f) => {
    const boundary = createWorkspaceBoundary(f.repositoryRoot);
    assert.equal(
      boundary.executable(path.join(f.target, "release/LoliCode.exe")),
      path.join(f.target, "release/LoliCode.exe"),
    );
    assert.throws(
      () => boundary.sourceFile(path.join(f.work, "LICENSE")),
      /leaves workspace/,
    );
    const link = path.join(f.repositoryRoot, "alias");
    symlinkSync(f.target, link, "junction");
    assert.throws(
      () =>
        boundary.generatedScript(
          path.join(link, "release/nsis/x64/installer.nsi"),
        ),
      /traverses a link/,
    );
  });
});

test("verified D receipt admits only its exact target alias and frozen source files", async () => {
  await withFixture(async (f) => {
    const boundary = await createSnapshotBoundary(f.originalOptions);
    assert.equal(
      boundary.generatedScript(f.script),
      path.join(f.target, "release/nsis/x64/installer.nsi"),
    );
    assert.equal(
      boundary.executable(f.executable),
      path.join(f.target, "release/LoliCode.exe"),
    );
    assert.equal(
      boundary.sourceFile(path.join(f.work, "src-tauri/../LICENSE")),
      path.join(f.work, "LICENSE"),
    );
    assert.equal(
      boundary.provenance.receiptSha256,
      f.originalOptions.expectedSnapshotSha256,
    );
    assert.throws(
      () =>
        boundary.generatedScript(
          path.join(f.target, "release/nsis/x64/installer.nsi"),
        ),
      /exact snapshot target alias/,
    );
    assert.throws(
      () => boundary.executable(path.join(f.shared, "release/LoliCode.exe")),
      /exact snapshot target alias/,
    );
    assert.throws(() => boundary.sourceFile(f.executable), /not shared target/);
  });
});

test("C references cannot reuse D's shared target or identical source contents", async () => {
  await withFixture(async (f) => {
    const boundary = await createSnapshotBoundary(f.originalOptions);
    assert.throws(
      () =>
        boundary.generatedScript(
          path.join(
            f.priorWork,
            "src-tauri/target/release/nsis/x64/installer.nsi",
          ),
        ),
      /exact snapshot target alias/,
    );
    assert.throws(
      () =>
        boundary.executable(
          path.join(f.priorWork, "src-tauri/target/release/LoliCode.exe"),
        ),
      /exact snapshot target alias/,
    );
    for (const name of [
      "LICENSE",
      "src-tauri/nsis/lolicode-installer-hooks.nsh",
    ]) {
      assert.throws(
        () => boundary.sourceFile(path.join(f.priorWork, name)),
        /leaves workspace/,
      );
    }
    // Production parsing dispatches each class of NSIS input through these same
    // methods; a D installer path does not grant access to C's embedded paths.
    const parser = readFileSync(
      new URL("./lolicode-nsis-built-payload.test.mjs", import.meta.url),
      "utf8",
    );
    for (const call of [
      "boundary.generatedScript(filename)",
      "boundary.sourceFile(bundledHookIncludes[0][1])",
      "boundary.executable(executable)",
      "boundary.sourceFile(resource[2])",
    ])
      assert(parser.includes(call));
  });
});

test("receipt digest, archive bytes and version must match independently pinned inputs", async () => {
  await withFixture(async (f) => {
    await assert.rejects(
      createSnapshotBoundary({
        ...f.originalOptions,
        expectedSnapshotSha256: undefined,
      }),
      /independently verified/,
    );
    await assert.rejects(
      createSnapshotBoundary({
        ...f.originalOptions,
        expectedSnapshotSha256: "0".repeat(64),
      }),
      /receipt bytes changed/,
    );
    await assert.rejects(
      createSnapshotBoundary({
        ...f.originalOptions,
        expectedVersion: "4.1.8",
      }),
      /build version/,
    );
    appendFileSync(path.join(f.directory, "source.tar"), "changed");
    await assert.rejects(
      createSnapshotBoundary(f.originalOptions),
      /archive length changed/,
    );
  });
});

test("an updated receipt cannot authorize an arbitrary work root, shared root or drive", async () => {
  await withFixture(async (f) => {
    await assert.rejects(
      createSnapshotBoundary(f.options({ work: f.external })),
      /exact adjacent work/,
    );
    await assert.rejects(
      createSnapshotBoundary(f.options({ work: path.parse(f.root).root })),
      /drive\/root/,
    );
    await assert.rejects(
      createSnapshotBoundary(f.options({ sharedTarget: f.external })),
      /exact build repository target/,
    );
  });
});

test("nested source links and non-file inputs are rejected even when still within D", async () => {
  await withFixture(async (f) => {
    const boundary = await createSnapshotBoundary(f.originalOptions);
    const internal = path.join(f.work, "real-assets");
    mkdirSync(internal);
    writeFileSync(path.join(internal, "asset"), "synthetic data");
    symlinkSync(internal, path.join(f.work, "linked-assets"), "junction");
    symlinkSync(f.external, path.join(f.work, "external-assets"), "junction");
    assert.throws(
      () => boundary.sourceFile(path.join(f.work, "linked-assets/asset")),
      /traverses a link/,
    );
    assert.throws(
      () =>
        boundary.sourceFile(path.join(f.work, "external-assets/private-input")),
      /traverses a link/,
    );
    assert.throws(() => boundary.sourceFile(internal), /not a regular file/);
    assert.throws(
      () => boundary.sourceFile(path.join(f.external, "private-input")),
      /leaves workspace/,
    );
    assert.throws(
      () => boundary.sourceFile(path.join(f.work, "bad$name")),
      /unsupported NSIS syntax/,
    );
  });
});

test("nested target links are not part of the one declared target junction chain", async () => {
  await withFixture(
    async (f) => {
      const boundary = await createSnapshotBoundary(f.originalOptions);
      assert.throws(
        () => boundary.generatedScript(f.script),
        /traverses a link/,
      );
      assert.throws(
        () => boundary.executable(f.executable),
        /traverses a link/,
      );
    },
    { nestedTarget: true },
  );
});

test("target aliases are rechecked and cannot be redirected through C or another root", async () => {
  await withFixture(async (f) => {
    const boundary = await createSnapshotBoundary(f.originalOptions);
    unlinkSync(f.alias); // Remove only this synthetic junction, not its target.
    symlinkSync(
      path.join(f.priorWork, "src-tauri/target"),
      f.alias,
      "junction",
    );
    assert.throws(
      () => boundary.generatedScript(f.script),
      /Unexpected target junction destination/,
    );
  });
  await withFixture(async (f) => {
    const boundary = await createSnapshotBoundary(f.originalOptions);
    unlinkSync(f.shared);
    symlinkSync(f.external, f.shared, "junction");
    assert.throws(
      () => boundary.executable(f.executable),
      /Unexpected target junction destination/,
    );
  });
});
