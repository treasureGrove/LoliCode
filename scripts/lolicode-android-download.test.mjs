import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareDownload } from "./lolicode-android-download.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "lolicode-android-download-"));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith("lolicode-android-download-"));
    rmSync(resolved, { recursive: true, force: true });
  });
  const apk = path.join(root, "fixture.apk");
  const bytes = Buffer.alloc(2048, 1);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(bytes);
  writeFileSync(apk, bytes);
  return { apk, bytes, output: path.join(root, "delivery"), version: "0.1.0-alpha.1", certificateSha256: "a".repeat(64) };
}

test("download page binds its QR, filename and SHA to the exact alpha APK bytes", async (t) => {
  const input = fixture(t);
  const manifest = await prepareDownload(input);
  assert.equal(manifest.sha256, createHash("sha256").update(input.bytes).digest("hex"));
  assert.deepEqual(readFileSync(path.join(input.output, manifest.filename)), input.bytes);
  assert.equal(manifest.url, "https://lolicode.com/downloads/android/0.1.0-alpha.1/LoliCode-Android-0.1.0-alpha.1.apk");
  assert.equal(manifest.systemPush, "deferred");
  assert.equal(manifest.lockscreenTest, "pending");
  const html = readFileSync(path.join(input.output, "index.html"), "utf8");
  assert.ok(html.includes(manifest.url));
  assert.ok(html.includes(manifest.sha256));
  assert.ok(html.includes("系统锁屏推送暂未启用"));
  assert.ok(readFileSync(path.join(input.output, "download-qr.svg"), "utf8").includes("<svg"));
  const png = readFileSync(path.join(input.output, "download-qr.png"));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.equal(png.readUInt32BE(16), 280);
  assert.equal(png.readUInt32BE(20), 280);
  assert.ok(html.includes('src="download-qr.png"'));
  assert.ok(!html.includes("<script"));
});

test("delivery preparation refuses to overwrite an existing directory", async (t) => {
  const input = fixture(t);
  await prepareDownload(input);
  const before = readFileSync(path.join(input.output, "download-manifest.json"));
  await assert.rejects(prepareDownload(input), /Preserve existing/);
  assert.deepEqual(readFileSync(path.join(input.output, "download-manifest.json")), before);
});

test("path-like versions and absent signing identity are rejected before writing", async (t) => {
  const input = fixture(t);
  await assert.rejects(prepareDownload({ ...input, version: "../0.1.0" }), /alpha version/);
  await assert.rejects(prepareDownload({ ...input, certificateSha256: "" }), /certificate/);
  assert.equal(existsSync(input.output), false);
});

test("a non-APK file is never published as an Android download", async (t) => {
  const input = fixture(t);
  writeFileSync(input.apk, "not an Android package");
  await assert.rejects(prepareDownload(input), /APK container/);
  assert.equal(existsSync(input.output), false);
});

test("optional desktop preview is the same-version binary ZIP with its exact bytes and checksum", async (t) => {
  const input = fixture(t);
  const desktopPreview = path.join(path.dirname(input.apk), `LoliCode-Mobile-Companion-${input.version}-Windows-x64-Desktop-Preview.zip`);
  const bytes = Buffer.alloc(4096, 2);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(bytes);
  writeFileSync(desktopPreview, bytes);
  const manifest = await prepareDownload({ ...input, desktopPreview });
  assert.deepEqual(manifest.desktopPreview, {
    filename: path.basename(desktopPreview), bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: `https://lolicode.com/downloads/android/${input.version}/${path.basename(desktopPreview)}`,
  });
  assert.deepEqual(readFileSync(path.join(input.output, manifest.desktopPreview.filename)), bytes);
  const html = readFileSync(path.join(input.output, "index.html"), "utf8");
  assert.ok(html.includes(manifest.desktopPreview.url) && html.includes(manifest.desktopPreview.sha256));
  for (const detail of ["包括托盘", "完整解压", "独立文件夹", "请勿解压覆盖已有安装目录", "本预览沿用现有配置"]) assert.ok(html.includes(detail));
  assert.equal(manifest.url.endsWith(".apk"), true);
  assert.equal(manifest.systemPush, "deferred");
});

test("desktop source archives, different versions and non-ZIP bytes are rejected without creating output", async (t) => {
  const input = fixture(t);
  for (const name of ["source.zip", "LoliCode-Mobile-Companion-0.1.0-alpha.2-Windows-x64-Desktop-Preview.zip"]) {
    const desktopPreview = path.join(path.dirname(input.apk), name);
    writeFileSync(desktopPreview, Buffer.alloc(2048));
    await assert.rejects(prepareDownload({ ...input, desktopPreview }), /same-version/);
  }
  const desktopPreview = path.join(path.dirname(input.apk), `LoliCode-Mobile-Companion-${input.version}-Windows-x64-Desktop-Preview.zip`);
  writeFileSync(desktopPreview, Buffer.alloc(2048));
  await assert.rejects(prepareDownload({ ...input, desktopPreview }), /ZIP container/);
  assert.equal(existsSync(input.output), false);
  await assert.rejects(prepareDownload({ ...input, version: "1.0.0-alpha.1" }), /alpha version/);
});

test("all seven prepared public files pass the Python publisher's allowlist and immutable checksum validation", async (t) => {
  const input = fixture(t);
  const desktopPreview = path.join(path.dirname(input.apk), `LoliCode-Mobile-Companion-${input.version}-Windows-x64-Desktop-Preview.zip`);
  const bytes = Buffer.alloc(2048);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(bytes);
  writeFileSync(desktopPreview, bytes);
  const manifest = await prepareDownload({ ...input, desktopPreview });
  const publisher = fileURLToPath(new URL("../deploy/companion/publish-download.py", import.meta.url));
  const check = spawnSync("python", ["-B", "-c", [
    "import sys, pathlib, tarfile, importlib.util, hashlib, json",
    "spec=importlib.util.spec_from_file_location('publisher', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
    "root=pathlib.Path(sys.argv[2]); archive=root.parent/'fixture-delivery.tar.gz'",
    "with tarfile.open(archive, 'w:gz') as tar:",
    " for item in sorted(root.iterdir()): tar.add(item, arcname=item.name, recursive=False)",
    "manifest, entries=module.validate_bundle(archive, hashlib.sha256(archive.read_bytes()).hexdigest())",
    "print(json.dumps({'manifest':manifest, 'files':sorted(entries)}))",
  ].join("\n"), publisher, input.output], { encoding: "utf8", timeout: 20_000 });
  assert.equal(check.status, 0, check.stderr);
  const receipt = JSON.parse(check.stdout);
  assert.deepEqual(receipt.manifest, manifest);
  assert.equal(receipt.files.length, 8);
  assert.ok(receipt.files.includes("SHA256SUMS"));
  assert.ok(receipt.files.includes(manifest.filename));
  assert.ok(receipt.files.includes(manifest.desktopPreview.filename));
});
