import { useCallback, useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { settingsApi } from "@/lib/api";
import { agentApi } from "@/lib/api/agent";
import { agentErrorMessage, useAgentSnapshot } from "@/hooks/useAgentSnapshot";
import type {
  AgentCatalog,
  AgentEngineStatus,
  AgentMode,
  AgentModel,
  AgentSession,
  AgentSnapshot,
  AgentWorkspace,
} from "@/types/agent";
import { cn } from "@/lib/utils";
import { AgentMessageView } from "./AgentParts";
import { AgentChanges } from "./AgentChanges";
import { AgentPermissionCard } from "./AgentPermissionCard";
import { AgentQuestionCard } from "./AgentQuestionCard";

const RECENT_KEY = "lolicode.agent.recent-projects";
const EMPTY_CATALOG: AgentCatalog = {
  revision: 0,
  models: [],
  excludedSources: [],
};
type PendingSend = { requestId: string; assistantIds: Set<string> };
const nameOf = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;
const draftKey = (path: string, id: string) =>
  `lolicode.agent.draft:${encodeURIComponent(path)}:${encodeURIComponent(id)}`;
const pendingKey = (path: string, id: string) =>
  `lolicode.agent.pending:${encodeURIComponent(path)}:${encodeURIComponent(id)}`;
const storePending = (path: string, id: string, entry?: PendingSend) => {
  try {
    if (entry)
      sessionStorage.setItem(
        pendingKey(path, id),
        JSON.stringify({
          requestId: entry.requestId,
          assistantIds: [...entry.assistantIds],
        }),
      );
    else sessionStorage.removeItem(pendingKey(path, id));
  } catch {}
};
const restorePending = (
  path: string,
  items: AgentSession[],
): Record<string, PendingSend> => {
  const entries: Record<string, PendingSend> = {};
  for (const session of items) {
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(pendingKey(path, session.id)) || "null",
      );
      if (saved && typeof saved === "object") {
        const item = saved as { requestId?: unknown; assistantIds?: unknown };
        if (
          typeof item.requestId === "string" &&
          Array.isArray(item.assistantIds) &&
          item.assistantIds.every((id) => typeof id === "string")
        )
          entries[session.id] = {
            requestId: item.requestId,
            assistantIds: new Set(item.assistantIds as string[]),
          };
      }
    } catch {}
  }
  return entries;
};
const readDraft = (key: string) => {
  try {
    return sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
};
const readRecent = (): string[] => {
  try {
    const paths: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(paths)
      ? paths
          .filter((path): path is string => typeof path === "string")
          .slice(0, 8)
      : [];
  } catch {
    return [];
  }
};
const activeStatus = (status?: string) =>
  Boolean(status && status !== "idle" && status !== "error");
const modelLabel = (model: AgentModel) =>
  !model.channelName || model.name.startsWith(`${model.channelName} · `)
    ? model.name
    : `${model.channelName} · ${model.name}`;

export interface AgentPageProps {
  onOpenChannels?: () => void;
  onBusyChange?: (busy: boolean) => void;
}

export function AgentPage({ onOpenChannels, onBusyChange }: AgentPageProps) {
  const [engine, setEngine] = useState<AgentEngineStatus | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [workspace, setWorkspace] = useState<AgentWorkspace | null>(null);
  const [catalog, setCatalog] = useState<AgentCatalog>(EMPTY_CATALOG);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [mode, setMode] = useState<AgentMode>("build");
  const [busy, setBusy] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState(readRecent);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, PendingSend>>({});
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const generation = useRef(0);
  const mutation = useRef(false);
  const selectedId = useRef(sessionId);
  selectedId.current = sessionId;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const stoppingRef = useRef(stopping);
  stoppingRef.current = stopping;
  const statusRef = useRef(statuses);
  statusRef.current = statuses;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const bindCatalog = (next: AgentCatalog) => {
    setCatalog(next);
    setModelId((current) =>
      next.models.some((model) => model.id === current)
        ? current
        : next.models.some((model) => model.id === next.defaultModel)
          ? next.defaultModel!
          : next.models[0]?.id || "",
    );
  };
  const rememberProject = (path: string) => {
    setRecent((old) => {
      const next = [path, ...old.filter((item) => item !== path)].slice(0, 8);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };
  const initialize = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setInitializing(true);
    setError(null);
    try {
      const status = await agentApi.getStatus();
      if (!mounted.current || generation.current !== requestGeneration) return;
      setEngine(status);
      if (status.running && status.projectPath) {
        const [nextCatalog, nextSessions] = await Promise.all([
          agentApi.getCatalog(),
          agentApi.listSessions(),
        ]);
        if (!mounted.current || generation.current !== requestGeneration)
          return;
        setWorkspace({
          path: status.projectPath,
          name: nameOf(status.projectPath),
        });
        bindCatalog(nextCatalog);
        setSessions(nextSessions);
        setPending(restorePending(status.projectPath, nextSessions));
        setSessionId(nextSessions[0]?.id || null);
        rememberProject(status.projectPath);
      }
    } catch (cause) {
      if (mounted.current && generation.current === requestGeneration)
        setError(agentErrorMessage(cause));
    } finally {
      if (mounted.current && generation.current === requestGeneration)
        setInitializing(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void initialize();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [initialize]);
  useEffect(() => {
    onBusyChange?.(Boolean(busy));
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const onSnapshot = useCallback((next: AgentSnapshot) => {
    if (!mounted.current) return;
    const id = next.session.id;
    setSessions((old) =>
      old.map((session) => (session.id === id ? next.session : session)),
    );
    setStatuses((old) =>
      old[id] === next.status ? old : { ...old, [id]: next.status },
    );
    const queued = pendingRef.current[id];
    const acknowledged =
      queued &&
      next.messages.some(
        (message) => message.role === "user" && message.id === queued.requestId,
      );
    if (
      queued &&
      (next.status === "error" ||
        (acknowledged &&
          (next.status !== "idle" ||
            next.messages.some(
              (message) =>
                message.role === "assistant" &&
                !queued.assistantIds.has(message.id),
            ))))
    ) {
      storePending(next.session.projectPath, id);
      setPending((old) => {
        const copy = { ...old };
        delete copy[id];
        return copy;
      });
    }
    if (
      stoppingRef.current[id] &&
      (next.status === "idle" || next.status === "error")
    ) {
      storePending(next.session.projectPath, id);
      setStopping((old) => {
        const copy = { ...old };
        delete copy[id];
        return copy;
      });
      setPending((old) => {
        const copy = { ...old };
        delete copy[id];
        return copy;
      });
    }
  }, []);
  const {
    snapshot,
    error: snapshotError,
    loading: snapshotLoading,
  } = useAgentSnapshot(sessionId, {
    fast: Boolean(sessionId && (pending[sessionId] || stopping[sessionId])),
    refresh,
    onSnapshot,
  });

  // An executing session remains observable when the user reads another conversation.
  const backgroundIds = Object.keys({ ...statuses, ...pending, ...stopping })
    .filter(
      (id) =>
        id !== sessionId &&
        (activeStatus(statuses[id]) || pending[id] || stopping[id]),
    )
    .sort()
    .join("|");
  useEffect(() => {
    if (!backgroundIds) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = backgroundIds.split("|");
    const poll = async () => {
      const results = await Promise.allSettled(
        ids.map((id) => agentApi.getSession(id)),
      );
      if (disposed) return;
      for (const [index, result] of results.entries())
        if (
          result.status === "fulfilled" &&
          result.value.session.id === ids[index]
        )
          onSnapshot(result.value);
      timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [backgroundIds, onSnapshot]);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll && atBottom.current) scroll.scrollTop = scroll.scrollHeight;
  }, [snapshot]);
  useEffect(() => {
    atBottom.current = true;
  }, [sessionId]);

  const working =
    Object.values(statuses).some(activeStatus) ||
    Object.keys(pending).length > 0 ||
    Object.keys(stopping).length > 0;
  const selectedSession =
    snapshot?.session || sessions.find((session) => session.id === sessionId);
  const boundModel = catalog.models.find(
    (model) =>
      model.providerId === selectedSession?.model?.providerId &&
      model.modelId === selectedSession?.model?.modelId,
  );
  const key = workspace && sessionId ? draftKey(workspace.path, sessionId) : "";
  const draft = key ? (drafts[key] ?? readDraft(key)) : "";
  const writeDraft = (storageKey: string, value: string) => {
    setDrafts((old) => ({ ...old, [storageKey]: value }));
    try {
      if (value) sessionStorage.setItem(storageKey, value);
      else sessionStorage.removeItem(storageKey);
    } catch {}
  };

  const openProject = async (path?: string) => {
    if (mutation.current || working || initializing) return;
    mutation.current = true;
    setBusy("project");
    setError(null);
    const requestGeneration = ++generation.current;
    try {
      const selectedPath =
        path || (await settingsApi.pickDirectory(workspace?.path));
      if (
        !selectedPath ||
        !mounted.current ||
        generation.current !== requestGeneration
      )
        return;
      const result = await agentApi.openProject(selectedPath);
      if (!mounted.current || generation.current !== requestGeneration) return;
      setWorkspace(result.workspace);
      bindCatalog(result.catalog);
      setSessions(result.sessions);
      setSessionId(result.sessions[0]?.id || null);
      setStatuses({});
      setPending(restorePending(result.workspace.path, result.sessions));
      setStopping({});
      rememberProject(result.workspace.path);
      setEngine((old) => ({
        ...old,
        available: true,
        running: true,
        projectPath: result.workspace.path,
      }));
    } catch (cause) {
      if (mounted.current && generation.current === requestGeneration)
        setError(agentErrorMessage(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const createSession = async () => {
    if (
      mutation.current ||
      !workspace ||
      !catalog.models.some((model) => model.id === modelId)
    )
      return;
    mutation.current = true;
    setBusy("create");
    setError(null);
    const requestGeneration = generation.current;
    try {
      const session = await agentApi.createSession(modelId, mode);
      if (!mounted.current || generation.current !== requestGeneration) return;
      setSessions((old) => [
        session,
        ...old.filter((item) => item.id !== session.id),
      ]);
      setSessionId(session.id);
    } catch (cause) {
      if (mounted.current && generation.current === requestGeneration)
        setError(agentErrorMessage(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const send = async () => {
    if (
      mutation.current ||
      !sessionId ||
      !key ||
      !draft.trim() ||
      !snapshot ||
      activeStatus(snapshot.status) ||
      pendingRef.current[sessionId] ||
      stoppingRef.current[sessionId]
    )
      return;
    const id = sessionId;
    const storageKey = key;
    const text = draft.trim();
    const requestId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    const queued = {
      requestId,
      assistantIds: new Set(
        snapshot.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.id),
      ),
    };
    pendingRef.current = { ...pendingRef.current, [id]: queued };
    storePending(workspace!.path, id, queued);
    setPending(pendingRef.current);
    mutation.current = true;
    setBusy("send");
    setBusySessionId(id);
    setError(null);
    try {
      await agentApi.sendMessage(id, text, requestId);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
      if (!mounted.current) return;
      writeDraft(storageKey, "");
      setRefresh((old) => old + 1);
    } catch (cause) {
      storePending(selectedSession!.projectPath, id);
      if (mounted.current) {
        setPending((old) => {
          const copy = { ...old };
          delete copy[id];
          return copy;
        });
        if (selectedId.current === id) setError(agentErrorMessage(cause));
      }
    } finally {
      mutation.current = false;
      if (mounted.current) {
        setBusy(null);
        setBusySessionId(null);
      }
    }
  };
  const stop = async () => {
    if (mutation.current || !sessionId || stoppingRef.current[sessionId])
      return;
    const id = sessionId;
    mutation.current = true;
    setBusy("stop");
    setBusySessionId(id);
    setError(null);
    try {
      await agentApi.interruptSession(id);
      if (mounted.current) {
        setStopping((old) => ({ ...old, [id]: true }));
        setRefresh((old) => old + 1);
      }
    } catch (cause) {
      if (mounted.current && selectedId.current === id)
        setError(agentErrorMessage(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) {
        setBusy(null);
        setBusySessionId(null);
      }
    }
  };
  const refreshCatalog = async () => {
    if (mutation.current || working) return;
    mutation.current = true;
    setBusy("catalog");
    setError(null);
    try {
      if (workspace) {
        const result = await agentApi.openProject(workspace.path);
        if (!mounted.current) return;
        setWorkspace(result.workspace);
        bindCatalog(result.catalog);
        setSessions(result.sessions);
        setSessionId((current) =>
          result.sessions.some((session) => session.id === current)
            ? current
            : result.sessions[0]?.id || null,
        );
        setEngine((old) => ({
          ...old,
          available: true,
          running: true,
          projectPath: result.workspace.path,
        }));
        setRefresh((old) => old + 1);
      } else {
        const next = await agentApi.getCatalog();
        if (mounted.current) bindCatalog(next);
      }
    } catch (cause) {
      if (mounted.current) setError(agentErrorMessage(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const refreshAfter = async (operation: () => Promise<void>) => {
    await operation();
    if (mounted.current) setRefresh((old) => old + 1);
  };
  const runningHere = snapshot && activeStatus(snapshot.status);
  const queuedHere = Boolean(sessionId && pending[sessionId]);
  const stoppingHere =
    (busy === "stop" && busySessionId === sessionId) ||
    Boolean(sessionId && stopping[sessionId]);
  const sendingHere = busy === "send" && busySessionId === sessionId;
  const sendDisabled =
    Boolean(busy) ||
    !snapshot ||
    !draft.trim() ||
    Boolean(runningHere) ||
    queuedHere ||
    stoppingHere;

  return (
    <div className="lolicode-agent-page flex h-full min-h-0 flex-col bg-app text-fg-1">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-title font-semibold">编程工作台</h1>
          <p className="mt-1 text-caption text-fg-3">
            {workspace
              ? `${workspace.name} · ${workspace.path}`
              : "选择项目，与 Agent 一起分析和实现代码。"}
          </p>
        </div>
        <div className="flex gap-2">
          {onOpenChannels && (
            <Button variant="quiet" onClick={onOpenChannels}>
              渠道与模型
            </Button>
          )}
          <Button
            variant="neutral"
            disabled={
              initializing ||
              Boolean(busy) ||
              working ||
              engine?.available === false
            }
            onClick={() => void openProject()}
          >
            <FolderOpen className="h-4 w-4" />
            {busy === "project"
              ? "正在打开…"
              : workspace
                ? "切换项目"
                : "选择项目"}
          </Button>
        </div>
      </header>
      {error && (
        <div role="alert" className="px-6 pt-3">
          <Notice tone="danger" title={error} />
        </div>
      )}
      {initializing && (
        <p
          role="status"
          className="flex items-center gap-2 px-6 py-4 text-body text-fg-3"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          正在准备工作台…
        </p>
      )}
      {!initializing && engine?.available === false && (
        <div className="px-6 py-4">
          <Notice
            tone="warning"
            title="运行组件尚未准备好，暂时不能开始会话。"
            actions={
              <Button
                variant="neutral"
                size="compact"
                onClick={() => void initialize()}
              >
                重新检查
              </Button>
            }
          />
        </div>
      )}
      {!workspace ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10">
          <MessageSquarePlus className="h-9 w-9 text-fg-3" />
          <p className="text-body text-fg-2">
            打开一个项目，开始新的编程会话。
          </p>
          {recent.length > 0 && (
            <div className="w-full max-w-lg space-y-2">
              <p className="text-caption text-fg-3">最近的项目</p>
              {recent.map((path) => (
                <Button
                  key={path}
                  variant="neutral"
                  className="h-auto w-full justify-start whitespace-normal py-3 text-left"
                  disabled={
                    initializing || Boolean(busy) || engine?.available === false
                  }
                  onClick={() => void openProject(path)}
                >
                  <FolderOpen className="h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block">{nameOf(path)}</span>
                    <span className="block break-all text-caption text-fg-3">
                      {path}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          )}
          {error && (
            <Button variant="neutral" onClick={() => void initialize()}>
              重新加载
            </Button>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside
            aria-label="项目会话"
            className="flex shrink-0 flex-col border-b border-border md:w-64 md:border-b-0 md:border-r"
          >
            <div className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="agent-new-model"
                  className="text-caption text-fg-3"
                >
                  新会话模型
                </label>
                <Button
                  variant="quiet"
                  size="compact"
                  disabled={Boolean(busy) || working}
                  aria-label="刷新可用模型"
                  title={
                    working ? "请等项目中的任务完成后刷新模型" : "刷新可用模型"
                  }
                  onClick={() => void refreshCatalog()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
              <select
                id="agent-new-model"
                className={fieldClass}
                disabled={Boolean(busy) || !catalog.models.length}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              >
                {!catalog.models.length && (
                  <option value="">还没有可用模型</option>
                )}
                {catalog.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {modelLabel(model)}
                  </option>
                ))}
              </select>
              {working && (
                <p className="text-caption text-fg-3">
                  任务结束后可刷新模型目录。
                </p>
              )}
              <div
                role="group"
                aria-label="新会话执行方式"
                className="flex gap-2"
              >
                <Button
                  variant={mode === "plan" ? "solid" : "neutral"}
                  size="compact"
                  disabled={Boolean(busy)}
                  aria-pressed={mode === "plan"}
                  onClick={() => setMode("plan")}
                >
                  分析
                </Button>
                <Button
                  variant={mode === "build" ? "solid" : "neutral"}
                  size="compact"
                  disabled={Boolean(busy)}
                  aria-pressed={mode === "build"}
                  onClick={() => setMode("build")}
                >
                  实现
                </Button>
              </div>
              <Button
                className="w-full"
                disabled={Boolean(busy) || !modelId}
                onClick={() => void createSession()}
              >
                <MessageSquarePlus className="h-4 w-4" />
                {busy === "create" ? "正在创建…" : "新建会话"}
              </Button>
              {catalog.models.length === 0 && (
                <p className="text-caption text-fg-3">
                  先在渠道与模型中添加可用于编程的模型。
                </p>
              )}
              {catalog.excludedSources.length > 0 && (
                <details className="text-caption text-fg-3">
                  <summary className="cursor-pointer">
                    部分渠道在工作台中不可用
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {catalog.excludedSources.map((reason, index) => (
                      <li key={index} className="break-words">
                        {reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <div className="max-h-40 flex-1 space-y-1 overflow-y-auto px-2 pb-3 md:max-h-none">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  disabled={busy === "project" || busy === "create"}
                  aria-pressed={session.id === sessionId}
                  onClick={() => {
                    setError(null);
                    setSessionId(session.id);
                  }}
                  className={cn(
                    "block w-full rounded-control px-3 py-2.5 text-left text-body hover:bg-subtle",
                    session.id === sessionId && "bg-subtle",
                  )}
                >
                  <span className="block truncate">
                    {session.title || "新会话"}
                  </span>
                  <span className="text-caption text-fg-3">
                    {activeStatus(statuses[session.id]) || pending[session.id]
                      ? "进行中"
                      : session.mode === "plan"
                        ? "分析"
                        : "实现"}
                  </span>
                </button>
              ))}
              {!sessions.length && (
                <p className="px-3 py-4 text-caption text-fg-3">
                  项目还没有会话。
                </p>
              )}
            </div>
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {!sessionId ? (
              <div className="flex flex-1 items-center justify-center px-6 text-body text-fg-3">
                选择模型并新建会话。
              </div>
            ) : (
              <>
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
                  <div>
                    <h2 className="text-body font-medium">
                      {selectedSession?.title || "新会话"}
                    </h2>
                    <p className="mt-0.5 text-caption text-fg-3">
                      {boundModel
                        ? modelLabel(boundModel)
                        : selectedSession?.model?.modelId ||
                          "会话绑定的模型"}{" "}
                      · {selectedSession?.mode === "plan" ? "分析" : "实现"}
                    </p>
                  </div>
                  <span role="status" className="text-caption text-fg-3">
                    {stoppingHere
                      ? "正在停止…"
                      : queuedHere
                        ? "已发送，等待开始…"
                        : snapshot?.status === "running"
                          ? "正在执行…"
                          : snapshot?.status === "waiting_permission"
                            ? "等待你的许可"
                            : snapshot?.status === "waiting_question"
                              ? "等待你的回答"
                              : snapshot?.status === "error"
                                ? "执行遇到问题"
                                : snapshotLoading && !snapshot
                                  ? "正在加载会话…"
                                  : "准备就绪"}
                  </span>
                </div>
                {snapshotError && (
                  <div role="alert" className="px-5 pt-3">
                    <Notice
                      tone="danger"
                      title={snapshotError}
                      actions={
                        <Button
                          variant="quiet"
                          size="compact"
                          onClick={() => setRefresh((old) => old + 1)}
                        >
                          重试
                        </Button>
                      }
                    />
                  </div>
                )}
                {snapshot?.error && (
                  <div role="alert" className="px-5 pt-3">
                    <Notice tone="danger" title={snapshot.error} />
                  </div>
                )}
                {snapshot?.streamGap && activeStatus(snapshot.status) && (
                  <p role="status" className="px-5 pt-2 text-caption text-fg-3">
                    正在恢复连接，已有内容会保留。
                  </p>
                )}
                <div
                  ref={scrollRef}
                  onScroll={() => {
                    const el = scrollRef.current;
                    if (el)
                      atBottom.current =
                        el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
                  }}
                  className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5"
                >
                  {snapshot?.messages.map((message) => (
                    <AgentMessageView
                      key={message.id}
                      message={message}
                      projectPath={workspace.path}
                    />
                  ))}
                  {snapshot && !snapshot.messages.length && (
                    <p className="py-10 text-center text-body text-fg-3">
                      说说你想完成的任务。
                    </p>
                  )}
                  {snapshot?.permissions
                    .filter((request) => request.sessionId === sessionId)
                    .map((request) => (
                      <AgentPermissionCard
                        key={request.id}
                        request={request}
                        onReply={(decision) =>
                          refreshAfter(() =>
                            agentApi.replyPermission(
                              request.sessionId,
                              request.id,
                              decision,
                            ),
                          )
                        }
                      />
                    ))}
                  {snapshot?.questions
                    .filter((request) => request.sessionId === sessionId)
                    .map((request) => (
                      <AgentQuestionCard
                        key={request.id}
                        question={request}
                        onReply={(answer) =>
                          refreshAfter(() =>
                            agentApi.replyQuestion(
                              request.sessionId,
                              request.id,
                              answer,
                            ),
                          )
                        }
                        onReject={() =>
                          refreshAfter(() =>
                            agentApi.rejectQuestion(
                              request.sessionId,
                              request.id,
                            ),
                          )
                        }
                      />
                    ))}
                </div>
                <AgentChanges diffs={snapshot?.diffs || []} />
                <form
                  className="shrink-0 space-y-2 border-t border-border bg-surface px-5 py-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
                  <label htmlFor="agent-message" className="sr-only">
                    发送给 Agent 的消息
                  </label>
                  <textarea
                    id="agent-message"
                    rows={3}
                    className={cn(fieldClass, "h-auto resize-none py-2.5")}
                    placeholder="描述要分析或实现的任务…"
                    value={draft}
                    disabled={sendingHere}
                    onChange={(event) => writeDraft(key, event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        if (!sendDisabled) void send();
                      }
                    }}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-caption text-fg-3">
                      Enter 发送 · Shift + Enter 换行
                    </span>
                    <div className="flex gap-2">
                      {(runningHere || queuedHere || stoppingHere) && (
                        <Button
                          type="button"
                          variant="neutral"
                          disabled={Boolean(busy) || stoppingHere}
                          onClick={() => void stop()}
                        >
                          <Square className="h-3.5 w-3.5" />
                          {stoppingHere ? "停止中…" : "停止"}
                        </Button>
                      )}
                      <Button type="submit" disabled={sendDisabled}>
                        <Send className="h-3.5 w-3.5" />
                        {sendingHere ? "正在发送…" : "发送"}
                      </Button>
                    </div>
                  </div>
                </form>
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
