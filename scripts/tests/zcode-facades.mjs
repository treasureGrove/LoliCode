import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const allowed = [
  "automation",
  "remote",
  "capabilities",
  "extensions",
  "native-history",
  "native-history-compat",
];
const names = process.argv.length > 2 ? process.argv.slice(2) : allowed;
if (names.some((name) => !allowed.includes(name)))
  throw new Error("Unknown facade regression suite");
const owned = await mkdtemp(path.join(os.tmpdir(), "lolicode-facade-tests-"));
try {
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
  const output = path.join(owned, "tests");
  const home = path.join(owned, "home");
  await mkdir(home, { recursive: true });
  await build({
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    entryPoints: names.map((name) =>
      path.join(repo, "packages/lolicode-zcode-runtime/src", `${name}.test.ts`),
    ),
    outdir: output,
    outExtension: { ".js": ".mjs" },
    plugins: [
      {
        name: "single-service-identity",
        setup(builder) {
          builder.onResolve(
            { filter: /^\.\/(services|remote)\.mjs$/ },
            (args) => ({
              path: pathToFileURL(
                path.join(
                  repo,
                  "src-tauri/resources/zcode-runtime",
                  args.path.slice(2),
                ),
              ).href,
              external: true,
            }),
          );
        },
      },
    ],
  });
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
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    ZCODE_DATA_BASE_DIR: home,
    LOLICODE_FACADE_TEST_HOME: home,
    TEMP: owned,
    TMP: owned,
    NODE_ENV: "test",
    ZCODE_MODEL_TELEMETRY_ENABLED: "false",
  });
  const result = spawnSync(
    process.execPath,
    ["--test", ...names.map((name) => path.join(output, `${name}.test.mjs`))],
    { env, stdio: "inherit", timeout: 120_000, windowsHide: true },
  );
  process.exitCode = result.status ?? 1;
} finally {
  if (
    path.dirname(owned) !== path.resolve(os.tmpdir()) ||
    !path.basename(owned).startsWith("lolicode-facade-tests-")
  )
    throw new Error("Refusing cleanup outside owned temporary root");
  await rm(owned, { recursive: true, force: true });
}
