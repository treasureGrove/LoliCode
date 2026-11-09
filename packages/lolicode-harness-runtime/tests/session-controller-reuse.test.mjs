import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";

const root = fileURLToPath(new URL("../", import.meta.url));
const additions = [
  ["reuse-connection", "@deepseek-ai/dsh-client-connection"],
  ["reuse-file-uploads", "@deepseek-ai/dsh-client-file-upload"],
  ["reuse-workspace", "@deepseek-ai/dsh-workspace"],
  ["reuse-controller", "@deepseek-ai/dsh-api-session-controller"],
  ["reuse-stats", "@deepseek-ai/dsh-session-stats"],
  ["reuse-outline", "@deepseek-ai/dsh-session-turn-outline"],
];

test("official Session Controller works beside the desktop SDK and reads hot/cold logs without Agents", {
  timeout: 60_000,
}, async (t) => {
  const parent = path.resolve(os.tmpdir());
  const prefix = "lolicode-session-reuse-";
  const temporary = await mkdtemp(path.join(parent, prefix));
  const children = [];
  t.after(async () => {
    for (const { child, exited, transport } of children) {
      transport.close();
      if (child.connected) child.disconnect();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    assert.equal(path.dirname(temporary), parent);
    assert.ok(path.basename(temporary).startsWith(prefix));
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  await mkdir(home);
  await mkdir(project);
  const patch = path.join(temporary, "probe.json");
  await writeFile(patch, JSON.stringify([{
    id: "llm-pi-ai",
    config: { providers: { "reuse-fixture": {
      apiKeyEnv: "LOLICODE_REUSE_FIXTURE_TOKEN", api: "openai-completions", baseURL: "http://127.0.0.1:9/v1",
      models: [{ id: "reuse-model", input: ["text"], contextWindow: 32768, maxTokens: 1024 }],
    } } },
  }, { insert: [
    ...additions.map(([id, name]) => ({ id, name })),
    { id: "reuse-probe", name: path.join(root, "probes/session-controller-host.mjs") },
  ] }]));

  async function start() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|HOME|USERPROFILE|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|TMPDIR)$/i.test(key)));
    const child = spawn(process.execPath, [
      path.join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
      "--profile", "sdk",
      "--patch", path.join(root, "profile.cordis.patch.yml"),
      "--patch", path.join(root, "host-operations.cordis.patch.yml"),
      "--patch", patch,
    ], {
      cwd: project,
      env: { ...env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", LOLICODE_SESSION_REUSE_PROBE: "1", LOLICODE_REUSE_FIXTURE_TOKEN: "unused-fixture" },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {});
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
    transport.start();
    children.push({ child, exited, transport });
    const failed = Promise.race([
      exited.then(({ code, signal }) => { throw new Error(`Probe exited ${signal ?? code}: ${stderr}`); }),
      new Promise((_, reject) => child.once("error", reject)),
      new Promise((_, reject) => t.signal.addEventListener("abort", () => reject(t.signal.reason), { once: true })),
    ]);
    const ready = new Promise((resolve) => child.on("message", (message) => { if (message.ready) resolve(); }));
    await Promise.race([ready, failed]);
    const initialized = await Promise.race([transport.request("initialize", {
      cwd: project, provider: "reuse-fixture", model: "reuse-model",
    }, t.signal), failed]);
    assert.equal(initialized.serverInfo.name, "deepseek-harness-sdk-runtime");
    let sequence = 0;
    return {
      async operation(method) {
        const id = ++sequence;
        const response = new Promise((resolve, reject) => {
          const listener = (message) => {
            if (message.id !== id) return;
            child.off("message", listener);
            if (message.error) reject(new Error(message.error.stack));
            else resolve(message.result);
          };
          child.on("message", listener);
          child.send({ id, method });
        });
        return Promise.race([response, failed]);
      },
      async stop() {
        assert.deepEqual(await transport.request("shutdown", {}, t.signal), {});
        if (child.connected) child.disconnect();
        assert.deepEqual(await exited, { code: 0, signal: null });
        transport.close();
      },
    };
  }

  function verify(read) {
    assert.equal(read.agentsBefore, 0);
    assert.equal(read.agentsAfter, 0);
    assert.equal(read.httpServerStarted, false);
    assert.ok(read.pages.length >= 3, "exercise real backward paging");
    const events = read.pages.toReversed().flatMap((page) => page.records.map((record) => record.event));
    assert.deepEqual(events, read.canonical);
    assert.equal(read.projections.kind, "sequenced");
    assert.equal(read.projections.asOfSeq, events.at(-1).seq);
    assert.equal(read.projections.values.turnOutline.length, 3);
    assert.equal(read.projections.values.sessionStats.turns, 3);
    assert.equal(read.projections.values.sessionStats.steps, 3);
    assert.equal(read.state.active, false);
    assert.equal(read.opening.type, "snapshot");
    assert.equal(read.opening.cursor, events.at(-1).seq);
    assert.deepEqual(read.opening.projections, {
      asOfSeq: read.projections.asOfSeq, values: read.projections.values,
    });
    assert.equal(events.filter((event) => event.type === "turn/end").at(-1).data.reason.kind, "max-tokens");
    assert.ok(events.filter((event) => event.type === "user/message").every((event) =>
      event.surfaceOp === "append" && event.data.source.rpcId.startsWith("fixture-")));
    return events;
  }

  const hot = await start();
  const seeded = await hot.operation("seed");
  assert.ok(path.resolve(seeded.path).startsWith(`${temporary}${path.sep}`));
  const logBefore = await readFile(seeded.path);
  const hotRead = await hot.operation("read");
  const hotEvents = verify(hotRead);
  await hot.stop();
  assert.deepEqual(await readFile(seeded.path), logBefore);
  // Independent process: no opening or restoring an Agent before these reads.
  const cold = await start();
  const coldRead = await cold.operation("read");
  assert.deepEqual(verify(coldRead), hotEvents);
  assert.deepEqual(coldRead.projections, hotRead.projections);
  await cold.stop();
  assert.deepEqual(await readFile(seeded.path), logBefore);
  t.diagnostic(`Reused ${additions.length} official plugins; ${hotEvents.length} events preserved across paging and restart; no Agent or HTTP listener.`);
});
