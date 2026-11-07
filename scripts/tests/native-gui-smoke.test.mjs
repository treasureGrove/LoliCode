import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateHost,
  validateReport,
  phases,
  bounded,
} from "./native-gui-smoke.mjs";
const env = {
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_REPOSITORY: "treasureGrove/LoliCode",
  GITHUB_REF: "refs/heads/test/native-gui-smoke-20261107",
  GITHUB_SHA: "a".repeat(40),
  RUNNER_TEMP: "/tmp/runner",
  EXPECTED_PLATFORM: "darwin",
  EXPECTED_ARCH: "arm64",
};
test("only exact hosted native host and test branch can launch", () => {
  validateHost(env, "darwin", "arm64");
  for (const [key, value] of Object.entries({
    RUNNER_ENVIRONMENT: "self-hosted",
    GITHUB_REPOSITORY: "fork/LoliCode",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "bad",
    RUNNER_TEMP: "",
  }))
    assert.throws(() =>
      validateHost({ ...env, [key]: value }, "darwin", "arm64"),
    );
  assert.throws(() => validateHost(env, "win32", "arm64"));
  assert.throws(() => validateHost(env, "darwin", "x64"));
  const linux = { ...env, EXPECTED_PLATFORM: "linux", EXPECTED_ARCH: "x64" };
  assert.throws(() => validateHost(linux, "linux", "x64"));
  validateHost(
    {
      ...linux,
      DISPLAY: ":99",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus",
    },
    "linux",
    "x64",
  );
});
test("nonce, revision, every phase and passed result are required", () => {
  const fixture = { nonce: "random", revision: "a".repeat(40) };
  const good = { ...fixture, result: "passed", phases: [...phases] };
  validateReport(good, fixture);
  for (const patch of [
    { nonce: "stale" },
    { revision: "b".repeat(40) },
    { result: "failed" },
    { phases: phases.slice(0, -1) },
    { phases: [...phases].reverse() },
  ])
    assert.throws(() => validateReport({ ...good, ...patch }, fixture));
  assert.throws(() => validateReport(undefined, fixture));
});
test("bounded waits reject hangs and preserve errors", async () => {
  assert.equal(await bounded(Promise.resolve(4), 100, "timeout"), 4);
  await assert.rejects(bounded(new Promise(() => {}), 5, "timeout"), /timeout/);
  await assert.rejects(
    bounded(Promise.reject(new Error("original")), 100, "timeout"),
    /original/,
  );
});
test("workflow keeps public output and trigger scope narrow", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/native-gui-smoke.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /branches: \[test\/native-gui-smoke-20261107\]/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  for (const host of ["macos-15", "macos-15-intel", "ubuntu-22.04"])
    assert.ok(workflow.includes("runner: " + host));
  for (const forbidden of [
    "upload-artifact",
    "release create",
    "workflow_run:",
    "pull_request:",
    "schedule:",
    "secrets.",
    "continue-on-error",
    "xattr",
    "spctl",
    "tccutil",
    "killall",
  ])
    assert.ok(!workflow.includes(forbidden), forbidden);
  assert.match(workflow, /dbus-run-session -- xvfb-run/);
});
test("native IPC and real DOM remain in test renderer, no mock bridge", async () => {
  const renderer = await readFile(
    new URL("./native-gui-smoke-renderer.mjs", import.meta.url),
    "utf8",
  );
  for (const name of [
    "get_build_info",
    "get_agent_status",
    "plugin:window|is_visible",
    "plugin:process|exit",
    "requestAnimationFrame",
    "getBoundingClientRect",
    "Coding workspace",
    "Character chat",
  ])
    assert.ok(renderer.includes(name));
  assert.ok(!renderer.includes("__TAURI_INTERNALS__ ="));
  assert.ok(!renderer.includes("agent_send"));
});
