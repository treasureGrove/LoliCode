import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEnvironment,
  developmentBuildNumber,
  main,
  targetDirectory,
} from "../lolicode-development.mjs";

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
    TAURI_SIGNING_PRIVATE_KEY: "test-release-key",
  });
  assert.equal(env.LOLICODE_BUILD_CHANNEL, "stable");
  assert.equal(env.VITE_LOLICODE_BUILD_CHANNEL, "stable");
  assert.equal(env.CARGO_TARGET_DIR, undefined);
  assert.equal(env.LOLICODE_BUILD_NUMBER, undefined);
  assert.equal(env.VITE_LOLICODE_BUILD_NUMBER, undefined);
  assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, "test-release-key");
});

test("development build number uses Singapore time across a UTC date boundary", () => {
  assert.equal(
    developmentBuildNumber(new Date("2026-10-27T23:42:43Z")),
    "DEV-20261028-074243",
  );
});

test("development entry rejects installer and identity overrides before building", () => {
  assert.throws(() => main(["build", "--bundles", "nsis"]), /build:release/);
  assert.throws(
    () => main(["build", "--config", "src-tauri/tauri.conf.json"]),
    /build:release/,
  );
});
