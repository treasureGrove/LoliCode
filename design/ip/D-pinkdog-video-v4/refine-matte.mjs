import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pngModule from "../../../node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs/lib/png.js";

const { PNG } = pngModule;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (filename) => PNG.sync.read(fs.readFileSync(filename));
const write = (filename, png) =>
  fs.writeFileSync(filename, PNG.sync.write(png), { flag: "wx" });
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
const isTeal = (r, g, b) => {
  const [h, s] = hue(r, g, b);
  return h >= 160 && h <= 210 && s >= 0.25;
};

/** Only RGB green spill and alpha in a two-pixel band adjoining existing transparency. */
export function refineMatte(alpha, source = alpha, shrink = 0.35) {
  if (alpha.width !== source.width || alpha.height !== source.height)
    throw new Error("Source and matte dimensions differ.");
  if (!Number.isFinite(shrink) || shrink < 0 || shrink > 0.5)
    throw new Error("Shrink must be 0..0.5 pixels.");
  const { width, height } = alpha,
    count = width * height;
  const band = new Uint8Array(count);
  const aAt = (x, y) =>
    x < 0 || x >= width || y < 0 || y >= height
      ? 0
      : alpha.data[(y * width + x) * 4 + 3];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (alpha.data[i * 4 + 3] <= 4) continue;
      band[i] = 3;
      for (let radius = 1; radius <= 2 && band[i] === 3; radius++) {
        outer: for (let dy = -radius; dy <= radius; dy++)
          for (let dx = -radius; dx <= radius; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            if (aAt(x + dx, y + dy) <= 4) {
              band[i] = radius;
              break outer;
            }
          }
      }
    }
  const output = new PNG({ width, height });
  alpha.data.copy(output.data);
  const metrics = {
    changedPixels: 0,
    greenChanged: 0,
    alphaChanged: 0,
    coreChanged: 0,
    coreTealPixels: 0,
    coreTealChanged: 0,
    referencesProtectedAsTeal: 0,
    missingReference: 0,
    maximumGreenReduction: 0,
    maximumAlphaReduction: 0,
  };
  const reference = (x, y) => {
    for (let radius = 1; radius <= 6; radius++) {
      const colors = [];
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
          const i = yy * width + xx,
            p = i * 4;
          if (band[i] !== 3 || alpha.data[p + 3] < 248) continue;
          const r = alpha.data[p],
            g = alpha.data[p + 1],
            b = alpha.data[p + 2];
          const [h, s] = hue(r, g, b);
          if (h >= 70 && h <= 155 && s > 0.12 && g > Math.max(r, b) + 4)
            continue;
          colors.push([r, g, b]);
        }
      if (colors.length)
        return [0, 1, 2].map(
          (c) =>
            colors.map((rgb) => rgb[c]).sort((a, b) => a - b)[
              Math.floor(colors.length / 2)
            ],
        );
    }
    return null;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        p = i * 4,
        a = alpha.data[p + 3];
      if (band[i] === 3 && isTeal(...alpha.data.subarray(p, p + 3)))
        metrics.coreTealPixels++;
      if (band[i] < 1 || band[i] > 2 || a <= 4) continue;
      const r = alpha.data[p],
        g = alpha.data[p + 1],
        b = alpha.data[p + 2];
      const sr = source.data[p],
        sg = source.data[p + 1],
        sb = source.data[p + 2],
        [h, s] = hue(sr, sg, sb);
      if (
        !(h >= 65 && h <= 165 && s >= 0.12 && sg > Math.max(sr, sb) + 4) &&
        g <= Math.max(r, b) + 8
      )
        continue;
      const fg = reference(x, y);
      if (!fg) {
        metrics.missingReference++;
        continue;
      }
      if (isTeal(...fg)) {
        metrics.referencesProtectedAsTeal++;
        continue;
      }
      const expected =
        (((r + b) / 2) * fg[1]) / Math.max(8, (fg[0] + fg[2]) / 2);
      const targetG = Math.round(clamp(expected + 2, 0, g));
      if (g - targetG <= 4) continue;
      let minimumAlpha = a;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          minimumAlpha = Math.min(minimumAlpha, aAt(x + dx, y + dy));
      const strength = clamp((g - targetG) / 32, 0, 1);
      const targetA = Math.round(a - shrink * (a - minimumAlpha) * strength);
      output.data[p + 1] = targetG;
      output.data[p + 3] = targetA;
      metrics.changedPixels++;
      metrics.greenChanged++;
      if (a !== targetA) metrics.alphaChanged++;
      metrics.maximumGreenReduction = Math.max(
        metrics.maximumGreenReduction,
        g - targetG,
      );
      metrics.maximumAlphaReduction = Math.max(
        metrics.maximumAlphaReduction,
        a - targetA,
      );
    }
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    if (band[i] !== 3) continue;
    if ([0, 1, 2, 3].some((c) => alpha.data[p + c] !== output.data[p + c])) {
      metrics.coreChanged++;
      if (isTeal(...alpha.data.subarray(p, p + 3))) metrics.coreTealChanged++;
    }
  }
  if (metrics.coreChanged)
    throw new Error("Refinement changed the protected interior.");
  return { png: output, metrics };
}

