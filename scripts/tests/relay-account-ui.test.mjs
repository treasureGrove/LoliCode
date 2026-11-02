import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const portal = new URL("../../deploy/lolicode-relay/portal/", import.meta.url);
const fixture = () => ({
  account: {
    account: { displayName: "Member", username: "member" },
    quota: {
      requestLimit: Number.MAX_SAFE_INTEGER,
      requestsRemaining: Number.MAX_SAFE_INTEGER,
      requestsUnlimited: true,
      tokenLimit: 100000,
      creditLimit: 100,
      creditsUsed: 12.345678,
      creditsReserved: 3.5,
      creditsRemaining: 84.154322,
      resetsAt: "2026-10-31T00:00:00+08:00",
    },
    ready: true,
    models: [
      {
        id: "model/a",
        name: "Model A",
        creditRate: { input: 2, output: 8, cacheRead: 0.25, cacheWrite: 3 },
      },
    ],
  },
  usage: {
    plan: { name: "公益免费", currency: "CNY", billedAmount: 0 },
    today: {
      requests: 3,
      tokens: 4000,
      reservedTokens: 500,
      credits: 12.345678,
      creditsReserved: 3.5,
    },
    daily: [
      {
        day: "2026-10-30",
        requests: 3,
        tokens: 4000,
        reservedTokens: 500,
        credits: 12.345678,
        creditsReserved: 3.5,
      },
    ],
    records: [
      {
        createdAt: "2026-10-30T04:00:00Z",
        model: "model/a",
        state: "charged",
        tokens: 4000,
        reservedTokens: 0,
        credits: 12.345678,
        creditsReserved: 0,
        creditRate: { input: 2, output: 8, cacheRead: 0.25, cacheWrite: 3 },
      },
      {
        createdAt: "2026-10-30T04:01:00Z",
        model: "model/a",
        state: "pending",
        tokens: 0,
        reservedTokens: 500,
        credits: 0,
        creditsReserved: 3.5,
      },
      {
        createdAt: "2026-10-30T03:00:00Z",
        model: "model/a",
        state: "uncertain",
        tokens: 200,
        reservedTokens: 0,
        credits: 1.25,
        creditsReserved: 0,
      },
    ],
  },
});
async function page(data = fixture()) {
  const dom = new JSDOM(readFileSync(new URL("account.html", portal), "utf8"), {
    url: "https://relay.lolicode.com/account",
    runScripts: "outside-only",
  });
  dom.window.AbortSignal.timeout ??= () => undefined;
  dom.window.fetch = async (path) => ({
    ok: true,
    status: 200,
    json: async () =>
      path === "/account-api/account" ? data.account : data.usage,
  });
  dom.window.eval(readFileSync(new URL("account.js", portal), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { dom, byId: (id) => dom.window.document.getElementById(id) };
}

test("member balance and utilization use Credit independently of raw token usage", async (t) => {
  const p = await page();
  t.after(() => p.dom.window.close());
  assert.equal(p.byId("account-panel").hidden, false);
  assert.equal(p.byId("credits-remaining").textContent, "84.154322");
  assert.equal(p.byId("credits-used").textContent, "12.345678");
  assert.equal(p.byId("credits-limit").textContent, "100");
  assert.equal(p.byId("tokens-used").textContent, "4,000");
  assert.equal(p.byId("credits-progress").max, 100);
  assert.match(p.byId("reserved").textContent, /3.5 Credit.*实际用量结算/);
  assert.match(
    p.byId("models").textContent,
    /输入 2,000 \/ 输出 8,000 \/ 缓存读 250 \/ 缓存写 3,000 Credit/,
  );
  assert.match(
    p.byId("daily-chart").getAttribute("aria-label"),
    /12.345678 Credit/,
  );
  assert.match(p.byId("chart-caption").textContent, /4,000 token/);
});

test("request records distinguish settled Credit, pending reservations and uncertain billing", async (t) => {
  const p = await page();
  t.after(() => p.dom.window.close());
  const rows = p.byId("usage-records").querySelectorAll("tr");
  assert.equal(rows[0].children[3].textContent, "12.345678");
  assert.equal(rows[0].children[4].textContent, "4,000");
  assert.match(rows[0].children[3].title, /输入 2,000，输出 8,000/);
  assert.match(rows[1].children[3].textContent, /0预留 3.5/);
  assert.equal(rows[2].children[2].textContent, "待确认 · 按预留计费");
  assert.match(rows[2].querySelector(".record-state").title, /请求开始时/);
});

test("legacy member responses receive the fixed token-to-Credit conversion", async (t) => {
  const data = fixture();
  delete data.account.quota.creditLimit;
  delete data.account.quota.creditsUsed;
  delete data.account.quota.creditsReserved;
  delete data.account.quota.creditsRemaining;
  Object.assign(data.account.quota, {
    tokensUsed: 4000,
    tokensReserved: 500,
    tokensRemaining: 95500,
  });
  for (const row of [
    data.usage.today,
    ...data.usage.daily,
    ...data.usage.records,
  ]) {
    delete row.credits;
    delete row.creditsReserved;
  }
  const p = await page(data);
  t.after(() => p.dom.window.close());
  assert.equal(p.byId("credits-remaining").textContent, "95.5");
  assert.equal(p.byId("credits-used").textContent, "4");
  assert.match(p.byId("reserved").textContent, /0.5 Credit/);
});

test("a zero Credit balance keeps free-model usage visible without a false negative balance", async (t) => {
  const data = fixture();
  data.account.quota.creditLimit = 0;
  Object.assign(data.account.quota, {
    creditsUsed: 0,
    creditsReserved: 0,
    creditsRemaining: 0,
  });
  data.usage.today.credits = 0;
  data.usage.today.creditsReserved = 0;
  const p = await page(data);
  t.after(() => p.dom.window.close());
  assert.equal(p.byId("credits-remaining").textContent, "0");
  assert.equal(p.byId("credits-used").textContent, "0");
  assert.equal(p.byId("tokens-used").textContent, "4,000");
  assert.equal(p.byId("reserved").textContent, "");
});

test("the public allowance uses Credit including zero and never presents raw tokens as the balance", async (t) => {
  for (const dailyCredits of [12.345678, 0]) {
    const dom = new JSDOM(readFileSync(new URL("index.html", portal), "utf8"), {
      url: "https://relay.lolicode.com/relay-assets/index.html",
      runScripts: "outside-only",
    });
    t.after(() => dom.window.close());
    dom.window.AbortSignal.timeout ??= () => undefined;
    dom.window.fetch = async () => ({
      ok: true,
      json: async () => ({
        ready: true,
        modelCount: 1,
        dailyRequests: null,
        dailyCredits,
        limits: {
          globalDailyRequests: null,
          globalDailyCredits: 1234.5,
          maxConcurrentGlobal: 2,
        },
      }),
    });
    dom.window.eval(readFileSync(new URL("portal.js", portal), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      dom.window.document.getElementById("credit-limit").textContent,
      dailyCredits.toLocaleString("zh-CN", { maximumFractionDigits: 6 }),
    );
    assert.match(
      dom.window.document.getElementById("availability-answer").textContent,
      /1,234.5 Credit/,
    );
    assert.match(
      dom.window.document.getElementById("service-status").textContent,
      /已开放/,
    );
  }
});

test("member model pricing shows monetary usage and per-request billing without using legacy Credit rates", async (t) => {
  const data = fixture();
  data.account.models[0].billing = {
    mode: "tokens",
    currency: "USD",
    creditsPerUnit: 100,
    prices: { input: 2, output: 8, cacheRead: 0.25, cacheWrite: 3 },
    revision: 9,
  };
  data.account.models.push({
    id: "per-request",
    name: "按次模型",
    creditRate: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
    billing: {
      mode: "request",
      currency: "CNY",
      creditsPerUnit: 20,
      price: 0.012345,
      revision: 11,
    },
  });
  const p = await page(data);
  t.after(() => p.dom.window.close());
  assert.match(
    p.byId("models").textContent,
    /每 1M（100万）token：输入 200 \/ 输出 800 \/ 缓存读 25 \/ 缓存写 300 Credit/,
  );
  assert.match(p.byId("models").textContent, /旧定价待迁移.*仍按原配置结算/);
  assert.equal(p.byId("models").textContent.includes("999"), false);
  assert.equal(p.byId("credits-remaining").textContent, "84.154322");
});

test("historical monetary cost details preserve exact decimal strings and their original conversion", async (t) => {
  const data = fixture();
  data.usage.records[0].costDetails = {
    currency: "USD",
    amount: "0.000000123456789",
    basis: "usage",
    mode: "tokens",
    creditsPerUnit: 123.456789,
  };
  data.usage.records[2].costDetails = {
    currency: "CNY",
    amount: "0.01",
    basis: "reservation",
    mode: "tokens",
    creditsPerUnit: 10,
  };
  const p = await page(data);
  t.after(() => p.dom.window.close());
  const rows = p.byId("usage-records").querySelectorAll("tr");
  assert.match(
    rows[0].children[3].textContent,
    /实际用量 0.000000123456789 USD/,
  );
  assert.match(rows[0].children[3].title, /1 USD = 123.456789 Credit/);
  assert.equal(
    rows[0].children[3].title.includes("Credit / 1M（100万）token"),
    false,
  );
  assert.match(rows[2].children[3].textContent, /按预留计费 0.01 CNY/);
});

test("per-request charge details and suspicious monetary strings remain plain text", async (t) => {
  const data = fixture();
  data.usage.records[0].costDetails = {
    currency: "USD",
    amount: "<img src=x onerror=bad()>",
    basis: "request",
    mode: "request",
    creditsPerUnit: 100,
  };
  const p = await page(data);
  t.after(() => p.dom.window.close());
  assert.match(
    p.byId("usage-records").textContent,
    /按次计费 <img src=x onerror=bad\(\)> USD/,
  );
  assert.equal(
    p.byId("usage-records").querySelectorAll("img,script").length,
    0,
  );
});

test("legacy Credit billing snapshots display per million tokens without changing balances", async (t) => {
  const data = fixture();
  data.account.models[0].billing = {
    mode: "credits",
    rate: {
      input: 0.125123456,
      output: 1,
      cacheRead: 0.000000001,
      cacheWrite: 0,
    },
  };
  const p = await page(data);
  t.after(() => p.dom.window.close());
  assert.match(
    p.byId("models").textContent,
    /每 1M（100万）token：输入 125.123456 \/ 输出 1,000 \/ 缓存读 0.000001 \/ 缓存写 0 Credit/,
  );
  assert.equal(p.byId("credits-used").textContent, "12.345678");
  assert.equal(p.byId("credits-remaining").textContent, "84.154322");
  assert.match(
    p.byId("usage-records").querySelector("tr").children[3].title,
    /Credit \/ 1M（100万）token/,
  );
});

test("member request counts remain statistics and never expose old limits or compatibility sentinels", async (t) => {
  for (const limit of [20, null, undefined, Number.MAX_SAFE_INTEGER]) {
    const data = fixture();
    if (limit === undefined) delete data.account.quota.requestLimit;
    else data.account.quota.requestLimit = limit;
    const p = await page(data);
    t.after(() => p.dom.window.close());
    assert.equal(p.byId("account-panel").hidden, false);
    assert.equal(p.byId("requests-used").textContent, "3");
    assert.equal(p.byId("requests-remaining"), null);
    assert.equal(p.byId("requests-progress"), null);
    assert.equal(p.byId("requests-limit"), null);
    assert.equal(p.byId("credits-remaining").textContent, "84.154322");
    assert.equal(
      p.byId("account-panel").textContent.includes("9007199254740991"),
      false,
    );
    assert.equal(
      p.byId("account-panel").textContent.includes("9,007,199,254,740,991"),
      false,
    );
    assert.match(p.byId("account-panel").textContent, /不设每日调用次数上限/);
  }
});

test("the public Credit-only page accepts absent call limits and explicit unlimited Credit pools", async (t) => {
  const dom = new JSDOM(readFileSync(new URL("index.html", portal), "utf8"), {
    url: "https://relay.lolicode.com/relay-assets/index.html",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  dom.window.AbortSignal.timeout ??= () => undefined;
  dom.window.fetch = async () => ({
    ok: true,
    json: async () => ({
      ready: true,
      modelCount: 2,
      dailyCredits: 100,
      limits: {
        globalDailyCredits: null,
        globalDailyTokens: 1000000,
        maxConcurrentGlobal: 5,
        globalRequestsPerMinute: 30,
      },
    }),
  });
  dom.window.eval(readFileSync(new URL("portal.js", portal), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dom.window.document.getElementById("request-limit"), null);
  assert.equal(
    dom.window.document.getElementById("credit-limit").textContent,
    "100",
  );
  assert.match(
    dom.window.document.getElementById("service-status").textContent,
    /已开放/,
  );
  const answer = dom.window.document.getElementById(
    "availability-answer",
  ).textContent;
  assert.match(answer, /最多同时处理 5 个请求/);
  assert.match(answer, /每分钟最多 30 次调用/);
  assert.equal(answer.includes("全站每日共用"), false);
  assert.match(dom.window.document.body.textContent, /不设每日调用次数上限/);
  assert.equal(
    dom.window.document.body.textContent.includes("请求次数另有限制"),
    false,
  );
});

test("canonical Credit balances override conflicting flat quotas and a separate usage snapshot", async (t) => {
  const data = fixture();
  data.account.quota.creditBalance = {
    unit: "Credit",
    limit: 50,
    used: 7,
    reserved: 1,
    remaining: 42,
    pricingRevision: 18,
    ledgerRevision: 27,
  };
  data.usage.today.credits = 999;
  data.usage.today.creditsReserved = 999;
  const p = await page(data);
  t.after(() => p.dom.window.close());
  assert.equal(p.byId("credits-limit").textContent, "50");
  assert.equal(p.byId("credits-used").textContent, "7");
  assert.equal(p.byId("credits-remaining").textContent, "42");
  assert.equal(p.byId("credits-progress").max, 50);
  assert.equal(p.byId("credits-progress").value, 42);
  assert.match(p.byId("reserved").textContent, /预留 1 Credit/);
  assert.equal(p.byId("account-panel").dataset.pricingRevision, "18");
  assert.equal(p.byId("account-panel").dataset.ledgerRevision, "27");
});

test("flat compatibility uses its complete balance instead of recomputing from usage", async (t) => {
  const data = fixture();
  Object.assign(data.account.quota, {
    creditLimit: 100,
    creditsUsed: 20,
    creditsReserved: 5,
    creditsRemaining: 75,
  });
  data.usage.today.credits = 99;
  data.usage.today.creditsReserved = 99;
  const p = await page(data);
  t.after(() => p.dom.window.close());
  assert.equal(p.byId("credits-used").textContent, "20");
  assert.equal(p.byId("credits-remaining").textContent, "75");
  assert.match(p.byId("reserved").textContent, /预留 5 Credit/);
});

test("incomplete canonical or flat balances are rejected without mixing generations", async (t) => {
  for (const malformedCanonical of [true, false]) {
    const data = fixture();
    if (malformedCanonical)
      data.account.quota.creditBalance = {
        unit: "Credit",
        limit: 100,
        used: 2,
        reserved: 1,
      };
    else delete data.account.quota.creditsRemaining;
    const p = await page(data);
    t.after(() => p.dom.window.close());
    assert.equal(p.byId("account-panel").hidden, true);
    assert.match(p.byId("message").textContent, /Credit 余额/);
  }
});
