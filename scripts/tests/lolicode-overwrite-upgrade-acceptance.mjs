// Run from an elevated Windows shell using Node 24:
// node scripts/tests/lolicode-overwrite-upgrade-acceptance.mjs <published-1.0.6.exe> [<local-4.1.7-setup.exe> <source-snapshot.json> <verified-candidate-sha256>]
// A baseline-only run rehearses the released installer and old transcript creation.
// Upgrade runs restart/resume, then reinstall the identical candidate and resume
// again, all in the same disposable account/profile with fresh prompts/request IDs.
// cleanup-identity.json records only SID/profile/ACL digests, never a password.
// A cleanup failure retains the evidence and installers and cannot produce a pass.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// BEGIN PURE ARGUMENT VALIDATION
function parseAcceptanceArgs(args, platform) {
  const [baseline, candidate, sourceSnapshotPath, expectedCandidateSha256] =
    args;
  if (
    platform !== "win32" ||
    ![1, 4].includes(args.length) ||
    !baseline ||
    (args.length === 4 &&
      (!candidate ||
        !sourceSnapshotPath ||
        !/^[a-f0-9]{64}$/i.test(expectedCandidateSha256 ?? "")))
  ) {
    throw new Error(
      "Usage (Windows): node lolicode-overwrite-upgrade-acceptance.mjs <published-v1.0.6.exe> [<candidate-4.1.7.exe> <source-snapshot.json> <independently-verified-64-hex-candidate-sha256>]",
    );
  }
  return { baseline, candidate, sourceSnapshotPath, expectedCandidateSha256 };
}
// END PURE ARGUMENT VALIDATION
const { baseline, candidate, sourceSnapshotPath, expectedCandidateSha256 } =
  parseAcceptanceArgs(process.argv.slice(2), process.platform);
const sourceSnapshot =
  candidate && JSON.parse(await readFile(sourceSnapshotPath, "utf8"));
if (sourceSnapshot) {
  assert.equal(sourceSnapshot.product, "LoliCode");
  assert.equal(sourceSnapshot.productVersion, "1.0.7");
  assert.equal(sourceSnapshot.buildVersion, "4.1.7");
  for (const key of ["sourceCommit", "sourceTree", "parentCommit"])
    assert.match(sourceSnapshot[key], /^[a-f0-9]{40}$/);
  assert.match(sourceSnapshot.sourceArchiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof sourceSnapshot.work, "string");
  assert.ok(
    path.win32.isAbsolute(sourceSnapshot.work),
    "Frozen work directory must be an absolute Windows path",
  );
}
const expectedHarnessVersion = candidate
  ? JSON.parse(
      await readFile(
        path.join(
          sourceSnapshot.work,
          "packages/lolicode-harness-runtime/package.json",
        ),
        "utf8",
      ),
    ).dependencies["@deepseek-ai/dsh"]
  : undefined;
if (candidate)
  assert.match(expectedHarnessVersion, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
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
    "[Environment]::GetFolderPath('CommonDocuments'); if (Get-Process -Name 'LoliCode','tai-switch' -ErrorAction SilentlyContinue) { exit 90 }",
  ],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(
  knownFolders.status,
  0,
  "Close any running stable LoliCode instance before this test",
);
const candidateHash = candidate && (await sha256(candidate));
if (candidate)
  assert.equal(
    candidateHash,
    expectedCandidateSha256.toLowerCase(),
    "Candidate differs from the independently verified signed build",
  );
const scriptRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptNames = [
  "scripts/tests/lolicode-overwrite-upgrade-acceptance.mjs",
  "scripts/tests/lolicode-overwrite-upgrade-account.ps1",
  "scripts/tests/lolicode-overwrite-upgrade-cleanup.test.mjs",
];
function gitRead(args) {
  const result = spawnSync("git", args, {
    cwd: scriptRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `Cannot record acceptance script provenance: ${result.stderr}`,
  );
  return result.stdout.trim();
}
const scriptProvenance = {
  gitCommit: gitRead(["rev-parse", "HEAD"]),
  dirtyFiles: gitRead([
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...scriptNames,
  ])
    .split(/\r?\n/)
    .filter(Boolean),
  files: await Promise.all(
    scriptNames.map(async (name) => ({
      path: name,
      sha256: await sha256(path.join(scriptRoot, name)),
    })),
  ),
};
assert.match(scriptProvenance.gitCommit, /^[a-f0-9]{40}$/);

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
// Public Documents inherits CREATOR OWNER. Pre-create every worker-written file
// as the controller so recording evidence does not introduce a second SID grant.
const workerRecords = [
  "baseline",
  "candidate",
  "restart",
  "reinstall",
  "finished",
  "account-finished",
];
for (const name of [...workerRecords, "cleanup-identity", "cleanup"]) {
  for (const suffix of [".json", ".json.tmp"]) {
    await writeFile(
      path.join(stage, name + suffix),
      JSON.stringify({ pending: true }),
      { flag: "wx" },
    );
  }
}
await writeFile(path.join(stage, "failure.txt"), "", { flag: "wx" });
const accountScript = path.join(stage, "isolated-account.ps1");
await copyFile(
  fileURLToPath(
    new URL("./lolicode-overwrite-upgrade-account.ps1", import.meta.url),
  ),
  accountScript,
);
await copyFile(baseline, path.join(stage, "baseline.exe"));
if (candidate) await copyFile(candidate, path.join(stage, "candidate.exe"));
assert.equal(await sha256(path.join(stage, "baseline.exe")), baselineHash);
if (candidate)
  assert.equal(await sha256(path.join(stage, "candidate.exe")), candidateHash);
console.log(`Isolated Windows upgrade evidence: ${stage}`);

const fixture = {
  model: "upgrade-fixture-model",
  key: "lolicode-synthetic-upgrade-channel-key",
  channel: "upgrade-fixture-channel",
  turns: [
    {
      phase: "baseline",
      prompt:
        "LOLICODE_OLD_HISTORY: remember the fixture phrase amber compass.",
      answer: "I saved the fixture phrase amber compass for your next turn.",
    },
    {
      phase: "candidate",
      prompt: "LOLICODE_NEW_HISTORY: what phrase did I ask you to remember?",
      answer: "The pre-upgrade conversation phrase was amber compass.",
    },
    {
      phase: "restart",
      prompt:
        "LOLICODE_RESTART_HISTORY: repeat that phrase after restarting Harness.",
      answer:
        "After the restart I still remember amber compass and our upgrade turn.",
    },
    {
      phase: "reinstall",
      prompt:
        "LOLICODE_REINSTALL_HISTORY: recall our phrase after this identical installer ran again.",
      answer:
        "After reinstalling I still remember amber compass, the upgrade, and the restart.",
    },
  ].map((turn) => ({
    ...turn,
    requestId: `isolated-overwrite-${turn.phase}-${randomUUID()}`,
  })),
};
let providerError;
const modelCalls = Object.fromEntries(
  fixture.turns.map(({ phase }) => [phase, 0]),
);
let activePhase;

// BEGIN PURE HISTORY VALIDATION
function validateFixtureHistory(messages, fixture, calls, activePhase) {
  const text = JSON.stringify(messages);
  const index = fixture.turns.findLastIndex((turn) =>
    text.includes(turn.prompt),
  );
  assert.ok(index >= 0, "Unexpected fixture model prompt");
  const turn = fixture.turns[index];
  assert.equal(
    turn.phase,
    activePhase,
    "A stale request was reused for a later acceptance phase",
  );
  for (const previous of fixture.turns.slice(0, index)) {
    assert.ok(
      calls[previous.phase] > 0 &&
        text.includes(previous.prompt) &&
        text.includes(previous.answer),
      `The ${turn.phase} model request lost ${previous.phase} conversation history`,
    );
  }
  return turn;
}
// END PURE HISTORY VALIDATION

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
    const turn = validateFixtureHistory(
      body.messages,
      fixture,
      modelCalls,
      activePhase,
    );
    modelCalls[turn.phase] += 1;
    reply(response, body, turn.answer);
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
    const record = JSON.parse(value.replace(/^\uFEFF/, ""));
    return record.pending === true ? undefined : record;
  } catch (error) {
    // Worker writes into pre-created controller-owned files, without replacing
    // their ACL/owner. A concurrent read can briefly see a partial JSON payload.
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

// BEGIN PURE CLEANUP VALIDATION
function validateCleanupRecord(record, identity, stage) {
  assert.ok(identity, "Missing isolated cleanup identity");
  const accountName = `LCU${path.basename(stage).slice("LoliCodeUpgrade-".length)}`;
  assert.equal(identity.accountName, accountName);
  assert.match(identity.accountSid, /^S-1-5-21-[0-9-]+$/);
  assert.equal(path.basename(identity.profile), accountName);
  assert.equal(identity.stage, stage);
  assert.equal(record?.stage, stage);
  assert.equal(record?.accountSid, identity.accountSid);
  assert.equal(record?.accountName, identity.accountName);
  assert.equal(record?.profile, identity.profile);
  assert.deepEqual(record?.originalAcl, identity.originalAcl);
  assert.ok(identity.originalAcl?.length, "Missing pre-grant ACL digests");
  for (const entry of identity.originalAcl) {
    assert.match(entry.daclSha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.testSidAceCount, 0);
  }
  for (const check of [
    "completed",
    "accountRemoved",
    "profileRemoved",
    "profileRegistrationRemoved",
    "profileDirectoryRemoved",
    "processesCleared",
    "daclRestored",
    "stageSidRemoved",
  ])
    assert.equal(
      record[check],
      true,
      `Isolated cleanup did not verify ${check}`,
    );
  assert.deepEqual(record.errors, []);
  assert.deepEqual(record.remainingProcesses, []);
  assert.ok(record.finalAcl?.length, "Missing post-cleanup ACL inventory");
  for (const entry of record.finalAcl) assert.equal(entry.testSidAceCount, 0);
  for (const before of identity.originalAcl) {
    assert.equal(
      record.finalAcl.find((entry) => entry.path === before.path)?.daclSha256,
      before.daclSha256,
    );
  }
  return record;
}
// END PURE CLEANUP VALIDATION

async function waitUntil(action, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (providerError) throw providerError;
    if (accountFailure) throw accountFailure;
    if (account?.exitCode !== null && account?.exitCode !== undefined) {
      throw new Error(
        `Isolated account exited with ${account.exitCode} while waiting for ${label}`,
      );
    }
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

// BEGIN BOUNDED CDP CONNECTION
async function connectCdp(
  address,
  port,
  { connectionTimeoutMs = 10_000, callTimeoutMs = 20_000 } = {},
) {
  const url = new URL(address);
  assert.ok(
    url.protocol === "ws:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      Number(url.port) === port,
  );
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  const rejectPending = () => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("WebView2 debugging socket closed"));
    }
    pending.clear();
  };
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  socket.addEventListener("close", rejectPending);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out connecting to isolated WebView2"));
    }, connectionTimeoutMs);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Cannot connect to isolated WebView2"));
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        reject(new Error("Isolated WebView2 closed before connecting"));
      },
      { once: true },
    );
  });
  return {
    close: () => {
      rejectPending();
      socket.close();
    },
    evaluate: async (expression, timeoutMs = callTimeoutMs) => {
      const id = ++nextId;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error("Timed out waiting for isolated WebView2 evaluation"),
          );
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(
            JSON.stringify({
              id,
              method: "Runtime.evaluate",
              params: { expression, awaitPromise: true, returnByValue: true },
            }),
          );
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
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
// END BOUNDED CDP CONNECTION

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
  const turnIndex = fixture.turns.findIndex((turn) => turn.phase === phase);
  check(turnIndex >= 0, "Unknown acceptance phase");
  const turn = fixture.turns[turnIndex];
  if (phase !== "baseline") {
    const before = await snapshot();
    for (const previous of fixture.turns.slice(0, turnIndex)) {
      check(
        has(before, "user", previous.prompt) &&
          has(before, "assistant", previous.answer),
        `The persisted ${previous.phase} messages are missing before ${phase}`,
      );
    }
  }
  await invoke("send_agent_message", {
    sessionId,
    text: turn.prompt,
    requestId: turn.requestId,
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
      has(state, "assistant", turn.answer) &&
      (phase === "baseline" || state.session.permissionMode === "ask")
    );
  }, `${phase} Agent answer`);
  return { sessionId };
}

