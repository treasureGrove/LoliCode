import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pngModule from "../../../node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs/lib/png.js";

const { PNG } = pngModule;
const here = path.dirname(fileURLToPath(import.meta.url));
const [ffmpeg, destination] = process.argv.slice(2);
if (!ffmpeg || !destination)
  throw new Error("Usage: node encode-runtime.mjs FFMPEG NEW_OUTPUT_DIRECTORY");
const outDir = path.resolve(destination);
if (fs.existsSync(outDir)) throw new Error("Output directory already exists.");
const clips = [
  [
    "idle",
    "idle-square-2k-clean-v2",
    "idle-square-2k-v1.mp4",
    "idle-mini-5s-square.txt",
  ],
  [
    "greeting",
    "greeting-seedance20-square-2k-clean-v2",
    "greeting-seedance20-square-2k-v2.mp4",
    "greeting-seedance20-v2-square.txt",
  ],
  [
    "feed",
    "feed-seedance20-square-2k-clean-v2",
    "feed-seedance20-square-2k-v2.mp4",
    "feed-seedance20-v2-square.txt",
  ],
  [
    "snack",
    "snack-cookie-seedance20-square-clean-v1",
    "snack-cookie-seedance20-square-v1.mp4",
    "snack-cookie-seedance20-square.txt",
  ],
  [
    "curious",
    "idle-curious-seedance20-square-clean-v1",
    "idle-curious-seedance20-square-v1.mp4",
    "idle-curious-seedance20-square.txt",
  ],
];
for (const [, directory] of clips)
  if (
    !fs.existsSync(path.join(here, "refined", directory, "refine-report.json"))
  )
    throw new Error(`Final refinement not complete: ${directory}`);
fs.mkdirSync(outDir, { recursive: true });
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function run(args) {
  const result = spawnSync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-n", ...args],
    {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || result.error?.message || "FFmpeg failed.");
}
const scale =
  "format=gbrap,premultiply=inplace=1:planes=7,scale=640:640:flags=lanczos,unpremultiply=inplace=1:planes=7";
const report = {
  width: 640,
  height: 640,
  fps: 24,
  codec: "VP9 alpha",
  audio: false,
  preparation:
    "Premultiplied-alpha Lanczos downsample, unpremultiply, VP9 yuva420p with auto-alt-ref disabled. No per-frame crop or scale changes.",
  clips: [],
};
for (const [name, directory, raw, prompt] of clips) {
  const framesDir = path.join(here, "refined", directory, "alpha-frames");
  const frames = fs
    .readdirSync(framesDir)
    .filter((f) => /^\d{6}\.png$/.test(f))
    .sort();
  const file = path.join(outDir, `companion-${name}-video-v4.webm`);
  run([
    "-framerate",
    "24",
    "-i",
    path.join(framesDir, "%06d.png"),
    "-vf",
    `${scale},format=yuva420p`,
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "0",
    "-crf",
    "20",
    "-auto-alt-ref",
    "0",
    "-deadline",
    "good",
    "-cpu-used",
    "4",
    file,
  ]);
  const checks = [];
  for (const index of [
    ...new Set([0, Math.floor(frames.length / 2), frames.length - 1]),
  ]) {
    const decodedFile = path.join(outDir, `${name}-decoded-${index}.png`);
    run([
      "-c:v",
      "libvpx-vp9",
      "-i",
      file,
      "-vf",
      `select=eq(n\\,${index})`,
      "-frames:v",
      "1",
      decodedFile,
    ]);
    const decoded = PNG.sync.read(fs.readFileSync(decodedFile));
    let transparent = 0;
    for (let p = 3; p < decoded.data.length; p += 4)
      if (decoded.data[p] === 0) transparent++;
    const fraction = transparent / (decoded.width * decoded.height);
    if (
      fraction < 0.1 ||
      fraction > 0.9 ||
      decoded.width !== 640 ||
      decoded.height !== 640
    )
      throw new Error(
        `Decoded alpha/canvas check failed for ${name} frame ${index}.`,
      );
    checks.push({ frame: index + 1, transparentFraction: fraction });
  }
  const source = path.join(here, "source-videos", raw);
  report.clips.push({
    name,
    file: path.basename(file),
    bytes: fs.statSync(file).size,
    sha256: hash(file),
    source: path.relative(here, source).replaceAll("\\", "/"),
    sourceSha256: hash(source),
    prompt: `prompts/${prompt}`,
    refinedFrames: `refined/${directory}/alpha-frames`,
    frames: frames.length,
    durationSeconds: frames.length / 24,
    decodedChecks: checks,
  });
}
const poster = path.join(outDir, "companion-video-poster-v4.webp");
run([
  "-i",
  path.join(here, "refined", clips[0][1], "alpha-frames", "000001.png"),
  "-vf",
  `${scale},format=rgba`,
  "-frames:v",
  "1",
  "-c:v",
  "libwebp",
  "-lossless",
  "1",
  poster,
]);
report.poster = {
  file: path.basename(poster),
  bytes: fs.statSync(poster).size,
  sha256: hash(poster),
};
if (new Set(report.clips.map((c) => c.sha256)).size !== 5)
  throw new Error("Distinct action videos required.");
fs.writeFileSync(
  path.join(outDir, "runtime-report.json"),
  JSON.stringify(report, null, 2) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    outDir,
    clips: report.clips.map(({ name, bytes, durationSeconds }) => ({
      name,
      bytes,
      durationSeconds,
    })),
  }),
);
