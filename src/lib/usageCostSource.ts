type UsageCostSources = {
  reportedCostRequests?: number;
  estimatedCostRequests?: number;
};

const validCount = (value?: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Older ledgers do not identify the origin of their amounts. */
export function usageCostSource(
  value: UsageCostSources,
  totalRequests: number,
) {
  const reported = value.reportedCostRequests;
  const estimated = value.estimatedCostRequests;
  if (
    !validCount(reported) ||
    !validCount(estimated) ||
    !validCount(totalRequests) ||
    reported + estimated > totalRequests
  ) {
    return { known: false, allReported: false, label: "估算费用", detail: "" };
  }
  const unknown = totalRequests - reported - estimated;
  const allReported = totalRequests > 0 && reported === totalRequests;
  const label = allReported
    ? "渠道回报"
    : totalRequests > 0 && estimated === totalRequests
      ? "本地估算"
      : reported > 0 && estimated > 0
        ? "混合费用"
        : "费用";
  const detail = [
    reported ? `${reported.toLocaleString("zh-CN")} 次渠道回报` : "",
    estimated ? `${estimated.toLocaleString("zh-CN")} 次本地估算` : "",
    unknown ? `${unknown.toLocaleString("zh-CN")} 次费用来源未区分` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { known: true, allReported, label, detail };
}
