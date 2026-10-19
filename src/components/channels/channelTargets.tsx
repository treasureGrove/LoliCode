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
  "codebuddy",
];

export const CHANNEL_TARGET_NAMES: Record<ChannelTarget, string> = {
  ...APP_DISPLAY_NAME,
  workbuddy: "WorkBuddy",
  "deepseek-harness": "DeepSeek Harness",
  zcode: "ZCode",
  mimocode: "MiMo Code",
  codebuddy: "CodeBuddy",
};

export function ChannelTargetGlyph({
  app,
  size = 18,
}: {
  app: ChannelTarget | "qoder";
  size?: number;
}) {
  if (APP_IDS.includes(app as AppId))
    return <AppGlyph app={app as AppId} size={size} />;

  if (app === "codebuddy" || app === "qoder")
    return (
      <ProviderIcon
        icon={app}
        name={app === "qoder" ? "Qoder" : "CodeBuddy"}
        size={size}
        showFallback={false}
      />
    );

  if (app === "deepseek-harness")
    return (
      <ProviderIcon
        icon="deepseek"
        name="DeepSeek Harness"
        size={size}
        showFallback={false}
      />
    );
  if (app === "mimocode")
    return (
      <ProviderIcon
        icon="xiaomimimo"
        name="MiMo"
        size={size}
        showFallback={false}
      />
    );

  if (app === "workbuddy")
    return (
      <ProviderIcon
        icon="workbuddy"
        name="WorkBuddy"
        size={size}
        showFallback={false}
      />
    );
  return (
    <ProviderIcon icon="zcode" name="ZCode" size={size} showFallback={false} />
  );
}
