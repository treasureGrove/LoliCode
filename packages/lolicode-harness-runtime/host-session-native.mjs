import path from "node:path";
import { TYPERT_REMOTE } from "@deepseek-ai/dsh-api-session-controller/remote";
import { logMissing, logUnreadable, sessionMarkdownError } from "./host-session-markdown.mjs";

export const nativeTooLarge = "LOLICODE_SESSION_NATIVE_TOO_LARGE";
const maximumBytes = 8 * 1024 * 1024;
const maximumPendingOutput = 16 * 1024 * 1024;
const readers = new WeakMap();
function nativeReaderScope() {}

export function nativePagination(request = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).some((key) => !["beforeSeq", "throughSeq", "maxMessages"].includes(key))) {
    throw new Error("Invalid native session pagination");
  }
  const result = {};
  for (const key of ["beforeSeq", "throughSeq", "maxMessages"]) {
    const value = request[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < (key === "maxMessages" ? 1 : 0) ||
        (key === "maxMessages" && value > 200)) throw new Error("Invalid native session pagination");
    result[key] = value;
  }
  return { maxMessages: 50, ...result };
}

async function installReader(ctx) {
  const scope = ctx.plugin(nativeReaderScope);
  await scope.await();
  const owner = scope.ctx;
  try {
    // These are the real upstream services, activated only on the first native
    // read. Connection is carrier-neutral: no Web Server or HTTP port is added.
    for (const [name, service] of [
      ["@deepseek-ai/dsh-client-connection", "connection"],
      ["@deepseek-ai/dsh-workspace", "workspaceRegistry"],
      ["@deepseek-ai/dsh-client-file-upload", "fileUploads"],
      ["@deepseek-ai/dsh-api-session-controller", "sessionController"],
      ["@deepseek-ai/dsh-session-stats"],
      ["@deepseek-ai/dsh-session-turn-outline"],
    ]) {
      if (service && ctx.get(service)) continue;
      const plugin = await import(name);
      await owner.plugin(plugin.default ?? plugin).await();
    }
    // Dynamic plugins are not Loader roster rows. Register the unchanged public
    // generated Host manifest when the roster has not already registered it.
    if (!ctx.typert.getPackage("@deepseek-ai/dsh-api-session-controller", "host")) {
      const { TYPERT } = await import("@deepseek-ai/dsh-api-session-controller/typert");
      owner.effect(() => ctx.typert.register(TYPERT), "native session generated contract");
    }
    return owner.get("connection").createPeer({ principal: { kind: "owner" }, interactions: "none" });
  } catch (error) {
    await scope.dispose();
    throw error;
  }
}

async function readerPeer(ctx) {
  let ready = readers.get(ctx.root);
  if (!ready) {
    ready = installReader(ctx.root);
    readers.set(ctx.root, ready);
  }
  try {
    return await ready;
  } catch (error) {
    if (readers.get(ctx.root) === ready) readers.delete(ctx.root);
    throw error;
  }
}

/** Install official observation before the first Agent can emit stream frames. */
export async function prepareNativeSession(ctx) {
  await readerPeer(ctx);
}

export function boundedNativeSession(result) {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximumBytes) throw new Error(nativeTooLarge);
  return result;
}

export function notifyNativeSessionFrame(transport, output, subscriptionId, frame) {
  // Never wait on the shared SDK carrier: that would move the backlog into the
  // upstream listener and delay execution traffic. Stop only this observer.
  if (output.writableLength > maximumPendingOutput) throw new Error("LOLICODE_SESSION_NATIVE_FOLLOW_BACKLOG");
  transport.notify("lolicode/session.native-follow", { subscriptionId, frame });
}

export function nativeSessionError(error) {
  if (error?.message === nativeTooLarge) return nativeTooLarge;
  if (error?.code === "session/not-found" || error?.code === "subagent/not-found") return logMissing;
  return sessionMarkdownError(error);
}

async function nativeSessionAccess(ctx, sessionId) {
  const host = ctx.root;
  const peer = await readerPeer(host);
  const header = host.sessions.get(sessionId)?.header ?? (await host.sessionPersistence.stat(sessionId))?.header;
  const address = header?.origin === "subagent"
    ? { kind: "subagent", parentSessionId: header.parentSession, childSessionId: sessionId, mode: "unknown" }
    : { kind: "session", sessionId };
  return { host, peer, address };
}

