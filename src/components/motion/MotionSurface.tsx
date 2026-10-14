import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { useReducedMotion } from "framer-motion";
import { motionEasing, motionTokens } from "@/lib/motion";

interface MotionSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  motionKey: string;
}

/** Animate the live surface; never retain an old page or key a business form. */
export function MotionSurface({
  motionKey,
  children,
  ...props
}: MotionSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(motionKey);
  const animation = useRef<Animation>();
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || previous.current === motionKey) return;
    previous.current = motionKey;
    // Read the in-flight presentation before cancellation so rapid changes
    // redirect from the current position instead of replaying a fresh entrance.
    const current =
      animation.current?.playState === "running"
        ? getComputedStyle(element)
        : null;
    const from = current
      ? { transform: current.transform, opacity: current.opacity }
      : { transform: "translateY(8px)", opacity: "0.82" };
    animation.current?.cancel();
    if (reduced || !element.animate) return;
    animation.current = element.animate(
      [from, { transform: "none", opacity: "1" }],
      { duration: motionTokens.duration.page * 1000, easing: motionEasing },
    );
  }, [motionKey, reduced]);

  useLayoutEffect(() => {
    if (reduced) animation.current?.cancel();
    return () => animation.current?.cancel();
  }, [reduced]);

  return (
    <div ref={ref} {...props}>
      {children}
    </div>
  );
}
