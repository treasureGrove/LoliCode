import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useLolicodeRelayStatus,
  RELAY_POLL_INTERVAL_MS,
  RELAY_REFRESH_DEBOUNCE_MS,
} from "@/hooks/useLolicodeRelayStatus";
import { useLolicodeAccount } from "@/hooks/useLolicodeAccount";
import { RELAY_QUOTA_QUERY_KEY } from "@/lib/relay-query-state";
import type {
  LolicodeAccountStatus,
  LolicodeRelayStatus,
} from "@/lib/api/lolicode-account";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  relay: vi.fn(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (name: string, listener: (event: { payload: unknown }) => void) => {
      const callbacks = mocks.listeners.get(name) || new Set();
      callbacks.add(listener);
      mocks.listeners.set(name, callbacks);
      return () => {
        callbacks.delete(listener);
      };
    },
  ),
}));

const signedIn: LolicodeAccountStatus = {
  account: {
    id: "42",
    username: "member",
    displayName: "Member",
    avatarUrl: null,
    profileUrl: "https://lolicode.com/u/42",
  },
  persistent: true,
  warning: null,
};
const signedOut: LolicodeAccountStatus = {
  account: null,
  persistent: true,
  warning: null,
};
function snapshot(
  remaining = 80,
  pricingRevision = 3,
  ledgerRevision = 10,
): LolicodeRelayStatus {
  return {
    account: { id: "42", username: "member", displayName: "Member" },
    ready: true,
    models: [{ id: "public-model" }],
    quota: {
      day: "2028-01-01",
      timezone: "Asia/Singapore",
      resetsAt: "2029-01-02T00:00:00+08:00",
      requestLimit: Number.MAX_SAFE_INTEGER,
      requestsRemaining: Number.MAX_SAFE_INTEGER,
      requestsUnlimited: true,
      requestsUsed: 230,
      tokenLimit: 100000,
      tokensUsed: 20000,
      tokensReserved: 0,
      tokensRemaining: 80000,
      creditBalance: {
        unit: "Credit",
        limit: 100,
        used: 100 - remaining,
        reserved: 0,
        remaining,
        pricingRevision,
        ledgerRevision,
      },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const clients: QueryClient[] = [];
function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
async function flush(milliseconds = 5) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
function emit(name: string, payload: unknown = {}) {
  mocks.listeners.get(name)?.forEach((listener) => listener({ payload }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2028-01-01T12:00:00Z"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  mocks.listeners.clear();
  mocks.relay.mockReset().mockResolvedValue(snapshot());
  let identity = signedIn;
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "lolicode_relay_status") return mocks.relay();
    if (command === "lolicode_account_login") {
      identity = signedIn;
      return identity;
    }
    if (command === "lolicode_account_logout") {
      identity = signedOut;
      return identity;
    }
    if (command === "lolicode_account_status") return identity;
    throw new Error("Unexpected native command");
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shared LoliCode Credit summary", () => {
  it("shares one snapshot and event bridge across observers and merges simultaneous manual refreshes", async () => {
    const { wrapper } = harness();
    const view = renderHook(
      () => [useLolicodeRelayStatus("42"), useLolicodeRelayStatus("42")],
      { wrapper },
    );
    await flush();
    expect(mocks.relay).toHaveBeenCalledOnce();
    expect(view.result.current[0].data).toBe(view.result.current[1].data);
    expect(mocks.listeners.get("usage-log-recorded")?.size).toBe(1);
    const waiting = deferred<LolicodeRelayStatus>();
    mocks.relay.mockReturnValueOnce(waiting.promise);
    let first!: Promise<unknown>, second!: Promise<unknown>;
    act(() => {
      first = view.result.current[0].refresh();
      second = view.result.current[1].refresh();
    });
    expect(mocks.relay).toHaveBeenCalledTimes(2);
    await act(async () => {
      waiting.resolve(snapshot(70));
      await Promise.all([first, second]);
    });
    await flush();
    expect(view.result.current[0].data?.quota.creditBalance?.remaining).toBe(
      70,
    );
    expect(view.result.current[0].data).toBe(view.result.current[1].data);
    expect(
      mocks.invoke.mock.calls.some(
        ([command]) => command === "lolicode_relay_connect",
      ),
    ).toBe(false);
  });

  it("debounces completed request events into one fresh canonical summary", async () => {
    const { wrapper } = harness();
    const view = renderHook(() => useLolicodeRelayStatus("42"), { wrapper });
    await flush();
    mocks.relay.mockResolvedValue(snapshot(65, 3, 11));
    act(() => {
      emit("usage-log-recorded");
      emit("usage-log-recorded");
      emit("lolicode-relay-request-completed");
    });
    await flush(RELAY_REFRESH_DEBOUNCE_MS - 1);
    expect(mocks.relay).toHaveBeenCalledOnce();
    await flush(6);
    expect(mocks.relay).toHaveBeenCalledTimes(2);
    expect(view.result.current.data?.quota.creditBalance?.remaining).toBe(65);
  });

  it("queues a post-event read when a pre-event snapshot is still in flight", async () => {
    const { wrapper } = harness();
    const view = renderHook(() => useLolicodeRelayStatus("42"), { wrapper });
    await flush();
    const oldRead = deferred<LolicodeRelayStatus>();
    mocks.relay
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue(snapshot(50, 3, 12));
    let manual!: Promise<unknown>;
    act(() => {
      manual = view.result.current.refresh();
    });
    act(() => {
      emit("usage-log-recorded");
    });
    await flush(RELAY_REFRESH_DEBOUNCE_MS + 1);
    expect(mocks.relay).toHaveBeenCalledTimes(2);
    await act(async () => {
      oldRead.resolve(snapshot(79, 3, 10));
      await manual;
    });
    await flush();
    expect(mocks.relay).toHaveBeenCalledTimes(3);
    expect(view.result.current.data?.quota.creditBalance?.remaining).toBe(50);
    expect(view.result.current.data?.quota.creditBalance?.ledgerRevision).toBe(
      12,
    );
  });

  it("ignores its own catalog event but refreshes after an external channel change", async () => {
    const { wrapper } = harness();
    const view = renderHook(() => useLolicodeRelayStatus("42"), { wrapper });
    await flush();
    act(() => {
      emit("channel-center-updated", {
        revision: 9,
        source: "lolicode-relay-refresh",
      });
    });
    await flush(RELAY_REFRESH_DEBOUNCE_MS + 1);
    expect(mocks.relay).toHaveBeenCalledOnce();
    mocks.relay.mockResolvedValue(snapshot(90, 4, 10));
    act(() => {
      emit("channel-center-updated", { revision: 10 });
    });
    await flush(RELAY_REFRESH_DEBOUNCE_MS + 5);
    expect(view.result.current.data?.quota.creditBalance?.pricingRevision).toBe(
      4,
    );
    expect(view.result.current.data?.quota.creditBalance?.remaining).toBe(90);
  });

  it("polls within 30 seconds, skips hidden windows and refreshes when visible again", async () => {
    const { wrapper } = harness();
    const view = renderHook(() => useLolicodeRelayStatus("42"), { wrapper });
    await flush();
    mocks.relay.mockResolvedValue(snapshot(60, 4, 10));
    await flush(RELAY_POLL_INTERVAL_MS + RELAY_REFRESH_DEBOUNCE_MS + 5);
    expect(view.result.current.data?.quota.creditBalance?.remaining).toBe(60);
    expect(mocks.relay).toHaveBeenCalledTimes(2);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await flush(RELAY_POLL_INTERVAL_MS * 2);
    expect(mocks.relay).toHaveBeenCalledTimes(2);
    mocks.relay.mockResolvedValue(snapshot(40, 4, 15));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush(RELAY_REFRESH_DEBOUNCE_MS + 5);
    expect(view.result.current.data?.quota.creditBalance?.remaining).toBe(40);
  });

  it("shares foreground and reconnect refresh without duplicated requests", async () => {
    const { wrapper } = harness();
    renderHook(
      () => [useLolicodeRelayStatus("42"), useLolicodeRelayStatus("42")],
      { wrapper },
    );
    await flush();
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    await flush(RELAY_REFRESH_DEBOUNCE_MS + 5);
    expect(mocks.relay).toHaveBeenCalledTimes(2);
  });

  it("fences old reads and removes the cache across logout and login with the same account ID", async () => {
    const { client, wrapper } = harness();
    const view = renderHook(
      () => {
        const identity = useLolicodeAccount();
        const relay = useLolicodeRelayStatus(
          identity.account?.id ?? null,
          !identity.isPending,
        );
        return { identity, relay };
      },
      { wrapper },
    );
    await flush();
    await flush();
    expect(view.result.current.relay.data?.quota.creditBalance?.remaining).toBe(
      80,
    );
    const oldRead = deferred<LolicodeRelayStatus>();
    mocks.relay
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue(snapshot(35, 3, 30));
    let oldRefresh!: Promise<unknown>;
    act(() => {
      oldRefresh = view.result.current.relay.refresh().catch(() => undefined);
    });
    await act(async () => {
      await view.result.current.identity.logout();
    });
    await flush();
    expect(view.result.current.relay.data).toBeUndefined();
    expect(
      client
        .getQueriesData({ queryKey: RELAY_QUOTA_QUERY_KEY })
        .every(([, value]) => value === undefined),
    ).toBe(true);
    await act(async () => {
      await view.result.current.identity.login("member", "entered-password");
    });
    await flush();
    await flush();
    expect(view.result.current.relay.data?.quota.creditBalance?.remaining).toBe(
      35,
    );
    await act(async () => {
      oldRead.resolve(snapshot(99, 2, 1));
      await oldRefresh;
    });
    await flush();
    expect(view.result.current.relay.data?.quota.creditBalance?.remaining).toBe(
      35,
    );
    expect(
      client
        .getQueriesData<LolicodeRelayStatus>({
          queryKey: RELAY_QUOTA_QUERY_KEY,
        })
        .filter(([, value]) => value)
        .map(([, value]) => value?.quota.creditBalance?.remaining),
    ).toEqual([35]);
  });

  it("accepts a new day even when pricing and ledger revisions did not change", async () => {
    const { wrapper } = harness();
    const view = renderHook(() => useLolicodeRelayStatus("42"), { wrapper });
    await flush();
    const tomorrow = snapshot(100, 3, 10);
    tomorrow.quota.day = "2028-01-02";
    tomorrow.quota.resetsAt = "2029-01-03T00:00:00+08:00";
    mocks.relay.mockResolvedValue(tomorrow);
    await act(async () => {
      await view.result.current.refresh();
    });
    await flush();
    expect(view.result.current.data?.quota.day).toBe("2028-01-02");
    expect(view.result.current.data?.quota.creditBalance?.remaining).toBe(100);
  });

  it("does not fetch a signed-out account and removes shared listeners after the last observer", async () => {
    const { wrapper } = harness();
    const view = renderHook(() => useLolicodeRelayStatus(null), { wrapper });
    await flush();
    expect(mocks.relay).not.toHaveBeenCalled();
    view.unmount();
    expect(mocks.listeners.get("usage-log-recorded")?.size).toBe(0);
  });
});