async function exercise(phase, port, previousSessionId) {
  activePhase = phase;
  const callsBefore = modelCalls[phase];
  const expected = await waitUntil(
    async () => {
      if (account.exitCode !== null)
        throw new Error(`Isolated account exited before ${phase} was ready`);
      return readRecord(`${phase}.json`);
    },
    `${phase} isolated install`,
    720_000,
  );
  const identity = await readRecord("cleanup-identity.json");
  assert.equal(expected.accountSid, identity.accountSid);
  assert.equal(expected.account, identity.accountName);
  assert.equal(expected.accountProfile, identity.profile);
  assert.equal(
    path.normalize(expected.profile).toLowerCase(),
    path.join(identity.profile, ".tai-switch").toLowerCase(),
  );
  if (phase !== "baseline")
    assert.equal(expected.install.installerSha256, candidateHash);
  const address = await waitUntil(
    () => debugTarget(port),
    `${phase} installed WebView2 target`,
  );
  const cdp = await connectCdp(address, port);
  // Controller termination must release a pending Runtime.evaluate even if a
  // broken WebView leaves its debugging socket open.
  accountExit.then(
    () => cdp.close(),
    () => cdp.close(),
  );
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
      240_000,
    );
    if (response.error) throw new Error(response.error);
    assert.ok(
      modelCalls[phase] > callsBefore,
      `No fresh model request occurred in ${phase}`,
    );
    return {
      ...response.value,
      install: expected.install,
      profile: expected.profile,
      accountSid: expected.accountSid,
      requestId: fixture.turns.find((turn) => turn.phase === phase).requestId,
      freshModelRequests: modelCalls[phase] - callsBefore,
    };
  } finally {
    if (verified) {
      await cdp
        .evaluate(
          "setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:process|exit', {code: 0}), 0); true",
          5_000,
        )
        .catch(() => {});
    }
    cdp.close();
  }
}

