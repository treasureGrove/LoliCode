import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  X,
} from "lucide-react";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import {
  agentFilesApi,
  type AgentBrowserHistoryAction,
  type AgentBrowserPreviewBounds,
  type AgentBrowserPreviewPresentation,
  type AgentBrowserPreviewState,
} from "@/lib/api/agent-files";
import { settingsApi } from "@/lib/api/settings";
import { isWindows } from "@/lib/platform";
import { toast } from "@/lib/toast";
import {
  externalBrowserAddress,
  typedBrowserAddress,
} from "./agentBrowserAddress";
import "./agent-preview-atelier.css";

const PREVIEW_OVERLAY =
  "[aria-modal='true'], [role='dialog'], [role='menu'], [role='listbox'], [role='tooltip'], [data-radix-popper-content-wrapper]";

let presentationRevision = 0;

function nextPresentationRevision() {
  // Use one clock across browser panels, including renderer reloads.
  presentationRevision = Math.max(presentationRevision + 1, Date.now() * 1000);
  return presentationRevision;
}

function browserPreviewBounds(
  stage: HTMLElement,
): AgentBrowserPreviewBounds | null {
  if (
    document.hidden ||
    stage.closest("[hidden], [inert], [aria-hidden='true']")
  )
    return null;
  const modal = document.querySelector(
    "[aria-modal='true'], [role='dialog'][data-state='open']",
  );
  if (modal && !modal.contains(stage)) return null;
  const { left, top, right, bottom, width, height } =
    stage.getBoundingClientRect();
  if (
    width < 1 ||
    height < 1 ||
    left < 0 ||
    top < 0 ||
    right > window.innerWidth ||
    bottom > window.innerHeight
  )
    return null;
  // A native child is above the workbench's DOM. Hide it while a portal or
  // dialog covers its space so the workbench keeps the input focus.
  if (typeof document.elementFromPoint === "function") {
    for (const [x, y] of [
      [left + width / 2, top + height / 2],
      [left + 1, top + 1],
      [right - 1, top + 1],
      [left + 1, bottom - 1],
      [right - 1, bottom - 1],
    ]) {
      const topElement = document.elementFromPoint(x, y);
      if (topElement && !stage.contains(topElement)) return null;
    }
  }
  return { x: left, y: top, width, height };
}

function useNativeBrowserPreview(
  sessionId: string,
  browserId: string,
  enabled: boolean,
  slot: AgentBrowserPreviewPresentation["slot"],
) {
  const stage = useRef<HTMLDivElement>(null);
  const refresh = useRef<() => void>();
  const calls = useRef(Promise.resolve());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled || !stage.current) return;
    const target = stage.current;
    let active = true;
    let frame = 0;
    let latest: string | undefined;
    let reloadPending = false;
    let request:
      | { bounds: AgentBrowserPreviewBounds | null; reload: boolean }
      | undefined;
    let draining = false;
    setReady(false);
    setError(undefined);

    function send(bounds: AgentBrowserPreviewBounds | null, reload: boolean) {
      const presentation = { slot, revision: nextPresentationRevision() };
      const result = calls.current.then(() =>
        agentFilesApi.syncBrowserWebview(
          sessionId,
          browserId,
          bounds,
          reload,
          presentation,
        ),
      );
      calls.current = result.catch(() => {});
      return result;
    }

    async function drain() {
      if (draining) return;
      draining = true;
      while (active && request) {
        const next = request;
        request = undefined;
        try {
          await send(next.bounds, next.reload);
          if (active && next.bounds) {
            setReady(true);
            setError(undefined);
          }
        } catch (cause) {
          if (active && next.bounds) {
            setReady(false);
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }
      }
      draining = false;
    }

    function measure() {
      frame = 0;
      if (!active) return;
      const bounds = browserPreviewBounds(target);
      const key = JSON.stringify(bounds);
      const reload =
        Boolean(bounds) && (reloadPending || request?.reload === true);
      if (latest === key && !reload) return;
      latest = key;
      if (reload) reloadPending = false;
      request = { bounds, reload };
      void drain();
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure);
    }

    function onScroll(event: Event) {
      const source = event.target;
      if (
        source === document ||
        (source instanceof Element && source.contains(target))
      ) {
        schedule();
      }
    }

    function onVisibility() {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        measure();
      } else {
        schedule();
      }
    }

    refresh.current = () => {
      reloadPending = true;
      schedule();
    };
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    resize?.observe(target);
    const overlays = new MutationObserver((mutations) => {
      const affected = mutations.some(
        ({ target: node, addedNodes, removedNodes }) => {
          if (!(node instanceof Element)) return false;
          if (node.contains(target) || node.closest(PREVIEW_OVERLAY))
            return true;
          if (node.closest(".wb-chat")) return false;
          return [...addedNodes, ...removedNodes].some(
            (child) =>
              child instanceof Element &&
              (child.matches(PREVIEW_OVERLAY) ||
                child.querySelector(PREVIEW_OVERLAY)),
          );
        },
      );
      if (affected) schedule();
    });
    overlays.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "aria-hidden",
        "class",
        "data-state",
        "hidden",
        "inert",
        "open",
        "style",
      ],
    });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      active = false;
      refresh.current = undefined;
      cancelAnimationFrame(frame);
      resize?.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("visibilitychange", onVisibility);
      void send(null, false).catch(() => {});
    };
  }, [sessionId, browserId, enabled, slot]);

  return { stage, refresh, ready, error };
}

