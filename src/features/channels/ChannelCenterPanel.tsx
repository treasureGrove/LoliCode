import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import {
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  Layers3,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, fieldClass } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  CHANNEL_TARGETS,
  CHANNEL_TARGET_NAMES,
  ChannelTargetGlyph,
} from "./channelTargets";
import { AuthCenterPanel } from "@/features/settings/AuthCenterPanel";
import type { ManagedAuthProvider } from "@/lib/api/auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  channelCenterApi,
  type ChannelApplyResponse,
  type ChannelConnection,
  type ChannelCenterSnapshot,
  type ChannelProtocol,
  type ChannelSource,
} from "@/lib/api/channel-center";
import { useUnsavedChangesTracker } from "@/lib/unsavedChanges";
import { cn } from "@/lib/utils";
import {
  channelErrorMessage,
  matchesChannelModel,
  mergeDiscoveredChannel,
  selectedChannelModels,
  withValidDefault,
} from "./channelCenterUtils";
import { ZhipuLoginPanel } from "./ZhipuLoginPanel";
import { ChannelPresetPicker } from "./ChannelPresetPicker";
import { ProviderIconBox } from "@/components/ProviderIconBox";
import {
  ACCOUNT_CHANNEL_PRESET_MAP,
  CHANNEL_PRESET_MAP,
  matchChannelPreset,
} from "./channelPresets";
import { ManagedChannelLoginPanel } from "./ManagedChannelLoginPanel";
import { NativeSubscriptionLoginPanel } from "./NativeSubscriptionLoginPanel";
import { ChannelConnectionPanel } from "./ChannelConnectionPanel";
import { ChannelModelList } from "./ChannelModelList";
import { AppsPage } from "@/features/apps/AppsPage";
import "./channels.css";

const EMPTY_SNAPSHOT: ChannelCenterSnapshot = {
  channels: [],
  targets: ["opencode", "hermes", "openclaw"],
};
const CARD = "lolicode-channel-section";

export interface ChannelCenterPanelProps {
  onNavigationBlockedChange?: (blocked: boolean) => void;
  initialAccountManagerOpen?: boolean;
  initialToolsOpen?: boolean;
}

