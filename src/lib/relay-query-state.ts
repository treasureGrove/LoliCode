import type { QueryClient } from "@tanstack/react-query";

export const RELAY_QUOTA_QUERY_KEY = [
  "lolicode-account",
  "relay-quota",
] as const;
export const relayQuotaKey = (accountId: string | null, generation: number) =>
  [...RELAY_QUOTA_QUERY_KEY, accountId, generation] as const;

type RelaySession = Readonly<{ generation: number; transitioning: boolean }>;
const sessions = new WeakMap<
  QueryClient,
  {
    snapshot: RelaySession;
    listeners: Set<() => void>;
  }
>();

function session(client: QueryClient) {
  let state = sessions.get(client);
  if (!state) {
    state = {
      snapshot: { generation: 0, transitioning: false },
      listeners: new Set(),
    };
    sessions.set(client, state);
  }
  return state;
}

export const relaySessionSnapshot = (client: QueryClient) =>
  session(client).snapshot;
export function subscribeRelaySession(
  client: QueryClient,
  listener: () => void,
) {
  const state = session(client);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

function replaceSession(client: QueryClient, transitioning: boolean) {
  const state = session(client);
  state.snapshot = { generation: state.snapshot.generation + 1, transitioning };
  // Cancellation cannot stop native IPC; query functions also check this epoch.
  void client
    .cancelQueries({ queryKey: RELAY_QUOTA_QUERY_KEY })
    .catch(() => {});
  client.removeQueries({ queryKey: RELAY_QUOTA_QUERY_KEY });
  state.listeners.forEach((listener) => listener());
  return state.snapshot.generation;
}

export const beginRelaySessionTransition = (client: QueryClient) =>
  replaceSession(client, true);
export function endRelaySessionTransition(
  client: QueryClient,
  expectedGeneration: number,
) {
  if (session(client).snapshot.generation === expectedGeneration)
    replaceSession(client, false);
}
