import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Blocks,
  FilePlus2,
  FolderOpen,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import type {
  AgentExtensionConfig,
  AgentExtensions,
  AgentSkill,
} from "@/types/agent";

const RUNTIME_LABELS: Record<string, string> = {
  not_running: "未启动项目",
  connected: "已连接",
  disconnected: "未连接",
  connecting: "正在连接",
  loaded: "已载入",
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
  const [tab, setTab] = useState<"skills" | "plugins" | "mcp">("skills");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [serverName, setServerName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [serverToken, setServerToken] = useState("");
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    if (!visible) return;
    setBusy(true);
    setError(null);
    setCatalog(null);
    agentApi
      .getExtensions()
      .then((next) => {
        if (generation.current === current) {
          setCatalog(next);
          setNeedsReload(Boolean(next.pendingReload));
        }
      })
      .catch((cause) => {
        if (generation.current === current) setError(agentErrorMessage(cause));
      })
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
    return () => {
      generation.current += 1;
    };
  }, [visible]);
  const run = async (operation: () => Promise<AgentExtensions | null>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const current = generation.current;
    try {
      const next = await operation();
      if (next && generation.current === current) {
        setCatalog(next);
        setNeedsReload(true);
      }
      return Boolean(next);
    } catch (cause) {
      if (generation.current === current) setError(agentErrorMessage(cause));
      return false;
    } finally {
      pending.current = false;
      if (generation.current === current) setBusy(false);
    }
  };
  const pickSkill = () =>
    run(async () => {
      const path = await settingsApi.pickDirectory();
      return path ? agentApi.importSkill(path) : null;
    });
  const pickPlugin = (directory: boolean) =>
    run(async () => {
      const selected = await open({
        directory,
        multiple: false,
        title: directory ? "选择插件目录" : "选择 OpenCode v2 插件文件",
        ...(!directory && {
          filters: [{ name: "插件", extensions: ["js", "mjs", "ts"] }],
        }),
      });
      return typeof selected === "string"
        ? agentApi.installPlugin(selected)
        : null;
    });
  const updateMcp = (
    update: (servers: Record<string, unknown>) => Record<string, unknown>,
  ) =>
    run(async () => {
      const config = await agentApi.getExtensionConfig();
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
  const addMcp = async () => {
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
      if (saved) {
        setServerName("");
        setServerUrl("");
        setServerToken("");
      }
    } catch (cause) {
      setError(agentErrorMessage(cause));
    }
  };
  const reload = async () => {
    if (working || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onReload();
      const next = await agentApi.getExtensions();
      setCatalog(next);
      setNeedsReload(Boolean(next.pendingReload));
    } catch (cause) {
      setError(agentErrorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={visible}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent
        className="wb-extensions p-5"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>技能与插件</DialogTitle>
          <DialogDescription>
            只配置 LoliCode 工作台，已安装的技能可以由 Agent 按任务选用。
          </DialogDescription>
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
              void run(async () => agentApi.getExtensions());
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
                        {skill.source === "bundled" ? "内置" : "本地"}
                      </span>
                      <label className="wb-extension-toggle">
                        <input
                          type="checkbox"
                          aria-label={`启用技能 ${skill.name}`}
                          checked={skill.enabled}
                          disabled={busy}
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
                            skill.loaded === false ||
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
            <>
              <p className="wb-extension-hint">
                本地插件需支持当前 OpenCode v2
                引擎。安装插件会在工作台引擎中运行其代码。
              </p>
              <div className="wb-extension-actions">
                <button
                  className="wb-mode-button"
                  disabled={busy}
                  onClick={() => void pickPlugin(false)}
                >
                  <FilePlus2 size={14} />
                  安装插件文件
                </button>
                <button
                  className="wb-mode-button"
                  disabled={busy}
                  onClick={() => void pickPlugin(true)}
                >
                  <FolderOpen size={14} />
                  安装插件目录
                </button>
              </div>
              {catalog?.plugins.map((plugin) => (
                <article className="wb-extension-card" key={plugin.id}>
                  <div className="wb-extension-card-heading">
                    <Blocks size={16} />
                    <h3>{plugin.name}</h3>
                    <label className="wb-extension-toggle">
                      <input
                        type="checkbox"
                        aria-label={`启用插件 ${plugin.name}`}
                        checked={plugin.enabled}
                        disabled={busy}
                        onChange={(event) =>
                          void run(() =>
                            agentApi.setPluginEnabled(
                              plugin.id,
                              event.target.checked,
                            ),
                          )
                        }
                      />
                      启用
                    </label>
                  </div>
                  <p className="break-all">{plugin.entry}</p>
                  {plugin.runtimeStatus && (
                    <p>{runtimeLabel(plugin.runtimeStatus)}</p>
                  )}
                  {plugin.error && (
                    <p role="alert" className="text-danger-text">
                      {plugin.error}
                    </p>
                  )}
                  <div className="wb-extension-meta">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() => agentApi.uninstallPlugin(plugin.id))
                      }
                    >
                      <Trash2 size={13} />
                      卸载
                    </button>
                  </div>
                </article>
              ))}
              {catalog && !catalog.plugins.length && (
                <p className="wb-extension-hint">没有已安装的本地插件。</p>
              )}
            </>
          )}
          {tab === "mcp" && (
            <>
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
                  保存服务
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
      </DialogContent>
    </Dialog>
  );
}
