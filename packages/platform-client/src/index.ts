import { Connection, FormReply, HostError, PermissionReply, PlatformError, PlatformEvent, Run, RunInput, Session, SessionInput, SessionSnapshot, Snapshot, Workspace, WorkspaceInput } from "@lolicode/platform-contracts";
import { readSse } from "@lolicode/platform-contracts/sse";
export * from "@lolicode/platform-contracts";

export class PlatformClient {
  private readonly connection: Connection;
  constructor(connection: Connection, private readonly transport: typeof fetch = fetch) { this.connection = Connection.parse(connection); }
  private async request(path: string, method = "GET", body?: unknown, signal?: AbortSignal) {
    const response = await this.transport(new URL(path, this.connection.url), {
      method, headers: { Authorization: `Bearer ${this.connection.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: "error", credentials: "omit", cache: "no-store",
    });
    if (!response.ok) {
      const error = HostError.safeParse(await response.json().catch(() => null));
      throw new PlatformError(error.success ? error.data.error.code : "host_error", error.success ? error.data.error.message : `Host request failed (${response.status})`, response.status);
    }
    return response;
  }
  async snapshot() { return Snapshot.parse(await (await this.request("/v1/snapshot")).json()); }
  async registerWorkspace(input: { path: string }) { return Workspace.parse(await (await this.request("/v1/workspaces", "POST", WorkspaceInput.parse(input))).json()); }
  async createSession(input: SessionInput) { return Session.parse(await (await this.request("/v1/sessions", "POST", SessionInput.parse(input))).json()); }
  async session(id: string) { return SessionSnapshot.parse(await (await this.request(`/v1/sessions/${encodeURIComponent(id)}`)).json()); }
  async run(sessionId: string, input: RunInput) { return Run.parse(await (await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/runs`, "POST", RunInput.parse(input))).json()); }
  async cancel(runId: string) { return Run.parse(await (await this.request(`/v1/runs/${encodeURIComponent(runId)}/cancel`, "POST", {})).json()); }
  async replyPermission(sessionId: string, id: string, decision: "once" | "always" | "reject") { await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(id)}`, "POST", PermissionReply.parse({ decision })); }
  async replyForm(sessionId: string, id: string, answer: Record<string, unknown>) { await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/forms/${encodeURIComponent(id)}`, "POST", FormReply.parse({ answer })); }
  async *events(after: number, signal: AbortSignal): AsyncGenerator<PlatformEvent | { type: "platform.reset"; cursor: number }> {
    const response = await this.request(`/v1/events?after=${after}`, "GET", undefined, signal);
    for await (const frame of readSse(response)) {
      if (frame.event === "reset") {
        const snapshot = Snapshot.parse(JSON.parse(frame.data));
        yield { type: "platform.reset", cursor: snapshot.cursor };
      } else {
        const event = PlatformEvent.parse(JSON.parse(frame.data));
        if (event.sequence > after) { after = event.sequence; yield event; }
      }
    }
  }
}
