import type { ModelPricing, ModelsDevSyncConfig } from "@/types/usage";
import {
  normalizeModelsDevModelId,
  type ModelsDevModel,
  type ModelsDevResponse,
} from "./modelsDev";

export interface ModelsDevEntry {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  normalizedId: string;
  modelName: string;
  releaseDate: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const NON_TEXT_MODEL_MARKERS = [
  "audio",
  "deprecated",
  "embedding",
  "image",
  "moderation",
  "realtime",
  "transcribe",
  "tts",
  "video",
];
const NON_TEXT_OUTPUT_MODALITIES = new Set(["audio", "image", "video"]);

const isTextPricingModel = (modelId: string, model?: ModelsDevModel) => {
  if (model?.status?.toLowerCase() === "deprecated") return false;

  const outputModalities = model?.modalities?.output
    ?.filter((modality): modality is string => typeof modality === "string")
    .map((modality) => modality.toLowerCase());
  if (
    outputModalities?.length &&
    (!outputModalities.includes("text") ||
      outputModalities.some((modality) =>
        NON_TEXT_OUTPUT_MODALITIES.has(modality),
      ))
  ) {
    return false;
  }

  const searchableName = `${modelId} ${model?.name ?? ""}`.toLowerCase();
  return !NON_TEXT_MODEL_MARKERS.some((marker) =>
    searchableName.includes(marker),
  );
};

const isPrice = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value < 1e12 &&
  (value === 0 || value >= 1e-28);

export function formatPrice(value: number | undefined): string {
  if (!isPrice(value)) return "—";
  const [coefficient, exponent] = String(value).split("e");
  if (exponent === undefined) return coefficient;
  const digits = coefficient.replace(".", "");
  const point =
    (coefficient.includes(".")
      ? coefficient.indexOf(".")
      : coefficient.length) + Number(exponent);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function flattenModels(data: ModelsDevResponse): ModelsDevEntry[] {
  const entries: ModelsDevEntry[] = [];
  for (const [providerId, provider] of Object.entries(data)) {
    if (!provider || typeof provider !== "object") continue;
    const providerName = provider.name || providerId;
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (!isTextPricingModel(modelId, model)) continue;
      const cost = model?.cost;
      const input = cost?.input;
      const output = cost?.output;
      if (!isPrice(input) || !isPrice(output)) continue;
      const normalizedId = normalizeModelsDevModelId(modelId);
      if (!normalizedId) continue;
      entries.push({
        key: `${providerId}/${modelId}`,
        providerId,
        providerName,
        modelId,
        normalizedId,
        modelName: model?.name || modelId,
        releaseDate:
          typeof model?.release_date === "string" ? model.release_date : "",
        input,
        output,
        cacheRead: isPrice(cost?.cache_read) ? cost.cache_read : undefined,
        cacheWrite: isPrice(cost?.cache_write) ? cost.cache_write : undefined,
      });
    }
  }
  entries.sort(
    (a, b) =>
      b.releaseDate.localeCompare(a.releaseDate) ||
      a.modelName.localeCompare(b.modelName),
  );
  return entries;
}

const COMMON_MODEL_LIMIT_PER_FAMILY = 6;

interface CommonFamilyRule {
  id: string;
  providers: ReadonlySet<string>;
  matches: (modelId: string) => boolean;
}

const COMMON_FAMILY_RULES: CommonFamilyRule[] = [
  {
    id: "claude",
    providers: new Set(["anthropic"]),
    matches: (modelId) => modelId.startsWith("claude-"),
  },
  {
    id: "gpt",
    providers: new Set(["openai"]),
    matches: (modelId) =>
      modelId.startsWith("gpt-") || /^(o1|o3|o4)(-|$)/.test(modelId),
  },
  {
    id: "gemini",
    providers: new Set(["google"]),
    matches: (modelId) => modelId.startsWith("gemini-"),
  },
  {
    id: "grok",
    providers: new Set(["xai"]),
    matches: (modelId) => modelId.startsWith("grok-"),
  },
  {
    id: "deepseek",
    providers: new Set(["deepseek"]),
    matches: (modelId) => modelId.startsWith("deepseek-"),
  },
  {
    id: "qwen",
    providers: new Set(["alibaba"]),
    matches: (modelId) => modelId.startsWith("qwen"),
  },
  {
    id: "mimo",
    providers: new Set(["xiaomi"]),
    matches: (modelId) => modelId.startsWith("mimo-"),
  },
  {
    id: "longcat",
    providers: new Set(["longcat"]),
    matches: (modelId) => modelId.startsWith("longcat-"),
  },
  {
    id: "kimi",
    providers: new Set(["moonshotai"]),
    matches: (modelId) => modelId.startsWith("kimi-"),
  },
  {
    id: "minimax",
    providers: new Set(["minimax-cn"]),
    matches: (modelId) => modelId.startsWith("minimax-m"),
  },
  {
    id: "glm",
    providers: new Set(["zai"]),
    matches: (modelId) => modelId.startsWith("glm-"),
  },
];

/** Pick a bounded, canonical set of recent chat/coding models per family. */
export function getCommonModelKeys(entries: ModelsDevEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const rule of COMMON_FAMILY_RULES) {
    let count = 0;
    for (const entry of entries) {
      if (
        rule.providers.has(entry.providerId) &&
        rule.matches(entry.normalizedId)
      ) {
        keys.add(entry.key);
        count += 1;
        if (count >= COMMON_MODEL_LIMIT_PER_FAMILY) break;
      }
    }
  }
  return keys;
}

