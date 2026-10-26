import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentSpreadsheetView } from "@/components/agent/AgentSpreadsheetView";
import type { AgentDocument, DocumentSection } from "@/lib/api/agent-documents";

const sheet = (
  name: string,
  rows: DocumentSection["rows"] = [],
): DocumentSection => ({
  id: `sheet:${name}`,
  label: name,
  rows,
  text: "Stored worksheet values",
});
const workbook = (
  sections = [
    sheet("Budget", [
      [
        { reference: "B2", value: "20" },
        { reference: "D2", value: "40", formula: "B2*2" },
      ],
    ]),
    sheet("Names", [[{ reference: "A1", value: "Alice" }]]),
    sheet("Team Data", [[{ reference: "B2", value: "Team" }]]),
  ],
): AgentDocument => ({
  path: "book.xlsx",
  name: "book.xlsx",
  kind: "xlsx",
  bytes: 1000,
  revision: "current-revision",
  warnings: [],
  sections,
});

function ControlledSheet({
  document,
  initialLocator,
  onNavigate,
}: {
  document: AgentDocument;
  initialLocator?: string;
  onNavigate: (locator: string) => void;
}) {
  const [locator, setLocator] = useState(
    initialLocator || `${document.sections[0].id}!A1`,
  );
  const selected =
    document.sections.find((section) => locator.startsWith(`${section.id}!`)) ||
    document.sections[0];
  return (
    <AgentSpreadsheetView
      document={document}
      section={selected}
      locator={locator}
      zoom={1}
      onNavigate={(next) => {
        onNavigate(next);
        setLocator(next);
      }}
    />
  );
}

function open(document = workbook(), initialLocator?: string) {
  const onNavigate = vi.fn();
  render(
    <ControlledSheet
      document={document}
      initialLocator={initialLocator}
      onNavigate={onNavigate}
    />,
  );
  return onNavigate;
}

function address(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "单元格地址" }), {
    target: { value },
  });
  fireEvent.submit(screen.getByRole("form", { name: "定位单元格" }));
}

