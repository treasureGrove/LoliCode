import { Boxes } from "lucide-react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { cn } from "@/lib/utils";
import type { AgentModel } from "@/types/agent";

type ModelBrand = {
  icon: string;
  label: string;
  model: RegExp;
  provider: RegExp;
};

// Match model families at token boundaries, rather than arbitrary substrings in
// channel names. A relay can expose several vendors under the same provider ID.
const BRANDS: readonly ModelBrand[] = [
  {
    icon: "openai",
    label: "OpenAI",
    model:
      /(?:^|[\s/.:_(-])(?:gpt(?=$|[\d\s._:-])|chatgpt(?=$|[\s._:-])|codex(?=$|[\s._:-])|o[1-9](?=$|[\s._:-]))/i,
    provider: /^(?:openai|chatgpt)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "claude",
    label: "Anthropic",
    model: /(?:^|[\s/.:_(-])(?:claude|sonnet|opus|haiku)(?=$|[\d\s._:-])/i,
    provider: /^(?:anthropic|claude)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "deepseek",
    label: "DeepSeek",
    model: /(?:^|[\s/.:_(-])deepseek(?=$|[\d\s._:-])/i,
    provider: /^deepseek(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "gemini",
    label: "Google",
    model: /(?:^|[\s/.:_(-])(?:gemini|gemma)(?=$|[\d\s._:-])/i,
    provider: /^(?:google|gemini|vertex)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "qwen",
    label: "通义千问",
    model: /(?:^|[\s/.:_(-])(?:qwen|qwq)(?=$|[\d\s._:-])/i,
    provider:
      /^(?:qwen|alibaba|dashscope|通义千问|阿里云百炼)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "kimi",
    label: "Moonshot AI",
    model: /(?:^|[\s/.:_(-])(?:kimi|moonshot)(?=$|[\d\s._:-])/i,
    provider: /^(?:kimi|moonshot)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "zhipu",
    label: "智谱",
    model: /(?:^|[\s/.:_(-])(?:glm|chatglm)(?=$|[\d\s._:-])/i,
    provider: /^(?:zhipu|zai|z\.ai|智谱)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "grok",
    label: "xAI",
    model: /(?:^|[\s/.:_(-])grok(?=$|[\d\s._:-])/i,
    provider: /^(?:xai|x\.ai|grok)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "mistral",
    label: "Mistral AI",
    model:
      /(?:^|[\s/.:_(-])(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)(?=$|[\d\s._:-])/i,
    provider: /^mistral(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "minimax",
    label: "MiniMax",
    model: /(?:^|[\s/.:_(-])minimax(?=$|[\d\s._:-])/i,
    provider: /^minimax(?:ai)?(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "meta",
    label: "Meta",
    model: /(?:^|[\s/.:_(-])llama(?=$|[\d\s._:-])/i,
    provider: /^(?:meta|meta-llama)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "doubao",
    label: "字节跳动",
    model: /(?:^|[\s/.:_(-])(?:doubao|seed)(?=$|[\d\s._:-])/i,
    provider:
      /^(?:doubao|bytedance|byteplus|火山引擎|豆包)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "hunyuan",
    label: "腾讯混元",
    model: /(?:^|[\s/.:_(-])hunyuan(?=$|[\d\s._:-])/i,
    provider: /^(?:hunyuan|腾讯混元)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "stepfun",
    label: "阶跃星辰",
    model: /(?:^|[\s/.:_(-])step(?=$|[\d\s._:-])/i,
    provider: /^(?:stepfun|阶跃星辰)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "xiaomimimo",
    label: "Xiaomi",
    model: /(?:^|[\s/.:_(-])mimo(?=$|[\d\s._:-])/i,
    provider: /^(?:xiaomi|mimo|小米)(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "cohere",
    label: "Cohere",
    model: /(?:^|[\s/.:_(-])command(?=$|[\d\s._:-])/i,
    provider: /^cohere(?=$|[\s·/:_(-]|官方)/i,
  },
  {
    icon: "perplexity",
    label: "Perplexity",
    model: /(?:^|[\s/.:_(-])sonar(?=$|[\d\s._:-])/i,
    provider: /^perplexity(?=$|[\s·/:_(-]|官方)/i,
  },
];

function modelFamily(value: string): ModelBrand | undefined {
  let earliest = Infinity;
  let selected: ModelBrand | undefined;
  for (const brand of BRANDS) {
    const match = brand.model.exec(value);
    if (match && match.index < earliest) {
      earliest = match.index;
      selected = brand;
    }
  }
  return selected;
}

export function resolveAgentModelBrand(
  model?: AgentModel,
): ModelBrand | undefined {
  if (!model) return undefined;
  // modelId is the upstream model path (possibly prefixed by a gateway route).
  // The engine's opaque `id` is deliberately never inspected or split.
  const leaf = model.modelId.slice(model.modelId.lastIndexOf("/") + 1);
  const channelPrefix = `${model.channelName.trim()} · `;
  const name = model.name.trim();
  const ownName =
    model.channelName.trim() && name.startsWith(channelPrefix)
      ? name.slice(channelPrefix.length)
      : name;
  return (
    modelFamily(leaf) ||
    modelFamily(ownName) ||
    BRANDS.find((brand) => brand.provider.test(model.providerId.trim())) ||
    BRANDS.find((brand) => brand.provider.test(model.channelName.trim()))
  );
}

/** Decorative vendor mark; its surrounding model control supplies the label. */
export function AgentModelIcon({
  model,
  size = 16,
  className,
}: {
  model?: AgentModel;
  size?: number;
  className?: string;
}) {
  const brand = resolveAgentModelBrand(model);
  return (
    <span
      aria-hidden="true"
      data-model-provider={brand?.icon || "unknown"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {brand ? (
        <ProviderIcon
          icon={brand.icon}
          name={brand.label}
          size={size}
          showFallback={false}
        />
      ) : (
        <Boxes size={size} />
      )}
    </span>
  );
}
