import { stripVTControlCharacters } from "node:util";

const esc = "\x1b[";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const nonprinting = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
const emoji = /\p{Emoji_Presentation}|\p{Regional_Indicator}|[\ufe0f\u20e3]/u;
const wide = /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;

const palette = {
  base: [252, 234],
  text: [230, 234],
  rose: [218, 234],
  muted: [249, 234],
  line: [96, 234],
  bar: [230, 53],
  badge: [53, 218],
  user: [230, 235],
  userLabel: [218, 235],
  panel: [230, 236],
  panelLine: [181, 236],
  panelMuted: [250, 236],
  selected: [230, 89],
};

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

function createCanvas(width, height, color) {
  const blank = { glyph: " ", cells: 1, style: "base" };
  const lines = Array.from({ length: height }, () => Array(width).fill(blank));

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
          if (color) {
            const [foreground, background] = palette[cell.style];
            content.push(`${esc}38;5;${foreground};48;5;${background}m`);
          }
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
  assistant: { label: "LoliCode", title: "rose", body: "text" },
  note: { label: "", title: "muted", body: "muted" },
  tool: { label: "工具", title: "rose", body: "muted" },
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
    const result = lines.map((text) => ({ text, style: style.body }));
    if (style.label) result.unshift({ text: style.label, style: style.title });
    result.push({ text: "", style: "base" });
    return result;
  });
}

function renderDialog(paint, width, height, dialog, safeGlyphs) {
  const span = Math.min(68, width - 2);
  if (span < 8 || height < 6) return undefined;
  const left = Math.floor((width - span) / 2);
  const inner = span - 6;
  const detail = dialog.detail
    ? wrap(withoutAnsi(dialog.detail), inner, { safeGlyphs }).lines.slice(0, height >= 16 ? 3 : 1)
    : [];
  const menu = Array.isArray(dialog.labels);
  const requested = menu ? Math.max(dialog.labels.length, 1) : 1;
  const visible = Math.max(1, Math.min(requested, height - detail.length - 5));
  const panelHeight = visible + detail.length + 4;
  const top = Math.floor((height - panelHeight) / 2);
  for (let row = top; row < top + panelHeight; row++) fill(paint, row, left, span, "panel");
  const title = clipped(` ${dialog.title} `, span - 4, safeGlyphs);
  outline(paint, top, left, span, panelHeight, "panelLine", title);
  detail.forEach((line, index) => paint(top + 1 + index, left + 3, line, "panelMuted", inner));
  const firstRow = top + 1 + detail.length;
  const footer = menu
    ? "上下键 / 编号选择    Enter 确认    Esc 返回"
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
      const numbered = `${active ? ">" : " "} ${index + 1}  ${label}`;
      paint(firstRow + offset, left + 2, clipped(numbered, span - 4, safeGlyphs), style);
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
  paint(firstRow, left + 3, "> ", "panelLine");
  paint(firstRow, left + 5, field.lines[field.position.row], "panel", inner - 2);
  return { row: firstRow, column: left + 5 + field.position.column };
}

export function renderWorkspace(state) {
  const width = Math.max(1, (state.columns || 80) - 1);
  const height = Math.max(1, state.rows || 24);
  const { paint, frame } = createCanvas(width, height, state.color);
  const safe = state.safeGlyphs;
  const render = (cursor, scrollMax) => ({
    ...frame(cursor, state.previousRows),
    width,
    height,
    scrollMax,
  });
  const margin = width >= 80 ? 3 : width >= 32 ? 2 : 0;
  const span = width - margin * 2;
  const cell = (row, left, value, style, available = width - left) =>
    paint(row, left, clipped(value, available, safe), style, available);

  const brand = width >= 34 ? " LC  " : "";
  fill(paint, 0, 0, width, "bar");
  cell(0, margin, brand, "badge");
  cell(0, margin + brand.length, "  LoliCode", "bar");
  const version = String(state.version ?? "");
  if (width >= 34) cell(0, width - margin - version.length, version, "bar");
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
  cell(1, margin, state.cwd || "", "muted", span);

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
    if (entry.style === "user" || entry.style === "userLabel") {
      fill(paint, row, margin, span, entry.style);
      paint(row, margin, "|", entry.style);
    }
    paint(row, margin + 2, entry.text, entry.style, span - 4);
  }
  if (!history.length && available >= 3) {
    const center = Math.floor((width - displayWidth("从一条消息开始")) / 2);
    const row = transcriptStart + Math.floor((available - 3) / 2);
    cell(row, center, "从一条消息开始", "rose");
    const hint = state.model ? "例如，帮我梳理这个项目的结构" : "用 /connect 连接你的模型";
    cell(row + 2, Math.max(margin, Math.floor((width - displayWidth(hint)) / 2)), hint, "muted");
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

  for (let row = 1; row <= inputRows; row++) fill(paint, composerTop + row, margin, span, "panel");
  outline(paint, composerTop, margin, span, composerHeight, "panelLine", " 消息 ");
  paint(composerTop + 1, margin + 2, ">", "panelLine");
  const fieldStart = Math.max(0, field.position.row - inputRows + 1);
  if (!text && composer.active) {
    cell(composerTop + 1, margin + 4, "输入任务，或键入 / 查看命令", "panelMuted", span - 6);
  } else {
    field.lines.slice(fieldStart, fieldStart + inputRows).forEach((line, index) =>
      paint(composerTop + 1 + index, margin + 4, line, "panel", span - 6));
  }
  const footer = state.model ? [state.model, state.approval].filter(Boolean).join("  |  ") : "未连接";
  const actions = width >= 75
    ? "/connect 连接   /models 模型   Ctrl+P 命令"
    : width >= 45 ? "/connect  /models  /help" : "/connect";
  const actionsWidth = displayWidth(actions);
  cell(height - 1, margin, footer, state.model ? "rose" : "muted", Math.max(0, span - actionsWidth - 2));
  cell(height - 1, width - margin - actionsWidth, actions, "muted");
  const cursor = state.dialog
    ? renderDialog(paint, width, height, state.dialog, safe)
    : composer.active
      ? { row: composerTop + 1 + field.position.row - fieldStart, column: margin + 4 + field.position.column }
      : undefined;
  return render(cursor, scrollMax);
}
