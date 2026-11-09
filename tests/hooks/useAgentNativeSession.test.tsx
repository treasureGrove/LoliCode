import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { agentApi } from "@/lib/api/agent";
import { useAgentNativeSession } from "@/hooks/useAgentNativeSession";
import type {
  AgentNativeSessionRead,
  AgentNativeSessionWatchMessage,
  SessionAssistantStreamAttempt,
  SessionWireEvent,
} from "@/types/harness-session";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    readSessionNative: vi.fn(),
    watchSessionNative: vi.fn(),
    stopSessionNative: vi.fn(),
  },
}));

const event = (seq: number, text = `message-${seq}`): SessionWireEvent => ({
  seq,
  time: seq + 1,
  type: "user/message",
  data: {
    id: String(seq),
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text }],
  },
  surfaceOp: "append",
});
function response(
  events: SessionWireEvent[],
  hasMore = false,
  cursor = 10,
): AgentNativeSessionRead {
  return {
    page: {
      records: events.map((value) => ({ type: "event", event: value })),
      hasMore,
      cursor,
    },
    projections: { kind: "sequenced", asOfSeq: cursor + 2, values: {} },
    state: {
      cursor: cursor + 2,
      active: false,
      running: false,
      queue: null,
      pendingInput: [],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.mocked(agentApi.readSessionNative).mockReset();
  vi.mocked(agentApi.watchSessionNative).mockReset().mockResolvedValue(false);
  vi.mocked(agentApi.stopSessionNative)
    .mockReset()
    .mockResolvedValue(undefined);
});

it("pins backward paging to the first history cut, retains native records, and deduplicates seqs", async () => {
  const native = event(8);
  const futureProjection = response([native, event(9)], true, 10);
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(futureProjection)
    .mockResolvedValueOnce(
      response(
        Array.from({ length: 6 }, (_, index) => event(index + 3)),
        false,
        10,
      ),
    );
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  expect(result.current.events[0]).toBe(native);
  await act(async () => {
    await result.current.loadOlder();
  });
  expect(agentApi.readSessionNative).toHaveBeenLastCalledWith("lc:first", {
    maxMessages: 12,
    beforeSeq: 8,
    throughSeq: 10,
  });
  expect(result.current.events.map(({ seq }) => seq)).toEqual([
    3, 4, 5, 6, 7, 8, 9,
  ]);
  expect(result.current.cursor).toBe(10);
  expect(result.current.read?.projections).toEqual({
    kind: "sequenced",
    asOfSeq: 12,
    values: {},
  });
  expect(result.current.hasMore).toBe(false);
});

it("discards a previous session's late response and clears its content immediately on selection", async () => {
  const old = deferred<AgentNativeSessionRead>();
  vi.mocked(agentApi.readSessionNative)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(response([event(5, "new-session")]));
  const { result, rerender } = renderHook(
    ({ id }) => useAgentNativeSession(id),
    { initialProps: { id: "lc:old" } },
  );
  rerender({ id: "lc:new" });
  expect(result.current.events).toEqual([]);
  await act(async () => {});
  await act(async () => {
    old.resolve(response([event(1, "old-session")]));
  });
  expect(result.current.sessionId).toBe("lc:new");
  expect(result.current.events).toEqual([event(5, "new-session")]);
});

it("a refresh supersedes an in-flight older page and starts a fresh cut", async () => {
  const older = deferred<AgentNativeSessionRead>();
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(8)], true, 10))
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce(response([event(15)], false, 20));
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.loadOlder();
  });
  await act(async () => {
    await result.current.refresh();
  });
  await act(async () => {
    older.resolve(response([event(1)], false, 10));
    await pending;
  });
  expect(result.current.events).toEqual([event(15)]);
  expect(result.current.cursor).toBe(20);
  expect(agentApi.readSessionNative).toHaveBeenLastCalledWith("lc:first", {
    maxMessages: 12,
  });
});

it("does not read while closed and exposes a retryable read failure", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockRejectedValueOnce(new Error("fixture read failed"))
    .mockResolvedValueOnce(response([event(1)]));
  const { result, rerender } = renderHook(
    ({ id }) => useAgentNativeSession(id),
    { initialProps: { id: null as string | null } },
  );
  await act(async () => {});
  expect(agentApi.readSessionNative).not.toHaveBeenCalled();
  rerender({ id: "lc:first" });
  await act(async () => {});
  expect(result.current.error).toContain("fixture read failed");
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.error).toBeNull();
  expect(result.current.events).toEqual([event(1)]);
});

