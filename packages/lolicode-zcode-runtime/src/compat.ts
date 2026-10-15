import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { nativeSelection, visibleSelection, type Catalog } from "./provider-bridge.js";
import { createNativeDiffCollector } from "./native-diffs.js";
import { createNativeHistoryCollector } from "./native-history.js";

type RecordValue = Record<string, any>;
type Entry = { workspacePath: string; mode: string; permissionMode: string; pinned?: boolean; archived?: boolean; pendingTitle?: string; pendingMode?: boolean; pendingPermission?: boolean };
type Feed = { snapshot?: any; subscriptionId?: string; gap: boolean; closed?: boolean; pendingWires: any[]; accept(wire: any): void; dispose(): Promise<void>; ready: Promise<void>; resolve(): void; reject(error: unknown): void; loading?: Promise<void> };
export const taggedSession = (id: string) => `zc:${id}`;
export function nativeSession(id: string) {
  if (!id.startsWith("zc:") || !id.slice(3).trim() || id.includes("\0")) throw new Error("ZCode 会话标识无效");
  return id.slice(3);
}
export function collaborationMode(permission: string) {
  if (permission === "ask") return "build";
  if (permission === "auto") return "guarded";
  if (permission === "full_access") return "yolo";
  throw new Error("请选择有效的权限模式");
}
export function nativeSnapshotBusy(snapshot: any): boolean {
  if (!snapshot) return false;
  return Boolean(
    snapshot.control?.canStop || snapshot.control?.stopState === "stopping" ||
    ["running", "prewarming"].includes(snapshot.control?.phase) ||
    snapshot.control?.activeWorks?.length || snapshot.pendingInteractions?.length ||
    snapshot.pendingCommands?.length || snapshot.queue?.items?.length ||
    snapshot.subagents?.running?.length ||
    snapshot.backgroundWorks?.some((work: any) => ["running", "resultPending"].includes(work.status)) ||
    snapshot.workflowRuns?.runs?.some((run: any) => ["pending", "running"].includes(run.status)),
  );
}
type MessagePart = { type: "text" | "reasoning"; text: string } | { type: "tool"; id: string; name: string; state: string; input: unknown; output: string | null; error: string | null };
type Message = { id: string; role: string; createdAt: number; completedAt: number | null; parts: MessagePart[] };
export function rowMessages(rows: any[]): Message[] {
  return rows.flatMap<Message>((row) => {
    const base = { id: row.kind === "userInput" ? (row.sourceCommandId || `row-${row.rowId}`) : `row-${row.rowId}`, role: row.kind === "userInput" ? "user" : "assistant", createdAt: row.createdAt ?? 0, completedAt: row.state === "streaming" ? null : (row.endedAt ?? row.createdAt ?? 0) };
    if (row.kind === "userInput" || row.kind === "assistantText") return [{ ...base, parts: [{ type: "text", text: row.text }] }];
    if (row.kind === "reasoning") return [{ ...base, parts: [{ type: "reasoning", text: row.text }] }];
    if (row.kind === "toolCall") return [{ ...base, parts: [{ type: "tool", id: row.toolCallId, name: row.toolName, state: ({ success: "completed", cancelled: "error", inputStreaming: "pending", pendingApproval: "pending" } as any)[row.status] ?? row.status, input: row.input ?? {}, output: row.output?.text ?? null, error: row.error?.message ?? null }] }];
    if (row.kind === "notice" && row.text) return [{ ...base, parts: [{ type: "text", text: row.text }] }];
    return [];
  });
}
export function permissionDto(id: string, interaction: any) {
  const payload = interaction.payload;
  return {
    id: interaction.interactionId, sessionId: id,
    action: payload.toolName, toolName: payload.toolName,
    resources: [], description: payload.summary,
    toolInput: payload.detail?.input ?? payload.detail ?? null,
    // A single-use native approval must never gain a remember button in the
    // older renderer. The native option list remains the only response owner.
    ...(!payload.options?.some((option: any) => option.kind === "allowAlways") ? { approvalMode: "user-once" } : {}),
  };
}

