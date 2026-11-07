import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  appendFile,
  open,
} from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const phases = [
  "identity",
  "harness",
  "paint",
  "language",
  "navigation",
];
export function validateReport(report, fixture) {
  assert.equal(report.nonce, fixture.nonce);
  assert.equal(report.revision, fixture.revision);
  assert.equal(report.result, "passed");
  assert.deepEqual(report.phases, phases);
}
export function validateHost(
  env = process.env,
  platform = process.platform,
  arch = process.arch,
) {
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(env.GITHUB_REPOSITORY, "treasureGrove/LoliCode");
  assert.equal(env.GITHUB_REF, "refs/heads/test/native-gui-smoke-20261107");
  assert.ok(["darwin", "linux"].includes(platform));
  assert.equal(platform, env.EXPECTED_PLATFORM);
  assert.equal(arch, env.EXPECTED_ARCH);
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.ok(env.RUNNER_TEMP);
  if (platform === "linux") {
    assert.ok(env.DISPLAY);
    assert.ok(env.DBUS_SESSION_BUS_ADDRESS);
  }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let stage = "host",
    vite,
    child,
    outcome,
    report,
    protocolFailure;
  let guiTimer, exitTimer, rejectLifecycle, privateLog;
  const lifecycle = new Promise((_, reject) => {
    rejectLifecycle = reject;
  });
  // Mark it handled before Vite starts; it is raced with the native child below.
  lifecycle.catch(() => {});
  const cancel = () => rejectLifecycle(new Error("cancelled"));
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  const revision = process.env.GITHUB_SHA;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  try {
    validateHost();
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      revision,
    );
    if (process.platform === "darwin")
      execFileSync("pgrep", ["-x", "WindowServer"], {
        stdio: "ignore",
        timeout: 5000,
      });
    const temporary = await realpath(
      await mkdtemp(path.join(process.env.RUNNER_TEMP, "lolicode-gui-")),
    );
    const home = path.join(temporary, "home");
    const profile = path.join(home, ".lolicode-dev");
    const dirs = {
      HOME: home,
      CC_SWITCH_TEST_HOME: home,
      XDG_CONFIG_HOME: path.join(temporary, "config"),
      XDG_CACHE_HOME: path.join(temporary, "cache"),
      XDG_DATA_HOME: path.join(temporary, "data"),
      XDG_STATE_HOME: path.join(temporary, "state"),
      XDG_RUNTIME_DIR: path.join(temporary, "run"),
      TMPDIR: path.join(temporary, "tmp"),
    };
    for (const dir of new Set([...Object.values(dirs), profile]))
      await mkdir(dir, { recursive: true, mode: 0o700 });
    const pkg = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    await writeFile(
      path.join(profile, "settings.json"),
      JSON.stringify({
        silentStartup: false,
        checkUpdates: false,
        sessionAutoSyncEnabled: false,
        firstRunNoticeConfirmed: true,
        whatsNewSeenVersion: pkg.version,
        newLayoutNoticeConfirmed: true,
        language: "en",
      }),
    );
    const nonce = randomBytes(32).toString("hex");
    const namespace = `/__native_gui_${nonce}/`;
    const fixture = { nonce, revision, profile };
    const env = {
      ...process.env,
      ...dirs,
      CARGO_HOME:
        process.env.CARGO_HOME || path.join(process.env.HOME, ".cargo"),
      RUSTUP_HOME:
        process.env.RUSTUP_HOME || path.join(process.env.HOME, ".rustup"),
      LOLICODE_BUILD_CHANNEL: "development",
      VITE_LOLICODE_BUILD_CHANNEL: "development",
      LOLICODE_BUILD_REVISION: revision,
      VITE_LOLICODE_BUILD_REVISION: revision,
      LOLICODE_BUILD_NUMBER: `DEV-GUI-${process.env.GITHUB_RUN_ID}`,
      LOLICODE_DEV_SOURCE_DIR: root,
      CARGO_TARGET_DIR: path.join(temporary, "target"),
    };
    // Vite's build identity is read at configuration time, before spawning the app.
    process.env.VITE_LOLICODE_BUILD_CHANNEL = "development";
    process.env.VITE_LOLICODE_BUILD_REVISION = revision;
    stage = "server";
    const { createServer } = await import("vite");
    const { default: react } = await import("@vitejs/plugin-react");
    const renderer = await readFile(
      new URL("./native-gui-smoke-renderer.mjs", import.meta.url),
      "utf8",
    );
    const plugin = {
      name: "native-gui-smoke-test-instrumentation",
      enforce: "pre",
      load(id) {
        if (
          id
            .split("?")[0]
            .replaceAll("\\", "/")
            .endsWith("/src/lib/api/lolicode-account.ts")
        )
          return `const unavailable = async () => { throw new Error('Account unavailable in GUI smoke'); }; export const lolicodeAccountApi = {status: async () => ({account:null,persistent:false,warning:null}), login:unavailable, logout:unavailable, refreshRelay:unavailable, relayStatus:unavailable, connectRelay:unavailable};`;
      },
      transformIndexHtml() {
        return [
          {
            tag: "script",
            attrs: { type: "module", src: namespace + "renderer.mjs" },
            injectTo: "body",
          },
        ];
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith(namespace)) return next();
          res.setHeader("Cache-Control", "no-store");
          if (req.method === "GET" && req.url === namespace + "renderer.mjs") {
            res.setHeader("Content-Type", "text/javascript");
            return res.end(renderer);
          }
          if (req.method === "GET" && req.url === namespace + "config") {
            res.setHeader("Content-Type", "application/json");
            stage = "gui-handshake";
            guiTimer ??= setTimeout(
              () => rejectLifecycle(new Error("gui-handshake-deadline")),
              120000,
            );
            return res.end(JSON.stringify(fixture));
          }
          if (req.method === "POST" && req.url === namespace + "report") {
            try {
              assert.equal(req.headers.origin, fixture.origin);
              assert.equal(report, undefined);
              const body = await bounded(
                (async () => {
                  let text = "";
                  for await (const part of req) {
                    text += part;
                    assert.ok(text.length <= 4096);
                  }
                  return text;
                })(),
                5000,
                "report-body",
              );
              report = JSON.parse(body);
              if (
                report.result === "failed" &&
                Array.isArray(report.phases) &&
                report.phases.every((phase, index) => phase === phases[index])
              )
                stage = "gui-" + (phases[report.phases.length] ?? "exit");
              validateReport(report, fixture);
              stage = "native-normal-exit";
              clearTimeout(guiTimer);
              exitTimer = setTimeout(
                () => rejectLifecycle(new Error("native-exit-deadline")),
                15000,
              );
              return res.writeHead(204).end();
            } catch {
              protocolFailure = true;
              rejectLifecycle(new Error("report-failed"));
              return res.writeHead(400).end();
            }
          }
          res.writeHead(404).end();
        });
      },
    };
    vite = await createServer({
      configFile: false,
      cacheDir: path.join(temporary, "vite-cache"),
      root: path.join(root, "src"),
      plugins: [react(), plugin],
      resolve: { alias: { "@": path.join(root, "src") } },
      logLevel: "silent",
      clearScreen: false,
      envPrefix: ["VITE_", "TAURI_"],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: true,
        fs: { allow: [root] },
      },
    });
    await bounded(vite.listen(), 15000, "server-start");
    vite.httpServer.requestTimeout = 10000;
    vite.httpServer.headersTimeout = 10000;
    fixture.origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const overlay = path.join(temporary, "overlay.json");
    await writeFile(
      overlay,
      JSON.stringify({
        productName: "LoliCode GUI Smoke",
        identifier: "art.treasuregrove.lolicode.gui-smoke",
        build: { devUrl: fixture.origin, beforeDevCommand: "" },
        app: {
          windows: [
            {
              label: "main",
              title: "Test-instrumented native GUI smoke",
              width: 1000,
              height: 750,
              visible: true,
            },
          ],
        },
        bundle: { active: false, createUpdaterArtifacts: false },
        plugins: { updater: { endpoints: [] } },
      }),
    );
    stage = "native-build-and-gui";
    const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
    privateLog = await open(
      path.join(temporary, "native-build-gui.log"),
      "wx",
      0o600,
    );
    child = spawn(
      process.execPath,
      [
        cli,
        "dev",
        "--no-watch",
        "--exit-on-panic",
        "--config",
        "src-tauri/tauri.dev.conf.json",
        "--config",
        overlay,
        "--",
        "--locked",
      ],
      {
        cwd: root,
        env,
        detached: true,
        stdio: ["ignore", privateLog.fd, privateLog.fd],
      },
    );
    outcome = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const exit = await bounded(
      Promise.race([outcome, lifecycle]),
      75 * 60_000,
      "native-deadline",
    );
    stage = "report-and-exit";
    assert.ok(!protocolFailure);
    validateReport(report, fixture);
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
    stage = "passed";
  } finally {
    // Only this detached invocation's process group. No system-wide process names.
    if (child?.pid) {
      const signal = (value) => {
        try {
          process.kill(-child.pid, value);
        } catch (e) {
          if (e.code !== "ESRCH") throw e;
        }
      };
      signal("SIGTERM");
      await delay(1500);
      signal("SIGKILL");
      if (outcome) await bounded(outcome, 5000, "owned-process-cleanup");
    }
    if (privateLog) await privateLog.close();
    clearTimeout(guiTimer);
    clearTimeout(exitTimer);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    if (vite) await bounded(vite.close(), 5000, "server-close");
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `Native GUI smoke: ${stage === "passed" ? "PASS" : "FAIL"}; stage: ${stage}; SHA: ${/^[a-f0-9]{40}$/.test(revision ?? "") ? revision : "invalid"}. Test-instrumented renderer on disposable hosted VM; not release-package or user-machine acceptance.\n`,
      );
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error(
      "Native GUI smoke failed. See the non-sensitive stage summary.",
    );
    process.exitCode = 1;
  });
