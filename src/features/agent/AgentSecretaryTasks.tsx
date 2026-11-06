import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CornerDownRight,
  Github,
  GitBranch,
  ListTodo,
  LoaderCircle,
  MessageCircle,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api/settings";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import type {
  AgentSecretaryExecutionMode,
  AgentSecretaryReportState,
  AgentSecretaryState,
  AgentSecretaryTask,
} from "@/types/agent";
import assistantPortrait from "@/assets/brand/lolicode-icon.png";
import { AgentSecretaryGithub } from "./AgentSecretaryGithub";
import { AgentSecretaryDraftPrCard } from "./AgentSecretaryDraftPr";
import {
  bounded,
  clearRequestIdentity,
  requestIdentity,
  safeGithubUrl,
} from "./secretaryRequests";
import "./agent-secretary.css";

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const emptyDelegation = {
  title: "",
  instructions: "",
  executionMode: "shared" as AgentSecretaryExecutionMode,
};
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
const reportLabels: Record<AgentSecretaryReportState, string> = {
  progress: "有新进展",
  waiting: "等待后续消息",
  ready: "交付就绪",
  blocked: "遇到阻碍",
  failed: "执行失败",
  dropped: "无需处理",
};

function needsUser(task: AgentSecretaryTask) {
  return (
    [
      "waiting_permission",
      "waiting_question",
      "failed",
      "interrupted",
    ].includes(task.status) ||
    (task.status === "completed" &&
      ["blocked", "failed"].includes(task.report?.state ?? ""))
  );
}

function visibleReport(task: AgentSecretaryTask) {
  if (task.status === "completed") return task.report?.state;
  if (task.status === "running" && task.report?.state === "progress")
    return "progress";
  return undefined;
}

function orderConversations(tasks: AgentSecretaryTask[]) {
  const sorted = [...tasks].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  const bySession = new Map(sorted.map((task) => [task.sessionId, task]));
  const children = new Map<string, AgentSecretaryTask[]>();
  const roots: AgentSecretaryTask[] = [];
  for (const task of sorted) {
    const parent = bySession.get(task.directParentSessionId ?? "");
    if (
      !parent ||
      parent.sessionId === task.sessionId ||
      parent.parentSessionId !== task.parentSessionId
    ) {
      roots.push(task);
      continue;
    }
    const siblings = children.get(parent.sessionId);
    if (siblings) siblings.push(task);
    else children.set(parent.sessionId, [task]);
  }
  const ordered = new Map<
    string,
    { task: AgentSecretaryTask; parent?: AgentSecretaryTask }
  >();
  const append = (task: AgentSecretaryTask, parent?: AgentSecretaryTask) => {
    if (ordered.has(task.id)) return;
    ordered.set(task.id, { task, parent });
    children.get(task.sessionId)?.forEach((child) => append(child, task));
  };
  roots.forEach((task) => append(task));
  // Cyclic relationships have no reachable root. Keep those sessions accessible.
  for (const task of sorted)
    if (!ordered.has(task.id)) ordered.set(task.id, { task });
  return Array.from(ordered.values());
}

