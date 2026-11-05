// Loaded only by the private Vite server in harness-desktop-acceptance.mjs.
const endpoint = new URL(".", import.meta.url);
const chiefKey = `${endpoint.pathname}:secretary`;
const keyboardKey = `${endpoint.pathname}:keyboard`;
const browserToolKey = `${endpoint.pathname}:browser-tool`;
const fullBrowserKey = `${endpoint.pathname}:full-browser-tool`;
const outputLinksKey = `${endpoint.pathname}:output-links`;
const dockKey = `${endpoint.pathname}:dock-tools`;
const compactKey = `${endpoint.pathname}:compact`;
const backgroundJobsKey = `${endpoint.pathname}:background-jobs`;
const nativeModesKey = `${endpoint.pathname}:native-modes`;
const savedWorkerInput = "desktop-worker-queue-after-restart";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAK0lEQVR4nGNkaGCgCmCijjEMowYRAUYDmzAYDSPCYDSMCIPRMCIMBl8YAQAWVACw3XqkiQAAAABJRU5ErkJggg==";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const windowsPath = (value) => value.replaceAll("\\", "/").toLowerCase();

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(read, description, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function requestReport(data) {
  const response = await fetch(new URL("report", endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  check(response.ok, "The acceptance report was not saved");
}

const invoke = (command, args = {}) =>
  window.__TAURI_INTERNALS__.invoke(command, args);

async function proveNativePage(url, click, count = 1, requireVisible = false) {
  const response = await fetch(new URL("native-preview-proof", endpoint), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, click, count, requireVisible }),
  });
  if (!response.ok) throw new Error(await response.text());
}

const visibleBrowserPanel = () =>
  document.querySelector('aside[aria-label="运行页面预览"]:not([hidden])');
const browserCalls = [];

async function waitForNativeBrowser() {
  try {
    return await waitFor(() => {
      const panel = visibleBrowserPanel();
      const error = panel?.querySelector('[role="alert"]');
      if (error) throw new Error(error.textContent);
      return panel?.querySelector('[data-preview-carrier="native"][data-native-ready="true"]');
    }, "the live browser sidebar", 20_000);
  } catch (error) {
    const panel = visibleBrowserPanel();
    const stage = panel?.querySelector('[data-preview-carrier="native"]');
    const rect = stage?.getBoundingClientRect();
    const coveredBy = rect && [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + 1, rect.top + 1],
      [rect.right - 1, rect.bottom - 1],
    ].map(([x, y]) => document.elementFromPoint(x, y)?.className?.toString());
    throw new Error(error.message + " " + JSON.stringify({
      viewport: [innerWidth, innerHeight],
      documentHidden: document.hidden,
      nativeReady: stage?.dataset.nativeReady,
      stage: rect?.toJSON(),
      hiddenAncestor: stage?.closest("[hidden],[inert],[aria-hidden=true]")?.className,
      coveredBy,
      panelText: panel?.innerText.slice(-300),
      browserCalls,
    }));
  }
}

async function verifyOutputLinks(fixture) {
  const links = fixture.outputLinks;
  const sessionId = sessionStorage.getItem(outputLinksKey);
  if (!sessionId) {
    await configureFixtureChannel(fixture);
    await invoke("open_agent_project", { path: fixture.project });
    const catalog = await invoke("get_agent_catalog");
    const session = await invoke("create_agent_session", {
      projectPath: fixture.project,
      title: links.title,
      modelId: catalog.defaultModel ?? catalog.models[0].id,
      mode: "build",
    });
    localStorage.setItem("cc-switch-last-view", "agent");
    localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
      projectPath: session.projectPath,
      sessionId: session.id,
    }));
    sessionStorage.setItem(outputLinksKey, session.id);
    return { reload: true };
  }
  await waitFor(() => document.querySelector("#agent-message"), "the output link session");
  const originalFetch = window.fetch;
  window.fetch = function (request, ...args) {
    const call = originalFetch.call(this, request, ...args);
    const command = ["open_agent_browser_preview", "sync_agent_browser_preview_webview"]
      .find((name) => String(request).endsWith("/" + name));
    if (!command) return call;
    const started = performance.now();
    const trace = { command };
    browserCalls.push(trace);
    return call.then((response) => {
      trace.ms = Math.round(performance.now() - started);
      trace.status = response.status;
      return response;
    }, (error) => {
      trace.error = String(error);
      throw error;
    });
  };
  await invoke("send_agent_message", {
    sessionId, text: links.prompt, requestId: "harness-desktop-output-links", locale: "zh",
  });
  const anchor = await waitFor(() =>
    document.querySelector(`a[href="${links.url}"]`), "the assistant's website link");
  check(anchor.textContent.includes(links.label), "The clickable link lost the assistant's label");
  check(!visibleBrowserPanel(), "The assistant reply opened the link without a user click");
  anchor.click();
  const stage = await waitForNativeBrowser();
  check(!stage.querySelector("img"), "The clicked link must use the live native browser");
  await waitFor(() =>
    visibleBrowserPanel()?.querySelector(".wb-preview-filename")?.textContent === links.title,
  "the native output link document title");
  await proveNativePage(links.url, true);

  const file = await waitFor(() =>
    document.querySelector(`button[aria-label="预览文件：${links.file}"]`), "the assistant's project file link");
  file.click();
  await waitFor(() =>
    document.querySelector(`aside[aria-label="文件预览"]:not([hidden]) [data-source-line="${links.fileLine}"]`)?.textContent.includes(links.fileText),
  "the project file and linked source line in the right sidebar");
  check(!visibleBrowserPanel(), "The browser obstructed the selected file preview");

  const addTab = await waitFor(() =>
    document.querySelector('button[aria-label="新建浏览器标签"]'), "the independent browser button");
  addTab.click();
  const navigate = async (url) => {
    const address = await waitFor(() =>
      visibleBrowserPanel()?.querySelector('input[aria-label="网页地址"]:not([readonly])'),
    "an editable browser address");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(address, url);
    address.dispatchEvent(new Event("input", { bubbles: true }));
    visibleBrowserPanel().querySelector('button[aria-label="前往网页地址"]').click();
  };
  const title = () => visibleBrowserPanel()?.querySelector(".wb-preview-filename")?.textContent;
  await navigate(links.secondUrl);
  await waitForNativeBrowser();
  await waitFor(() => title() === links.secondTitle, "the independent tab's document");
  await navigate(links.secondUrl + "?edited=1");
  await waitFor(() => title() === links.editedTitle, "the edited native browser address");
  const back = await waitFor(() =>
    visibleBrowserPanel()?.querySelector('button[aria-label="后退"]:not([disabled])'),
  "native browser history for the edited address");
  back.click();
  await waitFor(() => title() === links.secondTitle, "the original second-tab page after Back");
  const originalTab = await waitFor(() =>
    [...document.querySelectorAll('[role="tablist"][aria-label="右侧栏标签"] [role="tab"]')]
      .find((tab) => tab.textContent.includes(links.title)),
  "the original browser tab");
  originalTab.click();
  await waitFor(() => title() === links.title, "the original browser tab after switching");
  await proveNativePage(links.url, false);
  return { sessionId, nativeOutputLink: true, outputFile: true, nativeBrowserTabs: true };
}

