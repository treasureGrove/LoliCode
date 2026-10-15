import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
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
import { APP_IDS } from "@/config/appConfig";
import { APP_DISPLAY_NAME, AppGlyph } from "@/components/shell/AppGlyph";
import { AuthCenterPanel } from "@/components/settings/AuthCenterPanel";
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
  type ChannelCenterSnapshot,
  type ChannelProtocol,
  type ChannelSource,
} from "@/lib/api/channel-center";
import { useUnsavedChangesTracker } from "@/lib/unsavedChanges";
import { cn } from "@/lib/utils";
import {
  channelErrorMessage,
  channelModelMetadata,
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

const EMPTY_SNAPSHOT: ChannelCenterSnapshot = {
  channels: [],
  targets: ["opencode", "hermes", "openclaw"],
};
const CARD = "rounded-panel border border-border bg-surface p-5";

export interface ChannelCenterPanelProps {
  onNavigationBlockedChange?: (blocked: boolean) => void;
  initialAccountManagerOpen?: boolean;
}

/** One catalog of upstream channels; target writers stay behind the backend API. */
export function ChannelCenterPanel({
  onNavigationBlockedChange,
  initialAccountManagerOpen = false,
}: ChannelCenterPanelProps = {}) {
  const [snapshot, setSnapshot] =
    useState<ChannelCenterSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reloadRequested, setReloadRequested] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
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
  const formRef = useRef<HTMLFormElement>(null);
  const blocked = dirty || formTouched || Boolean(busy) || accountBusy;
  const tracker = useUnsavedChangesTracker();

  useEffect(() => {
    if (initialAccountManagerOpen) setAccountManagerOpen(true);
  }, [initialAccountManagerOpen]);

  useEffect(() => {
    if (dirty || formTouched) tracker.markDirty();
    else tracker.markClean();
  }, [dirty, formTouched, tracker.markDirty, tracker.markClean]);
  useEffect(() => {
    onNavigationBlockedChange?.(Boolean(busy) || accountBusy);
    return () => onNavigationBlockedChange?.(false);
  }, [busy, accountBusy, onNavigationBlockedChange]);
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
      setSnapshot(withValidDefault(saved));
      setDirty(false);
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
    setName("");
    setBaseUrl(CHANNEL_PRESET_MAP.deepseek.baseUrl);
    setApiKey("");
    setPreset("deepseek");
    setSourceProtocol(CHANNEL_PRESET_MAP.deepseek.protocol);
    setEditingId(null);
    setFormTouched(false);
    setResetRequested(false);
  };

  const selectPreset = (value: string) => {
    if (value === preset) return;
    setApiKey("");
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
    setSnapshot(withValidDefault(next));
    setDirty(true);
    setResponse(null);
    setNotice(null);
  };

  const run = async (
    label: string,
    operation: () => Promise<void>,
    propagate = false,
  ) => {
    if (busyRef.current || loading || loadFailed) {
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
      const message = channelErrorMessage(cause, [
        apiKey,
        ...snapshot.channels.map((channel) => channel.apiKey),
      ]);
      if (mounted.current) {
        setConflict(String(cause).includes("另一处修改"));
        setError(message);
      }
      if (propagate) throw new Error(message);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  // A successful save consumes this revision. Get the authoritative revision
  // before further writes; if refreshing fails, stop instead of applying stale data.
  const persist = async (next: ChannelCenterSnapshot, onSaved?: () => void) => {
    const normalized = withValidDefault(next);
    await channelCenterApi.save(normalized);
    if (mounted.current) {
      setSnapshot({ ...normalized, revision: (next.revision ?? 0) + 1 });
      setDirty(false);
      setResponse(null);
      onSaved?.();
    }
    let saved: ChannelCenterSnapshot;
    try {
      saved = await channelCenterApi.get();
    } catch {
      if (mounted.current) setLoadFailed(true);
      throw new Error("选择已保存，但无法刷新渠道。请点击重新加载后继续。");
    }
    if (saved.revision !== (next.revision ?? 0) + 1) {
      if (mounted.current) setDirty(true);
      throw new Error(
        "渠道列表已被另一处修改。请重新加载后再配置；本页的选择已保留。",
      );
    }
    if (mounted.current) setSnapshot(withValidDefault(saved));
    return saved;
  };

  const upsertDiscovered = async (
    channel: ChannelSource,
    onSaved?: () => void,
    alreadyDiscovered = false,
  ) => {
    const previous = snapshot.channels.find((item) => item.id === channel.id);
    const discovered = mergeDiscoveredChannel(
      alreadyDiscovered ? channel : await channelCenterApi.discover(channel),
      previous,
    );
    const exists = snapshot.channels.some((item) => item.id === discovered.id);
    const next = {
      ...snapshot,
      targets:
        discovered.authKind === "claude_subscription" &&
        !snapshot.targets.includes("claude")
          ? [...snapshot.targets, "claude" as const]
          : discovered.authKind === "gemini_subscription" &&
              !snapshot.targets.includes("gemini")
            ? [...snapshot.targets, "gemini" as const]
            : snapshot.targets,
      channels: exists
        ? snapshot.channels.map((item) =>
            item.id === discovered.id ? discovered : item,
          )
        : [...snapshot.channels, discovered],
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
      className="lolicode-channel-center h-full overflow-y-auto"
      aria-busy={Boolean(busy) || loading}
    >
      <div className="mx-auto max-w-6xl space-y-5 px-6 py-6 sm:px-8">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-fg-1">渠道中心</h1>
            <p className="mt-1 text-body text-fg-2">
              添加一次 API 或登录账号，把可用模型同步到你选择的 AI 工具。
            </p>
          </div>
          <span className="rounded-full bg-subtle px-3 py-1.5 text-caption text-fg-2">
            {snapshot.channels.length} 个渠道 · {selected.length} 个已选模型
          </span>
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

        <section className={CARD} aria-labelledby="channel-add-heading">
          <h2
            id="channel-add-heading"
            className="text-base font-semibold text-fg-1"
          >
            1. 添加渠道
          </h2>
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
          <ChannelPresetPicker
            value={preset}
            disabled={disabled}
            onValueChange={selectPreset}
          />
          <div className="lolicode-channel-form mt-4 max-w-2xl rounded-control border border-border p-4">
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
                  addApiChannel();
                }}
              >
                <fieldset disabled={disabled} className="space-y-3">
                  {selectedPreset && (
                    <div className="flex items-center gap-2.5 rounded-control bg-subtle p-3">
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
                        setName(event.target.value);
                        setFormTouched(true);
                      }}
                    />
                  </div>
                  {preset === "custom" && (
                    <div className="space-y-1.5">
                      <Label htmlFor="channel-url">API 地址</Label>
                      <Input
                        id="channel-url"
                        type="url"
                        required
                        value={baseUrl}
                        placeholder="粘贴服务商提供的 API 地址"
                        onChange={(event) => {
                          setBaseUrl(event.target.value);
                          setFormTouched(true);
                        }}
                      />
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor="channel-key">API Key</Label>
                    <Input
                      id="channel-key"
                      type="password"
                      required
                      value={apiKey}
                      placeholder="粘贴密钥"
                      autoComplete="new-password"
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        setFormTouched(true);
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
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
                      {editingId ? "保存修改并刷新模型" : "添加并查找模型"}
                    </Button>
                    {formTouched && (
                      <Button
                        type="button"
                        variant="quiet"
                        onClick={() => setResetRequested(true)}
                      >
                        {editingId ? "取消修改" : "清空输入"}
                      </Button>
                    )}
                  </div>
                  <p className="text-caption text-fg-3">
                    {preset === "custom"
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
        </section>

        <section className={CARD} aria-labelledby="channel-model-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="channel-model-heading"
                className="text-base font-semibold text-fg-1"
              >
                2. 选择模型
              </h2>
              <p className="mt-1 text-caption text-fg-2">
                模型来自上游目录，尚未发送聊天请求测试，不代表不可用。上下文与思考强度自动读取上游返回的信息；未提供的参数会明确标注。
              </p>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-2 h-4 w-4 text-fg-3" />
              <Input
                aria-label="搜索渠道或模型"
                className="pl-8"
                value={search}
                placeholder="搜索渠道或模型"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          {snapshot.channels.length === 0 && !loading && (
            <p className="py-8 text-center text-body text-fg-3">
              添加 API 或登录订阅账号后，模型会显示在这里。
            </p>
          )}
          <div className="mt-4 space-y-3">
            {filteredChannels.map(({ channel, models }) => (
              <article
                key={channel.id}
                className="rounded-control border border-border"
                aria-label={`${channel.name} 渠道`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-subtle/50 px-3 py-2.5">
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
                          setEditingId(channel.id);
                          setName(channel.name);
                          setBaseUrl(channel.baseUrl);
                          setApiKey(channel.apiKey);
                          setPreset(
                            matchChannelPreset(channel)?.id ?? "custom",
                          );
                          setSourceProtocol(channel.protocol);
                          setFormTouched(true);
                          formRef.current?.scrollIntoView?.({
                            behavior: "smooth",
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
                      disabled={disabled}
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
                    <Button
                      variant="quiet"
                      size="compact"
                      disabled={disabled || !channel.enabled}
                      onClick={() =>
                        updateSnapshot({
                          ...snapshot,
                          channels: snapshot.channels.map((item) =>
                            item.id === channel.id
                              ? {
                                  ...item,
                                  models: item.models.map((model) => ({
                                    ...model,
                                    enabled: model.supportsTools !== false,
                                  })),
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      全选适合模型
                    </Button>
                  </div>
                </div>
                {models.length === 0 ? (
                  <p className="px-3 py-4 text-caption text-fg-3">
                    {channel.models.length === 0
                      ? "没有可用模型，请检查账号权限或刷新重试。"
                      : "没有匹配的模型。"}
                  </p>
                ) : (
                  <div className="grid gap-px sm:grid-cols-2 xl:grid-cols-3">
                    {models.map((model) => (
                      <label
                        key={model.id}
                        className={cn(
                          "flex items-start gap-2.5 px-3 py-3 text-body",
                          !channel.enabled && "opacity-50",
                        )}
                      >
                        <Checkbox
                          className="mt-0.5"
                          aria-label={`${channel.name} · ${model.name || model.id}`}
                          checked={
                            model.enabled !== false &&
                            model.supportsTools !== false
                          }
                          disabled={
                            disabled ||
                            !channel.enabled ||
                            model.supportsTools === false
                          }
                          onCheckedChange={(enabled) =>
                            updateSnapshot({
                              ...snapshot,
                              channels: snapshot.channels.map((item) =>
                                item.id === channel.id
                                  ? {
                                      ...item,
                                      models: item.models.map((entry) =>
                                        entry.id === model.id
                                          ? { ...entry, enabled }
                                          : entry,
                                      ),
                                    }
                                  : item,
                              ),
                            })
                          }
                        />
                        <span className="min-w-0">
                          <span className="block break-words text-fg-1">
                            {model.name || model.id}
                          </span>
                          <span className="mt-0.5 block text-caption text-fg-3">
                            {model.name && model.name !== model.id
                              ? `${model.id} · `
                              : ""}
                            {channelModelMetadata(channel, model)}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
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
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className={CARD} aria-labelledby="channel-target-heading">
          <h2
            id="channel-target-heading"
            className="text-base font-semibold text-fg-1"
          >
            3. 选择工具并配置
          </h2>
          <p className="mt-1 text-caption text-fg-2">
            各工具使用兼容的模型。部分工具只能设置一个当前默认模型，实际结果会逐项显示。
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {APP_IDS.map((app) => (
              <label
                key={app}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-control border px-3 py-3 text-body text-fg-1",
                  snapshot.targets.includes(app)
                    ? "border-border-strong bg-subtle"
                    : "border-border",
                )}
              >
                <Checkbox
                  aria-label={APP_DISPLAY_NAME[app]}
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
                <AppGlyph app={app} size={18} />
                <span>{APP_DISPLAY_NAME[app]}</span>
              </label>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              variant="solid"
              size="lg"
              disabled={
                disabled ||
                selected.length === 0 ||
                snapshot.targets.length === 0
              }
              onClick={() =>
                void run("apply", async () => {
                  setResponse(null);
                  const saved = await persist(snapshot);
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
            <Button
              variant="neutral"
              disabled={disabled || !dirty}
              onClick={() =>
                void run("save", async () => {
                  await persist(snapshot);
                  if (mounted.current)
                    setNotice("选择已保存。点击一键配置后会同步到工具。");
                })
              }
            >
              {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />}
              保存选择
            </Button>
            {dirty && (
              <span className="text-caption text-fg-3">有未保存的选择</span>
            )}
          </div>
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
                      {APP_DISPLAY_NAME[result.app]} ·{" "}
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
                <Notice title="这些配置需要 LoliCode 在后台运行。" />
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
