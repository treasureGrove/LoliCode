#!/usr/bin/env node
// Deployment is opt-in by running this command. Tests and --dry-run never SSH.
// Uses only the authorized tools alias and the dedicated LoliCode namespace.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseVersion, verifyRelease } from "./lolicode-release.mjs";
import { verifySignatureFile } from "./lolicode-updater-signature.mjs";

export const REMOTE_NAMESPACE = "/www/wwwroot/tools.treasuregrove.art/lolicode";
export const PUBLIC_NAMESPACE = "https://tools.treasuregrove.art/lolicode";
export const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 7200;
const SITE_FILES = [
  "index.html",
  "assets/site.css",
  "assets/downloads.js",
  "assets/logo.svg",
  "assets/maid.png",
];
const OPTIONAL_SITE_FILES = ["assets/workbench.jpg"];
const runFile = promisify(execFile);
const REMOTE_PROGRAM = readFileSync(
  new URL("./lolicode-publish-remote.py", import.meta.url),
  "utf8",
);

export function quotePosix(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function hashFile(filename) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function within(root, relative) {
  const candidate = path.join(root, relative),
    stat = lstatSync(candidate),
    absolute = realpathSync(candidate);
  const fromRoot = path.relative(root, absolute);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !fromRoot ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(fromRoot)
  )
    throw new Error("Publication source must be an owned regular file.");
  return absolute;
}

function localSiteFiles(directory) {
  const actual = [];
  function visit(relative = "") {
    for (const entry of readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error("Website source must not contain symlinks.");
      if (entry.isDirectory()) {
        if (name !== "assets")
          throw new Error(
            "Only the dedicated LoliCode website files are accepted.",
          );
        visit(name);
      } else if (name !== "README.md") actual.push(name);
    }
  }
  visit();
  if (
    SITE_FILES.some((file) => !actual.includes(file)) ||
    actual.some(
      (file) => ![...SITE_FILES, ...OPTIONAL_SITE_FILES].includes(file),
    )
  )
    throw new Error(
      "Website directory must contain the approved LoliCode website files only.",
    );
  return actual;
}

export async function preparePublishPlan(options) {
  const checked = await verifyRelease(options);
  const directory = realpathSync(options["release-dir"]);
  const release = JSON.parse(
    readFileSync(path.join(directory, "release-manifest.json"), "utf8"),
  );
  if (parseVersion(release.version).pre.length)
    throw new Error(
      "Stable latest.json cannot publish a prerelease; use a separate candidate feed.",
    );
  if (
    release.latestURL !== `${PUBLIC_NAMESPACE}/updates/latest.json` ||
    release.releaseBaseURL.replace(/\/$/, "") !== `${PUBLIC_NAMESPACE}/releases`
  )
    throw new Error(
      "This deployer is restricted to the authorized LoliCode HTTPS namespace.",
    );
  const stageId = options["resume-stage"] ?? randomUUID();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      stageId,
    )
  )
    throw new Error(
      "resume-stage must be the exact UUID of a retained LoliCode publication.",
    );
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const source = within(directory, name);
    files.push({ role: "release", name, source, ...(await hashFile(source)) });
  }
  if (options["site-dir"]) {
    const site = realpathSync(options["site-dir"]);
    if (path.basename(site).toLowerCase() !== "lolicode")
      throw new Error(
        "site-dir must be the dedicated lolicode directory, never the tools website root.",
      );
    for (const name of localSiteFiles(site)) {
      const source = within(site, name);
      files.push({ role: "site", name, source, ...(await hashFile(source)) });
    }
  }
  const spec = {
    namespace: REMOTE_NAMESPACE,
    stageId,
    version: checked.version,
    resume: options["resume-stage"] !== undefined,
    files: files.map(({ source, ...file }) => file),
  };
  return { spec, files, directory, checked };
}

export function remoteCommand(phase, spec) {
  if (!["begin", "commit-artifacts", "finalize", "abort"].includes(phase))
    throw new Error("Invalid remote phase.");
  const encoded = Buffer.from(JSON.stringify(spec)).toString("base64");
  return `python3 - ${quotePosix(phase)} ${quotePosix(encoded)}`;
}

export function parseDownloadTimeoutSeconds(value) {
  if (value === undefined) return DEFAULT_DOWNLOAD_TIMEOUT_SECONDS;
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && !/^[1-9][0-9]*$/.test(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 60 ||
    Number(value) > 7200
  )
    throw new Error(
      "download-timeout-seconds must be an integer from 60 to 7200.",
    );
  return Number(value);
}

export function openSSHTransport(options = {}) {
  const downloadTimeoutMs =
    parseDownloadTimeoutSeconds(options.downloadTimeoutSeconds) * 1000;
  return {
    async remote(phase, spec) {
      const child = execFile(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=20",
          "tools",
          remoteCommand(phase, spec),
        ],
        { timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 },
        () => {},
      );
      const result = new Promise((resolve, reject) => {
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (data) => {
          output += data;
        });
        child.on("error", () =>
          reject(new Error("OpenSSH could not be started.")),
        );
        child.on("close", (code) => {
          let value;
          try {
            value = JSON.parse(output);
          } catch {
            reject(
              new Error(
                `SSH ${phase} did not return a valid publication result.`,
              ),
            );
            return;
          }
          if (code !== 0 || value.ok !== true)
            reject(new Error(value.error ?? `SSH ${phase} failed.`));
          else resolve(value);
        });
      });
      // An SSH refusal can close stdin before the program is written. The
      // process close/error result reports failure; do not leave EPIPE uncaught.
      child.stdin.on("error", () => {});
      child.stdin.end(REMOTE_PROGRAM);
      return result;
    },
    async upload(source, destination) {
      if (
        !destination.startsWith(`${REMOTE_NAMESPACE}/.publish-stage-`) ||
        /[\s'";`$\\]/.test(destination)
      )
        throw new Error("SCP destination must be an owned staging path.");
      try {
        await runFile(
          "scp",
          [
            "-q",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=20",
            source,
            `tools:${destination}`,
          ],
          { timeout: 900000, windowsHide: true, maxBuffer: 1024 * 1024 },
        );
      } catch {
        throw new Error("SCP failed; the owned staging directory is retained.");
      }
    },
    async download(url, destination, expected) {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(downloadTimeoutMs),
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent": "LoliCode-release-verifier",
        },
      });
      if (!response.ok || !response.body)
        throw new Error("Public HTTPS artifact download failed.");
      let count = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, done) {
          count += chunk.length;
          done(
            count > expected.bytes
              ? new Error("Public download exceeds the declared artifact size.")
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        limiter,
        createWriteStream(destination, { flags: "wx" }),
      );
      const actual = await hashFile(destination);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
        throw new Error("Public HTTPS artifact bytes/SHA256 mismatch.");
    },
  };
}

