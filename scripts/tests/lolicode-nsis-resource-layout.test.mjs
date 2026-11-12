import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
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

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const hooks =
  process.env.LOLICODE_NSIS_HOOKS_PATH ??
  path.join(root, "src-tauri/nsis/lolicode-installer-hooks.nsh");
const makensis =
  process.env.NSIS_MAKENSIS ??
  path.join(process.env.LOCALAPPDATA ?? "", "tauri/NSIS/makensis.exe");
const nsisAvailable = process.platform === "win32" && existsSync(makensis);
const quote = (value) =>
  value.replaceAll("$", () => "$$").replaceAll('"', () => '$\\"');
const hash = (value) => createHash("sha256").update(value).digest("hex");
const template = readFileSync(
  path.join(root, "src-tauri/nsis/installer.nsi"),
  "utf8",
).replaceAll("\r\n", "\n");
const begin = "; LoliCode resource filesystem helpers begin";
const end = "; LoliCode resource filesystem helpers end";
assert(template.includes(begin) && template.includes(end));
const helpers = template.slice(
  template.indexOf(begin),
  template.indexOf(end) + end.length,
);
function instruction(prefix) {
  const matches = template
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
  assert.equal(
    matches.length,
    1,
    `One reviewed resource instruction: ${prefix}`,
  );
  return matches[0];
}
const create = instruction('CreateDirectory "$LoliCodeResourceRoot\\');
const copy = instruction('File /a "/oname=$LoliCodeResourceRoot\\');
const remove = instruction('Delete "$LoliCodeResourceRoot\\');
const removeDirectory = instruction('RMDir /REBOOTOK "$LoliCodeResourceRoot\\');
const resourceDetailsBegin = instruction("SetDetailsPrint textonly");
const resourceDetailsEnd = instruction("SetDetailsPrint lastused");
function render(line, relative, source = "") {
  // The full Tauri bundler regression checks these exact rendered commands.
  // Handlebars consumes one source backslash immediately before an expression.
  const rendered = line
    .replaceAll("\\\\{{", "\\{{")
    .replaceAll("{{this.[1]}}", quote(relative))
    .replaceAll("{{this}}", quote(relative))
    .replaceAll("{{no-escape @key}}", quote(source));
  assert(!rendered.includes("{{"));
  return `  ${rendered}`;
}
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 45000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
function lengthDestination(length, destination) {
  const name = `text-${length}.txt`;
  let remaining = length - destination.length - 1 - name.length - 1;
  const parts = [];
  while (remaining > 60) {
    parts.push("深" + "x".repeat(59));
    remaining -= 61;
  }
  assert(remaining > 0);
  return [...parts, "路" + "x".repeat(remaining - 1), name].join("\\");
}

test("resource instructions use one separator without rewriting INSTDIR or main binary operations", () => {
  assert.equal(create, 'CreateDirectory "$LoliCodeResourceRoot\\\\{{this}}"');
  assert.equal(
    copy,
    'File /a "/oname=$LoliCodeResourceRoot\\\\{{this.[1]}}" "{{no-escape @key}}"',
  );
  assert.equal(remove, 'Delete "$LoliCodeResourceRoot\\\\{{this.[1]}}"');
  assert.equal(
    removeDirectory,
    'RMDir /REBOOTOK "$LoliCodeResourceRoot\\\\{{this}}"',
  );
  assert.doesNotMatch(
    helpers,
    /(?:StrCpy|GetFullPathName) \$INSTDIR|SetOutPath|RMDir|Delete /u,
  );
  assert(template.includes('File "${MAINBINARYSRCPATH}"'));
  assert(template.includes('Delete "$INSTDIR\\${MAINBINARYNAME}.exe"'));
  assert(template.includes('RMDir "$INSTDIR"'));
  const resourceStart = template.indexOf(resourceDetailsBegin);
  const resourceEnd = template.indexOf(resourceDetailsEnd);
  assert(template.indexOf('File "${MAINBINARYSRCPATH}"') < resourceStart);
  assert(resourceStart < template.indexOf(create));
  assert(template.indexOf(copy) < resourceEnd);
  assert(resourceEnd < template.indexOf("; Copy external binaries"));
  assert.deepEqual(
    template.slice(resourceStart, resourceEnd).match(/SetDetailsPrint[^\n]*/gu),
    [resourceDetailsBegin],
    "lastused must restore the mode from before resource extraction",
  );
});

