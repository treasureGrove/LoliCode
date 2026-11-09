import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { agentApi } from "@/lib/api/agent";
import { useAgentNativeSession } from "@/hooks/useAgentNativeSession";
import type {
  AgentNativeSessionRead,
  AgentNativeSessionWatchMessage,
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
    .mockResolvedValueOnce(response([event(3), event(8)], false, 10));
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
  expect(result.current.events.map(({ seq }) => seq)).toEqual([3, 8, 9]);
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
    .mockRejectedValueOnce(new Error("LOLICODE_SESSION_LOG_MISSING"))
    .mockResolvedValueOnce(response([event(1)]));
  const { result, rerender } = renderHook(
    ({ id }) => useAgentNativeSession(id),
    { initialProps: { id: null as string | null } },
  );
  await act(async () => {});
  expect(agentApi.readSessionNative).not.toHaveBeenCalled();
  rerender({ id: "lc:first" });
  await act(async () => {});
  expect(result.current.error).toContain("还没有可读取的原生记录");
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

it("pauses before paging and does not let late startup restore the subscription", async () => {
  vi.mocked(agentApi.readSessionNative)
    .mockResolvedValueOnce(response([event(8)], true, 8))
    .mockResolvedValueOnce(response([event(3)], false, 8));
  const subscriptions = liveSubscriptions();
  const { result } = renderHook(() => useAgentNativeSession("lc:first"));
  await act(async () => {});
  await act(async () => {
    await result.current.loadOlder();
  });
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
  expect(result.current.events.map(({ seq }) => seq)).toEqual([3, 8]);
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
