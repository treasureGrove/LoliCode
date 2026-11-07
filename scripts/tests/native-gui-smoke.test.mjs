import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateHost,
  validateReport,
  phases,
  bounded,
  safeDiagnostic,
  formatSummary,
  checkpoints,
  smokeWindow,
  classifyNativeLog,
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

test("public diagnostics accept only fixed identifiers and an exact SHA", () => {
  const secret = "private token\n::warning::do-not-print";
  assert.deepEqual(
    safeDiagnostic({ checkpoint: secret, failureCode: secret }),
    { checkpoint: "unknown", code: "unknown" },
  );
  assert.deepEqual(
    safeDiagnostic({ checkpoint: "root-painted", failureCode: "timeout" }),
    { checkpoint: "root-painted", code: "timeout" },
  );
  const summary = formatSummary(secret, secret, {
    checkpoint: secret,
    code: secret,
  });
  assert.ok(!summary.includes(secret));
  assert.ok(!summary.includes("private token"));
  assert.ok(!summary.includes("\n"));
  assert.match(
    summary,
    /stage: unknown; checkpoint: unknown; code: unknown; SHA: invalid/,
  );
  assert.match(
    formatSummary("gui-paint", "a".repeat(40), {
      checkpoint: "root-painted",
      code: "timeout",
    }),
    /FAIL.*gui-paint.*root-painted.*timeout/,
  );
  assert.match(
    formatSummary("passed", "a".repeat(40), {
      checkpoint: "native-exit",
      code: "none",
    }),
    /PASS/,
  );
});
test("every renderer checkpoint is allowlisted and no arbitrary error is reported", async () => {
  const renderer = await readFile(
    new URL("./native-gui-smoke-renderer.mjs", import.meta.url),
    "utf8",
  );
  for (const match of renderer.matchAll(/checkpoint = "([^"]+)"/g))
    assert.ok(checkpoints.includes(match[1]), match[1]);
  assert.ok(renderer.includes("checkpoint,"));
  assert.ok(renderer.includes("failureCode,"));
  assert.ok(!renderer.includes("message: error"));
  const runner = await readFile(
    new URL("./native-gui-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(runner.includes("console.log(summary)"));
  assert.ok(runner.includes("::error title=Native GUI smoke::${summary}"));
});
test("test window preserves original native chrome and geometry", () => {
  const original = {
    label: "main",
    title: "original",
    visible: false,
    titleBarStyle: "Overlay",
    trafficLightPosition: { x: 14, y: 16 },
    width: 1000,
    height: 650,
    minWidth: 900,
    minHeight: 600,
    resizable: true,
    fullscreen: false,
    center: true,
  };
  const result = smokeWindow({ app: { windows: [original] } });
  assert.deepEqual(result, {
    ...original,
    title: "Test-instrumented native GUI smoke",
    visible: true,
  });
  assert.equal(original.visible, false);
  assert.throws(() => smokeWindow({ app: { windows: [] } }));
});

test("native diagnostics publish only classifications, exit code and Rust error IDs", () => {
  const secret = "private credentials /home/private/source.rs";
  assert.deepEqual(
    classifyNativeLog(
      `error[E0308]: ${secret}\nerror[E0308]: duplicate\nerror[E0432]: ${secret}`,
      { code: 101 },
      false,
    ),
    {
      classification: "compile",
      rustErrors: ["E0308", "E0432"],
      exitCode: 101,
    },
  );
  assert.equal(
    classifyNativeLog(
      `Error invalid configuration ${secret}`,
      { code: 1 },
      false,
    ).classification,
    "cli-config",
  );
  assert.equal(
    classifyNativeLog(secret, { code: 0 }, false).classification,
    "native-exit-before-handshake",
  );
  assert.equal(
    classifyNativeLog(secret, { code: 1 }, true).classification,
    "native-exit-after-handshake",
  );
  const summary = formatSummary("native-build-and-gui", "a".repeat(40), {
    classification: secret,
    exitCode: secret,
    rustErrors: [secret, "E0308", "E99999", "E0001\n::error::secret"],
  });
  assert.ok(!summary.includes(secret));
  assert.ok(!summary.includes("\n"));
  assert.match(
    summary,
    /native-class: running-or-unknown; exit-code: unknown; rust-errors: E0308/,
  );
});

test("timeout classification does not turn cleanup termination into a natural crash", async () => {
  assert.equal(
    classifyNativeLog("", undefined, true).classification,
    "running-or-unknown",
  );
  const runner = await readFile(
    new URL("./native-gui-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    runner.indexOf("const naturalExit = nativeExit") <
      runner.indexOf('signal("SIGTERM")'),
  );
  assert.match(
    runner,
    /readNativeDiagnostic\(privateLogPath, naturalExit, handshakeSeen\)/,
  );
  assert.ok(
    !runner.includes("security:"),
    "Overlay must not replace the base CSP or security settings",
  );
});

test("leaving Settings uses its Back control before the Agent directory returns", async () => {
  const renderer = await readFile(
    new URL("./native-gui-smoke-renderer.mjs", import.meta.url),
    "utf8",
  );
  const sidebar = await readFile(
    new URL("../../src/app/shell/Sidebar.tsx", import.meta.url),
    "utf8",
  );
  const locale = JSON.parse(
    await readFile(
      new URL("../../src/i18n/locales/en.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(locale.nav.back, "Back");
  assert.ok(sidebar.includes('props.view === "settings" ? ('));
  assert.ok(sidebar.includes("<SettingsDirectory"));
  assert.ok(sidebar.includes("onClick={props.onExitSettings}"));
  const navigationStart = renderer.indexOf('phases.push("language")');
  const agentEntry = renderer.indexOf(
    'checkpoint = "agent-entry"',
    navigationStart,
  );
  const transition = renderer.slice(navigationStart, agentEntry);
  assert.ok(transition.includes('checkpoint = "settings-return"'));
  assert.ok(
    transition.includes('.lolicode-sidebar-settings button[aria-label="Back"]'),
  );
  assert.ok(!transition.includes("Coding workspace"));
  assert.ok(
    renderer.indexOf('checkpoint = "agent-return"') <
      renderer.lastIndexOf(
        "await click('button[aria-label=\"Coding workspace\"]')",
      ),
  );
});
