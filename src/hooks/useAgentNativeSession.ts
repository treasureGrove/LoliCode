import { useCallback, useEffect, useRef, useState } from "react";
import {
  AssistantStreamAccumulator,
  expandAssistantStream,
  type AssistantStreamRecord,
  type TimedStreamChunk,
} from "@deepseek-ai/dsh-llm/assistant-stream";
import { agentApi } from "@/lib/api/agent";
import type {
  AgentNativeSessionRead,
  AgentNativeSessionWatchMessage,
  SessionAssistantStreamAttempt,
  SessionAssistantStreamFrame,
  SessionWireEvent,
} from "@/types/harness-session";

type RealtimeState = "history" | "connecting" | "live" | "paused" | "failed";
type NativeSessionView = {
  sessionId: string | null;
  events: SessionWireEvent[];
  read: AgentNativeSessionRead | null;
  cursor: number | undefined;
  historyCursor: number | undefined;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  realtime: RealtimeState;
  activeAttempt: SessionAssistantStreamAttempt | null;
  ready: boolean;
};
type Subscription = { id: string; revision: number; opened: boolean };
type NativeSessionOptions = {
  enabled?: boolean;
  activityRevision?: string | number | null;
};
type AssistantAttempt = {
  value: SessionAssistantStreamAttempt;
  stream: AssistantStreamAccumulator;
  settled: boolean;
};

const empty = (sessionId: string | null): NativeSessionView => ({
  sessionId,
  events: [],
  read: null,
  cursor: undefined,
  historyCursor: undefined,
  hasMore: false,
  loading: false,
  error: null,
  realtime: "history",
  activeAttempt: null,
  ready: false,
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
const contiguous = (events: readonly SessionWireEvent[]) =>
  events.every(
    (event, index) => index === 0 || event.seq === events[index - 1].seq + 1,
  );
function sameNativeValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameNativeValue(value, right[index]))
    );
  const first = left as Record<string, unknown>;
  const second = right as Record<string, unknown>;
  const keys = Object.keys(first);
  return (
    keys.length === Object.keys(second).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(second, key) &&
        sameNativeValue(first[key], second[key]),
    )
  );
}
/** Retain only a verified older prefix joined to the authoritative new window. */
function retainNativePrefix(
  previous: NativeSessionView,
  incoming: SessionWireEvent[],
  hasMore: boolean,
): { events: SessionWireEvent[]; hasMore: boolean } {
  const replacement = { events: incoming, hasMore };
  const old = previous.events;
  if (
    !previous.ready ||
    !hasMore ||
    !old.length ||
    !incoming.length ||
    !contiguous(old) ||
    !contiguous(incoming)
  )
    return replacement;
  const start = incoming[0].seq;
  const end = incoming.at(-1)!.seq;
  if (
    old[0].seq >= start ||
    old.at(-1)!.seq > end ||
    start > old.at(-1)!.seq + 1
  )
    return replacement;
  const bySeq = new Map(incoming.map((event) => [event.seq, event]));
  for (const event of old) {
    if (event.seq >= start && !sameNativeValue(event, bySeq.get(event.seq)))
      return replacement;
  }
  return {
    events: [...old.filter((event) => event.seq < start), ...incoming],
    hasMore: previous.hasMore,
  };
}
const hasOpenTurn = (events: readonly SessionWireEvent[]) => {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === "turn/start") return true;
    if (events[index].type === "turn/end") return false;
    if (
      events[index].type.startsWith("step/") ||
      events[index].type.startsWith("assistant/") ||
      events[index].type === "tool/call" ||
      events[index].type === "tool/result"
    )
      return true;
    // A user input admitted after the previous turn may still be waiting to
    // start; closing that connection is not a confirmed completed turn.
    const data = events[index].data;
    if (
      events[index].type === "user/message" &&
      data !== null &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      data.source !== null &&
      typeof data.source === "object" &&
      !Array.isArray(data.source) &&
      data.source.kind === "user"
    )
      return true;
  }
  return false;
};
const settlesAttempt = (
  event: SessionWireEvent,
  attempt: SessionAssistantStreamAttempt,
) => {
  const data = event.data;
  return (
    (event.type === "assistant/attempt" ||
      (event.type === "assistant/message" && event.surfaceOp === "append")) &&
    event.seq > attempt.startedAfterSeq &&
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    data.turn === attempt.turn &&
    data.step === attempt.step
  );
};