async function verifyDockTools(fixture) {
  const restarted = fixture.phase === "dock-tools-restart";
  const sessionId = restarted ? fixture.dockSessionId : sessionStorage.getItem(dockKey);
  if (!sessionId) {
    await configureFixtureChannel(fixture);
    await invoke("open_agent_project", { path: fixture.project });
    const catalog = await invoke("get_agent_catalog");
    const session = await invoke("create_agent_session", {
      projectPath: fixture.project,
      title: "Dock acceptance",
      modelId: catalog.defaultModel ?? catalog.models[0].id,
      mode: "build",
    });
    localStorage.setItem("cc-switch-last-view", "agent");
    localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
      projectPath: session.projectPath, sessionId: session.id,
    }));
    sessionStorage.setItem(dockKey, session.id);
    return { reload: true };
  }
  const findButton = (label, container = document) =>
    container?.querySelector(`button[aria-label="${label}"]`);
  const namedButton = (label, container = document) =>
    [...(container?.querySelectorAll("button") ?? [])]
      .find((button) => !button.closest("[hidden]") && button.textContent.trim() === label);
  const tablist = (side) => document.querySelector(`[role="tablist"][aria-label="${side}侧分屏标签"]`);
  const tab = (side, title) =>
    [...(tablist(side)?.querySelectorAll('[role="tab"]') ?? [])]
      .find((button) => button.textContent.trim() === title);
  const toolHeader = (side) => tablist(side)?.closest(".wb-preview-tabs");
  const browserIn = (side) => {
    const activeTab = tablist(side)?.querySelector('[aria-selected="true"]');
    return activeTab && document.getElementById(activeTab.getAttribute("aria-controls"))
      ?.querySelector('aside[aria-label="运行页面预览"]:not([hidden])');
  };
  const navigate = async (side, url) => {
    findButton("新建浏览器标签", toolHeader(side)).click();
    const address = await waitFor(() => browserIn(side)?.querySelector('input[aria-label="网页地址"]'),
      side + " browser address");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setValue.call(address, url);
    address.dispatchEvent(new Event("input", { bubbles: true }));
    findButton("前往网页地址", browserIn(side)).click();
  };
  const divider = () => document.querySelector('[role="separator"][aria-label="调整右栏分屏宽度"]');
  const browserAddress = () => visibleBrowserPanel()?.querySelector('input[aria-label="网页地址"]');
  const browserLoads = async () => (await fetch(new URL("browser-page-loads", endpoint))).json();
  const terminal = () => document.querySelector('.wb-preview-dock-pane:not([hidden]) > [aria-label="交互终端"]');
  const terminalState = () => invoke("get_agent_terminal", { sessionId, terminalId: `${sessionId}:terminal` });
  const tree = () => document.querySelector('.wb-preview-dock-pane:not([hidden]) > [aria-label="项目目录"]');
  const fileName = fixture.outputLinks.file.split("/").at(-1);
  const browser = fixture.browserTool;
  const keyDown = (node, key, keyCode) => node.dispatchEvent(new KeyboardEvent("keydown", {
    key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
  const openTool = async (side, title) => {
    const trigger = await waitFor(() => findButton("右栏工具", toolHeader(side)), side + " dock tools");
    trigger.focus();
    keyDown(trigger, "Enter", 13);
    const item = await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent.trim() === title), title + " dock menu item");
    item.click();
  };

  await waitFor(() => document.querySelector("#agent-message"), "the dock session");
  if (restarted) {
    const loads = await browserLoads();
    await waitFor(() => tab("左", "项目目录") && tab("左", fileName) &&
      tab("左", "交互终端")?.getAttribute("aria-selected") === "true" &&
      tab("右", browser.title)?.getAttribute("aria-selected") === "true",
    "both saved dock panes and their active tabs");
    check(divider()?.getAttribute("aria-valuenow") === fixture.dockSplitWidth, "The saved divider width changed");
    await waitFor(() => namedButton("启动终端", terminal())?.disabled === false, "the restored terminal placeholder");
    check(!(await terminalState()).running, "A saved terminal started a process automatically");
    const restore = await waitFor(() => namedButton("恢复页面", visibleBrowserPanel()), "the browser restore action");
    check(browserAddress()?.value === browser.url, "The browser restore lost its address");
    check(await browserLoads() === loads, "Restoring the saved dock navigated the browser automatically");
    restore.click();
    await waitForNativeBrowser();
    await proveNativePage(browser.url, true);
    await navigate("左", browser.nextUrl);
    await waitFor(() => tab("左", browser.nextTitle), "the second browser's native document title");
    const [leftStage, rightStage] = await waitFor(() => {
      const selector = '[data-preview-carrier="native"][data-native-ready="true"]';
      const left = browserIn("左")?.querySelector(selector);
      const right = browserIn("右")?.querySelector(selector);
      return left && right && [left, right];
    }, "two simultaneous live browser views");
    check(leftStage.getBoundingClientRect().right < rightStage.getBoundingClientRect().left,
      "The two live browser views overlap");
    await proveNativePage(browser.nextUrl, true, 1, true);
    await Promise.all([
      proveNativePage(browser.url, false, 1, true),
      proveNativePage(browser.nextUrl, false, 1, true),
    ]);
    findButton("关闭页面预览", browserIn("右")).click();
    await waitFor(() => !tab("右", browser.title), "the explicitly closed browser tab");
    await proveNativePage(browser.nextUrl, false, 1, true);
    const stale = await invoke("open_agent_browser_preview", { sessionId, url: browser.url });
    const bounds = leftStage.getBoundingClientRect();
    const shownAt = Date.now() * 1000 + 1_000_000;
    const beforeStaleShow = await browserLoads();
    try {
      await invoke("sync_agent_browser_preview_webview", {
        sessionId, browserId: stale.browserId, bounds: null, reload: false,
        presentation: { slot: 0, revision: shownAt + 1 },
      });
      await invoke("sync_agent_browser_preview_webview", {
        sessionId, browserId: stale.browserId, reload: false,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        presentation: { slot: 0, revision: shownAt },
      });
      await sleep(800);
      check(await browserLoads() === beforeStaleShow, "An older first show opened a hidden browser");
      await proveNativePage(browser.nextUrl, false, 1, true);
    } finally {
      await invoke("close_agent_browser_preview", { sessionId, browserId: stale.browserId });
    }
    return {
      sessionId, savedDock: true, explicitBrowserRestore: true,
      terminalRestartRequiresStart: true, parallelBrowsers: true, staleBrowserShowIgnored: true,
    };
  }

  const show = await waitFor(() => findButton("预览项目文件"), "the right dock toggle");
  show.click();
  const split = await waitFor(() => findButton("分屏"), "the dock split action");
  split.click();
  await waitFor(() => tablist("左") && tablist("右"), "the two dock panes");
  const beforeResize = divider().getAttribute("aria-valuenow");
  const canGrow = Number(beforeResize) < Number(divider().getAttribute("aria-valuemax"));
  keyDown(divider(), canGrow ? "ArrowRight" : "ArrowLeft", canGrow ? 39 : 37);
  const splitWidth = await waitFor(() => {
    const width = divider()?.getAttribute("aria-valuenow");
    return width && width !== beforeResize && width;
  }, "the resized dock divider");
  await navigate("右", browser.url);
  await waitForNativeBrowser();
  await waitFor(() => tab("右", browser.title), "the browser tab title");
  await proveNativePage(browser.url, true);

  await openTool("左", "项目目录");
  const folder = await waitFor(() => namedButton("docs", tree()), "the project docs folder");
  folder.click();
  const report = await waitFor(() => namedButton(fileName, tree()), "the file in the expanded folder");
  report.click();
  await waitFor(() => document.querySelector('aside[aria-label="文件预览"]:not([hidden])')?.textContent.includes(fixture.outputLinks.fileText),
    "the project file opened in the left pane");
  check(visibleBrowserPanel(), "Opening the project file hid the other browser pane");

  await openTool("左", "交互终端");
  const start = await waitFor(() => {
    const button = namedButton("启动终端", terminal());
    return button && !button.disabled && button;
  }, "the explicit terminal start action");
  check(!(await terminalState()).running, "Opening the terminal tab started the shell");
  start.click();
  const running = await waitFor(async () => {
    const state = await terminalState();
    return state.running && state.data && state;
  }, "the interactive PowerShell prompt", 25_000);
  await waitFor(() => !namedButton("启动中…", terminal()), "the attached terminal input");
  const input = await waitFor(() => terminal()?.querySelector(".xterm-helper-textarea"), "the xterm input");
  const clipboard = new DataTransfer();
  clipboard.setData("text/plain", "Write-Output ('LOLICODE_DOCK_'+'READY')");
  input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  keyDown(input, "Enter", 13);
  await waitFor(async () => {
    const state = await terminalState();
    return state.data.includes("LOLICODE_DOCK_READY");
  }, "the real shell output returned from the terminal UI", 25_000);

  findButton("收起文件预览").click();
  await waitFor(() => !visibleBrowserPanel() && !terminal(), "the folded dock");
  const folded = await terminalState();
  check(folded.running && folded.instance === running.instance, "Folding the right dock killed the shell");
  findButton("预览项目文件").click();
  await waitForNativeBrowser();
  await proveNativePage(browser.url, false);
  findButton("关闭交互终端", terminal()).click();
  await waitFor(async () => !(await terminalState()).running && !tab("左", "交互终端"),
    "the shell being closed explicitly");
  await openTool("左", "交互终端");
  await waitFor(() => namedButton("启动终端", terminal())?.disabled === false, "the idle terminal tab before restart");
  return {
    sessionId, splitWidth, splitDock: true, projectTree: true, interactiveTerminal: true,
    foldRetainsTools: true, terminalClose: true,
  };
}

