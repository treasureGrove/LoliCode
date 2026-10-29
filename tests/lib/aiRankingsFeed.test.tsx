import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RANKING_FEED_BYTES,
  RANKINGS_FEED_URL,
  parseRankingSnapshot,
  rankingSnapshot,
} from "@/lib/ai-rankings";
import {
  RANKINGS_CACHE_KEY,
  RANKINGS_FOCUS_COOLDOWN_MS,
  useRankingsFeed,
} from "@/lib/query/aiRankings";

const now = new Date("2026-10-28T08:00:00Z");
const fixture = () => structuredClone(rankingSnapshot);
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  localStorage.removeItem(RANKINGS_CACHE_KEY);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("verified daily ranking feed", () => {
  it("reconstructs immutable snapshots from official sources without mutating bundled data", () => {
    const input = { ...fixture(), news: [{ title: "Ignored optional news" }] };
    const parsed = parseRankingSnapshot(JSON.stringify(input), now);
    expect(parsed).toEqual(rankingSnapshot);
    expect(parsed).not.toBe(rankingSnapshot);
    expect(Object.isFrozen(parsed.models[0].measurements)).toBe(true);
    expect(input.models[0].name).toBe(rankingSnapshot.models[0].name);
    expect("news" in parsed).toBe(false);
  });

  it("rejects untrusted links, unsupported sources, invalid scores and incomplete evidence", () => {
    for (const change of [
      (value: any) => {
        value.sources[0].url = "https://evil.example/rankings";
      },
      (value: any) => {
        value.models[0].measurements.arena.url =
          "https://user:secret@arena.ai/";
      },
      (value: any) => {
        value.models[0].measurements.livebench.url = "http://livebench.ai/";
      },
      (value: any) => {
        value.sources[2].id = "unsupported";
      },
      (value: any) => {
        value.models[0].measurements.livebench.score = NaN;
      },
      (value: any) => {
        value.models[0].measurements.livebench.score = 101;
      },
      (value: any) => {
        value.models[0].measurements.arena.score = -1;
      },
      (value: any) => {
        value.models[0].measurements.arena = null;
        value.models[0].measurements.livebench = null;
      },
      (value: any) => {
        value.models.push(value.models[0]);
      },
      (value: any) => {
        value.models[0].icon = "https://evil.example/tracker.svg";
      },
    ]) {
      const input = fixture();
      change(input);
      expect(() => parseRankingSnapshot(input, now)).toThrow();
    }
  });

  it("rejects impossible or future dates, excessive data and degenerate model sets", () => {
    for (const change of [
      (value: any) => {
        value.retrievedAt = "2026-02-30";
      },
      (value: any) => {
        value.retrievedAt = "2030-01-01";
      },
      (value: any) => {
        value.sources[1].updatedAt = "2026-10-29";
      },
      (value: any) => {
        value.models = value.models.slice(0, 1);
      },
      (value: any) => {
        value.models = Array(201).fill(value.models[0]);
      },
    ]) {
      const input = fixture();
      change(input);
      expect(() => parseRankingSnapshot(input, now)).toThrow();
    }
    expect(() =>
      parseRankingSnapshot(" ".repeat(MAX_RANKING_FEED_BYTES + 1), now),
    ).toThrow();
  });
});

