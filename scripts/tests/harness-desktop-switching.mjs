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

export async function verifySwitching(fixture, { configureFixtureChannel, invoke }) {
  const { sessions, turns, source, baseline } = fixture.switching;
  if (!sessionStorage.getItem(setupKey)) {
    await configureFixtureChannel(fixture);
    await invoke("set_builtin_app_enabled", { app: "tavern", enabled: true });
    const [preset] = await invoke("get_tavern_presets");
    check(preset, "The fixture could not find a built-in Tavern character");
    const character = await invoke("add_tavern_preset", { presetId: preset.id });
    await invoke("create_tavern_story", { characterId: character.id, title: "切换验收对话" });
    const opened = await invoke("open_agent_project", { path: fixture.project });
    for (const { id } of sessions)
      check(opened.sessions.some(session => session.id === id), "Seeded Harness desktop history was not listed");
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
  const transcript = session => {
    const content = visible(chat(), ".wb-chat-content");
    if (content?.querySelector("[data-agent-transcript-session]"))
      return visible(content, `[data-agent-transcript-session="${session.id}"]`);
    return content;
  };
  const tail = session => transcript(session)?.querySelector('article[aria-label="Agent 回复"]:last-of-type');
  const group = session => [...(transcript(session)?.querySelectorAll(".wb-execution-group") ?? [])].at(-1);
  const sessionReady = session => agent()?.querySelector(".wb-titlebar h1")?.textContent.trim() === session.title &&
    Boolean(composer()?.getClientRects().length) && tail(session)?.textContent.includes(session.last);
  const tavern = () => document.querySelector('#content-area[data-view="tavern"]');
  const tavernComposer = () => visible(tavern(), "#main-content textarea");
  const tavernReady = () => Boolean(tavernComposer()?.getClientRects().length &&
    visible(tavern(), 'button[aria-label="打开对话菜单"]'));
  const nav = () => visible(document, "nav.lolicode-unified-sidebar");
  const modeButton = label => visible(nav(), `button[aria-label="${label}"]`);
  const sessionButton = session => [...(nav()?.querySelectorAll("button.wb-session-row") ?? [])]
    .find(button => !button.disabled && button.textContent.trim() === session.title);
  const goalControlHidden = () => !visible(agent(), '[aria-label="Agent 会话模式"]') &&
    ![...(agent()?.querySelectorAll("button") ?? [])].some(button => button.textContent.trim() === "设置目标");
  const loadOlder = () => [...(chat()?.querySelectorAll("button") ?? [])]
    .find(button => !button.closest(hidden) &&
      (button.getAttribute("aria-label") ?? button.textContent.trim()) === "加载更早的消息");

  const first = sessions[0];
  const second = sessions[1];
  await waitForPaint(() => sessionReady(first) && sessionButton(second), "the seeded Agent conversation");
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
  const measure = async (name, button, ready) => {
    check(button, `Missing switching control for ${name}`);
    await nextFrame();
    const start = performance.now();
    button.click();
    await waitForPaint(ready, name);
    const end = performance.now();
    await nextFrame();
    longTasks.push(...(observer?.takeRecords() ?? []));
    const overlapping = longTasks.filter(entry =>
      entry.startTime < end && entry.startTime + entry.duration > start,
    );
    return {
      name, milliseconds: round(end - start),
      longTasks: overlapping.length,
      maxLongTask: round(Math.max(0, ...overlapping.map(entry => entry.duration))),
    };
  };
  const sessionSwitches = [];
  const modeSwitches = [];
  const switchSession = async (session, label) => {
    sessionSwitches.push(await measure(label, sessionButton(session), () => sessionReady(session)));
    checkReadingState(session);
  };
  try {
    await prepareReadingState(first);
    await switchSession(second, "cold B");
    await prepareReadingState(second);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await switchSession(first, `warm A ${attempt}`);
      await switchSession(second, `warm B ${attempt}`);
    }
    await switchSession(first, "warm A before mode switches");
    const tavernDraft = "未发送的酒馆验收草稿";
    for (let attempt = 1; attempt <= 5; attempt++) {
      modeSwitches.push(await measure(attempt === 1 ? "cold Tavern" : `warm Tavern ${attempt}`,
        modeButton("角色对话"), tavernReady));
      if (attempt === 1) {
        fillDraft(tavernComposer(), tavernDraft);
        await waitForPaint(() => tavernComposer()?.value === tavernDraft, "the Tavern draft");
      } else checks.tavernDraftPreserved &&= tavernComposer()?.value === tavernDraft;
      modeSwitches.push(await measure(`warm Agent ${attempt}`, modeButton("编程工作台"), () => sessionReady(first)));
      checkReadingState(first);
    }
  } finally {
    observer?.disconnect();
  }

  let olderMessagesError;
  if (checks.historyWindowed) {
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
    documentHidden: document.hidden, longTaskSupported: Boolean(observer),
    sessionSwitches, modeSwitches, checks, olderMessagesError,
  };
}
