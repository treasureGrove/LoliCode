import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  LocateFixed,
  Loader2,
  Maximize,
  Minus,
  PanelLeft,
  Plus,
  Search,
} from "lucide-react";
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  RenderTask,
} from "pdfjs-dist";
import {
  agentDocumentsApi,
  type AgentDocument,
  type DocumentSearch,
  type DocumentSection,
} from "@/lib/api/agent-documents";
import { AgentSpreadsheetView } from "./AgentSpreadsheetView";
import "./agent-document-viewer.css";

const SECTION_WINDOW = 20;
const ROW_WINDOW = 50;
const COLUMN_WINDOW = 30;
const PAGE_WIDTH = 794;
const SLIDE_WIDTH = 960;
const SLIDE_HEIGHT = 540;
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
const canvasContentWidth = (element: HTMLElement) => {
  if (!element.clientWidth) return 0;
  const style = window.getComputedStyle(element);
  return Math.max(
    0,
    element.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0),
  );
};

export const splitDocumentPath = (path: string) => {
  // A # inside a filename or directory is literal. Only a suffix following
  // the document extension is a locator; a complete filename takes priority.
  const match = /^(.*\.(?:docx|xlsx|pptx|pdf))#([^\\/]*)$/i.exec(path);
  if (!match) return { filePath: path, locator: "" };
  let locator = match[2];
  try {
    locator = decodeURIComponent(locator);
  } catch {
    /* Keep malformed fragments visible for correction. */
  }
  if (
    /\.(?:docx|xlsx|pptx|pdf)$/i.test(path) &&
    !/^(?:p:|t:|slide:|page[:=]|sheet:)/i.test(locator)
  )
    return { filePath: path, locator: "" };
  return { filePath: match[1], locator };
};

const cellPosition = (reference: string) => {
  const match = /^\$?([a-z]+)\$?([1-9]\d*)$/i.exec(reference);
  if (!match) return null;
  let column = 0;
  for (const char of match[1].toUpperCase())
    column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return column <= 16384 && row <= 1048576 ? { column, row } : null;
};

interface Location {
  index: number;
  locator: string;
  range?: {
    first: { column: number; row: number };
    last: { column: number; row: number };
  };
}

