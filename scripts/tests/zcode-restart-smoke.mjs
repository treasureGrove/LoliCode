/** Real production-worker cold restart. All files, credentials and model
 * responses are mkdtemp-owned; outbound networking is denied in every child. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(
  path.join(tmpdir(), "lolicode-native-restart-"),
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
const model = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    modelRequests++;
    assert.equal(input.model, "fixture/restart-model");
    const text = input.tools?.length
      ? "LOLICODE_COLD_RESTART_OK"
      : "Owned restart fixture";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "owned-restart", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "owned-restart", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    modelFailure = error;
    response.writeHead(500);
    response.end("Owned fixture failure");
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const catalog = {
  revision: 1,
  models: [
    {
      id: "lolicode/fixture/restart-model",
      providerId: "fixture",
      modelId: "fixture/restart-model",
      name: "Owned restart fixture",
      channelName: "Offline fixture",
      contextLimit: 16000,
      outputLimit: 1000,
    },
  ],
  defaultModel: "lolicode/fixture/restart-model",
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
  persistentPrivateRoot: true,
  externalNetworkBlocked: true,
  paidCalls: 0,
  coldBusyWithoutWorkspaceWake: false,
  historyRestored: false,
  preferencesRestored: false,
  noDuplicateInference: false,
  secondSessionWorked: false,
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
async function finished(rpc, id, expectedTitle) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const state = await rpc("getSession", { sessionId: id });
    if (
      state.status === "idle" &&
      state.session.title === expectedTitle &&
      state.messages.some((message) =>
        message.parts.some((part) =>
          part.text?.includes("LOLICODE_COLD_RESTART_OK"),
        ),
      )
    )
      return state;
    await pause(100);
  }
  throw new Error(
    "Owned session did not settle with its authoritative history/title",
  );
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
let failure;
try {
  const first = await boot();
  assert.equal(await first.rpc("busy"), false);
  await first.rpc("openProject", { path: workspace, catalog, gateway });
  const title = "Preserved native restart title";
  const session = await first.rpc("createSession", {
    modelId: catalog.defaultModel,
    mode: "build",
    permissionMode: "auto",
    title,
  });
  assert.ok(session.id.startsWith("zc:"));
  await first.rpc("sendMessage", {
    sessionId: session.id,
    text: "Reply with the owned restart fixture marker.",
    requestId: "msg_owned_restart_first",
  });
  const original = await finished(first.rpc, session.id, title);
  await first.rpc("setSessionMetadata", {
    sessionId: session.id,
    pinned: true,
  });
  await pause(750);
  assert.equal(await first.rpc("busy"), false);
  const beforeRestart = modelRequests;
  assert.ok(beforeRestart >= 1);
  await eof(first);

  const second = await boot();
  assert.equal(
    await second.rpc("busy"),
    false,
    "Cold busy must not initialize old workspaces",
  );
  assert.equal((await second.rpc("status")).running, false);
  await pause(750);
  assert.equal(modelRequests, beforeRestart);
  proof.coldBusyWithoutWorkspaceWake = true;
  const project = await second.rpc("openProject", {
    path: workspace,
    catalog,
    gateway,
  });
  assert.ok(project.sessions.some((item) => item.id === session.id));
  const restored = await second.rpc("getSession", { sessionId: session.id });
  assert.equal(restored.status, "idle");
  assert.equal(restored.session.title, title);
  assert.equal(restored.session.permissionMode, "auto");
  assert.equal(restored.session.pinned, true);
  const durable = (messages) =>
    messages.map(({ id, role, parts }) => ({ id, role, parts }));
  // Live/replay timestamp normalization is owned by native ZCode. Identity and
  // actual persisted content, rather than transient projection times, matter.
  assert.deepEqual(durable(restored.messages), durable(original.messages));
  proof.historyRestored = true;
  proof.preferencesRestored = true;
  await pause(750);
  assert.equal(
    modelRequests,
    beforeRestart,
    "Read/restore must not replay inference",
  );
  proof.noDuplicateInference = true;
  const freshTitle = "Second native restart session";
  const fresh = await second.rpc("createSession", {
    modelId: catalog.defaultModel,
    mode: "build",
    permissionMode: "ask",
    title: freshTitle,
  });
  await second.rpc("sendMessage", {
    sessionId: fresh.id,
    text: "Reply with the owned restart fixture marker.",
    requestId: "msg_owned_restart_second",
  });
  assert.equal(
    (await finished(second.rpc, fresh.id, freshTitle)).session.permissionMode,
    "ask",
  );
  assert.ok(modelRequests > beforeRestart);
  proof.secondSessionWorked = true;
  await pause(750);
  assert.equal(await second.rpc("busy"), false);
  await eof(second);
  assert.equal(modelFailure, undefined);
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
  assert.ok(
    pids.length >= 4,
    "Both workers and their native CLI children must be observed",
  );
  for (let attempt = 0; attempt < 40 && pids.some(alive); attempt++)
    await pause(50);
  assert.deepEqual(
    pids.filter(alive),
    [],
    "EOF must leave no owned runtime child running",
  );
  proof.noOrphans = true;
  proof.success = true;
  proof.modelRequests = modelRequests;
  proof.ownedProcessCount = pids.length;
  proof.blockedExternalAttempts = logged.filter((item) => item.blocked).length;
} catch (error) {
  failure = error;
} finally {
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
  assert.ok(path.basename(resolved).startsWith("lolicode-native-restart-"));
  await rm(resolved, { recursive: true, force: true });
}
