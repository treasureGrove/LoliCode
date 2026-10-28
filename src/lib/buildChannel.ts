export type BuildChannel = "development" | "stable";

export function resolveBuildChannel({
  channel,
  dev,
  mode,
}: {
  channel?: string;
  dev: boolean;
  mode: string;
}): BuildChannel {
  if (channel === "development") return "development";
  if (channel === "stable") return "stable";
  // Tests exercise the stable application unless a channel is explicitly set.
  return dev && mode !== "test" ? "development" : "stable";
}

export const BUILD_CHANNEL = resolveBuildChannel({
  channel: import.meta.env.VITE_LOLICODE_BUILD_CHANNEL,
  dev: import.meta.env.DEV,
  mode: import.meta.env.MODE,
});
export const IS_DEVELOPMENT_BUILD = BUILD_CHANNEL === "development";
export const BUILD_NUMBER =
  import.meta.env.VITE_LOLICODE_BUILD_NUMBER?.trim() || "";
export const BUILD_REVISION =
  import.meta.env.VITE_LOLICODE_BUILD_REVISION?.trim() || "";

export function buildChannelLabel(language: string): string {
  if (language === "zh-TW") return IS_DEVELOPMENT_BUILD ? "開發版" : "正式版";
  if (language.startsWith("zh"))
    return IS_DEVELOPMENT_BUILD ? "开发版" : "正式版";
  if (language.startsWith("ja"))
    return IS_DEVELOPMENT_BUILD ? "開発版" : "安定版";
  return IS_DEVELOPMENT_BUILD ? "Development" : "Stable";
}
