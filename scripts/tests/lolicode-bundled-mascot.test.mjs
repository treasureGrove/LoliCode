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

test("the production companion embeds the unchanged PNG without an asset request", async () => {
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
});
