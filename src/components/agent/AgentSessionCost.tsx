import { useQueryClient } from "@tanstack/react-query";
import { useSessionUsageSummary, usageKeys } from "@/lib/query/usage";
import { useTauriEvent } from "@/hooks/useTauriEvent";

const count = (value?: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;

export function AgentSessionCost({
  sessionId,
  active = false,
  hasRecordedCalls = false,
}: {
  sessionId: string;
  active?: boolean;
  hasRecordedCalls?: boolean;
}) {
  const queryClient = useQueryClient();
  const billing = useSessionUsageSummary("lolicode", sessionId, {
    refetchInterval: active ? 5000 : 30000,
  });
  useTauriEvent("usage-log-recorded", () => {
    void queryClient.invalidateQueries({
      queryKey: usageKeys.session("lolicode", sessionId),
    });
  });
  const summary = billing.data;
  const requests = count(summary?.totalRequests);
  const unpriced = count(summary?.unpricedRequests);
  const partial = count(summary?.partialRequests);
  const cachePartial = count(summary?.cachePartialRequests);
  const raw = summary?.totalCost;
  const amount =
    typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  const validAmount = Number.isFinite(amount) && amount >= 0;
  const qualityKnown = summary?.unpricedRequests !== undefined;
  const warnings = [
    unpriced ? `${unpriced} 次请求待定价` : "",
    partial ? `${partial} 次请求用量待确认` : "",
    cachePartial ? `${cachePartial} 次请求缓存计价不完整` : "",
  ].filter(Boolean);
  let label = "费用读取中…";
  if (!summary && billing.isError) label = "费用暂不可用";
  else if (summary) {
    if (!requests) label = hasRecordedCalls ? "费用待关联" : "尚未记录费用";
    else if (!validAmount) label = "费用待确认";
    else if (amount === 0 && unpriced > 0) label = "费用待定价";
    else if (amount === 0 && (partial > 0 || cachePartial > 0 || !qualityKnown))
      label = "费用待确认";
    else {
      const display =
        amount > 0 && amount < 0.0001 ? "<$0.0001" : `$${amount.toFixed(4)}`;
      label = `${warnings.length ? "已定价估算" : "估算费用"} ${display}`;
    }
  }
  const title = [
    requests
      ? `本会话已关联 ${requests.toLocaleString("zh-CN")} 次模型请求。`
      : "尚未关联到本会话的费用记录。",
    "费用包含主任务、标题生成和上下文压缩等可归属到本会话的模型请求；Token 与轮数仍按主任务回报显示。",
    ...warnings,
    "金额根据已记录的用量与已知单价估算，实际以渠道账单为准；上游未回报的用量不估填。",
    "历史未能关联会话的请求仍在总用量中，不会猜测分配到此会话。",
    billing.isError ? "读取失败，正在保留上次成功读取的金额。" : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <>
      <span aria-hidden="true">·</span>
      <span aria-label="本会话估算费用" title={title}>
        {label}
        {billing.isError && summary ? "（待刷新）" : ""}
      </span>
      {warnings.length > 0 && <span title={title}>{warnings.join(" · ")}</span>}
    </>
  );
}
