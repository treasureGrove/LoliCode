import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
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
import { Terminal, clean, slashCommands } from "./ui.mjs";
import { openSession, resumeMetadata, sessions } from "./session.mjs";

const help = `LoliCode ${version} · little paws, big ideas.

Usage: lolicode [project] [options]        Start an interactive session
       lolicode mini [project] [options]   Start the terminal prompt
       lolicode run [options] <message>    Run one task and exit
       lolicode session list              List saved sessions
       lolicode auth login [channel]      Set up a model channel
       lolicode auth list                 Show configured channels and key status
       lolicode models [channel]          List configured channel/model IDs
       lolicode doctor                   Check runtime and configuration

Also available: resume [ID], sessions, configure, models add NAME, models use NAME.

Options:
  -p, --prompt <text>       Run one task and exit (initial message in mini)
  -c, --continue            Continue the latest session in the project
  -s, --session <id>        Continue a saved LoliCode session
      --dir <directory>     Work in a project directory
  -C, --cwd <directory>     Project directory
      --channel <name>      Select a saved model channel
  -m, --model <id>          Select a saved channel/model, or pass a raw model ID
      --base-url <url>      OpenAI/Anthropic-compatible API base URL
      --api <protocol>      openai-completions | openai-responses | anthropic-messages
      --api-key-env <name>  Environment variable holding the API key
      --approval <mode>     review (default) | workspace | plan | full
      --json                Print one JSON result; never prompt for input
      --stream-json         Print JSONL events and final result; never prompt
      --format <format>     run: default|json (JSONL); session list: table|json
  -n, --max-count <number>  Limit the number of sessions shown
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
      dir: { type: "string" },
      continue: { type: "boolean", short: "c" },
      session: { type: "string", short: "s" },
      channel: { type: "string" },
      model: { type: "string", short: "m" },
      "base-url": { type: "string" },
      api: { type: "string" },
      "api-key-env": { type: "string" },
      approval: { type: "string" },
      json: { type: "boolean" },
      "stream-json": { type: "boolean" },
      format: { type: "string" },
      "max-count": { type: "string", short: "n" },
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
  if (options.dir !== undefined) {
    if (options.cwd !== undefined && options.cwd !== options.dir)
      throw new Error("Choose one project directory with --dir or --cwd.");
    options.cwd = options.dir;
  }
  if (options.session !== undefined && !options.session)
    throw new Error("--session requires a session ID.");
  if (options.continue && options.session)
    throw new Error("Choose --continue or --session.");
  options.resume = options.session || options.continue || undefined;

  const [command, action] = positionals;
  const sessionList = command === "session" && action === "list";
  const list =
    sessionList ||
    command === "sessions" ||
    command === "models" ||
    (command === "auth" && ["list", "ls"].includes(action));
  if (options.format !== undefined) {
    const allowed = list ? ["table", "json"] : ["default", "json"];
    if (!allowed.includes(options.format))
      throw new Error(`--format must be ${allowed.join(" or ")}.`);
    if (options.json || options.streamJson)
      throw new Error("Choose --format or one of --json and --stream-json.");
    options.json = list && options.format === "json";
    options.streamJson = !list && options.format === "json";
  }
  if (options.maxCount !== undefined) {
    if (!sessionList && command !== "sessions")
      throw new Error("--max-count is for session list.");
    if (
      !/^\d+$/.test(options.maxCount) ||
      !Number.isSafeInteger(Number(options.maxCount)) ||
      Number(options.maxCount) < 1
    )
      throw new Error("--max-count must be a positive integer.");
    options.maxCount = Number(options.maxCount);
  }
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

async function manageModels(words, options) {
  const config = await loadConfig();
  const [action = "list", name] = words;
  if (action === "list" || (!name && !["add", "use"].includes(action))) {
    const filter = action === "list" ? name : action;
    const channels = Object.entries(config.channels)
      .filter(([name]) => !filter || name === filter)
      .map(([name, channel]) => ({
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
      output("还没有模型渠道。运行 lolicode auth login 开始配置。");
    else
      for (const channel of channels)
        output(
          `${channel.selected ? "*" : " "} ${channel.name}/${channel.model} · ${channel.api} · ${channel.keyConfigured ? "key ready" : `set ${channel.apiKeyEnv}`}`,
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
    if (options.select || !config.selected) config.selected = name;
  } else
    throw new Error("Use models list, models add NAME, or models use NAME.");
  await saveJson(path.join(home, "config.json"), config);
  output(
    options.json
      ? { status: "ok", channel: name }
      : `已${action === "add" ? "添加" : "选择"}渠道 ${name}。🐾`,
  );
}

async function configure(
  options,
  ui,
  { connect = false, login = false, channelName } = {},
) {
  if (!ui.canAsk)
    throw new Error(
      "Interactive setup needs a terminal. Use `lolicode models add NAME --base-url URL --model MODEL --api-key-env ENV` in scripts.",
    );
  ui.note(
    "连接模型渠道 · 输入 /cancel 可返回会话。\n配置只保存地址、模型和环境变量名称。\n",
  );
  const config = await loadConfig();
  const defaultName = options.channel || config.selected || "default";
  const nameAnswer =
    channelName ?? (await ui.ask(`渠道名称 [${defaultName}]: `));
  if (nameAnswer === undefined || nameAnswer.trim() === "/cancel") return false;
  const name = nameAnswer.trim() || defaultName;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
    throw new Error(
      "Specify a channel name using letters, numbers, '-' or '_'.",
    );
  const select = connect || login;
  const existing =
    select && Object.hasOwn(config.channels, name)
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
    await manageModels(["add", name], {
      ...options,
      baseUrl,
      model,
      apiKeyEnv,
      api,
      select,
    });
  else await manageModels(["use", name], options);
  if (sessionKey?.trim()) process.env[apiKeyEnv] = sessionKey.trim();
  if (!process.env[apiKeyEnv])
    ui.note(`设置 ${apiKeyEnv} 后运行 lolicode 连接模型。`);
  else if (!connect) ui.note("配置已就绪，进入项目目录运行 lolicode。 ");
  return name;
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

async function listSessions(options, { allProjects = false } = {}) {
  const cwd =
    allProjects && !options.cwd
      ? undefined
      : await projectDirectory(options.cwd);
  const savedSessions = await sessions(cwd);
  const items = options.maxCount
    ? savedSessions.slice(0, options.maxCount)
    : savedSessions;
  if (options.format === "json") output(items);
  else if (options.json) output({ sessions: items });
  else if (!items.length)
    output(cwd ? "这个项目还没有保存的会话。" : "还没有保存的会话。");
  else
    for (const item of items)
      output(
        `${item.id} · ${item.status} · ${item.title || "New session"} · ${item.updatedAt}${cwd ? "" : ` · ${item.cwd}`}`,
      );
}

async function positionalProject(words) {
  if (words.length !== 1 || !words[0] || words[0] === "-") return undefined;
  const directory = words[0];
  if (path.isAbsolute(directory) || /^(?:~|\.{1,2})(?:[\\/]|$)/.test(directory))
    return directory;
  try {
    if ((await stat(directory)).isDirectory()) return directory;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "ENAMETOOLONG", "EINVAL"].includes(error.code))
      throw error;
  }
  return undefined;
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
    const command = words[0];
    const rest = words.slice(1);
    if (command === "session") {
      if (rest.length !== 1 || rest[0] !== "list")
        throw new Error(
          "Use lolicode session list [--dir DIRECTORY] [--format json].",
        );
      await listSessions(options, { allProjects: true });
      return;
    }
    if (command === "auth") {
      if (rest[0] === "login" && rest.length <= 2)
        await configure(options, ui, { login: true, channelName: rest[1] });
      else if (["list", "ls"].includes(rest[0]) && rest.length === 1)
        await manageModels([], options);
      else throw new Error("Use lolicode auth login [CHANNEL] or auth list.");
      return;
    }
    if (["configure", "models", "doctor", "sessions"].includes(command)) {
      if (command === "models") await manageModels(rest, options);
      if (command === "configure") await configure(options, ui);
      if (command === "doctor") await doctor(options);
      if (command === "sessions") await listSessions(options);
      return;
    }
    let prompt = options.prompt;
    if (command === "resume") {
      if (options.resume)
        throw new Error("Use resume or --continue/--session.");
      options.resume = rest[0] || true;
      if (words.length > 2)
        throw new Error(
          "Use `lolicode resume SESSION -p 'prompt'` to run a task in a saved session.",
        );
    } else if (command === "run") {
      prompt ||= rest.join(" ");
    } else {
      const input = command === "mini" ? rest : words;
      const directory = options.cwd
        ? undefined
        : await positionalProject(input);
      if (directory) options.cwd = directory;
      else prompt ||= input.join(" ");
    }
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
      (!!options.prompt && command !== "mini") ||
      options.json ||
      options.streamJson ||
      !ui.canAsk;
    if (once && !prompt?.trim())
      throw new Error(
        "Provide a task: lolicode run 'your task', or pipe input to lolicode run -.",
      );
    const resume = options.resume
      ? await resumeMetadata(options.resume, options.cwd)
      : undefined;
    const cwd = resume?.cwd ?? (await projectDirectory(options.cwd));
    if (resume) options.resume = resume.id;
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
    try {
      session = await openSession({ ...options, cwd }, ui);
      if (!once) ui.connected(session.metadata, options.approval);
    } catch (error) {
      if (once) throw error;
      ui.connectionRequired(error.message);
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
      const input = (
        await ui.ask(session ? "you › " : "lolicode › ", { commands: true })
      )?.trim();
      if (input === undefined || input === "/exit" || input === "/quit") break;
      if (!input) continue;
      try {
        const [action, argument] = input.split(/\s+/, 2);
        if (input === "/help" || input === "/") {
          output(
            slashCommands
              .map(
                ([command, description]) =>
                  `  ${command.padEnd(23)} ${description}`,
              )
              .join("\n"),
          );
          continue;
        }
        if (action === "/connect" || action === "/configure") {
          const channel = await configure(options, ui, {
            connect: true,
            channelName: argument,
          });
          if (!channel) continue;
          const next = {
            ...options,
            channel,
            model: undefined,
            baseUrl: undefined,
            cwd,
            ...(session && { resume: session.metadata.id }),
          };
          await selectedChannel(next);
          await session?.close();
          session = undefined;
          session = await openSession(next, ui);
          options = next;
          ui.connected(session.metadata, options.approval);
          continue;
        }
        if (input === "/sessions") {
          await listSessions({ ...options, cwd });
          continue;
        }
        if (input === "/models") {
          await manageModels([], options);
          continue;
        }
        if (input === "/new" || action === "/resume" || action === "/model") {
          if (action === "/model" && !argument)
            throw new Error("用法 /model 渠道[/模型]");
          const requested =
            action === "/resume"
              ? argument || true
              : action === "/model"
                ? session?.metadata.id
                : undefined;
          const target = requested
            ? await resumeMetadata(requested, cwd)
            : undefined;
          const next = { ...options, resume: target?.id, cwd };
          if (action === "/model") {
            const [channel, ...model] = argument.split("/");
            next.channel = channel;
            next.model = model.length ? model.join("/") : undefined;
            next.baseUrl = undefined;
          }
          // Validate the target before leaving the current session.
          await selectedChannel(next, target);
          await session?.close();
          session = undefined;
          session = await openSession(next, ui);
          options = next;
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
