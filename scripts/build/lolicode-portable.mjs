#!/usr/bin/env node
// Assemble and verify the actual portable payload of one frozen Windows build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Byte hashes verified against the official webrtc-rs/webrtc v0.17.2 tag:
// https://raw.githubusercontent.com/webrtc-rs/webrtc/v0.17.2/LICENSE-MIT
// https://raw.githubusercontent.com/webrtc-rs/webrtc/v0.17.2/LICENSE-APACHE
const companionLicenses = [
  [
    "webrtc-LICENSE-MIT",
    "56cc6c08157f4faf70d351b3a7ceac143399d5359a78c180e06dcd0390784f4d",
  ],
  [
    "webrtc-LICENSE-APACHE",
    "a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2",
  ],
];

const root = path.resolve(process.argv[2] ?? "");
const snapshot = JSON.parse(
  readFileSync(path.join(root, "source-snapshot.json")),
);
const work = snapshot.work;
const stage = path.join(root, "portable-stage");
const artifacts = path.join(root, "artifacts");
const extracted = path.join(root, "portable-extracted");
const zip = path.join(artifacts, "LoliCode-Portable.zip");
if ([stage, artifacts, extracted].some(existsSync))
  throw new Error("Portable output paths must be new.");
const buildVersion = snapshot.buildVersion,
  productVersion = snapshot.productVersion;
mkdirSync(stage);
mkdirSync(artifacts);
mkdirSync(extracted);
copyFileSync(
  path.join(work, "src-tauri/target/release/LoliCode.exe"),
  path.join(stage, "LoliCode.exe"),
);
cpSync(
  path.join(work, "src-tauri/resources/agent/extensions"),
  path.join(stage, "agent/extensions"),
  { recursive: true },
);
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
  copyFileSync(path.join(work, name), path.join(stage, name));
cpSync(
  path.join(work, "src-tauri/resources/companion-licenses"),
  path.join(stage, "licenses/companion"),
  { recursive: true },
);
writeFileSync(path.join(stage, "portable.ini"), "# LoliCode portable mode\n");
const notes = JSON.parse(
  readFileSync(path.join(work, `src/whats-new/${buildVersion}.json`)),
);
const markdown = [
  `# LoliCode ${productVersion}`,
  `Native updater version: ${buildVersion}`,
  "",
  ...notes.items.map((item) => `- ${item.zh}`),
  "",
].join("\n");
writeFileSync(path.join(stage, "release-notes.md"), markdown);
writeFileSync(path.join(artifacts, "release-notes.md"), markdown);
writeFileSync(
  path.join(stage, "使用说明.txt"),
  [
    `LoliCode ${productVersion} · Windows x64`,
    "解压整个 ZIP 到可写目录后运行 LoliCode.exe，保留 portable.ini 与 agent 文件夹。",
    "酒馆本地陪伴：在应用中心添加酒馆，选择本地陪伴模型并一键配置。首次按需下载约6.36GB，不含在此ZIP中。",
    "本地模型要求 Windows x64 + NVIDIA 约6GB及以上显存，建议16GB系统内存、16GB可用磁盘。",
    "使用云端模型时，在模型与渠道中添加并启用模型。更新便携版前关闭程序并备份数据。",
    "官网：https://lolicode.com/",
    "",
  ].join("\n"),
);
const nsis = path.join(
  work,
  "src-tauri/target/release/bundle/nsis",
  `LoliCode_${buildVersion}_x64-setup.exe`,
);
for (const suffix of ["", ".sig"])
  copyFileSync(
    nsis + suffix,
    path.join(
      artifacts,
      `LoliCode-${productVersion}-Windows-x64-Setup.exe${suffix}`,
    ),
  );
const seven = process.env.SEVEN_ZIP ?? "C:/Program Files/7-Zip/7z.exe";
function run(exe, args, options = {}) {
  const result = spawnSync(exe, args, {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(
    result.status,
    0,
    `${exe} failed: ${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
run(seven, ["a", "-tzip", "-mx=7", zip, "."], { cwd: stage });
run(seven, ["t", zip]);
run(seven, ["x", zip, `-o${extracted}`, "-y"]);
function files(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      assert(!entry.isSymbolicLink());
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory()
        ? files(path.join(dir, entry.name), name)
        : [
            {
              name,
              sha256: createHash("sha256")
                .update(readFileSync(path.join(dir, entry.name)))
                .digest("hex"),
            },
          ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
const packaged = files(extracted);
assert.deepEqual(packaged, files(stage));
for (const [name, expected] of companionLicenses) {
  const source = path.join(
    work,
    "src-tauri/resources/companion-licenses",
    name,
  );
  assert.equal(
    createHash("sha256").update(readFileSync(source)).digest("hex"),
    expected,
    `Companion license source must match official WebRTC v0.17.2: ${name}`,
  );
  assert.equal(
    packaged.find((file) => file.name === `licenses/companion/${name}`)?.sha256,
    expected,
    `Extracted portable ZIP must contain the official companion license: ${name}`,
  );
}
assert(
  !packaged.some(
    (file) =>
      /\.(gguf|key|env)$/i.test(file.name) ||
      /(?:node|llama-server)\.exe$/i.test(file.name),
  ),
);
const stdout = run(
  path.join(extracted, "LoliCode.exe"),
  ["--check-agent-runtime"],
  { cwd: extracted, timeout: 120000 },
);
const report = JSON.parse(
  stdout.split(/\r?\n/).find((line) => line.startsWith("{")),
);
assert.equal(report.version, buildVersion);
assert.equal(report.passed, true);
assert.equal(report.paidCalls, 0);
assert.equal(report.userConfigurationRead, false);
assert.equal(report.temporaryProjectsOnly, true);
assert.equal(report.nativeEngineProcessSpawned, false);
writeFileSync(
  path.join(artifacts, "portable-runtime-check.json"),
  JSON.stringify(report, null, 2) + "\n",
);
writeFileSync(
  path.join(artifacts, "portable-zip-acceptance.json"),
  JSON.stringify(
    {
      passed: true,
      productVersion,
      buildVersion,
      zipFileCount: packaged.length,
      extractedHashesMatch: true,
      defaultSkillsVerified: report.defaultSkillsVerified,
      offlineRuntimePassed: true,
      modelWeightsBundled: false,
      companionLicenseFiles: companionLicenses.length,
      companionLicenseHashesVerified: true,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    passed: true,
    productVersion,
    buildVersion,
    zip,
    artifacts,
    fileCount: packaged.length,
  }),
);