test(
  "resource root validation rejects ambiguous, non-local or truncated roots before copying",
  { skip: !nsisAvailable },
  () => {
    const parent = realpathSync(os.tmpdir());
    const temporary = mkdtempSync(path.join(parent, "lolicode-resource-root-"));
    try {
      const sentinel = path.join(temporary, "sentinel.txt");
      const reached = path.join(temporary, "copy-was-reached.txt");
      writeFileSync(sentinel, "untouched prior installation");
      const roots = [
        "1:\\not-a-drive",
        "relative\\folder",
        "\\\\server\\share\\LoliCode",
        "C:\\",
        path.join(temporary, "LoliCode."),
        path.join(temporary, "Foo.", "Bar"),
        path.join(temporary, "Foo ", "Bar"),
        "C:\\" + "x".repeat(243),
        "C:\\" + "x".repeat(1100),
      ];
      for (const [index, invalid] of roots.entries()) {
        const exe = path.join(temporary, `invalid-${index}.exe`);
        const nsi = path.join(temporary, `invalid-${index}.nsi`);
        writeFileSync(
          nsi,
          "\uFEFF" +
            [
              "Unicode true",
              "RequestExecutionLevel user",
              "SilentInstall silent",
              `!include "${quote(path.join(path.dirname(makensis), "Include/LogicLib.nsh"))}"`,
              helpers,
              `OutFile "${quote(exe)}"`,
              'Section "PreflightOnly"',
              `  StrCpy $INSTDIR "${quote(invalid)}"`,
              "  !insertmacro LoliCodePrepareResourceRoot",
              `  FileOpen $0 "${quote(reached)}" w`,
              '  FileWrite $0 "must not reach copy"',
              "  FileClose $0",
              "SectionEnd",
              "",
            ].join("\n"),
        );
        run(makensis, ["/V1", nsi]);
        const result = spawnSync(exe, ["/S"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 30000,
        });
        assert.equal(result.error, undefined, result.error?.message);
        assert.notEqual(result.status, 0, `Reject unsafe root ${index}`);
        assert(!existsSync(reached), `No copying for unsafe root ${index}`);
        assert.equal(
          readFileSync(sentinel, "utf8"),
          "untouched prior installation",
        );
      }
    } finally {
      assert.equal(path.dirname(path.resolve(temporary)), parent);
      assert(path.basename(temporary).startsWith("lolicode-resource-root-"));
      assert.equal(realpathSync(temporary), temporary);
      assert(!lstatSync(temporary).isSymbolicLink());
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test(
  "real template resource I/O preserves long Unicode paths through fresh install, overwrite and exact uninstall",
  { skip: !nsisAvailable },
  (context) => {
    const temporaryParent = realpathSync(os.tmpdir());
    const temporary = mkdtempSync(
      path.join(temporaryParent, "lolicode-resource-layout-"),
    );
    try {
      const destination = path.join(temporary, "首次 安装 中文", "LoliCode");
      const payload = path.join(temporary, "LICENSE");
      const license =
        "LoliCode isolated resource fixture\r\n许可文件保持原文。\r\n";
      writeFileSync(payload, license);
      const resources = [
        "LICENSE",
        "agent\\extensions\\LICENSE",
        "agent\\extensions\\skills\\docx\\LICENSE.txt",
        ...[240, 259, 260, 261, 300, 520].map((length) =>
          lengthDestination(length, destination),
        ),
      ];
      const directories = new Set([""]);
      for (const relative of resources) {
        let directory = path.win32.dirname(relative);
        while (directory !== ".") {
          directories.add(directory);
          directory = path.win32.dirname(directory);
        }
      }
      const normalization = ['  StrCpy $R0 "$INSTDIR"'];
      // NSIS itself trims whole-path terminal spaces on INSTDIR assignment.
      // Prove equivalence after that step; component-final spaces are rejected.
      for (const suffix of ["", " ", "\\", "\\\\", "\\.\\", "\\unused\\..\\"]) {
        normalization.push(
          `  StrCpy $INSTDIR "$R0${suffix}"`,
          '  StrCpy $R1 "$INSTDIR"',
          "  !insertmacro LoliCodePrepareResourceRoot",
          "  StrCmp $INSTDIR $R1 +3 0",
          "  SetErrorLevel 81",
          "  Quit",
          '  StrCmp $LoliCodeResourceRoot "\\\\?\\$R0" +3 0',
          "  SetErrorLevel 82",
          "  Quit",
        );
      }
      normalization.push(
        '  StrCpy $INSTDIR "$R0"',
        "  !insertmacro LoliCodePrepareResourceRoot",
      );
      const installer = path.join(temporary, "fixture.exe");
      const fixture = path.join(temporary, "fixture.nsi");
      const lines = [
        "Unicode true",
        "RequestExecutionLevel user",
        "SilentInstall silent",
        "AutoCloseWindow true",
        `!include "${quote(path.join(path.dirname(makensis), "Include/LogicLib.nsh"))}"`,
        "!macro CheckIfAppIsRunning executableName productName",
        "!macroend",
        `!include "${quote(hooks)}"`,
        // This private key does not exist. The production hook only reads it.
        `!define UNINSTKEY "Software\\LoliCodeResourceFixture\\${path.basename(temporary)}"`,
        "Var OldMainBinaryName",
        helpers,
        `OutFile "${quote(installer)}"`,
        `InstallDir "${quote(destination)}"`,
        'Section "Fixture"',
        ...normalization,
        "  SetOutPath $INSTDIR",
        "  !insertmacro NSIS_HOOK_PREINSTALL",
        "  StrCmp $OUTDIR $INSTDIR +3 0",
        "  SetErrorLevel 73",
        "  Quit",
        '  IfFileExists "$PLUGINSDIR\\lolicode-process-guard.ps1" +3 0',
        "  SetErrorLevel 74",
        "  Quit",
        '  !insertmacro CheckIfAppIsRunning "LoliCode.exe" "LoliCode"',
        `  File "/oname=LoliCode.exe" "${quote(payload)}"`,
        "  SetOverwrite on",
        resourceDetailsBegin,
        ...[...directories].flatMap((directory) => [
          "  ClearErrors",
          render(create, directory),
          "  IfErrors 0 +3",
          "  SetErrorLevel 83",
          "  Quit",
        ]),
        ...resources.flatMap((relative) => [
          "  ClearErrors",
          render(copy, relative, payload),
          "  IfErrors 0 +3",
          "  SetErrorLevel 84",
          "  Quit",
        ]),
        resourceDetailsEnd,
        '  SetOutPath "$INSTDIR\\alternate"',
        "  !insertmacro NSIS_HOOK_PREUNINSTALL",
        '  StrCmp $OUTDIR "$INSTDIR\\alternate" +3 0',
        "  SetErrorLevel 75",
        "  Quit",
        '  FileOpen $1 "$INSTDIR\\layout-proof.txt" w',
        '  FileWriteUTF16LE $1 "$OUTDIR$\\r$\\n$PLUGINSDIR$\\r$\\n"',
        "  FileClose $1",
        "  SetErrorLevel 0",
        "SectionEnd",
        "",
      ];
      writeFileSync(fixture, "\uFEFF" + lines.join("\n"));
      const compiled = spawnSync(makensis, ["/V1", fixture], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      });
      assert.equal(compiled.error, undefined, compiled.error?.message);
      assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
      assert.equal(
        existsSync(destination),
        false,
        "fresh install must start without the destination",
      );
      for (const round of ["fresh", "reinstall"]) {
        if (round === "reinstall")
          for (const relative of resources)
            writeFileSync(
              path.join(destination, relative),
              "stale synthetic contents",
            );
        const executed = spawnSync(installer, ["/S"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 45000,
        });
        assert.equal(executed.error, undefined, executed.error?.message);
        assert.equal(
          executed.status,
          0,
          `${round}: hook must keep OUTDIR (73/75) and stage its helper (74)`,
        );
        assert.equal(
          readFileSync(path.join(destination, "LoliCode.exe"), "utf8"),
          license,
        );
        for (const relative of resources)
          assert.equal(
            hash(readFileSync(path.join(destination, relative))),
            hash(license),
            `${round}: ${relative}`,
          );
        assert.equal(
          readFileSync(
            path.join(destination, "agent/extensions/LICENSE"),
            "utf8",
          ),
          license,
        );
        assert.equal(
          readFileSync(
            path.join(destination, "agent/extensions/skills/docx/LICENSE.txt"),
            "utf8",
          ),
          license,
        );
        const [outDirectory, pluginDirectory] = readFileSync(
          path.join(destination, "layout-proof.txt"),
          "utf16le",
        )
          .trim()
          .split(/\r?\n/);
        assert.equal(
          outDirectory.toLowerCase(),
          path.join(destination, "alternate").toLowerCase(),
        );
        assert(
          !existsSync(path.join(pluginDirectory, "agent")),
          "no application resources may be extracted into NSIS temp",
        );
        assert(!existsSync(path.join(pluginDirectory, "LoliCode.exe")));
        assert.equal(
          existsSync(path.join(destination, "lolicode-process-guard.ps1")),
          false,
        );
        if (round === "fresh")
          writeFileSync(
            path.join(destination, "user-sentinel.txt"),
            "preserve",
          );
      }
      assert.equal(
        readFileSync(path.join(destination, "user-sentinel.txt"), "utf8"),
        "preserve",
      );
      const uninstaller = path.join(temporary, "uninstall-fixture.exe");
      const uninstallScript = path.join(temporary, "uninstall-fixture.nsi");
      writeFileSync(
        uninstallScript,
        "\uFEFF" +
          [
            "Unicode true",
            "RequestExecutionLevel user",
            "SilentInstall silent",
            "AutoCloseWindow true",
            `!include "${quote(path.join(path.dirname(makensis), "Include/LogicLib.nsh"))}"`,
            helpers,
            `OutFile "${quote(uninstaller)}"`,
            `InstallDir "${quote(destination)}"`,
            'Section "ExactSyntheticDelete"',
            ...normalization,
            '  Delete "$INSTDIR\\LoliCode.exe"',
            ...resources.flatMap((relative) => [
              "  ClearErrors",
              render(remove, relative),
              "  IfErrors 0 +3",
              "  SetErrorLevel 85",
              "  Quit",
            ]),
            // All listed child directories are empty after exact file deletion.
            // Never recurse or remove the sentinel/evidence in the install root.
            ...[...directories]
              .filter(Boolean)
              .sort((a, b) => b.length - a.length)
              .flatMap((directory) => [
                "  ClearErrors",
                render(removeDirectory, directory),
                "  IfErrors 0 +3",
                "  SetErrorLevel 86",
                "  Quit",
              ]),
            '  RMDir "$INSTDIR"',
            "  SetErrorLevel 0",
            "SectionEnd",
            "",
          ].join("\n"),
      );
      run(makensis, ["/V1", uninstallScript]);
      run(uninstaller, ["/S"]);
      for (const relative of resources)
        assert(
          !existsSync(path.join(destination, relative)),
          `Exact uninstall: ${relative}`,
        );
      for (const directory of [...directories].filter(Boolean))
        assert(!existsSync(path.join(destination, directory)));
      assert(!existsSync(path.join(destination, "LoliCode.exe")));
      assert.equal(
        readFileSync(path.join(destination, "user-sentinel.txt"), "utf8"),
        "preserve",
      );
      assert.deepEqual(readdirSync(destination).sort(), [
        "alternate",
        "layout-proof.txt",
        "user-sentinel.txt",
      ]);
      context.diagnostic(
        "Actual template helpers/instructions: 240/259/260/261/300/520 character Unicode targets hash-verified after fresh install and overwrite, exact uninstall preserves sentinel; no longPathAware manifest used",
      );
    } finally {
      const resolved = path.resolve(temporary);
      assert.equal(path.dirname(resolved), temporaryParent);
      assert(path.basename(resolved).startsWith("lolicode-resource-layout-"));
      assert.equal(realpathSync(resolved), resolved);
      assert(!lstatSync(resolved).isSymbolicLink());
      rmSync(resolved, { recursive: true, force: true });
    }
  },
);
