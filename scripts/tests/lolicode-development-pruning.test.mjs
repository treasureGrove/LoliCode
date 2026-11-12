import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pruneEmptyDevelopmentRuntimeDirectories } from "../dev/lolicode-development-cache.mjs";

const registrationScript = fileURLToPath(
  new URL("../dev/register-lolicode-development.ps1", import.meta.url),
);
const implementations = [["staging", pruneEmptyDevelopmentRuntimeDirectories]];
if (process.platform === "win32") {
  implementations.push([
    "Windows registration",
    (directory) => {
      // Load only the pure cleanup functions, never registration, processes,
      // shortcuts, or the user's actual installation.
      execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
          $ErrorActionPreference = 'Stop'
          $taskIdentifier = 'art.treasuregrove.lolicode.dev'
          $taskTokens = $null; $taskParseErrors = $null
          $taskAst = [Management.Automation.Language.Parser]::ParseFile($env:LOLICODE_PRUNE_SCRIPT, [ref]$taskTokens, [ref]$taskParseErrors)
          if ($taskParseErrors.Count) { throw 'Registration script parse failed.' }
          foreach ($taskName in @('Read-DevelopmentManifest', 'Remove-EmptyDevelopmentRuntimeDirectories')) {
            $taskFunction = $taskAst.Find({ param($taskNode) $taskNode -is [Management.Automation.Language.FunctionDefinitionAst] -and $taskNode.Name -eq $taskName }, $true)
            if (-not $taskFunction) { throw 'Cleanup function missing.' }
            . ([scriptblock]::Create($taskFunction.Extent.Text))
          }
          Remove-EmptyDevelopmentRuntimeDirectories $env:LOLICODE_PRUNE_FIXTURE
          `,
        ],
        {
          env: {
            ...process.env,
            LOLICODE_PRUNE_SCRIPT: registrationScript,
            LOLICODE_PRUNE_FIXTURE: directory,
          },
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    },
  ]);
}

function fixture(t) {
  const temporary = mkdtempSync(
    path.join(os.tmpdir(), "lolicode-development-pruning-"),
  );
  const links = [];
  t.after(() => {
    // Remove fixture links before recursive cleanup; never traverse their targets.
    for (const link of links) rmSync(link, { force: true });
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.match(path.basename(temporary), /^lolicode-development-pruning-/);
    rmSync(temporary, { recursive: true, force: true });
  });
  const directory = path.join(temporary, "开发 app");
  const modules = path.join(directory, "agent/harness-runtime/node_modules");
  const write = (file, content) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const link = (target, destination) => {
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(
      target,
      destination,
      process.platform === "win32" ? "junction" : "dir",
    );
    links.push(destination);
  };
  const manifest = {
    identifier: "art.treasuregrove.lolicode.dev",
    channel: "development",
    appName: "LoliCode Dev",
    // The old nested files are already absent from the updated manifest.
    files: [
      "agent/harness-runtime/node_modules/zod/package.json",
      "agent/harness-runtime/node_modules/zod/index.js",
      "agent/harness-runtime/node_modules/@deepseek-ai/consumer/entry.mjs",
    ],
  };
  write(
    path.join(directory, "development-build.json"),
    JSON.stringify(manifest),
  );
  return { temporary, directory, modules, write, link, manifest };
}

for (const [name, prune] of implementations) {
  test(`${name} removes old empty package trees so Node imports the hoisted dependency`, (t) => {
    const f = fixture(t);
    f.write(
      path.join(f.modules, "zod/package.json"),
      JSON.stringify({ name: "zod", type: "module", exports: "./index.js" }),
    );
    f.write(
      path.join(f.modules, "zod/index.js"),
      'export const version = "4.6.6";',
    );
    const consumer = path.join(f.modules, "@deepseek-ai/consumer");
    const entry = path.join(consumer, "entry.mjs");
    f.write(entry, 'import { version } from "zod"; console.log(version);');
    const stale = path.join(consumer, "node_modules/zod");
    for (const relative of [
      "locales",
      "mini",
      "src/v4/core",
      "v3",
      "v4",
      "v4-mini",
    ])
      mkdirSync(path.join(stale, relative), { recursive: true });
    const unknown = path.join(consumer, "node_modules/unknown/notes.txt");
    f.write(unknown, "extra file preserved");
    const unrelated = path.join(f.directory, "user-data/empty-session");
    mkdirSync(unrelated, { recursive: true });
    const before = spawnSync(process.execPath, [entry], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(before.status, 0);
    assert.match(before.stderr, /ERR_MODULE_NOT_FOUND/);

    prune(f.directory);

    assert.equal(existsSync(stale), false);
    assert.equal(readFileSync(unknown, "utf8"), "extra file preserved");
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(f.modules), true);
    assert.deepEqual(
      JSON.parse(
        readFileSync(path.join(f.directory, "development-build.json")),
      ),
      f.manifest,
    );
    assert.equal(
      execFileSync(process.execPath, [entry], {
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      "4.6.6",
    );
    prune(f.directory); // The recovery remains safe on repeated registration.
  });

  test(`${name} preserves unknown files and does not follow nested directory links`, (t) => {
    const f = fixture(t);
    const unknown = path.join(f.modules, "unknown-package/local-file.txt");
    f.write(unknown, "keep this");
    const outside = path.join(f.temporary, "outside-installation");
    const emptyOutside = path.join(outside, "empty/child");
    mkdirSync(emptyOutside, { recursive: true });
    f.write(path.join(outside, "data.txt"), "outside data");
    const linked = path.join(f.modules, "link-parent/linked-package");
    f.link(outside, linked);
    prune(f.directory);
    assert.equal(readFileSync(unknown, "utf8"), "keep this");
    assert.equal(lstatSync(linked).isSymbolicLink(), true);
    assert.equal(existsSync(emptyOutside), true);
    assert.equal(
      readFileSync(path.join(outside, "data.txt"), "utf8"),
      "outside data",
    );
  });

  for (const relative of [
    "",
    "agent",
    "agent/harness-runtime",
    "agent/harness-runtime/node_modules",
  ]) {
    test(`${name} refuses a linked cleanup root at ${relative || "app"}`, (t) => {
      const f = fixture(t);
      const outside = path.join(f.temporary, "outside-installation");
      mkdirSync(path.join(outside, "empty/child"), { recursive: true });
      let directory = f.directory;
      const linked = relative
        ? path.join(f.directory, relative)
        : path.join(f.temporary, "linked-app");
      f.link(outside, linked);
      if (!relative) directory = linked;
      assert.throws(
        () => prune(directory),
        /Unsafe development runtime cleanup root/,
      );
      assert.equal(lstatSync(linked).isSymbolicLink(), true);
      assert.equal(existsSync(path.join(outside, "empty/child")), true);
    });
  }

  test(`${name} refuses to clean a directory owned by another app`, (t) => {
    const f = fixture(t);
    const empty = path.join(f.modules, "empty/child");
    mkdirSync(empty, { recursive: true });
    f.write(
      path.join(f.directory, "development-build.json"),
      JSON.stringify({ ...f.manifest, identifier: "other-app" }),
    );
    assert.throws(() => prune(f.directory));
    assert.equal(existsSync(empty), true);
  });
}
