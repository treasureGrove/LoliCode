import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../D-pinkdog-video-v1/import-green-video.mjs";

const base = path.dirname(fileURLToPath(import.meta.url));
const [ffmpeg, destination] = process.argv.slice(2);
if (!ffmpeg || !destination)
  throw new Error("Usage: node prepare-first-frames.mjs FFMPEG NEW_OUTPUT_DIRECTORY");
const output = path.resolve(destination);
if (fs.existsSync(output)) throw new Error("Output directory exists; use a new one.");
fs.mkdirSync(output, { recursive: true });
for (const [kind, width, height, canvasWidth, canvasHeight, x, y] of [
  ["sit", 664, 664, 720, 720, 28, 28],
  ["lie", 960, 640, 960, 720, 0, 40],
]) {
  run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path.join(base, `${kind}-source.png`),
    "-filter_complex", `[0:v]format=gbrap,premultiply=inplace=1:planes=7,scale=${width}:${height}:flags=lanczos,unpremultiply=inplace=1:planes=7,format=rgba[fg];color=c=0x00ff00:s=${canvasWidth}x${canvasHeight}:d=0.04,format=rgba[bg];[bg][fg]overlay=${x}:${y}:format=auto,format=rgb24[out]`,
    "-map", "[out]", "-frames:v", "1", path.join(output, `${kind}-green.png`)]);
}
console.log(`Prepared first/end frames in ${output}`);
