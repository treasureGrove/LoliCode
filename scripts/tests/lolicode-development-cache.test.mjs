import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDevelopmentIncrementally,
  developmentNativeFingerprint,
  readDevelopmentCache,
} from "../dev/lolicode-development-cache.mjs";
import { developmentSourceFingerprint } from "../dev/lolicode-development.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const temporary = mkdtempSync(
    path.join(os.tmpdir(), "lolicode-build-cache-test-"),
  );
  t.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(
      path.basename(temporary).startsWith("lolicode-build-cache-test-"),
    );
    rmSync(temporary, { recursive: true, force: true });
  });
  const repository = path.join(temporary, "source");
  const packageDirectory = path.join(
    repository,
    "src-tauri/target/development/app",
  );
  const installDirectory = path.join(temporary, "install");
  const pointer = path.join(
    repository,
    "src-tauri/target/development/current-renderer.json",
  );
  const write = (relative, text) => {
    const file = path.join(repository, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write(".gitignore", "/src-tauri/target/\n");
  write("src/main.tsx", "frontend one\n");
  write("src-tauri/src/lib.rs", "native one\n");
  write("packages/runtime/host.mjs", "runtime one\n");
  write("package.json", '{"version":"1.0.0"}\n');
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repository,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git(
    "-c",
    "user.name=Build tests",
    "-c",
    "user.email=build-tests@example.invalid",
    "commit",
    "-m",
    "Initial build fixture",
  );
  const events = [];
  const environment = { CARGO_PROFILE_RELEASE_INCREMENTAL: "true" };
  const nativeContract = async () => ({
    version: "1.0.0",
    contract: sha(readFileSync(path.join(repository, "src-tauri/src/lib.rs"))),
  });
  const options = {
    repository,
    packageDirectory,
    installDirectory,
    environment,
    fingerprintSource: developmentSourceFingerprint,
    nativeContract,
    log: () => {},
    buildNative: async () => {
      events.push("native");
    },
    stageNative: async (env) => {
      events.push("stage");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(
        path.join(packageDirectory, "LoliCode Dev.exe"),
        `native executable ${events.filter((event) => event === "native").length}`,
      );
      writeFileSync(path.join(packageDirectory, "LICENSE"), "license fixture");
      return {
        identifier: "art.treasuregrove.lolicode.dev",
        channel: "development",
        sourceDirectory: repository,
        sourceFingerprint: env.LOLICODE_DEV_SOURCE_FINGERPRINT,
        files: ["LoliCode Dev.exe", "LICENSE"],
        nativeBuildInfo: {
          channel: "development",
          builtAt: "2026-11-09T08:00:00Z",
          sourceRevision: "actual-native-revision",
        },
      };
    },
    buildRenderer: async () => {
      events.push("renderer");
      const outputDirectory = path.join(
        repository,
        "src-tauri/target/development/renderers",
        String(events.length),
      );
      mkdirSync(outputDirectory, { recursive: true });
      writeFileSync(
        path.join(outputDirectory, "index.html"),
        '<script src="assets.js"></script>',
      );
      writeFileSync(
        path.join(outputDirectory, "assets.js"),
        readFileSync(path.join(repository, "src/main.tsx")),
      );
      const native = await nativeContract();
      return {
        channel: "development",
        nativeContract: native.contract,
        nativeVersion: native.version,
        outputDirectory,
        builtAt: "2026-11-09T09:00:00Z",
        revision: "actual-renderer-revision",
      };
    },
    rendererFiles: (directory) =>
      Object.fromEntries(
        ["index.html", "assets.js"].map((file) => [
          file,
          sha(readFileSync(path.join(directory, file))),
        ]),
      ),
    register: async () => {
      events.push("register");
      cpSync(packageDirectory, installDirectory, {
        recursive: true,
        preserveTimestamps: true,
      });
    },
  };
  return {
    ...options,
    options,
    events,
    write,
    git,
    pointer,
    read: (directory = packageDirectory) =>
      JSON.parse(
        readFileSync(path.join(directory, "development-build.json"), "utf8"),
      ),
  };
}

test("unchanged builds reuse verified native output; frontend changes build only a renderer with separate provenance", async (t) => {
  const f = fixture(t);
  assert.equal((await buildDevelopmentIncrementally(f.options)).mode, "native");
  const native = f.read().nativeBuild;
  const binary = path.join(f.packageDirectory, "LoliCode Dev.exe");
  const before = statSync(binary).mtimeMs;
  assert.equal((await buildDevelopmentIncrementally(f.options)).mode, "reuse");
  assert.deepEqual(f.events, ["native", "stage", "register"]);
  f.write("src/main.tsx", "frontend two\n");
  const result = await buildDevelopmentIncrementally(f.options);
  assert.equal(result.mode, "renderer");
  assert.deepEqual(f.events, ["native", "stage", "register", "renderer"]);
  assert.equal(statSync(binary).mtimeMs, before);
  assert.deepEqual(f.read().nativeBuild, native);
  assert.equal(f.read().renderer.revision, "actual-renderer-revision");
  assert.equal(
    f.read(f.installDirectory).sourceFingerprint,
    developmentSourceFingerprint(f.repository),
  );
  assert.deepEqual(
    JSON.parse(readFileSync(f.pointer, "utf8")),
    result.manifest.renderer,
  );
  assert.equal((await buildDevelopmentIncrementally(f.options)).mode, "reuse");
});

test(
  "Windows cache ownership uses filesystem path casing while preserving foreign-source rejection",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fixture(t);
    await buildDevelopmentIncrementally(f.options);
    assert.ok(
      readDevelopmentCache(f.packageDirectory, f.repository.toUpperCase()),
    );
    assert.equal(
      developmentNativeFingerprint(f.repository, f.environment),
      developmentNativeFingerprint(f.repository.toUpperCase(), f.environment),
    );
    assert.throws(
      () =>
        readDevelopmentCache(
          f.packageDirectory,
          path.join(f.repository, "foreign"),
        ),
      /属于另一份源码/,
    );
  },
);

