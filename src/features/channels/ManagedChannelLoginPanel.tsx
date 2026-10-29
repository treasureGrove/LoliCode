import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/input";
import { useManagedAuth } from "@/features/providers/forms/hooks/useManagedAuth";
import type { ManagedAuthProvider } from "@/lib/api/auth";
import type { ChannelSource } from "@/lib/api/channel-center";
import { settingsApi } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { channelErrorMessage } from "./channelCenterUtils";

interface ManagedChannelLoginPanelProps {
  authProvider: ManagedAuthProvider;
  channels: ChannelSource[];
  disabled?: boolean;
  onConnected: (channel: ChannelSource) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}

const ACCOUNT_LABEL: Record<ManagedAuthProvider, string> = {
  github_copilot: "GitHub Copilot",
  codex_oauth: "ChatGPT",
  xai_oauth: "xAI",
};

/** Reuses the existing managed device-code flows, never accepting pasted OAuth tokens. */
export function ManagedChannelLoginPanel({
  authProvider,
  channels,
  disabled = false,
  onConnected,
  onBusyChange,
}: ManagedChannelLoginPanelProps) {
  const auth = useManagedAuth(authProvider);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [loginRequested, setLoginRequested] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const beforeLogin = useRef<Set<string> | null>(null);
  const loginStarted = useRef(false);
  const connectingRef = useRef(false);
  const mounted = useRef(true);
  const connected = useRef(onConnected);
  connected.current = onConnected;
  const busyChanged = useRef(onBusyChange);
  busyChanged.current = onBusyChange;
  const busy = loginRequested || auth.isAddingAccount || connecting;
  const label = ACCOUNT_LABEL[authProvider];
  const accountId =
    (auth.accounts.some((item) => item.id === selectedAccount)
      ? selectedAccount
      : auth.accounts.some((item) => item.id === auth.defaultAccountId)
        ? auth.defaultAccountId
        : auth.accounts[0]?.id) || "";
  const account = auth.accounts.find((item) => item.id === accountId);
  const needsReauth = account?.reauth_required || account?.requires_reauth;
  const existing = channels.find(
    (channel) =>
      channel.authKind === authProvider && channel.accountId === accountId,
  );

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      busyChanged.current?.(false);
    };
  }, []);

  const clearLogin = () => {
    beforeLogin.current = null;
    loginStarted.current = false;
    setLoginRequested(false);
  };

  const connect = async (id: string) => {
    if (disabled || connectingRef.current) return;
    const chosen = auth.accounts.find((item) => item.id === id);
    if (!chosen || chosen.reauth_required || chosen.requires_reauth) return;
    connectingRef.current = true;
    setConnecting(true);
    setSelectedAccount(id);
    setError(null);
    setMessage(null);
    clearLogin();
    const previous = channels.find(
      (channel) =>
        channel.authKind === authProvider && channel.accountId === id,
    );
    const source: ChannelSource = previous ?? {
      id: `${authProvider === "github_copilot" ? "copilot" : authProvider}-${id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100)}`,
      name: `${label} · ${chosen.login}`,
      baseUrl:
        authProvider === "github_copilot"
          ? "https://api.githubcopilot.com"
          : "",
      apiKey: "",
      authKind: authProvider,
      accountId: id,
      protocol:
        authProvider === "github_copilot" ? "openai_chat" : "openai_responses",
      enabled: true,
      models: [],
    };
    try {
      await connected.current({ ...source, apiKey: "" });
      if (mounted.current) setMessage("账号渠道和模型已加入。");
    } catch (cause) {
      if (mounted.current) setError(channelErrorMessage(cause));
    } finally {
      connectingRef.current = false;
      if (mounted.current) setConnecting(false);
    }
  };

  useEffect(() => {
    if (!beforeLogin.current) return;
    if (
      auth.isAddingAccount ||
      auth.pollingState === "polling" ||
      auth.pollingState === "success"
    )
      loginStarted.current = true;
    if (auth.pollingState === "error") {
      clearLogin();
      return;
    }
    const authorizationFinished =
      auth.pollingState === "success" ||
      (loginStarted.current &&
        !auth.isAddingAccount &&
        auth.pollingState === "idle");
    const added =
      auth.isStatusSuccess && authorizationFinished
        ? auth.accounts.find((item) => !beforeLogin.current?.has(item.id))
        : undefined;
    if (added && (added.reauth_required || added.requires_reauth)) {
      clearLogin();
      setSelectedAccount(added.id);
      setError("此账号需要重新登录，暂不能加入渠道。");
      return;
    }
    if (added && !disabled && !connectingRef.current) {
      void connect(added.id);
      return;
    }
    // Success precedes the hook's status refresh. Its final idle state is the
    // moment an existing account can be offered without guessing which login returned.
    if (
      !added &&
      loginStarted.current &&
      !auth.isAddingAccount &&
      auth.pollingState === "idle"
    ) {
      clearLogin();
      setMessage(
        "授权已完成。请选择账号并点击“加入渠道”，已有渠道可刷新模型。",
      );
    }
  });

  const startLogin = (reauth = false) => {
    if (disabled || beforeLogin.current || busy) return;
    beforeLogin.current = new Set(auth.accounts.map((item) => item.id));
    loginStarted.current = false;
    setLoginRequested(true);
    setError(null);
    setMessage(null);
    if (reauth && accountId) auth.reauthAccount(accountId);
    else auth.addAccount();
  };

  return (
    <div className="space-y-3">
      <p className="text-caption text-fg-2">
        {authProvider === "codex_oauth"
          ? "登录 ChatGPT 订阅账号，授权后自动获取该账号的可用模型。"
          : authProvider === "xai_oauth"
            ? "登录 xAI 订阅账号，授权后自动获取可用模型。"
            : "登录 GitHub Copilot 订阅账号，授权后自动获取可用模型。"}
      </p>
      {!auth.isStatusSuccess && !auth.isStatusError && (
        <p className="flex items-center gap-2 text-caption text-fg-3">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在读取登录状态…
        </p>
      )}
      {auth.isStatusError && (
        <div role="alert" className="text-caption text-danger-text">
          无法读取账号，请重试。
          <Button
            variant="quiet"
            size="compact"
            onClick={() => void auth.refetchStatus()}
          >
            重试
          </Button>
        </div>
      )}
      {auth.accounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`${label} 账号`}
            className={cn(fieldClass, "h-8 min-w-0 flex-1")}
            value={accountId}
            disabled={disabled || busy}
            onChange={(event) => setSelectedAccount(event.target.value)}
          >
            {auth.accounts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.login}
                {item.reauth_required || item.requires_reauth
                  ? " · 需要重新登录"
                  : ""}
              </option>
            ))}
          </select>
          <Button
            variant="neutral"
            disabled={
              disabled ||
              busy ||
              !account ||
              Boolean(needsReauth) ||
              !auth.isStatusSuccess
            }
            onClick={() => void connect(accountId)}
          >
            {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
            {existing ? "刷新此账号模型" : "加入渠道"}
          </Button>
        </div>
      )}
      <Button
        variant="neutral"
        disabled={disabled || busy || !auth.isStatusSuccess}
        onClick={() => startLogin(Boolean(needsReauth))}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {connecting
          ? "正在加入模型…"
          : busy
            ? "等待浏览器授权…"
            : needsReauth
              ? "重新登录此账号"
              : auth.accounts.length
                ? "登录另一个账号"
                : `使用 ${label} 登录`}
      </Button>
      {auth.deviceCode && auth.pollingState === "polling" && !connecting && (
        <div
          className="space-y-2 rounded-control bg-subtle p-3 text-caption text-fg-2"
          role="status"
        >
          <p>请在浏览器中确认登录；如需验证码，可复制下面的代码。</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base tracking-widest text-fg-1">
              {auth.deviceCode.user_code}
            </span>
            <Button
              variant="quiet"
              size="compact"
              onClick={() =>
                void copyText(auth.deviceCode!.user_code).catch(() =>
                  setError("复制失败，请手动复制上面的验证码。"),
                )
              }
            >
              <Copy className="h-3.5 w-3.5" />
              复制
            </Button>
            <Button
              variant="quiet"
              size="compact"
              onClick={() =>
                void settingsApi
                  .openExternal(auth.deviceCode!.verification_uri)
                  .catch(() => setError("打开浏览器失败，请重试。"))
              }
            >
              <ExternalLink className="h-3.5 w-3.5" />
              打开授权页
            </Button>
            <Button
              variant="quiet"
              size="compact"
              onClick={() => {
                clearLogin();
                auth.cancelAuth();
              }}
            >
              取消登录
            </Button>
          </div>
        </div>
      )}
      {busy && !auth.deviceCode && !connecting && (
        <Button
          variant="quiet"
          size="compact"
          onClick={() => {
            clearLogin();
            auth.cancelAuth();
          }}
        >
          取消登录
        </Button>
      )}
      {message && (
        <p role="status" className="text-caption text-fg-2">
          {message}
        </p>
      )}
      {(error || auth.error) && (
        <p role="alert" className="text-caption text-danger-text">
          {error || channelErrorMessage(auth.error)}
        </p>
      )}
    </div>
  );
}