export function AgentBrowserPreviewPanel({
  sessionId,
  browserId = "",
  url = "",
  native: live = false,
  toolPage = false,
  width,
  onClose,
  onAddress,
  opening = false,
  openingError,
  restoreTitle,
  onRestore,
  slot = 0,
  visible = true,
}: {
  sessionId: string;
  browserId?: string;
  url?: string;
  native?: boolean;
  toolPage?: boolean;
  width?: number;
  onClose: () => void;
  onAddress?: (url: string) => Promise<boolean>;
  opening?: boolean;
  openingError?: string;
  restoreTitle?: string;
  onRestore?: () => void;
  slot?: AgentBrowserPreviewPresentation["slot"];
  visible?: boolean;
}) {
  const [browserState, setBrowserState] = useState<AgentBrowserPreviewState>();
  const [addressDraft, setAddressDraft] = useState<string>();
  const [addressError, setAddressError] = useState<string>();
  const showHistory = live && toolPage;
  useTauriEvent<AgentBrowserPreviewState>(
    "agent-browser-preview-state",
    (state) => {
      if (
        showHistory &&
        state.sessionId === sessionId &&
        state.browserId === browserId
      )
        setBrowserState(state);
    },
  );
  const native = useNativeBrowserPreview(
    sessionId,
    browserId,
    live && visible,
    slot,
  );
  const [frame, setFrame] = useState<string>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const state =
    browserState?.sessionId === sessionId &&
    browserState?.browserId === browserId
      ? browserState
      : undefined;
  const address = state?.url && state.url !== "about:blank" ? state.url : url;
  const external = toolPage ? externalBrowserAddress(address) : undefined;
  const expiredToolPage = !onAddress && toolPage && isWindows() && !live;
  const navigate = (action: AgentBrowserHistoryAction) => {
    void agentFilesApi
      .navigateBrowser(sessionId, browserId, action)
      .catch((cause) => toast.error(agentErrorMessage(cause)));
  };

  useEffect(() => {
    if (!visible || live || expiredToolPage || onAddress) return;
    let disposed = false;
    let inFlight = false;
    let timer: number | undefined;
    setError(undefined);

    async function refresh() {
      window.clearTimeout(timer);
      if (disposed || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const data = await agentFilesApi.browserFrame(sessionId, browserId);
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data)) {
          throw new Error("浏览器没有返回有效的 PNG 画面");
        }
        if (disposed) return;
        setFrame(data);
        timer = window.setTimeout(refresh, 1500);
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [
    sessionId,
    browserId,
    revision,
    visible,
    live,
    expiredToolPage,
    onAddress,
  ]);

  return (
    <aside
      className="wb-preview-panel wb-preview-panel--browser"
      hidden={!visible}
      aria-label="运行页面预览"
      style={{ width, flexBasis: width }}
    >
      <header className="wb-preview-header">
        <div className="wb-preview-heading">
          <span className="wb-preview-filename">
            {toolPage
              ? state?.title || restoreTitle || external?.hostname || "浏览器"
              : "运行预览"}
          </span>
          {onAddress ? (
            <form
              className="wb-browser-address-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (opening) return;
                const value = typedBrowserAddress(addressDraft ?? address);
                if (!value) {
                  setAddressError("请输入有效的 HTTP 或 HTTPS 网页地址。");
                  return;
                }
                setAddressError(undefined);
                void onAddress(value).then((opened) => {
                  if (opened)
                    setAddressDraft((draft) =>
                      draft === addressDraft ? undefined : draft,
                    );
                });
              }}
            >
              <input
                aria-label="网页地址"
                aria-invalid={Boolean(addressError || openingError)}
                autoFocus={visible && !address && !opening}
                className="wb-browser-preview-address"
                dir="ltr"
                onChange={(event) => {
                  setAddressDraft(event.currentTarget.value);
                  setAddressError(undefined);
                }}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && addressDraft !== undefined) {
                    event.preventDefault();
                    setAddressDraft(undefined);
                    setAddressError(undefined);
                  }
                }}
                placeholder="输入网页地址"
                spellCheck={false}
                title={address}
                value={addressDraft ?? address}
              />
              <button
                type="submit"
                aria-label="前往网页地址"
                title="前往"
                disabled={opening}
              >
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            </form>
          ) : toolPage ? (
            <input
              aria-label="网页地址"
              className="wb-browser-preview-address"
              dir="ltr"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              title={address}
              value={address}
            />
          ) : (
            <span className="wb-browser-preview-address" title={url}>
              {url}
            </span>
          )}
        </div>
        <div className="wb-preview-actions">
          {showHistory && (
            <>
              <button
                type="button"
                aria-label="后退"
                title="后退"
                disabled={!state?.canGoBack}
                onClick={() => navigate("back")}
              >
                <ChevronLeft size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="前进"
                title="前进"
                disabled={!state?.canGoForward}
                onClick={() => navigate("forward")}
              >
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </>
          )}
          {!expiredToolPage && (!onAddress || live) && (
            <button
              type="button"
              aria-label={live ? "重新加载网页" : "刷新页面画面"}
              title={live ? "重新加载网页" : "刷新页面画面"}
              onClick={() => {
                if (live) native.refresh.current?.();
                else setRevision((n) => n + 1);
              }}
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          )}
          {external && (
            <button
              type="button"
              aria-label="在系统浏览器中打开"
              title="在系统浏览器中打开"
              onClick={() => {
                void settingsApi
                  .openExternal(external.href)
                  .catch((cause) => toast.error(agentErrorMessage(cause)));
              }}
            >
              <ExternalLink size={15} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            aria-label="关闭页面预览"
            title="关闭页面预览"
            onClick={onClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>
      {(addressError || openingError) && (
        <p className="wb-preview-state" role="alert">
          {addressError ?? openingError}
        </p>
      )}
      {live ? (
        <div
          ref={native.stage}
          className="wb-browser-preview-stage"
          aria-busy={
            (!native.ready || state?.loading === true) && !native.error
          }
          data-preview-carrier="native"
          data-native-ready={native.ready}
        >
          {!native.ready && (
            <p
              className="wb-browser-preview-state"
              role={native.error ? "alert" : "status"}
            >
              {native.error ?? "正在打开网页…"}
            </p>
          )}
        </div>
      ) : onAddress ? (
        <div className="wb-browser-preview-stage" aria-busy={opening}>
          {onRestore && !opening ? (
            <div className="wb-dock-guide">
              <p>上次打开的网页</p>
              <button type="button" onClick={onRestore}>
                恢复页面
              </button>
            </div>
          ) : (
            <p className="wb-browser-preview-state">
              {opening ? "正在打开网页…" : "输入网址后按 Enter 打开网页。"}
            </p>
          )}
        </div>
      ) : expiredToolPage ? (
        <div className="wb-browser-preview-stage">
          <p className="wb-browser-preview-state" role="alert">
            此浏览器页面已失效，请让 Agent 重新打开。
          </p>
        </div>
      ) : (
        <div className="wb-browser-preview-stage">
          {frame && <img src={frame} alt="本机开发页面画面" />}
          {!frame && (
            <p
              className="wb-browser-preview-state"
              role={error ? "alert" : "status"}
            >
              {error ?? "正在读取浏览器画面…"}
            </p>
          )}
        </div>
      )}
      {!live && frame && error && (
        <p className="wb-preview-state" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
