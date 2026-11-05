import { useId } from "react";
import {
  CornerDownRight,
  ListEnd,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Pause,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentQueuedMessage } from "@/types/agent";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import "./agent-message-queue.css";

export interface AgentMessageQueueProps {
  items: (AgentQueuedMessage & { confirming?: boolean })[];
  busyId?: string | null;
  disabled?: boolean;
  paused?: boolean;
  canSteer?: boolean;
  onSendNow: (id: string) => void;
  onRecall: (id: string) => void;
  onRemove: (id: string) => void;
}

/** Pending messages stay separate from the transcript until submitted. */
export function AgentMessageQueue({
  items,
  busyId,
  disabled = false,
  paused = false,
  canSteer = false,
  onSendNow,
  onRecall,
  onRemove,
}: AgentMessageQueueProps) {
  const hintId = useId();
  if (!items.length) return null;
  const action = canSteer ? "插入当前任务" : "立即发送";
  return (
    <section
      className="wb-message-queue"
      aria-label="待发送消息"
      aria-describedby={hintId}
    >
      <header className="sr-only">
        <h3>待发送 · {items.length}</h3>
        <p id={hintId} role="status">
          {paused
            ? "队列已暂停，可立即发送或撤回编辑"
            : "当前回复结束后依次发送"}
        </p>
      </header>
      {paused && (
        <div className="wb-message-queue-paused" aria-hidden="true">
          <Pause size={12} /> 队列已暂停
        </div>
      )}
      <ol className="wb-message-queue-list" aria-label="待发送消息列表">
        {items.map((item, index) => {
          const ordinal = index + 1;
          const sending = busyId === item.id;
          const confirming = item.confirming;
          const actionsDisabled = disabled || busyId != null || confirming;
          const attachments = item.attachments || [];
          const attachmentNames = attachments
            .map((attachment) => attachment.fileName)
            .join("、");
          return (
            <li
              key={item.id}
              className="wb-message-queue-item"
              aria-busy={sending || confirming || undefined}
            >
              <ListEnd
                className="wb-message-queue-icon"
                size={16}
                aria-hidden="true"
              />
              <div
                className="wb-message-queue-content"
                title={item.text.trim() || attachmentNames}
              >
                <p className="wb-message-queue-text">
                  {item.text.trim() || "仅附件消息"}
                </p>
                {attachments.length > 0 && (
                  <p
                    className="wb-message-queue-attachments"
                    title={attachmentNames}
                    aria-label={`${attachments.length} 个附件 · ${attachmentNames}`}
                  >
                    <Paperclip size={12} aria-hidden="true" />
                    <span aria-hidden="true">{attachments.length}</span>
                    <span className="sr-only">
                      {attachments.length} 个附件 · {attachmentNames}
                    </span>
                  </p>
                )}
              </div>
              <div className="wb-message-queue-actions">
                <Button
                  type="button"
                  variant="quiet"
                  size="compact"
                  className="wb-message-queue-send"
                  disabled={actionsDisabled}
                  aria-label={`${confirming ? "正在加入队列的" : sending ? "正在发送" : action}第 ${ordinal} 条消息`}
                  title={
                    confirming
                      ? "等待队列确认"
                      : canSteer
                        ? "在当前任务的下一步加入这条消息"
                        : "立即发送这条消息"
                  }
                  onClick={() => onSendNow(item.id)}
                >
                  {sending || confirming ? (
                    <Loader2
                      size={13}
                      className="motion-safe:animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <CornerDownRight size={15} aria-hidden="true" />
                  )}
                  {confirming ? "正在加入队列" : sending ? "发送中" : action}
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-compact"
                  className="wb-message-queue-delete"
                  disabled={actionsDisabled}
                  aria-label={`删除第 ${ordinal} 条消息`}
                  title="删除这条待发送消息"
                  onClick={() => onRemove(item.id)}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="quiet"
                      size="icon-compact"
                      disabled={actionsDisabled}
                      aria-label={`第 ${ordinal} 条消息的更多操作`}
                      title="更多操作"
                    >
                      <MoreHorizontal size={17} aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="top"
                    align="end"
                    className="wb-message-queue-menu"
                  >
                    <DropdownMenuLabel className="wb-message-queue-detail">
                      <p>{item.text.trim() || "仅附件消息"}</p>
                      {attachments.length > 0 && (
                        <small>{attachmentNames}</small>
                      )}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={actionsDisabled}
                      aria-label={`撤回编辑第 ${ordinal} 条消息`}
                      onSelect={() => onRecall(item.id)}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      撤回编辑
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
