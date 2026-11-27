import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { translateReasoning } from "../host-reasoning-translation.mjs";

async function translationFixture(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      body: Buffer.concat(chunks).toString("utf8"),
      contentType: request.headers["content-type"],
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
    if (request.url === "/unavailable") {
      response.writeHead(503).end();
    } else {
      const result =
        request.url === "/google"
          ? [[["範例文件。", "Sample file."]], null, "en"]
          : [{ translations: [{ text: "範例文件。" }] }];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    }
  });
  server.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  return { requests, origin: `http://127.0.0.1:${server.address().port}` };
}

test("uses the pinned Bing translator when chosen or omitted", async (t) => {
  const { requests, origin } = await translationFixture(t);
  const fragment = "Sample file.";
  const request = { text: fragment, targetLanguage: "zh-TW" };
  const endpoints = {
    bingEndpoint: `${origin}/bing`,
    googleEndpoint: `${origin}/google`,
  };
  assert.equal(await translateReasoning(request, endpoints), "範例文件。");
  assert.equal(
    await translateReasoning({ ...request, provider: "bing" }, endpoints),
    "範例文件。",
  );
  const bingRequest = {
    method: "POST",
    url: "/bing?to=zh-Hant&isEnterpriseClient=false",
    body: JSON.stringify([fragment]),
    contentType: "application/json",
    cookie: undefined,
    authorization: undefined,
  };
  assert.deepEqual(requests, [bingRequest, bingRequest]);
});

test("uses the pinned Google translator without falling back to Bing", async (t) => {
  const { requests, origin } = await translationFixture(t);
  const request = {
    text: "Sample file & window?",
    targetLanguage: "zh-TW",
    provider: "google",
  };
  const endpoints = {
    googleEndpoint: `${origin}/google`,
    bingEndpoint: `${origin}/bing`,
  };
  assert.equal(await translateReasoning(request, endpoints), "範例文件。");
  await assert.rejects(
    translateReasoning(request, {
      ...endpoints,
      googleEndpoint: `${origin}/unavailable`,
    }),
    { code: "TRANSLATION_HTTP_ERROR" },
  );
  assert.deepEqual(
    requests,
    ["/google", "/unavailable"].map((url) => ({
      method: "POST",
      url,
      body: "client=gtx&sl=auto&tl=zh-TW&dt=t&q=Sample+file+%26+window%3F",
      contentType: "application/x-www-form-urlencoded",
      cookie: undefined,
      authorization: undefined,
    })),
  );
});

test("rejects invalid requests with a fixed diagnostic and no stdout", () => {
  const entry = fileURLToPath(
    new URL("../host-reasoning-translation.mjs", import.meta.url),
  );
  for (const input of [
    "{not-json",
    " ".repeat(32 * 1024 + 1),
    JSON.stringify({ text: "x".repeat(4_001), targetLanguage: "zh-CN" }),
    JSON.stringify({ text: " ", targetLanguage: "zh-CN" }),
    JSON.stringify({ text: "Sample.", targetLanguage: "unlisted" }),
    JSON.stringify({ text: "Sample.", targetLanguage: "en", sessionId: "x" }),
    JSON.stringify({ text: "Sample.", targetLanguage: "en", provider: null }),
    JSON.stringify({
      text: "Sample.",
      targetLanguage: "en",
      provider: "Google",
    }),
    JSON.stringify({
      text: "Sample.",
      targetLanguage: "en",
      provider: "deepseek-flash",
    }),
    JSON.stringify({
      text: "Sample.",
      targetLanguage: "en",
      provider: "google",
      googleEndpoint: "http://127.0.0.1/",
    }),
  ]) {
    const result = spawnSync(process.execPath, [entry], {
      encoding: "utf8",
      input,
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "LOLICODE_TRANSLATION_INVALID_REQUEST\n");
  }
});
