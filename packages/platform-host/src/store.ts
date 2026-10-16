import { openSync, closeSync, readFileSync, writeFileSync, appendFileSync, fsyncSync, truncateSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PlatformError, PlatformEvent, Run, Session, Workspace } from "@lolicode/platform-contracts";

type Entry = { kind: "workspace" | "session" | "run" | "event"; value: unknown };
/** Single writer journal. Commands are durable before they reach a side-effecting runtime. */
export class PlatformStore {
  readonly workspaces = new Map<string, Workspace>();
  readonly sessions = new Map<string, Session>();
  readonly runs = new Map<string, Run>();
  readonly events: PlatformEvent[] = [];
  cursor = 0;
  private readonly fd: number;
  private readonly lockPath: string;
  private readonly lockNonce = randomUUID();
  private closed = false;
  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error("Platform root must be absolute");
    mkdirSync(root, { recursive: true });
    this.lockPath = path.join(root, "host.lock");
    if (existsSync(this.lockPath)) {
      const owner = JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid: number };
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid platform writer lock");
      try { process.kill(owner.pid, 0); throw new PlatformError("host_locked", "This platform data directory already has a writer", 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      unlinkSync(this.lockPath);
    }
    const lock = openSync(this.lockPath, "wx", 0o600);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: this.lockNonce })); fsyncSync(lock); closeSync(lock);
    const journal = path.join(root, "journal.jsonl");
    try {
      if (existsSync(journal)) {
        const bytes = readFileSync(journal);
        const last = bytes.lastIndexOf(10);
        if (last !== bytes.length - 1) {
          writeFileSync(path.join(root, `interrupted-tail-${randomUUID()}.bin`), bytes.subarray(last + 1), { mode: 0o600 });
          truncateSync(journal, last + 1);
        }
        const text = bytes.subarray(0, last + 1).toString("utf8");
        for (const line of text.split("\n")) if (line) this.apply(JSON.parse(line) as Entry);
      }
      this.fd = openSync(journal, "a", 0o600);
    } catch (error) { unlinkSync(this.lockPath); throw error; }
  }
  private apply(entry: Entry) {
    if (entry.kind === "workspace") { const value = Workspace.parse(entry.value); this.workspaces.set(value.id, value); }
    else if (entry.kind === "session") { const value = Session.parse(entry.value); this.sessions.set(value.id, value); }
    else if (entry.kind === "run") { const value = Run.parse(entry.value); this.runs.set(value.id, value); }
    else if (entry.kind === "event") {
      const value = PlatformEvent.parse(entry.value);
      if (value.sequence !== this.cursor + 1) throw new Error("Platform event journal sequence is corrupt");
      this.cursor = value.sequence; this.events.push(value);
      if (this.events.length > 1000) this.events.shift();
    } else throw new Error("Unknown platform journal record");
  }
  private append(entry: Entry) {
    if (this.closed) throw new Error("Platform store is closed");
    appendFileSync(this.fd, JSON.stringify(entry) + "\n"); fsyncSync(this.fd); this.apply(entry);
  }
  putWorkspace(value: Workspace) { this.append({ kind: "workspace", value: Workspace.parse(value) }); }
  putSession(value: Session) { this.append({ kind: "session", value: Session.parse(value) }); }
  putRun(value: Run) { this.append({ kind: "run", value: Run.parse(value) }); }
  event(type: string, data: unknown, sessionId?: string) {
    const value = PlatformEvent.parse({ sequence: this.cursor + 1, type, data, ...(sessionId ? { sessionId } : {}) });
    this.append({ kind: "event", value }); return value;
  }
  close() {
    if (this.closed) return;
    this.closed = true; closeSync(this.fd);
    const owner = JSON.parse(readFileSync(this.lockPath, "utf8")) as { nonce: string };
    if (owner.nonce === this.lockNonce) unlinkSync(this.lockPath);
  }
}
