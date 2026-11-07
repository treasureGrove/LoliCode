// Test instrumentation served only by the private loopback Vite harness.
// Uses native IPC and actual DOM controls, not mocked Tauri or navigation state.
const endpoint = new URL(".", import.meta.url);
const phases = [];
let checkpoint = "config";
let fixture,
  verified = false;
const check = (value, code = "assertion") => {
  if (!value) throw new Error(code);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, ms = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const invoke = (command, args = {}) =>
  bounded(
    window.__TAURI_INTERNALS__.invoke(command, args).catch(() => {
      throw new Error("ipc-rejected");
    }),
  );
async function waitFor(read, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await sleep(100);
  }
  throw new Error("timeout");
}
function visible(element) {
  if (!element || element.closest('[hidden], [aria-hidden="true"], [inert]'))
    return false;
  const rect = element.getBoundingClientRect(),
    css = getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    css.display !== "none" &&
    css.visibility === "visible" &&
    Number(css.opacity) > 0
  );
}
const query = (selector) =>
  [...document.querySelectorAll(selector)].find(visible);
async function click(selector) {
  const element = await waitFor(() => query(selector));
  await paint(element);
  element.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerType: "mouse",
      isPrimary: true,
    }),
  );
  element.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      button: 0,
      pointerType: "mouse",
      isPrimary: true,
    }),
  );
  element.click();
}
async function paint(element) {
  check(visible(element), "geometry-hidden");
  await bounded(
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    ),
    5000,
  );
  check(visible(element), "geometry-hidden");
  check(document.visibilityState === "visible", "document-hidden");
}
async function request(name, options) {
  const response = await bounded(fetch(new URL(name, endpoint), options));
  check(response.ok);
  return response;
}
let passed = false;
try {
  fixture = await (await request("config")).json();
  check(location.origin === fixture.origin, "origin-mismatch");
  checkpoint = "native-bridge";
  await waitFor(() => window.__TAURI_INTERNALS__?.invoke);
  checkpoint = "build-identity";
  const build = await invoke("get_build_info");
  check(build.channel === "development", "build-channel");
  check(build.dataDirectory === fixture.profile, "build-profile");
  check(build.sourceRevision === fixture.revision, "build-revision");
  verified = true;
  phases.push("identity");
  checkpoint = "harness-status";
  const engine = await invoke("get_agent_status");
  check(engine.available, "harness-unavailable");
  check(/^deepseek-harness-/.test(engine.version), "harness-version");
  phases.push("harness");
  checkpoint = "window-visible";
  await waitFor(() => invoke("plugin:window|is_visible", { label: "main" }));
  checkpoint = "root-painted";
  await paint(await waitFor(() => query("#root")));
  checkpoint = "workspace-painted";
  await paint(await waitFor(() => query("[data-workspace-active]")));
  phases.push("paint");
  checkpoint = "profile-menu";
  await click('button[aria-label="Profile and settings"]');
  checkpoint = "settings-menu";
  const settings = await waitFor(() =>
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => visible(el) && el.textContent.trim() === "Settings",
    ),
  );
  settings.click();
  checkpoint = "language-control";
  await click('[role="combobox"][aria-label="Language"]');
  checkpoint = "chinese-option";
  const chinese = await waitFor(() =>
    [...document.querySelectorAll('[role="option"]')].find(
      (el) => visible(el) && el.textContent.trim() === "简体中文",
    ),
  );
  checkpoint = "chinese-copy";
  chinese.click();
  await paint(
    await waitFor(() => query('[role="combobox"][aria-label="界面语言"]')),
  );
  check(document.body.textContent.includes("外观"));
  checkpoint = "chinese-persisted";
  await waitFor(async () => (await invoke("get_settings")).language === "zh");
  await click('[role="combobox"][aria-label="界面语言"]');
  checkpoint = "english-option";
  const english = await waitFor(() =>
    [...document.querySelectorAll('[role="option"]')].find(
      (el) => visible(el) && el.textContent.trim() === "English",
    ),
  );
  checkpoint = "english-copy";
  english.click();
  await paint(
    await waitFor(() => query('[role="combobox"][aria-label="Language"]')),
  );
  checkpoint = "english-persisted";
  await waitFor(async () => (await invoke("get_settings")).language === "en");
  check(document.body.textContent.includes("Appearance"));
  phases.push("language");
  // Settings replaces the main directory, so use its actual Back control.
  checkpoint = "settings-return";
  await click('.lolicode-sidebar-settings button[aria-label="Back"]');
  checkpoint = "agent-entry";
  const agent = await waitFor(() =>
    query("[data-workspace-active]#main-content"),
  );
  await paint(agent);
  checkpoint = "agent-content";
  await paint(await waitFor(() => query(".wb-chat-surface")));
  checkpoint = "agent-ready";
  await paint(await waitFor(() => query(".wb-welcome-action:not([disabled])")));
  checkpoint = "tavern-entry";
  await click('button[aria-label="Character chat"]');
  checkpoint = "tavern-enable";
  await click('article[data-app="tavern"] button:not([disabled])');
  checkpoint = "tavern-enabled";
  await waitFor(async () =>
    (await invoke("list_builtin_apps")).some(
      (app) => app.id === "tavern" && app.enabled === true,
    ),
  );
  checkpoint = "tavern-visible";
  const tavern = await waitFor(() => {
    const el = query("[data-workspace-active]");
    return el && el !== agent && !visible(agent) && el;
  });
  await paint(tavern);
  checkpoint = "tavern-snapshot";
  const snapshot = await invoke("get_tavern_snapshot");
  check(
    Array.isArray(snapshot.characters) &&
      snapshot.characters.length === 0 &&
      Array.isArray(snapshot.stories) &&
      snapshot.stories.length === 0,
  );
  checkpoint = "tavern-catalog";
  // A fresh signed-out profile intentionally has no model. Only this exact native
  // missing-model error is expected; corruption, IPC failure and other errors fail.
  const expectedMissingModel =
    "无效输入: 请先在渠道与模型中添加并启用一个可通过共享网关调用的模型";
  const noConfiguredModel = await bounded(
    window.__TAURI_INTERNALS__.invoke("get_tavern_catalog").then(
      () => false,
      (error) => error === expectedMissingModel,
    ),
  );
  check(noConfiguredModel, "tavern-catalog-unexpected");
  checkpoint = "tavern-section";
  // The active wrapper first holds the app library; enabling Tavern is asynchronous.
  // Wait for the real page's visible section, not merely its retained wrapper.
  await paint(
    await waitFor(() => {
      const section = tavern.querySelector("section");
      return visible(section) && section;
    }),
  );
  checkpoint = "tavern-ready";
  await paint(
    await waitFor(() => {
      const hint = query(".tavern-composer-hint");
      return (
        hint?.textContent.trim() ===
          "Set up the local companion above, or add a model in Models & channels to begin." &&
        hint
      );
    }),
  );
  checkpoint = "tavern-heading";
  await paint(
    await waitFor(() => [...tavern.querySelectorAll("h3")].find(visible)),
  );
  checkpoint = "agent-return";
  await click('button[aria-label="Coding workspace"]');
  await waitFor(() => visible(agent) && !visible(tavern));
  check(agent.isConnected && tavern.isConnected);
  await paint(agent);
  await paint(
    await waitFor(() => {
      const content = agent.querySelector(".wb-chat-surface");
      return visible(content) && content;
    }),
  );
  phases.push("navigation");
  checkpoint = "success-report";
  await request("report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nonce: fixture.nonce,
      revision: fixture.revision,
      result: "passed",
      phases,
    }),
  });
  passed = true;
} catch (error) {
  const failureCode = [
    "assertion",
    "timeout",
    "ipc-rejected",
    "request-failed",
    "geometry-hidden",
    "document-hidden",
    "origin-mismatch",
    "build-channel",
    "build-profile",
    "build-revision",
    "harness-unavailable",
    "harness-version",
    "tavern-catalog-unexpected",
  ].includes(error?.message)
    ? error.message
    : "unknown";
  if (fixture) {
    try {
      await request("report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nonce: fixture.nonce,
          revision: fixture.revision,
          result: "failed",
          phases,
          checkpoint,
          failureCode,
        }),
      });
    } catch {
      /* Host rejects a failure report and fails the run. */
    }
  }
} finally {
  if (verified) await invoke("plugin:process|exit", { code: passed ? 0 : 1 });
}
