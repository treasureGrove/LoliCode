// Prepare and verify inert presentation packs. Private keys stay in Tauri's signer.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePublicKey,
  verifySignatureBytes,
} from "../release/lolicode-updater-signature.mjs";

const slots = {
  companion: "companion.png",
  scene: "ribbon-atelier.png",
  sidebar: "sidebar-frame.png",
  brooch: "brooch-accent.png",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Deterministic stored ZIP. Fixed timestamps, no symlinks or executable modes. */
export function createResourceZip(files) {
  const local = [],
    central = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    if (!/^(companion|scene|sidebar|brooch)\.png$/.test(name))
      throw new Error("Invalid resource filename");
    const filename = Buffer.from(name),
      crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function officialURL(value) {
  const url = new URL(value);
  const allowed =
    (url.hostname === "tools.treasuregrove.art" &&
      url.pathname.startsWith("/lolicode/resources/")) ||
    (url.hostname === "lolicode.com" &&
      url.pathname.startsWith("/downloads/resources/"));
  if (
    !allowed ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error("Use the official HTTPS resource directory");
}

export async function prepareResourcePack({
  source,
  output,
  version,
  minAppVersion,
  maxAppVersion,
  archiveURL,
}) {
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !/^\d+\.\d+\.\d+$/.test(minAppVersion) ||
    !/^\d+\.\d+\.\d+$/.test(maxAppVersion)
  )
    throw new Error("Invalid resource/app version");
  officialURL(archiveURL);
  const root = await realpath(source),
    files = [];
  for (const [slot, filename] of Object.entries(slots)) {
    const file = path.join(root, filename),
      stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Resources must be regular local PNG files");
    const bytes = await readFile(file);
    if (
      bytes.length > 16 * 1024 * 1024 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("Invalid PNG resource");
    files.push({ slot, name: `${slot}.png`, bytes });
  }
  const archive = createResourceZip(files);
  if (archive.length > 48 * 1024 * 1024)
    throw new Error("Resource archive too large");
  const manifest = {
    format: 1,
    kind: "lolicode-presentation",
    version,
    minAppVersion,
    maxAppVersion,
    archiveUrl: archiveURL,
    archiveSha256: hash(archive),
    archiveBytes: archive.length,
    files: files.map((f) => ({
      slot: f.slot,
      path: f.name,
      sha256: hash(f.bytes),
      bytes: f.bytes.length,
    })),
  };
  await mkdir(output, { recursive: true });
  // A new resource version is immutable; never replace an earlier preparation.
  await writeFile(path.join(output, "assets.zip"), archive, { flag: "wx" });
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest),
    { flag: "wx" },
  );
  return {
    version,
    bytes: archive.length,
    files: files.length,
    archiveSha256: manifest.archiveSha256,
  };
}

export async function finalizeResourcePack({
  directory,
  signatureFile,
  publicKeyFile,
  configFile = fileURLToPath(
    new URL("../../src-tauri/tauri.conf.json", import.meta.url),
  ),
}) {
  if (!publicKeyFile.endsWith(".pub"))
    throw new Error("Expected a public .pub key file");
  const publicKey = (await readFile(publicKeyFile, "utf8")).trim();
  const config = JSON.parse(await readFile(configFile, "utf8"));
  if (
    parsePublicKey(publicKey).fingerprint !==
    parsePublicKey(config.plugins.updater.pubkey).fingerprint
  )
    throw new Error(
      "Resource signer must match the public key embedded in the desktop app",
    );
  const raw = await readFile(path.join(directory, "manifest.json"));
  const signature = (await readFile(signatureFile, "utf8")).trim();
  verifySignatureBytes(raw, signature, publicKey);
  const manifest = JSON.parse(raw),
    archive = await readFile(path.join(directory, "assets.zip"));
  if (
    manifest.kind !== "lolicode-presentation" ||
    archive.length !== manifest.archiveBytes ||
    hash(archive) !== manifest.archiveSha256
  )
    throw new Error("Resource archive no longer matches signed manifest");
  officialURL(manifest.archiveUrl);
  const envelope = { manifest: raw.toString("base64"), signature };
  await writeFile(
    path.join(directory, "latest.json"),
    JSON.stringify(envelope, null, 2),
    { flag: "wx" },
  );
  return {
    version: manifest.version,
    verified: true,
    archiveSha256: manifest.archiveSha256,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [command, ...args] = process.argv.slice(2),
      options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (
        !args[index].startsWith("--") ||
        !args[index + 1] ||
        options[args[index].slice(2)]
      )
        throw new Error("Invalid arguments");
      options[args[index].slice(2)] = args[index + 1];
    }
    const result =
      command === "prepare"
        ? await prepareResourcePack({
            source: options.source,
            output: options.output,
            version: Number(options.version),
            minAppVersion: options["min-app"],
            maxAppVersion: options["max-app"],
            archiveURL: options["archive-url"],
          })
        : command === "finalize"
          ? await finalizeResourcePack({
              directory: options.directory,
              signatureFile: options.signature,
              publicKeyFile: options["public-key"],
            })
          : (() => {
              throw new Error("Use prepare or finalize");
            })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(
      "Resource pack preparation failed. Check paths, version, signature and archive; existing files are preserved.\n",
    );
    process.exitCode = 1;
  }
}
