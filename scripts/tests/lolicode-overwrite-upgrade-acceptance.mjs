// Run from an elevated Windows shell using Node 24:
// node scripts/tests/lolicode-overwrite-upgrade-acceptance.mjs <published-1.0.6.exe> [local-4.1.7-setup.exe]
// A baseline-only run rehearses the released installer and old transcript creation.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [baseline, candidate, ...extra] = process.argv.slice(2);
if (process.platform !== "win32" || !baseline || extra.length) {
  throw new Error(
    "Pass the published Windows v1.0.6 installer and optional local candidate",
  );
}
const expectedHarnessVersion = candidate
  ? JSON.parse(
      await readFile(
        new URL("../../packages/lolicode-harness-runtime/package.json", import.meta.url),
        "utf8",
      ),
    ).dependencies["@deepseek-ai/dsh"]
  : undefined;
if (candidate) assert.match(expectedHarnessVersion, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
const powershell = path.join(
  process.env.WINDIR,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const powershellEnvironment = {
  ...process.env,
  PSModulePath: path.join(path.dirname(powershell), "Modules"),
};
const knownFolders = spawnSync(
  powershell,
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Environment]::GetFolderPath('CommonDocuments'); if (Get-Process -Name 'LoliCode' -ErrorAction SilentlyContinue) { exit 90 }",
  ],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(
  knownFolders.status,
  0,
  "Close any running stable LoliCode instance before this test",
);

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
const baselineHash =
  "e21021377ea8284eb00f73d297700644db76dd41bc93de7d3290833678b018b9";
assert.equal(
  await sha256(baseline),
  baselineHash,
  "The baseline must be the published v1.0.6 installer",
);

const stage = path.join(
  knownFolders.stdout.trim(),
  `LoliCodeUpgrade-${randomUUID().replaceAll("-", "").slice(0, 10)}`,
);
await mkdir(stage);
const accountScript = path.join(stage, "isolated-account.ps1");
await copyFile(
  fileURLToPath(
    new URL("./lolicode-overwrite-upgrade-account.ps1", import.meta.url),
  ),
  accountScript,
);
await copyFile(baseline, path.join(stage, "baseline.exe"));
if (candidate) await copyFile(candidate, path.join(stage, "candidate.exe"));
console.log(`Isolated Windows upgrade evidence: ${stage}`);

const fixture = {
  model: "upgrade-fixture-model",
  key: "lolicode-synthetic-upgrade-channel-key",
  channel: "upgrade-fixture-channel",
  priorPrompt:
    "LOLICODE_OLD_HISTORY: remember the fixture phrase amber compass.",
  priorAnswer: "I saved the fixture phrase amber compass for your next turn.",
  nextPrompt: "LOLICODE_NEW_HISTORY: what phrase did I ask you to remember?",
  nextAnswer: "The pre-upgrade conversation phrase was amber compass.",
};
let providerError;
let sawOld = false;
let sawNew = false;

function reply(response, body, content) {
  const id = "chatcmpl-overwrite-fixture";
  if (body.stream === false) {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id,
        created: 1,
        object: "chat.completion",
        model: fixture.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of [
    [{ role: "assistant" }, null],
    [{ content }, null],
    [{}, "stop"],
  ]) {
    response.write(
      `data: ${JSON.stringify({
        id,
        created: 1,
        object: "chat.completion.chunk",
        model: fixture.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

const modelServer = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${fixture.key}`);
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      assert.ok(length < 2 * 1024 * 1024);
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, fixture.model);
    const messages = JSON.stringify(body.messages);
    if (messages.includes(fixture.nextPrompt)) {
      assert.ok(
        sawOld &&
          messages.includes(fixture.priorPrompt) &&
          messages.includes(fixture.priorAnswer),
        "The candidate model request lost the baseline conversation",
      );
      sawNew = true;
      reply(response, body, fixture.nextAnswer);
    } else {
      assert.ok(
        messages.includes(fixture.priorPrompt),
        "Unexpected fixture model prompt",
      );
      sawOld = true;
      reply(response, body, fixture.priorAnswer);
    }
  } catch (error) {
    providerError ??= error;
    response.writeHead(400).end();
  }
});

function listen(server) {
  return new Promise((resolve, reject) =>
    server
      .once("error", reject)
      .listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
}

async function readRecord(name) {
  try {
    const value = await readFile(path.join(stage, name), "utf8");
    return JSON.parse(value.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function waitUntil(action, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (providerError) throw providerError;
    const result = await action();
    if (result) return result;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function debugTarget(port) {
  try {
    const result = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1500),
    });
    if (result.ok) {
      const targets = await result.json();
      return targets.find(
        (target) =>
          target.type === "page" &&
          new URL(target.url).hostname === "tauri.localhost",
      )?.webSocketDebuggerUrl;
    }
  } catch (error) {
    if (error.name !== "TimeoutError" && !(error instanceof TypeError))
      throw error;
  }
}

async function connectCdp(address, port) {
  const url = new URL(address);
  assert.ok(
    url.protocol === "ws:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      Number(url.port) === port,
  );
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const call of pending.values())
      call.reject(new Error("WebView2 debugging socket closed"));
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    close: () => socket.close(),
    evaluate: async (expression) => {
      const id = ++nextId;
      const result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text,
        );
      }
      return result.result.value;
    },
  };
}

