#!/usr/bin/env node
// Prepare a self-contained, verifiable Android alpha download page; never upload.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export async function prepareDownload({
  apk,
  output,
  version,
  certificateSha256,
  desktopPreview,
}) {
  if (!/^0\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})-alpha\.(?:0|[1-9]\d{0,8})$/.test(version ?? ""))
    throw new Error("Expected a distinct Android alpha version");
  if (!/^[a-fA-F0-9]{64}$/.test(certificateSha256 ?? ""))
    throw new Error("A verified APK signing certificate SHA-256 is required");
  const source = path.resolve(apk);
  const destination = path.resolve(output);
  if (!source.endsWith(".apk") || !statSync(source).isFile())
    throw new Error("Expected an actual APK file");
  if (statSync(source).size > 100 * 1024 * 1024)
    throw new Error("Invalid APK container or size");
  const bytes = readFileSync(source);
  if (
    bytes.length < 1024 ||
    bytes.length > 100 * 1024 * 1024 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  )
    throw new Error("Invalid APK container or size");
  if (existsSync(destination))
    throw new Error(
      "Preserve existing delivery directories; choose a new output",
    );
  const filename = `LoliCode-Android-${version}.apk`;
  const url = `https://lolicode.com/downloads/android/${version}/${filename}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schemaVersion: 1,
    applicationId: "art.treasuregrove.lolicode.mobile",
    version,
    channel: "alpha",
    filename,
    bytes: bytes.length,
    sha256,
    certificateSha256: certificateSha256.toLowerCase(),
    url,
    systemPush: "deferred",
    lockscreenTest: "pending",
  };
  let desktopBytes;
  if (desktopPreview !== undefined) {
    const desktopSource = path.resolve(desktopPreview);
    const desktopFilename = `LoliCode-Mobile-Companion-${version}-Windows-x64-Desktop-Preview.zip`;
    const desktopStat = statSync(desktopSource);
    if (path.basename(desktopSource) !== desktopFilename || !desktopStat.isFile())
      throw new Error("Expected the same-version Windows Desktop Preview ZIP filename");
    if (desktopStat.size < 1024 || desktopStat.size > 250 * 1024 * 1024)
      throw new Error("Invalid desktop preview ZIP container or size");
    desktopBytes = readFileSync(desktopSource);
    if (!desktopBytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
      throw new Error("Invalid desktop preview ZIP container or size");
    manifest.desktopPreview = {
      filename: desktopFilename,
      bytes: desktopBytes.length,
      sha256: createHash("sha256").update(desktopBytes).digest("hex"),
      url: `https://lolicode.com/downloads/android/${version}/${desktopFilename}`,
    };
  }
  const qrOptions = { errorCorrectionLevel: "M", margin: 3, width: 280 };
  const svg = await QRCode.toString(url, {
    ...qrOptions,
    type: "svg",
  });
  const png = await QRCode.toBuffer(url, { ...qrOptions, type: "png" });
  const desktopSection = manifest.desktopPreview
    ? `<section><h2>Windows 电脑预览版</h2><p>手机配对需要这个支持连接手机的电脑测试版本。</p><a class="download" href="${esc(manifest.desktopPreview.url)}" download="${esc(manifest.desktopPreview.filename)}">下载 Windows 电脑预览版 ZIP</a><div class="sub">${(manifest.desktopPreview.bytes / 1024 / 1024).toFixed(1)} MB · Windows x64 · ${esc(version)}</div><p><strong>先退出已有 LoliCode（包括托盘），将 ZIP 完整解压到新的独立文件夹，再运行其中的 LoliCode 程序。请勿解压覆盖已有安装目录。本预览沿用现有配置。</strong></p><p>电脑预览包 SHA-256<br><code>${manifest.desktopPreview.sha256}</code></p></section>`
    : "";
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>LoliCode Android 测试版下载</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#282026;background:#faf6f7;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:900px;margin:auto;padding:48px 24px 64px}header{display:flex;align-items:center;gap:16px}header img{width:64px;height:64px}h1{font-size:30px;letter-spacing:-.04em;margin:0 0 6px}.sub,p{line-height:1.7}.sub{color:#6e5964}.layout{display:grid;grid-template-columns:1fr 240px;gap:40px;margin-top:36px}.badge{display:inline-block;color:#7c2346;border:1px solid #dfbccb;padding:4px 10px;border-radius:5px;font-size:13px}.download{display:inline-block;background:#7c2346;color:white;text-decoration:none;border-radius:8px;padding:13px 22px;font-weight:650;margin:14px 0}.notice{border-left:3px solid #b95c80;padding:4px 0 4px 16px;margin:20px 0}.qr{background:#fff;padding:12px;border-radius:10px;align-self:start;color:#30232b;text-align:center}.qr img{max-width:100%;height:auto}.qr p{font-size:13px;margin:2px 0}section{border-top:1px solid #decfd6;margin-top:32px;padding-top:20px}h2{font-size:18px}li{line-height:1.8;margin:6px 0}code{overflow-wrap:anywhere;font-size:12px}a{color:#7c2346}footer{font-size:13px;color:#6e5964;margin-top:32px}@media(max-width:620px){main{padding-top:28px}.layout{grid-template-columns:1fr;gap:16px}.qr{width:220px}h1{font-size:25px}}@media(prefers-color-scheme:dark){:root{background:#191419;color:#f0e5eb}.sub,footer{color:#bfacb7}section{border-color:#49333e}.badge{color:#f0b6ce;border-color:#765063}a{color:#f0b6ce}.download{color:#fff;background:#98395e}}
</style></head><body><main>
<header><img src="icon.png" alt="LoliCode"><div><h1>LoliCode Android</h1><div class="sub">手机发任务，电脑在后台执行。</div></div></header>
<div class="layout"><div><span class="badge">${esc(version)} · 测试版</span><p>原生手机界面包含工作台、任务、设备三个页面，支持扫码连接电脑、查看进度、发送任务和处理审批。电脑端需要支持手机配对的专用开发版本，当前正式旧版没有这个入口。</p><a class="download" href="${esc(url)}" download="${esc(filename)}">下载 Android APK</a><div class="sub">${(bytes.length / 1024 / 1024).toFixed(1)} MB · Android 8.0 及以上</div><div class="notice"><strong>系统锁屏推送暂未启用</strong><p>本轮按开发范围暂缓 Firebase／系统推送。请在手机应用中查看审批与完成结果。电脑锁屏执行、手机真机兼容性仍需实测；本页不将它们标记为已验收。</p></div></div><aside class="qr"><img src="download-qr.png" width="280" height="280" alt="扫描下载 Android APK"><p>手机扫描二维码下载 APK</p></aside></div>
${desktopSection}
<section><h2>连接电脑</h2><ol><li>安装手机端，打开支持手机连接的 LoliCode 电脑开发版。</li><li>电脑头像菜单 → 连接手机 → 生成配对二维码。</li><li>手机端扫码，再在电脑端确认设备身份。</li><li>保持电脑联网并运行 LoliCode，即可从手机操作后台任务。</li></ol><p>远程任务采用后台安全模式，首轮支持文件和检索工具；终端命令及会操作桌面窗口的工具暂不开放。</p></section>
<section><h2>文件校验</h2><p>APK SHA-256<br><code>${sha256}</code></p><p>签名证书 SHA-256<br><code>${manifest.certificateSha256}</code></p><p><a href="download-manifest.json">查看下载文件信息</a></p></section><footer>来自 <a href="https://lolicode.com/">lolicode.com</a>。Android 测试通道独立于电脑正式更新，不更改电脑正式版更新源。</footer>
</main></body></html>`;
  mkdirSync(path.dirname(destination), { recursive: true });
  mkdirSync(destination);
  writeFileSync(path.join(destination, filename), bytes, { flag: "wx" });
  if (desktopBytes)
    writeFileSync(path.join(destination, manifest.desktopPreview.filename), desktopBytes, { flag: "wx" });
  copyFileSync(
    path.join(ROOT, "src/assets/brand/lolicode-icon.png"),
    path.join(destination, "icon.png"),
  );
  writeFileSync(path.join(destination, "index.html"), html, "utf8");
  writeFileSync(path.join(destination, "download-qr.svg"), svg, "utf8");
  writeFileSync(path.join(destination, "download-qr.png"), png);
  writeFileSync(
    path.join(destination, "download-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  return manifest;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .reduce(
        (pairs, item, index, all) =>
          index % 2 === 0
            ? [...pairs, [item.replace(/^--/, ""), all[index + 1]]]
            : pairs,
        [],
      ),
  );
  try {
    const result = await prepareDownload({
      apk: args.apk,
      output: args.output,
      version: args.version,
      certificateSha256: args["certificate-sha256"],
      desktopPreview: args["desktop-preview"],
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
