import { copyFile, mkdir, readFile, lstat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function prepareAgentAssets(
  root,
  output = path.join(root, "src-tauri/resources/agent/extensions"),
) {
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
  const extensionsOutput = output;
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
    await copyFile(
      path.join(vendored, name),
      path.join(extensionsOutput, name),
    );
  return {
    skills: skillsManifest.skills.length,
    sourceRevision: skillsManifest.sourceRevision,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await prepareAgentAssets(root);
  process.stdout.write(
    `Prepared ${result.skills} pinned content skills for the in-process LoliCode agent.\n`,
  );
}