export function questionDto(id: string, interaction: any) {
  const payload = interaction.payload;
  const planApproval = payload.schema?.interaction === "plan_approval";
  const plan = planApproval && typeof payload.input?.plan === "string" ? payload.input.plan : undefined;
  const fields = payload.questions?.length ? payload.questions.map((question: any, index: number) => ({ key: `answer_${index}`, type: question.multiSelect ? "multiselect" : "string", title: planApproval ? "实施计划" : question.header || question.question, description: planApproval && index === 0 ? plan || "原生工具没有提供计划正文，请拒绝并让 Agent 补充计划。" : question.question, required: true, options: question.options.map((option: any) => ({ value: option.value, label: planApproval && option.value === "approve" ? "同意并开始实施" : option.label, description: option.description ?? null })), custom: true, default: null, hidden: false, when: [] })) : [{ key: "text", type: "string", title: payload.prompt || "请回答", required: true, options: (payload.options ?? []).map((o: any) => ({ value: o.optionId, label: o.label, description: null })), custom: payload.freeText !== false, default: null, hidden: false, when: [] }];
  return { id: interaction.interactionId, sessionId: id, title: planApproval ? "请确认实施计划" : payload.prompt || "需要你的回答", fields };
}

export interface CompatibilityOptions {
  privateRoot: string;
  agent: any;
  v4: any;
  clientId: string;
  configureCatalog(catalog: Catalog, gateway: any): Promise<void>;
  extraBusy(): boolean;
}

/** A projection into the existing renderer contract, not a second agent runtime.
 * Commands, admission, permissions and workflow decisions remain native V4. */
export class CompatibilityAgent {
  private current?: string;
  private selected?: string;
  private catalogValue: Catalog = { revision: 0, models: [] };
  private entries: Record<string, Entry> = {};
  private readonly workspaces = new Set<string>();
  private readonly feeds = new Map<string, Feed>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly commandEnvelopes = new Map<string, any>();
  private writes = Promise.resolve();
  private restartSubscription?: { dispose(): void };
  private readonly stateFile: string;
  private readonly diffs: ReturnType<typeof createNativeDiffCollector>;
  private readonly history: ReturnType<typeof createNativeHistoryCollector>;

