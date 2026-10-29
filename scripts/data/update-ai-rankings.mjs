import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Rebuild the checked-in snapshot from independently downloaded source extracts:
// node scripts/data/update-ai-rankings.mjs aa-ranking.json livebench-20261025-extracted.json arena-verified-v3.json
// Inputs deliberately remain local: this script does not guess model aliases or scrape changing pages.
const [aaPath, livebenchPath, arenaPath] = process.argv.slice(2);
if (!aaPath || !livebenchPath || !arenaPath) {
  throw new Error(
    "Pass the Artificial Analysis, LiveBench and Arena extract paths.",
  );
}
const load = async (path) =>
  JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
const [aa, livebench, arena] = await Promise.all([
  load(aaPath),
  load(livebenchPath),
  load(arenaPath),
]);
const variants = (
  base,
  suffixes = ["", "-xhigh", "-high", "-medium", "-low"],
) => suffixes.map((suffix) => base + suffix);

// Explicit identity map. Only reasoning effort variants share a row. Flash/Pro,
// Preview, dated releases, quantizations and distinct versions stay separate.
// Muse Wonder Full and the unversioned Muse Wonder aliases are not matched to
// LiveBench's Wonder 1.0 without a version-specific identity record.
// AA's Qwen3.8 Max (0902) is not matched to undated source rows.
const identities = [
  [
    "claude-opus-5.5",
    "Claude Opus 5.5",
    "Anthropic",
    "anthropic",
    "claude-opus-5.5",
    variants("claude-opus-5-5"),
    ["Claude Opus 5.5 (High)"],
  ],
  [
    "gpt-6-astra",
    "GPT-6 Astra",
    "OpenAI",
    "openai",
    "gpt-6-astra",
    variants("gpt-6-astra"),
    ["GPT-6 Astra (Max)"],
  ],
  [
    "gpt-6.1-sol",
    "GPT-6.1 Sol",
    "OpenAI",
    "openai",
    "gpt-6.1-sol",
    variants("gpt-6-1-sol"),
    ["GPT-6.1 Sol (Max)"],
  ],
  [
    "claude-sonnet-5.5",
    "Claude Sonnet 5.5",
    "Anthropic",
    "anthropic",
    "claude-sonnet-5.5",
    variants("claude-sonnet-5-5"),
    ["Claude Sonnet 5.5 (xHigh)"],
  ],
  [
    "gpt-6.1-terra",
    "GPT-6.1 Terra",
    "OpenAI",
    "openai",
    "gpt-6.1-terra",
    variants("gpt-6-1-terra", [
      "",
      "-xhigh",
      "-high",
      "-medium",
      "-low",
      "-non-reasoning",
    ]),
    [],
  ],
  [
    "gemini-4-argon",
    "Gemini 4 Argon",
    "Google",
    "gemini",
    "gemini-4-argon",
    ["gemini-4-argon"],
    ["Gemini 4 Argon (High)"],
  ],
  [
    "claude-fable-5.1",
    "Claude Fable 5.1",
    "Anthropic",
    "anthropic",
    "claude-fable-5.1",
    variants("claude-fable-5-1"),
    ["Claude Fable 5.1 (Max)"],
  ],
  [
    "kimi-k3.1-pro",
    "Kimi K3.1 Pro",
    "Moonshot AI",
    "kimi",
    "kimi-k3.1-pro",
    ["kimi-k3-1-pro"],
    [],
  ],
  [
    "claude-haiku-5.5",
    "Claude Haiku 5.5",
    "Anthropic",
    "anthropic",
    "claude-haiku-5.5",
    variants("claude-haiku-5-5"),
    [],
  ],
  [
    "grok-4.7",
    "Grok 4.7",
    "xAI",
    "xai",
    "grok-4.7",
    variants("grok-4-7", ["", "-high", "-low"]),
    ["Grok 4.7 (xHigh)"],
  ],
  [
    "deepseek-v4.1-flash-1017",
    "DeepSeek V4.1 Flash 1017",
    "DeepSeek",
    "deepseek",
    "deepseek-v4.1-flash-1017",
    ["deepseek-v4-1-flash-1017"],
    [],
  ],
  // Arena currently marks Gemini 3.8 Flash preliminary. Keep its two established source results.
  [
    "gemini-3.8-flash",
    "Gemini 3.8 Flash",
    "Google",
    "gemini",
    "gemini-3.8-flash",
    variants("gemini-3-8-flash", ["", "-medium", "-low"]),
    [],
  ],
  [
    "mimo-v2.6-pro",
    "MiMo V2.6 Pro",
    "Xiaomi",
    "xiaomimimo",
    "mimo-v2.6-pro",
    ["mimo-v2-6-pro"],
    ["MiMo-V2.6-Pro"],
  ],
  [
    "minimax-m3.1-flash",
    "MiniMax M3.1 Flash",
    "MiniMax",
    "minimax",
    "minimax-m3.1-flash",
    ["minimax-m3-1-flash"],
    [],
  ],
  [
    "step-5-preview",
    "Step 5 Preview",
    "StepFun",
    "stepfun",
    "step-5-preview",
    ["step-5"],
    ["Step 5 Preview"],
  ],
  [
    "gpt-6-luna",
    "GPT-6 Luna",
    "OpenAI",
    "openai",
    "gpt-6-luna",
    variants("gpt-6-luna", [
      "",
      "-xhigh",
      "-high",
      "-medium",
      "-low",
      "-non-reasoning",
    ]),
    [],
  ],
  [
    "muse-spark-open",
    "Muse Spark Open",
    "Meta",
    "meta",
    "muse-spark-open",
    ["muse-spark-open"],
    [],
  ],
  [
    "qwen3.8-27b",
    "Qwen3.8 27B",
    "Alibaba",
    "qwen",
    "qwen3.8-27b",
    ["qwen3-8-27b"],
    [],
  ],
  [
    "nemotron-super-vl-3.5",
    "Nemotron 3.5 Super VL",
    "NVIDIA",
    "nvidia",
    "nemotron-super-vl-3.5",
    ["nemotron-3-5-super-vl"],
    [],
  ],
  [
    "inkling",
    "Inkling",
    "Thinking Machines",
    "",
    "inkling",
    ["inkling"],
    ["Inkling"],
  ],
  [
    "glm-5.3",
    "GLM-5.3",
    "Z.AI",
    "zhipu",
    null,
    variants("glm-5-3", ["", "-low"]),
    ["GLM-5.3 (Max)"],
  ],
  [
    "deepseek-v4-pro-0813",
    "DeepSeek V4 Pro 0813",
    "DeepSeek",
    "deepseek",
    null,
    ["deepseek-v4-pro"],
    ["DeepSeek-V4-Pro (High, 20260813)"],
  ],
  [
    "gpt-5.6-terra",
    "GPT-5.6 Terra",
    "OpenAI",
    "openai",
    "gpt-5.6-terra",
    [],
    ["GPT-5.6 Terra (xHigh)"],
  ],
  ["grok-4.6", "Grok 4.6", "xAI", "xai", "grok-4.6", [], ["Grok 4.6 (High)"]],
  [
    "muse-spark-1.3",
    "Muse Spark 1.3",
    "Meta",
    "meta",
    "muse-spark-1.3",
    [],
    ["Muse Spark 1.3 (Max)"],
  ],
  [
    "kimi-k3",
    "Kimi K3",
    "Moonshot AI",
    "kimi",
    "kimi-k3",
    [],
    ["Kimi K3 (Max)"],
  ],
  [
    "mistral-large-4",
    "Mistral Large 4",
    "Mistral AI",
    "mistral",
    "mistral-large-4",
    [],
    ["Mistral Large 4"],
  ],
  [
    "glm-5.3-flash",
    "GLM-5.3 Flash",
    "Z.AI",
    "zhipu",
    "glm-5.3-flash",
    [],
    ["GLM-5.3-Flash"],
  ],
];
const best = (rows, score) => [...rows].sort((a, b) => score(b) - score(a))[0];
const models = identities.map(
  ([id, name, provider, icon, lbId, aaSlugs, arenaNames]) => {
    const analysis = best(
      aa.models.filter((row) => aaSlugs.includes(row.slug)),
      (row) => row.intelligenceIndex,
    );
    const live = livebench.rows.find((row) => row.modelId === lbId);
    const preference = best(
      arena.text.rows.filter(
        (row) => arenaNames.includes(row.name) && !row.preliminary,
      ),
      (row) => row.score,
    );
    const measurements = {
      "artificial-analysis": analysis
        ? {
            score: analysis.intelligenceIndex,
            configuration: analysis.name,
            url: analysis.url,
          }
        : null,
      livebench: live
        ? {
            score: live.overall,
            configuration: `${live.name} (${live.effort})`,
            url: livebench.dataUrl,
          }
        : null,
      arena: preference
        ? {
            score: preference.score,
            configuration: preference.name,
            url: arena.text.url,
          }
        : null,
    };
    if (Object.values(measurements).filter(Boolean).length < 2) {
      throw new Error(
        `${id} no longer has two matched sources; review the identity map.`,
      );
    }
    return {
      id,
      name,
      provider,
      icon,
      openWeights: live?.openWeights ?? analysis?.isOpenWeights ?? false,
      measurements,
    };
  },
);
const snapshot = {
  retrievedAt: aa.retrievedAt,
  sources: [
    {
      id: "artificial-analysis",
      name: "Artificial Analysis",
      metric: "Intelligence Index",
      url: aa.url,
      updatedAt: null,
    },
    {
      id: "livebench",
      name: "LiveBench 2.0",
      metric: "Overall",
      url: "https://livebench.ai/",
      dataUrl: livebench.dataUrl,
      updatedAt: livebench.dataDate,
    },
    {
      id: "arena",
      name: "Arena",
      metric: "Text Overall",
      url: arena.text.url,
      updatedAt: arena.text.updatedAt,
    },
  ],
  models,
};
const destination = fileURLToPath(
  new URL("../../src/lib/data/ai-rankings.json", import.meta.url),
);
await mkdir(fileURLToPath(new URL("../../src/lib/data/", import.meta.url)), {
  recursive: true,
});
await writeFile(destination, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
console.log(`Wrote ${models.length} models to ${destination}`);
