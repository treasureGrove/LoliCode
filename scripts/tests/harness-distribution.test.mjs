import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneHarnessSourceMaps } from "../build/harness-distribution.mjs";

const sourceMap = JSON.stringify({
  version: 3,
  sources: ["original.ts"],
  names: [],
  mappings: "AAAA",
});
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "lolicode-distribution-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("lolicode-distribution-"));
    rmSync(root, { recursive: true, force: true });
  });
  const modules = path.join(root, "node_modules");
  mkdirSync(modules);
  function put(file, bytes) {
    const target = path.join(modules, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return target;
  }
  return { root, modules, put };
}

test("prunes external debug maps while keeping declarations, code, sources and unknown maps byte-identical", (t) => {
  const f = fixture(t);
  const keep = new Map(
    Object.entries({
      "example/lib/index.js":
        "export const value = 1;\n//# sourceMappingURL=index.js.map\n",
      "example/lib/index.d.ts": "export declare const value: 1;\n",
      "example/lib/types/types.js": "export const runtimeTypes = {};\n",
      "example/src/index.ts": "export const value: number = 1;\n",
      "example/package.json": '{"exports":"./lib/index.js"}',
      "example/LICENSE": "license attribution",
      "example/NOTICE": "third party notice",
      "example/README.md": "plugin developer guide",
      "example/data/city.map": sourceMap,
      "example/data/index.js.map": "not a source map",
      "example/data/custom.css.map": '{"version":2,"sources":[]}',
    }).map(([file, bytes]) => [f.put(file, bytes), Buffer.from(bytes)]),
  );
  const removed = [
    "example/lib/index.js.map",
    "example/lib/index.d.ts.map",
    "example/lib/entry.cjs.map",
    "example/lib/entry.mjs.map",
    "example/lib/index.d.cts.map",
    "example/lib/index.d.mts.map",
    "example/only-maps/absorbed.js.map",
    "example/lib/theme.css.map",
  ].map((file) => f.put(file, sourceMap));
  const report = pruneHarnessSourceMaps(f.modules);
  assert.equal(report.removedFiles, removed.length);
  assert.equal(
    report.removedBytes,
    Buffer.byteLength(sourceMap) * removed.length,
  );
  assert.equal(report.inputFiles, keep.size + removed.length);
  assert.equal(report.outputFiles, keep.size);
  for (const file of removed) assert(!existsSync(file), file);
  for (const [file, bytes] of keep)
    assert.deepEqual(readFileSync(file), bytes, file);
  assert(!existsSync(path.join(f.modules, "example/only-maps")));
  assert.equal(pruneHarnessSourceMaps(f.modules).removedFiles, 0);
});

test("rejects root and nested directory links before pruning any files", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  const sentinel = path.join(outside, "sentinel.js.map");
  writeFileSync(sentinel, sourceMap);
  const map = f.put("a/index.js.map", sourceMap);
  const link = path.join(f.modules, "z-linked-package");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => pruneHarnessSourceMaps(f.modules), /non-regular/);
  assert.equal(readFileSync(map, "utf8"), sourceMap);
  assert.equal(readFileSync(sentinel, "utf8"), sourceMap);
  assert.throws(() => pruneHarnessSourceMaps(link), /real directory/);
  // Remove only the owned link, never its target recursively.
  rmSync(link);
});
