import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const portal = new URL("../../deploy/lolicode-relay/portal/", import.meta.url);
const html = readFileSync(new URL("public-settings.html", portal), "utf8");
const settingsScript = readFileSync(
  new URL("public-settings.js", portal),
  "utf8",
);
const hostScript = readFileSync(new URL("portal-host.js", portal), "utf8");
const fixture = () => ({
  settings: {
    revision: 7,
    enabled: false,
    availabilityMode: "permanent",
    availableUntil: null,
    modelIds: [],
    dailyRequests: 20,
    dailyTokens: 100000,
    globalDailyRequests: 200,
    globalDailyTokens: 1000000,
    maxConcurrentPerAccount: 1,
    maxConcurrentGlobal: 1,
    globalRequestsPerMinute: 6,
    maxOutputTokens: 4096,
    maxRequestBytes: 131072,
  },
  channels: [
    {
      id: 12,
      name: "公益 API",
      enabled: true,
      status: 1,
      models: [{ id: "glm-5.3-flash", name: "GLM Flash" }],
    },
  ],
  status: { ready: false, expired: false, modelCount: 0 },
});
const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const presetFixture = {
  version: 1,
  presets: [
    {
      id: "glm",
      name: "智谱",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      protocol: "openai_chat",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      protocol: "openai_chat",
    },
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      protocol: "openai_responses",
    },
    {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      protocol: "anthropic",
    },
  ],
  commonIds: ["glm", "deepseek", "openai"],
};
const modelFixture = {
  models: [{ id: "glm-5.3-flash", name: "GLM Flash" }],
  protocol: "openai_chat",
  baseUrl: "https://api.example.com/v1",
};
async function page(handler = () => response(fixture()), options = {}) {
  const dom = new JSDOM(html, {
    url: "https://relay.example/public-models-admin",
    runScripts: "outside-only",
  });
  const calls = [];
  dom.window.AbortSignal.timeout ??= () => undefined;
  dom.window.fetch = async (path, optionsForRequest) => {
    calls.push({ path, options: optionsForRequest });
    if (path === "/relay-assets/channel-presets.json")
      return response(presetFixture);
    if (path === "/admin-api/upstream/models")
      return options.discover
        ? options.discover(path, optionsForRequest)
        : response(modelFixture);
    if (path === "/api/user/auth/refresh")
      return response({
        success: true,
        data: { access_token: "test-session-token" },
      });
    return handler(path, optionsForRequest);
  };
  // Neither the session token nor the upstream key may be written to web storage.
  dom.window.Storage.prototype.setItem = () => {
    throw new Error("Unexpected credential persistence");
  };
  dom.window.eval(settingsScript);
  await tick();
  const byId = (id) => dom.window.document.getElementById(id);
  const change = (id, value) => {
    const input = byId(id);
    if (typeof value === "boolean") input.checked = value;
    else input.value = value;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const submit = (id) =>
    byId(id).dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  return { dom, calls, byId, change, submit };
}

async function prepareModels(p) {
  p.byId("discover-models").click();
  await tick();
  p.byId("upstream-model-options").querySelector("input").click();
}

test("renews the existing cookie and loads public settings without storing credentials", async (t) => {
  const p = await page();
  t.after(() => p.dom.window.close());
  const auth = p.calls.find((call) => call.path === "/api/user/auth/refresh");
  assert.equal(auth.options.method, "POST");
  assert.equal(auth.options.credentials, "same-origin");
  assert.equal(auth.options.body, "{}");
  assert.equal(
    p.calls.find((call) => call.path === "/admin-api/public-settings").options
      .headers.Authorization,
    "Bearer test-session-token",
  );
  assert.equal(p.byId("settings-form").hidden, false);
  assert.equal(p.byId("upstream-panel").hidden, false);
  assert.equal(p.byId("daily-tokens").value, "100000");
  assert.equal(p.byId("service-state-text").textContent, "已关闭");
  assert.equal(p.byId("upstream-fields").disabled, false);
});

test("expired administrator access exposes an explicit login link without a redirect loop", async (t) => {
  const p = await page(() =>
    response({ error: { code: "admin_required", message: "请登录" } }, 403),
  );
  t.after(() => p.dom.window.close());
  assert.equal(p.byId("login-panel").hidden, false);
  assert.equal(
    p.byId("login-panel").querySelector("a").getAttribute("href"),
    "/sign-in?admin=1",
  );
  assert.equal(p.byId("settings-form").hidden, true);
  assert.equal(p.byId("save").disabled, true);
  assert.equal(
    p.calls.filter((call) => call.path !== "/relay-assets/channel-presets.json")
      .length,
    2,
  );
});

test("saves exact selected model IDs and preserves nullable global limits", async (t) => {
  let written;
  const data = fixture();
  const p = await page((path, options) => {
    if (options.method === "PUT") {
      written = JSON.parse(options.body);
      return response({
        ...data,
        settings: { ...written, revision: 8 },
        status: { ready: true, expired: false, modelCount: 1 },
      });
    }
    return response(data);
  });
  t.after(() => p.dom.window.close());
  p.byId("model-options").querySelector("input").click();
  p.change("enabled", true);
  p.change("daily-requests", "35");
  p.change("global-daily-tokens", "");
  p.submit("settings-form");
  await tick();
  assert.equal(written.revision, 7);
  assert.equal(written.enabled, true);
  assert.deepEqual(written.modelIds, ["glm-5.3-flash"]);
  assert.equal(written.dailyRequests, 35);
  assert.equal(written.globalDailyTokens, null);
  assert.equal(written.availabilityMode, "permanent");
  assert.equal(written.availableUntil, null);
  assert.equal(p.byId("service-state-text").textContent, "已开放 · 1 个模型");
  assert.match(p.byId("save-result").textContent, /已保存/);
});

test("a stale read never overwrites an edit made after it started", async (t) => {
  let resolveRead;
  let reads = 0;
  const p = await page(() => {
    reads += 1;
    return reads === 1
      ? response(fixture())
      : new Promise((resolve) => {
          resolveRead = resolve;
        });
  });
  t.after(() => p.dom.window.close());
  p.byId("reload").click();
  await tick();
  p.change("daily-tokens", "123456");
  resolveRead(
    response({
      ...fixture(),
      settings: { ...fixture().settings, dailyTokens: 999999 },
    }),
  );
  await tick();
  assert.equal(p.byId("daily-tokens").value, "123456");
  assert.match(p.byId("message").textContent, /保留/);
});

test("a concurrent policy change preserves the local draft and does not retry writes", async (t) => {
  const p = await page((path, options) =>
    options.method === "PUT"
      ? response({ error: { code: "settings_conflict" } }, 409)
      : response(fixture()),
  );
  t.after(() => p.dom.window.close());
  p.change("daily-tokens", "123456");
  p.submit("settings-form");
  await tick();
  assert.equal(p.byId("daily-tokens").value, "123456");
  assert.match(p.byId("save-result").textContent, /修改已保留/);
  assert.equal(
    p.calls.filter((call) => call.options.method === "PUT").length,
    1,
  );
  assert.equal(
    p.calls.filter((call) => call.path === "/admin-api/public-settings").length,
    2,
  );
});

test("three-field API setup clears the key immediately and only stages public opening", async (t) => {
  let resolveTest;
  let apiPayload;
  const data = fixture();
  const p = await page((path, options) => {
    if (path === "/admin-api/upstream") {
      apiPayload = JSON.parse(options.body);
      return new Promise((resolve) => {
        resolveTest = resolve;
      });
    }
    return response(data);
  });
  t.after(() => p.dom.window.close());
  p.change("daily-tokens", "222222");
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "secret-upstream-key");
  await prepareModels(p);
  p.submit("upstream-form");
  assert.equal(p.byId("upstream-key").value, "");
  assert.equal(p.byId("upstream-submit").disabled, true);
  assert.equal(apiPayload.apiKey, "secret-upstream-key");
  assert.deepEqual(apiPayload.modelIds, ["glm-5.3-flash"]);
  resolveTest(
    response({
      success: true,
      channel: data.channels[0],
      test: { model: "glm-5.3-flash", success: true },
      message: "通过",
    }),
  );
  await tick();
  assert.equal(p.byId("daily-tokens").value, "222222");
  assert.equal(p.byId("upstream-key").value, "");
  assert.equal(p.byId("model-options").querySelector("input").checked, true);
  assert.equal(p.byId("enabled").checked, true);
  assert.equal(p.byId("mode-permanent").checked, true);
  assert.equal(p.byId("available-until").value, "");
  assert.match(p.byId("save").textContent, /保存并开放/);
  assert.equal(
    p.calls.some((call) => call.options.method === "PUT"),
    false,
  );
  assert.equal(
    p.dom.window.document.body.textContent.includes("secret-upstream-key"),
    false,
  );
});

