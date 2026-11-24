import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { version } from "./config.mjs";
import { clean, slashCommands } from "./ui.mjs";
import { renderWorkspace } from "./workspace-render.mjs";

const enterScreen = "\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[2J";
const leaveScreen = "\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const commands = slashCommands.map(([command, description]) => ({
  command: command.split(" ")[0],
  description,
}));

export function canUseWorkspace(options) {
  return !options.plain && !options.json && !options.streamJson &&
    process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY &&
    process.env.TERM !== "dumb";
}

export class WorkspaceTerminal {
  canAsk = true;
  fullScreen = true;
  entries = [];
  scroll = 0;
  scrollMax = 0;
  history = [];
  queue = Promise.resolve();

  constructor({ approval = "review" } = {}) {
    this.approval = approval;
    this.color = !Object.hasOwn(process.env, "NO_COLOR");
    this.colorDepth = process.stderr.getColorDepth();
    this.safeGlyphs = process.platform === "win32" && !process.env.WT_SESSION;
  }

  banner(cwd, channel) {
    this.cwd = cwd;
    this.connected(channel);
    const { stdin, stderr } = process;
    this.decoder = new PassThrough();
    emitKeypressEvents(this.decoder);
    this.decoder.on("keypress", (character, key) => {
      this.keypress(character, key);
      this.schedule();
    });
    this.read = (bytes) => this.decoder.write(bytes);
    this.resize = () => this.schedule();
    this.end = () => this.close();
    this.rawBefore = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.on("data", this.read);
    stdin.once("end", this.end);
    stderr.on("resize", this.resize);
    process.once("exit", this.end);
    stderr.write(enterScreen);
    stdin.resume();
    this.schedule();
  }

  connected(channel) {
    this.model = channel ? `${channel.name}/${channel.model}` : "";
    this.schedule();
  }

  note(value) {
    this.append("note", value);
  }

  user(value) {
    this.scroll = 0;
    this.append("user", value);
  }

  tool(value) {
    this.endMessage();
    this.append("tool", value);
  }

  text(value) {
    if (!this.answer) this.answer = this.append("assistant", "");
    this.answer.text += clean(value);
    this.status = "正在回复";
    this.schedule();
  }

  endMessage() {
    this.answer = undefined;
  }

  append(kind, value) {
    const entry = { kind, text: clean(value).trimEnd() };
    this.entries.push(entry);
    if (this.entries.length > 240) this.entries.shift();
    this.schedule();
    return entry;
  }

  spinner(label = "正在回复") {
    this.status = label;
    this.schedule();
  }

  stopSpinner() {
    this.status = "";
    this.schedule();
  }

  // The interactive screen renders semantic messages, not the machine stream.
  event() {}
  result() {}

  reset() {
    this.entries = [];
    this.scroll = 0;
    this.endMessage();
    this.schedule();
  }

  ask(title, { commands: composer = false, secret = false, detail } = {}) {
    return this.request({ title, composer, secret, detail, text: "", cursor: 0 });
  }

  choose(title, labels) {
    return this.request({ title, labels, selected: 0, digits: "" });
  }

