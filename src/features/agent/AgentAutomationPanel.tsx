import { useState } from "react";
import { CalendarClock, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentApi } from "@/lib/api/agent";
import { automationCron, automationScheduleLabel } from "@/lib/agentAutomation";
import type { AgentCatalog, AgentSession } from "@/types/agent";
import {
  AgentAutomationSettings,
  defaultAutomationSettings,
  editAutomationSettings,
  type AutomationJob,
  type AutomationSettings,
} from "./AgentAutomationSettings";
import {
  OperationError,
  useAgentOperation,
  useAgentResource,
} from "./AgentOperationShared";
import { useAgentToolDraft } from "./AgentToolDrafts";
import { clearRequestIdentity, requestIdentity } from "./secretaryRequests";

export { automationCron, automationScheduleLabel } from "@/lib/agentAutomation";

type Run = {
  runId: string;
  outcome?: string;
  dispatchStatus: string;
  sessionId?: string;
  prompt?: string;
  error?: string;
  createdAt: number;
  cancelRequested?: boolean;
};

const FILTERS = [
  ["active", "已开启"],
  ["paused", "已暂停"],
  ["ended", "已结束"],
  ["all", "全部"],
] as const;
const DELIVERY_STATUS: Record<string, string> = {
  claimed: "等待投递",
  running: "正在投递",
  dispatched: "已投递",
  failed_to_dispatch: "投递失败",
  skipped: "已跳过",
  cancelled: "已取消",
};
const RUN_STATUS: Record<string, string> = {
  succeeded: "执行完成",
  failed: "执行失败",
  running: "执行中",
  stopped: "已停止",
};
const CREATE_PROMPT =
  "请帮我创建一项自动化任务。先确认要执行的工作和运行时间，再给我配置草案。";

function lifecycle(job: AutomationJob) {
  return job.lifecycleStatus === "ended" || job.lifecycleStatus === "completed"
    ? "ended"
    : job.enabled
      ? "active"
      : "paused";
}

function scheduleLabel(job: AutomationJob) {
  if (job.trigger === "idle")
    return `闲置 ${job.idleAfterMinutes ?? 10} 分钟 · 间隔 ${job.idleIntervalMinutes ?? 60} 分钟`;
  if (job.runAt) return `仅一次 · ${new Date(job.runAt).toLocaleString()}`;
  return automationScheduleLabel(job.cronExpr);
}

