import { ArrowLeft, CalendarClock, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, fieldClass } from "@/components/ui/input";
import type { AgentCatalog } from "@/types/agent";
import { AgentModelPicker } from "./AgentModelPicker";

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
  return {
    ...defaultAutomationSettings(catalog),
    job,
    title: job.title,
    prompt: job.prompt,
    trigger: job.trigger || "schedule",
    mode: job.mode || "build",
    frequency:
      fields[1] === "*" ? "hourly" : fields[4] === "*" ? "daily" : "weekly",
    time:
      fields[1] === "*"
        ? "09:00"
        : `${fields[1]?.padStart(2, "0")}:${fields[0]?.padStart(2, "0")}`,
    weekday: fields[4] === "*" ? "1" : fields[4],
    minute: fields[0],
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
  busy,
  idleUnsupported,
  error,
  onSave,
  onCancel,
}: {
  value: AutomationSettings;
  onChange: (patch: Partial<AutomationSettings>) => void;
  catalog: AgentCatalog;
  projectPath: string;
  busy: boolean;
  idleUnsupported?: string;
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
            {value.job ? "编辑自动化" : "新建自动化"}
          </h2>
          <p className="mt-1 text-caption text-fg-3">
            设置任务内容与运行计划，保存后自动执行。
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
          <label>
            触发方式
            <select
              aria-label="自动化触发方式"
              className={fieldClass}
              value={value.trigger}
              disabled={busy}
              onChange={(event) =>
                onChange({
                  trigger: event.target.value as AutomationSettings["trigger"],
                })
              }
            >
              <option value="schedule">定时运行</option>
              <option value="idle">电脑闲置时运行</option>
            </select>
          </label>
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
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                  <option value="hourly">每小时</option>
                </select>
              </label>
              {value.frequency === "hourly" ? (
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
        {idleUnsupported && (
          <p role="status" className="text-caption text-danger-text">
            {idleUnsupported}
          </p>
        )}
        <p className="text-caption text-fg-3">
          {value.trigger === "schedule"
            ? `按本地时区 ${timezone} 运行。`
            : "检测系统键鼠闲置，并等待 Agent 空闲。"}{" "}
          LoliCode 需要保持运行。
        </p>
      </section>
      <section className="wb-automation-settings-section" aria-label="执行设置">
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
              onChange={(event) => onChange({ reasoning: event.target.value })}
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
              !value.title.trim() ||
              !value.prompt.trim() ||
              !model ||
              !!idleUnsupported ||
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
