import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceCompanionState,
  COMPANION_STORAGE_KEY,
  FEED_COOLDOWN_MS,
  interactWithCompanion,
  readCompanionState,
  saveCompanionState,
} from "@/lib/companion";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.removeItem(COMPANION_STORAGE_KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
  // A successful save also clears the in-memory storage fallback.
  saveCompanionState(readCompanionState());
  localStorage.removeItem(COMPANION_STORAGE_KEY);
  vi.useRealTimers();
});

describe("companion care", () => {
  it("recovers damaged or non-object storage without blocking the app", () => {
    for (const raw of ["{broken", "null", "42", "[]"]) {
      localStorage.setItem(COMPANION_STORAGE_KEY, raw);
      expect(readCompanionState()).toMatchObject({
        satiety: 72,
        mood: 80,
        feedCount: 0,
        sleeping: false,
        position: null,
        updatedAt: NOW,
      });
    }
    localStorage.setItem(
      COMPANION_STORAGE_KEY,
      JSON.stringify({
        satiety: -30,
        mood: "happy",
        affection: 1e20,
        feedCount: -9,
        updatedAt: "yesterday",
        position: { x: 1e500, y: 20 },
      }),
    );
    expect(readCompanionState()).toMatchObject({
      satiety: 0,
      mood: 80,
      affection: 999_999,
      feedCount: 0,
      position: null,
      updatedAt: NOW,
    });
  });

  it("enforces feeding cooldown after saving and reopening", () => {
    const fed = interactWithCompanion(readCompanionState(), "feed");
    expect(fed).toMatchObject({
      satiety: 90,
      mood: 90,
      affection: 2,
      feedCount: 1,
      lastFedAt: NOW,
    });
    saveCompanionState(fed);
    const early = interactWithCompanion(
      readCompanionState(),
      "feed",
      NOW + FEED_COOLDOWN_MS - 1,
    );
    expect(early.feedCount).toBe(1);
    expect(early.affection).toBe(2);
    const next = interactWithCompanion(early, "feed", NOW + FEED_COOLDOWN_MS);
    expect(next.feedCount).toBe(2);
    expect(next.satiety).toBe(100);
  });

  it("does not grant food, affection or elapsed-time benefits on clock rollback", () => {
    const fed = interactWithCompanion(readCompanionState(), "feed");
    for (const action of ["feed", "pet", "sleep", "wake"] as const) {
      expect(interactWithCompanion(fed, action, NOW - HOUR)).toEqual(fed);
    }
    expect(advanceCompanionState(fed, NOW - HOUR)).toEqual(fed);
  });

  it("accumulates small elapsed intervals and caps a long absence", () => {
    const initial = readCompanionState();
    let ticked = initial;
    for (let seconds = 1; seconds <= 60; seconds++) {
      ticked = advanceCompanionState(ticked, NOW + seconds * 1_000);
    }
    const once = advanceCompanionState(initial, NOW + 60_000);
    expect(ticked.satiety).toBeCloseTo(once.satiety, 8);
    expect(ticked.mood).toBeCloseTo(once.mood, 8);
    expect(ticked.satiety).toBeLessThan(initial.satiety);
    const away = advanceCompanionState(initial, NOW + 30 * 24 * HOUR);
    expect(away.satiety).toBe(48);
    expect(away.mood).toBe(68);
    // The capped absence is consumed once, not on every subsequent render.
    expect(advanceCompanionState(away, away.updatedAt)).toEqual(away);
  });

  it("lets sleep restore mood and wakes for care without allowing rapid petting to farm affection", () => {
    const initial = { ...readCompanionState(), mood: 40 };
    const sleeping = interactWithCompanion(initial, "sleep");
    const rested = advanceCompanionState(sleeping, NOW + 2 * HOUR);
    expect(rested.mood).toBe(48);
    expect(rested.satiety).toBe(70);
    const petted = interactWithCompanion(rested, "pet", rested.updatedAt);
    expect(petted.sleeping).toBe(false);
    expect(petted.affection).toBe(1);
    expect(
      interactWithCompanion(petted, "pet", rested.updatedAt + 1).affection,
    ).toBe(1);
    expect(
      interactWithCompanion(petted, "pet", rested.updatedAt + 5_000).affection,
    ).toBe(2);
    expect(interactWithCompanion(sleeping, "wake").sleeping).toBe(false);
  });

  it("wakes for a head pat during cooldown without granting extra affection or mood", () => {
    const petted = interactWithCompanion(readCompanionState(), "pet", NOW);
    const sleeping = interactWithCompanion(petted, "sleep", NOW + 1000);
    expect(sleeping.sleeping).toBe(true);
    const time = NOW + 2000;
    const beforeTouch = advanceCompanionState(sleeping, time);
    const awake = interactWithCompanion(sleeping, "pet", time);
    expect(awake.sleeping).toBe(false);
    expect(awake.affection).toBe(petted.affection);
    expect(awake.mood).toBe(beforeTouch.mood);
    expect(awake.lastPettedAt).toBe(NOW);
  });

  it("keeps care and position available when browser persistence fails", () => {
    const state = {
      ...interactWithCompanion(readCompanionState(), "feed"),
      position: { x: 320, y: 180 },
    };
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
    expect(() => saveCompanionState(state)).not.toThrow();
    expect(readCompanionState()).toEqual(state);
    fail.mockRestore();
    saveCompanionState(state);
    expect(JSON.parse(localStorage.getItem(COMPANION_STORAGE_KEY)!)).toEqual(
      state,
    );
    const readFailure = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("disabled", "SecurityError");
      });
    expect(() => readCompanionState()).not.toThrow();
    readFailure.mockRestore();
  });
});
