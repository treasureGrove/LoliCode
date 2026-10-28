import { BUILD_NUMBER, IS_DEVELOPMENT_BUILD } from "./buildChannel";

export const APP_NAME = IS_DEVELOPMENT_BUILD ? "LoliCode 开发版" : "LoliCode";
export const APP_WINDOW_TITLE =
  IS_DEVELOPMENT_BUILD && BUILD_NUMBER
    ? `${APP_NAME} · ${BUILD_NUMBER}`
    : APP_NAME;
export const BUILTIN_AGENT_NAME = "sillyDog";
export const BUILTIN_AGENT_NICKNAME = "小笨狗";
export const APP_WEBSITE = "https://lolicode.com/";
export const APP_REPOSITORY = "https://github.com/treasureGrove/LoliCode";
export const APP_COMMUNITY = "https://lolicode.com/all";
export const APP_CHANGELOG =
  "https://github.com/treasureGrove/LoliCode-Releases/releases";

// LoliCode's signed release feed is configured in tauri.conf.json.
export const APP_UPDATES_ENABLED = !IS_DEVELOPMENT_BUILD;
