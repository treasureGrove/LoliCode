import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const ENGINE_VERSION = "2.0.12";
export const JsonObject = z.record(z.string(), z.unknown());
export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,180}$/);
export const RequestId = z.string().uuid();
export const Model = z.object({
  id: z.string().min(1), providerId: z.string().min(1), modelId: z.string().min(1), name: z.string().min(1),
}).strict();
export type Model = z.infer<typeof Model>;
export const Connection = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  url: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  }, "Expected an owned loopback Host"),
  token: z.string().min(32),
}).strict();
export type Connection = z.infer<typeof Connection>;
export const WorkspaceInput = z.object({ path: z.string().min(1).max(8192) }).strict();
export const Workspace = z.object({ id: Id, path: z.string(), name: z.string() }).strict();
export type Workspace = z.infer<typeof Workspace>;
export const SessionInput = z.object({
  workspaceId: Id, modelId: z.string().min(1), title: z.string().max(240).optional(),
  mode: z.enum(["build", "plan"]).default("build"),
}).strict();
export type SessionInput = z.infer<typeof SessionInput>;
export const Session = z.object({
  id: Id, workspaceId: Id, engine: z.literal("opencode"), engineVersion: z.literal(ENGINE_VERSION),
  nativeId: Id, modelId: z.string(), title: z.string(), mode: z.enum(["build", "plan"]), createdAt: z.number(),
}).strict();
export type Session = z.infer<typeof Session>;
export const RunInput = z.object({ requestId: RequestId, text: z.string().trim().min(1).max(200_000) }).strict();
export type RunInput = z.infer<typeof RunInput>;
export const RunStatus = z.enum(["queued", "running", "waiting_user", "cancelling", "succeeded", "failed", "cancelled", "interrupted"]);
export const Run = z.object({
  id: Id, sessionId: Id, requestId: RequestId, nativeMessageId: Id, text: z.string(),
  status: RunStatus, createdAt: z.number(), updatedAt: z.number(), error: z.string().optional(),
}).strict();
export type Run = z.infer<typeof Run>;
export const ACTIVE_STATUSES: ReadonlySet<Run["status"]> = new Set(["queued", "running", "waiting_user", "cancelling"]);
export const PermissionReply = z.object({ decision: z.enum(["once", "always", "reject"]) }).strict();
export const FormReply = z.object({ answer: JsonObject }).strict();
export const PlatformEvent = z.object({ sequence: z.number().int().positive(), type: z.string(), sessionId: Id.optional(), data: z.unknown() }).strict();
export type PlatformEvent = z.infer<typeof PlatformEvent>;
export const Snapshot = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION), cursor: z.number().int().nonnegative(),
  engine: z.object({ id: z.literal("opencode"), version: z.literal(ENGINE_VERSION), state: z.enum(["stopped", "starting", "ready", "failed"]) }).strict(),
  models: z.array(Model), workspaces: z.array(Workspace), sessions: z.array(Session), runs: z.array(Run),
}).strict();
export type Snapshot = z.infer<typeof Snapshot>;
/** Native records retain upstream-specific fields; this is a projection, not a replacement transcript. */
export const SessionSnapshot = z.object({ session: Session, messages: z.array(JsonObject), permissions: z.array(JsonObject), forms: z.array(JsonObject), active: z.boolean() }).strict();
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;
export const HostError = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();

export class PlatformError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = "PlatformError"; }
}
