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
export const checkpoints = [
  "config",
  "native-bridge",
  "build-identity",
  "harness-status",
  "window-visible",
  "root-painted",
  "workspace-painted",
  "profile-menu",
  "settings-menu",
  "language-control",
  "chinese-option",
  "chinese-copy",
  "chinese-persisted",
  "english-option",
  "english-copy",
  "english-persisted",
  "settings-return",
  "agent-entry",
  "agent-content",
  "agent-ready",
  "tavern-entry",
  "tavern-enable",
  "tavern-enabled",
  "tavern-visible",
  "tavern-catalog",
  "tavern-section",
  "tavern-ready",
  "tavern-heading",
  "tavern-snapshot",
  "agent-return",
  "success-report",
  "native-exit",
];
export const failureCodes = [
  "assertion",
  "timeout",
  "ipc-rejected",
  "request-failed",
  "geometry-hidden",
  "document-hidden",
  "origin-mismatch",
  "build-channel",
  "build-profile",
  "build-revision",
  "harness-unavailable",
  "harness-version",
  "tavern-catalog-unexpected",
  "unknown",
];
const hostCodes = [
  "cancelled",
  "gui-handshake-deadline",
  "native-exit-deadline",
  "native-deadline",
  "report-failed",
  "report-body",
  "server-start",
  "server-close",
  "owned-process-cleanup",
];
export function safeDiagnostic(report) {
  return {
    checkpoint: checkpoints.includes(report?.checkpoint)
      ? report.checkpoint
      : "unknown",
    code: failureCodes.includes(report?.failureCode)
      ? report.failureCode
      : "unknown",
  };
}
const nativeClasses = [
  "cli-config",
  "compile",
  "native-exit-before-handshake",
  "native-exit-after-handshake",
  "running-or-unknown",
  "log-unavailable",
];
export function classifyNativeLog(text, exit, handshakeSeen) {
  const rustErrors = [
    ...new Set(
      [...text.matchAll(/\berror\[(E[0-9]{4})\]/g)].map((match) => match[1]),
    ),
  ].slice(0, 12);
  const classification =
    /could not compile|failed to run custom build command|\berror\[E[0-9]{4}\]/i.test(
      text,
    )
      ? "compile"
      : /(?:failed to (?:parse|read)|invalid)[^\r\n]{0,80}(?:tauri[^\r\n]{0,20})?config|error[^\r\n]{0,80}configuration/i.test(
            text,
          )
        ? "cli-config"
        : exit
          ? handshakeSeen
            ? "native-exit-after-handshake"
            : "native-exit-before-handshake"
          : "running-or-unknown";
  return {
    classification,
    rustErrors,
    exitCode:
      Number.isInteger(exit?.code) && exit.code >= 0 && exit.code <= 255
        ? exit.code
        : null,
  };
}
async function readNativeDiagnostic(file, exit, handshakeSeen) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const bytes = Buffer.alloc(Math.min(size, 262144));
    const { bytesRead } = await handle.read(
      bytes,
      0,
      bytes.length,
      Math.max(0, size - bytes.length),
    );
    return classifyNativeLog(
      bytes.subarray(0, bytesRead).toString("utf8"),
      exit,
      handshakeSeen,
    );
  } finally {
    await handle.close();
  }
}
export function formatSummary(stage, revision, diagnostic = {}) {
  const stages = [
    "host",
    "server",
    "native-build-and-gui",
    "gui-handshake",
    "native-normal-exit",
    "report-and-exit",
    "cleanup",
    "passed",
    ...phases.map((phase) => "gui-" + phase),
    "gui-exit",
  ];
  const safeStage = stages.includes(stage) ? stage : "unknown";
  const checkpoint = checkpoints.includes(diagnostic.checkpoint)
    ? diagnostic.checkpoint
    : "unknown";
  const code = [...failureCodes, ...hostCodes, "none"].includes(diagnostic.code)
    ? diagnostic.code
    : "unknown";
  const sha = /^[a-f0-9]{40}$/.test(revision ?? "") ? revision : "invalid";
  const nativeClass = nativeClasses.includes(diagnostic.classification)
    ? diagnostic.classification
    : "running-or-unknown";
  const exitCode =
    Number.isInteger(diagnostic.exitCode) &&
    diagnostic.exitCode >= 0 &&
    diagnostic.exitCode <= 255
      ? diagnostic.exitCode
      : "unknown";
  const rustErrors = Array.isArray(diagnostic.rustErrors)
    ? diagnostic.rustErrors
        .filter((code) => typeof code === "string" && /^E[0-9]{4}$/.test(code))
        .slice(0, 12)
        .join(",") || "none"
    : "none";
  return `Native GUI smoke: ${safeStage === "passed" ? "PASS" : "FAIL"}; stage: ${safeStage}; checkpoint: ${checkpoint}; code: ${code}; SHA: ${sha}; native-class: ${nativeClass}; exit-code: ${exitCode}; rust-errors: ${rustErrors}. Test-instrumented renderer on disposable hosted VM; not release-package or user-machine acceptance.`;
}
export function smokeWindow(config) {
  const window = config.app.windows.find((window) => window.label === "main");
  assert.ok(window, "Missing main window");
  return {
    ...window,
    title: "Test-instrumented native GUI smoke",
    visible: true,
  };
}
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
  let guiTimer,
    exitTimer,
    rejectLifecycle,
    privateLog,
    privateLogPath,
    nativeExit;
  let handshakeSeen = false;
  let diagnostic = { checkpoint: "unknown", code: "unknown" };
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
            handshakeSeen = true;
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
              diagnostic = safeDiagnostic(report);
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
            smokeWindow(
              JSON.parse(
                await readFile(
                  path.join(root, "src-tauri/tauri.conf.json"),
                  "utf8",
                ),
              ),
            ),
          ],
        },
        bundle: { active: false, createUpdaterArtifacts: false },
        plugins: { updater: { endpoints: [] } },
      }),
    );
    stage = "native-build-and-gui";
    const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
    privateLogPath = path.join(temporary, "native-build-gui.log");
    privateLog = await open(privateLogPath, "wx", 0o600);
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
      child.once("close", (code, signal) => {
        nativeExit = { code, signal };
        resolve(nativeExit);
      });
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
    diagnostic = { checkpoint: "native-exit", code: "none" };
  } catch (error) {
    if (diagnostic.code === "unknown")
      diagnostic.code = hostCodes.includes(error?.message)
        ? error.message
        : error?.code === "ERR_ASSERTION"
          ? "assertion"
          : "unknown";
    throw error;
  } finally {
    // Freeze natural exit before cleanup signals; cleanup must not look like an app crash.
    const naturalExit = nativeExit;
    try {
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
    } catch (error) {
      stage = "cleanup";
      diagnostic.code = hostCodes.includes(error?.message)
        ? error.message
        : "unknown";
      throw error;
    } finally {
      if (privateLogPath) {
        try {
          diagnostic = {
            ...diagnostic,
            ...(await bounded(
              readNativeDiagnostic(privateLogPath, naturalExit, handshakeSeen),
              5000,
              "diagnostic-read",
            )),
          };
        } catch {
          diagnostic.classification = "log-unavailable";
        }
      }
      const summary = formatSummary(stage, revision, diagnostic);
      console.log(summary);
      if (stage !== "passed")
        console.log(`::error title=Native GUI smoke::${summary}`);
      if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
    }
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
