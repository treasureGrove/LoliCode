import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  Check,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock3,
  FileText,
  ListChecks,
  MoreHorizontal,
  Play,
  RefreshCw,
  Trash2,
  Sparkles,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAgentToolDraft } from "./AgentToolDrafts";
import type { AutomationJob } from "./AgentAutomationSettings";
import { automationScheduleLabel } from "@/lib/agentAutomation";
export { automationCron, automationScheduleLabel } from "@/lib/agentAutomation";
import { agentApi } from "@/lib/api/agent";
import type { AgentCatalog, AgentSession } from "@/types/agent";
import {
  OperationError,
  useAgentOperation,
  useAgentResource,
} from "./AgentOperationShared";

type Job = AutomationJob;
type Run = {
  runId: string;
  automationId: string;
  outcome?: string;
  dispatchStatus: string;
  sessionId?: string;
  error?: string;
  createdAt: number;
  cancelRequested?: boolean;
};
type TaskFilter = "all" | "running" | "completed" | "failed";
type ScheduleTemplate = {
  id: string;
  title: string;
  prompt: string;
  frequency: "daily" | "weekly";
  time: string;
  weekday: string;
  icon: typeof CalendarClock;
  schedule: string;
};

const STATUS: Record<string, string> = {
  running: "执行中",
  succeeded: "已完成",
  failed: "执行失败",
  stopped: "已停止",
  claimed: "等待派发",
  dispatched: "已派发",
  failed_to_dispatch: "派发失败",
  skipped: "已跳过",
  cancelled: "已停止",
};
const FILTERS: { id: TaskFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "running", label: "进行中" },
  { id: "completed", label: "已完成" },
  { id: "failed", label: "失败" },
];
const TEMPLATES: ScheduleTemplate[] = [
  {
    id: "morning-brief",
    title: "晨会动态",
    prompt: "汇总今天的代码变更和待跟进事项。",
    frequency: "daily",
    time: "09:00",
    weekday: "1",
    icon: CalendarClock,
    schedule: "每天 09:00",
  },
  {
    id: "risk-review",
    title: "风险扫描",
    prompt:
      "检查当前项目的风险、阻塞项和近期容易出错的变更，并按优先级整理建议。",
    frequency: "daily",
    time: "12:00",
    weekday: "1",
    icon: CircleAlert,
    schedule: "每天 12:00",
  },
  {
    id: "release-brief",
    title: "发布简报",
    prompt:
      "整理今天的发布说明草稿，汇总重要功能、修复和需要关注的兼容性变化。",
    frequency: "daily",
    time: "18:00",
    weekday: "1",
    icon: FileText,
    schedule: "每天 18:00",
  },
  {
    id: "documentation-review",
    title: "文档同步检查",
    prompt:
      "检查项目文档与当前实现是否保持同步，列出过时、遗漏或互相矛盾的说明。",
    frequency: "weekly",
    time: "15:00",
    weekday: "3",
    icon: ListChecks,
    schedule: "每周三 15:00",
  },
];

function filterMatches(filter: TaskFilter, run?: Run): boolean {
  if (filter === "all") return true;
  const state = run?.outcome || run?.dispatchStatus;
  if (filter === "running")
    return Boolean(
      run && ["running", "claimed", "dispatched"].includes(state || ""),
    );
  if (filter === "completed") return state === "succeeded";
  return state === "failed" || state === "failed_to_dispatch";
}

function TaskStatus({ run, enabled }: { run?: Run; enabled: boolean }) {
  const state = run?.outcome || run?.dispatchStatus;
  if (state === "failed" || state === "failed_to_dispatch")
    return (
      <span className="inline-flex items-center gap-1 text-danger-text">
        <CircleX size={15} /> 执行失败
      </span>
    );
  if (state === "succeeded")
    return (
      <span className="inline-flex items-center gap-1 text-success-text">
        <CircleCheck size={15} /> 已完成
      </span>
    );
  if (state === "stopped" || state === "cancelled")
    return (
      <span className="inline-flex items-center gap-1 text-fg-3">
        <CircleX size={15} />
        已停止
      </span>
    );
  if (state === "skipped")
    return (
      <span className="inline-flex items-center gap-1 text-fg-3">
        <Clock3 size={15} />
        已跳过
      </span>
    );
  if (state === "running" || state === "claimed" || state === "dispatched")
    return (
      <span className="inline-flex items-center gap-1 text-accent-text">
        <Clock3 size={15} /> {STATUS[state] || "执行中"}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-fg-3">
      <Clock3 size={15} /> {enabled ? "等待下次运行" : "已暂停"}
    </span>
  );
}

