import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEVELOPMENT_ID,
  DEVELOPMENT_NAME,
  buildEnvironment,
  developmentBuildNumber,
  developmentSourceFingerprint,
  launchDevelopment,
  main,
  targetDirectory,
} from "../dev/lolicode-development.mjs";

function developmentFixture(t) {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "lolicode-launch-test-"),
  );
  t.after(() => {
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    assert.match(path.basename(temporaryRoot), /^lolicode-launch-test-/);
    rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const repository = path.join(temporaryRoot, "source");
  const installDirectory = path.join(temporaryRoot, "installed");
  const binary = path.join(installDirectory, `${DEVELOPMENT_NAME}.exe`);
  const manifestPath = path.join(installDirectory, "development-build.json");
  const lockPath = path.join(
    repository,
    "src-tauri/target/development/launch.lock",
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (relative, content) => {
    const file = path.join(repository, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write(
    ".gitignore",
    "/src-tauri/target/\n/dist-dev/\n/packages/example/.build/\n",
  );
  write("src/index.ts", "export const value = 1;\n");
  write("src-tauri/src/lib.rs", "pub fn initial() {}\n");
  write("package.json", '{"name":"development-test","version":"1.0.0"}\n');
  git("init", "--initial-branch=main");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  const commit = (message, ...options) =>
    git(
      "-c",
      "user.name=Development tests",
      "-c",
      "user.email=development-tests@example.invalid",
      "commit",
      "-m",
      message,
      ...options,
    );
  commit("Initial source");
  const fingerprint = () => developmentSourceFingerprint(repository);
  const install = (overrides = {}) => {
    mkdirSync(installDirectory, { recursive: true });
    writeFileSync(binary, "installed development executable");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        identifier: DEVELOPMENT_ID,
        channel: "development",
        sourceDirectory: repository,
        sourceFingerprint: fingerprint(),
        ...overrides,
      }),
    );
  };
  return {
    repository,
    installDirectory,
    binary,
    manifestPath,
    lockPath,
    git,
    write,
    commit,
    fingerprint,
    install,
  };
}

test("development source identity tracks content changes even while the dirty status stays the same", (t) => {
  const fixture = developmentFixture(t);
  const original = fixture.fingerprint();
  fixture.write("src/index.ts", "export const value = 2;\n");
  const firstEdit = fixture.fingerprint();
  const dirtyStatus = fixture.git("status", "--porcelain");
  fixture.write("src/index.ts", "export const value = 3;\n");
  assert.equal(fixture.git("status", "--porcelain"), dirtyStatus);
  const secondEdit = fixture.fingerprint();
  assert.notEqual(firstEdit, original);
  assert.notEqual(secondEdit, firstEdit);

  fixture.write("src/new-module.ts", "export const added = true;\n");
  assert.notEqual(fixture.fingerprint(), secondEdit);
  unlinkSync(path.join(fixture.repository, "src/new-module.ts"));
  assert.equal(fixture.fingerprint(), secondEdit);
  unlinkSync(path.join(fixture.repository, "src-tauri/src/lib.rs"));
  const deletion = fixture.fingerprint();
  assert.notEqual(deletion, secondEdit);

  fixture.write(
    "src-tauri/target/development/app/output.exe",
    "new native output",
  );
  fixture.write("packages/example/.build/generated.js", "generated runtime");
  fixture.write("dist-dev/assets/output.js", "new frontend output");
  fixture.write("docs/notes.md", "Unrelated documentation changes.\n");
  assert.equal(fixture.fingerprint(), deletion);
});

test("development source identity includes the branch and commit even for identical source bytes", (t) => {
  const fixture = developmentFixture(t);
  const original = fixture.fingerprint();
  fixture.git("switch", "-c", "TG/same-source");
  const otherBranch = fixture.fingerprint();
  assert.notEqual(otherBranch, original);
  fixture.commit("New source identity", "--allow-empty");
  const otherCommit = fixture.fingerprint();
  assert.notEqual(otherCommit, otherBranch);
  fixture.git("switch", "--detach");
  assert.notEqual(fixture.fingerprint(), otherCommit);
});

test("an unchanged installed development app launches without building or interrupting a running app", async (t) => {
  const fixture = developmentFixture(t);
  fixture.install();
  const launch = async (binary) => assert.equal(binary, fixture.binary);
  const options = {
    ...fixture,
    isRunning: () => assert.fail("unchanged app should be reopened directly"),
    build: () => assert.fail("unchanged app should not be rebuilt"),
    launch,
  };
  await launchDevelopment(options);
  assert.equal(existsSync(fixture.lockPath), false);
  await assert.rejects(
    () =>
      launchDevelopment({
        ...options,
        launch: () => {
          throw new Error("launch failed");
        },
      }),
    /launch failed/,
  );
  assert.equal(existsSync(fixture.lockPath), false);
  await launchDevelopment(options);
});

test("a legacy development install is rebuilt and installed before launch while concurrent launches wait", async (t) => {
  const fixture = developmentFixture(t);
  fixture.install({ sourceFingerprint: undefined });
  const events = [];
  let finishBuild;
  const buildReady = new Promise((resolve) => {
    finishBuild = resolve;
  });
  const options = {
    ...fixture,
    isRunning: (binary) => {
      assert.equal(binary, fixture.binary);
      events.push("running");
      return false;
    },
    build: async () => {
      events.push("build");
      await buildReady;
      fixture.install();
      events.push("installed");
    },
    launch: async (binary) => {
      assert.equal(binary, fixture.binary);
      events.push("launch");
    },
  };
  const pending = launchDevelopment(options);
  assert.deepEqual(events, ["running", "build"]);
  assert.equal(readFileSync(fixture.lockPath, "utf8"), String(process.pid));
  await assert.rejects(() => launchDevelopment(options), /正在检查或构建/);
  finishBuild();
  await pending;
  assert.deepEqual(events, ["running", "build", "installed", "launch"]);
  assert.equal(existsSync(fixture.lockPath), false);
  await launchDevelopment(options);
  assert.deepEqual(events, [
    "running",
    "build",
    "installed",
    "launch",
    "launch",
  ]);
});

test("failed or obsolete development builds never start the old installed executable", async (t) => {
  for (const scenario of [
    "build failure",
    "not installed",
    "source edited during build",
  ]) {
    await t.test(scenario, async (t) => {
      const fixture = developmentFixture(t);
      fixture.install();
      const oldManifest = readFileSync(fixture.manifestPath, "utf8");
      fixture.write("src/index.ts", "export const changed = true;\n");
      await assert.rejects(
        () =>
          launchDevelopment({
            ...fixture,
            isRunning: () => false,
            build: async () => {
              if (scenario === "build failure")
                throw new Error("compiler failed");
              if (scenario === "source edited during build") {
                fixture.install();
                fixture.write(
                  "src/index.ts",
                  "export const changedAgain = true;\n",
                );
              }
            },
            launch: () =>
              assert.fail("a failed or outdated build must not launch"),
          }),
        scenario === "build failure"
          ? /compiler failed/
          : /构建期间源码发生变化或新构建未安装/,
      );
      assert.equal(existsSync(fixture.lockPath), false);
      if (scenario !== "source edited during build") {
        assert.equal(readFileSync(fixture.manifestPath, "utf8"), oldManifest);
      }
      // A later successful attempt must be able to acquire the released lock.
      let launched = false;
      await launchDevelopment({
        ...fixture,
        isRunning: () => false,
        build: () => fixture.install(),
        launch: () => {
          launched = true;
        },
      });
      assert.equal(launched, true);
    });
  }
});

test("changed source cannot replace a running development app", async (t) => {
  const fixture = developmentFixture(t);
  fixture.install();
  const oldManifest = readFileSync(fixture.manifestPath, "utf8");
  fixture.write("src/index.ts", "export const changed = true;\n");
  await assert.rejects(
    () =>
      launchDevelopment({
        ...fixture,
        isRunning: () => true,
        build: () => assert.fail("running app must not be replaced"),
        launch: () => assert.fail("outdated app must not be launched"),
      }),
    /请先从托盘退出/,
  );
  assert.equal(readFileSync(fixture.manifestPath, "utf8"), oldManifest);
  assert.equal(existsSync(fixture.lockPath), false);
});

test("development launch preserves foreign installations and safely recovers an abandoned lock", async (t) => {
  const fixture = developmentFixture(t);
  const options = {
    ...fixture,
    isRunning: () =>
      assert.fail("foreign installation must not be inspected or replaced"),
    build: () => assert.fail("foreign installation must be preserved"),
    launch: () => assert.fail("foreign installation must not launch"),
  };
  fixture.install({
    sourceDirectory: path.join(fixture.repository, "other-checkout"),
  });
  await assert.rejects(() => launchDevelopment(options), /属于另一份源码/);
  assert.equal(existsSync(fixture.lockPath), false);
  unlinkSync(fixture.manifestPath);
  await assert.rejects(() => launchDevelopment(options), /安装记录缺失/);
  assert.equal(existsSync(fixture.lockPath), false);

  fixture.install();
  fixture.write("src-tauri/target/development/launch.lock", "invalid owner");
  await assert.rejects(() => launchDevelopment(options), /正在检查或构建/);
  assert.equal(readFileSync(fixture.lockPath, "utf8"), "invalid owner");
  const departedOwner = execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(String(process.pid))"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  fixture.write("src-tauri/target/development/launch.lock", departedOwner);
  let launched = false;
  await launchDevelopment({
    ...options,
    launch: () => {
      launched = true;
    },
  });
  assert.equal(launched, true);
  assert.equal(existsSync(fixture.lockPath), false);
});

test("development builds isolate output and do not consume release signing credentials", () => {
  const env = buildEnvironment("development", {
    PATH: process.env.PATH || process.env.Path,
    LOLICODE_BUILD_CHANNEL: "stable",
    VITE_LOLICODE_BUILD_CHANNEL: "stable",
    CARGO_TARGET_DIR: "unrelated-output",
    TAURI_SIGNING_PRIVATE_KEY: "test-release-key",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test-release-password",
  });
  assert.equal(env.LOLICODE_BUILD_CHANNEL, "development");
  assert.equal(env.VITE_LOLICODE_BUILD_CHANNEL, "development");
  assert.equal(env.CARGO_TARGET_DIR, targetDirectory);
  assert.match(env.LOLICODE_BUILD_NUMBER, /^DEV-\d{8}-\d{6}$/);
  assert.equal(env.VITE_LOLICODE_BUILD_NUMBER, env.LOLICODE_BUILD_NUMBER);
  assert.equal(
    env.LOLICODE_BUILD_BRANCH,
    execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
    }).trim() || "detached HEAD",
  );
  for (const field of ["BRANCH", "REVISION", "TIMESTAMP", "DIRTY"]) {
    assert.equal(
      env[`VITE_LOLICODE_BUILD_${field}`],
      env[`LOLICODE_BUILD_${field}`],
    );
  }
  assert.equal(Number.isNaN(Date.parse(env.LOLICODE_BUILD_TIMESTAMP)), false);
  assert.equal(
    env.LOLICODE_BUILD_DIRTY,
    String(
      Boolean(
        execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
        }).trim(),
      ),
    ),
  );
  assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined);
});

