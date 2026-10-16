import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { usageApi } from "@/lib/api/usage";
import { usageKeys } from "@/lib/query/usage";
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
      className="mt-8 rounded-panel border border-border bg-surface px-5 py-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">本地应用用量</h2>
        <Button
          variant="neutral"
          size="compact"
          disabled={sync.isPending}
          onClick={() => sync.mutate()}
        >
          <RefreshCw
            className={sync.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"}
          />
          同步应用记录
        </Button>
      </div>
      {sources.isError && (
        <p className="mb-3 text-sm text-fg-2">
          应用用量来源暂时读取失败，已有统计保留；请重新同步。
        </p>
      )}
      {sync.isError && (
        <p role="alert" className="mb-3 text-sm text-danger-text">
          同步失败，请重试；已有用量记录保留。
        </p>
      )}
      {Boolean(sync.data?.errors.length) && (
        <p role="alert" className="mb-3 text-sm text-fg-2">
          部分应用的日志格式暂时无法读取，已有记录保留。
          {sync.data?.errors.join("；")}
        </p>
      )}
      <ul className="divide-y divide-border">
        {Object.entries(DESKTOP_USAGE_APPS).map(([app, name]) => {
          const source = sources.data?.find((item) => item.appType === app);
          const unknown = source?.unpricedRequests ?? 0;
          const priced = source
            ? Math.max(0, source.requestCount - unknown)
            : 0;
          const historical = source?.historicalRequests ?? 0;
          return (
            <li
              key={app}
              className="flex flex-wrap items-center justify-between gap-2 py-3"
              title={source?.detail}
            >
              <span className="text-sm font-medium">{name}</span>
              <span className="text-right text-xs text-fg-2">
                {source && source.requestCount > 0 ? (
                  <>
                    {fmtInt(source.requestCount)} 次请求
                    {(Number(source.totalCostUsd) > 0 ||
                      (historical === 0 && priced > 0)) && (
                      <> · 已定价估算 {fmtUsd(source.totalCostUsd, 4)}</>
                    )}
                    {unknown > 0 && <> · {fmtInt(unknown)} 次待定价</>}
                    {Boolean(source.cachePartialRequests) && (
                      <> · 部分缓存未回报</>
                    )}
                    {source.status === "unavailable" && (
                      <> · 同步异常，保留历史记录</>
                    )}
                    {historical > 0 && (
                      <>
                        {" "}
                        · 含 {fmtInt(historical)}{" "}
                        次历史汇总（逐笔计价状态未保留）
                      </>
                    )}
                  </>
                ) : source?.status === "not_found" ? (
                  "未发现本地记录"
                ) : source?.status === "awaiting_usage" ? (
                  "已检测到，等待请求用量"
                ) : source?.status === "unavailable" ? (
                  "本地记录暂无法读取，请同步重试"
                ) : sources.isLoading ? (
                  "正在读取…"
                ) : (
                  "状态暂不可用"
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs leading-relaxed text-fg-2">
        只读同步本机逐请求明细（约 1
        分钟后入账），与上方时间筛选独立。费用为本地估算，未定价请求不按免费计算；缓存未回报不表示未命中。官方账单以服务商为准。
      </p>
    </section>
  );
}
