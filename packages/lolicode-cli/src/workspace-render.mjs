import { stripVTControlCharacters } from "node:util";

const esc = "\x1b[";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const nonprinting = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
const emoji = /\p{Emoji_Presentation}|\p{Regional_Indicator}|[\ufe0f\u20e3]/u;
const wide = /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;

const canvas = [0x211b1e, 234];
const cream = [0xfff6ea, 230];
const rose = [0xf8afc4, 218];
const gold = [0xf1ba76, 216];
const muted = [0xb5a3a7, 249];
const panel = [0x30272b, 236];
const cherry = [0x5d142a, 52];
const selection = [0x6e1831, 89];
const backdrop = [0x181416, 233];
const palette = {
  base: [cream, canvas],
  rose: [rose, canvas],
  gold: [gold, canvas],
  muted: [muted, canvas],
  panel: [cream, panel],
  panelMuted: [muted, panel],
  panelAccent: [rose, panel],
  selected: [cream, selection],
  selectedAccent: [rose, selection],
  dim: [[0x816c74, 243], backdrop],
  hero: [cream, cherry],
  heroTitle: [cream, cherry, true],
  heroGold: [gold, cherry],
  fur: [cream, [0xc8957c, 180]],
  ear: [cream, [0x885947, 95]],
  hair: [cream, [0xea8da5, 211]],
  hairLight: [cream, [0xf5adc0, 218]],
  muzzle: [cream, cream],
  cheek: [cream, [0xf4b4b2, 217]],
  eye: [cream, [0x422430, 53]],
  bow: [cream, [0xb23b5c, 125]],
};

// Each pixel occupies two terminal columns so the character stays in proportion.
const puppy = [
  "    hhhhh    ",
  " eehllhhhee  ",
  "eecchhhhccee ",
  "eecocccoccee ",
  " efpcocpfe   ",
  "   ccccc  c  ",
  "   bbcbff f  ",
  "  fccccccf   ",
  "  ccc  ccc   ",
];
const pixels = {
  b: "bow", c: "muzzle", e: "ear", f: "fur", h: "hair", l: "hairLight", o: "eye", p: "cheek",
};
const puppyAscii = [" /\\___/\\ ", "( /o o\\ )", " U( v )U ", "  /|_|\\~ "];

const withoutAnsi = (value) =>
  stripVTControlCharacters(String(value ?? ""))
    .replace(nonprinting, "")
    .replace(/\t/g, "    ");
const isEmoji = (text) => emoji.test(text);
const displayGlyph = (text, safeGlyphs) =>
  safeGlyphs && (isEmoji(text) || text.includes("\ufffd")) ? "*" : text;

function cellWidth(text) {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(text)) return 0;
  return wide.test(text) || isEmoji(text) ? 2 : 1;
}

export function displayWidth(text, safeGlyphs = false) {
  let width = 0;
  for (const { segment } of graphemes.segment(withoutAnsi(text))) {
    width += cellWidth(displayGlyph(segment, safeGlyphs));
  }
  return width;
}

function wrap(text, width, { safeGlyphs, cursor } = {}) {
  const lines = [""];
  let column = 0;
  let position;
  for (const { segment, index } of graphemes.segment(text)) {
    if (segment === "\n") {
      if (index === cursor) position = { row: lines.length - 1, column };
      lines.push("");
      column = 0;
      continue;
    }
    const glyph = displayGlyph(segment, safeGlyphs);
    const cells = cellWidth(glyph);
    if (column && column + cells > width) {
      lines.push("");
      column = 0;
    }
    if (cursor >= index && cursor < index + segment.length) {
      position = { row: lines.length - 1, column };
    }
    lines[lines.length - 1] += cells <= width ? glyph : "?";
    column += Math.min(cells, width);
  }
  if (!position) position = { row: lines.length - 1, column };
  return { lines, position };
}

