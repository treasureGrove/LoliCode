import { useCallback, useEffect, useRef, useState } from "react";
import { agentApi } from "@/lib/api/agent";
import type {
  AgentNativeSessionRead,
  AgentNativeSessionWatchMessage,
  SessionWireEvent,
} from "@/types/harness-session";

type RealtimeState = "history" | "connecting" | "live" | "paused" | "failed";
type NativeSessionView = {
  sessionId: string | null;
  events: SessionWireEvent[];
  read: AgentNativeSessionRead | null;
  cursor: number | undefined;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  realtime: RealtimeState;
};
type Subscription = { id: string; revision: number; opened: boolean };

const empty = (sessionId: string | null): NativeSessionView => ({
  sessionId,
  events: [],
  read: null,
  cursor: undefined,
  hasMore: false,
  loading: false,
  error: null,
  realtime: "history",
});
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause ?? "");
const oversized = (cause: unknown) => {
  const text = errorText(cause);
  return (
    text.includes("LOLICODE_SESSION_NATIVE_TOO_LARGE") ||
    text.includes("原生会话页面超过 8 MiB")
  );
};

export function nativeSessionReadError(cause: unknown): string {
  const error = errorText(cause);
  if (oversized(cause))
    return "会话中的单条记录过大，暂时无法完整预览。原始记录仍然保留。";
  if (
    error.includes("LOLICODE_SESSION_LOG_MISSING") ||
    error.includes("会话尚未形成原生 Harness 日志")
  )
    return "这次会话还没有可读取的原生记录。";
  if (error.includes("LOLICODE_SESSION_LOG_COLD"))
    return "会话暂时不可读取，请稍后重试。";
  return error.trim().slice(0, 500) || "会话读取失败，请重试。";
}

