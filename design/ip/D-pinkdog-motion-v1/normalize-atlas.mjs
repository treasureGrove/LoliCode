import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function findPngJs() {
  try {
    return require("pngjs").PNG;
  } catch {
    for (let root = directory; ; root = path.dirname(root)) {
      const store = path.join(root, "node_modules", ".pnpm");
      if (fs.existsSync(store)) {
        for (const entry of fs.readdirSync(store).sort()) {
          if (!entry.startsWith("pngjs@")) continue;
          const modulePath = path.join(store, entry, "node_modules", "pngjs");
          if (fs.existsSync(modulePath)) return require(modulePath).PNG;
        }
      }
      if (path.dirname(root) === root) break;
    }
    throw new Error(
      "pngjs was not found. Run this script inside the project checkout with its existing pnpm dependencies installed.",
    );
  }
}

if (process.argv.includes("--help")) {
  console.log(
    "node normalize-atlas.mjs [source.png] [normalized.png]\nDefaults to source-atlas.png and normalized-atlas.png next to this script. Writes four QA frames and normalized-report.json beside the output. The source image is never changed.",
  );
  process.exit(0);
}

const PNG = findPngJs();
const input = path.resolve(
  process.argv[2] ?? path.join(directory, "source-atlas.png"),
);
const output = path.resolve(
  process.argv[3] ?? path.join(directory, "normalized-atlas.png"),
);
if (input === output) throw new Error("Input and output paths must differ.");
const sourceBytes = fs.readFileSync(input);
const source = PNG.sync.read(sourceBytes);
const { width, height, data } = source;
const COLUMNS = 6;
const ROWS = 5;
const CELL = 256;
const MAX_BBOX = 224;
const CENTER_X = 128;
const BASELINE_Y = 244;
const ALPHA_THRESHOLD = 10;
const MINIMUM_PIXELS = 1000;
const pixels = width * height;
const seen = new Uint8Array(pixels);
const owner = new Uint16Array(pixels);
const queue = new Int32Array(pixels);
const components = [];

for (let seed = 0; seed < pixels; seed++) {
  if (seen[seed] || data[seed * 4 + 3] <= ALPHA_THRESHOLD) continue;
  let head = 0;
  let tail = 1;
  let minX = width,
    minY = height,
    maxX = 0,
    maxY = 0,
    sumX = 0,
    sumY = 0;
  queue[0] = seed;
  seen[seed] = 1;
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    sumX += x;
    sumY += y;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (
          (!dx && !dy) ||
          x + dx < 0 ||
          x + dx >= width ||
          y + dy < 0 ||
          y + dy >= height
        )
          continue;
        const other = pixel + dy * width + dx;
        if (!seen[other] && data[other * 4 + 3] > ALPHA_THRESHOLD) {
          seen[other] = 1;
          queue[tail++] = other;
        }
      }
  }
  if (tail < MINIMUM_PIXELS) continue;
  const id = components.length + 1;
  for (let i = 0; i < tail; i++) owner[queue[i]] = id;
  const center = [sumX / tail, sumY / tail];
  components.push({
    id,
    pixels: tail,
    bbox: [minX, minY, maxX, maxY],
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    center,
    column: Math.floor(center[0] / (width / COLUMNS)),
    row: Math.floor(center[1] / (height / ROWS)),
  });
}

if (components.length !== COLUMNS * ROWS)
  throw new Error(`Expected 30 major characters, found ${components.length}.`);
components.sort((a, b) => a.row - b.row || a.column - b.column);
const slots = new Set(components.map((c) => `${c.row},${c.column}`));
if (
  slots.size !== 30 ||
  components.some(
    (c) => c.column < 0 || c.column >= COLUMNS || c.row < 0 || c.row >= ROWS,
  )
)
  throw new Error(
    "Expected exactly one character centroid in every source grid slot.",
  );
const scale =
  MAX_BBOX / Math.max(...components.map((c) => Math.max(c.width, c.height)));
const atlas = new PNG({ width: COLUMNS * CELL, height: ROWS * CELL });
atlas.data.fill(0);
const names = ["idle", "feed", "pet", "sleep", "drag"];
const frames = [];
const qaFrames = new Map([
  [0, "idle-0.png"],
  [8, "feed-2.png"],
  [20, "sleep-2.png"],
  [26, "drag-2.png"],
]);
const pendingQa = [];