function clipped(text, width, safeGlyphs) {
  if (width <= 0) return "";
  let result = "";
  let column = 0;
  for (const { segment } of graphemes.segment(withoutAnsi(text).replace(/\n/g, " "))) {
    const glyph = displayGlyph(segment, safeGlyphs);
    const cells = cellWidth(glyph);
    if (column + cells > width) break;
    result += glyph;
    column += cells;
  }
  return result;
}

function createCanvas(width, height, color, colorDepth) {
  const blank = { glyph: " ", cells: 1, style: "base" };
  const lines = Array.from({ length: height }, () => Array(width).fill(blank));
  const colorCodes = color && Object.fromEntries(
    Object.entries(palette).map(([style, [fg, bg, bold]]) => {
      const rgb = ([number]) => `${number >> 16};${(number >> 8) & 255};${number & 255}`;
      const code = colorDepth >= 24
        ? `38;2;${rgb(fg)};48;2;${rgb(bg)}`
        : `38;5;${fg[1]};48;5;${bg[1]}`;
      return [style, `${esc}${bold ? 1 : 22};${code}m`];
    }),
  );

  function paint(row, left, text, style = "base", available = width - left) {
    const line = lines[row];
    if (!line || left < 0 || left >= width || available <= 0) return;
    const end = Math.min(width, left + available);
    let x = left;
    for (const { segment: glyph } of graphemes.segment(text)) {
      const cells = cellWidth(glyph);
      if (!cells) {
        const previous = line[x - 1] || line[x - 2];
        if (x > left && previous && previous !== blank) previous.glyph += glyph;
        continue;
      }
      if (x + cells > end) break;
      if (line[x] === null && x > 0) line[x - 1] = blank;
      if (line[x]?.cells === 2 && cells === 1) line[x + 1] = blank;
      if (cells === 2 && line[x + 1]?.cells === 2) line[x + 2] = blank;
      line[x] = { glyph, cells, style };
      if (cells === 2) line[x + 1] = null;
      x += cells;
    }
  }

  function dim() {
    const dimBlank = { ...blank, style: "dim" };
    for (const line of lines) {
      for (const [column, cell] of line.entries()) {
        if (cell) line[column] = cell === blank ? dimBlank : { ...cell, style: "dim" };
      }
    }
  }

  function frame(cursor, previousRows) {
    const output = [];
    const rows = lines.map((line, row) => {
      const content = [];
      let previous;
      for (const cell of line) {
        if (!cell) continue;
        if (cell.style !== previous) {
          if (colorCodes) content.push(colorCodes[cell.style]);
          previous = cell.style;
        }
        content.push(cell.glyph);
      }
      const serialized = content.join("");
      if (serialized !== previousRows?.[row]) {
        output.push(`${esc}${row + 1};1H`, serialized, esc + "0m", esc + "K");
      }
      return serialized;
    });
    if (output.length || !cursor) output.unshift(esc + "?25l");
    if (cursor) {
      const { row, column } = cursor;
      output.push(`${esc}${row + 1};${Math.min(width, column + 1)}H`, esc + "?25h");
    }
    return { frame: output.join(""), rows };
  }
  return { frame, paint, dim };
}

function fill(paint, row, left, span, style) {
  paint(row, left, " ".repeat(Math.max(0, span)), style);
}

function outline(paint, top, left, span, height, style, title) {
  if (span < 3 || height < 2) return;
  paint(top, left, `+${"-".repeat(span - 2)}+`, style);
  paint(top + height - 1, left, `+${"-".repeat(span - 2)}+`, style);
  for (let offset = 1; offset < height - 1; offset++) {
    paint(top + offset, left, "|", style);
    paint(top + offset, left + span - 1, "|", style);
  }
  if (title) paint(top, left + 2, title, style, span - 4);
}

const historyStyles = {
  user: { label: "你", title: "muted", body: "base" },
  assistant: { label: "小笨狗", title: "rose", body: "base" },
  note: { label: "", title: "muted", body: "muted" },
  tool: { label: "工具", title: "gold", body: "muted" },
};
const lineCache = new WeakMap();

