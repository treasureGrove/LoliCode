import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [artifact, entry, proofFile] = process.argv.slice(2);
if (!artifact || !entry || !proofFile)
  throw new Error("Expected ARTIFACT INSTALLED_CLI PROOF_JSON.");
const testFile = fileURLToPath(
  new URL("../../packages/lolicode-cli/tests/cli.test.mjs", import.meta.url),
);
const child = spawn(
  process.execPath,
  ["--test", "--test-reporter=tap", "--test-concurrency=1", testFile],
  {
    env: { ...process.env, LOLICODE_TEST_CLI: path.resolve(entry) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
);
let output = "";
child.stdout.on("data", (bytes) => {
  output += bytes;
  process.stdout.write(bytes);
});
child.stderr.on("data", (bytes) => process.stderr.write(bytes));
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const count = Number(output.match(/# tests (\d+)/)?.[1]);
if (
  code !== 0 ||
  count < 12 ||
  !/# fail 0\b/.test(output) ||
  !/# skipped 0\b/.test(output)
) {
  process.exitCode = 1;
  throw new Error("Installed CLI acceptance did not pass every required test.");
}
const proof = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  packageSha256: createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex"),
  tests: count,
  passed: count,
  failed: 0,
  skipped: 0,
  result: "passed",
  modelSource:
    "loopback protocol fixtures with the actual Harness and local tools",
};
await writeFile(proofFile, `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify(proof));
