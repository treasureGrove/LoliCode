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
const accountsScript = readFileSync(
  new URL("admin-accounts.js", portal),
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
    dailyRequests: null,
    dailyTokens: 100000,
    dailyCredits: 100,
    globalDailyCredits: 1000,
    modelCreditRates: {},
    globalDailyRequests: null,
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
const accountsFixture = () => ({
  accounts: [
    {
      id: "member-1",
      username: "alice",
      displayName: "Alice",
      disabled: false,
      dailyCreditsOverride: null,
      revision: 3,
      quota: {
        creditBalance: {
          unit: "Credit",
          limit: 100,
          used: 12.345678,
          reserved: 0.000001,
          remaining: 87.654321,
          pricingRevision: 14,
          ledgerRevision: 5,
        },
      },
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
  defaultDailyCredits: 100,
  globalDailyCredits: 1000,
  globalUsage: { used: 12.345678, reserved: 0.000001, remaining: 987.654321 },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const accountRow = (p, id = "member-1") =>
  [...p.byId("accounts-list").children].find(
    (row) => row.dataset.accountId === id,
  );
const editAccount = (p, value, disabled, id = "member-1") => {
  const row = accountRow(p, id);
  const input = row.querySelector('[data-field="dailyCreditsOverride"]');
  input.value = value;
  input.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  if (disabled !== undefined) {
    const checkbox = row.querySelector('[data-field="disabled"]');
    checkbox.checked = disabled;
    checkbox.dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
  }
};
const submitAccount = (p, id = "member-1") =>
  accountRow(p, id)
    .querySelector("form")
    .dispatchEvent(
      new p.dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );

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
  const intervals = [];
  if (options.mockIntervals) {
    dom.window.setInterval = (callback, delay) => {
      const entry = {
        callback,
        delay,
        id: intervals.length + 1,
        cleared: false,
      };
      intervals.push(entry);
      return entry.id;
    };
    dom.window.clearInterval = (id) => {
      const entry = intervals.find((item) => item.id === id);
      if (entry) entry.cleared = true;
    };
    Object.defineProperty(dom.window.document, "hidden", {
      configurable: true,
      value: false,
    });
  }
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
    if (path.startsWith("/admin-api/accounts"))
      return options.accounts
        ? options.accounts(path, optionsForRequest)
        : response(accountsFixture());
    return handler(path, optionsForRequest);
  };
  // Neither the session token nor the upstream key may be written to web storage.
  dom.window.Storage.prototype.setItem = () => {
    throw new Error("Unexpected credential persistence");
  };
  dom.window.eval(accountsScript);
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
  return { dom, calls, byId, change, submit, intervals };
}

test("account administration loads its own canonical balances and retains the current default policy", async (t) => {
  const data = accountsFixture();
  data.accounts[0].quota.creditsUsed = 999;
  data.accounts[0].quota.creditsRemaining = 888;
  const p = await page(undefined, { accounts: () => response(data) });
  t.after(() => p.dom.window.close());
  const row = accountRow(p);
  assert.equal(p.byId("accounts-panel").hidden, false);
  assert.match(
    row.querySelector('[data-stat="used"]').textContent,
    /12\.35 Credit/,
  );
  assert.match(
    row.querySelector('[data-stat="reserved"]').textContent,
    /< 0\.01 Credit/,
  );
  assert.match(
    row.querySelector('[data-stat="remaining"]').textContent,
    /87\.65 Credit/,
  );
  assert.equal(
    row.querySelector('[data-field="dailyCreditsOverride"]').value,
    "",
  );
  assert.match(
    p.byId("accounts-summary").textContent,
    /100\.00 Credit.*1,000\.00 Credit/,
  );
  assert.match(p.byId("accounts-panel").textContent, /已接入中转的账号/);
  assert.equal(p.byId("accounts-prev").disabled, true);
  assert.equal(p.byId("accounts-next").disabled, true);
  assert.match(p.byId("accounts-page").textContent, /1 \/ 1 页 · 1 位用户/);
  const call = p.calls.find((call) =>
    call.path.startsWith("/admin-api/accounts?"),
  );
  assert.equal(call.path, "/admin-api/accounts?page=1&pageSize=50&q=");
  assert.equal(call.options.headers.Authorization, "Bearer test-session-token");
  assert.equal(call.options.credentials, "same-origin");
  assert.equal(p.byId("daily-credits").value, "100");
  assert.equal(p.byId("global-daily-credits").value, "1000");
  assert.match(html, /admin-accounts\.js\?v=20261030-account-admin2/);
});

test("account balances require a complete canonical snapshot and only use complete flat legacy responses", async (t) => {
  for (const canonical of [null, { unit: "Credit", limit: 100, used: 1 }]) {
    const data = accountsFixture();
    data.accounts[0].quota = {
      creditBalance: canonical,
      creditLimit: 100,
      creditsUsed: 99,
      creditsReserved: 0,
      creditsRemaining: 1,
    };
    const p = await page(undefined, { accounts: () => response(data) });
    t.after(() => p.dom.window.close());
    assert.equal(
      accountRow(p).querySelector('[data-stat="used"]').textContent,
      "— Credit",
    );
    assert.equal(
      accountRow(p).querySelector('[data-stat="remaining"]').textContent,
      "— Credit",
    );
  }
  const legacy = accountsFixture();
  legacy.accounts[0].quota = {
    creditLimit: 100,
    creditsUsed: 20,
    creditsReserved: 3,
    creditsRemaining: 77,
  };
  const p = await page(undefined, { accounts: () => response(legacy) });
  t.after(() => p.dom.window.close());
  assert.equal(
    accountRow(p).querySelector('[data-stat="remaining"]').textContent,
    "77.00 Credit",
  );
});

test("user administration remains available when the independent public settings read fails", async (t) => {
  const p = await page(() =>
    response({ error: { message: "设置暂不可用" } }, 503),
  );
  t.after(() => p.dom.window.close());
  assert.ok(accountRow(p));
  assert.equal(p.byId("accounts-panel").hidden, false);
  assert.equal(p.byId("accounts-reload").disabled, false);
  assert.equal(p.byId("upstream-fields").disabled, false);
  assert.match(p.byId("message").textContent, /设置暂不可用/);
});

test("saving one user's precise override and suspension never reloads or overwrites either main form", async (t) => {
  const data = accountsFixture();
  let written;
  const p = await page(undefined, {
    accounts: (path, options) => {
      if (options.method === "PUT") {
        written = JSON.parse(options.body);
        return response({
          account: { ...data.accounts[0], ...written, revision: 4 },
        });
      }
      return response(data);
    },
  });
  t.after(() => p.dom.window.close());
  p.change("daily-credits", "222.123456");
  p.change("upstream-name", "未保存的渠道名");
  p.change("upstream-key", "secret-draft-key");
  editAccount(p, "123.123456", true);
  submitAccount(p);
  await tick();
  assert.deepEqual(written, {
    revision: 3,
    dailyCreditsOverride: 123.123456,
    disabled: true,
  });
  assert.equal(p.byId("daily-credits").value, "222.123456");
  assert.equal(p.byId("global-daily-credits").value, "1000");
  assert.equal(p.byId("upstream-name").value, "未保存的渠道名");
  assert.equal(p.byId("upstream-key").value, "secret-draft-key");
  assert.equal(
    accountRow(p).querySelector('[data-field="dailyCreditsOverride"]').value,
    "123.123456",
  );
  assert.equal(
    accountRow(p).querySelector('[data-field="disabled"]').checked,
    true,
  );
  assert.match(accountRow(p).textContent, /已保存此用户/);
  assert.equal(
    p.calls.filter((call) => call.path === "/admin-api/public-settings").length,
    1,
  );
  assert.equal(
    p.calls.filter((call) => call.options.method === "PUT").length,
    1,
  );
  assert.equal(
    p.calls.find((call) => call.options.method === "PUT").path,
    "/admin-api/accounts/member-1",
  );
});

test("zero and a blank per-user override remain distinct and untouched six-decimal limits do not round", async (t) => {
  let account = {
    ...accountsFixture().accounts[0],
    dailyCreditsOverride: 0.123456,
  };
  const written = [];
  const p = await page(undefined, {
    accounts: (path, options) => {
      if (options.method === "PUT") {
        const payload = JSON.parse(options.body);
        written.push(payload);
        account = { ...account, ...payload, revision: account.revision + 1 };
        return response({ account });
      }
      return response({ ...accountsFixture(), accounts: [account] });
    },
  });
  t.after(() => p.dom.window.close());
  submitAccount(p);
  await tick();
  editAccount(p, "0");
  submitAccount(p);
  await tick();
  editAccount(p, "");
  submitAccount(p);
  await tick();
  assert.deepEqual(
    written.map((entry) => entry.dailyCreditsOverride),
    [0.123456, 0, null],
  );
  assert.deepEqual(
    written.map((entry) => entry.revision),
    [3, 4, 5],
  );
  assert.equal(account.disabled, false);
});

test("invalid per-user Credit overrides never issue a write", async (t) => {
  const p = await page();
  t.after(() => p.dom.window.close());
  for (const invalid of ["-1", "1000000.000001", "0.0000001", "1e3"]) {
    editAccount(p, invalid);
    submitAccount(p);
    await tick();
    assert.match(
      accountRow(p).querySelector('[role="status"]').textContent,
      /最多六位小数/,
    );
  }
  assert.equal(
    p.calls.filter((call) => call.options.method === "PUT").length,
    0,
  );
});

test("a user revision conflict preserves its draft until an explicit row reset and never automatically retries", async (t) => {
  let account = accountsFixture().accounts[0];
  let writes = 0;
  let finalPayload;
  const p = await page(undefined, {
    accounts: (path, options) => {
      if (options.method === "PUT") {
        writes += 1;
        if (writes === 1) {
          account = {
            ...account,
            revision: 4,
            dailyCreditsOverride: 77,
            disabled: false,
          };
          return response(
            { error: { code: "account_conflict", message: "stale" } },
            409,
          );
        }
        finalPayload = JSON.parse(options.body);
        return response({
          account: { ...account, ...finalPayload, revision: 5 },
        });
      }
      return response({ ...accountsFixture(), accounts: [account] });
    },
  });
  t.after(() => p.dom.window.close());
  p.change("daily-credits", "234.56");
  editAccount(p, "543.123456", true);
  submitAccount(p);
  await tick();
  assert.equal(writes, 1);
  assert.equal(
    p.calls.filter((call) => call.path.startsWith("/admin-api/accounts?"))
      .length,
    1,
  );
  assert.match(accountRow(p).textContent, /草稿已保留.*没有自动重试/);
  p.byId("accounts-reload").click();
  await tick();
  assert.equal(
    accountRow(p).querySelector('[data-field="dailyCreditsOverride"]').value,
    "543.123456",
  );
  assert.equal(
    accountRow(p).querySelector('[data-field="disabled"]').checked,
    true,
  );
  assert.equal(writes, 1);
  accountRow(p).querySelector('[data-action="reset"]').click();
  await tick();
  assert.equal(
    accountRow(p).querySelector('[data-field="dailyCreditsOverride"]').value,
    "77",
  );
  editAccount(p, "88");
  submitAccount(p);
  await tick();
  assert.equal(finalPayload.revision, 4);
  assert.equal(p.byId("daily-credits").value, "234.56");
});

test("account pagination and encoded username search preserve drafts on other pages and show empty results", async (t) => {
  const second = {
    ...accountsFixture().accounts[0],
    id: "member-2",
    username: "bob",
    displayName: "Bob",
  };
  const p = await page(undefined, {
    accounts: (path) => {
      const url = new URL(path, "https://relay.example");
      const current = Number(url.searchParams.get("page"));
      if (url.searchParams.get("q"))
        return response({ ...accountsFixture(), accounts: [], total: 0 });
      return response({
        ...accountsFixture(),
        accounts: [current === 2 ? second : accountsFixture().accounts[0]],
        total: 51,
        page: current,
      });
    },
  });
  t.after(() => p.dom.window.close());
  editAccount(p, "321.654321", true);
  assert.equal(p.byId("accounts-next").disabled, false);
  p.byId("accounts-next").click();
  await tick();
  assert.ok(accountRow(p, "member-2"));
  assert.equal(p.byId("accounts-next").disabled, true);
  p.byId("accounts-prev").click();
  await tick();
  assert.equal(
    accountRow(p).querySelector('[data-field="dailyCreditsOverride"]').value,
    "321.654321",
  );
  assert.equal(
    accountRow(p).querySelector('[data-field="disabled"]').checked,
    true,
  );
  p.change("accounts-search", "alice & <script>");
  p.submit("accounts-search-form");
  await tick();
  const last = p.calls
    .filter((call) => call.path.startsWith("/admin-api/accounts?"))
    .at(-1);
  assert.equal(
    new URL(last.path, "https://relay.example").searchParams.get("q"),
    "alice & <script>",
  );
  assert.equal(
    new URL(last.path, "https://relay.example").searchParams.get("page"),
    "1",
  );
  assert.match(p.byId("accounts-list").textContent, /未找到匹配用户/);
  assert.equal(
    p.calls.filter((call) => call.options.method === "PUT").length,
    0,
  );
});

test("a late account search cannot replace the latest result or its edits", async (t) => {
  let finishOld;
  const p = await page(undefined, {
    accounts: (path) => {
      const q = new URL(path, "https://relay.example").searchParams.get("q");
      if (q === "old")
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      const data = accountsFixture();
      if (q === "new") data.accounts[0].displayName = "最新搜索结果";
      return response(data);
    },
  });
  t.after(() => p.dom.window.close());
  p.change("accounts-search", "old");
  p.submit("accounts-search-form");
  await tick();
  p.change("accounts-search", "new");
  p.submit("accounts-search-form");
  await tick();
  editAccount(p, "456.78");
  const old = accountsFixture();
  old.accounts[0].displayName = "过期搜索结果";
  finishOld(response(old));
  await tick();
  assert.match(p.byId("accounts-list").textContent, /最新搜索结果/);
  assert.doesNotMatch(p.byId("accounts-list").textContent, /过期搜索结果/);
  assert.equal(
    accountRow(p).querySelector('[data-field="dailyCreditsOverride"]').value,
    "456.78",
  );
});

test("account refreshes and explicit resets never erase edits made after their request started", async (t) => {
  let finishRead;
  let reads = 0;
  const p = await page(undefined, {
    accounts: () => {
      reads += 1;
      return reads === 1
        ? response(accountsFixture())
        : new Promise((resolve) => {
            finishRead = resolve;
          });
    },
  });
  t.after(() => p.dom.window.close());
  p.byId("accounts-reload").click();
  await tick();
  editAccount(p, "789.123456");
  finishRead(response(accountsFixture()));
  await tick();
  assert.equal(
    accountRow(p).querySelector('[data-field="dailyCreditsOverride"]').value,
    "789.123456",
  );
  accountRow(p).querySelector('[data-action="reset"]').click();
  await tick();
  editAccount(p, "789.654321");
  finishRead(response(accountsFixture()));
  await tick();
  assert.equal(
    accountRow(p).querySelector('[data-field="dailyCreditsOverride"]').value,
    "789.654321",
  );
});

test("edits made during an account save survive its response and use the confirmed revision on the next save", async (t) => {
  let finishSave;
  const writes = [];
  const p = await page(undefined, {
    accounts: (path, options) => {
      if (options.method === "PUT") {
        writes.push(JSON.parse(options.body));
        return new Promise((resolve) => {
          finishSave = resolve;
        });
      }
      return response(accountsFixture());
    },
  });
  t.after(() => p.dom.window.close());
  editAccount(p, "150");
  submitAccount(p);
  await tick();
  editAccount(p, "200.123456", true);
  finishSave(
    response({
      account: { ...accountsFixture().accounts[0], ...writes[0], revision: 4 },
    }),
  );
  await tick();
  assert.equal(
    accountRow(p).querySelector('[data-field="dailyCreditsOverride"]').value,
    "200.123456",
  );
  assert.equal(
    accountRow(p).querySelector('[data-field="disabled"]').checked,
    true,
  );
  assert.match(accountRow(p).textContent, /刚修改的输入仍保留/);
  submitAccount(p);
  await tick();
  assert.deepEqual(writes[1], {
    revision: 4,
    dailyCreditsOverride: 200.123456,
    disabled: true,
  });
  finishSave(
    response({
      account: { ...accountsFixture().accounts[0], ...writes[1], revision: 5 },
    }),
  );
  await tick();
});

test("root-only account access failures stay local and do not disable ordinary administrator settings", async (t) => {
  const p = await page(undefined, {
    accounts: () => response({ error: { code: "root_required" } }, 403),
  });
  t.after(() => p.dom.window.close());
  assert.equal(p.byId("accounts-panel").hidden, false);
  assert.match(p.byId("accounts-message").textContent, /需站长权限/);
  assert.equal(p.byId("accounts-list").children.length, 0);
  assert.equal(p.byId("accounts-search").disabled, true);
  assert.equal(p.byId("login-panel").hidden, true);
  assert.equal(p.byId("settings-fields").disabled, false);
  assert.equal(p.byId("upstream-fields").disabled, false);
  assert.equal(p.byId("save").disabled, false);
});

test("account permission loss and expired sessions discard sensitive rows without applying late writes", async (t) => {
  let finishSave;
  let expired = false;
  const p = await page(undefined, {
    accounts: (path, options) => {
      if (options.method === "PUT")
        return new Promise((resolve) => {
          finishSave = resolve;
        });
      return expired
        ? response({ error: { code: "unauthorized" } }, 401)
        : response(accountsFixture());
    },
  });
  t.after(() => p.dom.window.close());
  editAccount(p, "600");
  submitAccount(p);
  await tick();
  expired = true;
  p.byId("accounts-reload").click();
  await tick();
  assert.equal(p.byId("accounts-panel").hidden, true);
  assert.equal(p.byId("accounts-list").children.length, 0);
  assert.equal(p.byId("login-panel").hidden, false);
  assert.equal(p.byId("save").disabled, true);
  finishSave(
    response({
      account: {
        ...accountsFixture().accounts[0],
        dailyCreditsOverride: 600,
        revision: 4,
      },
    }),
  );
  await tick();
  assert.equal(p.byId("accounts-list").children.length, 0);
});

test("account read failures leave existing drafts editable and independent settings available", async (t) => {
  let failed = false;
  const p = await page(undefined, {
    accounts: () =>
      failed
        ? response({ error: { message: "暂时不可用" } }, 503)
        : response(accountsFixture()),
  });
  t.after(() => p.dom.window.close());
  editAccount(p, "123.456789");
  failed = true;
  p.byId("accounts-reload").click();
  await tick();
  assert.match(p.byId("accounts-message").textContent, /暂时不可用/);
  assert.equal(
    accountRow(p).querySelector('[data-field="dailyCreditsOverride"]').value,
    "123.456789",
  );
  assert.equal(p.byId("accounts-reload").disabled, false);
  assert.equal(p.byId("settings-fields").disabled, false);
  assert.equal(p.byId("daily-credits").value, "100");
});

test("account names and IDs render as text, path IDs are encoded, and unlimited pools are explicit", async (t) => {
  const data = accountsFixture();
  const id = "user/1?x=<script>";
  data.accounts[0] = {
    ...data.accounts[0],
    id,
    username: '<img src=x onerror="evil()">',
    displayName: "<script>evil()</script>",
  };
  data.globalDailyCredits = null;
  data.globalUsage.remaining = null;
  let writtenPath;
  const p = await page(undefined, {
    accounts: (path, options) => {
      if (options.method === "PUT") {
        writtenPath = path;
        return response({
          account: {
            ...data.accounts[0],
            ...JSON.parse(options.body),
            revision: 4,
          },
        });
      }
      return response(data);
    },
  });
  t.after(() => p.dom.window.close());
  assert.match(p.byId("accounts-list").textContent, /<img src=x/);
  assert.match(
    p.byId("accounts-list").textContent,
    /<script>evil\(\)<\/script>/,
  );
  assert.equal(
    p.byId("accounts-list").querySelectorAll("img,script").length,
    0,
  );
  assert.match(
    p.byId("accounts-summary").textContent,
    /全站每日 不限.*剩余 不限/,
  );
  editAccount(p, "500", false, id);
  submitAccount(p, id);
  await tick();
  assert.equal(writtenPath, `/admin-api/accounts/${encodeURIComponent(id)}`);
});

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
  assert.equal(p.byId("daily-credits").value, "100");
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
    p.calls.filter(
      (call) =>
        call.path !== "/relay-assets/channel-presets.json" &&
        !call.path.startsWith("/admin-api/accounts"),
    ).length,
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
  p.change("global-daily-credits", "");
  p.submit("settings-form");
  await tick();
  assert.equal(written.revision, 7);
  assert.equal(written.enabled, true);
  assert.deepEqual(written.modelIds, ["glm-5.3-flash"]);
  assert.equal(written.dailyRequests, null);
  assert.equal(written.globalDailyRequests, null);
  assert.equal(written.dailyCredits, 100);
  assert.equal(written.globalDailyCredits, null);
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
  p.change("daily-credits", "123456");
  resolveRead(
    response({
      ...fixture(),
      settings: { ...fixture().settings, dailyCredits: 999999 },
    }),
  );
  await tick();
  assert.equal(p.byId("daily-credits").value, "123456");
  assert.match(p.byId("message").textContent, /保留/);
});

test("a concurrent policy change preserves the local draft and does not retry writes", async (t) => {
  const p = await page((path, options) =>
    options.method === "PUT"
      ? response({ error: { code: "settings_conflict" } }, 409)
      : response(fixture()),
  );
  t.after(() => p.dom.window.close());
  p.change("daily-credits", "123456");
  p.submit("settings-form");
  await tick();
  assert.equal(p.byId("daily-credits").value, "123456");
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
  p.change("daily-credits", "222222");
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
  assert.equal(p.byId("daily-credits").value, "222222");
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

test("Credit settings and distinct model rates round-trip with six-decimal precision", async (t) => {
  const data = fixture();
  data.settings.modelIds = ["glm-5.3-flash"];
  data.settings.modelCreditRates = {
    "glm-5.3-flash": {
      input: 1.25,
      output: 4,
      cacheRead: 0.1,
      cacheWrite: 1.5,
    },
  };
  let written;
  const p = await page((path, options) => {
    if (options.method === "PUT") {
      written = JSON.parse(options.body);
      return response({ ...data, settings: { ...written, revision: 8 } });
    }
    return response(data);
  });
  t.after(() => p.dom.window.close());
  const rateInput = (key) =>
    p.byId("model-credit-rates").querySelector(`[data-rate="${key}"]`);
  assert.equal(rateInput("input").value, "1250");
  assert.equal(rateInput("cacheRead").value, "100");
  p.change("daily-credits", "123.000001");
  p.change("global-daily-credits", "0");
  rateInput("output").value = "12.345678";
  rateInput("output").dispatchEvent(
    new p.dom.window.Event("input", { bubbles: true }),
  );
  rateInput("cacheWrite").value = "0";
  rateInput("cacheWrite").dispatchEvent(
    new p.dom.window.Event("input", { bubbles: true }),
  );
  p.submit("settings-form");
  await tick();
  assert.equal(written.dailyCredits, 123.000001);
  assert.equal(written.globalDailyCredits, 0);
  assert.equal(written.dailyTokens, 100000);
  assert.equal(written.globalDailyTokens, 1000000);
  assert.deepEqual(written.modelCreditRates["glm-5.3-flash"], {
    input: 1.25,
    output: 0.01235,
    cacheRead: 0.1,
    cacheWrite: 0,
  });
  assert.equal(rateInput("output").value, "12.35");
});

test("Credit rate drafts survive deselection and channel catalog refresh", async (t) => {
  const data = fixture();
  data.settings.modelIds = ["glm-5.3-flash"];
  const p = await page((path) =>
    path === "/admin-api/upstream"
      ? response({
          success: true,
          channel: data.channels[0],
          test: { success: true },
        })
      : response(data),
  );
  t.after(() => p.dom.window.close());
  const rate = () =>
    p.byId("model-credit-rates").querySelector('[data-rate="input"]');
  rate().value = "2.75";
  rate().dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  const selected = p.byId("model-options").querySelector("input");
  selected.click();
  assert.equal(p.byId("model-credit-rates").children.length, 0);
  selected.click();
  assert.equal(rate().value, "2.75");
  p.change("upstream-url", "https://api.example.com/v1");
  p.change("upstream-key", "test-key");
  await prepareModels(p);
  p.submit("upstream-form");
  await tick();
  assert.equal(rate().value, "2.75");
});

test("legacy token allowances display as Credit without changing their stored units", async (t) => {
  const data = fixture();
  delete data.settings.dailyCredits;
  delete data.settings.globalDailyCredits;
  delete data.settings.modelCreditRates;
  const p = await page(() => response(data));
  t.after(() => p.dom.window.close());
  assert.equal(p.byId("daily-credits").value, "100");
  assert.equal(p.byId("global-daily-credits").value, "1000");
});

test("invalid Credit precision or rates cannot issue a settings write", async (t) => {
  const data = fixture();
  data.settings.modelIds = ["glm-5.3-flash"];
  const p = await page(() => response(data));
  t.after(() => p.dom.window.close());
  p.change("daily-credits", "1.0000001");
  p.submit("settings-form");
  await tick();
  assert.match(p.byId("save-result").textContent, /最多六位小数/);
  p.change("daily-credits", "100");
  const rate = p
    .byId("model-credit-rates")
    .querySelector('[data-rate="input"]');
  rate.value = "10000001";
  rate.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  p.submit("settings-form");
  await tick();
  assert.match(p.byId("save-result").textContent, /超过允许范围/);
  assert.equal(
    p.calls.filter((call) => call.options.method === "PUT").length,
    0,
  );
});

function changeControl(p, element, value) {
  element.value = value;
  element.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  element.dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
}

test("channel health distinguishes all outcomes and treats channel names and reasons as text", async (t) => {
  const data = fixture();
  const statuses = [
    "healthy",
    "failed",
    "timeout",
    "skipped",
    "unknown",
    "stale",
  ];
  const now = new Date().toISOString();
  data.channels = statuses.map((status, index) => ({
    id: index + 1,
    name: index === 1 ? '<img src=x onerror="bad()">' : `渠道 ${index + 1}`,
    enabled: true,
    models: [{ id: "model-" + index }],
  }));
  data.channelHealth = {
    intervalSeconds: 3600,
    lastRunAt: now,
    nextRunAt: new Date(Date.now() + 3600000).toISOString(),
    results: statuses.map((status, index) => ({
      channelId: index + 1,
      model: "model-" + index,
      status,
      checkedAt: now,
      latencyMs: index * 10.5,
      consecutiveFailures: status === "failed" ? 3 : 0,
      reason: index === 1 ? "<script>bad()</script>" : "样例原因",
    })),
  };
  const p = await page(() => response(data));
  t.after(() => p.dom.window.close());
  assert.equal(p.byId("channel-health-panel").hidden, false);
  for (const title of [
    "连接正常",
    "连接失败",
    "巡检超时",
    "本轮跳过",
    "尚未检测",
    "结果已过期",
  ])
    assert.ok(p.byId("channel-health-results").textContent.includes(title));
  assert.match(p.byId("channel-health-results").textContent, /10.5 ms/);
  assert.match(p.byId("channel-health-results").textContent, /连续失败 3 次/);
  assert.match(
    p.byId("channel-health-results").textContent,
    /<script>bad\(\)<\/script>/,
  );
  assert.equal(
    p.byId("channel-health-results").querySelectorAll("img,script").length,
    0,
  );
  assert.match(
    p.byId("health-refresh-note").textContent,
    /只读取结果.*不触发模型测试/,
  );
});

test("health-only polling preserves price drafts, skips hidden pages and stops after login loss", async (t) => {
  const data = fixture();
  data.settings.modelIds = ["glm-5.3-flash"];
  let expired = false;
  const p = await page(
    () =>
      expired
        ? response(
            { error: { code: "admin_required", message: "请重新登录" } },
            403,
          )
        : response(data),
    { mockIntervals: true },
  );
  t.after(() => p.dom.window.close());
  assert.equal(p.intervals.length, 1);
  assert.equal(p.intervals[0].delay, 60000);
  p.change("daily-credits", "88.5");
  const rate = () =>
    p.byId("model-credit-rates").querySelector('[data-rate="output"]');
  changeControl(p, rate(), "123.456");
  p.intervals[0].callback();
  await tick();
  assert.equal(p.byId("daily-credits").value, "88.5");
  assert.equal(rate().value, "123.46");
  const reads = () =>
    p.calls.filter((call) => call.path === "/admin-api/public-settings").length;
  assert.equal(reads(), 2);
  Object.defineProperty(p.dom.window.document, "hidden", {
    configurable: true,
    value: true,
  });
  p.intervals[0].callback();
  await tick();
  assert.equal(reads(), 2);
  Object.defineProperty(p.dom.window.document, "hidden", {
    configurable: true,
    value: false,
  });
  expired = true;
  p.intervals[0].callback();
  await tick();
  assert.equal(p.intervals[0].cleared, true);
  assert.equal(p.byId("channel-health-panel").hidden, true);
  const stopped = reads();
  p.intervals[0].callback();
  await tick();
  assert.equal(reads(), stopped);
  assert.equal(
    p.calls.some((call) => call.path.includes("/upstream")),
    false,
  );
});

test("Credit per-million editing preserves legacy per-thousand values and nine-digit rate precision", async (t) => {
  const data = fixture();
  data.settings.modelIds = ["glm-5.3-flash"];
  data.settings.modelCreditRates = {
    "glm-5.3-flash": {
      input: 1,
      output: 1,
      cacheRead: 0.000000001,
      cacheWrite: 0.125123456,
    },
  };
  const written = [];
  const p = await page((path, options) => {
    if (options.method === "PUT") {
      written.push(JSON.parse(options.body));
      return response({
        ...data,
        settings: { ...written.at(-1), revision: 8 + written.length },
      });
    }
    return response(data);
  });
  t.after(() => p.dom.window.close());
  const rate = (key) =>
    p.byId("model-credit-rates").querySelector(`[data-rate="${key}"]`);
  assert.equal(rate("input").value, "1000");
  assert.equal(rate("output").value, "1000");
  assert.equal(rate("cacheRead").value, "0.000001");
  assert.equal(rate("cacheWrite").value, "125.123456");
  assert.equal(rate("input").max, "10000000");
  assert.equal(rate("input").step, "0.01");
  assert.match(
    p.byId("model-credit-rates").textContent,
    /Credit \/ 1M（100万）token/,
  );
  p.submit("settings-form");
  await tick();
  assert.deepEqual(written[0].modelCreditRates, data.settings.modelCreditRates);
  changeControl(p, rate("input"), "125.123456");
  p.submit("settings-form");
  await tick();
  assert.equal(written[1].modelCreditRates["glm-5.3-flash"].input, 0.12512);
  assert.equal(rate("input").value, "125.12");
});

test("Credit-only settings preserve the operator's current allowances and normalize legacy daily call limits", async (t) => {
  const data = fixture();
  data.settings.revision = 14;
  data.settings.dailyRequests = 20;
  data.settings.globalDailyRequests = 200;
  data.settings.dailyCredits = 100;
  data.settings.globalDailyCredits = 1000;
  data.settings.modelIds = ["glm-5.3-flash"];
  data.settings.billingConfig = {
    currency: "CNY",
    creditsPerUnit: 100,
    modelPrices: {
      "glm-5.3-flash": {
        mode: "tokens",
        prices: { input: 3.3, output: 22, cacheRead: 0.66, cacheWrite: 4.125 },
      },
    },
  };
  let written;
  const p = await page((path, options) => {
    if (options.method === "PUT") {
      written = JSON.parse(options.body);
      return response({ ...data, settings: { ...written, revision: 15 } });
    }
    return response(data);
  });
  t.after(() => p.dom.window.close());
  assert.equal(p.byId("daily-requests"), null);
  assert.equal(p.byId("global-daily-requests"), null);
  assert.ok(p.byId("max-concurrent-per-account"));
  assert.ok(p.byId("max-concurrent-global"));
  assert.ok(p.byId("global-requests-per-minute"));
  assert.equal(p.byId("daily-credits").value, "100");
  assert.equal(p.byId("global-daily-credits").value, "1000");
  p.submit("settings-form");
  await tick();
  assert.equal(written.revision, 14);
  assert.equal(written.dailyRequests, null);
  assert.equal(written.globalDailyRequests, null);
  assert.equal(written.dailyCredits, 100);
  assert.equal(written.globalDailyCredits, 1000);
  assert.equal(
    written.maxConcurrentPerAccount,
    data.settings.maxConcurrentPerAccount,
  );
  assert.equal(written.maxConcurrentGlobal, data.settings.maxConcurrentGlobal);
  assert.equal(
    written.globalRequestsPerMinute,
    data.settings.globalRequestsPerMinute,
  );
  assert.deepEqual(written.billingConfig, {
    currency: "CNY",
    creditsPerUnit: 100,
    modelPrices: {},
  });
  assert.equal(written.modelCreditRates["glm-5.3-flash"].input, 0.33);
  assert.equal(written.modelCreditRates["glm-5.3-flash"].output, 2.2);
  assert.equal(p.byId("daily-credits").value, "100");
  assert.equal(p.byId("global-daily-credits").value, "1000");
});

test("the RMB reference assistant previews fixed 100 Credit per yuan plus markup and applies only on click", async (t) => {
  const data = fixture();
  data.settings.modelIds = ["glm-5.3-flash"];
  let written;
  const p = await page((path, options) => {
    if (options.method === "PUT") {
      written = JSON.parse(options.body);
      return response({ ...data, settings: { ...written, revision: 8 } });
    }
    return response(data);
  });
  t.after(() => p.dom.window.close());
  const container = p.byId("model-credit-rates");
  const rate = (key) => container.querySelector(`[data-rate="${key}"]`);
  const reference = (key) =>
    container.querySelector(`[data-reference-price="${key}"]`);
  assert.equal(p.byId("billing-currency"), null);
  assert.equal(p.byId("billing-credits-per-unit"), null);
  assert.equal(container.querySelector("select"), null);
  assert.equal(container.querySelector("[data-reference-markup]").value, "10");
  for (const [key, value] of Object.entries({
    input: "2",
    output: "8",
    cacheRead: "0.04",
    cacheWrite: "2",
  }))
    changeControl(p, reference(key), value);
  assert.match(
    container.querySelector(".reference-preview").textContent,
    /× 100.*10%.*输入 220.00.*输出 880.00.*缓存读取 4.40/,
  );
  assert.equal(rate("input").value, "1000");
  assert.equal(
    p.calls.filter((call) => call.options.method === "PUT").length,
    0,
  );
  container.querySelector("[data-apply-reference]").click();
  assert.equal(rate("input").value, "220.00");
  assert.equal(rate("output").value, "880.00");
  assert.equal(rate("cacheRead").value, "4.40");
  assert.match(p.byId("save-result").textContent, /尚未保存/);
  p.submit("settings-form");
  await tick();
  assert.deepEqual(written.modelCreditRates["glm-5.3-flash"], {
    input: 0.22,
    output: 0.88,
    cacheRead: 0.0044,
    cacheWrite: 0.22,
  });
  assert.deepEqual(written.billingConfig, {
    currency: "CNY",
    creditsPerUnit: 100,
    modelPrices: {},
  });
  assert.equal(written.dailyCredits, 100);
  assert.equal(written.globalDailyCredits, 1000);
});

test("reference drafts survive reselection and nonzero quotes cannot round into free prices", async (t) => {
  const data = fixture();
  data.settings.modelIds = ["glm-5.3-flash"];
  const p = await page(() => response(data));
  t.after(() => p.dom.window.close());
  const container = p.byId("model-credit-rates");
  const reference = (key) =>
    container.querySelector(`[data-reference-price="${key}"]`);
  for (const key of ["input", "output", "cacheRead", "cacheWrite"])
    changeControl(p, reference(key), "0");
  changeControl(p, reference("input"), "0.000001");
  container.querySelector("[data-apply-reference]").click();
  assert.match(p.byId("save-result").textContent, /保留两位会变成 0/);
  assert.equal(container.querySelector('[data-rate="input"]').value, "1000");
  p.byId("model-options").querySelector("input").click();
  p.byId("model-options").querySelector("input").click();
  assert.equal(reference("input").value, "0.000001");
  changeControl(p, container.querySelector('[data-rate="input"]'), "0.004");
  p.submit("settings-form");
  await tick();
  assert.match(p.byId("save-result").textContent, /非零报价.*0/);
  assert.equal(
    p.calls.filter((call) => call.options.method === "PUT").length,
    0,
  );
  changeControl(p, container.querySelector('[data-rate="input"]'), "0.005");
  assert.equal(container.querySelector('[data-rate="input"]').value, "0.01");
});

test("legacy monetary token quotes migrate exactly without another markup or rounding untouched prices", async (t) => {
  const data = fixture();
  data.settings.modelIds = ["glm-5.3-flash"];
  data.settings.billingConfig = {
    currency: "USD",
    creditsPerUnit: 100,
    modelPrices: {
      "glm-5.3-flash": {
        mode: "tokens",
        prices: {
          input: 0.123456,
          output: 2,
          cacheRead: 0.000001,
          cacheWrite: 0,
        },
      },
    },
  };
  let written;
  const p = await page((path, options) => {
    if (options.method === "PUT") {
      written = JSON.parse(options.body);
      return response({ ...data, settings: { ...written, revision: 8 } });
    }
    return response(data);
  });
  t.after(() => p.dom.window.close());
  const rate = (key) =>
    p.byId("model-credit-rates").querySelector(`[data-rate="${key}"]`);
  assert.equal(rate("input").value, "12.3456");
  assert.equal(rate("cacheRead").value, "0.0001");
  p.submit("settings-form");
  await tick();
  assert.deepEqual(written.modelCreditRates["glm-5.3-flash"], {
    input: 0.0123456,
    output: 0.2,
    cacheRead: 0.0000001,
    cacheWrite: 0,
  });
  assert.deepEqual(written.billingConfig, {
    currency: "CNY",
    creditsPerUnit: 100,
    modelPrices: {},
  });
});

test("legacy request prices and unrepresentable token quotes cannot be silently overwritten", async (t) => {
  for (const entry of [
    { mode: "request", price: 0.01 },
    {
      mode: "tokens",
      prices: { input: 0.000001, output: 1, cacheRead: 1, cacheWrite: 1 },
    },
  ]) {
    const data = fixture();
    data.settings.modelIds = ["glm-5.3-flash"];
    data.settings.billingConfig = {
      currency: "CNY",
      creditsPerUnit: entry.mode === "tokens" ? 0.000001 : 100,
      modelPrices: { "glm-5.3-flash": entry },
    };
    const p = await page(() => response(data));
    t.after(() => p.dom.window.close());
    assert.match(p.byId("model-credit-rates").textContent, /旧定价待迁移/);
    assert.equal(
      p.byId("model-credit-rates").querySelector("[data-rate]"),
      null,
    );
    p.submit("settings-form");
    await tick();
    assert.match(p.byId("save-result").textContent, /待迁移/);
    assert.equal(
      p.calls.filter((call) => call.options.method === "PUT").length,
      0,
    );
  }
});

test("deselected incompatible monetary tariffs and archived Credit tariffs survive saves and remain protected on reselection", async (t) => {
  for (const legacy of [
    {
      currency: "USD",
      creditsPerUnit: 250,
      entry: { mode: "request", price: 0.012345 },
    },
    {
      currency: "CNY",
      creditsPerUnit: 0.000001,
      entry: {
        mode: "tokens",
        prices: { input: 0.000001, output: 1, cacheRead: 1, cacheWrite: 1 },
      },
    },
  ]) {
    const data = fixture();
    data.settings.modelIds = ["glm-5.3-flash", "legacy/old"];
    const archivedRate = {
      input: 0.123456789,
      output: 2,
      cacheRead: 0.000000001,
      cacheWrite: 0.25,
    };
    data.settings.modelCreditRates = {
      "glm-5.3-flash": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      "archived/direct": archivedRate,
    };
    data.settings.billingConfig = {
      currency: legacy.currency,
      creditsPerUnit: legacy.creditsPerUnit,
      modelPrices: { "legacy/old": legacy.entry },
    };
    data.channels[0].models.push({ id: "legacy/old", name: "旧模型" });
    const writes = [];
    const p = await page((path, options) => {
      if (options.method === "PUT") {
        writes.push(JSON.parse(options.body));
        return response({
          ...data,
          settings: { ...writes.at(-1), revision: 8 },
        });
      }
      return response(data);
    });
    t.after(() => p.dom.window.close());
    const legacyCheckbox = () =>
      p.byId("model-options").querySelector('input[value="legacy/old"]');
    legacyCheckbox().click();
    p.submit("settings-form");
    await tick();
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].modelIds, ["glm-5.3-flash"]);
    assert.deepEqual(writes[0].billingConfig, data.settings.billingConfig);
    assert.deepEqual(
      writes[0].modelCreditRates["archived/direct"],
      archivedRate,
    );
    assert.deepEqual(
      writes[0].modelCreditRates["glm-5.3-flash"],
      data.settings.modelCreditRates["glm-5.3-flash"],
    );
    legacyCheckbox().click();
    assert.match(p.byId("model-credit-rates").textContent, /旧定价待迁移/);
    p.submit("settings-form");
    await tick();
    assert.equal(writes.length, 1);
    assert.match(p.byId("save-result").textContent, /旧定价待迁移/);
  }
});
