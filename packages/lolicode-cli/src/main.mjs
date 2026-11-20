import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  home,
  version,
  loadConfig,
  saveJson,
  validateChannel,
  selectedChannel,
  projectDirectory,
} from "./config.mjs";
import { resolveRuntime } from "./runtime.mjs";
import { Terminal, clean } from "./ui.mjs";
import { openSession, sessions } from "./session.mjs";

const help = `LoliCode ${version} · little paws, big ideas.

Usage: lolicode [options] [prompt]
       lolicode run [options] <prompt>     Run one task and exit
       lolicode resume [session-id]       Resume a session (latest in this project by default)
       lolicode configure                Set up a model channel
       lolicode models [list|add|use]     Manage model channels
       lolicode sessions                 List this project's saved sessions
       lolicode doctor                   Check runtime and configuration

Options:
  -p, --prompt <text>       Run one task and exit
  -C, --cwd <directory>     Project directory
      --channel <name>      Select a saved model channel
      --model <name>        Override the channel's model
      --base-url <url>      OpenAI/Anthropic-compatible API base URL
      --api <protocol>      openai-completions | openai-responses | anthropic-messages
      --api-key-env <name>  Environment variable holding the API key
      --approval <mode>     review (default) | workspace | plan | full
      --json                Print one JSON result; never prompt for input
      --stream-json         Print JSONL events and final result; never prompt
      --stdin               Append stdin to the prompt (or use '-' as the prompt)
      --timeout <seconds>   Cancel a task after this time
      --plain               Disable colors
      --no-animation        Disable the activity animation
  -h, --help                Show help
  -v, --version             Show version

Models:
  lolicode models add NAME --base-url https://example.com/v1 --model MODEL --api-key-env MY_API_KEY
  lolicode models use NAME

Set LOLICODE_BASE_URL, LOLICODE_MODEL, LOLICODE_API_KEY for environment-only setup.
LOLICODE_HOME overrides the CLI data directory (default: ~/.lolicode/cli).
API keys are read from environment variables and never saved to configuration.
Review asks before changes. Workspace allows project operations. Full allows
unrestricted tools and must be selected explicitly. These modes are tool policies,
enforced by the shared Harness runtime. Noninteractive approval requests are rejected.
Exit status: 0 success, 1 error, 2 input/approval required, 124 timeout, 130 cancelled.
`;

export function argumentsFor(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      prompt: { type: "string", short: "p" },
      cwd: { type: "string", short: "C" },
      channel: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      api: { type: "string" },
      "api-key-env": { type: "string" },
      approval: { type: "string" },
      json: { type: "boolean" },
      "stream-json": { type: "boolean" },
      stdin: { type: "boolean" },
      timeout: { type: "string" },
      plain: { type: "boolean" },
      "no-animation": { type: "boolean" },
    },
  });
  const options = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key.replace(/-([a-z])/g, (_, char) => char.toUpperCase()),
      value,
    ]),
  );
  if (options.json && options.streamJson)
    throw new Error("Choose --json or --stream-json.");
  if (
    options.approval &&
    !["review", "workspace", "plan", "full"].includes(options.approval)
  )
    throw new Error("--approval must be review, workspace, plan or full.");
  if (options.timeout !== undefined) {
    options.timeout = Number(options.timeout);
    if (
      !Number.isFinite(options.timeout) ||
      options.timeout <= 0 ||
      options.timeout > 86400
    )
      throw new Error("--timeout must be between 0 and 86400 seconds.");
  }
  return { options, positionals };
}

const exitStatus = (result) =>
  ({
    ok: 0,
    approval_required: 2,
    input_required: 2,
    timeout: 124,
    cancelled: 130,
  })[result.status] ?? 1;
const output = (value) =>
  process.stdout.write(
    `${typeof value === "string" ? clean(value) : JSON.stringify(value)}\n`,
  );

