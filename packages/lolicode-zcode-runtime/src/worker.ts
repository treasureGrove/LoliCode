import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { CompatibilityAgent } from "./compat.js";
import { providerFile, emptyBuiltinFile, provisionRemoteCatalog, validateGateway, type Catalog, type Gateway } from "./provider-bridge.js";

type Bootstrap = { token: string; privateRoot: string };
let startupStage = "bootstrap";
async function main() {
const rawOutput = process.stdout.write.bind(process.stdout);
// stdout is a one-frame process handshake, never an upstream logger transport.
// Do not forward arbitrary upstream console messages or exception objects to UI.
console.log = console.info = console.warn = console.error = () => {};
let closing = false;
let updating = false;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const bootstrap = await new Promise<Bootstrap>((resolveBootstrap, reject) => {
  const timer = setTimeout(() => reject(new Error("Missing private bootstrap")), 15_000);
  lines.once("line", (line) => {
    clearTimeout(timer);
    try {
      if (Buffer.byteLength(line) > 65_536) throw new Error("Bootstrap too large");
      const parsed = JSON.parse(line);
      if (typeof parsed.token !== "string" || parsed.token.length < 48 || typeof parsed.privateRoot !== "string" || !isAbsolute(parsed.privateRoot)) throw new Error("Invalid private bootstrap");
      resolveBootstrap(parsed);
    } catch { reject(new Error("Invalid private bootstrap")); }
  });
});
const privateRoot = resolve(bootstrap.privateRoot);
const runtimeDir = dirname(process.argv[1]);
await mkdir(privateRoot, { recursive: true });
const privateHome = join(privateRoot, "home");
await mkdir(privateHome, { recursive: true });
// Skills/config discovery also uses HOME directly; ZCODE_DATA_BASE_DIR alone
// does not isolate those upstream owners. Preserve only a path reference for
// the SSH backend to use OpenSSH's existing user-authorized configuration.
process.env.LOLICODE_SSH_CONFIG_PATH ??= join(process.env.USERPROFILE || process.env.HOME || privateHome, ".ssh", "config");
process.env.HOME = privateHome;
process.env.USERPROFILE = privateHome;
process.env.XDG_CONFIG_HOME = join(privateHome, ".config");
process.env.XDG_DATA_HOME = join(privateHome, ".local", "share");
process.env.ZCODE_DATA_BASE_DIR = privateRoot;
process.env.ZCODE_DYNAMIC_WORKFLOW_MODE = "onDemand";
// LoliCode owns channels and account login in Rust. The embedded native Host
// must not require or silently refresh another product's cloud provider list.
const localControlOrigin = "http://127.0.0.1:1";
process.env.ZCODE_ENDPOINT_ORIGIN = localControlOrigin;
process.env.ZCODE_BASE_URL = localControlOrigin;
const builtinPath = join(privateRoot, "builtin-provider.json");
const { Services, NodeServices, ProviderNode, Shared } = await import("./services.mjs");
const { SharedV4 } = await import("./protocol.mjs");
const { createCapabilityFacade } = await import("./capabilities.js");
const { createNativeExtensionAdapter } = await import("./extensions.js");
NodeServices.setDataBaseDir(privateRoot);
const configDirectory = NodeServices.getAppConfigDir();
await mkdir(configDirectory, { recursive: true });
const personalPath = join(configDirectory, "provider_config.json");
process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinPath;
process.env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE = builtinPath;
process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalPath;
// An embedded runtime must never inherit the caller's API keys or SDK baseURL.
for (const key of Object.keys(process.env)) {
  if (/^(?:OPENAI|ANTHROPIC|DEEPSEEK|ZHIPU|GLM|BIGMODEL|ZAI|AZURE_OPENAI|GEMINI|GOOGLE_AI|COPILOT|GITHUB)_.*(?:KEY|TOKEN|BASE_URL|ENDPOINT|SECRET)$/.test(key)) delete process.env[key];
}

async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}
await atomicJson(builtinPath, emptyBuiltinFile);
// Gateway leases are supplied afresh by Rust on open. Stale lease files are
// cleared before native services/scheduler start after a desktop restart.
await atomicJson(personalPath, { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } });
const clientFile = join(privateRoot, "client-id");
let clientId: string;
try { clientId = (await readFile(clientFile, "utf8")).trim(); if (!/^[\da-f-]{36}$/i.test(clientId)) throw new Error("Invalid identity"); }
catch (error: any) { if (error.code !== "ENOENT") throw new Error("Invalid private runtime identity"); clientId = randomUUID(); await writeFile(clientFile, clientId, { mode: 0o600, flag: "wx" }); }

