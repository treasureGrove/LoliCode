import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
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
  Globe,
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
  ListChecks,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { agentFilesApi } from "@/lib/api/agent-files";
import {
  readAgentDocumentAttachments,
  readAgentHistoryAttachments,
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
  readAgentDraft as readDraft,
  readAgentSubmission,
  isAgentDraftCurrent,
  restoreAgentDraft,
  saveAgentDraft,
  saveAgentSubmission,
  updateAgentSubmission,
  type AgentSubmission,
} from "@/lib/agentInputLedger";
import {
  AGENT_PREPARED_SESSION_LIMIT,
  agentErrorMessage,
  useAgentSnapshot,
} from "@/hooks/useAgentSnapshot";
import { useLolicodeAccount } from "@/hooks/useLolicodeAccount";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import assistantPortrait from "@/assets/brand/lolicode-icon.png";
import type {
  AgentCatalog,
  AgentDocumentAttachment,
  AgentEngineStatus,
  AgentImageAttachment,
  AgentPermissionMode,
  AgentProject,
  AgentProjectResult,
  AgentQueuedMessage,
  AgentSession,
  AgentSnapshot,
  AgentWorkspace,
} from "@/types/agent";
import { AgentTranscriptDeck } from "./AgentTranscript";
import { useAgentNativeSession } from "@/hooks/useAgentNativeSession";
import { hasNativeTranscriptContent } from "./AgentNativeTranscript";
import { AgentMessageQueue } from "./AgentMessageQueue";
import { AgentRunError, lastAgentUserTurn } from "./AgentRunError";
import { AgentChanges } from "./AgentChanges";
import { AgentPermissionCard } from "./AgentPermissionCard";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { AgentSessionModes } from "./AgentSessionModes";
import { AgentActivityStatus } from "./AgentActivityStatus";
import { AgentModelPicker } from "./AgentModelPicker";
import { AgentReasoningPicker } from "./AgentReasoningPicker";
import { AgentContextPicker } from "./AgentContextPicker";
import { AgentComposerAdd, AgentComposerOptions } from "./AgentComposerOptions";
import { AgentFileActionsContext } from "./AgentFilePath";
import { AgentPreviewPanel } from "./AgentPreviewPanel";
import { AgentBrowserPreviewPanel } from "./AgentBrowserPreviewPanel";
import {
  AgentPreviewTabStrip,
  type PreviewTabLabel,
} from "./AgentPreviewTabStrip";
import { AgentProjectFilesPanel } from "./AgentProjectFilesPanel";
import { agentTerminalApi } from "@/lib/api/agent-terminal";
import {
  DOCK_DIVIDER_WIDTH,
  DOCK_FILE_STORAGE,
  DOCK_LAYOUT_STORAGE,
  DOCK_PANE_MIN_WIDTH,
  activateDockTab,
  browserDockTab,
  closeDockTab,
  dockOwnerSession,
  emptyDockLayout,
  mergePreviewDock,
  moveDockTab,
  pruneDockTabs,
  readDockFiles,
  readDockLayouts,
  splitPreviewDock,
  writeDockStorage,
  type DockAuxiliaryTab,
  type DockLayout,
  type DockTab,
} from "./agentPreviewDock";
import { useAgentBrowserTabs } from "./useAgentBrowserTabs";
import { AgentUsagePopover } from "./AgentUsagePopover";
import { AgentPaneResizeHandle, useAgentPaneLayout } from "./AgentPaneLayout";
import { useAgentAutoSizeTextarea } from "./useAgentAutoSizeTextarea";
import { WindowControlsContext } from "@/app/shell/AppPageHeader";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE, isWindows } from "@/lib/platform";
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
const AgentTerminalPanel = lazy(() =>
  import("./AgentTerminalPanel").then((module) => ({
    default: module.AgentTerminalPanel,
  })),
);
const WORKSPACE_ORDER_KEY = "lolicode.agent.workspace-order.v1";
const LAST_SELECTION_KEY = "lolicode.agent.last-selection.v1";
const EMPTY_CATALOG: AgentCatalog = {
  revision: 0,
  models: [],
  excludedSources: [],
};
const EMPTY_MESSAGES: AgentSnapshot["messages"] = [];
const EMPTY_NATIVE_ALIASES: Record<string, string> = {};
const EMPTY_QUEUED_MESSAGES: AgentQueuedMessage[] = [];

function nativeUserIdentifiers(event: {
  type: string;
  data: unknown;
}): string[] {
  if (
    event.type !== "user/message" ||
    !event.data ||
    typeof event.data !== "object" ||
    Array.isArray(event.data)
  )
    return [];
  const data = event.data as Record<string, unknown>;
  const source =
    data.source && typeof data.source === "object"
      ? (data.source as Record<string, unknown>)
      : {};
  if (source.kind !== "user") return [];
  return [data.id, source.rpcId].filter(
    (id): id is string => typeof id === "string",
  );
}

function readLastAgentSelection(): {
  projectPath: string;
  sessionId: string | null;
} | null {
  try {
    const saved = JSON.parse(
      localStorage.getItem(LAST_SELECTION_KEY) || "null",
    ) as {
      projectPath?: unknown;
      sessionId?: unknown;
    } | null;
    if (
      typeof saved?.projectPath === "string" &&
      (saved.sessionId === null || typeof saved.sessionId === "string")
    )
      return { projectPath: saved.projectPath, sessionId: saved.sessionId };
  } catch {}
  return null;
}

type QueueEcho = {
  projectPath: string;
  sessionId: string;
  item: AgentQueuedMessage & { confirming: true };
};

function observesQueuedInput(snapshot: AgentSnapshot, requestId: string) {
  return (
    snapshot.queuedMessages?.some((item) => item.id === requestId) ||
    snapshot.messages.some(
      (message) => message.role === "user" && message.id === requestId,
    )
  );
}

function sessionPermissionMode(value?: string): AgentPermissionMode {
  return value === "auto" || value === "full_access" ? value : "ask";
}

function workspacePermission<T extends AgentPermissionMode | undefined>(
  value: T,
  workspace?: AgentWorkspace | null,
): T | "auto" {
  return workspace?.remote && value === "full_access" ? "auto" : value;
}

type PendingSend = {
  requestId: string;
  assistantIds: Set<string>;
  uncertain?: boolean;
  preview?: {
    projectPath: string;
    message: AgentSnapshot["messages"][number];
  };
};
type AgentRetryInput = {
  sourceMessageId: string;
  requestId: string;
  text: string;
  images: AgentImageAttachment[];
  documents: AgentDocumentAttachment[];
};
type WorkbenchPreview = {
  sourceSessionId: string;
  hintKey?: string;
  deliveryKey?: string;
} & (
  | { path: string; line?: number }
  | { browserId: string; url: string; native?: boolean; toolPage: boolean }
);
type SessionPreview = {
  target: WorkbenchPreview;
  request: number;
};

function projectDockKey(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  return isWindows() ? trimmed.toLowerCase() : trimmed;
}

const compareSidebarSessions = (a: AgentSession, b: AgentSession) =>
  Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
  b.updatedAt - a.updatedAt;
// Secretary conversations belong to the top-level entry and its task switcher.
const isWorkspaceTask = (session: AgentSession) =>
  session.coordination?.role !== "secretary" &&
  session.coordination?.role !== "worker";
const matchesSidebarSession = (session: AgentSession, query: string) =>
  !query ||
  session.title.toLocaleLowerCase().includes(query) ||
  session.id.toLocaleLowerCase().includes(query);
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
// The pinned Harness WorkspacePicker uses the shortest distinguishing path suffix.
function workspacePathSuffixes(projects: readonly AgentProject[]) {
  const byName = new Map<string, AgentProject[]>();
  for (const project of projects) {
    const group = byName.get(project.name);
    if (group) group.push(project);
    else byName.set(project.name, [project]);
  }
  const suffixes = new Map<string, string>();
  const suffix = (parts: string[], length: number) =>
    parts.slice(-(2 * length - 1)).join("");
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const rows = group.map(({ path }) => ({
      path,
      parts: path.split(/([\\/])/),
    }));
    for (const row of rows) {
      let length = 1;
      while (2 * length - 1 < row.parts.length) {
        const candidate = suffix(row.parts, length);
        if (
          candidate &&
          !rows.some(
            (peer) => peer !== row && suffix(peer.parts, length) === candidate,
          )
        )
          break;
        length++;
      }
      suffixes.set(row.path, suffix(row.parts, length));
    }
  }
  return suffixes;
}
const isLegacySession = (id: string) =>
  id.startsWith("ses_") || id.startsWith("zc:");
const draftKey = (path: string, id: string) =>
  `lolicode.agent.draft:${encodeURIComponent(path)}:${encodeURIComponent(id)}`;
