import { FolderMinus, MoreHorizontal, Pin, PinOff, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Portal positioning keeps workspace actions clear of the scrollable sidebar. */
export function AgentProjectMenu({
  name,
  standalone = false,
  pinned,
  disabled,
  inProjectList,
  onCreateTask,
  onTogglePin,
  onRemove,
}: {
  name: string;
  standalone?: boolean;
  pinned: boolean;
  disabled: boolean;
  inProjectList?: boolean;
  onCreateTask?: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "wb-icon-button wb-project-menu-trigger",
            inProjectList && "wb-project-list-menu",
          )}
          aria-label={`${standalone ? "管理任务" : "管理项目"}：${name}`}
          disabled={disabled}
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
  );
}
