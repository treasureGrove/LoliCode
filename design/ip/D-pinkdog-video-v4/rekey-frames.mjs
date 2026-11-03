import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pngModule from "../../../node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs/lib/png.js";
import { keyFrame } from "../D-pinkdog-video-v1/import-green-video.mjs";
import { qaSheet } from "./refine-matte.mjs";

const { PNG } = pngModule;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clamp = (value, a, b) => Math.max(a, Math.min(b, value));
function hue(r, g, b) {
  const hi = Math.max(r, g, b),
    lo = Math.min(r, g, b),
    d = hi - lo;
  let h = d
    ? (hi === r ? (g - b) / d : hi === g ? 2 + (b - r) / d : 4 + (r - g) / d) *
      60
    : 0;
  if (h < 0) h += 360;
  return [h, hi ? d / hi : 0];
}
export function rekeyFrames({
  sourceDir,
  previousAlphaDir,
  outDir,
  frames,
  fps = 24,
}) {
  const inputPath = fs.realpathSync(sourceDir),
    outputPath = path.resolve(outDir);
  if (fs.existsSync(outputPath))
    throw new Error("Output exists; use a new versioned directory.");
  const allNames = fs
    .readdirSync(inputPath)
    .filter((name) => /^\d{6}\.png$/.test(name))
    .sort();
  const names = frames ? frames.split(",") : allNames;
  if (!names.length || names.some((name) => !allNames.includes(name)))
    throw new Error("Missing or invalid frames.");
  const sampleIndices = new Set([
    0,
    Math.floor(names.length / 2),
    names.length - 1,
  ]);
  fs.mkdirSync(path.join(outputPath, "alpha-frames"), { recursive: true });
  const perFrame = [],
    samples = [];
  names.forEach((name, index) => {
    const sourcePath = path.join(inputPath, name),
      sourceBytes = fs.readFileSync(sourcePath),
      source = PNG.sync.read(sourceBytes);
    const previousPath = previousAlphaDir
      ? path.join(previousAlphaDir, name)
      : null;
    const previousBytes = previousPath ? fs.readFileSync(previousPath) : null;
    const before = previousBytes
      ? PNG.sync.read(previousBytes)
      : keyFrame(source).png;
    const { png: after, metrics } = keyFrame(source, {
      clearStrongConnectedGreen: true,
    });
    if (before.width !== source.width || before.height !== source.height)
      throw new Error("Previous alpha dimensions differ.");
    let tealPixels = 0,
      tealAlphaChanges = 0,
      tealRgbChanges = 0,
      pinkCorePixels = 0,
      pinkCoreChanges = 0,
      opaqueForegroundChanges = 0;
    for (let p = 0; p < source.data.length; p += 4) {
      const [h, s] = hue(
        source.data[p],
        source.data[p + 1],
        source.data[p + 2],
      );
      const alphaChanged = before.data[p + 3] !== after.data[p + 3];
      const rgbChanged = [0, 1, 2].some(
        (c) => before.data[p + c] !== after.data[p + c],
      );
      if (h >= 160 && h <= 210 && s >= 0.25) {
        tealPixels++;
        if (alphaChanged) tealAlphaChanges++;
        if (rgbChanged) tealRgbChanges++;
      }
      if (
        (before.data[p + 3] >= 250 && rgbChanged) ||
        (before.data[p + 3] >= 250 && alphaChanged)
      )
        opaqueForegroundChanges++;
      if (
        before.data[p + 3] >= 250 &&
        (h >= 300 || h <= 25) &&
        s > 0.1 &&
        source.data[p] > source.data[p + 1]
      ) {
        pinkCorePixels++;
        if (alphaChanged || rgbChanged) pinkCoreChanges++;
      }
    }
    if (
      tealAlphaChanges ||
      tealRgbChanges ||
      pinkCoreChanges ||
      opaqueForegroundChanges
    )
      throw new Error(`Protected foreground changed in ${name}.`);
    const bytes = PNG.sync.write(after);
    fs.writeFileSync(path.join(outputPath, "alpha-frames", name), bytes, {
      flag: "wx",
    });
    const sourceUnchanged =
      hash(fs.readFileSync(sourcePath)) === hash(sourceBytes);
    const previousUnchanged =
      !previousPath ||
      hash(fs.readFileSync(previousPath)) === hash(previousBytes);
    if (!sourceUnchanged || !previousUnchanged)
      throw new Error("Input preservation failed.");
    perFrame.push({
      name,
      ...metrics,
      tealPixels,
      tealAlphaChanges,
      tealRgbChanges,
      pinkCorePixels,
      pinkCoreChanges,
      opaqueForegroundChanges,
      sourceUnchanged,
      previousUnchanged,
      sourceSha256: hash(sourceBytes),
      previousAlphaSha256: previousBytes ? hash(previousBytes) : null,
      outputSha256: hash(bytes),
    });
    if (sampleIndices.has(index)) {
      const side =
        Math.min(source.width, source.height) *
        (source.width === source.height ? 1 : 0.8);
      samples.push({
        name,
        before,
        after,
        crop: {
          left: (source.width - side) / 2,
          top: (source.height - side) / 2,
          width: side,
          height: side,
        },
      });
    }
  });
  qaSheet(samples, path.join(outputPath, "rekey-qa-before-after.png"));
  const details = samples.map((sample) => {
    const { width, height } = sample.before,
      y = Math.floor(height * 0.45),
      side = Math.min(360, width, height);
    let edgeX = Math.floor(width * 0.2);
    for (let x = Math.floor(width * 0.05); x < width / 2; x++)
      if (sample.before.data[(y * width + x) * 4 + 3] >= 200) {
        edgeX = x;
        break;
      }
    return {
      ...sample,
      crop: {
        left: clamp(edgeX - side / 3, 0, width - side),
        top: clamp(y - side / 2, 0, height - side),
        width: side,
        height: side,
      },
    };
  });
  qaSheet(details, path.join(outputPath, "rekey-detail-qa-before-after.png"));
  const sum = (key) => perFrame.reduce((n, frame) => n + frame[key], 0);
  const report = {
    sourceDir: inputPath,
    previousAlphaDir: previousAlphaDir ? path.resolve(previousAlphaDir) : null,
    outputDir: outputPath,
    frames: names.length,
    fps,
    method:
      "Opt-in keyFrame clearStrongConnectedGreen. Strongly green-dominant pixels in existing connected green regions are fully transparent instead of retaining alpha from a global brightness estimate. Connected regions include border flood-fill and strict saturated interior seeds for hair holes. No geometry erosion, blur, watermark masks, or redraw.",
    thresholds: {
      hueMinimum: 80,
      hueMaximum: 145,
      saturationMinimum: 0.45,
      greenMinimum: 65,
      greenOverMaximumRedBlue: 1.7,
    },
    defaultImporterUnchanged: true,
    residualGreenAlphaCleared: sum("residualGreenAlphaCleared"),
    strongConnectedGreenPixels: sum("strongConnectedGreenPixels"),
    protectedTealAlphaChanges: sum("tealAlphaChanges"),
    protectedTealRgbChanges: sum("tealRgbChanges"),
    protectedPinkCoreChanges: sum("pinkCoreChanges"),
    opaqueForegroundChanges: sum("opaqueForegroundChanges"),
    allInputsUnchanged: perFrame.every(
      (frame) => frame.sourceUnchanged && frame.previousUnchanged,
    ),
    qaLayout:
      "Left = previous matte; right = rekeyed matte; upper = light background, lower = dark. Main QA is full-frame for square inputs. Detail QA is 360px on the left hair edge; crops are inspection only.",
    qaFrames: samples.map((sample) => ({
      name: sample.name,
      crop: sample.crop,
    })),
    detailQaFrames: details.map((sample) => ({
      name: sample.name,
      crop: sample.crop,
    })),
    limitations: [
      "This is a color matte, not semantic segmentation. Strong green clothing or props would need a protected mask; this character has no such clothing.",
      "Highly green-dominant mixed edge pixels may become transparent. Review fine hairs on light and dark backgrounds before runtime use.",
      "All watermarks and non-green overlays are retained and can affect frame bounds.",
    ],
    perFrame,
  };
  fs.writeFileSync(
    path.join(outputPath, "rekey-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify(
      {
        outputPath,
        frames: report.frames,
        residualGreenAlphaCleared: report.residualGreenAlphaCleared,
        protectedTealAlphaChanges: report.protectedTealAlphaChanges,
        protectedPinkCoreChanges: report.protectedPinkCoreChanges,
        opaqueForegroundChanges: report.opaqueForegroundChanges,
        allInputsUnchanged: report.allInputsUnchanged,
      },
      null,
      2,
    ),
  );
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2),
    options = {},
    keys = {
      "--source-dir": "sourceDir",
      "--previous-alpha-dir": "previousAlphaDir",
      "--out-dir": "outDir",
      "--frames": "frames",
      "--fps": "fps",
    };
  if (args.includes("--help") || !args.length)
    console.log(
      "node rekey-frames.mjs --source-dir SOURCE_FRAMES --out-dir NEW_DIR [--previous-alpha-dir PREVIOUS_ALPHA] [--frames 000001.png,000061.png,000121.png] [--fps 24]",
    );
  else {
    for (let i = 0; i < args.length; i += 2) {
      const key = keys[args[i]];
      if (!key || !args[i + 1]) throw new Error(`Invalid option ${args[i]}`);
      options[key] = key === "fps" ? Number(args[i + 1]) : args[i + 1];
    }
    if (!options.sourceDir || !options.outDir)
      throw new Error("--source-dir and --out-dir are required.");
    rekeyFrames(options);
  }
}
