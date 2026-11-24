import { stripVTControlCharacters } from "node:util";

const esc = "\x1b[";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const nonprinting = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
const emoji = /\p{Emoji_Presentation}|\p{Regional_Indicator}|[\ufe0f\u20e3]/u;
const wide = /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;

const cocoa = [0x211820, 234];
const header = [0x35232e, 235];
const cream = [0xf8eadc, 230];
const petal = [0xf0a9bc, 218];
const blush = [0xe7c2b0, 223];
const taupe = [0xba9ea8, 249];
const panel = [0x352730, 236];
const raised = [0x412d38, 237];
const rail = [0x8c5b72, 95];
const pinkInk = [0x3e2433, 235];
const palette = {
  base: [cream, cocoa],
  rose: [petal, cocoa],
  warm: [blush, cocoa],
  muted: [taupe, cocoa],
  bar: [cream, header],
  barMuted: [taupe, header],
  badge: [pinkInk, petal],
  user: [cream, panel],
  userLabel: [petal, panel],
  userRail: [petal, raised],
  panel: [cream, panel],
  panelTitle: [blush, raised],
  panelMuted: [taupe, panel],
  panelAccent: [petal, panel],
  composerRail: [petal, rail],
  panelShadow: [taupe, [0x181217, 233]],
  selected: [cream, [0x62384e, 95]],
  selectedRail: [petal, [0x884f69, 131]],
  active: [blush, header],
  inactive: [taupe, header],
};

const puppy = [
  "   __       __   ",
  " /'  \\___/'  \\  ",
  "|   ( o o )   | ",
  " \\__/  v  \\__/  ",
  "     '---'      ",
];

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
    Object.entries(palette).map(([style, [fg, bg]]) => {
      const rgb = ([number]) => `${number >> 16};${(number >> 8) & 255};${number & 255}`;
      const code = colorDepth >= 24
        ? `38;2;${rgb(fg)};48;2;${rgb(bg)}`
        : `38;5;${fg[1]};48;5;${bg[1]}`;
      return [style, `${esc}${code}m`];
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
  return { frame, paint };
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
  user: { label: "你", title: "userLabel", body: "user" },
  assistant: { label: "小笨狗", title: "warm", body: "base" },
  note: { label: "", title: "muted", body: "muted" },
  tool: { label: "工具", title: "warm", body: "muted" },
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

function renderDialog(paint, width, height, dialog, safeGlyphs, color) {
  const span = Math.min(60, width - 2);
  if (span < 8 || height < 6) return undefined;
  const left = Math.floor((width - span) / 2);
  const inner = span - 6;
  const detail = dialog.detail
    ? wrap(withoutAnsi(dialog.detail), inner, { safeGlyphs }).lines.slice(0, height >= 16 ? 3 : 1)
    : [];
  const menu = Array.isArray(dialog.labels);
  const requested = menu ? Math.max(dialog.labels.length, 1) : 1;
  const roomy = height >= 16;
  const padding = roomy ? 1 : 0;
  const visible = Math.max(1, Math.min(requested, height - detail.length - 5 - padding * 2));
  const panelHeight = visible + detail.length + 4 + padding * 2;
  const top = Math.floor((height - panelHeight) / 2);
  if (color && roomy) {
    for (let row = top + 1; row <= top + panelHeight; row++)
      fill(paint, row, left + 2, Math.min(span, width - left - 2), "panelShadow");
  }
  for (let row = top; row < top + panelHeight; row++) fill(paint, row, left, span, "panel");
  const title = clipped(dialog.title, span - 6, safeGlyphs);
  if (color) fill(paint, top, left, span, "panelTitle");
  else outline(paint, top, left, span, panelHeight, "panelTitle");
  paint(top, left + 3, title, "panelTitle");
  detail.forEach((line, index) => paint(top + 1 + padding + index, left + 3, line, "panelMuted", inner));
  const firstRow = top + 1 + padding + detail.length;
  const footer = menu
    ? "上下键选择   Enter 确认   Esc 返回"
    : "Enter 确认    Esc 返回";
  paint(top + panelHeight - 2, left + 3, clipped(footer, inner, safeGlyphs), "panelMuted");

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
      if (active) paint(firstRow + offset, left + 2, ">", "selectedRail");
      const numbered = `${index + 1}   ${label}`;
      paint(firstRow + offset, left + 4, clipped(numbered, span - 6, safeGlyphs), style);
    }
    if (dialog.digits) {
      paint(top + panelHeight - 3, left + 3, clipped(`编号 ${dialog.digits}`, inner, safeGlyphs), "panelMuted");
    }
    return undefined;
  }

  const text = withoutAnsi(dialog.text);
  const display = dialog.secret ? "*".repeat(text.length) : text;
  const cursor = Math.min(dialog.cursor ?? display.length, display.length);
  const field = wrap(display, Math.max(1, inner - 3), { safeGlyphs, cursor });
  paint(firstRow, left + 3, "> ", "panelAccent");
  paint(firstRow, left + 5, field.lines[field.position.row], "panel", inner - 2);
  return { row: firstRow, column: left + 5 + field.position.column };
}

