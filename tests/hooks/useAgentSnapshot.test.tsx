import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { agentApi } from "@/lib/api/agent";
import { useAgentSnapshot } from "@/hooks/useAgentSnapshot";
import type { AgentSnapshot } from "@/types/agent";
import { emitTauriEvent } from "../msw/tauriMocks";

vi.mock("@/lib/api/agent", () => ({ agentApi: { getSession: vi.fn() } }));

afterEach(() => vi.useRealTimers());

function sessionSnapshot(
  id: string,
  status: AgentSnapshot["status"] = "idle",
): AgentSnapshot {
  return {
    session: {
      id,
      title: id,
      projectPath: "D:/project",
      createdAt: 1,
      updatedAt: 1,
    },
    status,
    messages: [{ id: `${id}:user`, role: "user", createdAt: 1, parts: [] }],
    permissions: [],
    questions: [],
    diffs: [],
  };
}

function follow(initialId: string, onSnapshot = vi.fn()) {
  return renderHook(
    ({ id, refresh }) =>
      useAgentSnapshot(id, { fast: false, refresh, onSnapshot }),
    {
      initialProps: { id: initialId, refresh: 0 },
    },
  );
}

it("shows only the selected session's stream tail before polling and preserves it across a stale read", async () => {
  vi.useFakeTimers();
  const sessionId = "lc:stream-fixture";
  const stored: AgentSnapshot = {
    session: {
      id: sessionId,
      title: "Fixture",
      projectPath: "D:/project",
      createdAt: 1,
      updatedAt: 1,
    },
    status: "running",
    messages: [{ id: "user", role: "user", createdAt: 1, parts: [] }],
    permissions: [],
    questions: [],
    diffs: [],
  };
  let completeStaleRead!: (snapshot: AgentSnapshot) => void;
  const read = vi.mocked(agentApi.getSession);
  read
    .mockReset()
    .mockResolvedValueOnce(structuredClone(stored))
    .mockReturnValueOnce(
      new Promise((resolve) => {
        completeStaleRead = resolve;
      }),
    )
    .mockImplementation(async () => structuredClone(stored));
  const { result } = renderHook(() =>
    useAgentSnapshot(sessionId, {
      fast: false,
      refresh: 0,
      onSnapshot: () => {},
    }),
  );
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(800));
  expect(read).toHaveBeenCalledTimes(2);

  const stream = {
    type: "tail",
    sessionId,
    previousMessageId: "user",
    message: {
      id: "dsh-live:first",
      role: "assistant",
      createdAt: 2,
      parts: [{ type: "text", text: "Streaming" }],
    },
  };
  act(() =>
    emitTauriEvent("agent-session-update", {
      ...stream,
      sessionId: "lc:other",
    }),
  );
  expect(result.current.snapshot?.messages.at(-1)?.id).toBe("user");
  act(() => emitTauriEvent("agent-session-update", stream));
  expect(result.current.snapshot?.messages.at(-1)).toEqual(stream.message);
  expect(read).toHaveBeenCalledTimes(2);

  await act(async () => completeStaleRead(structuredClone(stored)));
  expect(result.current.snapshot?.messages.at(-1)).toEqual(stream.message);

  stored.status = "idle";
  stored.messages.push({
    id: "committed",
    role: "assistant",
    createdAt: 2,
    parts: [{ type: "text", text: "Committed" }],
  });
  act(() => {
    emitTauriEvent("agent-session-update", { type: "changed", sessionId });
    emitTauriEvent("agent-session-update", { type: "changed", sessionId });
  });
  await act(async () => vi.advanceTimersByTimeAsync(40));
  expect(read).toHaveBeenCalledTimes(3);
  act(() => emitTauriEvent("agent-session-update", stream));
  expect(result.current.snapshot?.messages).toEqual(stored.messages);
});

it("keeps an unchanged snapshot and reuses history when only the last message changes", async () => {
  vi.useFakeTimers();
  const stored: AgentSnapshot = {
    session: {
      id: "lc:fixture",
      title: "Fixture",
      projectPath: "D:/project",
      createdAt: 1,
      updatedAt: 1,
    },
    status: "error",
    messages: [
      {
        id: "user",
        role: "user",
        createdAt: 1,
        parts: [{ type: "text", text: "Request" }],
      },
      {
        id: "reply",
        role: "assistant",
        createdAt: 2,
        parts: [{ type: "text", text: "Result" }],
      },
    ],
    permissions: [],
    questions: [],
    diffs: [],
  };
  const read = vi.mocked(agentApi.getSession);
  read.mockReset().mockImplementation(async () => structuredClone(stored));
  const { result } = renderHook(() =>
    useAgentSnapshot(stored.session.id, {
      fast: false,
      refresh: 0,
      onSnapshot: () => {},
    }),
  );
  await act(async () => {});
  const first = result.current.snapshot!;
  await act(async () => vi.advanceTimersByTimeAsync(800));
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current.snapshot).toBe(first);
  await act(async () => vi.advanceTimersByTimeAsync(800));
  expect(read).toHaveBeenCalledTimes(2);

  stored.messages[1].parts = [{ type: "text", text: "Updated result" }];
  await act(async () => vi.advanceTimersByTimeAsync(4200));
  expect(result.current.snapshot?.messages[0]).toBe(first.messages[0]);
  expect(result.current.snapshot?.messages[1]).not.toBe(first.messages[1]);
  expect(result.current.snapshot?.messages[1].parts).toEqual(
    stored.messages[1].parts,
  );
});

