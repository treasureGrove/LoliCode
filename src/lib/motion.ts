/** Shared timing for desktop navigation. Seconds for Motion/WAAPI callers. */
export const motionTokens = {
  duration: { press: 0.12, feedback: 0.18, page: 0.24, panel: 0.32 },
  ease: [0.22, 1, 0.36, 1] as const,
  spring: { type: "spring", stiffness: 420, damping: 38, mass: 0.85 } as const,
};

export const motionEasing = "cubic-bezier(0.22, 1, 0.36, 1)";