async function manageModels(words, options, ui) {
  const config = await loadConfig();
  const [action = "list", name] = words;
  if (action === "list") {
    const channels = Object.entries(config.channels).map(([name, channel]) => ({
      name,
      selected: name === config.selected,
      model: channel.model,
      api: channel.api,
      baseURL: channel.baseURL,
      apiKeyEnv: channel.apiKeyEnv,
      keyConfigured: !!process.env[channel.apiKeyEnv],
    }));
    if (options.json) output({ channels });
    else if (!channels.length)
      output("还没有模型渠道。运行 lolicode configure 开始配置。");
    else
      for (const channel of channels)
        output(
          `${channel.selected ? "*" : " "} ${channel.name} · ${channel.model} · ${channel.api} · ${channel.keyConfigured ? "key ready" : `set ${channel.apiKeyEnv}`}`,
        );
    return;
  }
  if (!name || !/^[A-Za-z0-9_-]{1,64}$/.test(name))
    throw new Error(
      "Specify a channel name using letters, numbers, '-' or '_'.",
    );
  if (action === "use") {
    if (!Object.hasOwn(config.channels, name))
      throw new Error(`Unknown channel: ${name}`);
    config.selected = name;
  } else if (action === "add") {
    if (Object.hasOwn(config.channels, name))
      throw new Error(
        `Channel ${name} already exists. Use a new name to preserve its configuration.`,
      );
    const channel = validateChannel({
      baseURL: options.baseUrl,
      model: options.model,
      api: options.api || "openai-completions",
      apiKeyEnv: options.apiKeyEnv || "LOLICODE_API_KEY",
    });
    config.channels = { ...config.channels, [name]: channel };
    config.selected ||= name;
  } else
    throw new Error("Use models list, models add NAME, or models use NAME.");
  await saveJson(path.join(home, "config.json"), config);
  output(
    options.json
      ? { status: "ok", channel: name }
      : `已${action === "add" ? "添加" : "选择"}渠道 ${name}。🐾`,
  );
}

async function configure(options, ui, { connect = false } = {}) {
  if (!ui.canAsk)
    throw new Error(
      "Interactive setup needs a terminal. Use `lolicode models add NAME --base-url URL --model MODEL --api-key-env ENV` in scripts.",
    );
  ui.note(
    "连接模型渠道 · 输入 /cancel 可返回会话。\n配置只保存地址、模型和环境变量名称。\n",
  );
  const config = await loadConfig();
  const defaultName = config.selected || "default";
  const nameAnswer = await ui.ask(`渠道名称 [${defaultName}]: `);
  if (nameAnswer === undefined || nameAnswer.trim() === "/cancel") return false;
  const name = nameAnswer.trim() || defaultName;
  const existing =
    connect && Object.hasOwn(config.channels, name)
      ? config.channels[name]
      : undefined;
  const values = [];
  for (const prompt of existing
    ? []
    : [
        "API 地址（例如 https://api.deepseek.com/v1）: ",
        "模型名称: ",
        "密钥环境变量名称 [LOLICODE_API_KEY]: ",
        "协议 [openai-completions]: ",
      ]) {
    const answer = await ui.ask(prompt);
    if (answer === undefined || answer.trim() === "/cancel") return false;
    values.push(answer.trim());
  }
  const channel = existing
    ? validateChannel(existing)
    : validateChannel({
        baseURL: values[0],
        model: values[1],
        apiKeyEnv: values[2] || "LOLICODE_API_KEY",
        api: values[3] || "openai-completions",
      });
  const { baseURL: baseUrl, model, apiKeyEnv, api } = channel;
  validateChannel({ baseURL: baseUrl, model, apiKeyEnv, api });
  let sessionKey;
  if (connect && !process.env[apiKeyEnv]) {
    ui.note(
      "可临时输入 API Key，仅本次进程使用，不保存到磁盘。也可以先设置环境变量后再启动。\n",
    );
    sessionKey = await ui.ask("API Key（输入隐藏，回车稍后连接）: ", {
      secret: true,
    });
    if (sessionKey === undefined || sessionKey.trim() === "/cancel")
      return false;
  }
  if (!existing)
    await manageModels(
      ["add", name],
      { ...options, baseUrl, model, apiKeyEnv, api },
      ui,
    );
  if (connect) {
    await manageModels(["use", name], options, ui);
    options.channel = name;
  }
  if (sessionKey?.trim()) process.env[apiKeyEnv] = sessionKey.trim();
  if (!process.env[apiKeyEnv])
    ui.note(`设置 ${apiKeyEnv} 后连接模型。当前仍可使用 /help 和 /exit。`);
  else if (!connect) ui.note("配置已就绪，进入项目目录运行 lolicode。 ");
  return true;
}

