import type { CompanionMotion } from "./CompanionActor";

const clamp = (value: number, low = 0, high = 1) =>
  Math.min(high, Math.max(low, value));

export function rigSmoothstep(low: number, high: number, value: number) {
  const x = clamp((value - low) / (high - low));
  return x * x * (3 - 2 * x);
}

export interface CompanionRigBlend {
  drag: number;
  pet: number;
  feed: number;
  sleep: number;
}

export const EMPTY_RIG_BLEND: CompanionRigBlend = {
  drag: 0,
  pet: 0,
  feed: 0,
  sleep: 0,
};

/** Limit resumed/slow frames, so a hidden page never leaps through an action. */
export function rigFrameDelta(now: number, previous: number | null) {
  return previous === null || !Number.isFinite(now - previous)
    ? 0
    : clamp(now - previous, 0, 50);
}

export function advanceRigBlend(
  previous: CompanionRigBlend,
  motion: CompanionMotion,
  deltaMs: number,
): CompanionRigBlend {
  const amount = -Math.expm1(-clamp(deltaMs, 0, 50) / 100);
  const blend = { ...previous };
  for (const key of ["drag", "pet", "feed", "sleep"] as const) {
    blend[key] += (Number(motion === key) - blend[key]) * amount;
  }
  return blend;
}

const BITE_TIMES = [1000, 1500, 2000];

export function sampleRigFeeding(ageMs: number) {
  const age = Math.max(0, ageMs);
  const bite = BITE_TIMES.reduce(
    (total, time) => total + rigSmoothstep(time, time + 120, age) / 3,
    0,
  );
  const latestBite = BITE_TIMES.filter((time) => time <= age).at(-1);
  const crumbAge = latestBite === undefined ? -1 : age - latestBite;
  return {
    visible: ageMs >= 100 && age < 2250 && bite < 0.995,
    approach: rigSmoothstep(150, 900, age),
    opacity: rigSmoothstep(100, 280, age),
    bite,
    chew: BITE_TIMES.reduce((total, time) => {
      const p = clamp((age - time) / 320);
      return total + Math.sin(p * Math.PI) ** 2;
    }, 0),
    crumbProgress: crumbAge >= 0 && crumbAge < 320 ? crumbAge / 320 : -1,
  };
}

export interface CompanionRigPose {
  time: number;
  breath: number;
  headAngle: number;
  headX: number;
  headY: number;
  hairSway: number;
  earFlop: number;
  tailWag: number;
  drag: number;
  lift: number;
  eyeClosed: number;
}

export function sampleCompanionRigPose(
  timeMs: number,
  actionAgeMs: number,
  motion: CompanionMotion,
  blend: CompanionRigBlend,
  settleAgeMs = Infinity,
): CompanionRigPose {
  const t = timeMs / 1000;
  const petProgress = clamp(actionAgeMs / 1800);
  const pet =
    motion === "pet" ? Math.sin(Math.PI * petProgress) * blend.pet : 0;
  const feeding = motion === "feed" ? sampleRigFeeding(actionAgeMs) : null;
  const blinkPhase = ((timeMs % 5900) + 5900) % 5900;
  const blink =
    rigSmoothstep(4200, 4270, blinkPhase) *
    (1 - rigSmoothstep(4320, 4420, blinkPhase));
  const petEyes =
    motion === "pet"
      ? rigSmoothstep(100, 350, actionAgeMs) *
        (1 - rigSmoothstep(1280, 1660, actionAgeMs))
      : 0;
  const feedEyes =
    motion === "feed"
      ? rigSmoothstep(1440, 1560, actionAgeMs) *
        (1 - rigSmoothstep(1950, 2150, actionAgeMs))
      : 0;
  const landing =
    Number.isFinite(settleAgeMs) && settleAgeMs >= 0
      ? 0.007 * Math.sin(settleAgeMs / 75) * Math.exp(-settleAgeMs / 160)
      : 0;
  return {
    time: t,
    breath: (0.5 + 0.5 * Math.sin(t * 1.8)) * (1 - 0.35 * blend.sleep),
    headAngle:
      0.0045 * Math.sin(t * 0.8) -
      pet * 0.013 +
      blend.drag * 0.014 * Math.sin(t * 3.1),
    headX: 0.0015 * Math.sin(t * 0.7),
    headY: pet * 0.002 + (feeding?.chew ?? 0) * 0.002,
    hairSway:
      0.0032 * Math.sin(t * 1.2 - 0.7) +
      blend.drag * 0.004 * Math.sin(t * 3.1 - 0.8),
    earFlop:
      0.009 * Math.sin(t * 1.4 - 0.4) +
      pet * 0.021 * Math.sin(t * 4) +
      blend.drag * 0.015 * Math.sin(t * 3.1 - 0.4),
    tailWag:
      0.017 * Math.sin(t * 1.8) +
      blend.feed * 0.028 * Math.sin(t * 7) +
      pet * 0.03 * Math.sin(t * 6),
    drag: blend.drag,
    lift: -0.008 * blend.drag + landing,
    eyeClosed: Math.max(blink, petEyes, feedEyes, blend.sleep),
  };
}

function ellipse(
  x: number,
  y: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
) {
  return 1 - rigSmoothstep(0.35, 1, Math.hypot((x - cx) / rx, (y - cy) / ry));
}

/** Source coordinates are normalized and retain the original illustration. */
export function deformCompanionRigPoint(
  u: number,
  v: number,
  pose: CompanionRigPose,
): [number, number] {
  // Fixed boots while standing. Dragging and the short landing response are
  // whole-character motions; all other changes fade out above the boots.
  const standingWeight = 1 - rigSmoothstep(0.74, 0.94, v);
  let x = u + 0.0011 * Math.sin(pose.time * 0.85) * standingWeight;
  let y = v - 0.0033 * pose.breath * standingWeight;
  const headWeight = 1 - rigSmoothstep(0.44, 0.59, v);
  const hx = u - 0.51;
  const hy = v - 0.445;
  x +=
    (hx * (Math.cos(pose.headAngle) - 1) -
      hy * Math.sin(pose.headAngle) +
      pose.headX) *
    headWeight;
  y +=
    (hx * Math.sin(pose.headAngle) +
      hy * (Math.cos(pose.headAngle) - 1) +
      pose.headY) *
    headWeight;

  // Side locks and curls move outside the face; no independent eye/face warp.
  const sideHair =
    (1 - rigSmoothstep(0.25, 0.39, u) + rigSmoothstep(0.66, 0.82, u)) *
    rigSmoothstep(0.29, 0.45, v) *
    (1 - rigSmoothstep(0.69, 0.83, v));
  x += pose.hairSway * sideHair;
  y += 0.0012 * Math.cos(pose.time * 1.2) * sideHair;

  const leftEar = ellipse(u, v, 0.22, 0.255, 0.115, 0.17);
  const rightEar = ellipse(u, v, 0.62, 0.145, 0.16, 0.12);
  x += -(v - 0.17) * pose.earFlop * leftEar;
  y += (u - 0.29) * pose.earFlop * leftEar;
  x += (v - 0.09) * pose.earFlop * rightEar;
  y -= (u - 0.51) * pose.earFlop * rightEar;

  const tail = ellipse(u, v, 0.205, 0.685, 0.15, 0.13);
  x -= (v - 0.72) * pose.tailWag * tail;
  y += (u - 0.33) * pose.tailWag * tail;
  y += pose.lift;
  return [x, y];
}
