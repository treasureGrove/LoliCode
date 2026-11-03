import { useEffect, useRef, useState } from "react";
import { CalendarClock, CheckCircle2, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentApi } from "@/lib/api/agent";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import {
  automationProposalSchedule,
  type AgentAutomationProposal,
} from "@/lib/agentAutomation";
import type { AutomationJob } from "./AgentAutomationSettings";
import "./agent-automation-conversation.css";

type SaveRequest = {
  method: "create" | "update";
  automationId?: string;
  input: Record<string, unknown>;
  savedJobId?: string;
  confirmed?: boolean;
};

async function bounded<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("保存结果尚未确认，配置已保留；可以重试核对。")),
          30_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function AgentAutomationProposalCard({
  proposal,
  toolCallId,
  projectPath,
  sessionId,
}: {
  proposal: AgentAutomationProposal;
  toolCallId: string;
  projectPath: string;
  sessionId?: string;
}) {
  const clientRequestId = `proposal:${sessionId || ""}:${toolCallId}`;
  const storageKey = `lolicode.agent.automation-proposal:${encodeURIComponent(projectPath)}:${encodeURIComponent(clientRequestId)}`;
  const [initialRequest] = useState<SaveRequest | null>(() => {
    try {
      const value = JSON.parse(
        sessionStorage.getItem(storageKey) || "null",
      ) as SaveRequest | null;
      return value &&
        ["create", "update"].includes(value.method) &&
        value.input?.clientRequestId === clientRequestId &&
        value.input.workspacePath === projectPath
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(
    proposal.savedAutomationId ||
      (typeof initialRequest?.savedJobId === "string"
        ? initialRequest.savedJobId
        : null),
  );
  const [confirmed, setConfirmed] = useState(
    Boolean(proposal.savedAutomationId || initialRequest?.confirmed),
  );
  const request = useRef<SaveRequest | null>(initialRequest);
  const nativeSavedId = useRef(proposal.savedAutomationId);
  nativeSavedId.current = proposal.savedAutomationId;
  useEffect(() => {
    if (!proposal.savedAutomationId) return;
    setSaved(proposal.savedAutomationId);
    setConfirmed(true);
    setError(null);
  }, [proposal.savedAutomationId]);
  const saving = useRef(false);
  const [permission, setPermission] = useState(
    typeof initialRequest?.input.mode === "string"
      ? initialRequest.input.mode
      : proposal.input.mode || "inherit",
  );
  const save = async () => {
    if (saving.current || (saved && confirmed) || !sessionId || !projectPath)
      return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!request.current) {
        const prior = sessionStorage.getItem(storageKey);
        if (prior) {
          const value = JSON.parse(prior) as SaveRequest;
          if (
            !["create", "update"].includes(value.method) ||
            value.input?.clientRequestId !== clientRequestId ||
            value.input.workspacePath !== projectPath
          )
            throw new Error("自动化保存恢复记录无效，原始配置已保留。");
          request.current = value;
        }
      }
      if (!request.current) {
        const current = await bounded(agentApi.getSession(sessionId));
        if (
          current.session.id !== sessionId ||
          current.session.projectPath !== projectPath ||
          !current.session.model
        )
          throw new Error(
            "当前会话的项目或模型无法确认，请重新打开会话后保存。",
          );
        let existing: AutomationJob | undefined;
        if (proposal.automationId) {
          const jobs = await bounded(
            agentApi.automation<AutomationJob[]>("list", [
              { workspacePath: projectPath },
            ]),
          );
          existing = jobs.find(
            (job) => job.automationId === proposal.automationId,
          );
          if (!existing)
            throw new Error("要修改的自动化已不存在或不属于当前项目。");
        }
        const mode =
          proposal.input.mode ||
          existing?.mode ||
          (current.session.permissionMode === "full_access"
            ? "yolo"
            : current.session.permissionMode === "auto"
              ? "guarded"
              : "build");
        setPermission(mode);
        const input = {
          idleAfterMinutes: existing?.idleAfterMinutes ?? 10,
          idleIntervalMinutes: existing?.idleIntervalMinutes ?? 60,
          ...proposal.input,
          cronExpr:
            proposal.input.trigger === "idle"
              ? "0 * * * *"
              : proposal.input.cronExpr,
          workspacePath: projectPath,
          clientRequestId,
          recurring: existing?.recurring ?? true,
          locale: existing?.locale || document.documentElement.lang || "zh",
          mode,
          modelSelection: existing?.modelSelection || {
            ...current.session.model,
            options: {
              reasoningLevel: current.session.reasoningEffort || "default",
            },
          },
        };
        const captured: SaveRequest = {
          method: proposal.automationId ? "update" : "create",
          ...(proposal.automationId
            ? { automationId: proposal.automationId }
            : {}),
          input,
        };
        // Capture before dispatch: retries keep the same model, permission and
        // idempotency key even if the conversation configuration changes later.
        sessionStorage.setItem(storageKey, JSON.stringify(captured));
        request.current = captured;
      }
      let captured = request.current;
      if (!captured.savedJobId) {
        const job = await bounded(
          agentApi.automation<AutomationJob>(
            captured.method,
            captured.method === "update"
              ? [
                  captured.automationId,
                  captured.input,
                  { workspacePath: projectPath },
                ]
              : [captured.input],
          ),
        );
        if (!job?.automationId)
          throw new Error("未收到有效的自动化保存结果，请重试核对。");
        captured = { ...captured, savedJobId: job.automationId };
        request.current = captured;
        setSaved(job.automationId);
        sessionStorage.setItem(storageKey, JSON.stringify(captured));
      }
      const result = await bounded(
        agentApi.automation<{
          status: string;
          automationId: string;
          toolCallId: string;
        }>("confirmProposal", [
          captured.savedJobId,
          sessionId,
          toolCallId,
          { workspacePath: projectPath },
        ]),
      );
      if (
        result?.status !== "saved" ||
        result.automationId !== captured.savedJobId ||
        result.toolCallId !== toolCallId
      )
        throw new Error("未收到有效的对话记录同步结果。");
      request.current = { ...captured, confirmed: true };
      sessionStorage.setItem(storageKey, JSON.stringify(request.current));
      setConfirmed(true);
    } catch (cause) {
      if (
        nativeSavedId.current &&
        nativeSavedId.current === request.current?.savedJobId
      ) {
        setConfirmed(true);
        setError(null);
      } else
        setError(
          `${request.current?.savedJobId ? "自动化已保存，对话记录尚未同步；请同步后再继续调整。" : ""}${agentErrorMessage(cause)}`,
        );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const permissions: Record<string, string> = {
    inherit: "沿用当前会话设置",
    build: "操作前询问",
    guarded: "自动 · 风险操作询问",
    yolo: "完全访问",
  };
  return (
    <section className="wb-automation-proposal" aria-label="自动化配置提案">
      <header>
        <CalendarClock size={20} aria-hidden="true" />
        <div>
          <p>{proposal.automationId ? "修改自动化" : "新建自动化"}</p>
          <h3>{proposal.input.title}</h3>
        </div>
        <span>{saved ? "已保存" : "待保存"}</span>
      </header>
      <p className="wb-automation-proposal-prompt">{proposal.input.prompt}</p>
      <dl>
        <div>
          <dt>运行计划</dt>
          <dd>{automationProposalSchedule(proposal)}</dd>
        </div>
        <div>
          <dt>项目</dt>
          <dd>{projectPath || "项目未连接"}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>
            沿用当前会话模型
            {proposal.automationId ? "；已有任务保留原模型设置" : ""}
          </dd>
        </div>
        <div>
          <dt>权限</dt>
          <dd>{permissions[permission] || permission}</dd>
        </div>
      </dl>
      <p className="wb-automation-proposal-hint">
        按本地时区运行，LoliCode 需要保持打开。
        {saved
          ? "可在自动化页面查看计划和运行记录。"
          : "可继续在对话中说明修改，生成新的配置卡片。"}
      </p>
      {error && (
        <p role="alert" className="text-caption text-danger-text">
          {error}
        </p>
      )}
      <footer>
        {saved && confirmed ? (
          <span role="status">
            <CheckCircle2 size={16} aria-hidden="true" /> 已保存自动化
          </span>
        ) : (
          <>
            <span>
              {saved ? "已保存，正在同步对话记录" : "点击保存后才会生效"}
            </span>
            <Button
              type="button"
              disabled={busy || !sessionId || !projectPath}
              onClick={() => void save()}
            >
              {busy && (
                <LoaderCircle
                  size={15}
                  className="animate-spin"
                  aria-hidden="true"
                />
              )}
              {busy
                ? saved
                  ? "正在同步…"
                  : "正在保存…"
                : saved
                  ? "同步保存结果"
                  : error
                    ? "重试保存"
                    : proposal.automationId
                      ? "保存修改"
                      : "保存自动化"}
            </Button>
          </>
        )}
      </footer>
    </section>
  );
}