export async function publishRelease(options, transport) {
  const downloadTimeoutSeconds = parseDownloadTimeoutSeconds(
    options["download-timeout-seconds"],
  );
  const plan = await preparePublishPlan(options);
  const summary = {
    version: plan.spec.version,
    sshAlias: "tools",
    namespace: REMOTE_NAMESPACE,
    stageId: plan.spec.stageId,
    files: plan.spec.files,
    publishLatestLast: true,
    downloadTimeoutSeconds,
  };
  if (options["dry-run"]) return { ...summary, dryRun: true, uploaded: false };
  transport ??= openSSHTransport({ downloadTimeoutSeconds });
  let begun = false;
  try {
    begun = true; // Also attempt owned-lock release if begin fails after locking.
    const initial = await transport.remote("begin", plan.spec);
    if (!initial.artifactsReady) {
      for (const file of plan.files)
        await transport.upload(
          file.source,
          `${REMOTE_NAMESPACE}/.publish-stage-${plan.spec.stageId}/${file.role}/${file.name}`,
        );
      await transport.remote("commit-artifacts", plan.spec);
    }
    const downloaded = mkdtempSync(
      path.join(os.tmpdir(), `lolicode-public-release-${plan.spec.stageId}-`),
    );
    const latest = JSON.parse(
      readFileSync(path.join(plan.directory, "latest.json"), "utf8"),
    );
    const installerURL = latest.platforms["windows-x86_64"].url;
    const installer = plan.files.find(
      (file) => file.role === "release" && file.name.endsWith("-Setup.exe"),
    );
    const detached = plan.files.find(
      (file) =>
        file.role === "release" && file.name === `${installer.name}.sig`,
    );
    await transport.download(
      installerURL,
      path.join(downloaded, installer.name),
      installer,
    );
    await transport.download(
      `${installerURL}.sig`,
      path.join(downloaded, detached.name),
      detached,
    );
    const publicKey = readFileSync(options["public-key-file"], "utf8").trim();
    const signature = readFileSync(
      path.join(downloaded, detached.name),
      "utf8",
    ).trim();
    if (signature !== latest.platforms["windows-x86_64"].signature)
      throw new Error(
        "Public signature differs from the prepared updater manifest.",
      );
    await verifySignatureFile(
      path.join(downloaded, installer.name),
      signature,
      publicKey,
    );
    const portable = plan.files.find(
      (file) =>
        file.role === "release" && file.name === "LoliCode-Portable.zip",
    );
    if (portable)
      await transport.download(
        latest.downloads["windows-x86_64-portable"].url,
        path.join(downloaded, portable.name),
        portable,
      );
    await transport.remote("finalize", plan.spec);
    begun = false;
    return {
      ...summary,
      published: true,
      publicSignatureAndHashesVerified: true,
      stagingRetained: true,
    };
  } catch (error) {
    if (begun) {
      try {
        await transport.remote("abort", plan.spec);
      } catch {
        /* Retain lock for manual inspection if releasing it failed. */
      }
    }
    throw new Error(
      `Publication stopped; staging ID ${plan.spec.stageId} is retained. ${error.code ? "File/transport access failed." : error.message}`,
    );
  }
}

export async function runPublishCLI(argv) {
  if (!argv.length || argv[0] === "--help") {
    console.log(
      "node scripts/lolicode-publish.mjs --release-dir <prepared/version> --public-key-file <key.pub> [--tauri-config <config.json>] [--site-dir <TAWEBTOOL/lolicode>] [--dry-run] [--resume-stage <retained-UUID>] [--download-timeout-seconds <60..7200; default 7200>]",
    );
    return;
  }
  const values = parsePublishOptions(argv);
  console.log(JSON.stringify(await publishRelease(values), null, 2));
}

export function parsePublishOptions(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (
      !argv[i].startsWith("--") ||
      ![
        "release-dir",
        "public-key-file",
        "tauri-config",
        "site-dir",
        "dry-run",
        "resume-stage",
        "download-timeout-seconds",
      ].includes(key) ||
      values[key] !== undefined
    )
      throw new Error("Unknown or duplicate publication option.");
    if (key === "dry-run") values[key] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new Error("Incomplete publication option.");
      values[key] = value;
    }
  }
  if (!values["release-dir"] || !values["public-key-file"])
    throw new Error("release-dir and public-key-file are required.");
  values["download-timeout-seconds"] = parseDownloadTimeoutSeconds(
    values["download-timeout-seconds"],
  );
  return values;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runPublishCLI(process.argv.slice(2)).catch((error) => {
    console.error(
      `LoliCode publication failed: ${error.code ? "File access failed." : error.message}`,
    );
    process.exitCode = 1;
  });
}
