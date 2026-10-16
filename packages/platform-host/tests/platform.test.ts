import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PlatformClient, PROTOCOL_VERSION, Connection } from "@lolicode/platform-client";
import { createPlatformHost, PlatformStore } from "../src/index.js";
import { readSse } from "@lolicode/platform-contracts/sse";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function temporary() { const root = await mkdtemp(path.join(tmpdir(), "lolicode-platform-unit-")); cleanup.push(() => rm(root, { recursive: true, force: true })); return root; }

describe("platform journal", () => {
  it("rejects a second writer, restores receipts, and preserves a torn tail", async () => {
    const root = await temporary();
    const store = new PlatformStore(root);
    expect(() => new PlatformStore(root)).toThrow("already has a writer");
    store.putRun({ id: "run_test", sessionId: "ps_test", requestId: randomUUID(), nativeMessageId: "msg_test", text: "owned request", status: "running", createdAt: 1, updatedAt: 1 });
    store.event("test.event", { nativeExtension: { untouched: 42 } }); store.close();
    await appendFile(path.join(root, "journal.jsonl"), '{"incomplete":');
    const recovered = new PlatformStore(root);
    expect(recovered.runs.get("run_test")?.status).toBe("running");
    expect(recovered.events[0].data).toEqual({ nativeExtension: { untouched: 42 } });
    recovered.close();
    expect((await readFile(path.join(root, "journal.jsonl"), "utf8")).endsWith("\n")).toBe(true);
  });
  it("marks active receipts interrupted without sending them to an engine", async () => {
    const root = await temporary();
    const store = new PlatformStore(root);
    store.putRun({ id: "run_test", sessionId: "ps_test", requestId: randomUUID(), nativeMessageId: "msg_test", text: "never replay", status: "waiting_user", createdAt: 1, updatedAt: 1 }); store.close();
    const host = await createPlatformHost({ root, models: [], engineConfig: {}, executable: path.join(root, "does-not-exist") }); cleanup.push(host.close);
    const client = new PlatformClient(host.connection);
    const snapshot = await client.snapshot();
    expect(snapshot.runs[0].status).toBe("interrupted");
    expect(snapshot.engine.state).toBe("stopped");
  });
});

describe("platform transport", () => {
  it("requires bearer authentication, checks browser origin, and validates input", async () => {
    const root = await temporary();
    const host = await createPlatformHost({ root, models: [], engineConfig: {}, allowedOrigins: ["http://localhost:3000"] }); cleanup.push(host.close);
    expect((await fetch(new URL("v1/snapshot", host.connection.url))).status).toBe(401);
    const headers = { Authorization: `Bearer ${host.connection.token}` };
    expect((await fetch(new URL("v1/snapshot", host.connection.url), { headers: { ...headers, Origin: "https://unrelated.example" } })).status).toBe(403);
    const good = await fetch(new URL("v1/snapshot", host.connection.url), { headers: { ...headers, Origin: "http://localhost:3000" } });
    expect(good.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect((await good.json()).protocolVersion).toBe(PROTOCOL_VERSION);
    const invalid = await fetch(new URL("v1/workspaces", host.connection.url), { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ path: root, unexpected: "must not be accepted" }) });
    expect(invalid.status).toBe(400);
    const client = new PlatformClient(host.connection);
    const workspace = await client.registerWorkspace({ path: root });
    expect((await client.registerWorkspace({ path: root })).id).toBe(workspace.id);
    expect((await client.snapshot()).workspaces).toHaveLength(1);
  });
  it("replays events after the cursor and resets future cursors", async () => {
    const root = await temporary();
    const host = await createPlatformHost({ root, models: [], engineConfig: {} }); cleanup.push(host.close);
    const client = new PlatformClient(host.connection);
    await client.registerWorkspace({ path: root });
    const controller = new AbortController();
    const events = client.events(0, controller.signal);
    const first = await events.next();
    expect(first.value?.type).toBe("workspace.registered");
    controller.abort(); await events.return(undefined);
    const resetController = new AbortController();
    const reset = client.events(9999, resetController.signal);
    expect((await reset.next()).value).toEqual({ type: "platform.reset", cursor: 1 });
    resetController.abort(); await reset.return(undefined);
  });
  it("does not accept remote or credential-bearing bootstrap endpoints", () => {
    expect(Connection.safeParse({ protocolVersion: 1, url: "https://remote.example/", token: "x".repeat(32) }).success).toBe(false);
    expect(Connection.safeParse({ protocolVersion: 1, url: "http://user:password@127.0.0.1:1234/", token: "x".repeat(32) }).success).toBe(false);
  });
  it("decodes fragmented UTF-8, CRLF and multiline SSE without committing a partial frame", async () => {
    const bytes = new TextEncoder().encode('id: 1\r\nevent: native\r\ndata: {"文字":\r\ndata: "片段"}\r\n\r\ndata: unfinished');
    const response = new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3)); controller.close(); } }));
    const frames = [];
    for await (const frame of readSse(response)) frames.push(frame);
    expect(frames).toEqual([{ id: "1", event: "native", data: '{"文字":\n"片段"}' }]);
  });
});
