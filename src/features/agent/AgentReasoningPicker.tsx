import { useEffect, useId, useState } from "react";
import { Brain, Check, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AgentModel } from "@/types/agent";
import { agentContextDefaultLimit } from "./AgentContextPicker";

const formatLimit = (value?: number | null) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? `${value.toLocaleString("zh-CN")} tokens`
    : "未知（渠道未提供）";

const TRANSPORT_LABELS = {
  declared: "中转声明支持此参数",
  unconfirmed: "中转尚未声明此参数的兼容性",
  mixed: "存在多路由差异，自动档位取可确认交集",
} as const;

// A missing catalog enum still permits an explicit session override. These are
// common choices, not a capability declaration or an automatic default.
const COMMON_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function AgentReasoningPicker({
  model,
  value,
  onSelect,
  contextValue,
  disabled = false,
}: {
  model?: AgentModel;
  value: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
  contextValue?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const declared = Array.isArray(model?.reasoningEfforts);
  const declaredEfforts = [...new Set(model?.reasoningEfforts || [])].filter(
    Boolean,
  );
  const efforts = declared ? declaredEfforts : COMMON_REASONING_EFFORTS;
  const configuredDefault = model?.defaultReasoningEffort;
  const defaultEffort =
    configuredDefault ||
    ["medium", "high"].find((effort) => declaredEfforts.includes(effort)) ||
    declaredEfforts[0];
  const supportedValue = !value || efforts.includes(value);
  const hasOutputLimit =
    typeof model?.outputLimit === "number" &&
    Number.isFinite(model.outputLimit) &&
    model.outputLimit > 0;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => setOpen(false), [model?.id]);

  const select = (next: string) => {
    if (disabled) return;
    onSelect(next);
    setOpen(false);
  };

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => {
        if (next && disabled) return;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="思考档位"
          aria-controls={contentId}
          disabled={disabled}
          title={
            value
              ? `思考档位：${value}`
              : configuredDefault
                ? `思考档位：模型默认 ${defaultEffort}，未设置会话覆盖`
                : defaultEffort
                  ? `思考档位：自动 ${defaultEffort}（优先 medium，其次 high）`
                  : "思考档位：使用上游默认设置"
          }
          className="wb-picker-trigger inline-flex max-w-[180px] items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Brain size={13} className="shrink-0" aria-hidden="true" />
          <span className="truncate">
            思考 ·{" "}
            {value
              ? value
              : configuredDefault
                ? `模型默认 · ${defaultEffort}`
                : defaultEffort
                  ? `自动档位 · ${defaultEffort}`
                  : "上游默认"}
          </span>
          <ChevronDown size={13} className="shrink-0" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id={contentId}
        aria-label="选择思考档位"
        align="start"
        side="top"
        collisionPadding={12}
        className="wb-reasoning-picker-content max-h-[var(--radix-popover-content-available-height)] w-[min(340px,calc(100vw-24px))] space-y-3 overflow-y-auto p-3"
      >
        <dl className="wb-picker-metadata grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-fg-2">上下文窗口</dt>
          <dd>
            {formatLimit(contextValue ?? agentContextDefaultLimit(model))}
          </dd>
          <dt className="text-fg-2">模型输出上限</dt>
          <dd>{hasOutputLimit ? formatLimit(model?.outputLimit) : "未声明"}</dd>
          {model?.reasoningEffortSource && (
            <>
              <dt className="text-fg-2">档位来源</dt>
              <dd className="min-w-0 break-all">
                {model.reasoningEffortSource}
              </dd>
            </>
          )}
          {model?.reasoningEffortTransport && (
            <>
              <dt className="text-fg-2">参数兼容</dt>
              <dd>{TRANSPORT_LABELS[model.reasoningEffortTransport]}</dd>
            </>
          )}
        </dl>
        <p className="text-xs text-fg-2">
          每轮输出根据模型上限和剩余上下文自动分配。
          {!hasOutputLimit && "模型上限未声明，本地自动基准为 32K tokens。"}
        </p>
        <div className="space-y-1 border-t pt-2">
          <button
            type="button"
            aria-label={
              configuredDefault
                ? "使用模型默认"
                : defaultEffort
                  ? "使用自动档位"
                  : "使用上游默认"
            }
            aria-pressed={!value}
            className="wb-picker-option flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
            onClick={() => select("")}
          >
            <span>
              {configuredDefault
                ? `模型默认（${defaultEffort}）`
                : defaultEffort
                  ? `自动档位（${defaultEffort}）`
                  : "上游默认"}
            </span>
            {!value && <Check size={14} aria-hidden="true" />}
          </button>
          {efforts.map((effort) => (
            <button
              key={effort}
              type="button"
              aria-label={`思考档位 ${effort}`}
              aria-pressed={value === effort}
              title={effort}
              className="wb-picker-option flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
              onClick={() => select(effort)}
            >
              <span className="min-w-0 truncate">{effort}</span>
              {value === effort && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
        {declared && !efforts.length && (
          <p className="text-xs text-fg-2">当前模型已声明没有可选思考档位。</p>
        )}
        {declared && !supportedValue && (
          <p className="break-all text-xs text-fg-2">
            当前保存的档位 {value} 未在此模型目录中声明，可以恢复上游默认。
          </p>
        )}
        {!declared && (
          <p className="text-xs text-fg-2">
            渠道未提供档位列表，以上为常用档位，实际支持以当前模型和渠道为准。
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
