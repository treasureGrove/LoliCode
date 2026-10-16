import type { AgentUsage } from "@/types/agent";

const validCount = (value?: number): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0;
const formatCount = (value?: number) =>
  validCount(value) ? value.toLocaleString("zh-CN") : "—";
const compact = (value?: number) =>
  validCount(value)
    ? new Intl.NumberFormat("en", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value)
    : "—";

export function AgentUsageFooter({ usage }: { usage?: AgentUsage }) {
  const session = usage?.session;
  const total = validCount(session?.totalTokens)
    ? session.totalTokens
    : session?.tokenReportedRequests === undefined &&
        validCount(session?.inputTokens) &&
        validCount(session?.outputTokens)
      ? session.inputTokens + session.outputTokens
      : undefined;
  const recorded = session?.tokenReportedRequests ?? session?.reportedRequests;
  const pending =
    validCount(session?.modelRequests) && validCount(recorded)
      ? Math.max(0, session.modelRequests - recorded)
      : 0;
  const hit = session?.cacheHitRate;
  const title = [
    `输入 ${formatCount(session?.inputTokens)} · 输出 ${formatCount(session?.outputTokens)}`,
    `缓存读 ${formatCount(session?.cacheReadTokens)} · 缓存写 ${formatCount(session?.cacheWriteTokens)}`,
    session?.complete === false
      ? "仅包含此会话开始记录后的请求，较早历史未计入。"
      : undefined,
    pending
      ? `${pending} 次请求尚未完整回报用量；当前数值保留已收到的记录。`
      : undefined,
    "数据来自模型服务回传；未回报的用量不估填，缓存命中率仅统计有对应缓存回报的请求。",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="wb-usage-footer" aria-label="本会话用量" title={title}>
      <span>
        {validCount(total)
          ? `会话用量 ${compact(total)} tokens`
          : session?.modelRequests
            ? "用量待上游回报"
            : "尚未记录用量"}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        缓存命中{" "}
        {typeof hit === "number" && Number.isFinite(hit) && hit >= 0 && hit <= 1
          ? `${(hit * 100).toFixed(1)}%`
          : "未回报"}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        {validCount(session?.modelRequests)
          ? `${formatCount(session.modelRequests)} 轮`
          : "暂无请求记录"}
      </span>
    </div>
  );
}
