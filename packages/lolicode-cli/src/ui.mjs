import { createInterface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";
import { Writable } from "node:stream";
import { version } from "./config.mjs";

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
        input: process.stdin,
        output: this.terminalOutput,
        terminal: true,
      });
      this.input.on("SIGINT", () => this.onInterrupt?.());
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
    this.note(
      `\n  你的终端编程伙伴 · 在这里对话、修改项目、运行工具\n  项目 ${cwd}\n  /help 命令 · /connect 连接模型 · /exit 离开\n`,
    );
  }
  connectionRequired(reason) {
    this.note(
      `还差一步：连接你的模型 🐾\n${reason}\n\n输入 /connect 开始引导；/help 查看命令。\n你仍在 LoliCode 会话中，这里的文字不会作为系统命令执行。\n`,
    );
  }
  connected(metadata, approval = "review") {
    this.note(
      `\n● ${metadata.model} · 权限 ${approval}\n直接输入任务开始聊天，/new 开启新会话。\n`,
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
  ask(prompt, { secret = false } = {}) {
    if (!this.input) return Promise.resolve(undefined);
    const operation = this.queue.then(async () => {
      this.stopSpinner();
      this.questionAbort = new AbortController();
      try {
        if (secret) {
          process.stderr.write(clean(prompt));
          this.hidingInput = true;
        }
        return await this.input.question(secret ? "" : clean(prompt), {
          signal: this.questionAbort.signal,
        });
      } catch {
        return undefined;
      } finally {
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
