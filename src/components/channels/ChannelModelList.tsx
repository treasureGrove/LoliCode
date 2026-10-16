import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { motionTokens } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { ChannelModel, ChannelSource } from "@/lib/api/channel-center";
import { cn } from "@/lib/utils";
import { channelModelMetadata } from "./channelCenterUtils";

export function ChannelModelList({
  channel,
  models,
  disabled,
  collapsed,
  onToggle,
  onModelsChange,
}: {
  channel: ChannelSource;
  models: ChannelModel[];
  disabled: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onModelsChange: (models: ChannelModel[]) => void;
}) {
  const reducedMotion = useReducedMotion();
  const safe = (value: string) =>
    channel.apiKey ? value.split(channel.apiKey).join("[已隐藏]") : value;
  const update = (id: string, patch: Partial<ChannelModel>) =>
    onModelsChange(
      channel.models.map((model) =>
        model.id === id ? { ...model, ...patch } : model,
      ),
    );
  return (
    <div>
      <div className="lolicode-model-toolbar flex flex-wrap items-center gap-2">
        <Button
          variant="quiet"
          size="compact"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <ChevronDown
            className={cn(
              "lolicode-channel-chevron h-3.5 w-3.5",
              collapsed && "-rotate-90",
            )}
          />
          {collapsed ? "展开" : "收起"} {safe(channel.name)} 模型
        </Button>
        <span className="text-caption text-fg-3">{models.length} 个匹配</span>
        <div className="ml-auto flex flex-wrap gap-1">
          <Button
            size="compact"
            variant="quiet"
            disabled={disabled || !channel.enabled}
            onClick={() =>
              onModelsChange(
                channel.models.map((model) => ({
                  ...model,
                  enabled: model.supportsTools !== false,
                })),
              )
            }
          >
            全选
          </Button>
          <Button
            size="compact"
            variant="quiet"
            disabled={disabled || !channel.enabled}
            onClick={() =>
              onModelsChange(
                channel.models.map((model) => ({ ...model, enabled: false })),
              )
            }
          >
            全不选
          </Button>
          <Button
            size="compact"
            variant="quiet"
            disabled={disabled || !channel.enabled}
            title="选择上游明确支持工具调用的模型；未知能力仍可手动选择"
            onClick={() =>
              onModelsChange(
                channel.models.map((model) => ({
                  ...model,
                  enabled: model.supportsTools === true,
                })),
              )
            }
          >
            适合 Agent
          </Button>
        </div>
      </div>
      {!collapsed &&
        (models.length ? (
          <motion.div
            initial={reducedMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: motionTokens.duration.page,
              ease: motionTokens.ease,
            }}
            className="lolicode-model-list"
            role="group"
            aria-label={`${safe(channel.name)} 模型列表`}
          >
            {models.map((model) => {
              const title = safe(model.name || model.id);
              return (
                <div
                  key={model.id}
                  className={cn(
                    "lolicode-model-row border-b border-border last:border-0",
                    !channel.enabled && "opacity-50",
                  )}
                  data-selected={
                    channel.enabled &&
                    model.enabled !== false &&
                    model.supportsTools !== false
                  }
                >
                  <label className="flex min-w-0 items-start gap-2.5 text-body">
                    <Checkbox
                      className="mt-0.5"
                      aria-label={`${safe(channel.name)} · ${title}`}
                      checked={
                        model.enabled !== false && model.supportsTools !== false
                      }
                      disabled={
                        disabled ||
                        !channel.enabled ||
                        model.supportsTools === false
                      }
                      onCheckedChange={(enabled) =>
                        update(model.id, { enabled })
                      }
                    />
                    <span className="min-w-0">
                      <span className="block break-words text-fg-1">
                        {title}
                      </span>
                      <span className="mt-0.5 block break-words text-caption text-fg-3">
                        {model.name && model.name !== model.id
                          ? `${safe(model.id)} · `
                          : ""}
                        {safe(channelModelMetadata(channel, model))}
                      </span>
                    </span>
                  </label>
                </div>
              );
            })}
          </motion.div>
        ) : (
          <p className="px-3 py-4 text-caption text-fg-3">
            {channel.models.length
              ? "没有匹配的模型。"
              : "没有可用模型，请检查账号权限或刷新重试。"}
          </p>
        ))}
    </div>
  );
}
