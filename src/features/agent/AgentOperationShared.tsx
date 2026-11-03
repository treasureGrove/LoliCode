import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";

// The lane survives closing/reopening a dialog. Dismissal never turns a still
// running native create/connect operation into a second submission.
const REQUEST_TIMEOUT_MS = 30_000;
const STALLED_MESSAGE =
  "操作长时间未响应，仍可能在后台执行。已恢复列表读取，请先查看结果，避免重复提交。";
const pending = new Map<string, { stalled: boolean }>();
let revision = 0;
const subscribers = new Set<() => void>();
const subscribe = (callback: () => void) => {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
};
const snapshot = () => revision;
function publish() {
  revision += 1;
  subscribers.forEach((callback) => callback());
}
export function useAgentOperation(scope = "shared") {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const busy = pending.has(scope);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => setError(null), [scope]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async (operation: () => Promise<unknown>) => {
      if (pending.has(scope)) {
        setError(
          pending.get(scope)?.stalled
            ? "上一项操作仍在后台处理中，请先刷新查看结果，避免重复提交。"
            : "请等待上一项操作完成后重试。",
        );
        return false;
      }
      const lane = { stalled: false };
      pending.set(scope, lane);
      publish();
      setError(null);
      const current = () => mounted.current && currentScope.current === scope;
      const timer = setTimeout(() => {
        lane.stalled = true;
        publish();
        if (current()) setError(STALLED_MESSAGE);
      }, REQUEST_TIMEOUT_MS);
      try {
        await operation();
        if (current()) setError(null);
        return true;
      } catch (cause) {
        if (current()) setError(agentErrorMessage(cause));
        return false;
      } finally {
        clearTimeout(timer);
        pending.delete(scope);
        publish();
      }
    },
    [scope],
  );
  return {
    busy,
    error: error || (pending.get(scope)?.stalled ? STALLED_MESSAGE : null),
    run,
  };
}
export function useAgentResource<T>(
  key: string,
  load: () => Promise<T>,
  interval = 5000,
  duringMutation = false,
  operationScope = "shared",
) {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  // Keep write deduplication until the native result is known, but let a stalled
  // write stop suppressing every read-only tool panel indefinitely.
  const lane = pending.get(operationScope);
  const blocked = !duringMutation && !!lane && !lane.stalled;
  const currentLoad = useRef(load);
  currentLoad.current = load;
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: string | null;
    loading: boolean;
  }>({ key, data: null, error: null, loading: false });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (blocked || !key) {
      setState((previous) => ({
        key,
        data: previous.key === key && key ? previous.data : null,
        error: previous.key === key && key ? previous.error : null,
        loading: false,
      }));
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      setState((previous) => ({
        key,
        data: previous.key === key ? previous.data : null,
        error: null,
        loading: true,
      }));
      let timedOut = false;
      try {
        const request = currentLoad.current();
        const value = await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => {
              timedOut = true;
              reject(new Error("读取超时，请刷新重试。"));
            }, REQUEST_TIMEOUT_MS);
          }),
        ]);
        if (!disposed) {
          setState({ key, data: value, error: null, loading: false });
        }
      } catch (cause) {
        if (!disposed)
          setState((previous) => ({
            ...previous,
            error: agentErrorMessage(cause),
            loading: false,
          }));
      } finally {
        if (deadline) clearTimeout(deadline);
        if (!disposed) {
          // A hung IPC cannot be cancelled here. Require an explicit reload
          // instead of accumulating another unresolved call on every poll.
          if (interval && !timedOut)
            timer = setTimeout(() => void poll(), interval);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
    };
  }, [key, revision, blocked, interval]);
  return {
    data: state.key === key ? state.data : null,
    error: state.key === key ? state.error : null,
    loading: !!key && !blocked && (state.key !== key || state.loading),
    reload: useCallback(() => setRevision((value) => value + 1), []),
  };
}
export function OperationError({ children }: { children?: string | null }) {
  return children ? (
    <p
      role="alert"
      className="my-2 whitespace-pre-wrap text-caption text-danger-text"
    >
      {children}
    </p>
  ) : null;
}