it("switches back synchronously without issuing another full read for a fresh idle session", async () => {
  vi.useFakeTimers();
  const read = vi.mocked(agentApi.getSession);
  read.mockReset().mockImplementation(async (id) => sessionSnapshot(id));
  const { result, rerender } = follow("lc:first");
  await act(async () => {});
  const first = result.current.snapshot;

  rerender({ id: "lc:second", refresh: 0 });
  expect(result.current.snapshot).toBeNull();
  expect(result.current.loading).toBe(true);
  await act(async () => {});
  expect(result.current.snapshot?.session.id).toBe("lc:second");

  rerender({ id: "lc:first", refresh: 0 });
  expect(result.current.snapshot).toBe(first);
  expect(result.current.loading).toBe(false);
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(4999));
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(read.mock.calls.map(([id]) => id)).toEqual([
    "lc:first",
    "lc:second",
    "lc:first",
  ]);
  expect(result.current.snapshot).toBe(first);

  rerender({ id: "lc:first", refresh: 1 });
  expect(read).toHaveBeenCalledTimes(4);
  expect(result.current.snapshot).toBe(first);
  await act(async () => {});
});

it("shows prefetched history on selection and reconciles only the selected session", async () => {
  const read = vi.mocked(agentApi.getSession);
  read.mockReset().mockImplementation(async (id) => sessionSnapshot(id));
  const onSnapshot = vi.fn();
  const { result, rerender } = follow("lc:first", onSnapshot);
  await act(async () => {});

  await act(async () => result.current.prefetch("lc:second"));
  expect(result.current.snapshot?.session.id).toBe("lc:first");
  expect(
    result.current.preparedSnapshots.map((item) => item.session.id),
  ).toEqual(["lc:second"]);
  expect(onSnapshot).toHaveBeenCalledTimes(1);

  rerender({ id: "lc:second", refresh: 0 });
  expect(result.current.snapshot?.session.id).toBe("lc:second");
  expect(result.current.loading).toBe(false);
  expect(result.current.preparedSnapshots).toEqual([]);
  expect(onSnapshot).toHaveBeenLastCalledWith(result.current.snapshot);
  expect(read.mock.calls.map(([id]) => id)).toEqual(["lc:first", "lc:second"]);
});

it("adopts an in-flight read on click and discards a changed speculative snapshot", async () => {
  const read = vi.mocked(agentApi.getSession);
  let finishSecond!: (snapshot: AgentSnapshot) => void;
  read.mockReset().mockImplementation((id) =>
    id === "lc:second"
      ? new Promise((resolve) => {
          finishSecond = resolve;
        })
      : Promise.resolve(sessionSnapshot(id)),
  );
  const { result, rerender } = follow("lc:first");
  await act(async () => {});
  await act(async () => {
    void result.current.prefetch("lc:second");
  });
  rerender({ id: "lc:second", refresh: 0 });
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => finishSecond(sessionSnapshot("lc:second")));
  expect(result.current.snapshot?.session.id).toBe("lc:second");

  await act(async () => result.current.prefetch("lc:third"));
  expect(result.current.preparedSnapshots).toHaveLength(1);
  act(() =>
    emitTauriEvent("agent-session-update", {
      type: "changed",
      sessionId: "lc:third",
    }),
  );
  expect(result.current.preparedSnapshots).toEqual([]);
  rerender({ id: "lc:third", refresh: 0 });
  expect(result.current.loading).toBe(true);
  await act(async () => {});
  expect(result.current.snapshot?.session.id).toBe("lc:third");
  expect(read.mock.calls.map(([id]) => id)).toEqual([
    "lc:first",
    "lc:second",
    "lc:third",
    "lc:third",
  ]);
});

