import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { importRuntime, runtimeFixtureEnvironment, runtimeRoot as root } from "./runtime-fixture.mjs";

const execute = promisify(execFile);
const file = fileURLToPath(import.meta.url);
const terminalBundle = "dsh-experimental-terminal-bundle";
const ralphBundle = "dsh-experimental-ralph-bundle";

async function inspectProfile(mode, home) {
  assert.ok(["default", "ralph", "terminal"].includes(mode));
  const patch = path.join(home, "fixture.json");
  await writeFile(
    patch,
    JSON.stringify([
      { id: "sdk-app-startup", disabled: true },
      { id: "sdk-jsonrpc-server", disabled: true },
      { id: "plugin-manager", disabled: true },
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            "terminal-fixture": {
              apiKeyEnv: "LOLICODE_TERMINAL_FIXTURE_TOKEN",
              api: "openai-completions",
              baseURL: "http://127.0.0.1:9/v1",
              models: [
                {
                  id: "fixture",
                  input: ["text"],
                  contextWindow: 32768,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
      },
    ]),
  );
  process.chdir(home);
  const [{ runProfile }, { createLaunchEnvironmentSnapshot }] =
    await Promise.all([
      importRuntime("@deepseek-ai/dsh/lib/profile-boot.js"),
      importRuntime("@deepseek-ai/dsh-launch-environment"),
    ]);
  const selected =
    mode === "default"
      ? []
      : [mode === "terminal" ? terminalBundle : ralphBundle];
  const runtime = await runProfile({
    profile: "sdk",
    patchFiles: [
      ...selected.map((name) =>
        path.join(root, "node_modules/@deepseek-ai", name, "cordis.patch.yml"),
      ),
      path.join(root, "profile.cordis.patch.yml"),
      patch,
    ],
    args: [],
    environment: createLaunchEnvironmentSnapshot([
      { source: "process", values: process.env },
    ]),
  });
  try {
    const { ctx } = runtime;
    const entries = [...ctx.loader.entries()];
    const group = entries.find(
      (entry) => entry.options.id === "optional-persistent-terminals",
    );
    const shell = entries.find(
      (entry) => entry.options.id === "lolicode-terminal-shell",
    );
    const tools = [
      "terminal_open",
      "terminal_send",
      "terminal_read",
      "terminal_signal",
      "terminal_close",
      "terminal_list",
    ];
    assert.equal(
      ctx.agents.list().length,
      0,
      "Selecting a bundle must not create an Agent",
    );
    assert.equal(
      ctx.get("terminalController"),
      undefined,
      "Do not load the upstream Web terminal controller",
    );
    assert.equal(ctx.get("webServer"), undefined);
    if (mode === "terminal") {
      assert.ok(
        group,
        "The explicitly selected group must survive the host overlay",
      );
      assert.ok(
        shell?.fiber,
        "The official headless shell backend must activate",
      );
      assert.equal(shell.options.name, "@deepseek-ai/dsh-terminal-bash");
      assert.deepEqual(shell.context.get("terminals").listBackends(), [
        "shell",
      ]);
      assert.equal(
        entries.some(
          (entry) => entry.options.name === "@deepseek-ai/dsh-terminal-panel",
        ),
        false,
      );
      for (const name of tools)
        assert.ok(ctx.tools.get(name), `Missing selected tool ${name}`);
    } else {
      assert.equal(
        group,
        undefined,
        "An unselected terminal group must not be inserted",
      );
      assert.equal(shell, undefined);
      for (const name of tools)
        assert.equal(
          ctx.tools.get(name),
          undefined,
          `Unexpected default tool ${name}`,
        );
    }
    assert.equal(Boolean(ctx.tools.get("ralph")), mode === "ralph");
    return {
      mode,
      headless: mode === "terminal",
      agents: ctx.agents.list().length,
    };
  } finally {
    await runtime.shutdown.shutdown(0);
    process.chdir(root);
  }
}

if (process.argv[2] === "--inspect-profile") {
  console.log(
    JSON.stringify(await inspectProfile(process.argv[3], process.argv[4])),
  );
} else {
  for (const mode of ["default", "ralph", "terminal"]) {
    test(
      `terminal compatibility uses the headless backend only with explicit terminal selection (${mode})`,
      { timeout: 45_000 },
      async (t) => {
        const parent = path.resolve(os.tmpdir());
        const prefix = "lolicode-terminal-compat-";
        const temporary = await mkdtemp(path.join(parent, prefix));
        t.after(async () => {
          assert.equal(path.dirname(temporary), parent);
          assert.ok(path.basename(temporary).startsWith(prefix));
          await rm(temporary, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
        });
        const home = path.join(temporary, "home");
        await mkdir(home);
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            /^(PATH|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|TMPDIR|COMSPEC|PATHEXT)$/i.test(
              key,
            ),
          ),
        );
        const result = await execute(
          process.execPath,
          [file, "--inspect-profile", mode, home],
          {
            cwd: root,
            env: {
              ...env,
              ...runtimeFixtureEnvironment,
              DSH_HOME: home,
              DSH_TELEMETRY_DISABLED: "1",
              LOLICODE_TERMINAL_FIXTURE_TOKEN: "unused-fixture",
            },
            windowsHide: true,
            timeout: 40_000,
          },
        );
        const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
        assert.deepEqual(report, {
          mode,
          headless: mode === "terminal",
          agents: 0,
        });
      },
    );
  }
}
