// Isolated WebView2 performance fixture served by harness-desktop-acceptance.mjs.
const setupKey = `${new URL(".", import.meta.url).pathname}:switching`;
const hidden = "[hidden], [aria-hidden='true'], [inert]";
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const round = value => Math.round(value * 10) / 10;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function waitForPaint(read, description, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    let frame;
    let matched = false;
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame);
      reject(new Error(`Timed out waiting for two painted frames of ${description}`));
    }, timeout);
    const inspect = () => {
      try {
        const ready = read();
        if (ready && matched) {
          clearTimeout(timer);
          resolve(ready);
          return;
        }
        matched = Boolean(ready);
        frame = requestAnimationFrame(inspect);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    };
    frame = requestAnimationFrame(inspect);
  });
}

function visible(scope, selector) {
  return [...(scope?.querySelectorAll(selector) ?? [])].find(node => !node.closest(hidden));
}

function painted(node) {
  return Boolean(node?.getClientRects().length && node.checkVisibility({
    opacityProperty: true,
    visibilityProperty: true,
  }));
}

function pendingPaintProbe(isPainted) {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const frames = [];
  return {
    wait,
    release,
    onPending() {
      frames.push(isPainted());
      if (frames.length === 2) release();
    },
    passed: () => frames.length >= 2 && frames.every(Boolean),
  };
}

function traceChatLayout(entries) {
  const prototype = Element.prototype;
  const originals = new Map();
  for (const property of ["scrollTop", "scrollHeight", "clientHeight"]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor?.configurable || !descriptor.get) continue;
    originals.set(property, descriptor);
    const timed = (method, accessor) => function (...args) {
      if (!this.classList.contains("wb-chat")) return accessor.apply(this, args);
      const startTime = performance.now();
      const value = accessor.apply(this, args);
      const duration = performance.now() - startTime;
      if (duration >= 5) entries.push({ property, method, startTime, duration: round(duration) });
      return value;
    };
    Object.defineProperty(prototype, property, {
      ...descriptor,
      get: timed("get", descriptor.get),
      ...(descriptor.set ? { set: timed("set", descriptor.set) } : {}),
    });
  }
  return () => {
    for (const [property, descriptor] of originals)
      Object.defineProperty(prototype, property, descriptor);
  };
}

function verifyWindowsDragPath() {
  const targets = [...document.querySelectorAll("[data-tauri-drag-region]")];
  const target = targets.find(node => !node.closest(hidden));
  if (!target || targets.some(node => getComputedStyle(node).webkitAppRegion === "drag")) return false;
  const dragUrl = window.__TAURI_INTERNALS__.convertFileSrc("plugin:window|start_dragging", "ipc");
  const fetchOriginal = window.fetch;
  let calls = 0;
  window.fetch = function (input, ...args) {
    if (input === dragUrl) {
      calls++;
      return Promise.resolve(new Response("null", {
        headers: { "content-type": "application/json", "tauri-response": "ok" },
      }));
    }
    return fetchOriginal.call(this, input, ...args);
  };
  try {
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 });
    target.dispatchEvent(down);
    return calls === 1 && down.defaultPrevented;
  } finally {
    window.fetch = fetchOriginal;
  }
}

