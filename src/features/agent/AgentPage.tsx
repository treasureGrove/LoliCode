import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { MotionSurface } from "@/components/motion/MotionSurface";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  MessageSquarePlus,
  ArrowUp,
  ArrowDown,
  ArrowUpRight,
  Bug,
  Code2,
  Compass,
  LoaderCircle,
  Sparkles,
  X,
  Square,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  PanelRightOpen,
  PanelRightClose,
  ChevronDown,
  ChevronRight,
  Brain,
  Archive,
  Pin,
  Plus,
  FileText,
  MoreHorizontal,
  BookOpen,
  UsersRound,
  MessageSquare,
  ShieldAlert,
  Lightbulb,
  ScrollText,
  RefreshCw,
  Info,
  ListPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  FullScreenPanelHostContext,
  FullScreenPanelNavigationContext,
} from "@/components/common/FullScreenPanel";
import { settingsApi } from "@/lib/api";
import { APP_NAME, APP_UPDATES_ENABLED } from "@/lib/branding";
import { BuildChannelBadge } from "@/app/shell/BuildChannelBadge";
import { DevelopmentFrontendRefreshMenuItem } from "@/app/shell/DevelopmentFrontendRefreshButton";
import { IS_DEVELOPMENT_BUILD } from "@/lib/buildChannel";
import { agentApi } from "@/lib/api/agent";
import {
  readAgentDocumentAttachments,
  readAgentImageAttachments,
  saveAgentDocumentAttachments,
  saveAgentImageAttachments,
} from "@/lib/agentImageStore";
import { toast } from "@/lib/toast";
import {
  clearAgentQueueSubmission,
  readAgentQueueSubmission,
  saveAgentQueueSubmission,
  type AgentQueueSubmission,
} from "@/lib/agentQueueLedger";
import {
  readAgentQueueRecall,
  saveAgentQueueRecall,
  clearAgentQueueRecall,
} from "@/lib/agentQueueRecall";
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
  isAgentDraftCurrent,
  restoreAgentDraft,
  saveAgentDraft,
  saveAgentSubmission,
  updateAgentSubmission,
  type AgentSubmission,
  type AgentDraftToken,
} from "@/lib/agentInputLedger";
import { agentErrorMessage, useAgentSnapshot } from "@/hooks/useAgentSnapshot";
import { useLolicodeAccount } from "@/hooks/useLolicodeAccount";
import assistantPortrait from "@/assets/brand/lolicode-icon.png";
import {
  AgentReplacementAborted,
  stopAgentBeforeReplacement,
} from "@/lib/agentInterruptSend";
import type {
  AgentCatalog,
  AgentDocumentAttachment,
  AgentEngineStatus,
  AgentImageAttachment,
  AgentPermissionMode,
  AgentProject,
  AgentProjectResult,
  AgentSession,
  AgentSnapshot,
  AgentWorkspace,
} from "@/types/agent";
import { AgentTranscript } from "./AgentTranscript";
import { AgentMessageQueue } from "./AgentMessageQueue";
import { AgentRunError } from "./AgentRunError";
import { AgentChanges } from "./AgentChanges";
import { AgentPermissionCard } from "./AgentPermissionCard";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { AgentActivityStatus } from "./AgentActivityStatus";
import { AgentModelPicker } from "./AgentModelPicker";
import { AgentReasoningPicker } from "./AgentReasoningPicker";
import { AgentContextPicker } from "./AgentContextPicker";
import { AgentComposerAdd, AgentComposerOptions } from "./AgentComposerOptions";
import { AgentFileActionsContext } from "./AgentFilePath";
import { AgentPreviewPanel } from "./AgentPreviewPanel";
import { AgentUsagePopover } from "./AgentUsagePopover";
import { AgentPaneResizeHandle, useAgentPaneLayout } from "./AgentPaneLayout";
import { useAgentAutoSizeTextarea } from "./useAgentAutoSizeTextarea";
import { WindowControlsContext } from "@/app/shell/AppPageHeader";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE } from "@/lib/platform";
import "./lolicode-workbench.css";
import { AgentSessionMenu } from "./AgentSessionMenu";
import { AgentProjectMenu } from "./AgentProjectMenu";
import { AgentSessionSyncButton } from "./AgentSessionSyncButton";
import { AgentSecretaryTasks } from "./AgentSecretaryTasks";
import { AgentAttachmentImage } from "./AgentAttachmentImage";
import { AgentExtensionsPanel } from "./AgentExtensionsPanel";
import { AgentMemoryPanel } from "./AgentMemoryPanel";
import { AgentOperationsPanel } from "./AgentOperationsPanel";
import {
  AgentToolPanel,
  type AgentTool,
  type AgentToolTab,
} from "./AgentToolPanel";
import { AgentToolDraftsContext } from "./AgentToolDrafts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const RECENT_KEY = "lolicode.agent.recent-projects";
const WORKSPACE_ORDER_KEY = "lolicode.agent.workspace-order.v1";
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
type AgentRetryInput = {
  requestId: string;
  text: string;
  images: AgentImageAttachment[];
  documents: AgentDocumentAttachment[];
};
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_COMPOSER_IMAGES = 4;
const MAX_COMPOSER_IMAGE_BYTES = 10 * 1024 * 1024;
const DOCUMENT_MIME_BY_EXTENSION: Record<string, string> = {
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  docm: "application/vnd.ms-word.document.macroEnabled.12",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  json: "application/json",
};
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_COMPOSER_DOCUMENTS = 4;
const MAX_COMPOSER_DOCUMENT_BYTES = 40 * 1024 * 1024;
async function sendSecretaryWorkerMessage(
  session: AgentSession,
  text: string,
  requestId: string,
  images: AgentImageAttachment[],
  documents: AgentDocumentAttachment[],
) {
  const link = session.coordination;
  if (link?.role !== "worker" || !link.parentSessionId || !link.taskId)
    throw new Error("工作任务关联缺失，请返回秘书重新打开。");
  const task = await agentApi.sendSecretaryTaskMessage(
    link.parentSessionId,
    link.taskId,
    text,
    requestId,
    images,
    documents,
  );
  if (
    task.sessionId !== session.id ||
    task.parentSessionId !== link.parentSessionId ||
    task.id !== link.taskId
  )
    throw new Error("返回的工作任务与当前对话不一致，输入已保留，请重新读取。");
}
const documentMimeOf = (file: File) => {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension ? DOCUMENT_MIME_BY_EXTENSION[extension] : undefined;
};
const readFileBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};
const readImageDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("无法读取图片"));
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(file);
  });

function WelcomeMark({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`wb-welcome-mark${compact ? " wb-welcome-mark-compact" : ""}`}
      aria-hidden="true"
    >
      <img src={assistantPortrait} alt="" draggable={false} />
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
const preserveWorkspaceOrder = (items: AgentProject[]): AgentProject[] => {
  let savedOrder: string[] = [];
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(WORKSPACE_ORDER_KEY) || "[]",
    );
    if (Array.isArray(saved))
      savedOrder = saved.filter(
        (path): path is string => typeof path === "string",
      );
  } catch {}

  const paths = new Set(items.map((item) => item.path));
  const order = savedOrder.filter((path) => paths.has(path));
  for (const item of items)
    if (!order.includes(item.path)) order.push(item.path);
  try {
    localStorage.setItem(WORKSPACE_ORDER_KEY, JSON.stringify(order));
  } catch {}

  const rank = new Map<string, number>(
    order.map((path, index) => [path, index]),
  );
  return [...items].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER),
  );
};
const activeStatus = (status?: string) =>
  Boolean(status && status !== "idle" && status !== "error");

export interface AgentSecretaryRequest {
  requestId: number;
  projectPath?: string;
  sessionId?: string;
  workerSessionId?: string;
}

export interface AgentPageProps {
  renderSidebar?: (content: {
    actions: ReactNode;
    workspace: ReactNode;
    onCollapse: () => void;
  }) => ReactNode;
  toolRequest?: {
    tool: AgentTool | null;
    id: number;
    initialTab?: AgentToolTab;
  };
  onWorkspaceNavigate?: (action: () => void) => void;
  onToolRequestConsumed?: () => void;
  onActiveToolChange?: (tool: AgentTool | null) => void;
  onOpenChannels?: () => void;
  onOpenAbout?: () => void;
  onCheckUpdate?: () => void;
  onBusyChange?: (busy: boolean) => void;
  initialProjectPath?: string;
  onInitialProjectConsumed?: () => void;
  secretaryRequest?: AgentSecretaryRequest;
  onSecretaryRequestConsumed?: () => void;
}

const LoliCodeRepository = "https://github.com/treasureGrove/LoliCode";

