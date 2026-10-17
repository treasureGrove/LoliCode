import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
const generatedScript = process.env.LOLICODE_NSIS_GENERATED_SCRIPT;
const expectedVersion = process.env.LOLICODE_NSIS_EXPECTED_VERSION ?? "4.0.19";
const makensis =
  process.env.NSIS_MAKENSIS ??
  path.join(process.env.LOCALAPPDATA ?? "", "tauri/NSIS/makensis.exe");
const hooksPath = path.join(
  repositoryRoot,
  "src-tauri/nsis/lolicode-installer-hooks.nsh",
);

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

// Never interpolate instructions from the generated installer. Only validated
// regular input files and relative payload destinations enter the fixture.
function workspaceFile(candidate) {
  assert(path.isAbsolute(candidate), `Source must be absolute: ${candidate}`);
  const absolute = path.resolve(candidate);
  assert(
    isWithin(repositoryRoot, absolute),
    `Source leaves workspace: ${candidate}`,
  );
  // Build checkouts may alias the shared target cache with a junction. Resolve
  // that read-only alias first, then allow only canonical workspace sources.
  const canonicalRoot = realpathSync(repositoryRoot);
  const canonical = realpathSync(absolute);
  assert(
    isWithin(canonicalRoot, canonical),
    `Resolved source leaves workspace: ${candidate}`,
  );
  const relative = path.relative(canonicalRoot, canonical);
  let current = canonicalRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    assert(
      !lstatSync(current).isSymbolicLink(),
      `Source traverses a link: ${current}`,
    );
  }
  assert(
    lstatSync(canonical).isFile(),
    `Source is not a regular file: ${candidate}`,
  );
  assert(
    !/[\r\n\0"$]/u.test(canonical),
    "Source contains unsupported NSIS syntax",
  );
  return canonical;
}

function relativeDestination(candidate) {
  assert(candidate.length > 0 && !path.win32.isAbsolute(candidate));
  assert(
    !/[\x00-\x1f"$:/<>|?*]/u.test(candidate),
    `Unsafe destination: ${candidate}`,
  );
  for (const component of candidate.split("\\")) {
    assert(component !== "" && component !== "." && component !== "..");
    assert(
      !/[. ]$/u.test(component),
      `Ambiguous Windows destination: ${candidate}`,
    );
    assert(
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(component),
      `Windows device destination: ${candidate}`,
    );
  }
  return candidate;
}

function quoted(value) {
  return value.replaceAll("$", () => "$$").replaceAll('"', () => '$\\"');
}

function sha256(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function payloadFromGeneratedScript(filename) {
  const source = readFileSync(workspaceFile(filename), "utf8");
  const bundledHookIncludes = [
    ...source.matchAll(
      /^!include "([^"\r\n]*lolicode-installer-hooks\.nsh)"\r?$/gmu,
    ),
  ];
  assert.equal(
    bundledHookIncludes.length,
    1,
    "Verify the hook used by this actual generated installer",
  );
  const bundledHooks = workspaceFile(bundledHookIncludes[0][1]);
  assert.equal(
    readFileSync(bundledHooks, "utf8").replaceAll("\r\n", "\n"),
    readFileSync(hooksPath, "utf8").replaceAll("\r\n", "\n"),
    "Generated installer must use the reviewed hook, not a stale build copy",
  );
  workspaceFile(
    path.join(path.dirname(bundledHooks), "lolicode-process-guard.ps1"),
  );
  const version = source.match(/^!define VERSION "([^"\r\n]+)"\r?$/mu)?.[1];
  assert.equal(
    version,
    expectedVersion,
    "Generated installer must be the intended release",
  );
  assert.equal(
    source.match(/^!define MAINBINARYNAME "([^"\r\n]+)"\r?$/mu)?.[1],
    "LoliCode",
  );
  const executable = source.match(
    /^!define MAINBINARYSRCPATH "([^"\r\n]+)"\r?$/mu,
  )?.[1];
  assert(executable, "Generated installer must declare its actual executable");
  assert.equal(path.win32.basename(executable), "LoliCode.exe");
  const section = source.match(
    /^Section Install\r?\n([\s\S]*?)^SectionEnd\r?$/mu,
  )?.[1];
  assert(
    section,
    "Generated installer must have exactly named Install section",
  );
  const block = section.match(
    /; Copy main executable\r?\n([\s\S]*?); Copy external binaries/u,
  )?.[1];
  assert(
    block,
    "Generated payload boundaries are missing; review the new Tauri layout",
  );
  const external = section.match(
    /; Copy external binaries\r?\n([\s\S]*?); Create file associations/u,
  )?.[1];
  assert.notEqual(
    external,
    undefined,
    "Generated external payload boundary is missing",
  );
  assert(
    external
      .split(/\r?\n/u)
      .every((line) => !line.trim() || line.trim().startsWith(";")),
    "External binary payload requires explicit fixture support",
  );

  const files = [];
  const operations = [];
  const destinations = new Set();
  for (const raw of block.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    if (line === 'File "${MAINBINARYSRCPATH}"') {
      assert(!files.some((file) => file.destination === "LoliCode.exe"));
      const file = {
        destination: "LoliCode.exe",
        source: workspaceFile(executable),
      };
      files.push(file);
      operations.push({ type: "file", ...file });
      continue;
    }
    const directory = line.match(/^CreateDirectory "\$INSTDIR\\([^"\r\n]+)"$/u);
    if (directory) {
      operations.push({
        type: "directory",
        destination: relativeDestination(directory[1]),
      });
      continue;
    }
    const resource = line.match(
      /^File \/a "\/oname=([^"\r\n]+)" "([^"\r\n]+)"$/u,
    );
    assert(resource, `Unrecognized generated payload instruction: ${line}`);
    const destination = relativeDestination(resource[1]);
    assert.notEqual(destination.toLowerCase(), "lolicode.exe");
    assert(
      !destinations.has(destination.toLowerCase()),
      `Duplicate destination: ${destination}`,
    );
    destinations.add(destination.toLowerCase());
    const file = { destination, source: workspaceFile(resource[2]) };
    files.push(file);
    operations.push({ type: "file", ...file });
  }
  assert.equal(
    files.filter((file) => file.destination === "LoliCode.exe").length,
    1,
  );
  assert(
    files.some((file) => file.destination === "agent\\extensions\\LICENSE"),
  );
  assert(
    files.some(
      (file) => file.destination === "agent\\extensions\\manifest.json",
    ),
  );
  assert(
    files.filter((file) =>
      /(?:^|\\)LICENSE(?:\.[^\\]+)?$/iu.test(file.destination),
    ).length >= 5,
  );
  return { files, operations, version, hooksPath: bundledHooks };
}

