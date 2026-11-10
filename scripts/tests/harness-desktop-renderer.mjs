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
const titlesKey = `${endpoint.pathname}:titles`;
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
  const answer = anchor.closest("article");
  await waitFor(() => answer?.textContent.includes("~literal~") &&
    answer.querySelector("del")?.textContent === "obsolete",
    "literal single tildes and double-tilde strikethrough in the assistant reply");
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
    // A reused test binary also reuses its WebView2 storage. Start this fixture
    // with a fresh dock so tabs from earlier profiles do not occupy its budget.
    localStorage.removeItem("lolicode.agent.rightDock.v1");
    localStorage.removeItem("lolicode.agent.rightDockBrowser.v1");
    await configureFixtureChannel(fixture);
    await invoke("set_builtin_app_enabled", { app: "tavern", enabled: true });
    const [preset] = await invoke("get_tavern_presets");
    const character = await invoke("add_tavern_preset", { presetId: preset.id });
    await invoke("create_tavern_story", { characterId: character.id, title: "Workspace switching fixture" });
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
  if (!restarted) {
    const isVisible = (element) =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
    const visible = (selector) => [...document.querySelectorAll(selector)]
      .find(isVisible);
    const nav = () => visible("nav.lolicode-unified-sidebar");
    const leftHandle = () => visible('[role="separator"][aria-label="调整项目侧栏宽度"]');
    const geometry = (view) => {
      const content = document.querySelector(view === "agent" ? "#agent-content-area" : '#content-area[data-view="tavern"]');
      return nav() && content && {
        width: Math.round(nav().getBoundingClientRect().width),
        boundary: Math.round(content.getBoundingClientRect().left),
      };
    };
    const switchTo = async (view) => {
      const button = await waitFor(() => findButton(view === "agent" ? "编程工作台" : "角色对话", nav()), view + " navigation");
      button.click();
      await waitFor(() => document.querySelector(`#content-area[data-view="${view}"]`) && geometry(view),
        view + " sidebar geometry");
      const surface = visible(view === "agent" ? ".wb-chat-surface" : ".tai-page");
      check(surface && getComputedStyle(surface).opacity === "1",
        view + " faded the entire page while switching");
    };
    const expectGeometry = (view, target) => waitFor(() => {
      const current = geometry(view);
      return current?.width === target.width && current.boundary === target.boundary;
    }, view + " sidebar preserving the same width and boundary", 20_000);
    const handle = await waitFor(leftHandle, "the Agent sidebar resize handle");
    const before = Number(handle.getAttribute("aria-valuenow"));
    const right = before < Number(handle.getAttribute("aria-valuemax"));
    keyDown(handle, right ? "ArrowRight" : "ArrowLeft", right ? 39 : 37);
    await waitFor(() => Number(leftHandle()?.getAttribute("aria-valuenow")) !== before, "the resized Agent sidebar");
    const expanded = geometry("agent");
    const composer = visible("#agent-message");
    const setComposer = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    const writeDraft = (input, value) => {
      setComposer.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const draft = "Unsent draft kept when switching modes";
    writeDraft(composer, draft);
    await switchTo("tavern");
    await expectGeometry("tavern", expanded);
    check(composer.isConnected && !isVisible(composer),
      "The inactive Agent composer was destroyed or stayed visible");
    const chatInput = 'textarea[aria-label="故事消息"]';
    const chatComposer = await waitFor(() => visible(chatInput), "the Tavern story composer", 15_000);
    const chatDraft = "Unsent Tavern message";
    writeDraft(chatComposer, chatDraft);
    keyDown(leftHandle(), right ? "ArrowLeft" : "ArrowRight", right ? 37 : 39);
    await waitFor(() => Number(leftHandle()?.getAttribute("aria-valuenow")) === before,
      "the sidebar width set from chat");
    const resizedFromChat = geometry("tavern");
    findButton("收起侧栏", nav()).click();
    await waitFor(() => nav()?.dataset.sidebarCompact === "true" && !leftHandle(), "the compact chat sidebar");
    const compact = geometry("tavern");
    check(compact.width === 72, "The compact chat rail did not keep its width");
    await switchTo("agent");
    await expectGeometry("agent", compact);
    check(visible("#agent-message") === composer && composer.value === draft,
      "Returning to Agent remounted the composer or lost its draft");
    check(chatComposer.isConnected && !isVisible(chatComposer),
      "The inactive Tavern composer was destroyed or stayed visible");
    writeDraft(composer, "");
    findButton("展开侧栏", nav()).click();
    await expectGeometry("agent", resizedFromChat);
    const search = await waitFor(() => nav()?.querySelector('input[aria-label="搜索会话"]'),
      "the workspace search control");
    search.focus();
    search.dispatchEvent(new KeyboardEvent("keydown", {
      key: "\\", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await waitFor(() => document.activeElement === findButton("展开侧栏", nav()),
      "keyboard focus moving to the collapsed sidebar toggle", 10_000);
    document.activeElement.click();
    await expectGeometry("agent", resizedFromChat);
    findButton("预览项目文件").click();
    await waitFor(() => findButton("收起文件预览"), "the open preview");
    const withPreview = geometry("agent");
    await switchTo("tavern");
    await expectGeometry("tavern", withPreview);
    check(visible(chatInput) === chatComposer && chatComposer.value === chatDraft,
      "Returning to Tavern remounted the composer or lost its draft");
    writeDraft(chatComposer, "");
    await switchTo("agent");
    await waitFor(() => findButton("收起文件预览"), "the restored preview", 10_000);
    await expectGeometry("agent", withPreview);
    findButton("收起文件预览").click();
  }
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
      foldRetainsTools: true, terminalClose: true, sharedSidebar: true,
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
  const goalControlsHidden = () =>
    !document.querySelector('[aria-label="Agent 会话模式"]') &&
    ![...document.querySelectorAll("button")].some(button => button.textContent.trim() === "设置目标");
  const completedGoalHidden = () =>
    document.querySelector(".wb-chat-content")?.textContent.includes(modes.goalText) && goalControlsHidden();
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
    await waitFor(completedGoalHidden, "restored Goal conversation without the completed goal strip");
    const state = await snapshot();
    check(state.goal?.phase === "complete" && state.goal.roundsStarted === 2, "Native Goal state was not restored");
    check(state.plan?.active === false && said(state, modes.planText), "Native Plan history was not restored");
    return { sessionId, nativeModesRestored: true };
  }
  await waitFor(() => document.querySelector("#agent-message"), "the native modes composer");
  check(goalControlsHidden(), "A session without a Goal exposed a creation control");
  const planToggle = () => [...document.querySelectorAll("button")]
    .some((button) => /^(退出)?计划模式$/.test(button.textContent.trim()));
  check(!planToggle(), "Plan mode is still exposed as a manual switch");
  check(!(await snapshot()).plan?.active, "The session did not start in its normal mode");
  await send("native-plan-work", "/plan " + modes.plan);
  const review = (heading) => waitFor(() => {
    const card = document.querySelector('[aria-label="审批实施计划"]');
    return card?.textContent.includes(heading) && card;
  }, heading, 30_000);
  const draft = await review("Initial desktop plan");
  check((await snapshot()).plan?.active === true, "The upstream command did not enter native Plan");
  check(!planToggle(), "Planning exposed a manual mode switch");
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
  await waitFor(completedGoalHidden, "completed Goal conversation without the goal strip");
  if (fixture.occupyProxyPort) {
    const config = await invoke("get_proxy_config");
    check(config.listen_port === fixture.proxyPort, "The fallback overwrote the saved proxy port");
  }
  return {
    sessionId, nativePlan: true, nativeGoal: true, occupiedProxyRecovered: fixture.occupyProxyPort,
  };
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
  let scrollState;
  try {
    await waitFor(async () => {
      const state = await invoke("get_agent_session", { sessionId: keyboardSessionId });
      const scroll = chatViewport();
      scrollState = {
        status: state.status,
        title: document.querySelector(".wb-titlebar h1")?.textContent,
        tailRendered: chat().includes("Historical paragraph 65"),
        height: scroll?.clientHeight,
        scrollHeight: scroll?.scrollHeight,
      };
      return scrollState.status === "idle" && scrollState.tailRendered &&
        scrollState.scrollHeight - scrollState.height > 96;
    }, "a scrollable workbench conversation");
  } catch (error) {
    throw new Error(`${error.message} (${JSON.stringify(scrollState)})`);
  }
  const readOlderMessages = async () => {
    chatViewport().scrollTop = 0;
    await waitFor(() => document.querySelector(".wb-scroll-latest") && !atChatTail(),
      "the reader scrolled away from the current conversation tail");
  };
  await readOlderMessages();
  await submit(keyboard.start);
  await waitFor(() => chat().includes(keyboard.start) && atChatTail(),
    "send follows its new bubble to the actual WebView bottom");
  const progress = await waitFor(() => document.querySelector("button.wb-task-progress"),
    "the running task's progress shortcut");
  await readOlderMessages();
  progress.click();
  await waitFor(() => atChatTail() && document.activeElement?.id === progress.getAttribute("aria-controls"),
    "the progress shortcut returns to the current task and focuses its status");
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

async function verifyCompletedGlobalSecretaryTasks(run, fixture) {
  const { session } = await invoke("get_agent_session", { sessionId: run.secretaryId });
  check(session.coordination?.role === "secretary" &&
    windowsPath(session.projectPath) === windowsPath(run.workspace),
  "The global secretary changed identity or workspace");
  const state = await invoke("get_agent_secretary", { sessionId: run.secretaryId });
  check(state.sessionId === run.secretaryId && state.tasks.length === run.tasks.length,
    "The global secretary lost or duplicated a task");
  for (const [index, expected] of run.tasks.entries()) {
    const task = state.tasks.find(({ id }) => id === expected.id);
    check(task?.status === "completed" && task.parentSessionId === run.secretaryId &&
      task.sessionId === expected.sessionId && task.requestId === expected.requestId &&
      windowsPath(task.projectPath) === windowsPath(expected.projectPath),
    "The global secretary's task changed owner, identity, project or outcome");
    const worker = await invoke("get_agent_session", { sessionId: expected.sessionId });
    check(worker.session.coordination?.role === "worker" &&
      worker.session.coordination.parentSessionId === run.secretaryId &&
      worker.session.permissionMode === "ask" &&
      windowsPath(worker.session.projectPath) === windowsPath(expected.projectPath) &&
      worker.messages.some((message) => message.role === "assistant" &&
        message.parts.some((part) => part.type === "text" && part.text === fixture.globalSecretary.tasks[index].answer)),
    "The global secretary's worker lost its project, review policy or answer");
  }
}

async function verifyGlobalSecretaryDispatch(fixture) {
  const { projectPath: workspace } = await invoke("get_agent_status");
  const catalog = await invoke("get_agent_catalog");
  const secretary = await invoke("open_agent_secretary", {
    projectPath: workspace, modelId: catalog.defaultModel ?? catalog.models[0].id, locale: "zh",
  });
  const configured = await invoke("update_agent_session", {
    sessionId: secretary.id, permissionMode: "full_access",
  });
  check(configured.permissionMode === "full_access", "The global secretary did not enter Full access for the scope test");
  const projects = await invoke("list_agent_projects");
  const run = { secretaryId: secretary.id, workspace, tasks: [] };
  for (const [index, path] of [fixture.project, fixture.otherProject].entries()) {
    const project = projects.find((entry) => windowsPath(entry.path) === windowsPath(path));
    check(project && !project.remote && !project.standalone, "The cross-project fixture needs two registered local projects");
    const expected = fixture.globalSecretary.tasks[index];
    const args = {
      sessionId: secretary.id, projectPath: project.path, title: expected.title,
      instructions: expected.prompt, requestId: `desktop-global-secretary-${index}`,
      executionMode: "shared", locale: "zh",
    };
    const task = await invoke("delegate_agent_secretary_task", args);
    check(task.id.startsWith("harness-") && task.parentSessionId === secretary.id &&
      windowsPath(task.projectPath) === windowsPath(project.path) &&
      !run.tasks.some(({ sessionId }) => sessionId === task.sessionId),
    "Manual cross-project delegation did not create a distinct owned worker");
    const approval = await waitFor(async () => {
      const state = await invoke("get_agent_secretary", { sessionId: secretary.id });
      const current = state.tasks.find(({ id }) => id === task.id);
      if (current?.status === "completed") throw new Error("Cross-project worker completed without scoped approval");
      if (["failed", "cancelled", "interrupted"].includes(current?.status))
        throw new Error(current.error || "Cross-project task failed");
      if (current?.status !== "waiting_permission") return false;
      const worker = await invoke("get_agent_session", { sessionId: task.sessionId });
      if (worker.status === "error" || worker.error) throw new Error(worker.error || "Cross-project worker failed");
      check(worker.session.permissionMode === "ask", "A cross-project worker inherited the secretary's Full access");
      return worker.status === "waiting_permission" && worker.permissions.length === 1 && worker.permissions[0];
    }, `the scoped approval for ${expected.title}`);
    check(approval.toolName === "write" && approval.approvalMode === "user-once",
      "A cross-project write did not require a real one-shot approval");
    await invoke("reply_agent_permission", {
      sessionId: task.sessionId, requestId: approval.id, decision: "once",
    });
    await waitFor(async () => {
      const state = await invoke("get_agent_secretary", { sessionId: secretary.id });
      const current = state.tasks.find(({ id }) => id === task.id);
      if (["failed", "cancelled", "interrupted"].includes(current?.status))
        throw new Error(current.error || "Cross-project task failed");
      return current?.status === "completed";
    }, `the completed worker for ${expected.title}`);
    const replayed = await invoke("delegate_agent_secretary_task", args);
    check(replayed.id === task.id && replayed.sessionId === task.sessionId,
      "Replaying a global secretary request allocated another worker");
    run.tasks.push({ id: task.id, sessionId: task.sessionId, requestId: args.requestId, projectPath: project.path });
  }
  await verifyCompletedGlobalSecretaryTasks(run, fixture);
  return run;
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

async function verifySessionTitles(fixture) {
  const { titles } = fixture;
  const restarted = fixture.phase === "titles-restart";
  const saved = JSON.parse(sessionStorage.getItem(titlesKey));
  if (!restarted && !saved) {
    await configureFixtureChannel(fixture);
    const opened = await invoke("open_agent_project", { path: fixture.project });
    check(opened.sessions.length === 0, "The title fixture requires an empty workspace");
    const catalog = await invoke("get_agent_catalog");
    const session = await invoke("create_agent_session", {
      projectPath: fixture.project, modelId: catalog.defaultModel ?? catalog.models[0].id, mode: "build",
    });
    check(session.title !== titles.generatedTitle, "The blank session already had a generated title");
    localStorage.setItem("cc-switch-last-view", "agent");
    localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
      projectPath: session.projectPath, sessionId: session.id,
    }));
    sessionStorage.setItem(titlesKey, JSON.stringify({ id: session.id, initialTitle: session.title }));
    return { reload: true };
  }

  const sessionId = restarted ? fixture.titleSessionId : saved.id;
  const snapshot = (id = sessionId) => invoke("get_agent_session", { sessionId: id });
  const composer = () => document.querySelector("textarea#agent-message");
  const titleVisible = title => document.querySelector(".wb-titlebar h1")?.textContent.trim() === title &&
    document.querySelector('button.wb-session-row[aria-pressed="true"]')?.textContent.trim() === title;
  const answerVisible = answer => document.querySelector(".wb-transcript-pane:not([hidden])")?.textContent.includes(answer);
  const hasAnswer = (state, answer) => state.messages.some(message => message.role === "assistant" &&
    message.parts.some(part => part.text?.includes(answer)));
  const verifyTurn = async (title, answer, id = sessionId) => {
    await waitFor(async () => {
      const state = await snapshot(id);
      if (state.status === "error") throw new Error(state.error || "The title fixture turn failed");
      return state.status === "idle" && !state.titlePending && state.session.title === title && hasAnswer(state, answer);
    }, `the settled turn with title ${title}`, 20_000);
    await waitFor(() => titleVisible(title) && answerVisible(answer),
      `the desktop header, sidebar, and answer for ${title}`, 20_000);
  };

  if (restarted) {
    await verifyTurn(titles.manualTitle, titles.manualAnswer);
    const listed = await invoke("open_agent_project", { path: fixture.project });
    check(listed.sessions.some(session => session.id === sessionId && session.title === titles.manualTitle),
      "Cold workspace listing lost the manually chosen title");
    check(listed.sessions.some(session => session.id === fixture.titleRaceSessionId && session.title === titles.raceManualTitle),
      "Cold workspace listing lost the title chosen while generation was pending");
    return { sessionId, manualTitleRetained: true };
  }

  const fill = (input, value) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const submit = async text => {
    const input = await waitFor(composer, "the title fixture composer", 10_000);
    fill(input, text);
    await waitFor(() => !input.form.querySelector('button[type="submit"]').disabled, "an enabled composer", 5000);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  };
  const renameTitle = async (current, next) => {
    const trigger = await waitFor(() => [...document.querySelectorAll("button.wb-session-menu:not(:disabled)")]
      .find(button => button.getAttribute("aria-label") === "管理会话：" + current), "the selected session's menu");
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const rename = await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')]
      .find(item => item.textContent.trim() === "重命名"), "the Rename menu item");
    rename.click();
    const input = await waitFor(() => document.querySelector('input[aria-label="会话名称"]'), "the Rename dialog");
    fill(input, next);
    const save = [...input.closest('[role="dialog"]').querySelectorAll("button")]
      .find(button => button.textContent.trim() === "保存名称");
    check(save, "The Rename dialog has no Save button");
    save.click();
    await waitFor(() => titleVisible(next), "the manual title in the workbench");
  };
  const waitForPendingTitle = async (id, answer, timeout) => {
    let progress;
    try {
      return await waitFor(async () => {
        const state = await snapshot(id);
        if (state.status === "error") throw new Error(state.error || "The title fixture turn failed");
        progress = { status: state.status, titlePending: state.titlePending, messages: state.messages.length,
          mainAnswer: hasAnswer(state, answer), answerVisible: Boolean(answerVisible(answer)) };
        return progress.status === "idle" && progress.titlePending && progress.mainAnswer && progress.answerVisible && state;
      }, "the visible main answer while its auxiliary title request is pending", timeout);
    } catch (error) {
      throw new Error(`${error.message} (${JSON.stringify(progress)})`);
    }
  };
  const releaseTitle = number => waitFor(async () => {
    const result = await fetch(new URL(`titles-release/${number}`, endpoint), { method: "POST" });
    if (result.status === 409) return false;
    check(result.ok, "The title fixture could not release its model response");
    return true;
  }, "the held title response", 5_000);

  await waitFor(() => titleVisible(saved.initialTitle), "the unnamed conversation in the workbench");
  await submit(titles.firstPrompt);
  await waitForPendingTitle(sessionId, titles.firstAnswer, 45_000);
  await submit(titles.nextPrompt);
  await waitForPendingTitle(sessionId, titles.nextAnswer, 4500);
  await releaseTitle(1);
  await verifyTurn(titles.generatedTitle, titles.nextAnswer);
  await renameTitle(titles.generatedTitle, titles.manualTitle);
  await submit(titles.manualPrompt);
  await verifyTurn(titles.manualTitle, titles.manualAnswer);

  const create = await waitFor(() => document.querySelector("button.wb-nav-create:not(:disabled)"), "the new conversation button");
  create.click();
  const raceSessionId = await waitFor(() => {
    const selected = JSON.parse(localStorage.getItem("lolicode.agent.last-selection.v1"));
    return selected?.sessionId !== sessionId && selected?.sessionId;
  }, "the new conversation selected for the title race");
  await submit(titles.racePrompt);
  const pending = await waitForPendingTitle(raceSessionId, titles.raceAnswer, 45_000);
  await renameTitle(pending.session.title, titles.raceManualTitle);
  await releaseTitle(2);
  await verifyTurn(titles.raceManualTitle, titles.raceAnswer, raceSessionId);

  const original = [...document.querySelectorAll("button.wb-session-row")]
    .find(button => button.textContent.trim() === titles.manualTitle);
  check(original, "The original titled conversation was lost");
  original.click();
  await verifyTurn(titles.manualTitle, titles.manualAnswer);
  return { sessionId, raceSessionId, generatedTitle: true, followupWhileTitlePending: true,
    manualTitleRetained: true, manualTitleWonRace: true };
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
  if (fixture.phase === "warm-session") {
    const { verifyWarmSession } = await import("./warm-session.mjs");
    return { ...await verifyWarmSession(fixture, { check, configureFixtureChannel, invoke, waitFor }), build };
  }
  if (fixture.phase === "dock-tools" || fixture.phase === "dock-tools-restart")
    return verifyDockTools(fixture);
  if (fixture.phase === "compact") return verifyNativeCompaction(fixture);
  if (fixture.phase === "background-jobs") return verifyBackgroundJobs(fixture);
  if (fixture.phase === "native-modes" || fixture.phase === "native-modes-restart")
    return verifyNativeModes(fixture);
  if (fixture.phase === "session-export" || fixture.phase === "session-export-restart") {
    const { verifySessionExport } = await import("./session-export.mjs");
    return verifySessionExport(fixture, { check, configureFixtureChannel, invoke, waitFor });
  }
  if (fixture.phase === "switching") {
    const { verifySwitching } = await import("./switching.mjs");
    return verifySwitching(fixture, { configureFixtureChannel, invoke });
  }
  if (fixture.phase === "titles" || fixture.phase === "titles-restart") return verifySessionTitles(fixture);
  if (fixture.phase === "browser-tool") {
    if (fixture.permissionsOnly && !sessionStorage.getItem(browserToolKey))
      await configureFixtureChannel(fixture);
    return verifyBrowserTool(fixture);
  }

  if (fixture.phase === "worker-queue-restart") {
    await invoke("open_agent_project", { path: fixture.project });
    await verifyCompletedGlobalSecretaryTasks(fixture.globalSecretaryRun, fixture);
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
    return { sessionId, workerQueueRestart: true, globalSecretaryRestored: true };
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
      localStorage.setItem("cc-switch-last-view", "agent");
      localStorage.setItem("lolicode.agent.last-selection.v1", JSON.stringify({
        projectPath: previous.session.projectPath,
        sessionId,
      }));
      sessionStorage.setItem(chiefKey, chief.id);
      return { reload: true };
    }
    const secretaryButton = await waitFor(() => {
      const button = document.querySelector("button.wb-nav-secretary");
      return document.querySelector("#agent-message") && button && !button.disabled && button;
    }, "the normal composer and enabled secretary navigation");
    if (secretaryButton.getAttribute("aria-pressed") !== "true") secretaryButton.click();
    await waitFor(
      async () => secretaryButton.getAttribute("aria-pressed") === "true" &&
        (await invoke("get_agent_status")).projectPath?.endsWith("standalone-workspace"),
      "the global secretary in its independent workspace",
    );
    const globalSecretaryRun = await verifyGlobalSecretaryDispatch(fixture);
    const projectButton = await waitFor(() => Array.from(
      document.querySelectorAll("button.wb-workspace-project"),
    ).find((button) => !button.disabled && windowsPath(button.title) === windowsPath(fixture.project)),
    "the original project's sidebar entry");
    projectButton.click();
    await waitFor(async () => {
      const status = await invoke("get_agent_status");
      return status.projectPath && windowsPath(status.projectPath) === windowsPath(fixture.project) &&
        document.querySelector("#agent-message");
    }, "the original project and its restored composer");
    const { session: oldChief } = await invoke("get_agent_session", { sessionId: chiefId });
    const oldChiefButton = await waitFor(() => Array.from(
      document.querySelectorAll(".wb-current-workspace-sessions button.wb-session-row"),
    ).find((button) => !button.disabled && button.querySelector("span")?.textContent === oldChief.title),
    "the migrated secretary in the original project's session list");
    oldChiefButton.click();
    await waitFor(
      () => oldChiefButton.getAttribute("aria-pressed") === "true" &&
        secretaryButton.getAttribute("aria-pressed") === "false" && document.querySelector("#agent-message") &&
        document.querySelector(".wb-titlebar h1")?.textContent === oldChief.title &&
        document.querySelector("main")?.innerText.includes("Loli 秘书"),
      "the migrated secretary selected in the real workbench",
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
      globalSecretaryRun,
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
