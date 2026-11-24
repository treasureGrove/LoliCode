import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const [action, directory, releaseId, transport] = process.argv.slice(2);
if (
  !["upload", "publish"].includes(action) ||
  !directory ||
  !/^\d+$/.test(releaseId || "")
) {
  throw new Error(
    "Expected upload|publish ARTIFACT_DIRECTORY EXISTING_RELEASE_ID.",
  );
}
const repository = "treasureGrove/LoliCode-Releases";
const tag = "lolicode-cli-v0.1.0-alpha.8";
const api = `https://api.github.com/repos/${repository}`;
const token = execFileSync("gh", ["auth", "token"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "LoliCode-CLI-release",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function request(url, options = {}) {
  const response = await fetch(url, {
    redirect: options.method === "POST" ? "manual" : "follow",
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!response.ok) {
    const location = response.headers.get("location");
    const detail = await response.text();
    throw new Error(
      `GitHub release request failed (${response.status}). ${location || detail.slice(0, 400)}`,
    );
  }
  return response;
}

let release = await (await request(`${api}/releases/${releaseId}`)).json();
if (release.tag_name !== tag || !release.prerelease)
  throw new Error("Unexpected release identity or channel.");
const files = [
  "lolicode-cli-0.1.0-alpha.8.tgz",
  "LoliCode-CLI-README.md",
  "SHA256SUMS",
];
const expected = new Map();
for (const name of files) {
  const bytes = await readFile(path.join(directory, name));
  expected.set(name, { bytes, digest: `sha256:${hash(bytes)}` });
}

if (action === "upload" && transport === "ssh") {
  const result = execFileSync(
    "ssh",
    [
      "-F",
      path.join(os.homedir(), ".ssh/config"),
      "-o",
      "BatchMode=yes",
      "lolicode",
      "python3 /tmp/lolicode-cli-validation-20261124-alpha8/lolicode-cli-upload.py",
    ],
    {
      input: `${JSON.stringify({ token, releaseId: Number(releaseId), files: Object.fromEntries([...expected].map(([name, value]) => [name, value.digest])) })}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 240000,
    },
  );
  process.stdout.write(result);
  release = await (await request(`${api}/releases/${releaseId}`)).json();
}

async function verify(asset, name) {
  const local = expected.get(name);
  if (asset.size !== local.bytes.length || asset.state !== "uploaded")
    throw new Error(`Incomplete asset: ${name}`);
  if (asset.digest) {
    if (asset.digest !== local.digest)
      throw new Error(`Remote digest differs: ${name}`);
  } else {
    const response = await request(`${api}/releases/assets/${asset.id}`, {
      headers: { Accept: "application/octet-stream" },
    });
    if (
      `sha256:${hash(Buffer.from(await response.arrayBuffer()))}` !==
      local.digest
    )
      throw new Error(`Remote bytes differ: ${name}`);
  }
  console.log(
    JSON.stringify({
      asset: name,
      id: asset.id,
      size: asset.size,
      digest: local.digest,
    }),
  );
}

for (const name of files) {
  let asset = release.assets.find((asset) => asset.name === name);
  if (!asset) {
    if (action !== "upload" || !release.draft)
      throw new Error(`Missing frozen asset: ${name}`);
    const upload = new URL(release.upload_url.split("{")[0]);
    if (
      upload.hostname !== "uploads.github.com" ||
      upload.pathname !== `/repos/${repository}/releases/${releaseId}/assets`
    )
      throw new Error("Unexpected upload destination.");
    upload.searchParams.set("name", name);
    asset = await (
      await request(upload, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: expected.get(name).bytes,
      })
    ).json();
  }
  await verify(asset, name);
}
if (action === "publish") {
  const published = await (
    await request(`${api}/releases/${releaseId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        draft: false,
        prerelease: true,
        make_latest: "false",
      }),
    })
  ).json();
  if (published.draft || !published.prerelease)
    throw new Error("Release publication was not confirmed.");
  console.log(
    JSON.stringify({
      status: "published",
      url: published.html_url,
      releaseId: published.id,
    }),
  );
}
