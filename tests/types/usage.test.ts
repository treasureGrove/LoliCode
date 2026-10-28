import { describe, expect, it } from "vitest";
import { getCacheWriteAvailability, isUnpricedUsage } from "@/types/usage";

describe("getCacheWriteAvailability", () => {
  it("distinguishes cache-write support across fixed protocols", () => {
    expect(getCacheWriteAvailability(["claude"])).toBe("ok");
    expect(getCacheWriteAvailability(["pi"])).toBe("partial");
    expect(getCacheWriteAvailability(["codex", "gemini"])).toBe("na");
    expect(getCacheWriteAvailability(["claude", "codex"])).toBe("partial");
    expect(getCacheWriteAvailability([])).toBe("ok");
  });
});

describe("isUnpricedUsage", () => {
  it("keeps an authoritative upstream zero while preserving unknown legacy zero behavior", () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: "0",
      statusCode: 200,
      costMultiplier: "3",
    };
    expect(isUnpricedUsage({ ...usage, costSource: "upstream" })).toBe(false);
    expect(isUnpricedUsage(usage)).toBe(true);
    expect(isUnpricedUsage({ ...usage, costSource: "unknown" })).toBe(true);
    expect(isUnpricedUsage({ ...usage, costSource: "local" })).toBe(true);
    expect(isUnpricedUsage({ ...usage, costMultiplier: "0" })).toBe(false);
  });
});
