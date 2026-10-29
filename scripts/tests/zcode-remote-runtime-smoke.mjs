// Explicit SSH integration gate. It writes only a newly created /tmp/lolicode-*
// namespace and executes no paid model or account request.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assetRoot,
  verifyRemoteAssets,
} from "../build/prepare-zcode-remote-runtime.mjs";

const index = process.argv.indexOf("--ssh-host");
const alias = index >= 0 ? process.argv[index + 1] : undefined;
if (!alias || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(alias))
  throw new Error("Pass --ssh-host <explicitly-authorized-alias>");
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const runtime = path.join(repo, "src-tauri/resources/zcode-runtime");
const owned = await mkdtemp(path.join(os.tmpdir(), "lolicode-remote-smoke-"));
const transportEnvironment = { ...process.env };
const q = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const runSSH = (command) =>
  execFileSync("ssh", ["-o", "BatchMode=yes", alias, command], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: transportEnvironment,
  });
const previousIndex = process.argv.indexOf("--remote-root");
const previous =
  previousIndex >= 0 ? process.argv[previousIndex + 1] : undefined;
const reuseDeployment = process.argv.includes("--reuse-deployment");
if (reuseDeployment && !previous)
  throw new Error(
    "--reuse-deployment requires an already verified --remote-root",
  );
if (previousIndex >= 0 && !previous)
  throw new Error("--remote-root needs an owned smoke temporary directory");
const remote =
  previous ?? runSSH("mktemp -d /tmp/lolicode-zcode-smoke-XXXXXXXX").trim();
assert.match(remote, /^\/tmp\/lolicode-zcode-smoke-[A-Za-z0-9]{8}$/);
if (previous)
  assert.equal(
    runSSH(
      `test ! -L ${q(remote)} && cat ${q(`${remote}/project/probe.txt`)}`,
    ).trim(),
    "LOLICODE_REMOTE_FILE_OK",
  );