export function renderWorkspace(state) {
  const width = Math.max(1, (state.columns || 80) - 1);
  const height = Math.max(1, state.rows || 24);
  const color = state.color && (state.colorDepth ?? 8) >= 8;
  const { paint, frame } = createCanvas(width, height, color, state.colorDepth);
  const safe = state.safeGlyphs;
  const render = (cursor, scrollMax) => ({
    ...frame(cursor, state.previousRows),
    width,
    height,
    scrollMax,
  });
  const margin = Math.max(width >= 80 ? 3 : width >= 32 ? 2 : 0, Math.floor((width - 110) / 2));
  const span = width - margin * 2;
  const cell = (row, left, value, style, available = width - left) =>
    paint(row, left, clipped(value, available, safe), style, available);

  const brand = width >= 34 ? " U^.^U " : "";
  fill(paint, 0, margin, span, "bar");
  cell(0, margin, brand, "badge");
  cell(0, margin + brand.length, "  LoliCode", "bar");
  const version = String(state.version ?? "");
  if (width >= 40) cell(0, width - margin - version.length - 2, version, "barMuted");
  if (height < 7 || width < 16) {
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
  cell(1, margin + 1, state.cwd || "", "muted", span - 2);

  const composer = state.composer || {};
  const text = withoutAnsi(composer.text);
  const field = wrap(text, span - 6, { safeGlyphs: safe, cursor: composer.cursor ?? text.length });
  const inputRows = Math.min(field.lines.length, height >= 21 ? 4 : height >= 13 ? 2 : 1);
  const composerHeight = inputRows + 2;
  const composerTop = height - composerHeight - 1;
  const transcriptStart = height >= 14 ? 3 : 2;
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
    if (entry.kind === "user" && color) {
      fill(paint, row, margin, span, entry.style);
      fill(paint, row, margin, 1, "userRail");
    }
    const marker = !color && entry.kind === "user" ? "| " : "";
    paint(row, margin + 2, marker + entry.text, entry.style, span - 4);
  }
  if (!state.dialog && !history.length && available >= 3) {
    const showPuppy = available >= 10 && span >= 28;
    const blockHeight = showPuppy ? 9 : 3;
    const start = transcriptStart + Math.floor((available - blockHeight) / 2);
    const center = (row, value, style) =>
      cell(row, Math.max(margin, Math.floor((width - displayWidth(value)) / 2)), value, style, span);
    if (showPuppy) {
      puppy.forEach((line, index) => center(start + index, line, index < 2 ? "rose" : "warm"));
    }
    const titleRow = start + (showPuppy ? 6 : 0);
    center(titleRow, "今天想做点什么？", "base");
    const hint = state.model ? "试试「帮我找一下项目入口」" : "从 /connect 连接一个模型";
    center(titleRow + 2, hint, "muted");
  }
  const statusRow = composerTop - 1;
  const status = scroll ? "查看历史 · Ctrl+End 回到底部" : state.status;
  cell(statusRow, margin + 2, status, "muted", span - 4);
  suggestions.forEach((item, index) => {
    const row = composerTop - suggestions.length - 1 + index;
    const active = firstSuggestion + index === highlighted;
    const style = active ? "selected" : "panel";
    fill(paint, row, margin, span, style);
    cell(row, margin + 2, `${active ? ">" : " "} ${item.command}   ${item.description}`, style, span - 4);
  });

  if (color) {
    fill(paint, composerTop, margin, span, "panelTitle");
    paint(composerTop, margin + 2, "消息", "panelTitle");
    if (span >= 40) paint(composerTop, width - margin - 13, "Enter 发送", "panelTitle");
    for (let row = 1; row <= inputRows; row++) {
      fill(paint, composerTop + row, margin, span, "panel");
      fill(paint, composerTop + row, margin, 1, "composerRail");
    }
    fill(paint, composerTop + composerHeight - 1, margin, span, "panel");
  } else {
    outline(paint, composerTop, margin, span, composerHeight, "panelTitle", " 消息 ");
  }
  paint(composerTop + 1, margin + 2, ">", "panelAccent");
  const fieldStart = Math.max(0, field.position.row - inputRows + 1);
  if (!text && composer.active) {
    cell(composerTop + 1, margin + 4, "输入任务，或键入 / 查看命令", "panelMuted", span - 6);
  } else {
    field.lines.slice(fieldStart, fieldStart + inputRows).forEach((line, index) =>
      paint(composerTop + 1 + index, margin + 4, line, "panel", span - 6));
  }
  const footer = state.model ? [state.model, state.approval].filter(Boolean).join("  /  ") : "未连接";
  const actions = width >= 75
    ? "/connect 连接   /models 模型   Ctrl+P 命令"
    : width >= 45 ? "/connect  /models  /help" : "/connect";
  const actionsWidth = displayWidth(actions);
  const footerWidth = Math.max(0, span - actionsWidth - 2);
  const modelLabel = clipped(footer, Math.max(0, footerWidth - 3), safe);
  if (footerWidth > 3)
    cell(height - 1, margin, `  ${modelLabel} `, state.model ? "active" : "inactive", footerWidth);
  cell(height - 1, width - margin - actionsWidth, actions, "muted");
  const cursor = state.dialog
    ? renderDialog(paint, width, height, state.dialog, safe, color)
    : composer.active
      ? { row: composerTop + 1 + field.position.row - fieldStart, column: margin + 4 + field.position.column }
      : undefined;
  return render(cursor, scrollMax);
}