for (const [index, component] of components.entries()) {
  const frame = new PNG({ width: CELL, height: CELL });
  frame.data.fill(0);
  const [minX, minY] = component.bbox;
  const left = CENTER_X - (component.width * scale) / 2;
  // The last occupied source scanline is the boots' contact line in this atlas.
  // Align its lower pixel edge to 245, leaving the visible last scanline at 244.
  const top = BASELINE_Y + 1 - component.height * scale;
  let outMinX = CELL,
    outMinY = CELL,
    outMaxX = -1,
    outMaxY = -1;
  let outPixels = 0;
  for (
    let y = Math.max(0, Math.ceil(top - 0.5));
    y < Math.min(CELL, Math.ceil(top + component.height * scale - 0.5));
    y++
  ) {
    for (
      let x = Math.max(0, Math.ceil(left - 0.5));
      x < Math.min(CELL, Math.ceil(left + component.width * scale - 0.5));
      x++
    ) {
      const sourceX = minX + (x + 0.5 - left) / scale - 0.5;
      const sourceY = minY + (y + 0.5 - top) / scale - 0.5;
      const x0 = Math.floor(sourceX),
        y0 = Math.floor(sourceY);
      const fx = sourceX - x0,
        fy = sourceY - y0;
      let alpha = 0,
        red = 0,
        green = 0,
        blue = 0;
      for (let oy = 0; oy < 2; oy++)
        for (let ox = 0; ox < 2; ox++) {
          const px = x0 + ox,
            py = y0 + oy;
          if (px < 0 || px >= width || py < 0 || py >= height) continue;
          const pixel = py * width + px;
          if (owner[pixel] !== component.id) continue;
          const weight = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
          const weightedAlpha = data[pixel * 4 + 3] * weight;
          alpha += weightedAlpha;
          red += data[pixel * 4] * weightedAlpha;
          green += data[pixel * 4 + 1] * weightedAlpha;
          blue += data[pixel * 4 + 2] * weightedAlpha;
        }
      if (Math.round(alpha) <= ALPHA_THRESHOLD) continue;
      const destination = (y * CELL + x) * 4;
      frame.data[destination] = Math.round(red / alpha);
      frame.data[destination + 1] = Math.round(green / alpha);
      frame.data[destination + 2] = Math.round(blue / alpha);
      frame.data[destination + 3] = Math.round(alpha);
      outMinX = Math.min(outMinX, x);
      outMinY = Math.min(outMinY, y);
      outMaxX = Math.max(outMaxX, x);
      outMaxY = Math.max(outMaxY, y);
      outPixels++;
    }
  }
  const normalizedWidth = outMaxX - outMinX + 1;
  const normalizedHeight = outMaxY - outMinY + 1;
  // A fractional source-edge sample can remove the very last low-alpha toe
  // pixel. Integer translation restores the shared contact line without
  // changing the globally shared scale or the character's proportions.
  const baselineCorrection = BASELINE_Y - outMaxY;
  if (baselineCorrection !== 0) {
    const aligned = Buffer.alloc(frame.data.length);
    for (let y = outMinY; y <= outMaxY; y++) {
      const destinationY = y + baselineCorrection;
      if (destinationY < 0 || destinationY >= CELL)
        throw new Error(
          `Frame ${index} baseline correction would clip the character.`,
        );
      frame.data.copy(
        aligned,
        destinationY * CELL * 4,
        y * CELL * 4,
        (y + 1) * CELL * 4,
      );
    }
    frame.data = aligned;
    outMinY += baselineCorrection;
    outMaxY += baselineCorrection;
  }
  if (
    normalizedWidth > MAX_BBOX ||
    normalizedHeight > MAX_BBOX ||
    outMaxY !== BASELINE_Y
  )
    throw new Error(
      `Frame ${index} did not meet bounding box / baseline requirements (${normalizedWidth}x${normalizedHeight}, baseline ${outMaxY}).`,
    );
  frame.bitblt(
    atlas,
    0,
    0,
    CELL,
    CELL,
    component.column * CELL,
    component.row * CELL,
  );
  if (qaFrames.has(index))
    pendingQa.push([qaFrames.get(index), PNG.sync.write(frame)]);
  frames.push({
    frame: index,
    action: names[component.row],
    actionFrame: component.column,
    sourcePixels: component.pixels,
    sourceBBox: component.bbox,
    sourceCenter: component.center,
    sourceFootBaseline: component.bbox[3],
    globalScale: scale,
    normalizedBBox: [outMinX, outMinY, outMaxX, outMaxY],
    normalizedPixels: outPixels,
    horizontalCenter: CENTER_X,
    footBaseline: BASELINE_Y,
    baselineCorrection,
  });
}

const outputDirectory = path.dirname(output);
fs.mkdirSync(outputDirectory, { recursive: true });
const atlasBytes = PNG.sync.write(atlas);
fs.writeFileSync(output, atlasBytes);
for (const [name, bytes] of pendingQa)
  fs.writeFileSync(path.join(outputDirectory, name), bytes);
const report = {
  input: path.basename(input),
  sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
  sourceSize: [width, height],
  output: path.basename(output),
  outputSize: [atlas.width, atlas.height],
  outputSha256: createHash("sha256").update(atlasBytes).digest("hex"),
  columns: COLUMNS,
  rows: ROWS,
  cell: CELL,
  alphaThreshold: ALPHA_THRESHOLD,
  connectivity: 8,
  minimumComponentPixels: MINIMUM_PIXELS,
  globalScale: scale,
  horizontalCenter: CENTER_X,
  footBaseline: BASELINE_Y,
  maxBoundingBox: MAX_BBOX,
  resampling:
    "bilinear with premultiplied-alpha interpolation; component ownership prevents adjacent-frame contamination",
  frames,
};
fs.writeFileSync(
  path.join(outputDirectory, "normalized-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      output,
      frames: frames.length,
      size: report.outputSize,
      globalScale: scale,
      footBaseline: BASELINE_Y,
      sha256: report.outputSha256,
    },
    null,
    2,
  ),
);
