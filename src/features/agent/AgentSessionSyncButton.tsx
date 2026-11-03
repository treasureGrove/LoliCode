import { useRef, useState } from "react";
import { ArrowLeftRight, LoaderCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import { agentApi } from "@/lib/api/agent";
import { IS_DEVELOPMENT_BUILD } from "@/lib/buildChannel";

type Direction = "both" | "import" | "export";
type SyncResult = Awaited<ReturnType<typeof agentApi.syncSessions>>;

export function AgentSessionSyncButton({
  disabled = false,
  onSynced,
}: {
  disabled?: boolean;
  onSynced: () => Promise<void> | void;
}) {
  const peer = IS_DEVELOPMENT_BUILD ? "正式版" : "开发版";
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<Direction>("both");
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  const sync = async () => {
    if (pending.current || disabled) return;
    pending.current = true;
    setSyncing(true);
    setError(null);
    setResult(null);
    try {
      const next = await agentApi.syncSessions(direction);
      setResult(next);
      try {
        await onSynced();
      } catch (cause) {
        setError(`会话已同步，列表刷新未完成：${agentErrorMessage(cause)}`);
      }
    } catch (cause) {
      setError(agentErrorMessage(cause));
    } finally {
      pending.current = false;
      setSyncing(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending.current) return;
        setOpen(next);
        if (next) {
          setResult(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <button type="button" className="wb-nav-button" disabled={disabled}>
          <ArrowLeftRight aria-hidden="true" />
          同步会话
        </button>
      </DialogTrigger>
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (pending.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>同步开发版与正式版会话</DialogTitle>
          <DialogDescription>
            手动同步本机两版的本体会话，包含聊天内容与继续对话所需的上下文。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void sync();
          }}
        >
          <div className="min-h-0 space-y-4 overflow-y-auto px-6">
            <label className="block text-sm text-fg-2">
              同步方向
              <select
                className="mt-2 w-full rounded border border-border bg-surface p-2 text-fg-1"
                value={direction}
                disabled={syncing}
                onChange={(event) => {
                  setDirection(event.target.value as Direction);
                  setResult(null);
                  setError(null);
                }}
              >
                <option value="both">双向同步</option>
                <option value="export">同步到{peer}</option>
                <option value="import">从{peer}同步过来</option>
              </select>
            </label>
            <p className="text-xs leading-relaxed text-fg-3">
              已有会话保留；同一会话内容不同时保留副本。正在运行的会话会跳过，任务结束后可再次同步。
              {peer}
              若已打开，需要退出后重新打开才能显示新会话。旧引擎会话和远程项目会话保留在原处。
            </p>
            {syncing && (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-fg-2"
              >
                <LoaderCircle
                  size={14}
                  className="animate-spin"
                  aria-hidden="true"
                />
                正在同步，请稍候…
              </p>
            )}
            {result && (
              <div
                role="status"
                className="space-y-2 rounded border border-border p-3 text-sm"
              >
                <p className="font-medium">同步完成</p>
                <p>
                  同步过来 {result.imported} 个，同步过去 {result.exported} 个。
                </p>
                <p className="text-xs text-fg-3">
                  已有相同记录 {result.duplicates} 个，保留冲突副本{" "}
                  {result.conflicts} 个， 跳过运行中会话 {result.skippedBusy}{" "}
                  个，跳过不支持的会话 {result.skippedUnsupported} 个。
                </p>
                {result.warnings.map((warning, index) => (
                  <p key={`${index}:${warning}`} className="text-xs text-fg-2">
                    {warning}
                  </p>
                ))}
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-danger-text">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <button
              type="button"
              className="wb-mode-button"
              disabled={syncing}
              onClick={() => setOpen(false)}
            >
              关闭
            </button>
            <button
              type="submit"
              className="wb-primary"
              disabled={syncing || disabled}
            >
              {syncing ? "正在同步…" : result ? "再次同步" : "开始同步"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
