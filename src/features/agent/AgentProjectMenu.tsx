import { useRef, useState } from "react";
import {
  FolderMinus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";

/** Portal positioning keeps workspace actions clear of the scrollable sidebar. */
export function AgentProjectMenu({
  name,
  standalone = false,
  pinned,
  disabled,
  inProjectList,
  onCreateTask,
  onRename,
  onTogglePin,
  onRemove,
}: {
  name: string;
  standalone?: boolean;
  pinned: boolean;
  disabled: boolean;
  inProjectList?: boolean;
  onCreateTask?: () => void;
  onRename?: (name: string) => Promise<void>;
  onTogglePin: () => void;
  onRemove: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nextName, setNextName] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const saveName = async () => {
    if (!onRename || pending.current) return;
    const value = nextName.trim();
    if (!value) {
      setError("请填写项目名称");
      return;
    }
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      await onRename(value);
      setRenaming(false);
    } catch (cause) {
      setError(agentErrorMessage(cause));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "wb-icon-button wb-project-menu-trigger",
              inProjectList && "wb-project-list-menu",
            )}
            aria-label={`${standalone ? "管理任务" : "管理项目"}：${name}`}
            disabled={disabled || saving}
          >
            <MoreHorizontal size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="w-48">
          <DropdownMenuLabel className="truncate text-xs">
            {name}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {onCreateTask && (
            <DropdownMenuItem onSelect={onCreateTask}>
              <Plus size={14} />
              {standalone ? "新建独立任务" : "在此项目中新建任务"}
            </DropdownMenuItem>
          )}
          {onRename && (
            <DropdownMenuItem
              onSelect={() => {
                setNextName(name);
                setError(null);
                setRenaming(true);
              }}
            >
              <Pencil size={14} />
              重命名项目
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onTogglePin}>
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {pinned ? "取消置顶" : standalone ? "置顶任务" : "置顶项目"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onRemove}>
            <FolderMinus size={14} />
            {standalone ? "隐藏独立任务列表" : "移出项目列表"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-[10px] text-fg-3">
            {standalone
              ? "任务文件与会话保留，重新新建独立任务即可恢复。"
              : "项目文件与会话保留。"}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={renaming}
        onOpenChange={(open) => {
          if (!saving) setRenaming(open);
        }}
      >
        <DialogContent
          className="wb-extensions p-5"
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>重命名项目</DialogTitle>
            <DialogDescription>
              修改工作台中的显示名称，项目文件夹与会话保留。
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveName();
            }}
          >
            <label className="text-caption">
              项目名称
              <input
                aria-label="项目名称"
                className="mt-2 w-full rounded border border-border bg-surface p-2 text-body"
                value={nextName}
                maxLength={128}
                disabled={saving}
                onChange={(event) => setNextName(event.target.value)}
                autoFocus
              />
            </label>
            {error && (
              <p role="alert" className="mt-2 text-caption text-danger-text">
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="wb-mode-button"
                type="button"
                disabled={saving}
                onClick={() => setRenaming(false)}
              >
                取消
              </button>
              <button
                className="wb-primary"
                type="submit"
                disabled={saving || !nextName.trim()}
              >
                {saving ? "正在保存…" : "保存名称"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
