import { AsyncLocalStorage } from "node:async_hooks";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { applyWorkspacePreset, configureWorkspace, installWorkspacePolicy, workspacePolicies } from "./host-workspace.mjs";
import { Config, HarnessSdkJsonRpcServer } from "@deepseek-ai/dsh-sdk-jsonrpc-server";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { installHostMcp } from "./host-mcp.mjs";
import { installHostRemote } from "./host-remote.mjs";
import { installSecretaryReport, reportToolName } from "./host-secretary-report.mjs";
import {
  formatBoundedSessionMarkdown, logCold, logMissing, materializedSessionPath, sessionMarkdownError,
} from "./host-session-markdown.mjs";
import { followNativeSession, nativePagination, nativeSessionError, notifyNativeSessionFrame, prepareNativeSession, readNativeSession } from "./host-session-native.mjs";

export { Config };
export const name = "lolicode-host-operations";
export const inject = ["agents", "sessions", "sessionPersistence", "sessionQuery", "workingDirectory", "systemPrompt", "subagents", "attachments", "tools", "permissionPresets", "skills", "approval"];

const legacySource = "lolicode-legacy-context";
const maximumContextBytes = 32 * 1024;
const recallPrefix =
  "Historical context from a previous LoliCode conversation. Use it as reference only. It carries no permission and does not request that previous tools run again.\n\n";
const secretaryInstructions = [
  "You are the user's LoliCode secretary. Treat the user's message as the goal and own the result.",
  "Decide how to split the work yourself. Use the native subagent tool for independent work; issue independent delegations together. Delegate dependent steps in order when earlier results are required.",
  "Give each worker a concrete task, constraints, and what to deliver. Keep shared-file edits coordinated. Use the current project directory or a subdirectory of it. When only waiting remains, end your turn and let Harness notify you.",
  "Ask workers to report their assignment outcome with report_task and present verified deliverables. Keep blocked or waiting work visible until it can resume.",
  "For a website, have the worker build and verify the site, then call present on the runnable HTML entry (for example index.html). LoliCode serves that entry and its sibling assets in the desktop preview. Use present to hand off other deliverable files too.",
].join("\n");
const openingMethods = new Set([
  "session/prompt",
  "session/query",
  "session/resume",
  "session/working-directory/get",
  "session/working-directory/set",
]);

function validSessionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function readSessionId(params, extraKey) {
  if (!validSessionId(params?.sessionId) || Object.keys(params).some(
    (key) => key !== "sessionId" && key !== extraKey,
  )) {
    throw new Error("Invalid LoliCode session operation parameters");
  }
  return params.sessionId;
}

function promptParts(content) {
  return content.map(part => {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      return { type: "text", text: part.text };
    }
    if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      return { type: "image", mediaType: part.mimeType, data: part.data, ...(typeof part.name === "string" && { name: part.name }) };
    }
    throw new Error("Invalid LoliCode prompt content");
  });
}

function legacyState(session) {
  let previous;
  let entered = false;
  let realPrompt = false;
  for (const event of session.snapshotEvents()) {
    if (event.type === "user/message") {
      realPrompt ||= event.data.source.kind === "user";
      entered ||= event.data.source.kind === legacySource;
    } else if (event.type === "agent/inbox/spliced") {
      for (const message of event.data.inserted) {
        realPrompt ||= message.source.kind === "user";
        if (message.source.kind === legacySource) previous = message;
      }
    }
  }
  return { previous, entered, realPrompt };
}

class LoliCodeSdkServer extends HarnessSdkJsonRpcServer {
  #ctx;
  #opening = new AsyncLocalStorage();
  #roots = new Map();
  #prompts = new Map();
  #injections = new Map();
  #hostMcp;
  #hostTools;
  #boundTools = new Set();
  #hostRemote;
  #secretaries = new WeakSet();
  #reportingWorkers = new WeakSet();
  #rootPolicies = new Map();
  #modeSignatures = new Map();
  #hostWorkers = new Map();
  #parkedWorkerInputs = new Map();
  #nativeFollows = new Map();
  #nativeOutput;