describe("daily ranking client cache", () => {
  it("keeps identical snapshot and model references while manual refresh still gives feedback", async () => {
    vi.mocked(fetch).mockImplementation(async () => response(fixture()));
    const { result } = renderHook(() => useRankingsFeed());
    const originalSnapshot = result.current.snapshot;
    const originalModels = result.current.models;
    expect(result.current.refreshing).toBe(false);
    await waitFor(() => expect(result.current.source).toBe("online"));
    expect(result.current.snapshot).toBe(originalSnapshot);
    expect(result.current.models).toBe(originalModels);
    const pending = deferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => pending.promise);
    act(() => result.current.refresh());
    expect(result.current.refreshing).toBe(true);
    await act(async () => pending.resolve(response(fixture())));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.snapshot).toBe(originalSnapshot);
    expect(result.current.models).toBe(originalModels);

    const changed = fixture() as any;
    changed.models[0].name = "Changed verified model";
    vi.mocked(fetch).mockResolvedValueOnce(response(changed));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.snapshot).not.toBe(originalSnapshot);
    expect(result.current.models).not.toBe(originalModels);
    expect(result.current.snapshot.models[0].name).toBe(changed.models[0].name);
  });

  it("throttles repeated focus events and checks silently after the cooldown", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.mocked(fetch).mockImplementation(async () => response(fixture()));
    const rendered = vi.fn();
    const { result } = renderHook(() => {
      rendered();
      return useRankingsFeed();
    });
    await waitFor(() => expect(result.current.source).toBe("online"));
    const snapshot = result.current.snapshot;
    const models = result.current.models;
    const renders = rendered.mock.calls.length;
    act(() => {
      for (let index = 0; index < 20; index++)
        window.dispatchEvent(new Event("focus"));
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    const pending = deferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => pending.promise);
    clock.mockReturnValue(now.getTime() + RANKINGS_FOCUS_COOLDOWN_MS);
    act(() => {
      for (let index = 0; index < 20; index++)
        window.dispatchEvent(new Event("focus"));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.refreshing).toBe(false);
    expect(rendered).toHaveBeenCalledTimes(renders);
    await act(async () => pending.resolve(response(fixture())));
    expect(result.current.snapshot).toBe(snapshot);
    expect(result.current.models).toBe(models);
    expect(rendered).toHaveBeenCalledTimes(renders);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not flash an error or repaint the chart for a failed background check", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.mocked(fetch).mockResolvedValueOnce(response(fixture()));
    const rendered = vi.fn();
    const { result } = renderHook(() => {
      rendered();
      return useRankingsFeed();
    });
    await waitFor(() => expect(result.current.source).toBe("online"));
    const renders = rendered.mock.calls.length;
    const pending = deferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => pending.promise);
    clock.mockReturnValue(now.getTime() + RANKINGS_FOCUS_COOLDOWN_MS);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => pending.reject(new Error("offline")));
    expect(result.current.source).toBe("online");
    expect(result.current.refreshing).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(rendered).toHaveBeenCalledTimes(renders);
  });

  it("merges manual refreshes into a pending background request without aborting it", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.mocked(fetch).mockResolvedValueOnce(response(fixture()));
    const { result } = renderHook(() => useRankingsFeed());
    await waitFor(() => expect(result.current.source).toBe("online"));
    const retained = result.current.snapshot;
    const pending = deferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => pending.promise);
    clock.mockReturnValue(now.getTime() + RANKINGS_FOCUS_COOLDOWN_MS);
    act(() => window.dispatchEvent(new Event("focus")));
    const signal = vi.mocked(fetch).mock.calls[1][1]!.signal!;
    act(() => {
      result.current.refresh();
      result.current.refresh();
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(false);
    expect(result.current.refreshing).toBe(true);
    await act(async () => pending.reject(new Error("offline")));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.refreshing).toBe(false);
    expect(result.current.snapshot).toBe(retained);
    expect(signal.aborted).toBe(false);
  });

  it("loads verified server results and persists a reusable last-good snapshot", async () => {
    const next = fixture() as any;
    next.models[0].name = "Updated model from server";
    vi.mocked(fetch).mockResolvedValueOnce(response(next));
    const { result, unmount } = renderHook(() => useRankingsFeed());
    await waitFor(() => expect(result.current.source).toBe("online"));
    expect(fetch).toHaveBeenCalledWith(
      RANKINGS_FEED_URL,
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    expect(
      result.current.models.some((model) => model.name === next.models[0].name),
    ).toBe(true);
    expect(JSON.parse(localStorage.getItem(RANKINGS_CACHE_KEY)!)).toEqual(next);
    unmount();
    const reopened = renderHook(() => useRankingsFeed());
    expect(reopened.result.current.source).toBe("cache");
    await waitFor(() => expect(reopened.result.current.failed).toBe(true));
    expect(reopened.result.current.snapshot.models[0].name).toBe(
      next.models[0].name,
    );
  });

  it("ignores corrupt caches and keeps existing data on a failed manual refresh", async () => {
    localStorage.setItem(RANKINGS_CACHE_KEY, "{broken}");
    const { result } = renderHook(() => useRankingsFeed());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.source).toBe("builtin");
    const next = fixture() as any;
    next.models[0].name = "Verified replacement";
    vi.mocked(fetch).mockResolvedValueOnce(response(next));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.source).toBe("online"));
    const retained = result.current.snapshot;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("{broken}", { status: 200 }),
    );
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.snapshot).toBe(retained);
  });

  it("refuses to replace current data with an older or oversized server response", async () => {
    const older = fixture() as any;
    older.retrievedAt = "2026-10-27";
    vi.mocked(fetch).mockResolvedValueOnce(response(older));
    const { result } = renderHook(() => useRankingsFeed());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.snapshot).toBe(rankingSnapshot);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(MAX_RANKING_FEED_BYTES + 1) },
      }),
    );
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.failed).toBe(true);
    expect(result.current.snapshot).toBe(rankingSnapshot);
  });
});
