import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
type CachedSession = {
  snapshot: AgentSnapshot | null;
  tail: StreamTail | null;
  error: string | null;
  lastRead: number;
  revision: number;
  readRevision: number;
  prefetched?: boolean;
};
const CACHE_LIMIT = 6;
const CHANGE_DELAY = 40;
export const AGENT_PREPARED_SESSION_LIMIT = 3;

function cacheSession(
  sessions: Map<string, CachedSession>,
  id: string,
  selected?: string,
) {
  const entry = sessions.get(id) ?? {
    snapshot: null,
    tail: null,
    error: null,
    lastRead: 0,
    revision: 0,
    readRevision: -1,
  };
  sessions.delete(id);
  sessions.set(id, entry);
  if (sessions.size > CACHE_LIMIT) {
    const keys = sessions.keys();
    const first = keys.next().value;
    const oldest = first === selected ? keys.next().value : first;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  return entry;
}

function streamTailMode(snapshot: AgentSnapshot, stream: StreamTail) {
  if (snapshot.status !== "running" || snapshot.session.id !== stream.sessionId)
    return undefined;
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
      return undefined;
    return "replace";
  }
  return (last?.id ?? null) === stream.previousMessageId ? "append" : undefined;
}

function withStreamTail(snapshot: AgentSnapshot, stream: StreamTail) {
  const mode = streamTailMode(snapshot, stream);
  if (!mode) return snapshot;
  const messages = snapshot.messages.slice();
  if (mode === "replace") messages[messages.length - 1] = stream.message;
  else messages.push(stream.message);
  return {
    ...snapshot,
    modelPhase: "streaming" as const,
    messages,
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
    /** Native transcript owns transient frames; this hook supplies desktop controls. */
    nativeTranscript?: boolean;
  },
) {
  const cache = useRef(new Map<string, CachedSession>());
  const [, setRevision] = useState(0);
  const [preparedSnapshots, setPreparedSnapshots] = useState<AgentSnapshot[]>(
    [],
  );
  const callback = useRef(options.onSnapshot);
  callback.current = options.onSnapshot;
  const active = useRef<{ id: string; invalidate: () => void }>();
  const prefetching = useRef<{
    entry: CachedSession;
    revision: number;
    read: Promise<AgentSnapshot>;
  }>();
  const previousSelection = useRef<{
    id: string | null;
    fast: boolean;
    refresh: number;
  }>();
  const { fast, refresh, nativeTranscript = false } = options;

  // Warm one likely destination at a time. A click during the read can adopt
  // it, and background results never update the selected conversation.
  const prefetch = useCallback((id: string) => {
    const sessions = cache.current;
    if (
      prefetching.current ||
      active.current?.id === id ||
      sessions.get(id)?.snapshot
    )
      return;
    const entry = cacheSession(sessions, id, active.current?.id);
    const revision = entry.revision;
    const read = Promise.resolve().then(() => agentApi.getSession(id));
    prefetching.current = { entry, revision, read };
    return read
      .then(
        (snapshot) => {
          if (
            snapshot.session.id === id &&
            sessions.get(id) === entry &&
            active.current?.id !== id &&
            entry.revision === revision
          ) {
            entry.snapshot = snapshot;
            entry.error = null;
            entry.lastRead = Date.now();
            entry.readRevision = revision;
            entry.prefetched = true;
            startTransition(() => {
              setPreparedSnapshots((current) =>
                [
                  ...current.filter((item) => item.session.id !== id),
                  snapshot,
                ].slice(-AGENT_PREPARED_SESSION_LIMIT),
              );
            });
          }
        },
        () => {},
      )
      .finally(() => {
        prefetching.current = undefined;
      });
  }, []);

  useTauriEvent<SessionUpdate>(
    "agent-session-update",
    (update) => {
      const entry = cache.current.get(update.sessionId);
      if (!entry) return;
      const selected =
        active.current?.id === update.sessionId ? active.current : null;
      if (entry.prefetched && !selected) {
        entry.snapshot = null;
        entry.prefetched = false;
        setPreparedSnapshots((current) =>
          current.filter((item) => item.session.id !== update.sessionId),
        );
      }
      if (update.type === "tail") {
        if (nativeTranscript && selected) return;
        entry.tail = update;
        if (selected) setRevision((value) => value + 1);
        else entry.revision += 1;
      } else {
        entry.revision += 1;
        selected?.invalidate();
      }
    },
    "main",
  );

  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { id: sessionId, fast, refresh };
    if (!sessionId) return;

    const entry = cacheSession(cache.current, sessionId);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let refreshRequested = false;
    let deferredRead = false;
    const shouldDeferRead = (requestedRevision: number) => {
      const defer = Boolean(
        entry.snapshot && requestedRevision !== entry.revision && !deferredRead,
      );
      deferredRead = defer;
      return defer;
    };
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      reading = true;
      refreshRequested = false;
      const requestedRevision = entry.revision;
      const requestedTail = entry.tail;
      let delay = fast ? 800 : 5000;
      try {
        const pending = prefetching.current;
        const next = await (pending?.entry === entry &&
        pending.revision === requestedRevision
          ? pending.read
          : agentApi.getSession(sessionId));
        if (disposed) return;
        if (next.session.id !== sessionId) {
          throw new Error("会话内容与当前选择不一致，请重新加载。");
        }
        const cached = entry.snapshot;
        // Prefer a read after the latest event, but publish every second read
        // if a busy agent keeps changing before any full IPC can finish.
        if (shouldDeferRead(requestedRevision)) return;
        const shared = cached
          ? (shareSnapshotValue(cached, next) as AgentSnapshot)
          : next;
        const oldTail = entry.tail;
        if (
          oldTail &&
          oldTail === requestedTail &&
          requestedRevision === entry.revision &&
          !streamTailMode(shared, oldTail)
        ) {
          entry.tail = null;
        }
        const changed =
          shared !== cached || entry.tail !== oldTail || entry.error !== null;
        entry.snapshot = shared;
        entry.error = null;
        entry.lastRead = Date.now();
        entry.readRevision = requestedRevision;
        if (changed) setRevision((value) => value + 1);
        callback.current(shared);
        if (
          isActive(shared) ||
          (shared.status === "error" && shared !== cached)
        ) {
          delay = 800;
        }
      } catch (cause) {
        if (disposed || shouldDeferRead(requestedRevision)) return;
        const error = agentErrorMessage(cause);
        if (entry.error !== error) {
          entry.error = error;
          setRevision((value) => value + 1);
        }
        delay = 2000;
      } finally {
        reading = false;
        if (!disposed) schedule(refreshRequested ? CHANGE_DELAY : delay);
      }
    };
    active.current = {
      id: sessionId,
      invalidate: () => {
        if (refreshRequested) return;
        refreshRequested = true;
        if (!reading) schedule(CHANGE_DELAY);
      },
    };
    const explicit =
      previous && (previous.refresh !== refresh || (fast && !previous.fast));
    if (entry.prefetched && entry.snapshot) {
      entry.prefetched = false;
      if (entry.readRevision === entry.revision)
        callback.current(entry.snapshot);
      setPreparedSnapshots((current) =>
        current.filter((item) => item.session.id !== sessionId),
      );
      setRevision((value) => value + 1);
    }
    if (!entry.snapshot || (explicit && previous.id === sessionId)) {
      void poll();
    } else {
      const delay = fast || isActive(entry.snapshot) ? 800 : 5000;
      const due =
        explicit || entry.error || entry.readRevision !== entry.revision
          ? CHANGE_DELAY
          : Math.max(CHANGE_DELAY, entry.lastRead + delay - Date.now());
      schedule(due);
    }
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      active.current = undefined;
    };
  }, [sessionId, fast, refresh]);

  const cached = sessionId ? cache.current.get(sessionId) : undefined;
  const snapshot = cached?.snapshot ?? null;
  const tail = cached?.tail ?? null;
  const error = cached?.error ?? null;
  const displayed = useMemo(() => {
    return snapshot && tail && !nativeTranscript
      ? withStreamTail(snapshot, tail)
      : snapshot;
  }, [snapshot, tail, nativeTranscript]);

  return {
    snapshot: displayed,
    error,
    loading: Boolean(sessionId && !snapshot && !error),
    prefetch,
    preparedSnapshots,
  };
}
