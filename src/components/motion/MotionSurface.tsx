import {
  forwardRef,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type MutableRefObject,
} from "react";
import { useReducedMotion } from "framer-motion";
import { motionEasing, motionTokens } from "@/lib/motion";

interface MotionSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  motionKey: string;
  /** Keep embedded navigation stationary while its content changes. */
  targetSelector?: string;
  /** Optional navigation vector: +1 pushes from right, -1 pops from left, 0 glides vertically. */
  direction?: -1 | 0 | 1;
}

/** Animate the live surface; never retain an old page or key a business form. */
export const MotionSurface = forwardRef<HTMLDivElement, MotionSurfaceProps>(
  function MotionSurface(
    { motionKey, targetSelector, direction = 0, children, ...props },
    forwardedRef,
  ) {
    const internalRef = useRef<HTMLDivElement | null>(null);
    const previous = useRef(motionKey);
    const animation = useRef<Animation>();
    const reduced = useReducedMotion();

    useLayoutEffect(() => {
      const element = targetSelector
        ? internalRef.current?.querySelector<HTMLElement>(targetSelector)
        : internalRef.current;
      if (!element || previous.current === motionKey) return;
      previous.current = motionKey;
      // Read the in-flight presentation before cancellation so rapid changes
      // redirect from the current position instead of replaying a fresh entrance.
      const current =
        animation.current?.playState === "running"
          ? getComputedStyle(element)
          : null;
      const defaultFrom =
        direction !== 0
          ? {
              transform: `translate3d(${direction > 0 ? 12 : -12}px, 0, 0)`,
              opacity: "0.84",
            }
          : {
              transform: "translate3d(0, 6px, 0)",
              opacity: "0.86",
            };
      const from = current
        ? { transform: current.transform, opacity: current.opacity }
        : defaultFrom;
      animation.current?.cancel();
      if (reduced || !element.animate) return;
      animation.current = element.animate(
        [from, { transform: "none", opacity: "1" }],
        {
          duration: motionTokens.duration.page * 1000,
          easing: motionEasing,
        },
      );
    }, [direction, motionKey, reduced, targetSelector]);

    useLayoutEffect(() => {
      if (reduced) animation.current?.cancel();
      return () => animation.current?.cancel();
    }, [reduced]);

    return (
      <div
        ref={(node) => {
          internalRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef)
            (forwardedRef as MutableRefObject<HTMLDivElement | null>).current =
              node;
        }}
        {...props}
      >
        {children}
      </div>
    );
  },
);
