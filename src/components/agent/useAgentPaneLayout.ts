import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentPaneResizeHandleProps } from "./AgentPaneResizeHandle";

const SIDEBAR_KEY = "lolicode.agent.layout.sidebarWidth";
const PREVIEW_KEY = "lolicode.agent.layout.previewWidth";
const HANDLE_WIDTH = 8;
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
  previewVisible,
  sidebarPreferred,
  previewPreferred,
}: {
  width: number;
  sidebarVisible: boolean;
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
  const showSidebar =
    sidebarVisible &&
    available >=
      chatMinimum +
        160 +
        (previewVisible ? previewMinimum + HANDLE_WIDTH : 0) +
        HANDLE_WIDTH;
  const handles = (Number(showSidebar) + Number(previewVisible)) * HANDLE_WIDTH;
  const sidebarMax = showSidebar
    ? Math.max(
        160,
        Math.min(
          420,
          available -
            chatMinimum -
            (previewVisible ? previewMinimum : 0) -
            handles,
        ),
      )
    : 0;
  const sidebarWidth = showSidebar
    ? clamp(sidebarPreferred, 160, sidebarMax)
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
    sidebarVisible: showSidebar,
    sidebarWidth,
    previewWidth,
    sidebarMin: showSidebar ? 160 : 0,
    sidebarMax,
    previewMin: previewVisible ? previewMinimum : 0,
    previewMax,
    chatMinimum,
  };
}

export function useAgentPaneLayout({
  sidebarVisible,
  previewVisible,
}: {
  sidebarVisible: boolean;
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
  useEffect(() => {
    const container = containerRef.current;
    const measure = () =>
      setWidth(
        container?.getBoundingClientRect().width || window.innerWidth || 1024,
      );
    measure();
    const observer = new ResizeObserver(measure);
    if (container) observer.observe(container);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const changeSidebar = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    const value = clamp(next, 160, 420);
    setSidebar(value);
    saveWidth(SIDEBAR_KEY, value);
  }, []);
  const changePreview = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    const value = clamp(next, 140, 960);
    setPreview(value);
    saveWidth(PREVIEW_KEY, value);
  }, []);
  const layout = computeAgentPaneLayout({
    width,
    sidebarVisible,
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
  };
  const previewHandleProps: AgentPaneResizeHandleProps = {
    label: "调整预览宽度",
    width: layout.previewWidth,
    minWidth: layout.previewMin,
    maxWidth: layout.previewMax,
    growthDirection: -1,
    onWidthChange: changePreview,
  };
  return { ...layout, containerRef, sidebarHandleProps, previewHandleProps };
}
