import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assetURL,
  compareVersions,
  httpsURL,
  parseVersion,
  prepareRelease,
  verifyRelease,
} from "./lolicode-release.mjs";
import {
  parsePublicKey,
  verifySignatureBytes,
} from "./lolicode-updater-signature.mjs";

const wrap = (text) => Buffer.from(text, "utf8").toString("base64");
// Official public verification vector from minisign-verify 0.2.5's tests.
const PUBLIC_VECTOR = wrap(
  "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
);
const SIGNATURE_VECTOR = wrap(
  "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==",
);

function signedFixture(data) {
  // Ephemeral in-memory test key only: never read/export/print a signing secret.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8),
    publicRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const encodedKey = wrap(
    `untrusted comment: owned Node unit fixture\n${Buffer.concat([Buffer.from("Ed"), id, publicRaw]).toString("base64")}\n`,
  );
  const digest = createHash("blake2b512").update(data).digest();
  const signature = sign(null, digest, privateKey),
    comment = "timestamp:1700000000\tfile:owned-fixture.exe";
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(comment)]),
    privateKey,
  );
  const encodedSignature = wrap(
    `untrusted comment: owned Node unit fixture\n${Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`,
  );
  return { encodedKey, encodedSignature };
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lolicode-release-test-"));
  const data = Buffer.from(
    "MZ owned synthetic unit-test bytes, never an executable installer",
  );
  const material = signedFixture(data);
  const installer = path.join(root, "owned-fixture.exe"),
    signature = `${installer}.sig`,
    keyFile = path.join(root, "fixture.key.pub");
  writeFileSync(installer, data);
  writeFileSync(signature, material.encodedSignature);
  writeFileSync(keyFile, material.encodedKey);
  const configFile = path.join(root, "tauri.conf.json"),
    latestURL = "https://updates.example.test/lolicode/updates/latest.json";
  const config = {
    productName: "LoliCode",
    version: "4.0.12",
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: { pubkey: material.encodedKey, endpoints: [latestURL] },
    },
  };
  writeFileSync(configFile, JSON.stringify(config));
  const options = {
    installer,
    signature,
    "public-key-file": keyFile,
    "tauri-config": configFile,
    version: "4.0.12",
    "current-version": "4.0.11",
    "base-url": "https://updates.example.test/lolicode/releases/",
    "latest-url": latestURL,
    "output-dir": path.join(root, "staging"),
    "pub-date": "2026-10-14T12:00:00Z",
  };
  const verifyOptions = {
    "release-dir": path.join(options["output-dir"], options.version),
    "public-key-file": keyFile,
    "tauri-config": configFile,
  };
  return {
    root,
    options,
    verifyOptions,
    config,
    configFile,
    data,
    material,
    clean() {
      const relative = path.relative(
        path.resolve(os.tmpdir()),
        path.resolve(root),
      );
      assert.ok(
        relative &&
          !relative.startsWith("..") &&
          !path.isAbsolute(relative) &&
          path.basename(root).startsWith("lolicode-release-test-"),
      );
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("official prehashed Minisign vector and trusted comment are verified", () => {
  assert.equal(
    verifySignatureBytes(Buffer.from("test"), SIGNATURE_VECTOR, PUBLIC_VECTOR),
    parsePublicKey(PUBLIC_VECTOR).fingerprint,
  );
  assert.throws(
    () =>
      verifySignatureBytes(
        Buffer.from("Test"),
        SIGNATURE_VECTOR,
        PUBLIC_VECTOR,
      ),
    /signature verification failed/,
  );
  const forged = Buffer.from(SIGNATURE_VECTOR, "base64")
    .toString("utf8")
    .replace("timestamp:1556193335", "timestamp:1556193336");
  assert.throws(
    () =>
      verifySignatureBytes(Buffer.from("test"), wrap(forged), PUBLIC_VECTOR),
    /trusted-comment/,
  );
});

test("canonical semver requires a real increase including prerelease precedence", () => {
  assert.equal(compareVersions("4.0.12", "4.0.11"), 1);
  assert.equal(compareVersions("4.0.12-rc.10", "4.0.12-rc.2"), 1);
  assert.equal(compareVersions("4.0.12", "4.0.12-rc.10"), 1);
  assert.equal(compareVersions("4.0.12+new", "4.0.12+old"), 0);
  for (const invalid of [
    "v4.0.12",
    "4.0.012",
    "../4.0.12",
    "4.0.12/next",
    "4.0.12-rc.01",
  ])
    assert.throws(() => parseVersion(invalid));
});

test("release URLs reject credentials, tokens, insecure transport and path escapes", () => {
  for (const url of [
    "http://example.test/releases",
    "https://user:secret@example.test/releases",
    "https://example.test/releases?token=must-not-be-published",
    "https://example.test/releases#key",
    "https://example.test/releases/%2fother",
    "https://example.test/releases/%5cother",
    "https://example.test/lolicode/releases/../other",
    "https://example.test/lolicode/releases/%2e%2e/other",
    "https://example.test/lolicode/releases/%252e%252e/other",
    "https://example.test/%zz",
  ])
    assert.throws(() => httpsURL(url));
  assert.equal(
    assetURL(
      "https://example.test/lolicode/releases/",
      "4.0.12+test",
      "LoliCode 中文 +.exe",
    ),
    "https://example.test/lolicode/releases/4.0.12%2Btest/LoliCode%20%E4%B8%AD%E6%96%87%20%2B.exe",
  );
  assert.throws(() =>
    assetURL("https://example.test/releases", "4.0.12", "../secret.exe"),
  );
});

test("signed local preparation verifies copied bytes and creates only an immutable version directory", async () => {
  const f = fixture();
  try {
    const result = await prepareRelease(f.options);
    assert.equal(result.uploaded, false);
    assert.equal(result.signatureVerified, true);
    assert.deepEqual(readdirSync(f.options["output-dir"]), ["4.0.12"]);
    const latest = JSON.parse(
      readFileSync(path.join(result.directory, "latest.json")),
    );
    assert.deepEqual(Object.keys(latest.platforms), ["windows-x86_64"]);
    assert.equal(
      latest.platforms["windows-x86_64"].signature,
      f.material.encodedSignature,
    );
    const plan = JSON.parse(
      readFileSync(path.join(result.directory, "upload-plan.json")),
    );
    assert.equal(plan.uploads.at(-1).publishLast, true);
    assert.equal(plan.uploads.at(-1).url, f.options["latest-url"]);
    assert.equal(
      (await verifyRelease(f.verifyOptions)).hashesAndBytesVerified,
      true,
    );
    await assert.rejects(prepareRelease(f.options), /immutable/);
  } finally {
    f.clean();
  }
});

test("tampered hashes and refreshed attacker metadata cannot bypass installer verification", async () => {
  const f = fixture();
  try {
    const prepared = await prepareRelease(f.options);
    const releaseFile = path.join(prepared.directory, "release-manifest.json");
    const release = JSON.parse(readFileSync(releaseFile));
    const installer = path.join(prepared.directory, release.files[0].name),
      changed = Buffer.from(f.data);
    changed[3] ^= 1;
    writeFileSync(installer, changed);
    await assert.rejects(verifyRelease(f.verifyOptions), /bytes\/SHA256/);
    release.files[0].sha256 = createHash("sha256")
      .update(changed)
      .digest("hex");
    writeFileSync(releaseFile, JSON.stringify(release));
    await assert.rejects(
      verifyRelease(f.verifyOptions),
      /signature verification failed/,
    );
  } finally {
    f.clean();
  }
});

test("missing/unsigned signatures, mismatched keys, old versions and disabled endpoints fail before output", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      prepareRelease({ ...f.options, version: "4.0.11" }),
      /increase/,
    );
    const changedKey = signedFixture(f.data).encodedKey;
    writeFileSync(f.options["public-key-file"], changedKey);
    await assert.rejects(prepareRelease(f.options), /embedded/);
    writeFileSync(f.options["public-key-file"], f.material.encodedKey);
    writeFileSync(f.options.signature, "UNSIGNED");
    await assert.rejects(prepareRelease(f.options), /Invalid signature/);
    writeFileSync(f.options.signature, f.material.encodedSignature);
    writeFileSync(
      f.configFile,
      JSON.stringify({
        ...f.config,
        plugins: { updater: { ...f.config.plugins.updater, endpoints: [] } },
      }),
    );
    await assert.rejects(prepareRelease(f.options), /endpoint/);
    await assert.rejects(
      prepareRelease({
        ...f.options,
        "public-key-file": path.join(f.root, "DO-NOT-READ-private.key"),
      }),
      /\.pub/,
    );
    assert.equal(readdirSync(f.root).includes("staging"), false);
  } finally {
    f.clean();
  }
});