test("failed API testing keeps existing public selections and clears the key", async (t) => {
  const p = await page((path) =>
    path === "/admin-api/upstream"
      ? response({
          success: false,
          channel: null,
          test: { success: false },
          message: "上游认证失败",
        })
      : response(fixture()),
  );
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "not-a-valid-key");
  await prepareModels(p);
  p.submit("upstream-form");
  await tick();
  assert.equal(p.byId("upstream-key").value, "");
  assert.match(p.byId("upstream-result").textContent, /上游认证失败/);
  assert.equal(p.byId("model-options").querySelector("input").checked, false);
  assert.equal(p.byId("enabled").checked, false);
});

function host(initial) {
  const dom = new JSDOM(
    "<!doctype html><body><a id='login' href='/sign-in'>登录</a></body>",
    { url: "https://relay.example" + initial },
  );
  let current = new URL(dom.window.location.href);
  const destinations = [];
  const location = {
    get href() {
      return current.href;
    },
    get origin() {
      return current.origin;
    },
    get pathname() {
      return current.pathname;
    },
    replace(value) {
      destinations.push(value);
    },
    assign(value) {
      destinations.push(value);
    },
  };
  const history = Object.fromEntries(
    ["pushState", "replaceState"].map((method) => [
      method,
      (_state, _unused, value) => {
        if (value) current = new URL(value, current);
      },
    ]),
  );
  const context = vm.createContext({
    document: dom.window.document,
    window: dom.window,
    location,
    history,
    URL,
    Event: dom.window.Event,
  });
  vm.runInContext(hostScript, context);
  return { dom, destinations, history };
}

