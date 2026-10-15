import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApi } from "@/lib/api/agent";
import {
  beginAgentSubmission,
  captureAgentDraft,
  endAgentSubmission,
  readAgentSubmission,
  saveAgentSubmission,
  updateAgentSubmission,
} from "@/lib/agentInputLedger";
import {
  AgentReplacementAborted,
  stopAgentBeforeReplacement,
} from "@/lib/agentInterruptSend";
import type { AgentSnapshot } from "@/types/agent";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    interruptSession: vi.fn(),
    getSession: vi.fn(),
    queryCommand: vi.fn(),
  },
}));

const id = "lc:interrupt-fixture";
const projectPath = "D:/fixture/interrupt";
let snapshot: AgentSnapshot;
const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
const saveInput = () => {
  const draft = captureAgentDraft("interrupt-draft", "original input");
  saveAgentSubmission({
    version: 1,
    sessionId: id,
    projectPath,
    requestId: "original-request",
    text: draft.text,
    draft,
    assistantIds: [],
    phase: "uncertain",
    observed: false,
    stopRequested: false,
  });
};
const settle = (
  extra: Partial<Parameters<typeof stopAgentBeforeReplacement>[0]> = {},
) =>
  stopAgentBeforeReplacement({
    sessionId: id,
    projectPath,
    isCurrent: () => true,
    onSnapshot: vi.fn(),
    ...extra,
  });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  snapshot = {
    session: { id, projectPath, title: "Fixture", createdAt: 1, updatedAt: 2 },
    status: "running",
    messages: [],
    permissions: [],
    questions: [],
    diffs: [],
  };
  vi.mocked(agentApi.interruptSession).mockReset().mockResolvedValue();
  vi.mocked(agentApi.getSession)
    .mockReset()
    .mockImplementation(async () => structuredClone(snapshot));
  vi.mocked(agentApi.queryCommand)
    .mockReset()
    .mockResolvedValue({ status: "unknown" });
});
afterEach(() => {
  endAgentSubmission("original-request");
  vi.useRealTimers();
});

describe("stopAgentBeforeReplacement", () => {
  it("waits beyond the Stop ACK for a new terminal snapshot and settled tools", async () => {
    let completed = false;
    const task = settle().then((value) => {
      completed = true;
      return value;
    });
    await flush();
    expect(agentApi.interruptSession).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    snapshot.status = "idle";
    snapshot.messages = [
      {
        id: "assistant",
        role: "assistant",
        createdAt: 3,
        parts: [
          {
            type: "tool",
            id: "tool",
            name: "shell",
            input: {},
            state: "running",
          },
        ],
      },
    ];
    await vi.advanceTimersByTimeAsync(250);
    expect(completed).toBe(false);
    snapshot.messages[0].parts = [
      {
        type: "tool",
        id: "tool",
        name: "shell",
        input: {},
        state: "error",
        error: "任务已停止",
      },
    ];
    await vi.advanceTimersByTimeAsync(250);
    expect((await task).messages).toEqual(snapshot.messages);
    expect(agentApi.interruptSession).toHaveBeenCalledOnce();
  });

  it("never treats an old idle snapshot as cancellation of an unknown input", async () => {
    saveInput();
    snapshot.status = "idle";
    const outcome = settle({ timeoutMs: 1500 }).catch((cause) => cause);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await outcome).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("停止确认超时"),
      }),
    );
    expect(readAgentSubmission(projectPath, id)?.requestId).toBe(
      "original-request",
    );
    expect(agentApi.interruptSession).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem("interrupt-draft")).toBe("original input");
  });

  it("repeats Stop after late admission and then fetches a fresh settled snapshot", async () => {
    saveInput();
    snapshot.status = "idle";
    const order: string[] = [];
    vi.mocked(agentApi.interruptSession).mockImplementation(async () => {
      order.push("stop");
    });
    vi.mocked(agentApi.getSession).mockImplementation(async () => {
      order.push("snapshot");
      return structuredClone(snapshot);
    });
    vi.mocked(agentApi.queryCommand).mockImplementation(async () => {
      order.push("accepted");
      return { status: "accepted" };
    });
    await settle();
    expect(order).toEqual(["stop", "snapshot", "accepted", "stop", "snapshot"]);
    expect(readAgentSubmission(projectPath, id)).toBeNull();
  });

  it("waits for in-flight admission even if an early Stop saw an idle actor", async () => {
    saveInput();
    updateAgentSubmission(projectPath, id, "original-request", {
      phase: "submitting",
    });
    beginAgentSubmission("original-request");
    snapshot.status = "idle";
    let completed = false;
    const task = settle().then(() => {
      completed = true;
    });
    await flush();
    expect(completed).toBe(false);
    expect(agentApi.queryCommand).not.toHaveBeenCalled();
    updateAgentSubmission(projectPath, id, "original-request", {
      phase: "accepted",
    });
    endAgentSubmission("original-request");
    await vi.advanceTimersByTimeAsync(250);
    await task;
    expect(agentApi.interruptSession).toHaveBeenCalledTimes(2);
    expect(readAgentSubmission(projectPath, id)).toBeNull();
  });

  it("preserves the recovery receipt when Stop fails", async () => {
    saveInput();
    vi.mocked(agentApi.interruptSession).mockRejectedValue(
      new Error("stop failed"),
    );
    await expect(settle()).rejects.toThrow("stop failed");
    expect(agentApi.getSession).not.toHaveBeenCalled();
    expect(readAgentSubmission(projectPath, id)).toMatchObject({
      requestId: "original-request",
      stopRequested: true,
      stopAcknowledged: false,
    });
  });

  it("abandons a queued replacement promptly when its target changes during a hung IPC", async () => {
    let current = true;
    let release!: () => void;
    vi.mocked(agentApi.interruptSession).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const outcome = settle({ isCurrent: () => current }).catch(
      (cause) => cause,
    );
    await flush();
    current = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBeInstanceOf(AgentReplacementAborted);
    release();
    await flush();
    expect(agentApi.getSession).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "records a late Stop ACK after navigation only when admission was already proven (%s)",
    async (accepted) => {
      saveInput();
      if (accepted)
        updateAgentSubmission(projectPath, id, "original-request", {
          phase: "accepted",
        });
      let current = true;
      let release!: () => void;
      vi.mocked(agentApi.interruptSession).mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const outcome = settle({ isCurrent: () => current }).catch(
        (cause) => cause,
      );
      await flush();
      current = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(await outcome).toBeInstanceOf(AgentReplacementAborted);
      release();
      await flush();
      expect(readAgentSubmission(projectPath, id)?.stopAcknowledged).toBe(
        accepted,
      );
      expect(agentApi.getSession).not.toHaveBeenCalled();
    },
  );

  it("rejects a response belonging to a different project without clearing old evidence", async () => {
    saveInput();
    snapshot.session.projectPath = "D:/other-project";
    snapshot.status = "idle";
    await expect(settle()).rejects.toThrow("停止回执与原会话不一致");
    expect(readAgentSubmission(projectPath, id)?.requestId).toBe(
      "original-request",
    );
  });
});
