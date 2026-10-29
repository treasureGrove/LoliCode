import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  channelCenterApi,
  type ChannelConnection,
} from "@/lib/api/channel-center";
import { ChannelTargetGlyph, CHANNEL_TARGET_NAMES } from "./channelTargets";
import { cn } from "@/lib/utils";

export function ChannelConnectionPanel({
  disabled,
  routeDisabled,
  refreshToken,
  onSet,
}: {
  disabled: boolean;
  routeDisabled: boolean;
  refreshToken: unknown;
  onSet: (
    app: ChannelConnection["app"],
    mode: "native" | "lolicode",
  ) => Promise<ChannelConnection | undefined>;
}) {
  const [connections, setConnections] = useState<ChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [operationFailed, setOperationFailed] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setFailed(false);
    try {
      const result = await channelCenterApi.getConnections();
      if (mounted.current && request === generation.current)
        setConnections(result);
    } catch {
      if (mounted.current && request === generation.current) setFailed(true);
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [load, refreshToken]);

  const change = async (
    app: ChannelConnection["app"],
    mode: "native" | "lolicode",
  ) => {
    if (
      disabled ||
      changing ||
      loading ||
      (mode === "lolicode" && routeDisabled)
    )
      return;
    generation.current += 1;
    setChanging(app);
    setOperationFailed(false);
    try {
      const result = await onSet(app, mode);
      if (!mounted.current) return;
      if (result)
        setConnections((old) =>
          old.map((item) => (item.app === app ? result : item)),
        );
      else await load(); // The parent reports errors; always re-read actual file state.
    } catch {
      if (mounted.current) {
        setOperationFailed(true);
        await load();
      }
    } finally {
      if (mounted.current) setChanging(null);
    }
  };
  return (
    <section
      className="mt-5 border-t border-border pt-4"
      aria-label="工具连接方式"
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-medium text-fg-1">Codex / Claude 连接方式</h4>
        <Button
          size="compact"
          variant="quiet"
          disabled={disabled || loading || Boolean(changing)}
          onClick={() => void load()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新连接状态
        </Button>
      </div>
      <p className="mt-1 text-caption text-fg-3">
        原生配置使用工具自身的地址与登录；LoliCode 路由使用已配置渠道，需要
        LoliCode 在后台运行。其他工具在上方配置模型即可。
      </p>
      {operationFailed && (
        <Notice
          tone="warning"
          title="切换未完成，已重新读取实际配置状态，请重试。"
        />
      )}
      {failed ? (
        <Notice tone="warning" title="无法读取连接状态，请刷新后重试。" />
      ) : (
        <div
          className="mt-3 grid gap-3 sm:grid-cols-2"
          aria-busy={loading || Boolean(changing)}
        >
          {(["codex", "claude"] as const).map((app) => {
            const state = connections.find((item) => item.app === app);
            const label = CHANNEL_TARGET_NAMES[app];
            const blocked = disabled || loading || Boolean(changing) || !state;
            return (
              <div
                key={app}
                className="rounded-control border border-border px-3 py-3"
                role="group"
                aria-label={`${label} 连接方式`}
              >
                <div className="flex items-center gap-2 text-body">
                  <ChannelTargetGlyph app={app} />
                  <span className="font-medium">{label}</span>
                  <span
                    className="ml-auto text-caption text-fg-3"
                    role="status"
                  >
                    {changing === app
                      ? "正在切换…"
                      : loading
                        ? "读取中…"
                        : state?.mode === "lolicode"
                          ? "当前：LoliCode 路由"
                          : state?.mode === "native"
                            ? "当前：原生配置"
                            : "状态待确认"}
                  </span>
                </div>
                <div className="mt-3 flex gap-1 rounded-control bg-subtle p-1">
                  {(["native", "lolicode"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-label={`${label} 使用${mode === "native" ? "原生配置" : "LoliCode 路由"}`}
                      aria-pressed={state?.mode === mode}
                      disabled={
                        blocked ||
                        state?.mode === mode ||
                        (mode === "lolicode" && routeDisabled)
                      }
                      className={cn(
                        "flex-1 rounded px-2 py-1.5 text-caption transition-colors disabled:cursor-default",
                        state?.mode === mode
                          ? "bg-base font-medium text-fg-1 shadow-sm"
                          : "text-fg-3 enabled:hover:bg-base disabled:opacity-50",
                      )}
                      onClick={() => void change(app, mode)}
                    >
                      {mode === "native" ? "原生配置" : "LoliCode 路由"}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-caption text-fg-3">
                  {state?.message ||
                    (!state?.configured
                      ? "切换到 LoliCode 路由时，将为此工具配置所选模型。"
                      : state.hasNativeProfile
                        ? "切回原生时恢复切换前的配置，插件和 MCP 保留。"
                        : "旧版未保存原生记录时，切回工具官方登录配置。")}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