it("rejects a non-progressing page without discarding the loaded transcript", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(8)], true))
    .mockResolvedValueOnce(response([event(8)], true));
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  await act(async () => {
    await result.current.loadOlder();
  });
  expect(result.current.events).toEqual([event(8)]);
  expect(result.current.error).toContain("历史读取没有前进");
});

it("reduces an oversized page without truncating records or retrying unboundedly", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockRejectedValueOnce("LOLICODE_SESSION_NATIVE_TOO_LARGE")
    .mockRejectedValueOnce("LOLICODE_SESSION_NATIVE_TOO_LARGE")
    .mockResolvedValueOnce(response([event(8)]));
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  expect(
    vi
      .mocked(agentApi.readSessionNative)
      .mock.calls.map(([, options]) => options?.maxMessages),
  ).toEqual([12, 6, 3]);
  expect(result.current.events).toEqual([event(8)]);
  expect(agentApi.watchSessionNative).toHaveBeenCalledWith(
    "lc:first",
    expect.any(String),
    expect.any(Function),
    { maxMessages: 3 },
  );
});

it("rejects a page from a different history cut", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(8)], true, 10))
    .mockResolvedValueOnce(response([event(3)], false, 20));
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  await act(async () => {
    await result.current.loadOlder();
  });
  expect(result.current.events).toEqual([event(8)]);
  expect(result.current.error).toContain("历史读取位置发生变化");
});

it("stops at one-message pages when an individual event exceeds the read limit", async () => {
  vi.mocked(agentApi.readSessionNative).mockRejectedValue(
    new Error("LOLICODE_SESSION_NATIVE_TOO_LARGE"),
  );
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  expect(
    vi
      .mocked(agentApi.readSessionNative)
      .mock.calls.map(([, options]) => options?.maxMessages),
  ).toEqual([12, 6, 3, 1]);
  expect(result.current.error).toContain("单条记录过大");
  expect(result.current.events).toEqual([]);
});

it("accepts the empty-log cursor without passing a negative paging position", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValueOnce(
    response([], false, -1),
  );
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  await act(async () => {
    await result.current.loadOlder();
  });
  expect(result.current.cursor).toBe(-1);
  expect(result.current.hasMore).toBe(false);
  expect(result.current.error).toBeNull();
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
});

it("also reduces page size for the desktop's localized size-limit error", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockRejectedValueOnce("原生会话页面超过 8 MiB，请缩小读取范围")
    .mockResolvedValueOnce(response([event(8)]));
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  expect(
    vi
      .mocked(agentApi.readSessionNative)
      .mock.calls.map(([, options]) => options?.maxMessages),
  ).toEqual([12, 6]);
  expect(result.current.events).toEqual([event(8)]);
});

type WatchFrame = Extract<
  AgentNativeSessionWatchMessage,
  { frame: unknown }
>["frame"];
function liveSubscriptions() {
  const subscriptions: Array<{
    id: string;
    sessionId: string;
    send: (frame: WatchFrame) => void;
    error: (message: string) => void;
    done: ReturnType<typeof deferred<boolean>>;
  }> = [];
  vi.mocked(agentApi.watchSessionNative).mockImplementation(
    (sessionId, id, accept) => {
      const done = deferred<boolean>();
      subscriptions.push({
        id,
        sessionId,
        done,
        send: (frame) => accept({ subscriptionId: id, frame }),
        error: (error) => accept({ subscriptionId: id, error }),
      });
      return done.promise;
    },
  );
  return subscriptions;
}
function snapshot(
  id: string,
  events: SessionWireEvent[],
  hasMore = false,
): Extract<WatchFrame, { type: "snapshot" }> {
  const cursor = events.at(-1)?.seq ?? -1;
  return {
    type: "snapshot",
    header: {
      version: 4,
      id: id.slice(3) as Extract<
        WatchFrame,
        { type: "snapshot" }
      >["header"]["id"],
      createdAt: 1,
      isSeeded: false,
    },
    records: events.map((event) => ({ type: "event", event })),
    cursor,
    hasMore,
    projections: { asOfSeq: cursor, values: {} },
  };
}

const attemptId = "attempt-one" as SessionAssistantStreamAttempt["attemptId"];
const sessionCursor = (seq: number) =>
  seq as SessionAssistantStreamAttempt["startedAfterSeq"];

