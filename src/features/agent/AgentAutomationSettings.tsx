import { ArrowLeft, CalendarClock, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, fieldClass } from "@/components/ui/input";
import type { AgentCatalog, AgentSession } from "@/types/agent";
import { AgentModelPicker } from "./AgentModelPicker";

export type AutomationTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "new_once" | "new" };

export type AutomationJob = {
  automationId: string;
  title: string;
  prompt: string;
  cronExpr: string;
  enabled: boolean;
  lifecycleStatus: string;
  recurring?: boolean;
  locale?: string;
  nextRunAt?: number;
  runAt?: number;
  updatedAt?: number;
  target?: AutomationTarget;
  reusableSessionId?: string;
  trigger?: "schedule" | "idle";
  idleAfterMinutes?: number;
  idleIntervalMinutes?: number;
  lastError?: string;
  mode?: string;
  modelSelection?: {
    providerId: string;
    modelId: string;
    options?: Record<string, unknown>;
  };
};

export type AutomationSettings = {
  job: AutomationJob | null;
  title: string;
  prompt: string;
  trigger: "schedule" | "idle";
  frequency: string;
  time: string;
  weekday: string;
  minute: string;
  runAt: string;
  target: AutomationTarget;
  idleAfter: string;
  idleInterval: string;
  modelId: string;
  reasoning: string;
  mode: string;
};

import { automationCron, automationScheduleLabel } from "@/lib/agentAutomation";
export { automationCron, automationScheduleLabel } from "@/lib/agentAutomation";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
export function defaultAutomationSettings(
  catalog: AgentCatalog,
): AutomationSettings {
  return {
    job: null,
    title: "",
    prompt: "",
    trigger: "schedule",
    frequency: "daily",
    time: "09:00",
    weekday: "1",
    minute: "0",
    runAt: "",
    target: { kind: "new_once" },
    idleAfter: "10",
    idleInterval: "60",
    modelId: catalog.defaultModel || catalog.models[0]?.id || "",
    reasoning: "",
    mode: "build",
  };
}

export function editAutomationSettings(
  job: AutomationJob,
  catalog: AgentCatalog,
): AutomationSettings {
  const fields = job.cronExpr.trim().split(/\s+/);
  const model = catalog.models.find(
    (item) =>
      item.providerId === job.modelSelection?.providerId &&
      item.modelId === job.modelSelection?.modelId,
  );
  const runAt = job.runAt ? new Date(job.runAt) : null;
  const localRunAt = runAt
    ? new Date(runAt.getTime() - runAt.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16)
    : "";
  return {
    ...defaultAutomationSettings(catalog),
    job,
    title: job.title,
    prompt: job.prompt,
    trigger: job.trigger || "schedule",
    mode: job.mode || "build",
    frequency: runAt
      ? "once"
      : fields[1] === "*"
        ? "hourly"
        : fields[4] === "*"
          ? "daily"
          : "weekly",
    time:
      fields[1] === "*"
        ? "09:00"
        : `${fields[1]?.padStart(2, "0")}:${fields[0]?.padStart(2, "0")}`,
    weekday: fields[4] === "*" ? "1" : fields[4],
    minute: fields[0],
    runAt: localRunAt,
    target: job.target ?? { kind: "new" },
    idleAfter: String(job.idleAfterMinutes ?? 10),
    idleInterval: String(job.idleIntervalMinutes ?? 60),
    modelId: model?.id || "",
    reasoning:
      typeof job.modelSelection?.options?.reasoningLevel === "string"
        ? job.modelSelection.options.reasoningLevel
        : "",
  };
}

