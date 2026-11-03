import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pngModule from "../../../node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs/lib/png.js";
import { keyFrame, run } from "../D-pinkdog-video-v1/import-green-video.mjs";
import { refineMatte, qaSheet } from "../D-pinkdog-video-v4/refine-matte.mjs";

const { PNG } = pngModule;
const base = path.dirname(fileURLToPath(import.meta.url));
const [kind, ffmpeg, sourceArgument, crop] = process.argv.slice(2);
if (!["sit", "lie"].includes(kind) || !ffmpeg || !sourceArgument)
  throw new Error("Usage: node process-rest-video.mjs sit|lie FFMPEG SOURCE [crop=w:h:x:y]");
const source = path.resolve(sourceArgument);
const out = path.join(base, "processed", `${kind}-v1`);
if (fs.existsSync(out)) throw new Error("Output exists; preserve it and version the next run.");
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sourceHash = sha(source);
const probe = JSON.parse(run(path.join(path.dirname(ffmpeg), "ffprobe.exe"), [
  "-v", "error", "-show_streams", "-show_format", "-of", "json", source,
]));
const stream = probe.streams.find((s) => s.codec_type === "video");
const width = kind === "sit" ? 640 : 768;
const height = kind === "sit" ? 640 : 512;
const sourceDir = path.join(out, "source-frames");
const alphaDir = path.join(out, "alpha-frames");
fs.mkdirSync(sourceDir, { recursive: true });
fs.mkdirSync(alphaDir);
run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", source, "-vf",
  [crop, "fps=24"].filter(Boolean).join(","), "-fps_mode", "passthrough", path.join(sourceDir, "%06d.png")]);
const names = fs.readdirSync(sourceDir).filter((n) => /^\d{6}\.png$/.test(n)).sort();
if (names.length < 115 || names.length > 125) throw new Error("Unexpected duration; verify real video.");
const samples = [], perFrame = [];
for (let i = 0; i < names.length; i++) {
  const name = names[i];
  const input = path.join(sourceDir, name);
  const raw = PNG.sync.read(fs.readFileSync(input));
  const keyed = keyFrame(raw, { clearStrongConnectedGreen: true });
  const refined = refineMatte(keyed.png, raw, 0.35);
  if (refined.metrics.coreChanged || refined.metrics.coreTealChanged)
    throw new Error("Protected interior was altered.");
  fs.writeFileSync(path.join(alphaDir, name), PNG.sync.write(refined.png), { flag: "wx" });
  perFrame.push({ name, sourceSha256: sha(input), key: keyed.metrics, refinement: refined.metrics });
  if ([0, Math.floor(names.length / 2), names.length - 1].includes(i))
    samples.push({ before: keyed.png, after: refined.png,
      crop: { left: 0, top: 0, width: raw.width, height: raw.height } });
}
qaSheet(samples, path.join(out, "matte-qa-light-dark.png"));
const scale = `format=gbrap,premultiply=inplace=1:planes=7,scale=${width}:${height}:flags=lanczos,unpremultiply=inplace=1:planes=7`;
const video = path.join(out, `companion-${kind}-video-v5.webm`);
run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-framerate", "24", "-i", path.join(alphaDir, "%06d.png"),
  "-vf", `${scale},format=yuva420p`, "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
  "-crf", "20", "-b:v", "0", "-auto-alt-ref", "0", "-deadline", "good", "-cpu-used", "4", video]);
const poster = path.join(out, `companion-${kind}-poster-v5.webp`);
run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path.join(alphaDir, names[0]), "-vf", `${scale},format=rgba`,
  "-frames:v", "1", "-c:v", "libwebp", "-lossless", "1", poster]);
const decoded = [];
for (const n of [0, Math.floor(names.length / 2), names.length - 1]) {
  const file = path.join(out, `decoded-${n}.png`);
  run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", video,
    "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", file]);
  const png = PNG.sync.read(fs.readFileSync(file));
  let transparent = 0;
  for (let p = 3; p < png.data.length; p += 4) if (png.data[p] < 8) transparent++;
  const fraction = transparent / (png.width * png.height);
  if (png.width !== width || png.height !== height || fraction < 0.1 || fraction > 0.9)
    throw new Error("Final alpha decode failed.");
  decoded.push({ frame: n, transparentFraction: fraction });
}
if (sha(source) !== sourceHash) throw new Error("Source changed during processing.");
const assets = [video, poster].map((file) => ({ file: path.basename(file), bytes: fs.statSync(file).size, sha256: sha(file) }));
const report = { kind, source: path.relative(base, source).replaceAll("\\", "/"), sourceSha256: sourceHash,
  native: { width: stream.width, height: stream.height, fps: stream.r_frame_rate, duration: probe.format.duration },
  crop: crop ?? null, width, height, fps: 24, frames: names.length, durationSeconds: names.length / 24,
  method: "v4 connected-green key + protected two-pixel matte refinement; premultiplied Lanczos; VP9 alpha; no region-erasure masks",
  assets, decoded, perFrame };
fs.writeFileSync(path.join(out, "processing-report.json"), JSON.stringify(report, null, 2));
for (const file of [video, poster]) fs.copyFileSync(file, path.resolve(base, "../../../src/assets/atelier", path.basename(file)), fs.constants.COPYFILE_EXCL);
console.log(JSON.stringify({ ...report, perFrame: undefined }, null, 2));