const home = `${remote}/home`;
runSSH(
  `mkdir -p ${q(home)} ${q(`${remote}/project`)} ${q(`${remote}/commands`)}; printf '%s\n' LOLICODE_REMOTE_FILE_OK > ${q(`${remote}/project/probe.txt`)}`,
);
const children = new Set();
const commands = [];
const baseEnv = `env -i HOME=${q(home)} USERPROFILE=${q(home)} PATH=/usr/bin:/bin TMPDIR=${q(remote)} ZCODE_MODEL_TELEMETRY_ENABLED=false ZCODE_BASE_URL=http://127.0.0.1:9 ZCODE_PRODUCTION_BASE_URL=http://127.0.0.1:9 ZAI_PRODUCTION_OAUTH_ORIGIN=http://127.0.0.1:9 ZAI_PRODUCTION_BUSINESS_BASE_URL=http://127.0.0.1:9`;
const mapPath = (value) => {
  const file = value.startsWith("~/") ? `${home}/${value.slice(2)}` : value;
  if (!file.startsWith(`${remote}/`) || file.split("/").includes(".."))
    throw new Error(
      "SSH smoke rejected path outside its owned temporary namespace",
    );
  return file;
};
let disposed = false;
const backend = {
  async detect() {
    return { platform: "linux", arch: "x64" };
  },
  async upload(local, target) {
    const destination = mapPath(target);
    execFileSync("scp", ["-q", local, `${alias}:${destination}`], {
      stdio: "pipe",
      env: transportEnvironment,
    });
  },
  async exists(target) {
    try {
      runSSH(`[ -e ${q(mapPath(target))} ]`);
      return true;
    } catch {
      return false;
    }
  },
  async readFile(target) {
    return runSSH(`cat ${q(mapPath(target))}`);
  },
  async exec(command) {
    if (disposed) throw new Error("Owned smoke SSH transport is closed");
    // Any original product install path is a test failure before execution.
    const decodedCommand = command.replace(/(?:\\[0-7]{3})+/g, (bytes) =>
      bytes.replace(/\\([0-7]{3})/g, (_, octal) =>
        String.fromCharCode(parseInt(octal, 8)),
      ),
    );
    if (decodedCommand.includes("/.zcode/server")) {
      await writeFile(path.join(owned, "rejected-command.txt"), command);
      throw new Error(
        "Official ZCode binary/config root must never be written",
      );
    }
    commands.push(command);
    // Windows OpenSSH's command-line parser does not preserve nested multiline
    // shell quotes reliably. Stage the exact command bytes as an owned script;
    // stdin remains reserved for the genuine native RPC/lock protocol.
    const scriptName = `command-${randomUUID()}.sh`;
    const script = path.join(owned, scriptName);
    await writeFile(script, `#!/bin/sh\ncd ${q(remote)}\n${command}\n`);
    execFileSync(
      "scp",
      ["-q", script, `${alias}:${remote}/commands/${scriptName}`],
      { stdio: "pipe", timeout: 180_000, env: transportEnvironment },
    );
    const child = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        alias,
        `${baseEnv} /bin/sh ${remote}/commands/${scriptName}`,
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: transportEnvironment,
      },
    );
    children.add(child);
    const listeners = new Set();
    child.on("close", (code) => {
      children.delete(child);
      for (const listener of listeners) listener(code ?? 1);
    });
    // System OpenSSH may keep a no-output command channel waiting on an open
    // local stdin pipe. The native SSH2 backend does not have this CLI wrapper.
    // Only genuine protocol owners retain stdin: lock holder, stdio server and
    // relay/probe Node programs which explicitly consume framed input.
    if (
      !decodedCommand.includes("lock_heartbeat_pid=") &&
      !decodedCommand.includes("ZCODE_SERVER_RUNTIME_ROOT=") &&
      !/(?:^|\/)node\s+-e\s/.test(command)
    )
      child.stdin.end();
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      onClose(listener) {
        listeners.add(listener);
        return {
          dispose() {
            listeners.delete(listener);
          },
        };
      },
    };
  },
  dispose() {
    disposed = true;
    for (const child of children) child.stdin.end();
  },
  async disposeAndWait() {
    this.dispose();
    for (const child of [...children])
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 5000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
  },
};
let gatewayRequests = 0;
let modelRequests = 0;
let readToolIssued = false;
let readToolResultSeen = false;
const runtimePreferenceScopes = [];
const requestedModels = [];
const remoteModelId = "offline-remote/test-model";
const completionMarker = "LOLICODE_REMOTE_NATIVE_TASK_DONE";
const gateway = createServer(async (request, response) => {
  if (
    request.headers.authorization !==
    "Bearer offline-smoke-private-loopback-only"
  ) {
    response.writeHead(403);
    response.end();
    return;
  }
  if (request.url === "/v1/models" && request.method === "GET") {
    gatewayRequests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [] }));
    return;
  }
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  requestedModels.push(input.model);
  if (input.model !== remoteModelId || ++modelRequests > 6) {
    response.writeHead(400).end(
      JSON.stringify({
        error: { message: "Offline model route or request budget rejected" },
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish, usage) =>
    `data: ${JSON.stringify({ id: "remote-fixture-completion", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  const read = input.tools?.find((tool) => tool.function?.name === "Read");
  if (read && !readToolIssued) {
    assert.ok(
      read.function.parameters?.properties?.file_path,
      "Read must come from the real native advertised schema",
    );
    readToolIssued = true;
    response.end(
      chunk(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_remote_read_fixture",
              type: "function",
              function: {
                name: read.function.name,
                arguments: JSON.stringify({
                  file_path: `${remote}/project/probe.txt`,
                }),
              },
            },
          ],
        },
        null,
      ) +
        chunk({}, "tool_calls") +
        "data: [DONE]\n\n",
    );
  } else {
    if (
      input.messages?.some(
        (message) =>
          message.role === "tool" &&
          JSON.stringify(message.content).includes("LOLICODE_REMOTE_FILE_OK"),
      )
    )
      readToolResultSeen = true;
    response.end(
      chunk({ role: "assistant", content: completionMarker }, null) +
        chunk({}, "stop", {
          prompt_tokens: 10,
          completion_tokens: 8,
          total_tokens: 18,
        }) +
        "data: [DONE]\n\n",
    );
  }
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
let owner;
let taskTerminalSubscription;
let taskTerminalTimeout;
const captured = [];
const originalLog = console.log;
const originalInfo = console.info;
let passed = false;
try {
  const manifest = await verifyRemoteAssets();
  if (reuseDeployment) {
    const coreFiles = [
      ["server/zcode-server.cjs", "zcode-server.cjs"],
      ["node/linux-x64/node", "node"],
      ["node-pty/linux-x64/pty.node", "build/Release/pty.node"],
      ["glm/linux-x64/zcode.cjs", "agents/glm/zcode.cjs"],
      ...["bfs/bfs", "ripgrep/rg", "ugrep/ugrep"].map((entry) => [
        `tools/linux-x64/${entry}`,
        `tools/${entry}`,
      ]),
    ];
    const installed = new Map(
      runSSH(
        `sha256sum ${coreFiles.map(([, file]) => q(`${home}/.lolicode/server/${file}`)).join(" ")}`,
      )
        .trim()
        .split(/\r?\n/)
        .map((line) => [line.slice(66), line.slice(0, 64)]),
    );
    for (const [source, target] of coreFiles) {
      const expected = manifest.files.find(
        (file) =>
          file.path === `releases/${manifest.upstreamVersion}/${source}`,
      );
      assert.ok(expected);
      assert.equal(
        installed.get(`${home}/.lolicode/server/${target}`),
        expected.sha256,
        "Reused deployed binary must match every current verified release component",
      );
    }
  }
  const { build } = await import(
    pathToFileURL(
      createRequire(
        path.join(
          repo,
          "packages/lolicode-zcode-runtime/.build/workspace/package.json",
        ),
      ).resolve("esbuild"),
    ).href
  );
  // Service packages capture platform paths during module initialization. Keep
  // even their lazy local state under this fixture before importing that graph;
  // the authorized system SSH transport retains its original environment.
  for (const key of Object.keys(process.env))
    if (key.startsWith("ZCODE_") || key.startsWith("ZAI_"))
      delete process.env[key];
  process.env.HOME = process.env.USERPROFILE = path.join(owned, "local-home");
  process.env.ZCODE_DATA_BASE_DIR = path.join(owned, "local-data");
  process.env.ZCODE_MODEL_TELEMETRY_ENABLED = "false";
  await mkdir(process.env.HOME, { recursive: true });
  const facade = path.join(owned, "remote-facade.mjs");
  await build({
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    entryPoints: [
      path.join(repo, "packages/lolicode-zcode-runtime/src/remote.ts"),
    ],
    outfile: facade,
    plugins: [
      {
        name: "same-runtime-identity",
        setup(builder) {
          builder.onResolve(
            { filter: /^\.\/(?:services|remote)\.mjs$/ },
            (args) => ({
              path: pathToFileURL(path.join(runtime, path.basename(args.path)))
                .href,
              external: true,
            }),
          );
        },
      },
    ],
  });
  const { RemoteOwner } = await import(pathToFileURL(facade).href);
  const bridge = path.join(owned, "provider-bridge.mjs");
  await build({
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    entryPoints: [
      path.join(repo, "packages/lolicode-zcode-runtime/src/provider-bridge.ts"),
    ],
    outfile: bridge,
  });
  const { provisionRemoteCatalog, manualModelConfig, modelConfig } =
    await import(pathToFileURL(bridge).href);
  const { Services, Provider } = await import(
    pathToFileURL(path.join(runtime, "services.mjs")).href
  );
  const fixtureModel = {
    id: `offline/${remoteModelId}`,
    providerId: "offline",
    modelId: remoteModelId,
    name: "Offline remote model",
    channelName: "Owned loopback fixture",
    contextLimit: 16000,
    outputLimit: 1000,
  };
  assert.deepEqual(
    Provider.manualModelConfigSchema.parse(manualModelConfig(fixtureModel)),
    Provider.extractManualModelConfig(modelConfig(fixtureModel)),
    "The exact pinned upstream manual-model schema must accept the remote projection",
  );
  console.log = console.info = (...args) =>
    captured.push(
      args
        .map((value) =>
          typeof value === "string" ? value : JSON.stringify(value),
        )
        .join(" "),
    );
  owner = new RemoteOwner({
    connectOptions: {
      mockCdnDir: assetRoot,
      skipDeploy: reuseDeployment,
      assetInstallMode: "local-download-upload",
      handshakeTimeout: 20_000,
      remoteRuntimeEnv: {
        ZCODE_PRODUCTION_BASE_URL: "http://127.0.0.1:9",
        ZAI_PRODUCTION_OAUTH_ORIGIN: "http://127.0.0.1:9",
        ZAI_PRODUCTION_BUSINESS_BASE_URL: "http://127.0.0.1:9",
      },
    },
    createBackend: async () => backend,
    resolveRuntimePreferences: async (request) => {
      assert.ok(
        ["runtime-materialization", "user-execution"].includes(request.scope),
      );
      runtimePreferenceScopes.push(request.scope);
      return {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: "preflight-v1",
      };
    },
    acquireGatewayLease: async () => ({
      baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`,
      bearerToken: "offline-smoke-private-loopback-only",
      release() {},
    }),
    provisionGateway: async ({ services, baseUrl, apiKey }) => {
      // Prove the remote HTTP relay reaches the desktop's loopback gateway.
      // Relay credentials enter stdin; no credential enters command arguments.
      const program =
        'let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",async()=>{try{const{url,token}=JSON.parse(input);const r=await fetch(url,{headers:{authorization:"Bearer "+token}});const j=await r.json();console.log(JSON.stringify({status:r.status,count:j.data?.length}));}catch{console.log(JSON.stringify({failed:true}));process.exitCode=1;}});';
      const stream = await backend.exec(
        `~/.lolicode/server/node -e ${q(program)}`,
      );
      let response = "";
      stream.stdout.on("data", (chunk) => (response += chunk));
      stream.stderr.resume();
      const completed = new Promise((resolve, reject) =>
        stream.onClose((code) =>
          code === 0
            ? resolve()
            : reject(new Error("Remote gateway probe failed")),
        ),
      );
      stream.stdin.end(
        `${JSON.stringify({ url: `${baseUrl}/models`, token: apiKey })}\n`,
      );
      await completed;
      assert.deepEqual(JSON.parse(response), { status: 200, count: 0 });
      assert.notEqual(
        apiKey,
        "offline-smoke-private-loopback-only",
        "Remote must receive its ephemeral relay token, never the desktop gateway token",
      );
      return provisionRemoteCatalog(
        services,
        Services.IProviderSettingsService,
        { revision: 1, models: [fixtureModel], defaultModel: fixtureModel.id },
        baseUrl,
        apiKey,
      );
    },
  });
  const connected = await owner.connect({
    id: "owned-linux-gate",
    target: { kind: "ssh", host: "tools", username: "fixture" },
  });
  assert.equal(connected.state, "connected");
  const services = owner.getServices("owned-linux-gate");
  const files = services.fileService;
  const listing = await files.readdir({ path: `${remote}/project` });
  assert.ok(listing.some((entry) => entry.name === "probe.txt"));
  const content = await files.readTextFile({
    path: `${remote}/project/probe.txt`,
  });
  assert.ok(JSON.stringify(content).includes("LOLICODE_REMOTE_FILE_OK"));
  const searchRoot = `${home}/.lolicode/server`;
  const terminal = services.terminalService;
  const created = await terminal.create({
    cols: 80,
    rows: 24,
    cwd: `${remote}/project`,
  });
  let terminalText = "";
  const terminalOutput = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Remote native PTY did not emit probe")),
      15_000,
    );
    const disposable = terminal.onDynamicData(created.id)((chunk) => {
      terminalText += chunk;
      if (terminalText.includes("LOLICODE_REMOTE_TERMINAL_DONE")) {
        clearTimeout(timeout);
        disposable.dispose();
        resolve();
      }
    });
  });
  await terminal.write({
    id: created.id,
    data: "printf 'LOLICODE_RUNTIME_ROOT=%s\\n' \"$ZCODE_SERVER_RUNTIME_ROOT\"; \"$ZCODE_SERVER_RUNTIME_ROOT/agents/glm/zcode-agent\" --version && printf 'LOLICODE_REMOTE_%s\\n' 'CLI_OK'; printf 'LOLICODE_REMOTE_%s\\n' 'TERMINAL_DONE'\r",
  });
  await terminalOutput;
  await writeFile(path.join(owned, "terminal-probe.txt"), terminalText);
  assert.ok(
    terminalText.includes(`LOLICODE_RUNTIME_ROOT=${searchRoot}`),
    "Native server must preserve the real owned binary root while isolating HOME",
  );
  assert.ok(
    terminalText.includes("LOLICODE_REMOTE_CLI_OK"),
    "The genuinely deployed agent wrapper must execute successfully",
  );
  await terminal.dispose({ id: created.id });
  const toolChecks = runSSH(
    `${q(`${searchRoot}/tools/bfs/bfs`)} --version; ${q(`${searchRoot}/tools/ripgrep/rg`)} --version; ${q(`${searchRoot}/tools/ugrep/ugrep`)} --version`,
  );
  assert.match(toolChecks, /bfs 4\.1\.1/);
  assert.match(toolChecks, /ripgrep 14\.1\.1/);
  assert.match(toolChecks, /ugrep 7\.8\.4/);
  assert.ok(commands.every((command) => !command.includes("/.zcode/server")));
  const selectionView = await services.modelSelectionService.getView();
  const actualProvider = selectionView.providers?.find((provider) =>
    provider.models.some((model) => model.modelId === remoteModelId),
  );
  const selection =
    selectionView.preferredSelection?.modelId === remoteModelId
      ? selectionView.preferredSelection
      : actualProvider
        ? {
            providerId: actualProvider.providerId,
            modelId: remoteModelId,
            options: { reasoningLevel: "default" },
          }
        : undefined;
  if (!selection || selection.modelId !== remoteModelId) {
    await writeFile(
      path.join(owned, "selection-view.json"),
      JSON.stringify(selectionView, null, 2),
    );
    throw new Error(
      "The actual remote provider registry did not expose the owned gateway model",
    );
  }
  const tasks = services.zcodeTaskService;
  const task = await tasks.createTask({
    workspacePath: `${remote}/project`,
    mode: "guarded",
    modelSelection: selection,
    v4Create: true,
    deferPersistenceUntilFirstPrompt: true,
  });
  const draftSnapshot = await tasks.getTaskSnapshot({
    taskId: task.taskId,
    workspacePath: `${remote}/project`,
    messageLimit: 200,
    clientMode: "desktop-continuous",
  });
  assert.ok(
    draftSnapshot,
    "The same native draft snapshot required by the UI must be readable before the first prompt",
  );
  assert.equal(draftSnapshot.meta.taskId, task.taskId);
  const inputId = randomUUID();
  const terminalOutcome = new Promise((resolve, reject) => {
    taskTerminalTimeout = setTimeout(
      () =>
        reject(
          new Error("Real remote task did not reach native terminal outcome"),
        ),
      90_000,
    );
    taskTerminalSubscription = tasks.onDynamicTaskTerminalOutcome(task.taskId)(
      (outcome) => {
        if (outcome.inputId === inputId) {
          clearTimeout(taskTerminalTimeout);
          resolve(outcome);
        }
      },
    );
  });
  terminalOutcome.catch(() => {});
  await tasks.sendPrompt({
    taskId: task.taskId,
    traceId: inputId,
    content: `Use Read to read ${remote}/project/probe.txt, then reply exactly ${completionMarker}. Do not modify files or run commands.`,
    clientMode: "desktop-continuous",
    modelSelection: selection,
  });
  const outcome = await terminalOutcome;
  taskTerminalSubscription.dispose();
  assert.equal(
    outcome.outcome,
    "succeeded",
    "Native terminal event must confirm success, rather than prompt ACK",
  );
  const taskSnapshot = await tasks.getTaskSnapshot({
    taskId: task.taskId,
    workspacePath: `${remote}/project`,
    messageLimit: 200,
    clientMode: "desktop-continuous",
  });
  assert.ok(
    taskSnapshot.messages.some(
      (message) =>
        message.role === "assistant" &&
        String(message.content).includes(completionMarker),
    ),
    "Authoritative native snapshot must contain the streamed assistant response",
  );
  assert.ok(modelRequests >= 2 && modelRequests <= 6);
  assert.ok(
    readToolIssued && readToolResultSeen,
    "The real remote Read tool result must return through the native agent into the second model call",
  );
  assert.ok(requestedModels.every((id) => id === remoteModelId));
  assert.ok(runtimePreferenceScopes.includes("runtime-materialization"));
  assert.ok(runtimePreferenceScopes.includes("user-execution"));
  await owner.disconnect("owned-linux-gate");
  assert.ok(
    captured.some((line) => line.includes("stdio shutdown completed")),
    "Native remote server must report actual graceful shutdown",
  );
  assert.equal(owner.list().length, 0);
  const evidence = {
    sourceRevision: manifest.sourceRevision,
    upstreamVersion: manifest.upstreamVersion,
    node: manifest.node.version,
    platform: manifest.platform,
    requiredGlibcSymbols: manifest.native.requiredGlibcSymbols,
    remoteTemporaryRoot: remote,
    nativeDeploy: true,
    reusedVerifiedDeployment: reuseDeployment,
    serverHandshake: true,
    originalZcodeRootUntouched: true,
    rpcFileRead: true,
    nativePtySpawn: true,
    nativeSearchTools: ["bfs 4.1.1", "ripgrep 14.1.1", "ugrep 7.8.4"],
    gatewayRelayConnected: true,
    gatewayReadOnlyRequests: gatewayRequests,
    nativeAgentCliExecuted: true,
    gracefulDisconnect: true,
    remoteTaskTerminalOutcome: outcome.outcome,
    remoteTaskSnapshotAssistant: true,
    remoteTaskDraftSnapshotReadable: true,
    remoteNativeReadTool: true,
    upstreamManualModelSchema: true,
    nativeHostRuntimePreferences: runtimePreferenceScopes,
    remoteModelRoute: remoteModelId,
    modelRequests,
    paidCalls: 0,
  };
  await writeFile(
    path.join(owned, "result.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  passed = true;
  console.log = originalLog;
  console.info = originalInfo;
  console.log(
    JSON.stringify(
      { ...evidence, localEvidence: path.join(owned, "result.json") },
      null,
      2,
    ),
  );
} catch (error) {
  console.log = originalLog;
  console.info = originalInfo;
  // This fixture never loads credentials. Retain the isolated protocol log for
  // diagnosis, without returning arbitrary SSH/native errors to product users.
  await writeFile(path.join(owned, "protocol.log"), captured.join("\n"));
  console.error(
    `Owned Linux gate failed: ${error.message}; diagnostic=${path.join(owned, "protocol.log")}; remote=${remote}`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(taskTerminalTimeout);
  taskTerminalSubscription?.dispose();
  await Promise.race([
    owner?.dispose(),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      timer.unref();
    }),
  ]);
  await backend.disposeAndWait();
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
  if (!passed)
    console.error(
      "The remote integration gate has not passed. No remote compatibility claim is made.",
    );
}
