import { copyFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = fileURLToPath(new URL("../", import.meta.url));
const shared = path.resolve(directory, "../lolicode-harness-runtime");
await mkdir(path.join(directory, "runtime"), { recursive: true });
for (const file of await readdir(shared)) {
  if (/^(host-.*\.mjs|.*\.cordis\.patch\.yml)$/.test(file)) {
    await copyFile(path.join(shared, file), path.join(directory, "runtime", file));
  }
}
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await copyFile(path.resolve(directory, "../..", file), path.join(directory, file));
}
console.log("Prepared shared LoliCode Harness overlays and notices.");
