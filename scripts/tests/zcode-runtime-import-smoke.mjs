// Offline module/ABI validation only. Does not create a service, session, shell,
// remote connection, provider/account manager, or model request.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const runtime = path.join(repository, "src-tauri/resources/zcode-runtime");
const owned = await mkdtemp(path.join(os.tmpdir(), "lolicode-zcode-import-"));
try {
  const manifest = JSON.parse(
    await readFile(path.join(runtime, "runtime-manifest.json"), "utf8"),
  );
  if (manifest.sourceRevision !== "aac4755666d09fdcd70272fcf063c077a639015f")
    throw new Error("Unpinned runtime");
  const program = `
    import { createRequire } from 'node:module';
    const services = await import(${JSON.stringify(pathToFileURL(path.join(runtime, "services.mjs")).href)});
    const remote = await import(${JSON.stringify(pathToFileURL(path.join(runtime, "remote.mjs")).href)});
    const protocol = await import(${JSON.stringify(pathToFileURL(path.join(runtime, "protocol.mjs")).href)});
    const require = createRequire(${JSON.stringify(path.join(runtime, "package.json"))});
    const pty = require('node-pty');
    const koffi = require('koffi');
    const checks = {
      services: typeof services.NodeServices.createLocalServices === 'function',
      serviceContracts: typeof services.Services.ServiceCollection === 'function',
      rpc: typeof services.Rpc.ChannelClient === 'function',
      provider: typeof services.ProviderNode.NodeProviderRegistryRuntime === 'function',
      remote: typeof remote.Remote.connectRemote === 'function',
      wsl: typeof remote.Remote.WSLBackend === 'function',
      bootstrap: typeof protocol.Bootstrap.createZCodeApp === 'function',
      protocol: !!protocol.SharedV4.V4_METHODS,
      pty: typeof pty.spawn === 'function',
      ffi: typeof koffi.load === 'function'
    };
    if (Object.values(checks).some(value => !value)) throw new Error('Missing runtime export');
    console.log(JSON.stringify({sourceRevision:${JSON.stringify(manifest.sourceRevision)},node:process.version,checks}));
  `;
  const env = Object.fromEntries(
    [
      "PATH",
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "PATHEXT",
      "NUMBER_OF_PROCESSORS",
      "PROCESSOR_ARCHITECTURE",
    ]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    HOME: owned,
    USERPROFILE: owned,
    APPDATA: path.join(owned, "appdata"),
    LOCALAPPDATA: path.join(owned, "localappdata"),
    TEMP: owned,
    TMP: owned,
    ZCODE_DATA_BASE_DIR: owned,
    ZCODE_STORAGE_DIR: path.join(owned, "storage"),
    ZCODE_MODEL_TELEMETRY_ENABLED: "false",
    NODE_ENV: "test",
  });
  const result = spawnSync(
    path.join(runtime, process.platform === "win32" ? "node.exe" : "node"),
    ["--input-type=module", "-e", program],
    { cwd: owned, env, encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0)
    throw new Error(
      `Owned runtime import failed: ${(result.stderr || result.error?.message || "").slice(0, 3000)}`,
    );
  process.stdout.write(result.stdout);
  const help = spawnSync(
    path.join(runtime, "node.exe"),
    [path.join(runtime, "runtimeCLI.cjs"), "--help"],
    { cwd: owned, env, encoding: "utf8", timeout: 30_000 },
  );
  if (help.status !== 0 || !/Usage:|app-server|ZCode/i.test(help.stdout))
    throw new Error(
      `Owned CLI help failed: ${(help.stderr || help.error?.message || "").slice(0, 2000)}`,
    );
  console.log(
    JSON.stringify({
      cliHelp: true,
      modelRequests: 0,
      userConfiguration: "isolated",
    }),
  );
} finally {
  // The absolute target comes directly from mkdtemp, never from arguments/config.
  await rm(owned, { recursive: true, force: true });
}