test("administrator SPA login redirects preserve admin intent and expose a simple settings shortcut", (t) => {
  const p = host("/channels");
  t.after(() => p.dom.window.close());
  const toolbar = p.dom.window.document.getElementById("relay-admin-shortcuts");
  assert.equal(toolbar.hidden, false);
  assert.equal(
    toolbar.querySelector('a[href="/public-models-admin"]').textContent,
    "简易后台",
  );
  p.history.replaceState({}, "", "/sign-in?redirect=%2Fchannels");
  assert.equal(p.destinations.at(-1), "/sign-in?redirect=%2Fchannels&admin=1");
});

test("explicit administrator destinations stay native while ordinary login stays on the account page", (t) => {
  const admin = host("/sign-in?redirect=%2Fchannels");
  const ordinary = host("/sign-in");
  const external = host(
    "/sign-in?redirect=https%3A%2F%2Fother.example%2Fchannels",
  );
  t.after(() => {
    admin.dom.window.close();
    ordinary.dom.window.close();
    external.dom.window.close();
  });
  assert.equal(admin.destinations[0], "/sign-in?redirect=%2Fchannels&admin=1");
  assert.equal(ordinary.destinations[0], "/account");
  assert.equal(external.destinations[0], "/account");
  assert.equal(
    ordinary.dom.window.document.getElementById("relay-admin-shortcuts").hidden,
    true,
  );
});

