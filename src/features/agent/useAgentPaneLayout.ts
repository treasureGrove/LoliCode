import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AgentPaneResizeHandleProps } from "./AgentPaneResizeHandle";

const SIDEBAR_KEY = "lolicode.agent.layout.sidebarWidth";
const PREVIEW_KEY = "lolicode.agent.layout.previewWidth";
const HANDLE_WIDTH = 8;
const COMPACT_SIDEBAR_WIDTH = 72;
const MIN_SIDEBAR_WIDTH = 240;
const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.max(min, Math.min(max, value)));
const readWidth = (key: string, fallback: number) => {
  try {
    const raw = localStorage.getItem(key);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};
const saveWidth = (key: string, value: number) => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* Layout remains usable when persistence is unavailable. */
  }
};

export function computeAgentPaneLayout({
  width,
  sidebarVisible,
  sidebarCompact = false,
  sidebarAutoCompact = false,
  previewVisible,
  sidebarPreferred,
  previewPreferred,
}: {
  width: number;
  sidebarVisible: boolean;
  sidebarCompact?: boolean;
  sidebarAutoCompact?: boolean;
  previewVisible: boolean;
  sidebarPreferred: number;
  previewPreferred: number;
}) {
  const available = Number.isFinite(width) && width > 0 ? width : 1024;
  const chatMinimum = Math.min(360, Math.max(120, available * 0.55));
  const previewMinimum = Math.max(
    0,
    Math.min(260, available - chatMinimum - HANDLE_WIDTH),
  );
  // On narrow windows, keep both the chat and an open preview usable. Closing
  // the preview restores the user's sidebar visibility without changing it.
  const sidebarBudget =
    available -
    chatMinimum -
    (previewVisible ? previewMinimum + HANDLE_WIDTH : 0);
  const sidebarCanOpen = sidebarBudget >= MIN_SIDEBAR_WIDTH + HANDLE_WIDTH;
  const compact = sidebarCompact || (sidebarAutoCompact && !sidebarCanOpen);
  const sidebarMinimum = compact ? COMPACT_SIDEBAR_WIDTH : MIN_SIDEBAR_WIDTH;
  const showSidebar =
    sidebarVisible &&
    (compact ? sidebarBudget >= COMPACT_SIDEBAR_WIDTH : sidebarCanOpen);
  const handles =
    (Number(showSidebar && !compact) + Number(previewVisible)) * HANDLE_WIDTH;
  const sidebarMin = showSidebar ? sidebarMinimum : 0;
  const sidebarMax =
    showSidebar && !compact
      ? Math.min(420, sidebarBudget - HANDLE_WIDTH)
      : sidebarMin;
  const sidebarWidth = showSidebar
    ? clamp(sidebarPreferred, sidebarMin, sidebarMax)
    : 0;
  const previewMax = previewVisible
    ? Math.max(
        previewMinimum,
        Math.min(960, available - chatMinimum - sidebarWidth - handles),
      )
    : 0;
  const previewWidth = previewVisible
    ? clamp(previewPreferred, previewMinimum, previewMax)
    : 0;
  return {
    sidebarCanOpen,
    sidebarCompact: compact,
    sidebarVisible: showSidebar,
    sidebarWidth,
    previewWidth,
    sidebarMin,
    sidebarMax,
    previewMin: previewVisible ? previewMinimum : 0,
    previewMax,
    chatMinimum,
  };
}

export function useAgentPaneLayout({
  isActive = true,
  sidebarVisible,
  sidebarCompact,
  sidebarAutoCompact,
  previewVisible,
}: {
  isActive?: boolean;
  sidebarVisible: boolean;
  sidebarCompact?: boolean;
  sidebarAutoCompact?: boolean;
  previewVisible: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => window.innerWidth || 1024);
  const [sidebarPreferred, setSidebar] = useState(() =>
    readWidth(SIDEBAR_KEY, 252),
  );
  const [previewPreferred, setPreview] = useState(() =>
    readWidth(PREVIEW_KEY, 420),
  );
  useLayoutEffect(() => {
    if (!isActive) return;
    setSidebar((previous) => readWidth(SIDEBAR_KEY, previous));
    const container = containerRef.current;
    const measureViewport = () => setWidth(window.innerWidth || 1024);
    measureViewport();
    // The observed size is already available after layout. Reading the DOM
    // synchronously here used to force the whole retained page to lay out.
    const observer = new ResizeObserver(([entry]) => {
      if (entry?.contentRect.width) setWidth(entry.contentRect.width);
    });
    if (container) observer.observe(container);
    window.addEventListener("resize", measureViewport);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureViewport);
    };
  }, [isActive]);
  const changeSidebar = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    setSidebar(clamp(next, MIN_SIDEBAR_WIDTH, 420));
  }, []);
  const changePreview = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    setPreview(clamp(next, 140, 960));
  }, []);
  const layout = computeAgentPaneLayout({
    width,
    sidebarVisible,
    sidebarCompact,
    sidebarAutoCompact,
    previewVisible,
    sidebarPreferred,
    previewPreferred,
  });
  const sidebarHandleProps: AgentPaneResizeHandleProps = {
    label: "调整项目侧栏宽度",
    width: layout.sidebarWidth,
    minWidth: layout.sidebarMin,
    maxWidth: layout.sidebarMax,
    growthDirection: 1,
    onWidthChange: changeSidebar,
    onWidthCommit: (value) => saveWidth(SIDEBAR_KEY, value),
  };
  const previewHandleProps: AgentPaneResizeHandleProps = {
    label: "调整预览宽度",
    width: layout.previewWidth,
    minWidth: layout.previewMin,
    maxWidth: layout.previewMax,
    growthDirection: -1,
    onWidthChange: changePreview,
    onWidthCommit: (value) => saveWidth(PREVIEW_KEY, value),
  };
  return { ...layout, containerRef, sidebarHandleProps, previewHandleProps };
}
