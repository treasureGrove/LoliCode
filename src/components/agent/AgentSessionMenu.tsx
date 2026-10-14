import { useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import type { AgentSession } from "@/types/agent";

export function AgentSessionMenu({
  session,
  disabled,
  active,
  onRename,
  onPin,
  onArchive,
  onDelete,
}: {
  session: AgentSession;
  disabled: boolean;
  active: boolean;
  onRename: (title: string) => Promise<void>;
  onPin: () => Promise<void>;
  onArchive: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
      setDialog(null);
    } catch (cause) {
      setError(agentErrorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="wb-icon-button wb-session-menu"
            disabled={disabled || busy}
            aria-label={`管理会话：${session.title}`}
          >
            <MoreHorizontal />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setTitle(session.title);
              setError(null);
              setDialog("rename");
            }}
          >
            <Pencil size={14} />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void run(onPin)}>
            {session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {session.pinned ? "取消置顶" : "置顶会话"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={active}
            onSelect={() => void run(onArchive)}
          >
            {session.archived ? (
              <ArchiveRestore size={14} />
            ) : (
              <Archive size={14} />
            )}
            {session.archived ? "恢复会话" : "归档会话"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={active}
            onSelect={() => {
              setError(null);
              setDialog("delete");
            }}
          >
            <Trash2 size={14} />
            删除会话
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && !dialog && (
        <p role="alert" className="wb-sidebar-note text-danger-text">
          {error}
        </p>
      )}
      <Dialog
        open={Boolean(dialog)}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <DialogContent
          className="wb-extensions p-5"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {dialog === "rename" ? "重命名会话" : "删除会话"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "rename"
                ? "给这次任务一个容易找到的名字。"
                : `删除“${session.title}”的会话记录。项目文件会保留。`}
            </DialogDescription>
          </DialogHeader>
          {dialog === "rename" && (
            <input
              aria-label="会话名称"
              className="rounded border border-border bg-surface p-2"
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
            />
          )}
          {error && (
            <p role="alert" className="text-caption text-danger-text">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              className="wb-mode-button"
              disabled={busy}
              onClick={() => setDialog(null)}
            >
              取消
            </button>
            <button
              className="wb-primary"
              disabled={busy || (dialog === "rename" && !title.trim())}
              onClick={() =>
                void run(
                  dialog === "rename" ? () => onRename(title.trim()) : onDelete,
                )
              }
            >
              {busy
                ? "正在保存…"
                : dialog === "rename"
                  ? "保存名称"
                  : "确认删除"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
