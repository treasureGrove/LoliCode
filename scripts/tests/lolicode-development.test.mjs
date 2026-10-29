import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  buildEnvironment,
  developmentBuildNumber,
  main,
  targetDirectory,
} from "../dev/lolicode-development.mjs";

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