it("assembles official live chunks separately and hands off once to their durable settlement", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0)], false, 0),
  );
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  act(() => {
    subscriptions[0].send({
      ...snapshot("lc:first", [event(0)]),
      assistantStream: { revision: 0 },
    });
    subscriptions[0].send({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId,
        revision: 1,
        startedAfterSeq: sessionCursor(0),
        turn: 1,
        step: 1,
      },
    });
    subscriptions[0].send({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId,
        revision: 2,
        index: 0,
        time: 100,
        chunk: { type: "text-delta", index: 0, text: "Hello" },
      },
    });
  });
  expect(result.current.events).toEqual([event(0)]);
  expect(result.current.activeAttempt).toMatchObject({
    attemptId,
    nextIndex: 1,
    stream: [{ type: "text-chunks", time0: 100, texts: ["Hello"] }],
  });
  const settlement: SessionWireEvent = {
    ...event(1),
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    },
  };
  act(() => subscriptions[0].send({ type: "event", event: settlement }));
  expect(result.current.activeAttempt).toBeNull();
  expect(result.current.events.at(-1)).toBe(settlement);
  act(() =>
    subscriptions[0].send({
      type: "assistant-stream",
      frame: {
        type: "end",
        attemptId,
        revision: 3,
        index: 1,
        outcome: { kind: "committed", eventType: "assistant/message", seq: 1 },
      },
    }),
  );
  expect(result.current.events).toEqual([event(0), settlement]);
  expect(result.current.realtime).toBe("live");
  expect(result.current.error).toBeNull();
});

it("adopts a reconnect attempt baseline with exact timestamps before appending new native chunks", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0)], false, 0),
  );
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  const opening: SessionAssistantStreamAttempt = {
    attemptId,
    startedAfterSeq: sessionCursor(0),
    turn: 1,
    step: 1,
    nextIndex: 2,
    stream: [
      {
        type: "text-chunks",
        time0: 100,
        index: 0,
        dt: [2],
        texts: ["Hel", "lo"],
      },
    ],
  };
  act(() =>
    subscriptions[0].send({
      ...snapshot("lc:first", [event(0)]),
      assistantStream: { revision: 4, activeAttempt: opening },
    }),
  );
  expect(result.current.activeAttempt).toBe(opening);
  act(() =>
    subscriptions[0].send({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId,
        revision: 5,
        index: 2,
        time: 106,
        chunk: { type: "text-delta", index: 0, text: "!" },
      },
    }),
  );
  expect(result.current.activeAttempt).toMatchObject({
    nextIndex: 3,
    stream: [{ time0: 100, dt: [2, 4], texts: ["Hel", "lo", "!"] }],
  });
  expect(result.current.events).toEqual([event(0)]);
});

it.each(["revision", "index"])(
  "stops an incomplete assistant %s without fabricating durable messages",
  async (gap) => {
    vi.mocked(agentApi.readSessionNative).mockResolvedValue(
      response([event(0)], false, 0),
    );
    const subscriptions = liveSubscriptions();
    const { result } = renderHook(() => useAgentNativeSession("lc:first"));
    await act(async () => {});
    act(() => {
      subscriptions[0].send(snapshot("lc:first", [event(0)]));
      subscriptions[0].send({
        type: "assistant-stream",
        frame: {
          type: "start",
          attemptId,
          revision: 1,
          startedAfterSeq: sessionCursor(0),
          turn: 1,
          step: 1,
        },
      });
      subscriptions[0].send({
        type: "assistant-stream",
        frame: {
          type: "chunk",
          attemptId,
          revision: gap === "revision" ? 3 : 2,
          index: gap === "index" ? 1 : 0,
          time: 100,
          chunk: { type: "text-delta", index: 0, text: "untrusted suffix" },
        },
      });
    });
    expect(result.current.realtime).toBe("failed");
    expect(result.current.activeAttempt).toBeNull();
    expect(result.current.events).toEqual([event(0)]);
    expect(agentApi.stopSessionNative).toHaveBeenCalledWith(
      subscriptions[0].id,
    );
  },
);