async function verifyNativeCompaction(fixture) {
  const { compact } = fixture;
  const sessionId = sessionStorage.getItem(compactKey);
  if (!sessionId) {
    await configureFixtureChannel(fixture);
    await invoke("open_agent_project", { path: fixture.project });
    const catalog = await invoke("get_agent_catalog");
    const session = await invoke("create_agent_session", {
      projectPath: fixture.project,
      title: compact.title,
      modelId: catalog.defaultModel ?? catalog.models[0].id,
      mode: "build",
    });
    localStorage.setItem("cc-switch-last-view", "agent");
    localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
      projectPath: session.projectPath,
      sessionId: session.id,
    }));
    sessionStorage.setItem(compactKey, session.id);
    return { reload: true };
  }
  const composer = () => document.querySelector("#agent-message");
  await waitFor(composer, "the compact session composer");
  const read = () => invoke("get_agent_session", { sessionId });
  const send = (requestId, text) => invoke("send_agent_message", {
    sessionId, requestId, text, locale: "zh",
  });
  const hasText = (state, pattern) => state.messages.some((message) =>
    message.role === "assistant" && message.parts.some((part) => pattern.test(part.text ?? "")));
  const settled = (pattern, description) => waitFor(async () => {
    const state = await read();
    if (state.status === "error") throw new Error(state.error || "The compaction fixture failed");
    return state.status === "idle" && hasText(state, pattern) && state;
  }, description);
  const original = `${compact.original}\n${"The acceptance workspace uses amber as its fixture color. ".repeat(80)}`;
  await send("compact-seed", original);
  await settled(/I recorded the fixture color/, "the initial chat turn");

  const input = composer();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "/compact");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => !input.form.querySelector('button[type="submit"]').disabled, "the compact send control");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const result = await settled(/Compacted [1-9]/, "the native compaction receipt");
  const command = result.messages.find((message) =>
    message.role === "user" && message.parts.some((part) => part.text === "/compact"));
  check(command, "The compaction request did not appear in the transcript");
  const receipt = await invoke("query_agent_command", { sessionId, requestId: command.id });
  check(receipt.status === "accepted", "The command did not retain its durable request receipt");
  await waitFor(() => document.querySelector(".wb-chat")?.textContent.includes("Compacted "),
    "the native compact result in the real desktop transcript");
  await send(command.id, "/compact");
  check((await read()).messages.filter(({ id }) => id === command.id).length === 1,
    "Replaying the accepted compact command duplicated the transcript");
  await send("compact-followup", compact.followup);
  await settled(new RegExp(compact.answer), "the follow-up using the compacted context");
  return { sessionId, nativeCompaction: true };
}

async function verifyBackgroundJobs(fixture) {
  const jobs = fixture.backgroundJobs;
  const sessionId = sessionStorage.getItem(backgroundJobsKey);
  if (!sessionId) {
    await configureFixtureChannel(fixture);
    await invoke("open_agent_project", { path: fixture.project });
    const catalog = await invoke("get_agent_catalog");
    const session = await invoke("create_agent_session", {
      projectPath: fixture.project,
      title: "Native background job across turns",
      modelId: catalog.defaultModel ?? catalog.models[0].id,
      mode: "build",
      permissionMode: "full_access",
    });
    localStorage.setItem("cc-switch-last-view", "agent");
    localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
      projectPath: session.projectPath, sessionId: session.id,
    }));
    sessionStorage.setItem(backgroundJobsKey, session.id);
    return { reload: true };
  }
  await waitFor(() => document.querySelector("#agent-message"), "the background job composer");
  const stopButton = () => [...document.querySelectorAll(".wb-queue-recovery button")]
    .find((button) => button.textContent.trim() === "停止后台作业" && !button.disabled);
  const processStatus = async () => (await fetch(new URL("background-process-status", endpoint))).text();
  const send = (requestId, text) => invoke("send_agent_message", { sessionId, requestId, text, locale: "zh" });
  const idle = (text, count) => waitFor(async () => {
    const state = await invoke("get_agent_session", { sessionId });
    if (state.status === "error") throw new Error(state.error || "The background job fixture failed");
    const replied = state.messages.some((message) => message.role === "assistant"
      && message.parts.some((part) => part.text?.includes(text)));
    return state.status === "idle" && (state.backgroundJobs ?? 0) === count && replied && state;
  }, text, 30_000);
  await send("background-start", jobs.start);
  await idle(jobs.started, 1);
  await waitFor(stopButton, "the idle background job stop button");
  await send("background-followup", jobs.next);
  const continued = await idle(jobs.continued, 1);
  check(continued.messages.some(({ id }) => id === "background-followup"), "Missing durable continuation message");
  const release = await fetch(new URL("release-background-job", endpoint), { method: "POST" });
  check(release.ok, "Could not release the fixture job");
  await idle(jobs.woke, 0);
  await waitFor(() => !stopButton(), "the settled job badge to disappear");
  await send("background-cancel", jobs.cancel);
  await idle(jobs.cancelStarted, 1);
  await waitFor(async () => await processStatus() === "running", "the cancellable PowerShell process");
  (await waitFor(stopButton, "the second background job stop button")).click();
  await idle(jobs.cancelStarted, 0);
  await waitFor(async () => await processStatus() === "stopped", "PowerShell process teardown after clicking stop");
  return { backgroundJobs: true, sessionId };
}

async function verifyNativeModes(fixture) {
  const modes = fixture.nativeModes;
  const sessionId = fixture.nativeModesSessionId ?? sessionStorage.getItem(nativeModesKey);
  if (!sessionId) {
    await configureFixtureChannel(fixture);
    await invoke("open_agent_project", { path: fixture.project });
    const catalog = await invoke("get_agent_catalog");
    const session = await invoke("create_agent_session", {
      projectPath: fixture.project,
      title: "Native Goal and Plan acceptance",
      modelId: catalog.defaultModel ?? catalog.models[0].id,
      mode: "build",
      permissionMode: "full_access",
    });
    localStorage.setItem("cc-switch-last-view", "agent");
    localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
      projectPath: session.projectPath, sessionId: session.id,
    }));
    sessionStorage.setItem(nativeModesKey, session.id);
    return { reload: true };
  }
  const button = (text, scope = document) => [...scope.querySelectorAll("button")].find(
    button => button.textContent.trim() === text && !button.disabled,
  );
  const area = () => document.querySelector('[aria-label="Agent 会话模式"]');
  const snapshot = () => invoke("get_agent_session", { sessionId });
  const waitState = (predicate, description) => waitFor(async () => {
    const state = await snapshot();
    if (state.status === "error") throw new Error(state.error || description);
    return predicate(state) && state;
  }, description, 45_000);
  const said = (state, text) => state.messages.some(message => message.role === "assistant" &&
    message.parts.some(part => part.text?.includes(text)));
  const send = (requestId, text) => invoke("send_agent_message", { sessionId, requestId, text, locale: "zh" });
  if (fixture.phase === "native-modes-restart") {
    await waitFor(() => area()?.textContent.includes(modes.goal), "restored Goal summary");
    const state = await snapshot();
    check(state.goal?.phase === "complete" && state.goal.roundsStarted === 2, "Native Goal state was not restored");
    check(state.plan?.active === false && said(state, modes.planText), "Native Plan history was not restored");
    return { sessionId, nativeModesRestored: true };
  }
  const toggle = await waitFor(() => area() && button("计划模式", area()), "native Plan button");
  toggle.click();
  await waitState(state => state.status === "idle" && state.plan?.active === true, "entered native Plan mode");
  await send("native-plan-work", modes.plan);
  const review = (heading) => waitFor(() => {
    const card = document.querySelector('[aria-label="审批实施计划"]');
    return card?.textContent.includes(heading) && card;
  }, heading, 30_000);
  const draft = await review("Initial desktop plan");
  const feedback = draft.querySelector("textarea");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(feedback, modes.feedback);
  feedback.dispatchEvent(new Event("input", { bubbles: true }));
  button("继续规划", draft).click();
  const revised = await review("Revised desktop plan");
  button("批准计划并执行", revised).click();
  await waitState(state => state.status === "idle" && state.plan?.active === false && said(state, modes.planText), "approved implementation");
  await send("native-goal-work", "/goal " + modes.goal);
  await waitState(state => state.status === "idle" && state.goal?.phase === "complete" &&
    state.goal.roundsStarted === 2 && said(state, modes.goalText), "two-round native Goal completion");
  await waitFor(() => area()?.textContent.includes("已完成"), "completed Goal on the composer");
  return { sessionId, nativePlan: true, nativeGoal: true };
}

