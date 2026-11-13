import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { importRuntime, runtimeRoot as root } from "./runtime-fixture.mjs";

const { JsonRpcLineTransport } = await importRuntime("@deepseek-ai/dsh-sdk-protocol");
const { formatBoundedSessionMarkdown } = await importRuntime("./host-session-markdown.mjs");
const { boundedNativeSession, nativePagination } = await importRuntime("./host-session-native.mjs");
const provider = "lolicode-gateway";
const model = "lolicode-host-operations-fixture";
const cancelMethod = "lolicode/session/cancel";
const contextMethod = "lolicode/session/inject-legacy-context";
const execFileAsync = promisify(execFile);

function writeModelChunk(response, delta, finishReason = null) {
  const chunk = {
    id: "fixture-response",
    object: "chat.completion.chunk",
    created: 1700000000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function modelReply(response, content, finishReason = "stop") {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  writeModelChunk(response, { role: "assistant" });
  writeModelChunk(response, typeof content === "string" ? { content } : content);
  writeModelChunk(response, {}, finishReason);
  response.end("data: [DONE]\n\n");
}

function readColdMarkdown(sessions, id) {
  return execFileAsync(process.execPath, [
    path.join(root, "host-session-markdown.mjs"), sessions, id,
  ], { env: {}, windowsHide: true });
}

async function fixture(t, onModelCall, onHostRequest) {
  const parent = path.resolve(os.tmpdir());
  const prefix = "lolicode-harness-host-operations-";
  const temporary = await mkdtemp(path.join(parent, prefix));
  t.after(async () => {
    assert.equal(path.dirname(temporary), parent);
    assert.ok(path.basename(temporary).startsWith(prefix));
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const home = path.join(temporary, "home");
  const project = path.join(temporary, "project");
  await mkdir(home);
  await mkdir(project);

  let modelError;
  const http = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer test-lease");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.model, model);
      onModelCall(body, response);
    } catch (error) {
      modelError ??= error;
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    http.closeAllConnections();
    return new Promise((resolve) => http.close(resolve));
  });
  const gateway = path.join(temporary, "gateway.json");
  await writeFile(gateway, JSON.stringify([{
    id: "llm-pi-ai",
    config: { providers: { [provider]: {
      apiKeyEnv: "DSH_LOLICODE_GATEWAY_TOKEN",
      api: "openai-completions",
      baseURL: `http://127.0.0.1:${http.address().port}/v1`,
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
      models: [{ id: model, input: ["text"], contextWindow: 32768, maxTokens: 1024 }],
    } } },
  }]));

  return {
    home,
    project,
    get modelError() { return modelError; },
    async start({ userQuestions = false, pluginBundles = [], patchFiles = [], initialize = true, launchRoot = root } = {}) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(PATH|HOME|USERPROFILE|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|TMPDIR)$/i.test(key)));
      const child = spawn(process.execPath, [
        path.join(launchRoot, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
        "--profile", "sdk",
        ...pluginBundles.flatMap((name) => [
          "--patch", path.join(launchRoot, "node_modules", "@deepseek-ai", name, "cordis.patch.yml"),
        ]),
        ...patchFiles.flatMap(file => ["--patch", file]),
        "--patch", path.join(launchRoot, "profile.cordis.patch.yml"),
        "--patch", path.join(launchRoot, "host-operations.cordis.patch.yml"),
        "--patch", gateway,
      ], {
        cwd: project,
        env: {
          ...env,
          DSH_HOME: home,
          DSH_TELEMETRY_DISABLED: "1",
          DSH_LOLICODE_GATEWAY_TOKEN: "test-lease",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let diagnostics = "";
      child.stderr.on("data", (chunk) => (diagnostics += chunk));
      child.stdin.on("error", () => {});
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      t.after(async () => {
        child.kill();
        await exited;
      });
      const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
      const notifications = [];
      transport.onNotification((method, params) => notifications.push({ method, params }));
      if (onHostRequest) transport.onRequest(onHostRequest);
      transport.start();
      async function request(method, params = {}) {
        try {
          return await transport.request(method, params, t.signal);
        } catch (error) {
          if (modelError) throw modelError;
          if (diagnostics) error.message += `\n${diagnostics}`;
          throw error;
        }
      }
      if (initialize) {
        const ready = await request("initialize", { cwd: project, provider, model, approvalRequests: true, capabilities: { userQuestions } });
        assert.equal(ready.serverInfo.name, "deepseek-harness-sdk-runtime");
      }
      return {
        request,
        notifications,
        open: (sessionId) => request("session/working-directory/get", { sessionId }),
        prompt: (sessionId, text) => request("session/prompt", {
          sessionId, contentBlocks: [{ type: "text", text }],
        }),
        wait: (sessionId) => request("session/wait", { sessionId }),
        async shutdown() {
          assert.deepEqual(await request("shutdown"), {});
          assert.deepEqual(await exited, { code: 0, signal: null });
          transport.close();
        },
      };
    },
  };
}

test("native history crosses the official Gateway without flattening events or activating cold Agents", { timeout: 60_000 }, async (t) => {
  const sessionId = "native-history-root";
  const method = "lolicode/session/read-native";
  let modelCalls = 0;
  const runtime = await fixture(t, (_body, response) => {
    modelCalls++;
    modelReply(response, "Native session answer");
  });
  const client = await runtime.start();
  let live;
  try {
    await assert.rejects(client.request(method, { sessionId }), /not an open root/);
    await client.open(sessionId);
    await assert.rejects(client.request(method, { sessionId }), /LOLICODE_SESSION_LOG_MISSING/);
    for (const request of [{ maxMessages: 0 }, { beforeSeq: -1 }, { throughSeq: 2 ** 53 }, { principal: "owner" }]) {
      await assert.rejects(client.request(method, { sessionId, ...request }), /Invalid/);
    }
    await client.prompt(sessionId, "Keep the official event envelope");
    await client.wait(sessionId);
    live = await client.request(method, { sessionId, maxMessages: 200 });
    assert.equal(live.projections.kind, "sequenced");
    assert.equal(live.projections.values.turnOutline.length, 1);
    assert.equal(live.projections.values.sessionStats.turns, 1);
    assert.ok(live.page.records.some(({ event }) => event.type === "assistant/message" && event.data.stream));
    assert.ok(live.page.records.some(({ event }) => event.type === "user/message" && event.surfaceOp === "append"));
    assert.equal(live.page.records.filter(({ event }) => event.type === "turn/end").at(-1).event.data.reason.kind, "completed");
    await client.open("another-native-root");
    await assert.rejects(client.request(method, { sessionId, childSessionId: "another-native-root" }), /Worker is not owned/);
    assert.equal(await client.request(method, { sessionId, childSessionId: "not-resident" }), null);
  } finally {
    await client.shutdown();
  }
  const sessions = path.join(runtime.home, "sessions");
  const journal = (await readdir(sessions, { recursive: true })).find((entry) =>
    entry.split(path.sep).includes(sessionId) && /\.jsonl(?:\.zstd)?$/.test(entry));
  assert.ok(journal);
  const journalPath = path.join(sessions, journal);
  const bytesBefore = await readFile(journalPath);
  const mtimeBefore = (await stat(journalPath)).mtimeMs;
  const filesBefore = (await readdir(runtime.home, { recursive: true })).sort();
  const cold = await execFileAsync(process.execPath, [
    path.join(root, "host-session-native.mjs"), sessions, sessionId,
    JSON.stringify({ maxMessages: 200, throughSeq: live.page.cursor }),
  ], { env: {}, windowsHide: true, timeout: 45_000 });
  const restored = JSON.parse(cold.stdout);
  assert.deepEqual(restored.page, live.page);
  assert.equal(restored.state.active, false);
  assert.deepEqual(restored.projections, live.projections);
  assert.deepEqual(await readFile(journalPath), bytesBefore);
  assert.equal((await stat(journalPath)).mtimeMs, mtimeBefore);
  assert.deepEqual((await readdir(runtime.home, { recursive: true })).sort(), filesBefore);
  assert.equal(modelCalls, 1);
});

test("native history bounds pagination and rejects oversized values without truncation", () => {
  assert.deepEqual(nativePagination({}), { maxMessages: 50 });
  for (const request of [null, [], { maxMessages: 201 }, { beforeSeq: 0.5 }, { activate: true }]) {
    assert.throws(() => nativePagination(request), /Invalid/);
  }
  const value = { text: "x".repeat(8 * 1024 * 1024) };
  assert.throws(() => boundedNativeSession(value), /LOLICODE_SESSION_NATIVE_TOO_LARGE/);
});

test("passive native followers retain official transient attempts and committed events without starting work", { timeout: 60_000 }, async (t) => {
  const sessionId = "native-follow-root";
  const method = "lolicode/session.native-follow";
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const later = "33333333-3333-4333-8333-333333333333";
  const waiting = Promise.withResolvers();
  let modelCalls = 0;
  let response;
  const runtime = await fixture(t, (_body, output) => {
    if (++modelCalls === 2) {
      output.writeHead(200, { "Content-Type": "text/event-stream" });
      writeModelChunk(output, { role: "assistant" });
      writeModelChunk(output, { content: "Transient follow fixture answer" });
      waiting.resolve(output);
    } else modelReply(output, `Committed follow answer ${modelCalls}`);
  });
  const client = await runtime.start();
  const notices = (id) => client.notifications.filter((item) => item.method === method && item.params.subscriptionId === id);
  const follow = (subscriptionId, extra = {}) => client.request("lolicode/session/follow-native", {
    sessionId, subscriptionId, maxMessages: 200, ...extra,
  });
  const stop = (subscriptionId) => client.request("lolicode/session/unfollow-native", { subscriptionId });
  try {
    await assert.rejects(follow(first), /not an open root/);
    await client.open(sessionId);
    await follow(first);
    const pending = await fixtureNotice(client, method, (notice) => notice.subscriptionId === first && notice.frame?.type === "snapshot");
    assert.equal(pending.frame.header.id, sessionId);
    assert.equal(modelCalls, 0, "opening a native watch must not activate a turn");
    assert.ok(pending.frame.assistantStream);
    await stop(first);
    client.notifications.splice(0);
    await client.prompt(sessionId, "Create a committed baseline");
    await client.wait(sessionId);
    await assert.rejects(follow(first, { activate: true }), /Invalid/);
    await assert.rejects(follow(first, { principal: "owner" }), /Invalid/);
    const duplicates = await Promise.allSettled([follow(first), follow(first)]);
    assert.equal(duplicates.filter((result) => result.status === "fulfilled").length, 1);
    assert.match(duplicates.find((result) => result.status === "rejected").reason.message, /already exists/);
    await follow(second);
    const openingA = await fixtureNotice(client, method, (notice) => notice.subscriptionId === first && notice.frame?.type === "snapshot");
    const openingB = await fixtureNotice(client, method, (notice) => notice.subscriptionId === second && notice.frame?.type === "snapshot");
    assert.deepEqual(openingA.frame, openingB.frame);
    assert.equal(modelCalls, 1);
    await assert.rejects(follow(first), /already exists/);
    await client.prompt(sessionId, "Hold this model response open");
    response = await waiting.promise;
    await fixtureNotice(client, method, (notice) => notice.subscriptionId === second && notice.frame?.event?.type === "turn/start");
    const transient = await fixtureNotice(client, method, (notice) => notice.subscriptionId === second &&
      notice.frame?.type === "assistant-stream" && JSON.stringify(notice.frame).includes("Transient follow fixture answer"));
    assert.ok(transient.frame.frame);
    assert.ok(!notices(second).some((notice) => notice.frame?.event?.type === "assistant/message" &&
      JSON.stringify(notice.frame.event.data.message).includes("Transient follow fixture answer")));
    const midAttempt = "native-follow-mid-attempt";
    await follow(midAttempt);
    const reconnect = await fixtureNotice(client, method, (notice) => notice.subscriptionId === midAttempt && notice.frame?.type === "snapshot");
    assert.ok(reconnect.frame.assistantStream.activeAttempt, "reopening while a model response is pending retains its official attempt baseline");
    assert.ok(JSON.stringify(reconnect.frame.assistantStream).includes("Transient follow fixture answer"));
    await stop(midAttempt);
    await stop(first);
    const stoppedCount = notices(first).length;
    writeModelChunk(response, {}, "stop");
    response.end("data: [DONE]\n\n");
    await client.wait(sessionId);
    const committed = await fixtureNotice(client, method, (notice) => notice.subscriptionId === second &&
      notice.frame?.event?.type === "assistant/message" && JSON.stringify(notice.frame.event.data.message).includes("Transient follow fixture answer"));
    assert.ok(committed.frame.event.data.stream.length > 0);
    assert.equal(notices(first).length, stoppedCount);
    await fixtureNotice(client, method, (notice) => notice.subscriptionId === second &&
      notice.frame?.type === "assistant-stream" && notice.frame.frame.type === "end");
    await follow(later);
    const replacement = await fixtureNotice(client, method, (notice) => notice.subscriptionId === later && notice.frame?.type === "snapshot");
    assert.ok(replacement.frame.records.some((record) => record.event.seq === committed.frame.event.seq));
    assert.equal(modelCalls, 2);
    const remaining = Array.from({ length: 6 }, (_, index) => `native-follow-limit-${index}`);
    try {
      await Promise.all(remaining.map((id) => follow(id)));
      await assert.rejects(follow("native-follow-over-limit"), /Too many native subscriptions/);
    } finally {
      await Promise.all(remaining.map((id) => stop(id)));
    }
    await stop(second);
    await stop(first); // closing twice is harmless
  } finally {
    if (response && !response.writableEnded) response.destroy();
    await Promise.allSettled([stop(first), stop(second)]);
    // Keep the later subscription active: SDK disposal must abort and await it.
    await client.shutdown();
  }
});

test("a native watch opened during the first model response retains the official active attempt prefix", { timeout: 60_000 }, async (t) => {
  const sessionId = "native-first-attempt-root";
  const subscriptionId = "native-late-first-view";
  const ready = Promise.withResolvers();
  let output;
  let modelCalls = 0;
  const runtime = await fixture(t, (_body, response) => {
    modelCalls++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    writeModelChunk(response, { role: "assistant" });
    writeModelChunk(response, { content: "First attempt prefix before viewer" });
    output = response;
    ready.resolve();
  });
  const client = await runtime.start();
  const method = "lolicode/session.native-follow";
  try {
    await client.open(sessionId);
    await client.prompt(sessionId, "Start before the first native viewer opens");
    await ready.promise;
    // The SDK's stock transient notification confirms it consumed the chunk;
    // no native read or native follow has been issued yet.
    await fixtureNotice(client, "lolicode/session.assistant-stream", (notice) =>
      notice.sessionId === sessionId && JSON.stringify(notice).includes("First attempt prefix before viewer"));
    await client.request("lolicode/session/follow-native", { sessionId, subscriptionId, maxMessages: 12 });
    const opening = await fixtureNotice(client, method, (notice) => notice.subscriptionId === subscriptionId && notice.frame?.type === "snapshot");
    assert.ok(opening.frame.assistantStream.activeAttempt);
    assert.ok(JSON.stringify(opening.frame.assistantStream).includes("First attempt prefix before viewer"));
    assert.equal(modelCalls, 1);
    writeModelChunk(output, { content: " plus the suffix" });
    writeModelChunk(output, {}, "stop");
    output.end("data: [DONE]\n\n");
    await client.wait(sessionId);
    const committed = await fixtureNotice(client, method, (notice) => notice.subscriptionId === subscriptionId &&
      notice.frame?.event?.type === "assistant/message");
    assert.ok(JSON.stringify(committed.frame.event.data.message).includes("First attempt prefix before viewer plus the suffix"));
    assert.ok(committed.frame.event.data.stream.length > 0);
    assert.equal(modelCalls, 1);
  } finally {
    if (output && !output.writableEnded) output.destroy();
    await client.request("lolicode/session/unfollow-native", { subscriptionId }).catch(() => {});
    await client.shutdown();
  }
});

test("runtime preparation creates no Agent, model request or history and preserves the first native stream prefix", { timeout: 60_000 }, async (t) => {
  const sessionId = "prepared-runtime-first-root";
  const subscriptionId = "prepared-runtime-first-watch";
  const ready = Promise.withResolvers();
  let modelCalls = 0;
  let output;
  const runtime = await fixture(t, (_body, response) => {
    modelCalls++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    writeModelChunk(response, { role: "assistant" });
    writeModelChunk(response, { content: "Prepared runtime stream prefix" });
    output = response;
    ready.resolve();
  });
  const monitor = path.join(runtime.home, "preparation-counts.json");
  const plugin = path.join(runtime.home, "preparation-monitor.mjs");
  const patch = path.join(runtime.home, "preparation-monitor.json");
  await writeFile(plugin, `import { writeFileSync } from "node:fs";\nexport const inject = ["agents", "sessions"];\nexport function apply(ctx) { let createdAgents = 0, createdSessions = 0; const report = () => writeFileSync(${JSON.stringify(monitor)}, JSON.stringify({ agents: ctx.agents.list().length, sessions: ctx.sessions.list().length, createdAgents, createdSessions })); ctx.on("agent/created", () => { createdAgents++; report(); }); ctx.on("session/created", () => { createdSessions++; report(); }); report(); }\n`);
  await writeFile(patch, JSON.stringify([{ insert: [{ id: "fixture-preparation-monitor", name: plugin }] }]));
  const client = await runtime.start({ patchFiles: [patch], initialize: false });
  const method = "lolicode/runtime/prepare";
  const counts = async () => JSON.parse(await readFile(monitor, "utf8"));
  const journals = async () => (await readdir(runtime.home, { recursive: true })).filter(entry =>
    entry.split(path.sep).includes("sessions") || /\.jsonl(?:\.zstd)?$/.test(entry)).sort();
  try {
    await assert.rejects(client.request(method, {}), /not initialized/);
    await client.request("initialize", { cwd: runtime.project, provider, model, approvalRequests: true, capabilities: { userQuestions: true } });
    assert.deepEqual(await counts(), { agents: 0, sessions: 0, createdAgents: 0, createdSessions: 0 });
    const before = await journals();
    // The official carrier canonicalizes non-object params to {} before
    // dispatch. The private method accepts no session, activation or route.
    for (const params of [{ sessionId }, { activate: true }, { provider }]) {
      await assert.rejects(client.request(method, params), /Invalid LoliCode runtime preparation/);
    }
    const firstAt = performance.now();
    assert.deepEqual(await client.request(method, {}), {});
    const firstMs = performance.now() - firstAt;
    const repeatAt = performance.now();
    const repeats = await Promise.all(Array.from({ length: 4 }, () => client.request(method, {})));
    const repeatedMs = performance.now() - repeatAt;
    assert.deepEqual(repeats, [{}, {}, {}, {}]);
    assert.deepEqual(await counts(), { agents: 0, sessions: 0, createdAgents: 0, createdSessions: 0 });
    assert.deepEqual(await journals(), before);
    assert.equal(modelCalls, 0);
    assert.equal(client.notifications.filter(({ method }) => method === "session.event").length, 0);
    t.diagnostic(`runtime prepare first=${firstMs.toFixed(1)}ms, four cached RPCs=${repeatedMs.toFixed(1)}ms`);
    await client.open(sessionId);
    assert.equal((await counts()).agents, 1);
    await client.prompt(sessionId, "Start only after runtime preparation completes.");
    await ready.promise;
    await fixtureNotice(client, "lolicode/session.assistant-stream", notice => notice.sessionId === sessionId &&
      JSON.stringify(notice).includes("Prepared runtime stream prefix"));
    await client.request("lolicode/session/follow-native", { sessionId, subscriptionId, maxMessages: 12 });
    const opening = await fixtureNotice(client, "lolicode/session.native-follow", notice =>
      notice.subscriptionId === subscriptionId && notice.frame?.type === "snapshot");
    assert.ok(opening.frame.assistantStream.activeAttempt);
    assert.ok(JSON.stringify(opening.frame.assistantStream).includes("Prepared runtime stream prefix"));
    writeModelChunk(output, { content: " and committed suffix" });
    writeModelChunk(output, {}, "stop");
    output.end("data: [DONE]\n\n");
    await client.wait(sessionId);
    const committed = await fixtureNotice(client, "lolicode/session.native-follow", notice =>
      notice.subscriptionId === subscriptionId && notice.frame?.event?.type === "assistant/message");
    assert.ok(JSON.stringify(committed.frame.event.data.message).includes("Prepared runtime stream prefix and committed suffix"));
    assert.ok(committed.frame.event.data.stream.length > 0);
    assert.equal(modelCalls, 1);
    assert.equal(runtime.modelError, undefined);
  } finally {
    if (output && !output.writableEnded) output.destroy();
    await client.request("lolicode/session/unfollow-native", { subscriptionId }).catch(() => {});
    await client.shutdown();
  }
});

test("Markdown copies a complete native log live or cold without starting another turn or writing", { timeout: 45_000 }, async (t) => {
  const sessionId = "markdown-test-root";
  const method = "lolicode/session/read-markdown";
  const prompts = ["First Markdown fixture prompt", "Second Markdown fixture prompt"];
  const answers = ["First Markdown fixture answer", "Second Markdown fixture answer"];
  let modelCalls = 0;
  const runtime = await fixture(t, (_body, response) => modelReply(response, answers[modelCalls++]));
  const client = await runtime.start();
  let liveMarkdown;
  try {
    await assert.rejects(client.request(method, { sessionId }), /not an open root/);
    await client.open(sessionId);
    await assert.rejects(client.request(method, { sessionId }), /LOLICODE_SESSION_LOG_MISSING/);
    await client.open("another-root");
    await assert.rejects(client.request(method, { sessionId, childSessionId: "another-root" }), /Worker is not owned/);
    await assert.rejects(client.request(method, { sessionId, childSessionId: "not-resident" }), /LOLICODE_SESSION_LOG_COLD/);
    for (const prompt of prompts) {
      await client.prompt(sessionId, prompt);
      await client.wait(sessionId);
    }
    liveMarkdown = await client.request(method, { sessionId });
    assert.match(liveMarkdown, /^# [^\n]+\n\nSession file:\n/);
    let previous = -1;
    for (const marker of [prompts[0], answers[0], prompts[1], answers[1]]) {
      const position = liveMarkdown.indexOf(marker);
      assert.ok(position > previous, `Expected ${marker} in chronological order`);
      previous = position;
    }
  } finally {
    await client.shutdown();
  }

  const sessions = path.join(runtime.home, "sessions");
  const journal = (await readdir(sessions, { recursive: true })).find((entry) =>
    entry.split(path.sep).includes(sessionId) && /\.jsonl(?:\.zstd)?$/.test(entry));
  assert.ok(journal);
  const journalPath = path.join(sessions, journal);
  const beforeFiles = (await readdir(runtime.home, { recursive: true })).sort();
  const before = await readFile(journalPath);
  const beforeMtime = (await stat(journalPath)).mtimeMs;
  assert.equal((await readColdMarkdown(sessions, sessionId)).stdout, liveMarkdown);
  await assert.rejects(readColdMarkdown(sessions, "no-such-log"), {
    code: 2, stdout: "", stderr: "LOLICODE_SESSION_LOG_MISSING\n",
  });
  await assert.rejects(readColdMarkdown(sessions, "../outside"), {
    code: 1, stdout: "", stderr: "LOLICODE_SESSION_LOG_UNREADABLE\n",
  });
  assert.deepEqual(await readFile(journalPath), before);
  assert.equal((await stat(journalPath)).mtimeMs, beforeMtime);
  assert.deepEqual((await readdir(runtime.home, { recursive: true })).sort(), beforeFiles);
  assert.equal(modelCalls, 2);
  await writeFile(journalPath, "intentionally corrupt SDK test journal");
  await assert.rejects(readColdMarkdown(sessions, sessionId), {
    code: 1, stdout: "", stderr: "LOLICODE_SESSION_LOG_UNREADABLE\n",
  });
});

test("Markdown reads an owned active worker without copying the transient assistant stream", { timeout: 45_000 }, async (t) => {
  const sessionId = "markdown-worker-owner";
  const otherRoot = "markdown-worker-other-root";
  const childSessionId = "8486c14d-29fd-4b4d-9ee7-3a03bc432c71";
  const method = "lolicode/session/read-markdown";
  const input = "Markdown worker committed prompt";
  const draft = "Markdown worker assistant stream";
  const first = Promise.withResolvers();
  let modelCalls = 0;
  const runtime = await fixture(t, (_body, response) => {
    modelCalls += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    writeModelChunk(response, { role: "assistant" });
    writeModelChunk(response, { content: draft });
    first.resolve(response);
  });
  const client = await runtime.start();
  let response;
  try {
    await client.open(sessionId);
    await client.open(otherRoot);
    await client.request("lolicode/session/configure-secretary", { sessionId });
    await client.request("lolicode/secretary/delegate-worker", {
      sessionId, childSessionId, label: "Markdown fixture worker", content: [{ type: "text", text: input }],
    });
    response = await first.promise;
    await fixtureNotice(client, "lolicode/session.assistant-stream", ({ sessionId, frame }) =>
      sessionId === childSessionId && frame.type === "chunk" && frame.chunk.type === "text-delta" &&
      frame.chunk.text === draft);
    await assert.rejects(client.request(method, { sessionId: otherRoot, childSessionId }), /Worker is not owned/);
    const activeMarkdown = await client.request(method, { sessionId, childSessionId });
    assert.ok(activeMarkdown.includes(input));
    assert.ok(!activeMarkdown.includes(draft));
    const nativeMethod = "lolicode/session/read-native";
    await assert.rejects(client.request(nativeMethod, { sessionId: otherRoot, childSessionId }), /Worker is not owned/);
    const activeNative = await client.request(nativeMethod, { sessionId, childSessionId, maxMessages: 200 });
    assert.ok(JSON.stringify(activeNative.page.records).includes(input));
    assert.ok(!JSON.stringify(activeNative.page.records).includes(draft));
    assert.equal(activeNative.state.active, true);
    assert.equal(modelCalls, 1);
    writeModelChunk(response, {}, "stop");
    response.end("data: [DONE]\n\n");
    await client.wait(sessionId);
    await assert.rejects(client.request(method, { sessionId, childSessionId }), /LOLICODE_SESSION_LOG_COLD/);
    const completed = await readColdMarkdown(path.join(runtime.home, "sessions"), childSessionId);
    assert.ok(completed.stdout.includes(draft));
    const coldNative = await execFileAsync(process.execPath, [
      path.join(root, "host-session-native.mjs"), path.join(runtime.home, "sessions"), childSessionId,
      JSON.stringify({ maxMessages: 200 }),
    ], { env: {}, windowsHide: true, timeout: 45_000 });
    const nativeChild = JSON.parse(coldNative.stdout);
    assert.ok(JSON.stringify(nativeChild.page.records).includes(draft));
    assert.equal(nativeChild.state.active, false);
    assert.equal(modelCalls, 1);
  } finally {
    if (response && !response.writableEnded) response.destroy();
    await client.shutdown();
  }
});

test("Markdown rejects both UTF-8 and JSON frame overflow in full", () => {
  const limit = /LOLICODE_SESSION_MARKDOWN_TOO_LARGE/;
  assert.throws(() => formatBoundedSessionMarkdown([], "界".repeat(3 * 1024 * 1024)), limit);
  assert.throws(() => formatBoundedSessionMarkdown([], "\u0000".repeat(6 * 1024 * 1024)), limit);
});

test("host-approved MCP calls use upstream tool execution and canonical results", { timeout: 45_000 }, async (t) => {
  const sessionId = "mcp-test-root";
  const toolName = "mcp_fixture_lookup_2ef5f3200d31";
  const callId = "call_fixture_lookup";
  const calls = [];
  let resultSeen = false;
  const runtime = await fixture(t, (body, response) => {
    const result = body.messages.find((message) => message.role === "tool");
    if (result) {
      assert.match(JSON.stringify(result.content), /fixture host result/);
      resultSeen = true;
      modelReply(response, "The configured MCP tool ran.");
      return;
    }
    assert.ok(body.tools.some((tool) => tool.function.name === toolName));
    modelReply(response, { tool_calls: [{ index: 0, id: callId, type: "function", function: {
      name: toolName, arguments: JSON.stringify({ query: "approved query" }),
    } }] }, "tool_calls");
  }, async (method, params) => {
    assert.equal(method, "lolicode/mcp/approve-and-call");
    calls.push(params);
    return { content: [{ type: "text", text: "fixture host result" }] };
  });
  const client = await runtime.start();
  await client.open(sessionId);
  assert.deepEqual(await client.request("lolicode/session/configure-mcp", { sessionId, tools: [{
    function: { name: toolName, description: "Look up an approved fixture", parameters: {
      type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
    } },
  }] }), { registered: 1 });
  assert.deepEqual(calls, []);
  await client.prompt(sessionId, "Use the MCP lookup tool.");
  await client.wait(sessionId);
  assert.equal(resultSeen, true);
  assert.deepEqual(calls, [{ sessionId, callId, toolName, arguments: { query: "approved query" } }]);
  await client.shutdown();
});

test("product tool registration preserves its name and host execution", { timeout: 45_000 }, async (t) => {
  const sessionId = "product-tool-root";
  const name = "propose_automation";
  let submitted;
  const runtime = await fixture(t, (body, response) => {
    assert.ok(body.tools.some(tool => tool.function.name === name));
    const result = body.messages.find(message => message.role === "tool");
    if (result) {
      assert.match(JSON.stringify(result.content), /proposal recorded/);
      modelReply(response, "Proposal ready.");
      return;
    }
    modelReply(response, { tool_calls: [{ index: 0, id: "proposal-fixture", type: "function", function: {
      name, arguments: JSON.stringify({ title: "Daily fixture" }),
    } }] }, "tool_calls");
  }, async (method, params) => {
    assert.equal(method, "lolicode/mcp/approve-and-call");
    submitted = params;
    return { content: [{ type: "text", text: "proposal recorded" }], isError: false };
  });
  const client = await runtime.start();
  try {
    await client.open(sessionId);
    await client.request("lolicode/session/configure-workspace", {
      sessionId, workspace: { policy: "review", skills: [], memory: "" },
    });
    assert.deepEqual(await client.request("lolicode/session/configure-tools", {
      sessionId,
      tools: [{ function: { name, parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } } }],
    }), { registered: 1 });
    await client.prompt(sessionId, "Record the application proposal.");
    await client.wait(sessionId);
    if (runtime.modelError) throw runtime.modelError;
    assert.deepEqual(submitted, { sessionId, callId: "proposal-fixture", toolName: name, arguments: { title: "Daily fixture" }, workspacePolicy: "review" });
  } finally {
    await client.shutdown();
  }
});

for (const searchConfigured of [false, true]) {
  test(`public web tools route to the host when search is ${searchConfigured ? "configured" : "unconfigured"}`, { timeout: 45_000 }, async (t) => {
    const sessionId = "public-web-tool-root";
    const calls = [];
    const requests = [{ name: "web_fetch", arguments: { url: "https://example.test/reference" } }];
    if (searchConfigured) requests.push({ name: "web_search", arguments: { query: "public reference" } });
    const runtime = await fixture(t, (body, response) => {
      const names = body.tools.map(tool => tool.function.name)
        .filter(name => name === "web_fetch" || name === "web_search");
      assert.deepEqual(names.sort(), requests.map(request => request.name));
      const next = requests.find(({ name }) => !body.messages.some(message =>
        message.role === "tool" && message.tool_call_id === `host-${name}`));
      if (!next) {
        assert.equal(body.messages.filter(message =>
          message.role === "tool" && JSON.stringify(message.content).includes("public fixture")).length, requests.length);
        modelReply(response, "Public web results received.");
        return;
      }
      modelReply(response, { tool_calls: [{ index: 0, id: `host-${next.name}`, type: "function", function: {
        name: next.name, arguments: JSON.stringify(next.arguments),
      } }] }, "tool_calls");
    }, async (method, params) => {
      assert.equal(method, "lolicode/mcp/approve-and-call");
      calls.push(params);
      return { content: [{ type: "text", text: "public fixture" }], isError: false };
    });
    const client = await runtime.start();
    try {
      await client.open(sessionId);
      await client.request("lolicode/session/configure-workspace", {
        sessionId, workspace: { policy: "review", skills: [], memory: "" },
      });
      const tools = requests.map(({ name, arguments: args }) => {
        const field = Object.keys(args)[0];
        return { function: {
          name, parameters: { type: "object", properties: { [field]: { type: "string" } }, required: [field] },
        } };
      });
      assert.deepEqual(await client.request("lolicode/session/configure-tools", {
        sessionId, tools,
      }), { registered: tools.length });
      await client.prompt(sessionId, "Read the configured public sources.");
      await client.wait(sessionId);
      if (runtime.modelError) throw runtime.modelError;
      assert.deepEqual(calls, requests.map(({ name, arguments: args }) => ({
        sessionId, callId: `host-${name}`, toolName: name, arguments: args, workspacePolicy: "review",
      })));
    } finally {
      await client.shutdown();
    }
  });
}

test("model memory updates use the host approval path", { timeout: 45_000 }, async (t) => {
  const sessionId = "model-memory-root";
  const input = { scope: "project", action: "add", content: "Tests use the local fixture." };
  let submitted;
  const runtime = await fixture(t, (body, response) => {
    assert.equal(body.tools.filter(tool => tool.function.name === "memory").length, 1);
    const result = body.messages.find(message => message.role === "tool");
    if (result) {
      assert.match(JSON.stringify(result.content), /memory saved by host/);
      modelReply(response, "Memory saved.");
      return;
    }
    modelReply(response, { tool_calls: [{ index: 0, id: "save-memory", type: "function", function: {
      name: "memory", arguments: JSON.stringify(input),
    } }] }, "tool_calls");
  }, async (method, params) => {
    assert.equal(method, "lolicode/mcp/approve-and-call");
    submitted = params;
    return { content: [{ type: "text", text: "memory saved by host" }], isError: false };
  });
  const client = await runtime.start();
  try {
    await client.open(sessionId);
    await client.request("lolicode/session/configure-workspace", {
      sessionId, workspace: { policy: "review", skills: [], memory: "" },
    });
    const fields = ["scope", "action", "content", "old_text"];
    assert.deepEqual(await client.request("lolicode/session/configure-tools", {
      sessionId, tools: [{ function: {
        name: "memory", parameters: {
          type: "object",
          properties: Object.fromEntries(fields.map(field => [field, { type: "string" }])),
          required: ["scope", "action"], additionalProperties: false,
        },
      } }],
    }), { registered: 1 });
    await client.prompt(sessionId, "Remember this project convention.");
    await client.wait(sessionId);
    if (runtime.modelError) throw runtime.modelError;
    assert.deepEqual(submitted, {
      sessionId, callId: "save-memory", toolName: "memory", arguments: input, workspacePolicy: "review",
    });
  } finally {
    await client.shutdown();
  }
});

test("host tool policy follows the admitted root and worker scope", { timeout: 45_000 }, async (t) => {
  const sessionId = "host-tool-policy-root";
  const reviewed = "8486c14d-29fd-4b4d-9ee7-3a03bc432c63";
  const name = "fixture_policy_tool";
  const calls = [];
  const runtime = await fixture(t, (body, response) => {
    const prompt = JSON.stringify(body.messages.filter(message => message.role === "user"));
    const hasResult = id => body.messages.some(message => message.role === "tool" && message.tool_call_id === id);
    const call = (id, tool, args) => modelReply(response, { tool_calls: [{ index: 0, id, type: "function", function: {
      name: tool, arguments: JSON.stringify(args),
    } }] }, "tool_calls");
    if (prompt.includes("FULL_NATIVE_WORKER") || prompt.includes("REVIEW_HOST_WORKER")) {
      if (hasResult("fixture_scoped_call")) return modelReply(response, "Scoped host tool completed.");
      return call("fixture_scoped_call", name, { workspacePolicy: "full" });
    }
    if (hasResult("fixture_delegate")) return modelReply(response, "Native worker delegated.");
    return call("fixture_delegate", "subagent", { description: "Check inherited policy", prompt: "FULL_NATIVE_WORKER" });
  }, async (method, params) => {
    assert.equal(method, "lolicode/mcp/approve-and-call");
    calls.push(params);
    return { content: [{ type: "text", text: "Scoped tool result." }], isError: false };
  });
  const client = await runtime.start();
  try {
    await client.open(sessionId);
    await client.request("lolicode/session/configure-secretary", { sessionId });
    await client.request("lolicode/session/configure-workspace", {
      sessionId, workspace: { policy: "full", skills: [], memory: "" },
    });
    assert.deepEqual(await client.request("lolicode/session/configure-tools", {
      sessionId, tools: [{ function: {
        name, parameters: { type: "object", properties: { workspacePolicy: { type: "string" } }, required: ["workspacePolicy"] },
      } }],
    }), { registered: 1 });
    await client.request("lolicode/secretary/delegate-worker", {
      sessionId, childSessionId: reviewed, label: "Reviewed worker", workspacePolicy: "review",
      content: [{ type: "text", text: "REVIEW_HOST_WORKER" }],
    });
    await client.wait(sessionId);
    await client.prompt(sessionId, "Start a native worker.");
    await client.wait(sessionId);
    if (runtime.modelError) throw runtime.modelError;
    const nativeChild = client.notifications.find(({ method, params }) =>
      method === "subagent.started" && params.childSessionId !== reviewed);
    assert.ok(nativeChild);
    assert.deepEqual(calls.map(call => [call.sessionId, call.workspacePolicy, call.arguments.workspacePolicy]), [
      [reviewed, "review", "full"],
      [nativeChild.params.childSessionId, "full", "full"],
    ]);
  } finally {
    await client.shutdown();
  }
});

test("a remote root and its genuine child use only remote host tools", { timeout: 55_000 }, async (t) => {
  const sessionId = "remote-workspace";
  const workerPrompt = "Read the remote fixture";
  const calls = [];
  let readReturned = false;
  let localCallDenied = false;
  let waitReturned = false;
  const schemas = [
    { name: "mcp_remote_read_file", properties: { path: { type: "string" } }, required: ["path"] },
    { name: "mcp_remote_write_file", properties: {
      path: { type: "string" },
      content: { type: "string" },
      expected_content: { type: ["string", "null"] },
    }, required: ["path", "content", "expected_content"] },
  ].map(({ name, properties, required }) => ({
    function: { name, parameters: { type: "object", properties, required, additionalProperties: false } },
  }));
  function toolCall(response, name, args) {
    modelReply(response, { tool_calls: [{ index: 0, id: `fixture_${name}`, type: "function", function: {
      name, arguments: JSON.stringify(args),
    } }] }, "tool_calls");
  }
  const runtime = await fixture(t, (body, response) => {
    const toolNames = body.tools.map(tool => tool.function.name);
    assert.ok(toolNames.includes("mcp_remote_read_file"));
    assert.ok(toolNames.includes("mcp_remote_write_file"));
    assert.ok(toolNames.includes("wait_agent"), "Remote agents retain the official inbox wait tool");
    assert.ok(!toolNames.includes("write"));
    assert.ok(!toolNames.includes("read"));
    assert.ok(!toolNames.includes("bash"));
    assert.ok(!toolNames.includes("pwsh"));
    assert.match(JSON.stringify(body.messages), /remote workspace/i);
    const toolResults = body.messages.filter(message => message.role === "tool");
    const hasResult = id => toolResults.find(message => message.tool_call_id === id);
    if (body.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(workerPrompt))) {
      const result = hasResult("fixture_mcp_remote_read_file");
      if (!result) return toolCall(response, "mcp_remote_read_file", { path: "probe.txt" });
      assert.match(JSON.stringify(result.content), /remote fixture receipt/);
      readReturned = true;
      return modelReply(response, "The remote worker read its file.");
    }
    if (!hasResult("fixture_write")) {
      return toolCall(response, "write", { path: "no-local-fallback.txt", content: "must not be written" });
    }
    assert.doesNotMatch(JSON.stringify(hasResult("fixture_write").content), /successfully wrote/i);
    localCallDenied = true;
    if (!hasResult("fixture_subagent")) {
      return toolCall(response, "subagent", { description: "Remote read fixture", prompt: workerPrompt });
    }
    if (!hasResult("fixture_wait_agent")) return toolCall(response, "wait_agent", { timeout_ms: 10_000 });
    assert.match(JSON.stringify(hasResult("fixture_wait_agent").content), /timedOut/);
    waitReturned = true;
    return modelReply(response, "The remote task is delegated.");
  }, async (method, params) => {
    assert.equal(method, "lolicode/mcp/approve-and-call");
    calls.push(params);
    return { content: [{ type: "text", text: "remote fixture receipt" }], isError: false };
  });
  const client = await runtime.start();
  try {
    await client.open(sessionId);
    assert.deepEqual(await client.request("lolicode/session/configure-remote", {
      sessionId, tools: schemas, location: { name: "Fixture SSH", root: "/tmp/remote-fixture" },
    }), { registered: schemas.length });
    await client.prompt(sessionId, "Delegate a read in this remote workspace.");
    await client.wait(sessionId);
    if (runtime.modelError) throw runtime.modelError;
    assert.ok(localCallDenied);
    assert.ok(waitReturned);
    assert.ok(readReturned, JSON.stringify(client.notifications.filter(event =>
      ["subagent.started", "subagent.finished", "lolicode/session.assistant-stream"].includes(event.method)
    )));
    const worker = client.notifications.find(event => event.method === "subagent.started");
    assert.equal(worker.params.parentSessionId, sessionId);
    assert.deepEqual(calls, [{
      sessionId: worker.params.childSessionId,
      callId: "fixture_mcp_remote_read_file",
      toolName: "mcp_remote_read_file",
      arguments: { path: "probe.txt" },
    }]);
    await assert.rejects(access(path.join(runtime.project, "no-local-fallback.txt")), { code: "ENOENT" });
  } finally {
    await client.shutdown();
  }
});

test("manual secretary work starts one native child and follows up after restart", { timeout: 60_000 }, async (t) => {
  const sessionId = "manual-secretary";
  const childSessionId = "8486c14d-29fd-4b4d-9ee7-3a03bc432c60";
  const title = "Manual child fixture";
  const initial = "Complete the fixture worker task";
  const followup = "Check the same fixture again";
  const modelCalls = [];
  const runtime = await fixture(t, (body, response) => {
    const input = JSON.stringify(body.messages);
    assert.match(input, new RegExp(initial));
    assert.match(input, /Current working directory:.+second-project/);
    assert.doesNotMatch(input, /You are the user's LoliCode secretary/);
    if (input.includes(followup)) {
      assert.match(input, /first worker answer/);
      modelReply(response, "second worker answer");
    } else {
      modelReply(response, "first worker answer");
    }
    modelCalls.push(input);
  });
  const target = path.join(path.dirname(runtime.project), "second-project");
  await mkdir(target);
  let client = await runtime.start();
  await client.open(sessionId);
  const delegate = { sessionId, childSessionId, label: title, cwd: target, workspacePolicy: "review", content: [{ type: "text", text: initial }] };
  await assert.rejects(client.request("lolicode/secretary/delegate-worker", delegate), /configured secretary/);
  await client.request("lolicode/session/configure-secretary", { sessionId });
  assert.equal((await client.request("lolicode/secretary/delegate-worker", delegate)).childSessionId, childSessionId);
  await client.wait(sessionId);
  assert.ok(client.notifications.some(({ method, params }) =>
    method === "session.event" && params.sessionId === childSessionId &&
    params.event.type === "working-directory/change" &&
    path.normalize(params.event.data.cwd) === path.normalize(target)),
  JSON.stringify(client.notifications.filter(({ method, params }) =>
    ["subagent.started", "subagent.finished", "lolicode/subagent.directory"].includes(method) ||
    params.event?.type === "working-directory/change")));
  assert.ok(client.notifications.some(({ method, params }) =>
    method === "subagent.finished" && params.childSessionId === childSessionId && params.status === "ok"));
  await client.shutdown();

  client = await runtime.start();
  const foreignSecretary = "unrelated-manual-secretary";
  await client.open(foreignSecretary);
  await client.request("lolicode/session/configure-secretary", { sessionId: foreignSecretary });
  const beforeForeignPrompt = await readColdMarkdown(path.join(runtime.home, "sessions"), childSessionId);
  await assert.rejects(client.request("lolicode/secretary/prompt-worker", {
    sessionId: foreignSecretary, childSessionId, requestId: "foreign-cold-worker-prompt",
    workspacePolicy: "full", content: [{ type: "text", text: "UNAUTHORIZED_WORKER_INPUT" }],
  }), /Invalid worker parent/);
  assert.equal(modelCalls.length, 1);
  assert.equal((await readColdMarkdown(path.join(runtime.home, "sessions"), childSessionId)).stdout, beforeForeignPrompt.stdout);
  assert.ok(!client.notifications.some(({ params }) => params.sessionId === childSessionId || params.childSessionId === childSessionId));
  await client.request("session/resume", { sessionId });
  await client.request("lolicode/session/configure-secretary", { sessionId });
  assert.deepEqual(await client.request("lolicode/secretary/delegate-worker", delegate), { childSessionId });
  const prompt = await client.request("lolicode/secretary/prompt-worker", {
    sessionId, childSessionId, requestId: "host-followup-one", content: [{ type: "text", text: followup }],
  });
  assert.ok(prompt.messageId);
  await client.wait(sessionId);
  assert.equal(modelCalls.length, 2);
  assert.ok(client.notifications.some(({ method, params }) =>
    method === "session.event" && params.sessionId === childSessionId &&
    params.event.type === "user/message" && params.event.data.source.rpcId === "host-followup-one"));
  await client.shutdown();
});

test("worker queue edits and direct steering use the child's own live inbox", { timeout: 60_000 }, async (t) => {
  const sessionId = "worker-queue-secretary";
  const childSessionId = "8486c14d-29fd-4b4d-9ee7-3a03bc432c69";
  const initial = "FIXTURE_WORKER_ACTIVE";
  const normal = "FIXTURE_WORKER_NORMAL";
  const removed = "FIXTURE_WORKER_REMOVED";
  const steering = "FIXTURE_WORKER_STEER";
  const markers = [initial, normal, removed, steering];
  const first = Promise.withResolvers();
  const seen = [];
  const runtime = await fixture(t, (body, response) => {
    const marker = body.messages.filter(message => message.role === "user").reverse()
      .map(message => markers.find(value => JSON.stringify(message.content).includes(value)))
      .find(Boolean);
    seen.push(marker);
    if (marker === initial) first.resolve(response);
    else modelReply(response, `Finished ${marker}`);
  });
  const client = await runtime.start();
  await client.open(sessionId);
  await client.request("lolicode/session/configure-secretary", { sessionId });
  await client.request("lolicode/secretary/delegate-worker", {
    sessionId, childSessionId, label: "Independent child queue",
    content: [{ type: "text", text: initial }],
  });
  const response = await first.promise;
  const prompt = (requestId, text, delivery = "queue") => client.request("lolicode/secretary/prompt-worker", {
    sessionId, childSessionId, requestId, delivery, content: [{ type: "text", text }],
  });
  try {
    const pending = await prompt("worker-normal", normal);
    const toRemove = await prompt("worker-removed", removed);
    const steered = await prompt("worker-steer", steering, "steer");
    assert.deepEqual(await prompt("worker-steer", steering, "steer"), steered);
    const action = "lolicode/session/queued-action";
    await assert.rejects(client.request(action, {
      sessionId, messageId: toRemove.messageId, action: "remove",
    }), /no longer pending/);
    assert.deepEqual(await client.request(action, {
      sessionId, childSessionId, messageId: toRemove.messageId, action: "remove",
    }), { messageId: toRemove.messageId, status: "removed" });
    assert.deepEqual(seen, [initial]);
    modelReply(response, "The original worker step completed.");
    await client.wait(sessionId);
    assert.deepEqual(seen, [initial, steering, normal]);
    const events = client.notifications.filter(({ method, params }) =>
      method === "session.event" && params.sessionId === childSessionId).map(({ params }) => params.event);
    const messages = events.filter(event =>
      event.type === "user/message" && event.data.source.kind === "user" && event.data.source.rpcId !== undefined);
    assert.deepEqual(messages.map(event => [event.data.id, event.data.source.rpcId]), [
      [steered.messageId, "worker-steer"],
      [pending.messageId, "worker-normal"],
    ]);
    assert.equal(events.filter(event => event.type === "turn/end").length, 2);
  } finally {
    if (!response.writableEnded) response.destroy();
    await client.shutdown();
  }
});

test("stopping a worker parks its inbox and the same request can resume after restart", { timeout: 60_000 }, async (t) => {
  const sessionId = "worker-park-secretary";
  const childSessionId = "8486c14d-29fd-4b4d-9ee7-3a03bc432c70";
  const requestId = "parked-child-input";
  const initial = "FIXTURE_CHILD_PAUSE_INITIAL";
  const text = "FIXTURE_CHILD_PARKED";
  const first = Promise.withResolvers();
  let resumed = 0;
  let initialCalls = 0;
  const runtime = await fixture(t, (body, response) => {
    const users = JSON.stringify(body.messages.filter(message => message.role === "user"));
    if (users.includes(text)) {
      resumed += 1;
      modelReply(response, "The parked input ran after restart.");
    } else if (!users.includes(initial)) {
      modelReply(response, "Secretary acknowledged the worker outcome.");
    } else if (++initialCalls === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "fixture-held-response", model, choices: [{ index: 0, delta: { role: "assistant", content: "Working" }, finish_reason: null }],
      })}\n\n`);
      first.resolve(response);
    } else {
      modelReply(response, "The initial input was replayed unexpectedly.");
    }
  });
  let client = await runtime.start();
  await client.open(sessionId);
  await client.request("lolicode/session/configure-secretary", { sessionId });
  await client.request("lolicode/secretary/delegate-worker", {
    sessionId, childSessionId, label: "Worker queue pause fixture",
    content: [{ type: "text", text: initial }],
  });
  const response = await first.promise;
  const prompt = { sessionId, childSessionId, requestId, content: [{ type: "text", text }] };
  try {
    await client.request("lolicode/secretary/prompt-worker", prompt);
    assert.deepEqual(await client.request("lolicode/secretary/cancel-worker", {
      sessionId, childSessionId, parkedRequestIds: [requestId],
    }), { parked: [requestId] });
    response.destroy();
    await client.wait(sessionId);
    assert.equal(resumed, 0);
  } finally {
    if (!response.writableEnded) response.destroy();
    await client.shutdown();
  }
  const initialCallsAtStop = initialCalls;
  client = await runtime.start();
  try {
    await client.request("session/resume", { sessionId });
    await client.request("lolicode/session/configure-secretary", { sessionId });
    await client.request("lolicode/secretary/configure-worker-queues", {
      sessionId, workers: [{ childSessionId, requestIds: [requestId] }],
    });
    const { messageId } = await client.request("lolicode/secretary/prompt-worker", prompt);
    await client.wait(sessionId);
    assert.equal(resumed, 1);
    assert.equal(initialCalls, initialCallsAtStop);
    const delivered = client.notifications.filter(({ method, params }) => method === "session.event" &&
      params.sessionId === childSessionId && params.event.type === "user/message" &&
      params.event.data.source.rpcId === requestId);
    assert.deepEqual(delivered.map(({ params }) => params.event.data.id), [messageId]);
  } finally {
    await client.shutdown();
  }
});

test("automatic secretary writes require worker-scoped approval", { timeout: 60_000 }, async (t) => {
  const sessionId = "scoped-review-secretary";
  const reviewed = "8486c14d-29fd-4b4d-9ee7-3a03bc432c61";
  const interactive = "8486c14d-29fd-4b4d-9ee7-3a03bc432c62";
  const approvals = [];
  const toolResults = new Map();
  const runtime = await fixture(t, (body, response) => {
    const user = body.messages.filter((message) => message.role === "user");
    const contents = JSON.stringify(user);
    if (contents.includes("ROOT_NATIVE_DELEGATE")) {
      if (body.messages.some(message => message.role === "tool" && message.tool_call_id === "native_review_delegate")) {
        modelReply(response, "Secretary delegated the work.");
      } else {
        modelReply(response, { tool_calls: [{ index: 0, id: "native_review_delegate", type: "function", function: {
          name: "subagent", arguments: JSON.stringify({ description: "Permission test", prompt: "NATIVE_CHILD_WRITE" }),
        } }] }, "tool_calls");
      }
      return;
    }
    const file = contents.includes("NATIVE_CHILD_WRITE") ? "native-child.txt"
      : contents.includes("ROOT_REVIEW_WRITE") ? "root-review.txt"
      : contents.includes("REVIEWED_WRITE") ? "reviewed.txt" : "interactive.txt";
    const result = body.messages.find((message) => message.role === "tool");
    if (result) {
      toolResults.set(file, JSON.stringify(result.content));
      modelReply(response, "Worker completed");
    } else {
      modelReply(response, { tool_calls: [{ index: 0, id: "reviewed_write", type: "function", function: {
        name: "write", arguments: JSON.stringify({ file_path: file, content: "fixture content" }),
      } }] }, "tool_calls");
    }
  }, async (method, params) => {
    assert.equal(method, "approval/request");
    approvals.push(params.sessionId);
    return { outcome: "rejected" };
  });
  const client = await runtime.start();
  try {
    await client.open(sessionId);
    await client.request("lolicode/session/configure-secretary", { sessionId });
    await client.request("lolicode/session/configure-workspace", { sessionId, workspace: { policy: "review", skills: [], memory: "" } });
    for (const [childSessionId, text, selection] of [[reviewed, "REVIEWED_WRITE", { approvalRequired: true }], [interactive, "INTERACTIVE_WRITE", { workspacePolicy: "workspace" }]]) {
      await client.request("lolicode/secretary/delegate-worker", {
        sessionId, childSessionId, label: text, ...selection, content: [{ type: "text", text }],
      });
      await client.wait(sessionId);
    }
    await client.prompt(sessionId, "ROOT_REVIEW_WRITE");
    await client.wait(sessionId);
    await client.prompt(sessionId, "ROOT_NATIVE_DELEGATE");
    await client.wait(sessionId);
  } finally {
    await client.shutdown();
  }
  assert.match(toolResults.get("reviewed.txt"), /rejected|denied/i);
  assert.match(toolResults.get("interactive.txt"), /Created file/);
  assert.match(toolResults.get("root-review.txt"), /rejected|denied/i);
  assert.match(toolResults.get("native-child.txt"), /rejected|denied/i);
  const nativeChild = client.notifications.find(({ method, params }) =>
    method === "subagent.started" && ![reviewed, interactive].includes(params.childSessionId));
  assert.ok(nativeChild);
  assert.deepEqual(approvals, [reviewed, sessionId, nativeChild.params.childSessionId]);
});

test("review mode admits official subagent coordination while keeping worker writes subject to approval", { timeout: 60_000 }, async (t) => {
  const sessionId = "review-coordination";
  const childSessionId = "review-coordination-child";
  const approvals = [];
  const results = new Map();
  const runtime = await fixture(t, (body, response) => {
    const rootPrompt = body.messages.some(message => message.role === "user" &&
      JSON.stringify(message.content).includes("REVIEW_COORDINATION_ROOT"));
    const toolCall = (name, args) => modelReply(response, {
      tool_calls: [{ index: 0, id: `review_${name}`, type: "function", function: {
        name, arguments: JSON.stringify(args),
      } }],
    }, "tool_calls");
    const result = name => body.messages.find(message => message.role === "tool" &&
      message.tool_call_id === `review_${name}`);
    if (!rootPrompt) {
      if (!JSON.stringify(body.messages).includes("REVIEW_COORDINATION_FOLLOWUP")) {
        return modelReply(response, "Worker ready for follow-up.");
      }
      if (!result("write")) return toolCall("write", { file_path: "review-coordination.txt", content: "requires approval" });
      results.set("write", JSON.stringify(result("write").content));
      return modelReply(response, "Worker respected the write decision.");
    }
    if (!result("send_message")) {
      return toolCall("send_message", { agent: childSessionId, message: "REVIEW_COORDINATION_FOLLOWUP" });
    }
    results.set("send_message", JSON.stringify(result("send_message").content));
    return modelReply(response, "Coordination completed.");
  }, async (method, params) => {
    assert.equal(method, "approval/request");
    approvals.push({ sessionId: params.sessionId, toolName: params.toolName });
    return { outcome: "rejected" };
  });
  const client = await runtime.start();
  try {
    await client.open(sessionId);
    await client.request("lolicode/session/configure-secretary", { sessionId });
    await client.request("lolicode/session/configure-workspace", {
      sessionId, workspace: { policy: "review", skills: [], memory: "" },
    });
    await client.request("lolicode/secretary/delegate-worker", {
      sessionId, childSessionId, label: "Review coordination fixture",
      content: [{ type: "text", text: "REVIEW_COORDINATION_WORKER" }],
    });
    await client.wait(sessionId);
    await client.prompt(sessionId, "REVIEW_COORDINATION_ROOT");
    await client.wait(sessionId);
    if (runtime.modelError) throw runtime.modelError;
    assert.match(results.get("send_message") ?? "", /message delivered to agent/);
    assert.deepEqual(approvals, [{ sessionId: childSessionId, toolName: "write" }]);
    assert.match(results.get("write") ?? "", /rejected|denied/i);
    await assert.rejects(access(path.join(runtime.project, "review-coordination.txt")), { code: "ENOENT" });
  } finally {
    await client.shutdown();
  }
});

test("secretary restores a grandchild with a cold creator while retaining ownership, review and reports", { timeout: 90_000 }, async (t) => {
  const sessionId = "restored-grandchild-secretary";
  const foreignRoot = "restored-grandchild-foreign";
  const parentId = "8486c14d-29fd-4b4d-9ee7-3a03bc432c63";
  const held = Promise.withResolvers();
  const approvals = [];
  const results = new Map();
  let modelCalls = 0;
  const runtime = await fixture(t, (body, response) => {
    modelCalls += 1;
    const userIndex = body.messages.findLastIndex(message => message.role === "user" &&
      /NESTED_PARENT_CREATE|NESTED_GRANDCHILD_INITIAL|RESTORE_GRANDCHILD_(REVIEW|PLAN)/.test(JSON.stringify(message.content)));
    assert.ok(userIndex >= 0, `Expected a nested task prompt: ${JSON.stringify(body.messages)}`);
    const input = JSON.stringify(body.messages[userIndex].content);
    const turn = body.messages.slice(userIndex + 1);
    if (input.includes("NESTED_PARENT_CREATE")) {
      if (turn.some(message => message.role === "tool")) {
        results.set("delegation", JSON.stringify(turn.filter(message => message.role === "tool")));
        modelReply(response, "Nested assignment finished.");
      }
      else fixtureTool(response, "nested_delegate", "subagent", {
        description: "Nested continuity fixture", prompt: "NESTED_GRANDCHILD_INITIAL",
      });
      return;
    }
    assert.ok(body.tools.some(tool => tool.function.name === "report_task"), "Every admitted secretary descendant receives its own report tool");
    if (input.includes("NESTED_GRANDCHILD_INITIAL")) {
      modelReply(response, "Original grandchild result.");
      return;
    }
    const mode = input.includes("RESTORE_GRANDCHILD_PLAN") ? "plan" : "review";
    assert.ok(input.includes(`RESTORE_GRANDCHILD_${mode.toUpperCase()}`));
    const writeResult = turn.find(message => message.role === "tool" && message.tool_call_id === `nested_write_${mode}`);
    const reportResult = turn.find(message => message.role === "tool" && message.tool_call_id === `nested_report_${mode}`);
    if (!writeResult) {
      fixtureTool(response, `nested_write_${mode}`, "write", { file_path: `grandchild-${mode}.txt`, content: "must remain blocked" });
    } else if (!reportResult) {
      results.set(mode, JSON.stringify(writeResult.content));
      fixtureTool(response, `nested_report_${mode}`, "report_task", { state: "ready", summary: `Restored grandchild ${mode} report` });
    } else if (mode === "review") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      writeModelChunk(response, { role: "assistant" });
      writeModelChunk(response, { content: "Restored grandchild result." });
      held.resolve(response);
    } else modelReply(response, "Plan guard preserved.");
  }, async (method, params) => {
    assert.equal(method, "approval/request");
    approvals.push(params.sessionId);
    return { outcome: "rejected" };
  });
  const depthPatch = path.join(runtime.home, "nested-subagent-depth.json");
  await writeFile(depthPatch, JSON.stringify([{ id: "subagent", config: { maxDepth: 2 } }]));
  const first = await runtime.start({ patchFiles: [depthPatch] });
  let childSessionId;
  try {
    await first.open(sessionId);
    await first.request("lolicode/session/configure-secretary", { sessionId });
    await first.request("lolicode/session/configure-workspace", { sessionId, workspace: { policy: "review", skills: [], memory: "" } });
    await first.request("lolicode/secretary/delegate-worker", {
      sessionId, childSessionId: parentId, label: "Nested parent", content: [{ type: "text", text: "NESTED_PARENT_CREATE" }],
    });
    await first.wait(sessionId);
    childSessionId = first.notifications.find(({ method, params }) =>
      method === "subagent.started" && params.parentSessionId === parentId)?.params.childSessionId;
    assert.equal(runtime.modelError, undefined);
    assert.ok(childSessionId, `The official native subagent tool created a real grandchild: ${results.get("delegation")}`);
    const original = await readColdMarkdown(path.join(runtime.home, "sessions"), childSessionId);
    assert.match(original.stdout, /Original grandchild result/);
  } finally {
    await first.shutdown();
  }
  const second = await runtime.start({ patchFiles: [depthPatch] });
  let response;
  const prompt = (owner, text, extra = {}) => second.request("lolicode/secretary/prompt-worker", {
    sessionId: owner, childSessionId, requestId: text, content: [{ type: "text", text }], ...extra,
  });
  try {
    await second.open(foreignRoot);
    await second.request("lolicode/session/configure-secretary", { sessionId: foreignRoot });
    const beforeForeign = modelCalls;
    await assert.rejects(prompt(foreignRoot, "FOREIGN_COLD_PROMPT", { workspacePolicy: "full" }), /Invalid worker parent/);
    assert.equal(modelCalls, beforeForeign);
    await second.request("session/resume", { sessionId });
    await second.request("lolicode/session/configure-secretary", { sessionId });
    await second.request("lolicode/session/configure-workspace", { sessionId, workspace: { policy: "review", skills: [], memory: "" } });
    await prompt(sessionId, "RESTORE_GRANDCHILD_REVIEW");
    response = await held.promise;
    assert.equal(await second.request("lolicode/session/read-native", { sessionId, childSessionId: parentId }), null);
    assert.ok(!second.notifications.some(({ method, params }) => method === "subagent.started" && params.childSessionId === parentId),
      "Restoring the grandchild must not activate its cold creator");
    const parameters = { sessionId, childSessionId };
    const native = await second.request("lolicode/session/read-native", parameters);
    assert.ok(JSON.stringify(native.page.records).includes("Original grandchild result"));
    assert.match(await second.request("lolicode/session/read-markdown", parameters), /RESTORE_GRANDCHILD_REVIEW/);
    const subscriptionId = "restored-grandchild-watch";
    await second.request("lolicode/session/follow-native", { ...parameters, subscriptionId });
    const snapshot = await fixtureNotice(second, "lolicode/session.native-follow", notice =>
      notice.subscriptionId === subscriptionId && notice.frame?.type === "snapshot");
    assert.equal(snapshot.frame.header.id, childSessionId);
    assert.equal(snapshot.frame.header.parentSession, parentId);
    for (const method of ["lolicode/session/read-native", "lolicode/session/read-markdown", "lolicode/session/follow-native"]) {
      await assert.rejects(second.request(method, {
        sessionId: foreignRoot, childSessionId, ...(method.endsWith("follow-native") && { subscriptionId: "foreign-grandchild-watch" }),
      }), /Worker is not owned/);
    }
    const beforeResidentForeign = modelCalls;
    await assert.rejects(prompt(foreignRoot, "FOREIGN_LIVE_PROMPT", { workspacePolicy: "full" }), /Invalid worker parent/);
    assert.equal(modelCalls, beforeResidentForeign);
    await second.request("lolicode/session/unfollow-native", { subscriptionId });
    writeModelChunk(response, {}, "stop");
    response.end("data: [DONE]\n\n");
    response = undefined;
    await second.wait(sessionId);
    await second.request("lolicode/session/configure-workspace", { sessionId, workspace: { policy: "plan", skills: [], memory: "" } });
    await prompt(sessionId, "RESTORE_GRANDCHILD_PLAN", { workspacePolicy: "full" });
    await second.wait(sessionId);
    assert.equal(runtime.modelError, undefined);
    assert.deepEqual(approvals, [childSessionId], "The resumed worker inherits root review; root plan cannot be overridden by full access");
    assert.match(results.get("review"), /rejected|denied/i);
    assert.match(results.get("plan"), /Plan mode allows read-only tools/);
    for (const mode of ["review", "plan"]) {
      await assert.rejects(access(path.join(runtime.project, `grandchild-${mode}.txt`)));
      assert.ok(second.notifications.some(({ method, params }) => method === "lolicode/secretary.report" &&
        params.sessionId === childSessionId && params.state === "ready" && params.summary === `Restored grandchild ${mode} report`));
    }
  } finally {
    response?.end("data: [DONE]\n\n");
    await second.shutdown();
  }
});

test("desktop permission selection enforces one-shot review, workspace access, full access and plan mode", { timeout: 60_000 }, async (t) => {
  const cases = new Map();
  const approvals = [];
  let activeCase;
  const runtime = await fixture(t, (body, response) => {
    const selected = activeCase;
    assert.ok(selected, "Expected a configured fixture case");
    const result = body.messages.findLast(message => message.role === "tool");
    const callId = `call_${selected.id}`;
    if (result && result.tool_call_id === callId) {
      selected.result = JSON.stringify(result.content);
      modelReply(response, "Permission fixture completed.");
    } else {
      const args = { file_path: selected.file, content: selected.id };
      if (selected.escalation) {
        args.sandbox_permissions = "danger-full-access";
        args.justification = "Write the temporary approval fixture outside this workspace.";
      }
      modelReply(response, { tool_calls: [{ index: 0, id: callId, type: "function", function: {
        name: "write", arguments: JSON.stringify(args),
      } }] }, "tool_calls");
    }
  }, async (method, params) => {
    assert.equal(method, "approval/request");
    assert.equal(params.toolName, "write");
    const id = params.callId?.replace(/^call_/, "");
    approvals.push(id);
    return { outcome: cases.get(id)?.allowed ? "allowed-once" : "rejected" };
  });
  const check = async (client, sessionId, selected) => {
    cases.set(selected.id, selected);
    activeCase = selected;
    await client.request("lolicode/session/configure-workspace", { sessionId, workspace: { policy: selected.policy, skills: [], memory: "" } });
    await client.prompt(sessionId, selected.id);
    await client.wait(sessionId);
    if (selected.allowed) await access(selected.file);
    else await assert.rejects(access(selected.file));
    assert.equal(runtime.modelError, undefined);
    assert.ok(selected.result, `Expected an upstream tool result for ${selected.id}`);
  };
  const sessionId = "desktop-mode-fixture";
  const first = await runtime.start();
  await first.open(sessionId);
  const inside = id => path.join(runtime.project, `${id}.txt`);
  const outside = id => path.join(runtime.project, "..", `${id}.txt`);
  try {
    await check(first, sessionId, { id: "reviewinside", policy: "review", file: inside("reviewinside"), allowed: false });
    await check(first, sessionId, { id: "reviewescape", policy: "review", file: outside("reviewescape"), escalation: true, allowed: true });
    await check(first, sessionId, { id: "autoinside", policy: "workspace", file: inside("autoinside"), allowed: true });
    await check(first, sessionId, { id: "autoescape", policy: "workspace", file: outside("autoescape"), escalation: true, allowed: false });
    await check(first, sessionId, { id: "fulloutside", policy: "full", file: outside("fulloutside"), allowed: true });
  } finally {
    await first.shutdown();
  }
  const second = await runtime.start();
  try {
    await second.request("session/resume", { sessionId });
    await check(second, sessionId, { id: "planwrite", policy: "plan", file: inside("planwrite"), allowed: false });
    await check(second, sessionId, { id: "reviewresumed", policy: "review", file: inside("reviewresumed"), allowed: false });
  } finally {
    await second.shutdown();
  }
  assert.deepEqual(approvals, ["reviewinside", "reviewescape", "autoescape", "reviewresumed"]);
});

test("legacy context is silent, idempotent, and visible on the first real prompt after restart", { timeout: 45_000 }, async (t) => {
  const requests = [];
  const runtime = await fixture(t, (body, response) => {
    requests.push(body);
    modelReply(response, "Continuing original conversation.");
  });
  const sessionId = "b1468419-1df4-8c52-a20e-7e18c546810a";
  const context = "An earlier discussion chose a concrete build target: cedar-fixture.";
  const first = await runtime.start();
  await assert.rejects(first.request(contextMethod, { sessionId, context }), /not an open root/);
  await first.open(sessionId);
  await assert.rejects(first.request(contextMethod, { sessionId, context, source: "user" }), /Invalid/);
  await assert.rejects(first.request(contextMethod, { sessionId, context: "中".repeat(11_000) }), /32 KiB/);
  const receipts = await Promise.all([
    first.request(contextMethod, { sessionId, context }),
    first.request(contextMethod, { sessionId, context }),
  ]);
  assert.equal(typeof receipts[0].messageId, "string");
  assert.deepEqual(receipts[0], receipts[1]);
  await assert.rejects(first.request(contextMethod, { sessionId, context: "Different source" }), /already staged/);
  assert.deepEqual(requests, []);
  await first.shutdown();

  const second = await runtime.start();
  await assert.rejects(second.request(cancelMethod, { sessionId }), /not an open root/);
  await second.request("session/resume", { sessionId });
  assert.deepEqual(requests, []);
  assert.deepEqual(await second.request(contextMethod, { sessionId, context }), receipts[0]);
  await second.prompt(sessionId, "Continue from the prior build choice.");
  await second.wait(sessionId);
  assert.equal(requests.length, 1);
  const messages = requests[0].messages;
  const userText = messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content));
  const recalled = userText.filter((text) => text.includes(context));
  assert.equal(recalled.length, 1);
  assert.match(recalled[0], /Historical context from a previous LoliCode conversation/);
  assert.equal(userText.filter((text) => text.includes("Continue from the prior build choice")).length, 1);
  const events = second.notifications.filter(({ params }) => params.sessionId === sessionId);
  const start = events.findIndex(({ method, params }) =>
    method === "lolicode/session.assistant-stream" && params.frame.type === "start");
  const text = events.findIndex(({ method, params }) =>
    method === "lolicode/session.assistant-stream" &&
    params.frame.type === "chunk" && params.frame.chunk.type === "text-delta" &&
    params.frame.chunk.text === "Continuing original conversation.");
  const durable = events.findIndex(({ method, params }) =>
    method === "session.event" && params.event.type === "assistant/message");
  const end = events.findIndex(({ method, params }) =>
    method === "lolicode/session.assistant-stream" && params.frame.type === "end");
  assert.ok(start >= 0 && start < text && text < durable && durable < end);
  await assert.rejects(second.request(contextMethod, { sessionId, context }), /before the first prompt/);
  await second.shutdown();
});

test("cancellation aborts the selected owned root and leaves the other root running", { timeout: 45_000 }, async (t) => {
  const firstCall = Promise.withResolvers();
  const secondCall = Promise.withResolvers();
  const runtime = await fixture(t, (body, response) => {
    const user = JSON.stringify(body.messages.filter((message) => message.role === "user"));
    if (user.includes("first fixture root")) firstCall.resolve(response);
    else if (user.includes("second fixture root")) secondCall.resolve(response);
    else throw new Error("Unexpected fixture prompt");
  });
  const client = await runtime.start();
  const first = "root-first";
  const second = "root-second";
  await assert.rejects(client.request(cancelMethod, { sessionId: "unowned" }), /not an open root/);
  await assert.rejects(client.request(cancelMethod, { sessionId: "../first" }), /Invalid/);
  await client.prompt(first, "Start first fixture root");
  await client.prompt(second, "Start second fixture root");
  const [target, unrelated] = await Promise.all([firstCall.promise, secondCall.promise]);
  const targetClosed = new Promise((resolve) => target.once("close", resolve));
  assert.deepEqual(await client.request(cancelMethod, { sessionId: first }), {});
  await targetClosed;
  assert.equal(target.writableEnded, false);
  assert.equal(unrelated.destroyed, false);
  modelReply(unrelated, "The other root completed.");
  await client.wait(second);
  await client.wait(first);
  await client.shutdown();
});

test("warm roots park durably across turns and changed one-time configuration requires a fresh process", { timeout: 60_000 }, async (t) => {
  const sessionId = "warm-configuration-root";
  const bodies = [];
  const runtime = await fixture(t, (body, response) => {
    bodies.push(body);
    modelReply(response, `Warm fixture answer ${bodies.length}`);
  });
  const tools = version => [{ function: {
    name: `fixture_warm_${version}`, description: `Product ${version}`,
    parameters: { type: "object", properties: {} },
  } }];
  const mcp = version => [{ function: {
    name: `mcp_warm_${version}`, description: `MCP ${version}`,
    parameters: { type: "object", properties: {} },
  } }];
  const workspace = version => ({
    policy: "workspace", memory: `WARM_MEMORY_${version}`,
    skills: [{ name: "warm-fixture", description: `WARM_SKILL_${version}`, content: `# Skill ${version}` }],
  });
  async function configure(client, version) {
    assert.deepEqual(await client.request("lolicode/session/configure-workspace", { sessionId, workspace: workspace(version) }), { registered: 1 });
    assert.deepEqual(await client.request("lolicode/session/configure-tools", { sessionId, tools: tools(version) }), { registered: 1 });
    assert.deepEqual(await client.request("lolicode/session/configure-mcp", { sessionId, tools: mcp(version) }), { registered: 1 });
  }
  const park = client => client.request("lolicode/session/park", { sessionId });
  const read = client => client.request("lolicode/session/read-native", { sessionId, maxMessages: 200 });
  const client = await runtime.start();
  let second;
  const receipts = [];
  try {
    await assert.rejects(client.request("lolicode/session/park", { sessionId: "unowned" }), /not an open root/);
    await assert.rejects(client.request("lolicode/session/park", { sessionId, activate: true }), /Invalid/);
    await client.open(sessionId);
    assert.deepEqual(await park(client), { parked: false });
    await configure(client, "V1");
    receipts.push(await client.prompt(sessionId, "WARM_ROUND_ONE"));
    await client.wait(sessionId);
    assert.deepEqual(await park(client), { parked: true });
    const first = await read(client);
    const cold = await execFileAsync(process.execPath, [
      path.join(root, "host-session-native.mjs"), path.join(runtime.home, "sessions"), sessionId,
      JSON.stringify({ maxMessages: 200, throughSeq: first.page.cursor }),
    ], { env: {}, windowsHide: true, timeout: 30_000 });
    const persisted = JSON.parse(cold.stdout);
    assert.deepEqual(persisted.page, first.page);
    assert.deepEqual(persisted.projections, first.projections);
    assert.equal(persisted.page.records.filter(({ event }) => event.type === "turn/end").at(-1).event.data.reason.kind, "completed");
    await client.open(sessionId);
    await assert.rejects(client.request("session/resume", { sessionId }), /already open/);
    receipts.push(await client.prompt(sessionId, "WARM_ROUND_TWO"));
    await client.wait(sessionId);
    assert.deepEqual(await park(client), { parked: true });
    const native = await read(client);
    const events = native.page.records.map(record => record.event);
    assert.equal(new Set(events.map(event => event.seq)).size, events.length);
    assert.deepEqual(events.filter(event => event.type === "user/message" && event.data.source.kind === "user").map(event => event.data.id), receipts.map(receipt => receipt.messageId));
    const notifications = client.notifications.filter(({ method, params }) => method === "session.event" && params.sessionId === sessionId).map(({ params }) => params.event);
    assert.equal(new Set(notifications.map(event => event.seq)).size, notifications.length);
    for (const body of bodies) {
      const prompt = JSON.stringify(body.messages);
      assert.ok(prompt.includes("WARM_MEMORY_V1"));
      assert.ok(prompt.includes("WARM_SKILL_V1"));
      assert.equal(body.tools.filter(tool => tool.function.name === "fixture_warm_V1").length, 1);
      assert.equal(body.tools.filter(tool => tool.function.name === "mcp_warm_V1").length, 1);
    }
    for (const method of ["configure-tools", "configure-mcp"]) {
      await assert.rejects(client.request(`lolicode/session/${method}`, { sessionId, tools: [] }), /repeated/);
    }
    await assert.rejects(client.request("lolicode/session/configure-workspace", { sessionId, workspace: workspace("V2") }), /already registered/);
    await client.shutdown();
    second = await runtime.start();
    await second.request("session/resume", { sessionId });
    await configure(second, "V2");
    receipts.push(await second.prompt(sessionId, "WARM_ROUND_THREE_NEW_CONFIGURATION"));
    await second.wait(sessionId);
    assert.deepEqual(await park(second), { parked: true });
    const refreshed = bodies.at(-1);
    const prompt = JSON.stringify(refreshed.messages);
    assert.ok(prompt.includes("WARM_MEMORY_V2"));
    assert.ok(prompt.includes("WARM_SKILL_V2"));
    assert.ok(!prompt.includes("WARM_MEMORY_V1"));
    // Official history retains the previous skill-catalog notice. The new
    // admission must advertise the updated catalog after that historical one.
    assert.ok(prompt.lastIndexOf("WARM_SKILL_V2") > prompt.lastIndexOf("WARM_SKILL_V1"));
    const names = refreshed.tools.map(tool => tool.function.name);
    assert.ok(names.includes("fixture_warm_V2") && names.includes("mcp_warm_V2"));
    assert.ok(!names.includes("fixture_warm_V1") && !names.includes("mcp_warm_V1"));
    const final = await read(second);
    assert.deepEqual(final.page.records.filter(({ event }) => event.type === "user/message" && event.data.source.kind === "user").map(({ event }) => event.data.id), receipts.map(receipt => receipt.messageId));
    assert.equal(bodies.length, 3);
  } finally {
    if (second) await second.shutdown();
    else await client.shutdown().catch(() => {});
  }
});

test("warm cancellation preserves queued identities and park refuses activity without interrupting it", { timeout: 45_000 }, async (t) => {
  const sessionId = "warm-cancellation-root";
  const waiting = Promise.withResolvers();
  const seen = [];
  const runtime = await fixture(t, (body, response) => {
    const markers = ["WARM_CANCEL_ONE", "WARM_CANCEL_TWO", "WARM_CANCEL_THREE"];
    const marker = body.messages.filter(message => message.role === "user").reverse()
      .map(message => markers.find(value => JSON.stringify(message.content).includes(value))).find(Boolean);
    assert.ok(marker);
    seen.push(marker);
    if (marker === "WARM_CANCEL_TWO") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      writeModelChunk(response, { role: "assistant" });
      writeModelChunk(response, { content: "Cancelled warm prefix" });
      waiting.resolve(response);
    } else modelReply(response, `Completed ${marker}`);
  });
  const client = await runtime.start();
  const park = () => client.request("lolicode/session/park", { sessionId });
  let response;
  try {
    await client.open(sessionId);
    await client.request("lolicode/session/configure-workspace", { sessionId, workspace: { policy: "workspace", skills: [], memory: "" } });
    const first = await client.prompt(sessionId, "WARM_CANCEL_ONE");
    await client.wait(sessionId);
    assert.equal(runtime.modelError, undefined);
    assert.deepEqual(await park(), { parked: true });
    const second = await client.prompt(sessionId, "WARM_CANCEL_TWO");
    response = await waiting.promise;
    assert.deepEqual(await park(), { parked: false });
    assert.equal(response.destroyed, false);
    const queued = await client.prompt(sessionId, "OLD_QUEUED_WARM_INPUT");
    assert.deepEqual(await park(), { parked: false });
    assert.equal(response.destroyed, false);
    const closed = new Promise(resolve => response.once("close", resolve));
    await client.request(cancelMethod, { sessionId });
    await closed;
    await client.wait(sessionId);
    assert.deepEqual(await park(), { parked: false });
    const pending = await client.request("lolicode/session/read-native", { sessionId, maxMessages: 200 });
    assert.deepEqual(pending.projections.values.inbox["next-turn"].map(message => message.id), [queued.messageId]);
    assert.deepEqual(await client.request("lolicode/session/queued-action", { sessionId, messageId: queued.messageId, action: "remove" }), { messageId: queued.messageId, status: "removed" });
    assert.deepEqual(await park(), { parked: false }, "a cancelled turn remains ineligible after its inbox clears");
    const third = await client.prompt(sessionId, "WARM_CANCEL_THREE");
    await client.wait(sessionId);
    assert.deepEqual(await park(), { parked: true });
    const native = await client.request("lolicode/session/read-native", { sessionId, maxMessages: 200 });
    const events = native.page.records.map(record => record.event);
    assert.equal(new Set(events.map(event => event.seq)).size, events.length);
    assert.deepEqual(events.filter(event => event.type === "user/message" && event.data.source.kind === "user").map(event => event.data.id), [first.messageId, second.messageId, third.messageId]);
    assert.deepEqual(events.filter(event => event.type === "turn/end").map(event => event.data.reason.kind), ["completed", "aborted", "completed"]);
    assert.deepEqual(seen, ["WARM_CANCEL_ONE", "WARM_CANCEL_TWO", "WARM_CANCEL_THREE"]);
  } finally {
    if (response && !response.writableEnded) response.destroy();
    await client.shutdown();
  }
});

