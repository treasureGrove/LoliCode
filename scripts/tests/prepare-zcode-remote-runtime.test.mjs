import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertLinuxElf,
  assertOwnedRemoteBuildPath,
  PLATFORM,
  validateArchivePaths,
  verifyRemoteAssets,
} from "../build/prepare-zcode-remote-runtime.mjs";
import {
  SOURCE_REVISION,
  UPSTREAM_VERSION,
  ownedTransformManifest,
} from "../build/prepare-zcode-runtime.mjs";

test("Linux assets reject Windows executables, wrong ELF architecture and truncation", () => {
  const elf = Buffer.alloc(64);
  elf.write("\x7fELF");
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(62, 18);
  assert.doesNotThrow(() => assertLinuxElf(elf));
  for (const invalid of [
    Buffer.from("MZ-Windows executable"),
    Buffer.alloc(3),
    Buffer.from(elf),
  ]) {
    if (invalid.length === 64) invalid.writeUInt16LE(183, 18);
    assert.throws(() => assertLinuxElf(invalid), /Linux x86-64 ELF/);
  }
});

test("archive extraction and SSH build paths cannot escape owned temporary roots", () => {
  assert.deepEqual(validateArchivePaths("./rg/\n./rg/rg\n"), [
    "./rg/",
    "./rg/rg",
  ]);
  for (const listing of [
    "",
    "../user-config\n",
    "/etc/passwd\n",
    "C:/users/test\n",
    "safe/../../key\n",
    "a\\b\n",
  ])
    assert.throws(() => validateArchivePaths(listing));
  assert.equal(
    assertOwnedRemoteBuildPath("/tmp/lolicode-zcode-native-ABCDEFGH"),
    "/tmp/lolicode-zcode-native-ABCDEFGH",
  );
  for (const target of [
    "/home/user/.zcode",
    "/tmp/lolicode-zcode-native-",
    "/tmp/lolicode-zcode-native-ABCDEF/..",
    "/tmp/other-task",
  ])
    assert.throws(() => assertOwnedRemoteBuildPath(target));
});

test("complete Linux remote manifest verifies seven components and rejects tampering or unlisted files", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "lolicode-linux-asset-test-"),
  );
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  try {
    const release = `releases/${UPSTREAM_VERSION}`;
    const elf = Buffer.alloc(64);
    elf.write("\x7fELF");
    elf[4] = 2;
    elf[5] = 1;
    elf.writeUInt16LE(62, 18);
    const put = async (file, bytes) => {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), bytes);
    };
    for (const binary of [
      `node/${PLATFORM}/node`,
      `node-pty/${PLATFORM}/pty.node`,
      ...["bfs/bfs", "ripgrep/rg", "ugrep/ugrep"].map(
        (value) => `tools/${PLATFORM}/${value}`,
      ),
    ])
      await put(`${release}/${binary}`, elf);
    for (const source of [
      "server/zcode-server.cjs",
      `glm/${PLATFORM}/zcode.cjs`,
      `glm/${PLATFORM}/packages/node-repl-host/dist/mcp/server.js`,
    ])
      await put(`${release}/${source}`, Buffer.from("/* owned fixture */"));
    const components = [];
    for (const [id, mount] of [
      ["server-bundle", "server"],
      ["node-runtime", `node/${PLATFORM}`],
      ["node-pty", `node-pty/${PLATFORM}`],
      ["glm", `glm/${PLATFORM}`],
      ...["bfs", "ripgrep", "ugrep"].map((id) => [
        id,
        `tools/${PLATFORM}/${id}`,
      ]),
    ]) {
      const bytes = Buffer.from(`fixture-${id}`),
        artifactPath = `artifacts/${id}.tar.gz`;
      await put(`${release}/${artifactPath}`, bytes);
      components.push({
        id,
        mount,
        version: "1.0.0",
        artifactPath,
        sha256: digest(bytes),
      });
    }
    await put(
      `${release}/manifest-${PLATFORM}.json`,
      JSON.stringify({
        schemaVersion: 1,
        appVersion: UPSTREAM_VERSION,
        platformArch: PLATFORM,
        components,
      }),
    );
    const files = [];
    async function walk(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else {
          const bytes = await readFile(file);
          files.push({
            path: path.relative(root, file).replaceAll("\\", "/"),
            bytes: bytes.length,
            sha256: digest(bytes),
          });
        }
      }
    }
    await walk(root);
    await put(
      "asset-manifest.json",
      JSON.stringify({
        format: 1,
        sourceRevision: SOURCE_REVISION,
        platform: PLATFORM,
        ownedTransforms: await ownedTransformManifest(),
        files,
      }),
    );
    assert.equal((await verifyRemoteAssets(root)).files.length, files.length);
    await put(`${release}/server/extra.cjs`, "unlisted");
    await assert.rejects(verifyRemoteAssets(root), /Unexpected or missing/);
    await rm(path.join(root, release, "server/extra.cjs"));
    await put(`${release}/node/${PLATFORM}/node`, Buffer.from("MZ-tampered"));
    await assert.rejects(verifyRemoteAssets(root), /checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
