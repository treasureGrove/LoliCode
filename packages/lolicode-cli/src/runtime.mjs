import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { access, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { home } from "./config.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const exists = (file) => access(file).then(() => true, () => false);

export async function resolveRuntime() {
  const roots = [
    ...(process.env.LOLICODE_RUNTIME_DIR ? [path.resolve(process.env.LOLICODE_RUNTIME_DIR)] : []),
    packageRoot,
    path.resolve(packageRoot, "../../src-tauri/resources/agent/harness-runtime"),
  ];
  for (const root of roots) {
    const require = createRequire(path.join(root, "package.json"));
    try {
      const manifest = require.resolve("@deepseek-ai/dsh/package.json");
      const cli = path.join(path.dirname(manifest), "lib/bin.js");
      const protocol = require.resolve("@deepseek-ai/dsh-sdk-protocol");
      const overlays = root === packageRoot ? path.join(root, "runtime") : root;
      if (await exists(cli) && await exists(path.join(overlays, "host-operations.mjs"))) return { cli, protocol, overlays };
    } catch { /* Try the next installed runtime. */ }
  }
  throw new Error("Harness runtime is missing. Reinstall LoliCode CLI, or run its prepare:runtime script when developing from source.");
}

export async function startRuntime({ channel, cwd, onNotification, onRequest }) {
  const runtime = await resolveRuntime();
  const { JsonRpcLineTransport } = await import(pathToFileURL(runtime.protocol).href);
  const directory = path.join(home, "runtime");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(directory, "launch-"));
  const patch = path.join(temporary, "channel.json");
  const provider = "lolicode-gateway";
  // Secrets remain in the child environment; patches contain only variable names.
  await writeFile(patch, JSON.stringify([{
    id: "llm-pi-ai",
    config: { providers: { [provider]: {
      api: channel.api, apiKeyEnv: channel.apiKeyEnv, baseURL: channel.baseURL,
      ...(channel.api === "openai-completions" && { compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" } }),
      models: [{ id: channel.model, name: channel.model, input: ["text"], contextWindow: channel.contextWindow || 128000, maxTokens: channel.maxTokens || 8192 }],
    } } },
  }, {
    id: "system-prompt", config: { includeHarnessIdentity: false, personaPrefix: "You are LoliCode, the user's coding companion in the terminal. Respond in the user's language. Use a friendly, concise style. For playful reactions use 🐾. Describe tool results accurately and do not claim unverified success." },
  }]), { mode: 0o600 });
  const child = spawn(process.execPath, [runtime.cli, "--profile", "sdk",
    "--patch", path.join(runtime.overlays, "profile.cordis.patch.yml"),
    "--patch", path.join(runtime.overlays, "host-operations.cordis.patch.yml"),
    "--patch", patch,
  ], {
    cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DSH_HOME: path.join(home, "harness"), DSH_TELEMETRY_DISABLED: "1" },
  });
  let diagnostic = "";
  child.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes).slice(-12000); });
  child.stdin.on("error", () => {});
  const exited = new Promise(resolve => {
    child.once("error", error => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
  transport.onNotification(onNotification);
  transport.onRequest(onRequest);
  transport.start();
  const request = async (method, params = {}, signal) => {
    try {
      return await Promise.race([
        transport.request(method, params, signal),
        exited.then(result => { throw result.error || new Error(`Harness stopped (${result.signal || result.code}). ${diagnostic}`); }),
      ]);
    } catch (error) {
      // A provider can echo its Authorization header in an error response.
      const secret = process.env[channel.apiKeyEnv];
      if (secret) error.message = error.message.split(secret).join("[redacted]");
      throw error;
    }
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await request("shutdown", {}, AbortSignal.timeout(5000)); }
    catch { child.kill(); }
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
    transport.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    await request("initialize", { cwd, provider, model: channel.model, approvalRequests: true, capabilities: { userQuestions: true } }, AbortSignal.timeout(60000));
  } catch (error) { await close(); throw error; }
  return { request, close };
}