/** Passive reads and subscription; transient frames never become durable rows. */
export function useAgentNativeSession(sessionId: string | null) {
  const [view, setView] = useState(() => empty(sessionId));
  const viewRef = useRef(view);
  viewRef.current = view;
  const selected = useRef(sessionId);
  selected.current = sessionId;
  const generation = useRef(0);
  const subscription = useRef<Subscription | null>(null);

  const publish = useCallback((next: NativeSessionView) => {
    viewRef.current = next;
    setView(next);
  }, []);
  const stop = useCallback(() => {
    const previous = subscription.current;
    subscription.current = null;
    if (previous) void agentApi.stopSessionNative(previous.id).catch(() => {});
  }, []);

  const watch = useCallback(
    (id: string, revision: number, maxMessages: number) => {
      const active: Subscription = {
        id: crypto.randomUUID(),
        revision,
        opened: false,
      };
      subscription.current = active;
      const current = () =>
        selected.current === id &&
        generation.current === revision &&
        subscription.current === active;
      const fail = (cause: unknown) => {
        if (!current()) return;
        stop();
        publish({
          ...viewRef.current,
          realtime: "failed",
          error: nativeSessionReadError(cause),
        });
      };
      const accept = (message: AgentNativeSessionWatchMessage) => {
        if (!current()) {
          // Startup may have reached the backend after the first stop request.
          void agentApi.stopSessionNative(active.id).catch(() => {});
          return;
        }
        if (message.subscriptionId !== active.id) return;
        if ("error" in message) {
          fail(message.error);
          return;
        }
        const frame = message.frame;
        const previous = viewRef.current;
        if (frame.type === "snapshot") {
          if (active.opened) {
            fail("实时连接收到重复的起始快照，请重新连接。");
            return;
          }
          if (frame.header.id !== id.slice(3)) {
            fail("实时记录不属于当前会话，请重新连接。");
            return;
          }
          const events = frame.records.map((record) => record.event);
          if (
            events.some(
              (event, index) =>
                index > 0 && event.seq !== events[index - 1].seq + 1,
            ) ||
            (events.length > 0
              ? events.at(-1)?.seq !== frame.cursor
              : frame.cursor !== -1)
          ) {
            fail("实时会话记录不连续，已保留原有记录。请重新连接。");
            return;
          }
          active.opened = true;
          publish({
            ...previous,
            events,
            cursor: frame.cursor,
            hasMore: frame.hasMore && frame.cursor >= 0 && events.length > 0,
            read: previous.read
              ? {
                  ...previous.read,
                  page: {
                    records: frame.records,
                    cursor: frame.cursor,
                    hasMore: frame.hasMore,
                  },
                  projections: { kind: "sequenced", ...frame.projections },
                }
              : null,
            realtime: "live",
            error: null,
          });
          return;
        }
        if (!active.opened) {
          fail("实时连接缺少起始快照，请重新连接。");
          return;
        }
        // The passive preview displays only committed records. Keep transient
        // upstream frames out of the durable timeline if one arrives.
        if (frame.type === "assistant-stream") return;
        const cursor = previous.cursor ?? -1;
        if (frame.event.seq <= cursor) return;
        if (frame.event.seq !== cursor + 1) {
          fail("实时会话记录出现缺口，已保留收到的记录。请重新连接。");
          return;
        }
        publish({
          ...previous,
          events: [...previous.events, frame.event],
          cursor: frame.event.seq,
        });
      };
      let pending: Promise<boolean>;
      try {
        pending = agentApi.watchSessionNative(id, active.id, accept, {
          maxMessages,
        });
      } catch (cause) {
        fail(cause);
        return;
      }
      void pending.then(
        (live) => {
          if (!current()) {
            // Also covers cancellation arriving before the backend registers startup.
            void agentApi.stopSessionNative(active.id).catch(() => {});
            return;
          }
          subscription.current = null;
          publish({
            ...viewRef.current,
            realtime: live ? "failed" : "history",
            error: live
              ? "实时连接已结束，已保留收到的记录。可重新连接。"
              : null,
          });
        },
        (cause) => {
          if (!current()) {
            void agentApi.stopSessionNative(active.id).catch(() => {});
            return;
          }
          fail(cause);
        },
      );
    },
    [publish, stop],
  );

  const load = useCallback(
    async (older: boolean) => {
      const id = selected.current;
      if (!id) return;
      const previous =
        viewRef.current.sessionId === id ? viewRef.current : empty(id);
      if (
        older &&
        (!previous.hasMore ||
          previous.loading ||
          previous.cursor === undefined ||
          previous.cursor < 0 ||
          !previous.events.length ||
          subscription.current)
      )
        return;
      if (!older) stop();
      const revision = ++generation.current;
      // Keep the previous successful window until a replacement succeeds.
      const basis = { ...previous };
      publish({
        ...basis,
        loading: true,
        error: null,
        realtime: older ? previous.realtime : "connecting",
      });
      try {
        let read: AgentNativeSessionRead;
        let pageSize = 12;
        for (;;) {
          try {
            read = await agentApi.readSessionNative(id, {
              maxMessages: pageSize,
              ...(older
                ? {
                    beforeSeq: previous.events[0]?.seq,
                    throughSeq: previous.cursor,
                  }
                : {}),
            });
            break;
          } catch (cause) {
            if (selected.current !== id || generation.current !== revision)
              return;
            if (!oversized(cause) || pageSize === 1) throw cause;
            pageSize = Math.max(1, Math.floor(pageSize / 2));
          }
        }
        if (selected.current !== id || generation.current !== revision) return;
        if (older && read.page.cursor !== previous.cursor)
          throw new Error("历史读取位置发生变化，请刷新会话后重试。");
        const eventsBySeq = new Map<number, SessionWireEvent>();
        if (older)
          for (const event of previous.events)
            eventsBySeq.set(event.seq, event);
        for (const record of read.page.records)
          if (record.type === "event")
            eventsBySeq.set(record.event.seq, record.event);
        const events = [...eventsBySeq.values()].sort((a, b) => a.seq - b.seq);
        if (
          older &&
          read.page.hasMore &&
          (events[0]?.seq ?? Infinity) >= (previous.events[0]?.seq ?? Infinity)
        )
          throw new Error("历史读取没有前进，请刷新会话后重试。");
        publish({
          ...basis,
          events,
          read,
          cursor: older ? previous.cursor : read.page.cursor,
          hasMore:
            read.page.hasMore && read.page.cursor >= 0 && events.length > 0,
          loading: false,
          error: null,
          realtime: older ? previous.realtime : "connecting",
        });
        if (!older) watch(id, revision, pageSize);
      } catch (cause) {
        if (selected.current !== id || generation.current !== revision) return;
        publish({
          ...basis,
          loading: false,
          error: nativeSessionReadError(cause),
          realtime: older ? basis.realtime : "failed",
        });
      }
    },
    [publish, stop, watch],
  );

  useEffect(() => {
    generation.current++;
    stop();
    publish(empty(sessionId));
    if (sessionId) void load(false);
    return () => {
      generation.current++;
      stop();
    };
  }, [sessionId, load, publish, stop]);

  const visible = view.sessionId === sessionId ? view : empty(sessionId);
  return {
    ...visible,
    refresh: () => load(false),
    loadOlder: () => load(true),
    pauseRealtime: () => {
      generation.current++;
      stop();
      publish({
        ...viewRef.current,
        realtime: "paused",
        loading: false,
      });
    },
  };
}
