import {
  lstatSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

// Only the disposable distribution stage is pruned. Keep declarations, source,
// licenses and every executable/resource so plugin development still works.
export function pruneHarnessSourceMaps(directory) {
  const root = path.resolve(directory);
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error(
      "Harness distribution dependencies must be a real directory.",
    );
  const files = new Map();
  const directories = [];
  function visit(parent) {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const file = path.join(parent, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        directories.push(file);
      } else if (entry.isFile()) files.set(file, lstatSync(file).size);
      else throw new Error(`Unexpected non-regular distribution file: ${file}`);
    }
  }
  // Validate the entire private stage before deleting anything; never follow
  // links or interpret arbitrary .map resources as compiler debug output.
  visit(root);
  const candidates = [];
  for (const [file, bytes] of files) {
    if (!/\.(?:[cm]?js|jsx|[cm]?ts|tsx|css)\.map$/i.test(file)) continue;
    try {
      const map = JSON.parse(readFileSync(file, "utf8"));
      if (
        map.version === 3 &&
        Array.isArray(map.sources) &&
        Array.isArray(map.names) &&
        typeof map.mappings === "string"
      )
        candidates.push([file, bytes]);
    } catch {
      // Unknown formats are payload, not disposable source maps.
    }
  }
  let removedBytes = 0;
  for (const [file, bytes] of candidates) {
    unlinkSync(file);
    removedBytes += bytes;
  }
  // Do not leave empty directories shadowing module resolution after pruning.
  for (const directory of directories) {
    if (readdirSync(directory).length === 0) rmdirSync(directory);
  }
  return {
    policy: "external-source-maps-v1",
    inputFiles: files.size,
    outputFiles: files.size - candidates.length,
    removedFiles: candidates.length,
    removedBytes,
  };
}
