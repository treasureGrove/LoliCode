import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Blocks,
  BrainCircuit,
  CheckCircle2,
  Compass,
  Database,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Store,
  Terminal,
  Trash2,
  Workflow,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  SegmentThumb,
  useSlidingIndicator,
} from "@/components/ui/sliding-indicator";
import { MotionSurface } from "@/components/motion/MotionSurface";
import { useNavigationDirection } from "@/lib/motion";
import { SessionMarkdown } from "@/features/sessions/reader/SessionMarkdown";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import { settingsApi } from "@/lib/api";
import { agentApi } from "@/lib/api/agent";
import type {
  DshLocalizedText,
  DshMarketDetail,
  DshMarketOverview,
  DshMarketPage,
  DshMarketPluginItem,
} from "@/types/agent";
import { AgentToolPanel } from "./AgentToolPanel";
import "./agent-marketplace-panel.css";
import "./agent-skills-panel.css";

const HARNESS_BUNDLE_LABELS: Record<
  string,
  { name: string; description: string }
> = {
  terminal: {
    name: "持久终端",
    description: "在任务执行期间复用终端进程和命令状态。",
  },
  ralph: {
    name: "Ralph",
    description: "用会话目标持续跟进任务，直到满足完成条件。",
  },
  "session-search": {
    name: "历史会话检索",
    description:
      "允许 Agent 使用 SQLite 全文索引检索与阅读当前工作区的历史会话。",
  },
  "session-titles": {
    name: "动态会话标题",
    description: "随着用户多轮提问推进，自动刷新与概括当前会话标题。",
  },
  "badge-skill": {
    name: "徽章标记技能",
    description: "为生成的文档、PR 与交付物添加 Powered by DSH 徽章。",
  },
  worktree: {
    name: "Git 工作树工具",
    description: "允许模型创建并切换独立的 Git Worktree 隔离开发分支。",
  },
  "auto-review": {
    name: "工具自动安全审查",
    description: "在自动权限预设下对每次工具调用执行 LLM 逐项安全授权审查。",
  },
};

function resolveLocalizedText(
  value: DshLocalizedText | null | undefined,
  chinese: boolean,
): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  const preferred = chinese
    ? [value.zh, value["zh-cn"], value["zh-hans"], value.en]
    : [value.en, value.zh, value["zh-cn"]];
  const hit = preferred.find((v) => typeof v === "string" && v.trim());
  if (hit) return hit;
  return Object.values(value).find((v) => typeof v === "string" && v.trim());
}

function formatDate(timestamp?: number | null): string | null {
  if (!timestamp) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(timestamp * 1000));
  } catch {
    return null;
  }
}

function artworkToneAndIcon(category?: string | null) {
  const key = (category || "").trim().toLowerCase();
  if (
    key.includes("memory") ||
    key.includes("knowledge") ||
    key.includes("rag")
  ) {
    return { tone: "plum", Icon: BrainCircuit };
  }
  if (
    key.includes("workflow") ||
    key.includes("plan") ||
    key.includes("flow")
  ) {
    return { tone: "amber", Icon: Workflow };
  }
  if (
    key.includes("terminal") ||
    key.includes("shell") ||
    key.includes("cli")
  ) {
    return { tone: "sage", Icon: Terminal };
  }
  if (key.includes("tool") || key.includes("dev") || key.includes("git")) {
    return { tone: "rose", Icon: Wrench };
  }
  if (
    key.includes("search") ||
    key.includes("web") ||
    key.includes("explore")
  ) {
    return { tone: "sage", Icon: Compass };
  }
  if (key.includes("agent") || key.includes("prompt") || key.includes("ai")) {
    return { tone: "rose", Icon: Sparkles };
  }
  return { tone: "amber", Icon: Blocks };
}

