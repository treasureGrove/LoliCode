#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEVELOPMENT_ID = "art.treasuregrove.lolicode.dev";
export const DEVELOPMENT_NAME = "LoliCode Dev";
export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const targetDirectory = path.join(root, "src-tauri/target/development");
export const packageDirectory = path.join(targetDirectory, "app");

function git(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function developmentBuildNumber(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return `DEV-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

export function buildEnvironment(channel, source = process.env) {
  const cargoBin = path.join(
    source.CARGO_HOME || path.join(os.homedir(), ".cargo"),
    "bin",
  );
  const pathKey =
    Object.keys(source).find((key) => key.toLowerCase() === "path") || "PATH";
  const env = {
    ...source,
    [pathKey]: `${cargoBin}${path.delimiter}${source[pathKey] || ""}`,
    LOLICODE_BUILD_CHANNEL: channel,
    VITE_LOLICODE_BUILD_CHANNEL: channel,
    VITE_LOLICODE_BUILD_REVISION: `${git(["rev-parse", "--short=8", "HEAD"]) || "local"}${git(["status", "--porcelain"]) ? "+dirty" : ""}`,
  };
  if (channel === "development") {
    env.CARGO_TARGET_DIR = targetDirectory;
    env.LOLICODE_BUILD_NUMBER = developmentBuildNumber();
    env.VITE_LOLICODE_BUILD_NUMBER = env.LOLICODE_BUILD_NUMBER;
    // Development needs fast repeat builds, without release-only whole-program LTO.
    env.CARGO_PROFILE_RELEASE_LTO = "false";
    // Local development never consumes a release signing credential.
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  } else {
    delete env.LOLICODE_BUILD_NUMBER;
    delete env.VITE_LOLICODE_BUILD_NUMBER;
    // An inherited development shell must not redirect a stable build.
    if (
      env.CARGO_TARGET_DIR &&
      path.resolve(env.CARGO_TARGET_DIR) === targetDirectory
    )
      delete env.CARGO_TARGET_DIR;
  }
  return env;
}

function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${path.basename(executable)} exited with ${result.status ?? result.signal}.`,
    );
}

function tauri(args, env) {
  run(
    process.execPath,
    [path.join(root, "node_modules/@tauri-apps/cli/tauri.js"), ...args],
    windowsToolchainEnvironment(env),
  );
}

export function windowsToolchainEnvironment(env) {
  if (process.platform !== "win32") return env;
  const vswhere = path.join(
    env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
    "Microsoft Visual Studio/Installer/vswhere.exe",
  );
  let installation = existsSync(vswhere)
    ? spawnSync(
        vswhere,
        [
          "-latest",
          "-prerelease",
          "-products",
          "*",
          "-requires",
          "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
          "-property",
          "installationPath",
        ],
        { encoding: "utf8", windowsHide: true, env },
      ).stdout?.trim()
    : "";
  if (!installation) {
    // Also support local Build Tools installations not registered with vswhere.
    const visualStudio = path.join(
      env.ProgramFiles || "C:/Program Files",
      "Microsoft Visual Studio",
    );
    if (existsSync(visualStudio)) {
      for (const version of readdirSync(visualStudio).sort().reverse()) {
        const versionRoot = path.join(visualStudio, version);
        for (const edition of [
          "BuildTools",
          "Community",
          "Professional",
          "Enterprise",
        ]) {
          const candidate = path.join(versionRoot, edition);
          if (
            existsSync(path.join(candidate, "VC/Auxiliary/Build/vcvarsall.bat"))
          ) {
            installation = candidate;
            break;
          }
        }
        if (installation) break;
      }
    }
  }
  if (!installation) return env;
  const developerCommand = path.join(
    installation,
    "VC/Auxiliary/Build/vcvarsall.bat",
  );
  if (!existsSync(developerCommand) || /[\r\n"&|<>^%!]/.test(developerCommand))
    throw new Error("Invalid Visual Studio developer command path.");
  // Capture the installed toolchain's environment without printing inherited secrets.
  const result = spawnSync(
    env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", `call "${developerCommand}" x64 >nul && set`],
    {
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true,
      env,
    },
  );
  if (result.status !== 0)
    throw new Error("Could not initialize the Visual Studio C++ build tools.");
  const prepared = { ...env };
  for (const line of result.stdout.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals);
    const oldKey = Object.keys(prepared).find(
      (name) => name.toLowerCase() === key.toLowerCase(),
    );
    if (oldKey) delete prepared[oldKey];
    prepared[key] = line.slice(equals + 1);
  }
  return prepared;
}

function fileList(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink())
      throw new Error("Development payload cannot contain symlinks.");
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? fileList(path.join(directory, entry.name), relative)
      : [relative];
  });
}

