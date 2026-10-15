import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";

// The lane survives closing/reopening a dialog. Dismissal never turns a still
// running native create/connect operation into a second submission.
let pending = false;
const subscribers = new Set<() => void>();
const subscribe = (callback: () => void) => {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
};
const snapshot = () => pending;
function publish(value: boolean) {
  pending = value;
  subscribers.forEach((callback) => callback());
}
export function useAgentOperation() {
  const busy = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (operation: () => Promise<unknown>) => {
    if (pending) {
      setError("请等待上一项操作完成后重试。");
      return false;
    }
    publish(true);
    setError(null);
    try {
      await operation();
      return true;
    } catch (cause) {
      if (mounted.current) setError(agentErrorMessage(cause));
      return false;
    } finally {
      publish(false);
    }
  };
  return { busy, error, run };
}
export function useAgentResource<T>(
  key: string,
  load: () => Promise<T>,
  interval = 5000,
  duringMutation = false,
) {
  const busy = useSyncExternalStore(subscribe, snapshot, snapshot);
  const blocked = busy && !duringMutation;
  const currentLoad = useRef(load);
  currentLoad.current = load;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setData(null);
  }, [key]);
  useEffect(() => {
    if (blocked || !key) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      setLoading(true);
      try {
        const value = await currentLoad.current();
        if (!disposed) {
          setData(value);
          setError(null);
        }
      } catch (cause) {
        if (!disposed) setError(agentErrorMessage(cause));
      } finally {
        if (!disposed) {
          setLoading(false);
          if (interval) timer = setTimeout(() => void poll(), interval);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, revision, blocked, interval]);
  return {
    data,
    error,
    loading,
    reload: () => setRevision((value) => value + 1),
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