startupStage = "native-services";
let facade: ReturnType<typeof createCapabilityFacade>;
let currentCatalog: Catalog = { revision: 0, models: [] };
let currentGateway: Gateway | undefined;
let currentProviderConfig: string | undefined;
let gatewayLeases = 0;
let rawServices: any;
const apiNetwork = NodeServices.createHostApiNetworkTransport(async () => {
  const settings = rawServices ? await rawServices.get(Services.ISettingService).get() : {};
  return { httpProxy: settings.httpProxy, noProxy: settings.httpProxyNoProxy, caCertPath: settings.httpProxyCaCertPath };
});
const localControlTransport = {
  ...apiNetwork,
  fetch: async (input: any, init: any) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin === localControlOrigin) {
      if (url.pathname === "/api/v1/client/configs" && (!init?.method || init.method === "GET")) {
        return Response.json({ code: 0, data: { configs: {} } });
      }
      throw new Error("请通过 LoliCode 的渠道与模型管理账号和模型");
    }
    return apiNetwork.fetch(input, init);
  },
};
rawServices = NodeServices.createLocalServices({
  zcodeBuiltinProviderConfigFilePath: builtinPath,
  hostApiNetworkTransport: localControlTransport,
  runtimeProcessEnvPatch: {
    ZCODE_DATA_BASE_DIR: privateRoot,
    ZCODE_DYNAMIC_WORKFLOW_MODE: "onDemand",
    ZCODE_ENDPOINT_ORIGIN: localControlOrigin,
    ZCODE_BASE_URL: localControlOrigin,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath,
    ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: builtinPath,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
    HOME: privateHome, USERPROFILE: privateHome,
  },
  zcodeAgentCommandResolver: ({ workspacePath }: any) => ({
    command: process.execPath,
    args: [join(runtimeDir, "runtimeCLI.cjs"), "app-server", "--stdio"],
    cwd: workspacePath,
    // Native resolveSpawnEnv owns endpoint-scoped registry paths. Replacing
    // them with process.env splits the CLI/account config generations and
    // causes later personal-model refreshes to retain the old registry.
  }),
  zcodeAgentSpawnFallbackCwd: privateRoot,
  onAutomationManualRunRequested: (claimed: any) => facade.automation.dispatchManual(claimed),
});
const connection = Services.createZCodeAgentConnectionScope(rawServices.get(Services.IZCodeAgentService), { connectionId: randomUUID(), clientMode: "desktop-continuous", role: "trusted-host-relay" });
const services = {
  get: (descriptor: any) => descriptor === Services.IZCodeAgentService ? connection.service : rawServices.get(descriptor),
  getOptional: (descriptor: any) => descriptor === Services.IZCodeAgentService ? connection.service : rawServices.getOptional(descriptor),
};
startupStage = "native-handshake";
await connection.service.helloConversationV4();
await connection.service.initializeConversationV4({ kind: "clientHello", protocolVersion: SharedV4.V4_WIRE_PROTOCOL_VERSION, clientId, clientKind: "desktop", appVersion: "LoliCode", capabilities: { workspaceHookReviewUi: false } });
startupStage = "native-capabilities";
facade = createCapabilityFacade({
  services, privateRoot,
  remoteOptions: {
    connectOptions: { mockCdnDir: join(runtimeDir, "remote-assets") },
    resolveRuntimePreferences: async (request: any) => {
      const settings = await rawServices.get(Services.ISettingService).get();
      return {
        askUserQuestionAutoResolutionEnabled: settings.askUserQuestionAutoResolutionEnabled !== false,
        nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
        memoryEnabled: settings.memoryEnabled === true,
        modelContextBudgetStrategy: Shared.DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
        ...(request.scope === "user-execution" && settings.integratedTerminalShell ? { integratedTerminalShell: settings.integratedTerminalShell } : {}),
      };
    },
    acquireGatewayLease: async () => {
      if (!currentGateway) throw new Error("请先打开本地项目以准备渠道目录");
      const leasedGateway = { ...currentGateway };
      gatewayLeases++;
      let released = false;
      return { ...leasedGateway, release: () => { if (!released) { released = true; gatewayLeases--; } } };
    },
    provisionGateway: ({ services: remoteServices, baseUrl, apiKey }: any) => provisionRemoteCatalog(remoteServices, Services.IProviderSettingsService, currentCatalog, baseUrl, apiKey),
  },
});
const compat = new CompatibilityAgent({
  privateRoot, agent: connection.service, v4: SharedV4, clientId,
  // A connected remote holds an immutable gateway lease even while idle.
  // Rust must see that lease before preparing/rotating a new local gateway.
  extraBusy: () => facade.busy() || gatewayLeases > 0,
  configureCatalog: async (catalog, gateway) => {
    validateGateway(gateway);
    if (!catalog || !Array.isArray(catalog.models) || !Number.isSafeInteger(catalog.revision)) throw new Error("Invalid channel catalog");
    const config = providerFile(catalog, gateway);
    // Both directions use the official codecs; reject incompatible config
    // before touching the currently active private provider file.
    const validated = ProviderNode.encodeProviderConfigFile(ProviderNode.decodeProviderConfigFile(config));
    const serialized = JSON.stringify(validated);
    if (serialized === currentProviderConfig) { currentCatalog = catalog; currentGateway = gateway; return; }
    if (gatewayLeases > 0) throw new Error("请先断开远程项目连接，再刷新渠道目录");
    if (await compat.busy()) throw new Error("正在执行任务，结束后将同步渠道目录");
    await atomicJson(personalPath, validated);
    await rawServices.get(Services.IProviderSettingsService).refresh("lolicode-channel-catalog");
    currentCatalog = catalog; currentGateway = gateway; currentProviderConfig = serialized;
  },
});
await compat.start();
const extensions = createNativeExtensionAdapter({ services, privateRoot, homeDirectory: privateHome, workspace: () => compat.workspace(), isBusy: () => compat.cachedBusy() || facade.busy() });
const extensionMethods: Record<string, (args: any) => Promise<unknown>> = {
  getExtensions: () => extensions.getExtensions(),
  getExtensionConfig: () => extensions.getExtensionConfig(),
  setSkillEnabled: (args) => extensions.setSkillEnabled(args.id, args.enabled),
  importSkill: (args) => extensions.importSkill(args.path),
  removeSkill: (args) => extensions.removeSkill(args.id),
  installPlugin: (args) => extensions.installPlugin(args.path),
  setPluginEnabled: (args) => extensions.setPluginEnabled(args.id, args.enabled),
  uninstallPlugin: (args) => extensions.uninstallPlugin(args.id),
  saveExtensionConfig: (args) => extensions.saveExtensionConfig(args.config),
};
// Scheduling only begins when a valid local model catalog has been supplied;
// persisted jobs cannot fire against stale credentials during boot.
let schedulerStarted = false;
const methods = new Set(["status", "catalog", "openProject", "listSessions", "createSession", "updateSession", "renameSession", "setSessionMetadata", "deleteSession", "getSession", "sendMessage", "queryCommand", "runSavedWorkflow", "interruptSession", "replyPermission", "replyQuestion", "rejectQuestion", "closeProject", "busy"]);
const controlMethods = new Set(["start", "wake", "flush", "status", "runNow", "list", "create", "update", "delete", "setEnabled", "restart", "listRuns", "deleteRun"]);
const remoteMethods = new Set(["connect", "disconnect", "list", "listWSL", "bindWorkspace"]);
const activeRpc = new Set<Promise<unknown>>();

