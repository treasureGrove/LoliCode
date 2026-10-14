import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Square,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  SlidersHorizontal,
  Lightbulb,
  ChevronDown,
  Sparkles,
  Blocks,
  Archive,
  Pin,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { settingsApi } from "@/lib/api";
import { agentApi } from "@/lib/api/agent";
import { agentErrorMessage, useAgentSnapshot } from "@/hooks/useAgentSnapshot";
import type {
  AgentCatalog,
  AgentEngineStatus,
  AgentMode,
  AgentPermissionMode,
  AgentProject,
  AgentModel,
  AgentSession,
  AgentSnapshot,
  AgentWorkspace,
} from "@/types/agent";
import { AgentMessageView } from "./AgentParts";
import { AgentChanges } from "./AgentChanges";
import { AgentPermissionCard } from "./AgentPermissionCard";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { WindowControlsContext } from "@/components/shell/AppPageHeader";
import LolicodeMascot from "@/components/shell/LolicodeMascot";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE } from "@/lib/platform";
import "./lolicode-workbench.css";
import { AgentSessionMenu } from "./AgentSessionMenu";
import { AgentExtensionsPanel } from "./AgentExtensionsPanel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const RECENT_KEY = "lolicode.agent.recent-projects";
const EMPTY_CATALOG: AgentCatalog = {
  revision: 0,
  models: [],
  excludedSources: [],
};
type PendingSend = { requestId: string; assistantIds: Set<string> };

