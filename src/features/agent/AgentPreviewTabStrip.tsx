import { useEffect, useRef } from "react";
import { Columns2, Ellipsis, Plus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type PreviewTabLabel = {
  id: string;
  title: string;
  select: () => void;
  close: () => void;
};

export function AgentPreviewTabStrip({
  tabs,
  activeId,
  onOpenBrowser,
  label = "右侧栏标签",
  column,
  onOpenFiles,
  onOpenTerminal,
  onSplit,
  onMerge,
  onMoveActive,
}: {
  tabs: PreviewTabLabel[];
  activeId?: string;
  onOpenBrowser?: () => void;
  label?: string;
  column: number;
  onOpenFiles: () => void;
  onOpenTerminal: () => void;
  onSplit?: () => void;
  onMerge?: () => void;
  onMoveActive?: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <div className="wb-preview-tabs" style={{ gridColumn: column, gridRow: 1 }}>
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        className="wb-preview-tablist"
      >
        {tabs.map(({ id, title, select, close }, index) => {
          const active = activeId === id;
          return (
            <div
              key={id}
              role="presentation"
              className="wb-preview-tab"
              data-selected={active}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  close();
                }
              }}
            >
              <button
                type="button"
                role="tab"
                id={id}
                aria-controls={id + "-panel"}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                title={title}
                onClick={select}
                onKeyDown={(event) => {
                  if (
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.shiftKey ||
                    event.nativeEvent.isComposing
                  )
                    return;
                  const count = tabs.length;
                  const positions: Record<string, number | undefined> = {
                    ArrowLeft: (index + count - 1) % count,
                    ArrowRight: (index + 1) % count,
                    Home: 0,
                    End: count - 1,
                  };
                  const next = positions[event.key];
                  if (next === undefined) return;
                  event.preventDefault();
                  list.current
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next]?.focus();
                }}
              >
                {title}
              </button>
              <button
                type="button"
                aria-label={`关闭标签：${title}`}
                title="关闭标签"
                onClick={close}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      {onOpenBrowser && (
        <button
          type="button"
          aria-label="新建浏览器标签"
          title="新建浏览器标签（Ctrl+T）"
          onClick={onOpenBrowser}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      )}
      {onSplit && (
        <button type="button" aria-label="分屏" title="分屏" onClick={onSplit}>
          <Columns2 size={15} aria-hidden="true" />
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="右栏工具" title="右栏工具">
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onOpenFiles}>项目目录</DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenTerminal}>
            交互终端
          </DropdownMenuItem>
          {onMoveActive && (
            <DropdownMenuItem onSelect={onMoveActive}>
              移到另一分屏
            </DropdownMenuItem>
          )}
          {onMerge && (
            <DropdownMenuItem onSelect={onMerge}>合并分屏</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
