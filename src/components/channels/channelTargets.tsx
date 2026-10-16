import { Terminal } from "lucide-react";
import { APP_IDS } from "@/config/appConfig";
import { APP_DISPLAY_NAME, AppGlyph } from "@/components/shell/AppGlyph";
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
  return APP_IDS.includes(app as AppId) ? (
    <AppGlyph app={app as AppId} size={18} />
  ) : (
    <Terminal size={18} aria-hidden="true" className="shrink-0" />
  );
}
