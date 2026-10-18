// Synthetic keys exist only in this generator's memory; no production key reads.
import {
  generateKeyPairSync,
  randomBytes,
  sign,
  createHash,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRendererZip } from "./lolicode-renderer-pack.mjs";
const { privateKey, publicKey } = generateKeyPairSync("ed25519"),
  id = randomBytes(8);
const pub = Buffer.from(
  `untrusted comment: renderer fixture public key\n${Buffer.concat([Buffer.from("Ed"), id, publicKey.export({ type: "spki", format: "der" }).subarray(-32)]).toString("base64")}\n`,
).toString("base64");
const hash = (b) => createHash("sha256").update(b).digest("hex");
function envelope(raw) {
  const sig = sign(
      null,
      createHash("blake2b512").update(raw).digest(),
      privateKey,
    ),
    comment = Buffer.from("timestamp:1");
  return {
    manifest: raw.toString("base64"),
    signature: Buffer.from(
      `untrusted comment: synthetic renderer\n${Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64")}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([sig, comment]), privateKey).toString("base64")}\n`,
    ).toString("base64"),
  };
}
const files = [
  {
    path: "index.html",
    bytes: Buffer.from(
      '<html><head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>',
    ),
  },
  {
    path: "assets/app.js",
    bytes: Buffer.from(
      "document.querySelector('#root').textContent='SIGNED_RENDERER_ONE';",
    ),
  },
  {
    path: "assets/theme.css",
    bytes: Buffer.from("body{color:#ddd;background:#211b25}"),
  },
];
function pack(version, overrides = {}, zipOverride) {
  const f = files.map((x) => ({ ...x }));
  f[1].bytes = Buffer.from(
    f[1].bytes.toString().replace("ONE", version === 1 ? "ONE" : "TWO"),
  );
  const zip = zipOverride ?? createRendererZip(f);
  const m = {
    format: 1,
    kind: "lolicode-renderer",
    version,
    nativeVersion: "4.0.21-rc.2",
    nativeContract: "a".repeat(64),
    archiveUrl: `https://tools.treasuregrove.art/lolicode/renderer/${version}/renderer.zip`,
    archiveBytes: zip.length,
    archiveSha256: hash(zip),
    files: f.map((x) => ({
      path: x.path,
      bytes: x.bytes.length,
      sha256: hash(x.bytes),
    })),
    ...overrides,
  };
  return {
    envelope: envelope(Buffer.from(JSON.stringify(m))),
    archive: zip.toString("base64"),
  };
}
const zip = createRendererZip(files),
  sym = Buffer.from(zip);
let pos = sym.indexOf(Buffer.from("504b0102", "hex"));
sym.writeUInt16LE(0x0314, pos + 4);
sym.writeUInt32LE(0xa1ff0000, pos + 38);
const result = {
  publicKey: pub,
  first: pack(1),
  second: pack(2),
  wrongNative: pack(3, { nativeVersion: "9.0.0" }),
  wrongContract: pack(3, { nativeContract: "b".repeat(64) }),
  nativeFile: pack(3, {
    files: [
      {
        path: "index.html",
        bytes: files[0].bytes.length,
        sha256: hash(files[0].bytes),
      },
      { path: "assets/evil.exe", bytes: 1, sha256: hash(Buffer.from("x")) },
    ],
  }),
  traversal: pack(3, {
    files: [
      { path: "../index.html", bytes: 1, sha256: hash(Buffer.from("x")) },
    ],
  }),
  undeclared: pack(
    3,
    {},
    createRendererZip([
      ...files,
      { path: "assets/extra.js", bytes: Buffer.from("extra") },
    ]),
  ),
  symlink: pack(1, {}, sym),
};
await writeFile(
  new URL("../src-tauri/test-fixtures/renderer-packs.json", import.meta.url),
  JSON.stringify(result, null, 2) + "\n",
);
console.log("Synthetic renderer fixtures generated; private key was not saved");
