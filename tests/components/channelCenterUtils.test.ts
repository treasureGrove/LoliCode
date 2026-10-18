import { describe, expect, it } from "vitest";
import {
  channelErrorMessage,
  channelModelMetadata,
  mergeDiscoveredChannel,
  selectedChannelModels,
  withValidDefault,
} from "@/components/channels/channelCenterUtils";
import type {
  ChannelCenterSnapshot,
  ChannelSource,
} from "@/lib/api/channel-center";

const source: ChannelSource = {
  id: "source-a",
  name: "Source A",
  baseUrl: "https://api.example.com/v1",
  apiKey: "secret-value",
  authKind: "api_key",
  protocol: "openai_chat",
  enabled: true,
  models: [{ id: "same/model", supportsTools: true }],
};

describe("upstream model metadata descriptions", () => {
  it("shows the advertised windows and the selected default", () => {
    expect(
      channelModelMetadata(source, {
        id: "multi",
        contextLimit: 128000,
        contextLimits: [128000, 1000000],
        selectedContextLimit: 1000000,
      }),
    ).toContain("上下文 128,000 / 1,000,000 tokens（当前 1,000,000）");
  });
  it("distinguishes missing upstream metadata from a failed model test", () => {
    const description = channelModelMetadata(source, { id: "unlisted-name" });
    expect(description).toContain("上下文：上游未提供");
    expect(description).toContain("思考强度：上游未提供");
    expect(description).not.toContain("未验证");
    expect(description).not.toContain("128");
  });

  it("shows exact fetched context and reasoning values without inventing levels", () => {
    const description = channelModelMetadata(source, {
      id: "model",
      contextLimit: 922000,
      outputLimit: 8192,
      reasoningEfforts: ["none", "xhigh"],
      supportsTools: true,
    });
    expect(description).toContain("922,000 tokens");
    expect(description).toContain("8,192 tokens");
    expect(description).toContain("none / xhigh");
    expect(description).toContain("上游标注支持工具调用");
    expect(description).not.toContain("medium");
    expect(
      channelModelMetadata(source, { id: "fixed", reasoningEfforts: [] }),
    ).toContain("思考强度不可调");
  });
});

describe("channel catalog selection", () => {
  it("keeps a supported window choice on refresh and drops removed options", () => {
    const previous = {
      ...source,
      models: [
        {
          id: "same/model",
          contextLimit: 128000,
          contextLimits: [128000, 1000000],
          selectedContextLimit: 1000000,
        },
      ],
    };
    const fresh = {
      ...source,
      models: [
        {
          id: "same/model",
          contextLimit: 128000,
          contextLimits: [128000, 1000000],
        },
      ],
    };
    expect(
      mergeDiscoveredChannel(fresh, previous).models[0].selectedContextLimit,
    ).toBe(1000000);
    fresh.models[0].contextLimits = [128000];
    expect(
      mergeDiscoveredChannel(fresh, previous).models[0].selectedContextLimit,
    ).toBeUndefined();
  });
  it("keeps model selection while refreshed upstream metadata replaces old values", () => {
    const refreshed = mergeDiscoveredChannel(
      {
        ...source,
        models: [{ id: "same/model", reasoningEfforts: ["low"] }],
      },
      {
        ...source,
        models: [
          { id: "same/model", enabled: false, reasoningEfforts: ["max"] },
        ],
      },
    );
    expect(refreshed.models[0].enabled).toBe(false);
    expect(refreshed.models[0].reasoningEfforts).toEqual(["low"]);
  });
  it("keeps models with identical upstream IDs distinct and respects channel/model availability", () => {
    const snapshot: ChannelCenterSnapshot = {
      channels: [
        source,
        { ...source, id: "source-b" },
        { ...source, id: "disabled", enabled: false },
        {
          ...source,
          id: "incompatible",
          models: [{ id: "same/model", supportsTools: false }],
        },
      ],
      targets: ["opencode"],
      defaultModel: "disabled/same/model",
    };
    expect(selectedChannelModels(snapshot).map((item) => item.value)).toEqual([
      "source-a/same/model",
      "source-b/same/model",
    ]);
    expect(withValidDefault(snapshot).defaultModel).toBe("source-a/same/model");
  });

  it("preserves disabled selections and does not select newly discovered non-tool models", () => {
    const refreshed = mergeDiscoveredChannel(
      {
        ...source,
        models: [
          { id: "same/model", supportsTools: true },
          { id: "new-model" },
          { id: "embedding", supportsTools: false },
        ],
      },
      { ...source, models: [{ id: "same/model", enabled: false }] },
    );
    expect(refreshed.models.map((model) => [model.id, model.enabled])).toEqual([
      ["same/model", false],
      ["new-model", true],
      ["embedding", false],
    ]);
  });

  it("replaces raw upstream errors with useful messages without exposing credentials", () => {
    expect(
      channelErrorMessage("Unauthorized secret-value", ["secret-value"]),
    ).toBe("没有访问权限，请检查 API Key 或重新登录账号。");
    expect(
      channelErrorMessage("请求失败 https://user:secret-value@host/x", [
        "secret-value",
      ]),
    ).not.toContain("secret-value");
    expect(
      channelErrorMessage({ request: { apiKey: "secret-value" } }, [
        "secret-value",
      ]),
    ).toBe("操作未完成，请检查地址、密钥或账号后重试。");
  });
});
