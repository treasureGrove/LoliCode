import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, Layers } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AgentModel } from "@/types/agent";

const DEFAULT_CONTEXT_LIMIT = 1_000_000;
const LOCAL_CONTEXT_BUDGETS = [256_000, 1_000_000];
const validLimit = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const declaredWindows = (model?: AgentModel) =>
  [...new Set(model?.contextLimits || [])]
    .filter(validLimit)
    .sort((a, b) => a - b);
export const agentContextDefaultLimit = (model?: AgentModel) =>
  validLimit(model?.contextLimit)
    ? model.contextLimit
    : (declaredWindows(model)[0] ?? DEFAULT_CONTEXT_LIMIT);
const formatLimit = (value: number) =>
  `${value.toLocaleString("zh-CN")} tokens`;
const compactLimit = (value: number) =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
const formatBytes = (value: number) =>
  value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MiB`
    : value >= 1024
      ? `${(value / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} KiB`
      : `${value.toLocaleString("zh-CN")} 字节`;

/** Declared tiers stay exact; scalar-only models allow bounded local budgets. */
export function AgentContextPicker({
  model,
  value,
  onSelect,
  disabled = false,
}: {
  model?: AgentModel;
  value?: number | null;
  onSelect: (value: number | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const defaultLimit = agentContextDefaultLimit(model);
  const declared = declaredWindows(model);
  const windows = declared.length
    ? declared
    : [
        ...new Set([
          ...LOCAL_CONTEXT_BUDGETS.filter((limit) => limit <= defaultLimit),
          defaultLimit,
        ]),
      ].sort((a, b) => a - b);
  const selectedLimit = validLimit(value) ? value : null;
  const currentLimit = selectedLimit ?? defaultLimit;
  const stale = selectedLimit != null && !windows.includes(selectedLimit);
  const requestLimit = validLimit(model?.maxRequestBytes)
    ? model.maxRequestBytes
    : null;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => setOpen(false), [model?.id]);

  const select = (next: number | null) => {
    if (disabled) return;
    onSelect(next);
    setOpen(false);
  };

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => {
        if (!disabled) setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="上下文窗口"
          aria-controls={contentId}
          disabled={disabled}
          title={`当前上下文：${formatLimit(currentLimit)}`}
          className="wb-picker-trigger inline-flex max-w-[180px] items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Layers size={13} className="shrink-0" aria-hidden="true" />
          <span className="truncate">
            上下文 · {compactLimit(currentLimit)}
          </span>
          <ChevronDown size={13} className="shrink-0" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id={contentId}
        aria-label="选择上下文窗口"
        align="start"
        side="top"
        collisionPadding={12}
        className="flex max-h-[min(520px,var(--radix-popover-content-available-height))] w-[min(340px,calc(100vw-24px))] flex-col gap-3 p-3"
      >
        <div className="shrink-0 text-xs text-fg-2">
          <p>当前上下文：{formatLimit(currentLimit)}</p>
          <p className="mt-1">
            {declared.length
              ? "上游提供的上下文档位"
              : "本地上下文预算，不更改上游模型参数。"}
          </p>
          {!declared.length && !validLimit(model?.contextLimit) && (
            <p className="mt-1">上游未提供上下文信息，默认使用 1M 本地预算。</p>
          )}
        </div>
        <div className="min-h-0 max-h-[min(360px,50vh)] space-y-1 overflow-y-auto">
          <button
            type="button"
            aria-label="使用默认上下文"
            aria-pressed={selectedLimit == null}
            onClick={() => select(null)}
            className="wb-picker-option flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
          >
            <span>默认 · {formatLimit(defaultLimit)}</span>
            {selectedLimit == null && <Check size={14} aria-hidden="true" />}
          </button>
          {windows.map((limit) => (
            <button
              key={limit}
              type="button"
              aria-label={`上下文窗口 ${formatLimit(limit)}`}
              aria-pressed={selectedLimit === limit}
              onClick={() => select(limit)}
              className="wb-picker-option flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
            >
              <span>{formatLimit(limit)}</span>
              {selectedLimit === limit && (
                <Check size={14} aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
        {stale && (
          <p className="shrink-0 text-xs text-fg-2">
            当前保存的 {formatLimit(currentLimit)}{" "}
            已不在当前可选预算中，可选择新窗口或恢复默认。
          </p>
        )}
        {requestLimit != null && (
          <p
            className="shrink-0 border-t pt-2 text-xs text-fg-2"
            title={`${requestLimit.toLocaleString("zh-CN")} 字节`}
          >
            入口请求体上限：{formatBytes(requestLimit)}
            。上下文是本地预算，仍需遵守入口的请求大小限制。
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
