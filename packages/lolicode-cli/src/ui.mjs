import { createInterface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";
import { PassThrough, Writable } from "node:stream";
import { version } from "./config.mjs";

export const slashCommands = [
  ["/connect", "连接模型"],
  ["/new", "新会话"],
  ["/sessions", "列出会话"],
  ["/resume [ID]", "恢复会话"],
  ["/models", "列出模型"],
  ["/model <渠道[/模型]>", "切换模型"],
  ["/help", "查看命令"],
  ["/exit", "离开"],
];

export function clean(value) {
  return stripVTControlCharacters(String(value)).replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    "",
  );
}

export class Terminal {
  constructor({
    json = false,
    streamJson = false,
    plain = false,
    noAnimation = false,
  } = {}) {
    this.json = json;
    this.streamJson = streamJson;
    this.color =
      !plain &&
      !process.env.NO_COLOR &&
      process.stderr.isTTY &&
      process.env.TERM !== "dumb";
    this.canAsk =
      !json && !streamJson && !!process.stdin.isTTY && !!process.stderr.isTTY;
    this.animate = this.color && !noAnimation && !process.env.CI;
    if (this.canAsk) {
      this.terminalInput = new PassThrough();
      this.terminalInput.isTTY = true;
      this.terminalInput.setRawMode = (mode) => process.stdin.setRawMode(mode);
      this.terminalOutput = new Writable({
        write: (chunk, encoding, callback) => {
          if (!this.hidingInput) process.stderr.write(chunk, encoding);
          callback();
        },
      });
      Object.defineProperty(this.terminalOutput, "columns", {
        get: () => process.stderr.columns,
      });
      this.input = createInterface({
        input: this.terminalInput,
        output: this.terminalOutput,
        terminal: true,
        completer: (line) => {
          if (!this.completeCommands || !line.startsWith("/"))
            return [[], line];
          const names = slashCommands.map(([command]) => command.split(" ")[0]);
          return [names.filter((name) => name.startsWith(line)), line];
        },
      });
      this.input.on("history", (history) => {
        if (this.hidingInput) history.shift();
      });
      this.input.on("SIGINT", () => this.onInterrupt?.());
      this.receiveInput = (chunk) => {
        if (!this.acceptingInput) {
          if (chunk.includes(3)) this.onInterrupt?.();
          return;
        }
        const end = chunk.findIndex((byte) => byte === 10 || byte === 13);
        if (end === -1) {
          this.terminalInput.write(chunk);
          return;
        }
        // Subsequent pasted lines have no prompt yet. Dropping them avoids
        // echoing a key before the hidden input prompt is active.
        this.acceptingInput = false;
        this.terminalInput.write(chunk.subarray(0, end + 1));
      };
      process.stdin.on("data", this.receiveInput);
      this.input.once("close", () => {
        this.canAsk = false;
        this.cancelQuestion();
        process.stdin.off("data", this.receiveInput);
        process.stdin.off("end", this.closeInput);
        process.stdin.pause();
      });
      this.closeInput = () => this.close();
      process.stdin.once("end", this.closeInput);
    }
    this.queue = Promise.resolve();
  }
  pink(value) {
    return this.color ? `\x1b[38;5;218m${clean(value)}\x1b[0m` : clean(value);
  }
  note(value) {
    this.stopSpinner();
    process.stderr.write(`${clean(value)}\n`);
  }
  banner(cwd) {
    this.stopSpinner();
    process.stderr.write(
      `${this.pink(`  / \\__\n (  \u2022\u1d25\u2022)  LoliCode CLI ${version}\n  / > \u2661    little paws, big ideas.`)}\n`,
    );
    this.note(`\n  项目 ${cwd}\n  /help 命令 · Tab 补全 · /exit 离开\n`);
  }
  connectionRequired(reason) {
    this.note(
      `还差一步，连接你的模型 🐾\n${reason}\n\n在 lolicode › 后输入 /connect，可按提示填写模型并隐藏输入 API Key。\n`,
    );
  }
  connected(metadata, approval = "review") {
    this.note(
      `\n● ${metadata.channel ? `${metadata.channel}/` : ""}${metadata.model} · 权限 ${approval}\n直接输入任务开始聊天，/new 开启新会话。\n`,
    );
  }
  spinner(label = "小爪爪正在忙") {
    if (this.json || this.streamJson || !this.animate) return;
    this.stopSpinner();
    let step = 0;
    this.timer = setInterval(
      () =>
        process.stderr.write(
          `\r\x1b[2K${this.pink(["·  ", "·· ", "···", " ··", "  ·"][step++ % 5])} ${label}`,
        ),
      160,
    );
    this.timer.unref();
  }
  stopSpinner() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      process.stderr.write("\r\x1b[2K");
    }
  }
  ask(prompt, { secret = false, commands = false } = {}) {
    if (!this.input) return Promise.resolve(undefined);
    const operation = this.queue.then(async () => {
      if (!this.canAsk) return undefined;
      this.stopSpinner();
      this.questionAbort = new AbortController();
      this.completeCommands = commands && !secret;
      try {
        if (secret) {
          process.stderr.write(clean(prompt));
          this.hidingInput = true;
        }
        this.acceptingInput = true;
        return await this.input.question(secret ? "" : clean(prompt), {
          signal: this.questionAbort.signal,
        });
      } catch {
        return undefined;
      } finally {
        this.acceptingInput = false;
        this.completeCommands = false;
        if (secret) {
          this.hidingInput = false;
          process.stderr.write("\n");
        }
        this.questionAbort = undefined;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  event(event) {
    if (this.streamJson) process.stdout.write(`${JSON.stringify(event)}\n`);
  }
  text(value) {
    this.stopSpinner();
    if (!this.json && !this.streamJson) process.stdout.write(clean(value));
  }
  result(value) {
    this.stopSpinner();
    if (this.json || this.streamJson)
      process.stdout.write(`${JSON.stringify({ type: "result", ...value })}\n`);
  }
  cancelQuestion() {
    this.questionAbort?.abort();
  }
  close() {
    this.stopSpinner();
    this.cancelQuestion();
    this.input?.close();
    this.canAsk = false;
  }
}
