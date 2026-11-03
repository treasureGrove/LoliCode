import { useEffect, useRef, useState } from "react";
import { agentApi } from "@/lib/api/agent";
import type { AgentSecretaryActivity } from "@/types/agent";

export interface SecretaryOpenTarget {
  sessionId: string;
  projectPath: string;
  workerSessionId?: string;
}

export type SecretaryPhase =
  | "unknown"
  | "idle"
  | "thinking"
  | "working"
  | "waiting_permission"
  | "waiting_question"
  | "failed"
  | "completed";

export interface SecretaryActivity {
  phase: SecretaryPhase;
  running: number;
  queued: number;
  attention: number;
  target?: SecretaryOpenTarget;
}

const EMPTY: SecretaryActivity = {
  phase: "unknown",
  running: 0,
  queued: 0,
  attention: 0,
};
const priority: Record<string, number> = {
  waiting_permission: 0,
  waiting_question: 1,
  failed: 2,
  interrupted: 2,
  running: 3,
  queued: 4,
  completed: 5,
  cancelled: 6,
};

/** One window-wide companion may show work from any registered project. */
export function summarizeSecretaryActivity(
  sessions: AgentSecretaryActivity[],
): SecretaryActivity {
  const tasks = sessions.flatMap((owner) =>
    owner.tasks.map((task) => ({ owner, task })),
  );
  tasks.sort(
    (a, b) =>
      (priority[a.task.status] ?? 9) - (priority[b.task.status] ?? 9) ||
      b.task.updatedAt - a.task.updatedAt,
  );
  const attention = tasks.filter(({ task }) =>
    [
      "waiting_permission",
      "waiting_question",
      "failed",
      "interrupted",
    ].includes(task.status),
  ).length;
  const running = tasks.filter(({ task }) => task.status === "running").length;
  const queued = tasks.filter(({ task }) => task.status === "queued").length;
  const selected = tasks.find(({ task }) => (priority[task.status] ?? 9) < 5);
  const chiefs = [...sessions].sort(
    (a, b) =>
      (a.status === "error" ? 2 : (priority[a.status] ?? 6)) -
      (b.status === "error" ? 2 : (priority[b.status] ?? 6)),
  );
  const chief = chiefs[0];
  const chiefPriority =
    chief?.status === "error" ? 2 : (priority[chief?.status ?? ""] ?? 6);
  const chiefNeedsAttention = chiefPriority <= 2;
  const useWorker = Boolean(
    selected &&
      (!chiefNeedsAttention ||
        (priority[selected.task.status] ?? 9) < chiefPriority),
  );
  const status = useWorker ? selected!.task.status : chief?.status;
  const phase: SecretaryPhase =
    status === "waiting_permission" || status === "waiting_question"
      ? status
      : ["failed", "interrupted", "error"].includes(status ?? "")
        ? "failed"
        : useWorker
          ? "working"
          : status === "running"
            ? "thinking"
            : "idle";
  const owner = useWorker ? selected!.owner : chief;
  return {
    phase,
    running,
    queued,
    attention:
      attention +
      sessions.filter((session) =>
        ["waiting_permission", "waiting_question", "error"].includes(
          session.status,
        ),
      ).length,
    target: owner
      ? {
          sessionId: owner.sessionId,
          projectPath: owner.projectPath,
          ...(useWorker && (phase !== "working" || running + queued === 1)
            ? { workerSessionId: selected!.task.sessionId }
            : {}),
        }
      : undefined,
  };
}

export function useSecretaryActivity(enabled: boolean): SecretaryActivity {
  const [activity, setActivity] = useState<SecretaryActivity>(EMPTY);
  const previous = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    setActivity((last) => ({ ...EMPTY, target: last.target }));
    let disposed = false;
    let reading = false;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    let completion: SecretaryOpenTarget | undefined;
    let completionUntil = 0;
    let last: SecretaryActivity = EMPTY;
    const poll = async () => {
      if (disposed || reading || document.hidden) return;
      reading = true;
      const request = ++sequence;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const sessions = await Promise.race([
          agentApi.getSecretaryActivity(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Secretary activity timeout")),
              15_000,
            );
          }),
        ]);
        if (disposed || sequence !== request) return;
        if (!Array.isArray(sessions))
          throw new Error("Invalid secretary activity");
        const seen = new Map<string, string>();
        let newest:
          | { updatedAt: number; target: SecretaryOpenTarget }
          | undefined;
        for (const owner of sessions) {
          for (const task of owner.tasks) {
            const key = `${owner.sessionId}:${task.id}`;
            seen.set(key, task.status);
            if (
              previous.current?.has(key) &&
              previous.current.get(key) !== "completed" &&
              task.status === "completed" &&
              (!newest || task.updatedAt > newest.updatedAt)
            ) {
              newest = {
                updatedAt: task.updatedAt,
                target: {
                  sessionId: owner.sessionId,
                  projectPath: owner.projectPath,
                },
              };
            }
          }
        }
        previous.current = seen;
        last = summarizeSecretaryActivity(sessions);
        if (newest) {
          completion = newest.target;
          completionUntil = Date.now() + 8_000;
          clearTimeout(completionTimer);
          completionTimer = setTimeout(() => {
            completion = undefined;
            if (!disposed) setActivity(last);
          }, 8_000);
        }
        setActivity(
          last.phase === "idle" && completion && Date.now() < completionUntil
            ? { ...last, phase: "completed", target: completion }
            : last,
        );
      } catch {
        if (!disposed && sequence === request) {
          last = { ...EMPTY, target: last.target };
          clearTimeout(completionTimer);
          completion = undefined;
          setActivity(last);
        }
      } finally {
        clearTimeout(timeout);
        reading = false;
        if (!disposed) timer = setTimeout(() => void poll(), 3_000);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    previous.current = null;
    void poll();
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      sequence += 1;
      clearTimeout(timer);
      clearTimeout(completionTimer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled]);
  return activity;
}