/** Caller must establish desktop root/child ownership before invoking this. */
export async function readNativeSession(ctx, sessionId, request = {}) {
  const pagination = nativePagination(request);
  const { host, peer, address } = await nativeSessionAccess(ctx, sessionId);
  const signal = AbortSignal.timeout(30_000);
  async function invoke(method, request) {
    const descriptor = TYPERT_REMOTE.methods[`session/${method}`];
    const args = { request };
    descriptor.input({ strict: true }).create().parse(args);
    const result = await host.typertGateway.invoke({ namespace: "session", method, args, peer, signal });
    // Validate with the generated official contract, returning the original
    // value so validation cannot strip additional fields from event envelopes.
    descriptor.result.create().parse(result);
    return result;
  }
  const page = await invoke("events", { address, ...pagination });
  const projections = await invoke("projections", { sessionId });
  const state = await invoke("state", { sessionId });
  // Projection/state reads can be newer than the fixed history cut while an
  // Agent is running; their own official cursors remain intact.
  return boundedNativeSession({ page, projections, state });
}

/** Passive stream; caller owns cancellation and desktop session authorization. */
export async function followNativeSession(ctx, sessionId, request, signal) {
  const pagination = nativePagination(request);
  if (pagination.beforeSeq !== undefined || pagination.throughSeq !== undefined) throw new Error("Invalid native follow parameters");
  const { host, peer, address } = await nativeSessionAccess(ctx, sessionId);
  const descriptor = TYPERT_REMOTE.methods["session/follow"];
  // Observe both the official committed journal and transient attempt frames.
  // assistantStream only binds observation; omitting activate avoids promotion
  // or a new Agent/turn when opening the default conversation.
  const args = { request: { address, assistantStream: true, maxMessages: pagination.maxMessages } };
  descriptor.input({ strict: true }).create().parse(args);
  const source = await host.typertGateway.stream({ namespace: "session", method: "follow", args, peer, signal });
  return (async function* () {
    for await (const frame of source) {
      descriptor.result.create().parse(frame);
      yield boundedNativeSession(frame);
    }
  })();
}

async function readColdNative(sessions, sessionId, request, suppliedHome) {
  if (!path.isAbsolute(sessions ?? "") || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId ?? "")) {
    throw new Error(logUnreadable);
  }
  const pagination = nativePagination(request);
  const [{ mkdtemp, rm }, os] = await Promise.all([import("node:fs/promises"), import("node:os")]);
  const parent = path.resolve(os.tmpdir());
  if (suppliedHome !== undefined && !path.isAbsolute(suppliedHome)) throw new Error(logUnreadable);
  const home = suppliedHome ?? await mkdtemp(path.join(parent, "lolicode-native-read-"));
  let ctx;
  try {
    // The original sessions directory is only a read backend. Profiles,
    // credentials and disposable caches belong to a fresh helper HOME.
    process.env.DSH_HOME = home;
    process.env.DSH_TELEMETRY_DISABLED = "1";
    process.chdir(home);
    const { createNativeReaderContext } = await import("./host-native-reader-context.mjs");
    ctx = await createNativeReaderContext(home, sessions);
    return await readNativeSession(ctx, sessionId, pagination);
  } finally {
    try {
      if (ctx) await ctx.fiber.dispose();
    } finally {
      // Rust owns supplied directories, including timeout/forced-exit cleanup.
      // A standalone CLI still owns and cleans up its own disposable HOME.
      if (suppliedHome === undefined) {
        if (path.dirname(home) !== parent || !path.basename(home).startsWith("lolicode-native-read-")) throw new Error(logUnreadable);
        process.chdir(parent);
        await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }
}

if (import.meta.main) {
  try {
    const [, , sessions, sessionId, request = "{}", home] = process.argv;
    if (Buffer.byteLength(request, "utf8") > 1024) throw new Error(logUnreadable);
    process.stdout.write(JSON.stringify(await readColdNative(sessions, sessionId, JSON.parse(request), home)));
  } catch (error) {
    const message = nativeSessionError(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = message === logMissing ? 2 : message === nativeTooLarge ? 3 : 1;
  }
}
