import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { usageApi } from "@/lib/api/usage";
import { channelCenterApi } from "@/lib/api/channel-center";
import { Button } from "@/components/ui/button";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import type { AppId } from "@/lib/api";
import { fmtInt, fmtUsd } from "./format";
import { UsageHeatmap } from "./UsageHeatmap";
import { usageKeys } from "@/lib/query/usage";
import { CopilotBillingPanel } from "./CopilotBillingPanel";
import { DesktopUsageSources } from "./DesktopUsageSources";
import { DESKTOP_USAGE_APPS } from "./desktopSources";

type Period = "today" | "week" | "all";

export function SimpleUsagePage() {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<Period>("today");
  const usage = useQuery({
    queryKey: ["channel-center-usage", period],
    queryFn: async () => {
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      if (period === "week") start.setDate(start.getDate() - 6);
      const from =
        period === "all" ? undefined : Math.floor(start.getTime() / 1000);
      const to = Math.floor(now.getTime() / 1000);
      const [summary, providers, catalog] = await Promise.all([
        usageApi.getUsageSummary(from, to),
        usageApi.getProviderStats(from, to),
        channelCenterApi.get().catch(() => undefined),
      ]);
      const channelNames = Object.fromEntries(
        catalog?.channels.map((channel) => [
          `channel-${channel.id}`,
          channel.name,
        ]) ?? [],
      );
      return { summary, providers, channelNames };
    },
    refetchInterval: 60_000,
  });
  const summary = usage.data?.summary;
  const providers = usage.data?.providers ?? [];
  return (
    <>
      <AppPageHeader
        title="用量"
        subtitle="查看已记录的使用情况"
        actions={
          <Button
            variant="neutral"
            size="compact"
            disabled={usage.isFetching}
            onClick={() => {
              void usage.refetch();
              void queryClient.invalidateQueries({ queryKey: usageKeys.all });
            }}
          >
            <RefreshCw
              className={usage.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"}
            />
            刷新
          </Button>
        }
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-4"
      >
        <div className="mb-6 flex gap-2" role="group" aria-label="统计时间">
          {(
            [
              ["today", "今天"],
              ["week", "近七天"],
              ["all", "全部"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant={period === value ? "solid" : "neutral"}
              size="compact"
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        {usage.isError ? (
          <p role="alert" className="text-sm text-fg-2">
            用量暂时加载失败，请点击刷新重试。
          </p>
        ) : summary ? (
          <>
            <dl className="mb-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ["请求次数", fmtInt(summary.totalRequests)],
                ["消耗 Tokens", fmtInt(summary.realTotalTokens)],
                ["已定价估算（美元）", fmtUsd(summary.totalCost, 4)],
                [
                  "请求成功率",
                  summary.totalRequests
                    ? `${summary.successRate.toFixed(1)}%`
                    : "—",
                ],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-panel border border-border bg-surface px-5 py-4"
                >
                  <dt className="mb-2 text-sm text-fg-2">{label}</dt>
                  <dd className="text-2xl font-semibold tabular-nums">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mb-8">
              <UsageHeatmap refreshIntervalMs={60_000} />
            </div>
            {providers.length > 0 ? (
              <section aria-label="各渠道用量">
                <h2 className="mb-3 text-base font-semibold">各渠道用量</h2>
                <div className="divide-y divide-border rounded-panel border border-border bg-surface">
                  {providers.map((provider) => (
                    <div
                      key={`${provider.appType}:${provider.providerId}`}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
                    >
                      <div>
                        <p className="font-medium">
                          {provider.appType === "channel-gateway"
                            ? (usage.data?.channelNames[provider.providerId] ??
                              provider.providerName)
                            : provider.providerName}
                        </p>
                        <p className="text-xs text-fg-2">
                          {provider.appType === "channel-gateway"
                            ? "统一渠道服务"
                            : (DESKTOP_USAGE_APPS[provider.appType] ??
                              APP_DISPLAY_NAME[provider.appType as AppId] ??
                              provider.appType)}
                        </p>
                      </div>
                      <div className="text-right text-sm tabular-nums">
                        <p>
                          {fmtInt(provider.requestCount)} 次 ·{" "}
                          {fmtInt(provider.totalTokens)} Tokens
                        </p>
                        <p className="text-fg-2">
                          {DESKTOP_USAGE_APPS[provider.appType] &&
                          Number(provider.totalCost) === 0
                            ? "待定价"
                            : fmtUsd(provider.totalCost, 4)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <p className="text-sm text-fg-2">这个时间段还没有用量记录。</p>
            )}
            <p className="mt-5 text-xs text-fg-2">
              费用按本地记录和已知单价估算，实际扣费以渠道账单为准。
            </p>
          </>
        ) : (
          <p role="status" className="text-sm text-fg-2">
            正在加载用量…
          </p>
        )}
        <DesktopUsageSources />
        <CopilotBillingPanel />
      </div>
    </>
  );
}
