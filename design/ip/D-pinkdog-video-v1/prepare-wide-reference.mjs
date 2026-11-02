import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pngModule from "../../../node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs/lib/png.js";

// Deterministic area resampling and compositing only; the character is not redrawn.
const { PNG } = pngModule;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const inputPath = path.join(root, "src/assets/atelier/companion.png");
const inputBytes = fs.readFileSync(inputPath);
const source = PNG.sync.read(inputBytes);
const output = new PNG({ width: 1280, height: 720 });
for (let i = 0; i < output.data.length; i += 4) {
  output.data.set([0, 255, 0, 255], i);
}
const targetHeight = 518;
const targetWidth = Math.round((source.width * targetHeight) / source.height);
const left = Math.floor((output.width - targetWidth) / 2);
const top = 108;
const scaleX = source.width / targetWidth;
const scaleY = source.height / targetHeight;
const foreground = {
  left: output.width,
  top: output.height,
  right: -1,
  bottom: -1,
};
for (let y = 0; y < targetHeight; y++) {
  const y0 = y * scaleY;
  const y1 = (y + 1) * scaleY;
  for (let x = 0; x < targetWidth; x++) {
    const x0 = x * scaleX;
    const x1 = (x + 1) * scaleX;
    let alpha = 0;
    const premultiplied = [0, 0, 0];
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
      const wy = Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy));
      for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
        const wx = Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx));
        const weight = (wx * wy) / (scaleX * scaleY);
        const offset = (sy * source.width + sx) * 4;
        const weightedAlpha = (source.data[offset + 3] / 255) * weight;
        alpha += weightedAlpha;
        for (let c = 0; c < 3; c++)
          premultiplied[c] += source.data[offset + c] * weightedAlpha;
      }
    }
    const offset = ((y + top) * output.width + x + left) * 4;
    output.data[offset] = Math.round(premultiplied[0]);
    output.data[offset + 1] = Math.round(premultiplied[1] + 255 * (1 - alpha));
    output.data[offset + 2] = Math.round(premultiplied[2]);
    if (alpha > 16 / 255) {
      foreground.left = Math.min(foreground.left, x + left);
      foreground.top = Math.min(foreground.top, y + top);
      foreground.right = Math.max(foreground.right, x + left);
      foreground.bottom = Math.max(foreground.bottom, y + top);
    }
  }
}
const outputBytes = PNG.sync.write(output);
fs.writeFileSync(path.join(here, "idle-reference-green-wide.png"), outputBytes);
const report = {
  source: "src/assets/atelier/companion.png",
  sourceDimensions: [source.width, source.height],
  sourceSha256: createHash("sha256").update(inputBytes).digest("hex"),
  output: "design/ip/D-pinkdog-video-v1/idle-reference-green-wide.png",
  outputDimensions: [output.width, output.height],
  outputSha256: createHash("sha256").update(outputBytes).digest("hex"),
  background: "#00FF00",
  preparation:
    "Area resample in premultiplied alpha, uniformly scale original character, center on solid green. No redraw or pose change.",
  characterCanvas: { left, top, width: targetWidth, height: targetHeight },
  foregroundAlphaThreshold: 16,
  foregroundBoundsInclusive: foreground,
  topMarginPercent: (foreground.top / output.height) * 100,
  bottomPositionPercent: ((foreground.bottom + 1) / output.height) * 100,
};
fs.writeFileSync(
  path.join(here, "wide-reference-report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
