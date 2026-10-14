import { describe, expect, it } from "vitest";
import {
  channelErrorMessage,
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

describe("channel catalog selection", () => {
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
