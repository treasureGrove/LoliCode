import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AgentModelIcon,
  resolveAgentModelBrand,
} from "@/features/agent/AgentModelIcon";
import type { AgentModel } from "@/types/agent";

const model = (patch: Partial<AgentModel> = {}): AgentModel => ({
  id: "opaque-engine-identity",
  providerId: "lolicode",
  modelId: "unknown-model",
  name: "Relay · Custom model",
  channelName: "Relay",
  ...patch,
});

describe("AgentModelIcon", () => {
  it.each([
    ["gateway/openai/gpt-6.1", "openai"],
    ["gateway/o3-pro", "openai"],
    ["gateway/anthropic/claude-sonnet-5", "claude"],
    ["us.anthropic.claude-opus-4-6-v1:0", "claude"],
    ["gateway/DeepSeek-V3.2", "deepseek"],
    ["google/gemini-3-pro", "gemini"],
    ["Qwen/Qwen3-Coder-Next", "qwen"],
    ["moonshotai/Kimi-K2.5", "kimi"],
    ["z-ai/glm-5.3-flash", "zhipu"],
    ["x-ai/grok-4", "grok"],
    ["MiniMaxAI/MiniMax-M3", "minimax"],
    ["deepseek-ai/DeepSeek-R1-Distill-GPT", "deepseek"],
  ])("recognizes the actual family in namespaced model %s", (modelId, icon) => {
    expect(resolveAgentModelBrand(model({ modelId }))?.icon).toBe(icon);
  });

  it("uses the actual model before a contradictory gateway vendor", () => {
    expect(
      resolveAgentModelBrand(
        model({
          modelId: "relay/claude-sonnet-5",
          providerId: "openai",
          channelName: "ChatGPT",
          name: "ChatGPT · Claude Sonnet 5",
        }),
      )?.icon,
    ).toBe("claude");
    expect(
      resolveAgentModelBrand(
        model({
          modelId: "relay/custom-alias",
          channelName: "ChatGPT",
          name: "ChatGPT · DeepSeek V3",
        }),
      )?.icon,
    ).toBe("deepseek");
  });

  it("strips the channel label and route prefix before inferring a model brand", () => {
    expect(
      resolveAgentModelBrand(
        model({
          modelId: "gpt-proxy/custom-alias",
          channelName: "Claude Proxy",
          name: "Claude Proxy · Gemini 3 Pro",
        }),
      )?.icon,
    ).toBe("gemini");
  });

  it("can identify a login channel when no family metadata is available", () => {
    expect(
      resolveAgentModelBrand(
        model({
          modelId: "account/auto",
          channelName: "ChatGPT · account@example.test",
          name: "ChatGPT · account@example.test · Auto",
        }),
      )?.icon,
    ).toBe("openai");
    expect(
      resolveAgentModelBrand(
        model({ providerId: "anthropic", channelName: "ChatGPT" }),
      )?.icon,
    ).toBe("claude");
  });

  it("does not guess from opaque identities or unrelated substrings", () => {
    expect(
      resolveAgentModelBrand(
        model({
          id: "openai/gpt-6.1",
          modelId: "mygptmodel",
          name: "Claudeish spreadsheet",
          channelName: "team-openai-notes",
        }),
      ),
    ).toBeUndefined();
    expect(resolveAgentModelBrand()).toBeUndefined();
  });

  it("renders a local decorative logo at the requested size and a neutral unknown fallback", () => {
    const { container, rerender } = render(
      <AgentModelIcon model={model({ modelId: "gpt-6.1" })} size={14} />,
    );
    const logo = container.querySelector('[data-model-provider="openai"]');
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo).toHaveStyle({ width: "14px", height: "14px" });
    expect(logo?.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    rerender(<AgentModelIcon model={model()} />);
    expect(
      container.querySelector('[data-model-provider="unknown"] svg'),
    ).not.toBeNull();
  });
});