test("park refuses a live child without cancelling it or changing its completed parent's state", { timeout: 45_000 }, async (t) => {
  const sessionId = "park-child-root";
  const childStarted = Promise.withResolvers();
  const runtime = await fixture(t, (body, response) => {
    const input = JSON.stringify(body.messages.filter(message => message.role === "user"));
    if (input.includes("PARK_CHILD_WORK")) return childStarted.resolve(response);
    if (!body.messages.some(message => message.role === "tool" && message.tool_call_id === "park-child")) {
      return fixtureTool(response, "park-child", "subagent", { description: "Parking child fixture", prompt: "PARK_CHILD_WORK" });
    }
    modelReply(response, "The parent settled without interrupting its child.");
  });
  const client = await runtime.start();
  let response;
  try {
    await client.open(sessionId);
    await client.request("lolicode/session/configure-workspace", { sessionId, workspace: { policy: "workspace", skills: [], memory: "" } });
    await client.prompt(sessionId, "Start the independent parking fixture child.");
    response = await childStarted.promise;
    await fixtureNotice(client, "session.event", notice => notice.sessionId === sessionId && notice.event.type === "turn/end");
    const before = await client.request("lolicode/session/read-native", { sessionId, maxMessages: 200 });
    assert.equal(before.state.running, false);
    assert.deepEqual(await client.request("lolicode/session/park", { sessionId }), { parked: false });
    assert.equal(response.destroyed, false);
    const after = await client.request("lolicode/session/read-native", { sessionId, maxMessages: 200 });
    assert.deepEqual(after.page, before.page);
    modelReply(response, "The child completed after the rejected park request.");
    await client.wait(sessionId);
    assert.deepEqual(await client.request("lolicode/session/park", { sessionId }), { parked: false });
    assert.equal(runtime.modelError, undefined);
  } finally {
    if (response && !response.writableEnded) response.destroy();
    await client.shutdown();
  }
});

