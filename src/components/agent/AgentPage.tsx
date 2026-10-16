import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  FolderOpen,
  MessageSquarePlus,
  Send,
  Square,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  PanelRightOpen,
  ChevronDown,
  Blocks,
  Archive,
  Pin,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { settingsApi } from "@/lib/api";
import { agentApi } from "@/lib/api/agent";
import { toast } from "@/lib/toast";
import {
  agentStopInFlight,
  agentSubmissionInFlight,
  beginAgentSubmission,
  captureAgentDraft,
  clearAgentSubmission,
  clearSubmittedAgentDraft,
  dispatchAgentStop,
  endAgentSubmission,
  readAgentSubmission,
  saveAgentDraft,
  saveAgentSubmission,
  updateAgentSubmission,
  type AgentSubmission,
} from "@/lib/agentInputLedger";
import { agentErrorMessage, useAgentSnapshot } from "@/hooks/useAgentSnapshot";
import {
  AgentReplacementAborted,
  stopAgentBeforeReplacement,
} from "@/lib/agentInterruptSend";
import type {
  AgentCatalog,
  AgentEngineStatus,
  AgentPermissionMode,
  AgentProject,
  AgentSession,
  AgentSnapshot,
  AgentWorkspace,
} from "@/types/agent";
import { AgentTranscript } from "./AgentTranscript";
import { AgentRunError } from "./AgentRunError";
import { AgentChanges } from "./AgentChanges";
import { AgentPermissionCard } from "./AgentPermissionCard";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { AgentActivityStatus } from "./AgentActivityStatus";
import {
  AgentModelPicker,
  agentModelLabel as modelLabel,
} from "./AgentModelPicker";
import { AgentReasoningPicker } from "./AgentReasoningPicker";
import { AgentFileActionsContext } from "./AgentFilePath";
import { AgentPreviewPanel } from "./AgentPreviewPanel";
import { AgentUsageFooter } from "./AgentUsageFooter";
import { AgentPaneResizeHandle, useAgentPaneLayout } from "./AgentPaneLayout";
import { useAgentAutoSizeTextarea } from "./useAgentAutoSizeTextarea";
import { WindowControlsContext } from "@/components/shell/AppPageHeader";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE } from "@/lib/platform";
import "./lolicode-workbench.css";
import { AgentSessionMenu } from "./AgentSessionMenu";
import { AgentProjectMenu } from "./AgentProjectMenu";
import { AgentCompanion } from "./AgentCompanion";
import { AgentExtensionsPanel } from "./AgentExtensionsPanel";
import { AgentOperationsPanel } from "./AgentOperationsPanel";
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
type PendingSend = {
  requestId: string;
  assistantIds: Set<string>;
  uncertain?: boolean;
};

function WelcomeMark({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`wb-welcome-mark${compact ? " wb-welcome-mark-compact" : ""}`}
      aria-hidden="true"
    >
      <Blocks />
    </div>
  );
}
const nameOf = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;
const isLegacySession = (id: string) =>
  id.startsWith("ses_") || id.startsWith("zc:");
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
          uncertain: entry.uncertain,
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
    const entry = readAgentSubmission(path, session.id);
    if (entry) {
      const uncertain =
        entry.phase === "uncertain" ||
        (entry.phase === "submitting" &&
          !agentSubmissionInFlight(entry.requestId));
      if (uncertain && !entry.stopRequested && !readDraft(entry.draft.key))
        saveAgentDraft(entry.draft.key, entry.draft.text);
      entries[session.id] = {
        requestId: entry.requestId,
        assistantIds: new Set(entry.assistantIds),
        uncertain,
      };
      continue;
    }
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(pendingKey(path, session.id)) || "null",
      );
      if (saved && typeof saved === "object") {
        const item = saved as {
          requestId?: unknown;
          assistantIds?: unknown;
          uncertain?: boolean;
        };
        if (
          typeof item.requestId === "string" &&
          Array.isArray(item.assistantIds) &&
          item.assistantIds.every((id) => typeof id === "string")
        )
          entries[session.id] = {
            requestId: item.requestId,
            assistantIds: new Set(item.assistantIds as string[]),
            uncertain: item.uncertain === true,
          };
      }
    } catch {}
  }
  return entries;
};
const restoreStopping = (path: string, items: AgentSession[]) =>
  Object.fromEntries(
    items
      .filter((session) => {
        const entry = readAgentSubmission(path, session.id);
        return (
          entry?.stopRequested &&
          (agentStopInFlight(session.id) ||
            (entry.stopAcknowledged &&
              (entry.phase === "accepted" || entry.observed)))
        );
      })
      .map((session) => [session.id, true]),
  );
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

export interface AgentPageProps {
  onOpenChannels?: () => void;
  onBusyChange?: (busy: boolean) => void;
}

