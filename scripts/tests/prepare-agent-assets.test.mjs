import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareAgentAssets } from "../prepare-agent-assets.mjs";

async function cleanup(root) {
  const actual = await realpath(root);
  const temporaryRoot = await realpath(tmpdir());
  assert.equal(path.dirname(actual).toLowerCase(), temporaryRoot.toLowerCase());
  assert.ok(path.basename(actual).startsWith("lolicode-native-assets-"));
  await rm(actual, { recursive: true, force: true });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "lolicode-native-assets-"));
  const content = "# Test skill\nOwned test instructions.\n";
  const relative = "skills/test/SKILL.md";
  const vendored = path.join(root, "third-party/zcode");
  await mkdir(path.join(vendored, "skills/test"), { recursive: true });
  await writeFile(path.join(vendored, relative), content);
  await writeFile(
    path.join(vendored, "manifest.json"),
    JSON.stringify({
      version: 1,
      sourceRevision: "aac4755666d09fdcd70272fcf063c077a639015f",
      skills: [
        {
          id: "test",
          directory: "test",
          files: [
            {
              path: relative,
              sha256: createHash("sha256").update(content).digest("hex"),
            },
          ],
        },
      ],
    }),
  );
  for (const name of ["LICENSE", "NOTICE.md", "UPSTREAM_NOTICE.md"]) {
    await writeFile(path.join(vendored, name), `Fixture ${name}\n`);
  }
  return { root, vendored, relative, content };
}

test("native content assets prepare without any engine executable or npm runtime", async () => {
  const f = await fixture();
  try {
    const result = await prepareAgentAssets(f.root);
    assert.equal(result.skills, 1);
    const output = path.join(f.root, "src-tauri/resources/agent/extensions");
    assert.equal(
      await readFile(path.join(output, f.relative), "utf8"),
      f.content,
    );
    assert.equal(
      await readFile(path.join(output, "NOTICE.md"), "utf8"),
      "Fixture NOTICE.md\n",
    );
  } finally {
    await cleanup(f.root);
  }
});

test("tampered skill bytes fail the build before a distribution can be produced", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.vendored, f.relative), "changed source");
    await assert.rejects(prepareAgentAssets(f.root), /checksum mismatch/);
  } finally {
    await cleanup(f.root);
  }
});

test("manifest cannot escape the approved content namespace", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.vendored, "manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.skills[0].files[0].path = "skills/test/../../outside.txt";
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(
      prepareAgentAssets(f.root),
      /Unsafe default skill file path/,
    );
  } finally {
    await cleanup(f.root);
  }
});
