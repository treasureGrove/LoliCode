import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const templatePath = path.join(root, "src-tauri/nsis/installer.nsi");
const hooksPath = path.join(
  root,
  "src-tauri/nsis/lolicode-installer-hooks.nsh",
);
const cliPath = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
const powershell = process.env.POWERSHELL_EXE ?? "powershell.exe";
const makensis =
  process.env.NSIS_MAKENSIS ??
  path.join(process.env.LOCALAPPDATA ?? "", "tauri/NSIS/makensis.exe");
// The real bundler bootstraps the verified NSIS toolchain on a clean CI runner.
// A missing compiler must not silently skip the upgrade regression on Windows.
const windowsAvailable = process.platform === "win32";
const quote = (value) =>
  value.replaceAll("$", () => "$$").replaceAll('"', () => '$\\"');
const digest = (filename) =>
  createHash("sha256").update(readFileSync(filename)).digest("hex");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

function ps(source, env = {}) {
  const utf8 = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ";
  return run(powershell, ["-NoLogo", "-NoProfile", "-Command", utf8 + source], {
    env: { ...process.env, ...env },
  });
}

test("release configuration selects the reviewed overwrite-upgrade template", () => {
  const config = JSON.parse(
    readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  assert.equal(config.bundle.windows.nsis.template, "nsis/installer.nsi");
  const template = readFileSync(templatePath, "utf8");
  assert.match(template, /tauri-cli-v2\.10\.1/);
  assert.doesNotMatch(
    template,
    /_\?=/,
    "NSIS updates must never build an uninstaller command",
  );
  assert.match(
    template,
    /Function PageLeaveReinstall\s+;[^\n]*\s+;[^\n]*\s+\$\{If\} \$WixMode != 1\s+Return/u,
  );
});

test(
  "real bundled NSIS upgrades preserve the old folder and data without invoking uninstall",
  {
    skip: !windowsAvailable,
    timeout: 240000,
  },
  () => {
    const temporaryParent = path.resolve(os.tmpdir());
    const temporary = mkdtempSync(
      path.join(temporaryParent, "lolicode-overwrite-"),
    );
    const fixtureId = `LoliCodeUpgradeFixture-${randomUUID()}`;
    const uninstallKey = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${fixtureId}`;
    const publisherKey = `HKCU:\\Software\\${fixtureId}\\${fixtureId}`;
    const project = path.join(temporary, "project");
    const install = path.join(temporary, "旧版 安装 中文", "LoliCode");
    const marker = path.join(temporary, "old-uninstaller-was-called.txt");
    const versionResource = path.join(project, "version.txt");
    const exe = path.join(project, "target/release/fixture-app.exe");
    const env = {
      ...process.env,
      PATH: `${path.join(os.homedir(), ".cargo/bin")}${path.delimiter}${process.env.PATH}`,
      CARGO_TARGET_DIR: path.join(project, "target"),
    };
    const fixtureEnv = {
      LOLICODE_FIXTURE_UNINSTALL_KEY: uninstallKey,
      LOLICODE_FIXTURE_PUBLISHER_KEY: publisherKey,
      LOLICODE_FIXTURE_INSTALL: install,
    };
    const registration = (script) => ps(script, fixtureEnv);
    let installers;
    try {
      mkdirSync(path.dirname(exe), { recursive: true });
      mkdirSync(path.join(project, "src"), { recursive: true });
      mkdirSync(path.join(project, "dist"));
      mkdirSync(install, { recursive: true });
      writeFileSync(
        path.join(project, "Cargo.toml"),
        '[package]\nname="fixture-app"\nversion="4.1.2"\nedition="2021"\n',
      );
      writeFileSync(path.join(project, "src/main.rs"), "fn main() {}\n");
      writeFileSync(path.join(project, "dist/index.html"), "fixture");
      ps(
        `Add-Type -TypeDefinition 'public class Program { public static void Main() {} }' -OutputType WindowsApplication -OutputAssembly $env:LOLICODE_FIXTURE_EXE`,
        {
          LOLICODE_FIXTURE_EXE: exe,
        },
      );
      copyFileSync(exe, path.join(path.dirname(exe), "LoliCode.exe"));
      // A hostile/broken old uninstaller records any attempt to execute it.
      const oldSource = path.join(temporary, "old-uninstaller.nsi");
      writeFileSync(
        oldSource,
        "\uFEFF" +
          [
            "Unicode true",
            "RequestExecutionLevel user",
            "SilentInstall silent",
            `OutFile "${quote(path.join(install, "uninstall.exe"))}"`,
            "Section",
            `FileOpen $0 "${quote(marker)}" w`,
            'FileWrite $0 "called"',
            "FileClose $0",
            "SetErrorLevel 91",
            "SectionEnd",
            "",
          ].join("\n"),
      );
      copyFileSync(exe, path.join(install, "tai-switch.exe"));
      writeFileSync(
        path.join(install, "user-database.sqlite"),
        "keep database and settings",
      );
      writeFileSync(path.join(install, "user-sentinel.txt"), "keep user file");
      function seedLegacyRegistration() {
        registration(`
      $ErrorActionPreference='Stop'
      if (Test-Path -LiteralPath $env:LOLICODE_FIXTURE_UNINSTALL_KEY) { throw 'Fixture key already exists' }
      New-Item -Path $env:LOLICODE_FIXTURE_UNINSTALL_KEY -Force | Out-Null
      $values=@{DisplayName='LoliCode'; DisplayVersion='4.0.11'; InstallLocation=('"'+$env:LOLICODE_FIXTURE_INSTALL+'"'); UninstallString=('"'+$env:LOLICODE_FIXTURE_INSTALL+'\\uninstall.exe"'); MainBinaryName='tai-switch.exe'}
      foreach($name in $values.Keys) { New-ItemProperty -LiteralPath $env:LOLICODE_FIXTURE_UNINSTALL_KEY -Name $name -Value $values[$name] -PropertyType String -Force | Out-Null }
    `);
      }

      installers = ["4.1.2", "4.1.3"].map((version) => {
        const config = {
          productName: fixtureId,
          mainBinaryName: "LoliCode",
          version,
          identifier: `art.lolicode.upgradefixture.${fixtureId.slice(-12)}`,
          build: { frontendDist: "dist" },
          bundle: {
            active: true,
            targets: ["nsis"],
            publisher: fixtureId,
            createUpdaterArtifacts: false,
            icon: [],
            resources: { "version.txt": "version.txt" },
            windows: {
              allowDowngrades: false,
              webviewInstallMode: { type: "skip" },
              nsis: {
                installMode: "currentUser",
                template: templatePath,
                installerHooks: hooksPath,
              },
            },
          },
        };
        writeFileSync(
          path.join(project, "tauri.conf.json"),
          JSON.stringify(config),
        );
        writeFileSync(versionResource, version);
        run(
          process.execPath,
          [
            cliPath,
            "bundle",
            "--bundles",
            "nsis",
            "--ci",
            "--no-sign",
            "--verbose",
          ],
          {
            cwd: project,
            env,
            timeout: 120000,
          },
        );
        const built = path.join(
          project,
          `target/release/bundle/nsis/${fixtureId}_${version}_x64-setup.exe`,
        );
        const installer = path.join(temporary, `setup-${version}.exe`);
        copyFileSync(built, installer);
        const generated = readFileSync(
          path.join(project, "target/release/nsis/x64/installer.nsi"),
          "utf8",
        );
        assert.doesNotMatch(generated, /_\?=/);
        return installer;
      });
      run(makensis, ["/V1", oldSource]);

      function verify(version) {
        assert.equal(
          existsSync(marker),
          false,
          "old uninstaller must not be called",
        );
        assert.equal(digest(path.join(install, "LoliCode.exe")), digest(exe));
        assert.equal(
          readFileSync(path.join(install, "version.txt"), "utf8"),
          version,
        );
        assert.equal(
          readFileSync(path.join(install, "user-database.sqlite"), "utf8"),
          "keep database and settings",
        );
        assert.equal(
          readFileSync(path.join(install, "user-sentinel.txt"), "utf8"),
          "keep user file",
        );
        assert.equal(existsSync(path.join(install, "tai-switch.exe")), false);
        const registered = JSON.parse(
          registration(
            `Get-ItemProperty -LiteralPath $env:LOLICODE_FIXTURE_UNINSTALL_KEY | Select-Object DisplayVersion,MainBinaryName | ConvertTo-Json -Compress`,
          ),
        );
        assert.equal(registered.DisplayVersion, version);
        assert.equal(registered.MainBinaryName, "LoliCode.exe");
        const location = registration(
          `(Get-Item -LiteralPath $env:LOLICODE_FIXTURE_PUBLISHER_KEY).GetValue('')`,
        ).trim();
        assert.equal(location.toLowerCase(), install.toLowerCase());
      }

      // Fresh installs and an explicit user-requested uninstall still work.
      const fresh = path.join(temporary, "首次 安装 中文", "LoliCode");
      // NSIS requires /D= last and unquoted, including when it has spaces.
      run(installers[0], ["/S", "/NS", `/D=${fresh}`], {
        windowsVerbatimArguments: true,
      });
      assert.equal(digest(path.join(fresh, "LoliCode.exe")), digest(exe));
      assert.equal(
        readFileSync(path.join(fresh, "version.txt"), "utf8"),
        "4.1.2",
      );
      writeFileSync(path.join(fresh, "user-sentinel.txt"), "keep user file");
      run(path.join(fresh, "uninstall.exe"), ["/S", `_?=${fresh}`], {
        windowsVerbatimArguments: true,
      });
      assert.equal(existsSync(path.join(fresh, "LoliCode.exe")), false);
      assert.equal(
        readFileSync(path.join(fresh, "user-sentinel.txt"), "utf8"),
        "keep user file",
      );

      seedLegacyRegistration();
      // No /D: the installer must recover the original directory by itself.
      run(installers[0], ["/P", "/NS"]); // manual download, passive maintenance path
      verify("4.1.2");
      run(installers[0], ["/S", "/NS"]); // repeat installation
      verify("4.1.2");
      run(installers[1], ["/S", "/UPDATE", "/NS"]); // app updater
      verify("4.1.3");

      // Recover from UninstallString when both directory records are missing.
      registration(
        `Remove-Item -LiteralPath $env:LOLICODE_FIXTURE_PUBLISHER_KEY -Force; Remove-ItemProperty -LiteralPath $env:LOLICODE_FIXTURE_UNINSTALL_KEY -Name InstallLocation`,
      );
      run(installers[1], ["/P", "/NS"]);
      verify("4.1.3");

      // Early releases may omit MainBinaryName as well as the publisher key.
      copyFileSync(exe, path.join(install, "tai-switch.exe"));
      registration(
        `Remove-ItemProperty -LiteralPath $env:LOLICODE_FIXTURE_UNINSTALL_KEY -Name MainBinaryName`,
      );
      run(installers[1], ["/S", "/NS"]);
      verify("4.1.3");

      // Silent downgrade attempts must not bypass the version policy.
      const downgrade = spawnSync(installers[0], ["/S", "/NS"], {
        windowsHide: true,
        timeout: 30000,
      });
      assert.equal(downgrade.error, undefined, downgrade.error?.message);
      assert.equal(downgrade.status, 1);
      verify("4.1.3");

      // An unusable registration must fail closed before copying any files.
      registration(
        `Remove-Item -LiteralPath $env:LOLICODE_FIXTURE_PUBLISHER_KEY -Force; Set-ItemProperty -LiteralPath $env:LOLICODE_FIXTURE_UNINSTALL_KEY -Name InstallLocation -Value 'C:\\'; Set-ItemProperty -LiteralPath $env:LOLICODE_FIXTURE_UNINSTALL_KEY -Name UninstallString -Value 'relative\\uninstall.exe'`,
      );
      const invalid = spawnSync(installers[1], ["/S", "/NS"], {
        windowsHide: true,
        timeout: 30000,
      });
      assert.equal(invalid.error, undefined, invalid.error?.message);
      assert.equal(invalid.status, 2);
      assert.equal(
        readFileSync(path.join(install, "version.txt"), "utf8"),
        "4.1.3",
      );
      assert.equal(existsSync(marker), false);
    } finally {
      // Only disposable, uniquely named registry entries belong to this test.
      registration(`
      foreach($p in @($env:LOLICODE_FIXTURE_UNINSTALL_KEY,$env:LOLICODE_FIXTURE_PUBLISHER_KEY)) {
        if ($p -notlike '*LoliCodeUpgradeFixture-*') { throw 'Unsafe fixture registry cleanup' }
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
      }
      $parent=Split-Path -Parent $env:LOLICODE_FIXTURE_PUBLISHER_KEY
      if ((Test-Path -LiteralPath $parent) -and @(Get-ChildItem -LiteralPath $parent).Count -eq 0) { Remove-Item -LiteralPath $parent -Force }
    `);
      const resolved = path.resolve(temporary);
      assert.equal(path.dirname(resolved), temporaryParent);
      assert(path.basename(resolved).startsWith("lolicode-overwrite-"));
      rmSync(resolved, { recursive: true, force: true });
      // A broken /D or restoration must never leave a test app in the profile.
      const defaultInstall = path.resolve(process.env.LOCALAPPDATA, fixtureId);
      assert.equal(
        path.dirname(defaultInstall),
        path.resolve(process.env.LOCALAPPDATA),
      );
      assert(
        path.basename(defaultInstall).startsWith("LoliCodeUpgradeFixture-"),
      );
      rmSync(defaultInstall, { recursive: true, force: true });
    }
  },
);