function historyLines(entries, span, safeGlyphs) {
  return entries.flatMap((entry) => {
    const style = historyStyles[entry.kind] ?? historyStyles.note;
    const cached = lineCache.get(entry);
    let lines;
    if (cached?.span === span && cached.safeGlyphs === safeGlyphs && cached.text === entry.text) {
      lines = cached.lines;
    } else {
      const text = withoutAnsi(entry.text).trimEnd();
      lines = wrap(text, span, { safeGlyphs }).lines;
      lineCache.set(entry, { span, safeGlyphs, text: entry.text, lines });
    }
    if (lines.length === 1 && !lines[0]) return [];
    const result = lines.map((text) => ({ text, style: style.body, kind: entry.kind }));
    if (style.label) result.unshift({ text: style.label, style: style.title, kind: entry.kind });
    result.push({ text: "", style: "base" });
    return result;
  });
}

function renderDialog({ paint, dim }, width, height, dialog, safeGlyphs, color) {
  const span = Math.min(54, width - 2);
  if (span < 8 || height < 6) return undefined;
  const left = Math.floor((width - span) / 2);
  const inner = span - 6;
  const detail = dialog.detail
    ? wrap(withoutAnsi(dialog.detail), inner, { safeGlyphs }).lines.slice(0, height >= 16 ? 3 : 1)
    : [];
  const menu = Array.isArray(dialog.labels);
  const requested = menu ? Math.max(dialog.labels.length, 1) : 1;
  const roomy = height >= 16;
  const topPadding = roomy ? 1 : 0;
  const visible = Math.max(1, Math.min(requested, height - detail.length - 5 - topPadding));
  const panelHeight = visible + detail.length + 4 + topPadding;
  const top = Math.floor((height - panelHeight) / 2);
  if (color) dim();
  for (let row = top; row < top + panelHeight; row++) fill(paint, row, left, span, "panel");
  const title = clipped(dialog.title, span - 6, safeGlyphs);
  if (!color && !topPadding) {
    outline(paint, top, left, span, panelHeight, "panelAccent", ` ${title} `);
  } else {
    if (!color) outline(paint, top, left, span, panelHeight, "panelAccent");
    paint(top + topPadding, left + 3, title, "panelAccent", inner);
  }
  detail.forEach((line, index) => paint(top + 1 + topPadding + index, left + 3, line, "panelMuted", inner));
  const firstRow = top + 1 + topPadding + detail.length;
  const footer = menu
    ? "上下键 选择   Enter 确认   Esc 返回"
    : "Enter 确认   Esc 返回";
  paint(top + panelHeight - 2, left + 3, clipped(dialog.digits ? `编号 ${dialog.digits}` : footer, inner, safeGlyphs), "panelMuted");

  if (menu) {
    const selected = Math.max(0, Math.min(dialog.labels.length - 1, dialog.selected ?? 0));
    const start = Math.min(Math.max(0, selected - 1), Math.max(0, dialog.labels.length - visible));
    if (!dialog.labels.length) {
      paint(firstRow, left + 3, clipped("没有匹配项", inner, safeGlyphs), "panelMuted");
    }
    for (const [offset, label] of dialog.labels.slice(start, start + visible).entries()) {
      const index = start + offset;
      const active = index === selected;
      const style = active ? "selected" : "panel";
      fill(paint, firstRow + offset, left + 2, span - 4, style);
      if (active) paint(firstRow + offset, left + 3, ">", "selectedAccent");
      const number = String(index + 1).padStart(String(dialog.labels.length).length);
      paint(firstRow + offset, left + 5, number, active ? "selectedAccent" : "panelMuted", inner - 2);
      const labelWidth = inner - 3 - number.length;
      paint(firstRow + offset, left + 6 + number.length, clipped(label, labelWidth, safeGlyphs), style, labelWidth);
    }
    return undefined;
  }

  const text = withoutAnsi(dialog.text);
  const display = dialog.secret ? "*".repeat(text.length) : text;
  const cursor = Math.min(dialog.cursor ?? display.length, display.length);
  const field = wrap(display, Math.max(1, inner - 3), { safeGlyphs, cursor });
  paint(firstRow, left + 3, "> ", "panelAccent");
  paint(firstRow, left + 5, field.lines[field.position.row], "panel", inner - 2);
  return { row: firstRow, column: Math.min(left + span - 2, left + 5 + field.position.column) };
}

