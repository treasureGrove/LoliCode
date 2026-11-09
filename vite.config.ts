import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { documentAssets } from "./scripts/build/vite-document-assets";

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
