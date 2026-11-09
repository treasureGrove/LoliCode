import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test(
  "Windows development install reuses unchanged files and verifies bootstrap bytes",
  { skip: process.platform !== "win32" },
  () => {
    const temporary = mkdtempSync(
      path.join(os.tmpdir(), "lolicode-development-copy-"),
    );
    try {
      const script = fileURLToPath(
        new URL("../dev/register-lolicode-development.ps1", import.meta.url),
      );
      const result = execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
      $taskTokens = $null; $taskParseErrors = $null
      $taskAst = [Management.Automation.Language.Parser]::ParseFile($env:LOLICODE_COPY_SCRIPT, [ref]$taskTokens, [ref]$taskParseErrors)
      if ($taskParseErrors.Count) { throw 'Registration script parse failed.' }
      $taskFunction = $taskAst.Find({ param($taskNode) $taskNode -is [Management.Automation.Language.FunctionDefinitionAst] -and $taskNode.Name -eq 'Copy-DevelopmentFile' }, $true)
      . ([scriptblock]::Create($taskFunction.Extent.Text))
      $taskSource = Join-Path $env:LOLICODE_COPY_FIXTURE 'source.txt'
      $taskDestination = Join-Path $env:LOLICODE_COPY_FIXTURE 'installed/file.txt'
      [IO.File]::WriteAllText($taskSource, 'original')
      [IO.File]::SetLastWriteTimeUtc($taskSource, [datetime]'2001-01-01T00:00:00Z')
      $taskFirst = Copy-DevelopmentFile $taskSource $taskDestination
      $taskAgain = Copy-DevelopmentFile $taskSource $taskDestination
      $taskBefore = [IO.File]::GetLastWriteTimeUtc($taskDestination)
      [IO.File]::WriteAllText($taskDestination, 'tampered')
      [IO.File]::SetLastWriteTimeUtc($taskDestination, $taskBefore)
      $taskRepaired = Copy-DevelopmentFile $taskSource $taskDestination $true
      $taskVerified = Copy-DevelopmentFile $taskSource $taskDestination $true
      [IO.File]::WriteAllText($taskSource, 'new version')
      $taskChanged = Copy-DevelopmentFile $taskSource $taskDestination
      @{ first=$taskFirst; again=$taskAgain; repaired=$taskRepaired; verified=$taskVerified; changed=$taskChanged; content=[IO.File]::ReadAllText($taskDestination) } | ConvertTo-Json -Compress
    `,
        ],
        {
          env: {
            ...process.env,
            LOLICODE_COPY_SCRIPT: script,
            LOLICODE_COPY_FIXTURE: temporary,
          },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      assert.deepEqual(JSON.parse(result), {
        first: true,
        again: false,
        repaired: true,
        verified: false,
        changed: true,
        content: "new version",
      });
    } finally {
      const resolved = realpathSync(temporary);
      assert.equal(
        path.dirname(resolved).toLowerCase(),
        realpathSync(os.tmpdir()).toLowerCase(),
      );
      assert.ok(
        path.basename(resolved).startsWith("lolicode-development-copy-"),
      );
      rmSync(resolved, { recursive: true });
    }
  },
);