export function qaSheet(samples, filename) {
  const size = 360,
    gap = 8,
    cellHeight = size * 2 + gap;
  const png = new PNG({
    width: size * 2 + gap * 3,
    height: samples.length * (cellHeight + gap) + gap,
  });
  for (let p = 0; p < png.data.length; p += 4)
    png.data.set([85, 85, 85, 255], p);
  samples.forEach((sample, row) =>
    [sample.before, sample.after].forEach((image, col) => {
      for (let panel = 0; panel < 2; panel++)
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const sx = Math.min(
              image.width - 1,
              Math.floor(sample.crop.left + (x * sample.crop.width) / size),
            );
            const sy = Math.min(
              image.height - 1,
              Math.floor(sample.crop.top + (y * sample.crop.height) / size),
            );
            const ip = (sy * image.width + sx) * 4,
              a = image.data[ip + 3] / 255;
            const op =
              ((gap + row * (cellHeight + gap) + panel * (size + gap) + y) *
                png.width +
                gap +
                col * (size + gap) +
                x) *
              4;
            const base = panel ? 24 : 245;
            for (let c = 0; c < 3; c++)
              png.data[op + c] = Math.round(
                image.data[ip + c] * a + base * (1 - a),
              );
          }
    }),
  );
  write(filename, png);
}

