#!/usr/bin/env node
// Local, credential-free preparation of LoliCode's signed Windows updater files.
// No private-key handling, networking or changes to the application's config.
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePublicKey,
  parseSignature,
  verifySignatureFile,
  UPSTREAM_KEY_FINGERPRINT,
} from "./lolicode-updater-signature.mjs";

const PLATFORM = "windows-x86_64";
const PORTABLE_PLATFORM = "windows-x86_64-portable";
const PORTABLE_NAME = "LoliCode-Portable.zip";
const DEFAULT_CONFIG = fileURLToPath(
  new URL("../src-tauri/tauri.conf.json", import.meta.url),
);
const HELP = `LoliCode signed updater preparation (local only)

prepare --installer <NSIS.exe> --signature <NSIS.exe.sig>
  --public-key-file <LoliCode.key.pub> --version <semver>
  --current-version <previous-semver> --base-url <https://host/lolicode/releases>
  --latest-url <https://host/lolicode/updates/latest.json> --output-dir <staging-root>
  [--tauri-config <tauri.conf.json>] [--notes-file <release-notes.md>]
  [--pub-date <RFC3339>] [--previous-manifest <published-latest.json>]
  [--portable <verified-portable.zip>]

verify --release-dir <staging-root/version> --public-key-file <LoliCode.key.pub>
  [--tauri-config <tauri.conf.json>]

prepare writes only a new immutable version directory. upload-plan.json puts
the mutable latest.json last. Neither command uploads files or signs with a key.`;

export function parseVersion(value) {
  if (typeof value !== "string" || value.length > 80)
    throw new Error("Invalid release version.");
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (
    !match ||
    match.slice(1, 4).some((n) => BigInt(n) > 18446744073709551615n) ||
    match[4]
      ?.split(".")
      .some((p) => /^\d+$/.test(p) && p.length > 1 && p.startsWith("0"))
  )
    throw new Error("Version must be canonical SemVer without a leading v.");
  return {
    value,
    core: match.slice(1, 4).map(BigInt),
    pre: match[4]?.split(".") ?? [],
  };
}

export function compareVersions(a, b) {
  const left = parseVersion(a),
    right = parseVersion(b);
  for (let i = 0; i < 3; i++)
    if (left.core[i] !== right.core[i])
      return left.core[i] > right.core[i] ? 1 : -1;
  if (!left.pre.length || !right.pre.length)
    return Number(!left.pre.length) - Number(!right.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    if (left.pre[i] === undefined) return -1;
    if (right.pre[i] === undefined) return 1;
    if (left.pre[i] === right.pre[i]) continue;
    const ln = /^\d+$/.test(left.pre[i]),
      rn = /^\d+$/.test(right.pre[i]);
    if (ln && rn) return BigInt(left.pre[i]) > BigInt(right.pre[i]) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return left.pre[i] > right.pre[i] ? 1 : -1;
  }
  return 0;
}

