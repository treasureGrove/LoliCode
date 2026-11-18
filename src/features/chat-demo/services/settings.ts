import { create } from "zustand";
import type { TtsVoice } from "./api/speech.js";
import { normalizeLocation, type UserLocation } from "./location.js";

export type Locale = "zh-CN" | "en-US";

/** 主题偏好；默认跟随系统 */
export type ThemePreference = "light" | "dark" | "system";

/**
 * 模型来源：
 * - 'deepseek-flash' | 'deepseek-v4-pro'：DeepSeek 官方 API 直连（使用本页 API Key）
 * - `channel:${string}`：复用桌面端「渠道与模型」或内置免费离线本地模型（tavern-local:*）
 */
export type ModelSource =
  | "deepseek-flash"
  | "deepseek-v4-pro"
  | `channel:${string}`;

type Settings = {
  apiKey: string | null;
  modelSource: ModelSource;
  locale: Locale;
  themePreference: ThemePreference;
  location: UserLocation | null;
  ttsVoice: TtsVoice;
  thinking: boolean;
  search: boolean;
  siderCollapsed: boolean;
};

const KEYS = {
  apiKey: "chat-demo:api-key",
  modelSource: "chat-demo:model-source",
  locale: "chat-demo:locale",
  location: "chat-demo:location",
  themePreference: "chat-demo:theme-preference",
  ttsVoice: "chat-demo:tts-voice",
  thinking: "chat-demo:thinking",
  search: "chat-demo:search",
  siderCollapsed: "chat-demo:sider-collapsed",
} as const;

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
};

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === "undefined" ? "zh" : navigator.language)
    .toLowerCase()
    .startsWith("zh");

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale);
  if (saved === "zh-CN" || saved === "en-US") {
    return saved;
  }
  return isChineseBrowser() ? "zh-CN" : "en-US";
};

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(
      JSON.parse(read(KEYS.location) ?? "null"),
    );
    if (!location) {
      return null;
    }
    return isChineseBrowser()
      ? location.region === "CN" && location.province
        ? location
        : null
      : { region: location.region };
  } catch {
    return null;
  }
};

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference);
  return saved === "light" || saved === "dark" ? saved : "system";
};

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice =>
  read(KEYS.ttsVoice) === "tide" ? "tide" : "stella";

const initialModelSource = (): ModelSource => {
  const saved = read(KEYS.modelSource);
  if (
    saved === "deepseek-flash" ||
    saved === "deepseek-v4-pro" ||
    (saved && saved.startsWith("channel:"))
  ) {
    return saved as ModelSource;
  }
  return "deepseek-flash";
};

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  modelSource: initialModelSource(),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === "true",
  search: read(KEYS.search) === "true",
  siderCollapsed: read(KEYS.siderCollapsed) === "true",
}));

let openChannelsCallback: (() => void) | undefined;
export const setOpenChannelsCallback = (cb: (() => void) | undefined) => {
  openChannelsCallback = cb;
};
export const triggerOpenChannels = () => {
  openChannelsCallback?.();
};

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale);
  useSettings.setState({ locale });
};

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value);
  write(KEYS.location, location ? JSON.stringify(location) : null);
  useSettings.setState({ location });
};

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference);
  useSettings.setState({ themePreference });
};

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice);
  useSettings.setState({ ttsVoice });
};

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey);
  useSettings.setState({ apiKey });
};

export const setModelSource = (modelSource: ModelSource) => {
  write(KEYS.modelSource, modelSource);
  useSettings.setState({ modelSource });
};

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking));
  useSettings.setState({ thinking });
};

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search));
  useSettings.setState({ search });
};

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed));
  useSettings.setState({ siderCollapsed });
};