function renderWelcome(paint, width, span, top, height, color) {
  const title = "LoliCode";
  const greeting = "和小笨狗一起写代码。";
  if (color && span >= 64 && height >= puppy.length + 2) {
    const left = Math.floor((width - 64) / 2);
    const heroHeight = puppy.length + 2;
    const first = top + Math.floor((height - heroHeight) / 2);
    for (let row = first; row < first + heroHeight; row++) fill(paint, row, left, 64, "hero");
    for (const [row, line] of puppy.entries()) {
      for (const [column, pixel] of [...line].entries()) {
        if (pixels[pixel]) fill(paint, first + 1 + row, left + 4 + column * 2, 2, pixels[pixel]);
      }
    }
    paint(first + 1, left + 28, "+", "heroGold");
    paint(first + 4, left + 33, title, "heroTitle");
    paint(first + 6, left + 33, greeting, "hero");
    return;
  }

  const showPuppy = height >= 8 && span >= 20;
  const showGreeting = height >= 3 && span >= displayWidth(greeting);
  const blockHeight = (showPuppy ? puppyAscii.length + 1 : 0) + (showGreeting ? 3 : 1);
  let row = top + Math.floor((height - blockHeight) / 2);
  const center = (value, style) => {
    paint(row++, Math.floor((width - displayWidth(value)) / 2), value, style);
  };
  if (showPuppy) {
    for (const line of puppyAscii) center(line, "rose");
    row++;
  }
  center(title, "base");
  if (showGreeting) {
    row++;
    center(greeting, "muted");
  }
}

