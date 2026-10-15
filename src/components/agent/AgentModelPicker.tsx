import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, Search, Sparkles } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AgentModel } from "@/types/agent";

export const agentModelLabel = (model: AgentModel) =>
  !model.channelName || model.name.startsWith(`${model.channelName} · `)
    ? model.name
    : `${model.channelName} · ${model.name}`;

export function AgentModelPicker({
  models,
  value,
  onSelect,
  disabled = false,
  unavailableLabel,
  className = "",
}: {
  models: AgentModel[];
  value: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
  unavailableLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const contentId = useId();
  useEffect(() => {
    if (disabled || !models.length) setOpen(false);
  }, [disabled, models.length]);
  const selected = models.find((model) => model.id === value);
  const groupKey = (model: AgentModel) =>
    JSON.stringify([model.providerId, model.channelName]);
  const needle = query.trim().toLocaleLowerCase();
  const groups = new Map<string, { label: string; models: AgentModel[] }>();
  for (const model of models) {
    if (
      needle &&
      ![model.name, model.modelId, model.channelName, model.providerId].some(
        (text) => text.toLocaleLowerCase().includes(needle),
      )
    )
      continue;
    const key = groupKey(model);
    const group = groups.get(key) || {
      label: model.channelName || model.providerId,
      models: [],
    };
    group.models.push(model);
    groups.set(key, group);
  }

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setExpanded({});
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="模型"
          aria-controls={contentId}
          disabled={disabled || !models.length}
          title={selected ? agentModelLabel(selected) : unavailableLabel}
          className={`inline-flex max-w-[280px] items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-black/5 dark:hover:bg-white/5 ${className}`}
        >
          <Sparkles size={13} className="shrink-0" aria-hidden="true" />
          <span className="truncate">
            {selected
              ? agentModelLabel(selected)
              : unavailableLabel || "还没有可用模型"}
          </span>
          <ChevronDown size={13} className="shrink-0" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id={contentId}
        aria-label="选择模型"
        align="start"
        side="top"
        collisionPadding={12}
        className="w-[min(360px,calc(100vw-24px))] p-0"
      >
        <label className="flex items-center gap-2 border-b px-3 py-2">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="搜索模型或渠道"
            type="search"
            placeholder="搜索模型或渠道…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setExpanded({});
            }}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {!groups.size && (
            <p role="status" className="px-3 py-5 text-sm text-fg-2">
              没有匹配的模型
            </p>
          )}
          {[...groups].map(([key, group], index) => {
            const isExpanded =
              expanded[key] ??
              Boolean(needle || (selected && groupKey(selected) === key));
            const groupId = `${contentId}-group-${index}`;
            return (
              <div key={key}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
                  aria-expanded={isExpanded}
                  aria-controls={groupId}
                  aria-label={`${group.label} 模型`}
                  onClick={() =>
                    setExpanded((old) => ({ ...old, [key]: !isExpanded }))
                  }
                >
                  <ChevronDown
                    size={14}
                    className={isExpanded ? "shrink-0" : "-rotate-90 shrink-0"}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  <span className="text-xs text-fg-2">
                    {group.models.length}
                  </span>
                </button>
                <div id={groupId} hidden={!isExpanded}>
                  {isExpanded &&
                    group.models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        aria-label={agentModelLabel(model)}
                        aria-pressed={model.id === value}
                        className="flex w-full items-center gap-2 rounded py-2 pl-7 pr-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
                        onClick={() => {
                          onSelect(model.id);
                          setOpen(false);
                        }}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{model.name}</span>
                          {model.name !== model.modelId && (
                            <span className="block truncate text-xs text-fg-2">
                              {model.modelId}
                            </span>
                          )}
                        </span>
                        {model.id === value && (
                          <Check
                            size={14}
                            className="shrink-0"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