const heldPorts = Array.from({ length: 5 }, () => createServer());
let account;
let accountExit;
let accountFailure;
let evidence;
let acceptanceError;
try {
  const ports = await Promise.all([
    listen(modelServer),
    ...heldPorts.map(listen),
  ]);
  const [
    modelPort,
    proxyPort,
    baselinePort,
    candidatePort,
    restartPort,
    reinstallPort,
  ] = ports;
  fixture.baseUrl = `http://127.0.0.1:${modelPort}/v1`;
  fixture.proxyPort = proxyPort;
  await writeFile(
    path.join(stage, "plan.json"),
    JSON.stringify({
      upgrade: Boolean(candidate),
      candidateVersion: "4.1.7",
      candidateSha256: candidateHash || undefined,
      expectedHarnessVersion,
      debugPorts: {
        baseline: baselinePort,
        candidate: candidatePort,
        restart: restartPort,
        reinstall: reinstallPort,
      },
      productSource: sourceSnapshot || undefined,
      acceptanceScripts: scriptProvenance,
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
  accountExit.catch((error) => {
    accountFailure = error;
  });
  const old = await exercise("baseline", baselinePort, null);
  assert.ok(modelCalls.baseline > 0);
  let upgrade;
  let restart;
  let reinstall;
  if (candidate) {
    upgrade = await exercise("candidate", candidatePort, old.sessionId);
    restart = await exercise("restart", restartPort, old.sessionId);
    reinstall = await exercise("reinstall", reinstallPort, old.sessionId);
    for (const phase of [upgrade, restart, reinstall]) {
      assert.equal(phase.sessionId, old.sessionId);
      assert.equal(phase.profile, old.profile);
      assert.equal(phase.accountSid, old.accountSid);
      assert.equal(phase.install.installerSha256, candidateHash);
    }
    assert.equal(
      reinstall.install.executableSha256,
      upgrade.install.executableSha256,
    );
  }
  await accountExit;
  const accountRecord = await readRecord("account-finished.json");
  assert.match(accountRecord?.persistedLegacySha256, /^[a-f0-9]{64}$/);
  const finished = candidate && (await readRecord("finished.json"));
  if (candidate) {
    assert.equal(finished?.overwroteOriginalInstall, true);
    assert.equal(finished?.harnessVersion, expectedHarnessVersion);
    assert.equal(finished?.restartVerified, true);
    assert.equal(finished?.sameCandidateReinstalled, true);
    assert.equal(finished?.candidateSha256, candidateHash);
  }
  evidence = {
    baseline: old,
    candidate: upgrade,
    restart,
    reinstall,
    finished: finished || undefined,
    persistedChannelUsed: Boolean(upgrade && modelCalls.candidate),
    legacyHistoryResumed: Boolean(upgrade && modelCalls.candidate),
    restartedHistoryResumed: Boolean(restart && modelCalls.restart),
    reinstalledHistoryResumed: Boolean(reinstall && modelCalls.reinstall),
    modelCalls,
    productSource: sourceSnapshot || undefined,
    candidateSha256: candidateHash || undefined,
    acceptanceScripts: scriptProvenance,
    isolatedStandardAccount: true,
    baselineConversationSha256: accountRecord.persistedLegacySha256,
  };
} catch (error) {
  acceptanceError = error;
  // Cooperative cancellation lets the account worker run its own finally.
  await writeFile(
    path.join(stage, "cancel.json"),
    JSON.stringify({ reason: error.message }),
  );
} finally {
  modelServer.closeAllConnections();
  if (modelServer.listening) modelServer.close();
  for (const server of heldPorts) if (server.listening) server.close();
  await accountExit?.catch((error) => {
    acceptanceError ??= error;
  });
  try {
    const cleanup = validateCleanupRecord(
      await readRecord("cleanup.json"),
      await readRecord("cleanup-identity.json"),
      stage,
    );
    // Remove only our copied inputs after verified cleanup. Retain all reports.
    for (const name of candidate
      ? ["baseline.exe", "candidate.exe"]
      : ["baseline.exe"]) {
      await unlink(path.join(stage, name));
    }
    if (evidence)
      evidence.cleanup = { ...cleanup, installerCopiesRemoved: true };
  } catch (error) {
    acceptanceError = new AggregateError(
      [acceptanceError, error].filter(Boolean),
      `Acceptance/cleanup failed; retain evidence at ${stage}: ${error.message}`,
    );
  }
}
if (acceptanceError) {
  await writeFile(
    path.join(stage, "acceptance-failure.json"),
    JSON.stringify(
      {
        message: acceptanceError.message,
        errors: (acceptanceError.errors ?? [acceptanceError]).map(
          (error) => error.message,
        ),
      },
      null,
      2,
    ),
  );
  throw acceptanceError;
}
for (const file of scriptProvenance.files) {
  assert.equal(
    await sha256(path.join(scriptRoot, file.path)),
    file.sha256,
    "Acceptance script changed while the test ran",
  );
}
await writeFile(
  path.join(stage, "acceptance.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence));
