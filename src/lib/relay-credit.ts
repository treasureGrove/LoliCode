import type {
  LolicodeCreditPricing,
  LolicodeRelayStatus,
} from "@/lib/api/lolicode-account";

type RelayQuota = LolicodeRelayStatus["quota"];

/** Canonical server balance wins; older explicit Credit fields remain readable. */
export function relayCreditQuota(quota: RelayQuota) {
  if (quota.creditBalance !== undefined) {
    const balance = quota.creditBalance;
    if (
      !balance ||
      balance.unit !== "Credit" ||
      [balance.limit, balance.used, balance.reserved, balance.remaining].some(
        (value) =>
          typeof value !== "number" || !Number.isFinite(value) || value < 0,
      ) ||
      [balance.pricingRevision, balance.ledgerRevision].some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      )
    )
      return null;
    return {
      limit: balance.limit,
      used: balance.used,
      reserved: balance.reserved,
      remaining: balance.remaining,
    };
  }
  const fields = [
    "creditLimit",
    "creditsUsed",
    "creditsReserved",
    "creditsRemaining",
  ] as const;
  const values = fields.map((field) => quota[field]);
  if (
    quota.creditUnit !== "Credit" ||
    values.some(
      (value) =>
        typeof value !== "number" || !Number.isFinite(value) || value < 0,
    )
  )
    return null;
  const [limit, used, reserved, remaining] = values as number[];
  return { limit, used, reserved, remaining };
}

export function formatCredit(value: number, locale: string) {
  if (value > 0 && value < 0.01)
    return `<${(0.01).toLocaleString(locale, { maximumFractionDigits: 2 })}`;
  return value.toLocaleString(locale, { maximumFractionDigits: 2 });
}

export function modelCreditPricing(
  model: LolicodeRelayStatus["models"][number],
): LolicodeCreditPricing | null {
  const pricing = model.creditPricing;
  const valid = (value: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (pricing !== undefined) {
    if (!pricing || pricing.unit !== "Credit") return null;
    if (pricing.mode === "request")
      return valid(pricing.creditsPerRequest) ? pricing : null;
    return pricing.mode === "tokens" &&
      pricing.perTokens === 1_000_000 &&
      [
        pricing.prices?.input,
        pricing.prices?.output,
        pricing.prices?.cacheRead,
        pricing.prices?.cacheWrite,
      ].every(valid)
      ? pricing
      : null;
  }
  const rates = model.creditRate;
  if (
    !rates ||
    ![rates.input, rates.output, rates.cacheRead, rates.cacheWrite].every(valid)
  )
    return null;
  return {
    unit: "Credit",
    mode: "tokens",
    perTokens: 1_000_000,
    prices: {
      input: rates.input * 1000,
      output: rates.output * 1000,
      cacheRead: rates.cacheRead * 1000,
      cacheWrite: rates.cacheWrite * 1000,
    },
  };
}
