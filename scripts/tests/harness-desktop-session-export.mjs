// Runs only in the private Windows desktop acceptance renderer.
const reloadKey = new URL("./session-export", import.meta.url).pathname;
const turnNumber = (index) => String(index).padStart(2, "0");
const copyLabel = "复制会话为 Markdown";
const emptyError = "会话尚未形成原生 Harness 日志，无法复制完整历史";
const legacyError = "旧引擎迁移会话的完整历史不在原生 Harness 日志中，无法复制完整历史";
const hasAssistantText = (state, text) => state.messages.some((message) =>
  message.role === "assistant" && message.parts.some((part) => part.text?.includes(text)));
const windowsPath = (value) => value.replaceAll("\\", "/").replace(/^\/\/\?\//, "").toLowerCase();

async function proof() {
  const response = await fetch(new URL("./session-export-proof", import.meta.url));
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function verifySessionExport(fixture, { check, configureFixtureChannel, invoke, waitFor }) {
  const config = fixture.sessionExport;
  const cold = fixture.phase === "session-export-restart";
  const saved = cold ? fixture.sessionExportState : JSON.parse(sessionStorage.getItem(reloadKey));
  const read = (sessionId) => invoke("get_agent_session", { sessionId });
  const send = (sessionId, requestId, text) =>
    invoke("send_agent_message", { sessionId, requestId, text, locale: "zh" });
  const readMarkdown = (sessionId) => invoke("read_agent_session_markdown", { sessionId });
  const settled = (sessionId, text) => waitFor(async () => {
    const state = await read(sessionId);
    if (state.status === "error") throw new Error(state.error || "Native export fixture turn failed");
    return state.status === "idle" && !state.streamConnected && (!text || hasAssistantText(state, text));
  }, text ?? sessionId);

  if (!saved) {
    check(!cold, "Missing warm acceptance state for the cold launch");
    await configureFixtureChannel(fixture);
    await invoke("open_agent_project", { path: fixture.project });
    const catalog = await invoke("get_agent_catalog");
    const modelId = catalog.defaultModel ?? catalog.models[0].id;
    const create = (title) => invoke("create_agent_session", {
      projectPath: fixture.project, title, modelId, mode: "build",
    });
    const root = await create(config.title);
    const empty = await create(config.emptyTitle);
    for (let index = 1; index <= config.turns; index++) {
      const turn = turnNumber(index);
      await send(root.id, "export-turn-" + turn, config.turnPrefix + turn);
      await settled(root.id, config.answerPrefix + turn);
    }

    const chief = await invoke("open_agent_secretary", { projectPath: fixture.project, modelId });
    const worker = await invoke("delegate_agent_secretary_task", {
      sessionId: chief.id, title: config.workerTitle, instructions: config.workerPrompt,
      requestId: "export-worker", executionMode: "shared", locale: "zh",
    });
    await waitFor(async () => {
      const state = await invoke("get_agent_secretary", { sessionId: chief.id });
      const task = state.tasks.find((entry) => entry.id === worker.id);
      if (["failed", "cancelled", "interrupted"].includes(task?.status))
        throw new Error(task.error || "Export fixture worker ended " + task.status);
      check(!task || task.sessionId === worker.sessionId, "The fixture worker identity changed");
      return task?.status === "completed";
    }, "the native worker completion");
    await settled(worker.sessionId, config.workerAnswer);
    await settled(chief.id);
    await send(config.legacyId, "export-migrate-legacy", config.legacyPrompt);
    await settled(config.legacyId, config.legacyAnswer);
    check(hasAssistantText(await read(config.legacyId), config.legacyHistory),
      "The legacy fixture did not migrate its original visible history");

    localStorage.setItem("cc-switch-last-view", "agent");
    localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
      projectPath: root.projectPath,
      sessionId: root.id,
    }));
    sessionStorage.setItem(reloadKey, JSON.stringify({
      rootId: root.id, emptyId: empty.id, workerId: worker.sessionId,
    }));
    return { reload: true };
  }

  const lastAnswer = config.answerPrefix + turnNumber(config.turns);
  const oldestAnswer = config.answerPrefix + "01";
  await waitFor(() => document.querySelector(".wb-chat")?.textContent?.includes(lastAnswer),
    "the latest visible session history");
  await waitFor(() => document.querySelector(".wb-history-earlier"), "the paginated transcript");
  check(!document.querySelector(".wb-chat").textContent.includes(oldestAnswer),
    "The oldest native turn must be hidden by the transcript's initial history window");

  const clipboard = () => globalThis.__fixtureSessionExportClipboard ?? [];
  const reads = () => globalThis.__fixtureSessionExportReads ?? [];
  const toast = (text) => [...document.querySelectorAll("[data-sonner-toast]")]
    .some((element) => element.textContent?.includes(text));
  const clickCopy = async (title) => {
    const trigger = await waitFor(() => [...document.querySelectorAll("button.wb-session-menu:not(:disabled)")]
      .find((button) => button.getAttribute("aria-label") === "管理会话：" + title),
    "the session menu for " + title);
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const action = await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === copyLabel && !item.hasAttribute("data-disabled")),
    "the session Markdown copy action");
    action.click();
  };
  const verifySource = (markdown, id) => {
    const lines = markdown.split(/\r?\n/);
    const field = lines.indexOf("Session file:");
    const sourcePath = field < 0 ? "" : windowsPath(lines[field + 3] ?? "");
    check(sourcePath.startsWith(windowsPath(fixture.profile) + "/agent/harness-desktop/") &&
      sourcePath.split("/").includes(id.slice(3).toLowerCase()),
    "The upstream Session file field did not point to the selected isolated native journal");
  };

  try {
    if (!cold) {
      await send(saved.rootId, "export-active", config.activePrompt);
      await waitFor(async () => (await read(saved.rootId)).status === "running" && (await proof()).held,
        "the running native session with an unfinished model reply");
    }
    const before = await proof();
    check(before.journal.length >= 3, "Expected native journals for the root, child, and migrated sessions");
    await clickCopy(config.title);
    const markdown = await waitFor(() => clipboard()[0], "the captured native clipboard payload");
    await waitFor(() => toast("会话已复制为 Markdown"), "the successful copy toast");
    check(typeof markdown === "string" && clipboard().length === 1,
      "Copy did not submit exactly one Markdown clipboard payload");
    check(reads().length === 1 && reads()[0] === saved.rootId,
      "Copy did not read the root session selected in its menu");
    verifySource(markdown, saved.rootId);

    let position = 0;
    for (let index = 1; index <= config.turns; index++) {
      const turn = turnNumber(index);
      for (const marker of [config.turnPrefix + turn, config.answerPrefix + turn]) {
        const next = markdown.indexOf(marker, position);
        check(next >= 0, "Export omitted or reordered native history at " + marker);
        position = next + marker.length;
      }
    }
    check(markdown.includes(config.activeAnswer) === cold,
      "Export must include the final reply after restart and exclude it while unfinished");
    check(!markdown.includes(config.workerAnswer) && !markdown.includes(config.legacyHistory),
      "The root export mixed in another conversation's history");

    const childMarkdown = await readMarkdown(saved.workerId);
    check(typeof childMarkdown === "string" && childMarkdown.includes(config.workerPrompt) &&
      childMarkdown.includes(config.workerAnswer) && !childMarkdown.includes(oldestAnswer),
    "Native child export did not retain its own prompt and reply");
    verifySource(childMarkdown, saved.workerId);
    check(reads().length === 1, "The direct child export should not be recorded as a menu action");

    await clickCopy(config.emptyTitle);
    await waitFor(() => toast("读取会话失败：" + emptyError), "the empty session export error");
    check(reads().length === 2 && reads()[1] === saved.emptyId && clipboard().length === 1,
      "Copying the nonactive empty session used the wrong session or wrote the clipboard");
    try {
      await readMarkdown(config.legacyId);
      throw new Error("Migrated session export returned an incomplete native transcript");
    } catch (error) {
      check(String(error?.message ?? error).includes(legacyError),
        "Expected the explicit incomplete legacy history error, got " + String(error));
    }
    const after = await proof();
    check(after.requests === before.requests, "Export made an extra model request");
    check(JSON.stringify(after.journal) === JSON.stringify(before.journal), "Export modified a native journal");
  } finally {
    if (!cold) {
      const response = await fetch(new URL("./session-export-release", import.meta.url), { method: "POST" });
      check(response.ok || response.status === 409, "Unable to release the live session fixture response");
    }
  }
  if (!cold) await settled(saved.rootId, config.activeAnswer);
  return { sessionExport: true, cold, sessionExportState: saved };
}
