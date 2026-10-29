import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_RANKING_FEED_BYTES,
  RANKINGS_FEED_URL,
  parseRankingSnapshot,
  rankModels,
  rankingSnapshot,
  type RankingSnapshot,
} from "@/lib/ai-rankings";

export const RANKINGS_CACHE_KEY = "lolicode:ai-rankings:verified-v1";
export const RANKINGS_FOCUS_COOLDOWN_MS = 5 * 60_000;

interface FeedRequest {
  controller: AbortController;
  timeout: number | undefined;
  promise: Promise<void>;
  manual: boolean;
  initial: boolean;
  cancelled: boolean;
}

interface RankingFeedState {
  snapshot: RankingSnapshot;
  source: "builtin" | "cache" | "online";
  refreshing: boolean;
  failed: boolean;
}

function initialFeed(): RankingFeedState {
  try {
    const cached = window.localStorage.getItem(RANKINGS_CACHE_KEY);
    if (cached) {
      const parsed = parseRankingSnapshot(cached);
      if (parsed.retrievedAt >= rankingSnapshot.retrievedAt)
        return {
          snapshot: parsed,
          source: "cache",
          refreshing: false,
          failed: false,
        };
    }
  } catch {
    // An unavailable or invalid cache must never prevent the bundled chart loading.
  }
  return {
    snapshot: rankingSnapshot,
    source: "builtin",
    refreshing: false,
    failed: false,
  };
}

async function readBoundedFeed(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_RANKING_FEED_BYTES)
    throw new Error("Ranking response exceeds size limit");
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RANKING_FEED_BYTES)
      throw new Error("Ranking response exceeds size limit");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RANKING_FEED_BYTES) {
        await reader.cancel();
        throw new Error("Ranking response exceeds size limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Keep the last verified snapshot usable while the daily server feed is checked. */
export function useRankingsFeed() {
  const [state, setState] = useState<RankingFeedState>(initialFeed);
  const latestState = useRef(state);
  const commitState = useCallback(
    (update: (previous: RankingFeedState) => RankingFeedState) => {
      const next = update(latestState.current);
      if (next !== latestState.current) {
        latestState.current = next;
        setState(next);
      }
    },
    [],
  );
  const current = useRef(state.snapshot);
  const currentFingerprint = useRef("");
  if (!currentFingerprint.current)
    currentFingerprint.current = JSON.stringify(state.snapshot);
  const cachedFingerprint = useRef(
    state.source === "cache" ? currentFingerprint.current : null,
  );
  const mounted = useRef(false);
  const inFlight = useRef<FeedRequest | null>(null);
  const lastAttempt = useRef<number | null>(null);

  const checkFeed = useCallback(
    (kind: "initial" | "background" | "manual") => {
      if (!mounted.current) return Promise.resolve();
      const manual = kind === "manual";
      if (manual)
        commitState((previous) =>
          previous.refreshing && !previous.failed
            ? previous
            : { ...previous, refreshing: true, failed: false },
        );
      if (inFlight.current) {
        if (manual) inFlight.current.manual = true;
        return inFlight.current.promise;
      }
      const now = Date.now();
      if (
        kind === "background" &&
        lastAttempt.current !== null &&
        now - lastAttempt.current < RANKINGS_FOCUS_COOLDOWN_MS
      )
        return Promise.resolve();
      lastAttempt.current = now;
      const controller = new AbortController();
      const request: FeedRequest = {
        controller,
        timeout: undefined,
        promise: Promise.resolve(),
        manual,
        initial: kind === "initial",
        cancelled: false,
      };
      inFlight.current = request;
      request.timeout = window.setTimeout(() => controller.abort(), 12_000);
      request.promise = (async () => {
        try {
          const response = await fetch(RANKINGS_FEED_URL, {
            cache: "no-cache",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("Ranking feed unavailable");
          const next = parseRankingSnapshot(await readBoundedFeed(response));
          if (next.retrievedAt < current.current.retrievedAt)
            throw new Error("Ranking feed is older than current data");
          if (!mounted.current || request.cancelled) return;
          const fingerprint = JSON.stringify(next);
          if (fingerprint !== currentFingerprint.current) {
            current.current = next;
            currentFingerprint.current = fingerprint;
          }
          if (cachedFingerprint.current !== fingerprint) {
            try {
              window.localStorage.setItem(RANKINGS_CACHE_KEY, fingerprint);
              cachedFingerprint.current = fingerprint;
            } catch {
              // A storage quota failure does not invalidate verified online data.
            }
          }
          commitState((previous) =>
            previous.snapshot === current.current &&
            previous.source === "online" &&
            !previous.refreshing &&
            !previous.failed
              ? previous
              : {
                  snapshot: current.current,
                  source: "online",
                  refreshing: false,
                  failed: false,
                },
          );
        } catch {
          // Initial failure gives one useful offline notice. Later background
          // checks leave the last result and its UI status alone until recovery.
          if (
            mounted.current &&
            !request.cancelled &&
            (request.manual || request.initial)
          )
            commitState((previous) =>
              previous.failed && !previous.refreshing
                ? previous
                : { ...previous, refreshing: false, failed: true },
            );
        } finally {
          window.clearTimeout(request.timeout);
          if (inFlight.current === request) inFlight.current = null;
        }
      })();
      return request.promise;
    },
    [commitState],
  );

  const refresh = useCallback(() => {
    void checkFeed("manual");
  }, [checkFeed]);

  useEffect(() => {
    mounted.current = true;
    void checkFeed("initial");
    return () => {
      mounted.current = false;
      if (inFlight.current) {
        inFlight.current.cancelled = true;
        window.clearTimeout(inFlight.current.timeout);
        inFlight.current.controller.abort();
        inFlight.current = null;
        lastAttempt.current = null;
      }
    };
  }, [checkFeed]);

  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible") void checkFeed("background");
    };
    window.addEventListener("focus", check);
    const interval = window.setInterval(check, 30 * 60_000);
    return () => {
      window.removeEventListener("focus", check);
      window.clearInterval(interval);
    };
  }, [checkFeed]);

  const models = useMemo(
    () => rankModels(state.snapshot.models),
    [state.snapshot],
  );
  return { ...state, models, refresh };
}
