// Whole-front-end pack publisher. Signing stays in Tauri's signer; this script
// reads only an explicitly supplied PUBLIC key and an already-created signature.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "./lolicode-resource-pack.mjs";
import {
  parsePublicKey,
  verifySignatureBytes,
} from "./lolicode-updater-signature.mjs";
const sha = (b) => createHash("sha256").update(b).digest("hex");
export function rendererPath(name) {
  if (!name || name.length > 240 || name.startsWith("/")) return false;
  if (
    name
      .split("/")
      .some(
        (p) =>
          !p ||
          p.startsWith(".") ||
          p.endsWith(".") ||
          !/^[A-Za-z0-9_.-]+$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    return false;
  return (
    name === "index.html" ||
    /^assets\/.+\.(js|css|png|jpg|jpeg|webp|gif|svg|ico|woff|woff2|ttf|otf)$/.test(
      name,
    )
  );
}
export function officialRendererURL(raw) {
  const u = new URL(raw);
  if (
    u.href !== raw ||
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    raw.includes("\\") ||
    !(
      (u.hostname === "tools.treasuregrove.art" &&
        u.pathname.startsWith("/lolicode/renderer/")) ||
      (u.hostname === "lolicode.com" &&
        u.pathname.startsWith("/downloads/renderer/"))
    )
  )
    throw Error("Not an official renderer URL");
}
export async function nativeContractFiles(repository) {
  const files = new Set([
    "src-tauri/build.rs",
    "src-tauri/native_contract.rs",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "crates/lolicode-agent/Cargo.toml",
  ]);
  async function collect(relative, extension) {
    for (const e of await readdir(path.join(repository, relative), {
      withFileTypes: true,
    })) {
      const name = relative + "/" + e.name;
      if (e.isSymbolicLink()) throw Error("Linked native contract input");
      if (e.isDirectory()) await collect(name, extension);
      else if (e.name.endsWith("." + extension)) files.add(name);
    }
  }
  await collect("src-tauri/src", "rs");
  await collect("src-tauri/capabilities", "json");
  await collect("crates/lolicode-agent/src", "rs");
  for (const e of await readdir(path.join(repository, "src-tauri"))) {
    if (e.startsWith("tauri.") && e.endsWith(".json"))
      files.add("src-tauri/" + e);
  }
  return [...files].sort();
}
export async function nativeContract(repository) {
  const version = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  ).version;
  if (
    JSON.parse(
      await readFile(
        path.join(repository, "src-tauri/tauri.conf.json"),
        "utf8",
      ),
    ).version !== version
  )
    throw Error("Native version mismatch");
  const hash = createHash("sha256").update(
    Buffer.from("lolicode-native-contract-v1\0"),
  );
  const record = (name, text) => {
    for (const b of [Buffer.from(name), Buffer.from(text)]) {
      const size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(b.length));
      hash.update(size);
      hash.update(b);
    }
  };
  record("@version", version);
  for (const file of await nativeContractFiles(repository))
    record(
      file,
      (await readFile(path.join(repository, file), "utf8")).replaceAll(
        "\r\n",
        "\n",
      ),
    );
  return { version, contract: hash.digest("hex") };
}
export function createRendererZip(files) {
  const local = [],
    central = [];
  let offset = 0;
  for (const { path: name, bytes } of files) {
    if (!rendererPath(name)) throw Error("Invalid renderer filename");
    const n = Buffer.from(name),
      crc = crc32(bytes),
      h = Buffer.alloc(30),
      c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(bytes.length, 18);
    h.writeUInt32LE(bytes.length, 22);
    h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(bytes.length, 20);
    c.writeUInt32LE(bytes.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    local.push(h, n, bytes);
    central.push(c, n);
    offset += 30 + n.length + bytes.length;
  }
  const dir = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dir, end]);
}
async function guard(file) {
  if (!path.isAbsolute(file)) throw Error("Absolute paths required");
  for (let p = file; ; p = path.dirname(p)) {
    let m;
    try {
      m = await lstat(p);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (m?.isSymbolicLink()) throw Error("Linked renderer directory");
    if (p === path.dirname(p)) break;
  }
}
export async function prepareRendererPack({
  source,
  output,
  version,
  archiveURL,
  repository = path.resolve(fileURLToPath(new URL("..", import.meta.url))),
}) {
  await guard(source);
  await guard(output);
  officialRendererURL(archiveURL);
  if (!Number.isSafeInteger(version) || version < 1)
    throw Error("Invalid renderer version");
  const native = await nativeContract(repository),
    files = [],
    seen = new Set();
  let total = 0;
  async function walk(relative = "") {
    for (const e of (
      await readdir(path.join(source, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const name = relative ? relative + "/" + e.name : e.name,
        absolute = path.join(source, name),
        m = await lstat(absolute);
      if (m.isSymbolicLink()) throw Error("Linked renderer file");
      if (m.isDirectory()) {
        if (name !== "assets" && !name.startsWith("assets/"))
          throw Error("Unexpected renderer directory");
        await walk(name);
        continue;
      }
      if (
        !m.isFile() ||
        !rendererPath(name) ||
        seen.has(name.toLowerCase()) ||
        m.size < 1 ||
        m.size > 32 * 1024 * 1024 ||
        (name === "index.html" && m.size > 128 * 1024)
      )
        throw Error("Unexpected renderer file");
      seen.add(name.toLowerCase());
      const bytes = await readFile(absolute);
      total += bytes.length;
      files.push({ path: name, bytes });
      if (total > 128 * 1024 * 1024 || files.length > 512)
        throw Error("Renderer budget exceeded");
    }
  }
  await walk();
  if (!seen.has("index.html") || !files.some((f) => f.path.endsWith(".js")))
    throw Error("Renderer entry missing");
  const archive = createRendererZip(files);
  if (archive.length > 96 * 1024 * 1024) throw Error("Archive budget exceeded");
  const manifest = {
    format: 1,
    kind: "lolicode-renderer",
    version,
    nativeVersion: native.version,
    nativeContract: native.contract,
    archiveUrl: archiveURL,
    archiveSha256: sha(archive),
    archiveBytes: archive.length,
    files: files.map((f) => ({
      path: f.path,
      bytes: f.bytes.length,
      sha256: sha(f.bytes),
    })),
  };
  const raw = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  if (raw.length > 256 * 1024) throw Error("Manifest budget exceeded");
  await mkdir(output);
  await writeFile(path.join(output, "renderer.zip"), archive, { flag: "wx" });
  await writeFile(path.join(output, "manifest.json"), raw, { flag: "wx" });
  return {
    version,
    nativeVersion: native.version,
    nativeContract: native.contract,
    files: files.length,
    archiveSha256: manifest.archiveSha256,
  };
}
export async function finalizeRendererPack({
  directory,
  signatureFile,
  publicKeyFile,
  configFile = new URL("../src-tauri/tauri.conf.json", import.meta.url),
}) {
  if (!publicKeyFile.endsWith(".pub")) throw Error("Public key required");
  await guard(path.resolve(directory));
  const publicKey = (await readFile(publicKeyFile, "utf8")).trim(),
    config = JSON.parse(await readFile(configFile, "utf8"));
  if (
    parsePublicKey(publicKey).fingerprint !==
    parsePublicKey(config.plugins.updater.pubkey).fingerprint
  )
    throw Error("Updater key mismatch");
  const raw = await readFile(path.join(directory, "manifest.json")),
    signature = (await readFile(signatureFile, "utf8")).trim();
  verifySignatureBytes(raw, signature, publicKey);
  const m = JSON.parse(raw),
    zip = await readFile(path.join(directory, "renderer.zip"));
  if (
    m.format !== 1 ||
    m.kind !== "lolicode-renderer" ||
    m.archiveBytes !== zip.length ||
    m.archiveSha256 !== sha(zip)
  )
    throw Error("Signed renderer archive changed");
  officialRendererURL(m.archiveUrl);
  await writeFile(
    path.join(directory, "latest.json"),
    JSON.stringify({ manifest: raw.toString("base64"), signature }, null, 2) +
      "\n",
    { flag: "wx" },
  );
  return {
    version: m.version,
    verified: true,
    nativeContract: m.nativeContract,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [cmd, ...args] = process.argv.slice(2),
      o = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i].startsWith("--") || !args[i + 1] || o[args[i].slice(2)])
        throw Error("Invalid arguments");
      o[args[i].slice(2)] = args[i + 1];
    }
    const result =
      cmd === "prepare"
        ? await prepareRendererPack({
            source: o.source,
            output: o.output,
            version: Number(o.version),
            archiveURL: o["archive-url"],
          })
        : cmd === "finalize"
          ? await finalizeRendererPack({
              directory: o.directory,
              signatureFile: o.signature,
              publicKeyFile: o["public-key"],
            })
          : (() => {
              throw Error("Use prepare or finalize");
            })();
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      "Renderer pack preparation failed; existing files were preserved. Check source, native contract and signature.",
    );
    process.exitCode = 1;
  }
}
