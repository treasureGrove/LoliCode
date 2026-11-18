import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { home, readJson, saveJson, sessionFile, sessionLock, projectDirectory, selectedChannel } from "./config.mjs";
import { startRuntime } from "./runtime.mjs";
import { clean } from "./ui.mjs";

export async function sessions(cwd) {
  const files = await readdir(path.join(home, "sessions")).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const items = await Promise.all(files.filter(file => /^[A-Za-z0-9_-]+\.json$/.test(file)).map(file => readJson(path.join(home, "sessions", file))));
  return items.filter(item => item && (!cwd || item.cwd === cwd)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function textContent(message) {
  return (message?.content || []).filter(block => block.type === "text").map(block => block.text).join("");
}

export async function openSession(options, ui) {
  let metadata;
  if (options.resume) {
    const cwd = await projectDirectory(options.cwd);
    const id = options.resume === true ? (await sessions(cwd))[0]?.id : options.resume;
    if (!id) throw new Error("No saved session in this project. Start one with `lolicode`.");
    metadata = await readJson(sessionFile(id));
    if (!metadata) throw new Error(`Session does not exist: ${id}`);
    if (options.cwd && metadata.cwd !== cwd) throw new Error("Resume this session in its original project directory.");
    await projectDirectory(metadata.cwd);
  } else {
    metadata = { id: `lc_${randomUUID().replaceAll("-", "")}`, cwd: await projectDirectory(options.cwd), createdAt: new Date().toISOString() };
  }
  const channel = await selectedChannel({ ...options, channel: options.channel || metadata.channel });
  const release = await sessionLock(metadata.id);
  const persist = async () => saveJson(sessionFile(metadata.id), { ...metadata, updatedAt: new Date().toISOString() });
  metadata.channel = channel.name === "environment" ? undefined : channel.name;
  metadata.model = channel.model;
  let state;
  const secret = process.env[channel.apiKeyEnv];
  const redact = value => clean(secret ? String(value).split(secret).join("[redacted]") : value);
  let runtime;
  let closed = false;
  try {
    ui.spinner("正在唤醒 LoliCode");
    runtime = await startRuntime({ channel, cwd: metadata.cwd,
      onNotification(method, params) {
        if (!state || params.sessionId !== metadata.id) return;
        if (method === "lolicode/session.assistant-stream") {
          const frame = params.frame;
          if (frame.type === "start") state.streamed = false;
          if (frame.chunk?.type === "text-delta") {
            const text = redact(frame.chunk.text);
            state.streamed = true;
            ui.text(text);
            ui.event({ type: "text_delta", sessionId: metadata.id, text });
          }
          return;
        }
        if (method !== "session.event") return;
        const { type, data } = params.event;
        if (type === "assistant/message") {
          const text = redact(textContent(data.message));
          if (text) {
            state.text.push(text);
            if (!state.streamed) ui.text(text);
            ui.text("\n\n");
            ui.event({ type: "message", sessionId: metadata.id, text });
          }
          state.streamed = false;
          if (data.usage) state.usage.push(data.usage);
        } else if (type === "tool/call") {
          state.calls.set(data.callId, { name: data.name, arguments: data.arguments });
          if (!ui.json && !ui.streamJson) ui.note(`  🐾 ${data.name} ${redact(data.arguments).slice(0, 200)}`);
          ui.event({ type: "tool_call", sessionId: metadata.id, name: data.name, arguments: redact(data.arguments) });
        } else if (type === "tool/result") {
          if (data.message.isError) state.toolErrors++;
          ui.event({ type: "tool_result", sessionId: metadata.id, isError: !!data.message.isError, text: redact(textContent(data.message)) });
        } else if (type === "turn/end") {
          state.finishReason = data.reason.kind;
        }
      },
      async onRequest(method, params) {
        if (method === "approval/request") {
          const call = state?.calls.get(params.callId);
          ui.event({ type: "approval_required", sessionId: params.sessionId, tool: params.toolName, reason: redact(params.reason || "") });
          if (!ui.canAsk) { if (state) state.approvalRequired = true; return { outcome: "rejected" }; }
          ui.note(`\n需要确认 · ${params.toolName}\n${redact(params.reason || "")}${call ? `\n${redact(call.arguments)}` : ""}`);
          const answer = await ui.ask("允许这一次？[y/N] ");
          return { outcome: /^y(es)?$/i.test(answer?.trim() || "") ? "allowed-once" : "rejected" };
        }
        if (method === "user-question/ask") {
          if (!ui.canAsk) { if (state) state.inputRequired = true; return { cancelled: true }; }
          // Preserve native question IDs and the upstream answer contract.
          const answers = [];
          for (const question of params.questions) {
            ui.note(redact(question.question || question.title || question.id));
            if (question.detail) ui.note(redact(question.detail));
            for (const option of question.options || []) ui.note(`  ${redact(option.label)}${option.description ? ` — ${redact(option.description)}` : ""}`);
            const answer = await ui.ask("> ");
            if (answer === undefined) return { cancelled: true };
            const labels = (question.options || []).map(option => option.label);
            const selected = question.multiSelect ? answer.split(",").map(item => item.trim()).filter(item => labels.includes(item)) : labels.includes(answer.trim()) ? [answer.trim()] : [];
            if (question.intent?.kind === "approval" && !selected.length) return { cancelled: true };
            answers.push({ id: question.id, selected, ...(!selected.length && { custom: answer }) });
          }
          return { answers };
        }
        throw new Error(`Unsupported host request: ${method}`);
      },
    });
    if (options.resume) await runtime.request("session/resume", { sessionId: metadata.id });
    else await runtime.request("session/working-directory/get", { sessionId: metadata.id });
    await runtime.request("lolicode/session/configure-workspace", { sessionId: metadata.id, workspace: { policy: options.approval || "review", skills: [], memory: "" } });
    metadata.status = "idle";
    await persist();
    ui.stopSpinner();
    if (!ui.json && !ui.streamJson) ui.note(`${channel.model} · ${options.approval || "review"} · ${metadata.id}`);
  } catch (error) { await runtime?.close(); await release(); throw error; }

  let active;
  const cancel = async () => {
    if (!active) return;
    active.cancelled = true;
    await runtime.request("lolicode/session/cancel", { sessionId: metadata.id }).catch(() => {});
  };
  const run = async (prompt) => {
    state = { text: [], usage: [], calls: new Map(), toolErrors: 0 };
    active = state;
    metadata.status = "running";
    metadata.title ||= prompt.slice(0, 100);
    await persist();
    let timeout;
    try {
      if (options.timeout) timeout = setTimeout(() => { state.timedOut = true; void cancel(); }, options.timeout * 1000);
      await runtime.request("session/prompt", { sessionId: metadata.id, contentBlocks: [{ type: "text", text: prompt }] });
      ui.spinner();
      await runtime.request("session/wait", { sessionId: metadata.id });
      // Flush the native session journal before advertising resumability.
      await runtime.request("lolicode/session/park", { sessionId: metadata.id });
      const status = state.timedOut ? "timeout" : state.cancelled ? "cancelled" : state.approvalRequired ? "approval_required" : state.inputRequired ? "input_required" : state.finishReason === "completed" ? "ok" : "error";
      metadata.status = status;
      const result = { status, sessionId: metadata.id, model: channel.model, text: state.text.join("\n\n"), finishReason: state.finishReason || "unknown", toolErrors: state.toolErrors, usage: state.usage };
      ui.result(result);
      if (!ui.json && !ui.streamJson && status !== "ok") ui.note(`任务状态：${status}。使用 lolicode resume ${metadata.id} 继续。`);
      return result;
    } catch (error) {
      metadata.status = "error";
      throw error;
    } finally {
      clearTimeout(timeout);
      active = undefined;
      ui.stopSpinner();
      await persist();
    }
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await cancel();
    try { await runtime.close(); } finally { await release(); }
  };
  return { run, cancel, close, metadata, get active() { return !!active; } };
}