test("stable builds reset an inherited development channel while preserving release credentials", () => {
  const env = buildEnvironment("stable", {
    PATH: process.env.PATH || process.env.Path,
    LOLICODE_BUILD_CHANNEL: "development",
    VITE_LOLICODE_BUILD_CHANNEL: "development",
    CARGO_TARGET_DIR: targetDirectory,
    LOLICODE_BUILD_NUMBER: "DEV-20261028-174243",
    VITE_LOLICODE_BUILD_NUMBER: "DEV-20261028-174243",
    LOLICODE_BUILD_BRANCH: "other-development-branch",
    VITE_LOLICODE_BUILD_BRANCH: "other-development-branch",
    LOLICODE_BUILD_DIRTY: "true",
    VITE_LOLICODE_BUILD_DIRTY: "true",
    LOLICODE_BUILD_TIMESTAMP: "2026-10-28T09:42:43Z",
    VITE_LOLICODE_BUILD_TIMESTAMP: "2026-10-28T09:42:43Z",
    TAURI_SIGNING_PRIVATE_KEY: "test-release-key",
  });
  assert.equal(env.LOLICODE_BUILD_CHANNEL, "stable");
  assert.equal(env.VITE_LOLICODE_BUILD_CHANNEL, "stable");
  assert.equal(env.CARGO_TARGET_DIR, undefined);
  assert.equal(env.LOLICODE_BUILD_NUMBER, undefined);
  assert.equal(env.VITE_LOLICODE_BUILD_NUMBER, undefined);
  for (const field of ["BRANCH", "TIMESTAMP", "DIRTY"]) {
    assert.equal(env[`LOLICODE_BUILD_${field}`], undefined);
    assert.equal(env[`VITE_LOLICODE_BUILD_${field}`], undefined);
  }
  assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, "test-release-key");
});

test("development build number uses Singapore time across a UTC date boundary", () => {
  assert.equal(
    developmentBuildNumber(new Date("2026-10-27T23:42:43Z")),
    "DEV-20261028-074243",
  );
});

test("development entry rejects installer and identity overrides before building", async () => {
  await assert.rejects(
    () => main(["build", "--bundles", "nsis"]),
    /build:release/,
  );
  await assert.rejects(
    () => main(["build", "--config", "src-tauri/tauri.conf.json"]),
    /build:release/,
  );
  await assert.rejects(
    () => main(["renderer", "--outDir", "dist"]),
    /does not accept/,
  );
});