function run(command, args, options, label) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 90000,
    ...options,
  });
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `${label}: exit=${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

function installedFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = prefix ? `${prefix}\\${entry.name}` : entry.name;
    assert(
      !lstatSync(absolute).isSymbolicLink(),
      "Fixture must not create links",
    );
    if (entry.isDirectory()) files.push(...installedFiles(absolute, relative));
    else {
      assert(entry.isFile(), `Unexpected installed object: ${relative}`);
      files.push(relative);
    }
  }
  return files;
}

const skipReason = !generatedScript
  ? "Set LOLICODE_NSIS_GENERATED_SCRIPT to the final release installer.nsi to verify its real payload"
  : process.platform !== "win32"
    ? "Real NSIS payload execution requires Windows"
    : false;

test(
  "final NSIS payload extracts every real file into the install directory and passes the packaged runtime check",
  { skip: skipReason, timeout: 240000 },
  (context) => {
    assert(existsSync(makensis), `NSIS compiler not found: ${makensis}`);
    const payload = payloadFromGeneratedScript(path.resolve(generatedScript));
    const expectedHashes = new Map(
      payload.files.map((file) => [file.destination, sha256(file.source)]),
    );
    const temporaryParent = realpathSync(os.tmpdir());
    const temporary = mkdtempSync(
      path.join(temporaryParent, "lolicode-built-payload-"),
    );
    try {
      const destination = path.join(temporary, "首次 安装 中文", "LoliCode");
      const childTemporary = path.join(temporary, "child-temp");
      mkdirSync(childTemporary);
      const fixture = path.join(temporary, "payload-fixture.nsi");
      const installer = path.join(temporary, "payload-fixture.exe");
      const registryKey = `Software\\LoliCodeBuiltPayloadFixture\\${path.basename(temporary)}`;
      const isolatedEnvironment = {
        ...process.env,
        TEMP: childTemporary,
        TMP: childTemporary,
        USERPROFILE: path.join(temporary, "profile"),
        HOME: path.join(temporary, "profile"),
        APPDATA: path.join(temporary, "profile/AppData/Roaming"),
        LOCALAPPDATA: path.join(temporary, "profile/AppData/Local"),
        LOLICODE_FIXTURE_REGISTRY_KEY: registryKey,
      };
      for (const directory of [
        isolatedEnvironment.APPDATA,
        isolatedEnvironment.LOCALAPPDATA,
      ]) {
        mkdirSync(directory, { recursive: true });
      }
      const assertNoRegistryKey = () =>
        run(
          process.env.POWERSHELL_EXE ?? "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "if (Test-Path -LiteralPath ('Registry::HKEY_CURRENT_USER\\' + $env:LOLICODE_FIXTURE_REGISTRY_KEY)) { exit 91 }; exit 0",
          ],
          { env: isolatedEnvironment },
          "Fixture registration must remain absent",
        );
      assertNoRegistryKey();
      const lines = [
        "Unicode true",
        "RequestExecutionLevel user",
        "SilentInstall silent",
        "AutoCloseWindow true",
        "ShowInstDetails nevershow",
        `!include "${quoted(path.join(path.dirname(makensis), "Include/LogicLib.nsh"))}"`,
        "!macro CheckIfAppIsRunning executableName productName",
        "!macroend",
        `!include "${quoted(payload.hooksPath)}"`,
        // A fresh random private registry key is read only by PREINSTALL. No
        // production uninstall registration or installer instructions are run.
        `!define UNINSTKEY "${quoted(registryKey)}"`,
        "Var OldMainBinaryName",
        `OutFile "${quoted(installer)}"`,
        `InstallDir "${quoted(destination)}"`,
        'Section "PayloadFixture"',
        "  SetShellVarContext current",
        "  SetOutPath $INSTDIR",
        "  !insertmacro NSIS_HOOK_PREINSTALL",
        "  StrCmp $OUTDIR $INSTDIR +3 0",
        "  SetErrorLevel 73",
        "  Quit",
        '  IfFileExists "$PLUGINSDIR\\lolicode-process-guard.ps1" +3 0',
        "  SetErrorLevel 74",
        "  Quit",
        '  !insertmacro CheckIfAppIsRunning "LoliCode.exe" "LoliCode"',
      ];
      for (const operation of payload.operations) {
        if (operation.type === "directory") {
          lines.push(
            `  CreateDirectory "$INSTDIR\\${quoted(operation.destination)}"`,
          );
        } else {
          lines.push(
            `  File /a "/oname=${quoted(operation.destination)}" "${quoted(operation.source)}"`,
          );
        }
      }
      lines.push(
        '  IfFileExists "$PLUGINSDIR\\LoliCode.exe" 0 +3',
        "  SetErrorLevel 76",
        "  Quit",
        '  IfFileExists "$PLUGINSDIR\\agent" 0 +3',
        "  SetErrorLevel 77",
        "  Quit",
        "  SetErrorLevel 0",
        "SectionEnd",
        "",
      );
      writeFileSync(fixture, "\uFEFF" + lines.join("\n"));
      run(makensis, ["/V1", fixture], {}, "Compile real payload fixture");
      assert(
        !existsSync(destination),
        "Fresh installation destination must not exist",
      );
      for (const round of ["fresh install", "reinstall"]) {
        run(
          installer,
          ["/S"],
          { env: isolatedEnvironment },
          `${round}: actual NSIS resource extraction`,
        );
        for (const [relative, expectedHash] of expectedHashes) {
          const installed = path.resolve(destination, ...relative.split("\\"));
          assert(isWithin(destination, installed));
          assert.equal(
            sha256(installed),
            expectedHash,
            `${round}: ${relative}`,
          );
        }
        const actual = installedFiles(destination)
          .filter((file) => file !== "user-sentinel.txt")
          .sort();
        assert.deepEqual(
          actual,
          [...expectedHashes.keys()].sort(),
          `${round}: no payload may be omitted or added`,
        );
        if (round === "fresh install") {
          writeFileSync(
            path.join(destination, "user-sentinel.txt"),
            "preserve user file",
          );
        }
      }
      assert.equal(
        readFileSync(path.join(destination, "user-sentinel.txt"), "utf8"),
        "preserve user file",
      );
      assertNoRegistryKey();

      // This opt-in main() branch runs before Tauri initialization. It uses a
      // loopback fake model and isolated temporary projects, never real tokens.
      const runtime = run(
        path.join(destination, "LoliCode.exe"),
        ["--check-agent-runtime"],
        { cwd: destination, env: isolatedEnvironment },
        "Extracted release executable offline runtime check",
      );
      const reports = runtime.stdout
        .split(/\r?\n/u)
        .filter((line) => line.trim().startsWith("{"));
      assert.equal(
        reports.length,
        1,
        "Runtime must return one structured check report",
      );
      const report = JSON.parse(reports[0]);
      assert.equal(report.product, "LoliCode");
      assert.equal(report.version, payload.version);
      assert.equal(report.engine, "rust-in-process");
      assert.equal(report.passed, true);
      assert.equal(report.paidCalls, 0);
      assert.equal(report.userConfigurationRead, false);
      assert.equal(report.temporaryProjectsOnly, true);
      assert.equal(report.nativeEngineProcessSpawned, false);
      assert.equal(report.realReadWriteAndContinuation, true);
      assert.equal(report.sessionRestartVerified, true);
      assert(report.defaultSkillsVerified >= 5);
      const licenses = payload.files.filter((file) =>
        /(?:^|\\)LICENSE(?:\.[^\\]+)?$/iu.test(file.destination),
      );
      context.diagnostic(
        `${payload.version}: ${payload.files.length} actual payload files and ${licenses.length} licenses hash-verified twice; extracted executable offline check passed; paidCalls=0; userConfigurationRead=false`,
      );
    } finally {
      const resolved = path.resolve(temporary);
      assert.equal(
        path.dirname(resolved).toLowerCase(),
        temporaryParent.toLowerCase(),
      );
      assert(path.basename(resolved).startsWith("lolicode-built-payload-"));
      assert(!lstatSync(resolved).isSymbolicLink());
      rmSync(resolved, { recursive: true, force: true });
    }
  },
);
