import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
} from "lucide-react";
import type {
  AgentDocument,
  DocumentCell,
  DocumentSection,
} from "@/lib/api/agent-documents";
import "./agent-spreadsheet-view.css";

const ROW_WINDOW = 50;
const COLUMN_WINDOW = 30;
const MAX_ROW = 1048576;
const MAX_COLUMN = 16384;

interface Position {
  row: number;
  column: number;
}
interface Selection {
  sheet: string;
  first: Position;
  last: Position;
}

export interface AgentSpreadsheetViewProps {
  document: AgentDocument;
  section: DocumentSection;
  locator?: string;
  onNavigate: (locator: string) => void;
  zoom: number;
}

function position(reference: string): Position | null {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i.exec(reference);
  if (!match) return null;
  let column = 0;
  for (const character of match[1].toUpperCase())
    column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return column <= MAX_COLUMN && row <= MAX_ROW ? { row, column } : null;
}

function columnName(column: number) {
  let name = "";
  while (column > 0) {
    column--;
    name = String.fromCharCode(65 + (column % 26)) + name;
    column = Math.floor(column / 26);
  }
  return name;
}

const reference = (cell: Position) => `${columnName(cell.column)}${cell.row}`;
const rangeReference = (selection: Selection) => {
  const first = reference(selection.first);
  const last = reference(selection.last);
  return first === last ? first : `${first}:${last}`;
};
const formulaText = (cell: DocumentCell) =>
  cell.formula?.startsWith("=") ? cell.formula : `=${cell.formula}`;
const firstCell = (sheet: string): Selection => ({
  sheet,
  first: { row: 1, column: 1 },
  last: { row: 1, column: 1 },
});

