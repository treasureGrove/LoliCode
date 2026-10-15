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
  const total =
    validCount(session?.inputTokens) && validCount(session?.outputTokens)
      ? session.inputTokens + session.outputTokens
      : undefined;
  const hit = session?.cacheHitRate;
  const title = [
    `输入 ${formatCount(session?.inputTokens)} · 输出 ${formatCount(session?.outputTokens)}`,
    `缓存读 ${formatCount(session?.cacheReadTokens)} · 缓存写 ${formatCount(session?.cacheWriteTokens)}`,
    session?.complete === false
      ? "仅包含此会话开始记录后的请求，较早历史未计入。"
      : undefined,
    "数据来自模型服务回传，缺失项显示 —。",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="wb-usage-footer" aria-label="本会话用量" title={title}>
      <span>会话用量 {compact(total)} tokens</span>
      <span aria-hidden="true">·</span>
      <span>
        缓存命中{" "}
        {typeof hit === "number" && Number.isFinite(hit) && hit >= 0 && hit <= 1
          ? `${(hit * 100).toFixed(1)}%`
          : "—"}
      </span>
      <span aria-hidden="true">·</span>
      <span>{formatCount(session?.modelRequests)} 轮</span>
    </div>
  );
}