function WelcomeMascot({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`wb-welcome-art${compact ? " wb-welcome-art-compact" : ""}`}
      aria-hidden="true"
    >
      <div className="wb-welcome-halo" />
      <LolicodeMascot className="wb-welcome-mascot" variant="full" decorative />
      <svg
        className="wb-welcome-sparkles"
        viewBox="0 0 180 150"
        fill="none"
        focusable="false"
      >
        <path
          d="m25 25 3.5 8 8 3.5-8 3.5-3.5 8-3.5-8-8-3.5 8-3.5ZM151 92l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5Z"
          fill="currentColor"
        />
        <path
          d="M139 31c-6-5-13-7-14-2-1 4 6 8 14 9m0-7c6-5 13-7 14-2 1 4-6 8-14 9m0-7v7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="139" cy="34" r="3" fill="currentColor" />
      </svg>
    </div>
  );
}
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
  const windowControls = useContext(WindowControlsContext);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [permissionMode, setPermissionMode] =
    useState<AgentPermissionMode>("ask");
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const fullAccessTarget = useRef<string | null>(null);
  const [sessionOverrides, setSessionOverrides] = useState<
    Record<string, AgentSession>
  >({});
  const overridesRef = useRef(sessionOverrides);
  overridesRef.current = sessionOverrides;
  const overrideFields = useRef<Record<string, (keyof AgentSession)[]>>({});
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

  useEffect(() => {
    const toggleSidebar = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key === "\\" &&
        !event.repeat
      ) {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
      }
    };
    window.addEventListener("keydown", toggleSidebar);
    return () => window.removeEventListener("keydown", toggleSidebar);
  }, []);

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
      const knownProjects = await agentApi.listProjects();
      if (!mounted.current || generation.current !== requestGeneration) return;
      setProjects(knownProjects);
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
    const confirmed = overridesRef.current[id];
    const matchesConfirmed =
      !confirmed ||
      next.session.updatedAt > confirmed.updatedAt ||
      (overrideFields.current[id] || []).every((field) => {
        if (field === "model")
          return (
            confirmed.model?.providerId === next.session.model?.providerId &&
            confirmed.model?.modelId === next.session.model?.modelId
          );
        if (field === "pinned" || field === "archived")
          return Boolean(confirmed[field]) === Boolean(next.session[field]);
        return confirmed[field] === next.session[field];
      });
    if (matchesConfirmed) {
      setSessions((old) =>
        old.map((session) => (session.id === id ? next.session : session)),
      );
      if (confirmed) {
        delete overrideFields.current[id];
        const current = { ...overridesRef.current };
        delete current[id];
        overridesRef.current = current;
        setSessionOverrides((old) => {
          const copy = { ...old };
          delete copy[id];
          return copy;
        });
      }
    }
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
    (sessionId && sessionOverrides[sessionId]) ||
    snapshot?.session ||
    sessions.find((session) => session.id === sessionId);
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
    if (mutation.current || initializing) return;
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
      setShowArchived(false);
      setPending((old) => ({
        ...old,
        ...restorePending(result.workspace.path, result.sessions),
      }));
      rememberProject(result.workspace.path);
      const knownProjects = await agentApi.listProjects();
      if (!mounted.current || generation.current !== requestGeneration) return;
      setProjects(knownProjects);
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
      const session = await agentApi.createSession(
        modelId,
        mode,
        undefined,
        permissionMode,
      );
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
  const refreshCatalog = async (propagateFailure = false) => {
    if (mutation.current || working) {
      if (propagateFailure)
        throw new Error("请等待当前任务或操作结束后重新载入。");
      return;
    }
    if (!workspace && propagateFailure)
      throw new Error("请先打开项目，再载入扩展。");
    mutation.current = true;
    setBusy("catalog");
    setError(null);
    try {
      if (workspace) {
        const result = await agentApi.openProject(workspace.path, true);
        if (!mounted.current) return;
        setWorkspace(result.workspace);
        bindCatalog(result.catalog);
        const refreshedSessions = showArchived
          ? await agentApi.listSessions(result.workspace.path, true)
          : result.sessions;
        if (!mounted.current) return;
        setSessions(refreshedSessions);
        setSessionId((current) =>
          refreshedSessions.some((session) => session.id === current)
            ? current
            : refreshedSessions[0]?.id || null,
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
      if (propagateFailure) throw cause;
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const refreshAfter = async (operation: () => Promise<void>) => {
    await operation();
    if (mounted.current) setRefresh((old) => old + 1);
  };
  const confirmSession = (
    session: AgentSession,
    fields: (keyof AgentSession)[],
  ) => {
    setSessions((old) =>
      old.map((item) => (item.id === session.id ? session : item)),
    );
    overrideFields.current[session.id] = [
      ...new Set([...(overrideFields.current[session.id] || []), ...fields]),
    ];
    overridesRef.current = { ...overridesRef.current, [session.id]: session };
    setSessionOverrides(overridesRef.current);
    setRefresh((old) => old + 1);
  };
  const updateSessionConfig = async (patch: {
    modelId?: string;
    mode?: AgentMode;
    permissionMode?: AgentPermissionMode;
  }) => {
    if (!sessionId) {
      if (patch.modelId) setModelId(patch.modelId);
      if (patch.mode) setMode(patch.mode);
      if (patch.permissionMode) setPermissionMode(patch.permissionMode);
      return;
    }
    if (
      mutation.current ||
      activeStatus(statusRef.current[sessionId]) ||
      pendingRef.current[sessionId] ||
      stoppingRef.current[sessionId]
    )
      return;
    const id = sessionId;
    mutation.current = true;
    setBusy("config");
    setError(null);
    try {
      const result = await agentApi.updateSession(id, patch);
      if (!mounted.current) return;
      if (result.id !== id)
        throw new Error("返回的会话与当前选择不一致，请重新读取。");
      confirmSession(result, [
        ...(patch.modelId ? ["model" as const] : []),
        ...(patch.mode ? ["mode" as const] : []),
        ...(patch.permissionMode ? ["permissionMode" as const] : []),
      ]);
      if (patch.modelId) setModelId(patch.modelId);
      if (patch.mode) setMode(patch.mode);
      if (patch.permissionMode) setPermissionMode(patch.permissionMode);
    } catch (cause) {
      if (mounted.current && selectedId.current === id)
        setError(agentErrorMessage(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const mutateSession = async (
    id: string,
    operation: () => Promise<AgentSession | void>,
    remove = false,
    fields: (keyof AgentSession)[] = [],
  ) => {
    if (mutation.current) throw new Error("请等待当前操作完成。");
    mutation.current = true;
    setBusy("metadata");
    try {
      const result = await operation();
      if (!mounted.current) return;
      if (result && result.id !== id)
        throw new Error("返回的会话与当前选择不一致，请重新读取。");
      if (remove || (result?.archived && !showArchived)) {
        setSessions((old) => old.filter((item) => item.id !== id));
        if (selectedId.current === id)
          setSessionId(
            sessions.find((item) => item.id !== id && !item.archived)?.id ||
              null,
          );
      } else if (result) confirmSession(result, fields);
      if (remove && workspace) {
        storePending(workspace.path, id);
        setStatuses((old) => {
          const copy = { ...old };
          delete copy[id];
          return copy;
        });
        setSessionOverrides((old) => {
          const copy = { ...old };
          delete copy[id];
          return copy;
        });
      }
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const toggleArchive = async () => {
    if (!workspace || mutation.current) return;
    mutation.current = true;
    setBusy("archive");
    setError(null);
    try {
      const items = await agentApi.listSessions(workspace.path, true);
      if (!mounted.current) return;
      setSessions(items);
      setShowArchived((value) => !value);
    } catch (cause) {
      if (mounted.current) setError(agentErrorMessage(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const updateProject = async (project: AgentProject, remove = false) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy("project-meta");
    setError(null);
    try {
      if (remove) await agentApi.removeProject(project.path);
      else await agentApi.setProjectMetadata(project.path, !project.pinned);
      const next = await agentApi.listProjects();
      if (mounted.current) setProjects(next);
    } catch (cause) {
      if (mounted.current) setError(agentErrorMessage(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(null);
    }
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
    <div className="lolicode-agent-page lolicode-workbench">
      {!sidebarCollapsed && (
        <aside className="wb-sidebar" aria-label="项目会话">
          <div
            className="wb-brand"
            {...DRAG_REGION_ATTR}
            style={DRAG_REGION_STYLE as React.CSSProperties}
          >
            <LolicodeMascot
              className="wb-brand-mascot"
              variant="portrait"
              decorative
            />
            <div className="wb-brand-label">
              LoliCode <span>工作台</span>
            </div>
          </div>
          <nav className="wb-nav" aria-label="工作台操作">
            <button
              className="wb-nav-button"
              disabled={!workspace || Boolean(busy) || !modelId}
              onClick={() => void createSession()}
            >
              <MessageSquarePlus />
              {busy === "create" ? "正在创建…" : "新建会话"}
            </button>
            <button
              className="wb-nav-button"
              disabled={
                initializing || Boolean(busy) || engine?.available === false
              }
              onClick={() => void openProject()}
            >
              <FolderOpen />
              {workspace ? "切换项目" : "选择项目"}
            </button>
            <button
              className="wb-nav-button"
              onClick={() => setExtensionsOpen(true)}
            >
              <Blocks />
              技能与插件
            </button>
          </nav>
          <label className="wb-search">
            <Search />
            <input
              aria-label="搜索会话"
              placeholder="搜索会话"
              value={sessionSearch}
              onChange={(event) => setSessionSearch(event.target.value)}
            />
          </label>
          <div className="wb-projects">
            <div className="wb-section-label">
              <span>{showArchived ? "归档会话" : "项目与会话"}</span>
              <button
                className="wb-icon-button"
                disabled={!workspace || Boolean(busy)}
                aria-label={showArchived ? "显示当前会话" : "显示归档会话"}
                aria-pressed={showArchived}
                onClick={() => void toggleArchive()}
              >
                <Archive />
              </button>
            </div>
            {workspace && (
              <>
                <div className="wb-project-row" title={workspace.path}>
                  <ChevronDown />
                  <Folder />
                  <span>{workspace.name}</span>
                  {projects.find((item) => item.path === workspace.path)
                    ?.pinned && <Pin size={11} />}
                  <details className="wb-project-menu wb-current-project-menu">
                    <summary aria-label={`管理项目：${workspace.name}`}>
                      <MoreHorizontal size={14} />
                    </summary>
                    <div>
                      <button
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void updateProject(
                            projects.find(
                              (item) => item.path === workspace.path,
                            ) || {
                              ...workspace,
                              pinned: false,
                              lastOpenedAt: 0,
                            },
                          )
                        }
                      >
                        {projects.find((item) => item.path === workspace.path)
                          ?.pinned
                          ? "取消置顶"
                          : "置顶项目"}
                      </button>
                      <button
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void updateProject(
                            projects.find(
                              (item) => item.path === workspace.path,
                            ) || {
                              ...workspace,
                              pinned: false,
                              lastOpenedAt: 0,
                            },
                            true,
                          )
                        }
                      >
                        移出项目列表
                      </button>
                      <p>项目文件与会话保留。</p>
                    </div>
                  </details>
                </div>
                {sessions
                  .filter(
                    (session) =>
                      Boolean(session.archived) === showArchived &&
                      (!sessionSearch.trim() ||
                        session.title
                          .toLocaleLowerCase()
                          .includes(sessionSearch.toLocaleLowerCase())),
                  )
                  .sort(
                    (a, b) =>
                      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
                      b.updatedAt - a.updatedAt,
                  )
                  .map((session) => (
                    <div className="wb-session-container" key={session.id}>
                      <button
                        className="wb-session-row"
                        disabled={busy === "project" || busy === "create"}
                        aria-pressed={session.id === sessionId}
                        onClick={() => {
                          setError(null);
                          setSessionId(session.id);
                        }}
                      >
                        <span>{session.title || "新会话"}</span>
                        {session.pinned && (
                          <Pin size={11} aria-label="已置顶" />
                        )}
                        {(activeStatus(statuses[session.id]) ||
                          pending[session.id]) && (
                          <i className="wb-session-dot" aria-label="进行中" />
                        )}
                        <small>
                          {session.mode === "plan" ? "分析" : "实现"}
                        </small>
                      </button>
                      <AgentSessionMenu
                        session={session}
                        disabled={Boolean(busy)}
                        active={
                          activeStatus(statuses[session.id]) ||
                          Boolean(pending[session.id]) ||
                          Boolean(stopping[session.id])
                        }
                        onRename={(title) =>
                          mutateSession(
                            session.id,
                            () => agentApi.renameSession(session.id, title),
                            false,
                            ["title"],
                          )
                        }
                        onPin={() =>
                          mutateSession(
                            session.id,
                            () =>
                              agentApi.setSessionMetadata(session.id, {
                                pinned: !session.pinned,
                              }),
                            false,
                            ["pinned"],
                          )
                        }
                        onArchive={() =>
                          mutateSession(
                            session.id,
                            () =>
                              agentApi.setSessionMetadata(session.id, {
                                archived: !session.archived,
                              }),
                            false,
                            ["archived"],
                          )
                        }
                        onDelete={() =>
                          mutateSession(
                            session.id,
                            () => agentApi.deleteSession(session.id),
                            true,
                          )
                        }
                      />
                    </div>
                  ))}
                {!sessions.length && (
                  <p className="wb-sidebar-note">项目还没有会话。</p>
                )}
                {sessionSearch &&
                  !sessions.some((session) =>
                    session.title
                      .toLocaleLowerCase()
                      .includes(sessionSearch.toLocaleLowerCase()),
                  ) && <p className="wb-sidebar-note">没有匹配的会话。</p>}
              </>
            )}
            {(projects.length
              ? projects.map((item) => item.path)
              : recent
            ).filter((path) => path !== workspace?.path).length > 0 && (
              <>
                <div className="wb-section-label">最近的项目</div>
                {(projects.length
                  ? projects
                  : recent.map((path) => ({
                      path,
                      name: nameOf(path),
                      pinned: false,
                      lastOpenedAt: 0,
                    }))
                )
                  .filter((item) => item.path !== workspace?.path)
                  .sort(
                    (a, b) =>
                      Number(b.pinned) - Number(a.pinned) ||
                      b.lastOpenedAt - a.lastOpenedAt,
                  )
                  .map((project) => (
                    <div className="wb-project-list-row" key={project.path}>
                      <button
                        className="wb-nav-button wb-recent-project"
                        title={project.path}
                        disabled={
                          initializing ||
                          Boolean(busy) ||
                          engine?.available === false
                        }
                        onClick={() => void openProject(project.path)}
                      >
                        <Folder />
                        <span className="truncate">{project.name}</span>
                        {project.pinned && <Pin size={11} />}
                      </button>
                      <details className="wb-project-menu">
                        <summary aria-label={`管理项目：${project.name}`}>
                          <MoreHorizontal size={14} />
                        </summary>
                        <div>
                          <button
                            disabled={Boolean(busy)}
                            onClick={() => void updateProject(project)}
                          >
                            {project.pinned ? "取消置顶" : "置顶项目"}
                          </button>
                          <button
                            disabled={Boolean(busy)}
                            onClick={() => void updateProject(project, true)}
                          >
                            移出项目列表
                          </button>
                          <p>项目文件与会话保留。</p>
                        </div>
                      </details>
                    </div>
                  ))}
              </>
            )}
          </div>
          <div className="wb-sidebar-footer">
            {onOpenChannels && (
              <button className="wb-nav-button" onClick={onOpenChannels}>
                <SlidersHorizontal />
                渠道与模型
              </button>
            )}
            <button
              className="wb-nav-button"
              disabled={Boolean(busy) || working}
              aria-label="刷新可用模型"
              title={
                working ? "请等项目中的任务完成后刷新模型" : "刷新可用模型"
              }
              onClick={() => void refreshCatalog()}
            >
              <RefreshCw />
              刷新模型目录
            </button>
            {working && (
              <p className="wb-sidebar-note">任务结束后可刷新模型目录。</p>
            )}
            {catalog.excludedSources.length > 0 && (
              <details>
                <summary>部分渠道在工作台中不可用</summary>
                <ul>
                  {catalog.excludedSources.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </aside>
      )}
      <main className="wb-main">
        <header
          className="wb-titlebar"
          {...DRAG_REGION_ATTR}
          style={DRAG_REGION_STYLE as React.CSSProperties}
        >
          <button
            className="wb-icon-button"
            title={"Ctrl + \\"}
            aria-label={sidebarCollapsed ? "展开项目侧栏" : "收起项目侧栏"}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
          <h1 {...DRAG_REGION_ATTR}>
            {selectedSession?.title || "编程工作台"}
          </h1>
          {workspace && (
            <span className="wb-titlebar-project" title={workspace.path}>
              <Folder />
              {workspace.name}
            </span>
          )}
          <div
            className="wb-native-controls"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            {windowControls}
          </div>
        </header>
        {initializing && (
          <p role="status" className="wb-notice">
            正在恢复工作台…
          </p>
        )}
        {error && (
          <div role="alert" className="wb-notice">
            <Notice tone="danger" title={error} />
          </div>
        )}
        {engine?.available === false && (
          <div className="wb-notice">
            <Notice
              tone="warning"
              title="编程引擎暂不可用"
              actions={
                <Button variant="quiet" onClick={() => void initialize()}>
                  重新检查
                </Button>
              }
            >
              请检查桌面应用的编程引擎组件，然后重新检查。
            </Notice>
          </div>
        )}
        {!workspace ? (
          <div className="wb-empty">
            <div className="wb-empty-content">
              <WelcomeMascot />
              <span className="wb-welcome-eyebrow">LoliCode 工作台</span>
              <h2>从一个项目开始</h2>
              <p>选择项目，与 LoliCode 一起分析和实现代码。</p>
              <button
                className="wb-primary"
                aria-label="打开项目文件夹"
                disabled={
                  initializing || Boolean(busy) || engine?.available === false
                }
                onClick={() => void openProject()}
              >
                <FolderOpen />
                打开项目
              </button>
              {error && (
                <button
                  className="wb-nav-button justify-center"
                  onClick={() => void initialize()}
                >
                  重新加载
                </button>
              )}
            </div>
          </div>
        ) : !sessionId ? (
          <div className="wb-empty">
            <div className="wb-empty-content">
              <WelcomeMascot compact />
              <h2>开始新的任务</h2>
              <p>
                {catalog.models.length
                  ? "选择模型并新建会话。"
                  : "先在渠道与模型中添加可用于编程的模型。"}
              </p>
              <label className="sr-only" htmlFor="agent-new-model">
                模型
              </label>
              <select
                id="agent-new-model"
                className="wb-empty-select"
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
              <div
                role="group"
                aria-label="新会话执行方式"
                className="mb-4 flex justify-center gap-2"
              >
                <button
                  className="wb-mode-button"
                  disabled={Boolean(busy)}
                  aria-pressed={mode === "plan"}
                  onClick={() => void updateSessionConfig({ mode: "plan" })}
                >
                  <Lightbulb size={14} />
                  分析
                </button>
                <button
                  className="wb-mode-button"
                  disabled={Boolean(busy)}
                  aria-pressed={mode === "build"}
                  onClick={() => void updateSessionConfig({ mode: "build" })}
                >
                  实现
                </button>
              </div>
              <label className="sr-only" htmlFor="agent-new-permission">
                执行权限
              </label>
              <select
                id="agent-new-permission"
                className="wb-empty-select"
                value={permissionMode}
                disabled={Boolean(busy)}
                onChange={(event) => {
                  if (event.target.value === "full_access") {
                    fullAccessTarget.current = null;
                    setConfirmFullAccess(true);
                  } else
                    setPermissionMode(
                      event.target.value as AgentPermissionMode,
                    );
                }}
              >
                <option value="ask">逐次确认</option>
                <option value="auto">Auto Mode</option>
                <option value="full_access">完整权限</option>
              </select>
              <button
                className="wb-primary"
                disabled={Boolean(busy) || !modelId}
                onClick={() => void createSession()}
              >
                开始会话
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="wb-context-line">
              <span>
                {boundModel
                  ? modelLabel(boundModel)
                  : selectedSession?.model?.modelId || "会话绑定的模型"}{" "}
                · {selectedSession?.mode === "plan" ? "分析" : "实现"}
              </span>
              <span role="status" className="wb-status">
                {(runningHere || queuedHere || stoppingHere) && (
                  <Loader2 className="animate-spin" />
                )}
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
              <div role="alert" className="wb-notice">
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
              <div role="alert" className="wb-notice">
                <Notice tone="danger" title={snapshot.error} />
              </div>
            )}
            {snapshot?.streamGap && activeStatus(snapshot.status) && (
              <p role="status" className="wb-notice">
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
              className="wb-chat"
            >
              <div className="wb-chat-content">
                {snapshot?.messages.map((message) => (
                  <AgentMessageView
                    key={message.id}
                    message={message}
                    projectPath={workspace.path}
                  />
                ))}
                {snapshot && !snapshot.messages.length && (
                  <div className="wb-empty">
                    <div className="wb-empty-content">
                      <WelcomeMascot compact />
                      <h2>今天想完成什么？</h2>
                      <p>说说你想完成的任务。</p>
                    </div>
                  </div>
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
            </div>
            <AgentChanges diffs={snapshot?.diffs || []} />
            <div className="wb-composer-area">
              <form
                className="wb-composer"
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
                  placeholder="描述任务，或继续追问…"
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
                <div className="wb-composer-toolbar">
                  <div className="wb-composer-model">
                    <Sparkles />
                    <label className="sr-only" htmlFor="agent-new-model">
                      模型
                    </label>
                    <select
                      id="agent-new-model"
                      disabled={
                        Boolean(busy) ||
                        !snapshot ||
                        Boolean(runningHere) ||
                        queuedHere ||
                        stoppingHere ||
                        !catalog.models.length
                      }
                      value={boundModel?.id || ""}
                      onChange={(event) =>
                        void updateSessionConfig({
                          modelId: event.target.value,
                        })
                      }
                    >
                      {!catalog.models.length && (
                        <option value="">还没有可用模型</option>
                      )}
                      {catalog.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {modelLabel(model)}
                        </option>
                      ))}
                      {!boundModel && selectedSession?.model && (
                        <option value="">
                          {selectedSession.model.modelId}（目录中不可用）
                        </option>
                      )}
                    </select>
                  </div>
                  <div
                    role="group"
                    aria-label="会话执行方式"
                    className="flex gap-1"
                  >
                    <button
                      type="button"
                      className="wb-mode-button"
                      disabled={
                        Boolean(busy) ||
                        !snapshot ||
                        Boolean(runningHere) ||
                        queuedHere ||
                        stoppingHere
                      }
                      aria-pressed={selectedSession?.mode === "plan"}
                      onClick={() =>
                        void updateSessionConfig({
                          mode:
                            selectedSession?.mode === "plan" ? "build" : "plan",
                        })
                      }
                    >
                      <Lightbulb size={13} />
                      分析
                    </button>
                    <button
                      type="button"
                      className="wb-mode-button"
                      disabled={
                        Boolean(busy) ||
                        !snapshot ||
                        Boolean(runningHere) ||
                        queuedHere ||
                        stoppingHere
                      }
                      aria-pressed={selectedSession?.mode !== "plan"}
                      onClick={() =>
                        void updateSessionConfig({ mode: "build" })
                      }
                    >
                      实现
                    </button>
                  </div>
                  <label className="sr-only" htmlFor="agent-permission-mode">
                    执行权限
                  </label>
                  <select
                    id="agent-permission-mode"
                    value={selectedSession?.permissionMode || "ask"}
                    disabled={
                      Boolean(busy) ||
                      !snapshot ||
                      Boolean(runningHere) ||
                      queuedHere ||
                      stoppingHere
                    }
                    onChange={(event) => {
                      if (event.target.value === "full_access") {
                        fullAccessTarget.current = sessionId;
                        setConfirmFullAccess(true);
                      } else
                        void updateSessionConfig({
                          permissionMode: event.target
                            .value as AgentPermissionMode,
                        });
                    }}
                  >
                    <option value="ask">逐次确认</option>
                    <option value="auto">Auto Mode</option>
                    <option value="full_access">完整权限</option>
                    {selectedSession?.permissionMode &&
                      !["ask", "auto", "full_access"].includes(
                        selectedSession.permissionMode,
                      ) && (
                        <option value={selectedSession.permissionMode}>
                          自定义权限
                        </option>
                      )}
                  </select>
                  <span className="wb-toolbar-spacer" />
                  {(runningHere || queuedHere || stoppingHere) && (
                    <button
                      type="button"
                      className="wb-primary wb-stop-button"
                      disabled={Boolean(busy) || stoppingHere}
                      onClick={() => void stop()}
                    >
                      <Square />
                      {stoppingHere ? "停止中…" : "停止"}
                    </button>
                  )}
                  <button
                    type="submit"
                    className="wb-primary"
                    disabled={sendDisabled}
                  >
                    <Send />
                    {sendingHere ? "正在发送…" : "发送"}
                  </button>
                </div>
              </form>
              <p className="wb-compose-hint">
                {selectedSession?.mode === "plan"
                  ? "分析模式只读取文件，不改动项目。"
                  : selectedSession?.permissionMode === "auto"
                    ? "常规编辑与已识别的安全命令自动允许，其余操作先询问。"
                    : selectedSession?.permissionMode === "full_access"
                      ? "允许执行项目内工具；项目外的访问仍需确认。"
                      : "改动文件与执行命令前先确认。"}{" "}
                Enter 发送 · Shift + Enter 换行
              </p>
            </div>
          </>
        )}
      </main>
      <AgentExtensionsPanel
        open={extensionsOpen}
        onOpenChange={setExtensionsOpen}
        working={working}
        projectOpen={Boolean(workspace)}
        onReload={async () => {
          await refreshCatalog(true);
        }}
        onUseSkill={
          key
            ? (skill) => {
                writeDraft(
                  key,
                  `${draft}${draft && !draft.endsWith("\n") ? "\n" : ""}请使用 ${skill.name} 技能完成这个任务。\n`,
                );
                setExtensionsOpen(false);
              }
            : undefined
        }
      />
      <Dialog open={confirmFullAccess} onOpenChange={setConfirmFullAccess}>
        <DialogContent className="wb-extensions wb-permission-confirm p-5">
          <DialogHeader>
            <DialogTitle>为此会话启用完整权限？</DialogTitle>
            <DialogDescription>
              允许 LoliCode
              在项目内改动文件、执行命令和运行工具。分析模式仍保持只读，项目外访问仍需确认。
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button
              className="wb-mode-button"
              onClick={() => setConfirmFullAccess(false)}
            >
              取消
            </button>
            <button
              className="wb-primary"
              onClick={() => {
                setConfirmFullAccess(false);
                if (fullAccessTarget.current === selectedId.current)
                  void updateSessionConfig({ permissionMode: "full_access" });
              }}
            >
              启用完整权限
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