test("the default native dashboard returns administrators to the simple console", (t) => {
  const p = host("/dashboard/overview");
  t.after(() => p.dom.window.close());
  assert.equal(p.destinations[0], "/public-models-admin");
});

test("native security, system settings, keys and usage paths keep administrator login context", (t) => {
  for (const path of [
    "/security",
    "/system-settings",
    "/keys",
    "/usage-logs",
    "/profile",
  ]) {
    const p = host(path);
    t.after(() => p.dom.window.close());
    p.history.replaceState({}, "", "/sign-in");
    assert.equal(p.destinations.at(-1), "/sign-in?admin=1", path);
  }
});

test("unknown upstream request outcomes are explicit and never automatically retried", async (t) => {
  const p = await page((path) => {
    if (path === "/admin-api/upstream")
      throw new TypeError("Network disconnected");
    return response(fixture());
  });
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "not-a-valid-key");
  await prepareModels(p);
  p.submit("upstream-form");
  await tick();
  assert.equal(p.byId("upstream-key").value, "");
  assert.match(p.byId("upstream-result").textContent, /结果未确认.*重新读取/);
  assert.equal(
    p.calls.filter((call) => call.path === "/admin-api/upstream").length,
    1,
  );
});

test("the homepage and account page expose the stable management entry", () => {
  const publicScript = readFileSync(
    new URL("public-account.js", portal),
    "utf8",
  );
  const accountHtml = readFileSync(new URL("account.html", portal), "utf8");
  assert.match(publicScript, /管理后台[\s\S]{0,12}\/admin/);
  const dom = new JSDOM(accountHtml);
  assert.equal(
    dom.window.document.querySelector('header a[href="/admin"]').textContent,
    "管理后台",
  );
  dom.window.close();
});

test("a failed public settings read does not lock the authenticated API form", async (t) => {
  const p = await page(() =>
    response({ error: { message: "额度服务暂时不可用" } }, 500),
  );
  t.after(() => p.dom.window.close());
  assert.equal(p.byId("upstream-panel").hidden, false);
  assert.equal(p.byId("upstream-fields").disabled, false);
  assert.match(p.byId("message").textContent, /额度服务暂时不可用/);
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "test-key");
  await prepareModels(p);
  assert.equal(p.byId("upstream-submit").disabled, false);
  assert.equal(p.byId("save").disabled, true);
});

test("preset search fills the exact local preset URL and protocol", async (t) => {
  const p = await page();
  t.after(() => p.dom.window.close());
  p.change("preset-search", "Anthropic");
  const buttons = p.byId("preset-options").querySelectorAll("button");
  assert.equal(buttons.length, 2);
  p.byId("preset-options")
    .querySelector('[data-preset-id="anthropic"]')
    .click();
  assert.equal(p.byId("upstream-url").value, "https://api.anthropic.com");
  assert.equal(p.byId("upstream-protocol").value, "anthropic");
  assert.equal(p.byId("upstream-name").value, "Anthropic");
  assert.equal(p.byId("upstream-key").value, "");
});

test("address and Key changes automatically fetch models after the debounce without clearing Key", async (t) => {
  const p = await page();
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "test-key");
  assert.equal(
    p.calls.some((call) => call.path === "/admin-api/upstream/models"),
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 660));
  const calls = p.calls.filter(
    (call) => call.path === "/admin-api/upstream/models",
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-key",
    protocol: "openai_chat",
  });
  assert.equal(p.byId("upstream-key").value, "test-key");
  assert.match(p.byId("discovery-result").textContent, /获取 1 个模型/);
  assert.equal(
    p.calls.some((call) => call.path === "/admin-api/upstream"),
    false,
  );
});

