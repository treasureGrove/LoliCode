import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
const quote = (value) => value.replaceAll("$", "$$").replaceAll('"', '$\\"');

test(
  "real NSIS hooks preserve the resource destination on fresh install and reinstall",
  { skip: !nsisAvailable },
  () => {
    const temporaryParent = path.resolve(os.tmpdir());
    const temporary = mkdtempSync(
      path.join(temporaryParent, "lolicode-resource-layout-"),
    );
    try {
      const destination = path.join(temporary, "首次 安装 中文", "LoliCode");
      const payload = path.join(temporary, "LICENSE");
      const license =
        "LoliCode isolated resource fixture\r\n许可文件保持原文。\r\n";
      writeFileSync(payload, license);
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
        `OutFile "${quote(installer)}"`,
        `InstallDir "${quote(destination)}"`,
        'Section "Fixture"',
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
        '  CreateDirectory "$INSTDIR\\agent\\extensions\\skills\\docx"',
        `  File "/oname=agent\\extensions\\LICENSE" "${quote(payload)}"`,
        `  File "/oname=agent\\extensions\\skills\\docx\\LICENSE.txt" "${quote(payload)}"`,
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
      assert.deepEqual(readdirSync(destination).sort(), [
        "LoliCode.exe",
        "agent",
        "alternate",
        "layout-proof.txt",
        "user-sentinel.txt",
      ]);
    } finally {
      const resolved = path.resolve(temporary);
      assert.equal(path.dirname(resolved), temporaryParent);
      assert(path.basename(resolved).startsWith("lolicode-resource-layout-"));
      rmSync(resolved, { recursive: true, force: true });
    }
  },
);
