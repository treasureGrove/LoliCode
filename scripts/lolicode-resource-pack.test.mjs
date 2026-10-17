import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  prepareResourcePack,
  finalizeResourcePack,
} from "./lolicode-resource-pack.mjs";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "lolicode-resource-test-"));
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../src-tauri/test-fixtures/resource-packs.json",
        import.meta.url,
      ),
    ),
  );
  const archive = Buffer.from(fixture.first.archive, "base64"),
    manifest = JSON.parse(
      Buffer.from(fixture.first.envelope.manifest, "base64"),
    );
  const png = archive.subarray(
    30 + archive.readUInt16LE(26),
    30 + archive.readUInt16LE(26) + manifest.files[0].bytes,
  );
  const source = path.join(dir, "source");
  await mkdir(source);
  for (const name of [
    "companion.png",
    "ribbon-atelier.png",
    "sidebar-frame.png",
    "brooch-accent.png",
  ])
    await writeFile(path.join(source, name), png);
  return {
    dir,
    source,
    options: {
      source,
      output: path.join(dir, "pack"),
      version: 1,
      minAppVersion: "4.0.20",
      maxAppVersion: "4.9.0",
      archiveURL:
        "https://tools.treasuregrove.art/lolicode/resources/1/assets.zip",
    },
  };
}

test("preparation is deterministic and never overwrites an existing resource version", async () => {
  const f = await fixture();
  try {
    const first = await prepareResourcePack(f.options);
    const second = await prepareResourcePack({
      ...f.options,
      output: path.join(f.dir, "second"),
    });
    assert.equal(first.archiveSha256, second.archiveSha256);
    await assert.rejects(prepareResourcePack(f.options));
    await assert.rejects(
      prepareResourcePack({
        ...f.options,
        archiveURL: "http://127.0.0.1/secret",
      }),
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("finalization requires the bound signing key and verifies actual archive bytes", async () => {
  const f = await fixture();
  try {
    await prepareResourcePack(f.options);
    // An ephemeral private key exists only in process memory, never a fixture file.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519"),
      id = randomBytes(8);
    const pub = Buffer.from(
      `untrusted comment: test public key\n${Buffer.concat([Buffer.from("Ed"), id, publicKey.export({ type: "spki", format: "der" }).subarray(-32)]).toString("base64")}\n`,
    ).toString("base64");
    const raw = await readFile(path.join(f.options.output, "manifest.json"));
    const signature = sign(
        null,
        createHash("blake2b512").update(raw).digest(),
        privateKey,
      ),
      comment = Buffer.from("timestamp:1");
    const encoded = Buffer.from(
      `untrusted comment: fixture\n${Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64")}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([signature, comment]), privateKey).toString("base64")}\n`,
    ).toString("base64");
    const options = {
      directory: f.options.output,
      signatureFile: path.join(f.dir, "manifest.sig"),
      publicKeyFile: path.join(f.dir, "key.pub"),
      configFile: path.join(f.dir, "config.json"),
    };
    await writeFile(options.signatureFile, encoded);
    await writeFile(options.publicKeyFile, pub);
    await writeFile(
      options.configFile,
      JSON.stringify({ plugins: { updater: { pubkey: pub } } }),
    );
    assert.equal((await finalizeResourcePack(options)).verified, true);
    const envelope = JSON.parse(
      await readFile(path.join(f.options.output, "latest.json")),
    );
    assert.deepEqual(Buffer.from(envelope.manifest, "base64"), raw);
    await assert.rejects(
      finalizeResourcePack({
        ...options,
        publicKeyFile: path.join(f.dir, "private.key"),
      }),
    );
    await writeFile(path.join(f.options.output, "assets.zip"), "corrupted");
    await assert.rejects(finalizeResourcePack(options));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