  constructor(ctx, transport, options, output) {
    super(ctx, transport, options);
    this.#ctx = ctx;
    this.#nativeOutput = output;
    ctx.effect(() => async () => {
      const follows = [...this.#nativeFollows.values()];
      for (const entry of follows) entry.abort.abort();
      await Promise.allSettled(follows.map((entry) => entry.done));
    }, "native session follow lifetime");
    const workspacePolicy = agent => this.#policyFor(agent);
    this.#hostMcp = installHostMcp(transport, { workspacePolicy });
    this.#hostTools = installHostMcp(transport, {
      acceptsName: name => /^(?!mcp_)[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name),
      onRegistered: name => this.#boundTools.add(name),
      workspacePolicy,
    });
    this.#hostRemote = installHostRemote(ctx, transport);
    installWorkspacePolicy(ctx, workspacePolicy, name => name === reportToolName || this.#boundTools.has(name));
    ctx.on("goal/changed", ({ agent }) => this.#publishMode(agent.session.id));
    ctx.on("goal/activation-changed", ({ sessionId }) => this.#publishMode(sessionId));
    ctx.on("session/event", (session, event) => {
      const agent = this.#roots.get(session.id);
      if (agent && (event.type === "plan/mode" ||
          (event.type === "user/message" && event.data.source.kind === "goal") ||
          (event.type === "tool/result" && ctx.get("planMode")?.get(agent)?.pending !== undefined))) {
        // The Plan service clears the pending intent after appending its event.
        queueMicrotask(() => this.#publishMode(session.id));
      }
    });
    ctx.on("agent/created", ({ agent, source }) => {
      if (source === "resume" && agent.session.header.parentSession) {
        const parked = this.#parkedWorkerInputs.get(agent.session.id);
        if (parked) this.#detachWorkerInputs(agent, parked);
      }
      this.#configureWorker(agent);
      const opening = this.#opening.getStore();
      if (
        opening && agent.id === opening.id && agent.session.id === opening.id &&
        !agent.session.header.parentSession && source === opening.source
      ) {
        opening.agent = agent;
      }
    });
    ctx.on("agent/disposed", ({ agent }) => {
      if (this.#roots.get(agent.id) === agent) {
        this.#roots.delete(agent.id);
        this.#rootPolicies.delete(agent.session.id);
        this.#modeSignatures.delete(agent.session.id);
      }
    });
  }

  async handleRequest(method, params) {
    if (method === "lolicode/session/follow-native") return this.#followNativeSession(params);
    if (method === "lolicode/session/unfollow-native") {
      if (!params || !validSessionId(params.subscriptionId) || Object.keys(params).some((key) => key !== "subscriptionId")) {
        throw new Error("Invalid native subscription");
      }
      const entry = this.#nativeFollows.get(params.subscriptionId);
      if (entry) {
        entry.abort.abort();
        await entry.done;
      }
      return {};
    }
    if (method === "lolicode/session/read-native") {
      return this.#readNativeSession(params);
    }
    if (method === "lolicode/session/read-markdown") {
      return this.#readSessionMarkdown(params);
    }
    if (method === "lolicode/session/configure-workspace") {
      const id = readSessionId(params, "workspace");
      const result = configureWorkspace(this.#ctx, this.#ownedRoot(id), params.workspace);
      this.#rootPolicies.set(id, params.workspace.policy);
      this.#publishMode(id);
      return result;
    }
    if (method === "lolicode/session/cancel") {
      const agent = this.#ownedRoot(readSessionId(params, "includeWorkers"));
      if (params.includeWorkers !== undefined && typeof params.includeWorkers !== "boolean") {
        throw new Error("Invalid worker cancellation option");
      }
      if (params.includeWorkers && !this.#secretaries.has(agent)) {
        throw new Error("Only a configured secretary can stop its worker tree");
      }
      agent.cancel({ kind: "user" }, { keepInbox: true });
      if (params.includeWorkers) await this.#ctx.subagents.drainDescendants([agent]);
      return {};
    }
    if (method === "lolicode/session/queued-action") {
      return this.#queuedAction(params);
    }
    if (method === "lolicode/session/steer") {
      return this.#steer(params);
    }
    if (method === "lolicode/session/inject-legacy-context") {
      return this.#injectLegacyContext(params);
    }
    if (method === "lolicode/session/configure-mcp") {
      const agent = this.#ownedRoot(readSessionId(params, "tools"));
      return this.#hostMcp(agent, params.tools);
    }
    if (method === "lolicode/session/configure-tools") {
      const agent = this.#ownedRoot(readSessionId(params, "tools"));
      // The isolated process has one LoliCode root and its children.
      return this.#hostTools(agent, params.tools, this.#ctx);
    }
    if (method === "lolicode/session/configure-remote") {
      const { sessionId, tools, location } = params ?? {};
      if (!validSessionId(sessionId) ||
          Object.keys(params).some(key => !["sessionId", "tools", "location"].includes(key))) {
        throw new Error("Invalid LoliCode remote workspace parameters");
      }
      return this.#hostRemote(this.#ownedRoot(sessionId), { tools, location });
    }
    if (method === "lolicode/session/configure-secretary") {
      const agent = this.#ownedRoot(readSessionId(params));
      if (!this.#secretaries.has(agent)) {
        agent.ctx.systemPrompt.section({
          name: "lolicode:secretary",
          order: agent.ctx.systemPrompt.getSectionOrder("TEAM_POLICY"),
          text: secretaryInstructions,
          interpolate: false,
        });
        this.#secretaries.add(agent);
        for (const child of this.#ctx.agents.list()) {
          this.#enableSecretaryReports(child);
        }
      }
      return {};
    }
    if (method === "lolicode/secretary/cancel-worker") {
      const { sessionId, childSessionId, parkedRequestIds = [] } = params ?? {};
      const agent = this.#ownedRoot(sessionId);
      if (!validSessionId(childSessionId) || childSessionId === agent.session.id ||
          Object.keys(params).some(key => !["sessionId", "childSessionId", "parkedRequestIds"].includes(key)) ||
          !Array.isArray(parkedRequestIds) || !parkedRequestIds.every(validSessionId)) {
        throw new Error("Invalid LoliCode worker session");
      }
      this.#ctx.subagents.interrupt(childSessionId, { kind: "ancestor", agent });
      const child = this.#ownedWorker(agent, childSessionId);
      const parked = child ? this.#detachWorkerInputs(child, new Set(parkedRequestIds)) : [];
      if (child && parked.length) await this.#ctx.sessions.flush(child.session);
      return { parked };
    }
    if (method === "lolicode/secretary/configure-worker-queues") {
      const root = this.#ownedRoot(readSessionId(params, "workers"));
      if (!this.#secretaries.has(root) || !Array.isArray(params.workers) ||
          params.workers.some(entry => !validSessionId(entry?.childSessionId) ||
            !Array.isArray(entry.requestIds) || !entry.requestIds.every(validSessionId))) {
        throw new Error("Invalid LoliCode worker queue state");
      }
      this.#parkedWorkerInputs = new Map(params.workers.map(entry => [entry.childSessionId, new Set(entry.requestIds)]));
      return {};
    }
    if (method === "lolicode/secretary/delegate-worker" || method === "lolicode/secretary/prompt-worker") {
      return this.#workerAction(method, params);
    }
    const id = params?.sessionId;
    if (!openingMethods.has(method) || !validSessionId(id)) {
      return super.handleRequest(method, params);
    }
    // Default conversations can attach after a prompt has started. Install the
    // official accumulator first so its reconnect snapshot includes the prefix.
    await prepareNativeSession(this.#ctx);
    const isPrompt = method === "session/prompt" || method === "session/query";
    if (isPrompt) {
      if (this.#injections.has(id)) throw new Error("Legacy context is being saved");
      this.#prompts.set(id, (this.#prompts.get(id) ?? 0) + 1);
    }
    const opening = { id, source: method === "session/resume" ? "resume" : "startup" };
    try {
      const result = await this.#opening.run(opening, () => super.handleRequest(method, params));
      if (method === "session/resume" && opening.agent) {
        await this.#restoreLegacyContext(opening.agent);
      }
      return result;
    } finally {
      // A prompt can fail during input validation after opening its root.
      // The registry identity check excludes rolled-back or replaced agents.
      if (opening.agent && this.#ctx.agents.get(id) === opening.agent) {
        this.#roots.set(id, opening.agent);
      }
      if (method === "session/query") this.#publishMode(id);
      if (isPrompt) {
        const pending = this.#prompts.get(id) - 1;
        if (pending === 0) this.#prompts.delete(id);
        else this.#prompts.set(id, pending);
      }
    }
  }

  #publishMode(sessionId) {
    const agent = this.#roots.get(sessionId);
    if (!agent) return;
    const goal = this.#ctx.get("goals")?.get(agent) ?? null;
    const plan = this.#ctx.get("planMode")?.get(agent) ?? null;
    const signature = JSON.stringify([goal, plan]);
    if (this.#modeSignatures.get(sessionId) === signature) return;
    this.#modeSignatures.set(sessionId, signature);
    this.transport.notify("lolicode/session.mode", { sessionId, goal, plan });
  }

  #ownedRoot(id) {
    const agent = this.#roots.get(id);
    if (!agent || this.#ctx.agents.get(id) !== agent) {
      throw new Error("Session is not an open root owned by this LoliCode connection");
    }
    return agent;
  }

  #ownedWorker(root, id) {
    const child = this.#ctx.agents.get(id);
    const visited = new Set();
    for (let current = child; current && current !== root;) {
      if (visited.has(current)) break;
      visited.add(current);
      current = this.#ctx.agents.get(current.session.header.parentSession);
      if (current === root) return child;
    }
    return undefined;
  }

  async #readSessionMarkdown(params) {
    const root = this.#ownedRoot(readSessionId(params, "childSessionId"));
    const { childSessionId } = params;
    let sessionId = root.session.id;
    if (childSessionId !== undefined) {
      if (!validSessionId(childSessionId) || childSessionId === sessionId) {
        throw new Error("Invalid LoliCode worker session");
      }
      if (!this.#ctx.agents.get(childSessionId)) throw new Error(logCold);
      const worker = this.#ownedWorker(root, childSessionId);
      if (!worker) throw new Error("Worker is not owned by this LoliCode session");
      sessionId = worker.session.id;
    }
    try {
      const { events } = await this.#ctx.sessionQuery.readSession(sessionId);
      const sourcePath = await materializedSessionPath(this.#ctx.sessionPersistence, sessionId);
      // In this JSONL profile a pending root can contain initialization
      // events before it has a native journal. Keep legacy history available.
      if (!sourcePath) throw new Error(logMissing);
      return formatBoundedSessionMarkdown(events, sourcePath);
    } catch (error) {
      throw new Error(sessionMarkdownError(error));
    }
  }

  async #readNativeSession(params) {
    if (!params || Object.keys(params).some((key) =>
      !["sessionId", "childSessionId", "beforeSeq", "throughSeq", "maxMessages"].includes(key))) {
      throw new Error("Invalid native session parameters");
    }
    const { sessionId, childSessionId, ...request } = params;
    if (!validSessionId(sessionId)) throw new Error("Invalid LoliCode session");
    const pagination = nativePagination(request);
    const root = this.#ownedRoot(sessionId);
    let selected = root;
    if (childSessionId !== undefined) {
      if (!validSessionId(childSessionId) || childSessionId === sessionId) throw new Error("Invalid LoliCode worker session");
      if (!this.#ctx.agents.get(childSessionId)) return null;
      selected = this.#ownedWorker(root, childSessionId);
      if (!selected) throw new Error("Worker is not owned by this LoliCode session");
    }
    try {
      if (!await materializedSessionPath(this.#ctx.sessionPersistence, selected.session.id)) throw new Error(logMissing);
      return await readNativeSession(this.#ctx, selected.session.id, pagination);
    } catch (error) {
      throw new Error(nativeSessionError(error));
    }
  }

  async #followNativeSession(params) {
    if (!params || Object.keys(params).some((key) =>
      !["sessionId", "childSessionId", "subscriptionId", "maxMessages"].includes(key))) {
      throw new Error("Invalid native follow parameters");
    }
    const { sessionId, childSessionId, subscriptionId, maxMessages } = params;
    if (!validSessionId(sessionId) || !validSessionId(subscriptionId)) throw new Error("Invalid native subscription");
    if (this.#nativeFollows.has(subscriptionId)) throw new Error("Native subscription already exists");
    if (this.#nativeFollows.size >= 8) throw new Error("Too many native subscriptions");
    const pagination = nativePagination({ maxMessages });
    const root = this.#ownedRoot(sessionId);
    let selected = root;
    if (childSessionId !== undefined) {
      if (!validSessionId(childSessionId) || childSessionId === sessionId) throw new Error("Invalid LoliCode worker session");
      if (!this.#ctx.agents.get(childSessionId)) return null;
      selected = this.#ownedWorker(root, childSessionId);
      if (!selected) throw new Error("Worker is not owned by this LoliCode session");
    }
    const entry = { abort: new AbortController(), done: undefined };
    const ready = Promise.withResolvers();
    this.#nativeFollows.set(subscriptionId, entry);
    const notify = (value) => {
      this.transport.notify("lolicode/session.native-follow", { subscriptionId, ...value });
    };
    entry.done = (async () => {
      let opened = false;
      try {
        // An admitted resident session can be observed before its first native
        // journal is materialized, so the first prompt streams into this watch.
        if (entry.abort.signal.aborted) throw entry.abort.signal.reason;
        const source = await followNativeSession(this.#ctx, selected.session.id, pagination, entry.abort.signal);
        opened = true;
        ready.resolve({});
        for await (const frame of source) {
          if (entry.abort.signal.aborted) break;
          notifyNativeSessionFrame(this.transport, this.#nativeOutput, subscriptionId, frame);
        }
        if (!entry.abort.signal.aborted) notify({ error: "LOLICODE_SESSION_FOLLOW_ENDED" });
      } catch (error) {
        if (!opened) ready.reject(new Error(nativeSessionError(error)));
        else if (!entry.abort.signal.aborted) {
          try { notify({ error: nativeSessionError(error) }); } catch { /* the private carrier is already closed */ }
        }
      } finally {
        if (this.#nativeFollows.get(subscriptionId) === entry) this.#nativeFollows.delete(subscriptionId);
      }
    })();
    return ready.promise;
  }

  #detachWorkerInputs(agent, identities) {
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
    return pending.filter(message => message.source.kind === "user" &&
      identities.has(message.source.rpcId) && agent.inbox.remove(message.id))
      .map(message => message.source.rpcId);
  }

  #policyFor(agent) {
    let selected;
    const visited = new Set();
    for (let current = agent; current; ) {
      const id = current.session.id;
      if (visited.has(id)) return undefined;
      visited.add(id);
      if (this.#ctx.get("planMode")?.get(current)?.active) return "plan";
      const parent = current.session.header.parentSession;
      if (!parent) {
        const root = this.#rootPolicies.get(id);
        return root === "plan" ? root : selected ?? root;
      }
      const worker = this.#hostWorkers.get(id);
      if (worker?.parent === parent) selected ??= worker.policy;
      current = this.#ctx.agents.get(parent);
    }
    return selected;
  }

  #configureWorker(agent) {
    const parent = agent.session.header.parentSession;
    if (!parent) return;
    const policy = this.#policyFor(agent);
    if (policy) {
      applyWorkspacePreset(this.#ctx, agent, policy);
    } else if (this.#hostWorkers.get(agent.session.id)?.parent === parent) {
      this.#ctx.approval.setPolicy(agent, "ask");
    }
    this.#enableSecretaryReports(agent);
  }

  #enableSecretaryReports(agent) {
    if (this.#reportingWorkers.has(agent)) return;
    const visited = new Set();
    let id = agent.session.header.parentSession;
    while (id && !visited.has(id)) {
      visited.add(id);
      const ancestor = this.#ctx.agents.get(id);
      if (ancestor && this.#secretaries.has(ancestor)) {
        installSecretaryReport(agent, this.transport);
        this.#reportingWorkers.add(agent);
        return;
      }
      id = ancestor?.session.header.parentSession;
    }
  }

  async #workerAction(method, params) {
    const { sessionId, childSessionId, content, requestId, label, cwd, approvalRequired = false, workspacePolicy, delivery = "queue" } = params ?? {};
    const delegate = method === "lolicode/secretary/delegate-worker";
    const keys = delegate
      ? ["sessionId", "childSessionId", "content", "label", "cwd", "approvalRequired", "workspacePolicy"]
      : ["sessionId", "childSessionId", "content", "requestId", "approvalRequired", "workspacePolicy", "delivery"];
    if (!validSessionId(sessionId) || !validSessionId(childSessionId) || childSessionId === sessionId ||
        Object.keys(params).some((key) => !keys.includes(key)) || !Array.isArray(content) || !content.length ||
        typeof approvalRequired !== "boolean" || (delivery !== "queue" && delivery !== "steer") ||
        (workspacePolicy !== undefined && !workspacePolicies.includes(workspacePolicy))) {
      throw new Error("Invalid LoliCode worker operation");
    }
    const agent = this.#ownedRoot(sessionId);
    if (!this.#secretaries.has(agent)) throw new Error("Only a configured secretary owns worker operations");
    const resident = this.#ctx.agents.get(childSessionId);
    if (resident && !this.#ownedWorker(agent, childSessionId)) throw new Error("Invalid worker parent");
    const parentSessionId = resident?.session.header.parentSession ?? sessionId;
    // Persisting a new front-end selection never changes an in-flight call
    // or pending approval. A resident, idle worker can adopt it on admission.
    if (!resident || resident.status === "idle") {
      this.#hostWorkers.set(childSessionId, { parent: parentSessionId, policy: approvalRequired ? "review" : workspacePolicy });
      if (resident) this.#configureWorker(resident);
    }
    const signal = new AbortController().signal;
    const parts = promptParts(content);
    if (!delegate) {
      if (!validSessionId(requestId)) throw new Error("Invalid LoliCode worker prompt identity");
      if (delivery === "steer" && resident?.status !== "running") {
        return { status: "rejected", message: "当前子任务已经结束，请重新发送。" };
      }
      const previous = resident?.session.snapshotEvents().find(event =>
        event.type === "user/message" && event.data.source.kind === "user" && event.data.source.rpcId === requestId);
      const pending = resident && [...resident.inbox.nextTurn, ...resident.inbox.nextStep].find(message =>
        message.source.kind === "user" && message.source.rpcId === requestId);
      if (pending || previous) return { messageId: pending?.id ?? previous.data.id };
      const result = await this.#ctx.subagents.prompt({
        parentSessionId, childSessionId, mode: "continuable", delivery, requestId, content: parts,
      }, signal);
      const child = this.#ownedWorker(agent, childSessionId);
      if (child) await this.#ctx.sessions.flush(child.session);
      return result;
    }
    if (typeof label !== "string" || !label.trim() || label.length > 320 ||
        (cwd !== undefined && (typeof cwd !== "string" || !cwd || cwd.includes("\0")))) {
      throw new Error("Invalid LoliCode worker delegation metadata");
    }
    // The parent catalog is the authoritative publication receipt. A host
    // restart between SDK admission and saving the desktop receipt reuses it.
    if ((await this.#ctx.subagents.listChildren(sessionId, signal)).some((child) => child.id === childSessionId)) {
      return { childSessionId };
    }
    const prompt = parts.some((part) => part.type === "image")
      ? await this.#ctx.attachments.admitPromptContent(parts)
      : parts;
    const activation = await this.#ctx.subagents.startActivation({
      provider: "spawn",
      label,
      childId: childSessionId,
      request: { parent: agent, prompt, ...(cwd && { cwd }), maxDepth: this.#ctx.subagents.resolveMaxDepth() },
      signal,
      delivery: "caller",
    });
    // Lifecycle events carry the result to the desktop. Avoid a detached
    // rejection if a provider cannot capture the child's final response.
    activation.result.catch(() => {});
    await this.#ctx.sessions.flush(agent.session);
    return { childSessionId: activation.childId, messageId: activation.messageId };
  }

  async #steer(params) {
    const { sessionId, requestId, contentBlocks } = params ?? {};
    if (!validSessionId(sessionId) || !validSessionId(requestId) ||
        !Array.isArray(contentBlocks) || !contentBlocks.length ||
        Object.keys(params).some(key => !["sessionId", "requestId", "contentBlocks"].includes(key))) {
      return { status: "rejected", message: "无效的插入请求" };
    }
    const agent = this.#ownedRoot(sessionId);
    const match = (entry) => entry.source.kind === "user" && entry.source.rpcId === requestId;
    const find = () => agent.inbox.nextStep.find(match) ??
      agent.session.snapshotEvents().find(event => event.type === "user/message" && match(event.data))?.data;
    const existing = find();
    if (existing) return { status: "steered", messageId: existing.id };
    if (agent.status !== "running") {
      return { status: "rejected", message: "当前任务已经结束，草稿已保留。" };
    }
    let content;
    try {
      const parts = promptParts(contentBlocks);
      if (parts.some(part => part.type === "image")) {
        content = await this.#ctx.attachments.admitPromptContent(parts);
        const concurrent = find();
        if (concurrent) return { status: "steered", messageId: concurrent.id };
      } else {
        content = parts;
      }
    } catch {
      return { status: "rejected", message: "插入消息的内容或附件无效，草稿已保留。" };
    }
    if (this.#ctx.agents.get(sessionId) !== agent || agent.status !== "running") {
      return { status: "rejected", message: "当前任务已经结束，草稿已保留。" };
    }
    const message = createUserMessage({ content, source: { kind: "user", rpcId: requestId } });
    agent.steer(message);
    await this.#ctx.sessions.flush(agent.session);
    return { status: "steered", messageId: message.id };
  }

  async #queuedAction(params) {
    const { sessionId, childSessionId, messageId, action } = params ?? {};
    if (
      !validSessionId(sessionId) || !validSessionId(messageId)
      || (action !== "remove" && action !== "steer")
      || (childSessionId !== undefined && !validSessionId(childSessionId))
      || Object.keys(params).some(key => !["sessionId", "childSessionId", "messageId", "action"].includes(key))
    ) {
      throw new Error("Invalid Harness queue action");
    }
    const root = this.#ownedRoot(sessionId);
    const agent = childSessionId === undefined ? root : this.#ownedWorker(root, childSessionId);
    if (!agent) throw new Error("The selected child session is not active");
    const matches = entry => entry.id === messageId && entry.source.kind === "user";
    const queued = agent.inbox.nextTurn.find(matches);
    const message = queued ?? agent.inbox.nextStep.find(matches);
    if (!message) throw new Error("The selected user message is no longer pending");
    if (action === "steer" && (!queued || agent.status !== "running")) {
      throw new Error("当前任务已不能接收插入消息，原消息仍在等待处理。");
    }
    if (!agent.inbox.remove(messageId)) throw new Error("The selected user message is no longer pending");
    // Match the upstream queue action, carrying the same message to the next
    // step of the running turn and leaving the remaining next-turn inbox alone.
    if (action === "steer") agent.steer(message);
    await this.#ctx.sessions.flush(agent.session);
    return { messageId, status: action === "remove" ? "removed" : "steered" };
  }

  async #injectLegacyContext(params) {
    const id = readSessionId(params, "context");
    const agent = this.#ownedRoot(id);
    const { context } = params;
    if (typeof context !== "string" || !context.trim() || context.includes("\0") ||
        Buffer.byteLength(context, "utf8") > maximumContextBytes) {
      throw new Error("Legacy context must be non-empty UTF-8 text of at most 32 KiB");
    }
    const text = recallPrefix + context;
    const pending = this.#injections.get(id);
    if (pending) {
      if (pending.text !== text) throw new Error("Different legacy context was already staged");
      return pending.completion;
    }
    const state = legacyState(agent.session);
    if (this.#prompts.has(id) || state.realPrompt || agent.status !== "idle") {
      throw new Error("Legacy context is only accepted before the first prompt");
    }
    if (state.previous && state.previous.content[0]?.text !== text) {
      throw new Error("Different legacy context was already staged");
    }
    const message = state.previous ?? createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: legacySource, form: "recall" },
    });
    if (!state.entered && !agent.inbox.nextStep.some((entry) => entry.id === message.id)) {
      agent.inject(message);
    }
    const completion = this.#ctx.sessions.flush(agent.session).then(() => ({ messageId: message.id }));
    this.#injections.set(id, { text, completion });
    try {
      return await completion;
    } finally {
      this.#injections.delete(id);
    }
  }

  async #restoreLegacyContext(agent) {
    // Graceful SDK shutdown can clear unclaimed inbox entries. Re-stage the
    // same historical input after resume when no real prompt has arrived.
    const { previous, entered, realPrompt } = legacyState(agent.session);
    if (previous && !entered && !realPrompt && agent.status === "idle" &&
        !agent.inbox.nextStep.some((entry) => entry.id === previous.id)) {
      agent.inject(previous);
      await this.#ctx.sessions.flush(agent.session);
    }
  }
}

// The SDK app still owns CLI parsing, EOF and signal handling. This row owns
// the one SDK transport and delegates the entire standard wire API upstream.
export function apply(ctx, config = {}) {
  const output = config.output ?? process.stdout;
  const transport = new JsonRpcLineTransport(config.input ?? process.stdin, output);
  const server = new LoliCodeSdkServer(ctx, transport, { maxTokensAsSuccess: config.maxTokensAsSuccess }, output);
  ctx.provide("sdkSessionActivation", { ready: true });
  // Stock SDK notifications carry the durable settlement. Forward the
  // upstream transient frames on the same transport for the desktop view.
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    transport.notify("lolicode/session.assistant-stream", {
      sessionId: String(agent.session.id),
      frame,
    });
  });
  ctx.on("session/created", (session) => {
    const { origin, parentSession, cwd } = session.header;
    if (origin !== "subagent" || !parentSession || !cwd) return;
    transport.notify("lolicode/subagent.directory", {
      parentSessionId: String(parentSession),
      childSessionId: String(session.id),
      cwd,
    });
  });

  let shutdownScheduled = false;
  transport.onRequest(async (method, params) => {
    if (method === "initialize") await ctx.get("loader")?.await();
    const result = await server.handleRequest(method, params);
    if (method === "shutdown" && !shutdownScheduled) {
      shutdownScheduled = true;
      // Let the transport enqueue this RPC's response before draining stdout.
      setImmediate(async () => {
        await transport.flush().catch(() => {});
        await ctx.root.fiber.dispose().catch(() => {});
        (config.exit ?? process.exit)(0);
      });
    }
    return result;
  });
  ctx.effect(() => {
    transport.start();
    return async () => {
      try {
        await server.shutdown();
      } finally {
        transport.close();
      }
    };
  }, "lolicode.jsonrpc.serve");
}
