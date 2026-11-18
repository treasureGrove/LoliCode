import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

function collectRealTree(directory) {
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
  // links or delete files outside a real directory tree.
  visit(root);
  return { root, files, directories };
}

function removeCandidates(candidates, directories) {
  let removedBytes = 0;
  for (const [file, bytes] of candidates) {
    unlinkSync(file);
    removedBytes += bytes;
  }
  // Do not leave empty directories shadowing module resolution after pruning.
  for (const directory of directories) {
    if (existsSync(directory) && readdirSync(directory).length === 0)
      rmdirSync(directory);
  }
  return removedBytes;
}

function isRealRegularFile(file) {
  try {
    const info = lstatSync(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

// Only the disposable distribution stage is pruned. Keep declarations, source,
// licenses and every executable/resource so plugin development still works.
export function pruneHarnessSourceMaps(directory) {
  const { files, directories } = collectRealTree(directory);
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
  const removedBytes = removeCandidates(candidates, directories);
  return {
    policy: "external-source-maps-v1",
    inputFiles: files.size,
    outputFiles: files.size - candidates.length,
    removedFiles: candidates.length,
    removedBytes,
  };
}

/** Prune target-redundant payloads (WASM fallback when native Kit exists, PDBs, other-arch binaries, npm test fixtures). */
export function pruneHarnessRedundantAssets(
  directory,
  { platform = process.platform, arch = process.arch } = {},
) {
  const { root, files, directories } = collectRealTree(directory);
  const target = `${platform}-${arch}`;
  const nativeKitDir = path.join(
    root,
    "@deepseek-ai",
    `libreoffice-kit-${target}`,
  );
  const hasNativeKit =
    isRealRegularFile(path.join(nativeKitDir, "package.json")) &&
    isRealRegularFile(path.join(nativeKitDir, "prebuilds.json"));

  const candidates = [];
  for (const [file, bytes] of files) {
    const rel = path.relative(root, file).split(path.sep);
    if (
      hasNativeKit &&
      rel[0] === "@deepseek-ai" &&
      rel[1] === "libreoffice-kit-wasm"
    ) {
      candidates.push([file, bytes]);
      continue;
    }
    if (
      rel[0] === "@mixmark-io" &&
      rel[1] === "domino" &&
      (rel[2] === "test" || rel[2] === ".yarn")
    ) {
      candidates.push([file, bytes]);
      continue;
    }
    if (rel[0] === "node-pty") {
      if (file.toLowerCase().endsWith(".pdb")) {
        candidates.push([file, bytes]);
        continue;
      }
      if (rel[1] === "prebuilds" && rel.length >= 4 && rel[2] !== target) {
        candidates.push([file, bytes]);
        continue;
      }
      if (
        platform === "win32" &&
        rel[1] === "third_party" &&
        rel[2] === "conpty" &&
        rel.length >= 6
      ) {
        const winMatch = /^win\d+-(.+)$/i.exec(rel[4]);
        if (winMatch && winMatch[1] !== arch) {
          candidates.push([file, bytes]);
          continue;
        }
      }
    }
  }
  const removedBytes = removeCandidates(candidates, directories);
  return {
    policy: "target-redundant-assets-v1",
    removedFiles: candidates.length,
    removedBytes,
  };
}
