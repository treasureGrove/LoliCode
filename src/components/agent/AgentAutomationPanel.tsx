import { useState } from "react";
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
};
type Run = {
  runId: string;
  outcome?: string;
  dispatchStatus: string;
  sessionId?: string;
  error?: string;
  createdAt: number;
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
};
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
export function AgentAutomationPanel({
  projectPath,
  catalog,
  onSession,
}: {
  projectPath: string;
  catalog: AgentCatalog;
  onSession: (session: AgentSession) => void;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [frequency, setFrequency] = useState("daily");
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
  const { busy, error, run } = useAgentOperation();
  const scope = { workspacePath: projectPath };
  const jobs = useAgentResource(`automation:${projectPath}`, () =>
    agentApi.automation<Job[]>("list", [scope]),
  );
  const runs = useAgentResource(
    selected ? `automation-runs:${projectPath}:${selected}` : "",
    () => agentApi.automation<Run[]>("listRuns", [selected, scope]),
    1000,
  );
  const create = () =>
    void run(async () => {
      const model = catalog.models.find((item) => item.id === modelId);
      if (!title.trim() || !prompt.trim() || !model)
        throw new Error("请填写名称、任务内容并选择模型");
      const job = await agentApi.automation<Job>("create", [
        {
          title: title.trim(),
          prompt: prompt.trim(),
          cronExpr: automationCron(frequency, time, weekday, minute),
          workspacePath: projectPath,
          recurring: true,
          mode,
          modelSelection: {
            providerId: model.providerId,
            modelId: model.modelId,
            options: {
              reasoningLevel: model.reasoningEfforts?.[0] || "default",
            },
          },
        },
      ]);
      setSelected(job.automationId);
      setTitle("");
      setPrompt("");
      setNotice("已保存自动化。应用运行时会按计划执行。");
      jobs.reload();
    });
  return (
    <div className="space-y-4">
      <p className="text-caption text-fg-3">
        自动任务在 LoliCode
        运行且渠道可用时执行。派发成功不代表任务完成，以下显示原生运行结果。
      </p>
      <OperationError>{error || jobs.error || runs.error}</OperationError>
      {notice && (
        <p role="status" className="text-caption">
          {notice}
        </p>
      )}
      <Button
        variant="neutral"
        disabled={busy}
        onClick={() => {
          jobs.reload();
          runs.reload();
        }}
      >
        刷新自动化
      </Button>
      {!jobs.data?.length && (
        <p className="text-caption text-fg-3">
          {jobs.loading ? "正在读取自动化…" : "当前项目还没有自动化任务。"}
        </p>
      )}
      {jobs.data?.map((job) => (
        <section
          key={job.automationId}
          className="space-y-2 rounded-control border border-border p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <strong className="mr-auto">{job.title}</strong>
            <span className="text-caption">
              {job.enabled ? "已启用" : "已暂停"}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-caption text-fg-3">
            {job.prompt}
          </p>
          <p className="text-caption">
            计划：{automationScheduleLabel(job.cronExpr)}
            {job.nextRunAt
              ? ` · 下次 ${new Date(job.nextRunAt).toLocaleString()}`
              : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await agentApi.automation<{ status: string }>(
                    "runNow",
                    [job.automationId, scope],
                  );
                  setSelected(job.automationId);
                  setNotice(
                    result.status === "duplicate"
                      ? "此任务已经在执行，请查看运行记录。"
                      : "已提交任务，等待原生执行结果。",
                  );
                  runs.reload();
                })
              }
            >
              立即运行
            </Button>
            <Button
              variant="neutral"
              disabled={busy}
              onClick={() => setSelected(job.automationId)}
            >
              查看运行记录
            </Button>
            <Button
              variant="neutral"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await agentApi.automation<Job | null>(
                    "setEnabled",
                    [job.automationId, !job.enabled, scope],
                  );
                  if (!result) throw new Error("任务已不存在，请刷新列表");
                  jobs.reload();
                })
              }
            >
              {job.enabled ? "暂停计划" : "启用计划"}
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => setConfirmDelete(job.automationId)}
            >
              删除任务
            </Button>
          </div>
          {confirmDelete === job.automationId && (
            <div className="flex gap-2">
              <Button variant="neutral" onClick={() => setConfirmDelete(null)}>
                取消删除
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const removed = await agentApi.automation<boolean>(
                      "delete",
                      [job.automationId, scope],
                    );
                    if (!removed) throw new Error("删除未完成，请刷新列表");
                    if (selected === job.automationId) setSelected(null);
                    setConfirmDelete(null);
                    jobs.reload();
                  })
                }
              >
                确认删除自动化
              </Button>
            </div>
          )}
        </section>
      ))}
      {selected && (
        <section
          className="space-y-2 rounded-control border border-border p-3"
          aria-label="自动化运行记录"
        >
          <h3 className="font-medium">运行记录</h3>
          {!runs.data?.length && (
            <p className="text-caption text-fg-3">尚无运行记录。</p>
          )}
          {runs.data?.map((item) => (
            <div
              key={item.runId}
              className="border-t border-border py-2 text-caption"
            >
              <p>
                {new Date(item.createdAt).toLocaleString()} ·{" "}
                {STATUS[item.outcome || item.dispatchStatus] ||
                  item.outcome ||
                  item.dispatchStatus}
              </p>
              {item.error && (
                <p className="whitespace-pre-wrap text-danger-text">
                  {item.error}
                </p>
              )}
              <p className="break-all text-fg-3">{item.runId}</p>
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
                        (session) =>
                          session.id === item.sessionId ||
                          session.id === `zc:${item.sessionId}`,
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
            </div>
          ))}
        </section>
      )}
      <form
        className="space-y-3 rounded-control border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <h3 className="font-medium">创建自动化</h3>
        <label className="block text-caption">
          名称
          <Input
            aria-label="自动化名称"
            value={title}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="block text-caption">
          任务内容
          <textarea
            aria-label="自动化任务内容"
            className={fieldClass}
            rows={3}
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
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
        {frequency === "hourly" ? (
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
        )}
        {frequency === "weekly" && (
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
        <p className="text-caption text-fg-3">
          按本地时区运行，应用保持开启时生效。
        </p>
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
        <Button
          type="submit"
          disabled={
            busy || !title.trim() || !prompt.trim() || !catalog.models.length
          }
        >
          保存自动化
        </Button>
      </form>
    </div>
  );
}
