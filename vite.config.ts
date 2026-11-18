import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { documentAssets } from "./scripts/build/vite-document-assets";

if (process.platform === "win32") {
  const tmpPrefix = path.join(os.tmpdir(), "esbuild-").toLowerCase();
  const isEsbuildTemp = (file: fs.PathOrFileDescriptor) =>
    typeof file === "string" && path.resolve(file).toLowerCase().startsWith(tmpPrefix);
  const rawWriteFile = fs.writeFile.bind(fs);
  const rawWriteFileSync = fs.writeFileSync.bind(fs);
  // Force esbuild to use its built-in in-memory stdin pipe instead of temp files
  // that Windows antivirus/sandbox locks during DeleteFileW.
  fs.writeFile = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (isEsbuildTemp(file)) {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        queueMicrotask(() => cb(new Error("esbuild temp file disabled")));
        return;
      }
    }
    return (rawWriteFile as (...a: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.writeFile;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (isEsbuildTemp(file)) {
      throw new Error("esbuild temp file disabled");
    }
    return (rawWriteFileSync as (...a: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.writeFileSync;
}

export default defineConfig(({ command }) => ({
  root: "src",
  plugins: [
    command === "serve" &&
      codeInspectorPlugin({
        bundler: "vite",
      }),
    react(),
    documentAssets(),
  ].filter(Boolean),
  base: "./",
  build: {
    outDir:
      process.env.VITE_LOLICODE_BUILD_CHANNEL === "development"
        ? "../dist-dev"
        : "../dist",
    emptyOutDir: true,
  },
  server: {
    port:
      process.env.VITE_LOLICODE_BUILD_CHANNEL === "development" ? 3001 : 3000,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@deepseek-ai/dsh-llm/assistant-stream": path.resolve(
        __dirname,
        "packages/lolicode-harness-runtime/node_modules/@deepseek-ai/dsh-llm/lib/types/assistant-stream.js",
      ),
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
}));
