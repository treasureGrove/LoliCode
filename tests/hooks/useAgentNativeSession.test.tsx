import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { agentApi } from "@/lib/api/agent";
import { useAgentNativeSession } from "@/hooks/useAgentNativeSession";
import type {
  AgentNativeSessionRead,
  SessionWireEvent,
} from "@/types/harness-session";

vi.mock("@/lib/api/agent", () => ({
  agentApi: { readSessionNative: vi.fn() },
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
