import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = fileURLToPath(new URL("../", import.meta.url));
const shared = path.resolve(directory, "../lolicode-harness-runtime");
const sharedManifest = JSON.parse(
  await readFile(path.join(shared, "package.json"), "utf8"),
);
const manifest = JSON.parse(
  await readFile(path.join(directory, "package.json"), "utf8"),
);
for (const [dependency, version] of Object.entries(
  sharedManifest.dependencies,
)) {
  if (manifest.dependencies[dependency] !== version) {
    throw new Error(
      `CLI dependency ${dependency} must match the shared runtime pin ${version}.`,
    );
  }
}
await mkdir(path.join(directory, "runtime"), { recursive: true });
for (const file of await readdir(shared)) {
  if (/^(host-.*\.mjs|.*\.cordis\.patch\.yml)$/.test(file)) {
    await copyFile(
      path.join(shared, file),
      path.join(directory, "runtime", file),
    );
  }
}
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await copyFile(
    path.resolve(directory, "../..", file),
    path.join(directory, file),
  );
}
await copyFile(
  path.join(directory, "package-lock.json"),
  path.join(directory, "npm-shrinkwrap.json"),
);
console.log("Prepared shared LoliCode Harness overlays and notices.");
