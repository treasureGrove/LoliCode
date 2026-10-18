#!/usr/bin/env node
// Final stable-delivery gate. A GitHub release alone does not satisfy this gate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion, verifyRelease } from "./lolicode-release.mjs";

const FEEDS = [
  "https://tools.treasuregrove.art/lolicode/updates/latest.json",
  "https://lolicode.com/downloads/updates/latest.json",
];
const R2 = "https://pub-250df9737586416fbd6e8cb0a843b249.r2.dev";
const GITHUB =
  "https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v";
const API = "https://api.github.com/repos/treasureGrove/LoliCode-Releases";

export function validateStableFeed(feed, local) {
  assert.equal(
    parseVersion(local.version).pre.length,
    0,
    "Stable version required",
  );
  assert.equal(
    feed.version,
    local.version,
    "Stable feed has not been promoted to this version",
  );
  assert.deepEqual(Object.keys(feed.platforms ?? {}), ["windows-x86_64"]);
  const installer = `LoliCode-${local.version}-Windows-x64-Setup.exe`;
  assert.deepEqual(
    feed.platforms["windows-x86_64"],
    {
      url: `https://lolicode.com/downloads/releases/${local.version}/${installer}`,
      signature: local.signature,
    },
    "Stable updater must use the reviewed installer and signature",
  );
  const portable = local.assets["LoliCode-Portable.zip"];
  assert.deepEqual(feed.downloads?.["windows-x86_64-portable"], {
    name: "LoliCode-Portable.zip",
    ...portable,
    url: `https://lolicode.com/downloads/releases/${local.version}/LoliCode-Portable.zip`,
  });
  assert.deepEqual(feed.downloads?.["windows-x86_64-installer-github"], {
    name: installer,
    ...local.assets[installer],
    url: `${GITHUB}${local.version}/${installer}`,
  });
}

export function reviewedRedirect(selected, next) {
  if (!selected.startsWith(GITHUB)) return false;
  const url = new URL(next);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.hash &&
    [
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
    ].includes(url.hostname)
  );
}

async function request(url) {
  return fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(120000),
    headers: {
      "User-Agent": "LoliCode-Delivery-Verification/1",
      "Cache-Control": "no-cache",
    },
  });
}

async function metadata(url) {
  const response = await request(url);
  assert.equal(response.status, 200, "Metadata unavailable");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert(bytes <= 128 * 1024, "Metadata exceeds limit");
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  return {
    value: JSON.parse(data),
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

export async function verifyDelivery(options) {
  await verifyRelease(options); // Actual local installer bytes and minisign, not a receipt boolean.
  const directory = path.resolve(options["release-dir"]);
  const release = JSON.parse(
    readFileSync(path.join(directory, "release-manifest.json"), "utf8"),
  );
  const version = release.version;
  assert.equal(parseVersion(version).pre.length, 0, "Stable version required");
  const installer = `LoliCode-${version}-Windows-x64-Setup.exe`;
  const assets = Object.fromEntries(
    release.files
      .filter((f) => f.name !== "latest.json")
      .map(({ name, bytes, sha256 }) => [name, { bytes, sha256 }]),
  );
  assert.deepEqual(
    Object.keys(assets).sort(),
    [installer, `${installer}.sig`, "LoliCode-Portable.zip"].sort(),
  );
  const local = {
    version,
    assets,
    signature: readFileSync(
      path.join(directory, `${installer}.sig`),
      "utf8",
    ).trim(),
  };
  const proof = {
    version,
    passed: false,
    feeds: [],
    artifacts: [],
    githubLatest: null,
  };
  for (const url of FEEDS) {
    const result = await metadata(url);
    validateStableFeed(result.value, local);
    proof.feeds.push({
      url,
      version: result.value.version,
      sha256: result.sha256,
    });
  }
  assert.equal(
    proof.feeds[0].sha256,
    proof.feeds[1].sha256,
    "Website and installed clients disagree",
  );
  const github = (await metadata(`${API}/releases/latest`)).value;
  assert.equal(github.tag_name, `lolicode-v${version}`);
  assert.equal(github.draft, false);
  assert.equal(github.prerelease, false);
  proof.githubLatest = github.tag_name;
  for (const [name, expected] of Object.entries(assets)) {
    const asset = github.assets.find((item) => item.name === name);
    assert(
      asset &&
        asset.state === "uploaded" &&
        asset.size === expected.bytes &&
        asset.digest === `sha256:${expected.sha256}`,
      "GitHub asset differs from verified local bytes",
    );
    const url = `https://lolicode.com/downloads/releases/${version}/${name}`;
    const routed = await request(url);
    assert.equal(
      routed.status,
      302,
      "Download must redirect instead of using website bandwidth",
    );
    const selected = routed.headers.get("location");
    await routed.body?.cancel();
    assert(
      [
        `${R2}/lolicode/releases/${version}/${name}`,
        `${GITHUB}${version}/${name}`,
      ].includes(selected),
    );
    let response = await request(selected);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      assert(
        reviewedRedirect(selected, next),
        "Unexpected download storage redirect",
      );
      await response.body?.cancel();
      response = await request(next);
    }
    assert.equal(response.status, 200);
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert(bytes <= expected.bytes, "Unexpected installer length");
      hash.update(chunk);
    }
    const actual = { bytes, sha256: hash.digest("hex") };
    assert.deepEqual(actual, expected);
    proof.artifacts.push({
      name,
      url,
      selectedSource: selected.startsWith(R2) ? "r2" : "github",
      ...actual,
    });
  }
  proof.passed = true;
  return proof;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i]?.slice(2);
      assert(
        ["release-dir", "public-key-file", "tauri-config", "output"].includes(
          key,
        ) &&
          process.argv[i + 1] &&
          !Object.hasOwn(options, key),
        "Invalid arguments",
      );
      options[key] = process.argv[i + 1];
    }
    const proof = await verifyDelivery(options);
    if (options.output)
      writeFileSync(options.output, JSON.stringify(proof, null, 2) + "\n", {
        flag: "wx",
      });
    console.log(
      JSON.stringify({
        passed: proof.passed,
        version: proof.version,
        feeds: proof.feeds.length,
        verifiedArtifacts: proof.artifacts.length,
      }),
    );
  } catch {
    // Transport errors can contain signed storage URLs; never print raw errors.
    console.error(
      "Stable delivery verification failed; check the feeds, version and public asset bytes.",
    );
    process.exitCode = 1;
  }
}
