import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureSdkProcesses, readFixtureSdkProcessesAsync } from "./harness-desktop-processes.mjs";

const profile = "C:\\Temp\\lolicode-harness-desktop-fixture\\.lolicode-dev";
const session = "11111111-1111-4111-8111-111111111111";
const command = `node.exe D:\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile sdk --patch D:\\runtime\\host-operations.cordis.patch.yml --patch "${profile}\\agent\\harness-desktop\\${session}\\channel-123.cordis.patch.yml"`;
const row = { pid: 123, parentPid: 100, createdAt: "2026-11-10T06:00:00.000Z", commandLine: command };

test("observes only the live SDK using the exact disposable profile and channel overlay", () => {
  assert.deepEqual(fixtureSdkProcesses([
    row,
    { ...row, pid: 124, commandLine: command.replace(profile, "C:\\Users\\admin\\.lolicode-dev") },
    { ...row, pid: 125, commandLine: command.replace(profile, `${profile}-other`) },
    { ...row, pid: 126, commandLine: command.replace("dsh\\lib\\bin.js", "host-session-native.mjs") },
    { ...row, pid: 127, commandLine: command.replace("--profile sdk", "--profile cli") },
    { ...row, pid: 128, commandLine: command.replace("channel-123", "another-overlay") },
  ], profile), [{ pid: 123, parentPid: 100, createdAt: row.createdAt, sessionId: `lc:${session}` }]);
});

test("requires an isolated profile and creation time so PID reuse is not mistaken for reuse", () => {
  assert.throws(() => fixtureSdkProcesses([row], "C:\\Users\\admin\\.lolicode-dev"), /disposable/);
  assert.throws(() => fixtureSdkProcesses([{ ...row, createdAt: null }], profile), /creation time/);
  assert.notEqual(`${row.pid}:${row.createdAt}`, `${row.pid}:2026-11-10T06:01:00.000Z`);
});

test("keeps the event loop available while the CIM query is pending and applies the same isolation", async () => {
  let finish;
  const read = readFixtureSdkProcessesAsync(profile, async () => new Promise((resolve) => {
    finish = resolve;
  }));
  let served = false;
  await new Promise(resolve => setImmediate(() => {
    served = true;
    resolve();
  }));
  assert.equal(served, true);
  finish({ stdout: JSON.stringify([row,
    { ...row, pid: 999, commandLine: command.replace(profile, "C:\\Users\\admin\\.lolicode-dev") }]) });
  const result = await read;
  assert.deepEqual(result.processes, fixtureSdkProcesses([row], profile));
  assert.ok(Number.isFinite(result.processQueryMs) && result.processQueryMs >= 0);
});
