import type { AgentMessage, AgentStatus } from "@/types/agent";

/** Only explicit stop outcomes are cancellation, never arbitrary HTTP errors. */
export function isAgentCancellation(value?: string | null) {
  const reason = value
    ?.trim()
    .replace(/[。.!！]$/, "")
    .toLowerCase();
  return (
    reason != null &&
    [
      "任务已停止",
      "任务已取消",
      "本轮已停止",
      "本轮已取消",
      "cancelled",
      "canceled",
      "task cancelled",
      "task canceled",
    ].includes(reason)
  );
}

export function lastAgentUserTurn(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return messages[index].id;
  }
  return null;
}

export interface AgentRunErrorProps {
  messages: AgentMessage[];
  status: AgentStatus;
  error?: string | null;
  /** New local submission, active run or stop awaiting acknowledgement. */
  pending?: boolean;
  /** Optional latest submitted request identity, including unacknowledged turns. */
  currentTurnId?: string | null;
}

/** Snapshot errors belong to its final acknowledged user turn, not the page. */
export function AgentRunError({
  messages,
  status,
  error,
  pending = false,
  currentTurnId,
}: AgentRunErrorProps) {
  const turnId = lastAgentUserTurn(messages);
  if (
    pending ||
    !error?.trim() ||
    !turnId ||
    (currentTurnId !== undefined && currentTurnId !== turnId)
  )
    return null;
  const cancelled = isAgentCancellation(error);
  if (status !== "error" && !(status === "idle" && cancelled)) return null;
  return (
    <div
      className={`wb-run-error${cancelled ? " wb-run-cancelled" : ""}`}
      role={cancelled ? "status" : "alert"}
      data-turn-id={turnId}
    >
      <div className="wb-run-error-heading">
        <span className="wb-run-error-dot" aria-hidden="true" />
        {cancelled ? "本轮已停止" : "本轮运行失败"}
      </div>
      <p className="wb-run-error-reason">{error}</p>
    </div>
  );
}