test("a failing official session flush rejects park and leaves the root usable", { timeout: 45_000 }, async (t) => {
  const sessionId = "park-flush-failure-root";
  const runtime = await fixture(t, (_body, response) => modelReply(response, "Durable parking fixture."));
  const marker = path.join(runtime.home, "fail-flush");
  const plugin = path.join(runtime.home, "flush-fault.mjs");
  const patch = path.join(runtime.home, "flush-fault.json");
  await writeFile(plugin, `import { existsSync } from "node:fs";\nexport default function(ctx) { ctx.on("session/flush", () => { if (existsSync(${JSON.stringify(marker)})) throw new Error("fixture park flush failed"); }); }\n`);
  await writeFile(patch, JSON.stringify([{ insert: [{ id: "fixture-flush-fault", name: plugin }] }]));
  const client = await runtime.start({ patchFiles: [patch] });
  try {
    await client.open(sessionId);
    await client.request("lolicode/session/configure-workspace", { sessionId, workspace: { policy: "workspace", skills: [], memory: "" } });
    await client.prompt(sessionId, "Complete before injecting the durability failure.");
    await client.wait(sessionId);
    await writeFile(marker, "fail");
    await assert.rejects(client.request("lolicode/session/park", { sessionId }), /fixture park flush failed/);
    await rm(marker);
    const before = await client.request("lolicode/session/read-native", { sessionId, maxMessages: 200 });
    assert.equal(before.state.running, false);
    await client.prompt(sessionId, "The same root can continue after the rejected park.");
    await client.wait(sessionId);
    assert.deepEqual(await client.request("lolicode/session/park", { sessionId }), { parked: true });
    const after = await client.request("lolicode/session/read-native", { sessionId, maxMessages: 200 });
    assert.equal(after.projections.values.turnOutline.length, 2);
    assert.equal(runtime.modelError, undefined);
  } finally {
    await client.shutdown();
  }
});

