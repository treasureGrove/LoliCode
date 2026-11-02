import { useId, useRef, type ReactNode } from "react";
import {
  Blocks,
  FileText,
  ImagePlus,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AgentSession } from "@/types/agent";

export function AgentComposerAdd({
  attachmentsDisabled,
  onAddImages,
  onAddDocuments,
  onAddPlugins,
}: {
  attachmentsDisabled: boolean;
  onAddImages: () => void;
  onAddDocuments: () => void;
  onAddPlugins: () => void;
}) {
  const openingPanel = useRef(false);
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) openingPanel.current = false;
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="wb-composer-add"
          aria-label="添加内容"
          title="添加图片、文档或插件"
        >
          <Plus size={20} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        onCloseAutoFocus={(event) => {
          // The tool panel takes focus as it opens; closing this menu must not
          // return focus to its now-inert trigger behind the panel.
          if (openingPanel.current) event.preventDefault();
        }}
      >
        <DropdownMenuItem
          title="也可以粘贴截图或拖入图片"
          disabled={attachmentsDisabled}
          onSelect={onAddImages}
        >
          <ImagePlus size={20} aria-hidden="true" />
          添加图片
        </DropdownMenuItem>
        <DropdownMenuItem
          title="添加 Word、PowerPoint、Excel、PDF 或文本文件；也可以直接拖入"
          disabled={attachmentsDisabled}
          onSelect={onAddDocuments}
        >
          <FileText size={20} aria-hidden="true" />
          添加文档
        </DropdownMenuItem>
        <DropdownMenuItem
          title="打开插件市场；安装后可将技能添加到当前会话"
          onSelect={() => {
            openingPanel.current = true;
            onAddPlugins();
          }}
        >
          <Blocks size={20} aria-hidden="true" />
          添加插件
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AgentComposerOptions({
  permissionMode,
  children,
}: {
  permissionMode: NonNullable<AgentSession["permissionMode"]>;
  children: ReactNode;
}) {
  const titleId = useId();
  const permissionLabel =
    permissionMode === "ask"
      ? "逐次确认"
      : permissionMode === "auto"
        ? "Auto Mode"
        : permissionMode === "full_access"
          ? "完整权限"
          : "自定义权限";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="wb-composer-options-trigger"
          aria-label="对话设置"
          title={`对话设置 · ${permissionLabel}`}
          data-permission-mode={permissionMode}
        >
          <SlidersHorizontal size={20} aria-hidden="true" />
          <span>{permissionLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-labelledby={titleId}
        align="start"
        side="top"
        collisionPadding={12}
        className="wb-composer-options-popover max-h-[var(--radix-popover-content-available-height)] w-[min(320px,calc(100vw-24px))] overflow-y-auto"
      >
        <h2 id={titleId}>对话设置</h2>
        {children}
      </PopoverContent>
    </Popover>
  );
}
