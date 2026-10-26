#!/usr/bin/env node
// Freeze the current work without changing the user's branch, index or files.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const root = realpathSync(
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
);
const output = path.resolve(process.argv[2] ?? "");
const relative = path.relative(root, output);
if (
  !process.argv[2] ||
  !relative.startsWith(`release${path.sep}`) ||
  existsSync(output)
)
  throw new Error(
    "Provide a new directory beneath this repository's release/.",
  );
const product = JSON.parse(
  readFileSync(path.join(root, "product-release.json")),
);
const config = JSON.parse(
  readFileSync(path.join(root, "src-tauri/tauri.conf.json")),
);
const pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
if (
  pkg.name !== "lolicode" ||
  pkg.version !== product.buildVersion ||
  config.version !== product.buildVersion
)
  throw new Error("Product/build/config versions must match before freezing.");
mkdirSync(output, { recursive: true });
const originalIndex = execFileSync("git", ["diff", "--cached", "--binary"], {
  cwd: root,
  windowsHide: true,
});
const env = {
  ...process.env,
  GIT_INDEX_FILE: path.join(output, "snapshot.index"),
};
function git(args, input) {
  return execFileSync("git", args, {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}
const parent = git(["rev-parse", "HEAD"]);
git(["read-tree", "HEAD"]);
git(["add", "--all", "--", "."]);
const tree = git(["write-tree"]);
const commit = git(
  ["commit-tree", tree, "-p", parent],
  `Frozen LoliCode ${product.productVersion} (native ${product.buildVersion}) release input\n`,
);
const ref = `refs/lolicode/builds/${product.buildVersion}-${randomUUID()}`;
git(["update-ref", ref, commit, "0000000000000000000000000000000000000000"]);
const archive = path.join(output, "source.tar");
git(["archive", "--format=tar", `--output=${archive}`, commit]);
const work = path.join(output, "work");
mkdirSync(work);
execFileSync("tar", ["-xf", archive, "-C", work], { windowsHide: true });
symlinkSync(
  path.join(root, "node_modules"),
  path.join(work, "node_modules"),
  "junction",
);
// Keep the target alias inside the frozen checkout so NSIS payload path checks
// and the generated installer agree on the same canonical source tree.
mkdirSync(path.join(work, "src-tauri"), { recursive: true });
symlinkSync(
  path.join(root, "src-tauri/target"),
  path.join(work, "src-tauri/target"),
  "junction",
);
const indexAfter = execFileSync("git", ["diff", "--cached", "--binary"], {
  cwd: root,
  windowsHide: true,
});
if (!originalIndex.equals(indexAfter))
  throw new Error(
    "The user's index changed concurrently; inspect before building.",
  );
const bytes = readFileSync(archive);
const receipt = {
  schemaVersion: 1,
  product: "LoliCode",
  productVersion: product.productVersion,
  buildVersion: product.buildVersion,
  sourceCommit: commit,
  sourceTree: tree,
  parentCommit: parent,
  snapshotRef: ref,
  sourceArchiveBytes: bytes.length,
  sourceArchiveSha256: createHash("sha256").update(bytes).digest("hex"),
  work,
  sharedTarget: path.join(root, "src-tauri/target"),
  userBranchAndIndexPreserved: true,
};
writeFileSync(
  path.join(output, "source-snapshot.json"),
  JSON.stringify(receipt, null, 2) + "\n",
  { flag: "wx" },
);
console.log(JSON.stringify(receipt));
