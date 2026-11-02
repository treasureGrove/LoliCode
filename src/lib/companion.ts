export interface CompanionState {
  satiety: number;
  mood: number;
  affection: number;
  feedCount: number;
  updatedAt: number;
  lastFedAt: number;
  lastPettedAt: number;
  sleeping: boolean;
  position: { x: number; y: number } | null;
}

export const COMPANION_STORAGE_KEY = "lolicode.companion.v1";
export const FEED_COOLDOWN_MS = 30_000;
const PET_COOLDOWN_MS = 5_000;
const HOUR_MS = 3_600_000;
const MAX_ELAPSED_MS = 6 * HOUR_MS;
let memoryFallback: string | null = null;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function bounded(value: unknown, fallback: number, max = 100): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, 0, max)
    : fallback;
}

function clock(now: number) {
  return bounded(now, Date.now(), Number.MAX_SAFE_INTEGER);
}

function normalize(value: unknown, now: number): CompanionState {
  const saved =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const position = saved.position as Record<string, unknown> | null;
  return {
    satiety: bounded(saved.satiety, 72),
    mood: bounded(saved.mood, 80),
    affection: Math.floor(bounded(saved.affection, 0, 999_999)),
    feedCount: Math.floor(bounded(saved.feedCount, 0, 999_999)),
    updatedAt: bounded(saved.updatedAt, now, Number.MAX_SAFE_INTEGER),
    lastFedAt: bounded(saved.lastFedAt, 0, Number.MAX_SAFE_INTEGER),
    lastPettedAt: bounded(saved.lastPettedAt, 0, Number.MAX_SAFE_INTEGER),
    sleeping: saved.sleeping === true,
    position:
      position &&
      typeof position.x === "number" &&
      Number.isFinite(position.x) &&
      typeof position.y === "number" &&
      Number.isFinite(position.y)
        ? { x: Math.max(0, position.x), y: Math.max(0, position.y) }
        : null,
  };
}

/** Keep fractional changes so frequent UI refreshes do not stop the clock. */
export function advanceCompanionState(
  state: CompanionState,
  now = Date.now(),
): CompanionState {
  const time = clock(now);
  const current = normalize(state, time);
  if (time <= current.updatedAt) return current;
  // Returning after a long absence should not leave her starving or unhappy.
  const hours = Math.min(time - current.updatedAt, MAX_ELAPSED_MS) / HOUR_MS;
  return {
    ...current,
    satiety: clamp(
      current.satiety - hours * (current.sleeping ? 1 : 4),
      0,
      100,
    ),
    mood: clamp(current.mood + hours * (current.sleeping ? 4 : -2), 0, 100),
    updatedAt: time,
  };
}

export function readCompanionState(now = Date.now()): CompanionState {
  const time = clock(now);
  let raw = memoryFallback;
  if (raw === null) {
    try {
      raw = window.localStorage.getItem(COMPANION_STORAGE_KEY);
    } catch {
      // A disabled or full browser store must not prevent opening the app.
    }
  }
  let saved: unknown;
  try {
    saved = JSON.parse(raw || "null");
  } catch {
    saved = null;
  }
  return advanceCompanionState(normalize(saved, time), time);
}

export function saveCompanionState(state: CompanionState): void {
  const raw = JSON.stringify(normalize(state, clock(Date.now())));
  try {
    window.localStorage.setItem(COMPANION_STORAGE_KEY, raw);
    memoryFallback = null;
  } catch {
    memoryFallback = raw;
  }
}

export function interactWithCompanion(
  state: CompanionState,
  action: "feed" | "pet" | "sleep" | "wake",
  now = Date.now(),
): CompanionState {
  const time = clock(now);
  const current = advanceCompanionState(state, time);
  // Do not turn a backward system-clock adjustment into a cooldown bypass.
  if (time < current.updatedAt) return current;
  if (action === "sleep" || action === "wake") {
    return { ...current, sleeping: action === "sleep" };
  }
  if (action === "feed") {
    if (current.lastFedAt > 0 && time - current.lastFedAt < FEED_COOLDOWN_MS)
      return current;
    return {
      ...current,
      satiety: clamp(current.satiety + 18, 0, 100),
      mood: clamp(current.mood + 10, 0, 100),
      affection: Math.min(current.affection + 2, 999_999),
      feedCount: Math.min(current.feedCount + 1, 999_999),
      lastFedAt: Math.max(1, time),
      sleeping: false,
    };
  }
  if (current.lastPettedAt > 0 && time - current.lastPettedAt < PET_COOLDOWN_MS)
    return { ...current, sleeping: false };
  return {
    ...current,
    mood: clamp(current.mood + 4, 0, 100),
    affection: Math.min(current.affection + 1, 999_999),
    lastPettedAt: Math.max(1, time),
    sleeping: false,
  };
}
