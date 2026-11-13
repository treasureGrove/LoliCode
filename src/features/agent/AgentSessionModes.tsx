import { useRef, useState } from "react";
import { ListChecks, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import type { AgentSnapshot } from "@/types/agent";

const goalPhase = {
  active: "推进中",
  paused: "已暂停",
  blocked: "遇到阻碍",
};

interface AgentSessionModesProps {
  goal?: AgentSnapshot["goal"];
  plan?: AgentSnapshot["plan"];
  planReviewPending?: boolean;
  disabled: boolean;
  onEditGoal: () => void;
  onCommand: (command: string) => Promise<void>;
}

export function AgentSessionModes({
  goal,
  plan,
  planReviewPending = false,
  disabled,
  onEditGoal,
  onCommand,
}: AgentSessionModesProps) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const visibleGoal = goal?.phase !== "complete" ? goal : undefined;
  const planTransition = plan?.pending;
  const visiblePlan =
    plan?.active || planTransition !== undefined || planReviewPending;
  if (!visibleGoal && !visiblePlan) return null;

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
      {visiblePlan && (
        <div className="wb-agent-plan-summary" role="status">
          <ListChecks size={18} aria-hidden="true" />
          <div>
            <strong>
              {planReviewPending
                ? "计划等待审批"
                : planTransition === true
                  ? "即将进入计划模式"
                  : planTransition === false
                    ? "即将退出计划模式"
                    : "计划模式"}
            </strong>
            <small>
              {planReviewPending
                ? "请在计划审批卡中批准执行，或提出修改意见。"
                : planTransition !== undefined
                  ? "模式选择将在下一次运行步骤生效，执行权限仍由对话设置控制。"
                  : "先分析并提出方案，确认后推进执行；执行权限由对话设置控制。"}
            </small>
          </div>
        </div>
      )}
      {visibleGoal && goal && goal.phase !== "complete" && (
        <div className="wb-agent-goal-card">
          <Target size={18} aria-hidden="true" className="wb-agent-mode-icon" />
          <div className="wb-agent-goal-summary">
            <small className="wb-agent-mode-label">持续目标</small>
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
          <div className="wb-agent-mode-actions">
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
              onClick={onEditGoal}
            >
              修改目标
            </Button>
            <Button
              type="button"
              size="compact"
              variant="quiet"
              disabled={locked}
              onClick={() => void run("/goal clear")}
            >
              清除目标
            </Button>
          </div>
        </div>
      )}
      {error && (
        <small role="alert" className="text-danger-text">
          {error}
        </small>
      )}
    </section>
  );
}
