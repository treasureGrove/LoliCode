import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { usageApi } from "@/lib/api/usage";
import { usageKeys } from "@/lib/query/usage";
import { ChannelTargetGlyph } from "@/components/channels/channelTargets";
import type { ChannelTarget } from "@/lib/api/channel-center";
import { Button } from "@/components/ui/button";
import { DESKTOP_USAGE_APPS } from "./desktopSources";
import { fmtInt, fmtUsd } from "./format";

export function DesktopUsageSources() {
  const client = useQueryClient();
  const sources = useQuery({
    queryKey: [...usageKeys.all, "desktop-sources"],
    queryFn: () => usageApi.getDataSourceBreakdown(),
    refetchInterval: 60_000,
  });
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
      aria-busy={sources.isLoading || sync.isPending}
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
      <ul className="lolicode-usage-sources-grid">
        {Object.entries(DESKTOP_USAGE_APPS).map(([app, name]) => {
          const source = sources.data?.find((item) => item.appType === app);
          const unknown = source?.unpricedRequests ?? 0;
          const priced = source
            ? Math.max(0, source.requestCount - unknown)
            : 0;
          const historical = source?.historicalRequests ?? 0;
          const hasRequests = Boolean(source && source.requestCount > 0);
          const hasPrice = Boolean(
            source &&
              hasRequests &&
              (Number(source.totalCostUsd) > 0 ||
                (historical === 0 && priced > 0)),
          );
          const unavailable = source?.status === "unavailable";
          const status = unavailable
            ? "同步异常"
            : hasRequests
              ? unknown > 0
                ? "含待定价"
                : "已记录"
              : source?.status === "awaiting_usage"
                ? "等待用量"
                : source?.status === "not_found"
                  ? "未发现"
                  : sources.isLoading
                    ? "读取中"
                    : sources.isError
                      ? "读取失败"
                      : "待同步";
          const tone =
            unavailable || sources.isError || (hasRequests && unknown > 0)
              ? "warning"
              : hasRequests
                ? "success"
                : "muted";
          return (
            <li
              key={app}
              className="lolicode-usage-source-card"
              title={source?.detail}
            >
              <div className="lolicode-usage-source-header">
                <h3 className="lolicode-usage-source-app">
                  <span
                    className="lolicode-usage-source-glyph"
                    aria-hidden="true"
                  >
                    <ChannelTargetGlyph app={app as ChannelTarget} />
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
                    <p className="lolicode-usage-source-count">
                      {fmtInt(source.requestCount)}{" "}
                      <span className="lolicode-usage-source-count-label">
                        次请求
                      </span>
                    </p>
                    {hasPrice && (
                      <p className="lolicode-usage-source-price">
                        已定价估算{" "}
                        <strong>{fmtUsd(source.totalCostUsd, 4)}</strong>
                      </p>
                    )}
                    {!hasPrice && (
                      <p className="lolicode-usage-source-price">
                        {historical > 0 ? "历史费用未完整保留" : "费用待定价"}
                      </p>
                    )}
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
                      {unavailable && (
                        <p
                          className="lolicode-usage-source-note"
                          data-tone="warning"
                        >
                          同步异常，保留历史记录
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
                          : sources.isLoading
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
        只读同步本机逐请求明细（约 1
        分钟后入账），与上方时间筛选独立。费用为本地估算，未定价请求不按免费计算；缓存未回报不表示未命中。官方账单以服务商为准。
      </p>
    </section>
  );
}
