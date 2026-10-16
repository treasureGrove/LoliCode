import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpath, stat } from "node:fs/promises";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";
import { OpenCodeAdapter, type NativeObject } from "@lolicode/opencode-adapter";
import { ACTIVE_STATUSES, Connection, ENGINE_VERSION, FormReply, Id, Model, PermissionReply, PlatformError, PROTOCOL_VERSION, RunInput, SessionInput, WorkspaceInput, type PlatformEvent, type Run, type Session, type Snapshot } from "@lolicode/platform-contracts";
import { PlatformStore } from "./store.js";
export { PlatformStore } from "./store.js";

export interface HostOptions {
  root: string;
  engineConfig: NativeObject;
  models: Model[];
  allowedOrigins?: string[];
  executable?: string;
}
const object = (value: unknown): NativeObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as NativeObject : {};

export async function createPlatformHost(options: HostOptions) {
  const store = new PlatformStore(options.root);
  const bus = new EventEmitter();
  const token = randomBytes(32).toString("hex");
  const origins = new Set(options.allowedOrigins ?? []);
  const models = options.models.map((model) => Model.parse(model));
  let closing = false;
  let operations = 0;
  const gates = new Map<string, Promise<unknown>>();
  const exclusive = async <T>(key: string, action: () => Promise<T>) => {
    const previous = gates.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    gates.set(key, next);
    try { return await next; } finally { if (gates.get(key) === next) gates.delete(key); }
  };
  const publish = (type: string, data: unknown, sessionId?: string) => { const event = store.event(type, data, sessionId); bus.emit("event", event); return event; };
  const updateRun = (run: Run, status: Run["status"], error?: string) => {
    const next: Run = { ...run, status, updatedAt: Date.now(), ...(error ? { error } : {}) };
    store.putRun(next); publish("run.updated", next, run.sessionId); return next;
  };
  const engine = new OpenCodeAdapter({ root: path.join(options.root, "engines", "opencode"), config: options.engineConfig, executable: options.executable,
    onEvent(event) {
      if (closing) return;
      const nativeSession = object(event.data).sessionID;
      const session = [...store.sessions.values()].find((item) => item.nativeId === nativeSession);
      if (session) publish("opencode.event", event, session.id);
      else if (event.type === "platform.engine_stream_gap") publish("engine.stream_gap", {});
    },
    onExit() {
      if (closing) return;
      for (const run of store.runs.values()) if (ACTIVE_STATUSES.has(run.status)) updateRun(run, "interrupted", "Engine exited; execution was not replayed");
      publish("engine.exited", {});
    },
  });
  for (const run of store.runs.values()) if (ACTIVE_STATUSES.has(run.status)) updateRun(run, "interrupted", "Host restarted; execution was not replayed");
  const snapshot = (): Snapshot => ({ protocolVersion: PROTOCOL_VERSION, cursor: store.cursor, engine: { id: "opencode", version: ENGINE_VERSION, state: engine.state }, models, workspaces: [...store.workspaces.values()], sessions: [...store.sessions.values()], runs: [...store.runs.values()] });
  const sessionOf = (id: string) => { const session = store.sessions.get(Id.parse(id)); if (!session) throw new PlatformError("session_not_found", "Session does not belong to this Host", 404); return session; };

  const refreshRun = async (id: string) => exclusive(`run:${id}`, async () => {
    const current = store.runs.get(id);
    if (!current || !ACTIVE_STATUSES.has(current.status) || current.status === "queued") return;
    const session = sessionOf(current.sessionId);
    const native = await engine.snapshot(session.nativeId);
    const run = store.runs.get(id)!;
    if (!ACTIVE_STATUSES.has(run.status)) return;
    const waiting = native.permissions.length > 0 || native.forms.length > 0;
    if (waiting && run.status !== "cancelling") { if (run.status !== "waiting_user") updateRun(run, "waiting_user"); return; }
    if (native.active) { if (run.status === "waiting_user") updateRun(run, "running"); return; }
    const index = native.messages.findIndex((message) => message.id === run.nativeMessageId);
    if (index < 0) return; // A prompt receipt is not proof that execution has settled.
    const tail = native.messages.slice(index + 1);
    const idle = [...tail].reverse().find((message) => message.type === "idle");
    if (!idle) return;
    const failed = tail.some((message) => message.type === "error" || message.type === "assistant" && !!message.error);
    updateRun(run, run.status === "cancelling" ? "cancelled" : failed ? "failed" : "succeeded", failed ? "Engine reported a failed turn; inspect its native history" : undefined);
  });
  const poll = setInterval(() => {
    if (closing) return;
    for (const run of store.runs.values()) if (ACTIVE_STATUSES.has(run.status) && run.status !== "queued" && !gates.has(`run:${run.id}`)) void refreshRun(run.id).catch(() => {
      // A transient request error does not prove success, failure or cancellation.
    });
  }, 400);
  poll.unref();

  const bodyOf = async (request: IncomingMessage): Promise<unknown> => {
    if (!(request.headers["content-type"] ?? "").startsWith("application/json")) throw new PlatformError("content_type", "Expected application/json", 415);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 512 * 1024) throw new PlatformError("body_limit", "Request is too large", 413); chunks.push(Buffer.from(chunk)); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new PlatformError("invalid_json", "Invalid JSON request"); }
  };
  const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(value)); };
  let authority = "";
  const clients = new Set<ServerResponse>();
  const server = createServer((request, response) => { void (async () => {
    if (request.headers.host !== authority) throw new PlatformError("host_header", "Invalid Host authority", 403);
    const origin = request.headers.origin;
    if (origin && !origins.has(origin)) throw new PlatformError("origin", "Origin is not allowed", 403);
    if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); }
    if (request.method === "OPTIONS") { response.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type" }); response.end(); return; }
    const authorization = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) throw new PlatformError("unauthorized", "Host authentication required", 401);
    if (closing) throw new PlatformError("host_closing", "Host is stopping", 503);
    const url = new URL(request.url ?? "/", `http://${authority}`);
    const route = url.pathname;
    const method = request.method;
    if (method === "GET" && route === "/v1/snapshot") { json(response, 200, snapshot()); return; }
    if (method === "GET" && route === "/v1/events") {
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0) throw new PlatformError("cursor", "Invalid event cursor");
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive" });
      clients.add(response);
      const send = (event: PlatformEvent) => { if (!response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)) response.destroy(); };
      // Journal replay and subscription occur synchronously, so no live event falls between them.
      if (after > store.cursor || after < (store.events[0]?.sequence ?? 1) - 1) response.write(`event: reset\ndata: ${JSON.stringify(snapshot())}\n\n`);
      else for (const event of store.events) if (event.sequence > after) send(event);
      bus.on("event", send);
      const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
      response.on("close", () => { clearInterval(heartbeat); clients.delete(response); bus.off("event", send); });
      return;
    }
    operations++;
    try {
      if (method === "POST" && route === "/v1/workspaces") {
        const input = WorkspaceInput.parse(await bodyOf(request));
        if (!path.isAbsolute(input.path)) throw new PlatformError("workspace_path", "Choose an absolute project directory");
        const directory = await realpath(input.path);
        if (!(await stat(directory)).isDirectory()) throw new PlatformError("workspace_path", "Project must be a directory");
        const key = process.platform === "win32" ? directory.toLowerCase() : directory;
        const workspace = { id: `ws_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`, path: directory, name: path.basename(directory) || directory };
        store.putWorkspace(workspace); publish("workspace.registered", workspace); json(response, 200, workspace); return;
      }
      if (method === "POST" && route === "/v1/sessions") {
        const input = SessionInput.parse(await bodyOf(request));
        const workspace = store.workspaces.get(input.workspaceId);
        const model = models.find((item) => item.id === input.modelId);
        if (!workspace || !model) throw new PlatformError("session_input", "Select a registered project and configured model");
        const native = await engine.createSession(workspace.path, model, input);
        const nativeId = Id.parse(native.id);
        const session: Session = { id: `ps_${randomUUID()}`, nativeId, workspaceId: workspace.id, engine: "opencode", engineVersion: ENGINE_VERSION, modelId: model.id, title: input.title ?? String(native.title ?? "OpenCode"), mode: input.mode, createdAt: Date.now() };
        store.putSession(session); publish("session.created", session, session.id); json(response, 201, session); return;
      }
      const sessionRoute = route.match(/^\/v1\/sessions\/([a-zA-Z0-9_-]+)$/);
      if (method === "GET" && sessionRoute) {
        const session = sessionOf(sessionRoute[1]);
        json(response, 200, { session, ...await engine.snapshot(session.nativeId) }); return;
      }
      const runRoute = route.match(/^\/v1\/sessions\/([a-zA-Z0-9_-]+)\/runs$/);
      if (method === "POST" && runRoute) {
        const session = sessionOf(runRoute[1]);
        const input = RunInput.parse(await bodyOf(request));
        const result = await exclusive(`session:${session.id}`, async () => {
          const duplicate = [...store.runs.values()].find((run) => run.requestId === input.requestId);
          if (duplicate) {
            if (duplicate.sessionId !== session.id || duplicate.text !== input.text) throw new PlatformError("request_conflict", "Request ID already belongs to different input", 409);
            return duplicate; // Never retry a side effect because a network response was lost.
          }
          if ([...store.runs.values()].some((run) => run.sessionId === session.id && ACTIVE_STATUSES.has(run.status))) throw new PlatformError("session_busy", "Session already has an active run", 409);
          const run: Run = { id: `run_${randomUUID()}`, sessionId: session.id, requestId: input.requestId, nativeMessageId: `msg_${input.requestId}`, text: input.text, status: "queued", createdAt: Date.now(), updatedAt: Date.now() };
          store.putRun(run); publish("run.updated", run, session.id);
          try { await engine.start(); await engine.send(session.nativeId, run.nativeMessageId, input.text); return updateRun(run, "running"); }
          catch { return updateRun(run, "interrupted", "Prompt admission could not be confirmed; inspect native history before continuing"); }
        });
        json(response, 202, result); return;
      }
      const cancelRoute = route.match(/^\/v1\/runs\/([a-zA-Z0-9_-]+)\/cancel$/);
      if (method === "POST" && cancelRoute) {
        await bodyOf(request);
        const result = await exclusive(`run:${cancelRoute[1]}`, async () => {
          const run = store.runs.get(cancelRoute[1]);
          if (!run) throw new PlatformError("run_not_found", "Run not found", 404);
          if (!ACTIVE_STATUSES.has(run.status)) return run;
          const pending = updateRun(run, "cancelling");
          await engine.cancel(sessionOf(run.sessionId).nativeId);
          // Upstream interrupt completion is followed by a snapshot; the UI never invents a cancelled state.
          const native = await engine.snapshot(sessionOf(run.sessionId).nativeId);
          return !native.active ? updateRun(pending, "cancelled") : pending;
        });
        json(response, 200, result); return;
      }
      const reply = route.match(/^\/v1\/sessions\/([a-zA-Z0-9_-]+)\/(permissions|forms)\/([a-zA-Z0-9_-]+)$/);
      if (method === "POST" && reply) {
        const session = sessionOf(reply[1]);
        if (reply[2] === "permissions") await engine.replyPermission(session.nativeId, Id.parse(reply[3]), PermissionReply.parse(await bodyOf(request)).decision);
        else await engine.replyForm(session.nativeId, Id.parse(reply[3]), FormReply.parse(await bodyOf(request)).answer);
        json(response, 200, { ok: true }); return;
      }
      throw new PlatformError("not_found", "Unknown platform operation", 404);
    } finally { operations--; }
  })().catch((error: unknown) => {
    if (response.headersSent) { response.destroy(); return; }
    const known = error instanceof PlatformError;
    const validation = error instanceof Error && error.name === "ZodError";
    json(response, known ? error.status : validation ? 400 : 500, { error: { code: known ? error.code : validation ? "invalid_input" : "host_error", message: known ? error.message : validation ? "Request does not match the platform contract" : "Platform operation failed" } });
  }); });
  server.requestTimeout = 35_000;
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
  catch (error) { clearInterval(poll); store.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind platform Host");
  authority = `127.0.0.1:${address.port}`;
  const connection = Connection.parse({ protocolVersion: PROTOCOL_VERSION, url: `http://${authority}/`, token });
  let closePromise: Promise<void> | undefined;
  return {
    connection, snapshot,
    busy: () => operations > 0 || [...store.runs.values()].some((run) => ACTIVE_STATUSES.has(run.status)),
    close: () => closePromise ??= (async () => {
      closing = true; clearInterval(poll);
      for (const client of clients) client.end();
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      while (operations > 0 || gates.size > 0) await new Promise((resolve) => setTimeout(resolve, 20));
      await engine.stop();
      for (const run of store.runs.values()) if (ACTIVE_STATUSES.has(run.status)) updateRun(run, "interrupted", "Host stopped; execution was not replayed");
      await stopped; store.close();
    })(),
  };
}