  constructor(private readonly options: CompatibilityOptions) { this.stateFile = join(options.privateRoot, "renderer-state.json"); this.diffs = createNativeDiffCollector(options.agent); this.history = createNativeHistoryCollector(options.agent); }
  async start() {
    try {
      const state = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (state.version !== 1 || typeof state.sessions !== "object") throw new Error("Invalid renderer state");
      this.entries = state.sessions;
    } catch (error: any) { if (error.code !== "ENOENT") throw new Error("LoliCode 会话索引读取失败，原文件已保留"); }
    this.restartSubscription = this.options.agent.onAgentRuntimeRestarted?.(() => {
      for (const feed of this.feeds.values()) feed.gap = true;
    });
  }
  private save() {
    const data = JSON.stringify({ version: 1, sessions: this.entries });
    const operation = this.writes.then(async () => {
      await mkdir(this.options.privateRoot, { recursive: true });
      const temp = `${this.stateFile}.${randomUUID()}.tmp`;
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, this.stateFile);
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  private entry(id: string) {
    nativeSession(id);
    const entry = this.entries[id];
    if (!entry) throw new Error("找不到此会话的项目，请重新打开项目");
    return entry;
  }
  private target(id: string) { return { workspacePath: this.entry(id).workspacePath, sessionId: nativeSession(id) }; }
  private async tracked<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation);
    try { return await operation; } finally { this.inFlight.delete(operation); }
  }
  private decorate(session: any, state?: any) {
    const id = taggedSession(session.sessionId);
    const entry = this.entries[id] ??= { workspacePath: session.workspace.workspacePath, mode: session.mode === "plan" ? "plan" : "build", permissionMode: ({ guarded: "auto", yolo: "full_access" } as any)[session.mode] ?? "ask" };
    const config = state?.config;
    if (config) {
      const mode = config.planEnabled === true ? "plan" : "build";
      const permissionMode = ({ guarded: "auto", yolo: "full_access" } as any)[config.mode] ?? "ask";
      if (!entry.pendingMode || entry.mode === mode) { entry.mode = mode; entry.pendingMode = false; }
      if (!entry.pendingPermission || entry.permissionMode === permissionMode) { entry.permissionMode = permissionMode; entry.pendingPermission = false; }
    }
    return { id, title: entry.pendingTitle || state?.meta?.title || session.title || "新会话", projectPath: entry.workspacePath, mode: entry.mode, permissionMode: entry.permissionMode, pinned: entry.pinned ?? false, archived: entry.archived ?? Boolean(session.archivedAt), model: visibleSelection(this.catalogValue, config?.modelSelection ?? session.model), createdAt: session.createdAt, updatedAt: session.updatedAt };
  }
  async status() { return { available: true, version: "ZCode 3.15.1 (aac4755)", running: this.workspaces.size > 0, projectPath: this.current ?? null }; }
  catalog() { return this.catalogValue; }
  workspace() { return this.current ? { path: this.current, ...(this.selected && this.entries[this.selected]?.workspacePath === this.current ? { sessionId: nativeSession(this.selected) } : {}) } : undefined; }
  cachedBusy() { return this.inFlight.size > 0 || [...this.feeds.values()].some((feed) => feed.gap || nativeSnapshotBusy(feed.snapshot)); }
  async openProject(args: RecordValue) {
    await this.options.configureCatalog(args.catalog, args.gateway);
    this.catalogValue = args.catalog;
    const initialized = await this.options.agent.initialize({ workspacePath: args.path });
    if (initialized.available === false) throw new Error(initialized.reason || "ZCode 项目运行时未就绪");
    // The embedded CLI applies the personal registry before acknowledging this
    // read. Keep live draft sessions while synchronizing the changed catalog.
    await this.options.agent.readWorkspacePresentation({ workspacePath: args.path });
    this.current = args.path;
    this.workspaces.add(args.path);
    const sessions = await this.listSessions({ projectPath: args.path });
    return { workspace: { path: args.path, name: basename(args.path) }, catalog: this.catalogValue, sessions };
  }
  async listSessions(args: RecordValue = {}) {
    const path = args.projectPath || this.current;
    if (!path) return [];
    this.workspaces.add(path);
    const sessions = await this.options.agent.listSessions({ workspacePath: path, includeArchived: true, limit: 2000 });
    const result = sessions.map((session: any) => this.decorate(session));
    await this.save();
    return result.filter((session: any) => args.includeArchived || !session.archived).sort((a: any, b: any) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }
  async createSession(args: RecordValue) {
    if (!this.current) throw new Error("请先选择项目");
    if (!["plan", "build"].includes(args.mode)) throw new Error("请选择分析或实现模式");
    const permissionMode = args.permissionMode ?? "ask";
    const mode = collaborationMode(permissionMode);
    const ack = await this.options.agent.sendConversationCommandV4({ workspacePath: this.current, envelope: {
      commandId: randomUUID(), clientId: this.options.clientId, sessionId: null,
      type: "createSession", issuedAt: Date.now(), payload: {
        workspaceId: this.current,
        config: { mode, modelSelection: nativeSelection(this.catalogValue, args.modelId), planEnabled: args.mode === "plan" },
      },
    } });
    if (!["accepted", "duplicate"].includes(ack.status) || !ack.result?.sessionId) throw new Error(ack.message || ack.reasonCode || "创建 ZCode 会话失败");
    const id = taggedSession(ack.result.sessionId);
    this.entries[id] = { workspacePath: this.current, mode: args.mode, permissionMode, ...(args.title?.trim() ? { pendingTitle: args.title.trim() } : {}) };
    await this.save();
    return (await this.getSession({ sessionId: id })).session;
  }
  private attach(id: string): Feed {
    const target = this.target(id);
    this.workspaces.add(target.workspacePath);
    const assembler = new this.options.v4.TopicWireFrameAssembler(this.options.v4.conversationTopicFrameSchema);
    let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Mark it observed immediately: initial assembly can fail before a caller
    // awaits the ACK, and must not create an unhandled rejection.
    void ready.catch(() => {});
    const feed: Feed = { gap: false, ready, resolve: resolveReady, reject: rejectReady, pendingWires: [], accept() {}, async dispose() {} };
    feed.accept = (wire: any) => {
      if (feed.closed || wire.topic !== `conversation/${target.sessionId}`) return;
      if (!feed.subscriptionId) {
        if (feed.pendingWires.length >= 2048) { feed.gap = true; feed.reject(new Error("ZCode 初始快照超过接收限制")); return; }
        feed.pendingWires.push(wire); return;
      }
      if (wire.subscriptionId !== feed.subscriptionId) return;
      for (const event of assembler.accept(wire)) {
        if (event.kind === "fault") { feed.gap = true; feed.reject(new Error(event.fault.reasonCode)); continue; }
        const frame = event.frame;
        if (frame.payload.kind === "snapshot") { feed.snapshot = frame.payload.snapshot; feed.gap = false; feed.resolve(); }
        else if (feed.snapshot && frame.fromSeq === feed.snapshot.seq) {
          feed.snapshot = { ...this.options.v4.applyConversationDeltas(feed.snapshot, frame.payload.deltas), seq: frame.toSeq };
        } else { feed.gap = true; }
      }
    };
    const listener = this.options.agent.onDynamicConversationFrame({ workspacePath: target.workspacePath })(feed.accept);
    feed.dispose = async () => {
      if (feed.closed) return;
      feed.closed = true; listener.dispose(); feed.pendingWires = [];
      feed.reject(new Error("ZCode 会话订阅已结束"));
      if (feed.subscriptionId) await this.options.agent.unsubscribeConversationV4({ workspacePath: target.workspacePath, subscriptionId: feed.subscriptionId, runtimePolicy: "existing-only" }).catch(() => {});
    };
    this.feeds.set(id, feed);
    return feed;
  }
  private async state(id: string): Promise<any> {
    let feed = this.feeds.get(id);
    if (feed?.snapshot && !feed.gap) return feed.snapshot;
    if (feed?.loading) { await feed.loading; return feed.snapshot; }
    await feed?.dispose();
    feed = this.attach(id);
    const loading = (async () => {
      const result = await this.options.agent.subscribeConversationV4({ ...this.target(id), visibility: "foreground" });
      feed!.subscriptionId = result.ack.subscriptionId;
      if (feed!.closed) {
        await this.options.agent.unsubscribeConversationV4({ workspacePath: this.entry(id).workspacePath, subscriptionId: result.ack.subscriptionId, runtimePolicy: "existing-only" }).catch(() => {});
        throw new Error("ZCode 会话订阅已结束");
      }
      for (const wire of feed!.pendingWires.splice(0)) feed!.accept(wire);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([feed!.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("ZCode 会话快照加载超时，请重试")), 30_000); })]);
      } finally { if (timer) clearTimeout(timer); }
    })();
    feed.loading = loading;
    try { await loading; return feed.snapshot; }
    catch (error) { await feed.dispose(); this.feeds.delete(id); throw error; }
    finally { feed.loading = undefined; }
  }
  private async command(id: string, type: string, payload: any, requestId: string = randomUUID()) {
    const state = await this.state(id);
    const key = `${id}\0${requestId}`;
    let envelope = this.commandEnvelopes.get(key);
    if (!envelope) {
      envelope = { commandId: requestId, clientId: this.options.clientId, sessionId: nativeSession(id), baseRevision: state.revision, baseLogEpoch: state.logEpoch, type, payload, issuedAt: Date.now() };
      this.commandEnvelopes.set(key, envelope);
    } else if (envelope.type !== type || JSON.stringify(envelope.payload) !== JSON.stringify(payload)) throw new Error("同一请求编号不能提交不同内容");
    const ack = await this.options.agent.sendConversationCommandV4({ workspacePath: this.entry(id).workspacePath, envelope });
    if (["rejected", "failed", "stale"].includes(ack.status)) {
      this.commandEnvelopes.delete(key);
      throw new Error(ack.message || ack.reasonCode || "ZCode 未接受此操作");
    }
    // Accepted command identity is durable in CLI. Keep uncertain submissions
    // unchanged; successful admissions need no in-memory envelope retention.
    this.commandEnvelopes.delete(key);
    return ack;
  }
  async updateSession(args: RecordValue) {
    const entry = this.entry(args.sessionId);
    const state = await this.state(args.sessionId);
    if (args.modelId) await this.options.agent.setModel({ ...this.target(args.sessionId), model: nativeSelection(this.catalogValue, args.modelId), expectedRevision: state.revision });
    if (args.permissionMode) {
      const desired = collaborationMode(args.permissionMode);
      await this.command(args.sessionId, "switchCollaborationMode", { mode: desired });
      entry.permissionMode = args.permissionMode;
      entry.pendingPermission = true;
    }
    if (args.mode) { if (!["plan", "build"].includes(args.mode)) throw new Error("请选择分析或实现模式"); entry.mode = args.mode; entry.pendingMode = true; }
    await this.save();
    return (await this.getSession({ sessionId: args.sessionId })).session;
  }
  async renameSession(args: RecordValue) {
    const entry = this.entry(args.sessionId);
    const state = await this.state(args.sessionId);
    if (!args.title?.trim()) throw new Error("请输入会话名称");
    if (state.control.phase === "draft") { entry.pendingTitle = args.title.trim(); await this.save(); }
    else await this.command(args.sessionId, "renameSession", { title: args.title.trim() });
    return (await this.getSession(args)).session;
  }
  async setSessionMetadata(args: RecordValue) {
    const entry = this.entry(args.sessionId);
    if (typeof args.pinned === "boolean") entry.pinned = args.pinned;
    if (typeof args.archived === "boolean") entry.archived = args.archived;
    await this.save();
    return (await this.getSession(args)).session;
  }
  async deleteSession(args: RecordValue) {
    await this.command(args.sessionId, "deleteSession", {});
    await this.feeds.get(args.sessionId)?.dispose(); this.feeds.delete(args.sessionId);
    delete this.entries[args.sessionId]; await this.save();
  }
  async getSession(args: RecordValue) {
    if (this.entry(args.sessionId).workspacePath === this.current) this.selected = args.sessionId;
    const state = await this.state(args.sessionId);
    const native = await this.options.agent.readSession({ ...this.target(args.sessionId), messageLimit: 1, contentProfile: "index" });
    const entry = this.entry(args.sessionId);
    if (entry.pendingTitle && !["draft", "prewarming"].includes(state.control.phase)) {
      try { await this.command(args.sessionId, "renameSession", { title: entry.pendingTitle }); delete entry.pendingTitle; await this.save(); } catch { /* Admission may precede SQLite promotion; retry on the next snapshot. */ }
    }
    // Native V4 is the live truth. Polling here merely projects its existing
    // stream; it does not resubmit, resume, or synthesize agent state.
    const permissions = state.pendingInteractions.filter((i: any) => i.kind === "permission").map((i: any) => permissionDto(args.sessionId, i));
    const questions = state.pendingInteractions.filter((i: any) => i.kind === "userInput").map((i: any) => questionDto(args.sessionId, i));
    const phase = state.control.phase;
    const status = permissions.length ? "waiting_permission" : questions.length ? "waiting_question" : phase === "error" ? "error" : state.control.canStop || phase === "running" || phase === "prewarming" ? "running" : "idle";
    const session = this.decorate(native.session, state);
    // Pending composer choices are local user intent until the next input is
    // admitted; a background snapshot must not silently erase them.
    session.mode = this.entry(args.sessionId).mode;
    const target = this.target(args.sessionId);
    const rows = await this.history.collect(target, state);
    const history = this.history.status(target);
    const messages = rowMessages(rows);
    if (history.message) messages.unshift({ id: "lolicode-history-notice", role: "system", createdAt: 0, completedAt: 0, parts: [{ type: "text", text: history.message }] });
    return { session, status, messages, permissions, questions, diffs: await this.diffs.collect(target, state), error: state.control.lastError?.message ?? null, streamConnected: true, streamGap: Boolean(this.feeds.get(args.sessionId)?.gap || history.retryable) };
  }
  async sendMessage(args: RecordValue) {
    if (!args.text?.trim() || !args.requestId?.trim()) throw new Error("请输入任务内容");
    const entry = this.entry(args.sessionId);
    const state = await this.state(args.sessionId);
    const payload = { text: args.text, modelSelection: state.config.modelSelection, mode: collaborationMode(entry.permissionMode), planEnabled: entry.mode === "plan", inputOrigin: "desktop" };
    return this.tracked(this.command(args.sessionId, "sendText", payload, args.requestId)).then(() => undefined);
  }
  async queryCommand(args: RecordValue) { return this.options.agent.queryConversationCommandsV4({ workspacePath: this.entry(args.sessionId).workspacePath, commands: [{ sessionId: nativeSession(args.sessionId), commandId: args.requestId }] }); }
  async runSavedWorkflow(args: RecordValue) {
    if (typeof args.name !== "string" || !args.name.trim() || typeof args.requestId !== "string" || !args.requestId.trim()) throw new Error("请选择工作流并提供运行请求编号");
    await this.tracked(this.command(args.sessionId, "startSavedWorkflow", { name: args.name, ...(args.scope ? { scope: args.scope } : {}), ...(args.args ? { args: args.args } : {}) }, args.requestId));
    return (await this.getSession({ sessionId: args.sessionId })).session;
  }
  async interruptSession(args: RecordValue) {
    const state = await this.state(args.sessionId);
    const executionId = state.control.activeWorks.find((work: any) => work.foregroundExecutionId)?.foregroundExecutionId;
    await this.command(args.sessionId, "stop", executionId ? { expectedForegroundExecutionId: executionId } : {});
  }
  private async interaction(args: RecordValue) {
    const state = await this.state(args.sessionId);
    const interaction = state.pendingInteractions.find((i: any) => i.interactionId === args.requestId);
    if (!interaction) throw new Error("此交互已处理或已经结束");
    return interaction;
  }
  async replyPermission(args: RecordValue) {
    const interaction = await this.interaction(args);
    if (interaction.kind !== "permission") throw new Error("权限请求类型不匹配");
    const desired = ({ once: "allowOnce", always: "allowAlways", reject: "deny" } as any)[args.decision];
    const option = interaction.payload.options.find((o: any) => o.kind === desired);
    if (!option) throw new Error(desired === "allowAlways" ? "此操作只允许单次确认，不能记住授权" : "此权限选项不可用");
    await this.command(args.sessionId, "resolveInteraction", { interactionId: args.requestId, answer: { optionId: option.optionId } });
  }
  async replyQuestion(args: RecordValue) { await this.command(args.sessionId, "resolveInteraction", { interactionId: args.requestId, answer: { action: "accept", content: args.answer?.content ?? args.answer, ...(args.answer?.text ? { freeText: args.answer.text } : {}) } }); }
  async rejectQuestion(args: RecordValue) { await this.command(args.sessionId, "resolveInteraction", { interactionId: args.requestId, answer: { action: "cancel" } }); }
  async closeProject() { this.current = undefined; }
  async busy() {
    if (this.inFlight.size || this.options.extraBusy()) return true;
    // Fresh native reads cover background workflow/goal/agent jobs, including
    // work that began while another workspace was selected.
    for (const path of this.workspaces) {
      const sessions = await this.options.agent.listSessions({ workspacePath: path, includeArchived: true, limit: 2000, runtimePolicy: "existing-only" });
      for (const session of sessions) {
        if (["running", "waiting", "paused"].includes(session.status)) return true;
        const feed = this.feeds.get(taggedSession(session.sessionId));
        const snapshot = feed?.snapshot;
        if (feed?.gap || nativeSnapshotBusy(snapshot)) return true;
      }
    }
    return false;
  }
  async dispose() {
    this.restartSubscription?.dispose();
    this.diffs.dispose();
    this.history.dispose();
    await Promise.allSettled([...this.feeds.values()].map((feed) => feed.dispose()));
    this.feeds.clear();
    await this.writes;
  }
}