/** One catalog of upstream channels; target writers stay behind the backend API. */
export function ChannelCenterPanel({
  onNavigationBlockedChange,
  initialAccountManagerOpen = false,
  initialToolsOpen = false,
}: ChannelCenterPanelProps = {}) {
  const reducedMotion = useReducedMotion();
  const [snapshot, setSnapshot] =
    useState<ChannelCenterSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reloadRequested, setReloadRequested] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(initialToolsOpen);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [response, setResponse] = useState<ChannelApplyResponse | null>(null);
  const [preset, setPreset] = useState("deepseek");
  const [sourceProtocol, setSourceProtocol] = useState<ChannelProtocol>(
    CHANNEL_PRESET_MAP.deepseek.protocol,
  );
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(CHANNEL_PRESET_MAP.deepseek.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formTouched, setFormTouched] = useState(false);
  const [search, setSearch] = useState("");
  const [resetRequested, setResetRequested] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountManagerOpen, setAccountManagerOpen] = useState(
    initialAccountManagerOpen,
  );
  const [accountManagerTarget, setAccountManagerTarget] =
    useState<ManagedAuthProvider | null>(null);
  const mounted = useRef(true);
  const loadGeneration = useRef(0);
  const busyRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  const editVersion = useRef(0);
  const formVersion = useRef(0);
  const cleanVersion = useRef(0);
  const saveInFlight = useRef<Promise<ChannelCenterSnapshot> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const blocked =
    dirty || formTouched || Boolean(busy) || accountBusy || saving;
  const tracker = useUnsavedChangesTracker();

  useEffect(() => {
    if (initialAccountManagerOpen) setAccountManagerOpen(true);
  }, [initialAccountManagerOpen]);
  useEffect(() => {
    if (initialToolsOpen) setToolsOpen(true);
  }, [initialToolsOpen]);

  const replaceSnapshot = (next: ChannelCenterSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  };

  useEffect(() => {
    if (dirty || formTouched) tracker.markDirty();
    else tracker.markClean();
  }, [dirty, formTouched, tracker.markDirty, tracker.markClean]);
  useEffect(() => {
    onNavigationBlockedChange?.(Boolean(busy) || accountBusy || saving);
    return () => onNavigationBlockedChange?.(false);
  }, [busy, accountBusy, saving, onNavigationBlockedChange]);
  useEffect(() => {
    if (!blocked) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [blocked]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadFailed(false);
    setConflict(false);
    setError(null);
    try {
      const saved = await channelCenterApi.get();
      if (!mounted.current || generation !== loadGeneration.current) return;
      replaceSnapshot(withValidDefault(saved));
      cleanVersion.current = editVersion.current;
      setDirty(false);
      setSaveFailed(false);
      setResponse(null);
    } catch (cause) {
      if (!mounted.current || generation !== loadGeneration.current) return;
      setLoadFailed(true);
      setError(channelErrorMessage(cause));
    } finally {
      if (mounted.current && generation === loadGeneration.current) {
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      loadGeneration.current += 1;
    };
  }, [load]);

  const resetForm = () => {
    formVersion.current += 1;
    setName("");
    setBaseUrl(CHANNEL_PRESET_MAP.deepseek.baseUrl);
    setApiKey("");
    setShowKey(false);
    setPreset("deepseek");
    setSourceProtocol(CHANNEL_PRESET_MAP.deepseek.protocol);
    setEditingId(null);
    setFormTouched(false);
    setResetRequested(false);
  };

  const selectPreset = (value: string) => {
    if (value === preset) return;
    formVersion.current += 1;
    setApiKey("");
    setShowKey(false);
    setPreset(value);
    const accountPreset = ACCOUNT_CHANNEL_PRESET_MAP[value];
    const apiPreset = CHANNEL_PRESET_MAP[value];
    setName(apiPreset?.name ?? "");
    setBaseUrl(apiPreset?.baseUrl ?? "");
    setSourceProtocol(apiPreset?.protocol ?? "openai_chat");
    if (accountPreset) setEditingId(null);
    setFormTouched(!accountPreset);
  };

  const updateSnapshot = (next: ChannelCenterSnapshot) => {
    editVersion.current += 1;
    replaceSnapshot(withValidDefault(next));
    setDirty(true);
    setSaveFailed(false);
    setNotice(null);
  };

  const run = async (
    label: string,
    operation: () => Promise<void>,
    propagate = false,
    independent = false,
  ) => {
    if (busyRef.current || (!independent && (loading || loadFailed))) {
      if (propagate)
        throw new Error("请等待当前操作完成或重新加载渠道后再加入。");
      return;
    }
    busyRef.current = true;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (cause) {
      const message = channelErrorMessage(
        cause,
        [apiKey, ...snapshot.channels.map((channel) => channel.apiKey)],
        label === "apply" || label.startsWith("connection-")
          ? "configuration"
          : "channel",
      );
      if (mounted.current) {
        setConflict(String(cause).includes("另一处修改"));
        if (label === "save" || label === "apply") setSaveFailed(true);
        setError(message);
      }
      if (propagate) throw new Error(message);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  // Serialize writes and rebase only the revision when users edit during I/O.
  // An older save/get response must never replace a newer local selection.
  const persist = async (
    proposal?: ChannelCenterSnapshot,
    onSaved?: () => void,
  ): Promise<ChannelCenterSnapshot> => {
    while (saveInFlight.current)
      await saveInFlight.current.catch(() => undefined);
    if (!proposal && cleanVersion.current === editVersion.current)
      return snapshotRef.current;
    const version = editVersion.current;
    const normalized = withValidDefault({
      ...(proposal ?? snapshotRef.current),
      revision: snapshotRef.current.revision,
    });
    const expectedRevision = (normalized.revision ?? 0) + 1;
    setSaving(true);
    setSaveFailed(false);
    const operation = (async () => {
      await channelCenterApi.save(normalized);
      if (!mounted.current) return normalized;
      cleanVersion.current = version;
      replaceSnapshot(
        editVersion.current === version
          ? { ...normalized, revision: expectedRevision }
          : { ...snapshotRef.current, revision: expectedRevision },
      );
      setDirty(editVersion.current !== version);
      onSaved?.();
      let saved: ChannelCenterSnapshot;
      try {
        saved = await channelCenterApi.get();
      } catch {
        if (mounted.current) setLoadFailed(true);
        throw new Error("选择已保存，但无法刷新渠道。请点击重新加载后继续。");
      }
      if (!mounted.current) return saved;
      if (saved.revision !== expectedRevision) {
        setConflict(true);
        setDirty(true);
        throw new Error(
          "渠道列表已被另一处修改。请重新加载后再配置；本页的选择已保留。",
        );
      }
      replaceSnapshot(
        editVersion.current === version
          ? withValidDefault(saved)
          : { ...snapshotRef.current, revision: saved.revision },
      );
      setError(null);
      return saved;
    })();
    saveInFlight.current = operation;
    try {
      return await operation;
    } finally {
      if (saveInFlight.current === operation) saveInFlight.current = null;
      if (mounted.current) setSaving(false);
    }
  };

  useEffect(() => {
    if (
      !dirty ||
      loading ||
      loadFailed ||
      conflict ||
      busy ||
      accountBusy ||
      saving ||
      saveFailed
    )
      return;
    const timer = window.setTimeout(() => {
      void persist().catch((cause) => {
        if (!mounted.current) return;
        setSaveFailed(true);
        setConflict(String(cause).includes("另一处修改"));
        setError(
          channelErrorMessage(
            cause,
            snapshotRef.current.channels.map((channel) => channel.apiKey),
          ),
        );
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    snapshot,
    dirty,
    loading,
    loadFailed,
    conflict,
    busy,
    accountBusy,
    saving,
    saveFailed,
  ]);

  // Editing a saved source changes only the local catalog. Catalog discovery is
  // an explicit action, so incomplete URLs never trigger network requests.
  useEffect(() => {
    if (
      !editingId ||
      !formTouched ||
      loading ||
      loadFailed ||
      conflict ||
      busy ||
      resetRequested ||
      !apiKey.trim()
    )
      return;
    let url: URL;
    try {
      url = new URL(baseUrl.trim());
    } catch {
      return;
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    const version = formVersion.current;
    const timer = window.setTimeout(() => {
      if (version !== formVersion.current) return;
      const current = snapshotRef.current;
      const previous = current.channels.find(
        (channel) => channel.id === editingId,
      );
      if (!previous || previous.authKind !== "api_key") return;
      const nextName =
        name.trim() || CHANNEL_PRESET_MAP[preset]?.name || url.hostname;
      const connectionChanged =
        previous.baseUrl !== baseUrl.trim() ||
        previous.apiKey !== apiKey.trim() ||
        previous.protocol !== sourceProtocol;
      if (connectionChanged || previous.name !== nextName) {
        updateSnapshot({
          ...current,
          channels: current.channels.map((channel) =>
            channel.id === editingId
              ? {
                  ...channel,
                  name: nextName,
                  baseUrl: baseUrl.trim(),
                  apiKey: apiKey.trim(),
                  protocol: sourceProtocol,
                }
              : channel,
          ),
        });
        setNotice(
          connectionChanged
            ? "连接信息将自动保存。地址或密钥已变更，请点击该渠道的“刷新模型”更新目录。"
            : "渠道名称将自动保存。",
        );
      }
      setFormTouched(false);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    editingId,
    formTouched,
    name,
    baseUrl,
    apiKey,
    preset,
    sourceProtocol,
    loading,
    loadFailed,
    conflict,
    busy,
    resetRequested,
  ]);

  const upsertDiscovered = async (
    channel: ChannelSource,
    onSaved?: () => void,
    alreadyDiscovered = false,
  ) => {
    const fetched = alreadyDiscovered
      ? channel
      : await channelCenterApi.discover(channel);
    const current = snapshotRef.current;
    const previous = current.channels.find((item) => item.id === channel.id);
    const discovered = mergeDiscoveredChannel(fetched, previous);
    const exists = current.channels.some((item) => item.id === discovered.id);
    const next = {
      ...current,
      targets:
        discovered.authKind === "claude_subscription" &&
        !current.targets.includes("claude")
          ? [...current.targets, "claude" as const]
          : discovered.authKind === "gemini_subscription" &&
              !current.targets.includes("gemini")
            ? [...current.targets, "gemini" as const]
            : current.targets,
      channels: exists
        ? current.channels.map((item) =>
            item.id === discovered.id ? discovered : item,
          )
        : [...current.channels, discovered],
    };
    await persist(next, onSaved);
    return discovered;
  };

  const addApiChannel = () => {
    void run("discover-api", async () => {
      let url: URL;
      try {
        url = new URL(baseUrl.trim());
      } catch {
        throw new Error(
          "请填写完整的 API 地址，例如 https://api.deepseek.com/v1。",
        );
      }
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        throw new Error(
          "请填写 http 或 https 服务地址，并将密钥放在 API Key 中。",
        );
      }
      if (!apiKey.trim()) throw new Error("请填写 API Key。");
      const previous = snapshot.channels.find((item) => item.id === editingId);
      const source: ChannelSource = {
        id: editingId ?? crypto.randomUUID(),
        name: name.trim() || CHANNEL_PRESET_MAP[preset]?.name || url.hostname,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        authKind: "api_key",
        protocol: sourceProtocol,
        models: previous?.models ?? [],
        enabled: previous?.enabled ?? true,
      };
      const discovered = await upsertDiscovered(source, resetForm);
      if (!mounted.current) return;
      setResponse(null);
      setNotice(
        `已保存 ${discovered.name}，发现 ${discovered.models.length} 个模型。选择工具后点击一键配置。`,
      );
    });
  };

  const connectAccountChannel = (channel: ChannelSource) =>
    run(
      "connect-account",
      async () => {
        try {
          const native =
            channel.authKind === "claude_subscription" ||
            channel.authKind === "gemini_subscription";
          const discovered = await upsertDiscovered(channel, undefined, native);
          if (mounted.current)
            setNotice(
              native
                ? `已加入 ${discovered.name}，模型由原生工具管理。`
                : `已加入 ${discovered.name}，发现 ${discovered.models.length} 个模型。`,
            );
        } catch (cause) {
          throw new Error(channelErrorMessage(cause, [channel.apiKey]));
        }
      },
      true,
    );

  const selected = selectedChannelModels(snapshot);
  const disabled = loading || loadFailed || Boolean(busy) || accountBusy;
  const selectedPreset = CHANNEL_PRESET_MAP[preset];
  const selectedAccountPreset = ACCOUNT_CHANNEL_PRESET_MAP[preset];
  const filteredChannels = snapshot.channels.map((channel) => ({
    channel,
    models: channel.models.filter((model) =>
      matchesChannelModel(channel, model, search),
    ),
  }));

  return (
    <div
      className="lolicode-channel-center"
      aria-busy={Boolean(busy) || loading}
    >
      <div className="lolicode-channel-content">
        <header className="lolicode-channel-heading">
          <div className="lolicode-channel-intro">
            <span className="lolicode-channel-eyebrow">MODEL LIBRARY</span>
            <h1>模型与渠道</h1>
            <p className="mt-1 text-body text-fg-2">
              连接喜欢的模型，让灵感随时就绪。
            </p>
          </div>
          <div className="lolicode-channel-summary">
            <span className="lolicode-channel-count">
              <Layers3 className="h-3.5 w-3.5" aria-hidden="true" />
              {snapshot.channels.length} 个渠道 · {selected.length} 个已选模型
            </span>
            <span
              role="status"
              className="lolicode-channel-save-state text-caption text-fg-3"
            >
              {!loading &&
                !dirty &&
                !formTouched &&
                !loadFailed &&
                !saveFailed &&
                !saving && (
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                )}
              {saving
                ? "正在自动保存…"
                : loadFailed
                  ? "暂时无法确认已保存配置"
                  : saveFailed
                    ? "自动保存失败，修改仍保留"
                    : dirty
                      ? "等待自动保存…"
                      : formTouched
                        ? "输入草稿尚未保存"
                        : !loading
                          ? "配置已自动保存"
                          : ""}
            </span>
          </div>
        </header>

        {error && (
          <div role="alert">
            <Notice
              tone="danger"
              title={error}
              actions={
                loadFailed || conflict ? (
                  <Button
                    variant="neutral"
                    size="compact"
                    onClick={() => {
                      if (dirty) setReloadRequested(true);
                      else void load();
                    }}
                  >
                    重新加载
                  </Button>
                ) : saveFailed ? (
                  <Button
                    variant="neutral"
                    size="compact"
                    onClick={() =>
                      void run("save", async () => {
                        await persist();
                      })
                    }
                  >
                    重试保存
                  </Button>
                ) : undefined
              }
            />
          </div>
        )}
        {notice && (
          <div role="status">
            <Notice title={notice} />
          </div>
        )}
        {loading && (
          <div
            role="status"
            className="flex items-center gap-2 text-body text-fg-2"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载渠道…
          </div>
        )}

        <section
          className={cn(CARD, "lolicode-channel-connect")}
          aria-labelledby="channel-add-heading"
        >
          <div className="lolicode-channel-section-heading">
            <div>
              <h2
                id="channel-add-heading"
                className="text-base font-semibold text-fg-1"
              >
                添加渠道
              </h2>
              <p className="mt-1 text-caption text-fg-3">
                选择服务，使用密钥或已有账号连接。
              </p>
            </div>
            <Button
              variant="quiet"
              size="compact"
              disabled={disabled}
              onClick={() => {
                setAccountManagerTarget(null);
                setAccountManagerOpen(true);
              }}
            >
              管理登录账号
            </Button>
          </div>
          <div className="lolicode-channel-connect-grid">
            <ChannelPresetPicker
              value={preset}
              disabled={disabled}
              onValueChange={selectPreset}
            />
            <div className="lolicode-channel-form">
              {selectedAccountPreset && (
                <div className="mb-4 flex items-center gap-2.5">
                  <ProviderIconBox
                    icon={selectedAccountPreset.icon}
                    name={selectedAccountPreset.name}
                  />
                  <h3 className="text-body font-medium text-fg-1">
                    {selectedAccountPreset.name}
                  </h3>
                </div>
              )}
              {!selectedAccountPreset ? (
                <form
                  ref={formRef}
                  noValidate
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!editingId) addApiChannel();
                  }}
                >
                  <fieldset disabled={disabled} className="space-y-3">
                    {selectedPreset && (
                      <div className="lolicode-channel-service-intro flex items-center gap-2.5">
                        <ProviderIconBox
                          icon={selectedPreset.icon}
                          name={selectedPreset.name}
                        />
                        <div>
                          <p className="text-body font-medium text-fg-1">
                            {selectedPreset.name}
                          </p>
                          <p className="mt-0.5 text-caption text-fg-3">
                            服务地址已准备好，填写密钥即可。
                          </p>
                        </div>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor="channel-name">
                        名称 <span className="text-fg-3">（可选）</span>
                      </Label>
                      <Input
                        id="channel-name"
                        value={name}
                        placeholder="例如：工作账号"
                        onChange={(event) => {
                          formVersion.current += 1;
                          setName(event.target.value);
                          setFormTouched(true);
                        }}
                      />
                    </div>
                    {(preset === "custom" || editingId) && (
                      <div className="space-y-1.5">
                        <Label htmlFor="channel-url">API 地址</Label>
                        <Input
                          id="channel-url"
                          type="url"
                          required
                          value={baseUrl}
                          placeholder="粘贴服务商提供的 API 地址"
                          onChange={(event) => {
                            formVersion.current += 1;
                            setBaseUrl(event.target.value);
                            setFormTouched(true);
                          }}
                        />
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor="channel-key">API Key</Label>
                      <div className="relative">
                        <Input
                          id="channel-key"
                          type={showKey ? "text" : "password"}
                          className="pr-10"
                          required
                          value={apiKey}
                          placeholder="粘贴密钥"
                          autoComplete="new-password"
                          onChange={(event) => {
                            formVersion.current += 1;
                            setApiKey(event.target.value);
                            setFormTouched(true);
                          }}
                        />
                        <Button
                          type="button"
                          variant="quiet"
                          size="icon-compact"
                          className="absolute right-1 top-1/2 -translate-y-1/2"
                          aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                          aria-pressed={showKey}
                          onClick={() => setShowKey((value) => !value)}
                        >
                          {showKey ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {!editingId && (
                        <Button
                          type="submit"
                          variant="neutral"
                          disabled={!baseUrl.trim() || !apiKey.trim()}
                        >
                          {busy === "discover-api" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Plus className="h-4 w-4" />
                          )}
                          添加并查找模型
                        </Button>
                      )}
                      {(formTouched || editingId) && (
                        <Button
                          type="button"
                          variant="quiet"
                          onClick={() =>
                            formTouched ? setResetRequested(true) : resetForm()
                          }
                        >
                          {editingId ? "结束编辑" : "清空输入"}
                        </Button>
                      )}
                    </div>
                    <p className="text-caption text-fg-3">
                      {editingId
                        ? "完整有效的修改会自动保存；不会自动请求模型目录。修改连接信息后，请单独刷新模型。"
                        : preset === "custom"
                          ? "填入服务商的地址和密钥，自动获取模型。"
                          : "自动获取此账号的模型列表；不同服务可以逐个加入。"}
                    </p>
                  </fieldset>
                </form>
              ) : selectedAccountPreset.authProvider === "zhipu_oauth" ? (
                <ZhipuLoginPanel
                  disabled={loading || loadFailed || Boolean(busy)}
                  onBusyChange={setAccountBusy}
                  onConnected={connectAccountChannel}
                />
              ) : selectedAccountPreset.authProvider ? (
                <ManagedChannelLoginPanel
                  key={selectedAccountPreset.authProvider}
                  authProvider={selectedAccountPreset.authProvider}
                  channels={snapshot.channels}
                  disabled={loading || loadFailed || Boolean(busy)}
                  onBusyChange={setAccountBusy}
                  onConnected={connectAccountChannel}
                />
              ) : (
                <NativeSubscriptionLoginPanel
                  key={selectedAccountPreset.nativeApp}
                  tool={selectedAccountPreset.nativeApp!}
                  disabled={loading || loadFailed || Boolean(busy)}
                  onBusyChange={setAccountBusy}
                  onConnected={connectAccountChannel}
                />
              )}
            </div>
          </div>
        </section>

        <section className={CARD} aria-labelledby="channel-model-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="channel-model-heading"
                className="text-base font-semibold text-fg-1"
              >
                选择模型
              </h2>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-3" />
              <Input
                aria-label="搜索渠道或模型"
                className="pl-9"
                value={search}
                placeholder="搜索渠道或模型"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          {snapshot.channels.length === 0 && !loading && (
            <div className="lolicode-channel-empty">
              <span className="lolicode-channel-empty-icon" aria-hidden="true">
                <Layers3 className="h-6 w-6" />
              </span>
              <p className="font-medium text-fg-2">你的模型库，从这里开始</p>
              <p className="text-caption text-fg-3">
                添加 API 或登录订阅账号后，模型会显示在这里。
              </p>
            </div>
          )}
          <div className="mt-4 space-y-3">
            {filteredChannels.map(({ channel, models }) => (
              <article
                key={channel.id}
                className="lolicode-saved-channel"
                aria-label={`${channel.name} 渠道`}
              >
                <div className="lolicode-saved-channel-heading flex flex-wrap items-center justify-between gap-2">
                  <label className="flex min-w-0 items-center gap-2 text-body font-medium text-fg-1">
                    <Checkbox
                      aria-label={`启用 ${channel.name}`}
                      checked={channel.enabled}
                      disabled={disabled}
                      onCheckedChange={(enabled) =>
                        updateSnapshot({
                          ...snapshot,
                          channels: snapshot.channels.map((item) =>
                            item.id === channel.id
                              ? { ...item, enabled }
                              : item,
                          ),
                        })
                      }
                    />
                    <ProviderIconBox
                      icon={
                        channel.authKind === "github_copilot"
                          ? "githubcopilot"
                          : channel.authKind === "zhipu_oauth"
                            ? "zhipu"
                            : channel.authKind === "codex_oauth"
                              ? "openai"
                              : channel.authKind === "xai_oauth"
                                ? "grok"
                                : channel.authKind === "claude_subscription"
                                  ? "claude"
                                  : channel.authKind === "gemini_subscription"
                                    ? "gemini"
                                    : matchChannelPreset(channel)?.icon ||
                                      "newapi"
                      }
                      name={channel.name}
                    />
                    <span className="truncate">{channel.name}</span>
                    {channel.authKind === "lolicode_account" && (
                      <span className="text-caption text-fg-3">
                        仅 LoliCode · 每日额度
                      </span>
                    )}
                    {(channel.authKind === "claude_subscription" ||
                      channel.authKind === "gemini_subscription") && (
                      <span className="text-caption text-fg-3">仅原生工具</span>
                    )}
                    <span className="text-caption font-normal text-fg-3">
                      {
                        channel.models.filter(
                          (model) =>
                            model.enabled !== false &&
                            model.supportsTools !== false,
                        ).length
                      }{" "}
                      / {channel.models.length} 个模型
                    </span>
                  </label>
                  <div className="flex flex-wrap gap-1">
                    {(channel.authKind === "github_copilot" ||
                      channel.authKind === "codex_oauth" ||
                      channel.authKind === "xai_oauth") && (
                      <Button
                        variant="quiet"
                        size="compact"
                        disabled={disabled}
                        onClick={() => {
                          setAccountManagerTarget(
                            channel.authKind as ManagedAuthProvider,
                          );
                          setAccountManagerOpen(true);
                        }}
                      >
                        账号管理
                      </Button>
                    )}
                    {channel.authKind === "api_key" && (
                      <Button
                        variant="quiet"
                        size="compact"
                        disabled={disabled || formTouched}
                        onClick={() => {
                          formVersion.current += 1;
                          setEditingId(channel.id);
                          setName(channel.name);
                          setBaseUrl(channel.baseUrl);
                          setApiKey(channel.apiKey);
                          setShowKey(false);
                          setPreset(
                            matchChannelPreset(channel)?.id ?? "custom",
                          );
                          setSourceProtocol(channel.protocol);
                          setFormTouched(false);
                          formRef.current?.scrollIntoView?.({
                            behavior: reducedMotion ? "auto" : "smooth",
                            block: "center",
                          });
                        }}
                      >
                        修改
                      </Button>
                    )}
                    <Button
                      variant="quiet"
                      size="compact"
                      disabled={
                        disabled || (editingId === channel.id && formTouched)
                      }
                      onClick={() =>
                        void run(`refresh-${channel.id}`, async () => {
                          await upsertDiscovered(channel);
                          if (mounted.current) {
                            setResponse(null);
                            setNotice(`${channel.name} 的模型列表已更新。`);
                          }
                        })
                      }
                    >
                      {busy === `refresh-${channel.id}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      {channel.authKind === "claude_subscription" ||
                      channel.authKind === "gemini_subscription"
                        ? "检测订阅"
                        : "刷新模型"}
                    </Button>
                  </div>
                </div>
                <ChannelModelList
                  channel={channel}
                  models={models}
                  disabled={disabled}
                  collapsed={collapsed[channel.id] ?? true}
                  onToggle={() =>
                    setCollapsed((value) => ({
                      ...value,
                      [channel.id]: !(value[channel.id] ?? true),
                    }))
                  }
                  onModelsChange={(models) =>
                    updateSnapshot({
                      ...snapshotRef.current,
                      channels: snapshotRef.current.channels.map((item) =>
                        item.id === channel.id ? { ...item, models } : item,
                      ),
                    })
                  }
                />
              </article>
            ))}
          </div>
          <div className="mt-4 max-w-lg space-y-1.5">
            <Label htmlFor="channel-default-model">默认模型</Label>
            <select
              id="channel-default-model"
              className={cn(fieldClass, "h-8")}
              disabled={disabled || selected.length === 0}
              value={snapshot.defaultModel || ""}
              onChange={(event) =>
                updateSnapshot({
                  ...snapshot,
                  defaultModel: event.target.value,
                })
              }
            >
              {selected.length === 0 && <option value="">请先选择模型</option>}
              {selected.map(({ channel, model, value }) => (
                <option key={value} value={value}>
                  {channel.name} · {model.name || model.id}
                  {channel.authKind === "lolicode_account" ? " · free" : ""}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className={CARD} aria-labelledby="channel-tools-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="channel-tools-heading"
                className="text-base font-semibold text-fg-1"
              >
                本地 Agent 工具
              </h2>
              <p className="mt-1 text-caption text-fg-2">
                查看本机安装状态，安装、升级或诊断需要使用的工具。
              </p>
            </div>
            <Button
              variant="neutral"
              size="compact"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen((value) => !value)}
            >
              {toolsOpen ? "收起工具管理" : "展开工具管理"}
            </Button>
          </div>
          {toolsOpen && (
            <AppsPage
              embedded
              simpleMode
              configureLocalAgentDisabled={disabled || conflict || formTouched}
              onConfigureLocalAgent={(target) => {
                if (!snapshot.targets.includes(target)) {
                  updateSnapshot({
                    ...snapshot,
                    targets: [...snapshot.targets, target],
                  });
                }
                setNotice(
                  `已选择 ${CHANNEL_TARGET_NAMES[target]}，请在下方确认配置目标并点击“一键配置”；本次选择不会直接改动外部工具。`,
                );
                document
                  .getElementById("channel-target-heading")
                  ?.scrollIntoView?.({
                    block: "center",
                    behavior: reducedMotion ? "auto" : "smooth",
                  });
                document.getElementById(`channel-target-${target}`)?.focus();
              }}
            />
          )}
        </section>

        <section className={CARD} aria-labelledby="channel-target-heading">
          <h2
            id="channel-target-heading"
            className="text-base font-semibold text-fg-1"
          >
            应用渠道到本地 Agent 工具
          </h2>
          <p className="mt-1 text-caption text-fg-2">
            选择明确的目标后，点击下方按钮才会写入这些工具的本地配置。各工具使用兼容模型，结果逐项保留；失败可重试。
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {CHANNEL_TARGETS.map((app) => (
              <label
                key={app}
                className={cn(
                  "lolicode-channel-target flex cursor-pointer items-center gap-2 border px-3 py-3 text-body text-fg-1",
                  snapshot.targets.includes(app)
                    ? "border-border-strong bg-subtle"
                    : "border-border",
                )}
                data-selected={snapshot.targets.includes(app)}
              >
                <Checkbox
                  id={`channel-target-${app}`}
                  aria-label={CHANNEL_TARGET_NAMES[app]}
                  checked={snapshot.targets.includes(app)}
                  disabled={disabled}
                  onCheckedChange={(enabled) =>
                    updateSnapshot({
                      ...snapshot,
                      targets: enabled
                        ? [...snapshot.targets, app]
                        : snapshot.targets.filter((item) => item !== app),
                    })
                  }
                />
                <ChannelTargetGlyph app={app} />
                <span>{CHANNEL_TARGET_NAMES[app]}</span>
              </label>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              variant="solid"
              size="lg"
              disabled={
                disabled ||
                conflict ||
                Boolean(editingId && formTouched) ||
                selected.length === 0 ||
                snapshot.targets.length === 0
              }
              onClick={() =>
                void run("apply", async () => {
                  setResponse(null);
                  const saved = await persist();
                  const result = await channelCenterApi.apply(saved.revision);
                  if (mounted.current) setResponse(result);
                })
              }
            >
              {busy === "apply" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <SlidersHorizontal className="h-4 w-4" />
              )}
              {busy === "apply"
                ? "正在配置…"
                : `一键配置 ${snapshot.targets.length} 个工具`}
            </Button>
            <span className="text-caption text-fg-3">
              配置目标：
              {snapshot.targets
                .map((app) => CHANNEL_TARGET_NAMES[app])
                .join("、") || "尚未选择"}
              。模型选择会自动保存，外部工具仅在点击时更新。
            </span>
          </div>
          <ChannelConnectionPanel
            disabled={Boolean(busy) || accountBusy || saving}
            routeDisabled={
              disabled ||
              conflict ||
              dirty ||
              formTouched ||
              saving ||
              !selected.some(
                ({ channel }) =>
                  channel.authKind !== "claude_subscription" &&
                  channel.authKind !== "gemini_subscription",
              )
            }
            refreshToken={response}
            onSet={async (target, mode) => {
              let result: ChannelConnection | undefined;
              await run(
                `connection-${target}`,
                async () => {
                  const saved =
                    mode === "lolicode" ? await persist() : snapshotRef.current;
                  result = await channelCenterApi.setConnection(
                    target,
                    mode,
                    saved.revision,
                  );
                },
                false,
                mode === "native",
              );
              return result;
            }}
          />
          {response && (
            <div className="mt-5 space-y-2" aria-live="polite">
              {response.results.map((result) => (
                <div
                  key={result.app}
                  className={cn(
                    "flex items-start gap-2 rounded-control px-3 py-2.5 text-body",
                    result.status === "success"
                      ? "bg-subtle text-fg-1"
                      : result.status === "error"
                        ? "bg-danger-soft text-danger-text"
                        : "bg-warning-soft text-warning-text",
                  )}
                >
                  {result.status === "success" ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <div>
                    <span className="font-medium">
                      {CHANNEL_TARGET_NAMES[result.app]} ·{" "}
                      {result.status === "success"
                        ? "配置成功"
                        : result.status === "skipped"
                          ? "已跳过"
                          : "配置失败"}
                    </span>
                    <p className="mt-0.5 break-words text-caption">
                      {result.status === "error"
                        ? channelErrorMessage(
                            result.message,
                            snapshot.channels.map((channel) => channel.apiKey),
                            "configuration",
                          )
                        : result.message}
                    </p>
                    {result.app === "claude" && result.status === "success" && (
                      <p className="mt-0.5 text-caption text-fg-2">
                        已运行的 Claude Code 请打开新终端或重启
                        CLI，使新配置生效。
                      </p>
                    )}
                  </div>
                </div>
              ))}
              {response.requiresBackground && (
                <Notice title="使用这些 LoliCode 路由模型时，需要 LoliCode 在后台运行。" />
              )}
              {response.results.length === 0 && (
                <Notice tone="warning" title="没有收到工具配置结果，请重试。" />
              )}
            </div>
          )}
        </section>
      </div>
      <Dialog open={accountManagerOpen} onOpenChange={setAccountManagerOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>管理登录账号</DialogTitle>
            <DialogDescription>
              维护渠道使用的订阅账号。重新登录或移除账号后，刷新对应渠道的模型；已移除账号不能继续使用。
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto px-6 pb-3">
            <AuthCenterPanel
              showIntro={false}
              authScrollTarget={accountManagerTarget}
            />
          </div>
          <DialogFooter>
            <Button
              variant="neutral"
              onClick={() => setAccountManagerOpen(false)}
            >
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        isOpen={resetRequested}
        title="放弃这次输入？"
        message="尚未保存的 API 地址和密钥会被清空。"
        confirmText="放弃输入"
        cancelText="继续编辑"
        variant="info"
        pending={Boolean(busy)}
        onConfirm={resetForm}
        onCancel={() => setResetRequested(false)}
      />
      <ConfirmDialog
        isOpen={reloadRequested}
        title="重新加载已保存的选择？"
        message="本页的模型和工具选择会恢复为已保存版本。API 地址和密钥输入会保留。"
        confirmText="重新加载"
        cancelText="继续编辑"
        variant="info"
        pending={Boolean(busy)}
        onConfirm={() => {
          setReloadRequested(false);
          void load();
        }}
        onCancel={() => setReloadRequested(false)}
      />
    </div>
  );
}

export default ChannelCenterPanel;
