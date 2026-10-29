import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultOutput,
  exportRelayChannelPresets,
  loadChannelPresetSource,
  relayPresetDocument,
} from "../data/export-relay-channel-presets.mjs";

test("committed relay catalog matches the current desktop API-key presets and common order", async () => {
  const source = await loadChannelPresetSource();
  const committed = JSON.parse(await readFile(defaultOutput, "utf8"));
  assert.equal(committed.version, 1);
  assert.deepEqual(
    committed.presets,
    JSON.parse(JSON.stringify(source.presets)),
  );
  assert.deepEqual(committed.commonIds, source.commonIds);
  assert.deepEqual(
    new Set(committed.presets.map((preset) => preset.protocol)),
    new Set(["openai_chat", "openai_responses", "anthropic", "gemini_native"]),
  );
  assert.ok(
    committed.presets.every((preset) => !preset.id.startsWith("account:")),
  );
  await exportRelayChannelPresets({ check: true });
});

test("the public export drops credentials, model lists and other private configuration", () => {
  const document = relayPresetDocument({
    presets: [
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://example.invalid/v1",
        protocol: "openai_chat",
        icon: "openai",
        apiKey: "private-key-fixture",
        models: [{ id: "private-model-fixture" }],
        settingsConfig: { token: "private-token-fixture" },
      },
    ],
    commonIds: ["fixture"],
  });
  assert.deepEqual(Object.keys(document.presets[0]), [
    "id",
    "name",
    "baseUrl",
    "protocol",
    "icon",
  ]);
  assert.doesNotMatch(
    JSON.stringify(document),
    /private-|apiKey|settingsConfig|models/,
  );
});

test("a stale export is rejected without writing and regeneration restores consistency", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "lolicode-relay-presets-"),
  );
  const output = path.join(directory, "channel-presets.json");
  context.after(async () => {
    await rm(output, { force: true });
    await rmdir(directory);
  });
  await exportRelayChannelPresets({ output });
  const current = await readFile(output, "utf8");
  const outdated = JSON.parse(current);
  outdated.presets[0].name = "Outdated exported name";
  const stale = JSON.stringify(outdated);
  await writeFile(output, stale);
  await assert.rejects(
    exportRelayChannelPresets({ output, check: true }),
    /out of date/,
  );
  assert.equal(await readFile(output, "utf8"), stale);
  assert.equal((await exportRelayChannelPresets({ output })).changed, true);
  assert.equal(await readFile(output, "utf8"), current);
  assert.equal(
    (await exportRelayChannelPresets({ output, check: true })).changed,
    false,
  );
});
