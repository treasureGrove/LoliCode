// Test instrumentation served only by the private loopback Vite harness.
// Uses native IPC and actual DOM controls, not mocked Tauri or navigation state.
const endpoint = new URL(".", import.meta.url);
const phases = [];
let fixture,
  verified = false;
const check = (value) => {
  if (!value) throw new Error("smoke assertion");
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, ms = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("deadline")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const invoke = (command, args = {}) =>
  bounded(window.__TAURI_INTERNALS__.invoke(command, args));
async function waitFor(read, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await sleep(100);
  }
  throw new Error("DOM deadline");
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
  check(visible(element));
  await bounded(
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    ),
    5000,
  );
  check(visible(element));
  check(document.visibilityState === "visible");
}
async function request(name, options) {
  const response = await bounded(fetch(new URL(name, endpoint), options));
  check(response.ok);
  return response;
}
let passed = false;
try {
  fixture = await (await request("config")).json();
  check(location.origin === fixture.origin);
  await waitFor(() => window.__TAURI_INTERNALS__?.invoke);
  const build = await invoke("get_build_info");
  check(
    build.channel === "development" &&
      build.dataDirectory === fixture.profile &&
      build.sourceRevision === fixture.revision,
  );
  verified = true;
  phases.push("identity");
  const engine = await invoke("get_agent_status");
  check(engine.available && /^deepseek-harness-/.test(engine.version));
  phases.push("harness");
  await waitFor(() => invoke("plugin:window|is_visible", { label: "main" }));
  await paint(await waitFor(() => query("#root")));
  await paint(await waitFor(() => query("[data-workspace-active]")));
  phases.push("paint");
  await click('button[aria-label="Profile and settings"]');
  const settings = await waitFor(() =>
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => visible(el) && el.textContent.trim() === "Settings",
    ),
  );
  settings.click();
  await click('[role="combobox"][aria-label="Language"]');
  const chinese = await waitFor(() =>
    [...document.querySelectorAll('[role="option"]')].find(
      (el) => visible(el) && el.textContent.trim() === "简体中文",
    ),
  );
  chinese.click();
  await paint(
    await waitFor(() => query('[role="combobox"][aria-label="界面语言"]')),
  );
  check(document.body.textContent.includes("外观"));
  await waitFor(async () => (await invoke("get_settings")).language === "zh");
  await click('[role="combobox"][aria-label="界面语言"]');
  const english = await waitFor(() =>
    [...document.querySelectorAll('[role="option"]')].find(
      (el) => visible(el) && el.textContent.trim() === "English",
    ),
  );
  english.click();
  await paint(
    await waitFor(() => query('[role="combobox"][aria-label="Language"]')),
  );
  await waitFor(async () => (await invoke("get_settings")).language === "en");
  check(document.body.textContent.includes("Appearance"));
  phases.push("language");
  await click('button[aria-label="Coding workspace"]');
  const agent = await waitFor(() =>
    query("[data-workspace-active]#main-content"),
  );
  await paint(agent);
  await paint(await waitFor(() => query(".wb-chat-surface")));
  await paint(await waitFor(() => query(".wb-welcome-action:not([disabled])")));
  await click('button[aria-label="Character chat"]');
  await click('article[data-app="tavern"] button:not([disabled])');
  const tavern = await waitFor(() => {
    const el = query("[data-workspace-active]");
    return el && el !== agent && !visible(agent) && el;
  });
  await paint(tavern);
  // Panel content must exist, not just the outer navigation marker.
  check(tavern.querySelector("section"));
  await paint(
    await waitFor(() => {
      const hint = query(".tavern-composer-hint");
      return (
        hint?.textContent.trim() === "Select or create a story to continue." &&
        hint
      );
    }),
  );
  await paint(
    await waitFor(() => [...tavern.querySelectorAll("h3")].find(visible)),
  );
  const snapshot = await invoke("get_tavern_snapshot");
  check(
    Array.isArray(snapshot.characters) &&
      snapshot.characters.length === 0 &&
      Array.isArray(snapshot.stories) &&
      snapshot.stories.length === 0,
  );
  await click('button[aria-label="Coding workspace"]');
  await waitFor(() => visible(agent) && !visible(tavern));
  await paint(agent);
  phases.push("navigation");
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
} catch {
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
        }),
      });
    } catch {
      /* Host rejects a failure report and fails the run. */
    }
  }
} finally {
  if (verified) await invoke("plugin:process|exit", { code: passed ? 0 : 1 });
}
