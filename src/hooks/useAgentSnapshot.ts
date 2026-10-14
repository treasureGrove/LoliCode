import { useEffect, useRef, useState } from "react";
import { agentApi } from "@/lib/api/agent";
import type { AgentSnapshot } from "@/types/agent";

export function agentErrorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause ?? "");
  return text.trim().slice(0, 500) || "操作没有完成，请重试。";
}

/** Serial polling consumes backend snapshots, including the engine's stream overlay. */
export function useAgentSnapshot(
  sessionId: string | null,
  options: {
    fast: boolean;
    refresh: number;
    onSnapshot: (snapshot: AgentSnapshot) => void;
  },
) {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const callback = useRef(options.onSnapshot);
  callback.current = options.onSnapshot;
  const generation = useRef(0);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError(null);
    setLoading(Boolean(sessionId));
    if (!sessionId) {
      setSnapshot(null);
      return;
    }
    const poll = async () => {
      let delay = options.fast ? 800 : 5000;
      try {
        const next = await agentApi.getSession(sessionId);
        if (disposed || generation.current !== requestGeneration) return;
        if (next.session.id !== sessionId) {
          throw new Error("会话内容与当前选择不一致，请重新加载。");
        }
        setSnapshot(next);
        setError(null);
        callback.current(next);
        if (next.status !== "idle") delay = 800;
      } catch (cause) {
        if (disposed || generation.current !== requestGeneration) return;
        setError(agentErrorMessage(cause));
        delay = 2000;
      } finally {
        if (!disposed && generation.current === requestGeneration) {
          setLoading(false);
          timer = setTimeout(() => void poll(), delay);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, options.fast, options.refresh]);

  return {
    snapshot: snapshot?.session.id === sessionId ? snapshot : null,
    error,
    loading,
  };
}