it("retires abandoned transient output without inventing a successful Assistant event", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0)], false, 0),
  );
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  act(() => {
    subscriptions[0].send(snapshot("lc:first", [event(0)]));
    subscriptions[0].send({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId,
        revision: 1,
        startedAfterSeq: sessionCursor(0),
        turn: 1,
        step: 1,
      },
    });
    subscriptions[0].send({
      type: "assistant-stream",
      frame: {
        type: "end",
        attemptId,
        revision: 2,
        index: 0,
        outcome: { kind: "abandoned" },
      },
    });
  });
  expect(result.current.activeAttempt).toBeNull();
  expect(result.current.events).toEqual([event(0)]);
  expect(result.current.realtime).toBe("live");
});

it("confirms an empty cold session without an error and retries only when its activity changes", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockRejectedValueOnce(new Error("LOLICODE_SESSION_LOG_MISSING"))
    .mockResolvedValue(response([event(0)], false, 0));
  const subscriptions = liveSubscriptions();
  vi.mocked(agentApi.watchSessionNative).mockResolvedValueOnce(false);
  const { result, rerender } = renderHook(
    ({ revision }) =>
      useAgentNativeSession("lc:first", { activityRevision: revision }),
    { initialProps: { revision: "idle:0" } },
  );
  expect(result.current.ready).toBe(false);
  await act(async () => {});
  expect(result.current.ready).toBe(true);
  expect(result.current.events).toEqual([]);
  expect(result.current.error).toBeNull();
  expect(result.current.realtime).toBe("history");
  rerender({ revision: "idle:0" });
  await act(async () => {});
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
  rerender({ revision: "running:1" });
  await act(async () => {});
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(2);
  act(() => subscriptions[0].send(snapshot("lc:first", [event(0)])));
  rerender({ revision: "running:2" });
  await act(async () => {});
  expect(result.current.realtime).toBe("live");
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(2);
});

it("keeps cached records while disabled and ignores late subscription frames", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0)], false, 0),
  );
  const subscriptions = liveSubscriptions();
  const { result, rerender } = renderHook(
    ({ enabled }) => useAgentNativeSession("lc:first", { enabled }),
    { initialProps: { enabled: true } },
  );
  await act(async () => {});
  act(() => subscriptions[0].send(snapshot("lc:first", [event(0)])));
  rerender({ enabled: false });
  act(() => subscriptions[0].send({ type: "event", event: event(1, "stale") }));
  expect(result.current.ready).toBe(true);
  expect(result.current.events).toEqual([event(0)]);
  expect(result.current.realtime).toBe("paused");
  expect(agentApi.stopSessionNative).toHaveBeenCalledWith(subscriptions[0].id);
  await act(async () => {});
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
  rerender({ enabled: true });
  await act(async () => {});
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(2);
});

it("loads older history while live and preserves frames arriving during the read", async () => {
  const older = deferred<AgentNativeSessionRead>();
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(8)], true, 8))
    .mockReturnValueOnce(older.promise);
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  act(() => subscriptions[0].send(snapshot("lc:first", [event(8)], true)));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.loadOlder();
  });
  act(() => {
    subscriptions[0].send({ type: "event", event: event(9) });
    subscriptions[0].send({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId,
        revision: 1,
        startedAfterSeq: sessionCursor(9),
        turn: 1,
        step: 1,
      },
    });
  });
  await act(async () => {
    older.resolve(
      response(
        Array.from({ length: 5 }, (_, index) => event(index + 3)),
        false,
        8,
      ),
    );
    await pending;
  });
  expect(result.current.events.map(({ seq }) => seq)).toEqual([
    3, 4, 5, 6, 7, 8, 9,
  ]);
  expect(result.current.cursor).toBe(9);
  expect(result.current.realtime).toBe("live");
  expect(result.current.activeAttempt?.attemptId).toBe(attemptId);
  expect(agentApi.stopSessionNative).not.toHaveBeenCalled();
  expect(agentApi.readSessionNative).toHaveBeenLastCalledWith("lc:first", {
    maxMessages: 12,
    beforeSeq: 8,
    throughSeq: 8,
  });
});