function sanitizedError(error: unknown) {
  let message = error instanceof Error ? error.message : "ZCode 操作未完成，请重试";
  for (const secret of [bootstrap.token, currentGateway?.bearerToken]) if (secret) message = message.replaceAll(secret, "[redacted]");
  return message.replace(/(?:Bearer\s+)[^\s"']+/gi, "Bearer [redacted]").replace(/([?&](?:key|token|api_key)=)[^&#\s]+/gi, "$1[redacted]").slice(0, 500);
}
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:apiKey|bearerToken|authorization|secret|password)$/i.test(key) ? "[redacted]" : redact(item)]));
  return value;
}
async function dispatch(method: string, args: any) {
  if (closing) throw new Error("LoliCode runtime is closing");
  if (updating && !["endUpdate", "shutdown", "status", "activity", "busy"].includes(method)) throw new Error("正在准备更新，请稍后重试");
  if (method === "shutdown") { setImmediate(() => void shutdown()); return null; }
  if (method === "beginUpdate") {
    updating = true;
    try {
      // A snapshot already admitted by HTTP may still be materializing a cold
      // session. Drain that work before the final native idle decision.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...activeRpc]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("后台请求尚未结束，请稍后重试更新")), 5_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      await facade.beginUpdate();
      if (facade.remote?.list().length || gatewayLeases > 0) throw new Error("请先断开远程项目连接，再安装更新");
      if (await compat.busy()) throw new Error("还有编程、工作流或自动化任务正在执行，请结束后更新");
      return null;
    } catch (error) { updating = false; facade.endUpdate(); throw error; }
  }
  if (method === "endUpdate") { updating = false; facade.endUpdate(); return null; }
  if (Object.hasOwn(extensionMethods, method)) return extensionMethods[method](args);
  if (method === "capability") return redact(await facade.dispatch(args.service, args.method, args.args ?? [], args.scope));
  if (method === "capabilities") return facade.list();
  if (method === "activity") return facade.activity();
  if (method === "automation") {
    if (!controlMethods.has(args.method)) throw new Error("Unknown automation operation");
    const owner: any = facade.automation;
    const target = typeof owner[args.method] === "function" ? owner : owner.service;
    if (typeof target[args.method] !== "function") throw new Error("Unknown automation operation");
    return redact(await target[args.method](...(args.args ?? [])));
  }
  if (method === "remote") {
    if (!remoteMethods.has(args.method) || !facade.remote) throw new Error("Unknown remote operation");
    return redact(await (facade.remote as any)[args.method](...(args.args ?? [])));
  }
  if (!methods.has(method)) throw new Error("Unknown runtime operation");
  if (method === "openProject") {
    // Prevent a timer claim from racing the final idle check and file commit.
    await facade.beginUpdate();
    try {
      const result = await compat.openProject(args);
      if (!schedulerStarted) { await facade.start(); schedulerStarted = true; }
      return result;
    } finally { facade.endUpdate(); }
  }
  const result = await (compat as any)[method](args ?? {});
  return result ?? null;
}
function authorized(request: IncomingMessage) {
  const header = request.headers.authorization;
  if (typeof header !== "string") return false;
  const expected = Buffer.from(`Bearer ${bootstrap.token}`), actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function json(response: ServerResponse, status: number, body: any) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}
