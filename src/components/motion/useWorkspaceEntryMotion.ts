import { useLayoutEffect, useRef, type RefObject } from "react";
import { motionEasing, motionTokens } from "@/lib/motion";

/** The new view is already interactive when its entry motion starts. */
export function useWorkspaceEntryMotion(
  surface: RefObject<HTMLElement>,
  key: string | null,
  targetSelector?: string,
) {
  const previousKey = useRef(key);
  useLayoutEffect(() => {
    const changed = previousKey.current !== key;
    previousKey.current = key;
    if (!changed || !key) return;
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    if (reducedMotion?.matches) return;
    const element = targetSelector
      ? surface.current?.querySelector<HTMLElement>(targetSelector)
      : surface.current;
    if (!element?.animate) return;
    // The viewport keeps its opaque theme. Leave the pane's geometry intact,
    // including native preview bounds, while the foreground comes into view.
    const frames = targetSelector
      ? [{ opacity: 0.94 }, { opacity: 1 }]
      : [
          { translate: "0 -3px", opacity: 0.88 },
          { translate: "none", opacity: 1 },
        ];
    const animation = element.animate(frames, {
      id: targetSelector
        ? "lolicode-workspace-enter"
        : "lolicode-transcript-enter",
      duration: motionTokens.duration.feedback * 1000,
      easing: motionEasing,
    });
    const finishIfReduced = (event: MediaQueryListEvent) => {
      if (event.matches) animation.finish();
    };
    reducedMotion?.addEventListener("change", finishIfReduced);
    return () => {
      reducedMotion?.removeEventListener("change", finishIfReduced);
      animation.cancel();
    };
  }, [key, surface, targetSelector]);
}
