import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApi } from "@/lib/api/agent";
import {
  summarizeSecretaryActivity,
  useSecretaryActivity,
} from "@/hooks/useSecretaryActivity";
import type {
  AgentSecretaryActivity,
  AgentSecretaryTaskStatus,
} from "@/types/agent";

vi.mock("@/lib/api/agent", () => ({
  agentApi: { getSecretaryActivity: vi.fn() },
}));
const api = vi.mocked(agentApi.getSecretaryActivity);
const owner = (
  status: AgentSecretaryTaskStatus = "running",
): AgentSecretaryActivity => ({
  sessionId: "chief",
  projectPath: "D:/owned/project",
  title: "秘书",
  status: "idle",
  tasks: [
    { id: "task", sessionId: "worker", title: "工作", status, updatedAt: 100 },
  ],
});
beforeEach(() => {
  vi.useFakeTimers();
  api.mockReset();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const advance = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("secretary companion projection", () => {
  it("keeps a running worker visible when its secretary is idle", () => {
    const state = summarizeSecretaryActivity([owner()]);
    expect(state).toMatchObject({
      phase: "working",
      running: 1,
      target: { sessionId: "chief", workerSessionId: "worker" },
    });
  });
  it("routes a permission prompt to the worker which actually needs it", () => {
    expect(
      summarizeSecretaryActivity([owner("waiting_permission")]),
    ).toMatchObject({
      phase: "waiting_permission",
      attention: 1,
      target: { workerSessionId: "worker" },
    });
  });
  it("opens the secretary overview when multiple workers are active", () => {
    const session = owner();
    session.tasks.push(
      { ...session.tasks[0], id: "another", sessionId: "worker-two" },
      {
        ...session.tasks[0],
        id: "next",
        sessionId: "worker-next",
        status: "queued",
      },
    );
    const state = summarizeSecretaryActivity([session]);
    expect(state).toMatchObject({ phase: "working", running: 2, queued: 1 });
    expect(state.target).toEqual({
      sessionId: "chief",
      projectPath: "D:/owned/project",
    });
  });
  it("opens the secretary for its question even when an older worker failed", () => {
    const state = owner("failed");
    state.status = "waiting_question";
    const result = summarizeSecretaryActivity([state]);
    expect(result.phase).toBe("waiting_question");
    expect(result.target).toEqual({
      sessionId: "chief",
      projectPath: "D:/owned/project",
    });
  });
  it("does not announce old completed tasks as new results", () => {
    expect(summarizeSecretaryActivity([owner("completed")]).phase).toBe("idle");
  });
  it("prioritizes a real permission request across project boundaries", () => {
    const other = owner("waiting_permission");
    other.sessionId = "chief-two";
    other.projectPath = "D:/other";
    other.tasks[0].sessionId = "other-worker";
    expect(summarizeSecretaryActivity([owner(), other]).target).toEqual({
      sessionId: "chief-two",
      projectPath: "D:/other",
      workerSessionId: "other-worker",
    });
  });
});

describe("companion activity polling", () => {
  it("polls only while enabled and stops after the companion is hidden", async () => {
    api.mockResolvedValue([owner()]);
    const view = renderHook(({ enabled }) => useSecretaryActivity(enabled), {
      initialProps: { enabled: false },
    });
    await advance();
    expect(api).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    await advance();
    expect(view.result.current.phase).toBe("working");
    expect(api).toHaveBeenCalledTimes(1);
    view.rerender({ enabled: false });
    await advance(10_000);
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("reports transport failure as unknown rather than idle or completed", async () => {
    api
      .mockResolvedValueOnce([owner()])
      .mockRejectedValue(new Error("old binary missing command"));
    const view = renderHook(() => useSecretaryActivity(true));
    await advance();
    expect(view.result.current.phase).toBe("working");
    await advance(3_000);
    expect(view.result.current.phase).toBe("unknown");
    expect(view.result.current.target?.sessionId).toBe("chief");
  });
  it("shows each observed completion briefly without repeating it on every poll", async () => {
    api
      .mockResolvedValueOnce([owner()])
      .mockResolvedValue([owner("completed")]);
    const view = renderHook(() => useSecretaryActivity(true));
    await advance();
    await advance(3_000);
    expect(view.result.current.phase).toBe("completed");
    await advance(9_000);
    expect(view.result.current.phase).toBe("idle");
    await advance(6_000);
    expect(view.result.current.phase).toBe("idle");
  });
  it("does not poll an invisible document and resumes when visible", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    api.mockResolvedValue([owner()]);
    const view = renderHook(() => useSecretaryActivity(true));
    await advance(10_000);
    expect(api).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance();
    expect(view.result.current.phase).toBe("working");
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("ignores a response from a previous visibility lifetime", async () => {
    let resolve!: (value: AgentSecretaryActivity[]) => void;
    api
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValue([owner("waiting_question")]);
    const view = renderHook(({ enabled }) => useSecretaryActivity(enabled), {
      initialProps: { enabled: true },
    });
    view.rerender({ enabled: false });
    view.rerender({ enabled: true });
    await advance();
    expect(view.result.current.phase).toBe("waiting_question");
    await act(async () => resolve([owner("completed")]));
    expect(view.result.current.phase).toBe("waiting_question");
  });
  it("bounds an unresponsive native request and remains able to refresh", async () => {
    api.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue([owner()]);
    const view = renderHook(() => useSecretaryActivity(true));
    await advance(15_000);
    expect(view.result.current.phase).toBe("unknown");
    await advance(3_000);
    expect(view.result.current.phase).toBe("working");
    expect(api).toHaveBeenCalledTimes(2);
  });
});
