import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageHero } from "@/features/usage/UsageHero";

const summaryQuery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/query/usage", () => ({ useUsageSummaryByApp: summaryQuery }));
const summary = {
  totalRequests: 12,
  totalCost: "4.500000",
  totalInputTokens: 100,
  totalOutputTokens: 25,
  totalCacheCreationTokens: 10,
  totalCacheReadTokens: 50,
  successRate: 100,
  realTotalTokens: 185,
  cacheHitRate: 0.3125,
};
const values = {
  range: { preset: "today" } as const,
  appType: "claude",
  refreshIntervalMs: 30000,
};

beforeEach(() => {
  summaryQuery.mockReset();
});

describe("usage metric states", () => {
  it("shows unavailable metrics instead of inventing zeroes after an initial load failure", () => {
    summaryQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    render(<UsageHero {...values} />);
    expect(screen.getAllByText("--")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: /usage.metrics.more/ }));
    expect(screen.getAllByText("--")).toHaveLength(8);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
  it("retains the expanded metric context while refreshed data arrives", () => {
    summaryQuery.mockReturnValue({
      data: [{ appType: "claude", summary }],
      isLoading: false,
      isError: false,
    });
    const { rerender } = render(<UsageHero {...values} />);
    const disclosure = screen.getByRole("button", {
      name: /usage.metrics.more/,
    });
    fireEvent.click(disclosure);
    expect(screen.getByText("usage.freshInput")).toBeInTheDocument();
    summaryQuery.mockReturnValue({
      data: [
        { appType: "claude", summary: { ...summary, totalCost: "6.500000" } },
      ],
      isLoading: false,
      isError: false,
    });
    rerender(<UsageHero {...values} />);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("$6.50")).toBeInTheDocument();
    expect(screen.getByText("usage.freshInput")).toBeInTheDocument();
  });
});