export function AgentAutomationPanel({
  projectPath,
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
  const [description, setDescription] = useAgentToolDraft(
    `automations:${projectPath}:description`,
    "",
  );
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const operationScope = `automation:${projectPath}`;
  const { busy, error, run } = useAgentOperation(operationScope);
  const scope = { workspacePath: projectPath };
  useEffect(() => {
    setSelected(null);
    setConfirmDelete(null);
    setNotice(null);
  }, [projectPath]);
  const jobs = useAgentResource(
    `automation:${projectPath}`,
    () => agentApi.automation<Job[]>("list", [scope]),
    5000,
    false,
    operationScope,
  );
  const allRuns = useAgentResource(
    `automation-runs:${projectPath}`,
    () => agentApi.automation<Run[]>("listRuns", [null, scope]),
    3000,
    false,
    operationScope,
  );
  const runs = useAgentResource(
    selected ? `automation-runs:${projectPath}:${selected}` : "",
    () => agentApi.automation<Run[]>("listRuns", [selected, scope]),
    3000,
    false,
    operationScope,
  );
  const latestRuns = useMemo(() => {
    const latest = new Map<string, Run>();
    for (const item of allRuns.data || []) {
      const previous = latest.get(item.automationId);
      if (!previous || item.createdAt > previous.createdAt)
        latest.set(item.automationId, item);
    }
    return latest;
  }, [allRuns.data]);
  const visibleJobs = useMemo(
    () =>
      (jobs.data || []).filter((job) =>
        filterMatches(filter, latestRuns.get(job.automationId)),
      ),
    [latestRuns, filter, jobs.data],
  );
  const canBuild = Boolean(onBuildAutomation || onCompose);
  const build = (requirement: string, editing?: Job) =>
    void run(async () => {
      if (!requirement.trim()) throw new Error("请先描述要自动执行的任务");
      if (!canBuild)
        throw new Error("当前入口暂不支持构建设计对话，请返回工作台后重试。");
      const prompt = [
        "请帮我设计当前项目的自动化任务。",
        `项目：${projectPath}`,
        `用户需求：${requirement.trim()}`,
        "任务内容或运行时间不明确时，先向我提问，确认后再生成配置。",
        "请先给我自动化配置卡，等我确认并点击保存后生效。",
        editing
          ? `请先询问我希望如何调整“${editing.title}”，保留未要求修改的设置。\n原任务配置：\n${JSON.stringify(editing, null, 2)}`
          : "请沿用当前对话的模型与执行设置。",
      ].join("\n\n");
      if (onBuildAutomation) {
        await onBuildAutomation(prompt);
        setNotice("已打开设计对话，确认配置卡后点击保存自动化。");
      } else {
        onCompose!(prompt);
        setNotice(
          "已将需求填入对话，发送后继续设计；配置卡保存前任务尚未创建。",
        );
      }
      // A delayed design-session response must not clear a newer description.
      setDescription((current) => (current === requirement ? "" : current));
    });
  const startFromTemplate = (template: ScheduleTemplate) =>
    build(
      `创建“${template.title}”：${template.prompt} 运行计划：${template.schedule}。`,
    );
  const edit = (job: Job) => build("请帮我调整这项已有自动化任务。", job);
  const focusDescription = () => descriptionInput.current?.focus();

  return (
    <div className="wb-automation space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-title font-semibold">自动化</h2>
          <p className="mt-1 text-caption text-fg-3">
            定时执行或在电脑闲置时处理任务。LoliCode
            需要保持运行，权限确认会保留到你回来处理。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="neutral"
            aria-label="刷新自动化"
            title="刷新自动化"
            disabled={jobs.loading}
            onClick={() => {
              jobs.reload();
              allRuns.reload();
              runs.reload();
            }}
          >
            <RefreshCw
              size={15}
              className={jobs.loading ? "animate-spin" : ""}
            />
          </Button>
          <Button variant="default" onClick={focusDescription} disabled={busy}>
            <Sparkles size={15} /> 用对话创建
          </Button>
        </div>
      </div>

      <form
        className="wb-automation-create space-y-3"
        aria-label="通过对话构建自动化"
        onSubmit={(event) => {
          event.preventDefault();
          build(description);
        }}
      >
        <label className="block space-y-2">
          <span className="text-sm font-medium">描述自动化任务</span>
          <textarea
            ref={descriptionInput}
            className={fieldClass}
            rows={3}
            required
            aria-label="描述自动化任务"
            placeholder="例如：每天早上 9 点检查当前项目的代码变更，整理风险与待办。"
            value={description}
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-caption text-fg-3">
            Agent 会先澄清需求，再给出配置卡。点击保存后才会执行计划。
          </p>
          <Button
            type="submit"
            disabled={busy || !description.trim() || !canBuild}
          >
            {busy ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles size={15} aria-hidden="true" />
            )}
            {busy ? "正在处理…" : "开始对话构建"}
          </Button>
        </div>
        {!canBuild && (
          <p role="status" className="text-caption text-fg-3">
            当前入口暂不支持构建设计对话，请返回工作台后重试。
          </p>
        )}
      </form>

      <OperationError>
        {error || jobs.error || allRuns.error || runs.error}
      </OperationError>
      {notice && (
        <p role="status" className="text-caption text-fg-3">
          {notice}
        </p>
      )}

      {(jobs.data?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="自动化状态筛选"
          >
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                className={`wb-automation-filter${filter === item.id ? " is-active" : ""}`}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="text-caption text-fg-3">
            {jobs.data?.length ?? 0} 个自动化任务
          </span>
        </div>
      )}

      {jobs.data?.length ? (
        visibleJobs.length ? (
          <div className="wb-automation-grid">
            {visibleJobs.map((job) => {
              const latest = latestRuns.get(job.automationId);
              return (
                <section key={job.automationId} className="wb-automation-card">
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      className="wb-automation-card-icon"
                      aria-hidden="true"
                    >
                      <CalendarClock size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-medium">
                        <button
                          type="button"
                          className="hover:underline"
                          disabled={busy || !canBuild}
                          onClick={() => edit(job)}
                        >
                          {job.title}
                        </button>
                      </h3>
                      <p className="mt-1 line-clamp-2 min-h-10 text-caption text-fg-3">
                        {job.prompt}
                      </p>
                    </div>
                    <details
                      className="wb-automation-actions"
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest("button")) {
                          event.currentTarget.open = false;
                        }
                      }}
                    >
                      <summary aria-label={`${job.title} 的更多操作`}>
                        <MoreHorizontal size={18} />
                      </summary>
                      <div className="wb-automation-actions-menu">
                        <button
                          type="button"
                          disabled={busy || !canBuild}
                          onClick={() => edit(job)}
                        >
                          编辑任务
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const result = await agentApi.automation<{
                                status: string;
                              }>("runNow", [job.automationId, scope]);
                              setSelected(job.automationId);
                              setNotice(
                                result.status === "duplicate"
                                  ? "此任务已经在执行，请查看运行记录。"
                                  : "已提交任务，等待原生执行结果。",
                              );
                              allRuns.reload();
                              runs.reload();
                            })
                          }
                        >
                          <Play size={14} /> 立即运行
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setSelected(job.automationId)}
                        >
                          <Clock3 size={14} /> 查看运行记录
                        </button>
                        <button
                          type="button"
                          className="is-danger"
                          disabled={busy}
                          onClick={() => setConfirmDelete(job.automationId)}
                        >
                          <Trash2 size={14} /> 删除任务
                        </button>
                      </div>
                    </details>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-caption">
                    <Switch
                      aria-label={`${job.title} 启用计划`}
                      checked={job.enabled}
                      disabled={busy}
                      onCheckedChange={(enabled) =>
                        void run(async () => {
                          const result = await agentApi.automation<Job | null>(
                            "setEnabled",
                            [job.automationId, enabled, scope],
                          );
                          if (!result)
                            throw new Error("任务已不存在，请刷新列表");
                          jobs.reload();
                        })
                      }
                    />
                    <TaskStatus run={latest} enabled={job.enabled} />
                    <span className="inline-flex items-center gap-1 text-fg-3">
                      <Clock3 size={14} />{" "}
                      {job.trigger === "idle"
                        ? `闲置 ${job.idleAfterMinutes || 10} 分钟 · 间隔 ${job.idleIntervalMinutes || 60} 分钟`
                        : automationScheduleLabel(job.cronExpr)}
                    </span>
                    {job.enabled && job.nextRunAt ? (
                      <span className="text-fg-3">
                        下次 {new Date(job.nextRunAt).toLocaleString()}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="ml-auto text-fg-3 hover:text-fg-1"
                      onClick={() =>
                        setSelected(
                          selected === job.automationId
                            ? null
                            : job.automationId,
                        )
                      }
                    >
                      {selected === job.automationId ? "收起记录" : "查看记录"}
                    </button>
                  </div>
                  {job.lastError && (
                    <p
                      role="status"
                      className="mt-2 text-caption text-danger-text"
                    >
                      {job.lastError}
                    </p>
                  )}
                  {confirmDelete === job.automationId && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-control bg-bg-subtle p-2">
                      <span className="mr-auto text-caption">
                        确定删除“{job.title}”及其计划吗？
                      </span>
                      <Button
                        variant="neutral"
                        onClick={() => setConfirmDelete(null)}
                      >
                        取消
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const removed = await agentApi.automation<boolean>(
                              "delete",
                              [job.automationId, scope],
                            );
                            if (!removed)
                              throw new Error("删除未完成，请刷新列表");
                            if (selected === job.automationId)
                              setSelected(null);
                            setConfirmDelete(null);
                            jobs.reload();
                            allRuns.reload();
                          })
                        }
                      >
                        确认删除自动化
                      </Button>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="wb-automation-empty-filter">
            <p>没有符合此状态的自动化任务。</p>
            <button type="button" onClick={() => setFilter("all")}>
              查看全部任务
            </button>
          </div>
        )
      ) : (
        <div className="wb-automation-empty">
          <p>{jobs.loading ? "正在读取自动化…" : "还没有自动化任务"}</p>
          {!jobs.loading && (
            <Button
              variant="neutral"
              onClick={focusDescription}
              disabled={busy}
            >
              描述第一个任务
            </Button>
          )}
        </div>
      )}

      {selected && jobs.data?.some((job) => job.automationId === selected) && (
        <section className="wb-automation-history" aria-label="自动化运行记录">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">运行记录</h3>
            <Button variant="neutral" onClick={() => setSelected(null)}>
              收起
            </Button>
          </div>
          {!runs.data?.length && (
            <p className="py-4 text-caption text-fg-3">
              {runs.loading ? "正在读取运行记录…" : "尚无运行记录。"}
            </p>
          )}
          {runs.data?.map((item) => (
            <div key={item.runId} className="wb-automation-run">
              <div className="min-w-0 flex-1">
                <p className="text-caption">
                  {new Date(item.createdAt).toLocaleString()} ·{" "}
                  {STATUS[item.outcome || item.dispatchStatus] ||
                    item.outcome ||
                    item.dispatchStatus}
                </p>
                {item.error && (
                  <p className="mt-1 whitespace-pre-wrap text-caption text-danger-text">
                    {item.error}
                  </p>
                )}
                <p className="mt-1 truncate text-caption text-fg-3">
                  {item.runId}
                </p>
              </div>
              {item.sessionId && (
                <Button
                  variant="neutral"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const sessions = await agentApi.listSessions(
                        projectPath,
                        true,
                      );
                      const session = sessions.find(
                        (candidate) =>
                          candidate.id === item.sessionId ||
                          candidate.id === `zc:${item.sessionId}`,
                      );
                      if (!session)
                        throw new Error("运行会话暂未写入索引，请稍后重试");
                      onSession(session);
                    })
                  }
                >
                  打开运行会话
                </Button>
              )}
              {(item.outcome === "running" ||
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
                      allRuns.reload();
                    })
                  }
                >
                  {item.cancelRequested ? "正在停止…" : "停止任务"}
                </Button>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="wb-automation-templates">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-caption font-medium text-fg-3">从模板开始</h3>
          <span className="text-caption text-fg-3">
            选择模板后在对话中完善，再确认保存
          </span>
        </div>
        <div className="wb-automation-grid">
          {TEMPLATES.map((template) => {
            const Icon = template.icon;
            return (
              <button
                key={template.id}
                type="button"
                className="wb-automation-template"
                disabled={busy || !canBuild}
                onClick={() => startFromTemplate(template)}
              >
                <span className="flex items-center gap-2 font-medium text-fg-1">
                  <Icon size={16} aria-hidden="true" /> {template.title}
                </span>
                <span className="line-clamp-2 text-caption text-fg-3">
                  {template.prompt}
                </span>
                <span className="mt-auto inline-flex items-center gap-1 text-caption text-fg-3">
                  <Check size={13} aria-hidden="true" /> {template.schedule}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
