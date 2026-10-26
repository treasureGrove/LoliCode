import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowDownUp,
  ChartColumn,
  CircleCheck,
  Coins,
  Layers3,
  RefreshCw,
  Search,
} from "lucide-react";
import { usageApi } from "@/lib/api/usage";
import { channelCenterApi } from "@/lib/api/channel-center";
import { Button } from "@/components/ui/button";
import { Input, fieldClass } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import type { AppId } from "@/lib/api";
import { fmtInt, fmtUsd } from "./format";
import { UsageHeatmap } from "./UsageHeatmap";
import { usageKeys } from "@/lib/query/usage";
import { DesktopUsageSources } from "./DesktopUsageSources";
import { DESKTOP_USAGE_APPS } from "./desktopSources";
import "./simple-usage.css";

type Period = "today" | "week" | "month" | "all";
type ProviderSort = "requests" | "tokens" | "cost";

const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "week", label: "近七天" },
  { value: "month", label: "近 30 天" },
  { value: "all", label: "全部" },
];

function periodBounds(period: Period, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "week") start.setDate(start.getDate() - 6);
  if (period === "month") start.setDate(start.getDate() - 29);
  return {
    from: period === "all" ? undefined : Math.floor(start.getTime() / 1000),
    to: Math.floor(now.getTime() / 1000),
  };
}

function appLabel(app: string) {
  if (app === "lolicode") return "LoliCode";
  if (app === "tavern") return "酒馆";
  if (app === "channel-gateway") return "通用渠道网关";
  return DESKTOP_USAGE_APPS[app] ?? APP_DISPLAY_NAME[app as AppId] ?? app;
}

