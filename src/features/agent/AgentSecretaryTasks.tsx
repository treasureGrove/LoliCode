import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CornerDownRight,
  Github,
  GitBranch,
  ListTodo,
  LoaderCircle,
  Plus,
  RefreshCw,
  Send,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api/settings";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import type {
  AgentProject,
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
  projectPath: "",
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
  projectChoices,
}: {
  sessionId: string;
  selectedSessionId?: string;
  active?: boolean;
  workerTaskId?: string;
  canDelegate?: boolean;
  onOpenSession: (
    sessionId: string,
  ) => Promise<void | boolean> | void | boolean;
  projectChoices?: AgentProject[];
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
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
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
  const restoreCloseFocus = useRef(false);
  const closeTrigger = useRef<HTMLButtonElement | null>(null);
  const closeCancel = useRef<HTMLButtonElement>(null);
  const tasksId = useId();
  const githubId = useId();
  const delegationId = useId();
  const closeDescriptionId = useId();
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
  const closingTask = tasks.find(
    (task) => task.id === confirmClose && terminal.has(task.status),
  );
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
  const taskSummary = [
    label("tasks", "工作任务"),
    stateHere &&
      label("totalCount", "共 {{count}} 项", { count: tasks.length }),
    runningCount > 0 &&
      label("runningCount", "{{count}} 路运行", { count: runningCount }),
    queuedCount > 0 &&
      label("queuedCount", "{{count}} 项排队", { count: queuedCount }),
    needsAttention.length > 0 &&
      label("attentionCount", "{{count}} 项需要你", {
        count: needsAttention.length,
      }),
  ]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    lifetime.current += 1;
    setAdding(false);
    setDelegation(emptyDelegation);
    setFollowups({});
    setOpenedTask(null);
    setConfirmClose(null);
    setBusy(null);
    setActionError(null);
    pending.current = false;
    restoreCloseFocus.current = false;
    navigation.current = null;
    return () => {
      lifetime.current += 1;
    };
  }, [sessionId]);

  useEffect(() => setOpenedTask(workerTaskId || null), [workerTaskId]);
  useEffect(() => {
    if (closingTask) closeCancel.current?.focus({ preventScroll: true });
  }, [closingTask?.id]);
  useEffect(() => {
    if (active && !busy && restoreCloseFocus.current) {
      restoreCloseFocus.current = false;
      selectedChip.current?.focus({ preventScroll: true });
    }
  }, [active, busy, currentConversationId, tasks.length]);
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
      pending.current ||
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
      JSON.stringify([
        title,
        instructions,
        delegation.executionMode,
        ...(delegation.projectPath ? [delegation.projectPath] : []),
      ]),
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
          ...(delegation.projectPath ? [delegation.projectPath] : []),
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

  const requestClose = (
    task: AgentSecretaryTask,
    trigger: HTMLButtonElement,
  ) => {
    if (!active || pending.current || !terminal.has(task.status)) return;
    closeTrigger.current = trigger;
    setConfirmClose(task.id);
    setActionError(null);
  };

  const closeTask = (task: AgentSecretaryTask) => {
    if (!terminal.has(task.status)) return;
    const epoch = lifetime.current;
    void act(
      `close:${task.id}`,
      async () => {
        if (
          task.sessionId === currentConversationId ||
          navigation.current?.id === task.sessionId
        ) {
          const opened = await onOpenSession(sessionId);
          if (opened === false)
            throw new Error(
              label("returnBeforeClose", "请先返回总秘书，再关闭这项任务。"),
            );
        }
        if (
          scope.current !== sessionId ||
          lifetime.current !== epoch ||
          !pending.current
        )
          return;
        await agentApi.deleteSecretaryTask(sessionId, task.id);
      },
      () => {
        readSequence.current += 1;
        setState((old) =>
          old?.sessionId === sessionId
            ? { ...old, tasks: old.tasks.filter((item) => item.id !== task.id) }
            : old,
        );
        setOpenedTask((old) => (old === task.id ? null : old));
        setConfirmClose(null);
        clearRequestIdentity(`${sessionId}:followup:${task.id}`);
        restoreCloseFocus.current = true;
      },
    );
  };

  return (
    <section className="wb-secretary" aria-label={label("tasks", "工作任务")}>
      <div className="wb-secretary-bar">
        <nav
          className="wb-secretary-sessions"
          aria-label={label("sessions", "秘书会话")}
        >
          <button
            ref={chiefSelected ? selectedChip : undefined}
            type="button"
            className="wb-secretary-session-chip"
            aria-current={chiefSelected ? "page" : undefined}
            disabled={!active || Boolean(busy)}
            onClick={() => void openConversation(sessionId)}
          >
            <img
              src={assistantPortrait}
              alt=""
              className="wb-secretary-avatar"
            />
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
              <div
                key={task.id}
                className="wb-secretary-session"
                data-status={task.status}
                data-attention={needsUser(task) || undefined}
                data-selected={selected || undefined}
              >
                <button
                  ref={selected ? selectedChip : undefined}
                  type="button"
                  className="wb-secretary-session-chip"
                  aria-label={name}
                  aria-description={
                    parent
                      ? label("childOf", "上一级工作对话：{{title}}", {
                          title: parent.title,
                        })
                      : undefined
                  }
                  aria-current={selected ? "page" : undefined}
                  disabled={!active || Boolean(busy)}
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
                  <span
                    className="wb-secretary-session-dot"
                    aria-hidden="true"
                  />
                  <span className="wb-secretary-session-title">
                    {task.title}
                  </span>
                </button>
                {terminal.has(task.status) && (
                  <button
                    type="button"
                    className="wb-secretary-session-close"
                    disabled={!active || Boolean(busy)}
                    aria-label={label("closeNamed", "关闭任务：{{title}}", {
                      title: task.title,
                    })}
                    aria-expanded={confirmClose === task.id}
                    title={label("closeTask", "关闭任务")}
                    onClick={(event) => requestClose(task, event.currentTarget)}
                  >
                    {busy === `close:${task.id}` ? (
                      <LoaderCircle
                        className="animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <X aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </nav>
        <div className="wb-secretary-actions">
          <button
            type="button"
            className="wb-secretary-toggle"
            aria-label={taskSummary}
            title={taskSummary}
            aria-expanded={expanded}
            aria-controls={tasksId}
            onClick={() => {
              setGithubOpen(false);
              setConfirmClose(null);
              setExpanded((value) => !value);
            }}
          >
            <ListTodo aria-hidden="true" />
            <strong>{label("tasks", "工作任务")}</strong>
            {stateHere && (
              <span className="wb-secretary-count" aria-hidden="true">
                {tasks.length}
              </span>
            )}
            {needsAttention.length > 0 && (
              <span className="wb-secretary-attention-dot" aria-hidden="true" />
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
          {!workerTaskId && !projectChoices && (
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
                setConfirmClose(null);
                setGithubOpen((value) => !value);
              }}
            >
              <Github aria-hidden="true" />
            </button>
          )}
          {delegationAllowed && (
            <button
              ref={delegationTrigger}
              type="button"
              className="wb-secretary-add wb-secretary-delegate"
              disabled={!active}
              aria-label={label("delegate", "交办任务")}
              aria-expanded={delegationOpen}
              aria-controls={delegationOpen ? delegationId : undefined}
              onClick={() => {
                setGithubOpen(false);
                setConfirmClose(null);
                setExpanded(true);
                setAdding(!delegationOpen);
              }}
            >
              <Plus aria-hidden="true" />
              <span>{label("delegate", "交办任务")}</span>
            </button>
          )}
        </div>
      </div>
      {closingTask && (
        <div
          className="wb-secretary-close-confirm"
          role="alertdialog"
          aria-label={label("closeTask", "关闭任务")}
          aria-describedby={closeDescriptionId}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.stopPropagation();
              setConfirmClose(null);
              closeTrigger.current?.focus({ preventScroll: true });
            }
          }}
        >
          <p id={closeDescriptionId}>
            {label(
              "closePrompt",
              "关闭「{{title}}」并从任务栏移除？工作对话和文件会保留。",
              { title: closingTask.title },
            )}
          </p>
          <Button
            ref={closeCancel}
            type="button"
            variant="neutral"
            disabled={Boolean(busy)}
            onClick={() => {
              setConfirmClose(null);
              closeTrigger.current?.focus({ preventScroll: true });
            }}
          >
            {label("dismissDelete", "返回")}
          </Button>
          <Button
            type="button"
            variant="neutral"
            disabled={!active || Boolean(busy)}
            onClick={() => closeTask(closingTask)}
          >
            {busy === `close:${closingTask.id}` && (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            )}
            {label("confirmClose", "确认关闭")}
          </Button>
        </div>
      )}
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
            onOpenSession={openConversation}
          />
        </div>
      )}
      {expanded && (
        <div id={tasksId} className="wb-secretary-content">
          {(runningCount > 0 ||
            queuedCount > 0 ||
            needsAttention.length > 0) && (
            <div className="wb-secretary-task-summary">
              {runningCount > 0 && (
                <span className="wb-secretary-running">
                  {label("runningCount", "{{count}} 路运行", {
                    count: runningCount,
                  })}
                </span>
              )}
              {queuedCount > 0 && (
                <span className="wb-secretary-count">
                  {label("queuedCount", "{{count}} 项排队", {
                    count: queuedCount,
                  })}
                </span>
              )}
              {needsAttention.length > 0 && (
                <span className="wb-secretary-attention">
                  {label("attentionCount", "{{count}} 项需要你", {
                    count: needsAttention.length,
                  })}
                </span>
              )}
            </div>
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
              {projectChoices && (
                <label>
                  {label("targetProject", "执行项目")}
                  <select
                    value={delegation.projectPath}
                    disabled={delegating}
                    onChange={(event) => {
                      const projectPath = event.target.value;
                      setDelegation((old) => ({
                        ...old,
                        projectPath,
                        executionMode: projectPath
                          ? old.executionMode
                          : "shared",
                      }));
                    }}
                  >
                    <option value="">
                      {label("standaloneProject", "独立任务目录")}
                    </option>
                    {projectChoices
                      .filter(
                        (project) => !project.standalone && !project.remote,
                      )
                      .map((project) => (
                        <option key={project.path} value={project.path}>
                          {project.name} · {project.path}
                        </option>
                      ))}
                  </select>
                </label>
              )}
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
                  <option
                    value="worktree"
                    disabled={Boolean(
                      projectChoices && !delegation.projectPath,
                    )}
                  >
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
              const canClose = terminal.has(task.status);
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
                    {canClose && (
                      <button
                        type="button"
                        className="wb-icon-button"
                        disabled={!active || Boolean(busy)}
                        aria-label={label("closeNamed", "关闭任务：{{title}}", {
                          title: task.title,
                        })}
                        aria-expanded={confirmClose === task.id}
                        title={label("closeTask", "关闭任务")}
                        onClick={(event) =>
                          requestClose(task, event.currentTarget)
                        }
                      >
                        <X aria-hidden="true" />
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
