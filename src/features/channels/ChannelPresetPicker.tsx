import { useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { motionTokens } from "@/lib/motion";
import { ProviderIconBox } from "@/components/ProviderIconBox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ACCOUNT_CHANNEL_PRESETS,
  CHANNEL_PRESETS,
  COMMON_CHANNEL_PRESETS,
} from "./channelPresets";

interface ChannelPresetPickerProps {
  value: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
}

export function ChannelPresetPicker({
  value,
  disabled,
  onValueChange,
}: ChannelPresetPickerProps) {
  const reducedMotion = useReducedMotion();
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState("");
  const primaryPresets = COMMON_CHANNEL_PRESETS.slice(0, 4);
  const primaryPresetIds = new Set(primaryPresets.map((preset) => preset.id));
  const additionalPresets = CHANNEL_PRESETS.filter(
    (preset) => !primaryPresetIds.has(preset.id),
  ).filter((preset) =>
    `${preset.name} ${"baseUrl" in preset ? preset.baseUrl : ""}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const visiblePresets = [...ACCOUNT_CHANNEL_PRESETS, ...primaryPresets];
  return (
    <div className="lolicode-channel-picker space-y-3">
      <div
        role="group"
        aria-label="添加渠道方式"
        className="lolicode-channel-preset-grid"
      >
        {visiblePresets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={value === preset.id}
            aria-label={preset.name}
            disabled={disabled}
            onClick={() => onValueChange(preset.id)}
            className={cn(
              "lolicode-channel-card flex min-w-0 items-center gap-2.5 border text-left text-body text-fg-1 disabled:opacity-50",
              value === preset.id
                ? "border-ring bg-subtle"
                : "border-border bg-surface",
            )}
          >
            <ProviderIconBox icon={preset.icon} name={preset.name} />
            <span className="min-w-0 leading-snug">
              <span className="block font-medium">
                {preset.name.split(" · ")[0]}
              </span>
              {preset.name.includes(" · ") && (
                <span className="mt-0.5 block text-[10px] text-fg-3">
                  {preset.name.split(" · ").slice(1).join(" · ")}
                </span>
              )}
            </span>
            {value === preset.id && (
              <Check
                className="lolicode-channel-preset-check"
                aria-hidden="true"
              />
            )}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="neutral"
          size="compact"
          disabled={disabled}
          onClick={() => setMore(!more)}
          aria-expanded={more}
          aria-controls="channel-additional-presets"
        >
          <ChevronDown
            className={cn(
              "lolicode-channel-chevron h-3.5 w-3.5",
              more && "rotate-180",
            )}
          />
          {more
            ? "收起更多服务"
            : `展开更多服务（${CHANNEL_PRESETS.length - primaryPresets.length}）`}
        </Button>
        <Button
          type="button"
          variant={value === "custom" ? "neutral" : "quiet"}
          size="compact"
          aria-pressed={value === "custom"}
          disabled={disabled}
          onClick={() => onValueChange("custom")}
        >
          自定义渠道
        </Button>
      </div>
      {more && (
        <motion.div
          initial={reducedMotion ? false : { opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: motionTokens.duration.feedback,
            ease: motionTokens.ease,
          }}
          id="channel-additional-presets"
          className="lolicode-channel-more space-y-3 bg-subtle p-3"
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-3" />
            <Input
              aria-label="搜索服务"
              className="pl-9"
              placeholder="搜索更多服务名称"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="lolicode-channel-additional-grid lolicode-channel-preset-grid">
            {additionalPresets.length ? (
              additionalPresets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={value === preset.id}
                  aria-label={preset.name}
                  disabled={disabled}
                  onClick={() => onValueChange(preset.id)}
                  className={cn(
                    "lolicode-channel-card flex min-w-0 items-center gap-2.5 border text-left text-body text-fg-1 disabled:opacity-50",
                    value === preset.id
                      ? "border-ring bg-subtle"
                      : "border-border bg-surface",
                  )}
                >
                  <ProviderIconBox icon={preset.icon} name={preset.name} />
                  <span className="min-w-0 leading-snug">
                    <span className="block font-medium">{preset.name}</span>
                  </span>
                  {value === preset.id && (
                    <Check
                      className="lolicode-channel-preset-check"
                      aria-hidden="true"
                    />
                  )}
                </button>
              ))
            ) : (
              <p className="py-2 text-caption text-fg-3">没有匹配的服务</p>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}
