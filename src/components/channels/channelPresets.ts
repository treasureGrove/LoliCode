import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { providerPresets } from "@/config/claudeProviderPresets";
import { parse } from "smol-toml";
import type { ChannelProtocol, ChannelSource } from "@/lib/api/channel-center";

export interface ChannelPreset {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ChannelProtocol;
  icon: string;
  websiteUrl?: string;
}

const packages: Record<string, ChannelProtocol> = {
  "@ai-sdk/openai-compatible": "openai_chat",
  "@ai-sdk/openai": "openai_responses",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/google": "gemini_native",
};

const existingOpenCode: ChannelPreset[] = opencodeProviderPresets.flatMap(
  (preset) => {
    const baseUrl = preset.settingsConfig.options?.baseURL;
    const protocol = packages[preset.settingsConfig.npm ?? ""];
    // A URL + Key form cannot supply template parameters or required custom headers.
    if (
      !baseUrl ||
      !protocol ||
      /\$\{|\{\{/.test(baseUrl) ||
      Object.keys(preset.settingsConfig.options?.headers ?? {}).length > 0
    )
      return [];
    return [
      {
        id: `opencode:${preset.name}`,
        name: preset.name,
        baseUrl,
        protocol,
        icon: preset.icon || "openai",
        websiteUrl: preset.websiteUrl,
      },
    ];
  },
);

function fromOpenCode(
  id: string,
  sourceName: string,
  name = sourceName,
): ChannelPreset {
  const preset = existingOpenCode.find((item) => item.name === sourceName);
  if (!preset) throw new Error(`Missing channel preset: ${sourceName}`);
  return { ...preset, id, name };
}

function fromCodex(
  id: string,
  sourceName: string,
  name: string,
): ChannelPreset {
  const preset = codexProviderPresets.find((item) => item.name === sourceName);
  const providers = preset
    ? (parse(preset.config).model_providers as
        | Record<string, { base_url?: string; wire_api?: string }>
        | undefined)
    : undefined;
  const provider = Object.values(providers ?? {})[0];
  const baseUrl = preset?.endpointCandidates?.[0] ?? provider?.base_url;
  const protocol =
    preset?.apiFormat ??
    (provider?.wire_api === "responses"
      ? "openai_responses"
      : provider?.wire_api === "chat"
        ? "openai_chat"
        : undefined);
  if (
    !preset ||
    !baseUrl ||
    !["openai_chat", "openai_responses"].includes(protocol ?? "")
  )
    throw new Error(`Missing channel preset: ${sourceName}`);
  return {
    id,
    name,
    baseUrl,
    protocol: protocol as ChannelProtocol,
    icon: preset.icon || "openai",
    websiteUrl: preset.websiteUrl,
  };
}

const gemini = providerPresets.find(
  (preset) => preset.name === "Gemini Native",
)!;
const bailianCoding = providerPresets.find(
  (preset) => preset.name === "千问AI平台 Coding Plan",
)!;

/** Existing CC Switch preset endpoints and logos; no preset model list is assumed available. */
export const COMMON_CHANNEL_PRESETS: ChannelPreset[] = [
  fromOpenCode("deepseek", "DeepSeek"),
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai_responses",
    icon: "openai",
    websiteUrl: "https://platform.openai.com",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic",
    icon: "anthropic",
    websiteUrl: "https://console.anthropic.com",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: (gemini.settingsConfig as { env: Record<string, string> }).env
      .ANTHROPIC_BASE_URL,
    protocol: "gemini_native",
    icon: gemini.icon || "gemini",
    websiteUrl: gemini.websiteUrl,
  },
  {
    id: "zhipu",
    name: "智谱 · 通用 API",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai_chat",
    icon: "zhipu",
    websiteUrl: "https://open.bigmodel.cn",
  },
  fromOpenCode("zhipu-coding", "Zhipu GLM", "智谱 · 编程套餐"),
  fromOpenCode("zai-coding", "Zhipu GLM en", "Z.ai · 编程套餐"),
  fromOpenCode("kimi", "Kimi", "Kimi · 中国"),
  fromOpenCode("minimax", "MiniMax", "MiniMax · 中国"),
  fromCodex("openrouter", "OpenRouter", "OpenRouter"),
  fromCodex("siliconflow", "SiliconFlow", "硅基流动 · 中国"),
  fromOpenCode("bailian", "千问AI平台", "阿里百炼 · 通用 API"),
  {
    id: "bailian-coding",
    name: "阿里百炼 · 编程套餐",
    baseUrl: (bailianCoding.settingsConfig as { env: Record<string, string> })
      .env.ANTHROPIC_BASE_URL,
    protocol: "anthropic",
    icon: bailianCoding.icon || "qianwenai",
    websiteUrl: bailianCoding.websiteUrl,
  },
];

const used = new Set(
  COMMON_CHANNEL_PRESETS.map((preset) => preset.baseUrl.replace(/\/+$/, "")),
);
export const CHANNEL_PRESETS: ChannelPreset[] = [
  ...COMMON_CHANNEL_PRESETS,
  ...existingOpenCode.filter((preset) => {
    const key = preset.baseUrl.replace(/\/+$/, "");
    if (used.has(key)) return false;
    used.add(key);
    return true;
  }),
  fromCodex("siliconflow-global", "SiliconFlow en", "硅基流动 · 国际"),
];

export const CHANNEL_PRESET_MAP = Object.fromEntries(
  CHANNEL_PRESETS.map((preset) => [preset.id, preset]),
);

export function matchChannelPreset(
  source: Pick<ChannelSource, "baseUrl" | "name">,
) {
  const url = source.baseUrl.trim().replace(/\/+$/, "");
  const matches = CHANNEL_PRESETS.filter(
    (preset) => preset.baseUrl.replace(/\/+$/, "") === url,
  );
  return matches.find((preset) => preset.name === source.name) ?? matches[0];
}
