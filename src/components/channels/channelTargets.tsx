import { APP_IDS } from "@/config/appConfig";
import { APP_DISPLAY_NAME, AppGlyph } from "@/components/shell/AppGlyph";
import { ProviderIcon } from "@/components/ProviderIcon";
import type { AppId } from "@/lib/api/types";
import type { ChannelTarget } from "@/lib/api/channel-center";

export const CHANNEL_TARGETS: ChannelTarget[] = [
  ...APP_IDS,
  "workbuddy",
  "deepseek-harness",
  "zcode",
  "mimocode",
];

export const CHANNEL_TARGET_NAMES: Record<ChannelTarget, string> = {
  ...APP_DISPLAY_NAME,
  workbuddy: "WorkBuddy",
  "deepseek-harness": "DeepSeek Harness",
  zcode: "ZCode",
  mimocode: "MiMo Code",
};

export function ChannelTargetGlyph({ app }: { app: ChannelTarget }) {
  if (APP_IDS.includes(app as AppId))
    return <AppGlyph app={app as AppId} size={18} />;

  if (app === "deepseek-harness")
    return (
      <ProviderIcon
        icon="deepseek"
        name="DeepSeek Harness"
        size={18}
        showFallback={false}
      />
    );
  if (app === "mimocode")
    return (
      <ProviderIcon
        icon="xiaomimimo"
        name="MiMo"
        size={18}
        showFallback={false}
      />
    );

  if (app === "workbuddy")
    return (
      <ProviderIcon
        icon="workbuddy"
        name="WorkBuddy"
        size={18}
        showFallback={false}
      />
    );
  return (
    <ProviderIcon icon="zcode" name="ZCode" size={18} showFallback={false} />
  );
}