test("a canceled model response cannot overwrite the newer key's model list", async (t) => {
  let oldResponse;
  let count = 0;
  const p = await page(undefined, {
    discover: () => {
      count += 1;
      return count === 1
        ? new Promise((resolve) => {
            oldResponse = resolve;
          })
        : response({
            ...modelFixture,
            models: [{ id: "new/model", name: "New Model" }],
          });
    },
  });
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "old-key");
  p.byId("discover-models").click();
  await tick();
  const firstCall = p.calls.find(
    (call) => call.path === "/admin-api/upstream/models",
  );
  assert.equal(p.byId("upstream-fields").disabled, false);
  p.change("upstream-key", "new-key");
  assert.equal(firstCall.options.signal.aborted, true);
  p.byId("discover-models").click();
  await tick();
  oldResponse(
    response({
      ...modelFixture,
      models: [{ id: "old/model", name: "Old Model" }],
    }),
  );
  await tick();
  assert.match(p.byId("upstream-model-options").textContent, /New Model/);
  assert.doesNotMatch(
    p.byId("upstream-model-options").textContent,
    /Old Model/,
  );
});

test("model search and bulk selection save the exact API IDs and requested protocol", async (t) => {
  let saved;
  const p = await page(
    (path, options) => {
      if (path === "/admin-api/upstream") {
        saved = JSON.parse(options.body);
        return response({
          success: false,
          test: { success: false },
          message: "测试结束",
        });
      }
      return response(fixture());
    },
    {
      discover: () =>
        response({
          ...modelFixture,
          models: [
            { id: "org/model:v1", name: "Code Model" },
            { id: "org/other:v2", name: "Other" },
          ],
        }),
    },
  );
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "test-key");
  p.byId("discover-models").click();
  await tick();
  p.change("upstream-model-search", "Code Model");
  p.byId("upstream-select-all").click();
  p.submit("upstream-form");
  await tick();
  assert.deepEqual(saved.modelIds, ["org/model:v1"]);
  assert.equal(saved.protocol, "openai_chat");
  assert.equal(saved.name, "api.example.com");
  assert.equal(p.byId("upstream-key").value, "");
});

test("invalid or autofilled usernames never trigger model fetching", async (t) => {
  const p = await page();
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "TreasureGrove");
  p.change("upstream-key", "autofilled-value");
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(
    p.calls.some((call) => call.path === "/admin-api/upstream/models"),
    false,
  );
  assert.equal(p.byId("discover-models").disabled, true);
  assert.match(p.byId("discovery-result").textContent, /有效的 HTTPS API 地址/);
  assert.equal(
    p.byId("upstream-key").getAttribute("autocomplete"),
    "new-password",
  );
  assert.match(p.byId("upstream-key").name, /^relay_upstream_/);
  assert.equal(p.byId("upstream-key").hasAttribute("readonly"), false);
});

test("changing the API host clears the previous host's Key before any new discovery", async (t) => {
  const p = await page();
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api-a.example/v1");
  p.change("upstream-key", "a-key");
  p.change("upstream-url", "https://api-b.example/v1");
  assert.equal(p.byId("upstream-key").value, "");
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(
    p.calls.some((call) => call.path === "/admin-api/upstream/models"),
    false,
  );
  assert.match(p.byId("discovery-result").textContent, /重新填写/);
});

test("managed channel editing requests a new Key and sends only its exact owned channel ID", async (t) => {
  const data = fixture();
  data.channels[0] = {
    ...data.channels[0],
    managed: true,
    baseUrl: "https://api.example.com/v1",
    protocol: "openai_chat",
    presetId: null,
  };
  let saved;
  const p = await page((path, options) => {
    if (path === "/admin-api/upstream") {
      saved = JSON.parse(options.body);
      return response({
        success: false,
        test: { success: false },
        message: "测试结束",
      });
    }
    return response(data);
  });
  t.after(() => p.dom.window.close());
  p.byId("saved-channels").querySelector("button").click();
  assert.equal(p.byId("upstream-name").value, "公益 API");
  assert.equal(p.byId("upstream-key").value, "");
  assert.match(p.byId("upstream-result").textContent, /重新填写 Key/);
  p.change("upstream-key", "replacement-key");
  await prepareModels(p);
  p.submit("upstream-form");
  await tick();
  assert.equal(saved.channelId, 12);
  assert.equal(saved.name, "公益 API");
});