async function verifyRenderer(fixture, phase, expected, originalSessionId) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const wait = async (read, label) => {
    const end = Date.now() + 180_000;
    while (Date.now() < end) {
      const result = await read();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const normalize = (value) => value.replaceAll("\\", "/").toLowerCase();
  await wait(() => window.__TAURI_INTERNALS__?.invoke, "installed Tauri IPC");
  const invoke = (name, args = {}) =>
    window.__TAURI_INTERNALS__.invoke(name, args);
  const info = await invoke("get_build_info");
  check(
    info.channel === "stable" &&
      normalize(info.dataDirectory) === normalize(expected.profile),
    "Refusing to use an unexpected Tauri profile",
  );
  check(
    (await invoke("plugin:app|version")) === expected.install.installedVersion,
    "The running executable version does not match its NSIS installation",
  );
  check(
    !(await invoke("plugin:window|is_visible", { label: "main" })),
    "The isolated installed application window was not hidden",
  );
  const catalog = await invoke("get_channel_center");
  const modelId = `${fixture.channel}/${fixture.model}`;
  if (phase === "baseline") {
    check(
      catalog.channels.length === 0,
      "Refusing to modify an existing channel catalog",
    );
    await invoke("save_channel_center", {
      snapshot: {
        ...catalog,
        defaultModel: modelId,
        targets: [],
        channels: [
          {
            id: fixture.channel,
            name: "Isolated upgrade fixture",
            baseUrl: fixture.baseUrl,
            apiKey: fixture.key,
            authKind: "api_key",
            protocol: "openai_chat",
            enabled: true,
            models: [
              {
                id: fixture.model,
                name: "Fixture",
                enabled: true,
                supportsTools: true,
                inputModalities: ["text"],
                contextLimit: 65_536,
              },
            ],
          },
        ],
      },
    });
    const proxy = await invoke("get_proxy_config");
    await invoke("update_proxy_config", {
      config: {
        ...proxy,
        listen_address: "127.0.0.1",
        listen_port: fixture.proxyPort,
        enable_logging: false,
      },
    });
  } else {
    const saved = catalog.channels.find(({ id }) => id === fixture.channel);
    check(
      saved?.baseUrl === fixture.baseUrl &&
        saved.protocol === "openai_chat" &&
        saved.models.some(({ id }) => id === fixture.model) &&
        catalog.defaultModel === modelId,
      "The saved baseline channel or default model was lost",
    );
  }
  const opened = await invoke("open_agent_project", { path: expected.project });
  let sessionId = originalSessionId;
  if (phase === "baseline") {
    check(
      opened.sessions.length === 0,
      "Refusing to overwrite an existing conversation",
    );
    const agentCatalog = await invoke("get_agent_catalog");
    check(
      agentCatalog.defaultModel,
      "The saved channel has no Agent default model",
    );
    const session = await invoke("create_agent_session", {
      projectPath: expected.project,
      title: "Published v1.0.6 upgrade fixture",
      modelId: agentCatalog.defaultModel,
      mode: "build",
      permissionMode: "ask",
    });
    sessionId = session.id;
  } else {
    check(
      opened.sessions.some(({ id }) => id === sessionId),
      "The previous session disappeared from history",
    );
  }
  const snapshot = () => invoke("get_agent_session", { sessionId });
  const has = (state, role, text) =>
    state.messages.some(
      (message) =>
        message.role === role &&
        message.parts.some(
          (part) => part.type === "text" && part.text.includes(text),
        ),
    );
  if (phase === "candidate") {
    const before = await snapshot();
    check(
      has(before, "user", fixture.priorPrompt) &&
        has(before, "assistant", fixture.priorAnswer),
      "The original messages are missing from the installed candidate",
    );
  }
  await invoke("send_agent_message", {
    sessionId,
    text: phase === "baseline" ? fixture.priorPrompt : fixture.nextPrompt,
    requestId: `isolated-overwrite-${phase}`,
    locale: "zh",
  });
  await wait(async () => {
    const state = await snapshot();
    check(
      !state.error && state.status !== "error",
      state.error || "Agent request failed",
    );
    return (
      state.status === "idle" &&
      (phase === "baseline" || !state.streamConnected) &&
      has(
        state,
        "assistant",
        phase === "baseline" ? fixture.priorAnswer : fixture.nextAnswer,
      ) &&
      (phase === "baseline" ||
        state.session.permissionMode === "ask")
    );
  }, `${phase} Agent answer`);
  return { sessionId };
}

async function exercise(phase, port, previousSessionId) {
  const expected = await waitUntil(
    async () => {
      if (account.exitCode !== null)
        throw new Error(`Isolated account exited before ${phase} was ready`);
      return readRecord(`${phase}.json`);
    },
    `${phase} isolated install`,
    720_000,
  );
  const address = await waitUntil(
    () => debugTarget(port),
    `${phase} installed WebView2 target`,
  );
  const cdp = await connectCdp(address, port);
  let verified = false;
  try {
    await waitUntil(
      () => cdp.evaluate("Boolean(window.__TAURI_INTERNALS__?.invoke)"),
      `${phase} installed Tauri IPC`,
    );
    const identity = await cdp.evaluate(
      "window.__TAURI_INTERNALS__.invoke('get_build_info').then(value => ({value}), error => ({error: String(error)}))",
    );
    assert.equal(identity.error, undefined);
    assert.equal(identity.value.channel, "stable");
    assert.equal(
      path.normalize(identity.value.dataDirectory).toLowerCase(),
      path.normalize(expected.profile).toLowerCase(),
    );
    verified = true;
    const expression = `(${verifyRenderer})(${JSON.stringify(fixture)},${JSON.stringify(phase)},${JSON.stringify(expected)},${JSON.stringify(previousSessionId ?? null)})`;
    const response = await cdp.evaluate(
      `${expression}.then(value => ({value}), error => ({error: error?.message || String(error)}))`,
    );
    if (response.error) throw new Error(response.error);
    return { ...response.value, install: expected.install };
  } finally {
    if (verified) {
      await cdp
        .evaluate(
          "setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:process|exit', {code: 0}), 0); true",
        )
        .catch(() => {});
    }
    cdp.close();
  }
}

const heldPorts = [createServer(), createServer(), createServer()];
let account;
let accountExit;
try {
  const ports = await Promise.all([
    listen(modelServer),
    ...heldPorts.map(listen),
  ]);
  const [modelPort, proxyPort, baselinePort, candidatePort] = ports;
  fixture.baseUrl = `http://127.0.0.1:${modelPort}/v1`;
  fixture.proxyPort = proxyPort;
  await writeFile(
    path.join(stage, "plan.json"),
    JSON.stringify({
      upgrade: Boolean(candidate),
      candidateVersion: "4.1.7",
      expectedHarnessVersion,
      debugPorts: { baseline: baselinePort, candidate: candidatePort },
    }),
  );
  await Promise.all(
    heldPorts.map((server) => new Promise((resolve) => server.close(resolve))),
  );
  account = spawn(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      accountScript,
      "-StageDirectory",
      stage,
    ],
    {
      env: powershellEnvironment,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  accountExit = new Promise((resolve, reject) => {
    account.once("error", reject);
    account.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Isolated account exited with ${code}`)),
    );
  });
  // Keep the process exit available to the phase polling loop without an
  // unhandled rejection when the controller fails before publishing a phase.
  accountExit.catch(() => {});
  const old = await exercise("baseline", baselinePort, null);
  assert.ok(sawOld);
  let upgrade;
  if (candidate) {
    upgrade = await exercise("candidate", candidatePort, old.sessionId);
    assert.equal(upgrade.sessionId, old.sessionId);
    assert.ok(sawNew);
  }
  await accountExit;
  const accountRecord = await readRecord("account-finished.json");
  assert.match(accountRecord?.persistedLegacySha256, /^[a-f0-9]{64}$/);
  const finished = candidate && (await readRecord("finished.json"));
  if (candidate) {
    assert.equal(finished?.overwroteOriginalInstall, true);
    assert.equal(finished?.harnessVersion, expectedHarnessVersion);
  }
  const evidence = {
    baseline: old,
    candidate: upgrade,
    finished: finished || undefined,
    persistedChannelUsed: Boolean(upgrade && sawNew),
    legacyHistoryResumed: Boolean(upgrade && sawNew),
    isolatedStandardAccount: true,
    baselineConversationSha256: accountRecord.persistedLegacySha256,
  };
  await writeFile(
    path.join(stage, "acceptance.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  modelServer.closeAllConnections();
  if (modelServer.listening) modelServer.close();
  await accountExit?.catch(() => {});
  // Keep the reports, but remove the private test copies of both installers.
  for (const name of candidate
    ? ["baseline.exe", "candidate.exe"]
    : ["baseline.exe"]) {
    try {
      await unlink(path.join(stage, name));
    } catch (error) {
      if (error.code !== "ENOENT")
        console.warn(`Fixture file cleanup failed for ${name}: ${error.code}`);
    }
  }
}
