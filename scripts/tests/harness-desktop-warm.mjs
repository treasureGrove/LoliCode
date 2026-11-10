// Served only by the private desktop acceptance Vite server.
export function warmRequestPrompt(messages) {
  // Official context notices can follow the human prompt as additional user
  // entries. Match the last business marker without accepting an earlier turn.
  return messages.filter(message => message.role === "user")
    .flatMap(message => [...JSON.stringify(message.content ?? "")
      .matchAll(/\bHARNESS_DESKTOP_WARM_[A-Z]+\b/g)].map(match => match[0])).at(-1);
}

export async function verifyWarmSession(fixture, { check, configureFixtureChannel, invoke, waitFor }) {
  const endpoint = new URL(".", import.meta.url);
  const turns = fixture.warmSession.turns;
  await configureFixtureChannel(fixture);
  const opened = await invoke("open_agent_project", { path: fixture.project });
  check(opened.sessions.length === 0, "Warm acceptance requires an empty disposable workspace");
  const catalog = await invoke("get_agent_catalog");
  const processQueries = [];
  const proofFor = async (sessionId) => {
    const url = new URL("warm-session-proof", endpoint);
    url.searchParams.set("sessionId", sessionId);
    const response = await fetch(url);
    check(response.ok, "Cannot inspect the isolated SDK process and command receipts");
    const value = await response.json();
    processQueries.push({ sessionId, processQueryMs: value.processQueryMs });
    return value;
  };
  let preparationCancelled = false;
  if (fixture.warmSession.prepare) {
    const discarded = await invoke("create_agent_session", {
      projectPath: fixture.project, modelId: catalog.defaultModel ?? catalog.models[0].id,
      mode: "build", permissionMode: "ask",
    });
    await invoke("prepare_agent_session", { sessionId: discarded.id });
    // Exercise cancellation while initialization may still be running. The
    // production close waits for cleanup; process observation adds no sleep.
    await invoke("close_agent_project");
    await waitFor(async () => {
      const value = await proofFor(discarded.id);
      return value.processes.length === 0 && value;
    }, "the cancelled preparation has no fixture SDK left", 20_000);
    const discardedState = await invoke("get_agent_session", { sessionId: discarded.id });
    const cancelled = await proofFor(discarded.id);
    check(cancelled.requests.length === 0 && Object.keys(cancelled.receipts).length === 0 &&
      discardedState.messages.length === 0 && (await invoke("get_agent_native_activity")).busy === false,
    "Cancelling preparation admitted a model request, command, history, or busy actor");
    preparationCancelled = true;
    await invoke("open_agent_project", { path: fixture.project });
  }
  const session = await invoke("create_agent_session", {
    projectPath: fixture.project, modelId: catalog.defaultModel ?? catalog.models[0].id,
    mode: "build", permissionMode: "ask",
  });
  const sessionId = session.id;
  // Explicit rename fixes title policy; a title job must not keep the runtime alive.
  await invoke("rename_agent_session", { sessionId, title: "Warm SDK acceptance (manual)" });
  const snapshot = () => invoke("get_agent_session", { sessionId });
  const activity = () => invoke("get_agent_native_activity");
  const proof = () => proofFor(sessionId);
  const identity = (process) => `${process.pid}:${process.createdAt}`;
  const seen = [];
  const submittedAt = {};
  const admissionMs = {};
  let prepareMs;
  let preparedProcess;
  let preparationSendStopped = false;
  const preparationStopRequestId = "desktop-warm-before-ready-stop";
  const mark = async (label, expectedProcesses) => {
    const value = await waitFor(async () => {
      const state = await proof();
      return state.processes.length === expectedProcesses && state;
    }, label, 20_000);
    seen.push({ label, processes: value.processes, receipts: value.receipts,
      processQueryMs: value.processQueryMs });
    return value;
  };
  const completed = async (turn) => {
    await waitFor(async () => {
      const state = await snapshot();
      if (state.status === "error") throw new Error(state.error || "Warm session failed");
      const reply = state.messages.some(message => message.role === "assistant" &&
        message.parts.some(part => part.text === turn.answer));
      return state.status === "idle" && !state.titlePending && reply;
    }, `the completed ${turn.requestId}`, 45_000);
    await waitFor(async () => {
      const state = await activity();
      const saved = await proof();
      return state.busy === false && saved.receipts[turn.requestId] === "completed";
    }, `idle and not busy after ${turn.requestId}`, 20_000);
  };
  const send = async (turn) => {
    // Read the matching receive time from the fixture later. Neither CIM nor
    // snapshot polling is included in this IPC-to-model-request interval.
    submittedAt[turn.requestId] = Date.now();
    await invoke("send_agent_message", {
      sessionId, text: turn.prompt, requestId: turn.requestId, locale: "zh",
    });
    admissionMs[turn.requestId] = Date.now() - submittedAt[turn.requestId];
  };

  if (fixture.warmSession.prepare) {
    await invoke("prepare_agent_session", { sessionId });
    // Do not await send admission: it is waiting for the preparation barrier.
    // Stop must record this request's cancellation before that barrier opens.
    const pendingSend = invoke("send_agent_message", {
      sessionId, text: "HARNESS_DESKTOP_WARM_EARLY", requestId: preparationStopRequestId, locale: "zh",
    });
    const pendingStop = invoke("interrupt_agent_session", {
      sessionId, expectedRequestId: preparationStopRequestId,
    });
    await Promise.all([pendingSend, pendingStop]);
    await waitFor(async () => {
      const value = await proof();
      const state = await snapshot();
      return value.processes.length === 0 && value.requests.length === 0 &&
        value.receipts[preparationStopRequestId] === "cancelled" &&
        state.status === "idle" && (await activity()).busy === false;
    }, "the send stopped during preparation has no model request or SDK left", 20_000);
    preparationSendStopped = true;

    const startedAt = Date.now();
    await invoke("prepare_agent_session", { sessionId, waitForReady: true });
    prepareMs = Date.now() - startedAt;
    const ready = await mark("prepared SDK is ready before the first send", 1);
    preparedProcess = identity(ready.processes[0]);
    const state = await snapshot();
    check(ready.requests.length === 0 && Object.keys(ready.receipts).length === 1 &&
      ready.receipts[preparationStopRequestId] === "cancelled",
      "Preparing the session admitted a model request or command");
    check(state.status === "idle" && state.messages.length === 0 &&
      (await activity()).busy === false,
    "Preparing the session changed conversation history or made it busy");
  }

  await send(turns[0]);
  await completed(turns[0]);
  const first = await mark("first completed SDK remains warm", 1);
  const original = identity(first.processes[0]);
  check(!preparationSendStopped || (first.receipts[preparationStopRequestId] === "cancelled" &&
    first.receipts[turns[0].requestId] === "completed"),
  "An old preparation Stop affected the next independent request in the same session");
  check(!preparedProcess || original === preparedProcess,
    "The first send restarted the SDK instead of using the prepared process");
  const nativeReadStartedAt = performance.now();
  const raw = await invoke("read_agent_session_native", { sessionId, maxMessages: 12 });
  const nativeReadMs = Math.round(performance.now() - nativeReadStartedAt);
  const events = raw.page.records.map(record => record.event);
  check(raw.state.active === true,
    "Completed warm history was read by a cold helper instead of the live SDK");
  check(events.some(event => event.type === "user/message" &&
    event.data.source?.kind === "user" && event.data.content?.some(part =>
      part.type === "text" && part.text === turns[0].prompt)) &&
    events.some(event => event.type === "assistant/message" &&
      event.data.message?.content?.some(part => part.type === "text" && part.text === turns[0].answer)),
  "The official warm history lost a complete user or assistant message");
  await send(turns[1]);
  await completed(turns[1]);
  const second = await mark("second completed SDK remains warm", 1);
  check(identity(second.processes[0]) === original, "The second turn restarted the SDK instead of reusing it");

  await send(turns[2]);
  const blocked = await waitFor(async () => {
    const state = await proof();
    return state.held && state;
  }, "the third model request paused before completion", 45_000);
  check(blocked.processes.length === 1 && identity(blocked.processes[0]) === original,
    "The independently stopped turn did not reuse the warm SDK");
  check((await activity()).busy === true, "A live model request was reported idle");
  await invoke("interrupt_agent_session", { sessionId });
  await waitFor(async () => {
    const saved = await proof();
    const state = await snapshot();
    return state.status === "idle" && (await activity()).busy === false &&
      saved.receipts[turns[2].requestId] === "cancelled" &&
      saved.receipts[turns[0].requestId] === "completed" &&
      saved.receipts[turns[1].requestId] === "completed";
  }, "Stop settled only the third command", 20_000);
  await mark("cancelled SDK is retired", 0);

  await send(turns[3]);
  await completed(turns[3]);
  const recovered = await mark("a fresh SDK continues after Stop", 1);
  const recovery = identity(recovered.processes[0]);
  check(recovery !== original, "A cancelled SDK was reused for a new turn");
  const changed = await invoke("update_agent_session", { sessionId, permissionMode: "auto" });
  check(changed.permissionMode === "auto", "The permission change was not acknowledged");
  await mark("permission change retires the old warm SDK", 0);
  await send(turns[4]);
  await completed(turns[4]);
  const configured = await mark("new permission uses a fresh SDK", 1);
  check(identity(configured.processes[0]) !== recovery, "New permissions reused the old SDK configuration");
  const final = await snapshot();
  check(final.session.permissionMode === "auto" && !final.queuedMessages?.length,
    "New configuration or an old turn's queue leaked into the final conversation");
  check(turns.filter(turn => !turn.hold).every(turn => final.messages.some(message =>
    message.role === "assistant" && message.parts.some(part => part.text === turn.answer))),
  "Continuing the session lost a completed earlier reply");
  await invoke("close_agent_project");
  const closed = await mark("closing the project retires every fixture SDK", 0);
  const turnTimings = turns.map(({ requestId }) => {
    const modelReceivedAt = closed.receivedAt[requestId];
    check(Number.isSafeInteger(modelReceivedAt) && modelReceivedAt >= submittedAt[requestId],
      `Missing or invalid model receive time for ${requestId}`);
    return { requestId, submittedAt: submittedAt[requestId], modelReceivedAt,
      preparationMs: modelReceivedAt - submittedAt[requestId], admissionMs: admissionMs[requestId] };
  });
  return { sessionId, warmSession: true, warmReuse: true, stopIsolated: true,
    configurationRestart: true, projectClosed: true, processProof: seen,
    preparedSession: Boolean(preparedProcess), preparationCancelled, preparationSendStopped,
    prepareMs, turnTimings,
    processQueries, nativeReadMs, nativeHistoryVerified: true,
    timingSource: "renderer send IPC invocation to local model HTTP request receive" };
}
