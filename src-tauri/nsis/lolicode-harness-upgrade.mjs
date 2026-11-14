import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const [directory, ownershipFile] = process.argv.slice(2);
if (!directory || !ownershipFile || !path.isAbsolute(directory)) {
  throw new Error("Expected the installed Harness directory and legacy ownership inventory.");
}

const root = path.resolve(directory);
function safeDirectory(directory) {
  const status = lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Unsafe Harness directory: " + directory);
  }
}
for (let directory = root; directory !== path.parse(directory).root; directory = path.dirname(directory)) {
  safeDirectory(directory);
}

function readInventory(bytes, hashes) {
  const entries = new Map();
  for (const line of gunzipSync(bytes).toString("utf8").trimEnd().split("\n")) {
    const [relative, ...digests] = line.split("\t");
    if (!relative.startsWith("node_modules/") ||
        relative.split("/").some(part => !part || part === "." || part === ".." ||
          /[\\:\x00-\x1f]|[. ]$/.test(part)) ||
        entries.has(relative.toLowerCase()) ||
        (hashes && (!digests.length || digests.some(digest => !/^[a-f0-9]{64}$/.test(digest)))) ||
        (!hashes && digests.length)) {
      throw new Error("Invalid Harness inventory entry: " + relative);
    }
    entries.set(relative.toLowerCase(), digests);
  }
  return entries;
}

const legacy = readInventory(readFileSync(ownershipFile), true);
const current = readInventory(readFileSync(path.join(root, "installer-files.gz")), false);
if (!current.has("node_modules/@deepseek-ai/dsh/lib/bin.js")) {
  throw new Error("The current Harness inventory is incomplete.");
}
let removed = 0;
function reconcile(directory, relative) {
  let changed = false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const key = relative + "/" + entry.name.toLowerCase();
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      changed = reconcile(file, key) || changed;
      continue;
    }
    if (!entry.isFile() || current.has(key)) continue;
    const digests = legacy.get(key);
    if (!digests) continue;
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (!digests.includes(digest)) continue;
    unlinkSync(file);
    removed++;
    changed = true;
  }
  if (changed && relative !== "node_modules" && readdirSync(directory).length === 0) {
    try {
      rmdirSync(directory);
    } catch (error) {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
    }
  }
  return changed;
}

const modules = path.join(root, "node_modules");
safeDirectory(modules);
reconcile(modules, "node_modules");
const requireFromAgent = (await import("node:module")).createRequire(
  path.join(modules, "@deepseek-ai", "dsh-agent", "package.json"),
);
const resolvedZod = path.toNamespacedPath(requireFromAgent.resolve("zod/package.json"));
const bundledZod = path.toNamespacedPath(path.join(modules, "zod", "package.json"));
if (resolvedZod.toLowerCase() !== bundledZod.toLowerCase()) {
  throw new Error("A local Zod override still shadows the bundled dependency.");
}
console.log("Removed " + removed + " obsolete managed Harness files.");