async function verifyBrowserTool(fixture) {
  const tool = fixture.browserTool;
  const fullSessionId = sessionStorage.getItem(fullBrowserKey);
  if (fullSessionId) return verifyFullBrowserTool(fullSessionId, tool);
  const sessionId = sessionStorage.getItem(browserToolKey);
  if (!sessionId) {
    await invoke("open_agent_project", { path: fixture.project });
    const catalog = await invoke("get_agent_catalog");
    const session = await invoke("create_agent_session", {
      projectPath: fixture.project,
      title: tool.title,
      modelId: catalog.defaultModel ?? catalog.models[0].id,
      mode: "build",
      permissionMode: "ask",
    });
    localStorage.setItem("cc-switch-last-view", "agent");
    localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
      projectPath: session.projectPath,
      sessionId: session.id,
    }));
    sessionStorage.setItem(browserToolKey, session.id);
    return { reload: true };
  }
  await waitFor(() => document.querySelector("#agent-message"), "the browser tool session composer");
  const snapshot = () => invoke("get_agent_session", { sessionId });
  const waitForState = (predicate, description) => waitFor(async () => {
    const state = await snapshot();
    if (state.status === "error" || state.error) throw new Error(state.error || "The browser tool run failed");
    return predicate(state) && state;
  }, description, 45_000);
  const send = (stage) => invoke("send_agent_message", {
    sessionId,
    text: tool[`${stage}Prompt`],
    requestId: `harness-desktop-browser-tool-${stage}`,
    locale: "zh",
  });
  const finished = (stage) => waitForState((state) =>
    state.status === "idle" && !state.streamConnected &&
    state.messages.some((message) => message.role === "assistant" &&
      message.parts.some((part) => part.type === "text" && part.text === tool[stage])),
  `the browser tool ${stage} response`);
  const approve = async (name) => {
    const state = await waitForState((value) =>
      value.permissions.some((permission) => permission.toolName === name),
    `frontend approval for ${name}`);
    const permission = state.permissions.find((item) => item.toolName === name);
    check(permission.approvalMode === "user-once", "Browser actions must require one-shot approval");
    const button = await waitFor(() => document.querySelector(".wb-permission-allow:not(:disabled)"),
      `the allow-once button for ${name}`);
    button.click();
  };

  await send("open");
  check(!(await snapshot()).preview, "The browser opened without approval");
  await approve("browser_open");
  const opened = await finished("opened");
  check(opened.preview?.kind === "browser" && opened.preview.url === tool.url && opened.preview.native,
    "The approved browser tool did not publish its native page");
  const stage = await waitForNativeBrowser();
  const toolbar = (name) => visibleBrowserPanel()?.querySelector(`button[aria-label="${name}"]`);
  const waitForAddress = (url, title) => waitFor(() => {
    const panel = visibleBrowserPanel();
    return panel?.querySelector('input[aria-label="网页地址"]')?.value === url &&
      panel?.querySelector(".wb-preview-filename")?.textContent === title;
  }, `the observed native address and title for ${title}`, 20_000);
  await waitForAddress(tool.url, tool.title);
  check(!stage.querySelector("img"), "The browser tool must not use the screenshot carrier");
  await proveNativePage(tool.url, true);

  document.querySelector('button[aria-label="收起文件预览"]').click();
  await waitFor(() => stage.closest("aside").hidden, "the browser tool sidebar folded");
  document.querySelector('button[aria-label="预览项目文件"]').click();
  await waitForNativeBrowser();
  await proveNativePage(tool.url, false);

  await send("inspect");
  await approve("browser_action");
  await finished("inspected");
  await proveNativePage(tool.url, false, 2);
  await send("navigate");
  await approve("browser_action");
  await finished("navigated");
  await waitForAddress(tool.nextUrl, tool.nextTitle);
  const back = await waitFor(() => {
    const button = toolbar("后退");
    return button && !button.disabled && button;
  }, "the native browser Back button to become available", 20_000);
  back.click();
  await waitForAddress(tool.url, tool.title);
  const forward = await waitFor(() => {
    const button = toolbar("前进");
    return button && !button.disabled && button;
  }, "the native browser Forward button to become available", 20_000);
  forward.click();
  await waitForAddress(tool.nextUrl, tool.nextTitle);
  const nextLoads = async () => (await fetch(new URL("browser-next-loads", endpoint))).json();
  const before = await nextLoads();
  toolbar("重新加载网页").click();
  await waitFor(async () => await nextLoads() > before, "the native browser reloaded the observed page", 20_000);
  visibleBrowserPanel().querySelector('button[aria-label="关闭页面预览"]').click();
  await waitFor(() => !stage.isConnected && !visibleBrowserPanel(), "the browser tool tab closed");
  await send("closed");
  await finished("closed");
  await send("reopen");
  await approve("browser_open");
  const reopened = await finished("reopened");
  check(reopened.preview?.browserId && reopened.preview.browserId !== opened.preview.browserId,
    "Reopening must create a fresh native browser session");
  const reopenedStage = await waitForNativeBrowser();
  await send("closeFromTool");
  const closed = await finished("closeFromTool");
  check(!closed.preview, "The model closed its browser but kept a stale preview");
  await waitFor(() => !reopenedStage.isConnected && !visibleBrowserPanel(), "the model-closed browser tab");
  const catalog = await invoke("get_agent_catalog");
  const full = await invoke("create_agent_session", {
    projectPath: fixture.project,
    title: tool.fullTitle,
    modelId: catalog.defaultModel ?? catalog.models[0].id,
    mode: "build",
  });
  check(full.permissionMode === "full_access", "A new local session must default to Full access");
  localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
    projectPath: full.projectPath,
    sessionId: full.id,
  }));
  sessionStorage.setItem(fullBrowserKey, full.id);
  return { reload: true };
}

