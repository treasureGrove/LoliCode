import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { agentApi } from "@/lib/api/agent";
import { useAgentSnapshot } from "@/hooks/useAgentSnapshot";
import type { AgentSnapshot } from "@/types/agent";
import { emitTauriEvent } from "../msw/tauriMocks";

vi.mock("@/lib/api/agent", () => ({ agentApi: { getSession: vi.fn() } }));

afterEach(() => vi.useRealTimers());

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
