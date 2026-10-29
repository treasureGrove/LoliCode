import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  prepareRendererPack,
  finalizeRendererPack,
  nativeContract,
  nativeContractFiles,
  rendererPath,
  officialRendererURL,
} from "../build/lolicode-renderer-pack.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "lolicode-renderer-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(path.join(source, "assets"), { recursive: true });
  await writeFile(
    path.join(source, "index.html"),
    '<script type="module" src="/assets/a.js"></script><div id="root"></div>',
  );
  await writeFile(
    path.join(source, "assets/a.js"),
    "console.log('version one')",
  );
  await writeFile(path.join(source, "assets/a.css"), "body{color:white}");
  return {
    root,
    source,
    options: {
      source,
      output: path.join(root, "pack"),
      version: 1,
      archiveURL:
        "https://tools.treasuregrove.art/lolicode/renderer/1/renderer.zip",
    },
  };
}
test("whole renderer archives are deterministic, native-bound, and never overwrite a published directory", async (t) => {
  const f = await fixture(t);
  const a = await prepareRendererPack(f.options);
  const b = await prepareRendererPack({
    ...f.options,
    output: path.join(f.root, "second"),
  });
  assert.equal(a.archiveSha256, b.archiveSha256);
  assert.deepEqual(
    { version: a.nativeVersion, contract: a.nativeContract },
    await nativeContract(path.resolve(".")),
  );
  assert.equal(a.files, 3);
  const before = await readFile(path.join(f.options.output, "manifest.json"));
  await assert.rejects(prepareRendererPack(f.options));
  assert.deepEqual(
    await readFile(path.join(f.options.output, "manifest.json")),
    before,
  );
});
test("publication verifies signed raw manifest, bound public key and actual zip bytes", async (t) => {
  const f = await fixture(t);
  const signed = JSON.parse(
    await readFile(
      new URL(
        "../../src-tauri/test-fixtures/renderer-packs.json",
        import.meta.url,
      ),
    ),
  );
  const dir = path.join(f.root, "signed");
  await mkdir(dir);
  const options = {
    directory: dir,
    signatureFile: path.join(f.root, "signature.txt"),
    publicKeyFile: path.join(f.root, "key.pub"),
    configFile: path.join(f.root, "config.json"),
  };
  await writeFile(
    path.join(dir, "manifest.json"),
    Buffer.from(signed.first.envelope.manifest, "base64"),
  );
  await writeFile(
    path.join(dir, "renderer.zip"),
    Buffer.from(signed.first.archive, "base64"),
  );
  await writeFile(options.signatureFile, signed.first.envelope.signature);
  await writeFile(options.publicKeyFile, signed.publicKey);
  await writeFile(
    options.configFile,
    JSON.stringify({ plugins: { updater: { pubkey: signed.publicKey } } }),
  );
  assert.equal((await finalizeRendererPack(options)).verified, true);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dir, "latest.json"))),
    signed.first.envelope,
  );
  await assert.rejects(
    finalizeRendererPack(options),
    "envelope publication is exclusive",
  );
  await assert.rejects(
    finalizeRendererPack({ ...options, publicKeyFile: "private.key" }),
  );
  await writeFile(path.join(dir, "renderer.zip"), "tampered");
  await assert.rejects(finalizeRendererPack(options));
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dir, "latest.json"))),
    signed.first.envelope,
  );
});
test("native contract is independent of checkout line endings and changes with native commands", async (t) => {
  const f = await fixture(t);
  const files = [
    "package.json",
    ...(await nativeContractFiles(path.resolve("."))),
  ];
  for (const file of files) {
    await mkdir(path.dirname(path.join(f.root, file)), { recursive: true });
    const data = (await readFile(path.resolve(file), "utf8"))
      .replaceAll("\r\n", "\n")
      .replaceAll("\n", "\r\n");
    await writeFile(path.join(f.root, file), data);
  }
  const original = await nativeContract(path.resolve("."));
  assert.deepEqual(await nativeContract(f.root), original);
  const commands = path.join(f.root, "src-tauri/src/commands/mod.rs");
  await writeFile(
    commands,
    (await readFile(commands, "utf8")) + "\n// changed API\n",
  );
  assert.notEqual((await nativeContract(f.root)).contract, original.contract);
});
test("native binaries, traversal, linked roots and non-official transport are rejected before publication", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "native.exe",
    "assets/../a.js",
    "assets/CON.js",
    "assets/.env",
    "assets/a.js.",
    "assets/a%20.js",
    "assets/A\\a.js",
  ])
    assert.equal(rendererPath(name), false, name);
  for (const url of [
    "http://tools.treasuregrove.art/lolicode/renderer/1.zip",
    "https://evil.invalid/lolicode/renderer/1.zip",
    "https://tools.treasuregrove.art/lolicode/renderer/../private.zip",
    "https://tools.treasuregrove.art/lolicode/renderer/1.zip?q=1",
    "https://pub-250df9737586416fbd6e8cb0a843b249.r2.dev/lolicode/releases/renderer.zip",
    "https://pub-250df9737586416fbd6e8cb0a843b249.r2.dev.evil.invalid/lolicode/renderer/1.zip",
  ])
    assert.throws(() => officialRendererURL(url));
  assert.doesNotThrow(() =>
    officialRendererURL(
      "https://pub-250df9737586416fbd6e8cb0a843b249.r2.dev/lolicode/renderer/1/renderer.zip",
    ),
  );
  await writeFile(path.join(f.source, "native.exe"), "native");
  await assert.rejects(prepareRendererPack(f.options));
  await rm(path.join(f.source, "native.exe"));
  const link = path.join(f.root, "linked");
  await symlink(
    f.source,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(prepareRendererPack({ ...f.options, source: link }));
});
