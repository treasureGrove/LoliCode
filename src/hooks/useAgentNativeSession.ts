import { useCallback, useEffect, useRef, useState } from "react";
import { agentApi } from "@/lib/api/agent";
import type {
  AgentNativeSessionRead,
  SessionWireEvent,
} from "@/types/harness-session";

type NativeSessionView = {
  sessionId: string | null;
  events: SessionWireEvent[];
  read: AgentNativeSessionRead | null;
  cursor: number | undefined;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
};

const empty = (sessionId: string | null): NativeSessionView => ({
  sessionId,
  events: [],
  read: null,
  cursor: undefined,
  hasMore: false,
  loading: false,
  error: null,
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

/** Passive, discrete reads; committed events stay in the upstream wire shape. */
export function useAgentNativeSession(sessionId: string | null) {
  const [view, setView] = useState(() => empty(sessionId));
  const viewRef = useRef(view);
  viewRef.current = view;
  const selected = useRef(sessionId);
  selected.current = sessionId;
  const generation = useRef(0);

  const load = useCallback(async (older: boolean) => {
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
        !previous.events.length)
    )
      return;
    const revision = ++generation.current;
    const basis = older ? previous : empty(id);
    const loading = { ...basis, loading: true, error: null };
    viewRef.current = loading;
    setView(loading);
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
      for (const event of basis.events) eventsBySeq.set(event.seq, event);
      for (const record of read.page.records) {
        if (record.type === "event")
          eventsBySeq.set(record.event.seq, record.event);
      }
      const events = [...eventsBySeq.values()].sort((a, b) => a.seq - b.seq);
      if (
        older &&
        read.page.hasMore &&
        (events[0]?.seq ?? Infinity) >= (previous.events[0]?.seq ?? Infinity)
      ) {
        throw new Error("历史读取没有前进，请刷新会话后重试。");
      }
      const next: NativeSessionView = {
        sessionId: id,
        events,
        read,
        cursor: older ? previous.cursor : read.page.cursor,
        hasMore:
          read.page.hasMore && read.page.cursor >= 0 && events.length > 0,
        loading: false,
        error: null,
      };
      viewRef.current = next;
      setView(next);
    } catch (cause) {
      if (selected.current !== id || generation.current !== revision) return;
      const failed = {
        ...basis,
        loading: false,
        error: nativeSessionReadError(cause),
      };
      viewRef.current = failed;
      setView(failed);
    }
  }, []);

  useEffect(() => {
    generation.current++;
    const reset = empty(sessionId);
    viewRef.current = reset;
    setView(reset);
    if (sessionId) void load(false);
    return () => {
      generation.current++;
    };
  }, [sessionId, load]);

  const visible = view.sessionId === sessionId ? view : empty(sessionId);
  return {
    ...visible,
    refresh: () => load(false),
    loadOlder: () => load(true),
  };
}
