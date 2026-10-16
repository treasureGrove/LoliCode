import { FolderMinus, MoreHorizontal, Pin, PinOff } from "lucide-react";
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
  pinned,
  disabled,
  recent,
  onTogglePin,
  onRemove,
}: {
  name: string;
  pinned: boolean;
  disabled: boolean;
  recent?: boolean;
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
            recent && "wb-recent-project-menu",
          )}
          aria-label={`管理项目：${name}`}
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
        <DropdownMenuItem onSelect={onTogglePin}>
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          {pinned ? "取消置顶" : "置顶项目"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRemove}>
          <FolderMinus size={14} />
          移出项目列表
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-[10px] text-fg-3">
          项目文件与会话保留。
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
