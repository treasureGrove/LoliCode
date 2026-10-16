import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { ENGINE_VERSION, PlatformError, type SessionInput } from "@lolicode/platform-contracts";
import { readSse } from "@lolicode/platform-contracts/sse";

export type NativeObject = Record<string, unknown>;
export interface EngineOptions {
  root: string;
  config: NativeObject;
  executable?: string;
  onEvent?: (event: NativeObject) => void;
  onExit?: () => void;
}
const record = (value: unknown): NativeObject => typeof value === "object" && value !== null && !Array.isArray(value) ? value as NativeObject : {};
const array = (value: unknown): NativeObject[] => Array.isArray(value) ? value.map(record) : [];

export function resolveOpenCodeExecutable() {
  const require = createRequire(import.meta.url);
  const cli = require.resolve("@opencode/cli/package.json");
  const platform: Record<string, string> = { "win32-x64": "windows-x64-baseline", "win32-arm64": "windows-arm64", "linux-x64": "linux-x64-baseline", "linux-arm64": "linux-arm64", "darwin-x64": "darwin-x64-baseline", "darwin-arm64": "darwin-arm64" };
  const suffix = platform[`${process.platform}-${process.arch}`];
  if (!suffix) throw new PlatformError("unsupported_platform", "No pinned OpenCode runtime for this platform", 503);
  const manifest = createRequire(cli).resolve(`@opencode/cli-${suffix}/package.json`);
  const info = require(manifest) as { version: string };
  if (info.version !== ENGINE_VERSION) throw new PlatformError("engine_version", `OpenCode ${ENGINE_VERSION} is required`, 503);
  return path.join(path.dirname(manifest), "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
}

/** Owns exactly one pinned engine. stdio EOF is the engine's parent-death boundary. */
export class OpenCodeAdapter {
  state: "stopped" | "starting" | "ready" | "failed" = "stopped";
  private child?: ChildProcess;
  private endpoint = "";
  private password = randomBytes(32).toString("hex");
  private starting?: Promise<void>;
  private stream?: AbortController;
  private closed = false;
  private secrets: string[];

  constructor(private readonly options: EngineOptions) {
    if (!path.isAbsolute(options.root)) throw new Error("Engine root must be absolute");
    const secrets = new Set<string>([this.password]);
    const visit = (value: unknown, secret = false) => {
      if (typeof value === "string" && secret && value.length >= 8) secrets.add(value);
      if (Array.isArray(value)) value.forEach((item) => visit(item, secret));
      if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) visit(child, secret || /^(api.?key|authorization|password|token|bearer.?token|headers|environment)$/i.test(key));
    };
    visit(options.config);
    this.secrets = [...secrets].sort((a, b) => b.length - a.length);
  }
  sanitize<T>(value: T): T {
    const redact = (item: unknown): unknown => {
      if (typeof item === "string") return this.secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), item);
      if (Array.isArray(item)) return item.map(redact);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, /^(api.?key|authorization|password|bearer.?token)$/i.test(key) ? "[REDACTED]" : redact(child)]));
      return item;
    };
    return redact(value) as T;
  }
  async start() {
    if (this.closed) throw new PlatformError("engine_closed", "Engine has stopped", 503);
    if (this.state === "ready") return;
    if (!this.starting) this.starting = this.launch().catch(async (error: unknown) => { this.state = "failed"; await this.stop(); throw error; });
    await this.starting;
  }
  private async launch() {
    this.state = "starting";
    const root = this.options.root;
    for (const directory of ["home", "config", "data", "cache", "state", "tmp"]) await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, "config", "opencode.json"), JSON.stringify(this.options.config), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|LANG|LC_ALL|LC_CTYPE|TERM|SHELL|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|USER|USERNAME)$/i.test(key)) env[key] = value;
    Object.assign(env, { OPENCODE_CLIENT: "lolicode-platform", OPENCODE_PASSWORD: this.password, OPENCODE_TEST_HOME: path.join(root, "home"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "state"), OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "data", "platform.db"), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMPDIR: path.join(root, "tmp") });
    const child = spawn(this.options.executable ?? resolveOpenCodeExecutable(), ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], { cwd: path.join(root, "home"), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    this.child = child;
    child.stderr?.resume(); // Provider diagnostics can contain credentials; never forward them.
    child.on("exit", () => {
      if (this.state !== "stopped") { this.state = "failed"; this.stream?.abort(); this.options.onExit?.(); }
    });
    this.endpoint = await new Promise<string>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      let bytes = 0;
      const timer = setTimeout(() => done(new Error("OpenCode startup timed out")), 30_000);
      const onError = () => done(new Error("Could not start pinned OpenCode"));
      const done = (error?: Error, endpoint?: string) => { clearTimeout(timer); lines.close(); child.stdout?.resume(); child.off("error", onError); child.off("exit", onError); error ? reject(error) : resolve(endpoint!); };
      child.once("error", onError); child.once("exit", onError);
      lines.on("line", (line) => {
        bytes += line.length;
        if (bytes > 64 * 1024) return done(new Error("Invalid engine startup response"));
        try {
          const value = JSON.parse(line) as { url?: string };
          if (!value.url) return;
          const url = new URL(value.url);
          if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || !["", "/"].includes(url.pathname) || url.search || url.hash) return done(new Error("Engine returned an invalid address"));
          done(undefined, url.origin);
        } catch { /* Ignore non-protocol startup lines without logging them. */ }
      });
    });
    // Keep an error listener after startup as well; no unhandled child 'error' events.
    child.on("error", () => { this.state = "failed"; this.stream?.abort(); this.options.onExit?.(); });
    const info = record(await this.request("/api/info"));
    if (info.version !== ENGINE_VERSION) throw new PlatformError("engine_version", `OpenCode ${ENGINE_VERSION} is required`, 503);
    this.stream = new AbortController();
    await this.connectEvents(this.stream.signal);
    this.state = "ready";
  }
  private async connectEvents(signal: AbortSignal) {
    const response = await fetch(`${this.endpoint}/api/event`, { headers: { Authorization: this.authorization() }, signal, redirect: "error" });
    if (!response.ok) throw new PlatformError("engine_stream", "Could not connect engine events", 503);
    void (async () => {
      try {
        for await (const frame of readSse(response)) {
          const event = record(JSON.parse(frame.data));
          this.options.onEvent?.(this.sanitize(event));
        }
      } catch { /* Snapshot reconciliation is authoritative after a stream gap. */ }
      if (!signal.aborted) {
        this.options.onEvent?.({ type: "platform.engine_stream_gap", data: {} });
        await delay(500, undefined, { signal }).catch(() => {});
        if (!signal.aborted) await this.connectEvents(signal).catch(() => this.options.onEvent?.({ type: "platform.engine_stream_gap", data: {} }));
      }
    })();
  }
  private authorization() { return `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`; }
  private async request(route: string, method = "GET", body?: unknown): Promise<unknown> {
    if (!this.child || this.child.exitCode !== null) throw new PlatformError("engine_stopped", "OpenCode is not running", 503);
    try {
      const response = await fetch(`${this.endpoint}${route}`, { method, headers: { Authorization: this.authorization(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (response.status === 204) return null;
      const text = await response.text();
      if (text.length > 64 * 1024 * 1024) throw new Error("Response too large");
      const value = JSON.parse(text) as unknown;
      if (!response.ok) throw new PlatformError("engine_request", `OpenCode request failed (${response.status})`, response.status === 404 ? 404 : 502);
      return value;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError("engine_connection", "OpenCode request could not be confirmed; reconcile before retrying", 502);
    }
  }
  async createSession(directory: string, model: { providerId: string; modelId: string }, input: SessionInput) {
    await this.start();
    const permissions = [{ action: "*", resource: "*", effect: "ask" }, ...["read", "glob", "grep", "list", "skill", "question"].map((action) => ({ action, resource: "*", effect: "allow" }))];
    if (input.mode === "plan") permissions.push({ action: "*", resource: "*", effect: "deny" }, ...["read", "glob", "grep", "list", "skill", "question"].map((action) => ({ action, resource: "*", effect: "allow" })));
    const response = record(await this.request("/api/session", "POST", { location: { directory }, model: { providerID: model.providerId, id: model.modelId }, agent: input.mode, permissions, ...(input.title ? { title: input.title } : {}) }));
    return this.sanitize(record(response.data));
  }
  async send(sessionId: string, messageId: string, text: string) { await this.request(`/api/session/${sessionId}/prompt`, "POST", { id: messageId, text, delivery: "queue", resume: true }); }
  async cancel(sessionId: string) { await this.request(`/api/session/${sessionId}/interrupt?resume=false`, "POST"); }
  async replyPermission(sessionId: string, id: string, decision: string) { await this.request(`/api/session/${sessionId}/permission/${id}/reply`, "POST", { decision }); }
  async replyForm(sessionId: string, id: string, answer: NativeObject) { await this.request(`/api/session/${sessionId}/form/${id}/reply`, "POST", { answer }); }
  async snapshot(sessionId: string) {
    await this.start();
    const prefix = `/api/session/${sessionId}`;
    const [active, permissions, forms, inbox] = await Promise.all([this.request("/api/session/active"), this.request(`${prefix}/permission`), this.request(`${prefix}/form`), this.request(`${prefix}/inbox`)]);
    const messages: NativeObject[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const params = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : { order: "asc" }) });
      const response = record(await this.request(`${prefix}/message?${params}`));
      messages.push(...array(response.data));
      const next = record(response.cursor).next;
      cursor = typeof next === "string" && next ? next : undefined;
      if (cursor && (seen.has(cursor) || messages.length > 100_000)) throw new PlatformError("engine_pagination", "Invalid engine history cursor", 502);
      if (cursor) seen.add(cursor);
    } while (cursor);
    const requests = array(record(permissions).data);
    const questions = array(record(forms).data);
    const queued = array(record(inbox).data).some((item) => item.status !== "aborted" && item.status !== "consumed");
    return this.sanitize({ messages, permissions: requests, forms: questions, active: record(record(active).data)[sessionId] && record(record(record(active).data)[sessionId]).type === "running" || queued || requests.length > 0 || questions.length > 0 });
  }
  async stop() {
    this.closed = true;
    this.state = "stopped";
    this.stream?.abort();
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.stdin?.end();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timer = setTimeout(() => {
      if (child.exitCode !== null) return;
      if (process.platform === "win32") {
        const killer = spawn(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => child.kill());
      } else { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    }, 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
}
