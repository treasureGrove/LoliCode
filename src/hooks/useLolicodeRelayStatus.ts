import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  CancelledError,
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { lolicodeAccountApi } from "@/lib/api/lolicode-account";
import {
  RELAY_QUOTA_QUERY_KEY,
  relayQuotaKey,
  relaySessionSnapshot,
  subscribeRelaySession,
} from "@/lib/relay-query-state";
import { relayCreditQuota } from "@/lib/relay-credit";

// One account query plus mutation/event invalidation follows the reviewed LiteLLM
// useCurrentUser/useBudgets pattern (MIT), commit 73aaf9e3daec8bb174accdf56ecade90b34c27c8.
export const RELAY_POLL_INTERVAL_MS = 25_000;
export const RELAY_REFRESH_DEBOUNCE_MS = 250;

export function relayStatusQueryOptions(
  client: QueryClient,
  accountId: string | null,
  generation: number,
) {
  return queryOptions({
    queryKey: relayQuotaKey(accountId, generation),
    queryFn: async ({ signal }) => {
      if (!accountId) throw new CancelledError({ silent: true });
      const result = await lolicodeAccountApi.refreshRelay();
      const current = relaySessionSnapshot(client);
      if (
        signal.aborted ||
        current.transitioning ||
        current.generation !== generation
      )
        throw new CancelledError({ silent: true });
      if (result.account.id !== accountId)
        throw new Error("账户已变化，请重新读取额度。");
      if (!relayCreditQuota(result.quota))
        throw new Error("Credit 余额资料无效，请刷新重试。");
      return result;
    },
    staleTime: RELAY_POLL_INTERVAL_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

type Bridge = {
  references: number;
  disposed: boolean;
  pending?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setInterval>;
  stops: UnlistenFn[];
  refresh: () => void;
  foreground: () => void;
  requested: number;
  running: boolean;
};
const bridges = new WeakMap<QueryClient, Bridge>();

function attachBridge(client: QueryClient) {
  const existing = bridges.get(client);
  if (existing) {
    existing.references += 1;
    return () => detachBridge(client, existing);
  }
  const bridge: Bridge = {
    references: 1,
    disposed: false,
    stops: [],
    refresh: () => {},
    foreground: () => {},
    requested: 0,
    running: false,
  };
  const schedule = () => {
    if (bridge.disposed) return;
    clearTimeout(bridge.pending);
    bridge.pending = setTimeout(() => {
      bridge.pending = undefined;
      if (
        bridge.disposed ||
        bridge.running ||
        relaySessionSnapshot(client).transitioning
      )
        return;
      const observed = bridge.requested;
      const generation = relaySessionSnapshot(client).generation;
      const inFlightBeforeEvent = client
        .getQueryCache()
        .findAll({ queryKey: RELAY_QUOTA_QUERY_KEY })
        .some((query) => query.state.fetchStatus === "fetching");
      bridge.running = true;
      const fetch = () =>
        client.invalidateQueries(
          { queryKey: RELAY_QUOTA_QUERY_KEY, refetchType: "active" },
          { cancelRefetch: false },
        );
      void (async () => {
        try {
          await fetch();
          // An existing read may have captured its balance before the completion
          // event. Wait for it, then perform one read that starts after the event.
          if (
            inFlightBeforeEvent &&
            !bridge.disposed &&
            !relaySessionSnapshot(client).transitioning &&
            relaySessionSnapshot(client).generation === generation
          )
            await fetch();
        } finally {
          bridge.running = false;
          if (!bridge.disposed && bridge.requested > observed) schedule();
        }
      })().catch(() => {});
    }, RELAY_REFRESH_DEBOUNCE_MS);
  };
  bridge.refresh = () => {
    bridge.requested += 1;
    schedule();
  };
  bridge.foreground = () => {
    if (document.visibilityState !== "hidden") bridge.refresh();
  };
  bridges.set(client, bridge);
  for (const name of [
    "usage-log-recorded",
    "lolicode-relay-request-completed",
    "channel-center-updated",
  ]) {
    void listen<{ source?: string }>(name, ({ payload }) => {
      // This status request already returned the exact summary used for this sync.
      if (
        name === "channel-center-updated" &&
        payload?.source === "lolicode-relay-refresh"
      )
        return;
      bridge.foreground();
    })
      .then((stop) => {
        if (bridge.disposed) stop();
        else bridge.stops.push(stop);
      })
      .catch(() => {});
  }
  window.addEventListener("focus", bridge.foreground);
  window.addEventListener("online", bridge.foreground);
  document.addEventListener("visibilitychange", bridge.foreground);
  bridge.poll = setInterval(bridge.foreground, RELAY_POLL_INTERVAL_MS);
  return () => detachBridge(client, bridge);
}

function detachBridge(client: QueryClient, bridge: Bridge) {
  if (--bridge.references > 0) return;
  bridge.disposed = true;
  clearTimeout(bridge.pending);
  clearInterval(bridge.poll);
  bridge.stops.forEach((stop) => stop());
  window.removeEventListener("focus", bridge.foreground);
  window.removeEventListener("online", bridge.foreground);
  document.removeEventListener("visibilitychange", bridge.foreground);
  if (bridges.get(client) === bridge) bridges.delete(client);
}

/** All allowance views share one server snapshot, session fence and refresh policy. */
export function useLolicodeRelayStatus(
  accountId: string | null,
  enabled = true,
) {
  const client = useQueryClient();
  const session = useSyncExternalStore(
    useCallback(
      (listener) => subscribeRelaySession(client, listener),
      [client],
    ),
    useCallback(() => relaySessionSnapshot(client), [client]),
  );
  const query = useQuery({
    ...relayStatusQueryOptions(client, accountId, session.generation),
    enabled: Boolean(accountId) && enabled && !session.transitioning,
  });
  const [expired, setExpired] = useState(false);
  useEffect(() => attachBridge(client), [client]);
  useEffect(() => {
    const resetAt = Date.parse(query.data?.quota.resetsAt ?? "");
    const delay = resetAt - Date.now();
    setExpired(Number.isFinite(resetAt) && delay <= 0);
    if (!Number.isFinite(resetAt)) return;
    if (delay <= 0) {
      if (query.dataUpdatedAt < resetAt) bridges.get(client)?.refresh();
      return;
    }
    const timer = setTimeout(
      () => {
        setExpired(Date.now() >= resetAt);
        bridges.get(client)?.refresh();
      },
      Math.min(delay + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [client, query.data, query.dataUpdatedAt]);
  const refetch = query.refetch;
  const refresh = useCallback(
    () => refetch({ cancelRefetch: false, throwOnError: true }),
    [refetch],
  );
  return {
    ...query,
    data:
      !enabled || session.transitioning || expired || query.isError
        ? undefined
        : query.data,
    refresh,
  };
}