export async function verifySwitching(fixture, { configureFixtureChannel, invoke }) {
  const { sessions, turns, source, baseline, profileScale } = fixture.switching;
  const verifyPending = !baseline && !profileScale;
  const attachmentName = `switching-${sessions[1].id.slice(-8)}.txt`;
  if (!sessionStorage.getItem(setupKey)) {
    await configureFixtureChannel(fixture);
    const { saveAgentDocumentAttachments } = await import("/lib/agentImageStore.ts");
    await saveAgentDocumentAttachments(`user-B-${turns}`, [{
      id: "switching-attachment", fileName: attachmentName, mime: "text/plain",
      bytes: 1, dataBase64: "YQ==",
    }]);
    await invoke("set_builtin_app_enabled", { app: "tavern", enabled: true });
    const [preset] = await invoke("get_tavern_presets");
    check(preset, "The fixture could not find a built-in Tavern character");
    const character = await invoke("add_tavern_preset", { presetId: preset.id });
    await invoke("create_tavern_story", { characterId: character.id, title: "切换验收对话" });
    const opened = await invoke("open_agent_project", { path: fixture.project });
    for (const { id } of sessions)
      check(opened.sessions.some(session => session.id === id), "Seeded Harness desktop history was not listed");
    localStorage.setItem("lolicode-theme", "dark");
    localStorage.setItem("cc-switch-last-view", "agent");
    localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
      projectPath: opened.workspace.path, sessionId: sessions[0].id,
    }));
    sessionStorage.setItem(setupKey, "1");
    return { reload: true };
  }

  const agent = () => document.querySelector('#content-area[data-view="agent"] #agent-content-area');
  const chat = () => visible(agent(), ".wb-chat");
  const composer = () => visible(agent(), "textarea#agent-message");
  const followsTail = () => {
    const scroll = chat();
    return Boolean(scroll && Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) <= 2);
  };
  const transcript = session => {
    const content = visible(chat(), ".wb-chat-content");
    if (content?.querySelector("[data-agent-transcript-session]"))
      return visible(content, `[data-agent-transcript-session="${session.id}"]`);
    return content;
  };
  const tail = session => transcript(session)?.querySelector('article[aria-label="Agent 回复"]:last-of-type');
  const group = session => [...(transcript(session)?.querySelectorAll(".wb-execution-group") ?? [])].at(-1);
  const sessionContentReady = session => Boolean(tail(session)?.textContent.includes(session.last));
  const sessionTitleReady = session => agent()?.querySelector(".wb-titlebar h1")?.textContent.trim() === session.title;
  const sessionReady = (session, hasContent = sessionContentReady(session)) =>
    hasContent && sessionTitleReady(session) && Boolean(composer()?.getClientRects().length);
  const tavern = () => document.querySelector('#content-area[data-view="tavern"]');
  const tavernComposer = () => visible(tavern(), "#main-content textarea");
  const tavernReady = () => Boolean(tavernComposer()?.getClientRects().length &&
    visible(tavern(), 'button[aria-label="打开对话菜单"]'));
  const viewport = () => document.querySelector("#content-area");
  const workspaceCanvas = () => visible(viewport(), "[data-workspace-viewport]") ?? viewport();
  const nav = () => visible(document, "nav.lolicode-unified-sidebar");
  const modeButton = label => visible(nav(), `button[aria-label="${label}"]`);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasAnimation = (node, name) => Boolean(
    node?.getAnimations().some(animation => animation.id === name),
  );
  const activePane = () => visible(viewport(), "[data-workspace-active]");
  const workspaceEntry = () => visible(activePane(), "[data-workspace-entry]");
  const bounds = node => {
    const rect = node?.getBoundingClientRect();
    return rect && [rect.x, rect.y, rect.width, rect.height].map(round).join(",");
  };
  const sessionButton = session => [...(nav()?.querySelectorAll("button.wb-session-row") ?? [])]
    .find(button => !button.disabled && button.textContent.trim() === session.title);
  const goalControlHidden = () => !visible(agent(), '[aria-label="Agent 会话模式"]') &&
    ![...(agent()?.querySelectorAll("button") ?? [])].some(button => button.textContent.trim() === "设置目标");
  const loadOlder = () => [...(chat()?.querySelectorAll("button") ?? [])]
    .find(button => !button.closest(hidden) &&
      (button.getAttribute("aria-label") ?? button.textContent.trim()) === "加载更早的消息");

  const [first, second, third, fourth, fifth, sixth] = sessions;
  await waitForPaint(() => sessionReady(first) && sessionButton(second), "the seeded Agent conversation");
  const initialSidebar = nav();
  const sidebarBounds = bounds(initialSidebar);
  const initialCanvas = workspaceCanvas();
  const canvasBounds = bounds(initialCanvas);
  const canvasBackground = getComputedStyle(initialCanvas).backgroundColor;
  const channelsTitle = () => visible(activePane(), "h1");
  const darkBackground = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(canvasBackground);
  const articles = session => transcript(session)?.querySelectorAll("article").length ?? 0;
  const initialArticles = articles(first);
  const checks = {
    noGoalCreationControl: goalControlHidden(),
    historyWindowed: !transcript(first).textContent.includes(first.first) && Boolean(loadOlder()),
    olderMessagesLoaded: false,
    draftPreserved: true,
    tavernDraftPreserved: true,
    readingPositionPreserved: true,
    toolExpansionPreserved: true,
    firstFrameNavigation: true,
    firstFrameSessionTitle: true,
    sidebarModeHasNoAnimation: true,
    sidebarStaysMounted: true,
    sidebarBoundsStable: true,
    workspaceSurfacePainted: true,
    darkViewportApplied: document.documentElement.classList.contains("dark") &&
      Boolean(darkBackground?.slice(1).every(channel => Number(channel) < 128)),
    workspaceModeMotion: true,
    inactiveWorkspaceNotPainted: true,
    reducedMotionPreferenceApplied: !fixture.switching.reducedMotion || reducedMotion,
    firstVisitFollowsTail: followsTail(),
    rapidSwitchKeepsLastSelection: true,
    ...(verifyPending ? { pendingTranscriptPainted: false, pendingTavernPainted: false, loadedTranscriptMotion: false } : {}),
  };
  const observeModeFrame = (view, selected) => {
    const sidebar = nav();
    const canvas = workspaceCanvas();
    const pane = activePane();
    const foreground = view === "channels" ? channelsTitle() : workspaceEntry();
    const sidebarAnimations = sidebar?.getAnimations({ subtree: true }).map(animation =>
      animation.id || animation.animationName || animation.transitionProperty || "unnamed",
    );
    const canvasStyle = canvas && getComputedStyle(canvas);
    const background = canvasStyle?.backgroundColor;
    const paneStyle = pane && getComputedStyle(pane);
    const opacity = paneStyle && Number(paneStyle.opacity);
    const onlyDestination = painted(foreground) && [...(canvas?.children ?? [])]
      .every(node => node === pane || !painted(node));
    checks.sidebarModeHasNoAnimation &&= sidebarAnimations?.length === 0;
    checks.sidebarStaysMounted &&= sidebar === initialSidebar;
    checks.sidebarBoundsStable &&= bounds(sidebar) === sidebarBounds;
    checks.workspaceSurfacePainted &&= Boolean(selected && viewport()?.dataset.view === view && onlyDestination &&
      canvas === initialCanvas && bounds(pane) === canvasBounds && canvasStyle.opacity === "1" &&
      background === canvasBackground && opacity >= 0.94 &&
      paneStyle.translate === "none" && paneStyle.transform === "none");
    checks.inactiveWorkspaceNotPainted &&= onlyDestination;
    return { view, sidebarAnimations, background, opacity, onlyDestination,
      workspace: hasAnimation(pane, "lolicode-workspace-enter") };
  };
  const expected = new Map();
  const setInput = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  const fillDraft = (input, text) => {
    setInput.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const prepareReadingState = async session => {
    const draft = `未发送的验收草稿 ${session.title}`;
    fillDraft(composer(), draft);
    group(session)?.querySelector("summary").click();
    await waitForPaint(() => group(session)?.open && group(session)?.querySelector(".wb-tool"),
      `${session.title} expanded execution group`);
    const scroll = chat();
    if (scroll.scrollHeight <= scroll.clientHeight) {
      const boxes = [];
      for (let node = scroll; node; node = node.parentElement) {
        const css = getComputedStyle(node);
        boxes.push({ node: node.id || String(node.className).split(" ")[0] || node.tagName,
          height: node.clientHeight, display: css.display, flex: css.flex,
          direction: css.flexDirection, overflow: css.overflowY, minHeight: css.minHeight });
      }
      throw new Error(`No scroll range at viewport ${innerWidth}×${innerHeight}: ${JSON.stringify(boxes)}`);
    }
    const position = Math.max(1, scroll.scrollHeight - scroll.clientHeight - 620);
    scroll.scrollTop = position;
    await waitForPaint(() => Math.abs(scroll.scrollTop - position) <= 2 && composer()?.value === draft,
      `${session.title} off-tail reading position and draft`);
    expected.set(session.id, { position: scroll.scrollTop, draft });
  };
  const checkReadingState = session => {
    const state = expected.get(session.id);
    if (!state) return;
    checks.noGoalCreationControl &&= goalControlHidden();
    checks.draftPreserved &&= composer()?.value === state.draft;
    checks.readingPositionPreserved &&= Math.abs((chat()?.scrollTop ?? -999) - state.position) <= 6;
    checks.toolExpansionPreserved &&= Boolean(group(session)?.open);
  };

  const longTasks = [];
  const observer = PerformanceObserver.supportedEntryTypes.includes("longtask")
    ? new PerformanceObserver(list => longTasks.push(...list.getEntries()))
    : null;
  observer?.observe({ type: "longtask" });
  const longFrames = [];
  const chatLayout = [];
  const stopLayoutTrace = profileScale ? traceChatLayout(chatLayout) : null;
  const frameObserver = profileScale && PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")
    ? new PerformanceObserver(list => longFrames.push(...list.getEntries()))
    : null;
  frameObserver?.observe({ type: "long-animation-frame" });
  const { readAgentImageAttachments } = await import("/lib/agentImageStore.ts");
  let attachmentStoreError;
  try {
    await readAgentImageAttachments("switching-fixture-probe");
  } catch (error) {
    attachmentStoreError = String(error);
  }
  const { agentApi } = await import("/lib/api/agent.ts");
  const originalGetSession = agentApi.getSession;
  const snapshotReads = [];
  let profileFailure;
  const coldTranscript = pendingPaintProbe(() =>
    painted(chat()?.querySelector("[data-conversation-loading]")) &&
    [...(chat()?.querySelectorAll("[data-agent-transcript-session]") ?? [])].every(node => !painted(node)),
  );
  agentApi.getSession = async function (...args) {
    const read = { session: args[0], started: performance.now(), finished: null };
    snapshotReads.push(read);
    try {
      const snapshot = await originalGetSession.apply(this, args);
      read.ipcFinished = performance.now();
      if (verifyPending && read.session === sixth.id) await coldTranscript.wait;
      return snapshot;
    } finally {
      read.finished = performance.now();
    }
  };
  const originalTransaction = IDBDatabase.prototype.transaction;
  let attachmentReads = 0;
  IDBDatabase.prototype.transaction = function (store, mode, ...options) {
    if (store === "sent-images" && mode === "readonly") attachmentReads++;
    return originalTransaction.call(this, store, mode, ...options);
  };
  const measure = async (name, control, selection, ready, {
    sessionId, contentReady, titleReady, onFrame, onPending, onContent,
  } = {}) => {
    const button = control();
    check(button, `Missing switching control for ${name}`);
    await nextFrame();
    const start = performance.now();
    const readsBefore = attachmentReads;
    let clickMilliseconds;
    let frames = 0;
    let navigationFrame = null;
    let navigationMilliseconds = null;
    let contentFrame = null;
    let contentMilliseconds = null;
    let animations;
    button.click();
    if (profileScale) clickMilliseconds = round(performance.now() - start);
    // Selection can paint while the destination is still preparing its content.
    try {
      await waitForPaint(() => {
        frames += 1;
        const selected = selection();
        const frame = onFrame?.(selected);
        if (selected && navigationFrame === null) {
          navigationFrame = frames;
          navigationMilliseconds = round(performance.now() - start);
          animations = frame;
          if (titleReady) checks.firstFrameSessionTitle &&= titleReady();
        }
        const hasContent = contentReady?.();
        if (hasContent && contentFrame === null) {
          contentFrame = frames;
          contentMilliseconds = round(performance.now() - start);
          onContent?.();
        }
        const complete = selected && ready(hasContent);
        if (selected && !complete) onPending?.();
        return complete;
      }, name);
    } catch (error) {
      if (profileScale) profileFailure = {
        name, message: error.message, frames, navigationFrame, navigationMilliseconds,
        contentFrame, contentMilliseconds, clickMilliseconds,
        pendingSnapshotReads: snapshotReads.filter(read => !read.finished).map(read => ({
          session: sessions.findIndex(session => session.id === read.session),
          nativePending: read.ipcFinished === undefined,
          ageMs: round(performance.now() - read.started),
        })),
        selected: Boolean(selection()), contentReady: contentReady?.(),
        titleReady: titleReady?.(), loading: painted(agent()?.querySelector("[data-conversation-loading]")),
      };
      throw error;
    }
    const end = performance.now();
    checks.firstFrameNavigation &&= navigationFrame === 1;
    await nextFrame();
    longTasks.push(...(observer?.takeRecords() ?? []));
    const overlapping = longTasks.filter(entry =>
      entry.startTime < end && entry.startTime + entry.duration > start,
    );
    longFrames.push(...(frameObserver?.takeRecords() ?? []));
    const slowest = longFrames.filter(entry => entry.startTime < end && entry.startTime + entry.duration > start)
      .sort((a, b) => b.duration - a.duration)[0];
    return {
      name, milliseconds: round(end - start),
      navigationFrame, navigationMilliseconds,
      ...(contentReady ? { contentFrame, contentMilliseconds } : {}),
      ...(animations ? { animations } : {}),
      attachmentReadTransactions: attachmentReads - readsBefore,
      snapshotReadMs: snapshotReads.filter(read => read.started >= start && read.finished !== null && read.finished <= end)
        .map(read => round(read.finished - read.started)),
      ...(sessionId ? { pendingPrefetchMs: snapshotReads.filter(read =>
        read.session === sessionId && read.started < start && read.finished > start && read.finished <= end,
      ).map(read => round(read.finished - start)) } : {}),
      longTasks: overlapping.length,
      maxLongTask: round(Math.max(0, ...overlapping.map(entry => entry.duration))),
      ...(profileScale ? {
        clickMilliseconds,
        nativeSnapshotReadMs: snapshotReads.filter(read => read.started >= start && read.ipcFinished <= end)
          .map(read => round(read.ipcFinished - read.started)),
        chatLayout: chatLayout.filter(read => read.startTime >= start && read.startTime <= end)
          .map(({ property, method, duration }) => ({ property, method, duration })),
        ...(slowest ? { slowFrame: {
          milliseconds: round(slowest.duration),
          blockingMs: round(slowest.blockingDuration),
          forcedLayoutMs: round(slowest.scripts.reduce((total, script) => total + script.forcedStyleAndLayoutDuration, 0)),
          leadingScript: [...slowest.scripts].sort((a, b) => b.duration - a.duration)[0]?.sourceFunctionName,
        } } : {}),
      } : {}),
    };
  };
  const sessionSwitches = [];
  const modeSwitches = [];
  const idleAfterAgentReturn = [];
  const observeReturn = async () => {
    const start = performance.now();
    let previous = start;
    let largestGap = 0;
    while (previous - start < 1000) {
      await nextFrame();
      const now = performance.now();
      largestGap = Math.max(largestGap, now - previous);
      previous = now;
    }
    longTasks.push(...(observer?.takeRecords() ?? []));
    longFrames.push(...(frameObserver?.takeRecords() ?? []));
    const longest = entries => round(Math.max(0, ...entries.filter(entry => entry.startTime >= start)
      .map(entry => entry.duration)));
    idleAfterAgentReturn.push({ frameGapMs: round(largestGap), longTaskMs: longest(longTasks), longFrameMs: longest(longFrames) });
  };
  const switchSession = async (session, label, probes) => {
    sessionSwitches.push(await measure(label, () => sessionButton(session),
      () => sessionButton(session)?.matches('[aria-pressed="true"]'),
      hasContent => sessionReady(session, hasContent),
      { sessionId: session.id, contentReady: () => sessionContentReady(session),
        titleReady: () => sessionTitleReady(session), ...probes }));
    checkReadingState(session);
  };
  const switchMode = async (view, label, control, selected, ready, probes) => {
    modeSwitches.push(await measure(label, control, selected, ready, {
      onFrame: selected => observeModeFrame(view, selected), ...probes,
    }));
  };
  const selectedMode = label => modeButton(label)?.matches('[aria-current="page"]');
  const switchToTavern = async (label, onPending) => {
    await switchMode("tavern", label, () => modeButton("角色对话"), () => selectedMode("角色对话"),
      tavernReady, { onPending });
  };
  const switchToAgent = async label => {
    await switchMode("agent", label, () => modeButton("编程工作台"), () => selectedMode("编程工作台"),
      hasContent => sessionReady(first, hasContent), { contentReady: () => sessionContentReady(first),
        titleReady: () => sessionTitleReady(first) });
  };
  const verifyModelsNavigation = async () => {
    const { queryClient } = await import("/lib/query/queryClient.ts");
    await switchToTavern("Tavern before opening models");
    const draft = tavernComposer().value;
    const queryKey = ["tavern", "catalog"];
    const catalog = await waitForPaint(() => queryClient.getQueryData(queryKey), "the Tavern model catalog");
    await queryClient.cancelQueries({ queryKey });
    // Exercise the ordinary empty-model action without changing any saved channel.
    queryClient.setQueryData(queryKey, { ...catalog, models: [] });
    const configure = () => [...tavern()?.querySelectorAll("button") ?? []]
      .find(button => button.textContent.trim() === "配置模型");
    try {
      await waitForPaint(configure, "the Tavern configure models action");
      await switchMode("channels", "Model channels from Tavern", configure,
        () => viewport()?.dataset.view === "channels", () => painted(channelsTitle()) &&
          channelsTitle().textContent.trim() === "渠道与模型");
      await switchToTavern("Tavern from model channels");
      checks.tavernDraftPreserved &&= tavernComposer().value === draft;
    } finally {
      queryClient.setQueryData(queryKey, catalog);
    }
    await switchToAgent("Agent after opening models");
    checkReadingState(first);
  };
  const verifyPendingTavern = async () => {
    const { queryClient } = await import("/lib/query/queryClient.ts");
    const { tavernSnapshotQuery } = await import("/lib/api/tavern.ts");
    await queryClient.cancelQueries({ queryKey: tavernSnapshotQuery.queryKey });
    queryClient.removeQueries({ queryKey: tavernSnapshotQuery.queryKey });
    const coldTavern = pendingPaintProbe(() => painted(tavern()?.querySelector("[data-conversation-loading]")));
    const request = queryClient.fetchQuery({
      ...tavernSnapshotQuery,
      queryFn: async () => {
        await coldTavern.wait;
        return tavernSnapshotQuery.queryFn();
      },
    });
    try {
      await switchToTavern("Tavern with pending snapshot", coldTavern.onPending);
      checks.pendingTavernPainted = coldTavern.passed();
    } finally {
      coldTavern.release();
      await request;
    }
    await switchToAgent("Agent after pending Tavern snapshot");
  };
  const verifyWarmSessions = async () => {
    await switchSession(second, "cold B");
    await waitForPaint(() => transcript(second)?.textContent.includes(attachmentName),
      "the stored document attachment after switching");
    checks.firstVisitFollowsTail &&= followsTail();
    await prepareReadingState(second);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await switchSession(first, `warm A ${attempt}`);
      await switchSession(second, `warm B ${attempt}`);
    }
    await switchSession(first, profileScale ? "warm A after session loop" : "warm A before mode switches");
  };
  try {
    await prepareReadingState(first);
    if (!profileScale) await verifyWarmSessions();
    const tavernDraft = "未发送的酒馆验收草稿";
    for (let attempt = 1; attempt <= 5; attempt++) {
      await switchToTavern(attempt === 1 ? "cold Tavern" : `warm Tavern ${attempt}`);
      if (attempt === 1) {
        fillDraft(tavernComposer(), tavernDraft);
        await waitForPaint(() => tavernComposer()?.value === tavernDraft, "the Tavern draft");
      } else checks.tavernDraftPreserved &&= tavernComposer()?.value === tavernDraft;
      await switchToAgent(`warm Agent ${attempt}`);
      checkReadingState(first);
      if (profileScale && (attempt === 1 || attempt === 5)) await observeReturn();
    }
    if (profileScale) await verifyWarmSessions();
    await switchSession(third, "first visit C");
    checks.firstVisitFollowsTail &&= followsTail();
    await switchSession(fifth, "first visit E outside recent set");
    checks.firstVisitFollowsTail &&= followsTail();
    await switchSession(first, "warm A before rapid switch");
    const interrupted = sessionButton(fourth);
    const finalTarget = sessionButton(first);
    check(interrupted && finalTarget, "Missing the rapid switching controls");
    interrupted.click();
    await nextFrame();
    checks.rapidSwitchKeepsLastSelection &&= sessionButton(fourth)?.matches('[aria-pressed="true"]');
    finalTarget.click();
    await waitForPaint(() => {
      const selected = sessionButton(first)?.matches('[aria-pressed="true"]');
      if (selected) {
        checks.rapidSwitchKeepsLastSelection &&= sessions.slice(1).every(session => !sessionContentReady(session));
      }
      return selected && sessionReady(first) && snapshotReads.every(read =>
        read.session !== fourth.id || read.finished !== null,
      );
    }, "the final target after switching away from the fourth session");
    checkReadingState(first);
    if (verifyPending) {
      await switchSession(sixth, "Agent with pending snapshot", {
        onPending: coldTranscript.onPending,
        onContent() {
          checks.loadedTranscriptMotion = hasAnimation(transcript(sixth), "lolicode-transcript-enter") !== reducedMotion;
        },
      });
      checks.pendingTranscriptPainted = coldTranscript.passed();
      await switchSession(first, "Agent after pending snapshot");
      await verifyPendingTavern();
      await verifyModelsNavigation();
    }
  } catch (error) {
    if (!profileScale) throw error;
    profileFailure ??= { message: error.message };
  } finally {
    coldTranscript.release();
    agentApi.getSession = originalGetSession;
    IDBDatabase.prototype.transaction = originalTransaction;
    observer?.disconnect();
    frameObserver?.disconnect();
    stopLayoutTrace?.();
  }

  checks.workspaceModeMotion = modeSwitches.every(({ animations }) => animations?.workspace === !reducedMotion);
  checks.windowsDragUsesTauri = !profileFailure && verifyWindowsDragPath();

  let olderMessagesError;
  if (checks.historyWindowed && !profileFailure) {
    const firstUser = () => transcript(first)?.querySelector('article[aria-label="你的消息"]')?.textContent;
    const previousFirst = firstUser();
    loadOlder().click();
    try {
      await waitForPaint(() => articles(first) > initialArticles && firstUser() !== previousFirst && sessionReady(first),
        "loading older messages without losing the current tail", 10_000);
      checks.olderMessagesLoaded = true;
    } catch (error) {
      olderMessagesError = error.message;
    }
  }

  return {
    source, turnsPerSession: turns, baseline, initialArticles,
    ...(profileScale ? { snapshotBytes: sessions.map(session => session.bytes), longFrameSupported: Boolean(frameObserver),
      idleAfterAgentReturn, profileFailure } : {}),
    documentHidden: document.hidden, reducedMotion, longTaskSupported: Boolean(observer),
    sessionSwitches, modeSwitches, checks, olderMessagesError, attachmentStoreError,
  };
}
