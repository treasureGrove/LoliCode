import { useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { ProviderIconBox } from "@/components/ProviderIconBox";
import { Button } from "@/components/ui/button";
import { Input, fieldClass } from "@/components/ui/input";
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
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = [...ACCOUNT_CHANNEL_PRESETS, ...CHANNEL_PRESETS].filter(
    (preset) =>
      `${preset.name} ${"baseUrl" in preset ? preset.baseUrl : ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  return (
    <div className="mt-4 space-y-3">
      <p className="text-caption text-fg-2">
        选择服务，地址已配置好；只需填写密钥或登录账号。
      </p>
      <div
        role="group"
        aria-label="添加渠道方式"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      >
        {[...ACCOUNT_CHANNEL_PRESETS, ...COMMON_CHANNEL_PRESETS].map(
          (preset) => (
            <button
              key={preset.id}
              type="button"
              aria-pressed={value === preset.id}
              disabled={disabled}
              onClick={() => onValueChange(preset.id)}
              className={cn(
                "lolicode-channel-card flex min-w-0 items-center gap-2.5 rounded-control border px-3 py-2.5 text-left text-body text-fg-1 transition-colors hover:bg-subtle disabled:opacity-50",
                value === preset.id
                  ? "border-ring bg-subtle"
                  : "border-border bg-surface",
              )}
            >
              <ProviderIconBox icon={preset.icon} name={preset.name} />
              <span className="min-w-0 leading-snug">{preset.name}</span>
            </button>
          ),
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="neutral"
          size="compact"
          disabled={disabled}
          onClick={() => setMore(!more)}
          aria-expanded={more}
        >
          <ChevronDown className={cn("h-3.5 w-3.5", more && "rotate-180")} />
          更多服务
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
        <div className="grid gap-2 rounded-control bg-subtle p-3 sm:grid-cols-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-fg-3" />
            <Input
              aria-label="搜索服务"
              className="pl-8"
              placeholder="搜索服务名称"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <select
            aria-label="更多渠道服务"
            className={cn(fieldClass, "h-8")}
            value={filtered.some((preset) => preset.id === value) ? value : ""}
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value) onValueChange(event.target.value);
            }}
          >
            <option value="">
              {filtered.length
                ? `选择服务（${filtered.length} 个）`
                : "没有匹配服务"}
            </option>
            {filtered.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
