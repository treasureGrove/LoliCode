import { createRequire } from "node:module";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  lstat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "2.0.12";
const sourceRevision = "2670273ff17da96f85c5826ced57aa1b368754fa";
const extension = process.platform === "win32" ? ".exe" : "";
const packages = {
  "win32-x64": "@opencode/cli-windows-x64-baseline",
  "win32-arm64": "@opencode/cli-windows-arm64",
  "darwin-x64": "@opencode/cli-darwin-x64-baseline",
  "darwin-arm64": "@opencode/cli-darwin-arm64",
  "linux-x64": "@opencode/cli-linux-x64-baseline",
  "linux-arm64": "@opencode/cli-linux-arm64",
};
const platformPackage = packages[`${process.platform}-${process.arch}`];
if (!platformPackage)
  throw new Error("This desktop platform has no pinned agent runtime.");
const cliPackagePath = require.resolve("@opencode/cli/package.json");
const cliRequire = createRequire(cliPackagePath);
const packagePath = cliRequire.resolve(`${platformPackage}/package.json`);
const packageInfo = JSON.parse(await readFile(packagePath, "utf8"));
if (packageInfo.version !== version)
  throw new Error("Agent runtime dependency version mismatch.");
const executable = path.join(
  path.dirname(packagePath),
  "bin",
  `opencode${extension}`,
);
const output = path.join(root, "src-tauri", "resources", "agent");
await mkdir(output, { recursive: true });
const bytes = await readFile(executable);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const destination = path.join(output, `opencode${extension}`);
let currentHash;
try {
  currentHash = createHash("sha256")
    .update(await readFile(destination))
    .digest("hex");
} catch {
  /* First build. */
}
if (currentHash !== sha256) await copyFile(executable, destination);
if (process.platform !== "win32") await chmod(destination, 0o755);
const license = await readFile(
  path.join(root, "third-party", "opencode", "LICENSE"),
  "utf8",
);
await writeFile(path.join(output, "LICENSE"), license);
await writeFile(
  path.join(output, "runtime-manifest.json"),
  JSON.stringify(
    {
      package: platformPackage,
      version,
      source: "https://github.com/anomalyco/opencode",
      sourceRevision,
      license: "MIT",
      executable: `opencode${extension}`,
      bytes: (await stat(destination)).size,
      sha256,
      distribution:
        "Pinned npm platform package; package integrity is recorded in pnpm-lock.yaml.",
    },
    null,
    2,
  ) + "\n",
);

// These are exact default-enabled ZCode content skills, not ZCode's desktop
// MCP Apps or engine-specific dynamic-workflows. Each vendored byte is pinned.
const vendored = path.join(root, "third-party", "zcode");
const skillsManifest = JSON.parse(
  await readFile(path.join(vendored, "manifest.json"), "utf8"),
);
if (
  skillsManifest.version !== 1 ||
  skillsManifest.sourceRevision !== "aac4755666d09fdcd70272fcf063c077a639015f"
)
  throw new Error("Default skills source revision mismatch.");
const extensionsOutput = path.join(output, "extensions");
await mkdir(extensionsOutput, { recursive: true });
for (const skill of skillsManifest.skills) {
  if (!/^[a-zA-Z0-9_-]+$/.test(skill.directory))
    throw new Error("Invalid default skill directory.");
  const seen = new Set();
  for (const file of skill.files) {
    if (
      !file.path.startsWith(`skills/${skill.directory}/`) ||
      file.path.includes("\\") ||
      file.path.includes(":") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      seen.has(file.path)
    )
      throw new Error("Unsafe default skill file path.");
    seen.add(file.path);
    const sourceFile = path.join(vendored, file.path);
    if (!(await lstat(sourceFile)).isFile())
      throw new Error("Default skill source must be a regular file.");
    const fileBytes = await readFile(sourceFile);
    if (createHash("sha256").update(fileBytes).digest("hex") !== file.sha256)
      throw new Error("Default skill source checksum mismatch.");
    const targetFile = path.join(extensionsOutput, file.path);
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(targetFile, fileBytes);
  }
}
for (const name of [
  "manifest.json",
  "LICENSE",
  "NOTICE.md",
  "UPSTREAM_NOTICE.md",
])
  await copyFile(path.join(vendored, name), path.join(extensionsOutput, name));
process.stdout.write(
  `Prepared OpenCode ${version} engine and ${skillsManifest.skills.length} pinned default skills for LoliCode (${process.platform}/${process.arch}).\n`,
);