it("shows a bounded verified native cache immediately when switching back while refreshing", async () => {
  const refreshing = deferred<AgentNativeSessionRead>();
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(1, "first cached")], false, 1))
    .mockResolvedValueOnce(response([event(8, "second cached")], false, 8))
    .mockReturnValueOnce(refreshing.promise);
  const { result, rerender } = renderHook(
    ({ id }) => useAgentNativeSession(id),
    { initialProps: { id: "lc:first" } },
  );
  await act(async () => {});
  rerender({ id: "lc:second" });
  await act(async () => {});
  rerender({ id: "lc:first" });
  expect(result.current.ready).toBe(true);
  expect(result.current.events).toEqual([event(1, "first cached")]);
  expect(result.current.loading).toBe(true);
  await act(async () =>
    refreshing.resolve(response([event(2, "first refreshed")], false, 2)),
  );
  expect(result.current.events).toEqual([event(2, "first refreshed")]);
  expect(
    result.current.events.some((value) =>
      JSON.stringify(value).includes("second cached"),
    ),
  ).toBe(false);
});

it("keeps an already paged native prefix through cached return, read overlap, and an adjacent follow opening", async () => {
  const older = Array.from({ length: 8 }, (_, index) => event(index));
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(8), event(9), event(10)], true, 10))
    .mockResolvedValueOnce(response(older, false, 10))
    .mockResolvedValueOnce(response([event(0, "another session")], false, 0))
    .mockResolvedValueOnce(
      response([event(9), event(10), event(11), event(12)], true, 12),
    );
  const subscriptions = liveSubscriptions();
  const { result, rerender } = renderHook(
    ({ id }) => useAgentNativeSession(id),
    { initialProps: { id: "lc:first" } },
  );
  await act(async () => {});
  act(() =>
    subscriptions[0].send(
      snapshot("lc:first", [event(8), event(9), event(10)], true),
    ),
  );
  await act(async () => {
    await result.current.loadOlder();
  });
  expect(result.current.events.map(({ seq }) => seq)).toEqual(
    Array.from({ length: 11 }, (_, index) => index),
  );
  rerender({ id: "lc:second" });
  await act(async () => {});
  rerender({ id: "lc:first" });
  expect(result.current.events[0]).toBe(older[0]);
  await act(async () => {});
  expect(result.current.events.map(({ seq }) => seq)).toEqual(
    Array.from({ length: 13 }, (_, index) => index),
  );
  act(() =>
    subscriptions[2].send(snapshot("lc:first", [event(13), event(14)], true)),
  );
  expect(result.current.events.map(({ seq }) => seq)).toEqual(
    Array.from({ length: 15 }, (_, index) => index),
  );
  expect(result.current.events[0]).toBe(older[0]);
  expect(result.current.hasMore).toBe(false);
  expect(result.current.cursor).toBe(14);
  expect(result.current.error).toBeNull();
});

it.each(["gap", "conflict"])(
  "adopts a new official read window instead of attaching a cached prefix across a %s",
  async (difference) => {
    const refreshed =
      difference === "gap"
        ? [event(7), event(8)]
        : [event(3, "new authoritative content"), event(4)];
    vi.mocked(agentApi.readSessionNative)
      .mockResolvedValueOnce(
        response(
          Array.from({ length: 5 }, (_, index) => event(index)),
          false,
          4,
        ),
      )
      .mockResolvedValueOnce(response([event(0, "other")], false, 0))
      .mockResolvedValueOnce(response(refreshed, true, refreshed.at(-1)!.seq));
    const subscriptions = liveSubscriptions();
    const { result, rerender } = renderHook(
      ({ id }) => useAgentNativeSession(id),
      { initialProps: { id: "lc:first" } },
    );
    await act(async () => {});
    rerender({ id: "lc:second" });
    await act(async () => {});
    rerender({ id: "lc:first" });
    await act(async () => {});
    expect(result.current.events).toEqual(refreshed);
    act(() => subscriptions[2].send(snapshot("lc:first", refreshed, true)));
    expect(result.current.events).toEqual(refreshed);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.error).toBeNull();
  },
);

it("drops a retained prefix if the authoritative follow opening contradicts its overlapping event", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(
      response(
        Array.from({ length: 5 }, (_, index) => event(index)),
        false,
        4,
      ),
    )
    .mockResolvedValueOnce(response([event(0, "other")], false, 0))
    .mockResolvedValueOnce(response([event(3), event(4)], true, 4));
  const subscriptions = liveSubscriptions();
  const { result, rerender } = renderHook(
    ({ id }) => useAgentNativeSession(id),
    { initialProps: { id: "lc:first" } },
  );
  await act(async () => {});
  rerender({ id: "lc:second" });
  await act(async () => {});
  rerender({ id: "lc:first" });
  await act(async () => {});
  expect(result.current.events.map(({ seq }) => seq)).toEqual([0, 1, 2, 3, 4]);
  const authoritative = [event(4, "changed at opening"), event(5)];
  act(() => subscriptions[2].send(snapshot("lc:first", authoritative, true)));
  expect(result.current.events).toEqual(authoritative);
  expect(result.current.hasMore).toBe(true);
});

