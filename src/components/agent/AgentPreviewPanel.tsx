import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ExternalLink,
  File,
  FolderOpen,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { agentFilesApi, type AgentFilePreview } from "@/lib/api/agent-files";
import { SessionCodeBlock } from "@/components/sessions/reader/SessionCodeBlock";
import "./agent-preview-atelier.css";

const STATIC_TAGS = new Set(
  "a abbr address article aside b blockquote br button caption center code col colgroup dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img input label legend li main mark nav ol p pre s section small span strong style sub summary sup table tbody td textarea tfoot th thead tr u ul".split(
    " ",
  ),
);
const DROP_TAGS = new Set(
  "script iframe frame frameset object embed base meta link noscript template svg math applet portal video audio source track".split(
    " ",
  ),
);
const cleanCss = (value: string) =>
  value
    .replace(/@import[^;]*(?:;|$)/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none");

/** Parse in an inert template; build a static allowlisted tree before framing. */
export const isolatedAgentHtml = (content: string) => {
  const template = document.createElement("template");
  template.innerHTML = content;
  const output = document.createElement("div");
  const append = (node: Node, parent: HTMLElement) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.append(document.createTextNode(node.textContent || ""));
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) return;
    if (!STATIC_TAGS.has(tag)) {
      for (const child of node.childNodes) append(child, parent);
      return;
    }
    const clean = document.createElement(tag);
    for (const attr of node.attributes) {
      const name = attr.name.toLowerCase();
      if (
        [
          "class",
          "id",
          "title",
          "alt",
          "width",
          "height",
          "colspan",
          "rowspan",
          "role",
          "value",
          "placeholder",
          "open",
        ].includes(name) ||
        name.startsWith("aria-")
      )
        clean.setAttribute(name, attr.value);
      if (name === "style") clean.setAttribute("style", cleanCss(attr.value));
      if (
        tag === "img" &&
        name === "src" &&
        /^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,[a-z\d+/=\s]+$/i.test(
          attr.value,
        )
      )
        clean.setAttribute("src", attr.value);
    }
    if (tag === "button") clean.setAttribute("type", "button");
    if (tag === "input" || tag === "textarea" || tag === "button")
      clean.setAttribute("disabled", "");
    if (tag === "style") clean.textContent = cleanCss(node.textContent || "");
    else for (const child of node.childNodes) append(child, clean);
    parent.append(clean);
  };
  for (const node of template.content.childNodes) append(node, output);
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"></head><body>${output.innerHTML}</body></html>`;
};

export function AgentPreviewPanel({
  sessionId,
  path,
  onClose,
  width,
}: {
  sessionId: string;
  path: string;
  onClose: () => void;
  width?: number;
}) {
  const [preview, setPreview] = useState<AgentFilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [requestedPath, setRequestedPath] = useState(path);
  const [draft, setDraft] = useState(path);
  const [view, setView] = useState<"preview" | "source">("preview");
  const staticHtml = useMemo(
    () =>
      preview?.kind === "html" ? isolatedAgentHtml(preview.content || "") : "",
    [preview?.kind, preview?.content],
  );
  useEffect(() => {
    let disposed = false;
    setPreview(null);
    setError(null);
    if (!requestedPath) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void agentFilesApi
      .preview(sessionId, requestedPath)
      .then(
        (result) => {
          if (!disposed) setPreview(result);
        },
        (cause) => {
          if (!disposed)
            setError(cause instanceof Error ? cause.message : String(cause));
        },
      )
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, requestedPath, revision]);
  const open = async (action: "file" | "directory") => {
    try {
      await agentFilesApi.open(sessionId, requestedPath, action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <aside
      className="wb-preview-panel"
      aria-label="文件预览"
      style={width === undefined ? undefined : { width, flexBasis: width }}
    >
      <header className="wb-preview-header">
        <div className="wb-preview-heading">
          <span className="wb-preview-eyebrow">作品检视</span>
          <span className="wb-preview-filename" title={requestedPath}>
            {preview?.name ||
              requestedPath.split(/[\\/]/).pop() ||
              "项目文件预览"}
          </span>
        </div>
        <div className="wb-preview-actions">
          <button
            type="button"
            aria-label="打开预览文件"
            title="在默认应用中打开"
            disabled={!requestedPath}
            onClick={() => void open("file")}
          >
            <ExternalLink size={15} />
          </button>
          <button
            type="button"
            aria-label="打开预览所在文件夹"
            title="打开所在文件夹"
            disabled={!requestedPath}
            onClick={() => void open("directory")}
          >
            <FolderOpen size={15} />
          </button>
          <button
            type="button"
            aria-label="重新读取预览"
            title="重新读取预览"
            disabled={loading}
            onClick={() => setRevision((old) => old + 1)}
          >
            <RefreshCw
              size={15}
              className={loading ? "animate-spin" : undefined}
            />
          </button>
          <button
            type="button"
            aria-label="关闭预览"
            title="关闭预览"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <form
        className="wb-preview-path-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) setRequestedPath(draft.trim());
        }}
      >
        <File size={13} aria-hidden="true" />
        <input
          aria-label="预览文件路径"
          placeholder="输入项目内文件路径…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>
          预览
        </button>
      </form>
      <div className="wb-preview-toolbar">
        {preview?.kind === "html" && (
          <div className="wb-preview-view-switch" aria-label="预览显示方式">
            <button
              type="button"
              aria-pressed={view === "preview"}
              onClick={() => setView("preview")}
            >
              静态预览
            </button>
            <button
              type="button"
              aria-pressed={view === "source"}
              onClick={() => setView("source")}
            >
              源码
            </button>
          </div>
        )}
        <details className="wb-preview-isolation">
          <summary>
            <ShieldCheck size={12} aria-hidden="true" />
            隔离预览
            <ChevronDown size={11} aria-hidden="true" />
          </summary>
          <p className="wb-preview-note">
            静态预览不执行脚本或加载外部依赖；交互页面可打开文件在浏览器中运行。
          </p>
        </details>
      </div>
      {loading && (
        <p role="status" className="wb-preview-note wb-preview-state">
          <Loader2 className="inline animate-spin" size={14} /> 正在读取文件…
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="wb-preview-note wb-preview-state text-danger-text"
        >
          {error}
        </p>
      )}
      {preview && (
        <div
          className="wb-preview-content"
          data-kind={preview.kind}
          data-view={view}
        >
          {preview.truncated && (
            <p role="status" className="wb-preview-note">
              文件较大，当前仅显示部分内容。
            </p>
          )}
          {preview.kind === "html" && view === "preview" ? (
            <iframe
              title={`HTML 预览：${preview.name}`}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={staticHtml}
            />
          ) : preview.kind === "image" ? (
            /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|svg\+xml);base64,/i.test(
              preview.dataUrl || "",
            ) ? (
              <img src={preview.dataUrl} alt={preview.name} />
            ) : (
              <p role="alert">图片数据无法显示。</p>
            )
          ) : (
            <SessionCodeBlock
              className="wb-preview-source"
              code={preview.content || ""}
            />
          )}
        </div>
      )}
    </aside>
  );
}
