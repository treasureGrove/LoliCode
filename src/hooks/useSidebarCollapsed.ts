import { useCallback, useEffect, useState, type RefObject } from "react";
import { isMac } from "@/lib/platform";

/** A manual choice takes precedence over the compact-window default. */
export const SIDEBAR_AUTO_COLLAPSE_WIDTH = 960;
const STORAGE_KEY = "cc-switch-sidebar-collapsed";
export const SIDEBAR_EXPANDED_WIDTH = 216;
export const sidebarRailWidth = () => (isMac() ? 84 : 72);
export const sidebarWidth = (collapsed: boolean) =>
  collapsed ? sidebarRailWidth() : SIDEBAR_EXPANDED_WIDTH;

function readManualPreference(): boolean | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch {
    /* Window sizing still works when storage is unavailable. */
  }
  return null;
}

function isNarrowWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    window.innerWidth < SIDEBAR_AUTO_COLLAPSE_WIDTH
  );
}

/**
 * Width uses one interruptible CSS transition, with no document-wide covers,
 * stacking changes or detached animations surviving a navigation/unmount.
 */
export function useSidebarCollapsed(_navRef: RefObject<HTMLElement | null>) {
  const [manual, setManual] = useState<boolean | null>(readManualPreference);
  const [narrow, setNarrow] = useState(isNarrowWindow);
  const collapsed = manual ?? narrow;

  useEffect(() => {
    const onResize = () => setNarrow(isNarrowWindow());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const toggle = useCallback(() => {
    // Functional updates retain the latest intent even when React batches rapid input.
    setManual((previous) => {
      const next = !(previous ?? narrow);
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        /* Optional persistence. */
      }
      return next;
    });
  }, [narrow]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "\\" &&
        !event.repeat
      ) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  return { collapsed, toggle };
}
