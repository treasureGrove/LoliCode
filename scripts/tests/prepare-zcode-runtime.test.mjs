import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  dependencyClosure,
  assertRegistryRefreshBundle,
  includeUpstream,
  patchWorkspaceRegistryRefresh,
  safeRelative,
  SOURCE_REVISION,
  upstreamImporterVersions,
  verifySource,
  verifyRuntime,
} from "../build/prepare-zcode-runtime.mjs";

test("the owned workspace read barrier changes exactly one pinned anchor and fails closed on drift", () => {
  const original = `export async function readWorkspacePresentation(context, rawParams) {\n  const params = parseParams(zcodeWorkspaceReadPresentationParamsSchema, rawParams);\n  return context.runtime.getPresentation(params);\n}\n`;
  const patched = patchWorkspaceRegistryRefresh(original);
  assert.doesNotThrow(() => assertRegistryRefreshBundle(patched));
  assert.throws(
    () => assertRegistryRefreshBundle(original),
    /absent from the compiled runtime/,
  );
  assert.equal(
    patched,
    original.replace(
      "  const params = parseParams(zcodeWorkspaceReadPresentationParamsSchema, rawParams);",
      "  const params = parseParams(zcodeWorkspaceReadPresentationParamsSchema, rawParams);\n  await context.deps.refreshProviderRegistry?.('lolicode-channel-catalog');",
    ),
  );
  assert.throws(
    () => patchWorkspaceRegistryRefresh(patched),
    /refusing an unverified transform/,
  );
  assert.throws(
    () =>
      patchWorkspaceRegistryRefresh(
        original.replace("rawParams);", "changedParams);"),
      ),
    /anchor changed/,
  );
  assert.throws(
    () => patchWorkspaceRegistryRefresh(original + original),
    /anchor changed/,
  );
});

test("vendored sources exclude environment files, accounts, UI and repository metadata", () => {
  for (const file of [
    ".env",
    ".env.example",
    "apps/zcode-cli/packages/core/.env.production",
    ".git/config",
    "packages/desktop/src/main.ts",
    "packages/ui/src/index.ts",
    "apps/zcode-cli/packages/core/tests/token.test.ts",
    "apps/zcode-cli/.claude/config.json",
  ])
    assert.equal(includeUpstream(file), false, file);
  for (const file of [
    "LICENSE",
    "NOTICE.md",
    "THIRD-PARTY-NOTICES.md",
    "packages/services/src/node.ts",
    "packages/server/src/remote/connect.ts",
    "apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows/SKILL.md",
    "apps/zcode-cli/packages/skill-creator-plugin/.claude-plugin/plugin.json",
    "packages/desktop/src/scheduler/index.ts",
  ])
    assert.equal(includeUpstream(file), true, file);
});

test("source paths cannot escape their owned roots on Windows or POSIX", () => {
  for (const file of [
    "",
    "/x",
    "../x",
    "x/../y",
    "x//y",
    "C:/x",
    "x\\y",
    "./x",
    "x/.",
  ])
    assert.equal(safeRelative(file), false, file);
  assert.equal(safeRelative("packages/shared/src/index.ts"), true);
});

test("only production workspace dependencies enter the build closure", () => {
  const packages = new Map([
    [
      "entry",
      {
        manifest: {
          dependencies: { child: "workspace:*", npm: "1.0.0" },
          devDependencies: { electron: "workspace:*" },
        },
      },
    ],
    ["child", { manifest: { dependencies: { entry: "workspace:*" } } }],
    ["electron", { manifest: {} }],
  ]);
  assert.deepEqual(
    [...dependencyClosure(packages, ["entry"]).keys()],
    ["entry", "child"],
  );
  assert.throws(
    () => dependencyClosure(packages, ["missing"]),
    /Missing upstream/,
  );
});

test("upstream importer lock resolves exact versions without peer suffix or dev dependency", () => {
  const versions = upstreamImporterVersions(
    `lockfileVersion: '9.0'\nimporters:\n  apps/cli:\n    dependencies:\n      '@ai-sdk/openai':\n        specifier: ^3.0.58\n        version: 3.0.58(zod@4.6.5)\n      child:\n        specifier: workspace:*\n        version: link:../child\n    devDependencies:\n      electron:\n        version: 40.0.0\npackages:\n  unrelated@1.0.0:\n`,
  );
  assert.equal(versions.get("apps/cli\0@ai-sdk/openai"), "3.0.58");
  assert.equal(versions.has("apps/cli\0child"), false);
  assert.equal(versions.has("apps/cli\0electron"), false);
});

test("raw Git blob byte integrity rejects line-ending conversion and path injection", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "lolicode-zcode-source-test-"),
  );
  try {
    const bytes = Buffer.from("license\noriginal\n");
    const file = "LICENSE";
    await mkdir(path.join(root, "source"));
    await writeFile(path.join(root, "source", file), bytes);
    const manifest = {
      format: 1,
      revision: SOURCE_REVISION,
      files: [
        {
          path: file,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          blob: createHash("sha1")
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex"),
        },
      ],
    };
    const manifestFile = path.join(root, "manifest.json");
    await writeFile(manifestFile, JSON.stringify(manifest));
    assert.equal(
      (await verifySource(path.join(root, "source"), manifestFile)).files
        .length,
      1,
    );
    await writeFile(
      path.join(root, "source", file),
      bytes.toString().replaceAll("\n", "\r\n"),
    );
    await assert.rejects(
      verifySource(path.join(root, "source"), manifestFile),
      /integrity mismatch/,
    );
    manifest.files[0].path = "../LICENSE";
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(
      verifySource(path.join(root, "source"), manifestFile),
      /Unsafe/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complete runtime inventory rejects tampering and unlisted payloads", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "lolicode-zcode-runtime-test-"),
  );
  try {
    const names = [
      "node.exe",
      "runtimeCLI.cjs",
      "zcode.cjs",
      "services.mjs",
      "remote.mjs",
      "protocol.mjs",
      "LICENSE",
      "NOTICE.md",
      "THIRD-PARTY-NOTICES.md",
      "LICENSE.node.txt",
      "packages/bundled-skills/skills/dynamic-workflows/SKILL.md",
    ];
    const files = [];
    for (const name of names) {
      const content = Buffer.from(`offline fixture: ${name}\n`);
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), content);
      files.push({
        path: name,
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
    await writeFile(
      path.join(root, "runtime-manifest.json"),
      JSON.stringify({ format: 1, sourceRevision: SOURCE_REVISION, files }),
    );
    assert.equal((await verifyRuntime(root)).files.length, names.length);
    await writeFile(path.join(root, "unexpected.mjs"), "unlisted");
    await assert.rejects(verifyRuntime(root), /absent from its manifest/);
    await rm(path.join(root, "unexpected.mjs"));
    await writeFile(path.join(root, "services.mjs"), "tampered");
    await assert.rejects(verifyRuntime(root), /checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
