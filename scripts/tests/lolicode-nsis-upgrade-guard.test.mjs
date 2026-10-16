import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const configPath = path.join(repositoryRoot, "src-tauri", "tauri.conf.json");
const hooksPath = path.join(
  repositoryRoot,
  "src-tauri",
  "nsis",
  "lolicode-installer-hooks.nsh",
);
const guardPath = path.join(
  repositoryRoot,
  "src-tauri",
  "nsis",
  "lolicode-process-guard.ps1",
);
const powershell = process.env.POWERSHELL_EXE ?? "powershell.exe";
const powershellAvailable =
  spawnSync(powershell, ["-NoLogo", "-NoProfile", "-Command", "exit 0"], {
    encoding: "utf8",
    windowsHide: true,
  }).status === 0;
const makensis =
  process.env.NSIS_MAKENSIS ??
  path.join(process.env.LOCALAPPDATA ?? "", "tauri", "NSIS", "makensis.exe");

function runFixture({
  installDirectory,
  binaryName,
  processes,
  candidateIds = [],
  currentProcesses = [],
}) {
  const tempDirectory = mkdtempSync(
    path.join(os.tmpdir(), "lolicode-nsis-guard-"),
  );
  const fixturePath = path.join(tempDirectory, "processes.json");
  try {
    writeFileSync(
      fixturePath,
      JSON.stringify({ processes, candidateIds, currentProcesses }),
      "utf8",
    );
    const result = spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        guardPath,
        "-InstallDirectory",
        installDirectory,
        "-BinaryName",
        binaryName,
        "-Fixture",
        "-FixturePath",
        fixturePath,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim());
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

test("NSIS uses the scoped process guard and keeps app data handling unchanged", () => {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(config.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(
    config.bundle.windows.nsis.installerHooks,
    "nsis/lolicode-installer-hooks.nsh",
  );

  const hooks = readFileSync(hooksPath, "utf8");
  assert.match(hooks, /ReadRegStr \$OldMainBinaryName SHCTX .*MainBinaryName/);
  assert.match(hooks, /WriteRegStr SHCTX .*MainBinaryName.*""/);
  assert.match(hooks, /tai-switch\.exe/);
  assert.match(hooks, /!macro \/redef CheckIfAppIsRunning/);
  assert.match(hooks, /lolicode-process-guard\.ps1/);
  assert.match(hooks, /Close it manually and retry/);
  assert.doesNotMatch(
    hooks,
    /DeleteRegKey|RmDir|CreateShortcut|DeleteShortcut/,
  );
});

test(
  "NSIS hook macros compile against Tauri's process-check hook points",
  { skip: !existsSync(makensis) },
  () => {
    const nsisDirectory = path.dirname(makensis);
    const logicLib = path.join(nsisDirectory, "Include", "LogicLib.nsh");
    const tempDirectory = mkdtempSync(
      path.join(os.tmpdir(), "lolicode-nsis-preprocess-"),
    );
    const fixturePath = path.join(tempDirectory, "installer-hook-fixture.nsi");

    try {
      const fixture = [
        "Unicode true",
        `!include "${logicLib}"`,
        "!macro CheckIfAppIsRunning executableName productName",
        '  DetailPrint "Default process check: ${executableName}"',
        "!macroend",
        `!include "${hooksPath}"`,
        '!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LoliCode"',
        '!define PRODUCTNAME "LoliCode"',
        "Var OldMainBinaryName",
        `OutFile "${path.join(tempDirectory, "lolicode-nsis-hook-fixture.exe")}"`,
        'Section "Install"',
        '  StrCpy $INSTDIR "$TEMP\\LoliCodeFixture"',
        "  !insertmacro NSIS_HOOK_PREINSTALL",
        '  !insertmacro CheckIfAppIsRunning "LoliCode.exe" "LoliCode"',
        "SectionEnd",
        'Section "Uninstall"',
        "  !insertmacro NSIS_HOOK_PREUNINSTALL",
        '  !insertmacro CheckIfAppIsRunning "LoliCode.exe" "LoliCode"',
        "SectionEnd",
        "",
      ].join("\n");
      writeFileSync(fixturePath, fixture, "utf8");

      const outputPath = path.join(
        tempDirectory,
        "lolicode-nsis-hook-fixture.exe",
      );
      const result = spawnSync(makensis, ["/V1", fixturePath], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(outputPath), true);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "fixture process selection is limited to known executables in the exact install directory",
  { skip: !powershellAvailable },
  () => {
    const installDirectory =
      "C:\\Users\\fixture\\AppData\\Local\\Programs\\LoliCode";
    const result = runFixture({
      installDirectory,
      binaryName: "tai-switch.exe",
      processes: [
        {
          ProcessId: 101,
          Name: "tai-switch.exe",
          ExecutablePath: `${installDirectory}\\tai-switch.exe`,
        },
        {
          ProcessId: 102,
          Name: "tai-switch.exe",
          ExecutablePath: "C:\\Other\\tai-switch.exe",
        },
        {
          ProcessId: 103,
          Name: "LoliCode.exe",
          ExecutablePath: `${installDirectory}\\LoliCode.exe`,
        },
        {
          ProcessId: 104,
          Name: "other.exe",
          ExecutablePath: `${installDirectory}\\other.exe`,
        },
      ],
    });

    assert.deepEqual(result.MatchedIds, [101]);
    assert.deepEqual(result.Unresolved, []);
  },
);

test(
  "fixture process selection is case-insensitive for Windows paths",
  { skip: !powershellAvailable },
  () => {
    const installDirectory =
      "C:\\Users\\fixture\\AppData\\Local\\Programs\\LoliCode";
    const result = runFixture({
      installDirectory,
      binaryName: "LoliCode.exe",
      processes: [
        {
          ProcessId: 201,
          Name: "lolicode.exe",
          ExecutablePath:
            "c:\\users\\FIXTURE\\appdata\\local\\programs\\lolicode\\LOLICODE.EXE",
        },
      ],
    });

    assert.deepEqual(result.MatchedIds, [201]);
  },
);

test(
  "fixture process selection reports a same-name process whose path cannot be verified",
  { skip: !powershellAvailable },
  () => {
    const result = runFixture({
      installDirectory:
        "C:\\Users\\fixture\\AppData\\Local\\Programs\\LoliCode",
      binaryName: "LoliCode.exe",
      processes: [
        { ProcessId: 301, Name: "LoliCode.exe", ExecutablePath: null },
      ],
    });

    assert.deepEqual(result.MatchedIds, []);
    assert.deepEqual(result.Unresolved, [301]);
  },
);

test(
  "fixture PID revalidation rejects a reused PID from a different executable path",
  { skip: !powershellAvailable },
  () => {
    const installDirectory =
      "C:\\Users\\fixture\\AppData\\Local\\Programs\\LoliCode";
    const result = runFixture({
      installDirectory,
      binaryName: "LoliCode.exe",
      processes: [
        {
          ProcessId: 401,
          Name: "LoliCode.exe",
          ExecutablePath: `${installDirectory}\\LoliCode.exe`,
        },
      ],
      candidateIds: [401, 402, 403, 404, 405],
      currentProcesses: [
        {
          ProcessId: 401,
          Name: "LoliCode.exe",
          ExecutablePath: "C:\\Other\\LoliCode.exe",
        },
        {
          ProcessId: 402,
          Name: "LoliCode.exe",
          ExecutablePath: `${installDirectory}\\LoliCode.exe`,
        },
        {
          ProcessId: 403,
          Name: "other.exe",
          ExecutablePath: `${installDirectory}\\other.exe`,
        },
        { ProcessId: 405, Name: "LoliCode.exe", ExecutablePath: null },
      ],
    });

    assert.deepEqual(result.CandidateChecks, [
      { ProcessId: 401, Status: "different-path" },
      { ProcessId: 402, Status: "match" },
      { ProcessId: 403, Status: "different-name" },
      { ProcessId: 404, Status: "exited" },
      { ProcessId: 405, Status: "unresolved" },
    ]);
  },
);

test(
  "live guard smoke only blocks a private tai-switch.exe in the install directory",
  { skip: !powershellAvailable || process.platform !== "win32" },
  () => {
    const tempDirectory = mkdtempSync(
      path.join(os.tmpdir(), "lolicode-nsis-live-guard-"),
    );
    const installDirectory = path.join(tempDirectory, "install");
    const otherDirectory = path.join(tempDirectory, "other");
    const installExe = path.join(installDirectory, "tai-switch.exe");
    const otherExe = path.join(otherDirectory, "tai-switch.exe");
    mkdirSync(installDirectory);
    mkdirSync(otherDirectory);
    let otherPid;
    let installPid;

    const runPowershell = (script, environment = {}) =>
      spawnSync(powershell, ["-NoLogo", "-NoProfile", "-Command", script], {
        encoding: "utf8",
        env: { ...process.env, ...environment },
        windowsHide: true,
      });

    const startFixtureProcess = (executablePath) => {
      const result = runPowershell(
        [
          "$process = Start-Process -FilePath $env:LOLICODE_GUARD_EXE -PassThru -WindowStyle Hidden",
          "$expected = [System.IO.Path]::GetFullPath($env:LOLICODE_GUARD_EXE)",
          "$deadline = [DateTime]::UtcNow.AddSeconds(5)",
          "do {",
          '  $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($process.Id)"',
          "  if ($current.ExecutablePath -and [string]::Equals([System.IO.Path]::GetFullPath($current.ExecutablePath), $expected, [System.StringComparison]::OrdinalIgnoreCase)) { Write-Output $process.Id; exit 0 }",
          "  Start-Sleep -Milliseconds 100",
          "} while ([DateTime]::UtcNow -lt $deadline)",
          "throw 'The private fixture process did not start at the expected path.'",
        ].join("; "),
        { LOLICODE_GUARD_EXE: executablePath },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return Number(result.stdout.trim());
    };

    const getGuardExitCode = () => {
      const result = spawnSync(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          guardPath,
          "-InstallDirectory",
          installDirectory,
          "-BinaryName",
          "tai-switch.exe",
          "-Silent",
        ],
        { encoding: "utf8", windowsHide: true },
      );
      assert.equal(result.error, undefined, result.error?.message);
      return result.status;
    };

    const stopFixtureProcess = (processId, executablePath) => {
      if (!processId) return;
      const result = runPowershell(
        [
          "$expected = [System.IO.Path]::GetFullPath($env:LOLICODE_GUARD_EXE)",
          '$current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $env:LOLICODE_GUARD_PID"',
          "if (-not $current) { exit 0 }",
          "if (-not $current.ExecutablePath -or -not [string]::Equals([System.IO.Path]::GetFullPath($current.ExecutablePath), $expected, [System.StringComparison]::OrdinalIgnoreCase)) { exit 10 }",
          "$process = Get-Process -Id ([int] $env:LOLICODE_GUARD_PID)",
          "if (-not [string]::Equals([System.IO.Path]::GetFullPath($process.Path), $expected, [System.StringComparison]::OrdinalIgnoreCase)) { exit 11 }",
          "$process.Kill()",
          "$null = $process.WaitForExit(5000)",
        ].join("; "),
        {
          LOLICODE_GUARD_EXE: executablePath,
          LOLICODE_GUARD_PID: String(processId),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };

    const assertFixtureRunning = (processId, executablePath) => {
      const result = runPowershell(
        [
          "$expected = [System.IO.Path]::GetFullPath($env:LOLICODE_GUARD_EXE)",
          '$current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $env:LOLICODE_GUARD_PID"',
          "if ($current.ExecutablePath -and [string]::Equals([System.IO.Path]::GetFullPath($current.ExecutablePath), $expected, [System.StringComparison]::OrdinalIgnoreCase)) { exit 0 }",
          "exit 1",
        ].join("; "),
        {
          LOLICODE_GUARD_EXE: executablePath,
          LOLICODE_GUARD_PID: String(processId),
        },
      );
      assert.equal(
        result.status,
        0,
        result.stderr || "Fixture process exited unexpectedly.",
      );
    };

    try {
      const compile = runPowershell(
        [
          "$source = @'",
          "using System.Threading;",
          "public class FixtureSleep { public static void Main() { Thread.Sleep(120000); } }",
          "'@",
          "Add-Type -TypeDefinition $source -OutputType ConsoleApplication -OutputAssembly $env:LOLICODE_GUARD_EXE",
        ].join("\n"),
        { LOLICODE_GUARD_EXE: installExe },
      );
      assert.equal(compile.status, 0, compile.stderr || compile.stdout);
      copyFileSync(installExe, otherExe);

      otherPid = startFixtureProcess(otherExe);
      assert.equal(getGuardExitCode(), 0);
      assertFixtureRunning(otherPid, otherExe);
      installPid = startFixtureProcess(installExe);
      assert.equal(getGuardExitCode(), 1);
      assertFixtureRunning(installPid, installExe);

      stopFixtureProcess(otherPid, otherExe);
      otherPid = undefined;
      stopFixtureProcess(installPid, installExe);
      installPid = undefined;
      assert.equal(getGuardExitCode(), 0);
    } finally {
      if (otherPid) stopFixtureProcess(otherPid, otherExe);
      if (installPid) stopFixtureProcess(installPid, installExe);
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "unknown registered executable names are rejected before path use",
  { skip: !powershellAvailable },
  () => {
    const result = spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        guardPath,
        "-InstallDirectory",
        "C:\\Users\\fixture\\AppData\\Local\\Programs\\LoliCode",
        "-BinaryName",
        "..\\outside.exe",
        "-Fixture",
        "-FixturePath",
        "unused.json",
      ],
      { encoding: "utf8", windowsHide: true },
    );

    assert.equal(result.status, 20);
  },
);
