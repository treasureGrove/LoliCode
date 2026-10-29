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
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
}));