export function resolveModelsDevSelection(
  entries: ModelsDevEntry[],
  config: ModelsDevSyncConfig,
): ModelsDevEntry[] {
  const explicit = new Set(config.selectedModelKeys);
  const excluded = new Set(config.excludedCommonModelKeys);
  const common = config.includeCommonModels
    ? getCommonModelKeys(entries)
    : new Set<string>();
  return entries.filter(
    (entry) =>
      explicit.has(entry.key) ||
      (common.has(entry.key) && !excluded.has(entry.key)),
  );
}

const isOriginalProviderEntry = (entry: ModelsDevEntry): boolean =>
  COMMON_FAMILY_RULES.some(
    (rule) =>
      rule.providers.has(entry.providerId) && rule.matches(entry.normalizedId),
  );

/** Cover known model families at their original provider, excluding third-party hosting. */
export function resolveModelsDevSyncSelection(
  entries: ModelsDevEntry[],
  config: ModelsDevSyncConfig,
): ModelsDevEntry[] {
  const explicit = new Set(config.selectedModelKeys);
  const excluded = new Set(config.excludedCommonModelKeys);
  return entries.filter(
    (entry) =>
      explicit.has(entry.key) ||
      (config.includeCommonModels &&
        isOriginalProviderEntry(entry) &&
        !excluded.has(entry.key)),
  );
}

export function toModelPricing(
  entries: ModelsDevEntry[],
  existing: ModelPricing[] = [],
): ModelPricing[] {
  const existingById = new Map(existing.map((entry) => [entry.modelId, entry]));
  const groups = new Map<string, ModelsDevEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.normalizedId) ?? [];
    group.push(entry);
    groups.set(entry.normalizedId, group);
  }
  const result: ModelPricing[] = [];
  for (const [modelId, group] of groups) {
    const official = group.filter(isOriginalProviderEntry);
    const candidates = (official.length ? official : group).sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    const previous = existingById.get(modelId);
    const prices = candidates.flatMap((entry): ModelPricing[] => {
      if (!isPrice(entry.input) || !isPrice(entry.output)) return [];
      const cacheRead = isPrice(entry.cacheRead)
        ? entry.cacheRead
        : previous && Number(previous.cacheReadCostPerMillion);
      const cacheWrite = isPrice(entry.cacheWrite)
        ? entry.cacheWrite
        : previous && Number(previous.cacheCreationCostPerMillion);
      // Missing cache prices are unknown, not free. Keep a known local rate;
      // otherwise wait for a complete entry instead of persisting a false zero.
      if (!isPrice(cacheRead) || !isPrice(cacheWrite)) return [];
      return [
        {
          modelId,
          displayName: entry.modelName,
          inputCostPerMillion: formatPrice(entry.input),
          outputCostPerMillion: formatPrice(entry.output),
          cacheReadCostPerMillion: formatPrice(cacheRead),
          cacheCreationCostPerMillion: formatPrice(cacheWrite),
        },
      ];
    });
    const distinctRates = new Set(
      prices.map(({ displayName: _, ...rates }) => JSON.stringify(rates)),
    );
    // Conflicting host prices must not depend on feed ordering.
    if (distinctRates.size === 1) result.push(prices[0]);
  }
  return result;
}