test("API testing never overwrites public settings edited while the test was running", async (t) => {
  let finish;
  const p = await page((path) =>
    path === "/admin-api/upstream"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : response(fixture()),
  );
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "test-key");
  await prepareModels(p);
  p.submit("upstream-form");
  p.change("mode-until", true);
  p.change("mode-permanent", false);
  p.change("available-until", "2027-01-01T12:00");
  p.change("enabled", false);
  finish(
    response({
      success: true,
      channel: fixture().channels[0],
      test: { success: true },
    }),
  );
  await tick();
  assert.equal(p.byId("mode-until").checked, true);
  assert.equal(p.byId("available-until").value, "2027-01-01T12:00");
  assert.equal(p.byId("enabled").checked, false);
  assert.match(p.byId("upstream-result").textContent, /保留你刚修改/);
});

test("model-directory failures allow an explicitly marked, deduplicated manual fallback", async (t) => {
  let saved;
  const p = await page(
    (path, options) => {
      if (path === "/admin-api/upstream") {
        saved = JSON.parse(options.body);
        return response({
          success: false,
          test: { success: false },
          message: "测试结束",
        });
      }
      return response(fixture());
    },
    {
      discover: () =>
        response(
          {
            error: {
              code: "upstream_catalog_unavailable",
              message: "上游不提供模型目录",
            },
          },
          502,
        ),
    },
  );
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "test-key");
  p.byId("discover-models").click();
  await tick();
  assert.equal(p.byId("manual-models").open, true);
  assert.equal(p.byId("upstream-key").value, "test-key");
  p.change("manual-model-input", "org/a, org/b\norg/a");
  p.byId("manual-model-add").click();
  assert.match(
    p.byId("upstream-model-count").textContent,
    /0 个 API 模型.*2 个手动/,
  );
  assert.equal(
    p.byId("upstream-model-options").querySelectorAll("input:checked").length,
    2,
  );
  assert.match(p.byId("upstream-model-options").textContent, /手动填写/);
  p.submit("upstream-form");
  await tick();
  assert.deepEqual(saved.modelIds, ["org/a", "org/b"]);
});

test("manual model addition cancels in-flight discovery and rejects embedded whitespace", async (t) => {
  let finish;
  const p = await page(undefined, {
    discover: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "test-key");
  p.byId("discover-models").click();
  await tick();
  p.change("manual-model-input", "bad model");
  p.byId("manual-model-add").click();
  assert.match(p.byId("discovery-result").textContent, /不能有空白/);
  p.change("manual-model-input", "manual/model");
  p.byId("manual-model-add").click();
  finish(response(modelFixture));
  await tick();
  assert.match(p.byId("upstream-model-options").textContent, /manual\/model/);
  assert.doesNotMatch(
    p.byId("upstream-model-options").textContent,
    /GLM Flash/,
  );
  assert.equal(
    p.calls.find((call) => call.path === "/admin-api/upstream/models").options
      .signal.aborted,
    true,
  );
});

test("channel name conflicts show the backend channel message rather than a public-policy conflict", async (t) => {
  const p = await page((path) =>
    path === "/admin-api/upstream"
      ? response(
          {
            error: {
              code: "channel_name_conflict",
              message: "已有同名渠道，请编辑该渠道或修改名称",
            },
          },
          409,
        )
      : response(fixture()),
  );
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "test-key");
  await prepareModels(p);
  p.submit("upstream-form");
  await tick();
  assert.match(p.byId("upstream-result").textContent, /已有同名渠道/);
  assert.doesNotMatch(
    p.byId("upstream-result").textContent,
    /设置已被其他页面更新/,
  );
});

