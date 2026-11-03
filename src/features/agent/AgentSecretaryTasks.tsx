import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Github,
  GitBranch,
  ListTodo,
  LoaderCircle,
  Plus,
  RefreshCw,
  Send,
  Square,
} from "lucide-react";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api/settings";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import type {
  AgentSecretaryExecutionMode,
  AgentSecretaryState,
  AgentSecretaryTask,
} from "@/types/agent";
import assistantPortrait from "@/assets/brand/lolicode-icon.png";
import { AgentSecretaryGithub } from "./AgentSecretaryGithub";
import {
  bounded,
  clearRequestIdentity,
  requestIdentity,
  safeGithubUrl,
} from "./secretaryRequests";
import "./agent-secretary.css";

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const statusLabels: Record<AgentSecretaryTask["status"], string> = {
  queued: "等待执行",
  running: "正在工作",
  waiting_permission: "需要授权",
  waiting_question: "等你回答",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export function AgentSecretaryTasks({
  sessionId,
  active = true,
  workerTaskId,
  onOpenSession,
}: {
  sessionId: string;
  active?: boolean;
  workerTaskId?: string;
  onOpenSession: (sessionId: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const label = (
    key: string,
    fallback: string,
    values?: Record<string, unknown>,
  ) => t(`agentSecretary.${key}`, { defaultValue: fallback, ...values });
  const [state, setState] = useState<AgentSecretaryState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [githubVisited, setGithubVisited] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [executionMode, setExecutionMode] =
    useState<AgentSecretaryExecutionMode>("shared");
  const [followups, setFollowups] = useState<Record<string, string>>({});
  const [openedTask, setOpenedTask] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const readSequence = useRef(0);
  const scope = useRef(sessionId);
  scope.current = sessionId;
  const lifetime = useRef(0);
  const pending = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const tasksId = useId();
  const githubId = useId();
  const drafts = useRef({ title, instructions, executionMode, followups });
  drafts.current = { title, instructions, executionMode, followups };
  const stateHere = state?.sessionId === sessionId ? state : null;
  const tasks = stateHere?.tasks || [];
  const runningCount = tasks.filter((task) => task.status === "running").length;
  const queuedCount = tasks.filter((task) => task.status === "queued").length;
  const occupied = tasks.filter(
    ({ status }) =>
      status === "running" ||
      status === "waiting_permission" ||
      status === "waiting_question",
  );
  const worktreeCount = occupied.filter(
    (task) => task.executionMode === "worktree",
  ).length;
  const needsAttention = tasks.filter((task) =>
    [
      "waiting_permission",
      "waiting_question",
      "failed",
      "interrupted",
    ].includes(task.status),
  );

  useEffect(() => {
    lifetime.current += 1;
    setTitle("");
    setInstructions("");
    setExecutionMode("shared");
    setFollowups({});
    setOpenedTask(null);
    setAdding(false);
    setBusy(null);
    setActionError(null);
    pending.current = false;
    return () => {
      lifetime.current += 1;
    };
  }, [sessionId]);

  useEffect(() => setOpenedTask(workerTaskId || null), [workerTaskId]);
  useEffect(() => {
    if (expanded && adding) titleInput.current?.focus();
  }, [expanded, adding]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    const read = async () => {
      if (disposed || reading || document.visibilityState === "hidden") return;
      reading = true;
      const sequence = ++readSequence.current;
      try {
        const next = await bounded(
          agentApi.getSecretary(sessionId),
          label("readTimeout", "读取工作任务超时，请重新读取。"),
        );
        if (next.sessionId !== sessionId)
          throw new Error(
            label("wrongSession", "返回的任务与当前秘书不一致，请重新读取。"),
          );
        if (!disposed && sequence === readSequence.current) {
          setState(next);
          setReadError(null);
        }
      } catch (cause) {
        if (!disposed && sequence === readSequence.current)
          setReadError(agentErrorMessage(cause));
      } finally {
        reading = false;
        if (!disposed) timer = setTimeout(() => void read(), 2_500);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "hidden") void read();
    };
    setReadError(null);
    void read();
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      readSequence.current += 1;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [sessionId, active, revision]);

  const acceptTask = (task: AgentSecretaryTask) => {
    readSequence.current += 1;
    setState((old) => ({
      sessionId,
      tasks: [
        task,
        ...(old?.sessionId === sessionId ? old.tasks : []).filter(
          (item) => item.id !== task.id,
        ),
      ],
    }));
    setRevision((value) => value + 1);
  };

  const act = async (
    action: string,
    request: () => Promise<AgentSecretaryTask | void>,
    done?: () => void,
  ) => {
    if (pending.current || !active) return;
    pending.current = true;
    const id = sessionId;
    const epoch = lifetime.current;
    readSequence.current += 1;
    setBusy(action);
    setActionError(null);
    try {
      const task = await bounded(
        request(),
        label("actionTimeout", "操作结果尚未确认，输入已保留；请重试核对。"),
      );
      if (scope.current !== id || lifetime.current !== epoch) return;
      if (task) acceptTask(task);
      done?.();
      if (!task) setRevision((value) => value + 1);
    } catch (cause) {
      if (scope.current === id && lifetime.current === epoch)
        setActionError(agentErrorMessage(cause));
    } finally {
      if (scope.current === id && lifetime.current === epoch) {
        pending.current = false;
        setBusy(null);
      }
    }
  };

  const delegate = () => {
    const name = title.trim();
    const text = instructions.trim();
    if (!name || !text) return;
    const requestId = requestIdentity(
      `${sessionId}:delegate`,
      JSON.stringify([name, text, executionMode]),
    );
    void act(
      "delegate",
      () =>
        executionMode === "worktree"
          ? agentApi.delegateSecretaryTask(
              sessionId,
              name,
              text,
              requestId,
              executionMode,
            )
          : agentApi.delegateSecretaryTask(sessionId, name, text, requestId),
      () => {
        clearRequestIdentity(`${sessionId}:delegate`);
        if (
          drafts.current.title === title &&
          drafts.current.instructions === instructions &&
          drafts.current.executionMode === executionMode
        ) {
          setTitle("");
          setInstructions("");
          setExecutionMode("shared");
          setAdding(false);
        }
        setExpanded(true);
      },
    );
  };

  return (
    <section className="wb-secretary" aria-label={label("tasks", "工作任务")}>
      <div className="wb-secretary-bar">
        {workerTaskId ? (
          <button
            type="button"
            className="wb-secretary-back"
            disabled={Boolean(busy)}
            onClick={() =>
              void act("open-parent", async () => {
                await onOpenSession(sessionId);
              })
            }
          >
            <ArrowLeft aria-hidden="true" />
            {label("back", "返回秘书")}
          </button>
        ) : (
          <img src={assistantPortrait} alt="" className="wb-secretary-avatar" />
        )}
        <button
          type="button"
          className="wb-secretary-toggle"
          aria-expanded={expanded}
          aria-controls={tasksId}
          onClick={() => {
            setGithubOpen(false);
            setExpanded((value) => !value);
          }}
        >
          <ListTodo aria-hidden="true" />
          <strong>{label("tasks", "工作任务")}</strong>
          {stateHere && runningCount === 0 && queuedCount === 0 && (
            <span className="wb-secretary-count">
              {label("totalCount", "共 {{count}} 项", { count: tasks.length })}
            </span>
          )}
          {runningCount > 0 && (
            <span className="wb-secretary-running">
              {label("runningCount", "{{count}} 路运行", {
                count: runningCount,
              })}
            </span>
          )}
          {queuedCount > 0 && (
            <span className="wb-secretary-count">
              {label("queuedCount", "{{count}} 项排队", { count: queuedCount })}
            </span>
          )}
          {needsAttention.length > 0 && (
            <span className="wb-secretary-attention">
              {label("attentionCount", "{{count}} 项需要你", {
                count: needsAttention.length,
              })}
            </span>
          )}
          {!stateHere && !readError && (
            <LoaderCircle
              className="animate-spin"
              aria-label={label("loading", "正在读取任务")}
            />
          )}
          {expanded ? (
            <ChevronDown aria-hidden="true" />
          ) : (
            <ChevronRight aria-hidden="true" />
          )}
        </button>
        {!workerTaskId && (
          <button
            type="button"
            className="wb-secretary-source"
            aria-label={label("github.title", "GitHub 收件箱")}
            aria-expanded={githubOpen}
            aria-controls={githubId}
            title={label("github.title", "GitHub 收件箱")}
            onClick={() => {
              setGithubVisited(true);
              setExpanded(false);
              setGithubOpen((value) => !value);
            }}
          >
            <Github aria-hidden="true" />
            <span>GitHub</span>
          </button>
        )}
        {!workerTaskId && (
          <button
            type="button"
            className="wb-secretary-add"
            aria-label={label("delegate", "分派任务")}
            aria-expanded={expanded && adding}
            onClick={() => {
              setGithubOpen(false);
              setExpanded(true);
              setAdding((value) => !expanded || !value);
            }}
          >
            <Plus aria-hidden="true" />
            <span>{label("delegate", "分派任务")}</span>
          </button>
        )}
      </div>
      {readError && (
        <div className="wb-secretary-error" role="alert">
          <span>{readError}</span>
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw aria-hidden="true" />
            {label("refresh", "重新读取")}
          </button>
        </div>
      )}
      {actionError && (
        <p className="wb-secretary-error" role="alert">
          {actionError}
        </p>
      )}
      {!workerTaskId && githubVisited && (
        <div
          id={githubId}
          hidden={!githubOpen}
          className="wb-secretary-content"
        >
          <AgentSecretaryGithub
            key={sessionId}
            sessionId={sessionId}
            active={active && githubOpen}
            tasks={tasks}
            onTaskCreated={acceptTask}
            onOpenSession={onOpenSession}
          />
        </div>
      )}
      {expanded && (
        <div id={tasksId} className="wb-secretary-content">
          <p className="wb-secretary-note">
            {label(
              "description",
              "把目标交给我，我来安排工作、跟进结果。你可以继续和我聊。",
            )}
          </p>
          {worktreeCount > 0 && (
            <p className="wb-secretary-lanes">
              <GitBranch aria-hidden="true" />
              {label(
                "worktreeCount",
                "{{count}} / {{limit}} 个隔离执行位已占用",
                {
                  count: worktreeCount,
                  limit: 3,
                },
              )}
            </p>
          )}
          {adding && !workerTaskId && (
            <form
              className="wb-secretary-form"
              onSubmit={(event) => {
                event.preventDefault();
                delegate();
              }}
            >
              <label>
                {label("taskTitle", "任务名称")}
                <input
                  ref={titleInput}
                  value={title}
                  maxLength={100}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={label("titlePlaceholder", "例如：整理项目文档")}
                  required
                />
              </label>
              <label>
                {label("instructions", "工作要求")}
                <textarea
                  value={instructions}
                  maxLength={20000}
                  rows={3}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder={label(
                    "instructionsPlaceholder",
                    "描述目标、相关背景和你希望收到的结果",
                  )}
                  required
                />
              </label>
              <label>
                {label("executionMode", "执行方式")}
                <select
                  value={executionMode}
                  onChange={(event) =>
                    setExecutionMode(
                      event.target.value === "worktree" ? "worktree" : "shared",
                    )
                  }
                >
                  <option value="shared">
                    {label("sharedMode", "当前项目 · 串行")}
                  </option>
                  <option value="worktree">
                    {label("worktreeMode", "独立工作树 · 并行")}
                  </option>
                </select>
              </label>
              <div className="wb-secretary-form-actions">
                <span>
                  {executionMode === "worktree"
                    ? label(
                        "worktreeNote",
                        "从当前提交创建独立分支，可与其他任务同时运行。工作树不包含本地未提交改动。",
                      )
                    : label(
                        "serialNote",
                        "使用当前目录和本地改动。共享目录中的任务依次执行。",
                      )}
                </span>
                <button
                  type="submit"
                  disabled={
                    Boolean(busy) || !title.trim() || !instructions.trim()
                  }
                >
                  {busy === "delegate" ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Send aria-hidden="true" />
                  )}
                  {label("delegate", "分派任务")}
                </button>
              </div>
            </form>
          )}
          {!tasks.length && stateHere && (
            <p className="wb-secretary-empty">
              {label(
                "empty",
                "还没有工作任务。直接在下方告诉我目标，或分派一个明确的任务。",
              )}
            </p>
          )}
          <div className="wb-secretary-task-list">
            {tasks.map((task) => {
              const opened = openedTask === task.id;
              const sourceHref =
                task.sourceUrl && safeGithubUrl(task.sourceUrl);
              const attention = [
                "waiting_permission",
                "waiting_question",
              ].includes(task.status);
              return (
                <article
                  className="wb-secretary-task"
                  key={task.id}
                  data-status={task.status}
                >
                  <div className="wb-secretary-task-heading">
                    <button
                      type="button"
                      className="wb-secretary-task-toggle"
                      aria-expanded={opened}
                      onClick={() => setOpenedTask(opened ? null : task.id)}
                    >
                      {task.status === "completed" ? (
                        <CircleCheck aria-hidden="true" />
                      ) : task.status === "running" ? (
                        <LoaderCircle
                          className="animate-spin"
                          aria-hidden="true"
                        />
                      ) : opened ? (
                        <ChevronDown aria-hidden="true" />
                      ) : (
                        <ChevronRight aria-hidden="true" />
                      )}
                      <strong>{task.title}</strong>
                    </button>
                    <span className="wb-secretary-task-status">
                      {label(
                        `status.${task.status}`,
                        statusLabels[task.status],
                      )}
                    </span>
                    <button
                      type="button"
                      className="wb-secretary-task-open"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void act(`open:${task.id}`, async () => {
                          await onOpenSession(task.sessionId);
                        })
                      }
                      title={label("openTask", "打开工作对话")}
                    >
                      <span>
                        {attention
                          ? label("resolve", "查看并处理")
                          : label("openTask", "打开工作对话")}
                      </span>
                      <ArrowUpRight aria-hidden="true" />
                    </button>
                    {!terminal.has(task.status) && (
                      <button
                        type="button"
                        className="wb-icon-button"
                        disabled={Boolean(busy)}
                        aria-label={label(
                          "cancelNamed",
                          "取消任务：{{title}}",
                          { title: task.title },
                        )}
                        onClick={() =>
                          void act(`cancel:${task.id}`, () =>
                            agentApi.cancelSecretaryTask(sessionId, task.id),
                          )
                        }
                      >
                        {busy === `cancel:${task.id}` ? (
                          <LoaderCircle
                            className="animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Square aria-hidden="true" />
                        )}
                      </button>
                    )}
                  </div>
                  {opened && (
                    <div className="wb-secretary-task-detail">
                      <p>{task.instructions}</p>
                      {sourceHref && (
                        <button
                          type="button"
                          className="wb-secretary-task-open"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void act(`source:${task.id}`, () =>
                              settingsApi.openExternal(sourceHref),
                            )
                          }
                        >
                          <Github aria-hidden="true" />
                          {label("github.openSource", "在 GitHub 打开")}
                        </button>
                      )}
                      {task.worktree && (
                        <dl className="wb-secretary-worktree">
                          <dt>{label("branch", "工作分支")}</dt>
                          <dd>
                            <code>{task.worktree.branch}</code>
                          </dd>
                          <dt>{label("baseRevision", "基线提交")}</dt>
                          <dd>
                            <code title={task.worktree.baseRevision}>
                              {task.worktree.baseRevision.slice(0, 12)}
                            </code>
                          </dd>
                          <dt>{label("worktreePath", "工作目录")}</dt>
                          <dd>
                            <code>{task.worktree.path}</code>
                          </dd>
                        </dl>
                      )}
                      {task.summary && (
                        <p className="wb-secretary-task-summary">
                          {task.summary}
                        </p>
                      )}
                      {task.error && (
                        <p className="wb-secretary-task-error">{task.error}</p>
                      )}
                      {!workerTaskId && (
                        <form
                          className="wb-secretary-followup"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const text = followups[task.id]?.trim();
                            if (!text) return;
                            const requestId = requestIdentity(
                              `${sessionId}:followup:${task.id}`,
                              text,
                            );
                            void act(
                              `followup:${task.id}`,
                              () =>
                                agentApi.sendSecretaryTaskMessage(
                                  sessionId,
                                  task.id,
                                  text,
                                  requestId,
                                ),
                              () => {
                                clearRequestIdentity(
                                  `${sessionId}:followup:${task.id}`,
                                );
                                if (
                                  drafts.current.followups[task.id] ===
                                  followups[task.id]
                                )
                                  setFollowups((old) => ({
                                    ...old,
                                    [task.id]: "",
                                  }));
                              },
                            );
                          }}
                        >
                          <label
                            className="sr-only"
                            htmlFor={`secretary-followup-${task.id}`}
                          >
                            {label("followupNamed", "补充要求：{{title}}", {
                              title: task.title,
                            })}
                          </label>
                          <textarea
                            id={`secretary-followup-${task.id}`}
                            value={followups[task.id] || ""}
                            maxLength={20000}
                            rows={2}
                            onChange={(event) =>
                              setFollowups((old) => ({
                                ...old,
                                [task.id]: event.target.value,
                              }))
                            }
                            placeholder={label(
                              "followupPlaceholder",
                              "补充要求，或让她继续跟进这项工作",
                            )}
                          />
                          <button
                            type="submit"
                            disabled={
                              Boolean(busy) || !followups[task.id]?.trim()
                            }
                          >
                            {busy === `followup:${task.id}` ? (
                              <LoaderCircle
                                className="animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <Send aria-hidden="true" />
                            )}
                            {label("followup", "发送补充")}
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
