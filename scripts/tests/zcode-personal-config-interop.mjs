// Development-only protocol acceptance. No user configuration or credential is read.
// The Rust test sends a generated temporary-home fixture to the pinned ZCode reader.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const upstream = path.join(repository, "third-party/zcode-runtime/upstream");
const workspace = path.join(
  repository,
  "packages/lolicode-zcode-runtime/.build/workspace",
);
const sourceRevision = "aac4755666d09fdcd70272fcf063c077a639015f";

if (!fs.existsSync(path.join(workspace, "node_modules/esbuild/package.json"))) {
  throw new Error(
    "The development-only ZCode dependency workspace is missing; run pnpm prepare:zcode-runtime before this optional interop check.",
  );
}

let checkedFiles = 0;
for (const packageName of [
  "provider-node",
  "provider",
  "shared",
  "model-option-map",
]) {
  verifySourceDirectory(path.join("packages", packageName, "src"));
}

function verifySourceDirectory(relative) {
  for (const entry of fs.readdirSync(path.join(upstream, relative), {
    withFileTypes: true,
  })) {
    const candidate = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      verifySourceDirectory(candidate);
    } else if (entry.isFile()) {
      const hash = (root) =>
        crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(root, candidate)))
          .digest("hex");
      assert.equal(
        hash(workspace),
        hash(upstream),
        `Prepared reader differs from pinned source: ${candidate}`,
      );
      checkedFiles += 1;
    } else {
      throw new Error(
        `Unexpected linked source in pinned reader: ${candidate}`,
      );
    }
  }
}

const require = createRequire(path.join(workspace, "package.json"));
const { build } = require("esbuild");
const temporaryParent = path.resolve(os.tmpdir());
const temporary = fs.mkdtempSync(
  path.join(temporaryParent, "lolicode-zcode-interop-"),
);
try {
  const decoder = path.join(temporary, "decoder.cjs");
  await build({
    stdin: {
      contents: `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeProviderConfigFile, encodeProviderConfigFile } from './src/provider-config-file-codec.ts';
import { ProviderConfigResolver, ProviderConfigMap, ProviderRegistry, parseZCodeBuiltinProviderConfigRules, parseZCodeBuiltinModelConfigRules } from '@zcode/provider';
import { compileModelOptionMaps } from '../model-option-map/src/option-maps.ts';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const parsed = decodeProviderConfigFile(input);
assert.deepEqual(encodeProviderConfigFile(parsed), input, 'reader canonicalization must not invalidate ownership fragments');
const builtin = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(upstream, "config/provider/zcode-builtin.json"))}, 'utf8'));
const builtinProviders = parseZCodeBuiltinProviderConfigRules(builtin.config.providerConfigRules);
const resolution = new ProviderConfigResolver().resolve({
  zcodeBuiltinProviders: builtinProviders.providers,
  zcodeBuiltinProviderTemplates: builtinProviders.providerTemplates,
  zcodeBuiltinModelRules: parseZCodeBuiltinModelConfigRules(builtin.config.modelConfigRules),
  personalProviders: parsed.providers, personalModels: parsed.models,
  accountProviders: ProviderConfigMap.empty(), personalProviderOrder: parsed.providerOrder,
});
const managedId = parsed.defaultModelSelection.providerId;
assert(/^lolicode(?:-managed(?:-\\d+)?)?$/.test(managedId));
assert(resolution.registryProviders.some(value => value.providerId === managedId), 'generated provider must be executable');
const registry = new ProviderRegistry(resolution.registryProviders);
assert.equal(registry.validateSelection(parsed.defaultModelSelection).ok, true, 'configured default must be selectable');
const model = registry.getModel(managedId, 'channel/model');
assert(model);
const body = compileModelOptionMaps(model.config.optionSpecs).apply({ model: 'channel/model' }, { reasoningLevel: 'medium', maxOutputTokens: 4096 });
assert.equal(body.reasoning_effort, 'medium');
assert.equal(body.max_tokens, 4096);
assert.equal(model.config.properties.inputFormat.supportsImage, true);
assert.equal(model.config.properties.contextWindow, 128000);
assert.equal(encodeProviderConfigFile(parsed).config.providerConfigRules.providerRules.some(value => value.providerId === 'mine'), true);
console.log('UPSTREAM_ZCODE_PERSONAL_OK');
`,
      resolveDir: path.join(workspace, "packages/provider-node"),
      sourcefile: "lolicode-zcode-personal-acceptance.ts",
    },
    outfile: decoder,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "warning",
  });
  const installedCargo = path.join(
    os.homedir(),
    ".cargo",
    "bin",
    process.platform === "win32" ? "cargo.exe" : "cargo",
  );
  const result = spawnSync(
    fs.existsSync(installedCargo) ? installedCargo : "cargo",
    [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--lib",
      "external_zcode_",
    ],
    {
      cwd: repository,
      env: { ...process.env, LOLICODE_ZCODE_DECODER: decoder },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    "Rust writer / upstream reader interoperability failed",
  );
  console.log(
    JSON.stringify({
      result: "passed",
      sourceRevision,
      sourceFilesVerified: checkedFiles,
      fixtures: "synthetic temporary home; no live credentials",
    }),
  );
} finally {
  // Only our mkdtemp child is eligible for recursive cleanup.
  assert.equal(path.dirname(path.resolve(temporary)), temporaryParent);
  assert(path.basename(temporary).startsWith("lolicode-zcode-interop-"));
  fs.rmSync(temporary, { recursive: true, force: true });
}