async function verifyFullBrowserTool(sessionId, tool) {
  const snapshot = () => invoke("get_agent_session", { sessionId });
  check((await snapshot()).session.permissionMode === "full_access", "The default Full access selection was not restored");
  await waitFor(() => document.querySelector("#agent-message"), "the full-access browser tool composer");
  await invoke("send_agent_message", {
    sessionId, text: tool.fullPrompt, requestId: "harness-desktop-browser-full-access", locale: "zh",
  });
  const waitWithoutApproval = (predicate, description) => waitFor(async () => {
    const state = await snapshot();
    check(state.status !== "waiting_permission" && !state.permissions.length &&
      !document.querySelector(".wb-permission-allow:not(:disabled)"),
    "Full access displayed a tool approval");
    if (state.status === "error" || state.error) throw new Error(state.error || "The full-access browser run failed");
    return predicate(state) && state;
  }, description, 45_000);
  const waiting = await waitWithoutApproval((state) => state.questions.length === 1,
    "the model's genuine question in Full access");
  check(waiting.status === "waiting_question" && waiting.preview?.native &&
    waiting.questions[0].fields[0].title === tool.fullQuestion, "Full access must keep the question and the live preview");
  const stage = await waitForNativeBrowser();
  document.querySelector('button[aria-label="收起文件预览"]').click();
  await waitFor(() => stage.closest("aside").hidden, "the full-access browser folded before the next tool action");
  const choice = await waitFor(() =>
    document.querySelector(`.agent-question-card button[aria-label="${tool.fullAnswer}"]`), "the answer choice");
  choice.click();
  await waitFor(() => choice.getAttribute("aria-pressed") === "true", "the selected answer");
  document.querySelector('.agent-question-card button[type="submit"]').click();
  await waitWithoutApproval((state) =>
    state.status === "idle" && !state.questions.length &&
    state.messages.some((message) => message.role === "assistant" &&
      message.parts.some((part) => part.type === "text" && part.text === tool.fullCompleted)),
  "the Full access run to finish after a real answer");
  document.querySelector('button[aria-label="预览项目文件"]').click();
  await waitForNativeBrowser();
  visibleBrowserPanel().querySelector('button[aria-label="关闭页面预览"]').click();
  await waitFor(() => !stage.isConnected && !visibleBrowserPanel(), "the full-access browser tab closed");
  return { sessionId, nativeBrowserTool: true, nativeBrowserHistory: true, fullAccessQuestion: true };
}

async function verifyWorkspaceSwitch(fixture, firstSessionId) {
  const { first, second } = fixture.workspaceSwitch;
  const getSession = (sessionId) => invoke("get_agent_session", { sessionId });
  const waitForSession = (sessionId, predicate, description) =>
    waitFor(async () => {
      const state = await getSession(sessionId);
      if (state.status === "error" || state.error)
        throw new Error(state.error || `Workspace task failed: ${description}`);
      return predicate(state) && state;
    }, description);
  const send = (sessionId, requestId, turn) =>
    invoke("send_agent_message", {
      sessionId,
      requestId,
      text: turn.prompt,
      locale: "zh",
    });
  const pendingWrite = async (sessionId, description) => {
    const state = await waitForSession(
      sessionId,
      (state) =>
        state.status === "waiting_permission" && state.permissions.length === 1,
      description,
    );
    const [permission] = state.permissions;
    check(
      permission.toolName === "write" && permission.approvalMode === "user-once",
      `Expected a workspace-scoped write approval for ${description}`,
    );
    return permission.id;
  };
  const approve = (sessionId, requestId) =>
    invoke("reply_agent_permission", { sessionId, requestId, decision: "once" });
  const finish = (sessionId, requestId, turn, description) =>
    waitForSession(
      sessionId,
      (state) =>
        state.status === "idle" &&
        !state.streamConnected &&
        state.messages.some(
          (message) => message.role === "user" && message.id === requestId,
        ) &&
        state.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.parts.some(
              (part) => part.type === "text" && part.text === turn.answer,
            ),
        ),
      description,
    );

  const firstRequestId = "harness-desktop-workspace-first";
  await send(firstSessionId, firstRequestId, first);
  const firstApproval = await pendingWrite(
    firstSessionId,
    "the original workspace approval",
  );

  const opened = await invoke("open_agent_project", { path: fixture.otherProject });
  check(
    windowsPath(opened.workspace.path) === windowsPath(fixture.otherProject),
    "An active task blocked selection of the second workspace",
  );
  const catalog = await invoke("get_agent_catalog");
  const secondSession = await invoke("create_agent_session", {
    projectPath: fixture.otherProject,
    title: "Second concurrent Harness workspace",
    modelId: catalog.defaultModel ?? catalog.models[0].id,
    mode: "build",
    permissionMode: "ask",
  });
  check(
    secondSession.id !== firstSessionId &&
      windowsPath(secondSession.projectPath) === windowsPath(fixture.otherProject),
    "Second workspace created a session in the wrong project",
  );
  const secondRequestId = "harness-desktop-workspace-second";
  await send(secondSession.id, secondRequestId, second);
  await approve(
    secondSession.id,
    await pendingWrite(secondSession.id, "the second workspace approval"),
  );
  await finish(
    secondSession.id,
    secondRequestId,
    second,
    "second workspace completion",
  );

  const waiting = await getSession(firstSessionId);
  check(
    waiting.status === "waiting_permission" &&
      waiting.permissions.some(({ id }) => id === firstApproval),
    "The original workspace lost its pending approval while the second workspace ran",
  );
  await approve(firstSessionId, firstApproval);
  const completed = await finish(
    firstSessionId,
    firstRequestId,
    first,
    "original workspace completion",
  );
  check(
    windowsPath(completed.session.projectPath) === windowsPath(fixture.project),
    "Original session changed its project while completing in the background",
  );
  const selected = await invoke("get_agent_status");
  check(
    windowsPath(selected.projectPath) === windowsPath(fixture.otherProject),
    "Finishing the original task changed the selected workspace",
  );

  const restored = await invoke("open_agent_project", { path: fixture.project });
  check(
    restored.sessions.some(({ id }) => id === firstSessionId),
    "Returning to the original workspace lost its completed session",
  );
}

async function keyboardSteering({ sessionId, keyboardSessionId }, fixture) {
  const { keyboard } = fixture;
  const composer = () => document.querySelector("textarea#agent-message");
  await waitFor(
    () => document.querySelector(".wb-titlebar h1")?.textContent === keyboard.title && composer(),
    "the real Agent workbench on the keyboard test session",
    30_000,
  );
  const setInput = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  const submit = async (text, ctrlKey = false) => {
    const input = composer();
    setInput.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => !input.form.querySelector('button[type="submit"]').disabled, "an enabled Agent composer");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey, bubbles: true, cancelable: true }));
  };
  const chatViewport = () => document.querySelector(".wb-chat");
  const chat = () => chatViewport()?.textContent || "";
  const atChatTail = () => {
    const scroll = chatViewport();
    return scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2;
  };
  await submit(keyboard.scrollPrimer);
  await waitFor(async () => {
    const state = await invoke("get_agent_session", { sessionId: keyboardSessionId });
    return state.status === "idle" && chat().includes("Historical paragraph 65") &&
      chatViewport().scrollHeight - chatViewport().clientHeight > 96;
  }, "a scrollable workbench conversation");
  const readOlderMessages = async () => {
    chatViewport().scrollTop = 0;
    await waitFor(() => document.querySelector(".wb-scroll-latest") && !atChatTail(),
      "the reader scrolled away from the current conversation tail");
  };
  await readOlderMessages();
  await submit(keyboard.start);
  await waitFor(() => chat().includes(keyboard.start) && atChatTail(),
    "send follows its new bubble to the actual WebView bottom");
  const prefix = keyboard.first.slice(0, Math.floor(keyboard.first.length / 2));
  await waitFor(() => chat().includes(prefix), "the first chunk of the in-flight response");
  const switchWorkspace = async (path) => {
    const button = await waitFor(() => Array.from(
      document.querySelectorAll("button.wb-workspace-project"),
    ).find((entry) => !entry.disabled && windowsPath(entry.title) === windowsPath(path)), "a clickable workspace in the real sidebar");
    button.click();
    await waitFor(async () => {
      const status = await invoke("get_agent_status");
      return status.projectPath && windowsPath(status.projectPath) === windowsPath(path);
    }, "the real sidebar workspace switch");
  };
  await switchWorkspace(fixture.otherProject);
  check((await invoke("get_agent_session", { sessionId: keyboardSessionId })).status === "running",
    "The original response stopped when changing workspaces in the sidebar");
  await switchWorkspace(fixture.project);
  await waitFor(() => document.querySelector(".wb-titlebar h1")?.textContent === keyboard.title && chat().includes(prefix),
    "the original streaming conversation after returning to its workspace");
  await readOlderMessages();
  await submit(keyboard.insert, true);
  await waitFor(() => chat().includes(keyboard.insert) && composer()?.value === "" && atChatTail(), "the acknowledged steering bubble at the actual WebView bottom");
  const release = await fetch(new URL("release-keyboard-reply", endpoint), { method: "POST" });
  check(release.ok, "The original reply must still be waiting for release");
  await waitFor(async () => {
    const snapshot = await invoke("get_agent_session", { sessionId: keyboardSessionId });
    if (snapshot.status === "error") throw new Error(snapshot.error || "Keyboard steering failed");
    return snapshot.status === "idle" && chat().includes(keyboard.first) && chat().includes(keyboard.next);
  }, "both completed answers in the same workbench conversation");
  return { sessionId, keyboardSteering: true, sendScrollFollow: true };
}

