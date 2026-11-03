import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pngModule from "../../../node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs/lib/png.js";

const { PNG } = pngModule;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const readPng = (filename) => PNG.sync.read(fs.readFileSync(filename));
const writePng = (filename, png) =>
  fs.writeFileSync(filename, PNG.sync.write(png));
const sha256 = (filename) =>
  createHash("sha256").update(fs.readFileSync(filename)).digest("hex");

export function run(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${path.basename(executable)} failed (${result.status}):\n${result.stderr}`,
    );
  return result.stdout;
}

function hueSaturation(r, g, b) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
  }
  return [hue, max ? delta / max : 0];
}

function bounds(png, minAlpha = 16) {
  let left = png.width,
    top = png.height,
    right = -1,
    bottom = -1;
  let transparentPixels = 0,
    opaquePixels = 0,
    translucentPixels = 0;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const alpha = png.data[(y * png.width + x) * 4 + 3];
      if (alpha === 0) transparentPixels++;
      else if (alpha === 255) opaquePixels++;
      else translucentPixels++;
      if (alpha > minAlpha) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  return {
    boundsInclusive: right < 0 ? null : { left, top, right, bottom },
    transparentPixels,
    opaquePixels,
    translucentPixels,
    transparentFraction: transparentPixels / (png.width * png.height),
  };
}

// Green regions seeded by the border or an intentionally narrow pure-green hole test.
// No watermark masks or region erasure. Cyan/teal hues >= 160 degrees are never keyed.
export function keyFrame(source, { clearStrongConnectedGreen = false } = {}) {
  const count = source.width * source.height;
  const candidates = new Uint8Array(count);
  const strict = new Uint8Array(count);
  const connected = new Uint8Array(count);
  const queue = new Int32Array(count);
  const borderGreens = [];
  let protectedTealPixels = 0;
  for (let y = 0; y < source.height; y++)
    for (let x = 0; x < source.width; x++) {
      const i = y * source.width + x,
        p = i * 4;
      const r = source.data[p],
        g = source.data[p + 1],
        b = source.data[p + 2];
      const [h, s] = hueSaturation(r, g, b);
      const excess = g - Math.max(r, b);
      candidates[i] =
        h >= 75 && h <= 150 && s >= 0.18 && g >= 60 && excess >= 8 ? 1 : 0;
      strict[i] =
        h >= 110 && h <= 130 && s >= 0.8 && g >= 110 && excess >= 80 ? 1 : 0;
      if (h >= 160 && h <= 210 && s >= 0.25) protectedTealPixels++;
      if (
        strict[i] &&
        (x === 0 ||
          y === 0 ||
          x === source.width - 1 ||
          y === source.height - 1)
      )
        borderGreens.push([r, g, b]);
    }
  if (borderGreens.length < Math.min(source.width, source.height) / 2)
    throw new Error(
      "No reliable green screen on the frame border. Refusing to guess a matte.",
    );
  const median = (channel) =>
    borderGreens.map((rgb) => rgb[channel]).sort((a, b) => a - b)[
      Math.floor(borderGreens.length / 2)
    ];
  const background = [median(0), median(1), median(2)];
  let head = 0,
    tail = 0;
  const enqueue = (i) => {
    if (candidates[i] && !connected[i]) {
      connected[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < source.width; x++) {
    enqueue(x);
    enqueue((source.height - 1) * source.width + x);
  }
  for (let y = 0; y < source.height; y++) {
    enqueue(y * source.width);
    enqueue(y * source.width + source.width - 1);
  }
  // Hair loops can enclose background. Only unmistakable saturated green seeds
  // may start these interior regions; expansion still requires green dominance.
  for (let i = 0; i < count; i++) if (strict[i]) enqueue(i);
  while (head < tail) {
    const i = queue[head++],
      x = i % source.width,
      y = Math.floor(i / source.width);
    if (x) enqueue(i - 1);
    if (x + 1 < source.width) enqueue(i + 1);
    if (y) enqueue(i - source.width);
    if (y + 1 < source.height) enqueue(i + source.width);
  }
  const output = new PNG({ width: source.width, height: source.height });
  source.data.copy(output.data);
  let keyedPixels = 0,
    pureGreenSeedPixels = 0,
    protectedTealChanged = 0,
    strongConnectedGreenPixels = 0,
    residualGreenAlphaCleared = 0;
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const [h, s] = hueSaturation(
      source.data[p],
      source.data[p + 1],
      source.data[p + 2],
    );
    if (connected[i] || strict[i]) {
      if (strict[i]) pureGreenSeedPixels++;
      const excess =
        source.data[p + 1] - Math.max(source.data[p], source.data[p + 2]);
      const nearBackground = background.every(
        (value, c) => Math.abs(source.data[p + c] - value) <= 12,
      );
      const estimatedAlpha = nearBackground
        ? 0
        : clamp(1 - excess / background[1], 0, 1);
      // Opt-in cleanup for confirmed green regions. A global background
      // brightness estimate otherwise leaves a gray/cyan alpha haze when
      // compression slightly shifts the source green near fine hair.
      // Hue >=160 (eyes/gems) is outside this strict green test.
      const strongConnectedGreen =
        clearStrongConnectedGreen &&
        connected[i] &&
        h >= 80 &&
        h <= 145 &&
        s >= 0.45 &&
        source.data[p + 1] >= 65 &&
        source.data[p + 1] > Math.max(source.data[p], source.data[p + 2]) * 1.7;
      if (strongConnectedGreen) {
        strongConnectedGreenPixels++;
        if (Math.round(source.data[p + 3] * estimatedAlpha) > 0)
          residualGreenAlphaCleared++;
      }
      const alpha = strongConnectedGreen ? 0 : estimatedAlpha;
      output.data[p + 3] = Math.round(source.data[p + 3] * alpha);
      for (let c = 0; c < 3; c++)
        output.data[p + c] =
          alpha < 1 / 255
            ? 0
            : Math.round(
                clamp(
                  (source.data[p + c] - (1 - alpha) * background[c]) / alpha,
                  0,
                  255,
                ),
              );
      keyedPixels++;
    }
    if (
      h >= 160 &&
      h <= 210 &&
      s >= 0.25 &&
      output.data[p + 3] !== source.data[p + 3]
    )
      protectedTealChanged++;
  }
  return {
    png: output,
    metrics: {
      background,
      keyedPixels,
      pureGreenSeedPixels,
      protectedTealPixels,
      protectedTealChanged,
      clearStrongConnectedGreen,
      strongConnectedGreenPixels,
      residualGreenAlphaCleared,
      ...bounds(output),
    },
  };
}

function contactSheet(samples, filename, fps) {
  const thumbWidth = 320,
    thumbHeight = Math.round(
      (320 * samples[0].png.height) / samples[0].png.width,
    );
  const columns = 3,
    gap = 12,
    rows = Math.ceil(samples.length / columns);
  const cellHeight = thumbHeight * 2 + 6;
  const sheet = new PNG({
    width: columns * thumbWidth + (columns + 1) * gap,
    height: rows * cellHeight + (rows + 1) * gap,
  });
  for (let i = 0; i < sheet.data.length; i += 4)
    sheet.data.set([60, 64, 72, 255], i);
  const indices = [];
  samples.forEach(({ png, frame }, n) => {
    const left = gap + (n % columns) * (thumbWidth + gap),
      top = gap + Math.floor(n / columns) * (cellHeight + gap);
    indices.push({ cell: n + 1, frame, seconds: (frame - 1) / fps });
    for (let panel = 0; panel < 2; panel++)
      for (let y = 0; y < thumbHeight; y++)
        for (let x = 0; x < thumbWidth; x++) {
          const sourceOffset =
            (Math.floor((y * png.height) / thumbHeight) * png.width +
              Math.floor((x * png.width) / thumbWidth)) *
            4;
          const targetOffset =
            ((top + panel * (thumbHeight + 6) + y) * sheet.width + left + x) *
            4;
          const alpha = png.data[sourceOffset + 3] / 255;
          const checker = Math.floor(x / 12) % 2 === Math.floor(y / 12) % 2;
          const base = panel ? (checker ? 31 : 45) : checker ? 224 : 245;
          for (let c = 0; c < 3; c++)
            sheet.data[targetOffset + c] = Math.round(
              png.data[sourceOffset + c] * alpha + base * (1 - alpha),
            );
        }
  });
  writePng(filename, sheet);
  return indices;
}

export function importGreenVideo(options) {
  const {
    input,
    outDir,
    ffmpeg,
    ffprobe = path.join(
      path.dirname(ffmpeg),
      process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
    ),
    fps = 24,
  } = options;
  const sourcePath = fs.realpathSync(input);
  const outputPath = path.resolve(outDir);
  if (fs.existsSync(outputPath))
    throw new Error(
      "Output directory already exists. Choose a new directory; existing files are never overwritten.",
    );
  const probe = JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,r_frame_rate,duration:format=duration",
      "-of",
      "json",
      sourcePath,
    ]),
  );
  const stream = probe.streams?.[0];
  const duration = Number(stream?.duration || probe.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0 || duration > 30)
    throw new Error(
      "Expected a video with known duration between 0 and 30 seconds.",
    );
  if (
    stream.width < 16 ||
    stream.height < 16 ||
    stream.width > 2160 ||
    stream.height > 2160 ||
    stream.width % 2 ||
    stream.height % 2
  )
    throw new Error(
      "Expected even video dimensions, each between 16 and 2160 pixels.",
    );
  if (![12, 24, 25, 30].includes(fps))
    throw new Error("Choose fps 12, 24, 25, or 30.");
  const originalHash = sha256(sourcePath);
  fs.mkdirSync(outputPath, { recursive: true });
  const sourceFrames = path.join(outputPath, "source-frames"),
    alphaFrames = path.join(outputPath, "alpha-frames");
  fs.mkdirSync(sourceFrames);
  fs.mkdirSync(alphaFrames);
  run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-n",
    "-i",
    sourcePath,
    "-an",
    "-vf",
    `fps=${fps},format=rgba`,
    "-frames:v",
    "901",
    path.join(sourceFrames, "%06d.png"),
  ]);
  const frames = fs
    .readdirSync(sourceFrames)
    .filter((name) => /^\d{6}\.png$/.test(name))
    .sort();
  if (!frames.length || frames.length > 900)
    throw new Error(
      "Unexpected frame count; stopped without replacing the source.",
    );
  const indices = new Set(
    Array.from({ length: Math.min(9, frames.length) }, (_, i) =>
      Math.round(
        (i * (frames.length - 1)) / Math.max(1, Math.min(9, frames.length) - 1),
      ),
    ),
  );
  const perFrame = [],
    samples = [];
  frames.forEach((name, index) => {
    const result = keyFrame(readPng(path.join(sourceFrames, name)));
    writePng(path.join(alphaFrames, name), result.png);
    perFrame.push({ frame: index + 1, ...result.metrics });
    if (indices.has(index)) samples.push({ frame: index + 1, png: result.png });
  });
  const webmPath = path.join(outputPath, "transparent.webm");
  run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-n",
    "-framerate",
    String(fps),
    "-i",
    path.join(alphaFrames, "%06d.png"),
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-crf",
    "22",
    "-b:v",
    "0",
    "-auto-alt-ref",
    "0",
    "-deadline",
    "good",
    "-cpu-used",
    "4",
    webmPath,
  ]);
  const decodedPath = path.join(outputPath, "decoded-alpha-first.png");
  // Explicit libvpx decoder is essential: the native VP9 decoder can ignore alpha.
  run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-n",
    "-c:v",
    "libvpx-vp9",
    "-i",
    webmPath,
    "-frames:v",
    "1",
    decodedPath,
  ]);
  const decoded = readPng(decodedPath),
    decodedMetrics = bounds(decoded);
  if (decodedMetrics.transparentFraction < 0.05)
    throw new Error("Encoded WebM failed the real alpha decode check.");
  const encodedFirst = readPng(path.join(alphaFrames, frames[0]));
  const sourceFirst = readPng(path.join(sourceFrames, frames[0]));
  let tealCount = 0,
    tealAlphaLost = 0,
    tealRgbAbsoluteError = 0,
    foregroundPixelCount = 0,
    lostOpaquePixels = 0;
  for (let i = 0; i < decoded.width * decoded.height; i++) {
    const p = i * 4;
    const [h, s] = hueSaturation(
      sourceFirst.data[p],
      sourceFirst.data[p + 1],
      sourceFirst.data[p + 2],
    );
    if (encodedFirst.data[p + 3] === 255) {
      foregroundPixelCount++;
      if (decoded.data[p + 3] < 240) lostOpaquePixels++;
    }
    if (h >= 160 && h <= 210 && s >= 0.25 && encodedFirst.data[p + 3] === 255) {
      tealCount++;
      if (decoded.data[p + 3] < 240) tealAlphaLost++;
      for (let c = 0; c < 3; c++)
        tealRgbAbsoluteError += Math.abs(
          encodedFirst.data[p + c] - decoded.data[p + c],
        );
    }
  }
  const report = {
    sourcePath,
    sourceSha256: originalHash,
    sourceUnchanged: sha256(sourcePath) === originalHash,
    sourceMetadata: probe,
    output: webmPath,
    outputSha256: sha256(webmPath),
    fps,
    frames: frames.length,
    outputDurationSeconds: frames.length / fps,
    method:
      "Green-dominant regions (hue 75–150) connected to the border or to a highly saturated pure-green seed (110–130) inside hair loops. Cyan/teal 160–210 is protected. No watermark removal or rectangular erase masks.",
    mattePolicy:
      "Conservative color-difference edge alpha and green decontamination. Not semantic segmentation; inspect hair and any green clothing manually.",
    contactSheet: contactSheet(
      samples,
      path.join(outputPath, "contact-sheet.png"),
      fps,
    ),
    contactSheetSource:
      "Nine evenly spaced pre-encode alpha frames, each shown on light and dark checkerboards. Cell/time mapping is in contactSheet.",
    decodedAlphaVerification: {
      scope: "first_decoded_frame_only",
      ...decodedMetrics,
    },
    decodedForegroundVerification: {
      scope: "first_decoded_frame_only",
      foregroundPixelCount,
      lostOpaquePixels,
      tealCount,
      tealAlphaLost,
      tealMeanAbsoluteRgbError: tealCount
        ? tealRgbAbsoluteError / (tealCount * 3)
        : null,
    },
    allFramesHaveContent: perFrame.every((frame) => frame.boundsInclusive),
    allFramesHaveMargin: perFrame.every(
      (frame) =>
        frame.boundsInclusive &&
        frame.boundsInclusive.left >= 2 &&
        frame.boundsInclusive.top >= 2 &&
        frame.boundsInclusive.right < stream.width - 2 &&
        frame.boundsInclusive.bottom < stream.height - 2,
    ),
    protectedTealChangedInMatte: perFrame.reduce(
      (sum, frame) => sum + frame.protectedTealChanged,
      0,
    ),
    perFrame,
    limitations: [
      "First/last pose matching and character identity require visual review; this importer does not invent or repair motion.",
      "Green clothing/props may need a manual matte. Fine semi-transparent hairs can retain a fringe.",
      "Watermarks and other non-green overlays are retained and may affect content bounds.",
      "The source canvas is preserved as a review master. A single union bounding box across all frames, margins, and one fixed foot baseline must be reviewed before a square runtime export; do not dynamically crop each frame.",
      "Decoded WebM verification covers only the first frame. Per-frame checks and the contact sheet use pre-encode alpha PNGs.",
      "Both frame directories are intentionally retained for review and may use substantial disk space. Original input is never modified.",
      "Audio is omitted from the derived pet clip; the source retains its original audio.",
    ],
  };
  fs.writeFileSync(
    path.join(outputPath, "qa-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (
    !report.sourceUnchanged ||
    report.protectedTealChangedInMatte ||
    tealAlphaLost
  )
    throw new Error(
      "Preservation verification failed; inspect qa-report.json. Runtime assets were not changed.",
    );
  console.log(
    JSON.stringify(
      {
        output: webmPath,
        report: path.join(outputPath, "qa-report.json"),
        contactSheet: path.join(outputPath, "contact-sheet.png"),
        sourceUnchanged: report.sourceUnchanged,
        decodedAlpha: decodedMetrics.transparentFraction,
        tealCount,
        tealAlphaLost,
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
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.length) {
    console.log(
      "node import-green-video.mjs --input ORIGINAL.mp4 --out-dir NEW_DIRECTORY --ffmpeg /absolute/path/ffmpeg.exe [--fps 24] [--ffprobe /path/ffprobe.exe]",
    );
  } else {
    const options = {};
    const names = {
      "--input": "input",
      "--out-dir": "outDir",
      "--ffmpeg": "ffmpeg",
      "--ffprobe": "ffprobe",
      "--fps": "fps",
    };
    for (let i = 0; i < args.length; i += 2) {
      const name = names[args[i]];
      if (!name || !args[i + 1])
        throw new Error(`Unknown or incomplete option: ${args[i]}`);
      options[name] = name === "fps" ? Number(args[i + 1]) : args[i + 1];
    }
    if (!options.input || !options.outDir || !options.ffmpeg)
      throw new Error("--input, --out-dir, and --ffmpeg are required.");
    importGreenVideo(options);
  }
}
