/** Real AutomationRepo + IZCodeTaskService + native CLI terminal-outcome smoke.
 * All subprocesses and files are owned temp fixtures; no external network. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(
  path.join(tmpdir(), "lolicode-native-automation-"),
);
const workspace = path.join(directory, "project");
const privateRoot = path.join(directory, "private");
await mkdir(workspace);
await mkdir(privateRoot);
await writeFile(
  path.join(workspace, "README.md"),
  "Owned cold-restart fixture.\n",
);
const runtime = path.resolve("src-tauri/resources/zcode-runtime");
const processLog = path.join(directory, "owned-processes.jsonl");
const preload = path.join(directory, "offline-network.mjs");
await writeFile(
  preload,
  `
import http from "node:http"; import https from "node:https"; import net from "node:net";
import childProcess from "node:child_process"; import {appendFileSync} from "node:fs"; import {syncBuiltinESMExports} from "node:module";
const log = ${JSON.stringify(processLog)};
const record = value => appendFileSync(log, JSON.stringify(value) + "\\n");
record({pid:process.pid,parent:process.ppid});
const local = host => ["127.0.0.1","localhost","::1","[::1]"].includes(host);
const blocked = () => {record({blocked:true,pid:process.pid}); throw new Error("External network disabled for offline restart smoke");};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input,options) => {const url = new URL(input instanceof Request ? input.url : input); if(!local(url.hostname)) blocked(); return originalFetch(input,options);};
for(const module of [http,https]) {const original = module.request; module.request = function(input,...args) {const url = typeof input === "string" || input instanceof URL ? new URL(input) : input; if(!local(url.hostname || url.host || "localhost")) blocked(); return original.call(this,input,...args);};}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {const normalized = Array.isArray(args[0]) ? args[0] : args; const options = normalized[0]; if(typeof options === "object" && options && !options.path && !local(options.host || options.hostname || "localhost")) blocked(); if(typeof options === "number" && typeof normalized[1] === "string" && !local(normalized[1])) blocked(); return connect.apply(this,args);};
const spawn = childProcess.spawn; childProcess.spawn = function(...args) {const child = spawn.apply(this,args); if(child.pid) record({pid:child.pid,parent:process.pid}); return child;};
syncBuiltinESMExports();
`,
);
const env = {};
for (const key of [
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "SystemDrive",
  "SYSTEMDRIVE",
  "PATHEXT",
])
  if (process.env[key]) env[key] = process.env[key];
Object.assign(env, {
  HOME: directory,
  USERPROFILE: directory,
  APPDATA: path.join(directory, "appdata"),
  LOCALAPPDATA: path.join(directory, "localappdata"),
  TEMP: path.join(directory, "temp"),
  TMP: path.join(directory, "temp"),
  NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  ZCODE_DYNAMIC_WORKFLOW_MODE: "onDemand",
  NO_PROXY: "127.0.0.1,localhost",
  DO_NOT_TRACK: "1",
});
await mkdir(env.TEMP);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let modelRequests = 0;
let modelFailure;
let primaryRequests = 0;
let releaseFirst;
const firstResponseGate = new Promise((resolve) => {
  releaseFirst = resolve;
});
const model = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    modelRequests++;
    assert.equal(input.model, "fixture/automation-model");
    const primary = Boolean(input.tools?.length);
    if (primary) primaryRequests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      "data: " +
        JSON.stringify({
          id: "owned-automation",
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: primary
                  ? "LOLICODE_AUTOMATION_EXECUTED"
                  : "Owned automation title",
              },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n",
    );
    if (primary && primaryRequests === 1) await firstResponseGate;
    response.end(
      "data: " +
        JSON.stringify({
          id: "owned-automation",
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  } catch (error) {
    modelFailure = error;
    if (!response.headersSent) response.writeHead(500);
    response.end("Owned automation fixture failure");
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const catalog = {
  revision: 1,
  models: [
    {
      id: "lolicode/fixture/automation-model",
      providerId: "fixture",
      modelId: "fixture/automation-model",
      name: "Owned restart fixture",
      channelName: "Offline fixture",
      contextLimit: 16000,
      outputLimit: 1000,
    },
  ],
  defaultModel: "lolicode/fixture/automation-model",
  excludedSources: [],
};
const gateway = {
  baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
  bearerToken: "owned-loopback-only-no-upstream-key",
};
const children = [];
const exits = [];
const proof = {
  success: false,
  sourceRevision: "aac4755666d09fdcd70272fcf063c077a639015f",
  realNativeTaskService: true,
  externalNetworkBlocked: true,
  paidCalls: 0,
  runTerminalSucceeded: false,
  matchingSessionText: false,
  singleFlightNoDuplicate: false,
  updateBarrierRejectedRun: false,
  oneRunAfterResume: false,
  jobAndRunsSurviveRestart: false,
  eofExitCodes: exits,
  noOrphans: false,
};

async function boot() {
  const token = randomBytes(40).toString("hex");
  const child = spawn(
    path.join(runtime, process.platform === "win32" ? "node.exe" : "node"),
    [path.join(runtime, "worker.cjs")],
    { cwd: directory, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += String(data).slice(0, 1000);
  });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
  const owner = { child, exited };
  children.push(owner);
  const ready = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(
      () => reject(new Error("Owned worker startup timed out")),
      45_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Owned worker exited before ready (${code})`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (data) => {
      stdout += data;
      if (!stdout.includes("\n")) return;
      try {
        const event = JSON.parse(stdout.split("\n")[0]);
        assert.equal(event.event, "ready");
        clearTimeout(timer);
        resolve(event);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.stdin.write(JSON.stringify({ token, privateRoot }) + "\n");
  });
  const rpc = async (method, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${ready.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`${method}: ${result.error}`);
    return result.result;
  };
  return { ...owner, rpc, stderr: () => stderr };
}
async function eof(owner) {
  owner.child.stdin.end();
  let timer;
  const code = await Promise.race([
    owner.exited,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        owner.child.kill();
        resolve(-1);
      }, 12_000);
    }),
  ]);
  clearTimeout(timer);
  exits.push(code);
  assert.equal(code, 0, "Owned worker must exit cleanly on stdin EOF");
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function automation(rpc, method, ...args) {
  return rpc("automation", { method, args });
}
async function waitFor(predicate, message, timeout = 60_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (modelFailure) throw modelFailure;
    const value = await predicate();
    if (value) return value;
    await pause(100);
  }
  throw new Error(message);
}
async function terminal(rpc, id, count) {
  return waitFor(async () => {
    const runs = await automation(rpc, "listRuns", id);
    if (
      runs.some((run) => run.outcome === "failed" || run.outcome === "stopped")
    )
      throw new Error(
        "Native automation reached failed/stopped outcome: " +
          runs.find(
            (run) => run.outcome === "failed" || run.outcome === "stopped",
          ).error,
      );
    return runs.length === count &&
      runs.every((run) => run.outcome === "succeeded")
      ? runs
      : null;
  }, "Native task terminal outcome was not persisted");
}
async function taskHistory(rpc, run) {
  assert.ok(
    run.sessionId,
    "Terminal run must point to its actual native task/session",
  );
  const state = await rpc("capability", {
    service: "IZCodeTaskService",
    method: "getTaskSnapshot",
    args: [
      {
        taskId: run.sessionId,
        workspacePath: workspace,
        messageLimit: 200,
        clientMode: "desktop-continuous",
      },
    ],
  });
  assert.ok(
    state?.messages?.some(
      (message) =>
        message.role === "assistant" &&
        message.content.includes("LOLICODE_AUTOMATION_EXECUTED"),
    ),
    "Native task must persist the actual fake-model reply",
  );
  assert.ok(
    state.messages.some(
      (message) =>
        message.role === "user" &&
        message.content.includes("AUTO_EXECUTION_PROOF"),
    ),
    "Native task must preserve the submitted automation prompt",
  );
  return state;
}
let failure;
try {
  const first = await boot();
  await first.rpc("openProject", { path: workspace, catalog, gateway });
  const job = await automation(first.rpc, "create", {
    title: "Owned automation terminal fixture",
    cronExpr: "0 0 1 1 *",
    prompt:
      "AUTO_EXECUTION_PROOF: reply with the fixture marker only; do not invoke tools.",
    workspacePath: workspace,
    recurring: true,
    mode: "guarded",
    modelSelection: {
      providerId: "fixture",
      modelId: "fixture/automation-model",
      options: { reasoningLevel: "default" },
    },
  });
  assert.ok(job.automationId);
  const pending = automation(first.rpc, "runNow", job.automationId);
  void pending.catch(() => {});
  await waitFor(
    () => primaryRequests === 1,
    "Automation did not reach a real loopback model",
  );
  assert.deepEqual(await automation(first.rpc, "runNow", job.automationId), {
    status: "duplicate",
  });
  releaseFirst();
  assert.deepEqual(await pending, { status: "queued" });
  let runs = await terminal(first.rpc, job.automationId, 1);
  assert.equal(new Set(runs.map((run) => run.runId)).size, 1);
  assert.equal(runs[0].dispatchStatus, "dispatched");
  await taskHistory(first.rpc, runs[0]);
  proof.runTerminalSucceeded = true;
  proof.matchingSessionText = true;
  proof.singleFlightNoDuplicate = true;
  await waitFor(
    async () => !(await first.rpc("busy")),
    "Automation owner did not release terminal flight",
  );
  await pause(750);
  const afterFirst = modelRequests;
  await first.rpc("beginUpdate");
  await assert.rejects(
    () => automation(first.rpc, "runNow", job.automationId),
    /正在准备更新/,
  );
  await pause(500);
  assert.equal(
    modelRequests,
    afterFirst,
    "Update barrier must not dispatch a model request",
  );
  proof.updateBarrierRejectedRun = true;
  await first.rpc("endUpdate");
  assert.deepEqual(await automation(first.rpc, "runNow", job.automationId), {
    status: "queued",
  });
  runs = await terminal(first.rpc, job.automationId, 2);
  assert.equal(new Set(runs.map((run) => run.runId)).size, 2);
  for (const run of runs) await taskHistory(first.rpc, run);
  assert.equal(
    primaryRequests,
    2,
    "Each explicitly requested run must execute exactly once",
  );
  proof.oneRunAfterResume = true;
  await waitFor(
    async () => !(await first.rpc("busy")),
    "Second automation flight did not settle",
  );
  await pause(750);
  const beforeRestart = modelRequests;
  await eof(first);
  const second = await boot();
  assert.equal(await second.rpc("busy"), false);
  const jobs = await automation(second.rpc, "list", {
    workspacePath: workspace,
  });
  assert.equal(
    jobs.filter((value) => value.automationId === job.automationId).length,
    1,
  );
  const restored = await automation(second.rpc, "listRuns", job.automationId);
  assert.equal(restored.length, 2);
  assert.ok(restored.every((run) => run.outcome === "succeeded"));
  assert.deepEqual(
    restored.map((run) => run.runId).sort(),
    runs.map((run) => run.runId).sort(),
  );
  await second.rpc("openProject", { path: workspace, catalog, gateway });
  await pause(750);
  assert.equal(
    modelRequests,
    beforeRestart,
    "Restoring an automation must not repeat inference",
  );
  proof.jobAndRunsSurviveRestart = true;
  await eof(second);
  const logged = (await readFile(processLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const pids = [
    ...new Set(
      logged
        .filter((item) => Number.isInteger(item.pid) && !item.blocked)
        .map((item) => item.pid),
    ),
  ];
  for (let attempt = 0; attempt < 40 && pids.some(alive); attempt++)
    await pause(50);
  assert.deepEqual(
    pids.filter(alive),
    [],
    "EOF must stop all owned worker/CLI children",
  );
  proof.noOrphans = true;
  proof.success = true;
  proof.primaryModelRequests = primaryRequests;
  proof.modelRequests = modelRequests;
  proof.ownedProcessCount = pids.length;
  proof.blockedExternalAttempts = logged.filter((item) => item.blocked).length;
} catch (error) {
  failure = error;
} finally {
  releaseFirst();
  for (const owner of children)
    if (owner.child.exitCode === null && !owner.child.killed) {
      owner.child.stdin.end();
      let timer;
      await Promise.race([
        owner.exited,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            owner.child.kill();
            resolve();
          }, 12_000);
        }),
      ]);
      clearTimeout(timer);
    }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
}
console.log(JSON.stringify(proof));
if (failure) {
  console.error(failure.message);
  process.exitCode = 1;
} else {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith("lolicode-native-automation-"));
  await rm(resolved, { recursive: true, force: true });
}
