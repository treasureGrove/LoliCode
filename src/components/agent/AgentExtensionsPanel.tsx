import { useContext, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  Blocks,
  Check,
  ExternalLink,
  FilePlus2,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogClose,
  DialogFooter,
} from "@/components/ui/dialog";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import { WindowControlsContext } from "@/components/shell/AppPageHeader";
import type {
  AgentExtensionConfig,
  AgentExtensions,
  AgentPluginStore,
  AgentSkill,
} from "@/types/agent";

const RUNTIME_LABELS: Record<string, string> = {
  not_running: "未启动项目",
  connected: "已连接",
  disconnected: "未连接",
  connecting: "正在连接",
  loaded: "已载入",
  available: "按需可用",
  active: "已载入",
  failed: "载入失败",
  needs_auth: "需要登录",
  pending_reload: "待重新载入",
  disabled: "未启用",
  not_loaded: "未载入",
  unknown: "运行状态待确认",
};
const runtimeLabel = (status?: string) =>
  RUNTIME_LABELS[status || ""] || status;
const localizedPluginText = (
  fallback: string | undefined,
  translations: Record<string, string> | undefined,
) => {
  const locale = document.documentElement.lang || navigator.language || "zh-CN";
  if (translations) {
    const exact = translations[locale];
    if (exact) return exact;
    const language = locale.split("-")[0]?.toLowerCase();
    const match = Object.entries(translations).find(
      ([key, value]) => key.split("-")[0]?.toLowerCase() === language && value,
    );
    if (match?.[1]) return match[1];
  }
  return fallback;
};
const pluginCategoryLabel = (category: string) =>
  ({
    "developer-tools": "开发工具",
    productivity: "生产力",
    utilities: "实用工具",
    legal: "法律",
    template: "模板",
    finance: "财务",
    other: "其他",
  })[category] || category;
const BUNDLED_SKILL_LABELS: Record<string, { name: string; summary: string }> =
  {
    "skill-creator": {
      name: "技能创建",
      summary: "把常用工作流程整理成可重复使用的技能。",
    },
    docx: {
      name: "Word 文档",
      summary: "创建、编辑和转换 Word 文档，支持修订与批注。",
    },
    pdf: { name: "PDF 文档", summary: "读取、生成、转换和处理 PDF 文件。" },
    pptx: { name: "PPT 演示文稿", summary: "制作、编辑和导出演示文稿。" },
    xlsx: { name: "Excel 表格", summary: "创建、编辑和分析电子表格。" },
  };