export function httpsURL(value) {
  if (
    typeof value !== "string" ||
    !/^https:\/\//i.test(value) ||
    /[\\\x00-\x20]/.test(value)
  )
    throw new Error("Release URL must be explicit HTTPS with an encoded path.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Release URL must be a valid HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Release URL must use HTTPS without credentials, query or fragment.",
    );
  // Inspect the original path: URL() would silently normalize literal or
  // encoded .. segments before we could reject a namespace escape.
  const rawPath = value.match(/^https:\/\/[^/?#]*(\/[^?#]*)?/i)?.[1] ?? "";
  for (const segment of rawPath.split("/").filter(Boolean)) {
    let decoded = segment;
    for (let pass = 0; pass < 4; pass++) {
      let next;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        throw new Error("Invalid URL path encoding.");
      }
      if (
        next.includes("/") ||
        next.includes("\\") ||
        next === "." ||
        next === ".." ||
        /[\0-\x1f]/.test(next)
      )
        throw new Error("Unsafe URL path segment.");
      if (next === decoded) break;
      decoded = next;
      if (pass === 3) throw new Error("Excessively encoded URL path.");
    }
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

export function assetURL(base, version, name) {
  parseVersion(version);
  safeName(name);
  return `${httpsURL(base).href.replace(/\/$/, "")}/${encodeURIComponent(version)}/${encodeURIComponent(name)}`;
}

function safeName(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 220 ||
    name === "." ||
    name === ".." ||
    /[\\/:\0-\x1f]/.test(name) ||
    /[. ]$/.test(name)
  )
    throw new Error("Unsafe release file name.");
  return name;
}

function regularFile(filename, suffix) {
  if (
    typeof filename !== "string" ||
    (suffix && !filename.toLowerCase().endsWith(suffix))
  )
    throw new Error(`Expected a ${suffix ?? "regular"} file.`);
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Release input must be a regular file.");
  return realpathSync(filename);
}

function readSmall(filename, suffix, maximum = 16384) {
  const file = regularFile(filename, suffix);
  if (lstatSync(file).size > maximum)
    throw new Error("Release metadata file is too large.");
  return readFileSync(file, "utf8");
}

function publicBinding(publicKeyFile, configFile = DEFAULT_CONFIG) {
  // The explicit .pub requirement prevents an accidental private-key path.
  const publicKey = parsePublicKey(readSmall(publicKeyFile, ".pub").trim());
  if (publicKey.fingerprint === UPSTREAM_KEY_FINGERPRINT)
    throw new Error(
      "The inherited upstream signing key cannot sign LoliCode releases. Generate an independent LoliCode key.",
    );
  const config = JSON.parse(readSmall(configFile, ".json", 1024 * 1024));
  if (config.productName !== "LoliCode")
    throw new Error("Expected the LoliCode Tauri configuration.");
  const embedded = parsePublicKey(config.plugins?.updater?.pubkey);
  if (!embedded.raw.equals(publicKey.raw))
    throw new Error(
      "Public key does not match the updater key embedded by the Tauri configuration.",
    );
  return { publicKey, config };
}

async function metadata(filename, name) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { name, bytes, sha256: hash.digest("hex") };
}

function json(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
}
function readJSON(filename) {
  return JSON.parse(readSmall(filename, ".json", 4 * 1024 * 1024));
}

function pubDate(value = new Date().toISOString()) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    Number.isNaN(Date.parse(value))
  )
    throw new Error("pub-date must be an RFC3339 timestamp.");
  return new Date(value).toISOString();
}

