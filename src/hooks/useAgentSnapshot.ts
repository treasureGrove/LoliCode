import { useEffect, useMemo, useRef, useState } from "react";
import { agentApi } from "@/lib/api/agent";
import type { AgentMessage, AgentSnapshot } from "@/types/agent";
import { useTauriEvent } from "@/hooks/useTauriEvent";

type StreamTail = {
  type: "tail";
  sessionId: string;
  previousMessageId: string | null;
  message: AgentMessage;
};
type SessionUpdate = StreamTail | { type: "changed"; sessionId: string };

function withStreamTail(snapshot: AgentSnapshot, stream: StreamTail) {
  if (snapshot.status !== "running" || snapshot.session.id !== stream.sessionId)
    return snapshot;
  const last = snapshot.messages.at(-1);
  if (last?.id === stream.message.id) {
    // A read started before this event may have completed after it. Do not
    // replace a more advanced snapshot with an older accumulated tail.
    if (
      last.parts.some((part, index) => {
        const streamed = stream.message.parts[index];
        return (
          "text" in part &&
          (!streamed ||
            ("text" in streamed && part.text.length > streamed.text.length))
        );
      })
    )
      return snapshot;
    return {
      ...snapshot,
      modelPhase: "streaming" as const,
      messages: [...snapshot.messages.slice(0, -1), stream.message],
    };
  }
  if ((last?.id ?? null) !== stream.previousMessageId) return snapshot;
  return {
    ...snapshot,
    modelPhase: "streaming" as const,
    messages: [...snapshot.messages, stream.message],
  };
}

export function agentErrorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause ?? "");
  return text.trim().slice(0, 500) || "操作没有完成，请重试。";
}

// IPC returns a fresh JSON tree on each poll. Reuse unchanged messages and
// other subtrees so a streaming tail does not rerender the entire transcript.
function shareSnapshotValue(before: unknown, next: unknown): unknown {
  if (Object.is(before, next)) return before;
  if (Array.isArray(before) && Array.isArray(next)) {
    let same = before.length === next.length;
    const shared = next.map((value, index) => {
      const entry = shareSnapshotValue(before[index], value);
      same &&= Object.is(entry, before[index]);
      return entry;
    });
    return same ? before : shared;
  }
  if (
    before &&
    next &&
    typeof before === "object" &&
    typeof next === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(next)
  ) {
    const previous = before as Record<string, unknown>;
    const entries = Object.entries(next);
    let same = Object.keys(previous).length === entries.length;
    const shared = entries.map(([key, value]) => {
      const hasKey = Object.prototype.hasOwnProperty.call(previous, key);
      const entry = hasKey ? shareSnapshotValue(previous[key], value) : value;
      same &&= hasKey && Object.is(entry, previous[key]);
      return [key, entry] as const;
    });
    return same ? before : Object.fromEntries(shared);
  }
  return next;
}

function isActive(snapshot: AgentSnapshot) {
  return (
    snapshot.status === "running" ||
    snapshot.status === "waiting_permission" ||
    snapshot.status === "waiting_question" ||
    snapshot.titlePending ||
    snapshot.compacting
  );
}

/** Harness publishes the live tail separately; serial snapshots recover missed updates. */
export function useAgentSnapshot(
  sessionId: string | null,
  options: {
    fast: boolean;
    refresh: number;
    onSnapshot: (snapshot: AgentSnapshot) => void;
  },
) {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [stream, setStream] = useState<StreamTail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const callback = useRef(options.onSnapshot);
  callback.current = options.onSnapshot;
  const generation = useRef(0);
  const lastSnapshot = useRef<AgentSnapshot | null>(null);
  const receive = useRef<(update: SessionUpdate) => void>();
  useTauriEvent<SessionUpdate>(
    "agent-session-update",
    (update) => receive.current?.(update),
    "main",
  );

  useEffect(() => setStream(null), [sessionId]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let refreshRequested = false;
    let tailVersion = 0;
    setError(null);
    setLoading(Boolean(sessionId));
    if (!sessionId) {
      lastSnapshot.current = null;
      setSnapshot(null);
      return;
    }
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      reading = true;
      refreshRequested = false;
      const requestedTailVersion = tailVersion;
      let delay = options.fast ? 800 : 5000;
      try {
        const next = await agentApi.getSession(sessionId);
        if (disposed || generation.current !== requestGeneration) return;
        if (next.session.id !== sessionId) {
          throw new Error("会话内容与当前选择不一致，请重新加载。");
        }
        const previous = lastSnapshot.current;
        const shared =
          previous?.session.id === sessionId
            ? (shareSnapshotValue(previous, next) as AgentSnapshot)
            : next;
        if (shared !== previous) {
          lastSnapshot.current = shared;
          setSnapshot(shared);
        }
        if (requestedTailVersion === tailVersion) setStream(null);
        setError(null);
        callback.current(shared);
        if (
          isActive(shared) ||
          (shared.status === "error" && shared !== previous)
        ) {
          delay = 800;
        }
      } catch (cause) {
        if (disposed || generation.current !== requestGeneration) return;
        setError(agentErrorMessage(cause));
        delay = 2000;
      } finally {
        reading = false;
        if (!disposed && generation.current === requestGeneration) {
          setLoading(false);
          schedule(refreshRequested ? 40 : delay);
        }
      }
    };
    receive.current = (update) => {
      if (disposed || update.sessionId !== sessionId) return;
      if (update.type === "tail") {
        tailVersion += 1;
        setStream(update);
      } else if (!refreshRequested) {
        refreshRequested = true;
        if (!reading) schedule(40);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      receive.current = undefined;
    };
  }, [sessionId, options.fast, options.refresh]);

  const displayed = useMemo(() => {
    if (!snapshot || snapshot.session.id !== sessionId) return null;
    return stream ? withStreamTail(snapshot, stream) : snapshot;
  }, [snapshot, stream, sessionId]);

  return {
    snapshot: displayed,
    error,
    loading,
  };
}
