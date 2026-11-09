import { Loader2, Pause, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentNativeSession } from "@/hooks/useAgentNativeSession";
import type { SessionWireEvent } from "@/types/harness-session";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const endReasons: Record<string, string> = {
  completed: "已完成",
  aborted: "已取消",
  blocked: "已阻塞",
  error: "执行失败",
  "max-tokens": "达到输出上限",
  interrupted: "进程中断",
  forked: "已分叉",
};

function Content({ value }: { value: unknown }) {
  if (!Array.isArray(value)) return null;
  return value.map((item, index) => {
    const block = object(item);
    if (block.type === "text" && typeof block.text === "string")
      return (
        <p
          key={index}
          className="whitespace-pre-wrap break-words text-sm leading-6"
        >
          {block.text}
        </p>
      );
    if (block.type === "reasoning" && typeof block.text === "string")
      return (
        <details key={index} className="text-sm text-fg-3">
          <summary>推理过程</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{block.text}</p>
        </details>
      );
    if (block.type === "tool-call")
      return (
        <p key={index} className="text-sm text-fg-3">
          工具请求：{String(block.name ?? "工具")}
        </p>
      );
    return (
      <p key={index} className="text-xs text-fg-3">
        {block.type === "image" ? "图片内容" : "附加内容"}
      </p>
    );
  });
}

function NativeEvent({ event }: { event: SessionWireEvent }) {
  const data = object(event.data);
  const message = object(data.message);
  const source = object(data.source);
  let label: string;
  let content: unknown;
  switch (event.type) {
    case "turn/start":
      label = `第 ${data.turn} 轮开始`;
      break;
    case "turn/end": {
      const kind = String(object(data.reason).kind ?? "");
      label = `第 ${data.turn} 轮 · ${endReasons[kind] ?? "已结束"}`;
      break;
    }
    case "step/start":
      label = `步骤 ${data.step} 开始`;
      break;
    case "step/end":
      label = `步骤 ${data.step} 结束`;
      break;
    case "user/message":
      label =
        source.kind === "user" || source.kind === "user-rpc"
          ? "你"
          : "上下文已加入";
      if (label === "你") content = data.content;
      break;
    case "assistant/message":
      label = "助手";
      content = message.content;
      break;
    case "assistant/attempt":
      label = "模型尝试已结束，未形成回复";
      break;
    case "tool/call":
      label = `调用工具 · ${String(data.name ?? "工具")}`;
      break;
    case "tool/result":
      label = message.isError ? "工具执行失败" : "工具执行完成";
      break;
    case "system/message":
      label = "系统上下文已更新";
      break;
    case "session/title":
      label = "会话标题已更新";
      break;
    case "session/end-seed":
      label = "历史恢复边界";
      break;
    default:
      label = "其他会话事件";
  }
  return (
    <li
      className="border-b border-border px-4 py-3 last:border-b-0"
      data-event-seq={event.seq}
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <div>
          <span className="text-sm font-medium">{label}</span>
          {typeof data.turn === "number" && !event.type.startsWith("turn/") && (
            <span className="ml-2 text-xs text-fg-3">
              第 {data.turn} 轮
              {typeof data.step === "number" ? ` · 步骤 ${data.step}` : ""}
            </span>
          )}
        </div>
        <span
          className="shrink-0 text-xs tabular-nums text-fg-3"
          title={`事件 ${event.seq}`}
        >
          #{event.seq}
        </span>
      </div>
      {content !== undefined && (
        <div className="space-y-2">
          <Content value={content} />
        </div>
      )}
    </li>
  );
}

/** Read-only experiment: no prompt, resume, tool, or approval operations. */
export function AgentNativeSessionPreview({
  open,
  onOpenChange,
  sessionId,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  title?: string;
}) {
  const native = useAgentNativeSession(open ? sessionId : null);
  const following =
    native.realtime === "live" || native.realtime === "connecting";
  const realtimeLabel = {
    history: "仅历史记录",
    connecting: "正在连接实时记录…",
    live: "实时跟随已提交记录",
    paused: "实时更新已暂停",
    failed: "实时更新未连接",
  }[native.realtime];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle>原生会话预览</DialogTitle>
          <DialogDescription>
            {title || "当前会话"} · 实时跟随已提交记录，暂停后可加载更早历史。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2">
          <span className="text-xs text-fg-3" role="status">
            {native.loading
              ? "正在读取…"
              : `已读取 ${native.events.length} 条记录`}
            {` · ${realtimeLabel}`}
          </span>
          {following && (
            <button
              type="button"
              className="wb-icon-button"
              aria-label="暂停实时更新"
              title="暂停实时更新后可加载更早历史"
              onClick={native.pauseRealtime}
            >
              <Pause size={15} />
            </button>
          )}
          <button
            type="button"
            className="wb-icon-button"
            aria-label="刷新原生会话"
            title="刷新并重新连接原生会话"
            disabled={native.loading || !sessionId}
            onClick={() => void native.refresh()}
          >
            {native.loading ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <RefreshCw size={15} />
            )}
          </button>
        </div>
        <div className="min-h-40 overflow-y-auto overscroll-contain">
          {native.error && (
            <div
              role="alert"
              className="space-y-2 border-b border-border px-5 py-4 text-sm"
            >
              <p>{native.error}</p>
              <button
                type="button"
                className="underline"
                disabled={native.loading}
                onClick={() => void native.refresh()}
              >
                重新连接并读取
              </button>
            </div>
          )}
          {native.hasMore && (
            <div className="border-b border-border p-3 text-center">
              <button
                type="button"
                className="text-sm text-fg-2 underline disabled:opacity-50"
                disabled={native.loading || following}
                onClick={() => void native.loadOlder()}
              >
                加载更早记录
              </button>
              {following && (
                <p className="mt-1 text-xs text-fg-3">
                  暂停实时更新后可加载更早记录。
                </p>
              )}
            </div>
          )}
          {!native.loading && !native.error && !native.events.length && (
            <p className="px-5 py-8 text-sm text-fg-3">
              尚无已提交的会话记录。
            </p>
          )}
          <ol aria-label="原生会话记录">
            {native.events.map((event) => (
              <NativeEvent key={event.seq} event={event} />
            ))}
          </ol>
        </div>
      </DialogContent>
    </Dialog>
  );
}