describe("Office spreadsheet interactions", () => {
  it("applies a new parent locator before committing and never reports an old selection", () => {
    const document = workbook();
    const onNavigate = vi.fn();
    const view = render(
      <AgentSpreadsheetView
        document={document}
        section={document.sections[0]}
        locator="sheet:Budget!D2"
        zoom={1}
        onNavigate={onNavigate}
      />,
    );
    expect(screen.getByRole("gridcell", { name: "D2: 40" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "单元格地址" }), {
      target: { value: "未提交地址" },
    });
    view.rerender(
      <AgentSpreadsheetView
        document={document}
        section={document.sections[1]}
        locator="sheet:Names!A1"
        zoom={1}
        onNavigate={onNavigate}
      />,
    );
    expect(screen.getByRole("gridcell", { name: "A1: Alice" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("textbox", { name: "单元格地址" })).toHaveValue(
      "A1",
    );
    expect(screen.getByRole("textbox", { name: "单元格值与公式" })).toHaveValue(
      "Alice",
    );
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("gridcell", { name: "B2: 空" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("sheet:Names!B2");
  });
  it("shows the stored value and real formula through a read-only formula bar", () => {
    const document = workbook();
    const original = JSON.stringify(document);
    const navigate = open(document, "sheet:Budget!D2");
    const cell = screen.getByRole("gridcell", { name: "D2: 40" });
    expect(cell).toHaveAttribute("aria-selected", "true");
    expect(cell).toHaveTextContent("40");
    expect(screen.getByRole("textbox", { name: "单元格值与公式" })).toHaveValue(
      "=B2*2",
    );
    expect(
      screen.getByRole("textbox", { name: "单元格值与公式" }),
    ).toHaveAttribute("readonly");
    expect(screen.getByRole("grid", { name: "Budget 单元格" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "显示公式" }));
    expect(cell).toHaveTextContent("=B2*2");
    fireEvent.click(screen.getByRole("gridcell", { name: "B2: 20" }));
    expect(navigate).toHaveBeenLastCalledWith("sheet:Budget!B2");
    expect(screen.getByRole("textbox", { name: "单元格值与公式" })).toHaveValue(
      "20",
    );
    expect(JSON.stringify(document)).toBe(original);
  });

  it("selects empty cells and ranges using actual worksheet coordinates", () => {
    const navigate = open();
    address("C3");
    expect(screen.getByRole("gridcell", { name: "C3: 空" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(navigate).toHaveBeenLastCalledWith("sheet:Budget!C3");
    expect(screen.getByRole("textbox", { name: "单元格值与公式" })).toHaveValue(
      "",
    );
    address("$A$1:$B$3");
    expect(screen.getByRole("gridcell", { name: "A1: 空" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("gridcell", { name: "B3: 空" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("gridcell", { name: "C3: 空" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(navigate).toHaveBeenLastCalledWith("sheet:Budget!A1:B3");
    address("Z1001");
    expect(screen.getByRole("gridcell", { name: "Z1001: 空" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("rowheader", { name: "1001" })).toBeVisible();
    expect(screen.queryByRole("rowheader", { name: "1" })).toBeNull();
  });

  it("keeps bounded windows while making later real rows and the final legal cell reachable", () => {
    open(
      workbook([
        sheet(
          "Data",
          Array.from({ length: 61 }, (_, index) => [
            { reference: `A${index + 1}`, value: `row-${index + 1}` },
          ]),
        ),
      ]),
    );
    let grid = screen.getByRole("grid", { name: "Data 单元格" });
    expect(within(grid).getAllByRole("row")).toHaveLength(51);
    expect(screen.getByRole("gridcell", { name: "A1: row-1" })).toBeVisible();
    expect(screen.queryByRole("gridcell", { name: "A61: row-61" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一组行" }));
    expect(screen.getByRole("gridcell", { name: "A61: row-61" })).toBeVisible();
    expect(screen.getByRole("gridcell", { name: "A100: 空" })).toBeVisible();
    expect(screen.queryByRole("gridcell", { name: "A1: row-1" })).toBeNull();
    address("XFD1048576");
    expect(
      screen.getByRole("gridcell", { name: "XFD1048576: 空" }),
    ).toHaveAttribute("aria-selected", "true");
    grid = screen.getByRole("grid", { name: "Data 单元格" });
    expect(within(grid).getAllByRole("row").length).toBeLessThanOrEqual(51);
    expect(within(grid).getAllByRole("gridcell").length).toBeLessThanOrEqual(
      1500,
    );
    expect(screen.getByRole("button", { name: "下一组行" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一组列" })).toBeDisabled();
  });

  it("switches worksheets through tabs and quoted cross-sheet addresses", () => {
    const navigate = open();
    fireEvent.click(screen.getByRole("tab", { name: "Names" }));
    expect(screen.getByRole("tab", { name: "Names" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("gridcell", { name: "A1: Alice" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(navigate).toHaveBeenLastCalledWith("sheet:Names!A1");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Names" }), {
      key: "ArrowLeft",
    });
    expect(screen.getByRole("tab", { name: "Budget" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(navigate).toHaveBeenLastCalledWith("sheet:Budget!A1");
    address("'Team Data'!$B$2");
    expect(screen.getByRole("tab", { name: "Team Data" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("gridcell", { name: "B2: Team" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(navigate).toHaveBeenLastCalledWith("sheet:Team Data!B2");
  });

  it("moves the active cell with arrows, Enter, Tab and window keys", () => {
    const navigate = open(workbook(), "sheet:Budget!B2");
    const key = (key: string, shiftKey = false) =>
      fireEvent.keyDown(screen.getByRole("grid"), { key, shiftKey });
    key("ArrowRight");
    expect(screen.getByRole("gridcell", { name: "C2: 空" })).toHaveFocus();
    key("Enter");
    expect(screen.getByRole("gridcell", { name: "C3: 空" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    key("Enter", true);
    key("Tab");
    expect(navigate).toHaveBeenLastCalledWith("sheet:Budget!D2");
    key("Tab", true);
    expect(navigate).toHaveBeenLastCalledWith("sheet:Budget!C2");
    key("PageDown");
    expect(screen.getByRole("gridcell", { name: "C52: 空" })).toHaveFocus();
    key("Home");
    expect(navigate).toHaveBeenLastCalledWith("sheet:Budget!A52");
    key("Escape");
    expect(screen.getByRole("textbox", { name: "单元格地址" })).toHaveFocus();
  });

  it("rejects invalid addresses without moving the selection or reporting a location", () => {
    const navigate = open();
    for (const value of [
      "A0",
      "XFE1",
      "A1048577",
      "B2:A1",
      "Unknown!A1",
      "https://example.com/A1",
    ]) {
      address(value);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "请输入有效的单元格或范围",
      );
      expect(
        screen.getByRole("textbox", { name: "单元格地址" }),
      ).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("gridcell", { name: "A1: 空" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
    expect(navigate).not.toHaveBeenCalled();
    address("A2");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(navigate).toHaveBeenLastCalledWith("sheet:Budget!A2");
  });
});
