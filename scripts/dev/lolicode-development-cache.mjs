import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const identifier = "art.treasuregrove.lolicode.dev";
const manifestName = "development-build.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pathKey = (file) =>
  process.platform === "win32"
    ? path.resolve(file).toLowerCase()
    : path.resolve(file);
const nativeInputs = [
  "src-tauri",
  "crates",
  "packages",
  "assets",
  "scripts/build",
  "scripts/dev",
  "third-party/zcode",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "product-release.json",
  "rust-toolchain.toml",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];

/** Native/resources identity excludes renderer source and Git-only identity changes. */
export function developmentNativeFingerprint(
  repository,
  environment = process.env,
) {
  const listed = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...nativeInputs,
    ],
    {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (listed.status !== 0 || listed.error)
    throw new Error("无法检查开发版原生构建输入。");
  const hash = createHash("sha256").update("lolicode-development-native-v1\0");
  const record = (name, bytes) => {
    hash.update(JSON.stringify([name, bytes.length]) + "\0");
    hash.update(bytes);
  };
  record("@source", Buffer.from(pathKey(repository)));
  record("@platform", Buffer.from(`${process.platform}-${process.arch}`));
  record("@node", Buffer.from(process.execPath));
  for (const key of Object.keys(environment)
    .filter((key) =>
      /^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTUP_TOOLCHAIN|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_TARGET|CARGO_PROFILE_RELEASE_.*)$/i.test(
        key,
      ),
    )
    .sort())
    record(`@env:${key}`, Buffer.from(environment[key] || ""));
  for (const file of [
    ...new Set(listed.stdout.split("\0").filter(Boolean)),
  ].sort()) {
    try {
      record(file, readFileSync(path.join(repository, file)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      record(`deleted:${file}`, Buffer.alloc(0));
    }
  }
  return hash.digest("hex");
}

function ownedFile(directory, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.includes("\\") ||
    relative.includes(":") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsafe development cache file.");
  const file = path.resolve(directory, relative);
  if (!file.startsWith(path.resolve(directory) + path.sep))
    throw new Error("Unsafe development cache path.");
  for (
    let parent = file;
    parent !== path.resolve(directory);
    parent = path.dirname(parent)
  ) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      throw new Error("Linked development cache payload.");
  }
  return file;
}

/** Old manifests record files only; an already removed package can leave a
 * directory that shadows a hoisted npm dependency. Never remove files or links. */
export function pruneEmptyDevelopmentRuntimeDirectories(directory) {
  const root = path.resolve(directory);
  let runtime = root;
  for (const part of ["", "agent", "harness-runtime", "node_modules"]) {
    runtime = path.join(runtime, part);
    const entry = lstatSync(runtime, { throwIfNoEntry: false });
    if (!entry) return;
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error("Unsafe development runtime cleanup root.");
  }
  const manifest = JSON.parse(
    readFileSync(path.join(root, manifestName), "utf8"),
  );
  if (manifest.identifier !== identifier || manifest.channel !== "development")
    throw new Error("Unexpected development runtime cleanup ownership.");
  const prune = (current) => {
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink())
        prune(path.join(current, entry.name));
    }
    // Keep node_modules itself. Non-recursive removal also protects a file
    // added after enumeration: the operation fails instead of deleting it.
    if (current === runtime || readdirSync(current).length) return;
    const beforeRemoval = lstatSync(current, { throwIfNoEntry: false });
    if (beforeRemoval?.isDirectory() && !beforeRemoval.isSymbolicLink())
      rmdirSync(current);
  };
  prune(runtime);
}

export const isDevelopmentCriticalFile = (file) =>
  file === "LoliCode Dev.exe" ||
  !file.includes("/") ||
  /^agent\/harness-runtime\/[^/]+$/.test(file) ||
  /^agent\/harness-runtime\/node_modules\/@deepseek-ai\/dsh\/(package.json|lib\/bin.js)$/.test(
    file,
  ) ||
  file === "agent/extensions/manifest.json";

/** Hash native/bootstrap inputs, not all 70,000 immutable npm dependency files. */
export function developmentCriticalFiles(directory, files) {
  const critical = files.filter(isDevelopmentCriticalFile);
  if (!critical.includes("LoliCode Dev.exe"))
    throw new Error("Development cache executable missing.");
  return Object.fromEntries(
    critical.map((relative) => [
      relative,
      sha(readFileSync(ownedFile(directory, relative))),
    ]),
  );
}

function hashesMatch(directory, hashes) {
  if (!hashes || !Object.keys(hashes).length) return false;
  try {
    return Object.entries(hashes).every(
      ([relative, expected]) =>
        /^[a-f0-9]{64}$/.test(expected) &&
        sha(readFileSync(ownedFile(directory, relative))) === expected,
    );
  } catch {
    return false;
  }
}

