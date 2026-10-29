import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentDocumentViewer,
  splitDocumentPath,
} from "@/features/agent/AgentDocumentViewer";
import { AgentPreviewPanel } from "@/features/agent/AgentPreviewPanel";
import {
  agentDocumentsApi,
  isOfficeDocumentPath,
  type AgentDocument,
  type DocumentSection,
} from "@/lib/api/agent-documents";
import { agentFilesApi } from "@/lib/api/agent-files";

const pdfMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  getPage: vi.fn(),
  render: vi.fn(),
  destroy: vi.fn(),
  cleanup: vi.fn(),
  cancel: vi.fn(),
  options: { workerSrc: "" },
}));
vi.mock("pdfjs-dist", () => ({
  getDocument: pdfMocks.getDocument,
  GlobalWorkerOptions: pdfMocks.options,
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/local/pdf.worker.mjs",
}));
vi.mock("@/lib/api/agent-documents", async (original) => ({
  ...(await original<typeof import("@/lib/api/agent-documents")>()),
  agentDocumentsApi: {
    open: vi.fn(),
    read: vi.fn(),
    search: vi.fn(),
    report: vi.fn(),
    pdf: vi.fn(),
  },
}));
vi.mock("@/lib/api/agent-files", () => ({
  agentFilesApi: { preview: vi.fn(), open: vi.fn() },
}));

const section = (
  id: string,
  text: string,
  rows: DocumentSection["rows"] = [],
): DocumentSection => ({ id, label: id, text, rows });
const document = (
  kind: AgentDocument["kind"] = "docx",
  sections: DocumentSection[] = [section("p:1", "First paragraph")],
): AgentDocument => ({
  path: `report.${kind}`,
  name: `report.${kind}`,
  kind,
  bytes: 200,
  revision: "revision-1",
  sections,
  warnings: ["Extracted content only"],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const viewer = (path = "report.docx") =>
  render(<AgentDocumentViewer sessionId="lc:session" path={path} />);
const openSearch = () => {
  const button = screen.getByRole("button", { name: "查找" });
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
};

beforeEach(() => {
  vi.mocked(agentDocumentsApi.open).mockReset().mockResolvedValue(document());
  vi.mocked(agentDocumentsApi.report).mockReset().mockResolvedValue({
    path: "report.docx",
    revision: "revision-1",
    updatedAt: 1,
  });
  vi.mocked(agentDocumentsApi.search).mockReset().mockResolvedValue({
    path: "report.docx",
    revision: "revision-1",
    matches: [],
    truncated: false,
  });
  vi.mocked(agentDocumentsApi.pdf)
    .mockReset()
    .mockResolvedValue(btoa("%PDF-fixture"));
  vi.mocked(agentFilesApi.preview).mockReset();
  vi.mocked(agentFilesApi.open).mockReset().mockResolvedValue();
  pdfMocks.destroy.mockReset().mockResolvedValue(undefined);
  pdfMocks.cleanup.mockReset();
  pdfMocks.cancel.mockReset();
  pdfMocks.render.mockReset().mockImplementation(() => ({
    promise: Promise.resolve(),
    cancel: pdfMocks.cancel,
  }));
  pdfMocks.getPage.mockReset().mockResolvedValue({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    }),
    render: pdfMocks.render,
    cleanup: pdfMocks.cleanup,
  });
  pdfMocks.getDocument.mockReset().mockImplementation(() => ({
    promise: Promise.resolve({ getPage: pdfMocks.getPage, numPages: 2 }),
    destroy: pdfMocks.destroy,
  }));
  window.getSelection()?.removeAllRanges();
});

