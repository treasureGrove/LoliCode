import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngModule from "../../../node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs/lib/png.js";
import { importGreenVideo, run } from "./import-green-video.mjs";

const { PNG } = pngModule;
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ffmpeg = args[args.indexOf("--ffmpeg") + 1];
const directory = args[args.indexOf("--out-dir") + 1];
if (
  !args.includes("--ffmpeg") ||
  !args.includes("--out-dir") ||
  !ffmpeg ||
  !directory
)
  throw new Error(
    "Usage: node validate-video-pipeline.mjs --ffmpeg ABSOLUTE_FFMPEG_PATH --out-dir NEW_TEMP_DIRECTORY",
  );
const outDir = path.resolve(directory);
if (fs.existsSync(outDir))
  throw new Error("Choose a new validation directory.");
fs.mkdirSync(outDir, { recursive: true });

// Clearly synthetic: our original still mascot, not AI-generated video or motion evidence.
const png = PNG.sync.read(
  fs.readFileSync(path.join(here, "idle-reference-green-wide.png")),
);
const letters = {
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
};
let cursor = 24;
for (const letter of "SYNTHETIC TEST") {
  if (letter !== " ")
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 5; x++)
        if (letters[letter][y][x] === "1") {
          for (let dy = 0; dy < 3; dy++)
            for (let dx = 0; dx < 3; dx++) {
              const offset =
                ((24 + y * 3 + dy) * png.width + cursor + x * 3 + dx) * 4;
              png.data.set([255, 255, 255, 255], offset);
            }
        }
  cursor += 18;
}
const stillPath = path.join(outDir, "synthetic-still-labelled.png");
fs.writeFileSync(stillPath, PNG.sync.write(png));
const videoPath = path.join(outDir, "synthetic-static-own-mascot.mp4");
run(ffmpeg, [
  "-hide_banner",
  "-loglevel",
  "error",
  "-n",
  "-loop",
  "1",
  "-i",
  stillPath,
  "-t",
  "1",
  "-vf",
  "scale=640:360:flags=lanczos",
  "-r",
  "24",
  "-an",
  "-c:v",
  "libx264",
  "-crf",
  "12",
  "-pix_fmt",
  "yuv420p",
  videoPath,
]);
const report = importGreenVideo({
  input: videoPath,
  outDir: path.join(outDir, "imported-synthetic"),
  ffmpeg,
});
const decoded = PNG.sync.read(
  fs.readFileSync(
    path.join(outDir, "imported-synthetic/decoded-alpha-first.png"),
  ),
);
let retainedOverlayPixels = 0;
for (let y = 8; y < 25; y++)
  for (let x = 8; x < 140; x++) {
    const offset = (y * decoded.width + x) * 4;
    if (
      decoded.data[offset + 3] > 240 &&
      Math.min(
        decoded.data[offset],
        decoded.data[offset + 1],
        decoded.data[offset + 2],
      ) > 200
    )
      retainedOverlayPixels++;
  }
const validation = {
  synthetic: true,
  note: "One-second static video made locally from our original mascot and a SYNTHETIC TEST label. It is not a Doubao result and does not validate animation quality.",
  sourceUnchanged: report.sourceUnchanged,
  encodedAlphaPresent:
    report.decodedAlphaVerification.transparentFraction > 0.05,
  preservedTealPixels: report.decodedForegroundVerification.tealCount,
  tealAlphaLost: report.decodedForegroundVerification.tealAlphaLost,
  keyedTealChanged: report.protectedTealChangedInMatte,
  retainedNonGreenOverlayPixels: retainedOverlayPixels,
  matteBounds: report.perFrame[0].boundsInclusive,
  decodedBounds: report.decodedAlphaVerification.boundsInclusive,
  outputFrames: report.frames,
  decodedOpaquePixelsLost:
    report.decodedForegroundVerification.lostOpaquePixels,
  contactSheet: path.join(outDir, "imported-synthetic/contact-sheet.png"),
};
fs.writeFileSync(
  path.join(outDir, "synthetic-validation.json"),
  JSON.stringify(validation, null, 2) + "\n",
);
if (
  !validation.sourceUnchanged ||
  !validation.encodedAlphaPresent ||
  !validation.preservedTealPixels ||
  validation.tealAlphaLost ||
  validation.keyedTealChanged ||
  retainedOverlayPixels < 20
)
  throw new Error("Synthetic validation failed; inspect artifacts.");
console.log(JSON.stringify(validation, null, 2));