export function renderWorkspace(state) {
  const width = Math.max(1, (state.columns || 80) - 1);
  const height = Math.max(1, state.rows || 24);
  const color = state.color && (state.colorDepth ?? 8) >= 8;
  const canvas = createCanvas(width, height, color, state.colorDepth);
  const { paint, frame } = canvas;
  const safe = state.safeGlyphs;
  const render = (cursor, scrollMax) => ({
    ...frame(cursor, state.previousRows),
    width,
    height,
    scrollMax,
  });
  const margin = Math.max(width >= 32 ? 2 : 0, Math.floor((width - 86) / 2));
  const span = width - margin * 2;
  const cell = (row, left, value, style, available = width - left) =>
    paint(row, left, clipped(value, available, safe), style, available);

  if (height < 7 || width < 16) {
    cell(0, 0, "LoliCode", "rose");
    const dialog = state.dialog;
    const menu = Array.isArray(dialog?.labels);
    const rawInput = dialog?.text ?? state.composer?.text ?? "";
    const text = dialog?.secret ? "*".repeat(rawInput.length) : withoutAnsi(rawInput);
    if (height > 2) cell(1, 0, dialog?.title || state.status || state.model || "未连接", "muted");
    const selected = dialog?.selected ?? 0;
    const picked = menu ? `${selected + 1} ${dialog.labels[selected] ?? ""}` : "";
    const field = wrap(text, Math.max(1, width - 2), {
      safeGlyphs: safe, cursor: dialog?.cursor ?? state.composer?.cursor ?? text.length,
    });
    cell(height - 1, 0, `> ${menu ? picked : field.lines[field.position.row]}`, "rose");
    const cursor = !menu && (dialog || state.composer?.active)
      ? { row: height - 1, column: Math.min(width - 1, 2 + field.position.column) }
      : undefined;
    return render(cursor, 0);
  }
  const roomy = height >= 16;
  const headerRow = roomy ? 1 : 0;
  const hasHistory = state.entries?.length > 0;
  const brand = hasHistory ? "LoliCode  " : "";
  cell(headerRow, margin, brand, "rose", span);
  cell(headerRow, margin + brand.length, state.cwd, "muted", span - brand.length);

  const composer = state.composer || {};
  const text = withoutAnsi(composer.text);
  const field = wrap(text, span - 6, { safeGlyphs: safe, cursor: composer.cursor ?? text.length });
  const inputRows = Math.min(field.lines.length, height >= 21 ? 4 : height >= 13 ? 2 : 1);
  const composerHeight = inputRows + 2;
  const composerTop = height - composerHeight - 1;
  const transcriptStart = headerRow + (roomy ? 3 : 2);
  const suggestionCount = Math.min(5, Math.max(0, composerTop - transcriptStart - 3));
  const highlighted = composer.suggestionIndex ?? 0;
  const firstSuggestion = Math.max(0, highlighted - suggestionCount + 1);
  const suggestions = state.dialog ? [] : (composer.suggestions ?? []).slice(firstSuggestion, firstSuggestion + suggestionCount);
  const available = Math.max(0, composerTop - transcriptStart - suggestions.length - 1);
  const history = historyLines(state.entries ?? [], span - 4, safe);
  const scrollMax = Math.max(0, history.length - available);
  const scroll = Math.min(scrollMax, Math.max(0, state.scroll || 0));
  const end = history.length - scroll;
  const viewport = history.slice(Math.max(0, end - available), end);
  for (const [index, entry] of viewport.entries()) {
    const row = transcriptStart + index;
    if (entry.kind === "user") paint(row, margin, safe ? "|" : "│", "rose", 1);
    paint(row, margin + 2, entry.text, entry.style, span - 4);
  }
  if (!state.dialog && !history.length && available > 0)
    renderWelcome(paint, width, span, transcriptStart, available, color);

  const statusRow = composerTop - 1;
  const status = scroll ? "查看历史 · Ctrl+End 回到底部" : state.status;
  cell(statusRow, margin, status, scroll ? "muted" : "gold", span);
  suggestions.forEach((item, index) => {
    const row = composerTop - suggestions.length - 1 + index;
    const active = firstSuggestion + index === highlighted;
    const style = active ? "selected" : "panel";
    fill(paint, row, margin, span, style);
    cell(row, margin + 2, `${active ? ">" : " "} ${item.command}   ${item.description}`, style, span - 4);
  });

  if (color) {
    for (let row = 0; row < composerHeight; row++) fill(paint, composerTop + row, margin, span, "panel");
  } else {
    outline(paint, composerTop, margin, span, composerHeight, "panelAccent");
  }
  paint(composerTop + 1, margin + 2, ">", "panelAccent");
  const fieldStart = Math.max(0, field.position.row - inputRows + 1);
  if (!text && composer.active) {
    cell(composerTop + 1, margin + 4, "给小笨狗一个任务", "panelMuted", span - 6);
  } else {
    field.lines.slice(fieldStart, fieldStart + inputRows).forEach((line, index) =>
      paint(composerTop + 1 + index, margin + 4, line, "panel", span - 6));
  }
  const modelAction = state.model ? "/models" : "/connect";
  const actions = span >= 68 ? `${modelAction}   Ctrl+P 命令` : modelAction;
  const actionsWidth = displayWidth(actions, safe);
  const footerWidth = Math.max(0, span - actionsWidth - 2);
  const footer = state.model || "未连接模型";
  const approval = state.model && state.approval ? ` · ${state.approval}` : "";
  const approvalWidth = displayWidth(approval, safe);
  const showApproval = approval && (approvalWidth + 8 <= footerWidth);
  const modelWidth = showApproval ? footerWidth - approvalWidth : footerWidth;
  const modelLabel = clipped(footer, modelWidth, safe);
  cell(height - 1, margin, modelLabel, state.model ? "base" : "muted", modelWidth);
  if (showApproval) cell(height - 1, margin + displayWidth(modelLabel, safe), approval, "muted", approvalWidth);
  cell(height - 1, width - margin - actionsWidth, actions, "rose");
  const cursor = state.dialog
    ? renderDialog(canvas, width, height, state.dialog, safe, color)
    : composer.active
      ? { row: composerTop + 1 + field.position.row - fieldStart, column: margin + 4 + field.position.column }
      : undefined;
  return render(cursor, scrollMax);
}
