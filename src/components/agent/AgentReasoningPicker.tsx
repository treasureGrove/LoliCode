import { useEffect, useId, useState } from "react";
import { Brain, Check, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AgentModel } from "@/types/agent";

const formatLimit = (value?: number | null) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? `${value.toLocaleString("zh-CN")} tokens`
    : "未知（渠道未提供）";

const TRANSPORT_LABELS = {
  declared: "中转声明支持此参数",
  unconfirmed: "中转尚未声明此参数的兼容性",
  mixed: "存在多路由差异，自动档位取可确认交集",
} as const;

export function AgentReasoningPicker({
  model,
  value,
  onSelect,
  disabled = false,
}: {
  model?: AgentModel;
  value: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const contentId = useId();
  const helpId = useId();
  const declared = Array.isArray(model?.reasoningEfforts);
  const efforts = [...new Set(model?.reasoningEfforts || [])].filter(Boolean);
  const configuredDefault = model?.defaultReasoningEffort;
  const defaultEffort = configuredDefault || efforts[0];
  const validDraft = !draft || /^[A-Za-z0-9_-]{1,64}$/.test(draft);
  const supportedValue = !value || efforts.includes(value);

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
        if (next) setDraft(value);
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
                ? `模型默认：${defaultEffort}，未设置会话覆盖`
                : defaultEffort
                  ? `自动档位：${defaultEffort}（支持列表首项）`
                  : "上游默认：使用模型服务的默认设置"
          }
          className="wb-picker-trigger inline-flex max-w-[180px] items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Brain size={13} className="shrink-0" aria-hidden="true" />
          <span className="truncate">
            {value
              ? declared
                ? value
                : `${value}（手动）`
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
        className="wb-reasoning-picker-content w-[min(340px,calc(100vw-24px))] space-y-3 p-3"
      >
        <dl className="wb-picker-metadata grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-fg-2">上下文窗口</dt>
          <dd>{formatLimit(model?.contextLimit)}</dd>
          <dt className="text-fg-2">最大输出</dt>
          <dd>{formatLimit(model?.outputLimit)}</dd>
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
          <div className="space-y-2 border-t pt-3">
            <label className="block text-sm">
              手动档位标识（未验证）
              <input
                type="text"
                value={draft}
                aria-describedby={helpId}
                aria-invalid={!validDraft}
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
                className="mt-1 block w-full rounded border bg-transparent px-2 py-1.5 text-sm"
              />
            </label>
            <p id={helpId} className="text-xs text-fg-2">
              渠道未声明可用档位。请按中转服务文档填写，手动值未经验证；允许
              1–64 位英文字母、数字、下划线或连字符。
              {configuredDefault
                ? `留空继承模型默认（${defaultEffort}）。`
                : defaultEffort
                  ? `留空使用自动档位（${defaultEffort}）。`
                  : "留空使用上游默认。"}
            </p>
            <button
              type="button"
              disabled={!validDraft || disabled}
              onClick={() => select(draft)}
              className="rounded border px-3 py-1.5 text-sm disabled:cursor-default disabled:opacity-50"
            >
              应用手动档位
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