describe("Office document viewer", () => {
  it.each([
    ["draft#2.docx", "draft#2.docx", ""],
    ["draft.pdf#2.docx", "draft.pdf#2.docx", ""],
    ["report.xlsx#sheet%3ABudget.docx", "report.xlsx", "sheet:Budget.docx"],
    ["reports#draft/notes.xlsx", "reports#draft/notes.xlsx", ""],
    ["reports.docx#draft/notes.xlsx", "reports.docx#draft/notes.xlsx", ""],
    [
      "C:\\reports#draft\\notes#2.pdf#page%3A2",
      "C:\\reports#draft\\notes#2.pdf",
      "page:2",
    ],
    [
      "report.xlsx#sheet%3ABudget%23Q1%21A1%3AB2",
      "report.xlsx",
      "sheet:Budget#Q1!A1:B2",
    ],
    ["report.xlsx#sheet:Budget#Q1!A1", "report.xlsx", "sheet:Budget#Q1!A1"],
  ])(
    "preserves literal hashes and decodes only the locator: %s",
    (path, filePath, locator) => {
      expect(isOfficeDocumentPath(path)).toBe(true);
      expect(splitDocumentPath(path)).toEqual({ filePath, locator });
    },
  );

  it("does not detect a document extension in a parent directory as the file type", () => {
    expect(isOfficeDocumentPath("report.pdf#draft/not-office.txt")).toBe(false);
  });

  it("opens a filename and directory containing hashes with an encoded sheet locator", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("xlsx", [
        section("sheet:Budget#Q1", "20", [[{ reference: "A1", value: "20" }]]),
      ]),
    );
    viewer(
      `reports#draft/notes#2.xlsx#${encodeURIComponent("sheet:Budget#Q1!A1")}`,
    );
    await waitFor(() =>
      expect(screen.getByRole("gridcell", { name: "A1: 20" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(agentDocumentsApi.open).toHaveBeenCalledWith(
      "lc:session",
      "reports#draft/notes#2.xlsx",
    );
    await waitFor(() =>
      expect(agentDocumentsApi.report).toHaveBeenLastCalledWith(
        "lc:session",
        "reports#draft/notes#2.xlsx",
        "sheet:Budget#Q1!A1",
        undefined,
        "revision-1",
      ),
    );
  });

  it("routes Office files around the legacy UTF8 preview and renders literal Word content and tables", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("docx", [
        section("p:1", "<script>documentData()</script>"),
        section("t:1", "Cell text", [
          [{ reference: "r1c1", value: "Cell text" }],
        ]),
      ]),
    );
    const view = render(
      <AgentPreviewPanel
        sessionId="lc:session"
        path="report.docx#t:1"
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText("Cell text")).toBeVisible();
    expect(screen.getByText("<script>documentData()</script>")).toBeVisible();
    expect(view.container.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByLabelText("文档信息与提示"));
    expect(screen.getByText(/未复现原始排版/)).toBeVisible();
    expect(agentFilesApi.preview).not.toHaveBeenCalled();
    expect(agentDocumentsApi.open).toHaveBeenCalledTimes(1);
    expect(agentDocumentsApi.open).toHaveBeenCalledWith(
      "lc:session",
      "report.docx",
    );
    await waitFor(() =>
      expect(agentDocumentsApi.report).toHaveBeenLastCalledWith(
        "lc:session",
        "report.docx",
        "t:1",
        undefined,
        "revision-1",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "打开预览文件" }));
    expect(agentFilesApi.open).toHaveBeenCalledWith(
      "lc:session",
      "report.docx",
      "file",
    );
  });

  it("shows spreadsheet coordinates, cached values and formulas and navigates sheets", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("xlsx", [
        section("sheet:Budget", "20\t40", [
          [
            { reference: "B2", value: "20" },
            { reference: "D2", value: "40", formula: "B2*2" },
          ],
        ]),
        section("sheet:Names", "Alice", [
          [{ reference: "A1", value: "Alice" }],
        ]),
      ]),
    );
    viewer("report.xlsx#Budget!D2");
    await waitFor(() =>
      expect(screen.getByRole("gridcell", { name: "D2: 40" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(screen.getByRole("textbox", { name: "单元格值与公式" })).toHaveValue(
      "=B2*2",
    );
    expect(screen.getByRole("columnheader", { name: "C" })).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "显示公式" }));
    expect(screen.getByRole("gridcell", { name: "D2: 40" })).toHaveTextContent(
      "=B2*2",
    );
    fireEvent.click(screen.getByRole("tab", { name: "sheet:Names" }));
    expect(screen.getByRole("gridcell", { name: "A1: Alice" })).toBeVisible();
    await waitFor(() =>
      expect(agentDocumentsApi.report).toHaveBeenLastCalledWith(
        "lc:session",
        "report.xlsx",
        "sheet:Names!A1",
        undefined,
        "revision-1",
      ),
    );
  });

  it("bounds spreadsheet windows and makes later rows reachable", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("xlsx", [
        section(
          "sheet:Data",
          "",
          Array.from({ length: 61 }, (_, index) => [
            { reference: `A${index + 1}`, value: `row-${index + 1}` },
          ]),
        ),
      ]),
    );
    viewer("report.xlsx");
    expect(
      await screen.findByRole("gridcell", { name: "A1: row-1" }),
    ).toBeVisible();
    expect(screen.queryByRole("gridcell", { name: "A61: row-61" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一组行" }));
    expect(screen.getByRole("gridcell", { name: "A61: row-61" })).toBeVisible();
    expect(screen.queryByRole("gridcell", { name: "A1: row-1" })).toBeNull();
    await screen.findByText("已共享当前位置");
    expect(agentDocumentsApi.report).toHaveBeenLastCalledWith(
      "lc:session",
      "report.xlsx",
      "sheet:Data!A51",
      undefined,
      "revision-1",
    );
  });

  it("paginates slide content and jumps to backend search matches", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("pptx", [
        section("slide:1", "Opening slide"),
        section("slide:2", "Target slide"),
      ]),
    );
    vi.mocked(agentDocumentsApi.search).mockResolvedValue({
      path: "report.pptx",
      revision: "revision-1",
      matches: [
        {
          locator: "slide:2",
          label: "Second slide match",
          text: "Target excerpt",
        },
      ],
      truncated: false,
    });
    viewer("report.pptx");
    expect(
      await screen.findByRole("heading", { name: "Opening slide" }),
    ).toBeVisible();
    openSearch();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索文档文字" }), {
      target: { value: "Target" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Second slide match/ }),
    );
    expect(screen.getByRole("heading", { name: "Target slide" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Opening slide" })).toBeNull();
    expect(screen.getByRole("button", { name: "幻灯片 2" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(agentDocumentsApi.search).toHaveBeenCalledWith(
      "lc:session",
      "report.pptx",
      "Target",
    );
    fireEvent.click(screen.getByRole("button", { name: "上一页内容" }));
    expect(
      screen.getByRole("heading", { name: "Opening slide" }),
    ).toBeVisible();
  });

  it("shares actual selected document text and exposes report failure and retry", async () => {
    viewer();
    const paragraph = await screen.findByText("First paragraph");
    await screen.findByText("已共享当前位置");
    vi.mocked(agentDocumentsApi.report).mockRejectedValueOnce(
      new Error("view state unavailable"),
    );
    const range = window.document.createRange();
    range.selectNodeContents(paragraph);
    const selected = window.getSelection()!;
    selected.removeAllRanges();
    selected.addRange(range);
    fireEvent.mouseUp(paragraph);
    expect(
      await screen.findByText(/当前位置同步失败：view state unavailable/),
    ).toBeVisible();
    expect(agentDocumentsApi.report).toHaveBeenLastCalledWith(
      "lc:session",
      "report.docx",
      "p:1",
      "First paragraph",
      "revision-1",
    );
    fireEvent.click(screen.getByRole("button", { name: "重试同步" }));
    expect(await screen.findByText("已共享选中文字（15 字）")).toBeVisible();
  });

  it("ignores late open and search results when the path changes", async () => {
    const old = deferred<AgentDocument>();
    vi.mocked(agentDocumentsApi.open).mockReturnValueOnce(old.promise);
    const view = viewer("old.docx");
    view.rerender(
      <AgentDocumentViewer sessionId="lc:session" path="new.docx" />,
    );
    expect(await screen.findByText("First paragraph")).toBeVisible();
    await act(async () =>
      old.resolve(document("docx", [section("p:1", "Obsolete document")])),
    );
    expect(screen.queryByText("Obsolete document")).toBeNull();
    const search =
      deferred<Awaited<ReturnType<typeof agentDocumentsApi.search>>>();
    vi.mocked(agentDocumentsApi.search).mockReturnValueOnce(search.promise);
    openSearch();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索文档文字" }), {
      target: { value: "old" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    view.rerender(
      <AgentDocumentViewer sessionId="lc:session" path="third.docx" />,
    );
    await screen.findByText("First paragraph");
    await act(async () =>
      search.resolve({
        path: "new.docx",
        revision: "revision-1",
        matches: [
          { locator: "p:1", label: "Obsolete search", text: "Stale text" },
        ],
        truncated: false,
      }),
    );
    expect(screen.queryByText("Obsolete search")).toBeNull();
  });

  it("reports read errors and cancels pending loads without accepting a late result", async () => {
    vi.mocked(agentDocumentsApi.open).mockRejectedValueOnce(
      new Error("Document must stay inside project"),
    );
    viewer();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Document must stay inside project",
    );
    const pending = deferred<AgentDocument>();
    vi.mocked(agentDocumentsApi.open).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "重新读取文档" }));
    fireEvent.click(screen.getByRole("button", { name: "取消读取" }));
    expect(screen.getByRole("alert")).toHaveTextContent("文档读取已取消");
    await act(async () => pending.resolve(document()));
    expect(screen.queryByText("First paragraph")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新读取文档" }));
    expect(await screen.findByText("First paragraph")).toBeVisible();
  });

  it("keeps a failed search visible and rejects stale revisions", async () => {
    viewer();
    await screen.findByText("First paragraph");
    openSearch();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索文档文字" }), {
      target: { value: "word" },
    });
    vi.mocked(agentDocumentsApi.search).mockRejectedValueOnce(
      new Error("parser refused"),
    );
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByText("搜索失败：parser refused")).toBeVisible();
    vi.mocked(agentDocumentsApi.search).mockResolvedValueOnce({
      path: "report.docx",
      revision: "changed",
      matches: [],
      truncated: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(
      await screen.findByText(/文件已变更，请重新读取后搜索/),
    ).toBeVisible();
  });

  it("switches between collapsed search and location tools without changing document data", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("docx", [
        section("p:1", "First paragraph"),
        section("p:2", "Second paragraph"),
      ]),
    );
    viewer();
    await screen.findByText("First paragraph");
    expect(screen.queryByRole("textbox", { name: "搜索文档文字" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "文档位置" })).toBeNull();
    openSearch();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索文档文字" }), {
      target: { value: "Remember search" },
    });
    fireEvent.click(screen.getByRole("button", { name: "定位" }));
    expect(screen.getByRole("button", { name: "查找" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("textbox", { name: "搜索文档文字" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "文档位置" }), {
      target: { value: "p:2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "跳转" }));
    await waitFor(() =>
      expect(agentDocumentsApi.report).toHaveBeenLastCalledWith(
        "lc:session",
        "report.docx",
        "p:2",
        undefined,
        "revision-1",
      ),
    );
    openSearch();
    expect(screen.getByRole("textbox", { name: "搜索文档文字" })).toHaveValue(
      "Remember search",
    );
    expect(screen.queryByRole("textbox", { name: "文档位置" })).toBeNull();
    expect(agentDocumentsApi.open).toHaveBeenCalledTimes(1);
  });

  it("navigates the current slide through its left navigation and reports the same locator", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("pptx", [
        section("slide:1", "First slide"),
        section(
          "slide:2",
          "Second slide\nReal content\n[Presenter notes]\nActual notes",
        ),
      ]),
    );
    viewer("report.pptx");
    await screen.findByRole("heading", { name: "First slide" });
    fireEvent.click(screen.getByRole("button", { name: "幻灯片 2" }));
    expect(screen.getByRole("heading", { name: "Second slide" })).toBeVisible();
    expect(screen.getByRole("button", { name: "幻灯片 2" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(
      within(screen.getByRole("region", { name: "演讲者备注" })).getByText(
        "Actual notes",
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(agentDocumentsApi.report).toHaveBeenLastCalledWith(
        "lc:session",
        "report.pptx",
        "slide:2",
        undefined,
        "revision-1",
      ),
    );
  });

  it("fits the initial slide to the available height while preserving space for speaker notes", async () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(1280);
    const height = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(420);
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return new DOMRect(
          0,
          0,
          1280,
          this.getAttribute("aria-label") === "演讲者备注" ? 120 : 420,
        );
      });
    let view: ReturnType<typeof viewer> | undefined;
    try {
      vi.mocked(agentDocumentsApi.open).mockResolvedValue(
        document("pptx", [
          section(
            "slide:1",
            "Height-limited slide\nReal slide content\n[Presenter notes]\nSpeaker notes stay available",
          ),
        ]),
      );
      view = viewer("report.pptx");
      await screen.findByRole("heading", { name: "Height-limited slide" });
      const zoom = () =>
        Number(
          (screen.getByRole("slider", { name: "文档缩放" }) as HTMLInputElement)
            .value,
        );
      await waitFor(() => expect(zoom()).toBeLessThan(100));
      expect(
        within(screen.getByRole("region", { name: "演讲者备注" })).getByText(
          "Speaker notes stay available",
        ),
      ).toBeVisible();
      const withNotes = zoom();
      fireEvent.click(screen.getByRole("button", { name: "备注" }));
      expect(screen.queryByRole("region", { name: "演讲者备注" })).toBeNull();
      await waitFor(() => expect(zoom()).toBeGreaterThan(withNotes));
      expect(zoom()).toBeLessThanOrEqual(100);
    } finally {
      view?.unmount();
      width.mockRestore();
      height.mockRestore();
      bounds.mockRestore();
    }
  });

  it("renders only local PDF bytes with scripting and annotations disabled and releases tasks", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("pdf", [
        section("page:1", "PDF selectable text"),
        section("page:2", "Second PDF page"),
      ]),
    );
    const view = viewer("report.pdf#page:2");
    await waitFor(() => expect(pdfMocks.render).toHaveBeenCalled());
    const canvas = await screen.findByLabelText("PDF 第 2 页");
    await waitFor(() => expect(canvas).toBeVisible());
    expect(pdfMocks.getPage).toHaveBeenLastCalledWith(2);
    expect(pdfMocks.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.any(Uint8Array),
        isEvalSupported: false,
        enableXfa: false,
        useWorkerFetch: false,
        cMapPacked: true,
        cMapUrl: "/pdfjs/cmaps/",
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        wasmUrl: "/pdfjs/wasm/",
      }),
    );
    expect(pdfMocks.getDocument.mock.calls[0][0]).not.toHaveProperty("url");
    expect(pdfMocks.options.workerSrc).toBe("/local/pdf.worker.mjs");
    expect(pdfMocks.render).toHaveBeenCalledWith(
      expect.objectContaining({ annotationMode: 0 }),
    );
    const extracted = within(screen.getByLabelText("文档查看器")).getByText(
      "Second PDF page",
    );
    expect(extracted).not.toBeVisible();
    fireEvent.click(screen.getByText("提取文字"));
    expect(extracted).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "上一页内容" }));
    await waitFor(() => expect(pdfMocks.getPage).toHaveBeenLastCalledWith(1));
    expect(agentDocumentsApi.pdf).toHaveBeenCalledTimes(1);
    expect(agentDocumentsApi.pdf).toHaveBeenCalledWith(
      "lc:session",
      "report.pdf",
      "revision-1",
    );
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(pdfMocks.destroy).toHaveBeenCalled();
    expect(pdfMocks.cancel).toHaveBeenCalled();
    expect(pdfMocks.cleanup).toHaveBeenCalled();
  });

  it("shows PDF read failure while preserving extracted text and can retry", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("pdf", [section("page:1", "Readable fallback")]),
    );
    vi.mocked(agentDocumentsApi.pdf).mockRejectedValueOnce(
      new Error("bytes denied"),
    );
    viewer("report.pdf");
    expect(await screen.findByText(/PDF 无法显示：bytes denied/)).toBeVisible();
    fireEvent.click(screen.getByText("提取文字"));
    expect(screen.getByText("Readable fallback")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重试 PDF" }));
    await waitFor(() => expect(pdfMocks.render).toHaveBeenCalled());
  });

  it("zooms the actual PDF viewport without reloading document bytes", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("pdf", [section("page:1", "PDF text")]),
    );
    viewer("report.pdf");
    await waitFor(() => expect(pdfMocks.render).toHaveBeenCalled());
    const firstWidth = pdfMocks.render.mock.calls.at(-1)![0].viewport.width;
    fireEvent.change(screen.getByRole("slider", { name: "文档缩放" }), {
      target: { value: "150" },
    });
    await waitFor(() =>
      expect(pdfMocks.render.mock.calls.at(-1)![0].viewport.width).toBeCloseTo(
        firstWidth * 1.5,
      ),
    );
    expect(screen.getByLabelText("当前缩放")).toHaveTextContent("150%");
    fireEvent.click(screen.getByRole("button", { name: "缩小" }));
    await waitFor(() =>
      expect(pdfMocks.render.mock.calls.at(-1)![0].viewport.width).toBeCloseTo(
        firstWidth * 1.4,
      ),
    );
    expect(agentDocumentsApi.pdf).toHaveBeenCalledTimes(1);
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1);
  });

  it("fits the rendered PDF into a narrow pane instead of stopping at half scale", async () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(320);
    try {
      vi.mocked(agentDocumentsApi.open).mockResolvedValue(
        document("pdf", [section("page:1", "PDF text")]),
      );
      viewer("report.pdf");
      await waitFor(() =>
        expect(screen.getByLabelText("PDF 第 1 页")).toBeVisible(),
      );
      fireEvent.click(screen.getByRole("button", { name: "适合宽度" }));
      await waitFor(() =>
        expect(
          pdfMocks.render.mock.calls.at(-1)![0].viewport.width,
        ).toBeLessThanOrEqual(320.001),
      );
      expect(
        Number(
          (screen.getByRole("slider", { name: "文档缩放" }) as HTMLInputElement)
            .value,
        ),
      ).toBeLessThan(50);
      expect(agentDocumentsApi.pdf).toHaveBeenCalledTimes(1);
    } finally {
      width.mockRestore();
    }
  });

  it("automatically fits a narrow viewport, preserves manual zoom, and resumes fitting after Fit Width", async () => {
    let viewportWidth = 320;
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(() => viewportWidth);
    const observers = new Set<() => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private target?: Element;
        private notify: () => void;
        constructor(callback: ResizeObserverCallback) {
          this.notify = () => {
            if (this.target)
              callback(
                [
                  {
                    target: this.target,
                    contentRect: { width: viewportWidth },
                  } as ResizeObserverEntry,
                ],
                this as unknown as ResizeObserver,
              );
          };
        }
        observe(target: Element) {
          this.target = target;
          observers.add(this.notify);
          this.notify();
        }
        unobserve() {
          this.target = undefined;
        }
        disconnect() {
          observers.delete(this.notify);
        }
      },
    );
    const resize = async (nextWidth: number) => {
      await act(async () => {
        viewportWidth = nextWidth;
        for (const notify of observers) notify();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
    };
    let view: ReturnType<typeof viewer> | undefined;
    try {
      vi.mocked(agentDocumentsApi.open).mockResolvedValue(
        document("pdf", [section("page:1", "PDF text")]),
      );
      view = viewer("report.pdf");
      await waitFor(() => {
        expect(screen.getByLabelText("PDF 第 1 页")).toBeVisible();
        expect(
          pdfMocks.render.mock.calls.at(-1)![0].viewport.width,
        ).toBeLessThanOrEqual(320.001);
      });
      expect(
        Number(
          (screen.getByRole("slider", { name: "文档缩放" }) as HTMLInputElement)
            .value,
        ),
      ).toBeLessThan(50);
      fireEvent.change(screen.getByRole("slider", { name: "文档缩放" }), {
        target: { value: "150" },
      });
      await waitFor(() =>
        expect(
          pdfMocks.render.mock.calls.at(-1)![0].viewport.width,
        ).toBeGreaterThan(320),
      );
      const manualWidth = pdfMocks.render.mock.calls.at(-1)![0].viewport.width;
      await resize(480);
      expect(screen.getByRole("slider", { name: "文档缩放" })).toHaveValue(
        "150",
      );
      expect(pdfMocks.render.mock.calls.at(-1)![0].viewport.width).toBe(
        manualWidth,
      );
      fireEvent.click(screen.getByRole("button", { name: "适合宽度" }));
      await waitFor(() =>
        expect(
          pdfMocks.render.mock.calls.at(-1)![0].viewport.width,
        ).toBeLessThanOrEqual(480.001),
      );
      const fittedWidth = pdfMocks.render.mock.calls.at(-1)![0].viewport.width;
      await resize(640);
      await waitFor(() => {
        const currentWidth =
          pdfMocks.render.mock.calls.at(-1)![0].viewport.width;
        expect(currentWidth).toBeGreaterThan(fittedWidth);
        expect(currentWidth).toBeLessThanOrEqual(640.001);
      });
      expect(agentDocumentsApi.pdf).toHaveBeenCalledTimes(1);
    } finally {
      view?.unmount();
      width.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("ignores late PDF bytes after switching to another document", async () => {
    const bytes = deferred<string>();
    vi.mocked(agentDocumentsApi.open).mockResolvedValueOnce(
      document("pdf", [section("page:1", "Old PDF text")]),
    );
    vi.mocked(agentDocumentsApi.pdf).mockReturnValueOnce(bytes.promise);
    const view = viewer("old.pdf");
    await waitFor(() => expect(agentDocumentsApi.pdf).toHaveBeenCalled());
    view.rerender(
      <AgentDocumentViewer sessionId="lc:session" path="new.docx" />,
    );
    await screen.findByText("First paragraph");
    await act(async () => bytes.resolve(btoa("%PDF-late")));
    expect(pdfMocks.getDocument).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("PDF 第 1 页")).toBeNull();
  });

  it("serializes view reports and coalesces superseded locations", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("docx", [
        section("p:1", "One"),
        section("p:2", "Two"),
        section("p:3", "Three"),
      ]),
    );
    viewer();
    await screen.findByText("已共享当前位置");
    const pending =
      deferred<Awaited<ReturnType<typeof agentDocumentsApi.report>>>();
    vi.mocked(agentDocumentsApi.report).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "p:2" }));
    await waitFor(() =>
      expect(agentDocumentsApi.report).toHaveBeenLastCalledWith(
        "lc:session",
        "report.docx",
        "p:2",
        undefined,
        "revision-1",
      ),
    );
    const count = vi.mocked(agentDocumentsApi.report).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "p:3" }));
    fireEvent.click(screen.getByRole("button", { name: "p:1" }));
    expect(agentDocumentsApi.report).toHaveBeenCalledTimes(count);
    await act(async () =>
      pending.resolve({
        path: "report.docx",
        revision: "revision-1",
        updatedAt: 2,
      }),
    );
    await waitFor(() =>
      expect(agentDocumentsApi.report).toHaveBeenLastCalledWith(
        "lc:session",
        "report.docx",
        "p:1",
        undefined,
        "revision-1",
      ),
    );
    expect(agentDocumentsApi.report).toHaveBeenCalledTimes(count + 1);
  });

  it("cancels a running PDF render and releases it on page replacement", async () => {
    vi.mocked(agentDocumentsApi.open).mockResolvedValue(
      document("pdf", [
        section("page:1", "Page one"),
        section("page:2", "Page two"),
      ]),
    );
    const pending = deferred<void>();
    pdfMocks.render.mockImplementationOnce(() => ({
      promise: pending.promise,
      cancel: pdfMocks.cancel,
    }));
    const view = viewer("report.pdf");
    await waitFor(() => expect(pdfMocks.render).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "取消渲染" }));
    expect(pdfMocks.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("页面渲染已取消");
    fireEvent.click(screen.getByRole("button", { name: "下一页内容" }));
    await waitFor(() => expect(pdfMocks.getPage).toHaveBeenLastCalledWith(2));
    await act(async () => pending.reject(new Error("Rendering cancelled")));
    expect(pdfMocks.cleanup).toHaveBeenCalled();
    expect(screen.queryByText(/Rendering cancelled/)).toBeNull();
    view.unmount();
    expect(pdfMocks.destroy).toHaveBeenCalledTimes(1);
  });
});
