import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const selected = process.env.LOLICODE_TEST_RUNTIME_ROOT;
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
if (selected && !path.isAbsolute(selected))
  throw new Error("The SDK test runtime must be an absolute path.");
export const runtimeRoot = realpathSync(selected || sourceRoot);
const pathKey = (file) =>
  process.platform === "win32" ? file.toLowerCase() : file;
export const runtimeNode = selected
  ? realpathSync(
      path.join(
        runtimeRoot,
        process.platform === "win32" ? "node.exe" : "node",
      ),
    )
  : realpathSync(process.execPath);
if (selected) {
  assert.equal(
    pathKey(realpathSync(process.execPath)),
    pathKey(runtimeNode),
    "Run candidate SDK tests with the candidate's bundled Node, not the source/system Node.",
  );
}
const requireRuntime = createRequire(path.join(runtimeRoot, "package.json"));

// Real paths prevent a missing candidate dependency from silently resolving
// through a parent checkout's node_modules or a source-runtime link.
export function runtimeModuleUrl(specifier) {
  const file = realpathSync(
    specifier.startsWith("./")
      ? path.join(runtimeRoot, specifier.slice(2))
      : requireRuntime.resolve(specifier),
  );
  assert.ok(
    pathKey(file).startsWith(pathKey(runtimeRoot + path.sep)),
    `SDK test import escaped the selected runtime: ${specifier}`,
  );
  return pathToFileURL(file).href;
}

export const importRuntime = (specifier) => import(runtimeModuleUrl(specifier));

// Only self-hosted test helpers need this. The actual SDK/host CLI paths are
// already absolute and still receive their credential-free fixture environment.
export const runtimeFixtureEnvironment = selected
  ? { LOLICODE_TEST_RUNTIME_ROOT: runtimeRoot }
  : {};
