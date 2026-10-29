#!/usr/bin/env node
/** Export only the desktop's public API-key preset metadata for the relay UI. */
import { createRequire } from "node:module";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const defaultOutput = path.join(
  root,
  "deploy/lolicode-relay/portal/channel-presets.json",
);
const sourceFile = path.join(root, "src/features/channels/channelPresets.ts");
const protocols = new Set([
  "openai_chat",
  "openai_responses",
  "anthropic",
  "gemini_native",
]);

export async function loadChannelPresetSource() {
  // esbuild is already installed with Vite; no separate dependency or install.
  const viteRequire = createRequire(require.resolve("vite/package.json"));
  const { build } = viteRequire("esbuild");
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: `import { CHANNEL_PRESETS, COMMON_CHANNEL_PRESETS } from "./src/features/channels/channelPresets.ts";
export const presets = CHANNEL_PRESETS;
export const commonIds = COMMON_CHANNEL_PRESETS.map(preset => preset.id);`,
      resolveDir: root,
      sourcefile: "relay-channel-presets-export.ts",
      loader: "ts",
    },
    alias: { "@": path.join(root, "src") },
    bundle: true,
    treeShaking: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  // Fail before execution if a future preset import pulls in application code.
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input === "relay-channel-presets-export.ts") continue;
    const absolute = path.resolve(root, input);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (
      absolute !== sourceFile &&
      !relative.startsWith("src/config/") &&
      !relative.includes("node_modules/smol-toml/")
    ) {
      throw new Error(
        `Preset export must not execute application code: ${relative}`,
      );
    }
  }
  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.length)
      throw new Error("Preset export must be a self-contained static module");
  }
  const code = result.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

export function relayPresetDocument({ presets, commonIds }) {
  if (!Array.isArray(presets) || !Array.isArray(commonIds))
    throw new Error("Invalid desktop preset catalog");
  const seen = new Set();
  const exported = presets.map((preset) => {
    for (const field of ["id", "name", "baseUrl", "protocol", "icon"]) {
      if (typeof preset[field] !== "string" || !preset[field].trim()) {
        throw new Error(`Missing public preset field: ${field}`);
      }
    }
    if (
      seen.has(preset.id) ||
      preset.id.startsWith("account:") ||
      !protocols.has(preset.protocol)
    ) {
      throw new Error(
        "Invalid or duplicate API-key preset identity or protocol",
      );
    }
    seen.add(preset.id);
    const url = new URL(preset.baseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error(
        "Preset endpoint must be a public HTTP(S) URL without credentials",
      );
    }
    const value = {
      id: preset.id,
      name: preset.name,
      baseUrl: preset.baseUrl,
      protocol: preset.protocol,
      icon: preset.icon,
    };
    if (preset.websiteUrl !== undefined) {
      if (typeof preset.websiteUrl !== "string")
        throw new Error("Invalid preset website URL");
      value.websiteUrl = preset.websiteUrl;
    }
    return value;
  });
  if (
    new Set(commonIds).size !== commonIds.length ||
    commonIds.some((id) => !seen.has(id))
  ) {
    throw new Error(
      "Common desktop preset IDs must refer to the exported catalog",
    );
  }
  return { version: 1, presets: exported, commonIds: [...commonIds] };
}

export async function exportRelayChannelPresets({
  output = defaultOutput,
  check = false,
} = {}) {
  const document = relayPresetDocument(await loadChannelPresetSource());
  const content = `${JSON.stringify(document, null, 2)}\n`;
  let previous;
  try {
    previous = (await readFile(output, "utf8")).replaceAll("\r\n", "\n");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const changed = previous !== content;
  if (check && changed) {
    throw new Error(
      "Relay channel presets are out of date. Run: node scripts/data/export-relay-channel-presets.mjs",
    );
  }
  if (!check && changed) {
    await mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    let owned = false;
    try {
      const stream = await open(temporary, "wx");
      owned = true;
      try {
        await stream.writeFile(content, "utf8");
      } finally {
        await stream.close();
      }
      await rename(temporary, output);
    } finally {
      if (owned) await rm(temporary, { force: true });
    }
  }
  return { changed, count: document.presets.length, output };
}

export async function main(args = process.argv.slice(2)) {
  let check = false;
  let output = defaultOutput;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--check") check = true;
    else if (args[index] === "--output" && args[index + 1])
      output = path.resolve(args[++index]);
    else
      throw new Error(
        "Usage: node scripts/data/export-relay-channel-presets.mjs [--check] [--output path]",
      );
  }
  const result = await exportRelayChannelPresets({ output, check });
  console.log(
    `${check ? "Checked" : result.changed ? "Exported" : "Unchanged"} ${result.count} relay channel presets`,
  );
  return result;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
