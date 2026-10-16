import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock3,
  FileText,
  ListChecks,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, fieldClass } from "@/components/ui/input";
import { agentApi } from "@/lib/api/agent";
import type { AgentCatalog, AgentSession } from "@/types/agent";
import {
  OperationError,
  useAgentOperation,
  useAgentResource,
} from "./AgentOperationShared";

type Job = {
  automationId: string;
  title: string;
  prompt: string;
  cronExpr: string;
  enabled: boolean;
  lifecycleStatus: string;
  nextRunAt?: number;
  trigger?: "schedule" | "idle";
  idleAfterMinutes?: number;
  idleIntervalMinutes?: number;
  lastError?: string;
  mode?: string;
  modelSelection?: { providerId: string; modelId: string };
};
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

export function automationCron(
  frequency: string,
  time: string,
  weekday: string,
  minute: string,
): string {
  if (frequency === "hourly") {
    if (!/^\d{1,2}$/.test(minute) || Number(minute) > 59)
      throw new Error("请选择每小时 0–59 分钟中的一个时间");
    return `${Number(minute)} * * * *`;
  }
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new Error("请选择有效的运行时间");
  if (frequency === "weekly" && !/^[0-6]$/.test(weekday))
    throw new Error("请选择运行星期");
  return `${Number(match[2])} ${Number(match[1])} * * ${frequency === "weekly" ? weekday : "*"}`;
}

export function automationScheduleLabel(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (
    fields.length !== 5 ||
    !/^\d{1,2}$/.test(fields[0]) ||
    Number(fields[0]) > 59 ||
    fields[2] !== "*" ||
    fields[3] !== "*"
  )
    return "自定义计划";
  const minute = fields[0].padStart(2, "0");
  if (fields[1] === "*" && fields[4] === "*") return `每小时 ${minute} 分`;
  if (!/^\d{1,2}$/.test(fields[1]) || Number(fields[1]) > 23)
    return "自定义计划";
  const time = `${fields[1].padStart(2, "0")}:${minute}`;
  if (fields[4] === "*") return `每天 ${time}`;
  if (/^[0-6]$/.test(fields[4]))
    return `每周${["日", "一", "二", "三", "四", "五", "六"][Number(fields[4])]} ${time}`;
  return "自定义计划";
}