export async function prepareRelease(options) {
  const version = parseVersion(options.version).value;
  const current = parseVersion(options["current-version"]).value;
  if (compareVersions(version, current) <= 0)
    throw new Error("Release version must increase above current-version.");
  if (
    options["previous-manifest"] &&
    compareVersions(version, readJSON(options["previous-manifest"]).version) <=
      0
  )
    throw new Error(
      "Release version must increase above the previously published manifest.",
    );
  const base = httpsURL(options["base-url"]).href;
  const latestURL = httpsURL(options["latest-url"]).href;
  const { publicKey, config } = publicBinding(
    options["public-key-file"],
    options["tauri-config"],
  );
  const endpoints = config.plugins?.updater?.endpoints;
  if (
    !Array.isArray(endpoints) ||
    endpoints.length !== 1 ||
    endpoints[0] !== latestURL
  )
    throw new Error(
      "The LoliCode updater endpoint must exactly match latest-url; fallback/upstream endpoints are not accepted.",
    );
  if (config.bundle?.createUpdaterArtifacts !== true)
    throw new Error(
      "Enable Tauri v2 createUpdaterArtifacts before preparing an update release.",
    );
  if (config.version !== version)
    throw new Error(
      "Release version does not match the version in the LoliCode Tauri configuration.",
    );
  const installer = regularFile(options.installer, ".exe");
  const signatureFile = regularFile(options.signature, ".exe.sig");
  const signature = readSmall(signatureFile, ".sig").trim();
  parseSignature(signature);
  await verifySignatureFile(installer, signature, publicKey.encoded);
  const name = `LoliCode-${version}-Windows-x64-Setup.exe`;
  safeName(name);
  const notes = options["notes-file"]
    ? readSmall(options["notes-file"], ".md", 512 * 1024)
    : "";
  const portableSource = options.portable
    ? regularFile(options.portable, ".zip")
    : undefined;
  const output = path.resolve(options["output-dir"]);
  mkdirSync(output, { recursive: true });
  const canonicalOutput = realpathSync(output),
    destination = path.join(canonicalOutput, version);
  if (existsSync(destination))
    throw new Error(
      "Version directory already exists; releases are immutable and must not be overwritten.",
    );
  const stage = mkdtempSync(path.join(canonicalOutput, `.stage-${version}-`));
  let committed = false;
  try {
    const stagedInstaller = path.join(stage, name),
      stagedSignature = path.join(stage, `${name}.sig`);
    copyFileSync(installer, stagedInstaller);
    writeFileSync(stagedSignature, signature, { flag: "wx" });
    await verifySignatureFile(stagedInstaller, signature, publicKey.encoded);
    const artifact = await metadata(stagedInstaller, name),
      detached = await metadata(stagedSignature, `${name}.sig`);
    let portable;
    if (portableSource) {
      copyFileSync(portableSource, path.join(stage, PORTABLE_NAME));
      portable = await metadata(path.join(stage, PORTABLE_NAME), PORTABLE_NAME);
    }
    const latest = {
      version,
      notes,
      pub_date: pubDate(options["pub-date"]),
      platforms: {
        [PLATFORM]: { signature, url: assetURL(base, version, name) },
      },
    };
    if (portable)
      latest.downloads = {
        [PORTABLE_PLATFORM]: {
          ...portable,
          url: assetURL(base, version, PORTABLE_NAME),
        },
      };
    json(path.join(stage, "latest.json"), latest);
    const latestMetadata = await metadata(
      path.join(stage, "latest.json"),
      "latest.json",
    );
    const release = {
      schemaVersion: 1,
      product: "LoliCode",
      installerKind: "NSIS",
      version,
      previousVersion: current,
      platform: PLATFORM,
      releaseBaseURL: base,
      latestURL,
      publicKeyFingerprintSha256: publicKey.fingerprint,
      signatureVerified: true,
      files: [
        artifact,
        detached,
        ...(portable ? [portable] : []),
        latestMetadata,
      ],
    };
    json(path.join(stage, "release-manifest.json"), release);
    json(path.join(stage, "upload-plan.json"), {
      schemaVersion: 1,
      version,
      releaseDirectory: version,
      publishLatestLast: true,
      uploads: [
        {
          file: name,
          url: latest.platforms[PLATFORM].url,
          cacheControl: "public, max-age=31536000, immutable",
        },
        {
          file: `${name}.sig`,
          url: assetURL(base, version, `${name}.sig`),
          cacheControl: "public, max-age=31536000, immutable",
        },
        ...(portable
          ? [
              {
                file: PORTABLE_NAME,
                url: latest.downloads[PORTABLE_PLATFORM].url,
                bytes: portable.bytes,
                sha256: portable.sha256,
                cacheControl: "public, max-age=31536000, immutable",
              },
            ]
          : []),
        {
          file: "release-manifest.json",
          url: assetURL(base, version, "release-manifest.json"),
          cacheControl: "public, max-age=31536000, immutable",
        },
        {
          file: "latest.json",
          url: latestURL,
          cacheControl: "no-cache, max-age=0, must-revalidate",
          contentType: "application/json",
          publishLast: true,
        },
      ],
      precondition:
        "Upload immutable artifacts, fetch them from their final HTTPS URLs and verify their signatures/SHA256/bytes before publishing latest.json. This local tool does not upload or confirm deployment.",
    });
    // Reverify staged bytes before making the immutable version directory visible.
    await verifyRelease({
      "release-dir": stage,
      "public-key-file": options["public-key-file"],
      "tauri-config": options["tauri-config"],
    });
    if (existsSync(destination))
      throw new Error(
        "Version directory appeared during preparation; refusing overwrite.",
      );
    renameSync(stage, destination);
    committed = true;
    return {
      version,
      directory: destination,
      platform: PLATFORM,
      installer: artifact,
      publicKeyFingerprintSha256: publicKey.fingerprint,
      signatureVerified: true,
      uploaded: false,
    };
  } finally {
    if (!committed && existsSync(stage)) {
      const relative = path.relative(canonicalOutput, realpathSync(stage));
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative.startsWith(`..${path.sep}`) ||
        relative === ".." ||
        !path.basename(stage).startsWith(`.stage-${version}-`)
      )
        throw new Error("Refusing unsafe staging cleanup.");
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

export async function verifyRelease(options) {
  const directory = realpathSync(options["release-dir"]);
  const release = readJSON(path.join(directory, "release-manifest.json"));
  const latest = readJSON(path.join(directory, "latest.json"));
  const { publicKey, config } = publicBinding(
    options["public-key-file"],
    options["tauri-config"],
  );
  parseVersion(release.version);
  if (
    release.schemaVersion !== 1 ||
    release.product !== "LoliCode" ||
    release.installerKind !== "NSIS" ||
    release.platform !== PLATFORM ||
    release.publicKeyFingerprintSha256 !== publicKey.fingerprint ||
    latest.version !== release.version ||
    config.version !== release.version ||
    compareVersions(release.version, release.previousVersion) <= 0
  )
    throw new Error("Release identity/version/public-key binding is invalid.");
  if (!Array.isArray(release.files) || ![3, 4].includes(release.files.length))
    throw new Error("Expected installer, signature and latest.json metadata.");
  const portable = release.files.find((file) => file.name === PORTABLE_NAME);
  if (release.files.length !== (portable ? 4 : 3))
    throw new Error("Portable file metadata is inconsistent.");
  const expectedName = `LoliCode-${release.version}-Windows-x64-Setup.exe`;
  const expected = [
    expectedName,
    `${expectedName}.sig`,
    ...(portable ? [PORTABLE_NAME] : []),
    "latest.json",
  ];
  const inventory = readdirSync(directory).sort();
  if (
    JSON.stringify(inventory) !==
    JSON.stringify(
      [...expected, "release-manifest.json", "upload-plan.json"].sort(),
    )
  )
    throw new Error("Unexpected files in the release directory.");
  const seen = new Set();
  for (const file of release.files) {
    safeName(file.name);
    if (
      !expected.includes(file.name) ||
      seen.has(file.name) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Invalid or duplicate release asset metadata.");
    seen.add(file.name);
    const filename = regularFile(path.join(directory, file.name));
    if (path.dirname(filename) !== directory)
      throw new Error("Asset is outside the version directory.");
    const actual = await metadata(filename, file.name);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new Error(
        "Release asset bytes/SHA256 do not match the release manifest.",
      );
  }
  const platform = latest.platforms?.[PLATFORM];
  if (
    !latest.platforms ||
    Object.keys(latest.platforms).length !== 1 ||
    platform?.url !==
      assetURL(release.releaseBaseURL, release.version, expectedName) ||
    httpsURL(release.latestURL).href !== release.latestURL ||
    config.plugins?.updater?.endpoints?.length !== 1 ||
    config.plugins.updater.endpoints[0] !== release.latestURL ||
    config.bundle?.createUpdaterArtifacts !== true ||
    pubDate(latest.pub_date) !== latest.pub_date
  )
    throw new Error(
      "Updater platform, HTTPS URL, date or configured endpoint is invalid.",
    );
  const signature = readSmall(
    path.join(directory, `${expectedName}.sig`),
    ".sig",
  ).trim();
  if (platform.signature !== signature)
    throw new Error(
      "latest.json must embed the exact signature file contents.",
    );
  await verifySignatureFile(
    path.join(directory, expectedName),
    signature,
    publicKey.encoded,
  );
  if (portable) {
    const download = latest.downloads?.[PORTABLE_PLATFORM];
    if (
      Object.keys(latest.downloads ?? {}).length !== 1 ||
      download?.name !== PORTABLE_NAME ||
      download?.bytes !== portable.bytes ||
      download?.sha256 !== portable.sha256 ||
      download?.url !==
        assetURL(release.releaseBaseURL, release.version, PORTABLE_NAME)
    )
      throw new Error(
        "Portable download URL and checksum must describe the actual copied archive.",
      );
  } else if (latest.downloads !== undefined)
    throw new Error(
      "No portable source was provided; do not publish a portable URL.",
    );
  const plan = readJSON(path.join(directory, "upload-plan.json"));
  const uploadNames = [
    expectedName,
    `${expectedName}.sig`,
    ...(portable ? [PORTABLE_NAME] : []),
    "release-manifest.json",
    "latest.json",
  ];
  if (
    plan.schemaVersion !== 1 ||
    plan.version !== release.version ||
    plan.releaseDirectory !== release.version ||
    plan.publishLatestLast !== true ||
    !Array.isArray(plan.uploads) ||
    plan.uploads.length !== uploadNames.length ||
    plan.uploads.some(
      (item, index) =>
        item.file !== uploadNames[index] ||
        item.url !==
          (index === uploadNames.length - 1
            ? release.latestURL
            : assetURL(release.releaseBaseURL, release.version, item.file)) ||
        (index === uploadNames.length - 1
          ? item.publishLast !== true
          : item.publishLast === true),
    )
  )
    throw new Error(
      "Upload plan must publish only versioned assets, with latest.json last.",
    );
  return {
    version: release.version,
    platform: PLATFORM,
    publicKeyFingerprintSha256: publicKey.fingerprint,
    signatureVerified: true,
    hashesAndBytesVerified: true,
    uploaded: false,
  };
}

function argumentsFor(command, argv) {
  const allowed =
    command === "prepare"
      ? [
          "installer",
          "signature",
          "public-key-file",
          "version",
          "current-version",
          "base-url",
          "latest-url",
          "output-dir",
          "tauri-config",
          "notes-file",
          "pub-date",
          "previous-manifest",
          "portable",
        ]
      : ["release-dir", "public-key-file", "tauri-config"];
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2),
      value = argv[i + 1];
    if (
      !argv[i]?.startsWith("--") ||
      !allowed.includes(key) ||
      !value ||
      value.startsWith("--") ||
      values[key] !== undefined
    )
      throw new Error(
        "Unknown, duplicate or incomplete release option. Use --help.",
      );
    values[key] = value;
  }
  const required =
    command === "prepare" ? allowed.slice(0, 8) : allowed.slice(0, 2);
  if (required.some((key) => values[key] === undefined))
    throw new Error("A required release option is missing. Use --help.");
  return values;
}

export async function runCLI(argv) {
  if (argv.length === 0 || argv[0] === "--help") {
    console.log(HELP);
    return;
  }
  const [command, ...rest] = argv;
  if (!["prepare", "verify"].includes(command))
    throw new Error("Use prepare or verify.");
  const options = argumentsFor(command, rest);
  const result = await (command === "prepare"
    ? prepareRelease(options)
    : verifyRelease(options));
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCLI(process.argv.slice(2)).catch((error) => {
    // Never echo argument values, environment variables or input file contents.
    console.error(
      `LoliCode release preparation failed: ${error.code ? "File access failed." : error.message}`,
    );
    process.exitCode = 1;
  });
}
