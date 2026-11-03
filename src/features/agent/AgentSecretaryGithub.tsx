import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  CircleDot,
  GitPullRequest,
  Github,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Send,
  Unplug,
  Workflow,
} from "lucide-react";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api/settings";
import type {
  AgentSecretaryGithubItem,
  AgentSecretaryGithubState,
  AgentSecretaryTask,
} from "@/types/agent";
import { AgentSecretaryGithubReply } from "./AgentSecretaryGithubReply";
import { AgentSecretaryGithubPolicy } from "./AgentSecretaryGithubPolicy";
import { AgentSecretaryDraftPrCard } from "./AgentSecretaryDraftPr";
import {
  bounded,
  clearRequestIdentity,
  requestIdentity,
  safeGithubUrl,
} from "./secretaryRequests";

const kinds = {
  issue: { icon: CircleDot, fallback: "Issue" },
  pull_request: { icon: GitPullRequest, fallback: "PR" },
  comment: { icon: MessageSquare, fallback: "评论" },
  ci: { icon: Workflow, fallback: "CI" },
};

export function AgentSecretaryGithub({
  sessionId,
  active,
  tasks,
  onTaskCreated,
  onOpenSession,
}: {
  sessionId: string;
  active: boolean;
  tasks: AgentSecretaryTask[];
  onTaskCreated: (task: AgentSecretaryTask) => void;
  onOpenSession: (sessionId: string) => Promise<void> | void;
}) {
  const { t, i18n } = useTranslation();
  const label = (
    key: string,
    defaultValue: string,
    values?: Record<string, unknown>,
  ) => t(`agentSecretary.github.${key}`, { defaultValue, ...values });
  const [source, setSource] = useState<AgentSecretaryGithubState>();
  const [repository, setRepository] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const readVersion = useRef(0);
  const instructionsInput = useRef<HTMLTextAreaElement>(null);
  const selectedId = useId();
  const monitoringDescriptionId = useId();
  const monitoringDescription = label(
    "monitoringHint",
    "桌面应用运行时自动收件。可在下方设置自动分派规则。",
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (disposed || reading || document.visibilityState === "hidden") return;
      if (!pending.current) {
        reading = true;
        const version = readVersion.current;
        try {
          const next = await bounded(
            agentApi.getSecretaryGithub(sessionId),
            label("readTimeout", "读取 GitHub 收件箱超时。"),
          );
          if (!disposed && version === readVersion.current) {
            setSource(next);
            setReadError("");
          }
        } catch (error) {
          if (!disposed && version === readVersion.current)
            setReadError(agentErrorMessage(error));
        } finally {
          reading = false;
        }
      }
      if (!disposed) timer = setTimeout(() => void read(), 5_000);
    };
    const onVisibility = () => {
      clearTimeout(timer);
      void read();
    };
    void read();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, sessionId, refresh]);

  useEffect(() => {
    if (active && selected) instructionsInput.current?.focus();
  }, [active, selected]);

  const run = async <T,>(
    action: string,
    request: () => Promise<T>,
    receive: (result: T) => void,
  ) => {
    if (pending.current || !active) return;
    pending.current = true;
    readVersion.current += 1;
    setBusy(action);
    setActionError("");
    try {
      const result = await bounded(
        request(),
        label("actionTimeout", "操作结果尚未确认，输入已保留。请刷新或重试。"),
      );
      if (mounted.current) {
        receive(result);
        return result;
      }
    } catch (error) {
      if (mounted.current) setActionError(agentErrorMessage(error));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy("");
    }
  };

  const applySource = (next: AgentSecretaryGithubState) => {
    setSource(next);
    setReadError("");
  };

  const delegate = (item: AgentSecretaryGithubItem) => {
    const input = drafts[item.id];
    if (!input?.trim() || item.taskId) return;
    const scope = `${sessionId}:github:${source?.repository}:${item.id}`;
    const requestId = requestIdentity(scope, input.trim());
    void run(
      "delegate",
      () =>
        agentApi.delegateSecretaryGithubItem(
          sessionId,
          item.id,
          input.trim(),
          requestId,
        ),
      (task) => {
        clearRequestIdentity(scope);
        setSource(
          (old) =>
            old && {
              ...old,
              items: old.items.map((entry) =>
                entry.id === item.id ? { ...entry, taskId: task.id } : entry,
              ),
            },
        );
        setDrafts((old) =>
          old[item.id] === input ? { ...old, [item.id]: "" } : old,
        );
        onTaskCreated(task);
        setRefresh((value) => value + 1);
      },
    );
  };

  const unassigned = source?.items.filter((item) => !item.taskId).length ?? 0;
  const timestamp = source?.lastSyncedAt;
  const syncedAt = timestamp
    ? new Date(timestamp).toLocaleString(i18n.resolvedLanguage || undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : undefined;
  const error = actionError || readError || source?.error;

  return (
    <section
      className="wb-secretary-github"
      aria-label={label("title", "GitHub 收件箱")}
    >
      <header className="wb-secretary-github-header">
        <div className="wb-secretary-github-identity">
          <Github aria-hidden="true" />
          <div>
            <strong>
              {source?.repository ?? label("title", "GitHub 收件箱")}
            </strong>
            {source?.repository && (
              <small>
                {source.login ? `@${source.login} · ` : ""}
                {label("pendingCount", "{{count}} 项待交办", {
                  count: unassigned,
                })}
                {syncedAt &&
                  ` · ${label("lastSynced", "同步于 {{time}}", { time: syncedAt })}`}
              </small>
            )}
          </div>
        </div>
        {source?.repository && (
          <div className="wb-secretary-github-controls">
            <label
              className="wb-secretary-github-monitor"
              title={monitoringDescription}
            >
              <input
                type="checkbox"
                checked={source.monitoring}
                aria-describedby={monitoringDescriptionId}
                disabled={Boolean(busy)}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void run(
                    "monitoring",
                    () =>
                      agentApi.setSecretaryGithubMonitoring(sessionId, enabled),
                    applySource,
                  );
                }}
              />
              {label("monitoring", "自动收件")}
            </label>
            <span id={monitoringDescriptionId} className="sr-only">
              {monitoringDescription}
            </span>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run(
                  "refresh",
                  () => agentApi.refreshSecretaryGithub(sessionId),
                  applySource,
                )
              }
            >
              {busy === "refresh" ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              {label("refresh", "同步")}
            </button>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run(
                  "disconnect",
                  () => agentApi.disconnectSecretaryGithub(sessionId),
                  (next) => {
                    applySource(next);
                    setSelected(null);
                    setDrafts({});
                  },
                )
              }
            >
              <Unplug aria-hidden="true" />
              {label("disconnect", "断开")}
            </button>
          </div>
        )}
      </header>
      {error && (
        <div className="wb-secretary-error" role="alert">
          <span>{error}</span>
          {!source && !busy && (
            <button
              type="button"
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw aria-hidden="true" />
              {label("retry", "重试")}
            </button>
          )}
        </div>
      )}
      {!source && !readError && (
        <p className="wb-secretary-github-loading" role="status">
          <LoaderCircle className="animate-spin" aria-hidden="true" />
          {label("loading", "正在读取收件箱…")}
        </p>
      )}
      {source && !source.repository && (
        <form
          className="wb-secretary-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!repository.trim()) return;
            void run(
              "connect",
              () => agentApi.bindSecretaryGithub(sessionId, repository.trim()),
              applySource,
            );
          }}
        >
          <p className="wb-secretary-note">
            {label(
              "connectionHint",
              "使用本机已登录的 GitHub CLI 接收仓库动态。默认由你选定条目并交办，也可以按规则开启自动分派。",
            )}
          </p>
          <label>
            {label("repository", "GitHub 仓库")}
            <input
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              placeholder="owner/repo"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={256}
              required
            />
          </label>
          <div className="wb-secretary-form-actions">
            <button
              type="submit"
              disabled={Boolean(busy) || !repository.trim()}
            >
              {busy === "connect" ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Github aria-hidden="true" />
              )}
              {label("connect", "连接仓库")}
            </button>
          </div>
        </form>
      )}
      {source?.repository && (
        <>
          {source.policy && (
            <AgentSecretaryGithubPolicy
              key={source.repository}
              policy={source.policy}
              monitoring={source.monitoring}
              disabled={Boolean(busy) || !active}
              tasks={tasks}
              onSave={async (enabled, rules, expectedRevision) =>
                (
                  await run(
                    "policy",
                    () =>
                      agentApi.setSecretaryGithubPolicy(
                        sessionId,
                        enabled,
                        rules,
                        expectedRevision,
                      ),
                    applySource,
                  )
                )?.policy
              }
              onOpenTask={(id) =>
                void run(
                  "open",
                  async () => onOpenSession(id),
                  () => {},
                )
              }
              onOpenSource={(url) =>
                void run(
                  "source",
                  () => settingsApi.openExternal(url),
                  () => {},
                )
              }
            />
          )}
          {!source.items.length && (
            <p className="wb-secretary-empty">
              {label("empty", "暂时没有收件。同步后会在这里显示仓库动态。")}
            </p>
          )}
          <div className="wb-secretary-task-list">
            {source.items.map((item) => {
              const opened = selected === item.id;
              const linked = tasks.find((task) => task.id === item.taskId);
              const kind = kinds[item.kind];
              const Icon = kind.icon;
              const href = safeGithubUrl(item.url);
              return (
                <article key={item.id} className="wb-secretary-task">
                  <div className="wb-secretary-task-heading">
                    <button
                      type="button"
                      className="wb-secretary-task-toggle"
                      aria-expanded={opened}
                      aria-controls={opened ? selectedId : undefined}
                      onClick={() => setSelected(opened ? null : item.id)}
                    >
                      <Icon aria-hidden="true" />
                      <span className="wb-secretary-github-kind">
                        {label(`kind.${item.kind}`, kind.fallback)} #
                        {item.number}
                      </span>
                      <strong>{item.title}</strong>
                    </button>
                    {item.taskId && (
                      <span className="wb-secretary-task-status">
                        {label("assigned", "已交办")}
                      </span>
                    )}
                    {href && (
                      <button
                        type="button"
                        className="wb-secretary-task-open"
                        aria-label={label("openSource", "在 GitHub 打开")}
                        title={label("openSource", "在 GitHub 打开")}
                        onClick={() =>
                          void settingsApi.openExternal(href).catch((cause) => {
                            if (mounted.current)
                              setActionError(agentErrorMessage(cause));
                          })
                        }
                      >
                        <ArrowUpRight aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {opened && (
                    <div className="wb-secretary-task-detail" id={selectedId}>
                      <p>
                        {[
                          item.actor && `@${item.actor}`,
                          label(`state.${item.state}`, item.state),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {item.body && (
                        <p className="wb-secretary-github-body">{item.body}</p>
                      )}
                      {linked && (
                        <button
                          type="button"
                          className="wb-secretary-task-open"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void run(
                              "open",
                              async () => onOpenSession(linked.sessionId),
                              () => {},
                            )
                          }
                        >
                          <ArrowUpRight aria-hidden="true" />
                          {label("openTask", "打开已交办任务")}
                        </button>
                      )}
                      {linked?.status === "completed" && item.kind !== "ci" && (
                        <AgentSecretaryGithubReply
                          sessionId={sessionId}
                          itemId={item.id}
                          summary={linked.summary ?? ""}
                          login={source.login}
                        />
                      )}
                      {linked?.status === "completed" && linked.worktree && (
                        <AgentSecretaryDraftPrCard
                          key={linked.id}
                          sessionId={sessionId}
                          taskId={linked.id}
                          disabled={!active || Boolean(busy)}
                        />
                      )}
                      {!item.taskId && (
                        <form
                          className="wb-secretary-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            delegate(item);
                          }}
                        >
                          <label>
                            {label("instructions", "交办要求")}
                            <textarea
                              ref={instructionsInput}
                              value={drafts[item.id] ?? ""}
                              onChange={(event) =>
                                setDrafts((old) => ({
                                  ...old,
                                  [item.id]: event.target.value,
                                }))
                              }
                              placeholder={label(
                                "instructionsPlaceholder",
                                "例如：检查复现步骤，给出修复方案",
                              )}
                              maxLength={20_000}
                              rows={2}
                              required
                            />
                          </label>
                          <div className="wb-secretary-form-actions">
                            <span>
                              {label(
                                "worktreeHint",
                                "任务在基于当前项目已提交版本创建的独立工作树中执行。",
                              )}
                            </span>
                            <button
                              type="submit"
                              disabled={
                                Boolean(busy) || !drafts[item.id]?.trim()
                              }
                            >
                              {busy === "delegate" ? (
                                <LoaderCircle
                                  className="animate-spin"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Send aria-hidden="true" />
                              )}
                              {label("delegate", "交办此条目")}
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
