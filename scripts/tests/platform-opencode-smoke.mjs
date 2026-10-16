import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPlatformHost } from "../../packages/platform-host/dist/index.js";
import { PlatformClient } from "../../packages/platform-client/dist/index.js";

const root = await mkdtemp(path.join(tmpdir(), "lolicode-platform-real-engine-"));
const project = path.join(root, "项目 with spaces");
await mkdir(project);
const requests = [];
const fixture = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requests.push(input);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const content = "PLATFORM_REAL_ENGINE_OK";
  response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
const secret = `fixture-only-${randomUUID()}`;
const options = { root: path.join(root, "host"), models: [{ id: "fixture/offline", providerId: "fixture", modelId: "offline", name: "Offline integration fixture" }], engineConfig: {
  providers: { fixture: { name: "Offline fixture", package: "@ai-sdk/openai-compatible", settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: secret }, models: { offline: { modelID: "offline", name: "Offline fixture", limit: { context: 32_000, output: 2000 } } } } },
  model: "fixture/offline", default_agent: "build", update: "disable", share: "disabled", snapshots: false,
  experimental: { policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "fixture", effect: "allow" }] },
} };
let host;
try {
  host = await createPlatformHost(options);
  let client = new PlatformClient(host.connection);
  const workspace = await client.registerWorkspace({ path: project });
  const session = await client.createSession({ workspaceId: workspace.id, modelId: "fixture/offline", title: "Owned offline smoke", mode: "build" });
  console.log("real engine session created", session.nativeId);
  const input = { requestId: randomUUID(), text: "Reply with PLATFORM_REAL_ENGINE_OK." };
  const run = await client.run(session.id, input);
  assert.equal(run.status, "running");
  assert.equal((await client.run(session.id, input)).id, run.id);
  const deadline = Date.now() + 45_000;
  let state;
  do {
    state = await client.snapshot();
    if (!state.runs.some((item) => item.id === run.id && ["queued", "running", "waiting_user", "cancelling"].includes(item.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  const native = await client.session(session.id);
  if (state.runs.find((item) => item.id === run.id)?.status !== "succeeded") console.log(JSON.stringify({ run: state.runs, messages: native.messages.map((item) => ({ type: item.type, content: item.content, reason: item.reason, error: item.error })), permissions: native.permissions }));
  assert.equal(state.runs.find((item) => item.id === run.id)?.status, "succeeded");
  assert.ok(JSON.stringify(native.messages).includes("PLATFORM_REAL_ENGINE_OK"));
  assert.ok(requests.length > 0);
  assert.ok(!JSON.stringify(native).includes(secret));
  await host.close();
  host = await createPlatformHost(options);
  client = new PlatformClient(host.connection);
  const restored = await client.snapshot();
  assert.equal(restored.sessions[0].nativeId, session.nativeId);
  assert.equal((await client.run(session.id, input)).id, run.id);
  assert.ok(JSON.stringify((await client.session(session.id)).messages).includes("PLATFORM_REAL_ENGINE_OK"));
  assert.ok(!(await readFile(path.join(options.root, "journal.jsonl"), "utf8")).includes(secret));
  console.log(JSON.stringify({ result: "passed", engine: "OpenCode 2.0.12", checks: ["real engine + local model HTTP/SSE", "Chinese/space project path", "persistent session and run", "idempotent prompt", "completed turn", "cold restart history", "credential redaction"], modelRequests: requests.length }));
} finally {
  await host?.close(); fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve));
  assert.ok(root.startsWith(path.join(tmpdir(), "lolicode-platform-real-engine-")));
  await rm(root, { recursive: true, force: true });
}
