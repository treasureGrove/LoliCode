import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const [artifactArgument, outputArgument] = process.argv.slice(2);
if (!artifactArgument || !outputArgument)
  throw new Error("Expected ARTIFACT OUTPUT_DIRECTORY.");
const artifact = path.resolve(artifactArgument);
const output = path.resolve(outputArgument);
const releaseRoot = path.join(repository, "release") + path.sep;
if (!output.startsWith(releaseRoot))
  throw new Error(
    "Site output must be inside this worktree's release directory.",
  );
const batch = "20261124-cli-alpha7-v1";
const source = path.join(repository, "deploy/lolicode-cli-site/public/cli");
const packageManifest = JSON.parse(
  await readFile(
    path.join(repository, "packages/lolicode-cli/package.json"),
    "utf8",
  ),
);
const version = packageManifest.version;
const filename = `lolicode-cli-${version}.tgz`;
const artifactBytes = await readFile(artifact);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const product = {
  version,
  channel: "alpha",
  node: ">=24.9.0",
  harness: packageManifest.dependencies["@deepseek-ai/dsh"],
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim(),
  testedPlatforms: ["windows-x64", "linux-x64"],
  publishedDate: "2026-11-24",
  package: {
    filename,
    size: artifactBytes.length,
    sha256: sha(artifactBytes),
    url: `https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-cli-v${version}/${filename}`,
  },
};
await mkdir(path.join(output, "site/cli"), { recursive: true });
const files = {};
for (const file of ["index.html", "site.css", "site.js"]) {
  const bytes = await readFile(path.join(source, file));
  await writeFile(path.join(output, "site/cli", file), bytes);
  files[`cli/${file}`] = sha(bytes);
}
const latest = Buffer.from(`${JSON.stringify(product, null, 2)}\n`);
await writeFile(path.join(output, "site/cli/latest.json"), latest);
files["cli/latest.json"] = sha(latest);
const manifest = Buffer.from(
  `${JSON.stringify({ batch, package: product.package, files }, null, 2)}\n`,
);
await writeFile(path.join(output, "manifest.json"), manifest);
const template = await readFile(
  path.join(repository, "deploy/lolicode-cli-alpha2/deploy.py"),
  "utf8",
);
const deployment = template
  .replaceAll("20261120-cli-alpha2-v1", batch)
  .replaceAll(
    "lolicode-cli-preview-20261120-alpha2.conf",
    "lolicode-cli-preview-20261124-alpha7.conf",
  )
  .replaceAll("0.1.0-alpha.2", version)
  .replace(
    "d0a2277c2c23973ae043ca089b12cfaf6950f630466de8710939af7edefe9e82",
    "939ffb5739117cecccebbb51f706c34db21909d639cc9891e717e115db3655fc",
  )
  .replace(
    "a95cdb99d2f3582687816365318ca36d8c2208d93af1089d563e13c25ebc7bdf",
    "c91a66143342a5db00161098f0a3d19393d31973344b2bbb0a5d94ececed1e25",
  );
await writeFile(path.join(output, "deploy.py"), deployment);
console.log(
  JSON.stringify({
    output,
    manifestSha256: sha(manifest),
    packageSha256: product.package.sha256,
  }),
);