it("reuses a background tail and ignores the read left behind by a switch", async () => {
  vi.useFakeTimers();
  const first = sessionSnapshot("lc:first", "running");
  const second = sessionSnapshot("lc:second");
  const read = vi.mocked(agentApi.getSession);
  let resolveOldRead!: (snapshot: AgentSnapshot) => void;
  read
    .mockReset()
    .mockResolvedValueOnce(first)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOldRead = resolve;
      }),
    )
    .mockResolvedValueOnce(second)
    .mockResolvedValueOnce(structuredClone(first));
  const onSnapshot = vi.fn();
  const { result, rerender } = follow(first.session.id, onSnapshot);
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(800));
  expect(read).toHaveBeenCalledTimes(2);

  rerender({ id: second.session.id, refresh: 0 });
  await act(async () => {});
  const tail = {
    type: "tail",
    sessionId: first.session.id,
    previousMessageId: first.messages[0].id,
    message: {
      id: "dsh-live:background",
      role: "assistant",
      createdAt: 2,
      parts: [{ type: "text", text: "Still streaming" }],
    },
  };
  act(() => emitTauriEvent("agent-session-update", tail));
  expect(result.current.snapshot).toBe(second);
  await act(async () => resolveOldRead(sessionSnapshot(first.session.id)));
  expect(result.current.snapshot).toBe(second);
  expect(
    onSnapshot.mock.calls.map(([snapshot]) => snapshot.session.id),
  ).toEqual([first.session.id, second.session.id]);

  rerender({ id: first.session.id, refresh: 0 });
  expect(result.current.snapshot?.messages.at(-1)).toEqual(tail.message);
  expect(read).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(40));
  expect(read).toHaveBeenCalledTimes(4);
  expect(result.current.snapshot?.messages.at(-1)).toEqual(tail.message);
});

it("keeps a cached approval until a read after the latest change confirms its state", async () => {
  vi.useFakeTimers();
  const first = sessionSnapshot("lc:first", "waiting_permission");
  first.permissions = [
    {
      id: "approval-1",
      sessionId: first.session.id,
      action: "write",
      resources: ["example.txt"],
    },
  ];
  const second = sessionSnapshot("lc:second");
  const current = structuredClone(first);
  current.permissions[0].id = "approval-2";
  let resolveOldRead!: (snapshot: AgentSnapshot) => void;
  const read = vi.mocked(agentApi.getSession);
  read
    .mockReset()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOldRead = resolve;
      }),
    )
    .mockResolvedValueOnce(current);
  const onSnapshot = vi.fn();
  const { result, rerender } = follow(first.session.id, onSnapshot);
  await act(async () => {});
  rerender({ id: second.session.id, refresh: 0 });
  await act(async () => {});

  const changed = { type: "changed", sessionId: first.session.id };
  act(() => emitTauriEvent("agent-session-update", changed));
  rerender({ id: first.session.id, refresh: 0 });
  expect(result.current.snapshot?.permissions[0].id).toBe("approval-1");
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(40));
  expect(read).toHaveBeenCalledTimes(3);

  act(() => emitTauriEvent("agent-session-update", changed));
  await act(async () => resolveOldRead(sessionSnapshot(first.session.id)));
  expect(result.current.snapshot?.permissions[0].id).toBe("approval-1");
  expect(onSnapshot).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(40));
  expect(result.current.snapshot?.permissions[0].id).toBe("approval-2");
  expect(onSnapshot).toHaveBeenCalledTimes(3);
});

it("bounds retained conversations and ignores notifications for evicted sessions", async () => {
  vi.useFakeTimers();
  const read = vi.mocked(agentApi.getSession);
  read.mockReset().mockImplementation(async (id) => sessionSnapshot(id));
  const { result, rerender } = follow("lc:0");
  await act(async () => {});
  for (let index = 1; index <= 6; index += 1) {
    rerender({ id: `lc:${index}`, refresh: 0 });
    await act(async () => {});
  }
  act(() =>
    emitTauriEvent("agent-session-update", {
      type: "changed",
      sessionId: "lc:0",
    }),
  );
  expect(result.current.snapshot?.session.id).toBe("lc:6");
  rerender({ id: "lc:0", refresh: 0 });
  expect(result.current.snapshot).toBeNull();
  expect(result.current.loading).toBe(true);
  expect(read).toHaveBeenLastCalledWith("lc:0");
  await act(async () => {});
});

it("publishes progress when durable events invalidate consecutive slow reads", async () => {
  vi.useFakeTimers();
  const stored = sessionSnapshot("lc:busy", "running");
  const progressing = structuredClone(stored);
  progressing.messages.push({
    id: "current-step",
    role: "assistant",
    createdAt: 2,
    parts: [],
  });
  let resolveFirst!: (snapshot: AgentSnapshot) => void;
  let resolveSecond!: (snapshot: AgentSnapshot) => void;
  const read = vi.mocked(agentApi.getSession);
  read
    .mockReset()
    .mockResolvedValueOnce(stored)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    )
    .mockResolvedValueOnce(progressing);
  const onSnapshot = vi.fn();
  const { result } = follow(stored.session.id, onSnapshot);
  await act(async () => {});
  const change = () =>
    act(() =>
      emitTauriEvent("agent-session-update", {
        type: "changed",
        sessionId: stored.session.id,
      }),
    );

  change();
  await act(async () => vi.advanceTimersByTimeAsync(40));
  change();
  await act(async () => resolveFirst(structuredClone(progressing)));
  expect(result.current.snapshot).toBe(stored);
  await act(async () => vi.advanceTimersByTimeAsync(40));
  change();
  await act(async () => resolveSecond(structuredClone(progressing)));
  expect(result.current.snapshot?.messages.at(-1)?.id).toBe("current-step");
  expect(onSnapshot).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(40));
  expect(read).toHaveBeenCalledTimes(4);
  expect(onSnapshot).toHaveBeenCalledTimes(3);
});