export function AgentExtensionsPanel({
  open: visible,
  onOpenChange,
  working,
  onReload,
  onUseSkill,
  projectOpen = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  working: boolean;
  onReload: () => Promise<void>;
  onUseSkill?: (skill: AgentSkill) => void;
  projectOpen?: boolean;
}) {
  const [catalog, setCatalog] = useState<AgentExtensions | null>(null);
  const [pluginStore, setPluginStore] = useState<AgentPluginStore | null>(null);
  const [tab, setTab] = useState<"skills" | "plugins" | "mcp">("skills");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [serverName, setServerName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [serverToken, setServerToken] = useState("");
  const [marketplaceQuery, setMarketplaceQuery] = useState("");
  const [marketplaceSegment, setMarketplaceSegment] = useState<
    "public" | "personal"
  >("public");
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [marketplaceSourcesOpen, setMarketplaceSourcesOpen] = useState(false);
  const [installedManagementOpen, setInstalledManagementOpen] = useState(false);
  const windowControls = useContext(WindowControlsContext);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const pending = useRef<{ id: number; generation: number } | null>(null);
  const loading = useRef<number | null>(null);
  const catalogRequestId = useRef(0);
  const operationId = useRef(0);
  const generation = useRef(0);
  const isCurrent = (current: number) =>
    visibleRef.current && generation.current === current;
  const dismiss = () => {
    // Invalidate synchronously: an IPC reply may arrive before effect cleanup.
    generation.current += 1;
    visibleRef.current = false;
    onOpenChange(false);
  };
  const readCatalog = async (current: number) => {
    const requestId = ++catalogRequestId.current;
    loading.current = requestId;
    setBusy(true);
    setError(null);
    try {
      const [next, store] = await Promise.all([
        agentApi.getExtensions(),
        agentApi
          .getPluginStore()
          .catch(
            (cause): AgentPluginStore => ({
              marketplaces: [],
              availablePlugins: [],
              installedPlugins: [],
              restorableBuiltins: [],
              diagnostics: [
                { severity: "error", message: agentErrorMessage(cause) },
              ],
              capability: {
                supported: false,
                reason: agentErrorMessage(cause),
                customSources: false,
                localPluginRuntime: false,
                mcpRuntime: false,
              },
            }),
          ),
      ]);
      if (isCurrent(current) && loading.current === requestId) {
        setCatalog(next);
        setPluginStore(store);
        setNeedsReload(Boolean(next.pendingReload));
      }
    } catch (cause) {
      if (isCurrent(current) && loading.current === requestId)
        setError(agentErrorMessage(cause));
    } finally {
      if (loading.current === requestId) loading.current = null;
      if (isCurrent(current))
        setBusy(Boolean(pending.current || loading.current));
    }
  };
  useEffect(() => {
    const current = ++generation.current;
    loading.current = null;
    if (!visible) return;
    setCatalog(null);
    setPluginStore(null);
    setNeedsReload(false);
    void readCatalog(current);
    return () => {
      generation.current += 1;
      loading.current = null;
    };
  }, [visible]);
  const run = async (
    operation: () => Promise<AgentExtensions | null>,
    markReload = true,
  ) => {
    const current = generation.current;
    if (!isCurrent(current) || pending.current) return false;
    const id = ++operationId.current;
    pending.current = { id, generation: current };
    setBusy(true);
    setError(null);
    let changed = false;
    try {
      const next = await operation();
      changed = markReload && Boolean(next);
      if (next && isCurrent(current)) {
        setCatalog(next);
        setNeedsReload(markReload || Boolean(next.pendingReload));
        if (tab === "plugins") {
          try {
            const store = await agentApi.getPluginStore();
            if (isCurrent(current)) setPluginStore(store);
          } catch {
            // The extension mutation already succeeded; keep its result visible
            // and let the marketplace refresh control retry the catalog read.
          }
        }
      }
      return isCurrent(current) && Boolean(next);
    } catch (cause) {
      if (isCurrent(current)) setError(agentErrorMessage(cause));
      return false;
    } finally {
      // Dismissal does not cancel a dispatched write. Keep its mutation lock
      // across reopen, then read fresh state instead of applying its old reply.
      if (changed && !isCurrent(current) && visibleRef.current)
        await readCatalog(generation.current);
      if (pending.current?.id === id) pending.current = null;
      if (visibleRef.current) setBusy(Boolean(loading.current));
    }
  };
  const runStore = async (
    operation: () => Promise<AgentPluginStore>,
    markReload = false,
  ) => {
    const current = generation.current;
    if (!isCurrent(current) || pending.current) return false;
    const id = ++operationId.current;
    pending.current = { id, generation: current };
    setBusy(true);
    setError(null);
    let changed = false;
    try {
      const next = await operation();
      changed = true;
      if (isCurrent(current)) {
        setPluginStore(next);
        if (markReload) setNeedsReload(true);
      }
      return isCurrent(current);
    } catch (cause) {
      if (isCurrent(current)) setError(agentErrorMessage(cause));
      return false;
    } finally {
      if (changed && !isCurrent(current) && visibleRef.current)
        await readCatalog(generation.current);
      if (pending.current?.id === id) pending.current = null;
      if (visibleRef.current) setBusy(Boolean(loading.current));
    }
  };
  const pickSkill = () => {
    const current = generation.current;
    return run(async () => {
      const path = await settingsApi.pickDirectory();
      return path && isCurrent(current) ? agentApi.importSkill(path) : null;
    });
  };
  const pickPlugin = (directory: boolean) => {
    const current = generation.current;
    return run(async () => {
      const selected = await open({
        directory,
        multiple: false,
        title: directory ? "选择插件目录" : "选择 OpenCode v2 插件文件",
        ...(!directory && {
          filters: [{ name: "插件", extensions: ["js", "mjs", "ts"] }],
        }),
      });
      return typeof selected === "string" && isCurrent(current)
        ? agentApi.installPlugin(selected)
        : null;
    });
  };
  const pickMarketplaceDirectory = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择插件市场目录",
      });
      if (typeof selected === "string") setMarketplaceSource(selected);
    } catch {
      // Keep the source form as-is if the native picker is dismissed.
    }
  };
  const updateMcp = (
    update: (servers: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const current = generation.current;
    return run(async () => {
      const config = await agentApi.getExtensionConfig();
      if (!isCurrent(current)) return null;
      const raw = config.mcp.servers;
      const servers =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const next: AgentExtensionConfig = {
        ...config,
        mcp: { ...config.mcp, servers: update(servers) },
      };
      return agentApi.saveExtensionConfig(next);
    });
  };
  const addMcp = async () => {
    const current = generation.current;
    const id = serverName.trim();
    if (!id || !serverUrl.trim()) return;
    try {
      const url = new URL(serverUrl.trim());
      if (!/^https?:$/.test(url.protocol))
        throw new Error("请填写 http 或 https 服务地址。");
      const saved = await updateMcp((servers) => {
        if (id in servers)
          throw new Error("这个服务名称已存在，请换一个名称。");
        return {
          ...servers,
          [id]: {
            type: "remote",
            url: url.toString(),
            ...(serverToken.trim() && {
              headers: { Authorization: `Bearer ${serverToken.trim()}` },
            }),
          },
        };
      });
      if (saved && isCurrent(current)) {
        setServerName("");
        setServerUrl("");
        setServerToken("");
      }
    } catch (cause) {
      if (isCurrent(current)) setError(agentErrorMessage(cause));
    }
  };
  const reload = async () => {
    if (working) return;
    const current = generation.current;
    await run(async () => {
      await onReload();
      return isCurrent(current) ? agentApi.getExtensions() : null;
    }, false);
  };
  const storeMarketplaces = pluginStore?.marketplaces ?? [];
  const supportsCustomSources = pluginStore?.capability.customSources !== false;
  const supportsLocalPluginRuntime =
    pluginStore?.capability.localPluginRuntime !== false;
  const installedStorePlugins = pluginStore?.installedPlugins ?? [];
  const installedStoreById = new Map(
    installedStorePlugins.map((plugin) => [plugin.id, plugin]),
  );
  const isPublicMarketplace = (id: string) => {
    const marketplace = storeMarketplaces.find((item) => item.id === id);
    return Boolean(
      marketplace?.isOfficial ||
        id === "zcode-plugins-official" ||
        id === "zcode-plugins",
    );
  };
  const marketplaceItems = [
    ...(pluginStore?.availablePlugins ?? []),
    ...(pluginStore?.restorableBuiltins ?? []),
  ].filter(
    (item, index, all) =>
      all.findIndex((other) => other.id === item.id) === index,
  );
  const visibleMarketplaceItems = marketplaceItems.filter((item) => {
    if (item.listing?.requiresPaidPlan) return false;
    if (
      marketplaceSegment === "public" &&
      !isPublicMarketplace(item.marketplace)
    )
      return false;
    if (
      marketplaceSegment === "personal" &&
      isPublicMarketplace(item.marketplace)
    )
      return false;
    const query = marketplaceQuery.trim().toLocaleLowerCase();
    if (!query) return true;
    const market = storeMarketplaces.find(
      (entry) => entry.id === item.marketplace,
    );
    return [
      item.listing?.displayName,
      item.name,
      item.description,
      item.listing?.author,
      item.listing?.category,
      market?.name,
    ].some((value) => value?.toLocaleLowerCase().includes(query));
  });
  const marketplaceCategories = new Map<
    string,
    typeof visibleMarketplaceItems
  >();
  for (const item of visibleMarketplaceItems) {
    const category = pluginCategoryLabel(
      item.listing?.category?.trim() || "other",
    );
    marketplaceCategories.set(category, [
      ...(marketplaceCategories.get(category) ?? []),
      item,
    ]);
  }
  const submitMarketplaceSource = async () => {
    const value = marketplaceSource.trim();
    if (!value) return;
    const added = await runStore(() => agentApi.addPluginMarketplace(value));
    if (added) setMarketplaceSource("");
  };
  return (
    <Dialog
      open={visible}
      onOpenChange={(value) => {
        if (value) onOpenChange(true);
        else dismiss();
      }}
    >
      <DialogContent
        className="wb-extensions"
        onOpenAutoFocus={(event) => {
          opener.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          event.preventDefault();
          closeButton.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (visibleRef.current) return;
          if (opener.current?.isConnected) opener.current.focus();
        }}
      >
        <DialogHeader className="wb-extension-header">
          <div className="wb-extension-heading">
            <DialogTitle>技能与插件</DialogTitle>
            <DialogDescription>
              只配置 LoliCode 工作台，已安装的技能可以由 Agent 按任务选用。
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <button
              ref={closeButton}
              type="button"
              className="wb-extension-close"
              aria-label="关闭弹窗"
              title="关闭技能与插件"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </DialogClose>
        </DialogHeader>
        <div className="wb-extension-tabs" role="tablist" aria-label="扩展类型">
          {(
            [
              ["skills", "技能"],
              ["plugins", "插件"],
              ["mcp", "MCP 工具"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-caption text-danger-text">
            {error}
          </p>
        )}
        {busy && !catalog && (
          <p role="status" className="flex gap-2 text-caption">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取扩展…
          </p>
        )}
        {!catalog && !busy && error && (
          <button
            className="wb-mode-button"
            onClick={() => {
              void run(async () => agentApi.getExtensions(), false);
            }}
          >
            重新读取
          </button>
        )}
        <div className="wb-extension-list">
          {catalog?.runtimeRunning === false && (
            <p className="wb-extension-hint">
              打开项目后，工作台会载入已启用的扩展。
            </p>
          )}
          {catalog?.loadedPlugins
            ?.filter((plugin) => plugin.error)
            .map((plugin, index) => (
              <p
                key={plugin.id || index}
                role="alert"
                className="text-caption text-danger-text"
              >
                插件{plugin.id ? ` ${plugin.id}` : ""}载入失败：{plugin.error}
              </p>
            ))}
          {catalog?.loadedMcpServers
            ?.filter((server) => server.error)
            .map((server) => (
              <p
                key={server.name}
                role="alert"
                className="text-caption text-danger-text"
              >
                {server.name}：{server.error}
              </p>
            ))}
          {tab === "skills" && (
            <>
              <div className="wb-extension-actions">
                <button
                  className="wb-mode-button"
                  disabled={busy}
                  onClick={() => void pickSkill()}
                >
                  <FolderOpen size={14} />
                  导入技能目录
                </button>
              </div>
              {catalog?.skills.map((skill) => {
                const display =
                  skill.source === "bundled"
                    ? BUNDLED_SKILL_LABELS[skill.name]
                    : undefined;
                return (
                  <article className="wb-extension-card" key={skill.id}>
                    <div className="wb-extension-card-heading">
                      <Sparkles size={16} />
                      <h3>{display?.name || skill.name}</h3>
                      {display && (
                        <small className="wb-extension-original-name">
                          {skill.name}
                        </small>
                      )}
                      <span>
                        {skill.source === "bundled"
                          ? "内置"
                          : skill.source === "marketplace"
                            ? "CLI 插件"
                            : "本地"}
                      </span>
                      <label className="wb-extension-toggle">
                        <input
                          type="checkbox"
                          aria-label={`启用技能 ${skill.name}`}
                          checked={skill.enabled}
                          disabled={busy || skill.source === "marketplace"}
                          title={
                            skill.source === "marketplace"
                              ? "在插件市场统一启用或停用"
                              : undefined
                          }
                          onChange={(event) =>
                            void run(() =>
                              agentApi.setSkillEnabled(
                                skill.id,
                                event.target.checked,
                              ),
                            )
                          }
                        />
                        启用
                      </label>
                    </div>
                    <p
                      className="wb-skill-description"
                      title={skill.description || undefined}
                    >
                      {display?.summary || skill.description}
                    </p>
                    {skill.error && (
                      <p role="alert" className="text-caption text-danger-text">
                        {skill.error}
                      </p>
                    )}
                    {skill.requirements.length > 0 && (
                      <p className="wb-extension-requirements">
                        运行依赖：{skill.requirements.join("、")}
                        。使用前请确保本机已安装。
                      </p>
                    )}
                    <div className="wb-extension-meta">
                      <span>
                        {skill.installed ? "已安装" : "启用后安装"}
                        {skill.license ? ` · ${skill.license}` : ""}
                        {skill.runtimeStatus
                          ? ` · ${runtimeLabel(skill.runtimeStatus)}`
                          : ""}
                      </span>
                      {onUseSkill && skill.installed && skill.enabled && (
                        <button
                          disabled={
                            busy ||
                            (skill.loaded === false &&
                              skill.runtimeStatus !== "available") ||
                            catalog.pendingReload
                          }
                          onClick={() => onUseSkill(skill)}
                        >
                          在会话中使用
                        </button>
                      )}
                      {skill.sourceUrl &&
                        /^https?:\/\//i.test(skill.sourceUrl) && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void settingsApi.openExternal(skill.sourceUrl!)
                            }
                          >
                            查看来源
                          </button>
                        )}
                      {skill.source === "local" && (
                        <button
                          disabled={busy}
                          aria-label={`移除技能 ${skill.name}`}
                          onClick={() =>
                            void run(() => agentApi.removeSkill(skill.id))
                          }
                        >
                          <Trash2 size={13} />
                          移除
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
              {catalog && !catalog.skills.length && (
                <p className="text-caption text-fg-3">还没有已安装的技能。</p>
              )}
            </>
          )}
          {tab === "plugins" && (
            <section className="wb-plugin-store">
              <div className="wb-plugin-store-heading">
                <div>
                  <h2>插件市场</h2>
                  <p>
                    接入 ZCode 公开目录中的独立 CLI 技能。安装后先由 Agent
                    检查本机依赖和登录状态。
                  </p>
                </div>
                <div className="wb-plugin-store-actions">
                  <button
                    type="button"
                    aria-label="刷新插件市场"
                    title="刷新插件市场"
                    disabled={busy}
                    onClick={() =>
                      void runStore(() => agentApi.updatePluginMarketplace())
                    }
                  >
                    {busy ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <RefreshCw size={16} />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="管理插件市场来源"
                    title="管理插件市场来源"
                    aria-expanded={marketplaceSourcesOpen}
                    disabled={busy}
                    onClick={() => setMarketplaceSourcesOpen((value) => !value)}
                  >
                    <Settings2 size={16} />
                  </button>
                  {supportsCustomSources && (
                    <button
                      type="button"
                      className="wb-plugin-store-add"
                      disabled={busy}
                      onClick={() => setMarketplaceSourcesOpen(true)}
                    >
                      <Plus size={15} />
                      添加
                    </button>
                  )}
                </div>
              </div>

              {marketplaceSourcesOpen && (
                <div className="wb-marketplace-management">
                  {supportsCustomSources && (
                    <form
                      className="wb-marketplace-add-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitMarketplaceSource();
                      }}
                    >
                      <label className="wb-marketplace-source-input">
                        <span>添加插件市场</span>
                        <input
                          value={marketplaceSource}
                          disabled={busy}
                          onChange={(event) =>
                            setMarketplaceSource(event.target.value)
                          }
                          placeholder="ZCode 官方 marketplace.json URL"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={busy || !marketplaceSource.trim()}
                      >
                        {busy ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Plus size={14} />
                        )}
                        添加来源
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        title="选择本地插件市场目录"
                        onClick={() => void pickMarketplaceDirectory()}
                      >
                        <FolderOpen size={14} />
                      </button>
                    </form>
                  )}
                  <div className="wb-marketplace-source-list">
                    {storeMarketplaces.map((marketplace) => (
                      <div
                        className="wb-marketplace-source-row"
                        key={marketplace.id}
                      >
                        <div>
                          <strong>{marketplace.name}</strong>
                          <span>
                            {marketplace.pluginCount} 个插件
                            {marketplace.isOfficial ? " · 官方" : ""}
                          </span>
                        </div>
                        <button
                          type="button"
                          aria-label={`刷新市场 ${marketplace.name}`}
                          title="刷新市场"
                          disabled={busy}
                          onClick={() =>
                            void runStore(() =>
                              agentApi.updatePluginMarketplace(marketplace.id),
                            )
                          }
                        >
                          <RefreshCw size={14} />
                        </button>
                        {!marketplace.isOfficial &&
                          marketplace.id !== "zcode-plugins-official" && (
                            <button
                              type="button"
                              aria-label={`移除市场 ${marketplace.name}`}
                              title="移除市场来源"
                              disabled={busy}
                              onClick={() =>
                                void runStore(() =>
                                  agentApi.removePluginMarketplace(
                                    marketplace.id,
                                  ),
                                )
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                      </div>
                    ))}
                    {storeMarketplaces.length === 0 && !busy && (
                      <p className="wb-extension-hint">
                        还没有可用的市场来源。
                      </p>
                    )}
                  </div>
                </div>
              )}

              <label className="wb-plugin-store-search">
                <Search size={16} aria-hidden="true" />
                <input
                  aria-label="搜索插件"
                  placeholder="搜索插件"
                  value={marketplaceQuery}
                  onChange={(event) => setMarketplaceQuery(event.target.value)}
                />
              </label>

              <div className="wb-plugin-installed-strip">
                <div className="wb-plugin-store-section-title">
                  <h3>已安装</h3>
                  <span>
                    {
                      installedStorePlugins.filter(
                        (item) => !item.listing?.requiresPaidPlan,
                      ).length
                    }
                  </span>
                  <button
                    type="button"
                    className="wb-plugin-installed-manage-toggle"
                    aria-label="管理已安装插件"
                    title="管理已安装插件"
                    aria-expanded={installedManagementOpen}
                    disabled={busy}
                    onClick={() =>
                      setInstalledManagementOpen((value) => !value)
                    }
                  >
                    <Settings2 size={14} />
                  </button>
                </div>
                {installedStorePlugins.filter(
                  (item) => !item.listing?.requiresPaidPlan,
                ).length > 0 ? (
                  <div className="wb-plugin-installed-icons">
                    {installedStorePlugins
                      .filter((item) => !item.listing?.requiresPaidPlan)
                      .map((plugin) => (
                        <div
                          className="wb-plugin-installed-icon"
                          key={plugin.id}
                          title={plugin.name}
                        >
                          <span>
                            {(
                              localizedPluginText(
                                plugin.listing?.displayName,
                                plugin.listing?.displayNameI18n,
                              ) || plugin.name
                            )
                              .slice(0, 1)
                              .toLocaleUpperCase()}
                          </span>
                          <small>
                            {localizedPluginText(
                              plugin.listing?.displayName,
                              plugin.listing?.displayNameI18n,
                            ) || plugin.name}
                          </small>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="wb-extension-hint">安装的插件会显示在这里。</p>
                )}
                {installedManagementOpen && (
                  <div className="wb-plugin-installed-management">
                    {installedStorePlugins
                      .filter((plugin) => !plugin.listing?.requiresPaidPlan)
                      .map((plugin) => {
                        const sourceAvailable = storeMarketplaces.some(
                          (marketplace) =>
                            marketplace.id === plugin.marketplace,
                        );
                        const title =
                          localizedPluginText(
                            plugin.listing?.displayName,
                            plugin.listing?.displayNameI18n,
                          ) || plugin.name;
                        return (
                          <div
                            className="wb-plugin-installed-row"
                            key={plugin.id}
                          >
                            <div>
                              <strong>{title}</strong>
                              <span>
                                {sourceAvailable
                                  ? plugin.marketplace
                                  : "来源已移除"}
                              </span>
                            </div>
                            <label className="wb-plugin-store-enable">
                              <input
                                type="checkbox"
                                aria-label={`启用插件 ${title}`}
                                checked={plugin.enabled}
                                disabled={busy}
                                onChange={(event) =>
                                  void runStore(async () => {
                                    await agentApi.setPluginEnabled(
                                      plugin.id,
                                      event.target.checked,
                                    );
                                    return agentApi.getPluginStore();
                                  }, true)
                                }
                              />
                              启用
                            </label>
                            {sourceAvailable &&
                              plugin.updateStatus &&
                              plugin.updateStatus !== "none" && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    void runStore(
                                      () =>
                                        agentApi.updateMarketplacePlugin(
                                          plugin.id,
                                        ),
                                      true,
                                    )
                                  }
                                >
                                  <RotateCcw size={13} />
                                  更新
                                </button>
                              )}
                            <button
                              type="button"
                              aria-label={`卸载 ${title}`}
                              title="卸载插件"
                              disabled={busy}
                              onClick={() =>
                                void runStore(
                                  () =>
                                    agentApi.uninstallMarketplacePlugin(
                                      plugin.id,
                                    ),
                                  true,
                                )
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>

              <div
                className="wb-plugin-store-segments"
                role="tablist"
                aria-label="插件市场范围"
              >
                {(
                  [
                    ["public", "公开"],
                    ["personal", "个人"],
                  ] as const
                )
                  .filter(([id]) => id === "public" || supportsCustomSources)
                  .map(([id, label]) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={marketplaceSegment === id}
                      key={id}
                      onClick={() => setMarketplaceSegment(id)}
                    >
                      {label}
                    </button>
                  ))}
              </div>

              {pluginStore?.capability.supported === false && (
                <p className="wb-extension-hint">
                  {pluginStore.capability.reason ||
                    "当前环境暂不支持插件市场。"}
                </p>
              )}
              {pluginStore?.diagnostics
                .filter(
                  (item) => item.message !== pluginStore.capability.reason,
                )
                .map((item, index) => (
                  <p
                    key={`${item.pluginId || "market"}:${index}`}
                    role="status"
                    className="wb-extension-hint"
                  >
                    {item.pluginId ? `${item.pluginId}：` : ""}
                    {item.message}
                  </p>
                ))}
              {Array.from(marketplaceCategories.entries()).map(
                ([category, items]) => (
                  <section className="wb-plugin-store-category" key={category}>
                    <h3>{category}</h3>
                    <div className="wb-plugin-store-grid">
                      {items.map((item) => {
                        const installed = installedStoreById.get(item.id);
                        const restorable =
                          pluginStore?.restorableBuiltins.some(
                            (plugin) => plugin.id === item.id,
                          ) ?? false;
                        const title =
                          localizedPluginText(
                            item.listing?.displayName,
                            item.listing?.displayNameI18n,
                          ) || item.name;
                        const description =
                          localizedPluginText(
                            item.description,
                            item.listing?.descriptionI18n,
                          ) ||
                          storeMarketplaces.find(
                            (marketplace) =>
                              marketplace.id === item.marketplace,
                          )?.description;
                        return (
                          <article
                            className="wb-plugin-store-card"
                            key={item.id}
                          >
                            <div
                              className="wb-plugin-store-card-icon"
                              aria-hidden="true"
                            >
                              {item.listing?.icon?.startsWith("https://") ? (
                                <img
                                  src={item.listing.icon}
                                  alt=""
                                  loading="lazy"
                                />
                              ) : (
                                <Blocks size={19} />
                              )}
                            </div>
                            <div className="wb-plugin-store-card-content">
                              <div className="wb-plugin-store-card-title">
                                <h4 title={title}>{title}</h4>
                                {item.version && <small>{item.version}</small>}
                              </div>
                              <p title={description}>
                                {description || "暂无插件介绍。"}
                              </p>
                              <span className="wb-plugin-store-card-meta">
                                {item.listing?.author ||
                                  storeMarketplaces.find(
                                    (marketplace) =>
                                      marketplace.id === item.marketplace,
                                  )?.name ||
                                  item.marketplace}
                                {item.componentTypes?.length
                                  ? ` · ${item.componentTypes.join("、")}`
                                  : ""}
                              </span>
                            </div>
                            <div className="wb-plugin-store-card-actions">
                              {installed ? (
                                <>
                                  <label className="wb-plugin-store-enable">
                                    <input
                                      type="checkbox"
                                      aria-label={`启用插件 ${title}`}
                                      checked={installed.enabled}
                                      disabled={busy}
                                      onChange={(event) =>
                                        void runStore(async () => {
                                          await agentApi.setPluginEnabled(
                                            installed.id,
                                            event.target.checked,
                                          );
                                          return agentApi.getPluginStore();
                                        }, true)
                                      }
                                    />
                                    启用
                                  </label>
                                  {installed.updateStatus &&
                                  installed.updateStatus !== "none" ? (
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() =>
                                        void runStore(
                                          () =>
                                            agentApi.updateMarketplacePlugin(
                                              installed.id,
                                            ),
                                          true,
                                        )
                                      }
                                    >
                                      <RotateCcw size={13} />
                                      更新
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="is-installed"
                                      disabled
                                    >
                                      <Check size={13} />
                                      已安装
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="wb-plugin-store-icon-action"
                                    aria-label={`卸载 ${title}`}
                                    title="卸载插件"
                                    disabled={busy}
                                    onClick={() =>
                                      void runStore(
                                        () =>
                                          agentApi.uninstallMarketplacePlugin(
                                            installed.id,
                                          ),
                                        true,
                                      )
                                    }
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    void runStore(
                                      () =>
                                        restorable
                                          ? agentApi.restoreBuiltinPlugin(
                                              item.id,
                                            )
                                          : agentApi.installMarketplacePlugin(
                                              item.marketplace,
                                              item.name,
                                            ),
                                      true,
                                    )
                                  }
                                >
                                  <ArrowDownToLine size={14} />
                                  {restorable ? "恢复" : "安装"}
                                </button>
                              )}
                              {item.listing?.homepage &&
                                /^https:\/\//i.test(item.listing.homepage) && (
                                  <button
                                    type="button"
                                    className="wb-plugin-store-icon-action"
                                    aria-label={`打开 ${title} 的主页`}
                                    title="插件主页"
                                    disabled={busy}
                                    onClick={() =>
                                      void settingsApi.openExternal(
                                        item.listing!.homepage!,
                                      )
                                    }
                                  >
                                    <ExternalLink size={14} />
                                  </button>
                                )}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ),
              )}
              {pluginStore && visibleMarketplaceItems.length === 0 && (
                <p className="wb-plugin-store-empty">
                  {marketplaceSegment === "personal" && !marketplaceQuery.trim()
                    ? "还没有个人插件市场，点击右上角“添加”导入来源。"
                    : "没有找到符合条件的插件。"}
                </p>
              )}
              {!!catalog?.plugins.length && (
                <section className="space-y-2">
                  <h3 className="text-caption text-fg-3">
                    本地 JavaScript 插件配置
                  </h3>
                  {catalog.plugins.map((plugin) => (
                    <article key={plugin.id} className="wb-extension-card">
                      <strong>{plugin.name}</strong>
                      <p>
                        {runtimeLabel(plugin.runtimeStatus) ||
                          "尚未接入本体执行引擎"}
                      </p>
                      {plugin.error && (
                        <p role="alert" className="text-danger-text">
                          {plugin.error}
                        </p>
                      )}
                      <p className="wb-extension-hint">
                        此配置由旧版保留；CLI 市场的技能可由当前 Agent 使用。
                      </p>
                      <button
                        className="wb-mode-button"
                        disabled={busy}
                        onClick={() =>
                          void run(() => agentApi.uninstallPlugin(plugin.id))
                        }
                      >
                        <Trash2 size={13} />
                        移除配置
                      </button>
                    </article>
                  ))}
                </section>
              )}

              {supportsLocalPluginRuntime && (
                <div className="wb-extension-actions wb-plugin-store-local-actions">
                  <button
                    className="wb-mode-button"
                    disabled={busy}
                    onClick={() => void pickPlugin(true)}
                  >
                    <FolderOpen size={14} />
                    安装本地插件目录
                  </button>
                  <button
                    className="wb-mode-button"
                    disabled={busy}
                    onClick={() => void pickPlugin(false)}
                  >
                    <FilePlus2 size={14} />
                    安装插件文件
                  </button>
                </div>
              )}
            </section>
          )}
          {tab === "mcp" && (
            <>
              {pluginStore?.capability.mcpRuntime === false && (
                <p className="wb-extension-hint">
                  MCP 配置可保留，当前应用内执行引擎尚未接入 MCP
                  连接。可先使用插件市场中的 CLI 技能。
                </p>
              )}
              {catalog?.mcpServers.map((server) => (
                <article className="wb-extension-card" key={server.id}>
                  <div className="wb-extension-card-heading">
                    <Blocks size={16} />
                    <h3>{server.id}</h3>
                    <span>
                      {server.type === "remote" ? "远程服务" : "本地服务"}
                    </span>
                    <label className="wb-extension-toggle">
                      <input
                        type="checkbox"
                        aria-label={`启用工具 ${server.id}`}
                        disabled={busy}
                        checked={server.enabled}
                        onChange={(event) => {
                          const disabled = !event.target.checked;
                          void updateMcp((servers) => ({
                            ...servers,
                            [server.id]: {
                              ...(servers[server.id] as Record<
                                string,
                                unknown
                              >),
                              disabled,
                            },
                          }));
                        }}
                      />
                      启用
                    </label>
                  </div>
                  {server.runtimeStatus && (
                    <p>{runtimeLabel(server.runtimeStatus)}</p>
                  )}
                  {server.error && (
                    <p role="alert" className="text-danger-text">
                      {server.error}
                    </p>
                  )}
                </article>
              ))}
              <form
                className="wb-mcp-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addMcp();
                }}
              >
                <h3>添加远程工具服务</h3>
                <label>
                  名称
                  <input
                    value={serverName}
                    disabled={busy}
                    onChange={(event) => setServerName(event.target.value)}
                    placeholder="例如：项目文档"
                  />
                </label>
                <label>
                  服务地址
                  <input
                    value={serverUrl}
                    disabled={busy}
                    onChange={(event) => setServerUrl(event.target.value)}
                    placeholder="https://…/mcp"
                  />
                </label>
                <label>
                  访问密钥（可选）
                  <input
                    type="password"
                    value={serverToken}
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => setServerToken(event.target.value)}
                  />
                </label>
                <button
                  className="wb-primary"
                  disabled={busy || !serverName.trim() || !serverUrl.trim()}
                >
                  {pluginStore?.capability.mcpRuntime === false
                    ? "保存待接入配置"
                    : "保存服务"}
                </button>
              </form>
            </>
          )}
        </div>
        <DialogFooter className="wb-extension-footer">
          {windowControls && (
            <div
              className="wb-extension-window-controls"
              role="group"
              aria-label="窗口操作"
            >
              <span>窗口</span>
              {windowControls}
            </div>
          )}
          {needsReload && (
            <div className="wb-extension-reload">
              <p>
                {!projectOpen
                  ? "已保存，打开项目后可以载入扩展。"
                  : working
                    ? "已保存。任务结束后重新载入扩展，当前任务继续使用原配置。"
                    : "已保存，重新载入后供工作台使用。"}
              </p>
              <button
                className="wb-mode-button"
                disabled={busy || working || !projectOpen}
                onClick={() => void reload()}
              >
                <RefreshCw size={14} />
                重新载入扩展
              </button>
            </div>
          )}
          <DialogClose asChild>
            <button type="button" className="wb-extension-dismiss">
              返回工作台
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