test("a parked first-prompt title provider does not request another title on the next warm turn", { timeout: 45_000 }, async (t) => {
  const sessionId = "warm-first-title-root";
  const calls = [];
  const runtime = await fixture(t, (body, response) => {
    const title = JSON.stringify(body.messages).includes("Create a concise title for an AI coding-assistant session");
    calls.push(title ? "title" : "main");
    modelReply(response, title ? "Warm Session Title" : "The warm main turn completed.");
  });
  const patch = path.join(runtime.home, "enable-first-title.json");
  await writeFile(patch, JSON.stringify([{ id: "session-title-llm", disabled: false }]));
  const client = await runtime.start({ patchFiles: [patch] });
  try {
    await client.open(sessionId);
    await client.request("lolicode/session/configure-workspace", { sessionId, workspace: { policy: "workspace", skills: [], memory: "" } });
    await client.prompt(sessionId, "FIRST_WARM_TITLE_PROMPT");
    await client.wait(sessionId);
    await fixtureNotice(client, "session.event", notice => notice.sessionId === sessionId &&
      notice.event.type === "session/title" && notice.event.data.source.kind === "provider" &&
      notice.event.data.title === "Warm Session Title");
    assert.deepEqual(calls.slice().sort(), ["main", "title"]);
    assert.deepEqual(await client.request("lolicode/session/park", { sessionId }), { parked: true });
    const before = await client.request("lolicode/session/read-native", { sessionId, maxMessages: 200 });
    await client.prompt(sessionId, "SECOND_WARM_TITLE_PROMPT");
    await client.wait(sessionId);
    assert.deepEqual(await client.request("lolicode/session/park", { sessionId }), { parked: true });
    assert.equal(runtime.modelError, undefined);
    assert.equal(calls.filter(call => call === "title").length, 1);
    assert.equal(calls.filter(call => call === "main").length, 2);
    assert.equal(calls.length, 3);
    const after = await client.request("lolicode/session/read-native", { sessionId, maxMessages: 200 });
    assert.equal(after.projections.values.title, "Warm Session Title");
    assert.deepEqual(after.page.records.filter(({ event }) => event.type === "session/title"),
      before.page.records.filter(({ event }) => event.type === "session/title"));
  } finally {
    await client.shutdown();
  }
});

