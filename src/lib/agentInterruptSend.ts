import { agentApi } from "@/lib/api/agent";
import {
  agentStopInFlight,
  agentSubmissionInFlight,
  clearAgentSubmission,
  dispatchAgentStop,
  readAgentSubmission,
  updateAgentSubmission,
} from "@/lib/agentInputLedger";
import type { AgentSnapshot } from "@/types/agent";

/** Leaving the target conversation cancels the queued replacement, never the Stop. */
export class AgentReplacementAborted extends Error {}

const terminal = (snapshot: AgentSnapshot) =>
  (snapshot.status === "idle" || snapshot.status === "error") &&
  !snapshot.compacting &&
  !snapshot.modelPhase &&
  !snapshot.permissions.length &&
  !snapshot.questions.length &&
  !snapshot.messages.some((message) =>
    message.parts.some(
      (part) =>
        part.type === "tool" &&
        (part.state === "pending" || part.state === "running"),
    ),
  );

/**
 * A Stop ACK only requests cancellation. A fresh terminal snapshot, after proven
 * admission and Stop, is required before a different request may be submitted.
 * No new request identity is allocated here, and no original input is replayed.
 */
export async function stopAgentBeforeReplacement(options: {
  sessionId: string;
  projectPath: string;
  isCurrent: () => boolean;
  onSnapshot: (snapshot: AgentSnapshot) => void;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<AgentSnapshot> {
  const { sessionId: id, projectPath, isCurrent, onSnapshot } = options;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const pollMs = options.pollMs ?? 250;
  const initial = readAgentSubmission(projectPath, id);
  const originalId = initial?.requestId;
  let admitted =
    !initial ||
    (!agentSubmissionInFlight(initial.requestId) &&
      (initial.phase === "accepted" || initial.observed));
  let rejected = false;
  let stoppedAfterAdmission = admitted;
  let lastQuery = -Infinity;

  const check = () => {
    if (!isCurrent()) throw new AgentReplacementAborted();
    if (Date.now() >= deadline)
      throw new Error(
        "停止确认超时，尚未发送新消息。草稿已保留，请等待旧任务停止后重试。",
      );
  };
  // IPC cannot be aborted, but leaving the page or a hung IPC must never leave a
  // queued send that can unexpectedly fire much later.
  const guarded = async <T>(operation: Promise<T>): Promise<T> => {
    check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      const inspect = () => {
        try {
          check();
          timer = setTimeout(inspect, Math.min(100, deadline - Date.now()));
        } catch (cause) {
          reject(cause);
        }
      };
      inspect();
    });
    try {
      const value = await Promise.race([operation, guard]);
      check();
      return value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const recordStop = (acknowledged: boolean) => {
    if (originalId)
      updateAgentSubmission(projectPath, id, originalId, {
        stopRequested: true,
        stopAcknowledged: acknowledged,
      });
  };
  const stop = async (afterAdmission: boolean) => {
    recordStop(false);
    const operation = dispatchAgentStop(
      id,
      agentApi.interruptSession,
      afterAdmission,
    );
    // Retain a safe ACK even when navigation/timeout abandons the replacement.
    // A pre-admission ACK is deliberately not sufficient recovery evidence.
    if (afterAdmission)
      void operation.then(() => recordStop(true)).catch(() => {});
    await guarded(operation);
    if (afterAdmission) recordStop(true);
  };
  check();
  await stop(admitted);

  for (;;) {
    check();
    const next = await guarded(agentApi.getSession(id));
    if (next.session.id !== id || next.session.projectPath !== projectPath)
      throw new Error("停止回执与原会话不一致，尚未发送新消息。");
    const entry = readAgentSubmission(projectPath, id);
    if (entry && entry.requestId !== originalId)
      throw new Error("会话的发送记录已改变，尚未发送新消息，请重新确认。");
    const inFlight = Boolean(originalId && agentSubmissionInFlight(originalId));
    if (
      originalId &&
      next.messages.some(
        (message) => message.role === "user" && message.id === originalId,
      )
    )
      admitted = true;
    if (entry && !inFlight && (entry.phase === "accepted" || entry.observed))
      admitted = true;

    if (entry && !inFlight && !admitted && Date.now() - lastQuery >= 1000) {
      lastQuery = Date.now();
      const receipt = await guarded(agentApi.queryCommand(id, entry.requestId));
      if (receipt.status === "accepted") {
        admitted = true;
        updateAgentSubmission(projectPath, id, entry.requestId, {
          phase: "accepted",
        });
      } else if (receipt.status === "rejected" || receipt.status === "failed")
        rejected = true;
    }
    if (admitted && !inFlight && !stoppedAfterAdmission) {
      // The first Stop may have reached an idle actor before a delayed input
      // was admitted. Repeat after that admission, then read a new snapshot.
      await stop(true);
      stoppedAfterAdmission = true;
      continue;
    }
    onSnapshot(next);
    if (
      !inFlight &&
      !agentStopInFlight(id) &&
      ((admitted && stoppedAfterAdmission) || rejected) &&
      terminal(next)
    ) {
      if (originalId) clearAgentSubmission(projectPath, id, originalId);
      return next;
    }
    await guarded(new Promise<void>((resolve) => setTimeout(resolve, pollMs)));
  }
}
