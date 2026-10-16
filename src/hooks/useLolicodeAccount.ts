import { useCallback, useEffect, useRef, useState } from "react";
import {
  CancelledError,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  lolicodeAccountApi,
  type LolicodeAccountStatus,
} from "@/lib/api/lolicode-account";

export const LOLICODE_ACCOUNT_QUERY_KEY = [
  "lolicode-account",
  "status",
] as const;

// Shared by observers of the same cache, including a dialog mounted mid-request.
const generations = new WeakMap<QueryClient, { value: number }>();
function accountGeneration(client: QueryClient) {
  let generation = generations.get(client);
  if (!generation) {
    generation = { value: 0 };
    generations.set(client, generation);
  }
  return generation;
}

const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export interface UseLolicodeAccountResult {
  account: LolicodeAccountStatus["account"];
  status: LolicodeAccountStatus | undefined;
  isLoading: boolean;
  isRefreshing: boolean;
  isPending: boolean;
  error: string | null;
  warning: string | null;
  persistent: boolean;
  login: (
    identification: string,
    password: string,
  ) => Promise<LolicodeAccountStatus>;
  logout: () => Promise<LolicodeAccountStatus>;
  refresh: () => Promise<LolicodeAccountStatus>;
}

/** Reads native cached identity on mount; network refresh is always explicit. */
export function useLolicodeAccount(): UseLolicodeAccountResult {
  const queryClient = useQueryClient();
  const [operation, setOperation] = useState<
    "login" | "logout" | "refresh" | null
  >(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const latestOperation = useRef<symbol | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const statusQuery = useQuery<LolicodeAccountStatus>({
    queryKey: LOLICODE_ACCOUNT_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const generation = accountGeneration(queryClient);
      const requestGeneration = generation.value;
      const status = await lolicodeAccountApi.status(false);
      // Cancelling a Query cannot cancel native IPC. Reject its late public result.
      if (signal.aborted || generation.value !== requestGeneration)
        throw new CancelledError({ silent: true });
      return status;
    },
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const run = useCallback(
    async (
      kind: "login" | "logout" | "refresh",
      request: () => Promise<LolicodeAccountStatus>,
    ) => {
      const generation = accountGeneration(queryClient);
      const requestGeneration = ++generation.value;
      const operationId = Symbol(kind);
      latestOperation.current = operationId;
      if (mounted.current) {
        setOperation(kind);
        setOperationError(null);
      }
      await queryClient.cancelQueries({
        queryKey: LOLICODE_ACCOUNT_QUERY_KEY,
        exact: true,
      });
      try {
        const status = await request();
        if (generation.value === requestGeneration) {
          // Also invalidate reads started by another observer during this operation.
          const commitGeneration = ++generation.value;
          await queryClient.cancelQueries({
            queryKey: LOLICODE_ACCOUNT_QUERY_KEY,
            exact: true,
          });
          if (generation.value === commitGeneration)
            queryClient.setQueryData(LOLICODE_ACCOUNT_QUERY_KEY, status);
        }
        return status;
      } catch (cause) {
        if (generation.value === requestGeneration && mounted.current)
          setOperationError(errorMessage(cause));
        throw cause;
      } finally {
        if (latestOperation.current === operationId && mounted.current)
          setOperation(null);
      }
    },
    [queryClient],
  );

  // These credentials never become React Query mutation variables or cache data.
  const login = useCallback(
    (identification: string, password: string) =>
      run("login", () => lolicodeAccountApi.login(identification, password)),
    [run],
  );
  const logout = useCallback(
    () => run("logout", lolicodeAccountApi.logout),
    [run],
  );
  const refresh = useCallback(
    () => run("refresh", () => lolicodeAccountApi.status(true)),
    [run],
  );

  return {
    account: statusQuery.data?.account || null,
    status: statusQuery.data,
    isLoading: statusQuery.isLoading,
    isRefreshing: operation === "refresh",
    isPending: operation !== null,
    error:
      operationError ||
      (statusQuery.error ? errorMessage(statusQuery.error) : null),
    warning: statusQuery.data?.warning || null,
    persistent: statusQuery.data?.persistent ?? false,
    login,
    logout,
    refresh,
  };
}