it("rejects an older page when a newer opening has moved beyond it with an uncovered gap", async () => {
  const older = deferred<AgentNativeSessionRead>();
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(8), event(9), event(10)], true, 10))
    .mockReturnValueOnce(older.promise);
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.loadOlder();
  });
  act(() =>
    subscriptions[0].send(snapshot("lc:first", [event(13), event(14)], true)),
  );
  await act(async () => {
    older.resolve(
      response(
        Array.from({ length: 8 }, (_, index) => event(index)),
        false,
        10,
      ),
    );
    await pending;
  });
  expect(result.current.events).toEqual([event(13), event(14)]);
  expect(result.current.error).toContain("不连续");
  expect(result.current.realtime).toBe("live");
});

it("evicts older native cache entries and never treats a failed read as a verified empty session", async () => {
  vi.mocked(agentApi.readSessionNative).mockImplementation(async (id) => {
    if (id === "lc:broken") throw new Error("fixture unreadable");
    return response([event(0, id)], false, 0);
  });
  const { result, rerender } = renderHook(
    ({ id }) => useAgentNativeSession(id),
    { initialProps: { id: "lc:first" } },
  );
  await act(async () => {});
  for (const id of ["lc:second", "lc:third", "lc:fourth"]) {
    rerender({ id });
    await act(async () => {});
  }
  const pending = deferred<AgentNativeSessionRead>();
  vi.mocked(agentApi.readSessionNative).mockReturnValueOnce(pending.promise);
  rerender({ id: "lc:first" });
  expect(result.current.ready).toBe(false);
  expect(result.current.events).toEqual([]);
  await act(async () =>
    pending.resolve(response([event(1, "first new")], false, 1)),
  );
  rerender({ id: "lc:broken" });
  await act(async () => {});
  expect(result.current.ready).toBe(false);
  expect(result.current.error).toContain("unreadable");
  rerender({ id: "lc:first" });
  await act(async () => {});
  rerender({ id: "lc:broken" });
  expect(result.current.ready).toBe(false);
  expect(result.current.events).toEqual([]);
  await act(async () => {});
});

it("keeps a completed native turn as static history when its runtime closes normally", async () => {
  const completed: SessionWireEvent = {
    ...event(1),
    type: "turn/end",
    data: { turn: 1, reason: { kind: "completed" } },
  };
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0), completed], false, 1),
  );
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  act(() => subscriptions[0].send(snapshot("lc:first", [event(0), completed])));
  await act(async () => subscriptions[0].done.resolve(true));
  expect(result.current.events).toEqual([event(0), completed]);
  expect(result.current.realtime).toBe("history");
  expect(result.current.error).toBeNull();
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
});

it("accepts a fresh Agent's assistant revision after the previous attempt ended", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0)], false, 0),
  );
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  act(() => {
    subscriptions[0].send(snapshot("lc:first", [event(0)]));
    subscriptions[0].send({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId,
        revision: 1,
        startedAfterSeq: sessionCursor(0),
        turn: 1,
        step: 1,
      },
    });
    subscriptions[0].send({
      type: "assistant-stream",
      frame: {
        type: "end",
        attemptId,
        revision: 2,
        index: 0,
        outcome: { kind: "abandoned" },
      },
    });
    subscriptions[0].send({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "attempt-resumed" as typeof attemptId,
        revision: 1,
        startedAfterSeq: sessionCursor(0),
        turn: 2,
        step: 1,
      },
    });
  });
  expect(result.current.realtime).toBe("live");
  expect(result.current.activeAttempt?.attemptId).toBe("attempt-resumed");
  expect(result.current.activeAttempt?.turn).toBe(2);
  expect(result.current.events).toEqual([event(0)]);
});

it("does not duplicate a baseline attempt whose durable settlement is already in the opening window", async () => {
  const settlement: SessionWireEvent = {
    ...event(1),
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Already committed" }],
      },
    },
  };
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0), settlement], false, 1),
  );
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  act(() =>
    subscriptions[0].send({
      ...snapshot("lc:first", [event(0), settlement]),
      assistantStream: {
        revision: 3,
        activeAttempt: {
          attemptId,
          startedAfterSeq: sessionCursor(0),
          turn: 1,
          step: 1,
          nextIndex: 0,
          stream: [],
        },
      },
    }),
  );
  expect(result.current.activeAttempt).toBeNull();
  expect(result.current.events).toEqual([event(0), settlement]);
});

