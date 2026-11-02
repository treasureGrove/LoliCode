import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import pngModule from "../../../node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs/lib/png.js";

const { PNG } = pngModule;
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => PNG.sync.read(fs.readFileSync(path.join(here, name)));
const base = read("tail-matched-source.png");
const closed = read("eyes-closed-source.png");
if (base.width !== closed.width || base.height !== closed.height)
  throw new Error("Expression registration dimensions differ.");
const overlay = new PNG({ width: base.width, height: base.height });
// The two masks enclose the original irises and lashes, preserving all other
// source pixels. Feathering is confined to matching surrounding face/hair.
const eyeMasks = [
  { x: 484, y: 447, rx: 82, ry: 76, angle: -0.36 },
  { x: 666, y: 384, rx: 80, ry: 74, angle: -0.36 },
];
const smoothstep = (x) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
let covered = 0;
let minX = base.width,
  minY = base.height,
  maxX = -1,
  maxY = -1;
for (let y = 0; y < base.height; y++)
  for (let x = 0; x < base.width; x++) {
    let mask = 0;
    for (const eye of eyeMasks) {
      const dx = x - eye.x,
        dy = y - eye.y;
      const px = dx * Math.cos(eye.angle) + dy * Math.sin(eye.angle);
      const py = -dx * Math.sin(eye.angle) + dy * Math.cos(eye.angle);
      const distance = Math.sqrt((px / eye.rx) ** 2 + (py / eye.ry) ** 2);
      mask = Math.max(mask, 1 - smoothstep((distance - 0.84) / 0.16));
    }
    const offset = (y * base.width + x) * 4;
    const alpha = Math.round(mask * closed.data[offset + 3]);
    if (alpha) {
      overlay.data.set(closed.data.subarray(offset, offset + 3), offset);
      overlay.data[offset + 3] = alpha;
      covered++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
fs.writeFileSync(
  path.join(here, "eyes-closed-overlay.png"),
  PNG.sync.write(overlay),
);
// A composited inspection image verifies placement and edge blending. The
// runtime performs this same local blend while moving one continuous mesh.
const check = new PNG({ width: base.width, height: base.height });
for (let i = 0; i < base.width * base.height; i++) {
  const p = i * 4,
    a = overlay.data[p + 3] / 255;
  for (let c = 0; c < 3; c++)
    check.data[p + c] = Math.round(
      base.data[p + c] * (1 - a) + overlay.data[p + c] * a,
    );
  check.data[p + 3] = base.data[p + 3];
}
fs.writeFileSync(
  path.join(here, "expression-composite-check.png"),
  PNG.sync.write(check),
);
const hash = (name) =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(here, name)))
    .digest("hex");
fs.writeFileSync(
  path.join(here, "asset-report.json"),
  JSON.stringify(
    {
      width: base.width,
      height: base.height,
      method:
        "Local eye-region extraction from the built-in imagegen edit; alpha masks feather only the surrounding face. No full-body frame blending.",
      eyeMasks,
      coveredPixels: covered,
      maskBoundsInclusive: { minX, minY, maxX, maxY },
      hashes: Object.fromEntries(
        [
          "tail-matched-source.png",
          "eyes-closed-source.png",
          "eyes-closed-overlay.png",
          "turnaround.png",
        ].map((name) => [name, hash(name)]),
      ),
      correction:
        "Tail main fur cocoa brown, tip cream white, matched to ears. Original historical PNG remains unchanged.",
      turnaroundNote:
        "Front follows selected character; unseen side/back clothing details are inferred design references, not a 3D or Cubism model.",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    width: base.width,
    height: base.height,
    coveredPixels: covered,
    maskBoundsInclusive: { minX, minY, maxX, maxY },
  }),
);