export function SimpleUsagePage() {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<Period>("today");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ProviderSort>("requests");
  const usage = useQuery({
    queryKey: ["channel-center-usage", "summary", period],
    queryFn: () => {
      const { from, to } = periodBounds(period);
      return usageApi.getUsageSummary(from, to);
    },
    refetchInterval: 60_000,
  });
  const channels = useQuery({
    queryKey: ["channel-center-usage", "providers", period],
    queryFn: async () => {
      const { from, to } = periodBounds(period);
      const [providers, catalog] = await Promise.all([
        usageApi.getProviderStats(from, to),
        channelCenterApi.listUsageLabels().catch(() => []),
      ]);
      const channelNames = Object.fromEntries(
        catalog.map((channel) => [channel.providerId, channel.name]),
      );
      return { providers, channelNames };
    },
    refetchInterval: 60_000,
  });
  const summary = usage.data;
  const providers = channels.data?.providers ?? [];
  const providerRows = providers.map((provider) => ({
    ...provider,
    name:
      provider.appType === "lolicode" || provider.appType === "channel-gateway"
        ? (channels.data?.channelNames[provider.providerId] ??
          provider.providerName)
        : provider.providerName,
    app: appLabel(provider.appType),
  }));
  const query = search.trim().toLocaleLowerCase();
  const visibleProviders = providerRows
    .filter((provider) =>
      `${provider.name} ${provider.app}`.toLocaleLowerCase().includes(query),
    )
    .sort((a, b) => {
      const difference =
        sort === "tokens"
          ? b.totalTokens - a.totalTokens
          : sort === "cost"
            ? Number(b.totalCost) - Number(a.totalCost)
            : b.requestCount - a.requestCount;
      return difference || a.name.localeCompare(b.name, "zh-CN");
    });
  const totalProviderRequests = providers.reduce(
    (sum, provider) => sum + provider.requestCount,
    0,
  );
  const fetching = usage.isFetching || channels.isFetching;
  const updatedAt = usage.dataUpdatedAt;
  const { from } = periodBounds(period, new Date(updatedAt || Date.now()));
  const dateLabel = (date: Date) =>
    date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
  const rangeLabel =
    from == null
      ? "全部已记录用量"
      : `${dateLabel(new Date(from * 1000))}${period === "today" ? " · 今天" : ` – ${dateLabel(new Date(updatedAt || Date.now()))}`}`;
  const tokenParts = summary
    ? [
        { label: "新增输入", value: summary.totalInputTokens, tone: "input" },
        { label: "输出", value: summary.totalOutputTokens, tone: "output" },
        {
          label: "缓存读取",
          value: summary.totalCacheReadTokens,
          tone: "read",
        },
        {
          label: "缓存写入",
          value: summary.totalCacheCreationTokens,
          tone: "write",
        },
      ]
    : [];
  const totalParts = tokenParts.reduce(
    (sum, part) => sum + (part.value ?? 0),
    0,
  );
  const cacheableInput = summary
    ? summary.totalInputTokens +
      summary.totalCacheReadTokens +
      summary.totalCacheCreationTokens
    : 0;
  const refresh = () => {
    void usage.refetch();
    void channels.refetch();
    void queryClient.invalidateQueries({ queryKey: usageKeys.all });
  };
  return (
    <>
      <AppPageHeader
        title="用量"
        icon={<ChartColumn className="h-5 w-5" strokeWidth={1.75} />}
        subtitle="查看请求、Token 消耗与估算费用"
        actions={
          <Button
            variant="neutral"
            size="compact"
            disabled={fetching}
            onClick={refresh}
          >
            <RefreshCw
              aria-hidden="true"
              className={fetching ? "h-4 w-4 animate-spin" : "h-4 w-4"}
            />
            刷新
          </Button>
        }
      />
      <div
        id="main-content"
        className="lolicode-usage-scroll min-h-0 flex-1 overflow-y-auto scroll-stable"
      >
        <div className="lolicode-usage-content">
          <div className="lolicode-usage-toolbar">
            <div>
              <h2 className="lolicode-usage-range">{rangeLabel}</h2>
              <p className="lolicode-usage-caption">
                时间筛选适用于概览和渠道明细
              </p>
            </div>
            <SegmentedControl<Period>
              aria-label="统计时间"
              value={period}
              onValueChange={setPeriod}
              items={PERIODS}
            />
          </div>
          {usage.isError && (
            <p role="alert" className="lolicode-usage-notice">
              用量暂时加载失败，
              {summary
                ? "正在显示上次记录，请点击刷新重试。"
                : "请点击刷新重试。"}
            </p>
          )}
          {summary ? (
            <>
              <dl className="lolicode-usage-metrics">
                {[
                  {
                    label: "请求次数",
                    value: fmtInt(summary.totalRequests),
                    icon: Activity,
                    detail: "当前时间范围内的已记录请求",
                    tone: "requests",
                  },
                  {
                    label: "消耗 Tokens",
                    value: fmtInt(summary.realTotalTokens),
                    icon: Layers3,
                    detail: "包含新增输入、输出及缓存",
                    tone: "tokens",
                  },
                  {
                    label: "已定价估算（美元）",
                    value: fmtUsd(summary.totalCost, 4),
                    icon: Coins,
                    detail: "仅含已知单价，实际以渠道账单为准",
                    tone: "cost",
                  },
                  {
                    label: "请求成功率",
                    value: summary.totalRequests
                      ? `${summary.successRate.toFixed(1)}%`
                      : "—",
                    icon: CircleCheck,
                    detail: summary.totalRequests
                      ? "按已记录请求的返回状态计算"
                      : "有请求记录后显示",
                    tone: "success",
                  },
                ].map(({ label, value, icon: Icon, detail, tone }) => (
                  <div
                    key={label}
                    className="lolicode-usage-metric"
                    data-tone={tone}
                  >
                    <dt>
                      <span>{label}</span>
                      <Icon aria-hidden="true" size={17} strokeWidth={1.75} />
                    </dt>
                    <dd>{value}</dd>
                    <p>{detail}</p>
                  </div>
                ))}
              </dl>
              <div className="lolicode-usage-token-panel">
                <div className="lolicode-usage-token-heading">
                  <h3>Token 构成</h3>
                  <span>
                    输入缓存命中率{" "}
                    <strong>
                      {cacheableInput > 0
                        ? `${(summary.cacheHitRate * 100).toFixed(1)}%`
                        : "—"}
                    </strong>
                  </span>
                </div>
                <div className="lolicode-usage-token-bar" aria-hidden="true">
                  {tokenParts.map((part) => (
                    <span
                      key={part.tone}
                      data-tone={part.tone}
                      style={{
                        width: `${totalParts > 0 ? (part.value / totalParts) * 100 : 0}%`,
                      }}
                    />
                  ))}
                </div>
                <dl className="lolicode-usage-token-legend">
                  {tokenParts.map((part) => (
                    <div key={part.tone}>
                      <dt>
                        <i aria-hidden="true" data-tone={part.tone} />
                        {part.label}
                      </dt>
                      <dd>{fmtInt(part.value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </>
          ) : usage.isPending ? (
            <div
              role="status"
              aria-label="正在加载用量"
              className="lolicode-usage-metrics lolicode-usage-loading"
            >
              {[0, 1, 2, 3].map((item) => (
                <div key={item} className="lolicode-usage-metric">
                  <span />
                  <span />
                  <span />
                </div>
              ))}
            </div>
          ) : null}
          <div className="lolicode-usage-update">
            <span className="lolicode-usage-update-dot" aria-hidden="true" />
            每分钟自动更新
            {updatedAt > 0 && (
              <span>
                上次读取{" "}
                {new Date(updatedAt).toLocaleTimeString("zh-CN", {
                  hour12: false,
                })}
              </span>
            )}
          </div>

          <section
            className="lolicode-usage-channels"
            aria-labelledby="simple-usage-channels-title"
          >
            <div className="lolicode-usage-section-heading">
              <div>
                <h2 id="simple-usage-channels-title">
                  各渠道用量{" "}
                  <span className="lolicode-usage-count">
                    {providers.length}
                  </span>
                </h2>
                <p className="lolicode-usage-caption">
                  按应用区分记录，比较每个渠道的使用情况
                </p>
              </div>
              <div className="lolicode-usage-channel-tools">
                <div className="lolicode-usage-search">
                  <Search size={14} aria-hidden="true" />
                  <Input
                    aria-label="搜索渠道或应用"
                    placeholder="搜索渠道或应用"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <div className="lolicode-usage-sort">
                  <ArrowDownUp size={14} aria-hidden="true" />
                  <select
                    aria-label="渠道排序"
                    className={fieldClass}
                    value={sort}
                    onChange={(event) =>
                      setSort(event.target.value as ProviderSort)
                    }
                  >
                    <option value="requests">按请求次数</option>
                    <option value="tokens">按 Token 用量</option>
                    <option value="cost">按估算费用</option>
                  </select>
                </div>
              </div>
            </div>
            {channels.isError && (
              <p role="alert" className="lolicode-usage-notice">
                渠道明细暂时加载失败，
                {channels.data ? "正在显示上次记录。" : "请点击刷新重试。"}
              </p>
            )}
            {channels.isPending ? (
              <p role="status" className="lolicode-usage-empty">
                正在加载渠道明细…
              </p>
            ) : visibleProviders.length > 0 ? (
              <div className="lolicode-usage-table-scroll">
                <table className="lolicode-usage-table" aria-label="各渠道用量">
                  <thead>
                    <tr>
                      <th scope="col">渠道 / 应用</th>
                      <th scope="col">请求次数 / 占比</th>
                      <th scope="col">消耗 Tokens</th>
                      <th scope="col">估算费用（美元）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleProviders.map((provider) => {
                      const share =
                        totalProviderRequests > 0
                          ? (provider.requestCount / totalProviderRequests) *
                            100
                          : 0;
                      return (
                        <tr key={`${provider.appType}:${provider.providerId}`}>
                          <th scope="row">
                            <span className="lolicode-usage-provider-name">
                              {provider.name}
                            </span>
                            <span className="lolicode-usage-app-label">
                              {provider.app}
                            </span>
                          </th>
                          <td>
                            <div className="lolicode-usage-share-value">
                              <span>{fmtInt(provider.requestCount)}</span>
                              <span>{share.toFixed(1)}%</span>
                            </div>
                            <div
                              className="lolicode-usage-share-bar"
                              aria-hidden="true"
                            >
                              <span style={{ width: `${share}%` }} />
                            </div>
                          </td>
                          <td>{fmtInt(provider.totalTokens)}</td>
                          <td>
                            {DESKTOP_USAGE_APPS[provider.appType] &&
                            Number(provider.totalCost) === 0 ? (
                              <span className="lolicode-usage-unpriced">
                                待定价
                              </span>
                            ) : (
                              fmtUsd(provider.totalCost, 4)
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              !channels.isError && (
                <div className="lolicode-usage-empty">
                  <ChartColumn aria-hidden="true" size={25} />
                  <p>
                    {query
                      ? "没有匹配的渠道或应用。"
                      : "这个时间段还没有用量记录。"}
                  </p>
                  {query ? (
                    <Button
                      variant="quiet"
                      size="compact"
                      onClick={() => setSearch("")}
                    >
                      清除搜索
                    </Button>
                  ) : (
                    <span>可切换时间范围，或同步下方的本地应用记录。</span>
                  )}
                </div>
              )
            )}
            <p className="lolicode-usage-footnote">
              费用按本地记录和已知单价估算，未定价记录不代表免费，实际扣费以渠道账单为准。
            </p>
          </section>
          <div className="lolicode-usage-history">
            <p className="lolicode-usage-caption">
              历史活动 · 展示完整的每日记录，不受上方时间筛选影响
            </p>
            <UsageHeatmap refreshIntervalMs={60_000} />
          </div>
          <DesktopUsageSources />
        </div>
      </div>
    </>
  );
}
