import {
  CircleAlert,
  Loader2,
  MessageCircleQuestion,
  ShieldCheck,
} from "lucide-react";
import type { AgentMessage, AgentSnapshot } from "@/types/agent";

interface Props {
  snapshot: AgentSnapshot | null;
  submitting: boolean;
  stopping: boolean;
  id?: string;
}

const waitingForModel = {
  phase: "waiting_model",
  label: "正在等待模型响应…",
};

function runningPhase(
  messages: AgentMessage[],
  modelPhase: AgentSnapshot["modelPhase"],
) {
  if (modelPhase === "waiting") return waitingForModel;
  const currentTurn: AgentMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role === "assistant") currentTurn.push(message);
  }
  if (
    currentTurn.some((message) =>
      message.parts.some(
        (part) =>
          part.type === "tool" &&
          (part.state === "running" || part.state === "pending"),
      ),
    )
  )
    return { phase: "tool", label: "正在执行工具…" };
  const latest = currentTurn[0];
  if (latest && latest.completedAt == null) {
    for (let index = latest.parts.length - 1; index >= 0; index -= 1) {
      const part = latest.parts[index];
      if (part.type === "reasoning" && part.text.trim())
        return { phase: "thinking", label: "正在思考…" };
      if (part.type === "text" && part.text.trim())
        return { phase: "replying", label: "正在回复…" };
    }
  }
  // Harness can open the response stream before any model output arrives.
  return modelPhase === "streaming"
    ? waitingForModel
    : { phase: "running", label: "正在执行…" };
}

export function AgentActivityStatus({
  snapshot,
  submitting,
  stopping,
  id,
}: Props) {
  let phase: string;
  let label: string;
  let busy = false;
  if (stopping) {
    phase = "stopping";
    label = "正在停止…";
    busy = true;
  } else if (submitting) {
    phase = "preparing";
    label = "正在准备任务…";
    busy = true;
  } else if (snapshot?.status === "waiting_permission") {
    phase = "permission";
    label = "等待你的许可";
  } else if (snapshot?.status === "waiting_question") {
    phase = "question";
    label = "等待你的回答";
  } else if (snapshot?.status === "error") {
    phase = "error";
    label = "执行遇到问题";
  } else if (snapshot?.status === "running") {
    if (snapshot.compacting) {
      phase = "compacting";
      label = "正在整理上下文…";
    } else if (snapshot.modelPhase === "finishing") {
      phase = "finishing";
      label = "正在收尾统计…";
    } else {
      ({ phase, label } = runningPhase(snapshot.messages, snapshot.modelPhase));
    }
    busy = true;
  } else return null;
  const Icon = busy
    ? Loader2
    : phase === "question"
      ? MessageCircleQuestion
      : phase === "permission"
        ? ShieldCheck
        : phase === "error"
          ? CircleAlert
          : null;
  return (
    <span
      id={id}
      role="status"
      tabIndex={id ? -1 : undefined}
      aria-live="polite"
      aria-atomic="true"
      className="wb-status"
      data-phase={phase}
    >
      {Icon && (
        <Icon
          aria-hidden="true"
          className={busy ? "animate-spin" : undefined}
        />
      )}
      {label}
    </span>
  );
}