test("confirmed API success remains visible when the following public-settings read fails", async (t) => {
  let reads = 0;
  const added = {
    ...fixture().channels[0],
    id: 23,
    name: "已确认的新渠道",
    managed: true,
    baseUrl: "https://api.example.com/v1",
    protocol: "openai_chat",
  };
  const p = await page((path) => {
    if (path === "/admin-api/upstream")
      return response({
        success: true,
        channel: added,
        test: { success: true },
      });
    reads += 1;
    return reads === 1
      ? response(fixture())
      : response({ error: { message: "暂时无法读取" } }, 503);
  });
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "test-key");
  await prepareModels(p);
  p.submit("upstream-form");
  await tick();
  assert.match(
    p.byId("upstream-result").textContent,
    /已接入并测试通过.*暂时无法读取/,
  );
  assert.doesNotMatch(p.byId("upstream-result").textContent, /结果未确认/);
  assert.match(p.byId("saved-channels").textContent, /已确认的新渠道/);
  assert.equal(
    p.calls.filter((call) => call.path === "/admin-api/upstream").length,
    1,
  );
});

test("native channels are copied without sending an owned channel ID", async (t) => {
  const data = fixture();
  data.channels[0] = {
    ...data.channels[0],
    managed: false,
    baseUrl: "https://api.example.com/v1",
    protocol: "openai_chat",
  };
  let saved;
  const p = await page((path, options) => {
    if (path === "/admin-api/upstream") {
      saved = JSON.parse(options.body);
      return response({
        success: false,
        test: { success: false },
        message: "测试结束",
      });
    }
    return response(data);
  });
  t.after(() => p.dom.window.close());
  p.byId("saved-channels").querySelector("button").click();
  assert.match(p.byId("upstream-result").textContent, /原渠道保持不变/);
  p.change("upstream-key", "test-key");
  await prepareModels(p);
  p.submit("upstream-form");
  await tick();
  assert.equal(Object.hasOwn(saved, "channelId"), false);
});

test("the public model picker enforces its combined 128-model limit", async (t) => {
  const data = fixture();
  data.channels[0].models = Array.from({ length: 129 }, (_, i) => ({
    id: "model-" + i,
    name: "Model " + i,
  }));
  const p = await page(() => response(data));
  t.after(() => p.dom.window.close());
  for (const input of p.byId("model-options").querySelectorAll("input"))
    input.click();
  assert.equal(
    p.byId("model-options").querySelectorAll("input:checked").length,
    128,
  );
  assert.match(p.byId("save-result").textContent, /最多开放 128/);
});

test("API success only adds public models into remaining allowance slots", async (t) => {
  const data = fixture();
  data.channels[0].models = Array.from({ length: 127 }, (_, i) => ({
    id: "old-" + i,
    name: "Old " + i,
  }));
  data.settings.modelIds = data.channels[0].models.map((model) => model.id);
  data.channels.push({
    id: 24,
    name: "New API",
    enabled: true,
    models: [
      { id: "new-a", name: "New A" },
      { id: "new-b", name: "New B" },
    ],
  });
  const p = await page(
    (path) =>
      path === "/admin-api/upstream"
        ? response({
            success: true,
            channel: data.channels[1],
            test: { success: true },
          })
        : response(data),
    {
      discover: () =>
        response({ ...modelFixture, models: data.channels[1].models }),
    },
  );
  t.after(() => p.dom.window.close());
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "test-key");
  p.byId("discover-models").click();
  await tick();
  p.byId("upstream-select-all").click();
  p.submit("upstream-form");
  await tick();
  assert.equal(
    p.byId("model-options").querySelectorAll("input:checked").length,
    128,
  );
  assert.match(p.byId("upstream-result").textContent, /另有 1 个未自动勾选/);
});