  request(input) {
    const operation = this.queue.then(() => {
      if (!this.canAsk) return undefined;
      return new Promise((resolve) => {
        this.input = { ...input, resolve };
        this.historyIndex = this.history.length;
        this.historyDraft = "";
        this.suggestionIndex = 0;
        this.stopSpinner();
        this.schedule();
      });
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  cancelQuestion() {
    this.finish();
  }

  finish(value) {
    const input = this.input;
    this.input = undefined;
    this.pasting = false;
    input?.resolve(value);
    this.schedule();
  }

  suggestions(input = this.input) {
    if (!input?.composer || !/^\/[^\s]*$/.test(input.text)) return [];
    return commands.filter(({ command }) => command.startsWith(input.text));
  }

  keypress(character, key) {
    const input = this.input;
    if (!input) {
      if (key.ctrl && key.name === "c") this.onInterrupt?.();
      else this.scrollKey(key);
      return;
    }
    if (key.name === "paste-start") {
      this.pasting = true;
      this.pasteReturn = false;
      return;
    }
    if (key.name === "paste-end") {
      this.pasting = false;
      return;
    }
    if (this.pasting) {
      const newline = key.name === "return" || key.name === "enter";
      const afterReturn = this.pasteReturn;
      this.pasteReturn = key.name === "return";
      if (!input.labels && !(key.name === "enter" && afterReturn)) {
        if (newline && input.composer) this.insert(input, "\n");
        else if (!newline) this.insert(input, clean(character ?? "").replaceAll("\t", " "));
      }
      return;
    }
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      if (!input.composer) this.finish();
      else if (input.text) this.edit(input, "", 0);
      else if (key.ctrl) this.onInterrupt?.();
      return;
    }
    if (input.labels) {
      this.select(input, character, key);
      return;
    }
    if (input.composer && this.scrollKey(key)) return;
    if (input.composer && key.ctrl && key.name === "p") {
      this.edit(input, "/", 1);
      return;
    }
    const suggestions = this.suggestions(input);
    if (input.composer && (key.name === "up" || key.name === "down")) {
      const direction = key.name === "up" ? -1 : 1;
      if (suggestions.length)
        this.suggestionIndex = (this.suggestionIndex + direction + suggestions.length) % suggestions.length;
      else this.recall(input, direction);
      return;
    }
    if (key.name === "tab" && suggestions.length) {
      const { command } = suggestions[this.suggestionIndex] ?? suggestions[0];
      this.edit(input, command, command.length);
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      if (input.composer && (key.shift || key.meta)) this.insert(input, "\n");
      else {
        if (input.composer && input.text.trim()) {
          this.history.push(input.text);
          if (this.history.length > 100) this.history.shift();
        }
        this.finish(input.text);
      }
      return;
    }
    this.editKey(input, character, key);
  }

  select(input, character, key) {
    const count = input.labels.length;
    const { name } = key;
    if (name === "return" || name === "enter") {
      const index = input.digits ? Number(input.digits) - 1 : input.selected;
      if (index >= 0 && index < count) this.finish(index);
      else input.digits = "";
    } else if (name === "up" || name === "down") {
      input.digits = "";
      input.selected = (input.selected + (name === "up" ? -1 : 1) + count) % count;
    } else if (name === "home" || name === "end") {
      input.digits = "";
      input.selected = name === "home" ? 0 : count - 1;
    } else if (/^\d$/.test(character ?? "")) {
      input.digits = (input.digits + character).slice(0, String(count).length);
      const index = Number(input.digits) - 1;
      if (index >= 0 && index < count) input.selected = index;
    } else if (name === "backspace") input.digits = input.digits.slice(0, -1);
  }

  scrollKey({ name, ctrl }) {
    const page = Math.max(1, (process.stderr.rows || 24) - 10);
    if (name === "pageup") this.scroll = Math.min(this.scrollMax, this.scroll + page);
    else if (name === "pagedown") this.scroll = Math.max(0, this.scroll - page);
    else if (ctrl && name === "end") this.scroll = 0;
    else return false;
    return true;
  }

  recall(input, direction) {
    const current = this.historyIndex;
    if (current === this.history.length) this.historyDraft = input.text;
    this.historyIndex = Math.max(0, Math.min(this.history.length, current + direction));
    const text = this.history[this.historyIndex] ?? this.historyDraft;
    this.edit(input, text, text.length);
  }

  editKey(input, character, key) {
    const { text, cursor } = input;
    const { name, ctrl, meta } = key;
    if ((ctrl && name === "a") || name === "home") input.cursor = 0;
    else if ((ctrl && name === "e") || name === "end") input.cursor = text.length;
    else if (ctrl && name === "u") this.edit(input, text.slice(cursor), 0);
    else if (ctrl && name === "d" && !text && input.composer) this.onInterrupt?.();
    else if (name === "backspace" && cursor > 0) {
      const start = graphemes.segment(text).containing(cursor - 1).index;
      this.edit(input, text.slice(0, start) + text.slice(cursor), start);
    } else if (name === "delete" && cursor < text.length) {
      const { index, segment } = graphemes.segment(text).containing(cursor);
      this.edit(input, text.slice(0, cursor) + text.slice(index + segment.length), cursor);
    } else if (name === "left" && cursor > 0)
      input.cursor = graphemes.segment(text).containing(cursor - 1).index;
    else if (name === "right" && cursor < text.length) {
      const { index, segment } = graphemes.segment(text).containing(cursor);
      input.cursor = index + segment.length;
    } else if (!ctrl && !meta && character && character >= " " && name !== "tab") {
      this.insert(input, clean(character));
    }
  }

  insert(input, value) {
    if (input.text.length + value.length > (input.secret ? 4096 : 65536)) return;
    this.edit(input, input.text.slice(0, input.cursor) + value + input.text.slice(input.cursor),
      input.cursor + value.length);
  }

  edit(input, text, cursor) {
    input.text = text;
    input.cursor = cursor;
    this.suggestionIndex = 0;
  }

  schedule() {
    if (!this.decoder || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.draw();
    }, 16);
  }

  draw() {
    const input = this.input;
    const columns = process.stderr.columns || 80;
    const rows = process.stderr.rows || 24;
    const previous = this.lastLayout?.columns === columns && this.lastLayout?.height === rows
      ? this.lastLayout
      : undefined;
    const state = {
      columns,
      rows,
      previousRows: previous?.rows,
      color: this.color,
      colorDepth: this.colorDepth,
      safeGlyphs: this.safeGlyphs,
      version,
      cwd: this.cwd,
      model: this.model,
      approval: this.approval,
      entries: this.entries,
      scroll: this.scroll,
      status: this.status,
      composer: input?.composer ? {
        text: input.text,
        cursor: input.cursor,
        active: true,
        suggestions: this.suggestions(),
        suggestionIndex: this.suggestionIndex,
      } : { text: "", cursor: 0, active: false },
    };
    if (input && !input.composer) {
      state.dialog = input.labels
        ? { title: input.title, labels: input.labels, selected: input.selected, digits: input.digits }
        : {
          title: input.title,
          text: input.secret ? "*".repeat(input.text.length) : input.text,
          cursor: input.cursor,
          detail: input.detail,
          secret: input.secret,
        };
    }
    let layout = renderWorkspace(state);
    if (previous && this.scroll && layout.scrollMax > previous.scrollMax) {
      state.scroll += layout.scrollMax - previous.scrollMax;
      this.scroll = state.scroll;
      layout = renderWorkspace(state);
    }
    this.lastLayout = { ...layout, columns };
    this.scrollMax = layout.scrollMax;
    this.scroll = Math.min(this.scroll, this.scrollMax);
    process.stderr.write(layout.frame);
  }

  close() {
    if (!this.canAsk) return;
    this.canAsk = false;
    this.cancelQuestion();
    clearTimeout(this.timer);
    if (!this.decoder) return;
    process.stdin.off("data", this.read);
    process.stdin.off("end", this.end);
    process.stderr.off("resize", this.resize);
    process.off("exit", this.end);
    process.stdin.setRawMode(!!this.rawBefore);
    process.stdin.pause();
    this.decoder.destroy();
    this.decoder = undefined;
    process.stderr.write(leaveScreen);
  }
}
