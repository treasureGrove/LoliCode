import type { AppId } from "@/lib/api";

/**
 * 主窗口入口：主 Agent、统一渠道、用量与设置。
 *
 * 旧视图类型仅用于兼容已保存的导航和原生事件，生产入口经
 * productViewOf 收束，避免恢复已退出的客户端管理页面。
 */

export type AppPage =
  | "providers"
  | "workspace"
  | "openclawConfig"
  | "hermesMemory";

export type GlobalPage =
  | "applications"
  | "agent"
  | "tavern"
  | "unreal"
  | "rankings"
  | "free-ai"
  | "channels"
  | "usage"
  | "auth"
  | "mcp"
  | "skills"
  | "skillsDiscovery"
  | "prompts"
  | "sessions"
  | "apps";

export type View = AppPage | GlobalPage | "settings";

export type SettingsSection =
  | "general"
  | "appConfig"
  | "routing"
  | "network"
  | "data"
  | "about";

export const SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "appConfig",
  "routing",
  "network",
  "data",
  "about",
];

const APP_PAGES: AppPage[] = [
  "providers",
  "workspace",
  "openclawConfig",
  "hermesMemory",
];

const GLOBAL_PAGES: GlobalPage[] = [
  "applications",
  "agent",
  "tavern",
  "unreal",
  "rankings",
  "free-ai",
  "channels",
  "usage",
  "auth",
  "mcp",
  "skills",
  "skillsDiscovery",
  "prompts",
  "sessions",
  "apps",
];

export const VIEW_STORAGE_KEY = "cc-switch-last-view";
export const APP_STORAGE_KEY = "cc-switch-last-app";

/** 旧版视图名 → 新视图（OpenClaw 的三个配置页合成了一个）。 */
const LEGACY_VIEWS: Record<string, View> = {
  openclawEnv: "openclawConfig",
  openclawTools: "openclawConfig",
  openclawAgents: "openclawConfig",
};

export function isAppPage(view: View): view is AppPage {
  return (APP_PAGES as string[]).includes(view);
}

export function isGlobalPage(view: View): view is GlobalPage {
  return (GLOBAL_PAGES as string[]).includes(view);
}

export function parseView(value: string | null | undefined): View | null {
  if (!value) return null;
  if (value in LEGACY_VIEWS) return LEGACY_VIEWS[value];
  if (value === "settings") return "settings";
  if ((APP_PAGES as string[]).includes(value)) return value as AppPage;
  if ((GLOBAL_PAGES as string[]).includes(value)) return value as GlobalPage;
  return null;
}

/** 应用专属页只对它所属的应用成立；换了应用就回到供应商页。 */
export function appPageBelongsTo(page: AppPage, app: AppId): boolean {
  switch (page) {
    case "providers":
      return true;
    case "workspace":
    case "openclawConfig":
      return app === "openclaw";
    case "hermesMemory":
      return app === "hermes";
  }
}

export function readStoredView(): View {
  try {
    const view = parseView(localStorage.getItem(VIEW_STORAGE_KEY));
    return view ? productViewOf(view) : "agent";
  } catch {
    return "agent";
  }
}

export function storeView(view: View) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // 存不了就算了：下次启动回到主 Agent
  }
}

/** Retired CC Switch pages are migration inputs, never product destinations.
 * Agent extensions/memory use the workspace; clients use shared channels. */
export function productViewOf(view: View): View {
  switch (view) {
    case "providers":
    case "workspace":
    case "openclawConfig":
    case "auth":
      return "channels";
    case "mcp":
    case "skills":
    case "skillsDiscovery":
    case "prompts":
    case "sessions":
    case "hermesMemory":
      return "agent";
    default:
      return view;
  }
}

/**
 * 旧的设置页签名 → 新的设置分组。用量统计、认证已经搬成全局页，由调用方改走全局页。
 */
export function normalizeSettingsSection(
  tab: string | null | undefined,
): SettingsSection {
  switch (tab) {
    case "proxy":
    case "routing":
      return "routing";
    case "advanced":
    case "data":
      return "data";
    case "appConfig":
    case "network":
    case "about":
    case "general":
      return tab;
    default:
      return "general";
  }
}

/** 提示词、会话页在 Claude Desktop 上看的是 Claude Code 的内容（两者共用）。 */
export function sharedFeatureAppOf(app: AppId): AppId {
  return app === "claude-desktop" ? "claude" : app;
}