const findLocation = (
  document: AgentDocument,
  requested: string,
): Location | null => {
  let locator = requested.trim().replace(/^#/, "");
  if (!locator)
    return document.sections.length
      ? { index: 0, locator: document.sections[0].id }
      : null;
  if (/^\d+$/.test(locator))
    locator = `${document.kind === "pdf" ? "page" : document.kind === "pptx" ? "slide" : "p"}:${locator}`;
  if (document.kind === "pdf") locator = locator.replace(/^page=/i, "page:");
  const exact = document.sections.findIndex(
    (section) => section.id === locator,
  );
  if (exact >= 0) return { index: exact, locator };
  if (document.kind !== "xlsx") return null;
  const bang = locator.lastIndexOf("!");
  let sheet = (bang < 0 ? locator : locator.slice(0, bang)).replace(
    /^sheet:/,
    "",
  );
  if (sheet.startsWith("'") && sheet.endsWith("'"))
    sheet = sheet.slice(1, -1).replace(/''/g, "'");
  const index = document.sections.findIndex(
    (section) => section.id === `sheet:${sheet}`,
  );
  if (index < 0) return null;
  if (bang < 0) return { index, locator: document.sections[index].id };
  const range = locator
    .slice(bang + 1)
    .toUpperCase()
    .replace(/\$/g, "");
  const parts = range.split(":");
  if (parts.length > 2) return null;
  const first = cellPosition(parts[0]);
  const last = cellPosition(parts[1] || parts[0]);
  if (!first || !last || first.column > last.column || first.row > last.row)
    return null;
  return {
    index,
    locator: `${document.sections[index].id}!${range}`,
    range: { first, last },
  };
};

function DocumentTable({ section }: { section: DocumentSection }) {
  const [rowPage, setRowPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const columnCount = section.rows.reduce(
    (maximum, row) => Math.max(maximum, row.length),
    1,
  );
  const rows = section.rows.slice(
    rowPage * ROW_WINDOW,
    (rowPage + 1) * ROW_WINDOW,
  );
  const firstColumn = columnPage * COLUMN_WINDOW;
  return (
    <div className="agent-document-table-block">
      <div
        className="agent-document-grid-scroll"
        tabIndex={0}
        aria-label={`${section.label} 表格`}
      >
        <table>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row
                  .slice(firstColumn, firstColumn + COLUMN_WINDOW)
                  .map((cell) => (
                    <td key={cell.reference} data-document-locator={section.id}>
                      {cell.value}
                    </td>
                  ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(section.rows.length > ROW_WINDOW || columnCount > COLUMN_WINDOW) && (
        <div className="agent-document-grid-pages">
          {section.rows.length > ROW_WINDOW && (
            <span>
              <button
                type="button"
                disabled={!rowPage}
                onClick={() => setRowPage(rowPage - 1)}
              >
                上一组行
              </button>
              {rowPage * ROW_WINDOW + 1}–
              {Math.min((rowPage + 1) * ROW_WINDOW, section.rows.length)} /{" "}
              {section.rows.length} 行
              <button
                type="button"
                disabled={(rowPage + 1) * ROW_WINDOW >= section.rows.length}
                onClick={() => setRowPage(rowPage + 1)}
              >
                下一组行
              </button>
            </span>
          )}
          {columnCount > COLUMN_WINDOW && (
            <span>
              <button
                type="button"
                disabled={!columnPage}
                onClick={() => setColumnPage(columnPage - 1)}
              >
                上一组列
              </button>
              {firstColumn + 1}–
              {Math.min(firstColumn + COLUMN_WINDOW, columnCount)} 列
              <button
                type="button"
                disabled={(columnPage + 1) * COLUMN_WINDOW >= columnCount}
                onClick={() => setColumnPage(columnPage + 1)}
              >
                下一组列
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const slideText = (section: DocumentSection) => {
  const marker = "\n[Presenter notes]\n";
  const at = section.text.indexOf(marker);
  const body = at < 0 ? section.text : section.text.slice(0, at);
  const lines = body.split("\n");
  return {
    title: lines[0] || "",
    body: lines.slice(1).join("\n"),
    notes: at < 0 ? "" : section.text.slice(at + marker.length),
  };
};

function DocumentInfo({ document }: { document: AgentDocument }) {
  return (
    <details className="agent-document-info">
      <summary aria-label="文档信息与提示">
        <FileText size={16} />
      </summary>
      <div>
        <strong>文档信息</strong>
        <p>{document.path}</p>
        <p>
          {(document.bytes / 1024).toFixed(1)} KB · {document.sections.length}{" "}
          {document.kind === "xlsx"
            ? "张工作表"
            : document.kind === "docx"
              ? "个内容段落 / 表格"
              : document.kind === "pptx"
                ? "张幻灯片"
                : "页"}
        </p>
        {(document.kind === "docx" || document.kind === "pptx") && (
          <p>显示提取的文字与表格，未复现原始排版。文档按内容分组阅读。</p>
        )}
        {document.warnings.map((warning, index) => (
          <p key={index}>{warning}</p>
        ))}
      </div>
    </details>
  );
}

function PdfPage({
  sessionId,
  path,
  pageNumber,
  revision,
  zoom,
  onNaturalWidth,
}: {
  sessionId: string;
  path: string;
  pageNumber: number;
  revision: string;
  zoom: number;
  onNaturalWidth: (width: number) => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cancel = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false;
    let task: PDFDocumentLoadingTask | undefined;
    setPdf(null);
    setLoading(true);
    setError(null);
    const stop = () => {
      disposed = true;
      void task?.destroy().catch(() => {});
    };
    cancel.current = () => {
      stop();
      setLoading(false);
      setError("PDF 加载已取消。");
    };
    void Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      agentDocumentsApi.pdf(sessionId, path, revision),
    ])
      .then(async ([pdfjs, worker, encoded]) => {
        if (disposed) return;
        if (encoded.length > 28 * 1024 * 1024)
          throw new Error("PDF 数据超过查看器限制。");
        const bytes = Uint8Array.from(atob(encoded), (character) =>
          character.charCodeAt(0),
        );
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const base = import.meta.env.BASE_URL;
        task = pdfjs.getDocument({
          data: bytes,
          isEvalSupported: false,
          enableXfa: false,
          cMapUrl: `${base}pdfjs/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
          wasmUrl: `${base}pdfjs/wasm/`,
          useWorkerFetch: false,
          disableAutoFetch: true,
          disableRange: true,
          disableStream: true,
          stopAtErrors: true,
          maxImageSize: 16 * 1024 * 1024,
        });
        const document = await task.promise;
        if (!disposed) setPdf(document);
      })
      .catch((cause) => {
        if (!disposed) setError(`PDF 无法显示：${errorText(cause)}`);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return stop;
  }, [sessionId, path, revision, attempt]);
  useEffect(() => {
    if (!pdf) return;
    let disposed = false;
    let render: RenderTask | undefined;
    let cleanup: (() => void) | undefined;
    setDrawing(true);
    setError(null);
    const stop = () => {
      disposed = true;
      render?.cancel();
    };
    cancel.current = () => {
      stop();
      setDrawing(false);
      setError("页面渲染已取消。");
    };
    void pdf
      .getPage(pageNumber)
      .then(async (page) => {
        cleanup = () => {
          page.cleanup();
        };
        if (disposed) return;
        const target = canvas.current;
        if (!target) return;
        const base = page.getViewport({ scale: 1 });
        onNaturalWidth((base.width * 96) / 72);
        let scale = (zoom * 96) / 72;
        const displayViewport = page.getViewport({ scale });
        let viewport = displayViewport;
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        if (
          viewport.width * viewport.height * ratio * ratio >
          12 * 1024 * 1024
        ) {
          scale *= Math.sqrt(
            (12 * 1024 * 1024) /
              (viewport.width * viewport.height * ratio * ratio),
          );
          viewport = page.getViewport({ scale });
        }
        target.width = Math.ceil(viewport.width * ratio);
        target.height = Math.ceil(viewport.height * ratio);
        target.style.width = `${displayViewport.width}px`;
        target.style.height = `${displayViewport.height}px`;
        render = page.render({
          canvas: target,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          annotationMode: 0,
        });
        await render.promise;
      })
      .catch((cause) => {
        if (!disposed) setError(`页面无法渲染：${errorText(cause)}`);
      })
      .finally(() => {
        cleanup?.();
        if (!disposed) setDrawing(false);
      });
    return stop;
  }, [pdf, pageNumber, zoom, onNaturalWidth]);
  return (
    <div className="agent-document-pdf">
      {(loading || drawing) && (
        <p role="status">
          <Loader2 size={14} className="animate-spin" />
          {loading ? "正在加载 PDF…" : "正在渲染页面…"}
          <button type="button" onClick={() => cancel.current()}>
            取消{loading ? "加载" : "渲染"}
          </button>
        </p>
      )}
      {error && (
        <p role="alert">
          {error}
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试 PDF
          </button>
        </p>
      )}
      <canvas
        ref={canvas}
        aria-label={`PDF 第 ${pageNumber} 页`}
        hidden={!pdf || loading || drawing || Boolean(error)}
      />
    </div>
  );
}

export function AgentDocumentViewer({
  sessionId,
  path,
  revision = 0,
  onLoadingChange,
  embedded = false,
}: {
  sessionId: string;
  path: string;
  revision?: number;
  onLoadingChange?: (loading: boolean) => void;
  embedded?: boolean;
}) {
  const { filePath, locator: initialLocator } = splitDocumentPath(path);
  const [attempt, setAttempt] = useState(0);
  const key = `${sessionId}\0${filePath}\0${revision}\0${attempt}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    document: AgentDocument;
  } | null>(null);
  const document = loaded?.key === key ? loaded.document : null;
  const characterCount = useMemo(() => {
    let count = 0;
    for (const section of document?.sections || [])
      for (const _character of section.text) count++;
    return count;
  }, [document]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [location, setLocation] = useState<Location | null>(null);
  const [locatorDraft, setLocatorDraft] = useState(initialLocator);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<"search" | "locate" | null>(null);
  const [zoom, setZoom] = useState(1);
  const [zoomMode, setZoomMode] = useState<"initial" | "fit" | "manual">(
    "initial",
  );
  const [availableWidth, setAvailableWidth] = useState(0);
  const [availableHeight, setAvailableHeight] = useState(0);
  const [notesSpace, setNotesSpace] = useState(0);
  const [thumbnailsOpen, setThumbnailsOpen] = useState(true);
  const [notesOpen, setNotesOpen] = useState(true);
  const [pdfNaturalWidth, setPdfNaturalWidth] = useState(PAGE_WIDTH);
  const viewport = useRef<HTMLDivElement>(null);
  const notes = useRef<HTMLElement>(null);
  const [search, setSearch] = useState<DocumentSearch | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [selection, setSelection] = useState("");
  const [report, setReport] = useState({ pending: false, error: "" });
  const [reportAttempt, setReportAttempt] = useState(0);
  const searchSequence = useRef(0);
  const loadCancel = useRef<() => void>(() => {});
  const content = useRef<HTMLDivElement>(null);
  const reportQueue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let disposed = false;
    setLoaded(null);
    setLoading(true);
    setError(null);
    setLocation(null);
    setSelection("");
    setSearch(null);
    setSearchError(null);
    setSearching(false);
    setZoom(1);
    setZoomMode("initial");
    setAvailableWidth(0);
    setAvailableHeight(0);
    setNotesSpace(0);
    setPdfNaturalWidth(PAGE_WIDTH);
    setReport({ pending: false, error: "" });
    searchSequence.current++;
    onLoadingChange?.(true);
    loadCancel.current = () => {
      disposed = true;
      setLoading(false);
      setError("文档读取已取消。");
      onLoadingChange?.(false);
    };
    void agentDocumentsApi
      .open(sessionId, filePath)
      .then(
        (result) => {
          if (!disposed) setLoaded({ key, document: result });
        },
        (cause) => {
          if (!disposed) setError(errorText(cause));
        },
      )
      .finally(() => {
        if (!disposed) {
          setLoading(false);
          onLoadingChange?.(false);
        }
      });
    return () => {
      disposed = true;
      searchSequence.current++;
      onLoadingChange?.(false);
    };
  }, [sessionId, filePath, key, onLoadingChange]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const width = canvasContentWidth(element);
      if (width > 0) setAvailableWidth(width);
      if (element.clientHeight > 0) {
        const style = window.getComputedStyle(element);
        setAvailableHeight(
          Math.max(
            1,
            element.clientHeight -
              (parseFloat(style.paddingTop) || 0) -
              (parseFloat(style.paddingBottom) || 0),
          ),
        );
      }
      const note = notes.current;
      const noteStyle = note ? window.getComputedStyle(note) : null;
      setNotesSpace(
        note && noteStyle
          ? note.getBoundingClientRect().height +
              (parseFloat(noteStyle.marginTop) || 0) +
              (parseFloat(noteStyle.marginBottom) || 0)
          : 0,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    if (notes.current) observer?.observe(notes.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [document?.kind, thumbnailsOpen, notesOpen]);
  useEffect(() => {
    if (
      !document ||
      document.kind === "xlsx" ||
      zoomMode === "manual" ||
      !availableWidth
    )
      return;
    const natural =
      document.kind === "pptx"
        ? SLIDE_WIDTH
        : document.kind === "pdf"
          ? pdfNaturalWidth
          : PAGE_WIDTH;
    const maximum = zoomMode === "initial" ? 1 : 2;
    const widthRatio = availableWidth / natural;
    const heightRatio =
      document.kind === "pptx" && zoomMode === "initial" && availableHeight > 0
        ? Math.max(0, availableHeight - notesSpace) / (SLIDE_HEIGHT + 8)
        : Infinity;
    setZoom(
      Math.max(
        0.2,
        Math.min(
          maximum,
          Math.floor(Math.min(widthRatio, heightRatio) * 100) / 100,
        ),
      ),
    );
  }, [
    document?.kind,
    availableWidth,
    availableHeight,
    notesSpace,
    pdfNaturalWidth,
    zoomMode,
  ]);
  useEffect(() => {
    if (!document) return;
    const target = findLocation(document, initialLocator);
    setLocation(target || findLocation(document, ""));
    setLocatorDraft(initialLocator || target?.locator || "");
    setLocationError(
      initialLocator && !target ? `找不到位置：${initialLocator}` : null,
    );
    setSelection("");
  }, [document, initialLocator]);
  useEffect(() => {
    if (!document) return;
    let disposed = false;
    setReport({ pending: true, error: "" });
    reportQueue.current = reportQueue.current
      .catch(() => {})
      .then(async () => {
        if (disposed) return;
        try {
          const result = await agentDocumentsApi.report(
            sessionId,
            filePath,
            location?.locator,
            selection || undefined,
            document.revision,
          );
          if (result.revision !== document.revision)
            throw new Error("文件已变更，请重新读取后共享位置。");
          if (!disposed) setReport({ pending: false, error: "" });
        } catch (cause) {
          if (!disposed) setReport({ pending: false, error: errorText(cause) });
        }
      });
    return () => {
      disposed = true;
    };
  }, [
    document,
    sessionId,
    filePath,
    location?.locator,
    selection,
    reportAttempt,
  ]);
  const navigate = (locator: string) => {
    if (!document) return;
    const target = findLocation(document, locator);
    if (!target) {
      setLocationError(`找不到位置：${locator}`);
      return;
    }
    setLocation(target);
    setLocatorDraft(target.locator);
    setLocationError(null);
    setSelection("");
    requestAnimationFrame(() => {
      const element = Array.from(
        content.current?.querySelectorAll<HTMLElement>(
          "[data-document-section]",
        ) || [],
      ).find(
        (node) =>
          node.dataset.documentSection === document.sections[target.index].id,
      );
      element?.scrollIntoView?.({ block: "nearest" });
    });
  };
  const captureSelection = () => {
    const selected = window.getSelection();
    if (
      !selected ||
      !content.current ||
      !selected.anchorNode ||
      !selected.focusNode ||
      !content.current.contains(selected.anchorNode) ||
      !content.current.contains(selected.focusNode)
    )
      return;
    const text = selected.toString().trim();
    if (!text) {
      setSelection("");
      return;
    }
    const nearest = (node: Node) =>
      (node instanceof Element
        ? node
        : node.parentElement
      )?.closest<HTMLElement>("[data-document-locator]");
    const anchor = nearest(selected.anchorNode);
    const focus = nearest(selected.focusNode);
    if (
      !anchor ||
      !focus ||
      anchor.dataset.documentLocator !== focus.dataset.documentLocator
    ) {
      setLocationError("请选择同一段落、表格或单元格内的文字。");
      return;
    }
    if ([...text].length > 8000) {
      setLocationError("选中文字不能超过 8,000 字，请缩小选择范围。");
      return;
    }
    const target =
      document && findLocation(document, anchor.dataset.documentLocator || "");
    if (target) {
      setLocation(target);
      setLocatorDraft(target.locator);
      setLocationError(null);
      setSelection(text);
    }
  };
  const activeIndex = location?.index || 0;
  const active = document?.sections[activeIndex];
  const sectionStart =
    Math.floor(activeIndex / SECTION_WINDOW) * SECTION_WINDOW;
  const visible =
    document?.kind === "docx"
      ? document.sections.slice(sectionStart, sectionStart + SECTION_WINDOW)
      : active
        ? [active]
        : [];
  const pageCount = document
    ? document.kind === "docx"
      ? Math.ceil(document.sections.length / SECTION_WINDOW)
      : document.sections.length
    : 0;
  const pageNumber =
    document?.kind === "docx"
      ? Math.floor(activeIndex / SECTION_WINDOW) + 1
      : activeIndex + 1;
  const title =
    document?.kind === "xlsx"
      ? "电子表格"
      : document?.kind === "pptx"
        ? "幻灯片内容"
        : document?.kind === "pdf"
          ? "PDF 文档"
          : "文档内容";
  const setPage = (index: number) => {
    if (!document?.sections.length) return;
    const sectionIndex =
      document.kind === "docx" ? index * SECTION_WINDOW : index;
    navigate(
      document.sections[
        Math.max(0, Math.min(document.sections.length - 1, sectionIndex))
      ].id,
    );
  };
  const changeZoom = (value: number) => {
    setZoomMode("manual");
    setZoom(Math.max(0.2, Math.min(2, Math.round(value * 100) / 100)));
  };
  const fitWidth = () => {
    setZoomMode("fit");
    if (viewport.current) {
      const width = canvasContentWidth(viewport.current);
      if (width > 0) setAvailableWidth(width);
    }
  };
  const runSearch = () => {
    if (!document || !query.trim()) return;
    const sequence = ++searchSequence.current;
    setSearching(true);
    setSearch(null);
    setSearchError(null);
    void agentDocumentsApi
      .search(sessionId, filePath, query.trim())
      .then(
        (result) => {
          if (searchSequence.current !== sequence) return;
          if (result.revision !== document.revision) {
            setSearchError("文件已变更，请重新读取后搜索。");
            return;
          }
          setSearch(result);
        },
        (cause) => {
          if (searchSequence.current === sequence)
            setSearchError(errorText(cause));
        },
      )
      .finally(() => {
        if (searchSequence.current === sequence) setSearching(false);
      });
  };
  const renderSection = (section: DocumentSection) => (
    <article
      key={section.id}
      className="agent-document-paragraph"
      data-document-section={section.id}
      data-document-locator={section.id}
      data-active={
        document?.sections[activeIndex]?.id === section.id || undefined
      }
    >
      <button
        className="agent-document-section-label"
        type="button"
        title={`定位：${section.label}`}
        onClick={() => navigate(section.id)}
      >
        {section.label}
      </button>
      {section.rows.length ? (
        <DocumentTable section={section} />
      ) : (
        <div className="agent-document-text">{section.text || "\u00a0"}</div>
      )}
    </article>
  );
  const currentSlide =
    active && document?.kind === "pptx" ? slideText(active) : null;
  const thumbnailStart = Math.floor(activeIndex / 40) * 40;
  return (
    <section
      className="agent-document-viewer"
      data-kind={document?.kind || "loading"}
      aria-label="文档查看器"
    >
      {loading && (
        <p role="status" className="agent-document-state">
          <Loader2 size={16} className="animate-spin" />
          正在读取文档…
          <button type="button" onClick={() => loadCancel.current()}>
            取消读取
          </button>
        </p>
      )}
      {error && (
        <div role="alert" className="agent-document-state">
          {error}
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重新读取文档
          </button>
        </div>
      )}
      {document && (
        <>
          {!embedded && (
            <header className="agent-document-titlebar">
              <span className="agent-document-format" aria-hidden="true">
                {document.kind === "docx"
                  ? "W"
                  : document.kind === "xlsx"
                    ? "X"
                    : document.kind === "pptx"
                      ? "P"
                      : "PDF"}
              </span>
              <div className="agent-document-file-info">
                <strong title={document.path}>{document.name}</strong>
                <span>
                  {title}
                  <i>·</i>
                  {document.kind.toUpperCase()}
                </span>
              </div>
              <span className="agent-document-readonly">
                <Eye size={13} />
                只读
              </span>
              <DocumentInfo document={document} />
            </header>
          )}
          <div
            className="agent-document-ribbon"
            role="toolbar"
            aria-label="文档阅读工具"
          >
            <span className="agent-document-ribbon-tab">阅读</span>
            <div className="agent-document-tool-group">
              <button
                type="button"
                aria-label="查找"
                aria-expanded={panel === "search"}
                onClick={() => setPanel(panel === "search" ? null : "search")}
              >
                <Search size={16} />
                <span>查找</span>
              </button>
              {document.kind !== "xlsx" && (
                <button
                  type="button"
                  aria-label="定位"
                  aria-expanded={panel === "locate"}
                  onClick={() => setPanel(panel === "locate" ? null : "locate")}
                >
                  <LocateFixed size={16} />
                  <span>定位</span>
                </button>
              )}
            </div>
            {document.kind !== "xlsx" && (
              <div className="agent-document-tool-group agent-document-page-tools">
                <button
                  type="button"
                  aria-label="上一页内容"
                  title="上一页"
                  disabled={pageNumber <= 1}
                  onClick={() => setPage(pageNumber - 2)}
                >
                  <ChevronLeft size={17} />
                </button>
                <label>
                  <span className="sr-only">
                    {document.kind === "docx"
                      ? "阅读分页"
                      : document.kind === "pptx"
                        ? "幻灯片"
                        : "页码"}
                  </span>
                  <select
                    aria-label={
                      document.kind === "docx"
                        ? "阅读分页"
                        : document.kind === "pptx"
                          ? "幻灯片"
                          : "页码"
                    }
                    value={pageNumber - 1}
                    onChange={(event) => setPage(Number(event.target.value))}
                  >
                    {Array.from({ length: pageCount }, (_, index) => (
                      <option key={index} value={index}>
                        {index + 1} / {pageCount}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  aria-label="下一页内容"
                  title="下一页"
                  disabled={pageNumber >= pageCount}
                  onClick={() => setPage(pageNumber)}
                >
                  <ChevronRight size={17} />
                </button>
              </div>
            )}
            <div className="agent-document-tool-group agent-document-view-tools">
              {document.kind === "pptx" && (
                <button
                  type="button"
                  aria-label="幻灯片导航"
                  aria-pressed={thumbnailsOpen}
                  onClick={() => setThumbnailsOpen(!thumbnailsOpen)}
                >
                  <PanelLeft size={16} />
                  <span>导航</span>
                </button>
              )}
              {document.kind === "pptx" && (
                <button
                  type="button"
                  aria-label="备注"
                  aria-pressed={notesOpen}
                  onClick={() => setNotesOpen(!notesOpen)}
                >
                  <BookOpen size={16} />
                  <span>备注</span>
                </button>
              )}
              {document.kind !== "xlsx" && (
                <button
                  type="button"
                  aria-label="适合宽度"
                  title="适合宽度"
                  aria-pressed={zoomMode !== "manual"}
                  onClick={fitWidth}
                >
                  <Maximize size={15} />
                  <span>适合宽度</span>
                </button>
              )}
              {embedded && <DocumentInfo document={document} />}
            </div>
          </div>
          {panel === "locate" && document.kind !== "xlsx" && (
            <form
              className="agent-document-locator agent-document-utility-panel"
              onSubmit={(event) => {
                event.preventDefault();
                navigate(locatorDraft);
              }}
            >
              <LocateFixed size={15} />
              <input
                aria-label="文档位置"
                value={locatorDraft}
                onChange={(event) => setLocatorDraft(event.target.value)}
                placeholder={
                  document.kind === "pdf"
                    ? "page:2"
                    : document.kind === "pptx"
                      ? "slide:2"
                      : "p:3 或 t:1"
                }
              />
              <button type="submit">跳转</button>
            </form>
          )}
          {panel === "search" && (
            <div className="agent-document-utility-panel agent-document-search-panel">
              <form
                className="agent-document-search"
                role="search"
                aria-label="搜索文档"
                onSubmit={(event) => {
                  event.preventDefault();
                  runSearch();
                }}
              >
                <Search size={15} />
                <input
                  aria-label="搜索文档文字"
                  maxLength={500}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="查找文档中的文字"
                  autoFocus
                />
                <button type="submit" disabled={!query.trim() || searching}>
                  搜索
                </button>
                {searching && (
                  <button
                    type="button"
                    onClick={() => {
                      searchSequence.current++;
                      setSearching(false);
                    }}
                  >
                    取消搜索
                  </button>
                )}
              </form>
              {searching && <p role="status">正在搜索…</p>}
              {searchError && (
                <p role="alert" className="agent-document-error">
                  搜索失败：{searchError}
                </p>
              )}
              {search && (
                <div
                  className="agent-document-results"
                  aria-label="文档搜索结果"
                >
                  <p role="status">
                    {search.matches.length
                      ? `${search.matches.length} 个匹配位置${search.truncated ? "，仅显示部分结果" : ""}`
                      : "没有匹配内容"}
                  </p>
                  {search.matches.map((match, index) => (
                    <button
                      type="button"
                      key={`${match.locator}-${index}`}
                      onClick={() => navigate(match.locator)}
                    >
                      <strong>{match.label}</strong>
                      <span>{match.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {locationError && (
            <p
              role="alert"
              className="agent-document-error agent-document-inline-error"
            >
              {locationError}
            </p>
          )}
          <div
            className="agent-document-workspace"
            ref={content}
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
          >
            {document.kind === "pptx" && thumbnailsOpen && (
              <nav
                className="agent-document-slide-nav"
                aria-label="幻灯片导航列表"
              >
                {document.sections
                  .slice(thumbnailStart, thumbnailStart + 40)
                  .map((section, offset) => {
                    const number = thumbnailStart + offset + 1;
                    const text = slideText(section);
                    return (
                      <button
                        type="button"
                        key={section.id}
                        aria-label={`幻灯片 ${number}`}
                        aria-current={
                          activeIndex === number - 1 ? "true" : undefined
                        }
                        onClick={() => navigate(section.id)}
                      >
                        <span className="agent-document-thumb-number">
                          {number}
                        </span>
                        <span className="agent-document-slide-thumb">
                          <strong>{text.title}</strong>
                          <span>{text.body.slice(0, 170)}</span>
                        </span>
                      </button>
                    );
                  })}
                {document.sections.length > 40 && (
                  <div className="agent-document-thumbnail-pages">
                    <button
                      type="button"
                      disabled={!thumbnailStart}
                      onClick={() => setPage(Math.max(0, thumbnailStart - 40))}
                    >
                      前一组
                    </button>
                    <button
                      type="button"
                      disabled={thumbnailStart + 40 >= document.sections.length}
                      onClick={() => setPage(thumbnailStart + 40)}
                    >
                      后一组
                    </button>
                  </div>
                )}
              </nav>
            )}
            {document.kind === "xlsx" && active ? (
              <div
                className="agent-document-sheet-stage"
                data-document-section={active.id}
                data-document-locator={active.id}
              >
                <AgentSpreadsheetView
                  document={document}
                  section={active}
                  locator={location?.locator}
                  onNavigate={navigate}
                  zoom={zoom}
                />
              </div>
            ) : (
              <div
                className={`agent-document-stage agent-document-stage-${document.kind}`}
                ref={viewport}
              >
                {!document.sections.length && (
                  <p className="agent-document-state">文档没有可读取的内容。</p>
                )}
                {document.kind === "docx" && (
                  <div className="agent-document-word-layout" style={{ zoom }}>
                    <div className="agent-document-ruler" aria-hidden="true">
                      <span />
                      {Array.from({ length: 16 }, (_, index) => (
                        <i key={index}>{index + 1}</i>
                      ))}
                      <span />
                    </div>
                    <div className="agent-document-paper">
                      <div className="agent-document-paper-body">
                        {visible.map(renderSection)}
                      </div>
                      <div className="agent-document-paper-footer">
                        阅读分页 {pageNumber}
                      </div>
                    </div>
                  </div>
                )}
                {document.kind === "pptx" && active && currentSlide && (
                  <div className="agent-document-slide-layout">
                    <article
                      className="agent-document-slide"
                      style={{ zoom }}
                      data-document-section={active.id}
                      data-document-locator={active.id}
                    >
                      <h2>{currentSlide.title}</h2>
                      <div className="agent-document-slide-copy">
                        {currentSlide.body}
                      </div>
                      {active.rows.length > 0 && (
                        <DocumentTable section={active} />
                      )}
                      <span className="agent-document-slide-number">
                        {pageNumber}
                      </span>
                    </article>
                    {notesOpen && (
                      <section
                        className="agent-document-slide-notes"
                        ref={notes}
                        aria-label="演讲者备注"
                        data-document-locator={active.id}
                      >
                        <header>备注</header>
                        <div>
                          {currentSlide.notes || "此幻灯片没有演讲者备注。"}
                        </div>
                      </section>
                    )}
                  </div>
                )}
                {document.kind === "pdf" && active && (
                  <article
                    className="agent-document-pdf-page"
                    data-document-section={active.id}
                    data-document-locator={active.id}
                  >
                    <PdfPage
                      sessionId={sessionId}
                      path={filePath}
                      pageNumber={activeIndex + 1}
                      revision={document.revision}
                      zoom={zoom}
                      onNaturalWidth={setPdfNaturalWidth}
                    />
                    <details className="agent-document-extracted-text">
                      <summary>提取文字</summary>
                      {active.text ? (
                        <div className="agent-document-text">{active.text}</div>
                      ) : (
                        <p>此页未提取到文字；扫描图片中的文字无法直接选择。</p>
                      )}
                    </details>
                  </article>
                )}
              </div>
            )}
          </div>
          <footer className="agent-document-statusbar">
            <span className="agent-document-page-status">
              {document.kind === "docx"
                ? `阅读分页 ${pageNumber} / ${pageCount || 1}`
                : document.kind === "xlsx"
                  ? `工作表 ${activeIndex + 1} / ${document.sections.length}`
                  : document.kind === "pptx"
                    ? `幻灯片 ${pageNumber} / ${pageCount}`
                    : `第 ${pageNumber} 页，共 ${pageCount} 页`}
            </span>
            <span
              className="agent-document-current-location"
              title={location?.locator}
            >
              {document.kind === "xlsx"
                ? active?.label
                : `${characterCount.toLocaleString()} 字符`}
            </span>
            <span className="agent-document-view-status" aria-live="polite">
              {report.error ? (
                <>
                  <span title={report.error}>
                    当前位置同步失败：{report.error}
                  </span>
                  <button
                    type="button"
                    onClick={() => setReportAttempt((value) => value + 1)}
                  >
                    重试同步
                  </button>
                </>
              ) : (
                <span>
                  {report.pending
                    ? "正在同步当前位置…"
                    : selection
                      ? `已共享选中文字（${[...selection].length} 字）`
                      : "已共享当前位置"}
                </span>
              )}
            </span>
            <span className="agent-document-status-readonly">只读</span>
            <div className="agent-document-zoom">
              <button
                type="button"
                aria-label="缩小"
                disabled={zoom <= 0.2}
                onClick={() => changeZoom(zoom - 0.1)}
              >
                <Minus size={13} />
              </button>
              <input
                type="range"
                min="20"
                max="200"
                step="1"
                aria-label="文档缩放"
                value={Math.round(zoom * 100)}
                onChange={(event) =>
                  changeZoom(Number(event.target.value) / 100)
                }
              />
              <button
                type="button"
                aria-label="放大"
                disabled={zoom >= 2}
                onClick={() => changeZoom(zoom + 0.1)}
              >
                <Plus size={13} />
              </button>
              <output aria-label="当前缩放">{Math.round(zoom * 100)}%</output>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
