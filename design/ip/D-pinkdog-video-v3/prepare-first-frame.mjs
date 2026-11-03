import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pngModule from "../../../node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs/lib/png.js";

// Deterministic preparation only: sample existing RGBA pixels in premultiplied
// alpha and composite over exact green. No recoloring, keying, or redrawing.
const { PNG } = pngModule;
const here = path.dirname(fileURLToPath(import.meta.url));
const sourceName = "standard-pose-source.png";
const outputName = "first-frame-green.png";
const reportName = "first-frame-report.json";
for (const name of [outputName, reportName]) {
  if (fs.existsSync(path.join(here, name)))
    throw new Error(
      `Refusing to overwrite ${name}; use a new versioned directory.`,
    );
}

const sourceBytes = fs.readFileSync(path.join(here, sourceName));
const source = PNG.sync.read(sourceBytes);
const alphaThreshold = 16;
const sourceBounds = {
  left: source.width,
  top: source.height,
  right: -1,
  bottom: -1,
};
let transparentPixels = 0;
for (let y = 0; y < source.height; y++) {
  for (let x = 0; x < source.width; x++) {
    const alpha = source.data[(y * source.width + x) * 4 + 3];
    if (alpha === 0) transparentPixels++;
    if (alpha <= alphaThreshold) continue;
    sourceBounds.left = Math.min(sourceBounds.left, x);
    sourceBounds.top = Math.min(sourceBounds.top, y);
    sourceBounds.right = Math.max(sourceBounds.right, x);
    sourceBounds.bottom = Math.max(sourceBounds.bottom, y);
  }
}
if (sourceBounds.right < 0)
  throw new Error("Source has no visible RGBA content.");
if (transparentPixels === 0)
  throw new Error(
    "Source has no fully transparent pixels; supply the transparent master.",
  );

const canvasWidth = 1280;
const canvasHeight = 720;
const desiredHeight = 468;
const maximumWidth = 1024;
const footlineExclusive = 612;
const contentWidth = sourceBounds.right - sourceBounds.left + 1;
const contentHeight = sourceBounds.bottom - sourceBounds.top + 1;
const scale = Math.min(
  desiredHeight / contentHeight,
  maximumWidth / contentWidth,
);
const width = contentWidth * scale;
const height = contentHeight * scale;
const left = (canvasWidth - width) / 2;
const top = footlineExclusive - height;
const output = new PNG({ width: canvasWidth, height: canvasHeight });
for (let i = 0; i < output.data.length; i += 4)
  output.data.set([0, 255, 0, 255], i);

const outputBounds = {
  left: canvasWidth,
  top: canvasHeight,
  right: -1,
  bottom: -1,
};
const channel = (value) => Math.max(0, Math.min(255, Math.round(value)));
for (let y = Math.floor(top); y < Math.ceil(top + height); y++) {
  const y0 = Math.max(sourceBounds.top, (y - top) / scale + sourceBounds.top);
  const y1 = Math.min(
    sourceBounds.bottom + 1,
    (y + 1 - top) / scale + sourceBounds.top,
  );
  for (let x = Math.floor(left); x < Math.ceil(left + width); x++) {
    const x0 = Math.max(
      sourceBounds.left,
      (x - left) / scale + sourceBounds.left,
    );
    const x1 = Math.min(
      sourceBounds.right + 1,
      (x + 1 - left) / scale + sourceBounds.left,
    );
    let alpha = 0;
    const premultiplied = [0, 0, 0];
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
      const wy = Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy));
      for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
        const wx = Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx));
        const offset = (sy * source.width + sx) * 4;
        const weightedAlpha =
          (source.data[offset + 3] / 255) * wx * wy * scale * scale;
        alpha += weightedAlpha;
        for (let c = 0; c < 3; c++)
          premultiplied[c] += source.data[offset + c] * weightedAlpha;
      }
    }
    alpha = Math.max(0, Math.min(1, alpha));
    const offset = (y * canvasWidth + x) * 4;
    output.data[offset] = channel(premultiplied[0]);
    output.data[offset + 1] = channel(premultiplied[1] + 255 * (1 - alpha));
    output.data[offset + 2] = channel(premultiplied[2]);
    if (alpha <= alphaThreshold / 255) continue;
    outputBounds.left = Math.min(outputBounds.left, x);
    outputBounds.top = Math.min(outputBounds.top, y);
    outputBounds.right = Math.max(outputBounds.right, x);
    outputBounds.bottom = Math.max(outputBounds.bottom, y);
  }
}

const outputBytes = PNG.sync.write(output);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  source: sourceName,
  sourceDimensions: [source.width, source.height],
  sourceSha256: sha256(sourceBytes),
  sourceTransparentPixels: transparentPixels,
  sourceAlphaThreshold: alphaThreshold,
  sourceContentBoundsInclusive: sourceBounds,
  output: outputName,
  outputDimensions: [canvasWidth, canvasHeight],
  outputSha256: sha256(outputBytes),
  background: "#00FF00",
  transform: {
    uniformScale: scale,
    destinationContentRect: { left, top, width, height },
    footlineExclusive,
    desiredHeight,
    maximumWidth,
    limitedByWidth: maximumWidth / contentWidth < desiredHeight / contentHeight,
  },
  resampledForegroundBoundsInclusive: outputBounds,
  preparation:
    "Crop to visible alpha bounds (>16); uniformly area-resample in premultiplied alpha; composite onto exact green. Source colors and pose are unchanged; no chroma keying or recoloring.",
};
fs.writeFileSync(path.join(here, outputName), outputBytes, { flag: "wx" });
fs.writeFileSync(
  path.join(here, reportName),
  JSON.stringify(report, null, 2) + "\n",
  {
    flag: "wx",
  },
);
console.log(JSON.stringify(report, null, 2));
