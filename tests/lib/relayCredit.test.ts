import { describe, expect, it } from "vitest";
import {
  formatCredit,
  modelCreditPricing,
  relayCreditQuota,
} from "@/lib/relay-credit";
import type { LolicodeRelayStatus } from "@/lib/api/lolicode-account";

const quota: LolicodeRelayStatus["quota"] = {
  day: "2026-10-30",
  timezone: "Asia/Singapore",
  resetsAt: "2026-10-31T00:00:00+08:00",
  requestLimit: 20,
  requestsUsed: 3,
  requestsRemaining: 17,
  tokenLimit: 100000,
  tokensUsed: 1200,
  tokensReserved: 800,
  tokensRemaining: 98000,
  creditUnit: "Credit",
  creditLimit: 100,
  creditsUsed: 1.2,
  creditsReserved: 0.8,
  creditsRemaining: 98,
};

describe("public Credit snapshots", () => {
  it("reads older explicit Credit snapshots without subtracting reservations twice", () => {
    expect(relayCreditQuota(quota)).toEqual({
      limit: 100,
      used: 1.2,
      reserved: 0.8,
      remaining: 98,
    });
  });

  it("does not infer a Credit balance from raw tokens", () => {
    expect(
      relayCreditQuota({
        ...quota,
        creditUnit: undefined,
        creditLimit: undefined,
        creditsUsed: undefined,
        creditsReserved: undefined,
        creditsRemaining: undefined,
      }),
    ).toBeNull();
  });

  it("prefers the canonical server balance even when compatibility fields disagree", () => {
    expect(
      relayCreditQuota({
        ...quota,
        creditsRemaining: 0,
        tokensRemaining: 0,
        creditBalance: {
          unit: "Credit",
          limit: 200,
          used: 30,
          reserved: 10,
          remaining: 160,
          pricingRevision: 5,
          ledgerRevision: 12,
        },
      }),
    ).toEqual({ limit: 200, used: 30, reserved: 10, remaining: 160 });
  });

  it("trusts the complete Credit snapshot instead of recomputing it from tokens", () => {
    expect(
      relayCreditQuota({
        ...quota,
        creditUnit: "Credit",
        creditLimit: 200,
        creditsUsed: 39,
        creditsReserved: 1,
        creditsRemaining: 160,
      }),
    ).toEqual({
      limit: 200,
      used: 39,
      reserved: 1,
      remaining: 160,
    });
  });

  it("does not fall back to token accounting for partial or invalid Credit snapshots", () => {
    expect(
      relayCreditQuota({
        ...quota,
        creditLimit: undefined,
        creditsRemaining: 10,
      }),
    ).toBeNull();
    expect(
      relayCreditQuota({ ...quota, creditsRemaining: Number.NaN }),
    ).toBeNull();
    expect(
      relayCreditQuota({
        ...quota,
        creditBalance: {
          unit: "Credit",
          limit: 200,
          used: 30,
          reserved: 10,
          remaining: 160,
          pricingRevision: Number.NaN,
          ledgerRevision: 12,
        },
      }),
    ).toBeNull();
    expect(
      relayCreditQuota({
        ...quota,
        creditUnit: "Credit",
        creditLimit: 100,
        creditsUsed: 0,
        creditsReserved: 0,
        creditsRemaining: -1,
      }),
    ).toBeNull();
  });

  it("shows at most two decimals without presenting tiny charges as free", () => {
    expect(formatCredit(1.234567, "en")).toBe("1.23");
    expect(formatCredit(0.000001, "en")).toBe("<0.01");
    expect(formatCredit(0, "en")).toBe("0");
  });

  it("keeps canonical per-million and legacy per-request quotes in Credit", () => {
    expect(
      modelCreditPricing({
        id: "token-model",
        creditRate: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        creditPricing: {
          unit: "Credit",
          mode: "tokens",
          perTokens: 1_000_000,
          prices: { input: 22, output: 88, cacheRead: 2.2, cacheWrite: 22 },
        },
      }),
    ).toEqual({
      unit: "Credit",
      mode: "tokens",
      perTokens: 1_000_000,
      prices: { input: 22, output: 88, cacheRead: 2.2, cacheWrite: 22 },
    });
    expect(
      modelCreditPricing({
        id: "request-model",
        creditPricing: {
          unit: "Credit",
          mode: "request",
          creditsPerRequest: 0.25,
        },
      }),
    ).toEqual({ unit: "Credit", mode: "request", creditsPerRequest: 0.25 });
  });
});