function PluginArtwork({
  src,
  alt,
  category,
}: {
  src?: string | null;
  alt: string;
  category?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);
  const { tone, Icon } = artworkToneAndIcon(category);
  if (src && !failed) {
    return (
      <span className="wb-market-artwork" data-tone={tone} aria-hidden="true">
        <img
          src={src}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span className="wb-market-artwork" data-tone={tone} aria-hidden="true">
      <Icon size={19} strokeWidth={1.75} />
    </span>
  );
}

function MarketToggleSwitch({
  checked,
  disabled,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className="wb-market-switch"
      data-checked={checked ? "true" : "false"}
      title={checked ? "已启用" : "未启用"}
    >
      <input
        type="checkbox"
        className="wb-market-switch-input"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="wb-market-switch-track" aria-hidden="true">
        <span className="wb-market-switch-thumb" />
      </span>
    </label>
  );
}

type MarketTab = "official" | "installed" | "discover";

export function AgentDeepSeekMarketplacePanel({
  open,
  onClose,
  projectPath,
  working = false,
  onChanged,
  onOpenExtensions,
}: {
  open: boolean;
  onClose: () => void;
  projectPath?: string;
  working?: boolean;
  onChanged?: (enabledCount: number) => void;
  onOpenExtensions?: (tab?: "skills" | "plugins" | "mcp") => void;
}) {
  const { i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const panelId = useId();

  const [tab, setTab] = useState<MarketTab>("official");
  const [overview, setOverview] = useState<DshMarketOverview | null>(null);
  const [page, setPage] = useState<DshMarketPage | null>(null);
  const [items, setItems] = useState<DshMarketPluginItem[]>([]);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [incompatibleRetry, setIncompatibleRetry] = useState<{
    nameOrSpec: string;
    version?: string;
    registry?: string;
    sourceUrl?: string;
    message: string;
  } | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [debouncedText, setDebouncedText] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [compatibleOnly, setCompatibleOnly] = useState(false);
  const [sort, setSort] = useState<
    "index" | "relevance" | "published" | "name"
  >("index");

  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [customSourceUrl, setCustomSourceUrl] = useState("");
  const [manualSpec, setManualSpec] = useState("");

  const [detailName, setDetailName] = useState<string | null>(null);
  const [detail, setDetail] = useState<DshMarketDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const generation = useRef(0);
  const queryRequest = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;

  const isCurrent = (gen: number) =>
    openRef.current && generation.current === gen;

  const syncOverview = useCallback(
    (next: DshMarketOverview) => {
      setOverview(next);
      onChanged?.(next.enabledCount);
    },
    [onChanged],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedText(searchInput);
    }, 200);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const fetchOverview = useCallback(
    async (gen: number) => {
      setLoadingOverview(true);
      setError(null);
      try {
        const next = await agentApi.getDshMarketplaceOverview();
        if (isCurrent(gen)) syncOverview(next);
        return next;
      } catch (cause) {
        if (isCurrent(gen)) setError(agentErrorMessage(cause));
        return null;
      } finally {
        if (isCurrent(gen)) setLoadingOverview(false);
      }
    },
    [syncOverview],
  );

  const fetchCatalogPage = useCallback(
    async ({
      sourceUrl,
      text,
      category,
      compatOnly,
      sortMode,
      offset = 0,
      refresh = false,
      append = false,
    }: {
      sourceUrl?: string | null;
      text: string;
      category: string | null;
      compatOnly: boolean;
      sortMode: "index" | "relevance" | "published" | "name";
      offset?: number;
      refresh?: boolean;
      append?: boolean;
    }) => {
      const requestId = ++queryRequest.current;
      const gen = generation.current;
      if (append) setLoadingMore(true);
      else setLoadingPage(true);
      setError(null);
      try {
        const next = await agentApi.queryDshMarketplace({
          ...(sourceUrl ? { sourceUrl } : {}),
          text,
          category,
          compatibleOnly: compatOnly,
          sort: sortMode,
          offset,
          limit: 24,
          refresh,
        });
        if (isCurrent(gen) && queryRequest.current === requestId) {
          setPage(next);
          setItems((prev) => (append ? [...prev, ...next.items] : next.items));
        }
      } catch (cause) {
        if (isCurrent(gen) && queryRequest.current === requestId) {
          setError(agentErrorMessage(cause));
        }
      } finally {
        if (isCurrent(gen) && queryRequest.current === requestId) {
          setLoadingPage(false);
          setLoadingMore(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const gen = ++generation.current;
    if (!open) return;
    setError(null);
    setIncompatibleRetry(null);
    void fetchOverview(gen);
    return () => {
      generation.current += 1;
    };
  }, [open, fetchOverview]);

  useEffect(() => {
    if (!open || tab !== "discover" || !overview?.selectedSource) return;
    void fetchCatalogPage({
      sourceUrl: overview.selectedSource,
      text: debouncedText,
      category: selectedCategory,
      compatOnly: compatibleOnly,
      sortMode: debouncedText.trim() && sort === "index" ? "relevance" : sort,
      offset: 0,
      refresh: false,
      append: false,
    });
  }, [
    open,
    tab,
    overview?.selectedSource,
    debouncedText,
    selectedCategory,
    compatibleOnly,
    sort,
    fetchCatalogPage,
  ]);

  const openDetail = async (name: string, version?: string) => {
    setDetailName(name);
    setDetail(null);
    setDetailError(null);
    setLoadingDetail(true);
    const gen = generation.current;
    try {
      const next = await agentApi.getDshMarketplaceDetail(
        name,
        version,
        overview?.selectedSource ?? undefined,
      );
      if (isCurrent(gen)) setDetail(next);
    } catch (cause) {
      if (isCurrent(gen)) setDetailError(agentErrorMessage(cause));
    } finally {
      if (isCurrent(gen)) setLoadingDetail(false);
    }
  };

  const refreshAll = async (forceFeedRefresh = true) => {
    const gen = generation.current;
    setError(null);
    setBusyPlugin("__refresh__");
    try {
      const next = await agentApi.refreshDshMarketplaceSource(
        forceFeedRefresh && tab === "discover"
          ? (overview?.selectedSource ?? undefined)
          : undefined,
      );
      if (isCurrent(gen)) {
        syncOverview(next);
        if (tab === "discover" && next.selectedSource) {
          await fetchCatalogPage({
            sourceUrl: next.selectedSource,
            text: debouncedText,
            category: selectedCategory,
            compatOnly: compatibleOnly,
            sortMode:
              debouncedText.trim() && sort === "index" ? "relevance" : sort,
            offset: 0,
            refresh: false,
            append: false,
          });
        }
      }
    } catch (cause) {
      if (isCurrent(gen)) setError(agentErrorMessage(cause));
    } finally {
      if (isCurrent(gen)) setBusyPlugin(null);
    }
  };

  const handleInstall = async ({
    nameOrSpec,
    version,
    registry,
    sourceUrl,
    acceptIncompatible = false,
  }: {
    nameOrSpec: string;
    version?: string;
    registry?: string;
    sourceUrl?: string;
    acceptIncompatible?: boolean;
  }) => {
    const gen = generation.current;
    setBusyPlugin(nameOrSpec);
    setError(null);
    setIncompatibleRetry(null);
    try {
      const next = await agentApi.installDshMarketplacePlugin({
        nameOrSpec,
        ...(version ? { version } : {}),
        ...(registry ? { registry } : {}),
        ...((sourceUrl ?? overview?.selectedSource)
          ? { sourceUrl: sourceUrl ?? overview?.selectedSource ?? undefined }
          : {}),
        acceptIncompatible,
      });
      if (!isCurrent(gen)) return;
      syncOverview(next);
      setManualSpec("");
      if (detailName === nameOrSpec) {
        await openDetail(nameOrSpec, version);
      }
      if (next.selectedSource) {
        void fetchCatalogPage({
          sourceUrl: next.selectedSource,
          text: debouncedText,
          category: selectedCategory,
          compatOnly: compatibleOnly,
          sortMode:
            debouncedText.trim() && sort === "index" ? "relevance" : sort,
          offset: 0,
          refresh: false,
          append: false,
        });
      }
    } catch (cause) {
      if (!isCurrent(gen)) return;
      const msg = agentErrorMessage(cause);
      if (msg.startsWith("版本不兼容：") && !acceptIncompatible) {
        setIncompatibleRetry({
          nameOrSpec,
          version,
          registry,
          sourceUrl,
          message: msg,
        });
      } else {
        setError(msg);
      }
    } finally {
      if (isCurrent(gen)) setBusyPlugin(null);
    }
  };

  const handleToggleMarketPlugin = async (name: string, enabled: boolean) => {
    const gen = generation.current;
    setBusyPlugin(name);
    setError(null);
    try {
      const next = await agentApi.setDshMarketplacePluginEnabled(name, enabled);
      if (!isCurrent(gen)) return;
      syncOverview(next);
      setItems((prev) =>
        prev.map((item) => (item.name === name ? { ...item, enabled } : item)),
      );
      if (detail?.name === name) {
        setDetail((prev) => (prev ? { ...prev, enabled } : prev));
      }
    } catch (cause) {
      if (isCurrent(gen)) setError(agentErrorMessage(cause));
    } finally {
      if (isCurrent(gen)) setBusyPlugin(null);
    }
  };

  const handleUninstall = async (name: string) => {
    const gen = generation.current;
    setBusyPlugin(name);
    setError(null);
    try {
      const next = await agentApi.uninstallDshMarketplacePlugin(name);
      if (!isCurrent(gen)) return;
      syncOverview(next);
      setItems((prev) =>
        prev.map((item) =>
          item.name === name
            ? {
                ...item,
                installed: false,
                enabled: false,
                installedVersion: null,
                updateAvailable: false,
              }
            : item,
        ),
      );
      if (detail?.name === name) {
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                installed: false,
                enabled: false,
                installedVersion: null,
              }
            : prev,
        );
      }
    } catch (cause) {
      if (isCurrent(gen)) setError(agentErrorMessage(cause));
    } finally {
      if (isCurrent(gen)) setBusyPlugin(null);
    }
  };

  const handleUpdatePlugin = async (
    name: string,
    version?: string,
    registry?: string,
  ) => {
    const gen = generation.current;
    setBusyPlugin(name);
    setError(null);
    try {
      const next = await agentApi.updateDshMarketplacePlugin(
        name,
        version,
        registry,
      );
      if (!isCurrent(gen)) return;
      syncOverview(next);
      if (detail?.name === name) {
        await openDetail(name, version);
      }
      if (next.selectedSource) {
        void fetchCatalogPage({
          sourceUrl: next.selectedSource,
          text: debouncedText,
          category: selectedCategory,
          compatOnly: compatibleOnly,
          sortMode:
            debouncedText.trim() && sort === "index" ? "relevance" : sort,
          offset: 0,
          refresh: false,
          append: false,
        });
      }
    } catch (cause) {
      if (isCurrent(gen)) setError(agentErrorMessage(cause));
    } finally {
      if (isCurrent(gen)) setBusyPlugin(null);
    }
  };

  const handleToggleHarnessBundle = async (id: string, enabled: boolean) => {
    const gen = generation.current;
    setBusyPlugin(`harness:${id}`);
    setError(null);
    try {
      await agentApi.setHarnessPluginEnabled(id, enabled);
      if (isCurrent(gen)) {
        await fetchOverview(gen);
      }
    } catch (cause) {
      if (isCurrent(gen)) setError(agentErrorMessage(cause));
    } finally {
      if (isCurrent(gen)) setBusyPlugin(null);
    }
  };

  const handleAddSource = async (urlToAdd: string) => {
    const trimmed = urlToAdd.trim();
    if (!trimmed) return;
    const gen = generation.current;
    setBusyPlugin("__source__");
    setError(null);
    try {
      const next = await agentApi.addDshMarketplaceSource(trimmed);
      if (isCurrent(gen)) {
        syncOverview(next);
        setCustomSourceUrl("");
        setSelectedCategory(null);
      }
    } catch (cause) {
      if (isCurrent(gen)) setError(agentErrorMessage(cause));
    } finally {
      if (isCurrent(gen)) setBusyPlugin(null);
    }
  };

  const handleRemoveSource = async (url: string) => {
    const gen = generation.current;
    setBusyPlugin("__source__");
    setError(null);
    try {
      const next = await agentApi.removeDshMarketplaceSource(url);
      if (isCurrent(gen)) {
        syncOverview(next);
        setSelectedCategory(null);
        if (!next.selectedSource) {
          setPage(null);
          setItems([]);
        }
      }
    } catch (cause) {
      if (isCurrent(gen)) setError(agentErrorMessage(cause));
    } finally {
      if (isCurrent(gen)) setBusyPlugin(null);
    }
  };

  const handleSelectSource = async (url: string) => {
    const gen = generation.current;
    setBusyPlugin("__source__");
    setError(null);
    try {
      const next = await agentApi.selectDshMarketplaceSource(url);
      if (isCurrent(gen)) {
        syncOverview(next);
        setSelectedCategory(null);
      }
    } catch (cause) {
      if (isCurrent(gen)) setError(agentErrorMessage(cause));
    } finally {
      if (isCurrent(gen)) setBusyPlugin(null);
    }
  };

  const pickLocalPluginDirectory = async () => {
    const picked = await settingsApi.pickDirectory();
    if (!picked) return;
    await handleInstall({ nameOrSpec: picked });
  };

  const visibleCategories = useMemo(() => {
    const cats = page?.categories ?? [];
    if (showAllCategories || cats.length <= 10) return cats;
    return cats.slice(0, 10);
  }, [page?.categories, showAllCategories]);

  const installedCount = overview?.installed.length ?? 0;
  const activeSourceCount =
    page?.totalInFeed ??
    overview?.sources.find((s) => s.url === overview.selectedSource)
      ?.pluginCount ??
    0;
  const {
    ref: tabsRef,
    rect: tabThumbRect,
    animate: tabThumbAnimate,
  } = useSlidingIndicator<HTMLDivElement>(
    'button[data-tab-active="true"]',
    `${tab}:${installedCount}`,
  );
  const stageKey = detailName ? `detail:${detailName}` : `tab:${tab}`;
  const stageRank = detailName
    ? 3
    : tab === "official"
      ? 0
      : tab === "installed"
        ? 1
        : 2;
  const stageDirection = useNavigationDirection(stageRank, stageKey);

  return (
    <AgentToolPanel
      open={open}
      onClose={onClose}
      hideIntro
      title={chinese ? "插件市场" : "Plugin Marketplace"}
      description={
        chinese
          ? "探索、安装与管理搬运及兼容 DSH (DeepSeek Harness) 生态的社区与官方插件。"
          : "Discover, install, and manage ported and DSH-compatible plugins for your workbench."
      }
      icon={Store}
      projectPath={projectPath}
    >
      <div className="wb-market-shell">
        <div className="wb-market-masthead">
          <section className="wb-market-hero" aria-label="插件市场概览">
            <div className="wb-market-hero-copy">
              <span className="wb-market-hero-eyebrow">
                <Sparkles size={11} aria-hidden="true" />
                <span>
                  {chinese
                    ? "LOVELY STUDIO · 兼容 / 搬运 DSH 插件生态"
                    : "LOVELY STUDIO · PORTED & DSH-COMPATIBLE PLUGINS"}
                </span>
              </span>
              <h2 className="wb-market-hero-title">
                <span>{chinese ? "插件市场" : "Plugin Marketplace"}</span>
                <span className="wb-market-hero-title-tag">
                  {chinese ? "搬运 · 兼容 DSH 插件" : "Ported · DSH Compatible"}
                </span>
                {overview?.runtimeVersion && (
                  <span className="wb-market-hero-pill is-gold">
                    DSH v{overview.runtimeVersion}
                  </span>
                )}
              </h2>
              <p className="wb-market-hero-subtitle">
                {chinese
                  ? "汇聚兼容 DeepSeek Harness (DSH) 运行时的社区插件与官方扩展，一键安装并与工作台联动。"
                  : "Curated ported community plugins and official bundles compatible with the DeepSeek Harness (DSH) runtime."}
              </p>
            </div>

            <div className="wb-market-hero-emblem" aria-hidden="true">
              <div className="wb-market-hero-medallion">
                <Store size={24} strokeWidth={1.7} />
              </div>
              <span className="wb-market-hero-caption">DSH ♡ PLUGINS</span>
            </div>
          </section>

          <div className="wb-market-ribbon">
            <div className="wb-market-ribbon-items">
              <span className="wb-market-ribbon-item is-brand">
                <Sparkles size={12} aria-hidden="true" />
                <span>MAKE SOMETHING LOVELY</span>
              </span>
              <span className="wb-market-ribbon-item">
                {activeSourceCount > 0
                  ? `${activeSourceCount} 个索引扩展`
                  : "Format-1 社区索引"}
              </span>
              <span className="wb-market-ribbon-item">
                已安装 {installedCount} 项
              </span>
              <span className="wb-market-ribbon-item">
                已启用 {overview?.enabledCount ?? 0} 项
              </span>
            </div>
            {onOpenExtensions && (
              <button
                type="button"
                className="wb-market-ribbon-action"
                onClick={() => onOpenExtensions("plugins")}
              >
                管理工作台技能与 MCP
              </button>
            )}
          </div>
        </div>

        <div className="wb-market-panel">
          <div className="wb-market-topbar">
            <div
              ref={tabsRef}
              className="wb-extension-tabs"
              data-in-detail={detailName ? "true" : undefined}
              role="tablist"
              aria-label={chinese ? "插件市场视图" : "Marketplace views"}
            >
              <SegmentThumb
                rect={tabThumbRect}
                animate={tabThumbAnimate}
                className="wb-market-tabs-thumb"
              />
              {(
                [
                  ["official", chinese ? "官方与按需" : "Official"],
                  [
                    "installed",
                    chinese
                      ? `已安装 (${installedCount})`
                      : `Installed (${installedCount})`,
                  ],
                  ["discover", chinese ? "发现市场" : "Discover"],
                ] as const
              ).map(([id, label]) => {
                const selected = !detailName && tab === id;
                const tabActive = tab === id;
                return (
                  <button
                    key={id}
                    role="tab"
                    type="button"
                    id={`${panelId}-${id}`}
                    className={selected ? "is-active" : undefined}
                    aria-selected={selected}
                    data-tab-active={tabActive}
                    onClick={() => {
                      setDetailName(null);
                      setTab(id);
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="wb-market-controls">
              <button
                type="button"
                className="wb-market-btn-secondary rounded-full"
                aria-label={chinese ? "刷新插件目录" : "Refresh catalog"}
                disabled={Boolean(busyPlugin)}
                onClick={() => void refreshAll(true)}
              >
                <RefreshCw
                  size={13}
                  className={
                    busyPlugin === "__refresh__" ? "animate-spin" : undefined
                  }
                />
                {chinese ? "刷新目录" : "Refresh"}
              </button>
            </div>
          </div>

          {error && (
            <div className="wb-market-alert" role="alert">
              <AlertTriangle
                size={15}
                className="shrink-0"
                aria-hidden="true"
              />
              <span>{error}</span>
            </div>
          )}

          {incompatibleRetry && (
            <div className="wb-market-sources-panel" role="alert">
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle
                  size={16}
                  className="mt-0.5 shrink-0 text-amber-600"
                />
                <div className="grid gap-1">
                  <strong>{incompatibleRetry.message}</strong>
                  <span className="text-xs text-fg-2">
                    强行安装不兼容版本的插件可能导致部分功能异常或需随后续运行时升级适配。
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="wb-market-btn-primary"
                  disabled={Boolean(busyPlugin)}
                  onClick={() =>
                    void handleInstall({
                      nameOrSpec: incompatibleRetry.nameOrSpec,
                      version: incompatibleRetry.version,
                      registry: incompatibleRetry.registry,
                      sourceUrl: incompatibleRetry.sourceUrl,
                      acceptIncompatible: true,
                    })
                  }
                >
                  允许兼容豁免并安装
                </button>
                <button
                  type="button"
                  className="wb-market-btn-secondary"
                  onClick={() => setIncompatibleRetry(null)}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          <MotionSurface
            motionKey={stageKey}
            direction={stageDirection}
            className="wb-market-stage"
          >
            {detailName ? (
              <div className="wb-market-detail">
                <div>
                  <button
                    type="button"
                    className="wb-market-btn-secondary"
                    onClick={() => {
                      setDetailName(null);
                      setDetail(null);
                    }}
                  >
                    <ArrowLeft size={14} />
                    {chinese ? "返回插件列表" : "Back to marketplace"}
                  </button>
                </div>
                {loadingDetail && (
                  <p
                    role="status"
                    className="flex items-center gap-2 text-caption"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载插件详情与说明文档…
                  </p>
                )}
                {detailError && (
                  <p role="alert" className="text-caption text-danger-text">
                    {detailError}
                  </p>
                )}
                {detail && (
                  <>
                    <div className="wb-market-detail-hero">
                      <div className="wb-market-card-head">
                        <PluginArtwork
                          src={detail.icon}
                          alt={detail.name}
                          category={detail.category}
                        />
                        <div className="wb-market-card-titles">
                          <div className="wb-market-card-title-row">
                            <h3 className="text-base font-semibold">
                              {resolveLocalizedText(detail.title, chinese) ||
                                detail.name}
                            </h3>
                            {detail.defaultVersion && (
                              <span className="wb-market-badge is-accent">
                                v{detail.defaultVersion}
                              </span>
                            )}
                            {detail.installed && (
                              <span
                                className={`wb-market-badge ${detail.enabled ? "is-success" : ""}`}
                              >
                                {detail.enabled ? "已启用" : "已停用"}
                              </span>
                            )}
                          </div>
                          <span className="wb-market-pkg-id">
                            {detail.name}
                          </span>
                          {resolveLocalizedText(
                            detail.description,
                            chinese,
                          ) && (
                            <p className="mt-2 text-xs text-fg-2 leading-relaxed">
                              {resolveLocalizedText(
                                detail.description,
                                chinese,
                              )}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="wb-market-card-actions">
                        {detail.installed ? (
                          <>
                            <button
                              type="button"
                              className="wb-market-btn-secondary"
                              disabled={busyPlugin === detail.name}
                              onClick={() =>
                                void handleToggleMarketPlugin(
                                  detail.name,
                                  !detail.enabled,
                                )
                              }
                            >
                              {detail.enabled ? "停用" : "启用"}
                            </button>
                            {detail.defaultVersion &&
                              detail.installedVersion &&
                              detail.defaultVersion !==
                                detail.installedVersion && (
                                <button
                                  type="button"
                                  className="wb-market-btn-primary"
                                  disabled={busyPlugin === detail.name}
                                  onClick={() =>
                                    void handleUpdatePlugin(
                                      detail.name,
                                      detail.defaultVersion ?? undefined,
                                    )
                                  }
                                >
                                  更新至 v{detail.defaultVersion}
                                </button>
                              )}
                            <button
                              type="button"
                              className="wb-market-btn-secondary"
                              disabled={busyPlugin === detail.name}
                              onClick={() => void handleUninstall(detail.name)}
                            >
                              <Trash2 size={13} />
                              卸载
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="wb-market-btn-primary"
                            disabled={busyPlugin === detail.name}
                            onClick={() => {
                              const v = detail.versions.find(
                                (ver) => ver.version === detail.defaultVersion,
                              );
                              void handleInstall({
                                nameOrSpec: detail.name,
                                version: detail.defaultVersion ?? undefined,
                                registry: v?.registry ?? undefined,
                              });
                            }}
                          >
                            {busyPlugin === detail.name ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : (
                              <Download size={13} />
                            )}
                            安装{" "}
                            {detail.defaultVersion
                              ? `v${detail.defaultVersion}`
                              : ""}
                          </button>
                        )}
                      </div>
                    </div>

                    {detail.compatibilityIssue && (
                      <div className="wb-extension-hint" role="note">
                        <strong>兼容性提示：</strong>
                        {detail.compatibilityIssue}
                      </div>
                    )}

                    <div className="wb-market-detail-main">
                      <div className="wb-market-detail-card">
                        <h4 className="mb-3 text-sm font-semibold">
                          插件介绍与文档
                        </h4>
                        {detail.readme ? (
                          <SessionMarkdown content={detail.readme} />
                        ) : (
                          <p className="text-xs text-fg-2">
                            {detail.readmeError || "暂无详细 README 文档。"}
                          </p>
                        )}
                      </div>

                      <div className="grid gap-4">
                        <div className="wb-market-detail-card">
                          <h4 className="mb-3 text-sm font-semibold">
                            来源与信息
                          </h4>
                          <dl className="wb-market-facts">
                            <div>
                              <dt>包名</dt>
                              <dd>{detail.name}</dd>
                            </div>
                            {detail.author && (
                              <div>
                                <dt>作者</dt>
                                <dd>{detail.author}</dd>
                              </div>
                            )}
                            {resolveLocalizedText(
                              detail.categoryTitle,
                              chinese,
                            ) && (
                              <div>
                                <dt>分类</dt>
                                <dd>
                                  {resolveLocalizedText(
                                    detail.categoryTitle,
                                    chinese,
                                  )}
                                </dd>
                              </div>
                            )}
                            {detail.installedVersion && (
                              <div>
                                <dt>当前已安装</dt>
                                <dd>v{detail.installedVersion}</dd>
                              </div>
                            )}
                            {detail.homepage && (
                              <div>
                                <dt>主页</dt>
                                <dd>
                                  <button
                                    type="button"
                                    className="inline-flex items-center gap-1 underline"
                                    onClick={() =>
                                      void settingsApi.openExternal(
                                        detail.homepage!,
                                      )
                                    }
                                  >
                                    打开主页
                                    <ExternalLink size={11} />
                                  </button>
                                </dd>
                              </div>
                            )}
                            {detail.repository?.url && (
                              <div>
                                <dt>源代码仓库</dt>
                                <dd>
                                  <button
                                    type="button"
                                    className="inline-flex items-center gap-1 underline"
                                    onClick={() =>
                                      void settingsApi.openExternal(
                                        detail.repository!.url,
                                      )
                                    }
                                  >
                                    查看仓库
                                    <ExternalLink size={11} />
                                  </button>
                                </dd>
                              </div>
                            )}
                          </dl>
                        </div>

                        {detail.versions.length > 0 && (
                          <div className="wb-market-detail-card">
                            <h4 className="text-sm font-semibold">
                              可选版本 ({detail.versions.length})
                            </h4>
                            <div className="wb-market-versions">
                              {detail.versions.slice(0, 20).map((ver) => (
                                <div
                                  className="wb-market-version-row"
                                  key={ver.version}
                                >
                                  <div className="grid gap-0.5">
                                    <span className="font-medium">
                                      v{ver.version}
                                    </span>
                                    <span className="text-[11px] text-fg-2">
                                      {formatDate(ver.publishTimestamp) ?? ""}
                                      {ver.enginesDsh
                                        ? ` · DSH ${ver.enginesDsh}`
                                        : ""}
                                    </span>
                                  </div>
                                  {detail.installedVersion === ver.version ? (
                                    <span className="wb-market-badge is-success">
                                      已安装
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      className="wb-market-btn-secondary"
                                      disabled={busyPlugin === detail.name}
                                      onClick={() =>
                                        void handleInstall({
                                          nameOrSpec: detail.name,
                                          version: ver.version,
                                          registry: ver.registry ?? undefined,
                                        })
                                      }
                                    >
                                      安装
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <>
                {tab === "discover" && (
                  <>
                    <div className="wb-market-toolbar">
                      <label className="wb-market-search">
                        <Search size={16} aria-hidden="true" />
                        <input
                          aria-label="搜索插件"
                          placeholder="搜索插件名称、描述或作者…"
                          value={searchInput}
                          onChange={(e) => setSearchInput(e.target.value)}
                        />
                      </label>
                      <div className="wb-market-controls">
                        <select
                          aria-label="排序方式"
                          className="wb-market-select"
                          value={sort}
                          onChange={(e) =>
                            setSort(
                              e.target.value as
                                | "index"
                                | "relevance"
                                | "published"
                                | "name",
                            )
                          }
                        >
                          <option value="index">默认顺序</option>
                          <option value="relevance">最佳匹配</option>
                          <option value="published">最新发布</option>
                          <option value="name">包名排序</option>
                        </select>
                        <button
                          type="button"
                          className="wb-market-chip"
                          aria-pressed={compatibleOnly}
                          onClick={() => setCompatibleOnly((v) => !v)}
                        >
                          <CheckCircle2 size={13} />
                          仅看兼容当前版本
                        </button>
                        <button
                          type="button"
                          className="wb-market-chip"
                          aria-pressed={sourcesOpen}
                          onClick={() => setSourcesOpen((v) => !v)}
                        >
                          <Database size={13} />
                          索引源 ({overview?.sources.length ?? 0})
                        </button>
                      </div>
                    </div>

                    {sourcesOpen && overview && (
                      <section
                        className="wb-market-sources-panel"
                        aria-label="索引源管理"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <h3 className="text-sm font-semibold">
                              插件市场索引源 (Format 1)
                            </h3>
                            <p className="mt-0.5 text-xs text-fg-2">
                              支持官方及社区 Format-1 JSON
                              索引地址；仅从可信来源添加索引。
                            </p>
                          </div>
                          <button
                            type="button"
                            className="wb-market-btn-secondary"
                            onClick={() => setSourcesOpen(false)}
                          >
                            收起
                          </button>
                        </div>

                        <div className="grid gap-2">
                          {overview.sources.map((src) => (
                            <div className="wb-market-source-row" key={src.url}>
                              <div className="grid gap-0.5 min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <strong className="text-xs">
                                    {resolveLocalizedText(src.title, chinese) ||
                                      src.presetLabel ||
                                      src.url}
                                  </strong>
                                  {src.pluginCount !== null &&
                                    src.pluginCount !== undefined && (
                                      <span className="wb-market-badge">
                                        {src.pluginCount} 个插件
                                      </span>
                                    )}
                                  {overview.selectedSource === src.url && (
                                    <span className="wb-market-badge is-accent">
                                      当前使用
                                    </span>
                                  )}
                                </div>
                                <span className="wb-market-pkg-id">
                                  {src.url}
                                </span>
                                {src.error && (
                                  <span className="text-[11px] text-danger-text">
                                    {src.error}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                {overview.selectedSource !== src.url && (
                                  <button
                                    type="button"
                                    className="wb-market-btn-secondary"
                                    disabled={Boolean(busyPlugin)}
                                    onClick={() =>
                                      void handleSelectSource(src.url)
                                    }
                                  >
                                    切换
                                  </button>
                                )}
                                <button
                                  type="button"
                                  aria-label={`移除索引源 ${src.url}`}
                                  className="wb-market-btn-secondary"
                                  disabled={Boolean(busyPlugin)}
                                  onClick={() =>
                                    void handleRemoveSource(src.url)
                                  }
                                >
                                  <Trash2 size={12} />
                                  移除
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>

                        {overview.presets.some((p) => !p.added) && (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-fg-2">
                              快速添加镜像：
                            </span>
                            {overview.presets
                              .filter((p) => !p.added)
                              .map((preset) => (
                                <button
                                  key={preset.url}
                                  type="button"
                                  className="wb-market-chip"
                                  disabled={Boolean(busyPlugin)}
                                  onClick={() =>
                                    void handleAddSource(preset.url)
                                  }
                                >
                                  <Plus size={12} />
                                  {preset.label}
                                </button>
                              ))}
                          </div>
                        )}

                        <form
                          className="wb-market-manual-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void handleAddSource(customSourceUrl);
                          }}
                        >
                          <input
                            aria-label="自定义索引 URL"
                            placeholder="输入 Format-1 插件索引 URL（例如 https://.../index.json）"
                            value={customSourceUrl}
                            onChange={(e) => setCustomSourceUrl(e.target.value)}
                          />
                          <button
                            type="submit"
                            className="wb-market-btn-primary"
                            disabled={
                              !customSourceUrl.trim() || Boolean(busyPlugin)
                            }
                          >
                            <Plus size={13} />
                            添加索引源
                          </button>
                        </form>
                      </section>
                    )}

                    {page && page.categories.length > 0 && (
                      <div
                        className="wb-market-categories"
                        role="group"
                        aria-label="插件分类筛选"
                      >
                        <button
                          type="button"
                          className="wb-market-chip"
                          aria-pressed={selectedCategory === null}
                          onClick={() => setSelectedCategory(null)}
                        >
                          全部分类 ({page.totalInFeed})
                        </button>
                        {visibleCategories.map((cat) => (
                          <button
                            key={cat.id}
                            type="button"
                            className="wb-market-chip"
                            aria-pressed={selectedCategory === cat.id}
                            onClick={() =>
                              setSelectedCategory((prev) =>
                                prev === cat.id ? null : cat.id,
                              )
                            }
                          >
                            {resolveLocalizedText(cat.title, chinese) || cat.id}{" "}
                            ({cat.count})
                          </button>
                        ))}
                        {page.categories.length > 10 && (
                          <button
                            type="button"
                            className="wb-market-chip"
                            onClick={() => setShowAllCategories((v) => !v)}
                          >
                            {showAllCategories
                              ? "收起分类"
                              : `更多分类 (+${page.categories.length - 10})`}
                          </button>
                        )}
                      </div>
                    )}

                    {page && (
                      <div className="wb-market-status-bar">
                        <span>
                          当前索引：
                          <strong>
                            {resolveLocalizedText(page.feedTitle, chinese) ||
                              page.sourceUrl}
                          </strong>
                          {" · "}共 {page.total} 个匹配插件
                          {page.fromCache ? "（已优先使用本地缓存）" : ""}
                        </span>
                        {page.error && (
                          <span className="text-danger-text">{page.error}</span>
                        )}
                      </div>
                    )}

                    {!overview?.selectedSource && !loadingOverview ? (
                      <div className="wb-skills-empty">
                        <Store size={28} aria-hidden="true" />
                        <h3>还没有配置插件市场索引源</h3>
                        <p>
                          打开“索引源”添加一个 Format-1 兼容 DSH
                          插件索引开始浏览。
                        </p>
                        <button
                          type="button"
                          className="wb-market-btn-primary"
                          onClick={() => setSourcesOpen(true)}
                        >
                          管理索引源
                        </button>
                      </div>
                    ) : loadingPage || loadingOverview ? (
                      <p
                        role="status"
                        className="flex items-center gap-2 text-caption"
                      >
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在读取兼容 DSH 的插件市场目录…
                      </p>
                    ) : items.length === 0 ? (
                      <div className="wb-skills-empty">
                        <Blocks size={28} aria-hidden="true" />
                        <h3>没有找到符合条件的插件</h3>
                        <p>
                          试试修改搜索词、切换分类，或关闭“仅看兼容当前版本”筛选。
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="wb-market-grid">
                          {items.map((item) => {
                            const displayTitle =
                              resolveLocalizedText(item.title, chinese) ||
                              item.name;
                            const desc = resolveLocalizedText(
                              item.description,
                              chinese,
                            );
                            const catTitle = resolveLocalizedText(
                              item.categoryTitle,
                              chinese,
                            );
                            const isBusy = busyPlugin === item.name;
                            return (
                              <article
                                className="wb-market-card"
                                key={item.name}
                              >
                                <div className="wb-market-card-head">
                                  <PluginArtwork
                                    src={item.icon}
                                    alt={displayTitle}
                                    category={item.category}
                                  />
                                  <div className="wb-market-card-titles">
                                    <div className="wb-market-card-title-row">
                                      <button
                                        type="button"
                                        className="wb-market-card-link"
                                        onClick={() =>
                                          void openDetail(
                                            item.name,
                                            item.defaultVersion ?? undefined,
                                          )
                                        }
                                      >
                                        {displayTitle}
                                      </button>
                                    </div>
                                    <span className="wb-market-pkg-id">
                                      {item.name}
                                    </span>
                                  </div>
                                  <div className="wb-market-card-status">
                                    {item.installed ? (
                                      <span
                                        className={`wb-market-badge ${
                                          item.enabled ? "is-success" : ""
                                        }`}
                                      >
                                        {item.enabled
                                          ? "已启用"
                                          : "已安装未启用"}
                                      </span>
                                    ) : item.compatible ? (
                                      <span className="wb-market-badge is-accent">
                                        兼容
                                      </span>
                                    ) : (
                                      <span className="wb-market-badge is-warning">
                                        要求 {item.enginesDsh || "更高版本"}
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {desc && (
                                  <p
                                    className="wb-market-card-desc"
                                    title={desc}
                                  >
                                    {desc}
                                  </p>
                                )}

                                <div className="wb-market-card-footer">
                                  <div className="wb-market-card-meta">
                                    {catTitle && (
                                      <span className="wb-market-meta-cat">
                                        {catTitle}
                                      </span>
                                    )}
                                    {item.defaultVersion && (
                                      <span>v{item.defaultVersion}</span>
                                    )}
                                    {item.author && (
                                      <span
                                        className="wb-market-meta-author"
                                        title={`作者：${item.author}`}
                                      >
                                        {item.author}
                                      </span>
                                    )}
                                  </div>
                                  <div className="wb-market-card-actions">
                                    <button
                                      type="button"
                                      className="wb-market-btn-secondary"
                                      onClick={() =>
                                        void openDetail(
                                          item.name,
                                          item.defaultVersion ?? undefined,
                                        )
                                      }
                                    >
                                      详情
                                    </button>
                                    {item.installed ? (
                                      item.updateAvailable ? (
                                        <button
                                          type="button"
                                          className="wb-market-btn-primary"
                                          disabled={isBusy}
                                          onClick={() =>
                                            void handleUpdatePlugin(
                                              item.name,
                                              item.defaultVersion ?? undefined,
                                              item.registry ?? undefined,
                                            )
                                          }
                                        >
                                          {isBusy ? (
                                            <Loader2
                                              size={12}
                                              className="animate-spin"
                                            />
                                          ) : null}
                                          更新
                                        </button>
                                      ) : (
                                        <button
                                          type="button"
                                          className="wb-market-btn-secondary"
                                          disabled={isBusy}
                                          onClick={() =>
                                            void handleToggleMarketPlugin(
                                              item.name,
                                              !item.enabled,
                                            )
                                          }
                                        >
                                          {item.enabled ? "停用" : "启用"}
                                        </button>
                                      )
                                    ) : (
                                      <button
                                        type="button"
                                        className="wb-market-btn-primary"
                                        disabled={isBusy}
                                        onClick={() =>
                                          void handleInstall({
                                            nameOrSpec: item.name,
                                            version:
                                              item.defaultVersion ?? undefined,
                                            registry:
                                              item.registry ?? undefined,
                                            sourceUrl: page?.sourceUrl,
                                          })
                                        }
                                      >
                                        {isBusy ? (
                                          <Loader2
                                            size={12}
                                            className="animate-spin"
                                          />
                                        ) : (
                                          <Download size={12} />
                                        )}
                                        安装
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </article>
                            );
                          })}
                        </div>

                        {page?.nextOffset !== null &&
                          page?.nextOffset !== undefined && (
                            <div className="wb-market-load-more">
                              <button
                                type="button"
                                className="wb-market-btn-secondary"
                                disabled={loadingMore}
                                onClick={() =>
                                  void fetchCatalogPage({
                                    sourceUrl: page.sourceUrl,
                                    text: debouncedText,
                                    category: selectedCategory,
                                    compatOnly: compatibleOnly,
                                    sortMode:
                                      debouncedText.trim() && sort === "index"
                                        ? "relevance"
                                        : sort,
                                    offset: page.nextOffset ?? 0,
                                    refresh: false,
                                    append: true,
                                  })
                                }
                              >
                                {loadingMore ? (
                                  <Loader2 size={13} className="animate-spin" />
                                ) : null}
                                加载更多插件（已显示 {items.length} /{" "}
                                {page.total}）
                              </button>
                            </div>
                          )}
                      </>
                    )}
                  </>
                )}

                {tab === "official" && !overview && loadingOverview && (
                  <p
                    role="status"
                    className="flex items-center gap-2 text-caption"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载官方扩展与运行状态…
                  </p>
                )}

                {tab === "official" && overview && (
                  <div className="grid gap-6">
                    <section className="wb-harness-plugins">
                      <div className="wb-harness-plugin-heading">
                        <div>
                          <h2>DeepSeek Harness 内置官方扩展</h2>
                          <p>
                            随 LoliCode
                            内核直接附带的官方能力包，开启后会在下一轮 Harness
                            对话自动装载。
                          </p>
                        </div>
                      </div>
                      <div className="wb-skills-grid">
                        {overview.harnessBundles.map((bundle) => {
                          const label = HARNESS_BUNDLE_LABELS[bundle.id];
                          const title = label?.name || bundle.name;
                          return (
                            <article
                              className="wb-extension-card"
                              key={bundle.id}
                            >
                              <div className="wb-extension-card-heading">
                                <Sparkles size={16} aria-hidden="true" />
                                <h3>{title}</h3>
                                <MarketToggleSwitch
                                  ariaLabel={`启用内置扩展 ${title}`}
                                  checked={bundle.enabled}
                                  disabled={
                                    busyPlugin === `harness:${bundle.id}`
                                  }
                                  onChange={(checked) =>
                                    void handleToggleHarnessBundle(
                                      bundle.id,
                                      checked,
                                    )
                                  }
                                />
                              </div>
                              <p>{label?.description || bundle.description}</p>
                              <div className="wb-extension-meta">
                                <span>{bundle.name}</span>
                                <span>v{bundle.version}</span>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>

                    <section className="wb-harness-plugins">
                      <div className="wb-harness-plugin-heading">
                        <div>
                          <h2>官方按需下载扩展 (On-Demand)</h2>
                          <p>
                            DeepSeek Harness
                            官方提供的按需扩展包，安装版本号锁定与当前运行内核一致（v
                            {overview.runtimeVersion}）。
                          </p>
                        </div>
                      </div>
                      <div className="wb-skills-grid">
                        {overview.onDemandOfficial.map((item) => {
                          const isBusy = busyPlugin === item.name;
                          return (
                            <article
                              className="wb-extension-card"
                              key={item.name}
                            >
                              <div className="wb-extension-card-heading">
                                <Package size={16} aria-hidden="true" />
                                <h3>{chinese ? item.title : item.titleEn}</h3>
                                {item.installed && (
                                  <MarketToggleSwitch
                                    ariaLabel={`启用按需扩展 ${item.title}`}
                                    checked={item.enabled}
                                    disabled={isBusy}
                                    onChange={(checked) =>
                                      void handleToggleMarketPlugin(
                                        item.name,
                                        checked,
                                      )
                                    }
                                  />
                                )}
                              </div>
                              <p>
                                {chinese
                                  ? item.description
                                  : item.descriptionEn}
                              </p>
                              <div className="wb-extension-meta">
                                <span>
                                  {item.name} · v
                                  {item.installedVersion || item.targetVersion}
                                </span>
                                <div className="flex items-center gap-2">
                                  {item.installed ? (
                                    <button
                                      type="button"
                                      disabled={isBusy}
                                      onClick={() =>
                                        void handleUninstall(item.name)
                                      }
                                    >
                                      <Trash2 size={12} />
                                      卸载
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="wb-market-btn-primary"
                                      disabled={isBusy}
                                      onClick={() =>
                                        void handleInstall({
                                          nameOrSpec: item.name,
                                          version: item.targetVersion,
                                        })
                                      }
                                    >
                                      {isBusy ? (
                                        <Loader2
                                          size={12}
                                          className="animate-spin"
                                        />
                                      ) : (
                                        <Download size={12} />
                                      )}
                                      一键安装
                                    </button>
                                  )}
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  </div>
                )}

                {tab === "installed" && overview && (
                  <div className="grid gap-5">
                    <form
                      className="wb-market-manual-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleInstall({ nameOrSpec: manualSpec });
                      }}
                    >
                      <input
                        aria-label="手动安装插件包名或版本"
                        placeholder="输入兼容 DSH 的插件 npm 包名（例如 dsh-plan-note 或 @scope/pkg@1.0.0）"
                        value={manualSpec}
                        disabled={Boolean(busyPlugin)}
                        onChange={(e) => setManualSpec(e.target.value)}
                      />
                      <button
                        type="submit"
                        className="wb-market-btn-primary"
                        disabled={!manualSpec.trim() || Boolean(busyPlugin)}
                      >
                        <Download size={13} />
                        安装扩展
                      </button>
                      <button
                        type="button"
                        className="wb-market-btn-secondary"
                        disabled={Boolean(busyPlugin)}
                        onClick={() => void pickLocalPluginDirectory()}
                      >
                        <FolderOpen size={13} />
                        导入本地插件目录
                      </button>
                    </form>

                    {overview.installed.length === 0 ? (
                      <div className="wb-skills-empty">
                        <Package size={28} aria-hidden="true" />
                        <h3>还没有安装社区或按需插件</h3>
                        <p>
                          可以在“发现市场”或“官方与按需”页面选择扩展安装，或在上方输入包名手动安装。
                        </p>
                        <button
                          type="button"
                          className="wb-market-btn-primary"
                          onClick={() => setTab("discover")}
                        >
                          去发现市场浏览
                        </button>
                      </div>
                    ) : (
                      <div className="wb-market-grid">
                        {overview.installed.map((plugin) => {
                          const title =
                            resolveLocalizedText(plugin.title, chinese) ||
                            plugin.name;
                          const desc = resolveLocalizedText(
                            plugin.description,
                            chinese,
                          );
                          const isBusy = busyPlugin === plugin.name;
                          return (
                            <article
                              className="wb-market-card"
                              key={plugin.name}
                            >
                              <div className="wb-market-card-head">
                                <PluginArtwork
                                  src={plugin.icon}
                                  alt={title}
                                  category={plugin.category}
                                />
                                <div className="wb-market-card-titles">
                                  <div className="wb-market-card-title-row">
                                    <button
                                      type="button"
                                      className="wb-market-card-link"
                                      onClick={() =>
                                        void openDetail(
                                          plugin.name,
                                          plugin.version,
                                        )
                                      }
                                    >
                                      {title}
                                    </button>
                                  </div>
                                  <span className="wb-market-pkg-id">
                                    {plugin.name} · v{plugin.version}
                                    {plugin.author ? ` · ${plugin.author}` : ""}
                                  </span>
                                </div>
                                <div className="wb-market-card-status">
                                  <MarketToggleSwitch
                                    ariaLabel={`启用插件 ${title}`}
                                    checked={plugin.enabled}
                                    disabled={isBusy}
                                    onChange={(checked) =>
                                      void handleToggleMarketPlugin(
                                        plugin.name,
                                        checked,
                                      )
                                    }
                                  />
                                </div>
                              </div>
                              {desc && (
                                <p className="wb-market-card-desc">{desc}</p>
                              )}
                              <div className="wb-market-card-footer">
                                <div className="wb-market-card-meta">
                                  <span className="wb-market-meta-cat">
                                    {plugin.sourceType === "local"
                                      ? "本地目录"
                                      : plugin.sourceType === "on-demand"
                                        ? "官方按需"
                                        : "npm 安装"}
                                  </span>
                                  {plugin.hasBundle ? (
                                    <span className="wb-market-meta-detail">
                                      已接入 Harness
                                    </span>
                                  ) : plugin.hasClient ? (
                                    <span className="wb-market-meta-detail">
                                      仅前端包
                                    </span>
                                  ) : null}
                                </div>
                                <div className="wb-market-card-actions">
                                  <button
                                    type="button"
                                    className="wb-market-btn-secondary"
                                    onClick={() =>
                                      void openDetail(
                                        plugin.name,
                                        plugin.version,
                                      )
                                    }
                                  >
                                    详情
                                  </button>
                                  <button
                                    type="button"
                                    className="wb-market-btn-secondary"
                                    disabled={isBusy}
                                    onClick={() =>
                                      void handleUninstall(plugin.name)
                                    }
                                  >
                                    <Trash2 size={12} />
                                    卸载
                                  </button>
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}

                    {onOpenExtensions && (
                      <div className="wb-extension-hint flex flex-wrap items-center justify-between gap-3">
                        <span>
                          需要管理本地技能 (SKILL.md)、ZCode CLI 扩展包或远程
                          MCP 工具？
                        </span>
                        <button
                          type="button"
                          className="wb-market-btn-secondary"
                          onClick={() => onOpenExtensions("skills")}
                        >
                          打开技能与 MCP 管理
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </MotionSurface>

          {overview?.pendingReload && (
            <div className="wb-extension-reload" role="status">
              <p>
                {working
                  ? "插件市场配置已保存。当前任务结束后，下一轮 Harness 对话将自动应用已启用的扩展。"
                  : "插件配置已更新并同步至 Harness 会话配置，新发出的消息将直接携带最新扩展运行。"}
              </p>
            </div>
          )}
        </div>
      </div>
    </AgentToolPanel>
  );
}