const server = createServer(async (request, response) => {
  if (!authorized(request)) { json(response, 401, { ok: false, error: "Unauthorized" }); return; }
  if (request.method !== "POST" || request.url !== "/rpc" || request.headers.origin) { json(response, 403, { ok: false, error: "Private desktop transport only" }); return; }
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error("Request exceeds runtime limit"); chunks.push(chunk); }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed.method !== "string" || !parsed.args || typeof parsed.args !== "object" || Array.isArray(parsed.args)) throw new Error("Invalid request");
    const operation = dispatch(parsed.method, parsed.args);
    if (!["beginUpdate", "endUpdate", "shutdown", "status", "activity", "busy"].includes(parsed.method)) activeRpc.add(operation);
    let result;
    try { result = await operation; } finally { activeRpc.delete(operation); }
    json(response, 200, { ok: true, result });
  } catch (error) { json(response, 200, { ok: false, error: sanitizedError(error) }); }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  const force = setTimeout(() => process.exit(1), 10_000); force.unref();
  const trace = (stage: string) => { if (process.env.LOLICODE_RUNTIME_DIAGNOSTICS === "1") process.stderr.write(`${JSON.stringify({ event: "shutdown", stage })}\n`); };
  let clean = true;
  const cleanup = async (stage: string, operation: () => Promise<unknown> | unknown) => {
    trace(stage);
    try { await operation(); } catch { clean = false; trace(`${stage}-failed`); }
  };
  try {
    // A failed adapter cleanup must not skip native process-tree cleanup or
    // falsely report a successful EOF shutdown to the desktop/tests.
    await cleanup("facade", () => facade.dispose());
    await cleanup("compat", () => compat.dispose());
    await cleanup("connection", () => connection.dispose());
    await cleanup("native-resources", () => NodeServices.disposeServiceResourcesAndWait(rawServices));
    await cleanup("clear-lease", () => atomicJson(personalPath, { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }));
  } finally { clearTimeout(force); trace(clean ? "completed" : "failed"); process.exit(clean ? 0 : 1); }
}
lines.on("close", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("uncaughtException", () => void shutdown());
process.on("unhandledRejection", () => void shutdown());
await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("Private listener unavailable");
rawOutput(`${JSON.stringify({ event: "ready", port: address.port })}\n`);
}
void main().catch(() => { process.stderr.write(`${JSON.stringify({ event: "startup-failed", stage: startupStage })}\n`); process.exit(1); });