export function AgentAutomationSettings({
  value,
  onChange,
  catalog,
  projectPath,
  sessions,
  busy,
  unchanged,
  error,
  onSave,
  onCancel,
}: {
  value: AutomationSettings;
  onChange: (patch: Partial<AutomationSettings>) => void;
  catalog: AgentCatalog;
  projectPath: string;
  sessions: AgentSession[];
  busy: boolean;
  unchanged: boolean;
  error?: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const model = catalog.models.find((item) => item.id === value.modelId);
  const efforts = [
    ...new Set([
      ...(model?.reasoningEfforts || []),
      ...(value.reasoning && value.reasoning !== "default"
        ? [value.reasoning]
        : []),
    ]),
  ];
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let summary: string;
  try {
    summary =
      value.trigger === "idle"
        ? `电脑闲置 ${value.idleAfter || "…"} 分钟后运行，至少间隔 ${value.idleInterval || "…"} 分钟`
        : value.frequency === "once"
          ? value.runAt
            ? `仅一次 · ${new Date(value.runAt).toLocaleString()}`
            : "选择运行日期和时间"
          : automationScheduleLabel(
              automationCron(
                value.frequency,
                value.time,
                value.weekday,
                value.minute,
              ),
            );
  } catch {
    summary = "请选择有效的运行时间和星期";
  }
  return (
    <form
      className="wb-automation-settings"
      aria-label="自动化设置"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="wb-automation-settings-heading">
        <Button
          type="button"
          variant="neutral"
          disabled={busy}
          onClick={onCancel}
          aria-label="返回自动化列表"
        >
          <ArrowLeft size={16} />
        </Button>
        <div>
          <h2 className="text-title font-semibold">
            {value.job ? value.job.title : "手动创建任务"}
          </h2>
          <p className="mt-1 text-caption text-fg-3">
            设置要投递的指令、时间和目标对话。
          </p>
        </div>
      </div>
      <section className="wb-automation-settings-section" aria-label="任务设置">
        <h3>任务</h3>
        <label>
          名称
          <Input
            autoFocus
            required
            maxLength={160}
            aria-label="自动化名称"
            placeholder="例如：每日代码检查"
            value={value.title}
            disabled={busy}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </label>
        <label>
          任务内容
          <textarea
            required
            aria-label="自动化任务内容"
            className={fieldClass}
            rows={5}
            placeholder="描述要完成的工作，以及希望如何整理结果…"
            value={value.prompt}
            disabled={busy}
            onChange={(event) => onChange({ prompt: event.target.value })}
          />
        </label>
        <div className="wb-automation-project">
          <FolderOpen size={16} aria-hidden="true" />
          <div>
            <span className="text-caption text-fg-3">运行项目</span>
            <p>{projectPath}</p>
          </div>
        </div>
      </section>
      <section
        className="wb-automation-settings-section"
        aria-label="运行计划设置"
      >
        <h3>运行计划</h3>
        <div className="wb-automation-form-grid">
          {value.job?.trigger === "idle" && (
            <label>
              触发方式
              <select
                aria-label="自动化触发方式"
                className={fieldClass}
                value={value.trigger}
                disabled={busy}
                onChange={(event) =>
                  onChange({
                    trigger: event.target
                      .value as AutomationSettings["trigger"],
                  })
                }
              >
                <option value="schedule">定时运行</option>
                <option value="idle">电脑闲置时运行（已有任务）</option>
              </select>
            </label>
          )}
          {value.trigger === "schedule" ? (
            <>
              <label>
                运行频率
                <select
                  aria-label="自动化运行频率"
                  className={fieldClass}
                  value={value.frequency}
                  disabled={busy}
                  onChange={(event) =>
                    onChange({ frequency: event.target.value })
                  }
                >
                  <option value="once">仅一次</option>
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                  <option value="hourly">每小时</option>
                </select>
              </label>
              {value.frequency === "once" ? (
                <label>
                  日期和时间
                  <Input
                    type="datetime-local"
                    required
                    aria-label="自动化运行日期和时间"
                    value={value.runAt}
                    disabled={busy}
                    onChange={(event) =>
                      onChange({ runAt: event.target.value })
                    }
                  />
                </label>
              ) : value.frequency === "hourly" ? (
                <label>
                  每小时的第几分钟
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    required
                    aria-label="自动化每小时分钟"
                    value={value.minute}
                    disabled={busy}
                    onChange={(event) =>
                      onChange({ minute: event.target.value })
                    }
                  />
                </label>
              ) : (
                <label>
                  运行时间
                  <Input
                    type="time"
                    required
                    aria-label="自动化运行时间"
                    value={value.time}
                    disabled={busy}
                    onChange={(event) => onChange({ time: event.target.value })}
                  />
                </label>
              )}
              {value.frequency === "weekly" && (
                <div
                  className="wb-automation-weekdays"
                  role="group"
                  aria-label="自动化运行星期"
                >
                  <span>运行星期</span>
                  <div>
                    {[1, 2, 3, 4, 5, 6, 0].map((day) => {
                      const days = value.weekday.split(",").filter(Boolean);
                      const selected = days.includes(String(day));
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-label={`星期${WEEKDAYS[day]}`}
                          aria-pressed={selected}
                          disabled={busy}
                          onClick={() =>
                            onChange({
                              weekday: (selected
                                ? days.filter((item) => item !== String(day))
                                : [...days, String(day)]
                              )
                                .sort()
                                .join(","),
                            })
                          }
                        >
                          {WEEKDAYS[day]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <label>
                闲置分钟
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  required
                  aria-label="自动化闲置分钟"
                  value={value.idleAfter}
                  disabled={busy}
                  onChange={(event) =>
                    onChange({ idleAfter: event.target.value })
                  }
                />
              </label>
              <label>
                最小运行间隔（分钟）
                <Input
                  type="number"
                  min={1}
                  max={10080}
                  required
                  aria-label="自动化闲时间隔"
                  value={value.idleInterval}
                  disabled={busy}
                  onChange={(event) =>
                    onChange({ idleInterval: event.target.value })
                  }
                />
              </label>
            </>
          )}
        </div>
        <p className="text-caption text-fg-3">
          {value.trigger === "schedule"
            ? `按本地时区 ${timezone} 运行。`
            : "检测系统键鼠闲置，并等待 Agent 空闲。"}{" "}
          LoliCode 需要保持运行。
        </p>
      </section>
      <section className="wb-automation-settings-section" aria-label="执行位置">
        <h3>执行位置</h3>
        <label>
          投递目标
          <select
            className={fieldClass}
            value={
              value.target.kind === "session"
                ? `session:${value.target.sessionId}`
                : value.target.kind
            }
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value;
              onChange({
                target: next.startsWith("session:")
                  ? {
                      kind: "session",
                      sessionId: next.slice("session:".length),
                    }
                  : { kind: next === "new" ? "new" : "new_once" },
              });
            }}
          >
            <option value="new_once">新建对话并复用</option>
            <option value="new">每次新建对话</option>
            {value.target.kind === "session" &&
              !sessions.some(
                (session) =>
                  value.target.kind === "session" &&
                  session.id === value.target.sessionId,
              ) && (
                <option value={`session:${value.target.sessionId}`}>
                  已关联的对话
                </option>
              )}
            {sessions.length > 0 && (
              <optgroup label="已有对话">
                {sessions.map((session) => (
                  <option key={session.id} value={`session:${session.id}`}>
                    {session.title}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {value.target.kind === "session" && (
          <p className="text-caption text-fg-3">
            对话空闲后可投递，沿用该对话的模型，自动化运行使用逐次确认。
          </p>
        )}
      </section>
      {value.target.kind !== "session" && (
        <section
          className="wb-automation-settings-section"
          aria-label="执行设置"
        >
          <h3>执行设置</h3>
          <div className="wb-automation-form-grid">
            <label>
              模型
              <AgentModelPicker
                ariaLabel="自动化模型"
                className={`${fieldClass} w-full max-w-none`}
                models={catalog.models}
                value={value.modelId}
                disabled={busy}
                unavailableLabel="请选择可用模型"
                side="bottom"
                onSelect={(modelId) => onChange({ modelId, reasoning: "" })}
              />
            </label>
            <label>
              思考档位
              <select
                aria-label="自动化思考档位"
                className={fieldClass}
                value={value.reasoning}
                disabled={busy || !model}
                onChange={(event) =>
                  onChange({ reasoning: event.target.value })
                }
              >
                <option value="">自动</option>
                <option value="default">模型默认</option>
                {efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
            <label>
              执行权限
              <select
                aria-label="自动化权限"
                className={fieldClass}
                value={value.mode}
                disabled={busy}
                onChange={(event) => onChange({ mode: event.target.value })}
              >
                <option value="build">操作前询问</option>
                <option value="guarded">自动 · 风险操作询问</option>
                <option value="yolo">完全访问</option>
              </select>
            </label>
          </div>
          <p className="text-caption text-fg-3">
            需要确认的操作会等待你处理；每次运行的结果可在运行记录中查看。
          </p>
          {value.job?.recurring === false && (
            <p className="text-caption text-fg-3">此任务只运行一次。</p>
          )}
        </section>
      )}
      <div className="wb-automation-settings-footer">
        <div className="wb-automation-summary">
          <CalendarClock size={17} aria-hidden="true" />
          <span>
            {summary}
            {value.job && !value.job.enabled ? " · 已暂停" : ""}
          </span>
        </div>
        {error && (
          <p
            role="alert"
            className="wb-automation-settings-error text-caption text-danger-text"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="neutral"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            type="submit"
            variant="default"
            disabled={
              busy ||
              unchanged ||
              !value.title.trim() ||
              !value.prompt.trim() ||
              (value.target.kind !== "session" && !model) ||
              (value.trigger === "schedule" &&
                value.frequency === "once" &&
                !value.runAt) ||
              (value.trigger === "schedule" &&
                value.frequency === "weekly" &&
                !value.weekday)
            }
          >
            {busy ? "正在保存…" : value.job ? "保存修改" : "保存自动化"}
          </Button>
        </div>
      </div>
    </form>
  );
}