export function nativeSessionReadError(cause: unknown): string {
  const error = errorText(cause);
  if (oversized(cause))
    return "会话中的单条记录过大，暂时无法完整显示。原始记录仍然保留。";
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
export function useAgentNativeSession(
  sessionId: string | null,
  options: NativeSessionOptions = {},
) {
  const enabled = options.enabled ?? true;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const activity = useRef(options.activityRevision);
  activity.current = options.activityRevision;
  const observedActivity = useRef({
    sessionId,
    value: options.activityRevision,
  });
  const retryAfterOpening = useRef(false);
  const cache = useRef(new Map<string, NativeSessionView>());
  const [view, setView] = useState(() => empty(sessionId));
  const viewRef = useRef(view);
  viewRef.current = view;
  const selected = useRef(sessionId);
  selected.current = sessionId;
  const generation = useRef(0);
  const subscription = useRef<Subscription | null>(null);

  const publish = useCallback((next: NativeSessionView) => {
    if (next.sessionId && next.ready) {
      cache.current.delete(next.sessionId);
      cache.current.set(next.sessionId, {
        ...next,
        error: null,
        loading: false,
        realtime: "history",
        activeAttempt: null,
      });
      while (cache.current.size > 3) {
        const oldest = cache.current.keys().next().value;
        if (oldest === undefined) break;
        cache.current.delete(oldest);
      }
    }
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
        enabledRef.current &&
        generation.current === revision &&
        subscription.current === active;
      const fail = (cause: unknown) => {
        if (!current()) return;
        stop();
        publish({
          ...viewRef.current,
          realtime: "failed",
          activeAttempt: null,
          error: nativeSessionReadError(cause),
        });
      };
      let assistantRevision = 0;
      let attempt: AssistantAttempt | undefined;
      const acceptAssistant = (frame: SessionAssistantStreamFrame) => {
        // A resumed Agent has a fresh process-local assistant revision even
        // when its durable Session and this observation connection survive.
        if (
          frame.type === "start" &&
          frame.revision === 1 &&
          assistantRevision !== 0 &&
          attempt?.value.attemptId !== frame.attemptId
        ) {
          assistantRevision = 0;
          attempt = undefined;
        }
        if (frame.revision <= assistantRevision) return;
        if (frame.revision !== assistantRevision + 1)
          throw new Error("实时回复记录出现缺口，请重新连接。");
        assistantRevision = frame.revision;
        if (frame.type === "start") {
          if (attempt) throw new Error("实时回复缺少结束记录，请重新连接。");
          attempt = {
            value: {
              attemptId: frame.attemptId,
              startedAfterSeq: frame.startedAfterSeq,
              turn: frame.turn,
              step: frame.step,
              nextIndex: 0,
              stream: [],
            },
            stream: new AssistantStreamAccumulator(),
            settled: false,
          };
        } else if (!attempt || attempt.value.attemptId !== frame.attemptId) {
          // A suffix without a known opening is not enough to reconstruct an
          // attempt. Its durable settlement remains an ordinary native event.
          return;
        } else if (frame.index !== attempt.value.nextIndex) {
          throw new Error("实时回复片段不连续，请重新连接。");
        } else if (frame.type === "chunk") {
          attempt.stream.push({
            time: frame.time,
            chunk: frame.chunk as TimedStreamChunk["chunk"],
          });
          attempt.value = {
            ...attempt.value,
            nextIndex: frame.index + 1,
            stream:
              attempt.stream.snapshot() as unknown as SessionAssistantStreamAttempt["stream"],
          };
        } else {
          const outcome = frame.outcome;
          if (
            outcome.kind === "committed" &&
            !viewRef.current.events.some(
              (event) =>
                event.seq === outcome.seq && event.type === outcome.eventType,
            )
          )
            throw new Error("实时回复缺少对应的正式记录，请重新连接。");
          attempt = undefined;
        }
        publish({
          ...viewRef.current,
          activeAttempt: attempt && !attempt.settled ? attempt.value : null,
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
          const incoming = frame.records.map((record) => record.event);
          if (
            !contiguous(incoming) ||
            (incoming.length > 0
              ? incoming.at(-1)?.seq !== frame.cursor
              : frame.cursor !== -1)
          ) {
            fail("实时会话记录不连续，已保留原有记录。请重新连接。");
            return;
          }
          const { events, hasMore } = retainNativePrefix(
            previous,
            incoming,
            frame.hasMore,
          );
          assistantRevision = frame.assistantStream?.revision ?? 0;
          const opening = frame.assistantStream?.activeAttempt;
          attempt = undefined;
          if (opening) {
            try {
              const members = expandAssistantStream(
                opening.stream as unknown as readonly AssistantStreamRecord[],
              );
              if (
                members.length !== opening.nextIndex ||
                opening.startedAfterSeq > frame.cursor
              )
                throw new Error("实时回复起始记录不完整，请重新连接。");
              const stream = new AssistantStreamAccumulator();
              for (const member of members) stream.push(member);
              attempt = {
                value: opening,
                stream,
                settled: events.some((event) => settlesAttempt(event, opening)),
              };
            } catch (cause) {
              fail(cause);
              return;
            }
          }
          active.opened = true;
          publish({
            ...previous,
            events,
            cursor: frame.cursor,
            historyCursor: frame.cursor,
            hasMore: hasMore && frame.cursor >= 0 && events.length > 0,
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
            activeAttempt: attempt && !attempt.settled ? attempt.value : null,
            ready: true,
            error: null,
          });
          return;
        }
        if (!active.opened) {
          fail("实时连接缺少起始快照，请重新连接。");
          return;
        }
        if (frame.type === "assistant-stream") {
          try {
            acceptAssistant(frame.frame);
          } catch (cause) {
            fail(cause);
          }
          return;
        }
        const cursor = previous.cursor ?? -1;
        if (frame.event.seq <= cursor) return;
        if (frame.event.seq !== cursor + 1) {
          fail("实时会话记录出现缺口，已保留收到的记录。请重新连接。");
          return;
        }
        if (attempt && settlesAttempt(frame.event, attempt.value))
          attempt.settled = true;
        publish({
          ...previous,
          events: [...previous.events, frame.event],
          cursor: frame.event.seq,
          activeAttempt: attempt && !attempt.settled ? attempt.value : null,
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
          const completed =
            active.opened && !hasOpenTurn(viewRef.current.events);
          publish({
            ...viewRef.current,
            realtime: live && !completed ? "failed" : "history",
            activeAttempt: null,
            ready: live ? viewRef.current.ready : true,
            error:
              live && !completed
                ? "实时连接已结束，已保留收到的记录。可重新连接。"
                : null,
          });
        },
        (cause) => {
          if (!current()) {
            void agentApi.stopSessionNative(active.id).catch(() => {});
            return;
          }
          if (
            active.opened &&
            !hasOpenTurn(viewRef.current.events) &&
            /实时连接已结束|进程已断开/.test(errorText(cause))
          ) {
            subscription.current = null;
            publish({
              ...viewRef.current,
              realtime: "history",
              activeAttempt: null,
              error: null,
            });
            return;
          }
          fail(cause);
        },
      );
    },
    [publish, stop],
  );

  const load = useCallback(
    async (older: boolean, preservePrefix = false) => {
      const id = selected.current;
      if (!id || !enabledRef.current) return;
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
      if (!older) stop();
      const revision = older ? generation.current : ++generation.current;
      const historyCut = previous.historyCursor ?? previous.cursor;
      // Keep the previous successful window until a replacement succeeds.
      const basis = {
        ...previous,
        activeAttempt: older ? previous.activeAttempt : null,
      };
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
                    throughSeq: historyCut,
                  }
                : {}),
            });
            break;
          } catch (cause) {
            if (
              selected.current !== id ||
              generation.current !== revision ||
              !enabledRef.current
            )
              return;
            if (!oversized(cause) || pageSize === 1) throw cause;
            pageSize = Math.max(1, Math.floor(pageSize / 2));
          }
        }
        if (
          selected.current !== id ||
          generation.current !== revision ||
          !enabledRef.current
        )
          return;
        if (older && read.page.cursor !== historyCut)
          throw new Error("历史读取位置发生变化，请刷新会话后重试。");
        const current = older ? viewRef.current : basis;
        const eventsBySeq = new Map<number, SessionWireEvent>();
        if (older)
          for (const event of current.events) eventsBySeq.set(event.seq, event);
        for (const record of read.page.records)
          if (record.type === "event") {
            const held = eventsBySeq.get(record.event.seq);
            if (older && held && !sameNativeValue(held, record.event))
              throw new Error("历史记录内容已变化，请刷新会话后重试。");
            eventsBySeq.set(record.event.seq, record.event);
          }
        let events = [...eventsBySeq.values()].sort((a, b) => a.seq - b.seq);
        let hasMore = read.page.hasMore;
        if (!older && preservePrefix) {
          const retained = retainNativePrefix(previous, events, hasMore);
          events = retained.events;
          hasMore = retained.hasMore;
        }
        if (older && !contiguous(events))
          throw new Error("历史页面与当前记录不连续，请重试。");
        if (
          older &&
          read.page.hasMore &&
          (events[0]?.seq ?? Infinity) >= (previous.events[0]?.seq ?? Infinity)
        )
          throw new Error("历史读取没有前进，请刷新会话后重试。");
        publish({
          ...current,
          events,
          read,
          cursor: older ? current.cursor : read.page.cursor,
          historyCursor: older ? current.historyCursor : read.page.cursor,
          hasMore: hasMore && read.page.cursor >= 0 && events.length > 0,
          loading: false,
          ready: true,
          error: null,
          realtime: older ? current.realtime : "connecting",
        });
        if (!older) watch(id, revision, pageSize);
      } catch (cause) {
        if (
          selected.current !== id ||
          generation.current !== revision ||
          !enabledRef.current
        )
          return;
        if (
          !older &&
          (errorText(cause).includes("LOLICODE_SESSION_LOG_MISSING") ||
            errorText(cause).includes("会话尚未形成原生 Harness 日志"))
        ) {
          publish({
            ...basis,
            loading: false,
            error: null,
            realtime: "connecting",
          });
          // An authorized resident root may already have a native in-memory
          // journal before its first prompt creates a JSONL file.
          watch(id, revision, 12);
          return;
        }
        const current = older ? viewRef.current : basis;
        publish({
          ...current,
          loading: false,
          error: nativeSessionReadError(cause),
          realtime: older ? current.realtime : "failed",
        });
      }
    },
    [publish, stop, watch],
  );

  useEffect(() => {
    generation.current++;
    stop();
    retryAfterOpening.current = false;
    observedActivity.current = { sessionId, value: activity.current };
    const previous = viewRef.current;
    const basis =
      previous.sessionId === sessionId
        ? previous
        : (sessionId && cache.current.get(sessionId)) || empty(sessionId);
    if (previous.sessionId !== sessionId) publish(basis);
    if (sessionId && enabled) void load(false, true);
    else if (sessionId)
      publish({
        ...basis,
        loading: false,
        realtime: "paused",
        activeAttempt: null,
      });
    return () => {
      generation.current++;
      stop();
    };
  }, [sessionId, enabled, load, publish, stop]);

  useEffect(() => {
    const previous = observedActivity.current;
    observedActivity.current = { sessionId, value: options.activityRevision };
    if (
      !enabled ||
      !sessionId ||
      previous.sessionId !== sessionId ||
      previous.value === options.activityRevision
    )
      return;
    const current = viewRef.current;
    if (current.realtime === "live" || current.realtime === "paused") return;
    if (current.loading || current.realtime === "connecting") {
      retryAfterOpening.current = true;
      return;
    }
    void load(false, true);
  }, [sessionId, enabled, options.activityRevision, load]);

  useEffect(() => {
    if (
      !retryAfterOpening.current ||
      !enabled ||
      !sessionId ||
      view.loading ||
      view.realtime === "connecting"
    )
      return;
    retryAfterOpening.current = false;
    if (view.realtime !== "live" && view.realtime !== "paused")
      void load(false, true);
  }, [sessionId, enabled, view.loading, view.realtime, load]);

  const visible =
    view.sessionId === sessionId
      ? view
      : (sessionId && cache.current.get(sessionId)) || empty(sessionId);
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
        activeAttempt: null,
      });
    },
  };
}
