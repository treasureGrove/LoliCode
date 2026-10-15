import type { AgentTokenUsage, AgentUsage } from "@/types/agent";

const count = (value?: number) =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? value.toLocaleString("zh-CN")
    : "—";

function Counters({ usage }: { usage?: AgentTokenUsage }) {
  return (
    <>
      <span>输入 {count(usage?.inputTokens)}</span>
      <span>输出 {count(usage?.outputTokens)}</span>
      <span>缓存读 {count(usage?.cacheReadTokens)}</span>
      <span>缓存写 {count(usage?.cacheWriteTokens)}</span>
      <span>
        缓存命中{" "}
        {usage?.cacheHitRate !== undefined &&
        usage.cacheHitRate >= 0 &&
        usage.cacheHitRate <= 1
          ? `${(usage.cacheHitRate * 100).toFixed(1)}%`
          : "—"}
      </span>
      <span>模型请求 {count(usage?.modelRequests)} 轮</span>
      {usage && (
        <span>
          用量回报 {count(usage.reportedRequests)}/{count(usage.modelRequests)}
        </span>
      )}
    </>
  );
}

export function AgentUsageFooter({ usage }: { usage?: AgentUsage }) {
  return (
    <div
      className="wb-usage-footer"
      aria-label="实际模型用量"
      title="Token 与缓存计数来自模型服务回传，未回传的项目显示 —。"
    >
      <div>
        <strong>本次任务</strong>
        <Counters usage={usage?.task} />
        <span>
          耗时{" "}
          {usage?.task && Number.isFinite(usage.task.elapsedMs)
            ? `${(usage.task.elapsedMs / 1000).toFixed(1)} 秒`
            : "—"}
        </span>
        <span>
          生成速度{" "}
          {usage?.task?.generationMs &&
          usage.task.outputTokens !== undefined &&
          usage.task.reportedRequests === usage.task.modelRequests
            ? `${((usage.task.outputTokens * 1000) / usage.task.generationMs).toFixed(1)} tokens/秒`
            : "—"}
        </span>
      </div>
      <div>
        <strong>
          {usage?.session?.complete === false ? "已记录用量" : "会话累计"}
        </strong>
        <Counters usage={usage?.session} />
        {usage?.session?.complete === false && (
          <span>从 {new Date(usage.session.since).toLocaleString()} 起计</span>
        )}
      </div>
    </div>
  );
}