export function refineDirectory({
  inputAlphaDir,
  sourceDir,
  outDir,
  shrink = 0.35,
  frames,
}) {
  const inputPath = fs.realpathSync(inputAlphaDir),
    outputPath = path.resolve(outDir);
  if (fs.existsSync(outputPath))
    throw new Error("Output directory exists; choose a new versioned path.");
  const allNames = fs
    .readdirSync(inputPath)
    .filter((name) => /^\d{6}\.png$/.test(name))
    .sort();
  const names = frames ? frames.split(",") : allNames;
  if (!names.length || names.some((name) => !allNames.includes(name)))
    throw new Error("Missing or invalid frame names.");
  const selected = new Set([0, Math.floor(names.length / 2), names.length - 1]);
  fs.mkdirSync(path.join(outputPath, "alpha-frames"), { recursive: true });
  const perFrame = [],
    samples = [];
  names.forEach((name, index) => {
    const alphaPath = path.join(inputPath, name),
      alphaBytes = fs.readFileSync(alphaPath),
      alpha = PNG.sync.read(alphaBytes);
    const sourcePath = sourceDir ? path.join(sourceDir, name) : alphaPath;
    const sourceBytes = sourceDir ? fs.readFileSync(sourcePath) : alphaBytes;
    const { png, metrics } = refineMatte(
      alpha,
      PNG.sync.read(sourceBytes),
      shrink,
    );
    const outputName = path.join(outputPath, "alpha-frames", name);
    write(outputName, png);
    const sourceUnchanged =
      hash(fs.readFileSync(sourcePath)) === hash(sourceBytes);
    const matteUnchanged =
      hash(fs.readFileSync(alphaPath)) === hash(alphaBytes);
    if (!sourceUnchanged || !matteUnchanged)
      throw new Error("Input preservation check failed.");
    perFrame.push({
      name,
      ...metrics,
      sourceUnchanged,
      matteUnchanged,
      sourceSha256: hash(sourceBytes),
      inputAlphaSha256: hash(alphaBytes),
      outputSha256: hash(fs.readFileSync(outputName)),
    });
    if (selected.has(index)) {
      // Square inputs retain the full frame in QA; landscape inputs use the
      // centered 80%-height inspection crop. Neither affects output framing.
      const size =
        Math.min(alpha.width, alpha.height) *
        (alpha.width === alpha.height ? 1 : 0.8);
      samples.push({
        name,
        before: alpha,
        after: png,
        crop: {
          left: (alpha.width - size) / 2,
          top: (alpha.height - size) / 2,
          width: size,
          height: size,
        },
      });
    }
  });
  qaSheet(samples, path.join(outputPath, "edge-qa-before-after.png"));
  const detailSamples = samples.map((sample) => {
    const { width, height } = sample.before;
    const scanY = Math.floor(height * 0.45);
    let edgeX = Math.floor(width * 0.2);
    for (let x = Math.floor(width * 0.05); x < width / 2; x++) {
      if (sample.before.data[(scanY * width + x) * 4 + 3] >= 200) {
        edgeX = x;
        break;
      }
    }
    const size = Math.min(360, width, height);
    return {
      ...sample,
      crop: {
        left: clamp(edgeX - size / 3, 0, width - size),
        top: clamp(scanY - size / 2, 0, height - size),
        width: size,
        height: size,
      },
    };
  });
  qaSheet(
    detailSamples,
    path.join(outputPath, "edge-detail-qa-before-after.png"),
  );
  const report = {
    inputAlphaDir: inputPath,
    sourceDir: sourceDir ? path.resolve(sourceDir) : null,
    outputDir: outputPath,
    frames: names.length,
    method:
      "Only a 2px band adjoining existing transparency (alpha<=4). Green-channel spill is capped against local trusted foreground ratios; red/blue and the interior are unchanged. Teal foreground references are excluded. No watermark treatment, no whole-image blur or AI redraw.",
    shrinkPixels: shrink,
    alphaPolicy:
      "At most shrinkPixels times the local 1px alpha gradient; shrink is restricted to 0..0.5 and only pixels with verified green spill. Alpha is never increased.",
    qaLayout:
      "Rows = sampled frames; left = original matte, right = refined; upper = light background, lower = dark background. Crop is QA only; output frame dimensions are unchanged.",
    qaFrames: samples.map((s) => ({ name: s.name, crop: s.crop })),
    detailQaFrames: detailSamples.map((s) => ({ name: s.name, crop: s.crop })),
    allInputsUnchanged: perFrame.every(
      (f) => f.sourceUnchanged && f.matteUnchanged,
    ),
    protectedCoreChanges: perFrame.reduce((n, f) => n + f.coreChanged, 0),
    protectedCoreTealChanges: perFrame.reduce(
      (n, f) => n + f.coreTealChanged,
      0,
    ),
    changedPixels: perFrame.reduce((n, f) => n + f.changedPixels, 0),
    perFrame,
  };
  fs.writeFileSync(
    path.join(outputPath, "refine-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify(
      {
        outputPath,
        frames: report.frames,
        changedPixels: report.changedPixels,
        protectedCoreChanges: report.protectedCoreChanges,
        protectedCoreTealChanges: report.protectedCoreTealChanges,
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
    options = {};
  const keys = {
    "--input-alpha-dir": "inputAlphaDir",
    "--source-dir": "sourceDir",
    "--out-dir": "outDir",
    "--shrink": "shrink",
    "--frames": "frames",
  };
  if (args.includes("--help") || !args.length)
    console.log(
      "node refine-matte.mjs --input-alpha-dir ALPHA_FRAMES --out-dir NEW_DIRECTORY [--source-dir SOURCE_FRAMES] [--shrink 0.35] [--frames 000001.png,000061.png,000120.png]",
    );
  else {
    for (let i = 0; i < args.length; i += 2) {
      const key = keys[args[i]];
      if (!key || !args[i + 1]) throw new Error(`Invalid option ${args[i]}`);
      options[key] = key === "shrink" ? Number(args[i + 1]) : args[i + 1];
    }
    if (!options.inputAlphaDir || !options.outDir)
      throw new Error("--input-alpha-dir and --out-dir are required.");
    refineDirectory(options);
  }
}