test("the queue removes or steers the original SDK message without cancelling the active turn", { timeout: 45_000 }, async (t) => {
  const activePrompt = "FIXTURE_ACTIVE_PROMPT";
  const removedPrompt = "FIXTURE_REMOVED_PROMPT";
  const steeringPrompt = "FIXTURE_STEERING_PROMPT";
  const siblingPrompt = "FIXTURE_SIBLING_PROMPT";
  const markers = [activePrompt, removedPrompt, steeringPrompt, siblingPrompt];
  const first = Promise.withResolvers();
  const seen = [];
  const runtime = await fixture(t, (body, response) => {
    const marker = body.messages
      .filter(message => message.role === "user")
      .reverse()
      .map(message => markers.find(value => JSON.stringify(message.content).includes(value)))
      .find(Boolean);
    seen.push(marker);
    if (marker === activePrompt) first.resolve(response);
    else modelReply(response, "Finished " + marker);
  });
  const client = await runtime.start();
  const sessionId = "queue-root";
  const active = await client.prompt(sessionId, activePrompt);
  const activeResponse = await first.promise;
  await assert.rejects(client.request(cancelMethod, { sessionId, includeWorkers: true }), /configured secretary/);
  const sibling = await client.prompt(sessionId, siblingPrompt);
  const removed = await client.prompt(sessionId, removedPrompt);
  const steering = await client.prompt(sessionId, steeringPrompt);
  const method = "lolicode/session/queued-action";
  assert.deepEqual(
    await client.request(method, { sessionId, messageId: removed.messageId, action: "remove" }),
    { messageId: removed.messageId, status: "removed" },
  );
  for (const messageId of [removed.messageId, active.messageId]) {
    await assert.rejects(client.request(method, { sessionId, messageId, action: "remove" }), /no longer pending/);
  }
  assert.deepEqual(
    await client.request(method, { sessionId, messageId: steering.messageId, action: "steer" }),
    { messageId: steering.messageId, status: "steered" },
  );
  await assert.rejects(client.request(method, { sessionId, messageId: steering.messageId, action: "steer" }), /原消息仍在等待处理/);
  assert.deepEqual(seen, [activePrompt]);
  modelReply(activeResponse, "The active step finished without interruption.");
  await client.wait(sessionId);
  assert.deepEqual(seen, [activePrompt, steeringPrompt, siblingPrompt]);
  const events = client.notifications
    .filter(({ method, params }) => method === "session.event" && params.sessionId === sessionId)
    .map(({ params }) => params.event);
  const admitted = events
    .filter(event => event.type === "user/message" && event.data.source.kind === "user")
    .map(event => event.data.id);
  assert.deepEqual(admitted, [active.messageId, steering.messageId, sibling.messageId]);
  const turns = events.filter(event => event.type === "turn/end");
  assert.equal(turns.length, 2);
  assert.ok(turns.every(event => event.data.reason.kind === "completed"));
  assert.ok(events.findIndex(event => event.data.id === steering.messageId && event.type === "user/message") < events.indexOf(turns[0]));
  await client.shutdown();
});