async function verifyWorkerQueue(chiefId, task, fixture) {
  const { workerQueue } = fixture;
  const sessionId = task.sessionId;
  const snapshot = () => invoke("get_agent_session", { sessionId });
  await invoke("send_agent_secretary_task_message", {
    sessionId: chiefId,
    taskId: task.id,
    text: workerQueue.start,
    requestId: "desktop-worker-queue-start",
    locale: "zh",
  });
  await waitFor(async () => {
    const state = await snapshot();
    if (state.status === "error") throw new Error(state.error || "Child queue setup failed");
    return state.status === "running" &&
      (await fetch(new URL("worker-reply-ready", endpoint))).ok;
  }, "a streaming child ready for its own queue");
  const requestId = (action) => `desktop-worker-queue-${action}`;
  const enqueue = async (action, attachments) => {
    const receipt = await invoke("enqueue_agent_message", {
      sessionId, text: workerQueue[action], requestId: requestId(action), locale: "zh", attachments,
    });
    check(receipt.status === "accepted", receipt.message || `Child enqueue rejected: ${action}`);
  };
  const image = { ref: `data:image/png;base64,${png}`, fileName: "recalled.png", mime: "image/png", bytes: atob(png).length };
  await enqueue("later");
  await enqueue("later");
  await enqueue("insert");
  await enqueue("remove", [image]);
  const ids = (state) => state.queuedMessages?.map((item) => item.id).join(",");
  check(ids(await snapshot()) === ["later", "insert", "remove"].map(requestId).join(","), "Child did not own the FIFO queue");
  const root = await invoke("get_agent_session", { sessionId: chiefId });
  check(!root.queuedMessages?.some(({ id }) => id.startsWith("desktop-worker-queue-")), "Child queue leaked into the secretary");
  const recalled = await invoke("remove_queued_agent_message", { sessionId, requestId: requestId("remove") });
  check(recalled.requestId === requestId("remove") && recalled.text === workerQueue.remove && recalled.attachments[0]?.ref === image.ref,
    "Child recall did not return the original request and image");
  await invoke("send_queued_agent_message_now", { sessionId, requestId: requestId("insert"), steerOnly: true });
  const release = await fetch(new URL("release-worker-reply", endpoint), { method: "POST" });
  check(release.ok, "The original child reply must still be active");
  await waitFor(async () => {
    const state = await snapshot();
    if (state.status === "error") throw new Error(state.error || "Child queue failed");
    const messages = state.messages;
    const hasAnswer = (answer) => messages.some((message) => message.role === "assistant" && message.parts.some((part) => part.text === answer));
    if (!hasAnswer(workerQueue.finished) || state.status !== "idle") return false;
    const userIds = messages.filter((message) => message.role === "user").map((message) => message.id);
    check(hasAnswer(workerQueue.first) && hasAnswer(workerQueue.inserted) && !ids(state), "Child queue did not settle in order");
    check(userIds.includes(requestId("insert")) && userIds.includes(requestId("later")) && !userIds.includes(requestId("remove")), "Child transcript lost queue request identity");
    return true;
  }, "the child's inserted and ordinary queued messages completing in order");
}

async function configureFixtureChannel(fixture) {
  const proxy = await invoke("get_proxy_config");
  await invoke("update_proxy_config", {
    config: {
      ...proxy,
      listen_address: "127.0.0.1",
      listen_port: fixture.proxyPort,
      enable_logging: false,
    },
  });
  const catalog = await invoke("get_channel_center");
  check(
    catalog.channels.length === 0,
    "Refusing to use an existing model channel",
  );
  await invoke("save_channel_center", {
    snapshot: {
      ...catalog,
      targets: [],
      channels: [
        {
          id: "harness-desktop-fixture",
          name: "Harness Desktop Fixture",
          baseUrl: `http://127.0.0.1:${fixture.modelPort}/v1`,
          apiKey: fixture.fixtureKey,
          authKind: "api_key",
          protocol: "openai_chat",
          enabled: true,
          models: [
            {
              id: fixture.model,
              name: "Fixture Vision",
              enabled: true,
              supportsTools: true,
              contextLimit: 65_536,
            },
          ],
        },
      ],
      defaultModel: `harness-desktop-fixture/${fixture.model}`,
    },
  });
}