function latestRunFor(job: Job, runs: readonly Run[]): Run | undefined {
  return runs.find((run) => run.automationId === job.automationId);
}

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
  catalog,
  onSession,
  onCompose,
}: {
  projectPath: string;
  catalog: AgentCatalog;
  onSession: (session: AgentSession) => void;
  onCompose?: (text: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [frequency, setFrequency] = useState("daily");
  const [trigger, setTrigger] = useState<"schedule" | "idle">("schedule");
  const [idleAfter, setIdleAfter] = useState("10");
  const [idleInterval, setIdleInterval] = useState("60");
  const [editing, setEditing] = useState<string | null>(null);
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("1");
  const [minute, setMinute] = useState("0");
  const [modelId, setModelId] = useState(
    catalog.defaultModel || catalog.models[0]?.id || "",
  );
  const [mode, setMode] = useState("build");
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { busy, error, run } = useAgentOperation();
  const scope = { workspacePath: projectPath };
  useEffect(() => {
    setSelected(null);
    setEditing(null);
    setCreateOpen(false);
    setConfirmDelete(null);
    setNotice(null);
  }, [projectPath]);
  useEffect(() => {
    if (!catalog.models.some((model) => model.id === modelId))
      setModelId(catalog.defaultModel || catalog.models[0]?.id || "");
  }, [catalog, modelId]);
  const idleStatus = useAgentResource(
    trigger === "idle" && createOpen ? `automation-idle:${projectPath}` : "",
    () =>
      agentApi.automation<{ supported: boolean; reason?: string }>(
        "idleStatus",
        [],
      ),
    0,
  );
  const jobs = useAgentResource(`automation:${projectPath}`, () =>
    agentApi.automation<Job[]>("list", [scope]),
  );
  const allRuns = useAgentResource(
    `automation-runs:${projectPath}`,
    () => agentApi.automation<Run[]>("listRuns", [null, scope]),
    3000,
  );
  const runs = useAgentResource(
    selected ? `automation-runs:${projectPath}:${selected}` : "",
    () => agentApi.automation<Run[]>("listRuns", [selected, scope]),
    3000,
  );
  const visibleJobs = useMemo(
    () =>
      (jobs.data || []).filter((job) =>
        filterMatches(filter, latestRunFor(job, allRuns.data || [])),
      ),
    [allRuns.data, filter, jobs.data],
  );
  const create = () =>
    void run(async () => {
      const model = catalog.models.find((item) => item.id === modelId);
      if (!title.trim() || !prompt.trim() || !model)
        throw new Error("请填写名称、任务内容并选择模型");
      if (
        trigger === "idle" &&
        (!idleAfter.trim() ||
          !idleInterval.trim() ||
          !Number.isInteger(Number(idleAfter)) ||
          !Number.isInteger(Number(idleInterval)) ||
          Number(idleAfter) < 1 ||
          Number(idleAfter) > 1440 ||
          Number(idleInterval) < 1 ||
          Number(idleInterval) > 10080)
      )
        throw new Error("请填写有效的闲置分钟和运行间隔");
      const input = {
        title: title.trim(),
        prompt: prompt.trim(),
        cronExpr:
          trigger === "idle"
            ? "0 * * * *"
            : automationCron(frequency, time, weekday, minute),
        trigger,
        idleAfterMinutes: Number(idleAfter),
        idleIntervalMinutes: Number(idleInterval),
        locale: document.documentElement.lang || "zh",
        workspacePath: projectPath,
        recurring: true,
        mode,
        modelSelection: {
          providerId: model.providerId,
          modelId: model.modelId,
          options: {
            reasoningLevel:
              (model.reasoningEfforts?.includes("medium")
                ? "medium"
                : model.reasoningEfforts?.includes("high")
                  ? "high"
                  : model.defaultReasoningEffort) ||
              model.reasoningEfforts?.[0] ||
              "default",
          },
        },
      };
      const job = await agentApi.automation<Job>(
        editing ? "update" : "create",
        editing ? [editing, input, scope] : [input],
      );
      setSelected(job.automationId);
      setTitle("");
      setPrompt("");
      setEditing(null);
      setNotice("已保存自动化。应用运行时会按计划执行。");
      setCreateOpen(false);
      jobs.reload();
      allRuns.reload();
    });
  const startFromTemplate = (template: ScheduleTemplate) => {
    setEditing(null);
    setTrigger("schedule");
    setTitle(template.title);
    setPrompt(template.prompt);
    setFrequency(template.frequency);
    setTime(template.time);
    setWeekday(template.weekday);
    setCreateOpen(true);
    setMenuOpen(false);
  };
  const edit = (job: Job) => {
    setEditing(job.automationId);
    setTitle(job.title);
    setPrompt(job.prompt);
    setMode(job.mode || "build");
    setTrigger(job.trigger || "schedule");
    setIdleAfter(String(job.idleAfterMinutes || 10));
    setIdleInterval(String(job.idleIntervalMinutes || 60));
    const fields = job.cronExpr.split(/\s+/);
    setFrequency(
      fields[1] === "*" ? "hourly" : fields[4] === "*" ? "daily" : "weekly",
    );
    setMinute(fields[0]);
    setTime(`${fields[1].padStart(2, "0")}:${fields[0].padStart(2, "0")}`);
    setWeekday(fields[4] === "*" ? "1" : fields[4]);
    const model = catalog.models.find(
      (model) =>
        model.providerId === job.modelSelection?.providerId &&
        model.modelId === job.modelSelection?.modelId,
    );
    if (model) setModelId(model.id);
    setCreateOpen(true);
  };
  const createViaChat = () => {
    if (!onCompose) return;
    onCompose(
      `请帮我设计当前项目的自动化任务。先和我确认任务名称、内容，以及定时计划或电脑闲置触发规则，再整理成可填写到自动化面板的配置。尚未保存前不要宣称已经创建。`,
    );
  };

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
            disabled={busy || jobs.loading}
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
          <div className="relative">
            <Button
              variant="default"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              创建定时任务 <ChevronDown size={15} />
            </Button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 z-20 mt-2 min-w-48 rounded-control border border-border bg-bg-card p-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="wb-automation-menu-item"
                  onClick={() => {
                    setEditing(null);
                    setCreateOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  手动创建
                </button>
                {onCompose && (
                  <button
                    type="button"
                    role="menuitem"
                    className="wb-automation-menu-item"
                    onClick={createViaChat}
                  >
                    通过对话设计
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

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
            {jobs.data?.length ?? 0} 个定时任务
          </span>
        </div>
      )}

      {jobs.data?.length ? (
        visibleJobs.length ? (
          <div className="wb-automation-grid">
            {visibleJobs.map((job) => {
              const latest = latestRunFor(job, allRuns.data || []);
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
                      <h3 className="truncate font-medium">{job.title}</h3>
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
                          disabled={busy}
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
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const result =
                                await agentApi.automation<Job | null>(
                                  "setEnabled",
                                  [job.automationId, !job.enabled, scope],
                                );
                              if (!result)
                                throw new Error("任务已不存在，请刷新列表");
                              jobs.reload();
                            })
                          }
                        >
                          {job.enabled ? (
                            <Pause size={14} />
                          ) : (
                            <Play size={14} />
                          )}
                          {job.enabled ? "暂停计划" : "启用计划"}
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
          <p>{jobs.loading ? "正在读取自动化…" : "还没有定时任务"}</p>
          {!jobs.loading && (
            <Button variant="default" onClick={() => setCreateOpen(true)}>
              创建定时任务 <ChevronDown size={15} />
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

      {createOpen && (
        <form
          className="wb-automation-create"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-medium">
                {editing ? "编辑自动化任务" : "创建定时任务"}
              </h3>
              <p className="mt-1 text-caption text-fg-3">
                定时任务按本地时区运行；闲时任务检测系统键鼠闲置，并等待 Agent
                空闲。
              </p>
            </div>
            <button
              type="button"
              className="text-caption text-fg-3 hover:text-fg-1"
              onClick={() => setCreateOpen(false)}
            >
              取消
            </button>
          </div>
          <div className="wb-automation-form-grid">
            <label className="block text-caption">
              触发方式
              <select
                aria-label="自动化触发方式"
                className={fieldClass}
                value={trigger}
                disabled={busy}
                onChange={(event) =>
                  setTrigger(event.target.value as typeof trigger)
                }
              >
                <option value="schedule">定时运行</option>
                <option value="idle">电脑闲置时运行</option>
              </select>
            </label>
            {trigger === "idle" && (
              <>
                <label className="block text-caption">
                  闲置分钟
                  <Input
                    type="number"
                    min={1}
                    max={1440}
                    aria-label="自动化闲置分钟"
                    value={idleAfter}
                    disabled={busy}
                    onChange={(event) => setIdleAfter(event.target.value)}
                  />
                </label>
                <label className="block text-caption">
                  最小运行间隔（分钟）
                  <Input
                    type="number"
                    min={1}
                    max={10080}
                    aria-label="自动化闲时间隔"
                    value={idleInterval}
                    disabled={busy}
                    onChange={(event) => setIdleInterval(event.target.value)}
                  />
                </label>
                {idleStatus.data?.supported === false && (
                  <p role="status" className="text-caption text-danger-text">
                    {idleStatus.data.reason}
                  </p>
                )}
              </>
            )}
            <label className="block text-caption">
              名称
              <Input
                aria-label="自动化名称"
                value={title}
                disabled={busy}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            {trigger === "schedule" && (
              <label className="block text-caption">
                运行频率
                <select
                  aria-label="自动化运行频率"
                  className={fieldClass}
                  value={frequency}
                  disabled={busy}
                  onChange={(event) => setFrequency(event.target.value)}
                >
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                  <option value="hourly">每小时</option>
                </select>
              </label>
            )}
            {trigger === "schedule" &&
              (frequency === "hourly" ? (
                <label className="block text-caption">
                  每小时的第几分钟
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    aria-label="自动化每小时分钟"
                    value={minute}
                    disabled={busy}
                    onChange={(event) => setMinute(event.target.value)}
                  />
                </label>
              ) : (
                <label className="block text-caption">
                  运行时间
                  <Input
                    type="time"
                    aria-label="自动化运行时间"
                    value={time}
                    disabled={busy}
                    onChange={(event) => setTime(event.target.value)}
                  />
                </label>
              ))}
            {trigger === "schedule" && frequency === "weekly" && (
              <label className="block text-caption">
                运行星期
                <select
                  aria-label="自动化运行星期"
                  className={fieldClass}
                  value={weekday}
                  disabled={busy}
                  onChange={(event) => setWeekday(event.target.value)}
                >
                  {[
                    "星期日",
                    "星期一",
                    "星期二",
                    "星期三",
                    "星期四",
                    "星期五",
                    "星期六",
                  ].map((name, index) => (
                    <option key={name} value={index}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-caption">
              模型
              <select
                aria-label="自动化模型"
                className={fieldClass}
                value={modelId}
                disabled={busy}
                onChange={(event) => setModelId(event.target.value)}
              >
                {catalog.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.channelName} · {model.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-caption">
              执行权限
              <select
                aria-label="自动化权限"
                className={fieldClass}
                value={mode}
                disabled={busy}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="build">操作前询问</option>
                <option value="guarded">自动 · 风险操作询问</option>
                <option value="yolo">完全访问</option>
              </select>
            </label>
            <label className="block text-caption wb-automation-prompt">
              任务内容
              <textarea
                aria-label="自动化任务内容"
                className={fieldClass}
                rows={4}
                value={prompt}
                disabled={busy}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="neutral"
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={
                busy ||
                !title.trim() ||
                !prompt.trim() ||
                !catalog.models.length
              }
            >
              {editing ? "保存修改" : "保存定时任务"}
            </Button>
          </div>
        </form>
      )}

      <section className="wb-automation-templates">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-caption font-medium text-fg-3">定时任务模板</h3>
          <span className="text-caption text-fg-3">
            选择模板后可修改名称、计划和任务内容
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
