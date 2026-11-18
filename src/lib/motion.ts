import { useEffect, useRef } from "react";

/** Shared timing for desktop navigation. Seconds for Motion/WAAPI callers. */
export const motionTokens = {
  duration: { press: 0.08, feedback: 0.16, page: 0.22, panel: 0.28 },
  ease: [0.32, 0.72, 0, 1] as const,
  spring: { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const,
  segment: { duration: 0.2, ease: [0.32, 0.72, 0, 1] as const },
  gentleSpring: {
    type: "spring",
    stiffness: 320,
    damping: 32,
    mass: 0.9,
  } as const,
};

export const motionEasing = "cubic-bezier(0.32, 0.72, 0, 1)";

/** Computes directional vector (-1 left/back, +1 right/forward) when active view index changes. */
export function useNavigationDirection(rank: number, key: string): -1 | 0 | 1 {
  const prev = useRef({ rank, key });
  const dir: -1 | 0 | 1 =
    prev.current.key === key
      ? 0
      : rank > prev.current.rank
        ? 1
        : rank < prev.current.rank
          ? -1
          : 0;
  useEffect(() => {
    prev.current = { rank, key };
  }, [rank, key]);
  return dir;
}

/** Compositor-only opacity + micro-translate reveal on newly mounted drawers (avoids layout reflow). */
export function animateHeightReveal(
  element: HTMLElement | null,
  options?: { durationMs?: number; offsetY?: number },
): (() => void) | undefined {
  if (
    !element ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    !element.animate
  ) {
    return undefined;
  }
  const anim = element.animate(
    [
      {
        opacity: 0.45,
        transform: `translate3d(0, ${options?.offsetY ?? -4}px, 0)`,
      },
      { opacity: 1, transform: "none" },
    ],
    {
      duration: Math.min(options?.durationMs ?? 170, 190),
      easing: motionEasing,
    },
  );
  return () => anim.cancel();
}
