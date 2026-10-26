import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SimpleUsagePage } from "@/components/usage/SimpleUsagePage";
import { usageApi } from "@/lib/api/usage";
import { channelCenterApi } from "@/lib/api/channel-center";
import type { ProviderStats } from "@/types/usage";

vi.mock("@/lib/api/usage", () => ({
  usageApi: {
    getUsageSummary: vi.fn(),
    getProviderStats: vi.fn(),
    getUsageFirstDate: vi.fn(),
    getUsageTrends: vi.fn(),
    getDataSourceBreakdown: vi.fn().mockResolvedValue([]),
    syncSessionUsage: vi.fn(),
  },
}));
vi.mock("@/lib/api/channel-center", () => ({
  channelCenterApi: { get: vi.fn(), listUsageLabels: vi.fn() },
}));
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SimpleUsagePage />
      </QueryClientProvider>,
    ),
  };
}
beforeEach(() => {
  vi.mocked(usageApi.getDataSourceBreakdown).mockResolvedValue([]);
  vi.mocked(usageApi.getUsageFirstDate).mockResolvedValue(null);
  vi.mocked(usageApi.getUsageTrends).mockResolvedValue([]);
  vi.mocked(usageApi.getUsageSummary).mockResolvedValue({
    totalRequests: 4,
    totalCost: "0.1234",
    realTotalTokens: 2200,
    successRate: 75,
    totalInputTokens: 1200,
    totalOutputTokens: 1000,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    cacheHitRate: 0,
  });
  vi.mocked(usageApi.getProviderStats).mockResolvedValue([]);
  vi.mocked(channelCenterApi.get).mockResolvedValue({
    channels: [],
    targets: [],
  });
  vi.mocked(channelCenterApi.listUsageLabels).mockResolvedValue([]);
});
describe("basic usage", () => {
  it("keeps historical app usage visible after detail pruning without claiming an unknown history price is free", async () => {
    vi.mocked(usageApi.getDataSourceBreakdown).mockResolvedValue([
      {
        dataSource: "workbuddy_session",
        appType: "workbuddy",
        status: "recorded",
        requestCount: 3,
        totalCostUsd: "0",
        historicalRequests: 3,
        unpricedRequests: 0,
      },
    ]);
    mount();
    const sources = within(
      screen.getByRole("region", { name: "本地应用用量来源" }),
    );
    expect(await sources.findByText(/3 次历史汇总/)).toBeInTheDocument();
    expect(sources.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(
      sources.queryByText("已检测到，等待请求用量"),
    ).not.toBeInTheDocument();
  });
  it("shows desktop agent sources without presenting unpriced requests as free", async () => {
    vi.mocked(usageApi.getDataSourceBreakdown).mockResolvedValue([
      {
        dataSource: "workbuddy_session",
        appType: "workbuddy",
        status: "recorded",
        requestCount: 3,
        totalCostUsd: "0",
        unpricedRequests: 3,
        cachePartialRequests: 3,
      },
      {
        dataSource: "mimocode_session",
        appType: "mimocode",
        status: "not_found",
        requestCount: 0,
        totalCostUsd: "0",
      },
    ]);
    mount();
    const sources = within(
      screen.getByRole("region", { name: "本地应用用量来源" }),
    );
    expect(await sources.findByText(/3 次待定价/)).toBeInTheDocument();
    expect(sources.getByText("未发现本地记录")).toBeInTheDocument();
    expect(sources.getByText("DeepSeek Harness")).toBeInTheDocument();
    expect(sources.getByText("ZCode")).toBeInTheDocument();
    expect(sources.queryByText(/\$0\.00/)).not.toBeInTheDocument();
  });

  it("syncs app logs and refreshes the aggregate", async () => {
    vi.mocked(usageApi.syncSessionUsage).mockResolvedValue({
      imported: 1,
      skipped: 0,
      filesScanned: 1,
      suspectedDuplicates: 0,
      deferredFiles: 0,
      errors: [],
    });
    mount();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "同步应用记录" }));
    await waitFor(() => expect(usageApi.syncSessionUsage).toHaveBeenCalled());
    await waitFor(() =>
      expect(usageApi.getDataSourceBreakdown).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已更新 1 条用量记录",
    );
  });
  it("keeps recorded daily data if the first-date background refresh fails", async () => {
    vi.mocked(usageApi.getUsageFirstDate).mockResolvedValue("2024-01-01");
    const { client } = mount();
    expect(
      await screen.findAllByRole("button", { name: /0 Tokens · 0 次请求/ }),
    ).not.toHaveLength(0);
    vi.mocked(usageApi.getUsageFirstDate).mockRejectedValue(
      new Error("refresh failed"),
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["usage", "first-date"] });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "正在显示上次记录",
    );
    expect(
      screen.getAllByRole("button", { name: /0 Tokens · 0 次请求/ }),
    ).not.toHaveLength(0);
  });
  it("renders daily usage squares with real totals and keyboard-accessible details", async () => {
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    vi.mocked(usageApi.getUsageFirstDate).mockResolvedValue(day);
    vi.mocked(usageApi.getUsageTrends).mockResolvedValue([
      {
        date: day,
        requestCount: 7,
        totalCost: "0.15",
        totalTokens: 2500,
        totalInputTokens: 500,
        totalOutputTokens: 600,
        totalCacheReadTokens: 1300,
        totalCacheCreationTokens: 100,
      },
    ]);
    mount();
    const cell = await screen.findByRole("button", {
      name: /2,500 Tokens · 7 次请求/,
    });
    expect(cell).toHaveStyle({ backgroundColor: "var(--heat-1)" });
    fireEvent.focus(cell);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("2,500");
    expect(usageApi.getUsageTrends).toHaveBeenCalled();
  });
  it("shows a daily-data failure instead of an empty fabricated heatmap and can retry", async () => {
    vi.mocked(usageApi.getUsageFirstDate).mockRejectedValue(
      new Error("daily read failed"),
    );
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "每日用量暂时加载失败",
    );
    expect(
      screen.queryByRole("button", { name: /Tokens · .*次请求/ }),
    ).not.toBeInTheDocument();
    vi.mocked(usageApi.getUsageFirstDate).mockResolvedValue(null);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "重试每日用量" }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(
      await screen.findAllByRole("button", { name: /0 Tokens · 0 次请求/ }),
    ).not.toHaveLength(0);
  });
  it("labels recorded gateway usage with its shared source name", async () => {
    vi.mocked(channelCenterApi.listUsageLabels).mockResolvedValue([
      { providerId: "channel-fixture", name: "工作用 DeepSeek" },
    ]);
    vi.mocked(usageApi.getProviderStats).mockResolvedValue([
      {
        providerId: "channel-fixture",
        providerName: "channel-fixture",
        appType: "channel-gateway",
        requestCount: 4,
        totalTokens: 2200,
        totalCost: "0.1234",
      } as Awaited<ReturnType<typeof usageApi.getProviderStats>>[number],
    ]);
    mount();
    expect(await screen.findByText("工作用 DeepSeek")).toBeInTheDocument();
    expect(screen.getByText("通用渠道网关")).toBeInTheDocument();
    expect(screen.queryByText("channel-fixture")).not.toBeInTheDocument();
    expect(channelCenterApi.get).not.toHaveBeenCalled();
  });
  it("shows actual recorded metrics and changes the selected period", async () => {
    mount();
    expect(await screen.findByText("$0.1234")).toBeInTheDocument();
    expect(screen.getByText("75.0%")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() =>
      expect(usageApi.getUsageSummary).toHaveBeenLastCalledWith(
        undefined,
        expect.any(Number),
      ),
    );
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  it("queries the last 30 calendar days from local midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date(2026, 10, 5, 15, 24, 30);
    vi.setSystemTime(now);
    try {
      mount();
      expect(await screen.findByText("$0.1234")).toBeInTheDocument();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "近 30 天" }));
      const start = new Date(2026, 9, 7, 0, 0, 0);
      await waitFor(() =>
        expect(usageApi.getUsageSummary).toHaveBeenLastCalledWith(
          Math.floor(start.getTime() / 1000),
          Math.floor(now.getTime() / 1000),
        ),
      );
      expect(usageApi.getProviderStats).toHaveBeenLastCalledWith(
        Math.floor(start.getTime() / 1000),
        Math.floor(now.getTime() / 1000),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps the last recorded summary visible after a background refresh fails", async () => {
    const { client } = mount();
    expect(await screen.findByText("$0.1234")).toBeInTheDocument();
    vi.mocked(usageApi.getUsageSummary).mockRejectedValue(
      new Error("background summary read failed"),
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["channel-center-usage"] });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "正在显示上次记录",
    );
    expect(screen.getByText("$0.1234")).toBeInTheDocument();
    expect(screen.getByText("75.0%")).toBeInTheDocument();
  });
  it("keeps summary metrics available when channel details fail to load", async () => {
    vi.mocked(usageApi.getProviderStats).mockRejectedValue(
      new Error("provider statistics read failed"),
    );
    mount();
    expect(await screen.findByText("$0.1234")).toBeInTheDocument();
    expect(screen.getByText("75.0%")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("渠道明细");
    expect(usageApi.getUsageSummary).toHaveBeenCalled();
  });
  it("searches resolved channel and app names and orders channels by the selected metric", async () => {
    const providers: ProviderStats[] = [
      {
        providerId: "channel-deepseek",
        providerName: "channel-deepseek",
        appType: "channel-gateway",
        requestCount: 12,
        totalTokens: 2500,
        totalCost: "0.33",
        successRate: 100,
        avgLatencyMs: 1250,
      },
      {
        providerId: "claude-main",
        providerName: "Anthropic",
        appType: "claude",
        requestCount: 8,
        totalTokens: 12000,
        totalCost: "0.55",
        successRate: 87.5,
        avgLatencyMs: 2100,
      },
      {
        providerId: "workbuddy-session",
        providerName: "本机会话",
        appType: "workbuddy",
        requestCount: 5,
        totalTokens: 40000,
        totalCost: "0.25",
        successRate: 100,
        avgLatencyMs: 3200,
      },
    ];
    vi.mocked(usageApi.getProviderStats).mockResolvedValue(providers);
    vi.mocked(channelCenterApi.listUsageLabels).mockResolvedValue([
      { providerId: "channel-deepseek", name: "工作用 DeepSeek" },
    ]);
    mount();
    const table = await screen.findByRole("table", { name: "各渠道用量" });
    const providerNames = ["工作用 DeepSeek", "Anthropic", "本机会话"];
    const visibleProviderOrder = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) =>
          providerNames.find((name) => within(row).queryByText(name)),
        );
    expect(visibleProviderOrder()).toEqual(providerNames);
    const user = userEvent.setup();
    const search = screen.getByLabelText("搜索渠道或应用");
    await user.type(search, "工作用");
    expect(visibleProviderOrder()).toEqual(["工作用 DeepSeek"]);
    await user.clear(search);
    await user.type(search, "workbuddy");
    expect(visibleProviderOrder()).toEqual(["本机会话"]);
    await user.clear(search);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "渠道排序" }),
      "tokens",
    );
    expect(visibleProviderOrder()).toEqual([
      "本机会话",
      "Anthropic",
      "工作用 DeepSeek",
    ]);
  });
  it("reports a read failure instead of displaying fabricated zero usage", async () => {
    vi.mocked(usageApi.getUsageSummary).mockRejectedValue(
      new Error("database read failed"),
    );
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("加载失败");
    expect(screen.queryByText("$0.0000")).not.toBeInTheDocument();
    vi.mocked(usageApi.getUsageSummary).mockResolvedValue({
      totalRequests: 4,
      totalCost: "0.1234",
      realTotalTokens: 2200,
      successRate: 75,
    } as Awaited<ReturnType<typeof usageApi.getUsageSummary>>);
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("$0.1234")).toBeInTheDocument();
  });
});