test("a full native build can reuse its embedded frontend when startup would ignore an older pointer", async (t) => {
  const f = fixture(t);
  mkdirSync(path.dirname(f.pointer), { recursive: true });
  const oldPointer = JSON.stringify({
    channel: "development",
    builtAt: "2026-11-09T07:00:00Z",
    nativeContract: "older-contract",
  });
  writeFileSync(f.pointer, oldPointer);
  assert.equal((await buildDevelopmentIncrementally(f.options)).mode, "native");
  assert.equal((await buildDevelopmentIncrementally(f.options)).mode, "reuse");
  assert.equal(readFileSync(f.pointer, "utf8"), oldPointer);
  writeFileSync(
    f.pointer,
    JSON.stringify({
      channel: "development",
      builtAt: "2026-11-09T09:00:00Z",
      nativeContract: "unknown-contract",
    }),
  );
  assert.equal(
    (await buildDevelopmentIncrementally(f.options)).mode,
    "renderer",
  );
});

test("native, runtime, build flags and force invalidate native output; Git-only identity changes do not", async (t) => {
  const f = fixture(t);
  await buildDevelopmentIncrementally(f.options);
  const original = developmentNativeFingerprint(f.repository, f.environment);
  f.git("switch", "-c", "other-branch");
  assert.equal(
    developmentNativeFingerprint(f.repository, f.environment),
    original,
  );
  assert.equal(
    (await buildDevelopmentIncrementally(f.options)).mode,
    "renderer",
  );
  f.write("packages/runtime/host.mjs", "runtime two\n");
  assert.equal((await buildDevelopmentIncrementally(f.options)).mode, "native");
  f.write("src-tauri/src/lib.rs", "native two\n");
  assert.equal((await buildDevelopmentIncrementally(f.options)).mode, "native");
  f.environment.RUSTFLAGS = "-C target-cpu=generic";
  assert.equal((await buildDevelopmentIncrementally(f.options)).mode, "native");
  assert.equal(
    (await buildDevelopmentIncrementally({ ...f.options, force: true })).mode,
    "native",
  );
});

test("critical native corruption is detected even with unchanged size and timestamp; broken renderer assets rebuild only the renderer", async (t) => {
  const f = fixture(t);
  await buildDevelopmentIncrementally(f.options);
  const binary = path.join(f.packageDirectory, "LoliCode Dev.exe");
  const before = statSync(binary);
  writeFileSync(binary, Buffer.alloc(before.size, "x"));
  utimesSync(binary, before.atime, before.mtime);
  assert.equal((await buildDevelopmentIncrementally(f.options)).mode, "native");
  f.write("src/main.tsx", "new UI\n");
  await buildDevelopmentIncrementally(f.options);
  writeFileSync(
    path.join(f.read().renderer.outputDirectory, "assets.js"),
    "corrupt frontend",
  );
  assert.equal(
    (await buildDevelopmentIncrementally(f.options)).mode,
    "renderer",
  );
});

test("edits during a renderer build never publish a stale pointer or update installed provenance", async (t) => {
  const f = fixture(t);
  await buildDevelopmentIncrementally(f.options);
  const previous = readFileSync(
    path.join(f.installDirectory, "development-build.json"),
    "utf8",
  );
  f.write("src/main.tsx", "new frontend\n");
  await assert.rejects(
    buildDevelopmentIncrementally({
      ...f.options,
      buildRenderer: async (...args) => {
        const result = await f.options.buildRenderer(...args);
        f.write("src/main.tsx", "edited while building\n");
        return result;
      },
    }),
    /源码在构建期间发生变化/,
  );
  assert.equal(existsSync(f.pointer), false);
  assert.equal(
    readFileSync(
      path.join(f.installDirectory, "development-build.json"),
      "utf8",
    ),
    previous,
  );
});

test("changed source cannot update a running or foreign installation, and no-register never touches the installed receipt", async (t) => {
  const f = fixture(t);
  await buildDevelopmentIncrementally(f.options);
  const previous = readFileSync(
    path.join(f.installDirectory, "development-build.json"),
    "utf8",
  );
  f.write("src/main.tsx", "new frontend\n");
  await assert.rejects(
    buildDevelopmentIncrementally({ ...f.options, isRunning: () => true }),
    /请先从托盘退出/,
  );
  assert.deepEqual(f.events, ["native", "stage", "register"]);
  await buildDevelopmentIncrementally({ ...f.options, noRegister: true });
  assert.equal(
    readFileSync(
      path.join(f.installDirectory, "development-build.json"),
      "utf8",
    ),
    previous,
  );
  writeFileSync(
    path.join(f.installDirectory, "development-build.json"),
    JSON.stringify({
      ...f.read(f.installDirectory),
      sourceDirectory: path.join(f.repository, "foreign"),
    }),
  );
  await assert.rejects(
    buildDevelopmentIncrementally(f.options),
    /属于另一份源码/,
  );
});