export function AgentPage({ onOpenChannels, onBusyChange }: AgentPageProps) {
  const windowControls = useContext(WindowControlsContext);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState(false);
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
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [catalog, setCatalog] = useState<AgentCatalog>(EMPTY_CATALOG);
  const [catalogUpdate, setCatalogUpdate] = useState(0);
  const catalogAttempt = useRef({ key: "", at: 0 });
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewSession, setPreviewSession] = useState<string | null>(null);
  const openPreview = useCallback(
    (path: string) => {
      setPreviewSession(sessionId);
      setPreviewPath(path);
    },
    [sessionId],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState(readRecent);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, PendingSend>>({});
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [replacementSession, setReplacementSession] = useState<string | null>(
    null,
  );
  const replacement = useRef<{ sessionId: string } | null>(null);
  const selection = useRef({ identity: "", revision: 0 });
  const identity = `${workspace?.path || ""}\0${sessionId || ""}`;
  if (selection.current.identity !== identity)
    selection.current = { identity, revision: selection.current.revision + 1 };
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [pendingTitles, setPendingTitles] = useState<Record<string, boolean>>(
    {},
  );
  const removedSessions = useRef(new Set<string>());
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const generation = useRef(0);
  const mutation = useRef(false);
  const receiptQueries = useRef(new Map<string, number>());
  const receiptQueriesInFlight = useRef(new Set<string>());
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
  useEffect(() => setPreviewPath(null), [sessionId]);

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
  const discoverSessionActivity = (items: AgentSession[]) => {
    setStatuses((old) => {
      const next = { ...old };
      for (const item of items)
        if (item.activity && !removedSessions.current.has(item.id))
          next[item.id] = item.activity.status;
      return next;
    });
    setPendingTitles((old) => {
      const next = { ...old };
      for (const item of items) {
        if (!item.activity || removedSessions.current.has(item.id)) continue;
        if (item.activity.titlePending) next[item.id] = true;
        else delete next[item.id];
      }
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
        discoverSessionActivity(nextSessions);
        setPending(restorePending(status.projectPath, nextSessions));
        setStopping(restoreStopping(status.projectPath, nextSessions));
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
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const observe = (revision: number) => {
      if (!disposed && Number.isSafeInteger(revision) && revision >= 0)
        setCatalogUpdate((previous) => Math.max(previous, revision));
    };
    // An event can occur while this page is unmounted. The revision-only read
    // catches that case without exposing channel credentials to this page.
    void agentApi
      .getCatalogRevision()
      .then(observe)
      .catch(() => {});
    void listen<{ revision: number }>(
      "channel-center-updated",
      ({ payload }) => {
        observe(payload.revision);
      },
    )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    onBusyChange?.(Boolean(busy));
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const onSnapshot = useCallback((next: AgentSnapshot) => {
    if (!mounted.current) return;
    const id = next.session.id;
    if (removedSessions.current.has(id)) return;
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
    setPendingTitles((old) => {
      if (Boolean(old[id]) === Boolean(next.titlePending)) return old;
      const current = { ...old };
      if (next.titlePending) current[id] = true;
      else delete current[id];
      return current;
    });
    const queued = pendingRef.current[id];
    const submitted = readAgentSubmission(next.session.projectPath, id);
    const candidate =
      queued ||
      (submitted
        ? {
            requestId: submitted.requestId,
            assistantIds: new Set(submitted.assistantIds),
          }
        : undefined);
    const acknowledged =
      candidate &&
      next.messages.some(
        (message) =>
          message.role === "user" && message.id === candidate.requestId,
      );
    if (
      submitted &&
      replacement.current?.sessionId !== id &&
      (isLegacySession(id) || id.startsWith("lc:")) &&
      (isLegacySession(id) ||
        (!acknowledged && !submitted.observed) ||
        (submitted.stopRequested && !submitted.stopAcknowledged)) &&
      !agentSubmissionInFlight(submitted.requestId) &&
      (submitted.phase === "uncertain" ||
        (submitted.stopRequested && !submitted.stopAcknowledged) ||
        next.status === "idle" ||
        next.status === "error")
    ) {
      const queryKey = `${id}:${submitted.requestId}`;
      const last = receiptQueries.current.get(queryKey);
      if (
        !receiptQueriesInFlight.current.has(queryKey) &&
        (last === undefined || Date.now() - last >= 5000)
      ) {
        receiptQueries.current.set(queryKey, Date.now());
        receiptQueriesInFlight.current.add(queryKey);
        void agentApi
          .queryCommand(id, submitted.requestId)
          .then(async (receipt) => {
            const current = readAgentSubmission(next.session.projectPath, id);
            if (
              !mounted.current ||
              current?.requestId !== submitted.requestId ||
              (current.observed &&
                !isLegacySession(id) &&
                !(current.stopRequested && !current.stopAcknowledged))
            )
              return;
            if (receipt.status === "rejected" || receipt.status === "failed") {
              clearAgentSubmission(
                next.session.projectPath,
                id,
                current.requestId,
              );
              storePending(next.session.projectPath, id);
              if (!readDraft(current.draft.key))
                saveAgentDraft(current.draft.key, current.draft.text);
              const queued = { ...pendingRef.current };
              delete queued[id];
              pendingRef.current = queued;
              setPending(queued);
              const cancelled = { ...stoppingRef.current };
              delete cancelled[id];
              stoppingRef.current = cancelled;
              setStopping(cancelled);
              setDrafts((old) => ({
                ...old,
                [current.draft.key]: readDraft(current.draft.key),
              }));
              if (selectedId.current === id)
                setError(receipt.message || "该次发送未被接收，请重试。");
              return;
            }
            if (isLegacySession(id)) return;
            const accepted = receipt.status === "accepted";
            updateAgentSubmission(
              next.session.projectPath,
              id,
              current.requestId,
              {
                phase: accepted ? "accepted" : "uncertain",
                ...(accepted && current.stopRequested
                  ? { stopAcknowledged: false }
                  : {}),
              },
            );
            const queued = {
              requestId: current.requestId,
              assistantIds: new Set(current.assistantIds),
              uncertain: !accepted,
            };
            pendingRef.current = { ...pendingRef.current, [id]: queued };
            setPending(pendingRef.current);
            storePending(next.session.projectPath, id, queued);
            if (!accepted) {
              // Unknown is not evidence of cancellation or rejection. Keep the
              // original identity and let a user retry the exact same input.
              if (!current.stopRequested && !readDraft(current.draft.key)) {
                saveAgentDraft(current.draft.key, current.draft.text);
                setDrafts((old) => ({
                  ...old,
                  [current.draft.key]: current.draft.text,
                }));
              }
              if (current.stopRequested && !agentStopInFlight(id)) {
                const stopped = { ...stoppingRef.current };
                delete stopped[id];
                stoppingRef.current = stopped;
                setStopping(stopped);
              }
            } else if (current.stopRequested) {
              // Admission has now been proven after the earlier Stop. Repeat it
              // in that order before accepting an idle snapshot as settlement.
              await dispatchAgentStop(id, agentApi.interruptSession, true);
              updateAgentSubmission(
                next.session.projectPath,
                id,
                current.requestId,
                { stopAcknowledged: true },
              );
            } else if (clearSubmittedAgentDraft(current.draft)) {
              setDrafts((old) => ({ ...old, [current.draft.key]: "" }));
            }
          })
          .catch(() => {
            /* Keep unresolved input available for exact-ID retry. */
          })
          .finally(() => {
            receiptQueriesInFlight.current.delete(queryKey);
          });
      }
    }
    // The preserved history is not a live actor. Reconcile old receipts only;
    // never replay their saved Stop intent against a retired engine.
    if (isLegacySession(id)) return;
    if (submitted && acknowledged && !submitted.observed) {
      updateAgentSubmission(next.session.projectPath, id, submitted.requestId, {
        observed: true,
      });
    }
    if (submitted && acknowledged) {
      if (clearSubmittedAgentDraft(submitted.draft))
        setDrafts((old) =>
          old[submitted.draft.key] !== undefined &&
          old[submitted.draft.key] !== submitted.draft.text
            ? old
            : { ...old, [submitted.draft.key]: "" },
        );
      if (submitted.phase === "uncertain" && selectedId.current === id)
        setError(null);
    }
    const userIndex = candidate
      ? next.messages.findIndex(
          (message) =>
            message.id === candidate.requestId && message.role === "user",
        )
      : -1;
    const nextUser = next.messages.findIndex(
      (message, index) => index > userIndex && message.role === "user",
    );
    const hasReply =
      userIndex >= 0 &&
      next.messages
        .slice(userIndex + 1, nextUser < 0 ? undefined : nextUser)
        .some(
          (message) =>
            message.role === "assistant" &&
            !candidate?.assistantIds.has(message.id),
        );
    const received =
      acknowledged &&
      ((next.status !== "idle" && next.status !== "error") || hasReply);
    if (
      submitted &&
      received &&
      !agentSubmissionInFlight(submitted.requestId) &&
      !submitted.stopRequested
    )
      clearAgentSubmission(next.session.projectPath, id, submitted.requestId);
    if (queued && received) {
      storePending(next.session.projectPath, id);
      const updated = { ...pendingRef.current };
      delete updated[id];
      pendingRef.current = updated;
      setPending((old) => {
        const copy = { ...old };
        delete copy[id];
        return copy;
      });
    }
    if (
      (submitted
        ? submitted.stopRequested &&
          submitted.stopAcknowledged &&
          (submitted.phase === "accepted" || submitted.observed || acknowledged)
        : stoppingRef.current[id]) &&
      (next.status === "idle" || next.status === "error") &&
      !agentStopInFlight(id) &&
      (!submitted || !agentSubmissionInFlight(submitted.requestId))
    ) {
      storePending(next.session.projectPath, id);
      if (submitted)
        clearAgentSubmission(next.session.projectPath, id, submitted.requestId);
      const stopped = { ...stoppingRef.current };
      delete stopped[id];
      stoppingRef.current = stopped;
      const updated = { ...pendingRef.current };
      delete updated[id];
      pendingRef.current = updated;
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

  // Observe task and title jobs independently when another conversation is selected.
  const backgroundIds = Object.keys({
    ...statuses,
    ...pending,
    ...stopping,
    ...pendingTitles,
  })
    .filter(
      (id) =>
        id !== sessionId &&
        (activeStatus(statuses[id]) ||
          pending[id] ||
          stopping[id] ||
          pendingTitles[id]),
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
  const readOnlySession = Boolean(sessionId && isLegacySession(sessionId));
  const boundModel = catalog.models.find(
    (model) =>
      model.providerId === selectedSession?.model?.providerId &&
      model.modelId === selectedSession?.model?.modelId,
  );
  const key = workspace && sessionId ? draftKey(workspace.path, sessionId) : "";
  const draft = key ? (drafts[key] ?? readDraft(key)) : "";
  const textareaRef = useAgentAutoSizeTextarea(draft);
  const paneLayout = useAgentPaneLayout({
    sidebarVisible: !sidebarCollapsed,
    previewVisible:
      Boolean(sessionId) &&
      previewSession === sessionId &&
      previewPath !== null,
  });
  const writeDraft = (storageKey: string, value: string) => {
    setDrafts((old) => ({ ...old, [storageKey]: value }));
    saveAgentDraft(storageKey, value);
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
      result.warnings?.forEach((warning) => toast.warning(warning));
      setWorkspace(result.workspace);
      bindCatalog(result.catalog);
      setSessions(result.sessions);
      discoverSessionActivity(result.sessions);
      setSessionId(result.sessions[0]?.id || null);
      setShowArchived(false);
      setPending((old) => ({
        ...old,
        ...restorePending(result.workspace.path, result.sessions),
      }));
      setStopping((old) => ({
        ...old,
        ...restoreStopping(result.workspace.path, result.sessions),
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
        "build",
        undefined,
        permissionMode,
        reasoningEffort || undefined,
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
      replacement.current ||
      !sessionId ||
      isLegacySession(sessionId) ||
      !key ||
      !draft.trim() ||
      !snapshot ||
      (pendingRef.current[sessionId] &&
        !pendingRef.current[sessionId].uncertain &&
        !activeStatus(snapshot.status)) ||
      stoppingRef.current[sessionId] ||
      agentStopInFlight(sessionId)
    )
      return;
    const id = sessionId;
    const storageKey = key;
    const text = draft.trim();
    const projectPath = workspace!.path;
    const sourceDraft = captureAgentDraft(storageKey, draft);
    const targetRevision = selection.current.revision;
    const requestGeneration = generation.current;
    const stillCurrent = () =>
      mounted.current &&
      generation.current === requestGeneration &&
      selection.current.revision === targetRevision &&
      selectedId.current === id &&
      workspaceRef.current?.path === projectPath;
    let sourceSnapshot = snapshot;
    const interrupting = activeStatus(sourceSnapshot.status);
    const claim = interrupting ? { sessionId: id } : null;
    if (claim) {
      replacement.current = claim;
      setReplacementSession(id);
    }
    try {
      if (interrupting) {
        stoppingRef.current = { ...stoppingRef.current, [id]: true };
        setStopping(stoppingRef.current);
        setError(null);
        try {
          sourceSnapshot = await stopAgentBeforeReplacement({
            sessionId: id,
            projectPath,
            isCurrent: stillCurrent,
            onSnapshot,
          });
          if (!stillCurrent()) return;
          storePending(projectPath, id);
          const queued = { ...pendingRef.current };
          delete queued[id];
          pendingRef.current = queued;
          setPending(queued);
          const stopped = { ...stoppingRef.current };
          delete stopped[id];
          stoppingRef.current = stopped;
          setStopping(stopped);
          setRefresh((old) => old + 1);
        } catch (cause) {
          if (!(cause instanceof AgentReplacementAborted) && stillCurrent())
            setError(agentErrorMessage(cause));
          if (!agentStopInFlight(id)) {
            const stopped = { ...stoppingRef.current };
            delete stopped[id];
            stoppingRef.current = stopped;
            if (mounted.current) setStopping(stopped);
          }
          return;
        }
      }
      if (!stillCurrent()) return;
      if (mutation.current) {
        setError("配置正在保存，尚未发送新消息，请稍后重试。");
        return;
      }
      // Historical plan sessions remain readable. A new user send deliberately
      // moves an idle session to build before recording or dispatching input.
      if (
        (interrupting ? sourceSnapshot.session : selectedSession)?.mode ===
        "plan"
      ) {
        mutation.current = true;
        setBusy("config");
        setError(null);
        try {
          const result = await agentApi.updateSession(id, { mode: "build" });
          if (result.id !== id)
            throw new Error("返回的会话与当前选择不一致，请重新读取。");
          if (!stillCurrent()) return;
          confirmSession(result, ["mode"]);
        } catch (cause) {
          if (mounted.current && selectedId.current === id)
            setError(agentErrorMessage(cause));
          return;
        } finally {
          mutation.current = false;
          if (mounted.current) setBusy(null);
        }
      }
      if (!stillCurrent()) return;
      const previous = readAgentSubmission(projectPath, id);
      if (previous && (previous.text !== text || previous.stopRequested)) {
        setError(
          "上次发送的接收状态尚未确认，请先停止该次任务，再发送新的内容。",
        );
        return;
      }
      const requestId =
        previous?.requestId || `msg_${crypto.randomUUID().replace(/-/g, "")}`;
      const submission: AgentSubmission = {
        version: 1,
        projectPath,
        sessionId: id,
        requestId,
        text,
        draft: sourceDraft,
        assistantIds:
          previous?.assistantIds ||
          sourceSnapshot.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.id),
        phase: "submitting",
        observed: previous?.observed || false,
        stopRequested: false,
      };
      try {
        saveAgentSubmission(submission);
      } catch (cause) {
        setError(agentErrorMessage(cause));
        return;
      }
      const queued = {
        requestId,
        assistantIds: new Set(submission.assistantIds),
      };
      beginAgentSubmission(requestId);
      pendingRef.current = { ...pendingRef.current, [id]: queued };
      storePending(projectPath, id, queued);
      setPending(pendingRef.current);
      mutation.current = true;
      setBusy("send");
      setBusySessionId(id);
      setError(null);
      const accepted = () => {
        try {
          updateAgentSubmission(projectPath, id, requestId, {
            phase: "accepted",
          });
        } catch (cause) {
          // The native ACK is still valid if browser persistence became
          // unavailable afterwards. Retain the original identity for recovery.
          if (mounted.current && selectedId.current === id)
            setError(agentErrorMessage(cause));
        }
        const cleared = clearSubmittedAgentDraft(submission.draft);
        if (!mounted.current) return;
        if (cleared)
          setDrafts((old) =>
            old[storageKey] !== undefined &&
            old[storageKey] !== submission.draft.text
              ? old
              : { ...old, [storageKey]: "" },
          );
        setRefresh((old) => old + 1);
      };
      try {
        await agentApi.sendMessage(id, text, requestId);
        accepted();
      } catch (cause) {
        if (readAgentSubmission(projectPath, id)?.observed) accepted();
        else {
          try {
            updateAgentSubmission(projectPath, id, requestId, {
              phase: "uncertain",
            });
          } catch {
            /* The original pre-dispatch receipt remains recoverable. */
          }
          const uncertain = { ...queued, uncertain: true };
          storePending(projectPath, id, uncertain);
          if (mounted.current) {
            pendingRef.current = { ...pendingRef.current, [id]: uncertain };
            setPending(pendingRef.current);
            if (selectedId.current === id) setError(agentErrorMessage(cause));
          }
        }
      } finally {
        // A Stop may have reached an idle actor before this delayed prompt was
        // admitted. Honour the saved stop intent after both success and an
        // uncertain transport result; the first Stop ACK is not settlement.
        if (readAgentSubmission(projectPath, id)?.stopRequested) {
          try {
            updateAgentSubmission(projectPath, id, requestId, {
              stopAcknowledged: false,
            });
            await dispatchAgentStop(id, agentApi.interruptSession, true);
            updateAgentSubmission(projectPath, id, requestId, {
              stopAcknowledged: true,
            });
          } catch (cause) {
            if (mounted.current && selectedId.current === id)
              setError(agentErrorMessage(cause));
          }
        }
        endAgentSubmission(requestId);
        mutation.current = false;
        if (mounted.current) {
          setBusy(null);
          setBusySessionId(null);
        }
      }
    } finally {
      if (claim && replacement.current === claim) {
        replacement.current = null;
        if (mounted.current) setReplacementSession(null);
      }
    }
  };
  const stop = async () => {
    if (
      !sessionId ||
      isLegacySession(sessionId) ||
      stoppingRef.current[sessionId] ||
      agentStopInFlight(sessionId)
    )
      return;
    const id = sessionId;
    const projectPath = selectedSession?.projectPath || workspace?.path;
    const submitted = projectPath && readAgentSubmission(projectPath, id);
    try {
      if (submitted)
        updateAgentSubmission(projectPath!, id, submitted.requestId, {
          stopRequested: true,
          stopAcknowledged: false,
        });
    } catch (cause) {
      setError(agentErrorMessage(cause));
      return;
    }
    stoppingRef.current = { ...stoppingRef.current, [id]: true };
    setStopping(stoppingRef.current);
    setError(null);
    try {
      await dispatchAgentStop(id, agentApi.interruptSession);
      if (submitted)
        updateAgentSubmission(projectPath!, id, submitted.requestId, {
          stopAcknowledged: true,
        });
      if (mounted.current) {
        setRefresh((old) => old + 1);
      }
    } catch (cause) {
      if (mounted.current && selectedId.current === id)
        setError(agentErrorMessage(cause));
      if (mounted.current) {
        const current = { ...stoppingRef.current };
        delete current[id];
        stoppingRef.current = current;
        setStopping(current);
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
        result.warnings?.forEach((warning) => toast.warning(warning));
        setWorkspace(result.workspace);
        bindCatalog(result.catalog);
        const refreshedSessions = showArchived
          ? await agentApi.listSessions(result.workspace.path, true)
          : result.sessions;
        if (!mounted.current) return;
        setSessions(refreshedSessions);
        discoverSessionActivity(refreshedSessions);
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
  useEffect(() => {
    if (
      initializing ||
      !workspace ||
      working ||
      busy ||
      catalogUpdate <= catalog.revision
    )
      return;
    const key = `${workspace.path}:${catalogUpdate}`;
    const delay =
      catalogAttempt.current.key === key
        ? Math.max(0, 5000 - (Date.now() - catalogAttempt.current.at))
        : 0;
    const timer = setTimeout(() => {
      if (mutation.current) return;
      catalogAttempt.current = { key, at: Date.now() };
      void refreshCatalog();
    }, delay);
    return () => clearTimeout(timer);
  }, [
    initializing,
    workspace?.path,
    working,
    busy,
    catalogUpdate,
    catalog.revision,
  ]);
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
    permissionMode?: AgentPermissionMode;
    reasoningEffort?: string;
  }) => {
    if (!sessionId) {
      if (patch.modelId) setModelId(patch.modelId);
      if (patch.permissionMode) setPermissionMode(patch.permissionMode);
      if (patch.reasoningEffort !== undefined)
        setReasoningEffort(patch.reasoningEffort);
      return;
    }
    if (
      isLegacySession(sessionId) ||
      mutation.current ||
      pendingRef.current[sessionId]?.uncertain
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
        ...(patch.modelId || patch.reasoningEffort !== undefined
          ? ["reasoningEffort" as const]
          : []),
        ...(patch.permissionMode ? ["permissionMode" as const] : []),
      ]);
      if (selectedId.current === id) {
        if (patch.modelId) setModelId(patch.modelId);
        if (patch.modelId || patch.reasoningEffort !== undefined)
          setReasoningEffort(result.reasoningEffort || "");
        if (patch.permissionMode) setPermissionMode(patch.permissionMode);
      }
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
    if (isLegacySession(id))
      throw new Error("旧版会话只读，原数据保留，请新建本体会话继续");
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
        removedSessions.current.add(id);
        storePending(workspace.path, id);
        setPendingTitles((old) => {
          const copy = { ...old };
          delete copy[id];
          return copy;
        });
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
      discoverSessionActivity(items);
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
  const queuedHere = Boolean(
    sessionId && pending[sessionId] && !pending[sessionId].uncertain,
  );
  const uncertainHere = Boolean(sessionId && pending[sessionId]?.uncertain);
  const stoppingHere =
    (busy === "stop" && busySessionId === sessionId) ||
    Boolean(sessionId && stopping[sessionId]);
  const sendingHere = busy === "send" && busySessionId === sessionId;
  const replacingHere = replacementSession === sessionId;
  const sendDisabled =
    readOnlySession ||
    Boolean(busy) ||
    Boolean(replacementSession) ||
    !snapshot ||
    !draft.trim() ||
    (queuedHere && !runningHere) ||
    stoppingHere;

  return (
    <div
      ref={paneLayout.containerRef}
      className="lolicode-agent-page lolicode-workbench wb-resizable-layout"
    >
      {!sidebarCollapsed && paneLayout.sidebarVisible && (
        <aside
          className="wb-sidebar"
          aria-label="项目会话"
          style={{
            width: paneLayout.sidebarWidth,
            flexBasis: paneLayout.sidebarWidth,
          }}
        >
          <div
            className="wb-brand"
            {...DRAG_REGION_ATTR}
            style={DRAG_REGION_STYLE as React.CSSProperties}
          >
            <span className="wb-brand-mark" aria-hidden="true">
              <Blocks />
            </span>
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
              {busy === "create" ? "正在创建…" : "新建任务"}
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
              技能
            </button>
            <button
              className="wb-nav-button"
              onClick={() => setOperationsOpen(true)}
            >
              <Workflow />
              工作流与自动化
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
              <span>{showArchived ? "归档任务" : "工作区与任务"}</span>
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
                  <AgentProjectMenu
                    name={workspace.name}
                    pinned={Boolean(
                      projects.find((item) => item.path === workspace.path)
                        ?.pinned,
                    )}
                    disabled={Boolean(busy)}
                    onTogglePin={() =>
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
                    onRemove={() =>
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
                  />
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
                      </button>
                      <AgentSessionMenu
                        session={session}
                        disabled={Boolean(busy) || isLegacySession(session.id)}
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
                  <p className="wb-sidebar-note">当前项目还没有任务。</p>
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
                <div className="wb-section-label">最近的工作区</div>
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
                      <AgentProjectMenu
                        name={project.name}
                        pinned={Boolean(project.pinned)}
                        disabled={Boolean(busy)}
                        recent
                        onTogglePin={() => void updateProject(project)}
                        onRemove={() => void updateProject(project, true)}
                      />
                    </div>
                  ))}
              </>
            )}
          </div>
          <div className="wb-sidebar-footer">
            <AgentCompanion />
          </div>
        </aside>
      )}
      {!sidebarCollapsed && paneLayout.sidebarVisible && (
        <AgentPaneResizeHandle {...paneLayout.sidebarHandleProps} />
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
          <div className="wb-titlebar-heading" {...DRAG_REGION_ATTR}>
            <span className="wb-titlebar-caption">对话工作台</span>
            <h1 {...DRAG_REGION_ATTR}>
              {selectedSession?.title || "编程工作台"}
            </h1>
          </div>
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
              <WelcomeMark />
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
              <WelcomeMark compact />
              <h2>开始新任务</h2>
              <p>
                {catalog.models.length
                  ? "选择模型，然后描述你想完成的工作。"
                  : "先在渠道与模型中添加可用于编程的模型。"}
              </p>
              <AgentModelPicker
                className="mb-4"
                models={catalog.models}
                disabled={Boolean(busy)}
                value={modelId}
                onOpenChannels={onOpenChannels}
                onRefresh={() => void refreshCatalog()}
                refreshDisabled={Boolean(busy) || working}
                excludedSources={catalog.excludedSources}
                onSelect={(id) => {
                  setModelId(id);
                  setReasoningEffort((old) =>
                    catalog.models
                      .find((model) => model.id === id)
                      ?.reasoningEfforts?.includes(old)
                      ? old
                      : "",
                  );
                }}
              />
              <AgentReasoningPicker
                model={catalog.models.find((model) => model.id === modelId)}
                value={reasoningEffort}
                disabled={Boolean(busy) || !modelId}
                onSelect={setReasoningEffort}
              />
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
            {readOnlySession && (
              <p role="status" className="wb-notice">
                旧版会话只读，原数据保留，请新建本体会话继续
              </p>
            )}
            <div className="wb-context-line">
              <span className="wb-context-model">
                {boundModel ? modelLabel(boundModel) : "会话绑定的模型"}
              </span>
              <div className="wb-context-actions">
                <button
                  type="button"
                  className="wb-icon-button"
                  aria-label="预览项目文件"
                  onClick={() => openPreview("")}
                >
                  <PanelRightOpen />
                </button>
                <AgentActivityStatus
                  snapshot={snapshot}
                  queued={queuedHere}
                  stopping={stoppingHere}
                  loading={snapshotLoading}
                />
              </div>
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
            {snapshot?.streamGap && activeStatus(snapshot.status) && (
              <p role="status" className="wb-notice">
                正在恢复连接，已有内容会保留。
              </p>
            )}
            <AgentFileActionsContext.Provider
              value={{
                sessionId: sessionId || undefined,
                projectPath: workspace?.path,
                onPreview: openPreview,
              }}
            >
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
                  <AgentTranscript
                    messages={snapshot?.messages || []}
                    sessionId={snapshot?.session.id}
                    projectPath={workspace.path}
                    status={snapshot?.status}
                  />
                  {snapshot && !snapshot.messages.length && (
                    <div className="wb-empty">
                      <div className="wb-empty-content">
                        <WelcomeMark compact />
                        <h2>今天想完成什么？</h2>
                        <p>说说你想完成的任务。</p>
                      </div>
                    </div>
                  )}
                  {!readOnlySession &&
                    snapshot?.permissions
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
                  {!readOnlySession &&
                    snapshot?.questions
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
                  {snapshot && (
                    <AgentRunError
                      messages={snapshot.messages}
                      status={snapshot.status}
                      error={snapshot.error}
                      pending={Boolean(
                        queuedHere ||
                          runningHere ||
                          stoppingHere ||
                          sendingHere ||
                          replacingHere,
                      )}
                      currentTurnId={
                        sessionId ? pending[sessionId]?.requestId : undefined
                      }
                    />
                  )}
                </div>
              </div>
              <AgentChanges key={sessionId} diffs={snapshot?.diffs || []} />
            </AgentFileActionsContext.Provider>
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
                  ref={textareaRef}
                  id="agent-message"
                  rows={1}
                  placeholder="描述任务，或继续追问…"
                  title="Enter 发送 · Shift + Enter 换行；执行中可打断并发送"
                  value={draft}
                  disabled={readOnlySession}
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
                    <AgentModelPicker
                      models={catalog.models}
                      disabled={
                        readOnlySession ||
                        Boolean(busy) ||
                        !snapshot ||
                        uncertainHere
                      }
                      value={boundModel?.id || ""}
                      onOpenChannels={onOpenChannels}
                      onRefresh={() => void refreshCatalog()}
                      refreshDisabled={Boolean(busy) || working}
                      excludedSources={catalog.excludedSources}
                      notice={
                        catalogUpdate > catalog.revision
                          ? working
                            ? "渠道已更新，任务结束后将自动刷新模型目录。"
                            : "渠道已更新，可刷新模型目录。"
                          : working
                            ? "任务结束后可刷新模型目录。"
                            : undefined
                      }
                      unavailableLabel={
                        selectedSession?.model
                          ? "会话模型（目录中不可用）"
                          : undefined
                      }
                      onSelect={(id) =>
                        void updateSessionConfig({
                          modelId: id,
                        })
                      }
                    />
                  </div>
                  <AgentReasoningPicker
                    model={boundModel}
                    value={selectedSession?.reasoningEffort || ""}
                    disabled={
                      readOnlySession ||
                      Boolean(busy) ||
                      !snapshot ||
                      uncertainHere ||
                      !boundModel
                    }
                    onSelect={(value) =>
                      void updateSessionConfig({ reasoningEffort: value })
                    }
                  />
                  <label className="sr-only" htmlFor="agent-permission-mode">
                    执行权限
                  </label>
                  <select
                    id="agent-permission-mode"
                    title="逐次确认：改动和命令先询问；Auto Mode：常规编辑和安全命令自动允许；完整权限：允许项目内工具，项目外仍需确认。配置从下一次请求或工具检查生效。"
                    value={selectedSession?.permissionMode || "ask"}
                    disabled={
                      readOnlySession ||
                      Boolean(busy) ||
                      !snapshot ||
                      uncertainHere
                    }
                    onChange={(event) => {
                      if (readOnlySession) return;
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
                  {!readOnlySession &&
                    (runningHere ||
                      queuedHere ||
                      uncertainHere ||
                      stoppingHere) && (
                      <button
                        type="button"
                        className="wb-primary wb-stop-button"
                        disabled={stoppingHere}
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
                    title={
                      runningHere
                        ? "停止当前任务，确认收尾后发送新消息"
                        : "Enter 发送 · Shift + Enter 换行"
                    }
                  >
                    <Send />
                    {replacingHere
                      ? "正在打断…"
                      : sendingHere
                        ? "正在发送…"
                        : runningHere
                          ? "打断并发送"
                          : "发送"}
                  </button>
                </div>
              </form>
              <AgentUsageFooter usage={snapshot?.usage} />
            </div>
          </>
        )}
      </main>
      {sessionId && previewSession === sessionId && previewPath !== null && (
        <AgentPaneResizeHandle {...paneLayout.previewHandleProps} />
      )}
      {sessionId && previewSession === sessionId && previewPath !== null && (
        <AgentPreviewPanel
          key={`${sessionId}:${previewPath}`}
          sessionId={sessionId}
          path={previewPath}
          width={paneLayout.previewWidth}
          onClose={() => setPreviewPath(null)}
        />
      )}
      <AgentOperationsPanel
        open={operationsOpen}
        onOpenChange={setOperationsOpen}
        projectPath={workspace?.path}
        catalog={catalog}
        working={working}
        onSession={(session) => {
          if (
            !mounted.current ||
            workspaceRef.current?.path !== session.projectPath
          )
            return;
          setSessions((old) => [
            session,
            ...old.filter((item) => item.id !== session.id),
          ]);
          setSessionId(session.id);
          setRefresh((value) => value + 1);
        }}
        onCompose={(text) => {
          if (key && !readOnlySession) {
            writeDraft(
              key,
              `${draft}${draft && !draft.endsWith("\n") ? "\n" : ""}${text}\n`,
            );
            return;
          }
          if (!workspace || mutation.current) return;
          const target = workspace.path;
          const requestGeneration = generation.current;
          mutation.current = true;
          setBusy("create");
          void agentApi
            .createSession(
              modelId || catalog.defaultModel || catalog.models[0]?.id || "",
              "build",
              undefined,
              "ask",
            )
            .then((session) => {
              if (
                !mounted.current ||
                generation.current !== requestGeneration ||
                workspaceRef.current?.path !== target
              )
                return;
              setSessions((old) => [
                session,
                ...old.filter((item) => item.id !== session.id),
              ]);
              setSessionId(session.id);
              writeDraft(draftKey(target, session.id), `${text}\n`);
            })
            .catch((cause) => {
              if (mounted.current) setError(agentErrorMessage(cause));
            })
            .finally(() => {
              mutation.current = false;
              if (mounted.current) setBusy(null);
            });
        }}
      />
      <AgentExtensionsPanel
        open={extensionsOpen}
        onOpenChange={setExtensionsOpen}
        working={working}
        projectOpen={Boolean(workspace)}
        onReload={async () => {
          await refreshCatalog(true);
        }}
        onUseSkill={
          key && !readOnlySession
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
              在项目内改动文件、执行命令和运行工具，项目外访问仍需确认。
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