export function AgentSecretaryTasks({
  sessionId,
  selectedSessionId,
  active = true,
  workerTaskId,
  canDelegate = true,
  onOpenSession,
  onFocusComposer,
}: {
  sessionId: string;
  selectedSessionId?: string;
  active?: boolean;
  workerTaskId?: string;
  canDelegate?: boolean;
  onOpenSession: (sessionId: string) => Promise<void> | void;
  onFocusComposer?: () => void;
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
  const [delegation, setDelegation] = useState(emptyDelegation);
  const [followups, setFollowups] = useState<Record<string, string>>({});
  const [openedTask, setOpenedTask] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const readSequence = useRef(0);
  const scope = useRef(sessionId);
  scope.current = sessionId;
  const lifetime = useRef(0);
  const pending = useRef(false);
  const navigation = useRef<{ id: string } | null>(null);
  const delegationTrigger = useRef<HTMLButtonElement>(null);
  const delegationTitle = useRef<HTMLInputElement>(null);
  const selectedChip = useRef<HTMLButtonElement>(null);
  const tasksId = useId();
  const githubId = useId();
  const delegationId = useId();
  const delegationAllowed = canDelegate && !workerTaskId;
  const delegationOpen = delegationAllowed && active && expanded && adding;
  const delegating = busy === "delegate";
  const stateHere = state?.sessionId === sessionId ? state : null;
  const loadedTasks = stateHere?.tasks;
  const tasks = loadedTasks || [];
  const conversations = useMemo(
    () => orderConversations(loadedTasks ?? []),
    [loadedTasks],
  );
  const currentConversationId =
    selectedSessionId ??
    (workerTaskId
      ? tasks.find((task) => task.id === workerTaskId)?.sessionId
      : sessionId);
  const chiefSelected = currentConversationId === sessionId;
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
  const needsAttention = tasks.filter(needsUser);

  useEffect(() => {
    lifetime.current += 1;
    setAdding(false);
    setDelegation(emptyDelegation);
    setFollowups({});
    setOpenedTask(null);
    setConfirmDelete(null);
    setBusy(null);
    setActionError(null);
    pending.current = false;
    navigation.current = null;
    return () => {
      lifetime.current += 1;
    };
  }, [sessionId]);

  useEffect(() => setOpenedTask(workerTaskId || null), [workerTaskId]);
  useEffect(() => {
    if (delegationOpen) delegationTitle.current?.focus();
  }, [delegationOpen]);
  useEffect(() => {
    if (active)
      selectedChip.current?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
  }, [active, currentConversationId, tasks.length]);

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

  const openConversation = async (id: string) => {
    if (
      !active ||
      navigation.current?.id === id ||
      (id === currentConversationId && !navigation.current)
    )
      return;
    const intent = { id };
    const epoch = lifetime.current;
    navigation.current = intent;
    setActionError(null);
    try {
      await onOpenSession(id);
    } catch (cause) {
      if (
        navigation.current === intent &&
        scope.current === sessionId &&
        lifetime.current === epoch
      )
        setActionError(agentErrorMessage(cause));
    } finally {
      if (navigation.current === intent) navigation.current = null;
    }
  };

  const delegate = () => {
    const title = delegation.title.trim();
    const instructions = delegation.instructions.trim();
    if (!delegationOpen || pending.current || !title || !instructions) return;
    const requestScope = `${sessionId}:delegate`;
    const requestId = requestIdentity(
      requestScope,
      JSON.stringify([title, instructions, delegation.executionMode]),
    );
    void act(
      "delegate",
      async () => {
        const task = await agentApi.delegateSecretaryTask(
          sessionId,
          title,
          instructions,
          requestId,
          delegation.executionMode,
        );
        if (task.parentSessionId !== sessionId || task.requestId !== requestId)
          throw new Error(
            label("wrongSession", "返回的任务与当前秘书不一致，请重新读取。"),
          );
        return task;
      },
      () => {
        clearRequestIdentity(requestScope);
        if (delegationTitle.current?.form?.contains(document.activeElement))
          delegationTrigger.current?.focus({ preventScroll: true });
        setDelegation(emptyDelegation);
        setAdding(false);
      },
    );
  };

  const deleteTask = (taskId: string) => {
    void act(
      `delete:${taskId}`,
      () => agentApi.deleteSecretaryTask(sessionId, taskId),
      () => {
        readSequence.current += 1;
        setState((old) =>
          old?.sessionId === sessionId
            ? { ...old, tasks: old.tasks.filter((task) => task.id !== taskId) }
            : old,
        );
        setOpenedTask((old) => (old === taskId ? null : old));
        setConfirmDelete(null);
        clearRequestIdentity(`${sessionId}:followup:${taskId}`);
      },
    );
  };

  return (
    <section className="wb-secretary" aria-label={label("tasks", "工作任务")}>
      <nav
        className="wb-secretary-sessions"
        aria-label={label("sessions", "秘书会话")}
      >
        <button
          ref={chiefSelected ? selectedChip : undefined}
          type="button"
          className="wb-secretary-session-chip"
          aria-current={chiefSelected ? "page" : undefined}
          disabled={!active}
          onClick={() => void openConversation(sessionId)}
        >
          <img src={assistantPortrait} alt="" className="wb-secretary-avatar" />
          <span>{label("chiefSession", "总秘书")}</span>
        </button>
        {conversations.map(({ task, parent }) => {
          const selected = task.sessionId === currentConversationId;
          const status = label(
            `status.${task.status}`,
            statusLabels[task.status],
          );
          const name = `${task.title} · ${status}`;
          return (
            <button
              key={task.id}
              ref={selected ? selectedChip : undefined}
              type="button"
              className="wb-secretary-session-chip"
              data-status={task.status}
              data-attention={needsUser(task) || undefined}
              aria-label={name}
              aria-description={
                parent
                  ? label("childOf", "上一级工作对话：{{title}}", {
                      title: parent.title,
                    })
                  : undefined
              }
              aria-current={selected ? "page" : undefined}
              disabled={!active}
              title={name}
              onClick={() => void openConversation(task.sessionId)}
            >
              {parent && (
                <CornerDownRight
                  className="wb-secretary-session-branch"
                  size={13}
                  aria-hidden="true"
                />
              )}
              <span className="wb-secretary-session-dot" aria-hidden="true" />
              <span className="wb-secretary-session-title">{task.title}</span>
              <span className="wb-secretary-session-status">{status}</span>
            </button>
          );
        })}
      </nav>
      <div className="wb-secretary-bar">
        {workerTaskId && (
          <button
            type="button"
            className="wb-secretary-back"
            disabled={Boolean(busy)}
            onClick={() => void openConversation(sessionId)}
          >
            <ArrowLeft aria-hidden="true" />
            {label("back", "返回秘书")}
          </button>
        )}
        <button
          type="button"
          className="wb-secretary-toggle"
          aria-expanded={expanded}
          aria-controls={tasksId}
          onClick={() => {
            setGithubOpen(false);
            setConfirmDelete(null);
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
              setConfirmDelete(null);
              setGithubOpen((value) => !value);
            }}
          >
            <Github aria-hidden="true" />
            <span>GitHub</span>
          </button>
        )}
        {!workerTaskId && onFocusComposer && (
          <button
            type="button"
            className="wb-secretary-add"
            disabled={!active}
            aria-label={label("tellGoal", "告诉秘书目标")}
            onClick={onFocusComposer}
          >
            <MessageCircle aria-hidden="true" />
            <span>{label("tellGoal", "告诉秘书目标")}</span>
          </button>
        )}
        {delegationAllowed && (
          <button
            ref={delegationTrigger}
            type="button"
            className="wb-secretary-add wb-secretary-delegate"
            disabled={!active}
            aria-expanded={delegationOpen}
            aria-controls={delegationOpen ? delegationId : undefined}
            onClick={() => {
              setGithubOpen(false);
              setConfirmDelete(null);
              setExpanded(true);
              setAdding(!delegationOpen);
            }}
          >
            <Plus aria-hidden="true" />
            <span>{label("delegate", "交办任务")}</span>
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
          {!workerTaskId && (
            <p className="wb-secretary-note">
              {label(
                "description",
                "直接在对话里告诉我目标，我来拆解、分派和跟进工作。",
              )}
            </p>
          )}
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
          {delegationOpen && (
            <form
              id={delegationId}
              className="wb-secretary-form"
              aria-label={label("delegateForm", "手动交办任务")}
              aria-busy={delegating}
              onSubmit={(event) => {
                event.preventDefault();
                delegate();
              }}
            >
              <label>
                {label("taskTitle", "任务名称")}
                <input
                  ref={delegationTitle}
                  value={delegation.title}
                  maxLength={100}
                  placeholder={label("titlePlaceholder", "例如：整理项目文档")}
                  readOnly={delegating}
                  required
                  onChange={(event) => {
                    const title = event.target.value;
                    setDelegation((old) => ({ ...old, title }));
                  }}
                />
              </label>
              <label>
                {label("instructions", "工作要求")}
                <textarea
                  value={delegation.instructions}
                  rows={3}
                  maxLength={20000}
                  placeholder={label(
                    "instructionsPlaceholder",
                    "描述目标、相关背景和你希望收到的结果",
                  )}
                  readOnly={delegating}
                  required
                  onChange={(event) => {
                    const instructions = event.target.value;
                    setDelegation((old) => ({ ...old, instructions }));
                  }}
                />
              </label>
              <label>
                {label("executionMode", "执行方式")}
                <select
                  value={delegation.executionMode}
                  disabled={delegating}
                  onChange={(event) => {
                    const executionMode =
                      event.target.value === "worktree" ? "worktree" : "shared";
                    setDelegation((old) => ({ ...old, executionMode }));
                  }}
                >
                  <option value="shared">
                    {label("sharedMode", "当前项目目录")}
                  </option>
                  <option value="worktree">
                    {label("worktreeMode", "独立 Git 工作树")}
                  </option>
                </select>
              </label>
              <div className="wb-secretary-form-actions">
                <span>
                  {delegation.executionMode === "worktree"
                    ? label(
                        "worktreeNote",
                        "从当前提交创建独立分支，使用已提交的项目文件。",
                      )
                    : label(
                        "sharedNote",
                        "在当前项目目录中执行，可以使用本地未提交的改动。",
                      )}
                </span>
                <button
                  type="submit"
                  disabled={
                    Boolean(busy) ||
                    !delegation.title.trim() ||
                    !delegation.instructions.trim()
                  }
                >
                  {delegating ? (
                    <LoaderCircle
                      className="motion-safe:animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Send aria-hidden="true" />
                  )}
                  {label("delegateSubmit", "开始执行")}
                </button>
              </div>
            </form>
          )}
          {!tasks.length && stateHere && (
            <p className="wb-secretary-empty">
              {label("empty", "还没有工作任务。")}
            </p>
          )}
          <div className="wb-secretary-task-list">
            {tasks.map((task) => {
              const opened = openedTask === task.id;
              const canDelete = !workerTaskId && terminal.has(task.status);
              const sourceHref =
                task.sourceUrl && safeGithubUrl(task.sourceUrl);
              const report = visibleReport(task);
              const attention =
                task.status === "waiting_permission" ||
                task.status === "waiting_question" ||
                report === "blocked" ||
                report === "failed";
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
                      {task.status === "completed" &&
                      !attention &&
                      (!report || report === "ready") ? (
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
                    {task.automatic && (
                      <small className="wb-secretary-task-origin">
                        {label("github.policy.badge", "自动分派")}
                      </small>
                    )}
                    <span className="wb-secretary-task-status">
                      {report
                        ? label(`report.${report}`, reportLabels[report])
                        : label(
                            `status.${task.status}`,
                            statusLabels[task.status],
                          )}
                    </span>
                    <button
                      type="button"
                      className="wb-secretary-task-open"
                      disabled={Boolean(busy)}
                      onClick={() => void openConversation(task.sessionId)}
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
                    {canDelete && (
                      <button
                        type="button"
                        className="wb-icon-button"
                        disabled={!active || Boolean(busy)}
                        aria-label={label(
                          "deleteNamed",
                          "删除任务：{{title}}",
                          {
                            title: task.title,
                          },
                        )}
                        aria-expanded={confirmDelete === task.id}
                        title={label("deleteTask", "删除任务")}
                        onClick={() =>
                          setConfirmDelete((old) =>
                            old === task.id ? null : task.id,
                          )
                        }
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {canDelete && confirmDelete === task.id && (
                    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-control bg-bg-subtle p-2">
                      <p className="mr-auto min-w-0 break-words text-caption">
                        {label(
                          "deletePrompt",
                          "从列表删除「{{title}}」？工作对话和文件会保留。",
                          { title: task.title },
                        )}
                      </p>
                      <Button
                        type="button"
                        variant="neutral"
                        disabled={Boolean(busy)}
                        onClick={() => setConfirmDelete(null)}
                      >
                        {label("dismissDelete", "返回")}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={!active || Boolean(busy)}
                        onClick={() => deleteTask(task.id)}
                      >
                        {busy === `delete:${task.id}` && (
                          <LoaderCircle
                            className="animate-spin"
                            aria-hidden="true"
                          />
                        )}
                        {label("confirmDelete", "确认删除")}
                      </Button>
                    </div>
                  )}
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
                      {(task.report?.summary || task.summary) && (
                        <p className="wb-secretary-task-summary">
                          {task.report?.summary || task.summary}
                        </p>
                      )}
                      {task.error && (
                        <p className="wb-secretary-task-error">{task.error}</p>
                      )}
                      {!workerTaskId &&
                        task.status === "completed" &&
                        task.worktree && (
                          <AgentSecretaryDraftPrCard
                            key={task.id}
                            sessionId={sessionId}
                            taskId={task.id}
                            disabled={!active || Boolean(busy)}
                          />
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
                                setFollowups((old) =>
                                  old[task.id] === followups[task.id]
                                    ? { ...old, [task.id]: "" }
                                    : old,
                                );
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
