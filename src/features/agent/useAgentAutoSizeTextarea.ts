import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** Starts at one line and grows with content; it never resizes the page itself. */
export function useAgentAutoSizeTextarea(value: string, maxHeight = 150) {
  const element = useRef<HTMLTextAreaElement | null>(null);
  const dispose = useRef<(() => void) | undefined>();
  const metrics = useRef<{ min: number; border: number } | null>(null);
  const resize = useCallback(() => {
    const node = element.current;
    if (!node) return;
    let cached = metrics.current;
    if (!cached) {
      const style = getComputedStyle(node);
      const number = (input: string) => Number.parseFloat(input) || 0;
      const line = number(style.lineHeight) || 22;
      const padding = number(style.paddingTop) + number(style.paddingBottom);
      const border =
        number(style.borderTopWidth) + number(style.borderBottomWidth);
      const min = Math.min(maxHeight, Math.max(36, line + padding + border));
      cached = { min, border };
      metrics.current = cached;
    }
    node.style.height = "0px";
    const desired = Math.max(cached.min, node.scrollHeight + cached.border);
    node.style.height = `${Math.min(maxHeight, desired)}px`;
    node.style.overflowY = desired > maxHeight ? "auto" : "hidden";
  }, [maxHeight]);
  const ref = useCallback(
    (node: HTMLTextAreaElement | null) => {
      dispose.current?.();
      dispose.current = undefined;
      element.current = node;
      metrics.current = null;
      if (!node) return;
      resize();
      let previousWidth = node.getBoundingClientRect().width;
      const invalidateAndResize = () => {
        metrics.current = null;
        resize();
      };
      const observer = new ResizeObserver(() => {
        const nextWidth = node.getBoundingClientRect().width;
        if (nextWidth !== previousWidth) {
          previousWidth = nextWidth;
          invalidateAndResize();
        }
      });
      observer.observe(node);
      window.addEventListener("resize", invalidateAndResize);
      dispose.current = () => {
        observer.disconnect();
        window.removeEventListener("resize", invalidateAndResize);
      };
    },
    [resize],
  );
  useLayoutEffect(resize, [value, resize]);
  useEffect(() => () => dispose.current?.(), []);
  return ref;
}
