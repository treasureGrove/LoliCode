import { prepareAgentAssets } from "./prepare-agent-assets.mjs";
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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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

await prepareAgentAssets(root);
process.stdout.write(
  `Prepared OpenCode ${version} engine and ${skillsManifest.skills.length} pinned default skills for LoliCode (${process.platform}/${process.arch}).\n`,
);
