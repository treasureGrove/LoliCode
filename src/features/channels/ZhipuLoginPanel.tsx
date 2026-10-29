import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { fieldClass } from "@/components/ui/input";
import { settingsApi } from "@/lib/api";
import {
  channelCenterApi,
  type ChannelSource,
  type ZhipuLoginProvider,
} from "@/lib/api/channel-center";
import { cn } from "@/lib/utils";
import { channelErrorMessage } from "./channelCenterUtils";

interface ZhipuLoginPanelProps {
  disabled?: boolean;
  onConnected: (channel: ChannelSource) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}

type LoginState = "idle" | "starting" | "waiting" | "connecting";

/** Uses the official browser login; OAuth credentials never become inference keys. */
export function ZhipuLoginPanel({
  disabled = false,
  onConnected,
  onBusyChange,
}: ZhipuLoginPanelProps) {
  const [provider, setProvider] = useState<ZhipuLoginProvider>("bigmodel");
  const [state, setState] = useState<LoginState>("idle");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const flowId = useRef<string | null>(null);
  const generation = useRef(0);
  const starting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connected = useRef(onConnected);
  connected.current = onConnected;
  const busyChanged = useRef(onBusyChange);
  busyChanged.current = onBusyChange;
  const busy = state !== "idle";

  const clearTimers = () => {
    if (timer.current) clearTimeout(timer.current);
    if (expiryTimer.current) clearTimeout(expiryTimer.current);
    timer.current = null;
    expiryTimer.current = null;
  };

  const cancelBackend = (id: string | null) => {
    if (id) void channelCenterApi.cancelZhipuLogin(id).catch(() => {});
  };

  const cancel = () => {
    generation.current += 1;
    starting.current = false;
    clearTimers();
    const id = flowId.current;
    flowId.current = null;
    cancelBackend(id);
    setState("idle");
    setUrl(null);
    setError(null);
    setHint(null);
  };

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    return () => {
      generation.current += 1;
      clearTimers();
      cancelBackend(flowId.current);
      flowId.current = null;
      busyChanged.current?.(false);
    };
  }, []);

  const openLogin = async (loginUrl: string, requestGeneration: number) => {
    try {
      await settingsApi.openExternal(loginUrl);
    } catch {
      if (generation.current === requestGeneration) {
        setHint("浏览器没有自动打开，请点击打开登录页。");
      }
    }
  };

  const start = async () => {
    if (disabled || starting.current || flowId.current) return;
    starting.current = true;
    const requestGeneration = ++generation.current;
    setState("starting");
    setError(null);
    setHint(null);
    const finishError = (message: string) => {
      if (generation.current !== requestGeneration) return;
      generation.current += 1;
      starting.current = false;
      clearTimers();
      cancelBackend(flowId.current);
      flowId.current = null;
      setState("idle");
      setUrl(null);
      setError(message);
    };
    try {
      const flow = await channelCenterApi.startZhipuLogin(provider);
      if (generation.current !== requestGeneration) {
        cancelBackend(flow.flowId);
        return;
      }
      flowId.current = flow.flowId;
      starting.current = false;
      setUrl(flow.url);
      setState("waiting");
      const duration =
        flow.expiresIn > 0 ? flow.expiresIn * 1000 : 5 * 60 * 1000;
      const expiresAt = Date.now() + duration;
      expiryTimer.current = setTimeout(
        () => finishError("登录等待已超时，请重新登录。"),
        duration,
      );
      const poll = async () => {
        if (generation.current !== requestGeneration) return;
        if (Date.now() >= expiresAt) {
          finishError("登录等待已超时，请重新登录。");
          return;
        }
        try {
          const status = await channelCenterApi.pollZhipuLogin(flow.flowId);
          if (generation.current !== requestGeneration) return;
          if (status.status === "error") {
            finishError(
              status.message
                ? channelErrorMessage(status.message)
                : "登录未完成，请重新登录。",
            );
            return;
          }
          if (status.status === "success") {
            if (!status.channel) {
              finishError(
                "账号已授权，但没有取得可用的 Coding Plan 渠道，请检查订阅后重试。",
              );
              return;
            }
            clearTimers();
            setState("connecting");
            try {
              await connected.current(status.channel);
              if (generation.current !== requestGeneration) return;
              generation.current += 1;
              flowId.current = null;
              cancelBackend(flow.flowId);
              setState("idle");
              setUrl(null);
              setHint("账号已登录，渠道与模型已加入。");
            } catch (cause) {
              finishError(channelErrorMessage(cause, [status.channel.apiKey]));
            }
            return;
          }
          timer.current = setTimeout(() => void poll(), 2000);
        } catch (cause) {
          finishError(channelErrorMessage(cause));
        }
      };
      void openLogin(flow.url, requestGeneration);
      void poll();
    } catch (cause) {
      finishError(channelErrorMessage(cause));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-caption text-fg-2">
        通过官方登录加入 Coding Plan，无需复制密钥。
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="zhipu-login-region">账号所在地区</Label>
        <select
          id="zhipu-login-region"
          className={cn(fieldClass, "h-8")}
          value={provider}
          disabled={disabled || busy}
          onChange={(event) => {
            setProvider(event.target.value as ZhipuLoginProvider);
            setError(null);
            setHint(null);
          }}
        >
          <option value="bigmodel">中国 · 智谱开放平台</option>
          <option value="zai">国际 · Z.ai</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="neutral"
          disabled={disabled || busy}
          onClick={() => void start()}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {state === "starting"
            ? "正在打开登录…"
            : state === "waiting"
              ? "等待浏览器授权…"
              : state === "connecting"
                ? "正在加入模型…"
                : error
                  ? "重新登录"
                  : "登录智谱 / ZCode"}
        </Button>
        {url && (
          <Button
            variant="quiet"
            size="compact"
            disabled={state === "connecting"}
            onClick={() => void openLogin(url, generation.current)}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            打开登录页
          </Button>
        )}
        {busy && (
          <Button
            variant="quiet"
            size="compact"
            disabled={state === "connecting"}
            onClick={cancel}
          >
            取消登录
          </Button>
        )}
      </div>
      {hint && (
        <p className="text-caption text-fg-2" role="status">
          {hint}
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
