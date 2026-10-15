/** Real production worker saved-workflow smoke. Every file and process belongs
 * to this temporary fixture, all external network is blocked, no paid model. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const repo = resolve(".");
const dir = await mkdtemp(join(tmpdir(), "lolicode-real-native-workflow-"));
const project = join(dir, "project"),
  data = join(dir, "data");
await mkdir(project, { recursive: true });
await mkdir(data, { recursive: true });
const token = randomBytes(40).toString("hex");
let requests = 0;
let worker;
let error;
let modelError;
const logs = [];
const model = createServer(async (req, res) => {
  try {
    requests++;
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).model, "fixture/offline");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          id: "chatcmpl-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "offline-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Offline workflow complete.",
              },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n" +
        "data: " +
        JSON.stringify({
          id: "chatcmpl-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "offline-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  } catch (cause) {
    modelError = cause;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Offline fixture request mismatch" }));
  }
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const gateway = {
  baseUrl: "http://127.0.0.1:" + model.address().port + "/v1",
  bearerToken: "offline-lease-not-a-real-key",
};
const blocker = join(dir, "offline-network.mjs");
await writeFile(
  blocker,
  `import http from 'node:http';import https from 'node:https';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
const local=host=>['127.0.0.1','localhost','::1','[::1]'].includes(host);
const valid=x=>{try{const u=typeof x==='string'||x instanceof URL?new URL(x):x;return local(u.hostname||u.host);}catch{return false}};
const blocked=()=>{throw new Error('External network disabled for offline smoke')};
const original=globalThis.fetch;globalThis.fetch=(u,o)=>{if(!valid(u instanceof Request?u.url:u))blocked();return original(u,o)};
for(const m of [http,https]){const req=m.request;m.request=function(x,...args){if(!valid(x))blocked();return req.call(this,x,...args)};}
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const normalized=Array.isArray(args[0])?args[0]:args;const options=normalized[0];if(typeof options==='object'&&options&&!options.path&&!local(options.host||options.hostname||'localhost'))blocked();if(typeof options==='number'&&typeof normalized[1]==='string'&&!local(normalized[1]))blocked();return connect.apply(this,args)};
syncBuiltinESMExports();`,
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
  HOME: dir,
  USERPROFILE: dir,
  APPDATA: join(dir, "appdata"),
  LOCALAPPDATA: join(dir, "localappdata"),
  TEMP: join(dir, "temp"),
  TMP: join(dir, "temp"),
  ZCODE_DYNAMIC_WORKFLOW_MODE: "onDemand",
  NODE_OPTIONS: "--import=" + pathToFileURL(blocker).href,
  DO_NOT_TRACK: "1",
  NO_PROXY: "127.0.0.1,localhost",
});
await mkdir(env.TEMP);
const proof = {
  sourceRevision: "aac4755666d09fdcd70272fcf063c077a639015f",
  privateTemporaryProject: true,
  externalNetworkBlocked: true,
  controlPlane:
    "production worker local-only transport; no fake official response",
  paidCalls: 0,
  originalWorkflowWritten: false,
  listed: false,
  startAccepted: false,
  terminal: false,
  nativeSaveFromRun: false,
  resavedScriptUnchanged: false,
  modelRequests: 0,
  cleanup: false,
};
try {
  worker = spawn(
    join(repo, "src-tauri/resources/zcode-runtime/node.exe"),
    [join(repo, "src-tauri/resources/zcode-runtime/worker.cjs")],
    { cwd: project, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  worker.stderr.on("data", (b) => logs.push(b.toString()));
  const ready = await new Promise((resolve, reject) => {
    let pending = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error("Worker startup timed out: " + logs.join("").slice(-1200)),
        ),
      45000,
    );
    worker.once("exit", (c) => {
      clearTimeout(timer);
      reject(
        new Error("Worker exited " + c + ": " + logs.join("").slice(-1200)),
      );
    });
    worker.stdout.on("data", (b) => {
      pending += b;
      for (;;) {
        const i = pending.indexOf("\n");
        if (i < 0) break;
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        try {
          const f = JSON.parse(line);
          if (f.event === "ready") {
            clearTimeout(timer);
            resolve(f);
          }
        } catch {}
      }
    });
    worker.stdin.write(JSON.stringify({ token, privateRoot: data }) + "\n");
  });
  const base = "http://127.0.0.1:" + ready.port;
  const rpc = async (method, args = {}) => {
    const response = await fetch(base + "/rpc", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(method + ": " + result.error);
    return result.result;
  };
  const call = (method, args) =>
    rpc("capability", { service: "IZCodeAgentService", method, args: [args] });
  const catalog = {
    revision: 1,
    models: [
      {
        id: "lolicode/fixture/offline",
        providerId: "lolicode",
        modelId: "fixture/offline",
        name: "Offline fixture",
        channelName: "Isolated fixture",
      },
    ],
    defaultModel: "lolicode/fixture/offline",
    excludedSources: [],
  };
  await rpc("openProject", { path: project, catalog, gateway });
  const script =
    'artifact.markdown("offline-result", "# Native workflow completed");\nreturn { count: Number(args.count) + 1, source: "native-sandbox" };\n';
  await mkdir(join(project, ".zcode", "workflows"), { recursive: true });
  await writeFile(
    join(project, ".zcode", "workflows", "offline-smoke.dwf.ts"),
    "/* zcode-workflow\ndescription: Isolated offline smoke\nargs:\n  count: {type: number, default: 2}\n*/\n" +
      script,
  );
  proof.originalWorkflowWritten = true;
  const listing = await call("listSavedWorkflows", { workspacePath: project });
  assert.ok(listing.workflows.some((x) => x.name === "offline-smoke"));
  proof.listed = true;
  const created = await rpc("createSession", {
    modelId: catalog.defaultModel,
    mode: "build",
    permissionMode: "auto",
  });
  assert.ok(created.id.startsWith("zc:"));
  const started = await rpc("runSavedWorkflow", {
    sessionId: created.id,
    name: "offline-smoke",
    scope: "project",
    args: { count: 4 },
    requestId: randomUUID(),
  });
  assert.equal(started.id, created.id);
  proof.startAccepted = true;
  proof.productionRunRpc = true;
  let run;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const records = await call("listSavedWorkflowRuns", {
      workspacePath: project,
      name: "offline-smoke",
      scope: "project",
      limit: 10,
    });
    const runs = records.runs || records.items || [];
    assert.ok(runs.length <= 1, "Unexpected extra native workflow run");
    run = runs[0];
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  proof.runId = run?.runId;
  assert.ok(run, "Native run missing");
  proof.runStatus = run.status;
  assert.equal(run.status, "completed");
  proof.terminal = true;
  const saved = await call("saveSavedWorkflowFromRun", {
    workspacePath: project,
    runId: run.runId,
    name: "offline-smoke-saved",
    meta: { description: "Saved from the real native journal" },
    scope: "project",
  });
  assert.equal(saved.ok, true);
  proof.nativeSaveFromRun = true;
  const savedText = await readFile(
    join(project, ".zcode", "workflows", "offline-smoke-saved.dwf.ts"),
    "utf8",
  );
  assert.ok(savedText.endsWith(script));
  proof.resavedScriptUnchanged = true;
  proof.modelRequests = requests;
  if (modelError) throw modelError;
  await rpc("shutdown");
  if (worker.exitCode == null)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Worker did not close")),
        12000,
      );
      worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  assert.equal(worker.exitCode, 0);
  proof.workerExit = worker.exitCode;
  proof.success = true;
} catch (cause) {
  error = cause;
  proof.success = false;
  proof.error = cause.message;
  proof.lastNativeLog = logs.join("").slice(-1500);
} finally {
  if (worker && worker.exitCode == null) {
    worker.stdin.end();
    await new Promise((r) => setTimeout(r, 800));
    if (worker.exitCode == null) worker.kill();
  }
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
  proof.cleanup = true;
  await writeFile(
    join(tmpdir(), "lolicode-native-workflow-proof.json"),
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof, null, 2));
}
if (error) process.exitCode = 1;
