import { useEffect, useId, useRef, useState } from "react";
import {
  Blocks,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { AgentToolPanel } from "./AgentToolPanel";
import "./agent-skills-panel.css";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import type {
  AgentExtensionConfig,
  AgentExtensions,
  AgentHarnessPluginCatalog,
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
  error: "连接失败",
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
const HARNESS_PLUGIN_LABELS: Record<
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
};
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
  projectPath,
  initialTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  working: boolean;
  onReload: () => Promise<void>;
  onUseSkill?: (skill: AgentSkill) => void;
  projectOpen?: boolean;
  projectPath?: string;
  initialTab?: "skills" | "plugins" | "mcp";
}) {
  const [catalog, setCatalog] = useState<AgentExtensions | null>(null);
  const [pluginStore, setPluginStore] = useState<AgentPluginStore | null>(null);
  const [harnessPlugins, setHarnessPlugins] =
    useState<AgentHarnessPluginCatalog | null>(null);
  const [harnessPluginError, setHarnessPluginError] = useState<string | null>(
    null,
  );
  const [legacyPluginError, setLegacyPluginError] = useState<string | null>(
    null,
  );
  const [tab, setTab] = useState<"skills" | "plugins" | "mcp">(
    initialTab ?? "skills",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [serverName, setServerName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [serverToken, setServerToken] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const panelId = useId();
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
      const [next, legacy, native] = await Promise.all([
        agentApi.getExtensions().then(
          (value) => ({ value, error: null }),
          (cause) => ({ value: null, error: agentErrorMessage(cause) }),
        ),
        agentApi.getPluginStore().then(
          (value) => ({ value, error: null }),
          (cause) => ({ value: null, error: agentErrorMessage(cause) }),
        ),
        agentApi.getHarnessPlugins().then(
          (value) => ({ value, error: null }),
          (cause) => ({ value: null, error: agentErrorMessage(cause) }),
        ),
      ]);
      if (isCurrent(current) && loading.current === requestId) {
        setCatalog(next.value);
        setError(next.error);
        setPluginStore(legacy.value);
        setLegacyPluginError(legacy.error);
        setHarnessPlugins(native.value);
        setHarnessPluginError(native.error);
        setNeedsReload(Boolean(next.value?.pendingReload));
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
    if (initialTab) setTab(initialTab);
    setCatalog(null);
    setPluginStore(null);
    setHarnessPlugins(null);
    setHarnessPluginError(null);
    setLegacyPluginError(null);
    setNeedsReload(false);
    void readCatalog(current);
    return () => {
      generation.current += 1;
      loading.current = null;
    };
  }, [visible, initialTab]);
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
  const runStore = async <T,>(
    operation: () => Promise<T>,
    apply: (next: T, current: number) => Promise<void> | void,
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
      if (isCurrent(current)) await apply(next, current);
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
  const runLegacyStore = (operation: () => Promise<AgentPluginStore>) =>
    runStore(operation, async (next, current) => {
      setPluginStore(next);
      const extensions = await agentApi.getExtensions();
      if (isCurrent(current)) {
        setCatalog(extensions);
        setNeedsReload(Boolean(extensions.pendingReload));
      }
    });
  const pickSkill = () => {
    const current = generation.current;
    return run(async () => {
      const path = await settingsApi.pickDirectory();
      return path && isCurrent(current) ? agentApi.importSkill(path) : null;
    });
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
  const installedStorePlugins = pluginStore?.installedPlugins ?? [];
  const visibleSkills =
    catalog?.skills.filter((skill) => {
      const query = skillQuery.trim().toLocaleLowerCase();
      const display =
        skill.source === "bundled"
          ? BUNDLED_SKILL_LABELS[skill.name]
          : undefined;
      return (
        !query ||
        [skill.name, skill.description, display?.name, display?.summary].some(
          (value) => value?.toLocaleLowerCase().includes(query),
        )
      );
    }) ?? [];
  return (
    <AgentToolPanel
      open={visible}
      onClose={dismiss}
      title="技能与插件"
      description="管理 Harness 插件、技能与 MCP 工具。"
      icon={Blocks}
      projectPath={projectPath}
    >
      <div className="wb-skills-panel">
        <div
          className="wb-extension-tabs"
          role="tablist"
          aria-label="扩展类型"
          onKeyDown={(event) => {
            const tabs = ["skills", "plugins", "mcp"] as const;
            let index = tabs.indexOf(tab);
            if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
            else if (event.key === "ArrowLeft")
              index = (index + tabs.length - 1) % tabs.length;
            else if (event.key === "Home") index = 0;
            else if (event.key === "End") index = tabs.length - 1;
            else return;
            event.preventDefault();
            setTab(tabs[index]);
            document.getElementById(`${panelId}-${tabs[index]}`)?.focus();
          }}
        >
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
              type="button"
              id={`${panelId}-${id}`}
              aria-controls={`${panelId}-${id}-panel`}
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
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
        <div
          className="wb-extension-list"
          role="tabpanel"
          id={`${panelId}-${tab}-panel`}
          aria-labelledby={`${panelId}-${tab}`}
        >
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
              <div className="wb-skills-toolbar">
                <label className="wb-skills-search">
                  <Search size={16} aria-hidden="true" />
                  <input
                    aria-label="搜索技能"
                    placeholder="搜索技能名称或用途…"
                    value={skillQuery}
                    onChange={(event) => setSkillQuery(event.target.value)}
                  />
                </label>
                {catalog && (
                  <span className="wb-skills-count">
                    {catalog.skills.filter((skill) => skill.enabled).length} /{" "}
                    {catalog.skills.length} 个技能已启用
                  </span>
                )}
              </div>
              <div className="wb-skills-grid">
                {visibleSkills.map((skill) => {
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
                                ? "在插件页的兼容扩展中启用或停用"
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
                        <p
                          role="alert"
                          className="text-caption text-danger-text"
                        >
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
                              catalog?.pendingReload
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
              </div>
              {catalog && !visibleSkills.length && (
                <div className="wb-skills-empty">
                  <Blocks size={28} aria-hidden="true" />
                  <h3>
                    {skillQuery.trim()
                      ? "没有找到符合条件的技能"
                      : "还没有已安装的技能"}
                  </h3>
                  <p>
                    {skillQuery.trim()
                      ? "试试其他名称或关键词。"
                      : "可以导入本地技能目录，或管理 Harness 插件。"}
                  </p>
                  {!skillQuery.trim() && (
                    <button
                      className="wb-mode-button"
                      type="button"
                      onClick={() => setTab("plugins")}
                    >
                      管理插件
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {tab === "plugins" && (
            <>
              <section className="wb-harness-plugins" aria-label="官方插件">
                <div className="wb-harness-plugin-heading">
                  <div>
                    <h2>官方插件</h2>
                    <p>
                      管理 DeepSeek Harness 为本机 Agent
                      交互会话提供的可选能力。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="wb-mode-button"
                    aria-label="刷新插件"
                    title="刷新插件"
                    disabled={busy}
                    onClick={() => void readCatalog(generation.current)}
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                    刷新
                  </button>
                </div>
                {harnessPluginError && (
                  <p role="alert" className="text-caption text-danger-text">
                    {harnessPluginError}
                  </p>
                )}
                {harnessPlugins?.pendingReload && (
                  <p role="status" className="wb-extension-hint">
                    插件设置已保存，将在新一轮任务启动时生效。
                  </p>
                )}
                {harnessPlugins?.bundles.length === 0 && (
                  <p className="wb-extension-hint">
                    当前版本没有可管理的官方插件。
                  </p>
                )}
                <div className="wb-skills-grid">
                  {harnessPlugins?.bundles.map((plugin) => {
                    const display = HARNESS_PLUGIN_LABELS[plugin.id];
                    const name = display?.name || plugin.name;
                    return (
                      <article className="wb-extension-card" key={plugin.id}>
                        <div className="wb-extension-card-heading">
                          <Blocks size={16} aria-hidden="true" />
                          <h3>{name}</h3>
                          <label className="wb-extension-toggle">
                            <input
                              type="checkbox"
                              aria-label={`启用插件 ${name}`}
                              checked={plugin.enabled}
                              disabled={busy}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                void runStore(
                                  () =>
                                    agentApi.setHarnessPluginEnabled(
                                      plugin.id,
                                      enabled,
                                    ),
                                  setHarnessPlugins,
                                );
                              }}
                            />
                            启用
                          </label>
                        </div>
                        <p>{display?.description || plugin.description}</p>
                        <div className="wb-extension-meta">
                          <span>{plugin.version}</span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
              {legacyPluginError && (
                <p role="status" className="wb-extension-hint">
                  {legacyPluginError}
                </p>
              )}
              {(installedStorePlugins.length > 0 ||
                Boolean(catalog?.plugins.length)) && (
                <details className="wb-harness-plugins wb-compatible-plugins">
                  <summary>兼容扩展</summary>
                  <p>管理已保存的 CLI 技能包与旧版本地插件配置。</p>
                  {pluginStore?.diagnostics.map((item, index) => (
                    <p
                      key={`${item.pluginId || "legacy"}:${index}`}
                      role="status"
                    >
                      {item.message}
                    </p>
                  ))}
                  <div className="wb-skills-grid">
                    {installedStorePlugins.map((plugin) => {
                      const title =
                        localizedPluginText(
                          plugin.listing?.displayName,
                          plugin.listing?.displayNameI18n,
                        ) || plugin.name;
                      return (
                        <article className="wb-extension-card" key={plugin.id}>
                          <div className="wb-extension-card-heading">
                            <h3>{title}</h3>
                            <label className="wb-extension-toggle">
                              <input
                                type="checkbox"
                                aria-label={`启用兼容扩展 ${title}`}
                                checked={plugin.enabled}
                                disabled={busy}
                                onChange={(event) => {
                                  const enabled = event.target.checked;
                                  void runLegacyStore(async () => {
                                    await agentApi.setPluginEnabled(
                                      plugin.id,
                                      enabled,
                                    );
                                    return agentApi.getPluginStore();
                                  });
                                }}
                              />
                              启用
                            </label>
                          </div>
                          <div className="wb-extension-meta">
                            <span>
                              CLI 技能包
                              {plugin.version && ` · ${plugin.version}`}
                            </span>
                            <button
                              type="button"
                              aria-label={`卸载 ${title}`}
                              disabled={busy}
                              onClick={() =>
                                void runLegacyStore(() =>
                                  agentApi.uninstallMarketplacePlugin(
                                    plugin.id,
                                  ),
                                )
                              }
                            >
                              <Trash2 size={13} aria-hidden="true" />
                              卸载
                            </button>
                          </div>
                        </article>
                      );
                    })}
                    {catalog?.plugins.map((plugin) => (
                      <article className="wb-extension-card" key={plugin.id}>
                        <div className="wb-extension-card-heading">
                          <h3>{plugin.name}</h3>
                          <span>旧版本地配置</span>
                        </div>
                        {plugin.error && (
                          <p role="alert" className="text-danger-text">
                            {plugin.error}
                          </p>
                        )}
                        <div className="wb-extension-meta">
                          <span>{runtimeLabel(plugin.runtimeStatus)}</span>
                          <button
                            type="button"
                            aria-label={`移除配置 ${plugin.name}`}
                            disabled={busy}
                            onClick={() =>
                              void run(() =>
                                agentApi.uninstallPlugin(plugin.id),
                              )
                            }
                          >
                            <Trash2 size={13} aria-hidden="true" />
                            移除配置
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
          {tab === "mcp" && (
            <>
              {catalog?.mcpRuntime === true ? (
                <div className="wb-extension-hint">
                  <p>
                    已启用的服务会在发送任务时连接。工具定义通过工具搜索按需加载，实际调用仍遵循会话权限。
                  </p>
                  <button
                    type="button"
                    className="wb-mode-button"
                    disabled={busy}
                    onClick={() => void run(() => agentApi.connectMcp())}
                  >
                    <RefreshCw size={14} /> 连接启用的服务
                  </button>
                  {catalog.mcpRuntimeError && (
                    <p role="alert">{catalog.mcpRuntimeError}</p>
                  )}
                </div>
              ) : (
                pluginStore?.capability.mcpRuntime === false && (
                  <p className="wb-extension-hint">
                    MCP 配置可保存，当前应用内执行引擎尚未接入 MCP 连接。
                  </p>
                )
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
                    <p>
                      {runtimeLabel(server.runtimeStatus)}
                      {server.loaded
                        ? ` · ${server.toolCount ?? 0} 个工具`
                        : ""}
                    </p>
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
                  {catalog?.mcpRuntime !== true &&
                  pluginStore?.capability.mcpRuntime === false
                    ? "保存待接入配置"
                    : "保存服务"}
                </button>
              </form>
            </>
          )}
        </div>
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
      </div>
    </AgentToolPanel>
  );
}
