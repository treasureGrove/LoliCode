import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Search,
  Settings2,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AgentModel } from "@/types/agent";
import { FreeModelBadge } from "@/components/ui/free-model-badge";

const humanLabel = (value: string) =>
  value
    .replace(
      /\b(?:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|[a-f\d]{24,})\b/gi,
      "",
    )
    .replace(/^[\s·:/_-]+|[\s·:/_-]+$/g, "")
    .trim();
const modelName = (model: AgentModel) => humanLabel(model.name) || "未命名模型";
export const agentModelLabel = (model: AgentModel) => {
  const channel = humanLabel(model.channelName);
  const name = modelName(model);
  const label =
    channel && !name.startsWith(`${channel} · `)
      ? `${channel} · ${name}`
      : name;
  return model.isFree ? `${label} · free` : label;
};

export function AgentModelPicker({
  models,
  value,
  onSelect,
  disabled = false,
  unavailableLabel,
  className = "",
  onOpenChannels,
  onRefresh,
  refreshDisabled = false,
  notice,
  excludedSources = [],
}: {
  models: AgentModel[];
  value: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
  unavailableLabel?: string;
  className?: string;
  onOpenChannels?: () => void;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
  notice?: string;
  excludedSources?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const contentId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const selected = models.find((model) => model.id === value);
  const groupKey = (model: AgentModel) =>
    JSON.stringify([model.providerId, model.channelName]);
  const needle = query.trim().toLocaleLowerCase();
  const groups = new Map<string, { label: string; models: AgentModel[] }>();
  for (const model of models) {
    if (
      needle &&
      ![
        modelName(model),
        humanLabel(model.channelName),
        model.modelId,
        model.isFree ? "free" : "",
      ].some((text) => text.toLocaleLowerCase().includes(needle))
    )
      continue;
    const key = groupKey(model);
    const group = groups.get(key) || {
      label: humanLabel(model.channelName) || "模型渠道",
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
          aria-label={selected?.isFree ? "模型，free" : "模型"}
          aria-controls={contentId}
          disabled={disabled}
          title={selected ? agentModelLabel(selected) : unavailableLabel}
          className={`wb-picker-trigger inline-flex max-w-[280px] items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-black/5 dark:hover:bg-white/5 ${className}`}
        >
          <Sparkles size={13} className="shrink-0" aria-hidden="true" />
          <span className="truncate">
            {selected
              ? modelName(selected)
              : unavailableLabel || "还没有可用模型"}
          </span>
          {selected?.isFree && <FreeModelBadge />}
          <ChevronDown size={13} className="shrink-0" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id={contentId}
        aria-label="选择模型"
        align="start"
        side="top"
        collisionPadding={12}
        className="wb-model-picker-content w-[min(360px,calc(100vw-24px))] p-0"
      >
        <label className="wb-picker-search flex items-center gap-2 border-b px-3 py-2">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label="搜索模型或渠道"
            type="search"
            placeholder="搜索模型或渠道…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setExpanded({});
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const buttons =
                  listRef.current?.querySelectorAll<HTMLButtonElement>(
                    "button[data-picker-item]",
                  );
                const target =
                  event.key === "ArrowDown"
                    ? buttons?.[0]
                    : buttons?.[buttons.length - 1];
                if (target) {
                  event.preventDefault();
                  target.focus();
                }
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
        <div
          ref={listRef}
          className="max-h-80 overflow-y-auto p-1.5"
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
            )
              return;
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button[data-picker-item]",
              ),
            );
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            event.preventDefault();
            if (event.key === "ArrowUp" && index === 0) {
              searchRef.current?.focus();
              return;
            }
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : Math.min(
                      buttons.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    );
            buttons[next]?.focus();
          }}
        >
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
                  data-picker-item=""
                  title={group.label}
                  className="wb-picker-group flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
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
                        data-picker-item=""
                        aria-label={agentModelLabel(model)}
                        aria-pressed={model.id === value}
                        title={agentModelLabel(model)}
                        className="wb-picker-option flex w-full items-center gap-2 rounded py-2 pl-7 pr-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
                        onClick={() => {
                          onSelect(model.id);
                          setOpen(false);
                        }}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{modelName(model)}</span>
                            {model.isFree && <FreeModelBadge />}
                          </span>
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
        <div className="wb-picker-actions space-y-1 border-t p-1.5">
          {notice && <p className="px-2 py-1 text-xs text-fg-2">{notice}</p>}
          {onRefresh && (
            <button
              type="button"
              aria-label="刷新可用模型"
              disabled={refreshDisabled}
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm disabled:opacity-50"
              onClick={() => onRefresh()}
            >
              <RefreshCw size={14} />
              刷新模型目录
            </button>
          )}
          {onOpenChannels && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
              onClick={() => {
                setOpen(false);
                onOpenChannels();
              }}
            >
              <Settings2 size={14} />
              管理和添加模型与渠道
            </button>
          )}
          {excludedSources.length > 0 && (
            <details className="px-2 text-xs text-fg-2">
              <summary>部分渠道在工作台中不可用</summary>
              <ul>
                {excludedSources.map((reason, index) => (
                  <li key={index}>{humanLabel(reason)}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