test("unexpected files and moving latest ahead of artifacts are rejected", async () => {
  const f = fixture();
  try {
    const result = await prepareRelease(f.options),
      planFile = path.join(result.directory, "upload-plan.json");
    const plan = JSON.parse(readFileSync(planFile));
    plan.uploads.reverse();
    writeFileSync(planFile, JSON.stringify(plan));
    await assert.rejects(
      verifyRelease(f.verifyOptions),
      /publish only versioned/,
    );
    plan.uploads.reverse();
    writeFileSync(planFile, JSON.stringify(plan));
    mkdirSync(path.join(result.directory, "unexpected-private-directory"));
    await assert.rejects(verifyRelease(f.verifyOptions), /Unexpected files/);
  } finally {
    f.clean();
  }
});

test("optional portable is copied and audited before latest; a missing source never creates a download URL", async () => {
  const f = fixture();
  try {
    const source = path.join(f.root, "owned-portable.zip");
    await assert.rejects(
      prepareRelease({ ...f.options, portable: source }),
      /ENOENT/,
    );
    assert.equal(readdirSync(f.root).includes("staging"), false);
    // A real empty ZIP framing is enough for this distribution-metadata test;
    // archive contents/7z integrity belong to the separate packaging checks.
    const bytes = Buffer.from(
      "504b05060000000000000000000000000000000000000000",
      "hex",
    );
    writeFileSync(source, bytes);
    const prepared = await prepareRelease({ ...f.options, portable: source });
    assert.deepEqual(
      readFileSync(path.join(prepared.directory, "LoliCode-Portable.zip")),
      bytes,
    );
    const latest = JSON.parse(
      readFileSync(path.join(prepared.directory, "latest.json")),
    );
    const download = latest.downloads["windows-x86_64-portable"];
    assert.equal(download.name, "LoliCode-Portable.zip");
    assert.equal(download.bytes, bytes.length);
    assert.equal(
      download.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(
      download.url,
      "https://updates.example.test/lolicode/releases/4.0.12/LoliCode-Portable.zip",
    );
    const plan = JSON.parse(
      readFileSync(path.join(prepared.directory, "upload-plan.json")),
    );
    assert.equal(plan.uploads[2].file, "LoliCode-Portable.zip");
    assert.equal(plan.uploads[2].sha256, download.sha256);
    assert.equal(plan.uploads.at(-1).publishLast, true);
    assert.equal(
      (await verifyRelease(f.verifyOptions)).hashesAndBytesVerified,
      true,
    );
    writeFileSync(
      path.join(prepared.directory, "LoliCode-Portable.zip"),
      Buffer.from("corrupted"),
    );
    await assert.rejects(verifyRelease(f.verifyOptions), /bytes\/SHA256/);
  } finally {
    f.clean();
  }
});

test("previous published version and inherited upstream key both prevent accidental publication", async () => {
  const f = fixture();
  try {
    const previous = path.join(f.root, "previous-latest.json");
    writeFileSync(previous, JSON.stringify({ version: "4.0.13" }));
    await assert.rejects(
      prepareRelease({ ...f.options, "previous-manifest": previous }),
      /previously published/,
    );
    const inheritedPublicKey =
      "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEM4MDI4QzlBNTczOTI4RTMKUldUaktEbFhtb3dDeUM5US9kT0FmdGR5Ti9vQzcwa2dTMlpibDVDUmQ2M0VGTzVOWnd0SGpFVlEK";
    writeFileSync(f.options["public-key-file"], inheritedPublicKey);
    await assert.rejects(prepareRelease(f.options), /inherited upstream/);
    assert.equal(readdirSync(f.root).includes("staging"), false);
  } finally {
    f.clean();
  }
});
