import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { usageApi } from "@/lib/api/usage";
import { usageKeys } from "@/lib/query/usage";
import { ChannelTargetGlyph } from "@/components/channels/channelTargets";
import type { ChannelTarget } from "@/lib/api/channel-center";
import { Button } from "@/components/ui/button";
import { DESKTOP_USAGE_APPS } from "./desktopSources";
import { fmtInt, fmtUsd } from "./format";
import { usageCostSource } from "@/lib/usageCostSource";
import type { DataSourceSummary } from "@/types/usage";
import lolicodeLogo from "@/assets/brand/lolicode.svg";

const LOCAL_USAGE_APPS = { lolicode: "LoliCode", ...DESKTOP_USAGE_APPS };

export function DesktopUsageSources() {
  const client = useQueryClient();
  const sources = useQuery({
    queryKey: [...usageKeys.all, "desktop-sources"],
    queryFn: () => usageApi.getDataSourceBreakdown(),
    refetchInterval: 60_000,
  });
  const lolicode = useQuery({
    queryKey: [...usageKeys.all, "desktop-sources", "lolicode"],
    queryFn: () => usageApi.getUsageSummary(undefined, undefined, "lolicode"),
    refetchInterval: 60_000,
  });
  const lolicodeSource: DataSourceSummary | undefined = lolicode.data
    ? {
        appType: "lolicode",
        dataSource: "lolicode_proxy",
        requestCount: lolicode.data.totalRequests,
        totalCostUsd: lolicode.data.totalCost,
        status: lolicode.data.totalRequests > 0 ? "recorded" : "awaiting_usage",
        unpricedRequests: lolicode.data.unpricedRequests,
        cachePartialRequests: lolicode.data.cachePartialRequests,
        partialRequests: lolicode.data.partialRequests,
        reportedCostRequests: lolicode.data.reportedCostRequests,
        estimatedCostRequests: lolicode.data.estimatedCostRequests,
        detail:
          "LoliCode 内置 Agent 累计用量，包含主任务、标题生成和上下文压缩；费用优先采用渠道回报，未回报时按模型价格库估算。",
      }
    : undefined;
  const sync = useMutation({
    mutationFn: () => usageApi.syncSessionUsage(),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: usageKeys.all }),
        client.invalidateQueries({ queryKey: ["channel-center-usage"] }),
      ]);
    },
  });
  return (
    <section
      aria-label="本地应用用量来源"
      aria-busy={sources.isLoading || lolicode.isLoading || sync.isPending}
      className="lolicode-usage-sources"
    >
      <div className="lolicode-usage-sources-header">
        <div className="lolicode-usage-sources-heading">
          <h2>本地应用用量</h2>
          <p className="lolicode-usage-sources-subtitle">
            本机累计记录 · 约每分钟更新
          </p>
        </div>
        <Button
          variant="neutral"
          size="compact"
          disabled={sync.isPending}
          onClick={() => sync.mutate()}
        >
          <RefreshCw
            aria-hidden="true"
            className={sync.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"}
          />
          同步应用记录
        </Button>
      </div>
      {sources.isError && (
        <p className="lolicode-usage-sources-feedback" data-tone="warning">
          应用用量来源暂时读取失败，已有统计保留；请重新同步。
        </p>
      )}
      {lolicode.isError && (
        <p className="lolicode-usage-sources-feedback" data-tone="warning">
          LoliCode 用量暂时读取失败，已有统计保留；请重新同步。
        </p>
      )}
      {sync.isError && (
        <p
          role="alert"
          className="lolicode-usage-sources-feedback"
          data-tone="danger"
        >
          同步失败，请重试；已有用量记录保留。
        </p>
      )}
      {Boolean(sync.data?.errors.length) && (
        <p
          role="alert"
          className="lolicode-usage-sources-feedback"
          data-tone="warning"
        >
          部分应用的日志格式暂时无法读取，已有记录保留。
          {sync.data?.errors.join("；")}
        </p>
      )}
      {sync.isPending && (
        <p role="status" className="lolicode-usage-sources-feedback">
          正在同步应用记录…
        </p>
      )}
      {sync.isSuccess && sync.data && sync.data.errors.length === 0 && (
        <p
          role="status"
          className="lolicode-usage-sources-feedback"
          data-tone="success"
        >
          {sync.data.imported > 0
            ? `同步完成，已更新 ${fmtInt(sync.data.imported)} 条用量记录。`
            : "同步完成，本次没有需要更新的记录。"}
          {sync.data.deferredFiles > 0 &&
            ` ${fmtInt(sync.data.deferredFiles)} 个文件待后续同步。`}
        </p>
      )}
      <ul
        className="lolicode-usage-sources-list scroll-stable"
        aria-label="应用累计用量列表"
        tabIndex={0}
      >
        {Object.entries(LOCAL_USAGE_APPS).map(([app, name]) => {
          const query = app === "lolicode" ? lolicode : sources;
          const source =
            app === "lolicode"
              ? lolicodeSource
              : sources.data?.find((item) => item.appType === app);
          const costSource = source
            ? usageCostSource(source, source.requestCount)
            : null;
          const unknown = source?.unpricedRequests ?? 0;
          const priced = source
            ? Math.max(0, source.requestCount - unknown)
            : 0;
          const historical = source?.historicalRequests ?? 0;
          const hasRequests = Boolean(source && source.requestCount > 0);
          const partial = Boolean(
            source?.partialRequests || source?.cachePartialRequests,
          );
          const awaitingConfirmation =
            !costSource?.allReported &&
            (partial ||
              (app === "lolicode" && source?.unpricedRequests === undefined));
          const hasPrice = Boolean(
            source &&
              hasRequests &&
              (Number(source.totalCostUsd) > 0 ||
                costSource?.allReported ||
                (historical === 0 && priced > 0 && !awaitingConfirmation)),
          );
          const unavailable = source?.status === "unavailable" || query.isError;
          const status = unavailable
            ? "同步异常"
            : hasRequests
              ? unknown > 0
                ? "含待定价"
                : awaitingConfirmation
                  ? "用量待确认"
                  : "已记录"
              : source?.status === "awaiting_usage"
                ? "等待用量"
                : source?.status === "not_found"
                  ? "未发现"
                  : query.isLoading
                    ? "读取中"
                    : query.isError
                      ? "读取失败"
                      : "待同步";
          const tone =
            unavailable ||
            (hasRequests && (unknown > 0 || awaitingConfirmation))
              ? "warning"
              : hasRequests
                ? "success"
                : "muted";
          return (
            <li
              key={app}
              className="lolicode-usage-source-row"
              title={source?.detail}
            >
              <div className="lolicode-usage-source-header">
                <h3 className="lolicode-usage-source-app">
                  <span
                    className="lolicode-usage-source-glyph"
                    aria-hidden="true"
                  >
                    {app === "lolicode" ? (
                      <img src={lolicodeLogo} alt="" />
                    ) : (
                      <ChannelTargetGlyph
                        app={app as ChannelTarget}
                        size={26}
                      />
                    )}
                  </span>
                  {name}
                </h3>
                <span className="lolicode-usage-source-status" data-tone={tone}>
                  {status}
                </span>
              </div>
              <div className="lolicode-usage-source-body">
                {source && hasRequests ? (
                  <>
                    <div className="lolicode-usage-source-metric">
                      <span className="lolicode-usage-source-metric-label">
                        累计请求
                      </span>
                      <p className="lolicode-usage-source-count">
                        {fmtInt(source.requestCount)}{" "}
                        <span className="lolicode-usage-source-count-label">
                          次请求
                        </span>
                      </p>
                    </div>
                    <div className="lolicode-usage-source-metric">
                      <span className="lolicode-usage-source-metric-label">
                        {hasPrice
                          ? costSource?.known
                            ? costSource.label
                            : "已定价估算"
                          : "费用状态"}
                      </span>
                      {hasPrice && (
                        <p className="lolicode-usage-source-price">
                          <strong>
                            {Number(source.totalCostUsd) > 0 &&
                            Number(source.totalCostUsd) < 0.0001
                              ? "<$0.0001"
                              : fmtUsd(source.totalCostUsd, 4)}
                          </strong>
                        </p>
                      )}
                      {!hasPrice && (
                        <p className="lolicode-usage-source-price">
                          {historical > 0
                            ? "历史费用未完整保留"
                            : awaitingConfirmation
                              ? "费用待确认"
                              : "费用待定价"}
                        </p>
                      )}
                    </div>
                    <div className="lolicode-usage-source-notes">
                      {unknown > 0 && (
                        <p
                          className="lolicode-usage-source-note"
                          data-tone="warning"
                        >
                          {fmtInt(unknown)} 次待定价
                        </p>
                      )}
                      {Boolean(source.cachePartialRequests) && (
                        <p className="lolicode-usage-source-note">
                          部分缓存未回报
                        </p>
                      )}
                      {Boolean(source.partialRequests) && (
                        <p className="lolicode-usage-source-note">
                          {fmtInt(source.partialRequests)} 次用量待确认
                        </p>
                      )}
                      {costSource?.detail && (
                        <p className="lolicode-usage-source-note">
                          {costSource.detail}
                        </p>
                      )}
                      {unavailable && (
                        <p
                          className="lolicode-usage-source-note"
                          data-tone="warning"
                        >
                          读取异常，保留已有记录
                        </p>
                      )}
                      {historical > 0 && (
                        <p className="lolicode-usage-source-note">
                          含 {fmtInt(historical)}{" "}
                          次历史汇总（逐笔计价状态未保留）
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="lolicode-usage-source-empty">
                    {source?.status === "not_found"
                      ? "未发现本地记录"
                      : source?.status === "awaiting_usage"
                        ? "已检测到，等待请求用量"
                        : unavailable
                          ? "本地记录暂无法读取，请同步重试"
                          : query.isLoading
                            ? "正在读取…"
                            : "状态暂不可用"}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="lolicode-usage-sources-footer">
        LoliCode 自动记录模型请求，其他应用只读同步本机明细（约 1
        分钟后入账）；均为本机累计，与上方筛选独立。费用优先采用渠道回报，否则按价格库估算；待定价不表示免费。上下滚动可查看全部应用。
      </p>
    </section>
  );
}