test("direct steering joins the current turn exactly once without moving the FIFO queue", { timeout: 45_000 }, async (t) => {
  const activePrompt = "FIXTURE_DIRECT_ACTIVE";
  const steeringPrompt = "FIXTURE_DIRECT_STEER";
  const queuedPrompt = "FIXTURE_DIRECT_QUEUED";
  const markers = [activePrompt, steeringPrompt, queuedPrompt];
  const first = Promise.withResolvers();
  const seen = [];
  const runtime = await fixture(t, (body, response) => {
    const marker = body.messages.filter(message => message.role === "user").reverse()
      .map(message => markers.find(value => JSON.stringify(message.content).includes(value)))
      .find(Boolean);
    seen.push(marker);
    if (marker === activePrompt) first.resolve(response);
    else modelReply(response, `Finished ${marker}`);
  });
  const client = await runtime.start();
  const sessionId = "direct-steering-root";
  const active = await client.prompt(sessionId, activePrompt);
  const response = await first.promise;
  const queued = await client.prompt(sessionId, queuedPrompt);
  const method = "lolicode/session/steer";
  const input = { sessionId, requestId: "fixture-direct-steer", contentBlocks: [{ type: "text", text: steeringPrompt }] };
  const steering = await client.request(method, input);
  assert.equal(steering.status, "steered");
  assert.deepEqual(await client.request(method, input), steering);
  assert.deepEqual(seen, [activePrompt]);
  assert.equal(response.destroyed, false);
  modelReply(response, "The existing response finished normally.");
  await client.wait(sessionId);
  assert.deepEqual(await client.request(method, input), steering);
  const late = await client.request(method, { ...input, requestId: "late-steer" });
  assert.equal(late.status, "rejected");
  assert.deepEqual(seen, [activePrompt, steeringPrompt, queuedPrompt]);
  const events = client.notifications.filter(({ method, params }) =>
    method === "session.event" && params.sessionId === sessionId).map(({ params }) => params.event);
  const userMessages = events.filter(event => event.type === "user/message" && event.data.source.kind === "user");
  assert.deepEqual(userMessages.map(event => event.data.id), [active.messageId, steering.messageId, queued.messageId]);
  assert.equal(userMessages[1].data.source.rpcId, input.requestId);
  const turns = events.filter(event => event.type === "turn/end");
  assert.equal(turns.length, 2);
  assert.ok(turns.every(event => event.data.reason.kind === "completed"));
  assert.ok(events.indexOf(userMessages[1]) < events.indexOf(turns[0]));
  await client.shutdown();
});

