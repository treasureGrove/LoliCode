import {
  mkdir,
  readFile,
  rename,
  writeFile,
  chmod,
  realpath,
  open,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export const version = "0.1.0-alpha.3";
export const home = path.resolve(
  process.env.LOLICODE_HOME || path.join(os.homedir(), ".lolicode", "cli"),
);
export const apis = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, file);
    if (process.platform !== "win32") await chmod(file, 0o600);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function validateChannel(channel) {
  if (
    !channel ||
    typeof channel !== "object" ||
    typeof channel.model !== "string" ||
    !channel.model.trim()
  )
    throw new Error("A model name is required (--model).");
  const url = new URL(channel.baseURL);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "The API base URL must be an HTTP(S) URL without credentials, query or fragment.",
    );
  }
  if (!apis.includes(channel.api))
    throw new Error(`Supported API protocols: ${apis.join(", ")}`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(channel.apiKeyEnv))
    throw new Error("--api-key-env must be an environment variable name.");
  return { ...channel, baseURL: url.href.replace(/\/$/, "") };
}

export async function loadConfig() {
  const config = await readJson(path.join(home, "config.json"), {
    channels: {},
  });
  if (
    !config.channels ||
    typeof config.channels !== "object" ||
    Array.isArray(config.channels)
  )
    throw new Error("Invalid CLI channel configuration.");
  return config;
}

export async function selectedChannel(options = {}, saved = {}) {
  const config = await loadConfig();
  // Registered channel names can qualify a model. Other slashes can be part
  // of the actual API model ID (for example an OpenRouter organization).
  const [prefix, ...suffix] = options.model?.split("/") ?? [];
  const qualified =
    !options.channel &&
    !options.baseUrl &&
    suffix.length > 0 &&
    Object.hasOwn(config.channels, prefix);
  const selected =
    options.channel ||
    (qualified && prefix) ||
    saved.channel ||
    config.selected;
  const model = qualified ? suffix.join("/") : options.model;
  let channel =
    selected && Object.hasOwn(config.channels, selected)
      ? config.channels[selected]
      : undefined;
  if (selected && !channel) throw new Error(`Unknown channel: ${selected}`);
  const baseURL =
    options.baseUrl ||
    (!options.channel &&
      !qualified &&
      !saved.channel &&
      process.env.LOLICODE_BASE_URL);
  if (baseURL) {
    channel = {
      ...channel,
      baseURL,
      model:
        model ||
        (!options.channel && saved.model) ||
        process.env.LOLICODE_MODEL ||
        channel?.model,
      api:
        options.api ||
        process.env.LOLICODE_API ||
        channel?.api ||
        "openai-completions",
      apiKeyEnv: options.apiKeyEnv || "LOLICODE_API_KEY",
    };
  }
  if (!channel)
    throw new Error(
      "Set up a model with `lolicode auth login`, or set LOLICODE_BASE_URL, LOLICODE_MODEL and LOLICODE_API_KEY.",
    );
  channel = validateChannel({
    ...channel,
    model:
      model ?? (!options.channel && saved.model ? saved.model : channel.model),
  });
  if (!process.env[channel.apiKeyEnv])
    throw new Error(
      `Set ${channel.apiKeyEnv} in your environment before starting. API keys are never stored in the CLI configuration.`,
    );
  return { ...channel, name: baseURL ? "environment" : selected };
}

export function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
export const sessionFile = (id) => {
  if (!validId(id)) throw new Error("Invalid session ID.");
  return path.join(home, "sessions", `${id}.json`);
};
export async function projectDirectory(directory = process.cwd()) {
  const expanded = /^~(?:[\\/]|$)/.test(directory)
    ? path.join(os.homedir(), directory.slice(1))
    : directory;
  const project = await realpath(path.resolve(expanded));
  const { stat } = await import("node:fs/promises");
  if (!(await stat(project)).isDirectory())
    throw new Error("The project path must be a directory.");
  return project;
}

export async function sessionLock(id) {
  await mkdir(path.join(home, "locks"), { recursive: true, mode: 0o700 });
  const file = path.join(home, "locks", `${id}.lock`);
  if (!validId(id)) throw new Error("Invalid session ID.");
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `Session ${id} is already open. If a previous process crashed, remove its lock after checking no CLI is using it: ${file}`,
    );
  }
  await handle.writeFile(String(process.pid));
  return async () => {
    await handle.close();
    await unlink(file).catch(() => {});
  };
}
