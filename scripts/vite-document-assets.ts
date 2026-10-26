import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);
const folders = ["cmaps", "standard_fonts", "wasm"];

/** Serve and bundle only PDF.js's fixed, locally installed runtime resources. */
export function documentAssets(): Plugin {
  const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const assets = new Map<string, string>();
  for (const folder of folders) {
    for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
      if (entry.isFile()) assets.set(`pdfjs/${folder}/${entry.name}`, path.join(root, folder, entry.name));
    }
  }
  assets.set("pdfjs/LICENSE", path.join(root, "LICENSE"));
  return {
    name: "lolicode-document-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const key = (request.url || "").split("?", 1)[0].replace(/^\//, "");
        if (!key.startsWith("pdfjs/")) return next();
        const source = assets.get(key);
        if (!source) { response.statusCode = 404; response.end(); return; }
        response.setHeader("Content-Type", source.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        response.setHeader("Cache-Control", "no-cache");
        fs.createReadStream(source).on("error", () => { response.destroy(); }).pipe(response);
      });
    },
    generateBundle() {
      for (const [fileName, source] of assets) {
        this.emitFile({ type: "asset", fileName, source: fs.readFileSync(source) });
      }
    },
  };
}
