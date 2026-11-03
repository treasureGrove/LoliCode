import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("the production companion embeds its resource key and matching standing/rest posters and emits all seven clips as local assets", async () => {
  // jsdom/Vite dev imports remain URLs even for ?inline. Exercise the real
  // production asset transform, keeping output in memory and ordinary images
  // external so removing ?inline genuinely makes this regression fail.
  const result = await build({
    configFile: path.join(root, "vite.config.ts"),
    logLevel: "silent",
    build: {
      write: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: path.join(root, "src/features/agent/AgentCompanion.tsx"),
        preserveEntrySignatures: "strict",
        external: [
          "react",
          "react/jsx-runtime",
          "lucide-react",
          "react-i18next",
        ],
      },
    },
  });
  const output = (Array.isArray(result) ? result : [result]).flatMap(
    (bundle) => bundle.output,
  );
  const original = await readFile(
    path.join(root, "src/assets/atelier/companion.png"),
  );
  const dataUrl = `data:image/png;base64,${original.toString("base64")}`;
  assert.ok(
    output.some((item) => item.type === "chunk" && item.code.includes(dataUrl)),
  );
  assert.ok(!output.some((item) => /companion[^/]*\.png$/.test(item.fileName)));
  for (const filename of [
    "companion-video-poster-v4.webp",
    "companion-sit-poster-v5.webp",
    "companion-lie-poster-v5.webp",
  ]) {
    const artwork = await readFile(
      path.join(root, "src/assets/atelier", filename),
    );
    const artworkUrl = `data:image/webp;base64,${artwork.toString("base64")}`;
    assert.ok(
      output.some(
        (item) => item.type === "chunk" && item.code.includes(artworkUrl),
      ),
      `${filename} must work offline without a separate request`,
    );
  }
  assert.ok(
    !output.some((item) => /companion[^/]*\.webp$/.test(item.fileName)),
  );
  for (const filename of [
    "companion-idle-video-v4.webm",
    "companion-greeting-video-v4.webm",
    "companion-feed-video-v4.webm",
    "companion-snack-video-v4.webm",
    "companion-curious-video-v4.webm",
    "companion-sit-video-v5.webm",
    "companion-lie-video-v5.webm",
  ]) {
    const footage = await readFile(
      path.join(root, "src/assets/atelier", filename),
    );
    const asset = output.find(
      (item) =>
        item.type === "asset" &&
        item.fileName.endsWith(".webm") &&
        Buffer.from(item.source).equals(footage),
    );
    assert.ok(
      asset,
      `${filename} must be included in the desktop asset bundle`,
    );
    assert.deepEqual(Buffer.from(asset.source), footage);
    const chunk = output.find(
      (item) =>
        item.type === "chunk" &&
        item.code.includes(path.basename(asset.fileName)),
    );
    assert.ok(chunk, `${filename} must be referenced by the companion`);
    const references = Array.from(
      chunk.code.matchAll(/new URL\((["'])(.*?)\1,\s*import\.meta\.url\)/g),
    );
    const reference = references.find((match) =>
      match[2].endsWith(path.basename(asset.fileName)),
    );
    assert.ok(reference, `${filename} must resolve beside the local renderer`);
    assert.ok(
      !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(reference[2]),
      `${filename} must not use a remote or root-relative media URL`,
    );
  }

  const config = JSON.parse(
    await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const imagePolicy = config.app.security.csp
    .split(";")
    .find((directive) => directive.trim().startsWith("img-src "));
  assert.ok(
    imagePolicy?.split(/\s+/).includes("data:"),
    "the desktop CSP must permit the embedded PNG",
  );
  const directives = config.app.security.csp.split(";");
  const mediaPolicy =
    directives.find((directive) => directive.trim().startsWith("media-src ")) ??
    directives.find((directive) => directive.trim().startsWith("default-src "));
  assert.ok(
    mediaPolicy?.split(/\s+/).includes("'self'"),
    "the desktop CSP must permit the local WebM assets",
  );
});
