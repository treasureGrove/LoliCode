import { useState } from "react";
import { Copy, Loader2, Network, Play, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { channelCenterApi } from "@/lib/api/channel-center";
import { cn } from "@/lib/utils";
import { useChannelRuntimeStatus } from "./useChannelRuntimeStatus";

export function ChannelGatewayPanel({
  disabled,
  routeDisabled,
  revision,
  refreshToken,
  onConnect,
}: {
  disabled: boolean;
  routeDisabled: boolean;
  revision?: number;
  refreshToken: unknown;
  onConnect: () => Promise<boolean>;
}) {
  const { status, loading, failed, mounted, refresh, applyStatus } =
    useChannelRuntimeStatus(
      channelCenterApi.getGatewayStatus,
      refreshToken,
      5_000,
    );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(
    null,
  );
  const run = async (action: string, operation: () => Promise<string>) => {
    if (disabled || loading || failed || busy) return;
    setBusy(action);
    setNotice(null);
    try {
      const text = await operation();
      if (mounted.current) setNotice({ error: false, text });
    } catch {
      if (mounted.current) {
        setNotice({
          error: true,
          text:
            action === "copy"
              ? "无法复制配置，请确认 Gateway 正在运行且允许访问剪贴板。"
              : action === "check"
                ? "Gateway 连接检查失败，请刷新状态并重新启动服务。"
                : action === "enter"
                  ? "未能进入 Claude Code。请确认工具已安装；连接配置完成后也可在项目终端手动运行 claude。"
                  : "操作未完成，请确认渠道已保存、账户已授权且服务端口可用后重试。",
        });
        if (action !== "copy") void refresh();
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const available = status?.running && status.baseUrl;
  const catalogCurrent =
    available &&
    status.revision === revision &&
    status.revision === status.savedRevision;
  const blocked = disabled || loading || Boolean(busy);
  return (
    <section
      className="lolicode-channel-section"
      aria-labelledby="channel-gateway-heading"
      aria-busy={loading || Boolean(busy)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="channel-gateway-heading"
          className="flex items-center gap-2 text-base font-semibold text-fg-1"
        >
          <Network className="h-4 w-4" /> Gateway 路由服务
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <span
            role="status"
            className={cn(
              "rounded-full px-2.5 py-1 text-caption font-medium",
              failed
                ? "bg-warning-soft text-warning-text"
                : available
                  ? "bg-success-soft text-success-text"
                  : "bg-subtle text-fg-2",
            )}
          >
            {failed
              ? "状态暂时无法确认"
              : !status
                ? "读取中…"
                : available
                  ? "Gateway 运行中"
                  : status?.running
                    ? "服务已运行，Gateway 待启用"
                    : "Gateway 未启动"}
          </span>
          <Button
            size="compact"
            variant="quiet"
            disabled={blocked}
            onClick={() => void refresh(true)}
            aria-label="刷新 Gateway 状态"
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5",
                loading && "motion-safe:animate-spin",
              )}
            />
            刷新
          </Button>
        </div>
      </div>
      <p className="mt-2 text-caption text-fg-2">
        先启动 Gateway 路由服务，再进入 Claude Code。Claude Code
        通过本机路由使用所选渠道与模型；使用期间请保持 LoliCode 在后台运行。
      </p>
      {available && (
        <dl className="mt-4 grid gap-3 text-caption sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-fg-3">Anthropic Base URL</dt>
            <dd className="mt-1 break-all font-mono text-fg-1">
              {status.baseUrl}
            </dd>
          </div>
          <div>
            <dt className="text-fg-3">默认模型</dt>
            <dd className="mt-1 break-all text-fg-1">
              {status.defaultModel || "未设置"}
            </dd>
          </div>
          <div>
            <dt className="text-fg-3">模型与服务请求</dt>
            <dd className="mt-1 text-fg-1">
              {status.modelCount} 个模型 · {status.totalRequests} 次请求 ·{" "}
              {status.activeConnections} 个连接
            </dd>
          </div>
        </dl>
      )}
      {available && !catalogCurrent && !failed && (
        <p className="mt-3 text-caption text-fg-2">
          渠道目录已更新，请先更新路由目录，再进入 Claude Code 应用新模型。
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="compact"
          variant="neutral"
          disabled={blocked || failed || routeDisabled}
          onClick={() =>
            void run("start", async () => {
              const next = await channelCenterApi.startGateway(revision);
              applyStatus(next);
              return available
                ? "路由目录已更新，可以进入 Claude Code。"
                : "路由服务已启动，可以进入 Claude Code。";
            })
          }
        >
          {busy === "start" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {available ? "更新路由目录" : "启动路由服务"}
        </Button>
        <Button
          size="compact"
          variant="solid"
          disabled={blocked || routeDisabled || failed || !catalogCurrent}
          onClick={() =>
            void run("enter", async () => {
              if (!(await onConnect())) throw new Error("connection failed");
              if (!mounted.current) return "";
              const next = await channelCenterApi.getGatewayStatus();
              if (!mounted.current) return "";
              applyStatus(next);
              if (!(await channelCenterApi.openGatewayClaude()))
                throw new Error("terminal did not open");
              return "已打开使用 Gateway 的 Claude Code。可用 /status 查看连接，/model 选择模型。";
            })
          }
        >
          <Unplug className="h-3.5 w-3.5" />
          进入 Claude Code
        </Button>
        <Button
          size="compact"
          variant="neutral"
          disabled={blocked || failed || !available}
          onClick={() =>
            void run("check", async () => {
              const next = await channelCenterApi.checkGateway();
              applyStatus(next);
              return "本机 Gateway 认证与模型目录检查通过；此检查不调用上游模型。";
            })
          }
        >
          检查连接
        </Button>
        <Button
          size="compact"
          variant="quiet"
          disabled={blocked || failed || !available}
          onClick={() =>
            void run("copy", async () => {
              const config = await channelCenterApi.getGatewayClaudeConfig();
              await navigator.clipboard.writeText(
                JSON.stringify(config, null, 2),
              );
              return "已复制 Claude Code 配置（含本机网关密钥）。手动配置时请合并到 ~/.claude/settings.json；重开会话生效。";
            })
          }
        >
          <Copy className="h-3.5 w-3.5" />
          复制接入配置
        </Button>
      </div>
      {routeDisabled && (
        <p className="mt-3 text-caption text-fg-3">
          请先保存渠道修改，并启用至少一个可通过 Gateway 调用的模型。
        </p>
      )}
      {failed && (
        <Notice
          className="mt-3"
          tone="warning"
          title={
            status
              ? "无法读取 Gateway 状态，当前显示上次读取的数据。"
              : "无法读取 Gateway 状态，请刷新后重试。"
          }
        />
      )}
      {notice && (
        <div role="status" className="mt-3">
          <Notice
            tone={notice.error ? "warning" : "neutral"}
            title={notice.text}
          />
        </div>
      )}
    </section>
  );
}