async function run(fixture) {
  check(
    location.origin === fixture.origin,
    "Unexpected development renderer origin",
  );
  await waitFor(
    () => Boolean(window.__TAURI_INTERNALS__?.invoke),
    "native Tauri IPC",
  );
  const build = await invoke("get_build_info");
  check(
    build.channel === "development",
    "Refusing to use a non-development app",
  );
  check(
    windowsPath(build.dataDirectory) === windowsPath(fixture.profile),
    "Refusing to use a non-fixture profile",
  );
  check(
    !(await invoke("plugin:window|is_visible", { label: "main" })),
    "Expected the isolated native window to be hidden",
  );
  const engine = await invoke("get_agent_status");
  check(engine.available, "The compiled desktop rejected the bundled Harness runtime");
  if (fixture.harnessVersion) {
    check(
      engine.version === "deepseek-harness-" + fixture.harnessVersion,
      "The desktop reports a Harness version different from the pinned package",
    );
  }
  const tray = await invoke("plugin:tray|get_by_id", { id: "lolicode" }).catch(() => null);
  if (tray !== null)
    await invoke("plugin:tray|set_visible", { rid: tray, visible: false }).catch(() => {});
  if (fixture.phase === "output-links") return verifyOutputLinks(fixture);
  if (fixture.phase === "dock-tools" || fixture.phase === "dock-tools-restart")
    return verifyDockTools(fixture);
  if (fixture.phase === "compact") return verifyNativeCompaction(fixture);
  if (fixture.phase === "background-jobs") return verifyBackgroundJobs(fixture);
  if (fixture.phase === "native-modes" || fixture.phase === "native-modes-restart")
    return verifyNativeModes(fixture);
  if (fixture.phase === "browser-tool") {
    if (fixture.permissionsOnly && !sessionStorage.getItem(browserToolKey))
      await configureFixtureChannel(fixture);
    return verifyBrowserTool(fixture);
  }

  if (fixture.phase === "worker-queue-restart") {
    await invoke("open_agent_project", { path: fixture.project });
    const sessionId = fixture.workerQueueSessionId;
    const read = () => invoke("get_agent_session", { sessionId });
    const saved = await read();
    check(saved.queuePaused && saved.queuedMessages.some(({ id }) => id === savedWorkerInput),
      "The worker did not restore its own paused queue after restarting the app");
    await invoke("send_queued_agent_message_now", { sessionId, requestId: savedWorkerInput });
    await waitFor(async () => {
      const state = await read();
      if (state.status === "error") throw new Error(state.error || "The saved worker queue failed to resume");
      return state.status === "idle" && !state.queuedMessages?.length &&
        state.messages.some((message) => message.role === "user" && message.id === savedWorkerInput) &&
        state.messages.some((message) => message.role === "assistant" && message.parts.some((part) => part.text === fixture.workerQueue.resumed));
    }, "the saved worker queue resuming with the original message ID");
    return { sessionId, workerQueueRestart: true };
  }

  let sessionId;
  if (fixture.phase === "initial") {
    const keyboardSetup = sessionStorage.getItem(keyboardKey);
    if (keyboardSetup) return keyboardSteering(JSON.parse(keyboardSetup), fixture);
    await configureFixtureChannel(fixture);
    const opened = await invoke("open_agent_project", {
      path: fixture.project,
    });
    check(
      windowsPath(opened.workspace.path) === windowsPath(fixture.project),
      "Unexpected workspace",
    );
    check(opened.sessions.length === 0, "Refusing to use existing chats");
    const models = await invoke("get_agent_catalog");
    const session = await invoke("create_agent_session", {
      projectPath: fixture.project,
      title: "DeepSeek Harness desktop acceptance",
      modelId: models.defaultModel ?? models.models[0].id,
      mode: "build",
      permissionMode: "ask",
    });
    sessionId = session.id;
  } else if (fixture.phase === "restart") {
    const opened = await invoke("open_agent_project", {
      path: fixture.project,
    });
    check(
      opened.sessions.some((session) => session.id === fixture.sessionId),
      "The previous session was not listed after restart",
    );
    sessionId = fixture.sessionId;
  } else throw new Error("Unknown fixture phase");

  const snapshot = () => invoke("get_agent_session", { sessionId });
  const hasAnswer = (state, text) =>
    state.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some(
          (part) => part.type === "text" && part.text === text,
        ),
    );
  async function waitForState(test, description) {
    return waitFor(async () => {
      const state = await snapshot();
      if (state.status === "error" || state.error)
        throw new Error(state.error || "The Agent returned an error");
      return test(state) && state;
    }, description);
  }
  async function send(stage, attachments) {
    await invoke("send_agent_message", {
      sessionId,
      text: fixture.prompt[stage],
      requestId: `harness-desktop-${stage}`,
      locale: "zh",
      attachments,
    });
  }
  async function decide(decision) {
    const state = await waitForState(
      (value) => value.permissions.length === 1,
      `one approval for ${decision}`,
    );
    const permission = state.permissions[0];
    check(
      permission.toolName === "write" &&
        permission.approvalMode === "user-once",
      "Expected one-shot approval for the upstream write tool",
    );
    await invoke("reply_agent_permission", {
      sessionId,
      requestId: permission.id,
      decision,
    });
  }
  const completed = (stage) =>
    waitForState(
      (state) =>
        state.status === "idle" &&
        state.streamConnected === false &&
        hasAnswer(state, fixture.answers[stage]),
      `completed Harness ${stage} answer`,
    );

  if (fixture.phase === "initial") {
    const answer = fixture.answers.approve;
    const firstChunk = answer.slice(0, Math.floor(answer.length / 2));
    let streamed = false;
    await invoke("plugin:event|listen", {
      event: "agent-session-update",
      target: { kind: "AnyLabel", label: "main" },
      handler: window.__TAURI_INTERNALS__.transformCallback(({ payload }) => {
        if (
          payload?.type === "tail" &&
          payload.sessionId === sessionId &&
          payload.message.parts.some((part) => part.text === firstChunk)
        ) streamed = true;
      }),
    });
    await send("approve", [
      {
        ref: `data:image/png;base64,${png}`,
        fileName: "fixture.png",
        mime: "image/png",
        bytes: atob(png).length,
      },
    ]);
    await decide("once");
    await waitFor(() => streamed, "the partial answer over native streaming", 20_000);
    await completed("approve");
    await send("reject");
    await decide("reject");
    await completed("reject");
    let staleSteer;
    try {
      await invoke("send_queued_agent_message_now", {
        sessionId,
        requestId: "harness-desktop-stale-steer",
        steerOnly: true,
      });
    } catch (error) {
      staleSteer = error;
    }
    check(
      String(staleSteer).includes("当前任务已经结束"),
      "An explicit steering request cannot resume a finished turn",
    );
    await verifyWorkspaceSwitch(fixture, sessionId);
    const catalog = await invoke("get_agent_catalog");
    const keyboardSession = await invoke("create_agent_session", {
      projectPath: fixture.project,
      title: fixture.keyboard.title,
      modelId: catalog.defaultModel ?? catalog.models[0].id,
      mode: "build",
      permissionMode: "ask",
    });
    localStorage.setItem("cc-switch-last-view", "agent");
    localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
      projectPath: keyboardSession.projectPath,
      sessionId: keyboardSession.id,
    }));
    sessionStorage.setItem(keyboardKey, JSON.stringify({ sessionId, keyboardSessionId: keyboardSession.id }));
    return { reload: true };
  } else {
    const previous = await snapshot();
    check(
      hasAnswer(previous, fixture.answers.approve) &&
        hasAnswer(previous, fixture.answers.reject),
      "The desktop did not restore both assistant answers",
    );
    const chiefId = sessionStorage.getItem(chiefKey);
    if (!chiefId) {
      await send("resume");
      await completed("resume");
      const catalog = await invoke("get_agent_catalog");
      const modelId = catalog.defaultModel ?? catalog.models[0].id;
      const freshChief = await invoke("open_agent_secretary", {
        projectPath: fixture.otherProject,
        modelId,
        locale: "zh",
      });
      check(
        freshChief.coordination?.role === "secretary" && freshChief.permissionMode === "full_access",
        "A new local secretary must default to Full access",
      );
      const chief = await invoke("open_agent_secretary", {
        projectPath: fixture.project,
        modelId,
        locale: "zh",
      });
      check(
        chief.coordination?.role === "secretary" &&
        chief.id === fixture.workerFollowup.legacyParent &&
        chief.permissionMode === "ask",
        "The workbench did not preserve the migrated secretary's explicit approval mode",
      );
      const configuredChief = await invoke("update_agent_session", {
        sessionId: chief.id,
        permissionMode: "auto",
      });
      check(configuredChief.permissionMode === "auto", "The secretary did not keep the selected approval mode");
      sessionStorage.setItem(chiefKey, chief.id);
      return { reload: true };
    }
    await waitFor(
      () =>
        document.querySelector("#agent-message") &&
        document.querySelector("main")?.innerText.includes("Loli 秘书"),
      "the normal secretary composer",
    );
    const secretaryButton = await waitFor(() => {
      const button = document.querySelector("button.wb-nav-secretary");
      return button && !button.disabled && button;
    }, "the secretary navigation button");
    if (secretaryButton.getAttribute("aria-pressed") !== "true") secretaryButton.click();
    await waitFor(
      () => document.querySelector('button.wb-nav-secretary[aria-pressed="true"]') && document.querySelector("#agent-message"),
      "the old secretary selected in the real workbench",
    );
    await invoke("send_agent_message", {
      sessionId: chiefId,
      text: fixture.website.goal,
      requestId: "harness-desktop-secretary-website",
      locale: "zh",
    });
    const task = await waitFor(
      async () => {
        const root = await invoke("get_agent_session", { sessionId: chiefId });
        if (root.status === "error" || root.error) throw new Error(root.error || "Secretary run failed");
        const state = await invoke("get_agent_secretary", {
          sessionId: chiefId,
        });
        const candidate = state.tasks.find(
          (item) => item.title === fixture.website.title,
        );
        if (!candidate) return;
        if (["failed", "cancelled", "interrupted"].includes(candidate.status))
          throw new Error(
            candidate.error || `Website worker ended ${candidate.status}`,
          );
        return candidate.status === "completed" && candidate;
      },
      "the delegated website task",
      180_000,
    );
    check(
      task.id.startsWith("harness-"),
      "The task is not a real Harness worker",
    );
    check(task.report?.state === "ready" && task.report.summary.includes("等待验收"), "The worker's structured report did not reach the secretary");
    const preview = await waitFor(async () => {
      const state = await invoke("get_agent_session", { sessionId: chiefId });
      if (state.error) throw new Error(state.error);
      return (
        state.status === "idle" &&
        state.preview?.kind === "browser" &&
        state.preview
      );
    }, "secretary's completed live preview");
    check(
      preview.sessionId === task.sessionId,
      "The live preview was not owned by the delegated worker",
    );
    const previewPanel = () => document.querySelector('aside[aria-label="运行页面预览"]:not([hidden])');
    const nativeStage = () => previewPanel()?.querySelector('[data-preview-carrier="native"][data-native-ready="true"]');
    let stage;
    try {
      stage = await waitFor(() => {
        const error = previewPanel()?.querySelector('[role="alert"]');
        if (error) throw new Error(error.textContent);
        return nativeStage();
      }, "the automatic native browser in the right sidebar", 20_000);
    } catch (error) {
      const panel = previewPanel();
      const body = panel?.querySelector(".wb-browser-preview-stage");
      const rect = body?.getBoundingClientRect();
      const hit = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const modal = document.querySelector("[aria-modal='true'], [role='dialog'][data-state='open']");
      throw new Error(`${error.message}; native=${body?.dataset.previewCarrier}, hidden=${document.hidden}, rect=${JSON.stringify(rect?.toJSON())}, hit=${hit?.className}, modal=${modal?.querySelector("h2")?.textContent ?? Boolean(modal)}`);
    }
    check(!stage.querySelector("img"), "A delivered page must not use the old screenshot carrier");
    await proveNativePage(preview.url, true, 1, true);
    document.querySelector('button[aria-label="收起文件预览"]').click();
    await waitFor(() => stage.closest("aside").hidden, "the native preview folded");
    document.querySelector('button[aria-label="预览项目文件"]').click();
    await waitFor(() => !stage.closest("aside").hidden && nativeStage(), "the native preview unfolded");
    await proveNativePage(preview.url, false, 1, true);
    previewPanel().querySelector('button[aria-label="关闭页面预览"]').click();
    await waitFor(() => !stage.isConnected && !previewPanel(), "the delivered native preview closed explicitly");
    const automation = (method, args) => invoke("invoke_agent_automation", { method, args });
    const catalog = await invoke("get_agent_catalog");
    const selected = catalog.models.find((model) => model.id === catalog.defaultModel) ?? catalog.models[0];
    const scope = { workspacePath: fixture.project };
    const job = await automation("create", [{
      ...scope, title: "Harness automation fixture", prompt: "HARNESS_DESKTOP_AUTOMATION",
      trigger: "schedule", cronExpr: "18 6 * * *", mode: "build", recurring: false,
      modelSelection: { providerId: selected.providerId, modelId: selected.modelId },
    }]);
    await automation("runNow", [job.automationId, scope]);
    const background = await waitFor(async () => {
      const [run] = await automation("listRuns", [job.automationId, scope]);
      if (run?.outcome === "failed") throw new Error(run.error || "Harness automation failed");
      if (!run?.sessionId) return;
      const snapshot = await invoke("get_agent_session", { sessionId: run.sessionId });
      return snapshot.permissions.length === 1 && { run, permission: snapshot.permissions[0] };
    }, "automatic session's scoped write approval");
    check(background.permission.toolName === "write", "Expected Harness write approval for automatic execution");
    await invoke("reply_agent_permission", {
      sessionId: background.run.sessionId, requestId: background.permission.id, decision: "once",
    });
    await waitFor(async () => {
      const [run] = await automation("listRuns", [job.automationId, scope]);
      if (run?.outcome === "failed") throw new Error(run.error || "Harness automation failed");
      return run?.outcome === "succeeded";
    }, "completed automation receipt");

    const manual = fixture.workerFollowup;
    const manualArgs = {
      sessionId: chiefId, title: manual.title, instructions: manual.task,
      requestId: "desktop-manual-worker", executionMode: "worktree", locale: "zh",
    };
    const manualTask = await invoke("delegate_agent_secretary_task", manualArgs);
    check(manualTask.id.startsWith("harness-") && manualTask.worktree?.path, "Manual delegate did not create a native Harness worker in an isolated worktree");
    async function waitForWorker(parentId, taskId, childId, answer) {
      return waitFor(async () => {
        const state = await invoke("get_agent_secretary", { sessionId: parentId });
        const tasks = state.tasks.filter((entry) => entry.id === taskId);
        check(tasks.length === 1 && tasks[0].sessionId === childId, "Worker identity changed or was duplicated");
        if (["failed", "cancelled", "interrupted"].includes(tasks[0].status)) {
          throw new Error(tasks[0].error || `Worker ended ${tasks[0].status}`);
        }
        if (tasks[0].status !== "completed") return;
        const chat = await invoke("get_agent_session", { sessionId: childId });
        return hasAnswer(chat, answer) && chat;
      }, "the completed worker response", 180_000);
    }
    await waitForWorker(chiefId, manualTask.id, manualTask.sessionId, manual.firstAnswer);
    check((await invoke("delegate_agent_secretary_task", manualArgs)).id === manualTask.id, "Manual retry allocated a second task");
    await waitFor(async () => (await invoke("get_agent_session", { sessionId: chiefId })).status === "idle", "manual secretary idle before cold resume");
    const followup = await invoke("send_agent_secretary_task_message", {
      sessionId: chiefId, taskId: manualTask.id, text: manual.followup,
      requestId: "desktop-manual-worker-followup", locale: "zh",
    });
    check(followup.id === manualTask.id && followup.sessionId === manualTask.sessionId, "Follow-up changed the worker identity");
    const continued = await waitForWorker(chiefId, manualTask.id, manualTask.sessionId, manual.secondAnswer);
    check(hasAnswer(continued, manual.firstAnswer), "Follow-up replaced the original worker transcript");
    await verifyWorkerQueue(chiefId, manualTask, fixture);
    // A terminal child is visible before the parent has finished closing its
    // SDK transport. Send the next worker instruction without waiting for root idle.
    const legacy = await invoke("send_agent_secretary_task_message", {
      sessionId: manual.legacyParent, taskId: manual.legacyTask, text: manual.legacyPrompt,
      requestId: "desktop-legacy-worker-followup", locale: "zh",
    });
    check(legacy.id === manual.legacyTask && legacy.sessionId === manual.legacyChild, "v1.0.6 worker changed its public identity");
    const legacyChat = await waitForWorker(manual.legacyParent, manual.legacyTask, manual.legacyChild, manual.legacyAnswer);
    check(hasAnswer(legacyChat, manual.legacyHistory), "v1.0.6 worker transcript was not retained");
    const savedWorkerQueue = await invoke("enqueue_agent_message", {
      sessionId: manualTask.sessionId,
      text: fixture.workerQueue.afterRestart,
      requestId: savedWorkerInput,
      locale: "zh",
    });
    check(savedWorkerQueue.status === "accepted", savedWorkerQueue.message || "The idle worker queue could not be saved");
    return {
      sessionId,
      workerSessionId: task.sessionId,
      previewUrl: preview.url,
      nativePreviewRetained: true,
      manualWorktree: manualTask.worktree.path,
      manualWorkerSessionId: manualTask.sessionId,
      legacyWorkerSessionId: legacy.sessionId,
    };
  }
  return { sessionId };
}

let verifiedProfile = false;
let phase;
let reloading = false;
try {
  const config = await fetch(new URL("config", endpoint));
  check(config.ok, "Missing private acceptance configuration");
  const fixture = await config.json();
  phase = fixture.phase;
  await waitFor(
    () => Boolean(window.__TAURI_INTERNALS__?.invoke),
    "native Tauri IPC",
  );
  const build = await invoke("get_build_info");
  verifiedProfile =
    location.origin === fixture.origin &&
    build.channel === "development" &&
    windowsPath(build.dataDirectory) === windowsPath(fixture.profile);
  const result = await run(fixture);
  if (result.reload) {
    reloading = true;
    location.reload();
  } else {
    await requestReport({
      result: "passed",
      phase,
      ...result,
      hidden: !(await invoke("plugin:window|is_visible", { label: "main" })),
    });
  }
} catch (error) {
  await requestReport({
    result: "failed",
    phase,
    message: error?.message || String(error),
  });
} finally {
  if (verifiedProfile && !reloading)
    await invoke("plugin:process|exit", { code: 0 });
}
