import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { PassThrough, Writable } from "node:stream";
import { version } from "./config.mjs";

export const slashCommands = [
  ["/connect", "连接模型"],
  ["/new", "新会话"],
  ["/sessions", "列出会话"],
  ["/resume [ID]", "恢复会话"],
  ["/models", "选择模型"],
  ["/send", "发送保留的草稿"],
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
        if (this.menu) {
          // Pass the current selection's input through its own key decoder.
          const end = chunk.findIndex((byte) => byte === 10 || byte === 13);
          this.menu.input.write(end < 0 ? chunk : chunk.subarray(0, end + 1));
          return;
        }
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
        this.menu?.finish();
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
  banner(cwd, channel) {
    this.stopSpinner();
    const rule = "─".repeat(Math.min(46, Math.max(20, (process.stderr.columns || 48) - 4)));
    process.stderr.write(`\n  ${this.pink(rule)}\n`);
    this.note(`  🐾 LoliCode ${version}\n  项目  ${cwd}`);
    this.connected(channel);
    process.stderr.write(`  ${this.pink(rule)}\n`);
    this.note("  /connect 连接服务商    /models 选模型    /help 命令\n");
  }
  connected(channel) {
    this.note(channel ? `  模型  ${channel.name}/${channel.model}` : "  模型  未连接");
  }
  async choose(title, labels) {
    if (!this.canAsk) return undefined;
    this.note(`\n${title}\n${labels.map((label, index) => `  ${index + 1}  ${label}`).join("\n")}`);
    if (process.env.TERM === "dumb") {
      while (this.canAsk) {
        const answer = await this.ask("输入编号，回车选第 1 项，0 取消: ");
        if (answer === undefined || ["0", "/cancel"].includes(answer.trim())) return undefined;
        const index = Number(answer.trim() || 1) - 1;
        if (Number.isInteger(index) && index >= 0 && index < labels.length) return index;
      }
      return undefined;
    }
    this.note("  ↑↓ 选择 · 回车确认 · Esc 返回");
    return new Promise((resolve) => {
      const input = new PassThrough();
      let index = 0;
      let digits = "";
      const render = () => process.stderr.write(`\r\x1b[2K  › ${digits || index + 1}`);
      const finish = (value) => {
        this.menu = undefined;
        input.destroy();
        process.stderr.write("\n");
        resolve(value);
      };
      this.menu = { input, finish };
      emitKeypressEvents(input);
      input.on("keypress", (char, key) => {
        if (key.name === "escape" || (key.ctrl && key.name === "c")) {
          finish();
        } else if (key.name === "return" || key.name === "enter") {
          const chosen = digits ? Number(digits) - 1 : index;
          if (chosen >= 0 && chosen < labels.length) finish(chosen);
          else {
            digits = "";
            render();
          }
        } else if (key.name === "down" || key.name === "up") {
          digits = "";
          index = (index + (key.name === "down" ? 1 : -1) + labels.length) % labels.length;
          render();
        } else if (char && /^(0|[1-9])$/.test(char)) {
          digits = (digits + char).slice(0, String(labels.length).length);
          render();
        } else if (key.name === "backspace") {
          digits = digits.slice(0, -1);
          render();
        }
      });
      render();
    });
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