export function stageDevelopmentApp(env) {
  const binary = path.join(
    targetDirectory,
    "release",
    `${DEVELOPMENT_NAME}.exe`,
  );
  if (!existsSync(binary))
    throw new Error(`Build the development app first: ${binary}`);
  const identity = spawnSync(binary, ["--build-info"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  if (
    identity.status !== 0 ||
    JSON.parse(identity.stdout).channel !== "development"
  )
    throw new Error(
      "Refusing to register a binary that is not a development build.",
    );
  // Assemble only the allowlisted runtime payload, never a whole build directory.
  mkdirSync(targetDirectory, { recursive: true });
  const staging = mkdtempSync(path.join(targetDirectory, "package-"));
  cpSync(binary, path.join(staging, `${DEVELOPMENT_NAME}.exe`));
  const config = JSON.parse(
    readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  for (const [source, destination] of Object.entries(config.bundle.resources)) {
    cpSync(
      path.join(root, "src-tauri", source),
      path.join(staging, destination),
      { recursive: true },
    );
  }
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
    cpSync(path.join(root, name), path.join(staging, name));
  cpSync(
    path.join(root, "scripts/register-lolicode-development.ps1"),
    path.join(staging, "register-lolicode-development.ps1"),
  );
  const product = JSON.parse(
    readFileSync(path.join(root, "product-release.json"), "utf8"),
  );
  const manifest = {
    identifier: DEVELOPMENT_ID,
    channel: "development",
    appName: DEVELOPMENT_NAME,
    shortcutName: "LoliCode 开发版",
    productVersion: product.productVersion,
    buildVersion: product.buildVersion,
    developmentBuildNumber: env.LOLICODE_BUILD_NUMBER,
    revision: env.VITE_LOLICODE_BUILD_REVISION,
    builtAt: new Date().toISOString(),
    sourceDirectory: root,
    files: fileList(staging),
  };
  writeFileSync(
    path.join(staging, "development-build.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const previousManifest = path.join(
    packageDirectory,
    "development-build.json",
  );
  if (existsSync(previousManifest)) {
    const previous = JSON.parse(readFileSync(previousManifest, "utf8"));
    if (previous.identifier !== DEVELOPMENT_ID)
      throw new Error("Unexpected development package ownership.");
    for (const relative of previous.files.filter(
      (file) => !manifest.files.includes(file),
    )) {
      const stale = path.resolve(packageDirectory, relative);
      if (!stale.startsWith(packageDirectory + path.sep))
        throw new Error("Unsafe managed file path.");
      if (existsSync(stale)) rmSync(stale);
    }
  }
  mkdirSync(packageDirectory, { recursive: true });
  cpSync(staging, packageDirectory, { recursive: true });
  const resolvedStage = path.resolve(staging);
  if (
    path.dirname(resolvedStage) !== targetDirectory ||
    !path.basename(resolvedStage).startsWith("package-")
  )
    throw new Error("Unsafe staging cleanup path.");
  rmSync(resolvedStage, { recursive: true });
  return manifest;
}

function registration(action) {
  if (process.platform !== "win32")
    throw new Error("Windows registration requires Windows.");
  run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(root, "scripts/register-lolicode-development.ps1"),
    "-Action",
    action,
    "-BuildDirectory",
    packageDirectory,
  ]);
}

export function main(args) {
  const [command, ...options] = args;
  const devEnv = buildEnvironment("development");
  switch (command) {
    case "dev":
      tauri(
        ["dev", "--config", "src-tauri/tauri.dev.conf.json", ...options],
        devEnv,
      );
      break;
    case "build": {
      if (options.some((option) => option !== "--no-register"))
        throw new Error(
          "Development build supports only --no-register; use build:release for installers.",
        );
      if (process.platform !== "win32")
        throw new Error(
          "The desktop development package currently targets Windows.",
        );
      tauri(
        ["build", "--no-bundle", "--config", "src-tauri/tauri.dev.conf.json"],
        devEnv,
      );
      stageDevelopmentApp(devEnv);
      if (!options.includes("--no-register")) registration("Register");
      console.log(`Development app: ${packageDirectory}`);
      break;
    }
    case "release":
      tauri(["build", ...options], buildEnvironment("stable"));
      break;
    case "register":
      registration("Register");
      break;
    case "unregister":
      registration("Unregister");
      break;
    default:
      throw new Error(
        "Use dev, build [--no-register], release, register, or unregister.",
      );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
