// Read-only NSIS input boundaries. A snapshot is admitted only with a receipt
// digest already verified by the caller, never from an installer instruction.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

export function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function samePath(left, right) {
  const normalize = (value) =>
    process.platform === "win32"
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
  return normalize(left) === normalize(right);
}

function localPath(value) {
  assert.equal(typeof value, "string");
  assert(path.isAbsolute(value), `Source must be absolute: ${value}`);
  assert(!/[\r\n\0"$]/u.test(value), "Source contains unsupported NSIS syntax");
  if (process.platform === "win32")
    assert(
      /^[a-z]:[\\/]/iu.test(value),
      "Only local drive paths are supported",
    );
  return path.resolve(value);
}

// Check the original path before realpath, otherwise an internal nested junction
// could disappear during canonicalization and evade the link check.
function noLinks(root, candidate) {
  assert(
    samePath(root, candidate) || isWithin(root, candidate),
    `Source leaves workspace: ${candidate}`,
  );
  let current = root;
  assert(
    !lstatSync(current).isSymbolicLink(),
    `Source traverses a link: ${current}`,
  );
  const relative = path.relative(root, candidate);
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    assert(
      !lstatSync(current).isSymbolicLink(),
      `Source traverses a link: ${current}`,
    );
  }
}

function physicalRoot(candidate) {
  const root = localPath(candidate);
  assert(
    !samePath(root, path.parse(root).root),
    "A drive/root directory is not an input boundary",
  );
  noLinks(path.parse(root).root, root);
  assert(lstatSync(root).isDirectory(), "Input root must be a directory");
  assert(
    samePath(realpathSync(root), root),
    "Input root changed during validation",
  );
  return root;
}

function regularSource(root, candidate) {
  const absolute = localPath(candidate);
  assert(isWithin(root, absolute), `Source leaves workspace: ${candidate}`);
  noLinks(root, absolute);
  assert(
    samePath(realpathSync(root), root),
    "Source root changed during validation",
  );
  const canonical = realpathSync(absolute);
  assert(
    isWithin(root, canonical),
    `Resolved source leaves workspace: ${candidate}`,
  );
  assert(
    lstatSync(canonical).isFile(),
    `Source is not a regular file: ${candidate}`,
  );
  return canonical;
}

export function createWorkspaceBoundary(repositoryRoot) {
  const sourceRoot = physicalRoot(repositoryRoot);
  const sourceFile = (candidate) => regularSource(sourceRoot, candidate);
  return {
    sourceRoot,
    sourceFile,
    generatedScript: sourceFile,
    executable: sourceFile,
  };
}

function exactLink(link, expected) {
  assert(
    lstatSync(link).isSymbolicLink(),
    `Expected the declared target junction: ${link}`,
  );
  let target = readlinkSync(link);
  // Node can expose a Windows junction's extended-length prefix.
  if (process.platform === "win32" && target.startsWith("\\\\?\\"))
    target = target.slice(4);
  const resolved = path.resolve(path.dirname(link), target);
  assert(
    samePath(resolved, expected),
    `Unexpected target junction destination: ${link}`,
  );
}

async function fileDigest(filename) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function createSnapshotBoundary({
  repositoryRoot,
  snapshotFile,
  expectedSnapshotSha256,
  expectedVersion,
}) {
  assert.match(
    expectedSnapshotSha256 ?? "",
    /^[a-f0-9]{64}$/iu,
    "Snapshot mode requires an independently verified receipt SHA256",
  );
  const receiptPath = localPath(snapshotFile);
  assert.equal(path.basename(receiptPath), "source-snapshot.json");
  const snapshotDirectory = physicalRoot(path.dirname(receiptPath));
  regularSource(snapshotDirectory, receiptPath);
  const receiptBytes = readFileSync(receiptPath);
  const receiptSha256 = createHash("sha256").update(receiptBytes).digest("hex");
  assert.equal(
    receiptSha256,
    expectedSnapshotSha256.toLowerCase(),
    "Snapshot receipt bytes changed",
  );
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.product, "LoliCode");
  assert.equal(
    receipt.buildVersion,
    expectedVersion,
    "Snapshot build version does not match this acceptance",
  );
  for (const name of ["sourceCommit", "sourceTree", "parentCommit"])
    assert.match(receipt[name] ?? "", /^[a-f0-9]{40}$/u);
  assert.match(receipt.sourceArchiveSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert(
    Number.isSafeInteger(receipt.sourceArchiveBytes) &&
      receipt.sourceArchiveBytes > 0,
  );
  const releaseDirectory = path.dirname(snapshotDirectory);
  assert.equal(
    path.basename(releaseDirectory),
    "release",
    "Expected a snapshot directly under release/",
  );
  const buildRepository = physicalRoot(path.dirname(releaseDirectory));
  const sourceRoot = physicalRoot(receipt.work);
  assert(
    samePath(sourceRoot, path.join(snapshotDirectory, "work")),
    "Snapshot work must be its exact adjacent work directory",
  );
  const sharedTarget = localPath(receipt.sharedTarget);
  assert(
    samePath(sharedTarget, path.join(buildRepository, "src-tauri/target")),
    "Snapshot sharedTarget is not the exact build repository target",
  );

  // The canonical target must be the physical target of the reviewed test
  // repository. No third root or arbitrary canonical target is admitted.
  const toolRoot = physicalRoot(repositoryRoot);
  const canonicalTarget = physicalRoot(path.join(toolRoot, "src-tauri/target"));
  const targetAlias = path.join(sourceRoot, "src-tauri/target");
  function checkTargetChain() {
    noLinks(sourceRoot, path.dirname(targetAlias));
    noLinks(buildRepository, path.dirname(sharedTarget));
    exactLink(targetAlias, sharedTarget);
    if (!samePath(sharedTarget, canonicalTarget))
      exactLink(sharedTarget, canonicalTarget);
    else noLinks(toolRoot, canonicalTarget);
    assert(
      samePath(realpathSync(sharedTarget), canonicalTarget),
      "Shared target changed",
    );
    assert(
      samePath(realpathSync(targetAlias), canonicalTarget),
      "Snapshot target alias changed",
    );
  }
  checkTargetChain();
  const archivePath = regularSource(
    snapshotDirectory,
    path.join(snapshotDirectory, "source.tar"),
  );
  const archive = await fileDigest(archivePath);
  assert.equal(
    archive.bytes,
    receipt.sourceArchiveBytes,
    "Source archive length changed",
  );
  assert.equal(
    archive.sha256,
    receipt.sourceArchiveSha256,
    "Source archive SHA256 changed",
  );
  checkTargetChain();

  const sourceFile = (candidate) => {
    const absolute = localPath(candidate);
    assert(
      !samePath(absolute, targetAlias) && !isWithin(targetAlias, absolute),
      "Resource/hook must be in frozen source, not shared target",
    );
    return regularSource(sourceRoot, absolute);
  };
  function targetFile(candidate, suffix) {
    const absolute = localPath(candidate);
    assert(
      samePath(absolute, path.join(targetAlias, suffix)),
      `Expected the exact snapshot target alias: ${candidate}`,
    );
    checkTargetChain();
    const canonical = regularSource(
      canonicalTarget,
      path.join(canonicalTarget, suffix),
    );
    assert(
      samePath(realpathSync(absolute), canonical),
      "Target file changed during validation",
    );
    return canonical;
  }
  return {
    sourceRoot,
    sourceFile,
    generatedScript: (candidate) =>
      targetFile(candidate, "release/nsis/x64/installer.nsi"),
    executable: (candidate) => targetFile(candidate, "release/LoliCode.exe"),
    provenance: {
      snapshotFile: receiptPath,
      receiptSha256,
      sourceCommit: receipt.sourceCommit,
      sourceTree: receipt.sourceTree,
      parentCommit: receipt.parentCommit,
      sourceArchiveSha256: archive.sha256,
      sourceArchiveBytes: archive.bytes,
      sourceRoot,
      declaredSharedTarget: sharedTarget,
      canonicalTarget,
      // The caller verifies the Git commit/tree/archive mapping before supplying
      // the pinned receipt. This boundary does not claim a reproducible build.
      independentlyVerifiedReceiptRequired: true,
    },
  };
}
