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
    // Keep the themed surface opaque. Only the transcript, which sits on that
    // surface, can fade in slightly as its text settles into place.
    const frames = targetSelector
      ? [{ translate: "0 4px" }, { translate: "none" }]
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