it("coalesces activity arriving during the initial cold read into one later retry", async () => {
  const reading = deferred<AgentNativeSessionRead>();
  vi.mocked(agentApi.readSessionNative)
    .mockReturnValueOnce(reading.promise)
    .mockResolvedValue(response([event(0)], false, 0));
  const { result, rerender } = renderHook(
    ({ revision }) =>
      useAgentNativeSession("lc:first", { activityRevision: revision }),
    { initialProps: { revision: 0 } },
  );
  rerender({ revision: 1 });
  rerender({ revision: 2 });
  await act(async () => reading.resolve(response([], false, -1)));
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(2);
  expect(result.current.events).toEqual([event(0)]);
  expect(result.current.realtime).toBe("history");
});

it("isolates two subscriptions of the same session and cancels only the closing view", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0)], false, 0),
  );
  const subscriptions = liveSubscriptions();
  const first = renderHook(() => useAgentNativeSession("lc:first"));
  const second = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  expect(subscriptions).toHaveLength(2);
  expect(subscriptions[0].id).not.toBe(subscriptions[1].id);
  act(() => {
    subscriptions[0].send(snapshot("lc:first", [event(0)]));
    subscriptions[1].send(snapshot("lc:first", [event(0)]));
    subscriptions[0].send({ type: "event", event: event(1, "first view") });
  });
  expect(first.result.current.events.map(({ seq }) => seq)).toEqual([0, 1]);
  expect(second.result.current.events.map(({ seq }) => seq)).toEqual([0]);
  first.unmount();
  await act(async () => {
    subscriptions[0].done.resolve(true);
  });
  expect(
    vi
      .mocked(agentApi.stopSessionNative)
      .mock.calls.every(([id]) => id === subscriptions[0].id),
  ).toBe(true);
  act(() => {
    subscriptions[1].send({ type: "event", event: event(1, "second view") });
  });
  expect(second.result.current.events.at(-1)).toEqual(event(1, "second view"));
  expect(second.result.current.realtime).toBe("live");
});

it("ignores late frames and completion from a replaced session subscription", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(0, "old")], false, 0))
    .mockResolvedValueOnce(response([event(5, "new")], false, 5));
  const subscriptions = liveSubscriptions();
  const { result, rerender } = renderHook(
    ({ id }) => useAgentNativeSession(id),
    { initialProps: { id: "lc:old" } },
  );
  await act(async () => {});
  rerender({ id: "lc:new" });
  expect(result.current.events).toEqual([]);
  await act(async () => {});
  act(() => {
    subscriptions[0].send(snapshot("lc:old", [event(0, "leaked")]));
    subscriptions[1].send(snapshot("lc:new", [event(5, "new")]));
  });
  await act(async () => {
    subscriptions[0].done.resolve(true);
  });
  expect(result.current.events).toEqual([event(5, "new")]);
  expect(result.current.realtime).toBe("live");
  expect(agentApi.stopSessionNative).toHaveBeenCalledWith(subscriptions[0].id);
});

it("accepts committed frames once and stops on a gap without inventing a repair", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0)], false, 0),
  );
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  act(() => {
    subscriptions[0].send(snapshot("lc:first", [event(0)]));
    subscriptions[0].send({ type: "event", event: event(0) });
    subscriptions[0].send({ type: "event", event: event(1) });
    subscriptions[0].send({ type: "event", event: event(3) });
    subscriptions[0].send({ type: "event", event: event(2) });
  });
  expect(result.current.events.map(({ seq }) => seq)).toEqual([0, 1]);
  expect(result.current.cursor).toBe(1);
  expect(result.current.realtime).toBe("failed");
  expect(result.current.error).toContain("缺口");
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
  expect(agentApi.stopSessionNative).toHaveBeenCalledWith(subscriptions[0].id);
});

it("preserves a successful window when same-session refresh fails", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(0)], false, 0))
    .mockRejectedValueOnce(new Error("read failed"));
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.events).toEqual([event(0)]);
  expect(result.current.cursor).toBe(0);
  expect(result.current.error).toContain("read failed");
  expect(agentApi.watchSessionNative).toHaveBeenCalledTimes(1);
});

