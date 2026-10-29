import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { channelCenterApi, type ChannelSource } from "@/lib/api/channel-center";
import { channelErrorMessage } from "./channelCenterUtils";

interface NativeSubscriptionLoginPanelProps {
  tool: "claude" | "gemini";
  disabled: boolean;
  onConnected: (channel: ChannelSource) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}

/** References the official tool's existing login; native credentials never enter the catalog. */
export function NativeSubscriptionLoginPanel({
  tool,
  disabled,
  onConnected,
  onBusyChange,
}: NativeSubscriptionLoginPanelProps) {
  const [busy, setBusy] = useState<"open" | "detect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const busyChanged = useRef(onBusyChange);
  busyChanged.current = onBusyChange;
  const name = tool === "claude" ? "Claude Code" : "Gemini CLI";
  useEffect(() => {
    onBusyChange(Boolean(busy));
  }, [busy, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      busyChanged.current(false);
    };
  }, []);

  const run = async (action: "open" | "detect") => {
    if (disabled || pending.current) return;
    pending.current = true;
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      if (action === "open") {
        await channelCenterApi.openNativeSubscriptionLogin(tool);
        if (mounted.current)
          setMessage(
            `已打开 ${name} 登录窗口。完成登录后，点击“检测并加入渠道”。`,
          );
      } else {
        const channel = await channelCenterApi.discoverNativeSubscription(tool);
        if (!mounted.current) return;
        const expected =
          tool === "claude" ? "claude_subscription" : "gemini_subscription";
        if (
          channel.authKind !== expected ||
          channel.accountId !== "native" ||
          channel.apiKey
        )
          throw new Error(
            "没有取得有效的原生订阅登录状态，请在工具中完成登录后重试。",
          );
        await onConnected(channel);
        if (mounted.current)
          setMessage(`已加入 ${name} 的原生订阅，模型由工具管理。`);
      }
    } catch (cause) {
      if (mounted.current) setError(channelErrorMessage(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-caption text-fg-2">
        此订阅由本机 {name} 登录使用。加入后仅配置 {name}
        ，模型选择交给原生工具；登录凭据保留在工具中。
      </p>
      {tool === "gemini" && (
        <p className="text-caption text-fg-3">
          打开工具后，在登录选项中选择 Google 账号登录。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="neutral"
          disabled={disabled || Boolean(busy)}
          onClick={() => void run("open")}
        >
          {busy === "open" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ExternalLink className="h-4 w-4" />
          )}
          打开工具登录
        </Button>
        <Button
          variant="neutral"
          disabled={disabled || Boolean(busy)}
          onClick={() => void run("detect")}
        >
          {busy === "detect" && <Loader2 className="h-4 w-4 animate-spin" />}
          检测并加入渠道
        </Button>
      </div>
      {message && (
        <p className="text-caption text-fg-2" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="text-caption text-danger-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