function AgentHelpMenu({
  onOpenAbout,
  onCheckUpdate,
}: {
  onOpenAbout?: () => void;
  onCheckUpdate?: () => void;
}) {
  const openExternal = (url: string) => {
    void settingsApi.openExternal(url).catch((error) => {
      toast.error(agentErrorMessage(error));
    });
  };
  const openLogs = () => {
    void settingsApi.revealAppLogFile().catch((error) => {
      toast.error(agentErrorMessage(error));
    });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="wb-icon-button wb-titlebar-more"
          aria-label="对话更多选项"
          title="更多"
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="wb-conversation-menu w-56"
      >
        {IS_DEVELOPMENT_BUILD && (
          <>
            <DropdownMenuLabel className="wb-titlebar-build-menu">
              <BuildChannelBadge developmentOnly compact showRefresh={false} />
            </DropdownMenuLabel>
            <DevelopmentFrontendRefreshMenuItem />
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          onSelect={() =>
            openExternal("https://tools.treasuregrove.art/lolicode/")
          }
        >
          <BookOpen aria-hidden="true" /> 产品文档
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => openExternal(`${LoliCodeRepository}/discussions`)}
        >
          <UsersRound aria-hidden="true" /> 用户社群
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            openExternal(`${LoliCodeRepository}/issues/new/choose`)
          }
        >
          <MessageSquare aria-hidden="true" /> 问题上报
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            openExternal(`${LoliCodeRepository}/security/advisories/new`)
          }
        >
          <ShieldAlert aria-hidden="true" /> 报告安全漏洞
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            openExternal(
              `${LoliCodeRepository}/issues/new?template=feature_request.yml`,
            )
          }
        >
          <Lightbulb aria-hidden="true" /> 提出产品需求
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={openLogs}>
          <ScrollText aria-hidden="true" /> 查看应用日志
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onCheckUpdate}
          disabled={!APP_UPDATES_ENABLED}
        >
          <RefreshCw aria-hidden="true" /> 检查更新
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenAbout}>
          <Info aria-hidden="true" /> 关于 {APP_NAME}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AgentPage({
  renderSidebar,
  onWorkspaceNavigate,
  toolRequest,
  onToolRequestConsumed,
  onActiveToolChange,
  onOpenChannels,
  onOpenAbout,
  onCheckUpdate,
  onBusyChange,
  initialProjectPath,
  onInitialProjectConsumed,
  secretaryRequest,
  onSecretaryRequestConsumed,
}: AgentPageProps) {
  const { t } = useTranslation();
  const windowControls = useContext(WindowControlsContext);
  const { account } = useLolicodeAccount();
  const secretaryRequestRef = useRef(secretaryRequest);
  secretaryRequestRef.current = secretaryRequest;
  const consumedSecretaryRequest = useRef<number | null>(null);
  const openingSecretaryRequest = useRef<number | null>(null);
  const [secretaryRequestRevision, setSecretaryRequestRevision] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const [activeTool, setActiveTool] = useState<AgentTool | null>(null);
  const toolDrafts = useRef(new Map<string, unknown>());
  const focusComposerOnReturn = useRef(false);
  const extensionsOpen = activeTool === "skills";
  const operationsOpen = activeTool === "workflows";
  const setExtensionsOpen = (open: boolean) =>
    setActiveTool((current) =>
      open ? "skills" : current === "skills" ? null : current,
    );
  const setOperationsOpen = (open: boolean) =>
    setActiveTool((current) =>
      open ? "workflows" : current === "workflows" ? null : current,
    );
  const [extensionsInitialTab, setExtensionsInitialTab] = useState<
    "skills" | "plugins" | "mcp"
  >("skills");
  const [operationsTab, setOperationsTab] = useState<
    "workflows" | "automation" | "remote"
  >("workflows");
  useEffect(() => {
    if (!toolRequest) return;
    setActiveTool(toolRequest.tool);
    if (toolRequest.tool === "skills") {
      setExtensionsInitialTab(
        toolRequest.initialTab === "plugins" ? "plugins" : "skills",
      );
    } else if (toolRequest.tool === "workflows") {
      setOperationsTab(
        toolRequest.initialTab === "automation" ? "automation" : "workflows",
      );
    }
    onToolRequestConsumed?.();
  }, [toolRequest]);
  useEffect(() => {
    onActiveToolChange?.(activeTool);
  }, [activeTool, onActiveToolChange]);
  const [showArchived, setShowArchived] = useState(false);
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [permissionMode, setPermissionMode] =
    useState<AgentPermissionMode>("full_access");
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
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [contextLimit, setContextLimit] = useState<number | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewSession, setPreviewSession] = useState<string | null>(null);
  const previewVisible =
    Boolean(sessionId) && previewSession === sessionId && previewPath !== null;
  const openPreview = useCallback(
    (path: string) => {
      setPreviewSession(sessionId);
      setPreviewPath(path);
    },
    [sessionId],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [retryLoading, setRetryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState(readRecent);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<
    Record<string, boolean>
  >({});
  const [workspaceSessions, setWorkspaceSessions] = useState<
    Record<string, AgentSession[]>
  >({});
  const [loadingWorkspaceSessions, setLoadingWorkspaceSessions] = useState<
    Record<string, boolean>
  >({});
  const [workspaceSessionErrors, setWorkspaceSessionErrors] = useState<
    Record<string, boolean>
  >({});
  const workspaceSessionLoads = useRef(new Map<string, object>());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [automationKickoff, setAutomationKickoff] = useState<{
    sessionId: string;
    projectPath: string;
    draft: AgentDraftToken;
  } | null>(null);
  const [composerImagesBySession, setComposerImagesBySession] = useState<
    Record<string, AgentImageAttachment[]>
  >({});
  const [composerDocumentsBySession, setComposerDocumentsBySession] = useState<
    Record<string, AgentDocumentAttachment[]>
  >({});
  const [sentImageAttachments, setSentImageAttachments] = useState<
    Record<string, AgentImageAttachment[]>
  >({});
  const [sentDocumentAttachments, setSentDocumentAttachments] = useState<
    Record<string, AgentDocumentAttachment[]>
  >({});
  const [pending, setPending] = useState<Record<string, PendingSend>>({});
  const [queueBusyId, setQueueBusyId] = useState<string | null>(null);
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
  const composerImagesRef = useRef(composerImagesBySession);
  composerImagesRef.current = composerImagesBySession;
  const composerDocumentsRef = useRef(composerDocumentsBySession);
  composerDocumentsRef.current = composerDocumentsBySession;
  const stoppingRef = useRef(stopping);
  stoppingRef.current = stopping;
  const statusRef = useRef(statuses);
  statusRef.current = statuses;
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (activeTool) {
      focusComposerOnReturn.current = false;
      return;
    }
    if (!focusComposerOnReturn.current) return;
    let frame = 0;
    const focusDeadline = performance.now() + 1000;
    const restoreComposerFocus = () => {
      const input = composerInputRef.current;
      let parent: HTMLElement | null = input;
      while (parent && !parent.inert) parent = parent.parentElement;
      // Wait for the exit transition, independent of the display's refresh rate.
      if (parent && performance.now() < focusDeadline) {
        frame = requestAnimationFrame(restoreComposerFocus);
        return;
      }
      focusComposerOnReturn.current = false;
      if (!parent) input?.focus();
    };
    frame = requestAnimationFrame(restoreComposerFocus);
    return () => cancelAnimationFrame(frame);
  }, [activeTool]);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const nativeDropSupport = useRef(false);
  const addLocalDocumentsRef = useRef<(paths: string[]) => Promise<void>>(
    async () => {},
  );
  const imageLoadAttempts = useRef(new Set<string>());
  const documentLoadAttempts = useRef(new Set<string>());
  const pendingImageRestoreAttempts = useRef(new Set<string>());
  const pendingDocumentRestoreAttempts = useRef(new Set<string>());
  const queueAttachmentRestoreAttempts = useRef(new Set<string>());
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
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
      setProjects(preserveWorkspaceOrder(knownProjects));
      if (status.running && status.projectPath) {
        const [nextCatalog, nextSessions] = await Promise.all([
          agentApi.getCatalog(),
          agentApi.listSessions(),
        ]);
        if (!mounted.current || generation.current !== requestGeneration)
          return;
        const selectedProject = knownProjects.find(
          (project) => project.path === status.projectPath,
        );
        setWorkspace({
          path: status.projectPath,
          name: selectedProject?.name || nameOf(status.projectPath),
          standalone: selectedProject?.standalone,
        });
        bindCatalog(nextCatalog);
        setSessions(nextSessions);
        discoverSessionActivity(nextSessions);
        setPending(restorePending(status.projectPath, nextSessions));
        setStopping(restoreStopping(status.projectPath, nextSessions));
        setSessionId(
          nextSessions.find((item) => item.coordination?.role !== "worker")
            ?.id || null,
        );
        if (!selectedProject?.standalone) rememberProject(status.projectPath);
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

  const acceptQueuedDraft = useCallback((entry: AgentQueueSubmission) => {
    clearAgentQueueSubmission(
      entry.projectPath,
      entry.sessionId,
      entry.requestId,
    );
    const cleared = clearSubmittedAgentDraft(entry.draft);
    if (!mounted.current) return;
    if (cleared)
      setDrafts((old) =>
        old[entry.draft.key] !== undefined &&
        old[entry.draft.key] !== entry.draft.text
          ? old
          : { ...old, [entry.draft.key]: "" },
      );
    const images = { ...composerImagesRef.current };
    images[entry.sessionId] = (images[entry.sessionId] || []).filter(
      (image) => !entry.imageIds.includes(image.id),
    );
    composerImagesRef.current = images;
    setComposerImagesBySession(images);
    const documents = { ...composerDocumentsRef.current };
    documents[entry.sessionId] = (documents[entry.sessionId] || []).filter(
      (document) => !entry.documentIds.includes(document.id),
    );
    composerDocumentsRef.current = documents;
    setComposerDocumentsBySession(documents);
  }, []);
  const onSnapshot = useCallback(
    (next: AgentSnapshot) => {
      if (!mounted.current) return;
      const id = next.session.id;
      if (removedSessions.current.has(id)) return;
      const queueEntry = readAgentQueueSubmission(next.session.projectPath, id);
      if (
        queueEntry &&
        (next.queuedMessages?.some(
          (item) => item.id === queueEntry.requestId,
        ) ||
          next.messages.some(
            (message) =>
              message.role === "user" && message.id === queueEntry.requestId,
          ))
      ) {
        try {
          acceptQueuedDraft(queueEntry);
        } catch (cause) {
          if (selectedId.current === id) setError(agentErrorMessage(cause));
        }
      }
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
              if (
                receipt.status === "rejected" ||
                receipt.status === "failed"
              ) {
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
        updateAgentSubmission(
          next.session.projectPath,
          id,
          submitted.requestId,
          {
            observed: true,
          },
        );
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
      // A fast local failure can finish before polling observes a running actor
      // or an assistant message. Only settle the exact latest acknowledged turn.
      const acknowledgedFailure =
        acknowledged &&
        nextUser < 0 &&
        next.status === "error" &&
        Boolean(next.error?.trim());
      const received =
        acknowledged &&
        ((next.status !== "idle" && next.status !== "error") ||
          hasReply ||
          acknowledgedFailure);
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
            (submitted.phase === "accepted" ||
              submitted.observed ||
              acknowledged)
          : stoppingRef.current[id]) &&
        (next.status === "idle" || next.status === "error") &&
        !agentStopInFlight(id) &&
        (!submitted || !agentSubmissionInFlight(submitted.requestId))
      ) {
        storePending(next.session.projectPath, id);
        if (submitted)
          clearAgentSubmission(
            next.session.projectPath,
            id,
            submitted.requestId,
          );
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
    },
    [acceptQueuedDraft],
  );
  const {
    snapshot,
    error: snapshotError,
    loading: snapshotLoading,
  } = useAgentSnapshot(sessionId, {
    fast: Boolean(sessionId && (pending[sessionId] || stopping[sessionId])),
    refresh,
    onSnapshot,
  });
  const documentViewsSeen = useRef<{
    session: string | null;
    initialized: boolean;
    ids: Set<string>;
  }>({ session: null, initialized: false, ids: new Set() });
  useEffect(() => {
    if (!sessionId || snapshot?.session.id !== sessionId) return;
    const previous = documentViewsSeen.current;
    const sameSession = previous.session === sessionId;
    const seen = sameSession ? previous.ids : new Set<string>();
    let reveal: string | null = null;
    for (const message of snapshot.messages) {
      for (const part of message.parts) {
        if (
          part.type !== "tool" ||
          part.state !== "completed" ||
          !["open_document", "show_in_viewer"].includes(part.name)
        )
          continue;
        if (seen.has(part.id)) continue;
        seen.add(part.id);
        if (!sameSession || !previous.initialized) continue;
        if (!part.input || typeof part.input !== "object") continue;
        const input = part.input as Record<string, unknown>;
        if (typeof input.path !== "string") continue;
        reveal =
          input.path +
          (typeof input.locator === "string"
            ? `#${encodeURIComponent(input.locator)}`
            : "");
      }
    }
    documentViewsSeen.current = {
      session: sessionId,
      initialized: true,
      ids: seen,
    };
    if (reveal) openPreview(reveal);
  }, [sessionId, snapshot, openPreview]);
  useEffect(() => {
    for (const message of snapshot?.messages || []) {
      if (message.role !== "user") continue;
      if (
        !sentImageAttachments[message.id] &&
        !imageLoadAttempts.current.has(message.id)
      ) {
        imageLoadAttempts.current.add(message.id);
        void readAgentImageAttachments(message.id)
          .then((images) => {
            if (mounted.current && images?.length)
              setSentImageAttachments((old) => ({
                ...old,
                [message.id]: images,
              }));
          })
          .catch(() => {});
      }
      if (
        !sentDocumentAttachments[message.id] &&
        !documentLoadAttempts.current.has(message.id)
      ) {
        documentLoadAttempts.current.add(message.id);
        void readAgentDocumentAttachments(message.id)
          .then((documents) => {
            if (mounted.current && documents?.length)
              setSentDocumentAttachments((old) => ({
                ...old,
                [message.id]: documents,
              }));
          })
          .catch(() => {});
      }
    }
  }, [sentDocumentAttachments, sentImageAttachments, snapshot?.messages]);
  useEffect(() => {
    const id = sessionId;
    const unresolved = id ? pending[id] : undefined;
    const restoreKey = unresolved ? `${id}:${unresolved.requestId}` : "";
    if (
      !id ||
      !unresolved?.uncertain ||
      pendingImageRestoreAttempts.current.has(restoreKey)
    )
      return;
    pendingImageRestoreAttempts.current.add(restoreKey);
    void readAgentImageAttachments(unresolved.requestId)
      .then((images) => {
        if (!mounted.current || selectedId.current !== id || !images?.length)
          return;
        if (composerImagesRef.current[id]?.length) return;
        const next = {
          ...composerImagesRef.current,
          [id]: images,
        };
        composerImagesRef.current = next;
        setComposerImagesBySession(next);
      })
      .catch(() => {});
  }, [pending, sessionId]);
  useEffect(() => {
    const id = sessionId;
    const unresolved = id ? pending[id] : undefined;
    const restoreKey = unresolved ? `${id}:${unresolved.requestId}` : "";
    if (
      !id ||
      !unresolved?.uncertain ||
      pendingDocumentRestoreAttempts.current.has(restoreKey)
    )
      return;
    pendingDocumentRestoreAttempts.current.add(restoreKey);
    void readAgentDocumentAttachments(unresolved.requestId)
      .then((documents) => {
        if (!mounted.current || selectedId.current !== id || !documents?.length)
          return;
        if (composerDocumentsRef.current[id]?.length) return;
        const next = {
          ...composerDocumentsRef.current,
          [id]: documents,
        };
        composerDocumentsRef.current = next;
        setComposerDocumentsBySession(next);
      })
      .catch(() => {});
  }, [pending, sessionId]);

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
    if (scroll && atBottom.current)
      scroll.scrollTop = snapshot?.messages.length ? scroll.scrollHeight : 0;
  }, [snapshot]);
  useEffect(() => {
    atBottom.current = true;
    setShowScrollToBottom(false);
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
  const isSecretaryWorker = selectedSession?.coordination?.role === "worker";
  const configurationReadOnly = readOnlySession || isSecretaryWorker;
  const isSecretary = selectedSession?.coordination?.role === "secretary";
  const secretarySessionId = isSecretary
    ? selectedSession?.id
    : selectedSession?.coordination?.role === "worker"
      ? selectedSession.coordination.parentSessionId
      : undefined;
  const boundModel = catalog.models.find(
    (model) =>
      model.providerId === selectedSession?.model?.providerId &&
      model.modelId === selectedSession?.model?.modelId,
  );
  const displayedModel = boundModel;
  const displayedModelId = boundModel?.id || "";
  const displayedReasoningEffort = selectedSession?.reasoningEffort || "";
  const key = workspace && sessionId ? draftKey(workspace.path, sessionId) : "";
  const queueRecovery =
    workspace && sessionId
      ? readAgentQueueSubmission(workspace.path, sessionId)
      : null;
  const queueRecall =
    workspace && sessionId
      ? readAgentQueueRecall(workspace.path, sessionId)
      : null;
  const draft = key ? (drafts[key] ?? readDraft(key) ?? "") : "";
  useEffect(() => {
    if (!queueRecovery) return;
    if (restoreAgentDraft(queueRecovery.draft))
      setDrafts((old) => ({
        ...old,
        [queueRecovery.draft.key]: queueRecovery.draft.text,
      }));
    const { requestId, sessionId: id } = queueRecovery;
    if (queueAttachmentRestoreAttempts.current.has(requestId)) return;
    queueAttachmentRestoreAttempts.current.add(requestId);
    void Promise.all([
      readAgentImageAttachments(requestId),
      readAgentDocumentAttachments(requestId),
    ])
      .then(([images, documents]) => {
        if (
          !mounted.current ||
          readAgentQueueSubmission(queueRecovery.projectPath, id)?.requestId !==
            requestId
        )
          return;
        if (images?.length && !composerImagesRef.current[id]?.length) {
          composerImagesRef.current = {
            ...composerImagesRef.current,
            [id]: images,
          };
          setComposerImagesBySession(composerImagesRef.current);
        }
        if (documents?.length && !composerDocumentsRef.current[id]?.length) {
          composerDocumentsRef.current = {
            ...composerDocumentsRef.current,
            [id]: documents,
          };
          setComposerDocumentsBySession(composerDocumentsRef.current);
        }
      })
      .catch(() => {});
  }, [queueRecovery?.requestId, sessionId]);
  const composerImages = sessionId
    ? composerImagesBySession[sessionId] || []
    : [];
  const composerDocuments = sessionId
    ? composerDocumentsBySession[sessionId] || []
    : [];
  const textareaRef = useAgentAutoSizeTextarea(draft);
  const composerRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      composerInputRef.current = node;
      textareaRef(node);
    },
    [textareaRef],
  );
  const paneLayout = useAgentPaneLayout({
    sidebarVisible: !sidebarCollapsed,
    previewVisible,
  });
  const lastSidebarWidth = useRef(paneLayout.sidebarWidth || 252);
  if (paneLayout.sidebarVisible)
    lastSidebarWidth.current = paneLayout.sidebarWidth;
  const writeDraft = (storageKey: string, value: string) => {
    setDrafts((old) => ({ ...old, [storageKey]: value }));
    saveAgentDraft(storageKey, value);
  };
  const insertStarter = (text: string) => {
    if (!key || readOnlySession) return;
    writeDraft(key, draft.trim() ? `${draft}\n\n${text}` : text);
    composerInputRef.current?.focus();
  };
  const addComposerImages = async (files: File[]) => {
    const id = sessionId;
    if (!id || readOnlySession || pending[id]?.uncertain || !files.length)
      return;
    const current = composerImagesRef.current[id] || [];
    let totalBytes = current.reduce((sum, image) => sum + image.bytes, 0);
    const additions: AgentImageAttachment[] = [];
    for (const file of files) {
      const mime = file.type.toLowerCase().split(";", 1)[0];
      if (!IMAGE_MIME_TYPES.has(mime)) {
        toast.error("仅支持 PNG、JPEG、WebP、GIF、BMP 和 AVIF 图片。");
        continue;
      }
      if (!file.size || file.size > MAX_IMAGE_BYTES) {
        toast.error("单张图片不能超过 5 MB。");
        continue;
      }
      if (
        current.length + additions.length >= MAX_COMPOSER_IMAGES ||
        totalBytes + file.size > MAX_COMPOSER_IMAGE_BYTES
      ) {
        toast.error("最多添加 4 张图片，图片总大小不能超过 10 MB。");
        break;
      }
      try {
        const dataUrl = await readImageDataUrl(file);
        additions.push({
          id: crypto.randomUUID(),
          fileName:
            file.name ||
            `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
          mime,
          bytes: file.size,
          dataUrl,
        });
        totalBytes += file.size;
      } catch (cause) {
        toast.error(agentErrorMessage(cause));
      }
    }
    if (!additions.length) return;
    const next = {
      ...composerImagesRef.current,
      [id]: [...(composerImagesRef.current[id] || []), ...additions],
    };
    composerImagesRef.current = next;
    setComposerImagesBySession(next);
  };
  const addComposerDocuments = async (files: File[]) => {
    const id = sessionId;
    if (!id || readOnlySession || pending[id]?.uncertain || !files.length)
      return;
    const current = composerDocumentsRef.current[id] || [];
    let totalBytes = current.reduce((sum, document) => sum + document.bytes, 0);
    const additions: AgentDocumentAttachment[] = [];
    for (const file of files) {
      const mime = documentMimeOf(file);
      if (!mime) {
        toast.error("支持 PDF、Word、PowerPoint、Excel 和常见文本文件。");
        continue;
      }
      if (!file.size || file.size > MAX_DOCUMENT_BYTES) {
        toast.error("单个文档不能超过 20 MB。");
        continue;
      }
      if (
        current.length + additions.length >= MAX_COMPOSER_DOCUMENTS ||
        totalBytes + file.size > MAX_COMPOSER_DOCUMENT_BYTES
      ) {
        toast.error("最多添加 4 个文档，文档总大小不能超过 40 MB。");
        break;
      }
      try {
        additions.push({
          id: crypto.randomUUID(),
          fileName: file.name,
          mime,
          bytes: file.size,
          dataBase64: await readFileBase64(file),
        });
        totalBytes += file.size;
      } catch (cause) {
        toast.error(agentErrorMessage(cause));
      }
    }
    if (!additions.length) return;
    const next = {
      ...composerDocumentsRef.current,
      [id]: [...(composerDocumentsRef.current[id] || []), ...additions],
    };
    composerDocumentsRef.current = next;
    setComposerDocumentsBySession(next);
  };
  const addComposerFiles = async (files: File[]) => {
    const images = files.filter((file) =>
      file.type.toLowerCase().startsWith("image/"),
    );
    const documents = files.filter(
      (file) => !file.type.toLowerCase().startsWith("image/"),
    );
    if (images.length) await addComposerImages(images);
    if (documents.length) await addComposerDocuments(documents);
  };
  const addComposerLocalDocuments = async (paths: string[]) => {
    const id = sessionId;
    if (!id || readOnlySession || pending[id]?.uncertain) return;
    const current = composerDocumentsRef.current[id] || [];
    const additions: AgentDocumentAttachment[] = [];
    let totalBytes = current.reduce((sum, document) => sum + document.bytes, 0);
    for (const localPath of paths) {
      if (
        current.some((document) => document.localPath === localPath) ||
        additions.some((document) => document.localPath === localPath)
      )
        continue;
      if (current.length + additions.length >= MAX_COMPOSER_DOCUMENTS) {
        toast.error("最多添加 4 个文档。");
        break;
      }
      try {
        const info = await agentApi.inspectDocument(localPath);
        if (totalBytes + info.bytes > MAX_COMPOSER_DOCUMENT_BYTES) {
          toast.error("文档总大小不能超过 40 MB。");
          break;
        }
        additions.push({
          id: crypto.randomUUID(),
          fileName: info.fileName,
          mime: info.mime,
          bytes: info.bytes,
          localPath,
        });
        totalBytes += info.bytes;
      } catch (cause) {
        toast.error(agentErrorMessage(cause));
      }
    }
    if (!additions.length) return;
    const next = {
      ...composerDocumentsRef.current,
      [id]: [...(composerDocumentsRef.current[id] || []), ...additions],
    };
    composerDocumentsRef.current = next;
    setComposerDocumentsBySession(next);
  };
  const chooseComposerDocuments = async () => {
    try {
      const selected = await openFileDialog({
        title: "添加文档",
        multiple: true,
        directory: false,
        filters: [
          {
            name: "文档",
            extensions: Object.keys(DOCUMENT_MIME_BY_EXTENSION),
          },
        ],
      });
      if (selected)
        await addComposerLocalDocuments(
          Array.isArray(selected) ? selected : [selected],
        );
    } catch (cause) {
      toast.error(agentErrorMessage(cause));
    }
  };
  addLocalDocumentsRef.current = addComposerLocalDocuments;
  useEffect(() => {
    if (
      !(window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__
    )
      return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    void appWindow
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const form = composerFormRef.current;
        if (!form) return;
        const scale = await appWindow
          .scaleFactor()
          .catch(() => window.devicePixelRatio || 1);
        if (!active) return;
        const bounds = form.getBoundingClientRect();
        const x = event.payload.position.x / scale;
        const y = event.payload.position.y / scale;
        if (
          x < bounds.left ||
          x > bounds.right ||
          y < bounds.top ||
          y > bounds.bottom
        )
          return;
        const paths = event.payload.paths.filter((path) =>
          Boolean(
            DOCUMENT_MIME_BY_EXTENSION[
              path.split(".").pop()?.toLowerCase() || ""
            ],
          ),
        );
        void addLocalDocumentsRef.current(paths);
      })
      .then((stop) => {
        if (!active) stop();
        else {
          unlisten = stop;
          nativeDropSupport.current = true;
        }
      })
      .catch(() => {
        nativeDropSupport.current = false;
      });
    return () => {
      active = false;
      nativeDropSupport.current = false;
      unlisten?.();
    };
  }, []);
  const removeComposerImage = (imageId: string) => {
    if (!sessionId || pending[sessionId]?.uncertain) return;
    const next = { ...composerImagesRef.current };
    const remaining = (next[sessionId] || []).filter(
      (image) => image.id !== imageId,
    );
    if (remaining.length) next[sessionId] = remaining;
    else delete next[sessionId];
    composerImagesRef.current = next;
    setComposerImagesBySession(next);
  };
  const removeComposerDocument = (documentId: string) => {
    if (!sessionId || pending[sessionId]?.uncertain) return;
    const next = { ...composerDocumentsRef.current };
    const remaining = (next[sessionId] || []).filter(
      (document) => document.id !== documentId,
    );
    if (remaining.length) next[sessionId] = remaining;
    else delete next[sessionId];
    composerDocumentsRef.current = next;
    setComposerDocumentsBySession(next);
  };
  const clearSentComposerImages = (
    id: string,
    images: AgentImageAttachment[],
  ) => {
    if (!images.length) return;
    const next = { ...composerImagesRef.current };
    const remaining = (next[id] || []).filter(
      (image) => !images.some((sent) => sent.id === image.id),
    );
    if (remaining.length) next[id] = remaining;
    else delete next[id];
    composerImagesRef.current = next;
    setComposerImagesBySession(next);
  };
  const clearSentComposerDocuments = (
    id: string,
    documents: AgentDocumentAttachment[],
  ) => {
    if (!documents.length) return;
    const next = { ...composerDocumentsRef.current };
    const remaining = (next[id] || []).filter(
      (document) => !documents.some((sent) => sent.id === document.id),
    );
    if (remaining.length) next[id] = remaining;
    else delete next[id];
    composerDocumentsRef.current = next;
    setComposerDocumentsBySession(next);
  };

  const adoptProject = (
    result: AgentProjectResult,
    preferredSessionId?: string,
  ) => {
    // Expanded inactive projects read this cache instead of the active list.
    // Retain the full task list, independent of the current search or archive view.
    const previousWorkspace = workspaceRef.current;
    const retainedSessions: Record<string, AgentSession[]> = {
      ...(previousWorkspace && previousWorkspace.path !== result.workspace.path
        ? {
            [previousWorkspace.path]: sessionsRef.current.filter(
              (session) => !session.archived,
            ),
          }
        : {}),
      [result.workspace.path]: result.sessions.filter(
        (session) => !session.archived,
      ),
    };
    const retainedPaths = Object.keys(retainedSessions);
    // An older background expansion must not replace these authoritative lists.
    for (const path of retainedPaths)
      workspaceSessionLoads.current.delete(path);
    setWorkspaceSessions((old) => ({ ...old, ...retainedSessions }));
    setLoadingWorkspaceSessions((old) => {
      const next = { ...old };
      for (const path of retainedPaths) delete next[path];
      return next;
    });
    setWorkspaceSessionErrors((old) => {
      const next = { ...old };
      for (const path of retainedPaths) delete next[path];
      return next;
    });
    if (previousWorkspace?.path !== result.workspace.path) {
      setExpandedWorkspaces((old) => ({
        ...old,
        ...(previousWorkspace
          ? { [previousWorkspace.path]: old[previousWorkspace.path] ?? true }
          : {}),
        [result.workspace.path]: old[result.workspace.path] ?? true,
      }));
    }
    setWorkspace(result.workspace);
    bindCatalog(result.catalog);
    setSessions(result.sessions);
    discoverSessionActivity(result.sessions);
    setSessionId(
      result.sessions.find((session) => session.id === preferredSessionId)
        ?.id ||
        result.sessions.find((item) => item.coordination?.role !== "worker")
          ?.id ||
        null,
    );
    setShowArchived(false);
    setPending((old) => ({
      ...old,
      ...restorePending(result.workspace.path, result.sessions),
    }));
    setStopping((old) => ({
      ...old,
      ...restoreStopping(result.workspace.path, result.sessions),
    }));
    if (!result.workspace.standalone) rememberProject(result.workspace.path);
  };
  const openProject = async (path?: string, preferredSessionId?: string) => {
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
      adoptProject(result, preferredSessionId);
      const knownProjects = await agentApi.listProjects();
      if (!mounted.current || generation.current !== requestGeneration) return;
      setProjects(preserveWorkspaceOrder(knownProjects));
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
  const consumedInitialProject = useRef<string | null>(null);
  useEffect(() => {
    if (
      !initialProjectPath ||
      initializing ||
      consumedInitialProject.current === initialProjectPath
    )
      return;
    consumedInitialProject.current = initialProjectPath;
    onInitialProjectConsumed?.();
    void openProject(initialProjectPath);
  }, [initialProjectPath, initializing, onInitialProjectConsumed]);
  const createSession = async (standalone = false) => {
    if (mutation.current || initializing || engine?.available === false) return;
    if (
      !standalone &&
      workspace &&
      !catalog.models.some((model) => model.id === modelId)
    )
      return;
    mutation.current = true;
    setBusy("create");
    setError(null);
    const requestGeneration = generation.current;
    try {
      let target = workspace;
      let targetCatalog = catalog;
      if (standalone || !target) {
        const result = await agentApi.openStandalone();
        if (!mounted.current || generation.current !== requestGeneration)
          return;
        result.warnings?.forEach((warning) => toast.warning(warning));
        adoptProject(result);
        target = result.workspace;
        targetCatalog = result.catalog;
        setEngine((old) => ({
          ...old,
          available: true,
          running: true,
          projectPath: target!.path,
        }));
        const knownProjects = await agentApi.listProjects();
        if (!mounted.current || generation.current !== requestGeneration)
          return;
        setProjects(preserveWorkspaceOrder(knownProjects));
      }
      const selectedModel =
        targetCatalog.models.find((model) => model.id === modelId) ||
        targetCatalog.models.find(
          (model) => model.id === targetCatalog.defaultModel,
        ) ||
        targetCatalog.models[0];
      if (!selectedModel) return;
      const sessionArgs: Parameters<typeof agentApi.createSession> = [
        selectedModel.id,
        "build",
        undefined,
        permissionMode,
        reasoningEffort || undefined,
      ];
      if (target.standalone) sessionArgs[5] = target.path;
      if (contextLimit != null) sessionArgs[6] = contextLimit;
      const session = await agentApi.createSession(...sessionArgs);
      if (!mounted.current || generation.current !== requestGeneration) return;
      setShowArchived(false);
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
  const openSecretary = async (request?: AgentSecretaryRequest) => {
    if (mutation.current || initializing || engine?.available === false) return;
    mutation.current = true;
    setBusy("secretary");
    setError(null);
    let requestGeneration = generation.current;
    const selectionRevision = selection.current.revision;
    const requestCurrent = () =>
      !request || secretaryRequestRef.current?.requestId === request.requestId;
    try {
      let target = workspace;
      let targetCatalog = catalog;
      let requestedSession: AgentSession | undefined;
      let parentSession: AgentSession | undefined;
      const requestedId = request?.workerSessionId || request?.sessionId;
      if (requestedId) {
        requestedSession = (await agentApi.getSession(requestedId)).session;
        if (requestedSession.id !== requestedId)
          throw new Error("返回的会话与指定任务不一致，请重新打开。");
        if (request?.workerSessionId) {
          const link = requestedSession.coordination;
          if (
            link?.role !== "worker" ||
            !link.parentSessionId ||
            !link.taskId ||
            (request.sessionId && link.parentSessionId !== request.sessionId)
          )
            throw new Error("工作对话与指定秘书不一致，请重新打开。");
          parentSession = (await agentApi.getSession(link.parentSessionId))
            .session;
          if (
            parentSession.id !== link.parentSessionId ||
            parentSession.coordination?.role !== "secretary" ||
            parentSession.projectPath !== requestedSession.projectPath
          )
            throw new Error("工作任务的秘书关联已失效，请重新打开。");
        } else if (requestedSession.coordination?.role !== "secretary") {
          throw new Error("指定会话不是秘书，请重新打开。");
        }
      }
      if (!mounted.current || !requestCurrent()) return;
      const requestedPath =
        request?.projectPath || requestedSession?.projectPath;
      if (
        request?.projectPath &&
        requestedSession &&
        request.projectPath !== requestedSession.projectPath
      )
        throw new Error("工作任务与指定工作区不一致，请重新打开。");
      if (requestedPath) {
        requestGeneration = ++generation.current;
        const result = await agentApi.openProject(requestedPath);
        if (
          !mounted.current ||
          generation.current !== requestGeneration ||
          !requestCurrent()
        )
          return;
        if (
          requestedSession &&
          result.workspace.path !== requestedSession.projectPath
        )
          throw new Error("秘书会话与打开的工作区不一致，请重新打开。");
        result.warnings?.forEach((warning) => toast.warning(warning));
        adoptProject(result, requestedId);
        target = result.workspace;
        targetCatalog = result.catalog;
        setEngine((old) => ({
          ...old,
          available: true,
          running: true,
          projectPath: result.workspace.path,
        }));
      }
      if (!target) {
        const result = await agentApi.openStandalone();
        if (
          !mounted.current ||
          generation.current !== requestGeneration ||
          !requestCurrent()
        )
          return;
        result.warnings?.forEach((warning) => toast.warning(warning));
        adoptProject(result);
        target = result.workspace;
        targetCatalog = result.catalog;
        setEngine((old) => ({
          ...old,
          available: true,
          running: true,
          projectPath: target!.path,
        }));
      }
      if (requestedSession) {
        const related = parentSession
          ? [requestedSession, parentSession]
          : [requestedSession];
        setShowArchived(false);
        setSessions((old) => [
          ...related,
          ...old.filter((item) => !related.some((next) => next.id === item.id)),
        ]);
        setActiveTool(null);
        setSessionId(requestedSession.id);
        setRefresh((value) => value + 1);
        return;
      }
      const sourceSession =
        selectedSession?.projectPath === target.path
          ? selectedSession
          : undefined;
      const currentModel = targetCatalog.models.find(
        (model) =>
          model.providerId === sourceSession?.model?.providerId &&
          model.modelId === sourceSession?.model?.modelId,
      );
      const selectedModel =
        currentModel ||
        targetCatalog.models.find((model) => model.id === modelId) ||
        targetCatalog.models.find(
          (model) => model.id === targetCatalog.defaultModel,
        ) ||
        targetCatalog.models[0];
      if (!selectedModel)
        throw new Error(
          t("agentSecretary.noModel", {
            defaultValue: "请先添加可用模型，再打开秘书。",
          }),
        );
      const session = await agentApi.openSecretary(
        selectedModel.id,
        sourceSession?.permissionMode
          ? ["ask", "auto", "full_access"].includes(
              sourceSession.permissionMode,
            )
            ? (sourceSession.permissionMode as AgentPermissionMode)
            : "ask"
          : permissionMode,
        sourceSession
          ? sourceSession.reasoningEffort || undefined
          : reasoningEffort || undefined,
        target.path,
        sourceSession
          ? (sourceSession.contextLimit ?? undefined)
          : (contextLimit ?? undefined),
      );
      if (
        !mounted.current ||
        generation.current !== requestGeneration ||
        !requestCurrent()
      )
        return;
      if (
        !request &&
        workspace &&
        selection.current.revision !== selectionRevision
      )
        return;
      if (
        session.projectPath !== target.path ||
        session.coordination?.role !== "secretary"
      )
        throw new Error(
          t("agentSecretary.openMismatch", {
            defaultValue: "秘书会话与当前工作区不一致，请重新打开。",
          }),
        );
      setShowArchived(false);
      setActiveTool(null);
      setSessions((old) => [
        session,
        ...old.filter((item) => item.id !== session.id),
      ]);
      setSessionId(session.id);
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (
        mounted.current &&
        generation.current === requestGeneration &&
        requestCurrent()
      )
        setError(agentErrorMessage(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  useEffect(() => {
    const request = secretaryRequest;
    if (
      !request ||
      initializing ||
      busy ||
      mutation.current ||
      engine?.available === false ||
      consumedSecretaryRequest.current === request.requestId ||
      openingSecretaryRequest.current !== null
    )
      return;
    openingSecretaryRequest.current = request.requestId;
    void openSecretary(request).finally(() => {
      openingSecretaryRequest.current = null;
      if (!mounted.current) return;
      if (secretaryRequestRef.current?.requestId === request.requestId) {
        consumedSecretaryRequest.current = request.requestId;
        onSecretaryRequestConsumed?.();
      }
      setSecretaryRequestRevision((value) => value + 1);
    });
  }, [
    secretaryRequest?.requestId,
    initializing,
    busy,
    engine?.available,
    secretaryRequestRevision,
  ]);
  const openSecretarySession = async (id: string) => {
    if (mutation.current || !workspace) return;
    const target = workspace.path;
    const requestGeneration = generation.current;
    const selectionRevision = selection.current.revision;
    const next = await agentApi.getSession(id);
    if (
      !mounted.current ||
      generation.current !== requestGeneration ||
      workspaceRef.current?.path !== target ||
      selection.current.revision !== selectionRevision
    )
      return;
    if (next.session.id !== id || next.session.projectPath !== target)
      throw new Error(
        t("agentSecretary.openMismatch", {
          defaultValue: "工作对话与当前工作区不一致，请重新读取。",
        }),
      );
    setShowArchived(false);
    setSessions((old) => [
      next.session,
      ...old.filter((item) => item.id !== id),
    ]);
    setError(null);
    setSessionId(id);
    setRefresh((value) => value + 1);
  };
  const startAutomationConversation = async (text: string) => {
    if (mutation.current || replacement.current || !workspace || initializing)
      throw new Error("请等待当前配置保存后再开始自动化对话。");
    const target = workspace.path;
    if (selectedSession?.model && !boundModel)
      throw new Error(
        "当前会话模型不可用，请先选择可用模型，再开始自动化对话。",
      );
    const model =
      boundModel ||
      catalog.models.find((item) => item.id === catalog.defaultModel) ||
      catalog.models[0];
    if (!model) throw new Error("请先添加一个可用模型，再通过对话构建自动化。");
    const configuredPermission =
      selectedSession?.permissionMode || permissionMode;
    const selectedPermission = ["ask", "auto", "full_access"].includes(
      configuredPermission,
    )
      ? (configuredPermission as AgentPermissionMode)
      : "ask";
    const sourceRevision = selection.current.revision;
    const sourceGeneration = generation.current;
    mutation.current = true;
    setBusy("create");
    setError(null);
    try {
      const created = await agentApi.createSession(
        model.id,
        "build",
        "设计自动化",
        selectedPermission,
        selectedSession?.reasoningEffort || undefined,
        target,
        selectedSession?.contextLimit ?? undefined,
      );
      if (created.projectPath !== target)
        throw new Error("设计会话未绑定到当前项目，尚未发送自动化需求。");
      const token = saveAgentDraft(draftKey(target, created.id), text);
      if (
        !mounted.current ||
        generation.current !== sourceGeneration ||
        selection.current.revision !== sourceRevision ||
        workspaceRef.current?.path !== target
      )
        throw new Error(
          "设计会话与草稿已保留；你已切换位置，请在原项目中继续。",
        );
      setDrafts((old) => ({ ...old, [token.key]: text }));
      setSessions((old) => [
        created,
        ...old.filter((item) => item.id !== created.id),
      ]);
      setShowArchived(false);
      setSessionId(created.id);
      setAutomationKickoff({
        sessionId: created.id,
        projectPath: target,
        draft: token,
      });
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const enqueueDraft = async () => {
    if (
      mutation.current ||
      replacement.current ||
      !sessionId ||
      !workspace ||
      isLegacySession(sessionId) ||
      !snapshot ||
      stoppingRef.current[sessionId] ||
      agentStopInFlight(sessionId)
    )
      return;
    if (pendingRef.current[sessionId]?.uncertain) {
      setError(
        "上次发送的接收状态尚未确认，请先确认或停止该次任务，再加入新的排队消息。",
      );
      return;
    }
    const id = sessionId;
    const projectPath = workspace.path;
    const storageKey = key;
    const text = draft.trim();
    const images = composerImagesRef.current[id] || [];
    const documents = composerDocumentsRef.current[id] || [];
    if (!text && !images.length && !documents.length) return;
    const previous = readAgentQueueSubmission(projectPath, id);
    if (
      previous &&
      (previous.text !== text ||
        JSON.stringify(previous.imageIds) !==
          JSON.stringify(images.map((image) => image.id)) ||
        JSON.stringify(previous.documentIds) !==
          JSON.stringify(documents.map((document) => document.id)))
    ) {
      setError(
        "上次加入队列的结果尚未确认，请等待队列刷新后再提交新的内容；当前草稿已保留。",
      );
      setRefresh((old) => old + 1);
      return;
    }
    const entry: AgentQueueSubmission = previous || {
      version: 1,
      projectPath,
      sessionId: id,
      requestId: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      text,
      draft: captureAgentDraft(storageKey, draft),
      imageIds: images.map((image) => image.id),
      documentIds: documents.map((document) => document.id),
    };
    try {
      saveAgentQueueSubmission(entry);
    } catch (cause) {
      setError(agentErrorMessage(cause));
      return;
    }
    mutation.current = true;
    setBusy("enqueue");
    setBusySessionId(id);
    setError(null);
    try {
      // Native queue owns the durable payload; this cache also restores an
      // uncertain enqueue's attachments without copying blobs into localStorage.
      await Promise.all([
        saveAgentImageAttachments(entry.requestId, images),
        saveAgentDocumentAttachments(entry.requestId, documents),
      ]).catch(() => {});
      let receipt: Awaited<ReturnType<typeof agentApi.enqueueMessage>>;
      if (snapshot.session.coordination?.role === "worker") {
        await sendSecretaryWorkerMessage(
          snapshot.session,
          text,
          entry.requestId,
          images,
          documents,
        );
        receipt = { status: "accepted" };
      } else {
        receipt = await agentApi.enqueueMessage(
          id,
          text,
          entry.requestId,
          images,
          documents,
        );
      }
      if (receipt.status === "rejected") {
        clearAgentQueueSubmission(projectPath, id, entry.requestId);
        if (mounted.current && selectedId.current === id)
          setError(receipt.message || "消息未能加入队列，草稿和附件已保留。");
        return;
      }
      if (receipt.status !== "accepted")
        throw new Error("未能确认消息已加入队列，请重试。");
      acceptQueuedDraft(entry);
    } catch (cause) {
      let admitted = false;
      try {
        const next = await agentApi.getSession(id);
        if (
          next.session.id === id &&
          next.session.projectPath === projectPath
        ) {
          admitted = Boolean(
            next.queuedMessages?.some((item) => item.id === entry.requestId) ||
              next.messages.some(
                (message) =>
                  message.role === "user" && message.id === entry.requestId,
              ),
          );
          onSnapshot(next);
        }
      } catch {
        /* Retry retains this exact request identity and payload. */
      }
      if (admitted) acceptQueuedDraft(entry);
      else if (mounted.current && selectedId.current === id)
        setError(agentErrorMessage(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) {
        setBusy(null);
        setBusySessionId(null);
        setRefresh((old) => old + 1);
      }
    }
  };
  const manageQueuedMessage = async (
    requestId: string,
    action: "now" | "recall" | "remove",
  ) => {
    if (
      mutation.current ||
      replacement.current ||
      !sessionId ||
      !workspace ||
      isLegacySession(sessionId) ||
      stoppingRef.current[sessionId] ||
      pendingRef.current[sessionId]?.uncertain
    )
      return;
    const id = sessionId;
    const storageKey = key;
    if (
      action === "recall" &&
      (draft.trim() || composerImages.length || composerDocuments.length)
    ) {
      setError("输入框已有草稿，请先发送、加入队列或清空，再撤回这条消息。");
      return;
    }
    const existingRecall = readAgentQueueRecall(workspace.path, id);
    if (
      existingRecall &&
      (action !== "recall" || existingRecall.requestId !== requestId)
    ) {
      setError("上次撤回的结果尚未恢复，请先恢复这条消息。");
      return;
    }
    if (action === "recall") {
      try {
        // A retry uses a fresh empty-editor revision but keeps the original
        // receipt until the payload has actually reached this editor.
        saveAgentQueueRecall({
          projectPath: workspace.path,
          sessionId: id,
          requestId,
          draft: captureAgentDraft(storageKey, draft),
          text:
            snapshot?.queuedMessages?.find((item) => item.id === requestId)
              ?.text ||
            existingRecall?.text ||
            "",
        });
      } catch (cause) {
        setError(agentErrorMessage(cause));
        return;
      }
    }
    mutation.current = true;
    setQueueBusyId(requestId);
    setBusy(`queue-${action}`);
    setBusySessionId(id);
    setError(null);
    try {
      if (action === "now") {
        await agentApi.sendQueuedMessageNow(id, requestId);
      } else {
        const input = await agentApi.removeQueuedMessage(id, requestId);
        if (action === "recall") {
          if (input.requestId !== requestId)
            throw new Error("撤回回执与所选消息不一致，请重试。");
          const receipt = readAgentQueueRecall(workspace!.path, id);
          if (
            !mounted.current ||
            !receipt ||
            !isAgentDraftCurrent(receipt.draft) ||
            composerImagesRef.current[id]?.length ||
            composerDocumentsRef.current[id]?.length
          ) {
            if (mounted.current && selectedId.current === id)
              setError(
                "消息已撤回，新的草稿已保留；清空输入框后点击“恢复编辑”。",
              );
            return;
          }
          // Queue removal returns the original validated input and is idempotent.
          // The original editor is locked for this short IPC, even if the user
          // switches conversations before its response arrives.
          const restored = saveAgentDraft(storageKey, input.text);
          if (!isAgentDraftCurrent(restored))
            throw new Error(
              "输入框恢复失败，撤回记录已保留，请点击恢复编辑重试。",
            );
          clearAgentQueueRecall(workspace!.path, id, requestId);
          const images: AgentImageAttachment[] = [];
          const documents: AgentDocumentAttachment[] = [];
          for (const [index, attachment] of (
            input.attachments || []
          ).entries()) {
            const attachmentId = `${requestId}:${index}`;
            if (attachment.ref)
              images.push({
                id: attachmentId,
                fileName: attachment.fileName,
                mime: attachment.mime,
                bytes: attachment.bytes,
                dataUrl: attachment.ref,
              });
            else
              documents.push({
                id: attachmentId,
                fileName: attachment.fileName,
                mime: attachment.mime,
                bytes: attachment.bytes,
                ...(attachment.localPath
                  ? { localPath: attachment.localPath }
                  : { dataBase64: attachment.dataBase64 }),
              });
          }
          if (mounted.current) {
            setDrafts((old) => ({ ...old, [storageKey]: input.text }));
            composerImagesRef.current = {
              ...composerImagesRef.current,
              [id]: images,
            };
            setComposerImagesBySession(composerImagesRef.current);
            composerDocumentsRef.current = {
              ...composerDocumentsRef.current,
              [id]: documents,
            };
            setComposerDocumentsBySession(composerDocumentsRef.current);
            requestAnimationFrame(() => {
              if (mounted.current && selectedId.current === id)
                composerInputRef.current?.focus();
            });
          }
        }
      }
    } catch (cause) {
      if (mounted.current && selectedId.current === id)
        setError(agentErrorMessage(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) {
        setQueueBusyId(null);
        setBusy(null);
        setBusySessionId(null);
        setRefresh((old) => old + 1);
      }
    }
  };
  const submitComposer = () => {
    if (
      snapshot &&
      (activeStatus(snapshot.status) ||
        snapshot.queuedMessages?.length ||
        queueRecovery)
    )
      void enqueueDraft();
    else void send();
  };
  const send = async (retry?: AgentRetryInput) => {
    const outgoingImages =
      retry?.images ??
      (sessionId ? composerImagesRef.current[sessionId] || [] : []);
    const outgoingDocuments =
      retry?.documents ??
      (sessionId ? composerDocumentsRef.current[sessionId] || [] : []);
    const text = retry?.text.trim() ?? draft.trim();
    const retryingSamePending = Boolean(
      retry &&
        pendingRef.current[sessionId || ""]?.requestId === retry.requestId,
    );
    if (
      mutation.current ||
      replacement.current ||
      (retryLoading && !retry) ||
      !sessionId ||
      isLegacySession(sessionId) ||
      !key ||
      (!text && !outgoingImages.length && !outgoingDocuments.length) ||
      !snapshot ||
      (pendingRef.current[sessionId] &&
        !pendingRef.current[sessionId].uncertain &&
        !activeStatus(snapshot.status) &&
        !retryingSamePending) ||
      stoppingRef.current[sessionId] ||
      agentStopInFlight(sessionId)
    )
      return;
    const id = sessionId;
    const storageKey = key;
    const projectPath = workspace!.path;
    if (readAgentQueueSubmission(projectPath, id)) {
      setError(
        "上次加入队列的结果尚未确认，请先刷新队列或重试加入队列；当前草稿已保留。",
      );
      return;
    }
    const sourceDraft = retry
      ? {
          key: `${storageKey}:retry:${retry.requestId}`,
          revision: crypto.randomUUID(),
          text: "",
        }
      : captureAgentDraft(storageKey, draft);
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
        (interrupting ? sourceSnapshot.session : selectedSession)?.coordination
          ?.role !== "worker" &&
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
      if (
        previous &&
        (previous.text !== text ||
          previous.stopRequested ||
          (retry && previous.requestId !== retry.requestId))
      ) {
        setError(
          "上次发送的接收状态尚未确认，请先停止该次任务，再发送新的内容。",
        );
        return;
      }
      const requestId =
        retry?.requestId ||
        previous?.requestId ||
        `msg_${crypto.randomUUID().replace(/-/g, "")}`;
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
        if (outgoingImages.length) {
          setSentImageAttachments((old) => ({
            ...old,
            [requestId]: outgoingImages,
          }));
          clearSentComposerImages(id, outgoingImages);
        }
        if (outgoingDocuments.length) {
          setSentDocumentAttachments((old) => ({
            ...old,
            [requestId]: outgoingDocuments,
          }));
          clearSentComposerDocuments(id, outgoingDocuments);
        }
        setRefresh((old) => old + 1);
      };
      try {
        if (outgoingImages.length)
          await saveAgentImageAttachments(requestId, outgoingImages).catch(
            () => {},
          );
        if (outgoingDocuments.length)
          await saveAgentDocumentAttachments(
            requestId,
            outgoingDocuments,
          ).catch(() => {});
        if (sourceSnapshot.session.coordination?.role === "worker")
          await sendSecretaryWorkerMessage(
            sourceSnapshot.session,
            text,
            requestId,
            outgoingImages,
            outgoingDocuments,
          );
        else
          await agentApi.sendMessage(
            id,
            text,
            requestId,
            outgoingImages,
            outgoingDocuments,
          );
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
  useEffect(() => {
    if (!automationKickoff) return;
    const kickoff = automationKickoff;
    if (
      sessionId !== kickoff.sessionId ||
      workspace?.path !== kickoff.projectPath
    ) {
      setAutomationKickoff(null);
      return;
    }
    if (busy || snapshotLoading || !snapshot) return;
    setAutomationKickoff(null);
    if (
      snapshot.session.id !== kickoff.sessionId ||
      activeStatus(snapshot.status) ||
      draft !== kickoff.draft.text ||
      !isAgentDraftCurrent(kickoff.draft)
    )
      return;
    void send();
  }, [
    automationKickoff,
    sessionId,
    workspace?.path,
    snapshot,
    snapshotLoading,
    busy,
    draft,
  ]);
  const retryLastMessage = async () => {
    if (!snapshot || snapshot.status !== "error" || !sessionId) return;
    const message = [...snapshot.messages]
      .reverse()
      .find((item) => item.role === "user");
    if (!message) return;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    setRetryLoading(true);
    try {
      const [images, documents] = await Promise.all([
        sentImageAttachments[message.id] ||
          readAgentImageAttachments(message.id).then((value) => value || []),
        sentDocumentAttachments[message.id] ||
          readAgentDocumentAttachments(message.id).then((value) => value || []),
      ]);
      await send({
        requestId: message.id,
        text,
        images,
        documents,
      });
    } catch (cause) {
      toast.error(agentErrorMessage(cause));
    } finally {
      if (mounted.current) setRetryLoading(false);
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
            : refreshedSessions.find(
                (item) => item.coordination?.role !== "worker",
              )?.id || null,
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
  const confirmSession = useCallback(
    (session: AgentSession, fields: (keyof AgentSession)[]) => {
      setSessions((old) =>
        old.map((item) => (item.id === session.id ? session : item)),
      );
      overrideFields.current[session.id] = [
        ...new Set([...(overrideFields.current[session.id] || []), ...fields]),
      ];
      overridesRef.current = { ...overridesRef.current, [session.id]: session };
      setSessionOverrides(overridesRef.current);
      setRefresh((old) => old + 1);
    },
    [],
  );
  const updateSessionConfig = async (patch: {
    modelId?: string;
    permissionMode?: AgentPermissionMode;
    reasoningEffort?: string;
    contextLimit?: number | null;
  }) => {
    if (isSecretaryWorker) return;
    if (!sessionId) {
      if (patch.modelId) {
        setModelId(patch.modelId);
        setContextLimit(null);
      }
      if (patch.contextLimit !== undefined) setContextLimit(patch.contextLimit);
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
        ...(patch.modelId || patch.contextLimit !== undefined
          ? ["contextLimit" as const]
          : []),
        ...(patch.permissionMode ? ["permissionMode" as const] : []),
      ]);
      if (selectedId.current === id) {
        if (patch.modelId) setModelId(patch.modelId);
        if (patch.modelId || patch.reasoningEffort !== undefined)
          setReasoningEffort(result.reasoningEffort || "");
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
            sessions.find(
              (item) =>
                item.id !== id &&
                !item.archived &&
                item.coordination?.role !== "worker",
            )?.id || null,
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
  const loadWorkspaceSessions = async (path: string) => {
    if (workspaceSessionLoads.current.has(path)) return;
    const request = {};
    workspaceSessionLoads.current.set(path, request);
    setLoadingWorkspaceSessions((old) => ({ ...old, [path]: true }));
    setWorkspaceSessionErrors((old) => {
      const next = { ...old };
      delete next[path];
      return next;
    });
    try {
      const items = await agentApi.listSessions(path);
      if (
        !mounted.current ||
        workspaceSessionLoads.current.get(path) !== request
      )
        return;
      setWorkspaceSessions((old) => ({ ...old, [path]: items }));
      discoverSessionActivity(items);
    } catch {
      if (
        mounted.current &&
        workspaceSessionLoads.current.get(path) === request
      )
        setWorkspaceSessionErrors((old) => ({ ...old, [path]: true }));
    } finally {
      if (workspaceSessionLoads.current.get(path) === request) {
        workspaceSessionLoads.current.delete(path);
        if (mounted.current)
          setLoadingWorkspaceSessions((old) => ({ ...old, [path]: false }));
      }
    }
  };
  const toggleWorkspace = (path: string, expanded: boolean) => {
    setExpandedWorkspaces((old) => ({ ...old, [path]: !expanded }));
    if (!expanded && path !== workspace?.path) void loadWorkspaceSessions(path);
  };
  const refreshSyncedSessions = async () => {
    const nextProjects = await agentApi.listProjects();
    if (!mounted.current) return;
    setProjects(preserveWorkspaceOrder(nextProjects));
    if (workspace) {
      const items = await agentApi.listSessions(workspace.path, showArchived);
      if (!mounted.current) return;
      setSessions(items);
      discoverSessionActivity(items);
    }
    await Promise.all(
      nextProjects
        .filter(
          (project) =>
            project.path !== workspace?.path &&
            expandedWorkspaces[project.path],
        )
        .map((project) => {
          workspaceSessionLoads.current.delete(project.path);
          return loadWorkspaceSessions(project.path);
        }),
    );
    if (mounted.current) setRefresh((value) => value + 1);
  };
  const renameProject = async (project: AgentProject, name: string) => {
    if (mutation.current) throw new Error("配置正在保存，请稍后重命名。");
    mutation.current = true;
    setBusy("project-meta");
    try {
      const renamed = await agentApi.renameProject(project.path, name);
      if (!mounted.current) return;
      setProjects((old) =>
        preserveWorkspaceOrder(
          old.some((item) => item.path === renamed.path)
            ? old.map((item) => (item.path === renamed.path ? renamed : item))
            : [...old, renamed],
        ),
      );
      setWorkspace((old) =>
        old?.path === renamed.path ? { ...old, name: renamed.name } : old,
      );
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
      if (mounted.current) setProjects(preserveWorkspaceOrder(next));
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
  const enqueuingHere = busy === "enqueue" && busySessionId === sessionId;
  const queueMode = Boolean(
    runningHere || snapshot?.queuedMessages?.length || queueRecovery,
  );
  const recallingHere = busy === "queue-recall" && busySessionId === sessionId;
  const sendDisabled =
    readOnlySession ||
    retryLoading ||
    Boolean(busy) ||
    Boolean(replacementSession) ||
    !snapshot ||
    (!draft.trim() && !composerImages.length && !composerDocuments.length) ||
    (queuedHere && !runningHere) ||
    stoppingHere;
  const visibleWorkspaceSessions = sessions
    .filter(
      (session) =>
        session.coordination?.role !== "worker" &&
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
    );
  const workspaceExpanded = workspace
    ? (expandedWorkspaces[workspace.path] ?? true)
    : false;
  const sidebarProjects: AgentProject[] = projects.length
    ? [...projects]
    : recent.map((path) => ({
        path,
        name: nameOf(path),
        pinned: false,
        lastOpenedAt: 0,
      }));
  if (
    workspace &&
    !sidebarProjects.some((item) => item.path === workspace.path)
  )
    sidebarProjects.push({
      ...workspace,
      pinned: false,
      lastOpenedAt: 0,
    });
  sidebarProjects.sort(
    (a, b) =>
      Number(Boolean(b.standalone)) - Number(Boolean(a.standalone)) ||
      Number(b.pinned) - Number(a.pinned),
  );

  const navigateWorkspace = (action: () => void) => {
    const proceed = () => {
      setActiveTool(null);
      action();
    };
    if (activeTool && onWorkspaceNavigate) onWorkspaceNavigate(proceed);
    else proceed();
  };
  const collapseSidebar = () => {
    const focused = document.activeElement;
    const restoreKeyboardFocus =
      focused instanceof HTMLElement &&
      Boolean(focused.closest(".wb-sidebar")) &&
      focused.matches(":focus-visible");
    setSidebarCollapsed(true);
    if (restoreKeyboardFocus)
      requestAnimationFrame(() => {
        const buttons =
          paneLayout.containerRef.current?.querySelectorAll<HTMLButtonElement>(
            ".wb-sidebar-expand",
          );
        const target = Array.from(buttons || []).find((button) => {
          let parent: HTMLElement | null = button;
          while (parent && !parent.inert) parent = parent.parentElement;
          return !parent;
        });
        target?.focus();
      });
  };
  const toggleSidebar = () => {
    if (!paneLayout.sidebarVisible) {
      setPreviewPath(null);
      setSidebarCollapsed(false);
    } else collapseSidebar();
  };
  const sidebarToggle = !paneLayout.sidebarVisible ? (
    <button
      type="button"
      className="wb-icon-button wb-pane-toggle wb-sidebar-expand"
      title={"Ctrl + \\"}
      aria-label="展开项目侧栏"
      onClick={toggleSidebar}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <PanelLeftOpen />
    </button>
  ) : null;
  const sidebarActions = (
    <nav className="wb-nav" aria-label="工作台操作">
      <div className="wb-create-task">
        <button
          className="wb-nav-button wb-nav-create"
          aria-label={busy === "create" ? "正在创建…" : "新建任务"}
          disabled={
            initializing ||
            Boolean(busy) ||
            engine?.available === false ||
            Boolean(workspace && !modelId)
          }
          onClick={() => navigateWorkspace(() => void createSession())}
        >
          <Plus aria-hidden="true" />
          {busy === "create" ? "正在创建…" : "新对话"}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="wb-create-task-options"
              aria-label="选择新建任务类型"
              disabled={
                initializing || Boolean(busy) || engine?.available === false
              }
            >
              <ChevronDown />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6}>
            <DropdownMenuItem
              onSelect={() => navigateWorkspace(() => void openProject())}
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              打开文件夹
            </DropdownMenuItem>
            {workspace && !workspace.standalone && (
              <DropdownMenuItem
                disabled={!modelId}
                onSelect={() => navigateWorkspace(() => void createSession())}
              >
                <Folder className="mr-2 h-4 w-4" />
                在当前项目新建任务
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => navigateWorkspace(() => void createSession(true))}
            >
              <MessageSquarePlus className="mr-2 h-4 w-4" />
              <span>
                新建独立任务
                <span className="block text-xs text-fg-3">
                  无需打开项目或选择文件夹
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <button
        type="button"
        className="wb-nav-button wb-nav-secretary"
        aria-label={t("agentSecretary.open", {
          defaultValue: "打开 Loli 秘书",
        })}
        aria-pressed={Boolean(secretarySessionId)}
        disabled={
          initializing ||
          Boolean(busy) ||
          engine?.available === false ||
          Boolean(workspace && !catalog.models.length)
        }
        onClick={() => navigateWorkspace(() => void openSecretary())}
      >
        <img src={assistantPortrait} alt="" />
        <span>{t("agentSecretary.name", { defaultValue: "Loli 秘书" })}</span>
        {busy === "secretary" ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        ) : (
          <UsersRound aria-hidden="true" />
        )}
      </button>
      {IS_DEVELOPMENT_BUILD && (
        <AgentSessionSyncButton
          disabled={
            initializing || Boolean(busy) || engine?.available === false
          }
          onSynced={refreshSyncedSessions}
        />
      )}
    </nav>
  );
  const sidebarWorkspace = (
    <>
      <div className="wb-search" role="search">
        <Search aria-hidden="true" />
        <input
          ref={sessionSearchRef}
          aria-label="搜索会话"
          placeholder="搜索会话"
          value={sessionSearch}
          onChange={(event) => setSessionSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            if (event.nativeEvent.isComposing || event.keyCode === 229) {
              event.stopPropagation();
              return;
            }
            if (sessionSearch) {
              event.stopPropagation();
              event.preventDefault();
              setSessionSearch("");
            }
          }}
        />
        {sessionSearch && (
          <button
            type="button"
            className="wb-search-clear"
            aria-label="清空会话搜索"
            onClick={() => {
              setSessionSearch("");
              sessionSearchRef.current?.focus();
            }}
          >
            <X aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="wb-projects">
        <div className="wb-section-label">
          <span>{showArchived ? "归档任务" : "工作区"}</span>
          <span className="wb-workspace-count">{sidebarProjects.length}</span>
          <button
            type="button"
            className="wb-icon-button"
            aria-label="添加工作区"
            title="打开项目文件夹"
            disabled={
              initializing || Boolean(busy) || engine?.available === false
            }
            onClick={() => navigateWorkspace(() => void openProject())}
          >
            <FolderOpen />
          </button>
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
        {sidebarProjects.map((project) => {
          const isCurrentWorkspace = project.path === workspace?.path;
          const expanded = isCurrentWorkspace
            ? workspaceExpanded
            : Boolean(expandedWorkspaces[project.path]);
          const taskListId = `workspace-tasks-${encodeURIComponent(
            project.path,
          )}`;
          const matchingTasks = (
            isCurrentWorkspace
              ? visibleWorkspaceSessions
              : workspaceSessions[project.path] || []
          )
            .filter((session) => session.coordination?.role !== "worker")
            .filter(
              (session) =>
                isCurrentWorkspace ||
                !sessionSearch.trim() ||
                session.title
                  .toLocaleLowerCase()
                  .includes(sessionSearch.toLocaleLowerCase()),
            )
            .sort(
              (a, b) =>
                Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
                b.updatedAt - a.updatedAt,
            );
          return (
            <div className="wb-workspace-group" key={project.path}>
              <div
                className={
                  isCurrentWorkspace ? "wb-project-row" : "wb-project-list-row"
                }
                title={
                  project.standalone ? "无需绑定项目的独立任务" : project.path
                }
              >
                <button
                  type="button"
                  className={`wb-workspace-toggle${isCurrentWorkspace ? " wb-current-workspace-toggle" : ""}`}
                  aria-label={`${expanded ? "收起" : "展开"} ${project.name} 的任务`}
                  aria-expanded={expanded}
                  aria-controls={taskListId}
                  disabled={initializing || Boolean(busy)}
                  onClick={() => toggleWorkspace(project.path, expanded)}
                >
                  {expanded ? <ChevronDown /> : <ChevronRight />}
                </button>
                {isCurrentWorkspace ? (
                  <>
                    {project.standalone ? <MessageSquare /> : <Folder />}
                    <span>{project.name}</span>
                    {project.pinned && <Pin size={11} />}
                  </>
                ) : (
                  <button
                    className="wb-nav-button wb-workspace-project"
                    title={project.standalone ? "打开独立任务" : project.path}
                    disabled={
                      initializing ||
                      Boolean(busy) ||
                      engine?.available === false
                    }
                    onClick={() =>
                      navigateWorkspace(() => void openProject(project.path))
                    }
                  >
                    {project.standalone ? <MessageSquare /> : <Folder />}
                    <span className="truncate">{project.name}</span>
                    {project.pinned && <Pin size={11} />}
                  </button>
                )}
                <AgentProjectMenu
                  name={project.name}
                  standalone={project.standalone}
                  pinned={Boolean(project.pinned)}
                  disabled={Boolean(busy)}
                  inProjectList={!isCurrentWorkspace}
                  onCreateTask={
                    isCurrentWorkspace
                      ? () => navigateWorkspace(() => void createSession())
                      : undefined
                  }
                  onTogglePin={() => void updateProject(project)}
                  onRename={
                    project.standalone
                      ? undefined
                      : (name) => renameProject(project, name)
                  }
                  onRemove={() => void updateProject(project, true)}
                />
              </div>
              {expanded && (
                <div
                  className={`wb-workspace-sessions${
                    isCurrentWorkspace ? " wb-current-workspace-sessions" : ""
                  }`}
                  id={taskListId}
                  role="group"
                  aria-label={`${project.name} 的任务`}
                >
                  {isCurrentWorkspace ? (
                    matchingTasks.length ? (
                      matchingTasks.map((session) => (
                        <div className="wb-session-container" key={session.id}>
                          <button
                            className="wb-session-row"
                            disabled={
                              busy === "project" ||
                              busy === "create" ||
                              busy === "secretary"
                            }
                            aria-pressed={session.id === sessionId}
                            onClick={() =>
                              navigateWorkspace(() => {
                                setError(null);
                                setSessionId(session.id);
                              })
                            }
                          >
                            <span>{session.title || "新会话"}</span>
                            {session.pinned && (
                              <Pin size={11} aria-label="已置顶" />
                            )}
                            {(activeStatus(statuses[session.id]) ||
                              pending[session.id]) && (
                              <i
                                className="wb-session-dot"
                                aria-label="进行中"
                              />
                            )}
                          </button>
                          <AgentSessionMenu
                            session={session}
                            disabled={
                              Boolean(busy) || isLegacySession(session.id)
                            }
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
                      ))
                    ) : (
                      <p className="wb-sidebar-note">
                        {sessionSearch.trim()
                          ? "没有匹配的会话。"
                          : showArchived
                            ? "当前项目没有归档任务。"
                            : "当前项目还没有任务。"}
                      </p>
                    )
                  ) : loadingWorkspaceSessions[project.path] ? (
                    <p className="wb-sidebar-note" role="status">
                      正在加载任务…
                    </p>
                  ) : workspaceSessionErrors[project.path] ? (
                    <button
                      type="button"
                      className="wb-workspace-note"
                      onClick={() => void loadWorkspaceSessions(project.path)}
                    >
                      加载失败，点击重试
                    </button>
                  ) : matchingTasks.length ? (
                    matchingTasks.map((session) => (
                      <button
                        type="button"
                        className="wb-session-row wb-workspace-task-row"
                        key={session.id}
                        title={session.title || "新会话"}
                        disabled={Boolean(busy)}
                        onClick={() =>
                          navigateWorkspace(
                            () => void openProject(project.path, session.id),
                          )
                        }
                      >
                        <span>{session.title || "新会话"}</span>
                        {activeStatus(
                          statuses[session.id] || session.activity?.status,
                        ) && (
                          <i className="wb-session-dot" aria-label="进行中" />
                        )}
                      </button>
                    ))
                  ) : (
                    <p className="wb-sidebar-note">
                      {sessionSearch.trim()
                        ? "没有匹配的任务。"
                        : "此工作区还没有任务。"}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <div
      ref={paneLayout.containerRef}
      className="lolicode-agent-page lolicode-workbench wb-resizable-layout wb-unified"
    >
      <div
        className="wb-sidebar-track"
        data-collapsed={!paneLayout.sidebarVisible}
        aria-hidden={!paneLayout.sidebarVisible || undefined}
        ref={(node) => {
          if (node) node.inert = !paneLayout.sidebarVisible;
        }}
      >
        <div className="wb-sidebar-clip">
          <aside
            className="wb-sidebar"
            aria-label="项目会话"
            style={{
              width: lastSidebarWidth.current,
              flexBasis: lastSidebarWidth.current,
            }}
          >
            {renderSidebar ? (
              renderSidebar({
                actions: sidebarActions,
                workspace: sidebarWorkspace,
                onCollapse: collapseSidebar,
              })
            ) : (
              <>
                <div
                  className="wb-brand"
                  {...DRAG_REGION_ATTR}
                  style={DRAG_REGION_STYLE as React.CSSProperties}
                >
                  <span className="wb-brand-mark" aria-hidden="true">
                    <Sparkles />
                  </span>
                  <div className="wb-brand-label">
                    {APP_NAME} <span>工作台</span>
                  </div>
                  <button
                    type="button"
                    className="wb-icon-button wb-pane-toggle"
                    aria-label="收起项目侧栏"
                    title={"Ctrl + \\"}
                    onClick={collapseSidebar}
                    style={
                      { WebkitAppRegion: "no-drag" } as React.CSSProperties
                    }
                  >
                    <PanelLeftClose aria-hidden="true" />
                  </button>
                </div>
                {sidebarActions}
                {sidebarWorkspace}
              </>
            )}
          </aside>
        </div>
      </div>
      {!sidebarCollapsed && paneLayout.sidebarVisible && (
        <AgentPaneResizeHandle {...paneLayout.sidebarHandleProps} />
      )}
      <main id="agent-content-area" className="wb-main">
        <MotionSurface
          motionKey={`conversation:${sessionId || "welcome"}`}
          className="wb-chat-surface"
          data-panel-background
        >
          <header
            className="wb-titlebar"
            {...DRAG_REGION_ATTR}
            style={DRAG_REGION_STYLE as React.CSSProperties}
          >
            {sidebarToggle}
            <div className="wb-titlebar-heading" {...DRAG_REGION_ATTR}>
              <h1
                title={selectedSession?.title || "编程工作台"}
                {...DRAG_REGION_ATTR}
              >
                {selectedSession?.title || "编程工作台"}
              </h1>
            </div>
            {secretarySessionId && (
              <span className="wb-secretary-role">
                {isSecretary
                  ? t("agentSecretary.name", { defaultValue: "Loli 秘书" })
                  : t("agentSecretary.workerRole", {
                      defaultValue: "工作对话",
                    })}
              </span>
            )}
            {workspace && (
              <button
                type="button"
                className="wb-icon-button wb-titlebar-project"
                title={
                  workspace.standalone
                    ? "打开独立任务的文件目录"
                    : workspace.remote
                      ? `管理远程项目：${workspace.remote.root}`
                      : `打开项目文件夹：${workspace.path}`
                }
                aria-label={
                  workspace.standalone
                    ? "打开独立任务的文件目录"
                    : workspace.remote
                      ? `管理远程项目：${workspace.remote.root}`
                      : `打开项目文件夹：${workspace.path}`
                }
                onClick={(event) => {
                  event.stopPropagation();
                  if (workspace.remote) {
                    setOperationsTab("remote");
                    setOperationsOpen(true);
                    return;
                  }
                  void agentApi
                    .openProjectDirectory(workspace.path)
                    .catch((cause) =>
                      toast.error(
                        cause instanceof Error
                          ? cause.message
                          : "无法打开项目文件夹",
                      ),
                    );
                }}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <Folder aria-hidden="true" />
              </button>
            )}
            {workspace && sessionId && (
              <AgentActivityStatus
                hideIdle
                snapshot={snapshot}
                queued={queuedHere}
                stopping={stoppingHere}
                loading={snapshotLoading}
              />
            )}
            <AgentHelpMenu
              onOpenAbout={onOpenAbout}
              onCheckUpdate={onCheckUpdate}
            />
            {workspace && sessionId && (
              <button
                type="button"
                className="wb-icon-button wb-pane-toggle wb-titlebar-preview"
                aria-label={previewVisible ? "收起文件预览" : "预览项目文件"}
                aria-expanded={previewVisible}
                title={previewVisible ? "收起文件预览" : "展开文件预览"}
                onClick={() =>
                  previewVisible ? setPreviewPath(null) : openPreview("")
                }
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                {previewVisible ? (
                  <PanelRightClose aria-hidden="true" />
                ) : (
                  <PanelRightOpen aria-hidden="true" />
                )}
              </button>
            )}
            <div
              className="wb-native-controls"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              {windowControls}
            </div>
          </header>
          {secretarySessionId && (
            <AgentSecretaryTasks
              key={secretarySessionId}
              sessionId={secretarySessionId}
              workerTaskId={
                !isSecretary ? selectedSession?.coordination?.taskId : undefined
              }
              active={!activeTool}
              onOpenSession={openSecretarySession}
            />
          )}
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
                <span className="wb-welcome-eyebrow">YOUR CREATIVE SPACE</span>
                <h2>从一个想法开始</h2>
                <p>直接开始独立任务，也可以打开项目，继续你的创作。</p>
                <button
                  className="wb-primary wb-welcome-action"
                  disabled={
                    initializing || Boolean(busy) || engine?.available === false
                  }
                  onClick={() => void createSession(true)}
                >
                  <MessageSquarePlus />
                  新建独立任务
                  <ArrowUpRight aria-hidden="true" />
                </button>
                <button
                  className="wb-nav-button justify-center"
                  aria-label="打开项目文件夹"
                  disabled={
                    initializing || Boolean(busy) || engine?.available === false
                  }
                  onClick={() => void openProject()}
                >
                  <FolderOpen />
                  打开项目
                  <ArrowUpRight aria-hidden="true" />
                </button>
                <span className="wb-welcome-note">
                  独立任务自动保存，无需选择文件夹
                </span>
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
                <span className="wb-welcome-eyebrow">READY WHEN YOU ARE</span>
                <h2>开始新任务</h2>
                <p>
                  {catalog.models.length
                    ? "选择模型，然后描述你想完成的工作。"
                    : "先在渠道与模型中添加可用于编程的模型。"}
                </p>
                <div className="wb-startup-controls">
                  <AgentModelPicker
                    className="wb-startup-model"
                    models={catalog.models}
                    disabled={Boolean(busy)}
                    value={modelId}
                    onOpenChannels={onOpenChannels}
                    onRefresh={() => void refreshCatalog()}
                    refreshDisabled={Boolean(busy) || working}
                    excludedSources={catalog.excludedSources}
                    onSelect={(id) => {
                      setModelId(id);
                      setContextLimit(null);
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
                    contextValue={contextLimit}
                  />
                  <AgentContextPicker
                    model={catalog.models.find((model) => model.id === modelId)}
                    value={contextLimit}
                    disabled={Boolean(busy) || !modelId}
                    onSelect={setContextLimit}
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
                      setPermissionMode(
                        event.target.value as AgentPermissionMode,
                      );
                    }}
                  >
                    <option value="ask">逐次确认</option>
                    <option value="auto">Auto Mode</option>
                    <option value="full_access">完整权限</option>
                  </select>
                </div>
                <button
                  className="wb-primary wb-welcome-action"
                  disabled={Boolean(busy) || !modelId}
                  onClick={() => void createSession()}
                >
                  开始会话
                  <ArrowUpRight aria-hidden="true" />
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
                    if (el) {
                      atBottom.current =
                        el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
                      setShowScrollToBottom(!atBottom.current);
                    }
                  }}
                  className="wb-chat"
                >
                  <div className="wb-chat-content">
                    <AgentTranscript
                      messages={snapshot?.messages || []}
                      userIdentity={
                        account
                          ? {
                              displayName:
                                account.displayName || account.username,
                              avatarUrl: account.avatarUrl || undefined,
                            }
                          : undefined
                      }
                      sessionId={snapshot?.session.id}
                      projectPath={workspace.path}
                      status={snapshot?.status}
                      imageAttachmentsByMessage={sentImageAttachments}
                      documentAttachmentsByMessage={sentDocumentAttachments}
                    />
                    {snapshot && !snapshot.messages.length && (
                      <div className="wb-empty">
                        <div className="wb-empty-content">
                          <WelcomeMark compact />
                          <span className="wb-welcome-eyebrow">
                            LET’S MAKE SOMETHING
                          </span>
                          <h2>
                            {isSecretary
                              ? t("agentSecretary.welcomeTitle", {
                                  defaultValue: "今天有什么交给我？",
                                })
                              : "今天想完成什么？"}
                          </h2>
                          <p>
                            {isSecretary
                              ? t("agentSecretary.welcomeDescription", {
                                  defaultValue:
                                    "告诉我你的目标，我来安排工作、跟进进度，再把结果带回来。",
                                })
                              : "一个想法、一处优化，都可以从这里开始。"}
                          </p>
                          {!readOnlySession && (
                            <div
                              className="wb-task-starters"
                              aria-label="任务灵感"
                            >
                              {[
                                {
                                  icon: Compass,
                                  title: workspace.standalone
                                    ? "回答问题"
                                    : "读懂项目",
                                  detail: workspace.standalone
                                    ? "解释概念与整理思路"
                                    : "梳理结构与核心流程",
                                  prompt: workspace.standalone
                                    ? "帮我分析并解释这个问题："
                                    : "帮我梳理这个项目的结构，介绍核心模块和主要运行流程。",
                                },
                                {
                                  icon: Code2,
                                  title: "实现想法",
                                  detail: "把灵感变成可用功能",
                                  prompt: workspace.standalone
                                    ? "帮我实现这个想法："
                                    : "我想为这个项目实现一个新功能：",
                                },
                                {
                                  icon: workspace.standalone ? FileText : Bug,
                                  title: workspace.standalone
                                    ? "整理资料"
                                    : "排查问题",
                                  detail: workspace.standalone
                                    ? "总结内容与提炼要点"
                                    : "找到原因，稳妥修复",
                                  prompt: workspace.standalone
                                    ? "请帮我整理和总结下面的资料："
                                    : "帮我排查并修复这个项目中的问题：",
                                },
                              ].map(
                                (
                                  { icon: Icon, title, detail, prompt },
                                  index,
                                ) => (
                                  <button
                                    type="button"
                                    className="wb-task-starter"
                                    data-companion-surface={`welcome-card-${sessionId}-${index}`}
                                    data-companion-dock-id={`welcome-card-${sessionId}-${index}`}
                                    data-companion-rest="sit"
                                    key={title}
                                    onClick={() => insertStarter(prompt)}
                                  >
                                    <span className="wb-task-starter-icon">
                                      <Icon aria-hidden="true" />
                                    </span>
                                    <strong>{title}</strong>
                                    <span>{detail}</span>
                                    <ArrowUpRight
                                      className="wb-task-starter-arrow"
                                      aria-hidden="true"
                                    />
                                  </button>
                                ),
                              )}
                            </div>
                          )}
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
                        .slice(0, 1)
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
                        onRetry={readOnlySession ? undefined : retryLastMessage}
                        retrying={retryLoading || sendingHere}
                      />
                    )}
                  </div>
                </div>
                <AgentChanges key={sessionId} diffs={snapshot?.diffs || []} />
              </AgentFileActionsContext.Provider>
              <div className="wb-composer-area">
                {queueRecall && (
                  <div className="wb-queue-recovery" role="status">
                    <span>
                      有一条撤回消息待恢复：{queueRecall.text || "附件消息"}
                    </span>
                    <button
                      type="button"
                      disabled={Boolean(busy) || readOnlySession}
                      onClick={() =>
                        void manageQueuedMessage(
                          queueRecall.requestId,
                          "recall",
                        )
                      }
                    >
                      恢复编辑
                    </button>
                  </div>
                )}
                <AgentMessageQueue
                  items={snapshot?.queuedMessages || []}
                  paused={snapshot?.queuePaused}
                  busyId={
                    busy === "queue-now" && busySessionId === sessionId
                      ? queueBusyId
                      : null
                  }
                  disabled={
                    readOnlySession ||
                    Boolean(busy) ||
                    Boolean(replacementSession) ||
                    stoppingHere ||
                    uncertainHere
                  }
                  onSendNow={(id) => void manageQueuedMessage(id, "now")}
                  onRecall={(id) => void manageQueuedMessage(id, "recall")}
                  onRemove={(id) => void manageQueuedMessage(id, "remove")}
                />
                {showScrollToBottom && (
                  <button
                    type="button"
                    className="wb-scroll-latest"
                    onClick={() => {
                      const scroll = scrollRef.current;
                      if (!scroll) return;
                      atBottom.current = true;
                      setShowScrollToBottom(false);
                      scroll.scrollTo({
                        top: scroll.scrollHeight,
                        behavior: window.matchMedia(
                          "(prefers-reduced-motion: reduce)",
                        ).matches
                          ? "instant"
                          : "smooth",
                      });
                    }}
                  >
                    <ArrowDown aria-hidden="true" />
                    回到最新
                  </button>
                )}
                <form
                  ref={composerFormRef}
                  className="wb-composer"
                  data-companion-surface={`composer-${sessionId}`}
                  data-companion-dock-id={`composer-${sessionId}`}
                  data-companion-rest="lie"
                  onDragOver={(event) => {
                    if (
                      Array.from(event.dataTransfer.items).some(
                        (item) => item.kind === "file",
                      )
                    )
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    const files = Array.from(event.dataTransfer.files);
                    if (!files.length) return;
                    event.preventDefault();
                    if (nativeDropSupport.current)
                      void addComposerImages(
                        files.filter((file) =>
                          file.type.toLowerCase().startsWith("image/"),
                        ),
                      );
                    else void addComposerFiles(files);
                  }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!sendDisabled) submitComposer();
                  }}
                >
                  {(composerImages.length > 0 ||
                    composerDocuments.length > 0) && (
                    <div
                      className="wb-composer-attachments"
                      aria-label="待发送附件"
                    >
                      {composerImages.map((image) => (
                        <div className="wb-composer-image" key={image.id}>
                          <AgentAttachmentImage
                            image={image}
                            buttonClassName="wb-composer-image-preview"
                            imageClassName="wb-composer-image-preview__image"
                          />
                          <button
                            type="button"
                            aria-label={`移除图片：${image.fileName}`}
                            title="移除图片"
                            onClick={() => removeComposerImage(image.id)}
                          >
                            <X aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                      {composerDocuments.map((document) => (
                        <div className="wb-composer-document" key={document.id}>
                          <FileText aria-hidden="true" />
                          <span title={document.fileName}>
                            {document.fileName}
                          </span>
                          <small>
                            {document.bytes
                              ? `${(document.bytes / (1024 * 1024)).toFixed(1)} MB`
                              : "本地文件"}
                          </small>
                          <button
                            type="button"
                            aria-label={`移除文档：${document.fileName}`}
                            title="移除文档"
                            onClick={() => removeComposerDocument(document.id)}
                          >
                            <X aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <label htmlFor="agent-message" className="sr-only">
                    发送给 Agent 的消息
                  </label>
                  <textarea
                    ref={composerRef}
                    id="agent-message"
                    rows={1}
                    placeholder="描述任务，或继续追问…"
                    title="Enter 发送 · Shift + Enter 换行；执行中 Enter 加入队列，Ctrl/⌘ + Enter 打断并发送"
                    value={draft}
                    disabled={readOnlySession || recallingHere}
                    onChange={(event) => writeDraft(key, event.target.value)}
                    onPaste={(event) => {
                      const files = Array.from(event.clipboardData.items)
                        .filter(
                          (item) =>
                            item.kind === "file" &&
                            item.type.startsWith("image/"),
                        )
                        .map((item) => item.getAsFile())
                        .filter((file): file is File => file !== null);
                      if (!files.length) return;
                      event.preventDefault();
                      void addComposerImages(files);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        if (!sendDisabled) {
                          if (event.ctrlKey || event.metaKey) void send();
                          else submitComposer();
                        }
                      }
                    }}
                  />
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
                    multiple
                    hidden
                    onChange={(event) => {
                      void addComposerFiles(
                        Array.from(event.currentTarget.files || []),
                      );
                      event.currentTarget.value = "";
                    }}
                  />
                  <div className="wb-composer-toolbar">
                    <AgentComposerAdd
                      attachmentsDisabled={
                        readOnlySession ||
                        uncertainHere ||
                        recallingHere ||
                        !sessionId
                      }
                      onAddImages={() => imageInputRef.current?.click()}
                      onAddDocuments={() => void chooseComposerDocuments()}
                      onAddPlugins={() => {
                        setExtensionsInitialTab("plugins");
                        setExtensionsOpen(true);
                      }}
                    />
                    <div className="wb-composer-model">
                      <AgentModelPicker
                        models={catalog.models}
                        disabled={
                          configurationReadOnly ||
                          Boolean(busy) ||
                          !snapshot ||
                          uncertainHere
                        }
                        value={displayedModelId}
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
                    <AgentComposerOptions
                      permissionMode={selectedSession?.permissionMode || "ask"}
                    >
                      {isSecretaryWorker && (
                        <p className="wb-secretary-config-note">
                          {t("agentSecretary.workerSettings", {
                            defaultValue:
                              "工作对话沿用创建时的模型与权限；新任务设置请在秘书主对话中调整。",
                          })}
                        </p>
                      )}
                      <div className="wb-composer-options-field">
                        <span>推理强度</span>
                        <AgentReasoningPicker
                          model={displayedModel}
                          value={displayedReasoningEffort}
                          contextValue={selectedSession?.contextLimit}
                          disabled={
                            configurationReadOnly ||
                            Boolean(busy) ||
                            !snapshot ||
                            uncertainHere ||
                            !displayedModel
                          }
                          onSelect={(value) =>
                            void updateSessionConfig({ reasoningEffort: value })
                          }
                        />
                      </div>
                      <div className="wb-composer-options-field">
                        <span>上下文容量</span>
                        <AgentContextPicker
                          model={displayedModel}
                          value={selectedSession?.contextLimit}
                          onSelect={(value) =>
                            void updateSessionConfig({ contextLimit: value })
                          }
                          disabled={
                            configurationReadOnly ||
                            Boolean(busy) ||
                            !snapshot ||
                            uncertainHere ||
                            !displayedModel
                          }
                        />
                      </div>
                      <div className="wb-composer-options-field">
                        <label htmlFor="agent-permission-mode">执行权限</label>
                        <select
                          id="agent-permission-mode"
                          title="逐次确认：改动和命令先询问；Auto Mode：常规编辑和安全命令自动允许；完整权限：工具无需逐次确认。配置从下一次请求或工具检查生效。"
                          value={selectedSession?.permissionMode || "ask"}
                          disabled={
                            configurationReadOnly ||
                            Boolean(busy) ||
                            !snapshot ||
                            uncertainHere
                          }
                          onChange={(event) => {
                            if (readOnlySession) return;
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
                      </div>
                    </AgentComposerOptions>
                    <span className="wb-toolbar-spacer" />
                    <AgentUsagePopover
                      usage={snapshot?.usage}
                      sessionId={sessionId}
                      active={
                        snapshot?.status === "running" ||
                        snapshot?.titlePending ||
                        snapshot?.compacting
                      }
                    />
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
                    {runningHere && (
                      <button
                        type="button"
                        className="wb-interrupt-send"
                        disabled={sendDisabled}
                        aria-label={replacingHere ? "正在打断…" : "打断并发送"}
                        title="停止当前任务，确认收尾后发送新消息 · Ctrl/⌘ + Enter"
                        onClick={() => void send()}
                      >
                        <ArrowUpRight size={16} aria-hidden="true" />
                        <span>
                          {replacingHere ? "正在打断…" : "打断并发送"}
                        </span>
                      </button>
                    )}
                    <button
                      type="submit"
                      className={`wb-primary wb-send-button${sendingHere || replacingHere || enqueuingHere ? " wb-send-pending" : ""}`}
                      disabled={sendDisabled}
                      title={
                        queueMode
                          ? "加入待发送队列，当前回复结束后依次发送"
                          : "Enter 发送 · Shift + Enter 换行"
                      }
                    >
                      {sendingHere || replacingHere || enqueuingHere ? (
                        <LoaderCircle
                          className="wb-send-spinner"
                          size={20}
                          aria-hidden="true"
                        />
                      ) : queueMode ? (
                        <ListPlus size={20} aria-hidden="true" />
                      ) : (
                        <ArrowUp size={20} aria-hidden="true" />
                      )}
                      <span>
                        {enqueuingHere
                          ? "正在入队…"
                          : replacingHere
                            ? "等待停止…"
                            : sendingHere
                              ? "正在发送…"
                              : queueMode
                                ? "加入队列"
                                : "发送"}
                      </span>
                    </button>
                  </div>
                </form>
              </div>
            </>
          )}
        </MotionSurface>
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
      <FullScreenPanelNavigationContext.Provider value={sidebarToggle}>
        <FullScreenPanelHostContext.Provider value="agent-content-area">
          <AgentToolDraftsContext.Provider value={toolDrafts.current}>
            <AgentOperationsPanel
              open={operationsOpen}
              onOpenChange={setOperationsOpen}
              initialTab={operationsTab}
              projectPath={workspace?.path}
              catalog={catalog}
              working={working}
              onBuildAutomation={startAutomationConversation}
              onOpenProject={openProject}
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
                    modelId ||
                      catalog.defaultModel ||
                      catalog.models[0]?.id ||
                      "",
                    "build",
                    undefined,
                    permissionMode,
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
              projectPath={workspace?.path}
              initialTab={extensionsInitialTab}
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
                      focusComposerOnReturn.current = true;
                      setExtensionsOpen(false);
                    }
                  : undefined
              }
            />
            <AgentToolPanel
              open={activeTool === "memory"}
              onClose={() => setActiveTool(null)}
              title="记忆"
              description="管理跨会话的用户偏好与项目约定，让 Agent 越用越了解你的工作方式。"
              icon={Brain}
              projectPath={workspace?.path}
            >
              {activeTool === "memory" && (
                <AgentMemoryPanel embedded projectPath={workspace?.path} />
              )}
            </AgentToolPanel>
          </AgentToolDraftsContext.Provider>
        </FullScreenPanelHostContext.Provider>
      </FullScreenPanelNavigationContext.Provider>
    </div>
  );
}
