import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopUsageSources } from "@/components/usage/DesktopUsageSources";
import { usageApi } from "@/lib/api/usage";
import { usageKeys } from "@/lib/query/usage";
import type { UsageSummary } from "@/types/usage";

vi.mock("@/lib/api/usage", () => ({
  usageApi: {
    getDataSourceBreakdown: vi.fn(),
    getUsageSummary: vi.fn(),
    syncSessionUsage: vi.fn(),
  },
}));

const summary = (overrides: Partial<UsageSummary> = {}): UsageSummary => ({
  totalRequests: 42,
  totalCost: "7.25",
  realTotalTokens: 12000,
  totalInputTokens: 8000,
  totalOutputTokens: 3000,
  totalCacheReadTokens: 1000,
  totalCacheCreationTokens: 0,
  cacheHitRate: 1 / 9,
  successRate: 100,
  unpricedRequests: 0,
  partialRequests: 0,
  cachePartialRequests: 0,
  reportedCostRequests: 20,
  estimatedCostRequests: 22,
  ...overrides,
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DesktopUsageSources />
    </QueryClientProvider>,
  );
  return client;
}

function lolicodeRow() {
  return screen
    .getByRole("heading", { name: "LoliCode", exact: true })
    .closest("li")!;
}

beforeEach(() => {
  vi.mocked(usageApi.getUsageSummary).mockResolvedValue(summary());
  vi.mocked(usageApi.getDataSourceBreakdown).mockResolvedValue([
    {
      dataSource: "workbuddy_session",
      appType: "workbuddy",
      requestCount: 291,
      totalCostUsd: "0",
      status: "recorded",
      unpricedRequests: 8,
      historicalRequests: 283,
    },
  ]);
  vi.mocked(usageApi.syncSessionUsage).mockResolvedValue({
    imported: 3,
    skipped: 0,
    filesScanned: 1,
    suspectedDuplicates: 0,
    deferredFiles: 0,
    errors: [],
  });
});

describe("DesktopUsageSources", () => {
  it("keeps five applications visible with LoliCode first in a keyboard-scrollable list", async () => {
    mount();
    const list = await screen.findByRole("list", {
      name: "应用累计用量列表",
    });
    expect(list).toHaveAttribute("tabindex", "0");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(
      within(rows[0]).getByRole("heading", { name: "LoliCode", exact: true }),
    ).toBeInTheDocument();
    for (const app of ["WorkBuddy", "DeepSeek Harness", "ZCode", "MiMo"]) {
      expect(
        within(list).getByRole("heading", { name: app, exact: true }),
      ).toBeInTheDocument();
    }
  });

  it("loads LoliCode cumulative usage independently and identifies mixed billing sources", async () => {
    mount();
    await waitFor(() => expect(lolicodeRow()).toHaveTextContent("$7.2500"));
    expect(usageApi.getUsageSummary).toHaveBeenCalledWith(
      undefined,
      undefined,
      "lolicode",
    );
    expect(usageApi.getDataSourceBreakdown).toHaveBeenCalledWith();
    expect(lolicodeRow()).toHaveTextContent("42");
    expect(lolicodeRow()).toHaveTextContent("混合费用");
    expect(lolicodeRow()).not.toHaveTextContent("291");
  });

  it("shows an explicit upstream zero charge without labelling it unpriced", async () => {
    vi.mocked(usageApi.getUsageSummary).mockResolvedValue(
      summary({
        totalRequests: 1,
        totalCost: "0",
        realTotalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        partialRequests: 1,
        reportedCostRequests: 1,
        estimatedCostRequests: 0,
      }),
    );
    mount();
    await waitFor(() => expect(lolicodeRow()).toHaveTextContent("$0.0000"));
    expect(lolicodeRow()).toHaveTextContent("渠道回报");
    expect(lolicodeRow()).not.toHaveTextContent("待定价");
  });

  it("retains the last successful LoliCode totals when a refresh fails", async () => {
    const client = mount();
    await waitFor(() => expect(lolicodeRow()).toHaveTextContent("$7.2500"));
    vi.mocked(usageApi.getUsageSummary).mockRejectedValueOnce(
      new Error("temporarily unavailable"),
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: usageKeys.all });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "本地应用用量来源" }),
      ).toHaveTextContent(/读取失败|暂时读取失败/),
    );
    expect(lolicodeRow()).toHaveTextContent("42");
    expect(lolicodeRow()).toHaveTextContent("$7.2500");
  });

  it("does not present missing usage and an unreported zero amount as free", async () => {
    vi.mocked(usageApi.getUsageSummary).mockResolvedValue(
      summary({
        totalRequests: 1,
        totalCost: "0",
        realTotalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        partialRequests: 1,
        reportedCostRequests: 0,
        estimatedCostRequests: 0,
      }),
    );
    mount();
    await waitFor(() =>
      expect(lolicodeRow()).toHaveTextContent("1 次用量待确认"),
    );
    expect(lolicodeRow()).not.toHaveTextContent("$0.0000");
    expect(lolicodeRow()).toHaveTextContent("费用待确认");
  });

  it("refreshes both app records and the LoliCode ledger after synchronizing", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(lolicodeRow()).toHaveTextContent("$7.2500"));
    const oldSourceCalls = vi.mocked(usageApi.getDataSourceBreakdown).mock.calls
      .length;
    const oldLedgerCalls = vi.mocked(usageApi.getUsageSummary).mock.calls
      .length;
    vi.mocked(usageApi.getUsageSummary).mockResolvedValue(
      summary({ totalRequests: 45, totalCost: "8.5" }),
    );
    await user.click(screen.getByRole("button", { name: "同步应用记录" }));
    await waitFor(() => expect(lolicodeRow()).toHaveTextContent("$8.5000"));
    expect(usageApi.syncSessionUsage).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(usageApi.getDataSourceBreakdown).mock.calls.length,
    ).toBeGreaterThan(oldSourceCalls);
    expect(
      vi.mocked(usageApi.getUsageSummary).mock.calls.length,
    ).toBeGreaterThan(oldLedgerCalls);
    expect(screen.getByRole("status")).toHaveTextContent("同步完成");
  });
});