async function doctor(options) {
  const checks = [
    {
      name: "node",
      ok: Number(process.versions.node.split(".")[0]) >= 24,
      detail: process.version,
    },
    {
      name: "platform",
      ok: ["win32", "linux", "darwin"].includes(process.platform),
      detail: `${process.platform}/${process.arch}`,
    },
  ];
  for (const [name, check] of [
    ["runtime", resolveRuntime],
    ["channel", () => selectedChannel(options)],
    ["project", () => projectDirectory(options.cwd)],
  ]) {
    try {
      const result = await check();
      checks.push({
        name,
        ok: true,
        detail: result.model || result.cli || result,
      });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
    }
  }
  if (options.json)
    output({
      status: checks.every((check) => check.ok) ? "ok" : "error",
      version,
      checks,
    });
  else
    for (const check of checks)
      output(`${check.ok ? "✓" : "!"} ${check.name}: ${check.detail}`);
  process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
}

async function listSessions(options) {
  const items = await sessions(await projectDirectory(options.cwd));
  if (options.json) output({ sessions: items });
  else if (!items.length) output("这个项目还没有保存的会话。");
  else
    for (const item of items)
      output(
        `${item.id} · ${item.status} · ${item.title || "New session"} · ${item.updatedAt}`,
      );
}

export async function main(args = process.argv.slice(2)) {
  let ui;
  let session;
  let signalHandler;
  let options = {};
  try {
    const parsed = argumentsFor(args);
    options = parsed.options;
    const words = parsed.positionals;
    if (options.help || words[0] === "help") {
      output(help);
      return;
    }
    if (options.version || words[0] === "version") {
      output(version);
      return;
    }
    if (Number(process.versions.node.split(".")[0]) < 24)
      throw new Error("LoliCode CLI requires Node.js 24.9 or newer.");
    ui = new Terminal(options);
    let command = words[0];
    if (["configure", "models", "doctor", "sessions"].includes(command)) {
      const rest = words.slice(1);
      if (command === "models") await manageModels(rest, options, ui);
      if (command === "configure") await configure(options, ui);
      if (command === "doctor") await doctor(options);
      if (command === "sessions") await listSessions(options);
      return;
    }
    let prompt;
    if (command === "resume") {
      options.resume = words[1] || true;
      if (words.length > 2)
        throw new Error(
          "Use `lolicode resume SESSION -p 'prompt'` to run a task in a saved session.",
        );
      prompt = options.prompt;
    } else
      prompt =
        options.prompt ||
        (command === "run" ? words.slice(1) : words).join(" ");
    if (
      options.stdin ||
      prompt === "-" ||
      (!prompt && !process.stdin.isTTY && command !== "resume")
    ) {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += Buffer.byteLength(chunk);
        if (size > 8 * 1024 * 1024)
          throw new Error("stdin exceeds the 8 MiB limit.");
        chunks.push(chunk);
      }
      const input = Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
      ).toString("utf8");
      prompt = prompt && prompt !== "-" ? `${prompt}\n\n${input}` : input;
    }
    const once =
      command === "run" ||
      !!options.prompt ||
      options.json ||
      options.streamJson ||
      !ui.canAsk;
    if (once && !prompt?.trim())
      throw new Error(
        "Provide a task: lolicode run 'your task', or pipe input to lolicode run -.",
      );
    const cwd = await projectDirectory(options.cwd);
    if (!once) ui.banner(cwd);
    signalHandler = () => {
      if (session?.active) {
        ui.note("正在停止当前任务…");
        void session.cancel();
      } else {
        ui.close();
      }
    };
    process.on("SIGINT", signalHandler);
    ui.onInterrupt = signalHandler;
    let channelReady = true;
    try {
      await selectedChannel(options);
    } catch (error) {
      if (once) throw error;
      channelReady = false;
      ui.connectionRequired(error.message);
    }
    if (channelReady) {
      session = await openSession(options, ui);
      if (!once) ui.connected(session.metadata, options.approval);
    }
    if (prompt?.trim()) {
      if (!session)
        ui.note("任务还未发送。先输入 /connect 连接模型，再输入你的任务。\n");
      const result = session ? await session.run(prompt) : undefined;
      if (once) {
        process.exitCode = exitStatus(result);
        return;
      }
    }
    while (ui.canAsk) {
      const input = (await ui.ask(session ? "you › " : "lolicode › "))?.trim();
      if (input === undefined || input === "/exit" || input === "/quit") break;
      if (!input) continue;
      try {
        if (input === "/help") {
          output(
            "/connect 连接模型 · /new 新会话 · /resume [ID] 恢复 · /sessions 历史 · /models 渠道 · /model NAME 切换渠道 · /exit 离开",
          );
          continue;
        }
        if (input === "/connect" || input === "/configure") {
          if (!(await configure(options, ui, { connect: true }))) continue;
          await selectedChannel(options);
          const next = {
            ...options,
            cwd,
            ...(session && { resume: session.metadata.id }),
          };
          await session?.close();
          session = undefined;
          session = await openSession(next, ui);
          ui.connected(session.metadata, options.approval);
          continue;
        }
        if (input === "/sessions") {
          await listSessions({ ...options, cwd });
          continue;
        }
        if (input === "/models") {
          await manageModels([], options, ui);
          continue;
        }
        if (
          input === "/new" ||
          input.startsWith("/resume") ||
          input.startsWith("/model ")
        ) {
          const resume = input.startsWith("/resume")
            ? input.split(/\s+/)[1] || true
            : input.startsWith("/model ")
              ? session?.metadata.id
              : undefined;
          const channel = input.startsWith("/model ")
            ? input.slice(7).trim()
            : options.channel;
          // Validate a replacement before closing the current runtime.
          await selectedChannel({ ...options, channel });
          const next = { ...options, resume, channel, cwd };
          await session?.close();
          session = undefined;
          session = await openSession(next, ui);
          ui.connected(session.metadata, options.approval);
          continue;
        }
        if (input.startsWith("/")) {
          ui.note("没有这个命令，输入 /help 查看可用命令。\n");
          continue;
        }
        if (!session) {
          ui.note(
            "还没连接模型，这条消息没有发送。输入 /connect 开始配置，或 /exit 离开。\n",
          );
          continue;
        }
        await session.run(input);
      } catch (error) {
        ui.note(
          `暂时没有完成：${error.message}\n你仍在会话中，可以调整配置后继续。\n`,
        );
      }
    }
  } catch (error) {
    process.exitCode = error.name === "AbortError" ? 130 : 1;
    if (options.json || options.streamJson)
      output({ type: "result", status: "error", error: error.message });
    else process.stderr.write(`LoliCode: ${clean(error.message)}\n`);
  } finally {
    if (signalHandler) process.removeListener("SIGINT", signalHandler);
    try {
      await session?.close();
    } finally {
      ui?.close();
    }
  }
}