const retryDraftPrefix = (key: string) => `${key}:retry:`;
const retrySourceId = (entry: AgentSubmission | null) => {
  if (!entry) return undefined;
  const prefix = retryDraftPrefix(draftKey(entry.projectPath, entry.sessionId));
  return entry.draft.key.startsWith(prefix)
    ? entry.draft.key.slice(prefix.length)
    : undefined;
};
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
      if (uncertain && !entry.stopRequested) restoreAgentDraft(entry.draft);
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
  isActive?: boolean;
  sidebarCompact?: boolean;
  onSidebarCompactChange?: (compact: boolean) => void;
  onPreviewVisibilityChange?: (visible: boolean) => void;
  sharedPaneLayout?: ReturnType<typeof useAgentPaneLayout>;
  sidebarToggleRef?: MutableRefObject<(() => void) | null>;
  renderSidebar?: (content: {
    actions: ReactNode;
    workspace: ReactNode;
    onCollapse: () => void;
    compact?: boolean;
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
  isActive = true,
  sidebarCompact = false,
  onSidebarCompactChange,
  onPreviewVisibilityChange,
  sharedPaneLayout,
  sidebarToggleRef,
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
  const displayName = account?.displayName || account?.username;
  const avatarUrl = account?.avatarUrl || undefined;
  const userIdentity = useMemo(
    () => (displayName || avatarUrl ? { displayName, avatarUrl } : undefined),
    [displayName, avatarUrl],
  );
  const secretaryRequestRef = useRef(secretaryRequest);
  secretaryRequestRef.current = secretaryRequest;
  const consumedSecretaryRequest = useRef<number | null>(null);
  const openingSecretaryRequest = useRef<number | null>(null);
  const secretaryNavigation = useRef(0);
  const [secretaryRequestRevision, setSecretaryRequestRevision] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [compactSessionsOpen, setCompactSessionsOpen] = useState(false);
  const [sidebarDialogCount, setSidebarDialogCount] = useState(0);
  const onSidebarDialogOpenChange = useCallback((open: boolean) => {
    setSidebarDialogCount((count) => Math.max(0, count + (open ? 1 : -1)));
  }, []);
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
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>();
  const [sessionOverrides, setSessionOverrides] = useState<
    Record<string, AgentSession>
  >({});
  const overridesRef = useRef(sessionOverrides);
  overridesRef.current = sessionOverrides;
  const overrideFields = useRef<Record<string, (keyof AgentSession)[]>>({});
  const sessionTitles = useRef(
    new Map<string, Pick<AgentSession, "title" | "updatedAt">>(),
  );
  const withCommittedTitle = useCallback((session: AgentSession) => {
    const committed = sessionTitles.current.get(session.id);
    return committed &&
      session.updatedAt <= committed.updatedAt &&
      session.title !== committed.title
      ? { ...session, title: committed.title }
      : session;
  }, []);
  const [engine, setEngine] = useState<AgentEngineStatus | null>(null);
  const [initializing, setInitializing] = useState(true);
  const hasExplicitStartupTarget = useRef(false);
  hasExplicitStartupTarget.current = Boolean(
    initialProjectPath ||
      secretaryRequest?.projectPath ||
      secretaryRequest?.sessionId ||
      secretaryRequest?.workerSessionId,
  );
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
  const identity = `${workspace?.path || ""}\0${sessionId || ""}`;
  const selection = useRef({ identity: "", revision: 0 });
  if (selection.current.identity !== identity)
    selection.current = { identity, revision: selection.current.revision + 1 };
  const mounted = useRef(true);
  const [modelId, setModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [contextLimit, setContextLimit] = useState<number | null>(null);
  const [previews, setPreviews] = useState<Record<string, SessionPreview>>(() =>
    Object.fromEntries(
      Object.entries(readDockFiles()).map(([owner, target]) => [
        owner,
        {
          target: { ...target, sourceSessionId: dockOwnerSession(owner)! },
          request: 0,
        },
      ]),
    ),
  );
  const [dockLayouts, setDockLayouts] = useState(readDockLayouts);
  const dockResources = useRef({ dockLayouts, previews });
  dockResources.current = { dockLayouts, previews };
  const updateDock = useCallback(
    (owner: string, update: (layout: DockLayout) => DockLayout) => {
      setDockLayouts((old) => {
        const previous = old[owner] ?? emptyDockLayout();
        const next = update(previous);
        return previous === next ? old : { ...old, [owner]: next };
      });
    },
    [],
  );
  useEffect(
    () => writeDockStorage(DOCK_LAYOUT_STORAGE, dockLayouts),
    [dockLayouts],
  );
  useEffect(() => {
    writeDockStorage(
      DOCK_FILE_STORAGE,
      Object.fromEntries(
        Object.entries(previews).flatMap(([owner, { target }]) =>
          "path" in target && target.sourceSessionId === dockOwnerSession(owner)
            ? [[owner, { path: target.path, line: target.line }]]
            : [],
        ),
      ),
    );
  }, [previews]);
  const dockId = useId();
  const dockElement = useRef<HTMLDivElement>(null);
  const {
    decks: browserDecks,
    open: openBrowserTab,
    navigate: navigateBrowserTab,
    close: closeBrowserTab,
    removeOwners: removeBrowserTabs,
    onClosed: onBrowserTabClosed,
  } = useAgentBrowserTabs();
  const browserDeck = browserDecks[identity];
  const currentPreview = previews[identity];
  const savedDock = dockLayouts[identity] ?? emptyDockLayout();
  const availableTabs = savedDock.panes.flatMap(({ tabs }) =>
    tabs.filter(
      (tab): tab is DockAuxiliaryTab => tab === "files" || tab === "terminal",
    ),
  );
  const dock = pruneDockTabs(savedDock, [
    ...availableTabs,
    ...(currentPreview ? ["preview" as const] : []),
    ...(browserDeck?.tabs.map(({ id }) => browserDockTab(id)) ?? []),
  ]);
  const canOpenBrowser = Boolean(sessionId && isWindows());
  const hasPreview = dock.panes.some(({ tabs }) => tabs.length > 0);
  const previewVisible = hasPreview && !dock.folded;
  useLayoutEffect(() => {
    onPreviewVisibilityChange?.(previewVisible);
  }, [onPreviewVisibilityChange, previewVisible]);
  // Keep the current pane and recent background panes mounted, with a bound on
  // retained document renderers. Older panes can reopen from their saved paths.
  const retainedPreviews = Object.entries(previews)
    .filter(([owner, { request }]) => owner !== identity && request > 0)
    .slice(currentPreview ? -2 : -3);
  if (currentPreview) retainedPreviews.push([identity, currentPreview]);
  const setPreviewFolded = useCallback(
    (folded: boolean) =>
      updateDock(identity, (old) =>
        old.folded === folded ? old : { ...old, folded },
      ),
    [identity, updateDock],
  );
  const openWebPreview = useCallback(
    (url?: string, pane?: 0 | 1) => {
      if (!sessionId) return;
      const id = openBrowserTab(identity, sessionId, url);
      if (id !== undefined)
        updateDock(identity, (layout) =>
          activateDockTab(layout, browserDockTab(id), pane),
        );
    },
    [openBrowserTab, identity, sessionId, updateDock],
  );
  const selectDockTab = useCallback(
    (owner: string, tab: DockTab, pane?: 0 | 1) =>
      updateDock(owner, (layout) => activateDockTab(layout, tab, pane)),
    [updateDock],
  );
  const dismissDockTab = useCallback(
    (owner: string, tab: DockTab) =>
      updateDock(owner, (layout) => closeDockTab(layout, tab)),
    [updateDock],
  );
  const closeManualBrowser = useCallback(
    (owner: string, id: number) => {
      dismissDockTab(owner, browserDockTab(id));
      closeBrowserTab(id);
    },
    [closeBrowserTab, dismissDockTab],
  );
  const closeAuxiliaryTab = useCallback(
    (owner: string, tab: DockAuxiliaryTab) => {
      dismissDockTab(owner, tab);
      const ownerSession = dockOwnerSession(owner);
      if (tab === "terminal" && ownerSession) {
        void agentTerminalApi
          .close(ownerSession, `${ownerSession}:terminal`)
          .catch((cause) => toast.error(agentErrorMessage(cause)));
      }
    },
    [dismissDockTab],
  );
  const clearDockOwners = useCallback(
    (matches: (owner: string) => boolean) => {
      const current = dockResources.current;
      removeBrowserTabs(matches);
      for (const [owner, layout] of Object.entries(current.dockLayouts)) {
        if (
          matches(owner) &&
          layout.panes.some(({ tabs }) => tabs.includes("terminal"))
        )
          closeAuxiliaryTab(owner, "terminal");
      }
      for (const [owner, { target }] of Object.entries(current.previews)) {
        if (matches(owner) && "browserId" in target) {
          void agentFilesApi
            .closeBrowser(target.sourceSessionId, target.browserId)
            .catch((cause) => toast.error(agentErrorMessage(cause)));
        }
      }
      setDockLayouts((old) =>
        Object.fromEntries(
          Object.entries(old).filter(([owner]) => !matches(owner)),
        ),
      );
      setPreviews((old) =>
        Object.fromEntries(
          Object.entries(old).filter(([owner]) => !matches(owner)),
        ),
      );
    },
    [closeAuxiliaryTab, removeBrowserTabs],
  );
  const openPreview = useCallback(
    (path: string, line?: number) => {
      if (!sessionId) return;
      selectDockTab(identity, "preview");
      setPreviews((old) => ({
        ...old,
        [identity]: {
          target: { sourceSessionId: sessionId, path, line },
          request: (old[identity]?.request ?? 0) + 1,
        },
      }));
    },
    [selectDockTab, identity, sessionId],
  );
  const navigatePreview = useCallback((owner: string, path: string) => {
    setPreviews((old) => {
      const current = old[owner];
      if (
        !current ||
        !("path" in current.target) ||
        current.target.path === path
      )
        return old;
      return {
        ...old,
        [owner]: {
          ...current,
          target: { ...current.target, path, line: undefined },
        },
      };
    });
  }, []);
  const fileActions = useMemo(
    () => ({
      sessionId: sessionId || undefined,
      projectPath: workspace?.path,
      remote: Boolean(workspace?.remote),
      onPreview: openPreview,
      onOpenWeb: canOpenBrowser ? openWebPreview : undefined,
    }),
    [
      sessionId,
      workspace?.path,
      workspace?.remote,
      openPreview,
      openWebPreview,
      canOpenBrowser,
    ],
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
  const [queueEchoes, setQueueEchoes] = useState<QueueEcho[]>([]);
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [pendingTitles, setPendingTitles] = useState<Record<string, boolean>>(
    {},
  );
  const removedSessions = useRef(new Set<string>());
  const [refresh, setRefresh] = useState(0);
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
  const chatContentRef = useRef<HTMLDivElement>(null);
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
  const attachmentLoadAttempts = useRef(new Set<string>());
  const pendingImageRestoreAttempts = useRef(new Set<string>());
  const pendingDocumentRestoreAttempts = useRef(new Set<string>());
  const queueAttachmentRestoreAttempts = useRef(new Set<string>());
  const taskProgressId = useId();
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const atBottom = useRef(true);
  const readingSession = useRef<string | null>(null);
  const readingPositions = useRef(new Map<string, number>());
  const forgetTranscriptPosition = useCallback((key: string) => {
    readingPositions.current.delete(key);
  }, []);
  useLayoutEffect(() => {
    // The empty workspace branch unmounts every retained history window.
    // Its pixel bookmarks cannot be applied to a fresh recent-history window.
    if (!workspace || !sessionId) readingPositions.current.clear();
  }, [workspace, sessionId]);
  const followedScrollTop = useRef(0);
  const smoothChatTarget = useRef<number | null>(null);
  const followAfterCommit = useRef<string | null>(null);
  const pinChatTail = () => {
    readingPositions.current.delete(identity);
    atBottom.current = true;
    setShowScrollToBottom(false);
    const scroll = scrollRef.current;
    if (scroll) scroll.dataset.followTail = "true";
  };
  const followSubmittedChat = () => {
    pinChatTail();
    followAfterCommit.current = identity;
  };
  const jumpToChatTail = useCallback((scroll: HTMLDivElement) => {
    smoothChatTarget.current = null;
    scroll.scrollTop = scroll.scrollHeight;
    followedScrollTop.current = scroll.scrollTop;
  }, []);
  const preserveEarlierHistory = useCallback(() => {
    atBottom.current = false;
    smoothChatTarget.current = null;
    if (scrollRef.current) scrollRef.current.dataset.followTail = "false";
    setShowScrollToBottom(true);
  }, []);
  const updateChatReadingPosition = useCallback(() => {
    const scroll = scrollRef.current;
    if (!isActive || !scroll || readingSession.current !== identity) return;
    const floor = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const top = scroll.scrollTop;
    const reachedTail = top >= floor - 2;
    if (smoothChatTarget.current !== null) {
      if (reachedTail) {
        smoothChatTarget.current = null;
        followedScrollTop.current = top;
      }
      return;
    }
    // A browser scroll event can arrive after the content or viewport resized.
    // The old floor still means follow unless the reader actually moved up.
    if (
      atBottom.current &&
      !reachedTail &&
      top >= Math.min(followedScrollTop.current, floor) - 1
    )
      return;
    atBottom.current = reachedTail;
    scroll.dataset.followTail = String(reachedTail);
    if (reachedTail) {
      followedScrollTop.current = top;
      readingPositions.current.delete(identity);
    } else readingPositions.current.set(identity, top);
    setShowScrollToBottom(!reachedTail);
  }, [identity, isActive]);
  const stopSmoothChatScroll = () => {
    const scroll = scrollRef.current;
    if (!scroll || smoothChatTarget.current === null) return;
    smoothChatTarget.current = null;
    followedScrollTop.current = scroll.scrollTop;
    scroll.scrollTo({ top: scroll.scrollTop, behavior: "instant" });
  };
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
      const saved = readLastAgentSelection();
      const savedProject = knownProjects.find(
        (project) => project.path === saved?.projectPath,
      );
      let restored: AgentProjectResult | undefined;
      if (status.running && status.projectPath) {
        const [nextCatalog, nextSessions] = await Promise.all([
          agentApi.getCatalog(),
          agentApi.listSessions(),
        ]);
        const selectedProject = knownProjects.find(
          (project) => project.path === status.projectPath,
        );
        restored = {
          workspace: {
            path: status.projectPath,
            name: selectedProject?.name || nameOf(status.projectPath),
            standalone: selectedProject?.standalone,
            remote: selectedProject?.remote,
          },
          catalog: nextCatalog,
          sessions: nextSessions,
        };
      } else if (
        status.available &&
        savedProject &&
        !hasExplicitStartupTarget.current
      ) {
        restored = await agentApi.openProject(savedProject.path);
        if (hasExplicitStartupTarget.current) return;
      }
      if (
        !restored ||
        !mounted.current ||
        generation.current !== requestGeneration
      )
        return;
      const {
        workspace: restoredWorkspace,
        catalog: restoredCatalog,
        sessions: restoredSessions,
      } = restored;
      const savedSession =
        saved?.projectPath === restoredWorkspace.path
          ? restoredSessions.find(
              (session) =>
                session.id === saved.sessionId &&
                !session.archived &&
                (session.coordination?.role !== "secretary" ||
                  restoredWorkspace.standalone),
            )
          : undefined;
      restored.warnings?.forEach((warning) => toast.warning(warning));
      setWorkspace(restoredWorkspace);
      setEngine({
        ...status,
        running: true,
        projectPath: restoredWorkspace.path,
      });
      bindCatalog(restoredCatalog);
      setSessions(restoredSessions);
      discoverSessionActivity(restoredSessions);
      setPending(restorePending(restoredWorkspace.path, restoredSessions));
      setStopping(restoreStopping(restoredWorkspace.path, restoredSessions));
      setSessionId(
        savedSession?.id ||
          restoredSessions.find(
            (item) => !item.archived && isWorkspaceTask(item),
          )?.id ||
          null,
      );
      if (!restoredWorkspace.standalone)
        rememberProject(restoredWorkspace.path);
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
  const selectedProjectPath = workspace?.path;
  useEffect(() => {
    if (initializing || !selectedProjectPath) return;
    try {
      localStorage.setItem(
        LAST_SELECTION_KEY,
        JSON.stringify({ projectPath: selectedProjectPath, sessionId }),
      );
    } catch {}
  }, [initializing, selectedProjectPath, sessionId]);
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
  const updateSessionRows = useCallback(
    (
      { id, projectPath }: Pick<AgentSession, "id" | "projectPath">,
      update: (current: AgentSession) => AgentSession,
    ) => {
      const replace = (items: AgentSession[]) => {
        const index = items.findIndex((session) => session.id === id);
        if (index < 0) return items;
        const current = items[index];
        const next = update(current);
        if (
          next === current ||
          JSON.stringify(next) === JSON.stringify(current)
        )
          return items;
        const sessions = [...items];
        sessions[index] = next;
        return sessions;
      };
      setSessions(replace);
      setWorkspaceSessions((old) => {
        const items = old[projectPath];
        if (!items) return old;
        const next = replace(items);
        return next === items ? old : { ...old, [projectPath]: next };
      });
    },
    [],
  );
  const onSnapshot = useCallback(
    (next: AgentSnapshot) => {
      if (!mounted.current) return;
      const id = next.session.id;
      if (removedSessions.current.has(id)) return;
      const queueEntry = readAgentQueueSubmission(next.session.projectPath, id);
      if (queueEntry && observesQueuedInput(next, queueEntry.requestId)) {
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
        // A title commit can overtake an already-running background read.
        const committed = sessionTitles.current.get(id);
        const session = withCommittedTitle(next.session);
        if (committed && next.session.updatedAt > committed.updatedAt)
          sessionTitles.current.delete(id);
        updateSessionRows(session, (current) =>
          current.updatedAt > session.updatedAt ? current : session,
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
                restoreAgentDraft(current.draft);
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
              const previousPending = pendingRef.current[id];
              const queued = {
                requestId: current.requestId,
                assistantIds: new Set(current.assistantIds),
                uncertain: !accepted,
                preview:
                  previousPending?.requestId === current.requestId
                    ? previousPending.preview
                    : undefined,
              };
              pendingRef.current = { ...pendingRef.current, [id]: queued };
              setPending(pendingRef.current);
              storePending(next.session.projectPath, id, queued);
              if (!accepted) {
                // Unknown is not evidence of cancellation or rejection. Keep the
                // original identity and let a user retry the exact same input.
                if (
                  !current.stopRequested &&
                  restoreAgentDraft(current.draft)
                ) {
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
    [acceptQueuedDraft, updateSessionRows, withCommittedTitle],
  );
  useTauriEvent<{
    type: "changed" | "tail";
    sessionId: string;
    projectPath?: string;
    title?: string;
    updatedAt?: number;
  }>(
    "agent-session-update",
    ({ type, sessionId, projectPath, title, updatedAt }) => {
      if (
        type !== "changed" ||
        !projectPath ||
        !title ||
        typeof updatedAt !== "number" ||
        removedSessions.current.has(sessionId) ||
        overrideFields.current[sessionId]?.includes("title")
      )
        return;
      const previous = sessionTitles.current.get(sessionId);
      if (previous && previous.updatedAt >= updatedAt) return;
      sessionTitles.current.set(sessionId, { title, updatedAt });
      updateSessionRows({ id: sessionId, projectPath }, (session) =>
        session.updatedAt > updatedAt || session.title === title
          ? session
          : { ...session, title },
      );
    },
    "main",
  );
  const [compatibilityHistories, setCompatibilityHistories] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const usesNativeTranscript = Boolean(
    sessionId?.startsWith("lc:") && !compatibilityHistories.has(sessionId),
  );
  const {
    snapshot,
    error: snapshotError,
    loading: snapshotLoading,
    prefetch: prefetchSession,
    preparedSnapshots,
  } = useAgentSnapshot(sessionId, {
    fast: Boolean(sessionId && (pending[sessionId] || stopping[sessionId])),
    refresh,
    onSnapshot,
    nativeTranscript: usesNativeTranscript,
  });
  const nativeSession = useAgentNativeSession(
    usesNativeTranscript ? sessionId : null,
    {
      enabled: isActive,
      activityRevision: `${snapshot?.status ?? ""}:${snapshot?.messages.length ?? 0}:${refresh}:${Boolean(sessionId && pending[sessionId])}`,
    },
  );
  const nativeSessionRef = useRef(nativeSession);
  nativeSessionRef.current = nativeSession;
  const loadNativeEarlier = useCallback(() => {
    void nativeSessionRef.current.loadOlder();
  }, []);
  const nativeTranscript = useMemo(
    () =>
      usesNativeTranscript
        ? {
            events: nativeSession.events,
            activeAttempt: nativeSession.activeAttempt ?? undefined,
            hasMore: nativeSession.hasMore,
            loadingEarlier: nativeSession.loading,
            onLoadOlder: loadNativeEarlier,
          }
        : undefined,
    [
      usesNativeTranscript,
      nativeSession.events,
      nativeSession.activeAttempt,
      nativeSession.hasMore,
      nativeSession.loading,
      loadNativeEarlier,
    ],
  );
  const [nativeAliases, setNativeAliases] = useState<{
    sessionId: string | null;
    values: Record<string, string>;
  }>({ sessionId: null, values: {} });
  const [nativeAliasRevision, setNativeAliasRevision] = useState(0);
  useTauriEvent<{ sessionId: string }>(
    "agent-native-message-aliases-changed",
    (event) => {
      if (event.sessionId === sessionId)
        setNativeAliasRevision((revision) => revision + 1);
    },
    "main",
  );
  const nativeUserRevision = useMemo(
    () => nativeSession.events.flatMap(nativeUserIdentifiers).join("\0"),
    [nativeSession.events],
  );
  useEffect(() => {
    if (!usesNativeTranscript || !sessionId || !snapshot) return;
    let stale = false;
    void agentApi
      .readNativeMessageAliases(sessionId)
      .then((values) => {
        if (!stale) setNativeAliases({ sessionId, values });
      })
      .catch((cause) => {
        if (
          !stale &&
          agentErrorMessage(cause) === "LOLICODE_SESSION_LEGACY_HISTORY"
        ) {
          setCompatibilityHistories(
            (current) => new Set([...current, sessionId]),
          );
        }
      });
    return () => {
      stale = true;
    };
  }, [
    usesNativeTranscript,
    sessionId,
    snapshot?.messages.length,
    snapshot?.status,
    nativeUserRevision,
    nativeAliasRevision,
  ]);
  const nativeMessageAliases =
    nativeAliases.sessionId === sessionId
      ? nativeAliases.values
      : (nativeSession.read?.messageAliases ?? EMPTY_NATIVE_ALIASES);
  const durableMessages = snapshot?.messages || EMPTY_MESSAGES;
  const pendingSend = sessionId ? pending[sessionId] : undefined;
  const outgoingPreview = pendingSend?.uncertain
    ? undefined
    : pendingSend?.preview;
  const outgoingMessage =
    snapshot &&
    outgoingPreview &&
    outgoingPreview.projectPath === workspace?.path
      ? outgoingPreview.message
      : undefined;
  const nativeSendEchoes = useRef(
    new Map<string, Map<string, AgentSnapshot["messages"][number]>>(),
  );
  const transcriptMessages = useMemo(() => {
    const containsUser = (id: string) =>
      usesNativeTranscript
        ? nativeSession.events.some((event) =>
            nativeUserIdentifiers(event).some(
              (nativeId) =>
                nativeId === id || nativeMessageAliases[nativeId] === id,
            ),
          )
        : durableMessages.some(
            (message) => message.role === "user" && message.id === id,
          );
    const pendingMessages =
      outgoingMessage && !containsUser(outgoingMessage.id)
        ? [outgoingMessage]
        : [];
    if (snapshot) {
      const steering = new Map<string, AgentQueuedMessage>();
      if (activeStatus(snapshot.status)) {
        for (const item of snapshot.queuedMessages ?? [])
          if (item.delivery === "steer") steering.set(item.id, item);
      }
      for (const echo of queueEchoes) {
        if (
          echo.item.delivery === "steer" &&
          echo.projectPath === snapshot.session.projectPath &&
          echo.sessionId === snapshot.session.id &&
          !observesQueuedInput(snapshot, echo.item.id)
        ) {
          steering.set(echo.item.id, echo.item);
        }
      }
      for (const item of steering.values()) {
        if (!containsUser(item.id))
          pendingMessages.push({
            id: item.id,
            role: "user",
            createdAt: item.createdAt ?? 0,
            parts: item.text ? [{ type: "text", text: item.text }] : [],
          });
      }
    }
    if (usesNativeTranscript) {
      const lane =
        nativeSendEchoes.current.get(identity) ??
        new Map<string, AgentSnapshot["messages"][number]>();
      nativeSendEchoes.current.delete(identity);
      nativeSendEchoes.current.set(identity, lane);
      while (nativeSendEchoes.current.size > 3)
        nativeSendEchoes.current.delete(
          nativeSendEchoes.current.keys().next().value!,
        );
      for (const message of pendingMessages) lane.set(message.id, message);
      for (const [id] of lane) {
        const local = pendingMessages.some((message) => message.id === id);
        // A desktop receipt may precede the native stream. Retain only the
        // original local send echo until its exact native identity arrives.
        const admitted = durableMessages.some(
          (message) => message.role === "user" && message.id === id,
        );
        if (containsUser(id) || (!local && !admitted)) lane.delete(id);
      }
      return lane.size ? [...lane.values()] : EMPTY_MESSAGES;
    }
    return pendingMessages.length
      ? [...(usesNativeTranscript ? [] : durableMessages), ...pendingMessages]
      : usesNativeTranscript
        ? EMPTY_MESSAGES
        : durableMessages;
  }, [
    durableMessages,
    outgoingMessage,
    queueEchoes,
    snapshot,
    usesNativeTranscript,
    nativeSession.events,
    nativeMessageAliases,
    identity,
  ]);
  const hasChatContent =
    Boolean(
      nativeTranscript &&
        hasNativeTranscriptContent(
          nativeTranscript.events,
          nativeTranscript.activeAttempt,
        ),
    ) || transcriptMessages.length > 0;
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  const displayedQueue = useMemo(() => {
    const messages = snapshot?.queuedMessages ?? EMPTY_QUEUED_MESSAGES;
    const nativeItems =
      snapshot &&
      activeStatus(snapshot.status) &&
      messages.some((item) => item.delivery === "steer")
        ? messages.filter((item) => item.delivery !== "steer")
        : messages;
    if (!snapshot || !queueEchoes.length) return nativeItems;
    const pendingItems = queueEchoes
      .filter(
        (echo) =>
          echo.item.delivery !== "steer" &&
          echo.projectPath === snapshot.session.projectPath &&
          echo.sessionId === snapshot.session.id &&
          !observesQueuedInput(snapshot, echo.item.id),
      )
      .map((echo) => echo.item);
    return pendingItems.length
      ? [...nativeItems, ...pendingItems]
      : nativeItems;
  }, [queueEchoes, snapshot]);
  useEffect(() => {
    if (!snapshot || !queueEchoes.length) return;
    setQueueEchoes((current) => {
      if (!current.length) return current;
      const remaining = current.filter(
        (echo) =>
          echo.projectPath !== snapshot.session.projectPath ||
          echo.sessionId !== snapshot.session.id ||
          !observesQueuedInput(snapshot, echo.item.id),
      );
      return remaining.length === current.length ? current : remaining;
    });
  }, [queueEchoes.length, snapshot]);
  const uncertainSubmission =
    sessionId && workspace && pending[sessionId]?.uncertain
      ? readAgentSubmission(workspace.path, sessionId)
      : null;
  const uncertainRetrySource = retrySourceId(uncertainSubmission);
  const observedPreviews = useRef(
    new Map<
      string,
      {
        latestKey?: string;
        closedBrowserKey?: string;
        newestAt: number;
        seen: Set<string>;
      }
    >(),
  );
  const dismissedPreviews = useRef(new Map<string, Set<string>>());
  const closedBrowserPreviews = useRef(new Set<string>());
  useTauriEvent<{ sessionId: string; browserId: string }>(
    "agent-browser-preview-closed",
    ({ sessionId, browserId }) => {
      const closedTab = onBrowserTabClosed(sessionId, browserId);
      if (closedTab) {
        dismissDockTab(closedTab.owner, browserDockTab(closedTab.id));
        return;
      }
      const key = JSON.stringify([sessionId, browserId]);
      closedBrowserPreviews.current.add(key);
      const matches = (target: WorkbenchPreview) =>
        "browserId" in target &&
        target.sourceSessionId === sessionId &&
        target.browserId === browserId;
      for (const [owner, { target }] of Object.entries(previews)) {
        if (!matches(target)) continue;
        const observed = observedPreviews.current.get(owner);
        if (observed) observed.closedBrowserKey = target.hintKey;
        dismissDockTab(owner, "preview");
      }
      setPreviews((old) => {
        const remaining = Object.entries(old).filter(
          ([, { target }]) => !matches(target),
        );
        return remaining.length === Object.keys(old).length
          ? old
          : Object.fromEntries(remaining);
      });
    },
  );
  const closePreview = useCallback(
    (owner: string, target: WorkbenchPreview) => {
      dismissDockTab(owner, "preview");
      if (target.deliveryKey) {
        const dismissed = dismissedPreviews.current.get(owner) ?? new Set();
        dismissed.add(target.deliveryKey);
        dismissedPreviews.current.set(owner, dismissed);
      }
      setPreviews((old) => {
        const next = { ...old };
        delete next[owner];
        return next;
      });
      if ("browserId" in target) {
        void agentFilesApi
          .closeBrowser(target.sourceSessionId, target.browserId)
          .catch((cause) => toast.error(agentErrorMessage(cause)));
      }
    },
    [dismissDockTab],
  );
  const sessionPreviewTarget = previews[identity]?.target;
  useEffect(() => {
    if (
      !sessionId ||
      snapshot?.session.id !== sessionId ||
      snapshot.session.projectPath !== workspace?.path
    )
      return;
    const hint = snapshot.preview;
    const key = hint ? JSON.stringify([hint.sessionId, hint.id]) : undefined;
    const observed = observedPreviews.current.get(identity);
    if (!observed) {
      // Establish the first baseline without reopening historical previews.
      observedPreviews.current.set(identity, {
        latestKey: key,
        newestAt: hint?.createdAt ?? 0,
        seen: new Set(key ? [key] : []),
      });
      return;
    }
    if (key === observed.latestKey) return;
    const wasShowingBrowser = Boolean(
      observed.latestKey &&
        (observed.closedBrowserKey === observed.latestKey ||
          (sessionPreviewTarget &&
            "browserId" in sessionPreviewTarget &&
            sessionPreviewTarget.hintKey === observed.latestKey)),
    );
    observed.latestKey = key;
    if (hint && key) {
      const deliveryKey = JSON.stringify([
        hint.sessionId,
        hint.kind === "browser" ? (hint.deliveryId ?? hint.id) : hint.id,
      ]);
      const fresh =
        !observed.seen.has(key) && hint.createdAt >= observed.newestAt;
      const browserClosed =
        hint.kind === "browser" &&
        closedBrowserPreviews.current.has(
          JSON.stringify([hint.sessionId, hint.browserId]),
        );
      observed.seen.add(key);
      observed.newestAt = Math.max(observed.newestAt, hint.createdAt);
      // Once a browser closes, an older file may again be the latest preview.
      if (
        !browserClosed &&
        !dismissedPreviews.current.get(identity)?.has(deliveryKey) &&
        (fresh || (wasShowingBrowser && hint.kind === "file"))
      ) {
        const target =
          hint.kind === "browser"
            ? {
                browserId: hint.browserId,
                url: hint.url,
                native: hint.native,
                toolPage: hint.deliveryId === undefined,
              }
            : {
                path:
                  hint.path +
                  (hint.locator === undefined
                    ? ""
                    : `#${encodeURIComponent(hint.locator)}`),
              };
        updateDock(identity, (layout) =>
          activateDockTab(layout, "preview", layout.focused, false),
        );
        setPreviews((old) => ({
          ...old,
          [identity]: {
            target: {
              ...target,
              sourceSessionId: hint.sessionId,
              hintKey: key,
              deliveryKey,
            },
            request: (old[identity]?.request ?? 0) + 1,
          },
        }));
      }
    }
  }, [
    identity,
    sessionId,
    snapshot,
    workspace?.path,
    sessionPreviewTarget,
    updateDock,
  ]);
  useEffect(() => {
    const requestIds = new Set<string>();
    const acceptAttachmentId = (id: string) => {
      if (!id || attachmentLoadAttempts.current.has(id)) return;
      if (sentImageAttachments[id] && sentDocumentAttachments[id]) return;
      requestIds.add(id);
      attachmentLoadAttempts.current.add(id);
    };
    if (usesNativeTranscript)
      for (const event of nativeSession.events) {
        for (const nativeId of nativeUserIdentifiers(event)) {
          acceptAttachmentId(nativeId);
          if (nativeMessageAliases[nativeId])
            acceptAttachmentId(nativeMessageAliases[nativeId]);
        }
      }
    for (const message of transcriptMessages) {
      const { id, role } = message;
      if (role === "user") acceptAttachmentId(id);
    }
    if (!requestIds.size) return;
    void readAgentHistoryAttachments(requestIds)
      .then((records) => {
        if (!mounted.current || !records.length) return;
        setSentImageAttachments((old) => {
          let next = old;
          for (const { requestId, attachments } of records) {
            if (old[requestId] || !attachments?.length) continue;
            if (next === old) next = { ...old };
            next[requestId] = attachments;
          }
          return next;
        });
        setSentDocumentAttachments((old) => {
          let next = old;
          for (const { requestId, documents } of records) {
            if (old[requestId] || !documents?.length) continue;
            if (next === old) next = { ...old };
            next[requestId] = documents;
          }
          return next;
        });
      })
      .catch(() => {});
  }, [
    sentDocumentAttachments,
    sentImageAttachments,
    transcriptMessages,
    usesNativeTranscript,
    nativeSession.events,
    nativeMessageAliases,
  ]);
  useEffect(() => {
    const id = sessionId;
    const unresolved = id ? pending[id] : undefined;
    const restoreKey = unresolved ? `${id}:${unresolved.requestId}` : "";
    if (
      !id ||
      !unresolved?.uncertain ||
      uncertainRetrySource ||
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
  }, [pending, sessionId, uncertainRetrySource]);
  useEffect(() => {
    const id = sessionId;
    const unresolved = id ? pending[id] : undefined;
    const restoreKey = unresolved ? `${id}:${unresolved.requestId}` : "";
    if (
      !id ||
      !unresolved?.uncertain ||
      uncertainRetrySource ||
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
  }, [pending, sessionId, uncertainRetrySource]);

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
  const chatReady = Boolean(snapshot);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!chatReady || !scroll) {
      readingSession.current = null;
      return;
    }
    // Mode changes preserve the same scroll element at its original width.
    // Only a different conversation needs a synchronous position restore.
    if (!isActive || readingSession.current === identity) return;
    readingSession.current = identity;
    const position = readingPositions.current.get(identity);
    atBottom.current = position === undefined;
    scroll.dataset.followTail = String(atBottom.current);
    setShowScrollToBottom(!atBottom.current);
    smoothChatTarget.current = null;
    if (position === undefined) jumpToChatTail(scroll);
    else scroll.scrollTop = position;
  }, [isActive, chatReady, identity, jumpToChatTail]);
  useLayoutEffect(() => {
    const requested = followAfterCommit.current;
    if (requested === null) return;
    followAfterCommit.current = null;
    const scroll = scrollRef.current;
    if (requested === identity && scroll && readingSession.current === identity)
      jumpToChatTail(scroll);
  });
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = chatContentRef.current;
    if (!isActive || !chatReady || !scroll || !content) return;
    const settleSmoothScroll = () => {
      if (smoothChatTarget.current === null) return;
      followedScrollTop.current = smoothChatTarget.current;
      smoothChatTarget.current = null;
      updateChatReadingPosition();
    };
    scroll.addEventListener("scrollend", settleSmoothScroll);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            const floor = Math.max(
              0,
              scroll.scrollHeight - scroll.clientHeight,
            );
            if (
              readingSession.current === identity &&
              atBottom.current &&
              floor !== smoothChatTarget.current
            )
              jumpToChatTail(scroll);
          });
    observer?.observe(scroll);
    observer?.observe(content);
    return () => {
      scroll.removeEventListener("scrollend", settleSmoothScroll);
      observer?.disconnect();
    };
  }, [
    isActive,
    chatReady,
    identity,
    jumpToChatTail,
    updateChatReadingPosition,
  ]);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (
      isActive &&
      typeof ResizeObserver === "undefined" &&
      scroll &&
      atBottom.current
    )
      jumpToChatTail(scroll);
  }, [
    isActive,
    snapshot,
    transcriptMessages,
    nativeSession.events,
    nativeSession.activeAttempt,
    jumpToChatTail,
  ]);

  const working =
    Object.values(statuses).some(activeStatus) ||
    Object.keys(pending).length > 0 ||
    Object.keys(stopping).length > 0;
  const listedSession = sessions.find((session) => session.id === sessionId);
  const selectedOverride = sessionId ? sessionOverrides[sessionId] : undefined;
  const selectedSession =
    selectedOverride || snapshot?.session || listedSession;
  const selectedTitle =
    (listedSession && withCommittedTitle(listedSession).title) ||
    selectedOverride?.title ||
    snapshot?.session.title ||
    "编程工作台";
  const readOnlySession = Boolean(sessionId && isLegacySession(sessionId));
  const isSecretaryWorker = selectedSession?.coordination?.role === "worker";
  const workerPermissionLocked =
    isSecretaryWorker && selectedSession?.coordination?.permissionLocked;
  const selectedPermissionMode = workspacePermission(
    sessionPermissionMode(selectedSession?.permissionMode),
    workspace,
  );
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
  const localPaneLayout = useAgentPaneLayout({
    isActive: isActive && !sharedPaneLayout,
    sidebarVisible: !sidebarCollapsed,
    sidebarCompact,
    sidebarAutoCompact: Boolean(onSidebarCompactChange),
    previewVisible,
  });
  const paneLayout = sharedPaneLayout ?? localPaneLayout;
  const [sidebarWorkspaceCompact, setSidebarWorkspaceCompact] = useState(
    paneLayout.sidebarCompact,
  );
  // Moving the tree into/out of the popover remounts its menu dialogs. Defer
  // only that move while a dialog is open; the panes may still resize normally.
  useLayoutEffect(() => {
    if (sidebarDialogCount === 0)
      setSidebarWorkspaceCompact(paneLayout.sidebarCompact);
  }, [paneLayout.sidebarCompact, sidebarDialogCount]);
  useEffect(() => {
    if (!sidebarWorkspaceCompact || !isActive) setCompactSessionsOpen(false);
  }, [isActive, sidebarWorkspaceCompact]);
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
      !isActive ||
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
  }, [isActive]);
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
        result.sessions.find(isWorkspaceTask)?.id ||
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
  const openProject = async (
    path?: string,
    preferredSessionId?: string,
    relatedSession?: AgentSession,
  ) => {
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
      if (relatedSession) {
        if (result.workspace.path !== relatedSession.projectPath)
          throw new Error("打开的工作区与工作会话不一致，请重新打开。");
        if (!result.sessions.some(({ id }) => id === relatedSession.id)) {
          result.sessions = [relatedSession, ...result.sessions];
        }
      }
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
      return true;
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
        workspacePermission(permissionMode, target),
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
      let standalone: AgentProjectResult | undefined;
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
            parentSession.coordination?.role !== "secretary"
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
      if (!target || (!requestedPath && !target.standalone)) {
        standalone = await agentApi.openStandalone();
        if (
          !mounted.current ||
          generation.current !== requestGeneration ||
          !requestCurrent()
        )
          return;
        target = standalone.workspace;
        targetCatalog = standalone.catalog;
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
        workspacePermission(
          sourceSession?.permissionMode
            ? sessionPermissionMode(sourceSession.permissionMode)
            : target.standalone
              ? "ask"
              : permissionMode,
          target,
        ),
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
      if (standalone) {
        standalone.warnings?.forEach((warning) => toast.warning(warning));
        adoptProject(standalone, session.id);
        setEngine((old) => ({
          ...old,
          available: true,
          running: true,
          projectPath: session.projectPath,
        }));
      }
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
    const request = ++secretaryNavigation.current;
    if (id === selectedId.current) return true;
    if (mutation.current || !workspace) return false;
    const target = workspace.path;
    const requestGeneration = generation.current;
    const selectionRevision = selection.current.revision;
    const isCurrent = () =>
      mounted.current &&
      secretaryNavigation.current === request &&
      generation.current === requestGeneration &&
      workspaceRef.current?.path === target &&
      selection.current.revision === selectionRevision;
    let next: AgentSnapshot;
    try {
      next = await agentApi.getSession(id);
    } catch (cause) {
      if (isCurrent()) throw cause;
      return false;
    }
    if (!isCurrent()) return false;
    const link = next.session.coordination;
    if (
      next.session.id !== id ||
      (id === secretarySessionId
        ? link?.role !== "secretary"
        : link?.role !== "worker" ||
          link.parentSessionId !== secretarySessionId)
    )
      throw new Error(
        t("agentSecretary.openMismatch", {
          defaultValue: "工作对话与当前工作区不一致，请重新读取。",
        }),
      );
    if (next.session.projectPath !== target) {
      return Boolean(
        await openProject(next.session.projectPath, id, next.session),
      );
    }
    setShowArchived(false);
    setSessions((old) => [
      next.session,
      ...old.filter((item) => item.id !== id),
    ]);
    setError(null);
    setSessionId(id);
    setRefresh((value) => value + 1);
    return true;
  };
  const startAutomationConversation = async (text: string) => {
    if (mutation.current || !workspace || initializing)
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
    const selectedPermission = selectedSession
      ? selectedPermissionMode
      : (workspacePermission(permissionMode, workspace) ?? "ask");
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
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const enqueueDraft = async (delivery?: "steer") => {
    if (
      mutation.current ||
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
        previous.delivery !== delivery ||
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
      ...(delivery && { delivery }),
    };
    try {
      saveAgentQueueSubmission(entry);
    } catch (cause) {
      setError(agentErrorMessage(cause));
      return;
    }
    const echo: QueueEcho = {
      projectPath,
      sessionId: id,
      item: {
        id: entry.requestId,
        text,
        createdAt: Date.now(),
        ...(delivery && { delivery }),
        attachments: [...images, ...documents].map(
          ({ fileName, mime, bytes }) => ({ fileName, mime, bytes }),
        ),
        confirming: true,
      },
    };
    if (delivery === "steer") {
      followSubmittedChat();
      if (images.length)
        setSentImageAttachments((old) => ({
          ...old,
          [entry.requestId]: images,
        }));
      if (documents.length)
        setSentDocumentAttachments((old) => ({
          ...old,
          [entry.requestId]: documents,
        }));
    }
    setQueueEchoes((current) => [...current, echo]);
    const discardEcho = () => {
      if (mounted.current)
        setQueueEchoes((current) => current.filter((item) => item !== echo));
    };
    mutation.current = true;
    setBusy(delivery === "steer" ? "steer" : "enqueue");
    setBusySessionId(id);
    setError(null);
    try {
      const queued = agentApi.enqueueMessage(
        id,
        text,
        entry.requestId,
        images,
        documents,
        ...(delivery ? ([delivery] as const) : ([] as const)),
      );
      // Native queue owns the durable payload; this cache also restores an
      // uncertain enqueue's attachments without copying blobs into localStorage.
      void Promise.all([
        saveAgentImageAttachments(entry.requestId, images),
        saveAgentDocumentAttachments(entry.requestId, documents),
      ]).catch(() => {});
      const receipt = await queued;
      if (receipt.status === "rejected") {
        discardEcho();
        clearAgentQueueSubmission(projectPath, id, entry.requestId);
        if (mounted.current && selectedId.current === id)
          setError(receipt.message || "消息未被接收，草稿和附件已保留。");
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
          admitted = observesQueuedInput(next, entry.requestId);
          onSnapshot(next);
        }
      } catch {
        /* Retry retains this exact request identity and payload. */
      }
      if (admitted) acceptQueuedDraft(entry);
      else {
        discardEcho();
        if (mounted.current && selectedId.current === id)
          setError(agentErrorMessage(cause));
      }
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
    if (action === "now") followSubmittedChat();
    try {
      if (action === "now") {
        if (canSteerQueuedMessage) {
          await agentApi.sendQueuedMessageNow(id, requestId, true);
          if (mounted.current && selectedId.current === id)
            composerInputRef.current?.focus({ preventScroll: true });
        } else await agentApi.sendQueuedMessageNow(id, requestId);
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
    if (queueMode) void enqueueDraft(queueRecovery?.delivery);
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
    if (
      mutation.current ||
      (retryLoading && !retry) ||
      !sessionId ||
      isLegacySession(sessionId) ||
      !key ||
      (!text && !outgoingImages.length && !outgoingDocuments.length) ||
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
    const projectPath = workspace!.path;
    if (readAgentQueueSubmission(projectPath, id)) {
      setError(
        "上次加入队列的结果尚未确认，请先刷新队列或重试加入队列；当前草稿已保留。",
      );
      return;
    }
    const sourceDraft = retry
      ? {
          key: `${retryDraftPrefix(storageKey)}${retry.sourceMessageId}`,
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
    const sourceSnapshot = snapshot;
    if (activeStatus(sourceSnapshot.status)) return;
    if (!stillCurrent()) return;
    if (mutation.current) {
      setError("配置正在保存，尚未发送新消息，请稍后重试。");
      return;
    }
    // Historical plan sessions remain readable. A new user send deliberately
    // moves an idle session to build before recording or dispatching input.
    if (
      selectedSession?.coordination?.role !== "worker" &&
      selectedSession?.mode === "plan"
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
        previous.draft.key !== sourceDraft.key ||
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
    const queued: PendingSend = {
      requestId,
      assistantIds: new Set(submission.assistantIds),
      preview: {
        projectPath,
        message: {
          id: requestId,
          role: "user",
          createdAt: Date.now(),
          parts: text ? [{ type: "text", text }] : [],
        },
      },
    };
    followSubmittedChat();
    beginAgentSubmission(requestId);
    pendingRef.current = { ...pendingRef.current, [id]: queued };
    storePending(projectPath, id, queued);
    setPending(pendingRef.current);
    mutation.current = true;
    setBusy("send");
    setBusySessionId(id);
    setError(null);
    if (outgoingImages.length)
      setSentImageAttachments((old) => ({
        ...old,
        [requestId]: outgoingImages,
      }));
    if (outgoingDocuments.length)
      setSentDocumentAttachments((old) => ({
        ...old,
        [requestId]: outgoingDocuments,
      }));
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
      const cleared = !retry && clearSubmittedAgentDraft(submission.draft);
      if (!mounted.current) return;
      if (cleared)
        setDrafts((old) =>
          old[storageKey] !== undefined &&
          old[storageKey] !== submission.draft.text
            ? old
            : { ...old, [storageKey]: "" },
        );
      if (!retry) {
        if (outgoingImages.length) clearSentComposerImages(id, outgoingImages);
        if (outgoingDocuments.length)
          clearSentComposerDocuments(id, outgoingDocuments);
      }
      setRefresh((old) => old + 1);
    };
    if (outgoingImages.length)
      void saveAgentImageAttachments(requestId, outgoingImages).catch(() => {});
    if (outgoingDocuments.length)
      void saveAgentDocumentAttachments(requestId, outgoingDocuments).catch(
        () => {},
      );
    try {
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
  };
  const retryLastMessage = async () => {
    if (!snapshot || snapshot.status !== "error" || !sessionId || !workspace)
      return;
    const message = [...snapshot.messages]
      .reverse()
      .find((item) => item.role === "user");
    if (!message) return;
    const previous = readAgentSubmission(workspace.path, sessionId);
    if (previous && retrySourceId(previous) !== message.id) return;
    const targetRevision = selection.current.revision;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    setRetryLoading(true);
    try {
      const [retryImages, retryDocuments] = previous
        ? await Promise.all([
            readAgentImageAttachments(previous.requestId),
            readAgentDocumentAttachments(previous.requestId),
          ])
        : [];
      const [images, documents] = await Promise.all([
        retryImages ||
          sentImageAttachments[message.id] ||
          readAgentImageAttachments(message.id).then((value) => value || []),
        retryDocuments ||
          sentDocumentAttachments[message.id] ||
          readAgentDocumentAttachments(message.id).then((value) => value || []),
      ]);
      const current = latestSnapshot.current;
      if (
        !mounted.current ||
        selection.current.revision !== targetRevision ||
        current?.session.id !== sessionId ||
        current.status !== "error" ||
        lastAgentUserTurn(current.messages) !== message.id
      )
        return;
      await send({
        sourceMessageId: message.id,
        // A settled native receipt deduplicates the old message ID. Only an
        // unresolved submission for this explicit retry keeps its attempt ID.
        requestId:
          previous?.requestId || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
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
            : refreshedSessions.find(isWorkspaceTask)?.id || null,
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
      if (fields.includes("title"))
        sessionTitles.current.set(session.id, {
          title: session.title,
          updatedAt: session.updatedAt,
        });
      updateSessionRows(session, () => withCommittedTitle(session));
      overrideFields.current[session.id] = [
        ...new Set([...(overrideFields.current[session.id] || []), ...fields]),
      ];
      overridesRef.current = { ...overridesRef.current, [session.id]: session };
      setSessionOverrides(overridesRef.current);
      setRefresh((old) => old + 1);
    },
    [updateSessionRows, withCommittedTitle],
  );
  const updateSessionConfig = async (patch: {
    modelId?: string;
    permissionMode?: AgentPermissionMode;
    reasoningEffort?: string;
    contextLimit?: number | null;
  }) => {
    if (isSecretaryWorker && (!patch.permissionMode || workerPermissionLocked))
      return;
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
                item.id !== id && !item.archived && isWorkspaceTask(item),
            )?.id || null,
          );
      } else if (result) confirmSession(result, fields);
      if (remove && workspace) {
        removedSessions.current.add(id);
        sessionTitles.current.delete(id);
        const owner = `${workspace.path}\0${id}`;
        clearDockOwners((key) => key === owner);
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
      if (remove) {
        await agentApi.removeProject(project.path);
        if (!mounted.current) return;
        const key = projectDockKey(project.path);
        clearDockOwners(
          (owner) => projectDockKey(owner.split("\0", 1)[0]) === key,
        );
      } else await agentApi.setProjectMetadata(project.path, !project.pinned);
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
  const canSteerQueuedMessage = Boolean(runningHere) && !snapshot?.queuePaused;
  const queuedHere = Boolean(
    sessionId && pending[sessionId] && !pending[sessionId].uncertain,
  );
  const uncertainHere = Boolean(sessionId && pending[sessionId]?.uncertain);
  const stoppingHere =
    (busy === "stop" && busySessionId === sessionId) ||
    Boolean(sessionId && stopping[sessionId]);
  const showTaskProgress =
    queuedHere || stoppingHere || runningHere || snapshot?.status === "error";
  const sendingHere = busy === "send" && busySessionId === sessionId;
  const steeringHere = busy === "steer" && busySessionId === sessionId;
  const enqueuingHere = busy === "enqueue" && busySessionId === sessionId;
  const queueMode = Boolean(
    runningHere || snapshot?.queuedMessages?.length || queueRecovery,
  );
  const recallingHere = busy === "queue-recall" && busySessionId === sessionId;
  const sendDisabled =
    readOnlySession ||
    retryLoading ||
    Boolean(busy) ||
    !snapshot ||
    (!draft.trim() && !composerImages.length && !composerDocuments.length) ||
    (queuedHere && !runningHere) ||
    stoppingHere;
  const canRetryUncertain =
    !queueMode &&
    uncertainSubmission &&
    !uncertainSubmission.stopRequested &&
    uncertainSubmission.text === draft.trim() &&
    uncertainSubmission.draft.key === key;
  const stopPrimary =
    !readOnlySession &&
    (runningHere || queuedHere || uncertainHere || stoppingHere) &&
    (sendDisabled || (uncertainHere && !canRetryUncertain));
  const submittingHere = sendingHere || steeringHere || enqueuingHere;
  const sessionQuery = sessionSearch.trim().toLocaleLowerCase();
  const visibleWorkspaceSessions = useMemo(
    () =>
      sessions
        .map(withCommittedTitle)
        .filter(
          (session) =>
            isWorkspaceTask(session) &&
            Boolean(session.archived) === showArchived &&
            matchesSidebarSession(session, sessionQuery),
        )
        .sort(compareSidebarSessions),
    [sessions, showArchived, sessionQuery, withCommittedTitle],
  );
  const workspaceExpanded = workspace
    ? (expandedWorkspaces[workspace.path] ?? true)
    : false;
  const prefetchIds = useMemo(
    () =>
      visibleWorkspaceSessions
        .filter((session) => session.id !== sessionId)
        .slice(0, AGENT_PREPARED_SESSION_LIMIT)
        .map((session) => session.id),
    [visibleWorkspaceSessions, sessionId],
  );
  const canPrefetchSession = Boolean(
    isActive && workspaceExpanded && snapshot && !busy && !activeTool,
  );
  useEffect(() => {
    if (!canPrefetchSession || !prefetchIds.length) return;
    let stopped = false;
    let cancel = () => {};
    const prepare = (index: number) => {
      if (stopped || index === prefetchIds.length) return;
      const read = async () => {
        await prefetchSession(prefetchIds[index]);
        prepare(index + 1);
      };
      if (typeof window.requestIdleCallback === "function") {
        const task = window.requestIdleCallback(() => void read());
        cancel = () => window.cancelIdleCallback(task);
      } else {
        const timer = setTimeout(() => void read(), 80);
        cancel = () => clearTimeout(timer);
      }
    };
    prepare(0);
    return () => {
      stopped = true;
      cancel();
    };
  }, [canPrefetchSession, prefetchIds, prefetchSession]);
  const preparedTranscripts = useMemo(
    () =>
      preparedSnapshots
        .filter(
          (item) =>
            !item.session.id.startsWith("lc:") &&
            item.session.projectPath === selectedProjectPath &&
            item.messages.length,
        )
        .map((item) => ({
          sessionId: item.session.id,
          projectPath: item.session.projectPath,
          messages: item.messages,
          status: item.status,
          userIdentity,
          imageAttachmentsByMessage: sentImageAttachments,
          documentAttachmentsByMessage: sentDocumentAttachments,
          onLoadEarlier: preserveEarlierHistory,
        })),
    [
      preparedSnapshots,
      selectedProjectPath,
      userIdentity,
      sentImageAttachments,
      sentDocumentAttachments,
      preserveEarlierHistory,
    ],
  );
  const sidebarProjects = useMemo(() => {
    const items: AgentProject[] = projects.length
      ? [...projects]
      : recent.map((path) => ({
          path,
          name: nameOf(path),
          pinned: false,
          lastOpenedAt: 0,
        }));
    if (workspace && !items.some((item) => item.path === workspace.path)) {
      items.push({ ...workspace, pinned: false, lastOpenedAt: 0 });
    }
    return items.sort(
      (a, b) =>
        Number(Boolean(b.standalone)) - Number(Boolean(a.standalone)) ||
        Number(b.pinned) - Number(a.pinned),
    );
  }, [projects, recent, workspace]);
  const sidebarPathSuffixes = useMemo(
    () => workspacePathSuffixes(sidebarProjects),
    [sidebarProjects],
  );

  const navigateWorkspace = (action: () => void) => {
    const proceed = () => {
      setCompactSessionsOpen(false);
      setActiveTool(null);
      action();
    };
    if ((activeTool || !isActive) && onWorkspaceNavigate)
      onWorkspaceNavigate(proceed);
    else proceed();
  };
  const restoreCompactSidebarFocus = useRef(false);
  useLayoutEffect(() => {
    if (!paneLayout.sidebarCompact || !restoreCompactSidebarFocus.current)
      return;
    restoreCompactSidebarFocus.current = false;
    paneLayout.containerRef.current
      ?.querySelector<HTMLButtonElement>("[data-workspace-sidebar-toggle]")
      ?.focus({ preventScroll: true });
  }, [paneLayout.containerRef, paneLayout.sidebarCompact]);
  const collapseSidebar = useCallback(() => {
    const focused = document.activeElement;
    const focusedInSidebar =
      focused instanceof HTMLElement && Boolean(focused.closest(".wb-sidebar"));
    if (onSidebarCompactChange) {
      restoreCompactSidebarFocus.current = focusedInSidebar;
      onSidebarCompactChange(true);
      return;
    }
    setSidebarCollapsed(true);
    if (focusedInSidebar && focused.matches(":focus-visible"))
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
  }, [onSidebarCompactChange, paneLayout.containerRef]);
  const toggleSidebar = useCallback(() => {
    if (paneLayout.sidebarCompact || !paneLayout.sidebarVisible) {
      if (previewVisible && !paneLayout.sidebarCanOpen) setPreviewFolded(true);
      onSidebarCompactChange?.(false);
      setSidebarCollapsed(false);
    } else collapseSidebar();
  }, [
    collapseSidebar,
    onSidebarCompactChange,
    paneLayout.sidebarCanOpen,
    paneLayout.sidebarCompact,
    paneLayout.sidebarVisible,
    previewVisible,
    setPreviewFolded,
  ]);
  useLayoutEffect(() => {
    if (!sidebarToggleRef) return;
    sidebarToggleRef.current = toggleSidebar;
    return () => {
      sidebarToggleRef.current = null;
    };
  }, [sidebarToggleRef, toggleSidebar]);
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "\\") {
        event.preventDefault();
        toggleSidebar();
      }
      if (
        canOpenBrowser &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "t"
      ) {
        event.preventDefault();
        openWebPreview();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canOpenBrowser, isActive, openWebPreview, toggleSidebar]);
  const sidebarToggle =
    !sharedPaneLayout && !paneLayout.sidebarVisible ? (
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
          title={busy === "create" ? "正在创建…" : "新建任务"}
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
              title="选择新建任务类型"
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
        title={t("agentSecretary.open", { defaultValue: "打开 Loli 秘书" })}
        aria-pressed={Boolean(secretarySessionId && workspace?.standalone)}
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
          const suffix = sidebarPathSuffixes.get(project.path);
          const accessibleName = suffix
            ? `${project.name} ${suffix}`
            : project.name;
          const label = suffix ? (
            <span className="wb-workspace-label">
              <span className="truncate">{project.name}</span>{" "}
              <span className="wb-workspace-suffix truncate">{suffix}</span>
            </span>
          ) : (
            <span className="truncate">{project.name}</span>
          );
          const isCurrentWorkspace = project.path === workspace?.path;
          const expanded = isCurrentWorkspace
            ? workspaceExpanded
            : Boolean(expandedWorkspaces[project.path]);
          const taskListId = `workspace-tasks-${encodeURIComponent(
            project.path,
          )}`;
          const matchingTasks = isCurrentWorkspace
            ? visibleWorkspaceSessions
            : expanded
              ? (workspaceSessions[project.path] || [])
                  .map(withCommittedTitle)
                  .filter(
                    (session) =>
                      isWorkspaceTask(session) &&
                      matchesSidebarSession(session, sessionQuery),
                  )
                  .sort(compareSidebarSessions)
              : [];
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
                  aria-label={`${expanded ? "收起" : "展开"} ${accessibleName} 的任务`}
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
                    {label}
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
                    {label}
                    {project.pinned && <Pin size={11} />}
                  </button>
                )}
                <AgentProjectMenu
                  onDialogOpenChange={onSidebarDialogOpenChange}
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
                  aria-label={`${accessibleName} 的任务`}
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
                            onPointerEnter={(event) => {
                              if (
                                event.pointerType === "mouse" &&
                                canPrefetchSession
                              )
                                prefetchSession(session.id);
                            }}
                            onFocus={() => {
                              if (canPrefetchSession)
                                prefetchSession(session.id);
                            }}
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
                            onDialogOpenChange={onSidebarDialogOpenChange}
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

  const tabId = (tab: DockTab) => `${dockId}-${tab.replace(":", "-")}`;
  const previewTabs = new Map<DockTab, PreviewTabLabel>(
    (browserDeck?.tabs ?? []).map((tab) => [
      browserDockTab(tab.id),
      {
        id: tabId(browserDockTab(tab.id)),
        title: tab.title || tab.url || "新标签页",
        select: () => selectDockTab(identity, browserDockTab(tab.id)),
        close: () => closeManualBrowser(identity, tab.id),
      },
    ]),
  );
  if (currentPreview) {
    const { target } = currentPreview;
    previewTabs.set("preview", {
      id: tabId("preview"),
      title:
        "path" in target
          ? target.path.split(/[\\/]/).at(-1) || "文件预览"
          : "运行页面预览",
      select: () => selectDockTab(identity, "preview"),
      close: () => closePreview(identity, target),
    });
  }
  for (const tab of availableTabs) {
    previewTabs.set(tab, {
      id: tabId(tab),
      title: tab === "files" ? "项目目录" : "交互终端",
      select: () => selectDockTab(identity, tab),
      close: () => closeAuxiliaryTab(identity, tab),
    });
  }
  const splitSpace = paneLayout.previewWidth - DOCK_DIVIDER_WIDTH;
  const canSplit = splitSpace >= DOCK_PANE_MIN_WIDTH * 2;
  const showingSplit = dock.panes.length === 2 && canSplit;
  const visibleDock = showingSplit ? dock : mergePreviewDock(dock);
  const splitWidth = Math.max(
    DOCK_PANE_MIN_WIDTH,
    Math.min(
      splitSpace - DOCK_PANE_MIN_WIDTH,
      Math.round(splitSpace * dock.ratio),
    ),
  );
  const dockColumn = (index: number) => (index === 0 ? 1 : 3);
  const panelColumn = (owner: string, tab: DockTab) => {
    if (!isActive || !previewVisible || owner !== identity) return;
    const index = visibleDock.panes.findIndex(({ active }) => active === tab);
    if (index !== -1) return dockColumn(index);
  };

  const sidebarContent = renderSidebar?.({
    actions: sidebarActions,
    workspace: sidebarWorkspaceCompact ? (
      <Popover open={compactSessionsOpen} onOpenChange={setCompactSessionsOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="lolicode-sidebar-icon-button lolicode-compact-sessions"
            aria-label="项目与会话"
            title="项目与会话"
          >
            <MessageSquare aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={12}
          collisionPadding={12}
          aria-label="项目与会话"
          className="lolicode-workbench wb-unified lolicode-compact-sessions-popover"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            sessionSearchRef.current?.focus();
          }}
        >
          <div className="wb-sidebar">{sidebarWorkspace}</div>
        </PopoverContent>
      </Popover>
    ) : (
      sidebarWorkspace
    ),
    onCollapse: toggleSidebar,
    compact: paneLayout.sidebarCompact,
  });

  return (
    <div
      ref={sharedPaneLayout ? undefined : paneLayout.containerRef}
      className="lolicode-agent-page lolicode-workbench wb-resizable-layout wb-unified"
    >
      {sharedPaneLayout ? (
        sidebarContent
      ) : (
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
                sidebarContent
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
      )}
      {!sharedPaneLayout &&
        !paneLayout.sidebarCompact &&
        paneLayout.sidebarVisible && (
          <AgentPaneResizeHandle {...paneLayout.sidebarHandleProps} />
        )}
      <main id="agent-content-area" className="wb-main">
        <div className="wb-chat-surface" data-panel-background>
          <header
            className="wb-titlebar"
            {...DRAG_REGION_ATTR}
            style={DRAG_REGION_STYLE as React.CSSProperties}
          >
            {sidebarToggle}
            <div
              className="wb-titlebar-heading"
              data-workspace-entry
              {...DRAG_REGION_ATTR}
            >
              <h1 title={selectedTitle} {...DRAG_REGION_ATTR}>
                {selectedTitle}
              </h1>
            </div>
            {isSecretaryWorker && (
              <span className="wb-secretary-role">
                {t("agentSecretary.workerRole", {
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
            {workspace && sessionId && showTaskProgress && (
              <button
                type="button"
                className="wb-task-progress"
                aria-controls={taskProgressId}
                title="查看当前任务进度"
                onClick={() => {
                  const scroll = scrollRef.current;
                  if (!scroll) return;
                  pinChatTail();
                  jumpToChatTail(scroll);
                  document.getElementById(taskProgressId)?.focus({
                    preventScroll: true,
                  });
                }}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <ListChecks aria-hidden="true" />
                任务进度
              </button>
            )}
            <AgentHelpMenu
              onOpenAbout={onOpenAbout}
              onCheckUpdate={onCheckUpdate}
            />
            {canOpenBrowser && !browserDeck && (
              <button
                type="button"
                className="wb-icon-button wb-pane-toggle"
                aria-label="新建浏览器标签"
                title="新建浏览器标签（Ctrl+T）"
                onClick={() => openWebPreview()}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <Globe aria-hidden="true" />
              </button>
            )}
            {workspace && sessionId && (
              <button
                type="button"
                className="wb-icon-button wb-pane-toggle wb-titlebar-preview"
                aria-label={previewVisible ? "收起文件预览" : "预览项目文件"}
                aria-expanded={previewVisible}
                title={previewVisible ? "收起文件预览" : "展开文件预览"}
                onClick={() => {
                  if (hasPreview) setPreviewFolded(previewVisible);
                  else openPreview("");
                }}
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
              selectedSessionId={sessionId ?? undefined}
              canDelegate={
                isSecretary && !selectedSession?.archived && !readOnlySession
              }
              workerTaskId={
                !isSecretary ? selectedSession?.coordination?.taskId : undefined
              }
              active={isActive && !activeTool}
              onOpenSession={openSecretarySession}
              projectChoices={
                isSecretary && workspace?.standalone
                  ? sidebarProjects
                  : undefined
              }
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
                    value={
                      workspacePermission(permissionMode, workspace) ??
                      (workspace.remote ? "ask" : "full_access")
                    }
                    title={
                      workspace.remote
                        ? "远程写入和命令始终逐次确认。"
                        : "完整权限会在会话允许的范围内直接执行工具，无需手动批准。Agent 仍可向你提问。"
                    }
                    disabled={Boolean(busy)}
                    onChange={(event) => {
                      setPermissionMode(
                        event.target.value as AgentPermissionMode,
                      );
                    }}
                  >
                    <option value="ask">逐次确认</option>
                    <option value="auto">Auto Mode</option>
                    {!workspace.remote && (
                      <option value="full_access">完整权限</option>
                    )}
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
              {sessionId && compatibilityHistories.has(sessionId) && (
                <p role="status" className="wb-notice">
                  此会话包含旧格式历史，已保留原有显示。
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
              {usesNativeTranscript && nativeSession.error && (
                <div role="alert" className="wb-notice">
                  <Notice
                    tone="danger"
                    title={nativeSession.error}
                    actions={
                      <Button
                        variant="quiet"
                        size="compact"
                        onClick={() => void nativeSession.refresh()}
                      >
                        重新连接
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
              <AgentFileActionsContext.Provider value={fileActions}>
                <div
                  ref={scrollRef}
                  onScroll={updateChatReadingPosition}
                  onWheel={stopSmoothChatScroll}
                  onTouchStart={stopSmoothChatScroll}
                  onPointerDown={stopSmoothChatScroll}
                  onKeyDown={(event) => {
                    if (
                      [
                        "ArrowUp",
                        "ArrowDown",
                        "PageUp",
                        "PageDown",
                        "Home",
                        "End",
                        " ",
                      ].includes(event.key)
                    )
                      stopSmoothChatScroll();
                  }}
                  className="wb-chat"
                >
                  <div ref={chatContentRef} className="wb-chat-content">
                    <AgentTranscriptDeck
                      active={isActive}
                      loading={
                        usesNativeTranscript
                          ? nativeSession.loading &&
                            !nativeSession.ready &&
                            !transcriptMessages.length
                          : snapshotLoading
                      }
                      loadingLabel={t("common.loading")}
                      ready={
                        Boolean(snapshot) &&
                        (!usesNativeTranscript ||
                          nativeSession.ready ||
                          transcriptMessages.length > 0)
                      }
                      prepared={preparedTranscripts}
                      onEvict={forgetTranscriptPosition}
                      messages={transcriptMessages}
                      native={nativeTranscript}
                      messageAliases={nativeMessageAliases}
                      userIdentity={userIdentity}
                      sessionId={sessionId}
                      projectPath={workspace.path}
                      status={snapshot?.status}
                      imageAttachmentsByMessage={sentImageAttachments}
                      documentAttachmentsByMessage={sentDocumentAttachments}
                      onLoadEarlier={preserveEarlierHistory}
                    />
                    {showTaskProgress && (
                      <AgentActivityStatus
                        id={taskProgressId}
                        snapshot={snapshot}
                        submitting={queuedHere}
                        stopping={stoppingHere}
                      />
                    )}
                    {snapshot &&
                      !hasChatContent &&
                      (!usesNativeTranscript ||
                        (nativeSession.ready && !nativeSession.error)) && (
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
                            projectPath={workspace?.path}
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
                            steeringHere,
                        )}
                        currentTurnId={
                          uncertainRetrySource ??
                          (sessionId
                            ? pending[sessionId]?.requestId
                            : undefined)
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
                {sessionId &&
                  snapshot?.session.id === sessionId &&
                  snapshot.goal &&
                  !configurationReadOnly && (
                    <AgentSessionModes
                      key={sessionId}
                      goal={snapshot.goal}
                      disabled={Boolean(busy) || stoppingHere || uncertainHere}
                      onEditGoal={() => {
                        if (!key) return;
                        if (!draft.trimStart().startsWith("/goal "))
                          writeDraft(key, "/goal edit " + draft);
                        composerInputRef.current?.focus();
                      }}
                      onCommand={(command) =>
                        refreshAfter(() =>
                          agentApi.sendMessage(
                            sessionId,
                            command,
                            `mode_${crypto.randomUUID().replace(/-/g, "")}`,
                          ),
                        )
                      }
                    />
                  )}
                {snapshot &&
                  snapshot.session.id === sessionId &&
                  !readOnlySession &&
                  !isSecretaryWorker &&
                  !activeStatus(snapshot.status) &&
                  Boolean(snapshot.backgroundJobs) && (
                    <div className="wb-queue-recovery" role="status">
                      <span>{snapshot.backgroundJobs} 个后台作业仍在运行</span>
                      <button
                        type="button"
                        disabled={stoppingHere}
                        onClick={() => void stop()}
                      >
                        停止后台作业
                      </button>
                    </div>
                  )}
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
                  items={displayedQueue}
                  paused={snapshot?.queuePaused}
                  canSteer={canSteerQueuedMessage}
                  busyId={
                    busy === "queue-now" && busySessionId === sessionId
                      ? queueBusyId
                      : null
                  }
                  disabled={
                    readOnlySession ||
                    Boolean(busy) ||
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
                      pinChatTail();
                      const reduced = window.matchMedia(
                        "(prefers-reduced-motion: reduce)",
                      ).matches;
                      smoothChatTarget.current = reduced
                        ? null
                        : Math.max(
                            0,
                            scroll.scrollHeight - scroll.clientHeight,
                          );
                      scroll.scrollTo({
                        top: scroll.scrollHeight,
                        behavior: reduced ? "instant" : "smooth",
                      });
                      if (reduced) followedScrollTop.current = scroll.scrollTop;
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
                    if (sendDisabled) return;
                    submitComposer();
                    composerInputRef.current?.focus({ preventScroll: true });
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
                    title="Enter 发送 · Shift + Enter 换行；任务运行时默认排队，Ctrl/⌘ + Enter 引导当前任务"
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
                          if ((event.ctrlKey || event.metaKey) && runningHere)
                            void enqueueDraft("steer");
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
                      permissionMode={selectedPermissionMode}
                    >
                      {isSecretaryWorker && (
                        <p className="wb-secretary-config-note">
                          {workerPermissionLocked
                            ? t("agentSecretary.workerPermissionLocked", {
                                defaultValue:
                                  "该任务沿用派工会话或后台规则的权限。",
                              })
                            : t("agentSecretary.workerSettings", {
                                defaultValue:
                                  "工作对话沿用分派时的模型。这里更改的权限只对当前工作对话生效。",
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
                          title={
                            workspace?.remote
                              ? "远程写入和命令始终逐次确认。"
                              : "逐次确认会在改动和运行命令前询问。Auto Mode 允许工作区内的常规操作。完整权限会在会话允许的范围内直接执行工具，无需手动批准。Agent 仍可向你提问。当前运行和已排队消息沿用原权限，新设置从下一次独立运行生效。"
                          }
                          value={selectedPermissionMode}
                          disabled={
                            readOnlySession ||
                            workerPermissionLocked ||
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
                          {!workspace?.remote && (
                            <option value="full_access">完整权限</option>
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
                    <button
                      type={stopPrimary ? "button" : "submit"}
                      data-composer-action={stopPrimary ? "stop" : "send"}
                      className={`wb-primary wb-send-button${!stopPrimary && submittingHere ? " wb-send-pending" : ""}`}
                      disabled={stopPrimary ? stoppingHere : sendDisabled}
                      title={
                        stopPrimary
                          ? "停止当前任务，保留排队消息"
                          : queueMode
                            ? snapshot?.queuePaused
                              ? "发送消息 · 当前队列已暂停"
                              : "发送并排队 · 当前任务结束后依次发送"
                            : "Enter 发送 · Shift + Enter 换行"
                      }
                      onClick={
                        stopPrimary
                          ? (event) => {
                              if (event.detail < 2) void stop();
                            }
                          : undefined
                      }
                      onKeyDown={(event) => {
                        if (
                          event.repeat &&
                          (event.key === "Enter" || event.key === " ")
                        )
                          event.preventDefault();
                      }}
                    >
                      {stopPrimary ? (
                        <Square size={16} aria-hidden="true" />
                      ) : submittingHere ? (
                        <LoaderCircle
                          className="wb-send-spinner"
                          size={20}
                          aria-hidden="true"
                        />
                      ) : (
                        <ArrowUp size={20} aria-hidden="true" />
                      )}
                      <span>
                        {stopPrimary
                          ? stoppingHere
                            ? "停止中…"
                            : "停止"
                          : submittingHere
                            ? "正在发送…"
                            : "发送"}
                      </span>
                    </button>
                  </div>
                </form>
              </div>
            </>
          )}
        </div>
      </main>
      {previewVisible && (
        <AgentPaneResizeHandle {...paneLayout.previewHandleProps} />
      )}
      <div
        ref={dockElement}
        className="wb-preview-dock"
        hidden={!previewVisible}
        style={{
          width: paneLayout.previewWidth,
          gridTemplateColumns: showingSplit
            ? `minmax(0, var(--wb-dock-drag-width, ${splitWidth}px)) ${DOCK_DIVIDER_WIDTH}px minmax(0, 1fr)`
            : undefined,
        }}
      >
        {hasPreview &&
          visibleDock.panes.map(({ tabs, active }, index) => {
            const pane = index === 1 ? 1 : 0;
            const column = dockColumn(index);
            // A narrow window combines the presentation without changing the saved split.
            const openIn = showingSplit ? pane : undefined;
            return (
              <AgentPreviewTabStrip
                key={index}
                column={column}
                label={
                  showingSplit
                    ? index === 0
                      ? "左侧分屏标签"
                      : "右侧分屏标签"
                    : undefined
                }
                tabs={tabs.map((tab) => previewTabs.get(tab)!)}
                activeId={active ? tabId(active) : undefined}
                onOpenBrowser={
                  canOpenBrowser
                    ? () => openWebPreview(undefined, openIn)
                    : undefined
                }
                onOpenFiles={() => selectDockTab(identity, "files", openIn)}
                onOpenTerminal={() =>
                  selectDockTab(identity, "terminal", openIn)
                }
                onSplit={
                  dock.panes.length === 1 && canSplit
                    ? () => updateDock(identity, () => splitPreviewDock(dock))
                    : undefined
                }
                onMerge={
                  dock.panes.length === 2
                    ? () => updateDock(identity, mergePreviewDock)
                    : undefined
                }
                onMoveActive={
                  showingSplit && active
                    ? () =>
                        updateDock(identity, (old) =>
                          moveDockTab(old, active, pane === 0 ? 1 : 0),
                        )
                    : undefined
                }
              />
            );
          })}
        {showingSplit && (
          <div className="wb-preview-split-divider">
            <AgentPaneResizeHandle
              label="调整右栏分屏宽度"
              width={splitWidth}
              minWidth={DOCK_PANE_MIN_WIDTH}
              maxWidth={splitSpace - DOCK_PANE_MIN_WIDTH}
              growthDirection={1}
              onWidthChange={(width) => {
                const style = dockElement.current?.style;
                if (width === splitWidth)
                  style?.removeProperty("--wb-dock-drag-width");
                else style?.setProperty("--wb-dock-drag-width", `${width}px`);
              }}
              onWidthCommit={(width) => {
                dockElement.current?.style.removeProperty(
                  "--wb-dock-drag-width",
                );
                updateDock(identity, (old) => ({
                  ...old,
                  ratio: Math.min(0.9, Math.max(0.1, width / splitSpace)),
                }));
              }}
            />
          </div>
        )}
        {showingSplit &&
          visibleDock.panes.map(
            ({ tabs }, index) =>
              !tabs.length && (
                <div
                  key={index}
                  className="wb-dock-guide"
                  style={{ gridColumn: dockColumn(index), gridRow: 2 }}
                >
                  <p>打开一个工具</p>
                  {canOpenBrowser && (
                    <button
                      type="button"
                      onClick={() =>
                        openWebPreview(undefined, index === 1 ? 1 : 0)
                      }
                    >
                      浏览器
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      selectDockTab(identity, "files", index === 1 ? 1 : 0)
                    }
                  >
                    项目目录
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      selectDockTab(identity, "terminal", index === 1 ? 1 : 0)
                    }
                  >
                    交互终端
                  </button>
                </div>
              ),
          )}
        {retainedPreviews.map(([owner, { target, request }]) => {
          const column = panelColumn(owner, "preview");
          const visible = column !== undefined;
          const label = owner === identity ? tabId("preview") : undefined;
          const props = {
            sessionId: target.sourceSessionId,
            visible,
            onClose: () => closePreview(owner, target),
          };
          return (
            <div
              key={`${owner}:${request}`}
              className="wb-preview-dock-pane"
              id={label ? label + "-panel" : undefined}
              role={label ? "tabpanel" : undefined}
              aria-labelledby={label}
              hidden={!visible}
              style={{ gridColumn: column, gridRow: 2 }}
            >
              {"browserId" in target ? (
                <AgentBrowserPreviewPanel
                  {...props}
                  browserId={target.browserId}
                  url={target.url}
                  native={target.native}
                  toolPage={target.toolPage}
                  slot={column === 3 ? 1 : 0}
                />
              ) : (
                <AgentPreviewPanel
                  {...props}
                  path={target.path}
                  line={target.line}
                  onNavigate={(path) => navigatePreview(owner, path)}
                />
              )}
            </div>
          );
        })}
        {Object.entries(browserDecks).flatMap(([owner, deck]) =>
          deck.tabs.map((tab) => {
            const kind = browserDockTab(tab.id);
            const column = panelColumn(owner, kind);
            const visible = column !== undefined;
            const label = owner === identity ? tabId(kind) : undefined;
            return (
              <div
                key={tab.id}
                className="wb-preview-dock-pane"
                id={label ? label + "-panel" : undefined}
                role={label ? "tabpanel" : undefined}
                aria-labelledby={label}
                hidden={!visible}
                style={{ gridColumn: column, gridRow: 2 }}
              >
                <AgentBrowserPreviewPanel
                  sessionId={tab.sessionId}
                  browserId={tab.browserId}
                  url={tab.url}
                  native={Boolean(tab.browserId)}
                  toolPage
                  slot={column === 3 ? 1 : 0}
                  visible={visible}
                  opening={tab.loading}
                  openingError={tab.error}
                  restoreTitle={tab.restoring ? tab.title : undefined}
                  onRestore={
                    tab.restoring && tab.url
                      ? () => {
                          void navigateBrowserTab(tab.id, tab.url!);
                        }
                      : undefined
                  }
                  onAddress={(url) => navigateBrowserTab(tab.id, url)}
                  onClose={() => closeManualBrowser(owner, tab.id)}
                />
              </div>
            );
          }),
        )}
        {sessionId &&
          workspace &&
          availableTabs.map((tab) => {
            const column = panelColumn(identity, tab);
            const visible = column !== undefined;
            const label = tabId(tab);
            const props = {
              sessionId,
              projectPath: workspace.path,
              visible,
              onClose: () => closeAuxiliaryTab(identity, tab),
            };
            return (
              <div
                key={`${identity}:${tab}`}
                className="wb-preview-dock-pane"
                id={label + "-panel"}
                role="tabpanel"
                aria-labelledby={label}
                hidden={!visible}
                style={{ gridColumn: column, gridRow: 2 }}
              >
                {tab === "files" ? (
                  <AgentProjectFilesPanel {...props} onOpenFile={openPreview} />
                ) : (
                  <Suspense
                    fallback={<p className="wb-dock-guide">正在加载终端…</p>}
                  >
                    <AgentTerminalPanel
                      {...props}
                      terminalId={`${sessionId}:terminal`}
                    />
                  </Suspense>
                )}
              </div>
            );
          })}
      </div>
      <FullScreenPanelNavigationContext.Provider value={sidebarToggle}>
        <FullScreenPanelHostContext.Provider value="agent-content-area">
          <AgentToolDraftsContext.Provider value={toolDrafts.current}>
            <AgentOperationsPanel
              open={isActive && operationsOpen}
              onOpenChange={setOperationsOpen}
              initialTab={operationsTab}
              projectPath={workspace?.path}
              catalog={catalog}
              working={working}
              onBuildAutomation={startAutomationConversation}
              onOpenProject={async (path) => {
                await openProject(path);
              }}
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
                    workspacePermission(permissionMode, workspace),
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
              open={isActive && extensionsOpen}
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
              open={isActive && activeTool === "memory"}
              onClose={() => setActiveTool(null)}
              title="记忆"
              description="管理跨会话的用户偏好与项目约定，让 Agent 越用越了解你的工作方式。"
              icon={Brain}
              projectPath={workspace?.path}
            >
              {isActive && activeTool === "memory" && (
                <AgentMemoryPanel embedded projectPath={workspace?.path} />
              )}
            </AgentToolPanel>
          </AgentToolDraftsContext.Provider>
        </FullScreenPanelHostContext.Provider>
      </FullScreenPanelNavigationContext.Provider>
    </div>
  );
}