function parseAddress(
  document: AgentDocument,
  section: DocumentSection,
  raw: string,
): Selection | null {
  let address = raw.trim().replace(/^#/, "");
  if (!address || address.length > 512) return null;
  const bang = address.lastIndexOf("!");
  let sheet = section;
  if (bang >= 0 || /^sheet:/i.test(address)) {
    let sheetName = (bang < 0 ? address : address.slice(0, bang)).replace(
      /^sheet:/i,
      "",
    );
    if (sheetName.startsWith("'") && sheetName.endsWith("'"))
      sheetName = sheetName.slice(1, -1).replace(/''/g, "'");
    const found = document.sections.find(
      (candidate) => candidate.id === `sheet:${sheetName}`,
    );
    if (!found) return null;
    sheet = found;
    if (bang < 0) return firstCell(sheet.id);
    address = address.slice(bang + 1);
  }
  const parts = address.split(":");
  if (parts.length > 2) return null;
  const first = position(parts[0]);
  const last = position(parts[1] ?? parts[0]);
  if (!first || !last || first.row > last.row || first.column > last.column)
    return null;
  return { sheet: sheet.id, first, last };
}

export function AgentSpreadsheetView(props: AgentSpreadsheetViewProps) {
  return (
    <SpreadsheetView
      key={`${props.document.path}\0${props.document.revision}`}
      {...props}
    />
  );
}

function SpreadsheetView({
  document,
  section,
  locator,
  onNavigate,
  zoom,
}: AgentSpreadsheetViewProps) {
  const initial = () =>
    parseAddress(document, section, locator || section.id) ||
    firstCell(section.id);
  const [selection, setSelection] = useState<Selection>(initial);
  const [addressDraft, setAddressDraft] = useState(() =>
    rangeReference(initial()),
  );
  const [addressError, setAddressError] = useState("");
  const [showFormulas, setShowFormulas] = useState(false);
  const incomingLocation = `${section.id}\0${locator ?? ""}`;
  const [appliedLocation, setAppliedLocation] = useState(incomingLocation);
  // Apply a new parent locator before committing the grid. An effect would
  // briefly commit the old selection and can let selection reporting restore
  // it while a newly opened sheet is still being laid out.
  if (appliedLocation !== incomingLocation) {
    const target = initial();
    setAppliedLocation(incomingLocation);
    setSelection(target);
    setAddressDraft(rangeReference(target));
    setAddressError("");
  }
  const addressInput = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLTableElement>(null);
  const focusGrid = useRef(false);
  const composing = useRef(false);
  const activeSection =
    document.sections.find((candidate) => candidate.id === selection.sheet) ||
    section;
  const firstRow =
    Math.floor((selection.first.row - 1) / ROW_WINDOW) * ROW_WINDOW + 1;
  const firstColumn =
    Math.floor((selection.first.column - 1) / COLUMN_WINDOW) * COLUMN_WINDOW +
    1;
  const lastRow = Math.min(MAX_ROW, firstRow + ROW_WINDOW - 1);
  const lastColumn = Math.min(MAX_COLUMN, firstColumn + COLUMN_WINDOW - 1);
  const rows = Array.from(
    { length: lastRow - firstRow + 1 },
    (_, index) => firstRow + index,
  );
  const columns = Array.from(
    { length: lastColumn - firstColumn + 1 },
    (_, index) => firstColumn + index,
  );
  const safeZoom = Number.isFinite(zoom) ? Math.max(0.2, Math.min(2, zoom)) : 1;
  const cells = useMemo(() => {
    // Keep only the visible window; sparse source arrays never become row or
    // column indexes and a jump cannot materialize the intervening empty grid.
    const window = new Map<string, DocumentCell>();
    for (const row of activeSection.rows)
      for (const cell of row) {
        const cellPosition = position(cell.reference);
        if (
          cellPosition &&
          cellPosition.row >= firstRow &&
          cellPosition.row <= lastRow &&
          cellPosition.column >= firstColumn &&
          cellPosition.column <= lastColumn
        ) {
          window.set(reference(cellPosition), cell);
        }
      }
    return window;
  }, [activeSection.rows, firstRow, lastRow, firstColumn, lastColumn]);
  const selectedCell = cells.get(reference(selection.first));
  const formulaValue =
    selectedCell?.formula !== undefined
      ? formulaText(selectedCell)
      : selectedCell?.value || "";

  useEffect(() => {
    if (!focusGrid.current) return;
    focusGrid.current = false;
    const cell = grid.current?.querySelector<HTMLElement>(
      '[data-active-cell="true"]',
    );
    cell?.focus({ preventScroll: true });
    cell?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [
    selection.sheet,
    selection.first.row,
    selection.first.column,
    selection.last.row,
    selection.last.column,
  ]);

  const navigate = (target: Selection, focus = false) => {
    focusGrid.current = focus;
    // Keyboard/address navigation replaces a text selection. Leaving its old
    // DOM range alive would let the parent key-up reporter restore that cell.
    if (focus) window.getSelection()?.removeAllRanges();
    setSelection(target);
    setAddressDraft(rangeReference(target));
    setAddressError("");
    onNavigate(`${target.sheet}!${rangeReference(target)}`);
  };
  const move = (row: number, column: number) => {
    const target = {
      row: Math.max(1, Math.min(MAX_ROW, row)),
      column: Math.max(1, Math.min(MAX_COLUMN, column)),
    };
    navigate({ sheet: activeSection.id, first: target, last: target }, true);
  };
  const handleGridKey = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const { row, column } = selection.first;
    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        move(row - 1, column);
        break;
      case "ArrowDown":
        event.preventDefault();
        move(row + 1, column);
        break;
      case "ArrowLeft":
        event.preventDefault();
        move(row, column - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        move(row, column + 1);
        break;
      case "Enter":
        event.preventDefault();
        move(row + (event.shiftKey ? -1 : 1), column);
        break;
      case "Tab":
        event.preventDefault();
        move(row, column + (event.shiftKey ? -1 : 1));
        break;
      case "PageDown":
        event.preventDefault();
        move(row + ROW_WINDOW, column);
        break;
      case "PageUp":
        event.preventDefault();
        move(row - ROW_WINDOW, column);
        break;
      case "Home":
        event.preventDefault();
        move(row, 1);
        break;
      case "Escape":
        event.preventDefault();
        addressInput.current?.focus();
        break;
    }
  };

  return (
    <section
      className="agent-spreadsheet"
      aria-label={`${document.name} 电子表格`}
    >
      <div className="agent-spreadsheet-formula-row">
        <form
          className="agent-spreadsheet-address"
          aria-label="定位单元格"
          onSubmit={(event) => {
            event.preventDefault();
            if (composing.current) return;
            const target = parseAddress(document, activeSection, addressDraft);
            if (!target) {
              setAddressError(
                "请输入有效的单元格或范围，例如 A1、A1:B3 或 sheet:工作表!A1。",
              );
              return;
            }
            navigate(target, true);
          }}
        >
          <input
            ref={addressInput}
            aria-label="单元格地址"
            aria-invalid={Boolean(addressError)}
            value={addressDraft}
            maxLength={512}
            spellCheck={false}
            placeholder="A1"
            onChange={(event) => {
              setAddressDraft(event.target.value);
              setAddressError("");
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
          />
        </form>
        <span className="agent-spreadsheet-fx" aria-hidden="true">
          fx
        </span>
        <input
          className="agent-spreadsheet-formula"
          aria-label="单元格值与公式"
          readOnly
          value={formulaValue}
          title={formulaValue || "空单元格"}
        />
      </div>
      <div className="agent-spreadsheet-options">
        <span>只读</span>
        <label>
          <input
            type="checkbox"
            checked={showFormulas}
            onChange={(event) => setShowFormulas(event.target.checked)}
          />
          显示公式
        </label>
      </div>
      {addressError && (
        <p role="alert" className="agent-spreadsheet-error">
          {addressError}
        </p>
      )}
      <div className="agent-spreadsheet-scroll">
        <table
          ref={grid}
          className="agent-spreadsheet-table"
          role="grid"
          aria-label={`${activeSection.label} 单元格`}
          aria-readonly="true"
          aria-rowcount={MAX_ROW + 1}
          aria-colcount={MAX_COLUMN + 1}
          onKeyDown={handleGridKey}
          style={
            {
              "--spreadsheet-zoom": safeZoom,
              width: (46 + columns.length * 100) * safeZoom,
            } as CSSProperties
          }
        >
          <colgroup>
            <col className="agent-spreadsheet-row-number" />
            {columns.map((column) => (
              <col key={column} />
            ))}
          </colgroup>
          <thead>
            <tr role="row" aria-rowindex={1}>
              <th
                className="agent-spreadsheet-corner"
                role="columnheader"
                aria-label="行号"
              />
              {columns.map((column) => (
                <th
                  key={column}
                  role="columnheader"
                  scope="col"
                  aria-colindex={column + 1}
                  data-highlighted={
                    (column >= selection.first.column &&
                      column <= selection.last.column) ||
                    undefined
                  }
                >
                  {columnName(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row} role="row" aria-rowindex={row + 1}>
                <th
                  role="rowheader"
                  scope="row"
                  aria-colindex={1}
                  data-highlighted={
                    (row >= selection.first.row && row <= selection.last.row) ||
                    undefined
                  }
                >
                  {row}
                </th>
                {columns.map((column) => {
                  const ref = reference({ row, column });
                  const cell = cells.get(ref);
                  const selected =
                    row >= selection.first.row &&
                    row <= selection.last.row &&
                    column >= selection.first.column &&
                    column <= selection.last.column;
                  const active =
                    row === selection.first.row &&
                    column === selection.first.column;
                  return (
                    <td
                      key={column}
                      role="gridcell"
                      aria-label={`${ref}: ${cell?.value || "空"}`}
                      aria-colindex={column + 1}
                      aria-selected={selected}
                      tabIndex={active ? 0 : -1}
                      data-active-cell={active || undefined}
                      data-document-locator={`${activeSection.id}!${ref}`}
                      data-numeric={
                        Boolean(
                          cell?.value &&
                            /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
                              cell.value,
                            ),
                        ) || undefined
                      }
                      title={
                        cell?.formula !== undefined
                          ? `${ref} · ${formulaText(cell)}`
                          : cell?.value || undefined
                      }
                      onClick={(event) => {
                        if (window.getSelection()?.toString()) return;
                        event.currentTarget.focus();
                        navigate({
                          sheet: activeSection.id,
                          first: { row, column },
                          last: { row, column },
                        });
                      }}
                    >
                      {showFormulas && cell?.formula !== undefined
                        ? formulaText(cell)
                        : cell?.value || ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="agent-spreadsheet-window" aria-label="单元格窗口">
        <div>
          <button
            type="button"
            aria-label="上一组行"
            title="上一组行"
            disabled={firstRow === 1}
            onClick={() => move(firstRow - ROW_WINDOW, selection.first.column)}
          >
            <ChevronUp size={13} />
          </button>
          <span>
            行 {firstRow}–{lastRow}
          </span>
          <button
            type="button"
            aria-label="下一组行"
            title="下一组行"
            disabled={lastRow === MAX_ROW}
            onClick={() => move(firstRow + ROW_WINDOW, selection.first.column)}
          >
            <ChevronDown size={13} />
          </button>
        </div>
        <div>
          <button
            type="button"
            aria-label="上一组列"
            title="上一组列"
            disabled={firstColumn === 1}
            onClick={() =>
              move(selection.first.row, firstColumn - COLUMN_WINDOW)
            }
          >
            <ChevronLeft size={13} />
          </button>
          <span>
            列 {columnName(firstColumn)}–{columnName(lastColumn)}
          </span>
          <button
            type="button"
            aria-label="下一组列"
            title="下一组列"
            disabled={lastColumn === MAX_COLUMN}
            onClick={() =>
              move(selection.first.row, firstColumn + COLUMN_WINDOW)
            }
          >
            <ChevronRight size={13} />
          </button>
        </div>
      </div>
      <nav
        className="agent-spreadsheet-tabs"
        role="tablist"
        aria-label="工作表"
      >
        {document.sections.map((sheet, index) => (
          <button
            key={sheet.id}
            type="button"
            role="tab"
            aria-selected={sheet.id === activeSection.id}
            tabIndex={sheet.id === activeSection.id ? 0 : -1}
            onClick={() => navigate(firstCell(sheet.id))}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight")
                next = Math.min(document.sections.length - 1, index + 1);
              else if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = document.sections.length - 1;
              else return;
              event.preventDefault();
              (
                event.currentTarget.parentElement?.children[next] as
                  | HTMLElement
                  | undefined
              )?.focus();
              navigate(firstCell(document.sections[next].id));
            }}
          >
            {sheet.label}
          </button>
        ))}
      </nav>
    </section>
  );
}
