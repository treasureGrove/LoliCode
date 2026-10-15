import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { fieldClass } from "@/components/ui/input";
import type { ChannelModel, ChannelSource } from "@/lib/api/channel-center";
import { cn } from "@/lib/utils";
import { channelModelMetadata } from "./channelCenterUtils";

const STANDARD_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function sourceLabel(model: ChannelModel) {
  const source = model.reasoningEffortSource;
  const catalog =
    source === "relay:model-directory"
      ? "渠道模型目录"
      : source === "litellm:model-info"
        ? "LiteLLM 部署声明"
        : source?.startsWith("https://github.com/zai-org/ZCode/")
          ? "ZCode 上游能力目录"
          : model.reasoningEfforts
            ? "上游模型目录"
            : "上游未公布档位";
  const transport = model.reasoningEffortTransport;
  return `${catalog}${transport === "unconfirmed" ? " · 当前路由参数未确认" : transport === "mixed" ? " · 部分路由参数未确认" : ""}`;
}

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
  const native =
    channel.authKind === "claude_subscription" ||
    channel.authKind === "gemini_subscription";
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
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button
          variant="quiet"
          size="compact"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
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
          <div
            className="max-h-96 overflow-y-auto overscroll-contain"
            role="group"
            aria-label={`${safe(channel.name)} 模型列表`}
          >
            {models.map((model) => {
              const title = safe(model.name || model.id);
              const advertised = model.reasoningEfforts;
              const options = [
                ...new Set([
                  ...STANDARD_EFFORTS,
                  ...(advertised ?? []),
                  ...(model.defaultReasoningEffort
                    ? [model.defaultReasoningEffort]
                    : []),
                ]),
              ];
              const knownDefault =
                model.defaultReasoningEffort &&
                advertised?.includes(model.defaultReasoningEffort);
              return (
                <div
                  key={model.id}
                  className={cn(
                    "grid gap-3 border-b border-border px-3 py-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_230px]",
                    !channel.enabled && "opacity-50",
                  )}
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
                  {!native && (
                    <div className="space-y-1">
                      <label className="block text-caption text-fg-2">
                        默认思考强度
                        <select
                          className={cn(fieldClass, "mt-1 h-8 w-full")}
                          aria-label={`${safe(channel.name)} · ${title} 默认思考强度`}
                          value={model.defaultReasoningEffort ?? ""}
                          disabled={disabled || !channel.enabled}
                          onChange={(event) =>
                            update(model.id, {
                              defaultReasoningEffort:
                                event.target.value || undefined,
                            })
                          }
                        >
                          <option value="">default · 服务商默认</option>
                          {options.map((effort) => (
                            <option key={effort} value={effort}>
                              {effort}
                              {advertised?.includes(effort)
                                ? " · 已公布"
                                : " · 手动 / 未验证"}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p
                        className="text-caption text-fg-3"
                        title={
                          model.reasoningEffortSource?.startsWith(
                            "https://github.com/zai-org/ZCode/",
                          )
                            ? model.reasoningEffortSource
                            : undefined
                        }
                      >
                        {sourceLabel(model)}
                      </p>
                      {model.defaultReasoningEffort &&
                        (!knownDefault ||
                          model.reasoningEffortTransport === "unconfirmed" ||
                          model.reasoningEffortTransport === "mixed") && (
                          <p className="text-caption text-fg-3">
                            将尝试使用此设置；当前路由与协议的兼容性尚未验证。
                          </p>
                        )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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