export function AgentAutomationPanel({
  projectPath,
  catalog,
  onSession,
  onCompose,
  onBuildAutomation,
}: {
  projectPath: string;
  catalog: AgentCatalog;
  onSession: (session: AgentSession) => void;
  onCompose?: (text: string) => void;
  onBuildAutomation?: (prompt: string) => Promise<void>;
}) {
  const [editor, setEditor] = useAgentToolDraft<AutomationSettings | null>(
    `automations:${projectPath}:editor`,
    null,
  );
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("active");
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState("");
  const operationScope = `automation:${projectPath}`;
  const { busy, error, run } = useAgentOperation(operationScope);
  const scope = { workspacePath: projectPath };
  const selectedId = editor?.job?.automationId;
  const jobs = useAgentResource(
    operationScope,
    () => agentApi.automation<AutomationJob[]>("list", [scope]),
    5000,
    false,
    operationScope,
  );
  const runs = useAgentResource(
    selectedId && history ? `automation-runs:${projectPath}:${selectedId}` : "",
    () => agentApi.automation<Run[]>("listRuns", [selectedId, scope]),
    3000,
    false,
    operationScope,
  );
  const sessions = useAgentResource(
    editor ? `automation-targets:${projectPath}` : "",
    () => agentApi.listSessions(projectPath),
    0,
    false,
    operationScope,
  );
  const activeJob =
    jobs.data?.find(({ automationId }) => automationId === selectedId) ??
    editor?.job;
  const original = editor?.job
    ? editAutomationSettings(editor.job, catalog)
    : null;
  const dirty = Boolean(
    original && JSON.stringify(original) !== JSON.stringify(editor),
  );
  const activeSession =
    activeJob?.target?.kind === "session"
      ? activeJob.target.sessionId
      : activeJob?.reusableSessionId;
  const availableSessions = (sessions.data ?? []).filter(
    (session) =>
      !session.archived &&
      !session.coordination &&
      session.id.startsWith("lc:") &&
      session.projectPath === projectPath,
  );
  const query = search.trim().toLocaleLowerCase();
  const visible =
    jobs.data?.filter(
      (job) =>
        (filter === "all" || lifecycle(job) === filter) &&
        [
          job.title,
          job.prompt,
          job.reusableSessionId,
          job.target?.kind === "session" ? job.target.sessionId : "",
        ].some((value) => value?.toLocaleLowerCase().includes(query)),
    ) ?? [];

  const showEditor = (value: AutomationSettings | null) => {
    setHistory(false);
    setConfirmDelete(false);
    setNotice("");
    setEditor(value);
  };
  const compose = () =>
    void run(async () => {
      if (onBuildAutomation) await onBuildAutomation(CREATE_PROMPT);
      else onCompose?.(CREATE_PROMPT);
    });
  const save = (value: AutomationSettings) =>
    void run(async () => {
      const model = catalog.models.find(({ id }) => id === value.modelId);
      const modelSelection = model
        ? {
            providerId: model.providerId,
            modelId: model.modelId,
            options: {
              ...value.job?.modelSelection?.options,
              reasoningLevel: value.reasoning || "default",
            },
          }
        : value.job?.modelSelection;
      const once = value.trigger === "schedule" && value.frequency === "once";
      const local = once ? new Date(value.runAt) : null;
      if (local && !Number.isFinite(local.getTime()))
        throw new Error("请选择有效的运行日期和时间");
      const job = value.job;
      const sameTime =
        original &&
        value.frequency === original.frequency &&
        value.time === original.time &&
        value.weekday === original.weekday &&
        value.minute === original.minute &&
        value.trigger === original.trigger;
      const input = {
        ...scope,
        title: value.title.trim(),
        prompt: value.prompt.trim(),
        target: value.target,
        trigger: value.trigger,
        runAt: local
          ? value.runAt === original?.runAt
            ? (job?.runAt ?? local.getTime())
            : local.getTime()
          : null,
        cronExpr:
          once || value.trigger === "idle"
            ? (job?.cronExpr ?? "0 * * * *")
            : sameTime && job
              ? job.cronExpr
              : automationCron(
                  value.frequency,
                  value.time,
                  value.weekday,
                  value.minute,
                ),
        recurring: !once && (job?.runAt ? true : (job?.recurring ?? true)),
        idleAfterMinutes: Number(value.idleAfter),
        idleIntervalMinutes: Number(value.idleInterval),
        locale: job?.locale || document.documentElement.lang || "zh",
        mode: value.mode,
        modelSelection,
        ...(job?.updatedAt !== undefined
          ? { expectedUpdatedAt: job.updatedAt }
          : {}),
      };
      const requestScope = `schedule:${projectPath}:${job?.automationId ?? "new"}`;
      const data = {
        ...input,
        clientRequestId: requestIdentity(requestScope, JSON.stringify(input)),
      };
      const saved = await agentApi.automation<AutomationJob>(
        job ? "update" : "create",
        job ? [job.automationId, data, scope] : [data],
      );
      if (
        !saved?.automationId ||
        (job && saved.automationId !== job.automationId)
      )
        throw new Error("未收到有效的任务保存结果，请重试核对。");
      clearRequestIdentity(requestScope);
      setEditor((current) =>
        current === value ? editAutomationSettings(saved, catalog) : current,
      );
      setNotice("已保存自动化任务。");
      jobs.reload();
    });
  const openSession = (id: string) =>
    void run(async () => {
      const list = await agentApi.listSessions(projectPath);
      const session = list.find(
        (entry) =>
          !entry.archived &&
          (entry.id === id || entry.id === `zc:${id}`) &&
          entry.projectPath === projectPath,
      );
      if (!session) throw new Error("关联对话已归档、移除或尚未写入索引。");
      onSession(session);
    });
  const errorMessage = error || jobs.error || runs.error || sessions.error;

  return (
    <div className="wb-automation space-y-4">
      <OperationError>{errorMessage}</OperationError>
      {notice && (
        <p role="status" className="text-caption text-fg-3">
          {notice}
        </p>
      )}
      {editor ? (
        <>
          {activeJob && (
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="任务详情"
            >
              <Button
                type="button"
                variant="neutral"
                aria-pressed={!history}
                onClick={() => setHistory(false)}
              >
                规则
              </Button>
              <Button
                type="button"
                variant="neutral"
                aria-pressed={history}
                onClick={() => setHistory(true)}
              >
                投递记录
              </Button>
              <Button
                type="button"
                variant="neutral"
                disabled={busy || dirty || lifecycle(activeJob) === "ended"}
                onClick={() =>
                  void run(async () => {
                    const saved =
                      await agentApi.automation<AutomationJob | null>(
                        "setEnabled",
                        [activeJob.automationId, !activeJob.enabled, scope],
                      );
                    if (!saved) throw new Error("任务已不存在，请刷新列表。");
                    setEditor((current) =>
                      current === editor
                        ? editAutomationSettings(saved, catalog)
                        : current,
                    );
                    jobs.reload();
                  })
                }
              >
                {activeJob.enabled ? "暂停" : "恢复"}
              </Button>
              <Button
                type="button"
                variant="neutral"
                disabled={busy || dirty || lifecycle(activeJob) === "ended"}
                onClick={() =>
                  void run(async () => {
                    const result = await agentApi.automation<{
                      status: string;
                    }>("runNow", [activeJob.automationId, scope]);
                    setNotice(
                      result.status === "duplicate"
                        ? "此任务已有一次投递正在处理。"
                        : "已提交投递。",
                    );
                    setHistory(true);
                    runs.reload();
                    jobs.reload();
                  })
                }
              >
                立即运行
              </Button>
              <Button
                type="button"
                variant="neutral"
                disabled={busy || dirty}
                onClick={() => setConfirmDelete(true)}
              >
                删除任务
              </Button>
              {activeSession && (
                <Button
                  type="button"
                  variant="neutral"
                  disabled={busy}
                  onClick={() => openSession(activeSession)}
                >
                  打开关联对话
                </Button>
              )}
            </div>
          )}
          {confirmDelete && activeJob && (
            <div
              role="group"
              aria-label="确认删除任务"
              className="flex flex-wrap items-center gap-2"
            >
              <span>删除规则和投递记录。已有对话会保留。</span>
              <Button
                type="button"
                variant="neutral"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                取消删除
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (
                      !(await agentApi.automation<boolean>("delete", [
                        activeJob.automationId,
                        scope,
                      ]))
                    )
                      throw new Error("任务已不存在，请刷新列表。");
                    showEditor(null);
                    jobs.reload();
                  })
                }
              >
                确认删除自动化
              </Button>
            </div>
          )}
          {history && activeJob ? (
            <section
              className="wb-automation-history"
              aria-label="自动化运行记录"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium">{activeJob.title} · 投递记录</h3>
                <Button
                  type="button"
                  variant="neutral"
                  disabled={busy}
                  onClick={() => showEditor(null)}
                >
                  返回任务列表
                </Button>
              </div>
              {!runs.data?.length && (
                <p className="py-4 text-caption text-fg-3">
                  {runs.loading ? "正在读取投递记录…" : "尚无投递记录。"}
                </p>
              )}
              {runs.data?.map((item) => (
                <div key={item.runId} className="wb-automation-run">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-caption">
                      {new Date(item.createdAt).toLocaleString()} ·{" "}
                      {DELIVERY_STATUS[item.dispatchStatus] ||
                        item.dispatchStatus}
                    </p>
                    {item.outcome && RUN_STATUS[item.outcome] && (
                      <p className="text-caption text-fg-3">
                        {RUN_STATUS[item.outcome]}
                      </p>
                    )}
                    {item.prompt && (
                      <p className="line-clamp-3 whitespace-pre-wrap break-words text-caption text-fg-3">
                        {item.prompt}
                      </p>
                    )}
                    {item.error && (
                      <p className="whitespace-pre-wrap text-caption text-danger-text">
                        {item.error}
                      </p>
                    )}
                  </div>
                  {item.sessionId && (
                    <Button
                      variant="neutral"
                      disabled={busy}
                      onClick={() => openSession(item.sessionId!)}
                    >
                      打开运行会话
                    </Button>
                  )}
                  {item.outcome !== "stopped" &&
                    (item.outcome === "running" ||
                      (!item.outcome &&
                        ["claimed", "running", "dispatched"].includes(
                          item.dispatchStatus,
                        ))) && (
                      <Button
                        variant="neutral"
                        disabled={busy || item.cancelRequested}
                        onClick={() =>
                          void run(async () => {
                            await agentApi.automation("cancelRun", [
                              item.runId,
                              scope,
                            ]);
                            runs.reload();
                          })
                        }
                      >
                        {item.cancelRequested ? "正在停止…" : "停止任务"}
                      </Button>
                    )}
                </div>
              ))}
            </section>
          ) : (
            <AgentAutomationSettings
              value={editor}
              onChange={(patch) =>
                setEditor((value) => value && { ...value, ...patch })
              }
              catalog={catalog}
              projectPath={projectPath}
              sessions={availableSessions}
              busy={busy}
              unchanged={Boolean(editor.job && !dirty)}
              onSave={() => save(editor)}
              onCancel={() => showEditor(null)}
            />
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-title font-semibold">自动化任务</h2>
              <p className="mt-1 text-caption text-fg-3">
                按计划把指令投递到目标对话。投递时 LoliCode 需要保持运行。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="neutral"
                aria-label="刷新自动化"
                disabled={jobs.loading}
                onClick={jobs.reload}
              >
                <RefreshCw size={15} />
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={
                  onBuildAutomation || onCompose
                    ? compose
                    : () => showEditor(defaultAutomationSettings(catalog))
                }
              >
                <Plus size={15} /> 新建
              </Button>
              <details
                className="wb-automation-actions"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("button"))
                    event.currentTarget.open = false;
                }}
              >
                <summary aria-label="新建方式">
                  <MoreHorizontal size={18} />
                </summary>
                <div className="wb-automation-actions-menu">
                  {(onBuildAutomation || onCompose) && (
                    <button type="button" disabled={busy} onClick={compose}>
                      在会话中创建
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      showEditor(defaultAutomationSettings(catalog))
                    }
                  >
                    手动创建
                  </button>
                </div>
              </details>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="自动化状态筛选"
            >
              {FILTERS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  className={`wb-automation-filter${filter === id ? " is-active" : ""}`}
                  onClick={() => setFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <Input
              type="search"
              aria-label="搜索自动化任务"
              placeholder="搜索任务"
              className="w-auto max-w-full"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {visible.length ? (
            <div className="grid gap-2">
              {visible.map((job) => (
                <button
                  key={job.automationId}
                  type="button"
                  aria-label={job.title}
                  className="wb-automation-card flex w-full items-start gap-3 text-left hover:bg-bg-2"
                  onClick={() =>
                    showEditor(editAutomationSettings(job, catalog))
                  }
                >
                  <CalendarClock
                    size={17}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-fg-3"
                  />
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate font-medium">
                      {job.title}
                    </strong>
                    <p className="mt-1 truncate text-caption text-fg-3">
                      {job.prompt}
                    </p>
                    {job.lastError && (
                      <p className="mt-1 text-caption text-danger-text">
                        {job.lastError}
                      </p>
                    )}
                  </div>
                  <div className="text-right text-caption text-fg-3">
                    <span>{scheduleLabel(job)}</span>
                    {job.enabled && job.nextRunAt && (
                      <p className="mt-1">
                        下次 {new Date(job.nextRunAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="wb-automation-empty">
              <CalendarClock size={25} aria-hidden="true" />
              <p>
                {jobs.loading ? "正在读取自动化…" : "暂无符合条件的自动化任务"}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