export function readDevelopmentCache(directory, repository) {
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
    throw new Error("Linked development cache directory.");
  const file = path.join(directory, manifestName);
  if (!existsSync(file)) return null;
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (
    manifest.identifier !== identifier ||
    manifest.channel !== "development" ||
    typeof manifest.sourceDirectory !== "string" ||
    !path.isAbsolute(manifest.sourceDirectory) ||
    pathKey(manifest.sourceDirectory) !== pathKey(repository)
  )
    throw new Error("开发版缓存属于另一份源码，已有文件已保留。");
  if (
    manifest.nativeBuild?.format !== 1 ||
    !hashesMatch(directory, manifest.nativeBuild.criticalFiles)
  )
    return null;
  return manifest;
}

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.next`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
  });
  renameSync(temporary, file);
}

function rendererMatches(repository, manifest) {
  const pointer = path.join(
    repository,
    "src-tauri/target/development/current-renderer.json",
  );
  if (!manifest.renderer) {
    if (!existsSync(pointer)) return true;
    try {
      const previous = JSON.parse(readFileSync(pointer, "utf8"));
      const rendererBuiltAt = Date.parse(previous.builtAt);
      const nativeBuiltAt = Date.parse(manifest.nativeBuild.info?.builtAt);
      // Startup explicitly ignores pointers older than the compiled native
      // build. Preserve that old snapshot rather than forcing another Vite run.
      return (
        previous.channel === "development" &&
        Number.isFinite(rendererBuiltAt) &&
        Number.isFinite(nativeBuiltAt) &&
        rendererBuiltAt < nativeBuiltAt
      );
    } catch {
      return false;
    }
  }
  try {
    return (
      JSON.stringify(JSON.parse(readFileSync(pointer, "utf8"))) ===
        JSON.stringify(manifest.renderer) &&
      hashesMatch(manifest.renderer.outputDirectory, manifest.rendererFiles)
    );
  } catch {
    return false;
  }
}

function sameNative(manifest, fingerprint, native) {
  return (
    manifest?.nativeBuild.inputFingerprint === fingerprint &&
    manifest.nativeBuild.contract === native.contract &&
    manifest.nativeBuild.version === native.version
  );
}

/** Build policy is injected so the cache boundaries can be tested without a compiler. */
export async function buildDevelopmentIncrementally({
  repository,
  packageDirectory,
  installDirectory,
  environment,
  fingerprintSource,
  nativeContract,
  buildNative,
  stageNative,
  buildRenderer,
  register,
  rendererFiles,
  noRegister = false,
  force = false,
  log = console.log,
  isRunning = () => false,
}) {
  const source = fingerprintSource(repository);
  const native = await nativeContract(repository);
  const fingerprint = developmentNativeFingerprint(repository, environment);
  const previous = readDevelopmentCache(packageDirectory, repository);
  const compatible = sameNative(previous, fingerprint, native);
  const mode =
    force || !compatible
      ? "native"
      : previous.sourceFingerprint === source &&
          rendererMatches(repository, previous)
        ? "reuse"
        : "renderer";
  const installedBefore = noRegister
    ? null
    : readDevelopmentCache(installDirectory, repository);
  if (
    !noRegister &&
    isRunning(path.join(installDirectory, "LoliCode Dev.exe")) &&
    !(
      mode === "reuse" &&
      installedBefore?.sourceFingerprint === source &&
      sameNative(installedBefore, fingerprint, native)
    )
  )
    throw new Error(
      "请先从托盘退出 LoliCode 开发版，再构建更新；正在运行的任务已保留。",
    );
  const assertUnchanged = () => {
    if (
      fingerprintSource(repository) !== source ||
      developmentNativeFingerprint(repository, environment) !== fingerprint
    )
      throw new Error("源码在构建期间发生变化，未发布过期开发版。");
  };
  let manifest = previous;
  if (mode === "native") {
    environment.LOLICODE_DEV_SOURCE_FINGERPRINT = source;
    await buildNative(environment);
    assertUnchanged();
    manifest = await stageNative(environment);
    manifest.nativeBuild = {
      format: 1,
      inputFingerprint: fingerprint,
      contract: native.contract,
      version: native.version,
      info: manifest.nativeBuildInfo,
      criticalFiles: developmentCriticalFiles(packageDirectory, manifest.files),
    };
    delete manifest.nativeBuildInfo;
    atomicJson(path.join(packageDirectory, manifestName), manifest);
  } else if (mode === "renderer") {
    log("后端与运行时资源未变，仅构建开发前端……");
    const renderer = await buildRenderer(environment);
    if (
      renderer.nativeContract !== native.contract ||
      renderer.nativeVersion !== native.version
    )
      throw new Error("开发前端与原生构建契约不一致。");
    const rendererRoot = path.join(
      repository,
      "src-tauri/target/development/renderers",
    );
    if (
      pathKey(path.dirname(path.resolve(renderer.outputDirectory))) !==
      pathKey(rendererRoot)
    )
      throw new Error("开发前端产物不属于当前源码。");
    const hashes = rendererFiles(renderer.outputDirectory);
    if (!Object.hasOwn(hashes, "index.html"))
      throw new Error("开发前端入口缺失。");
    assertUnchanged();
    // Keep the executable's compiled identity intact. Only renderer provenance
    // and the combined source receipt advance in this path.
    manifest = {
      ...previous,
      sourceFingerprint: source,
      renderer,
      rendererFiles: hashes,
    };
    atomicJson(
      path.join(
        repository,
        "src-tauri/target/development/current-renderer.json",
      ),
      renderer,
    );
    atomicJson(path.join(packageDirectory, manifestName), manifest);
  } else log("源码与开发产物未变，复用已有开发版。");
  if (!noRegister) {
    const installed = readDevelopmentCache(installDirectory, repository);
    if (
      sameNative(installed, fingerprint, native) &&
      JSON.stringify(installed.nativeBuild.criticalFiles) ===
        JSON.stringify(manifest.nativeBuild.criticalFiles)
    ) {
      // No SDK tree is recopied for a frontend update. The verified native
      // executable/resources stay in place and startup reads the new pointer.
      if (JSON.stringify(installed) !== JSON.stringify(manifest))
        atomicJson(path.join(installDirectory, manifestName), manifest);
    } else await register();
  }
  return { mode, manifest };
}
