import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import type { AgentSnapshot } from "@/types/agent";

const goalPhase = {
  active: "推进中",
  paused: "已暂停",
  blocked: "遇到阻碍",
  complete: "已完成",
};

interface AgentSessionModesProps {
  goal: AgentSnapshot["goal"];
  disabled: boolean;
  onGoalDraft: (editing: boolean) => void;
  onCommand: (command: string) => Promise<void>;
}

export function AgentSessionModes({
  goal,
  disabled,
  onGoalDraft,
  onCommand,
}: AgentSessionModesProps) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const locked = disabled || working;
  const goalRunning = goal?.phase === "active" && goal.activation === "armed";
  const run = async (command: string) => {
    if (pending.current || locked) return;
    pending.current = true;
    setWorking(true);
    setError(undefined);
    try {
      await onCommand(command);
    } catch (cause) {
      setError(agentErrorMessage(cause));
    } finally {
      pending.current = false;
      setWorking(false);
    }
  };
  return (
    <section aria-label="Agent 会话模式" className="wb-agent-modes">
      {goal && (
        <div className="wb-agent-goal-summary">
          <span className="font-medium" title={goal.objective}>
            {goal.objective}
          </span>
          <small role="status">
            {goal.phase === "active" && !goalRunning
              ? "待继续"
              : goalPhase[goal.phase]}
            {" · "}
            {goal.roundsStarted}/{goal.maxGoalRounds} 轮
          </small>
          {goal.blockedReason && <small>{goal.blockedReason.message}</small>}
        </div>
      )}
      <div className="wb-agent-mode-actions">
        {!goal || goal.phase === "complete" ? (
          <Button
            type="button"
            size="compact"
            variant="quiet"
            disabled={locked}
            onClick={() => onGoalDraft(false)}
          >
            设置目标
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="compact"
              variant="quiet"
              disabled={
                locked ||
                (!goalRunning && goal.roundsStarted >= goal.maxGoalRounds)
              }
              onClick={() =>
                void run(goalRunning ? "/goal pause" : "/goal resume")
              }
            >
              {goalRunning ? "暂停目标" : "继续目标"}
            </Button>
            <Button
              type="button"
              size="compact"
              variant="quiet"
              disabled={locked}
              onClick={() => onGoalDraft(true)}
            >
              修改目标
            </Button>
          </>
        )}
        {goal && (
          <Button
            type="button"
            size="compact"
            variant="quiet"
            disabled={locked}
            onClick={() => void run("/goal clear")}
          >
            清除目标
          </Button>
        )}
      </div>
      {error && (
        <small role="alert" className="text-danger-text">
          {error}
        </small>
      )}
    </section>
  );
}