it("does not let late startup restore a paused subscription", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(8)], true, 8))
    .mockResolvedValueOnce(
      response(
        Array.from({ length: 5 }, (_, index) => event(index + 3)),
        false,
        8,
      ),
    );
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
  act(() => {
    result.current.pauseRealtime();
  });
  act(() => {
    subscriptions[0].send(snapshot("lc:first", [event(9)]));
  });
  expect(agentApi.stopSessionNative).toHaveBeenCalledTimes(2);
  expect(agentApi.stopSessionNative).toHaveBeenLastCalledWith(
    subscriptions[0].id,
  );
  await act(async () => {
    subscriptions[0].done.resolve(true);
  });
  await act(async () => {
    await result.current.loadOlder();
  });
  expect(result.current.events.map(({ seq }) => seq)).toEqual([
    3, 4, 5, 6, 7, 8,
  ]);
  expect(result.current.realtime).toBe("paused");
  expect(agentApi.readSessionNative).toHaveBeenLastCalledWith("lc:first", {
    maxMessages: 12,
    beforeSeq: 8,
    throughSeq: 8,
  });
});

it("keeps a cold false result as static history without polling or prompting", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0)], false, 0),
  );
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  expect(result.current.realtime).toBe("history");
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
  expect(agentApi.watchSessionNative).toHaveBeenCalledTimes(1);
  expect(agentApi.stopSessionNative).not.toHaveBeenCalled();
});

it("rejects a snapshot for another session before replacing the existing history", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0)], false, 0),
  );
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  act(() => {
    subscriptions[0].send(snapshot("lc:other", [event(3, "not this session")]));
  });
  expect(result.current.events).toEqual([event(0)]);
  expect(result.current.error).toContain("不属于当前会话");
});

it("retains history when a stream ends and reconnects with a new official opening window", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(0)], false, 0))
    .mockResolvedValueOnce(response([event(0), event(1), event(2)], false, 2));
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  act(() => {
    subscriptions[0].send(snapshot("lc:first", [event(0)]));
    subscriptions[0].send({ type: "event", event: event(1) });
  });
  await act(async () => {
    subscriptions[0].done.resolve(true);
  });
  expect(result.current.events.map(({ seq }) => seq)).toEqual([0, 1]);
  expect(result.current.realtime).toBe("failed");
  expect(result.current.error).toContain("连接已结束");
  expect(agentApi.watchSessionNative).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.refresh();
  });
  expect(subscriptions).toHaveLength(2);
  expect(subscriptions[1].id).not.toBe(subscriptions[0].id);
  act(() => {
    subscriptions[0].send({ type: "event", event: event(99, "late") });
    subscriptions[1].send(snapshot("lc:first", [event(0), event(1), event(2)]));
    subscriptions[1].send({ type: "event", event: event(3) });
  });
  expect(result.current.events.map(({ seq }) => seq)).toEqual([0, 1, 2, 3]);
  expect(result.current.realtime).toBe("live");
  expect(result.current.error).toBeNull();
});

it("rejects events before the opening snapshot and retains the discrete history", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0)], false, 0),
  );
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  act(() => {
    subscriptions[0].send({ type: "event", event: event(1) });
  });
  expect(result.current.events).toEqual([event(0)]);
  expect(result.current.error).toContain("缺少起始快照");
  expect(agentApi.stopSessionNative).toHaveBeenCalledWith(subscriptions[0].id);
});

it("rejects an empty opening that claims to cover a nonempty journal", async () => {
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(
    response([event(0)], false, 0),
  );
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  act(() => {
    subscriptions[0].send({ ...snapshot("lc:first", []), cursor: 3 });
  });
  expect(result.current.events).toEqual([event(0)]);
  expect(result.current.error).toContain("不连续");
});

it("does not begin a late subscription after pausing during the initial read", async () => {
  const read = deferred<AgentNativeSessionRead>();
  vi.mocked(agentApi.readSessionNative).mockReturnValue(read.promise);
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  act(() => {
    result.current.pauseRealtime();
  });
  await act(async () => {
    read.resolve(response([event(0)], false, 0));
  });
  expect(result.current.realtime).toBe("paused");
  expect(result.current.loading).toBe(false);
  expect(agentApi.watchSessionNative).not.toHaveBeenCalled();
});