test("manual compaction returns an owned native command completion", { timeout: 45_000 }, async (t) => {
  const marker = "NATIVE_COMPACT_ORIGINAL";
  const summary = "The fixture selected amber.";
  const seen = [];
  const runtime = await fixture(t, (body, response) => {
    const messages = JSON.stringify(body.messages);
    if (messages.includes("Do NOT mention this summarization request")) {
      assert.ok(messages.includes(marker));
      seen.push("summary");
      modelReply(response, summary);
    } else if (messages.includes("NATIVE_COMPACT_RESUME")) {
      assert.ok(messages.includes("<compacted-summary>") && messages.includes(summary));
      assert.ok(!messages.includes(marker));
      seen.push("resumed");
      modelReply(response, "Amber from the saved summary.");
    } else {
      assert.ok(messages.includes(marker));
      seen.push("original");
      modelReply(response, "I recorded the fixture color.");
    }
  });
  const client = await runtime.start();
  const sessionId = "native-compact-root";
  await client.open(sessionId);
  async function command(text, finalResponse) {
    const result = await client.request("session/query", {
      sessionId, contentBlocks: [{ type: "text", text }],
    });
    assert.equal(result.kind, "command");
    assert.equal(result.execution.result.kind, "success");
    const completions = client.notifications.filter(({ method, params }) =>
        method === "session.query.completed" && params.commandId === result.execution.commandId)
      .map(({ params }) => params);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].sessionId, sessionId);
    assert.equal(completions[0].finishReason, "completed");
    assert.match(completions[0].finalResponse, finalResponse);
  }
  await command("/compact", /^No compactable history yet\.$/);
  assert.deepEqual(seen, []);
  await client.prompt(sessionId, `${marker}\n${"The fixture selected amber. ".repeat(80)}`);
  await client.wait(sessionId);
  await command("  /压缩  ", /^Compacted [1-9]/);
  const compactedMarkdown = await client.request("lolicode/session/read-markdown", { sessionId });
  assert.ok(compactedMarkdown.includes(marker));
  assert.ok(compactedMarkdown.includes("I recorded the fixture color."));
  await client.shutdown();
  const coldMarkdown = await readColdMarkdown(path.join(runtime.home, "sessions"), sessionId);
  assert.equal(coldMarkdown.stdout, compactedMarkdown);
  const resumed = await runtime.start();
  await resumed.request("session/resume", { sessionId });
  await resumed.prompt(sessionId, "NATIVE_COMPACT_RESUME");
  await resumed.wait(sessionId);
  assert.deepEqual(seen, ["original", "summary", "resumed"]);
  await resumed.shutdown();
});

function fixtureTool(response, id, name, args) {
  modelReply(response, { tool_calls: [{ index: 0, id, type: "function", function: {
    name, arguments: JSON.stringify(args),
  } }] }, "tool_calls");
}

async function fixtureNotice(client, method, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const notice = client.notifications.find(notice => notice.method === method && predicate(notice.params));
    if (notice) return notice.params;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Expected SDK notice: ${method}`);
}

test("native Plan review revises Markdown, approves, and executes in the same turn", { timeout: 45_000 }, async (t) => {
  const sessionId = "native-plan-review";
  let reviews = 0;
  let runtime;
  runtime = await fixture(t, (body, response) => {
    const last = body.messages.findLast(message => message.role === "tool");
    switch (last?.tool_call_id) {
      case "plan-before":
        assert.match(JSON.stringify(last.content), /Plan mode allows read-only tools/);
        return fixtureTool(response, "plan-draft", "exit_plan_mode", { plan: "# Initial plan\n- Write a fixture." });
      case "plan-draft":
        assert.match(JSON.stringify(last.content), /Use the revised text/);
        return fixtureTool(response, "plan-revised", "exit_plan_mode", { plan: "# Revised plan\n- Use the revised text." });
      case "plan-revised":
        assert.match(JSON.stringify(last.content), /Plan approved/);
        return fixtureTool(response, "plan-after", "write", {
          file_path: path.join(runtime.project, "approved.txt"), content: "revised",
        });
      case "plan-after":
        return modelReply(response, "The approved implementation is complete.");
      default:
        return fixtureTool(response, "plan-before", "write", {
          file_path: path.join(runtime.project, "unapproved.txt"), content: "denied",
        });
    }
  }, async (method, params) => {
    assert.equal(method, "user-question/ask");
    assert.equal(params.sessionId, sessionId);
    const [question] = params.questions;
    assert.equal(question.intent.kind, "plan-review");
    reviews++;
    if (reviews === 1) {
      assert.match(question.detail, /^# Initial plan/);
      const revise = question.options.find(option => option.label !== question.intent.approve);
      return { answers: [{ id: question.id, selected: [revise.label], custom: "Use the revised text" }] };
    }
    assert.match(question.detail, /^# Revised plan/);
    return { answers: [{ id: question.id, selected: [question.intent.approve] }] };
  });
  const client = await runtime.start({ userQuestions: true });
  await client.open(sessionId);
  await client.request("lolicode/session/configure-workspace", { sessionId, workspace: { policy: "full", skills: [], memory: "" } });
  const command = await client.request("session/query", {
    sessionId, contentBlocks: [{ type: "text", text: "/plan Design and run the review fixture." }],
  });
  assert.equal(command.kind, "command");
  const completion = await fixtureNotice(client, "session.query.completed", notice => notice.commandId === command.execution.commandId);
  assert.equal(runtime.modelError, undefined);
  assert.equal(completion.finishReason, "completed");
  assert.match(completion.finalResponse, /approved implementation/);
  assert.equal(reviews, 2);
  const modes = client.notifications.filter(({ method }) => method === "lolicode/session.mode").map(({ params }) => params.plan);
  assert.ok(modes.some(mode => mode?.active === true));
  assert.equal(modes.at(-1)?.active, false);
  await assert.rejects(access(path.join(runtime.project, "unapproved.txt")));
  await access(path.join(runtime.project, "approved.txt"));
  await client.shutdown();
});

test("native Goal crosses turns, completes, and restores its terminal state", { timeout: 45_000 }, async (t) => {
  const sessionId = "native-goal-rounds";
  const runtime = await fixture(t, (body, response) => {
    const last = body.messages.findLast(message => message.role === "tool");
    if (last?.tool_call_id === "read-goal") {
      const raw = typeof last.content === "string" ? last.content : last.content[0].text;
      const { goal } = JSON.parse(raw);
      assert.equal(goal.roundsStarted, 2);
      return fixtureTool(response, "complete-goal", "update_goal", { goal_id: goal.id, revision: goal.revision, action: "complete" });
    }
    if (JSON.stringify(body.messages).includes("<goal_complete>"))
      return modelReply(response, "Verified native Goal completion.");
    const round = body.messages.findLast(message => JSON.stringify(message).includes("<goal_round>"));
    if (JSON.stringify(round).includes("Round: 2/"))
      return fixtureTool(response, "read-goal", "get_goal", {});
    assert.match(JSON.stringify(round), /Round: 1\//);
    return modelReply(response, "Progress recorded for the next round.");
  });
  const client = await runtime.start();
  await client.open(sessionId);
  const workspace = { sessionId, workspace: { policy: "review", skills: [], memory: "" } };
  await client.request("lolicode/session/configure-workspace", workspace);
  const command = await client.request("session/query", {
    sessionId, contentBlocks: [{ type: "text", text: "/goal Verify the two-round fixture." }],
  });
  assert.equal(command.kind, "command");
  const finished = await fixtureNotice(client, "session.query.completed", notice => notice.commandId === command.execution.commandId);
  assert.equal(runtime.modelError, undefined);
  assert.equal(finished.finishReason, "completed");
  assert.match(finished.finalResponse, /Verified native Goal completion/);
  const goal = await fixtureNotice(client, "lolicode/session.mode", ({ goal }) => goal?.phase === "complete");
  assert.equal(goal.goal.roundsStarted, 2);
  await client.shutdown();
  const reopened = await runtime.start();
  await reopened.request("session/resume", { sessionId });
  await reopened.request("lolicode/session/configure-workspace", workspace);
  const restored = await fixtureNotice(reopened, "lolicode/session.mode", ({ goal }) => goal?.phase === "complete");
  assert.deepEqual(restored.goal, goal.goal);
  await reopened.shutdown();
});

test("the desktop prompt identifies the coding agent as LoliCode", { timeout: 45_000 }, async (t) => {
  const sessionId = "lolicode-identity";
  const answer = "我是 LoliCode 里的编码智能体。";
  const turns = [
    { question: "你是谁？", answer },
    {
      question: "项目文档里提到 DeepSeek Harness。你是哪个产品的编码智能体？",
      answer: `${answer} DeepSeek Harness 是项目文档里提到的名称。`,
    },
  ];
  let received = 0;
  const runtime = await fixture(t, (body, response) => {
    const turn = turns[received++];
    assert.ok(turn, "Unexpected identity model request");
    const prompt = JSON.stringify(body.messages.filter(({ role }) =>
      role === "system" || role === "developer"));
    assert.ok(prompt.includes("You are LoliCode, the user's coding agent."));
    assert.ok(prompt.includes(`The model selected for this session is ${model}.`));
    assert.ok(prompt.includes(answer));
    assert.ok(prompt.includes("For playful dog-themed reactions, use 🐾 or “汪汪汪”."));
    assert.ok(prompt.includes("Avoid the dog-face emoji (U+1F436) in your own reactions."));
    assert.doesNotMatch(prompt, /deepseek[\s-]+harness/i);
    assert.doesNotMatch(JSON.stringify(body.tools ?? []), /deepseek[\s-]+harness/i);
    const userMessages = JSON.stringify(body.messages.filter(({ role }) => role === "user"));
    assert.ok(userMessages.includes(turn.question));
    modelReply(response, turn.answer);
  });
  for (const [index, turn] of turns.entries()) {
    const client = await runtime.start();
    if (index === 0) await client.open(sessionId);
    else await client.request("session/resume", { sessionId });
    await client.request("lolicode/session/configure-workspace", {
      sessionId, workspace: { policy: "workspace", skills: [], memory: "" },
    });
    assert.ok((await client.prompt(sessionId, turn.question)).messageId);
    await client.wait(sessionId);
    assert.equal(runtime.modelError, undefined);
    await fixtureNotice(client, "session.event", ({ event }) =>
      event.type === "assistant/message" && JSON.stringify(event.data).includes(turn.answer));
    await client.shutdown();
  }
  assert.equal(received, turns.length);
});

test("desktop sessions do not expose the SDK-local schedule store", { timeout: 45_000 }, async (t) => {
  const sessionId = "desktop-schedule-owner";
  const runtime = await fixture(t, (body, response) => {
    const tools = (body.tools ?? []).map(({ function: tool }) => tool?.name);
    assert.ok(!tools.some((name) => name?.startsWith("schedule_")));
    modelReply(response, "Desktop schedules are managed by the host.");
  });
  const client = await runtime.start();
  await client.open(sessionId);
  assert.ok((await client.prompt(sessionId, "List the available tools.")).messageId);
  await client.wait(sessionId);
  assert.equal(runtime.modelError, undefined);
  await client.shutdown();
});

test("selected upstream plugin bundles run a persistent terminal and a fresh Ralph worker", { timeout: 90_000 }, async (t) => {
  const terminalPrompt = "Run the persistent terminal fixture.";
  const ralphPrompt = "Explicitly run a Ralph loop for the fixture.";
  const terminalValue = "LOLICODE_PLUGIN_TERMINAL_STATE";
  const windows = process.platform === "win32";
  let absent;
  let terminalId;
  let terminalOutput;
  let terminalClose;
  let ralphResult;
  let freshWorker = false;
  const runtime = await fixture(t, (body, response) => {
    const user = JSON.stringify(body.messages.filter((message) => message.role === "user"));
    const tools = body.tools.map((tool) => tool.function.name);
    const result = (id) => {
      const content = body.messages.find((message) => message.tool_call_id === id)?.content;
      return typeof content === "string" ? content : content && JSON.stringify(content);
    };
    if (user.includes("Read the available tools.")) {
      absent = !tools.includes("terminal_open") && !tools.includes("ralph");
    } else if (user.includes(terminalPrompt)) {
      const opened = result("open-terminal");
      if (!opened && tools.includes("terminal_open")) {
        return fixtureTool(response, "open-terminal", "terminal_open", { type: "shell" });
      }
      if (opened && !terminalId) terminalId = /started terminal session ([^ \n]+)/.exec(opened)?.[1];
      if (terminalId && !result("set-terminal-state")) {
        return fixtureTool(response, "set-terminal-state", "terminal_send", {
          sessionId: terminalId, text: `${windows ? "$" : ""}fixture='${terminalValue}'`,
        });
      }
      if (terminalId && !result("read-terminal-state")) {
        return fixtureTool(response, "read-terminal-state", "terminal_send", {
          sessionId: terminalId, text: windows ? "Write-Output $fixture" : "printf '%s\\n' \"$fixture\"",
        });
      }
      terminalOutput = result("read-terminal-state") || opened;
      terminalClose = result("close-terminal");
      if (terminalId && !terminalClose) {
        return fixtureTool(response, "close-terminal", "terminal_close", { sessionId: terminalId });
      }
    } else if (user.includes("Ralph round:")) {
      freshWorker ||= tools.includes("structured_output") && !user.includes(ralphPrompt);
      if (tools.includes("structured_output") && !result("ralph-report")) {
        return fixtureTool(response, "ralph-report", "structured_output", {
          status: "complete", summary: "Verified fixture", evidence: ["isolated proof"],
          nextSteps: [], blocker: "",
        });
      }
    } else if (user.includes(ralphPrompt)) {
      ralphResult = result("start-ralph");
      if (!ralphResult && tools.includes("ralph")) {
        return fixtureTool(response, "start-ralph", "ralph", {
          objective: "Verify the fixture", maxRounds: 1,
        });
      }
    }
    modelReply(response, "Plugin fixture settled.");
  });
  const run = async (client, sessionId, text) => {
    await client.open(sessionId);
    await client.request("lolicode/session/configure-workspace", {
      sessionId, workspace: { policy: "workspace", skills: [], memory: "" },
    });
    await client.prompt(sessionId, text);
    await client.wait(sessionId);
  };
  const disabled = await runtime.start();
  try {
    await run(disabled, "bundles-disabled", "Read the available tools.");
  } finally {
    await disabled.shutdown();
  }
  const enabled = await runtime.start({
    pluginBundles: ["dsh-experimental-terminal-bundle", "dsh-experimental-ralph-bundle"],
  });
  try {
    await run(enabled, "bundle-terminal", terminalPrompt);
    await run(enabled, "bundle-ralph", ralphPrompt);
  } finally {
    await enabled.shutdown();
  }
  assert.equal(runtime.modelError, undefined);
  assert.equal(absent, true);
  assert.ok(terminalOutput?.includes(terminalValue), terminalOutput);
  assert.match(terminalClose, /closed terminal session/);
  assert.equal(freshWorker, true);
  assert.match(ralphResult, /reported completion after 1 round/);
  assert.match(ralphResult, /isolated proof/);
});

test("PTC executes typed code and an approved MCP binding with the selected runtime", { timeout: 60_000 }, async (t) => {
  const sessionId = "ptc-mcp-runtime-fixture";
  const toolName = "mcp_fixture_ptc_lookup";
  const calls = [];
  let resultSeen = false;
  const runtime = await fixture(t, (body, response) => {
    const result = body.messages.find(message => message.role === "tool");
    if (result) {
      const content = JSON.stringify(result.content);
      assert.match(content, /42/);
      assert.match(content, /approved PTC host result/);
      resultSeen = true;
      modelReply(response, "Typed PTC and MCP fixture completed.");
    } else {
      assert.deepEqual(body.tools.map(tool => tool.function.name), ["run_code"]);
      fixtureTool(response, "ptc-program", "run_code", {
        description: "Run typed code and an approved fixture tool",
        code: `const n: number = 41; const result = await tools.${toolName}({ query: "typed PTC query" }); return { answer: n + 1, result };`,
      });
    }
  }, async (method, params) => {
    assert.equal(method, "lolicode/mcp/approve-and-call");
    calls.push(params);
    return { content: [{ type: "text", text: "approved PTC host result" }] };
  });
  const launches = path.join(runtime.home, "ptc-launches.jsonl");
  const observer = path.join(runtime.home, "ptc-launch-observer.mjs");
  await writeFile(observer, `
import { appendFileSync } from "node:fs";
export const name = "ptc-launch-observer";
export const inject = ["subprocess"];
export function apply(ctx) {
  const original = ctx.subprocess.spawn.bind(ctx.subprocess);
  ctx.subprocess.spawn = spec => {
    appendFileSync(${JSON.stringify(launches)}, JSON.stringify(spec.argv) + "\\n");
    return original(spec);
  };
}
`);
  const patch = path.join(runtime.home, "ptc.json");
  await writeFile(patch, JSON.stringify([
    { id: "tool-executor-native", disabled: true },
    { id: "tool-executor-ptc", disabled: false },
    { id: "ptc-runtime", config: { executionMode: "per-call" } },
    { insert: [{ id: "ptc-launch-observer", name: observer }] },
  ]));
  const client = await runtime.start({ patchFiles: [patch] });
  try {
    await client.open(sessionId);
    await client.request("lolicode/session/configure-workspace", { sessionId, workspace: { policy: "workspace", skills: [], memory: "" } });
    await client.request("lolicode/session/configure-mcp", { sessionId, tools: [{ function: {
      name: toolName, description: "Read a fixture through host approval", parameters: {
        type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
      },
    } }] });
    await client.prompt(sessionId, "Run the typed PTC fixture.");
    await client.wait(sessionId);
    assert.equal(runtime.modelError, undefined);
    assert.equal(resultSeen, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, sessionId);
    assert.equal(calls[0].toolName, toolName);
    assert.deepEqual(calls[0].arguments, { query: "typed PTC query" });
    assert.match(calls[0].callId, /^ptc-program:ptc:\d+$/);
    const commands = (await readFile(launches, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
    const normalize = value => path.resolve(value).toLowerCase();
    const bootstrap = path.join(root, "node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js");
    assert.ok(commands.some(argv => argv.some(arg => normalize(arg) === normalize(process.execPath)) &&
      argv.some(arg => normalize(arg) === normalize(bootstrap))), "The real PTC subprocess must use the selected Node and compiled SDK bootstrap");
  } finally {
    await client.shutdown();
  }
});

test("real rc.1 root and worker histories resume under the selected rc.2 runtime", {
  timeout: 90_000, skip: !process.env.LOLICODE_TEST_BASELINE_RUNTIME_ROOT,
}, async (t) => {
  const baseline = process.env.LOLICODE_TEST_BASELINE_RUNTIME_ROOT;
  assert.ok(path.isAbsolute(baseline));
  const sdkVersion = async directory => JSON.parse(await readFile(path.join(directory, "node_modules/@deepseek-ai/dsh/package.json"), "utf8")).version;
  assert.equal(await sdkVersion(baseline), "0.2.2-rc.1");
  assert.equal(await sdkVersion(root), "0.2.2-rc.2");
  const sessionId = "rc1-root-continued-in-rc2";
  const childSessionId = "b643ecea-f069-454f-8f52-898cbbfd32d7";
  const calls = [];
  const runtime = await fixture(t, (body, response) => {
    const input = JSON.stringify(body.messages);
    if (input.includes("RC2_CHILD_CONTINUE")) {
      assert.match(input, /RC1_CHILD_START/);
      assert.match(input, /RC1_CHILD_ANSWER/);
      calls.push("rc2-child");
      return modelReply(response, "RC2_CHILD_ANSWER");
    }
    if (input.includes("RC2_ROOT_CONTINUE")) {
      assert.match(input, /RC1_ROOT_START/);
      assert.match(input, /RC1_ROOT_ANSWER/);
      if (calls.includes("rc2-child")) {
        assert.match(input, /RC2_CHILD_ANSWER/);
        calls.push("rc2-root-notified");
      } else calls.push("rc2-root");
      return modelReply(response, "RC2_ROOT_ANSWER");
    }
    if (input.includes("RC1_CHILD_START")) {
      calls.push("rc1-child");
      return modelReply(response, "RC1_CHILD_ANSWER");
    }
    assert.match(input, /RC1_ROOT_START/);
    calls.push("rc1-root");
    modelReply(response, "RC1_ROOT_ANSWER");
  });
  const delegate = { sessionId, childSessionId, label: "Existing worker", workspacePolicy: "review", content: [{ type: "text", text: "RC1_CHILD_START" }] };
  const first = await runtime.start({ launchRoot: baseline });
  try {
    await first.open(sessionId);
    await first.request("lolicode/session/configure-secretary", { sessionId });
    await first.prompt(sessionId, "RC1_ROOT_START");
    await first.wait(sessionId);
    await first.request("lolicode/secretary/delegate-worker", delegate);
    await first.wait(sessionId);
  } finally {
    await first.shutdown();
  }
  assert.deepEqual(calls, ["rc1-root", "rc1-child"]);
  const sessions = path.join(runtime.home, "sessions");
  const logs = (await readdir(sessions, { recursive: true })).filter(name => /\.jsonl(?:\.zstd)?$/.test(name));
  const original = await Promise.all(logs.map(async name => [name, await readFile(path.join(sessions, name))]));
  const cold = await execFileAsync(process.execPath, [path.join(root, "host-session-native.mjs"), sessions, sessionId], { env: {}, windowsHide: true, timeout: 45_000 });
  const result = JSON.parse(cold.stdout);
  assert.equal(result.state.active, false);
  assert.equal(result.projections.values.agentTeam.enabled, false);
  for (const [name, bytes] of original) assert.deepEqual(await readFile(path.join(sessions, name)), bytes);
  const second = await runtime.start();
  try {
    await second.request("session/resume", { sessionId });
    await second.request("lolicode/session/configure-secretary", { sessionId });
    assert.deepEqual(await second.request("lolicode/secretary/delegate-worker", delegate), { childSessionId });
    await second.prompt(sessionId, "RC2_ROOT_CONTINUE");
    await second.wait(sessionId);
    await second.request("lolicode/secretary/prompt-worker", {
      sessionId, childSessionId, requestId: "rc2-worker-followup", content: [{ type: "text", text: "RC2_CHILD_CONTINUE" }],
    });
    await second.wait(sessionId);
  } finally {
    await second.shutdown();
  }
  assert.equal(runtime.modelError, undefined);
  assert.deepEqual(calls, ["rc1-root", "rc1-child", "rc2-root", "rc2-child", "rc2-root-notified"]);
  t.diagnostic(`rc.1 root/worker logs continued under ${root}; Node ${process.execPath}; cold reads preserved original bytes.`);
});
