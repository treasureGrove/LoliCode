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
  it("labels recorded upstream charges separately from missing token usage", async () => {
    vi.mocked(usageApi.getUsageSummary).mockResolvedValue({
      totalRequests: 1,
      totalCost: "0",
      realTotalTokens: 0,
      successRate: 100,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      cacheHitRate: 0,
      unpricedRequests: 0,
      partialRequests: 1,
      cachePartialRequests: 0,
      reportedCostRequests: 1,
      estimatedCostRequests: 0,
    });
    mount();
    const heading = await screen.findByText("渠道回报（美元）");
    const card = heading.closest(".lolicode-usage-metric")!;
    expect(
      within(card as HTMLElement).getByText("$0.0000"),
    ).toBeInTheDocument();
    expect(card).toHaveTextContent("1 次渠道回报 · 1 次用量待回报");
    expect(within(card as HTMLElement).queryByText("待定价")).toBeNull();
  });

  it("explains mixed billing sources in overview and channel rows", async () => {
    vi.mocked(usageApi.getUsageSummary).mockResolvedValue({
      totalRequests: 4,
      totalCost: "0.1234",
      realTotalTokens: 2200,
      successRate: 100,
      totalInputTokens: 1200,
      totalOutputTokens: 1000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      cacheHitRate: 0,
      reportedCostRequests: 1,
      estimatedCostRequests: 3,
    });
    vi.mocked(usageApi.getProviderStats).mockResolvedValue([
      {
        providerId: "channel-reported",
        providerName: "回报渠道",
        appType: "lolicode",
        requestCount: 1,
        totalTokens: 100,
        totalCost: "0.02",
        successRate: 100,
        avgLatencyMs: 10,
        reportedCostRequests: 1,
        estimatedCostRequests: 0,
      },
    ]);
    mount();
    await screen.findByText("混合费用（美元）");
    expect(screen.getByText("1 次渠道回报 · 3 次本地估算")).toBeInTheDocument();
    const row = await screen.findByRole("row", { name: /回报渠道/ });
    expect(within(row).getByText("渠道回报")).toHaveAttribute(
      "title",
      "1 次渠道回报",
    );
  });

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
    expect(
      within(screen.getByRole("table", { name: "各渠道用量" })).getByText(
        "通用渠道网关",
      ),
    ).toBeInTheDocument();
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
  it("combines independent Agent and shared channel filters across metrics, rows and daily activity", async () => {
    const data: ProviderStats[] = [
      {
        providerId: "channel-shared",
        providerName: "shared",
        appType: "lolicode",
        requestCount: 3,
        totalTokens: 900,
        totalCost: "0.3",
        successRate: 100,
        avgLatencyMs: 100,
      },
      {
        providerId: "channel-shared",
        providerName: "shared",
        appType: "codex",
        requestCount: 2,
        totalTokens: 400,
        totalCost: "0.2",
        successRate: 100,
        avgLatencyMs: 100,
      },
      {
        providerId: "other",
        providerName: "Other",
        appType: "lolicode",
        requestCount: 1,
        totalTokens: 100,
        totalCost: "0.1",
        successRate: 100,
        avgLatencyMs: 100,
      },
    ];
    const select = (app?: string, encoded?: string) => {
      const source = encoded
        ? (JSON.parse(encoded.slice("@provider:v1:".length)) as [
            string,
            string,
          ])
        : null;
      return data.filter(
        (row) =>
          (!app || row.appType === app) &&
          (!source ||
            (row.providerId === source[0] &&
              (source[1] === "*" || row.appType === source[1]))),
      );
    };
    vi.mocked(usageApi.getProviderStats).mockImplementation(
      async (_from, _to, app, provider) => select(app, provider),
    );
    vi.mocked(usageApi.getUsageSummary).mockImplementation(
      async (_from, _to, app, provider) => {
        const rows = select(app, provider);
        return {
          totalRequests: rows.reduce((sum, row) => sum + row.requestCount, 0),
          totalCost: rows
            .reduce((sum, row) => sum + Number(row.totalCost), 0)
            .toString(),
          realTotalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          cacheHitRate: 0,
          successRate: 100,
        };
      },
    );
    vi.mocked(channelCenterApi.listUsageLabels).mockResolvedValue([
      { providerId: "channel-shared", name: "共享模型渠道" },
    ]);
    mount();
    const user = userEvent.setup();
    const encoded = '@provider:v1:["channel-shared","*"]';
    const agent = screen.getByRole("combobox", { name: "按 Agent 筛选" });
    const channel = screen.getByRole("combobox", { name: "按渠道筛选" });
    await screen.findByRole("option", { name: "共享模型渠道 · 共享渠道" });
    await user.selectOptions(channel, encoded);
    await waitFor(() =>
      expect(usageApi.getUsageSummary).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.any(Number),
        undefined,
        encoded,
      ),
    );
    await user.selectOptions(agent, "lolicode");
    await waitFor(() =>
      expect(usageApi.getUsageSummary).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.any(Number),
        "lolicode",
        encoded,
      ),
    );
    await waitFor(() => expect(screen.getAllByText("$0.3000")).toHaveLength(2));
    await waitFor(() =>
      expect(
        within(screen.getByRole("table", { name: "各渠道用量" })).getAllByRole(
          "row",
        ),
      ).toHaveLength(2),
    );
    expect(channel).toHaveValue(encoded);
    expect(
      within(channel).getByRole("option", { name: "Other · LoliCode" }),
    ).toBeInTheDocument();
    expect(usageApi.getUsageFirstDate).toHaveBeenLastCalledWith(
      "lolicode",
      encoded,
      undefined,
    );
    await waitFor(() =>
      expect(usageApi.getUsageTrends).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.any(Number),
        "lolicode",
        encoded,
        undefined,
      ),
    );
    await user.selectOptions(agent, "codex");
    expect(channel).toHaveValue(encoded);
    await waitFor(() =>
      expect(usageApi.getProviderStats).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.any(Number),
        "codex",
        encoded,
      ),
    );
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(agent).toHaveValue("all");
    expect(channel).toHaveValue("");
    await waitFor(() =>
      expect(usageApi.getUsageSummary).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.any(Number),
      ),
    );
  });
  it("keeps same-name provider identities separate and retains a selected channel when changing period", async () => {
    const first: ProviderStats = {
      providerId: "one",
      providerName: "同名渠道",
      appType: "codex",
      requestCount: 1,
      totalTokens: 10,
      totalCost: "0.01",
      successRate: 100,
      avgLatencyMs: 1,
    };
    const second = { ...first, providerId: "two" };
    vi.mocked(usageApi.getProviderStats).mockResolvedValue([first, second]);
    mount();
    const user = userEvent.setup();
    const channel = screen.getByRole("combobox", { name: "按渠道筛选" });
    await screen.findByRole("option", { name: /同名渠道.*（one）/ });
    expect(
      within(channel).getByRole("option", { name: /同名渠道.*（two）/ }),
    ).toBeInTheDocument();
    const encoded = '@provider:v1:["one","codex"]';
    await user.selectOptions(channel, encoded);
    await waitFor(() =>
      expect(usageApi.getProviderStats).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.any(Number),
        undefined,
        encoded,
      ),
    );
    vi.mocked(usageApi.getProviderStats).mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() =>
      expect(usageApi.getProviderStats).toHaveBeenLastCalledWith(
        undefined,
        expect.any(Number),
        undefined,
        encoded,
      ),
    );
    expect(channel).toHaveValue(encoded);
    expect(
      within(channel).getByRole("option", { selected: true }),
    ).toHaveTextContent("同名渠道");
    expect(
      await screen.findByText("当前 Agent 与渠道组合没有用量记录。"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(channel).toHaveValue("");
  });
  it("labels missing prices and usage instead of presenting an unknown zero as free", async () => {
    vi.mocked(usageApi.getUsageSummary).mockResolvedValue({
      totalRequests: 2,
      totalCost: "0",
      realTotalTokens: 200,
      successRate: 100,
      totalInputTokens: 100,
      totalOutputTokens: 100,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      cacheHitRate: 0,
      unpricedRequests: 1,
      partialRequests: 1,
      cachePartialRequests: 1,
    });
    vi.mocked(usageApi.getProviderStats).mockResolvedValue([
      {
        providerId: "channel-unknown",
        providerName: "未定价服务",
        appType: "lolicode",
        requestCount: 2,
        totalTokens: 200,
        totalCost: "0",
        successRate: 100,
        avgLatencyMs: 100,
        unpricedRequests: 1,
        partialRequests: 1,
        cachePartialRequests: 1,
      },
    ]);
    mount();
    const table = await screen.findByRole("table", { name: "各渠道用量" });
    expect(within(table).getByText("待定价")).toBeInTheDocument();
    expect(within(table).queryByText("$0.0000")).not.toBeInTheDocument();
    const metrics = document.querySelector(
      ".lolicode-usage-metrics",
    ) as HTMLElement;
    expect(within(metrics).getByText("待定价")).toBeInTheDocument();
    expect(
      within(metrics).getByText(
        /1 次待定价.*1 次用量待回报.*1 次缓存计费待确认/,
      ),
    ).toBeInTheDocument();
  });
  it("keeps a confirmed zero price visible without marking it unpriced", async () => {
    vi.mocked(usageApi.getUsageSummary).mockResolvedValue({
      totalRequests: 1,
      totalCost: "0",
      realTotalTokens: 100,
      successRate: 100,
      totalInputTokens: 100,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      cacheHitRate: 0,
      unpricedRequests: 0,
      partialRequests: 0,
      cachePartialRequests: 0,
    });
    vi.mocked(usageApi.getProviderStats).mockResolvedValue([
      {
        providerId: "free",
        providerName: "零单价模型",
        appType: "workbuddy",
        requestCount: 1,
        totalTokens: 100,
        totalCost: "0",
        successRate: 100,
        avgLatencyMs: 100,
        unpricedRequests: 0,
        partialRequests: 0,
        cachePartialRequests: 0,
      },
    ]);
    mount();
    const table = await screen.findByRole("table", { name: "各渠道用量" });
    expect(within(table).getByText("$0.0000")).toBeInTheDocument();
    expect(within(table).queryByText("待定价")).not.toBeInTheDocument();
  });
  it("uses the shared Claude source scope for matching Code and Desktop records", async () => {
    const provider: ProviderStats = {
      providerId: "same-provider",
      providerName: "Claude 渠道",
      appType: "claude",
      requestCount: 1,
      totalTokens: 100,
      totalCost: "0.1",
      successRate: 100,
      avgLatencyMs: 100,
    };
    vi.mocked(usageApi.getProviderStats).mockResolvedValue([
      provider,
      { ...provider, appType: "claude-desktop" },
    ]);
    mount();
    const channel = screen.getByRole("combobox", { name: "按渠道筛选" });
    const encoded = '@provider:v1:["same-provider","claude"]';
    await screen.findByRole("option", { name: /Claude 渠道/ });
    expect(within(channel).getAllByRole("option")).toHaveLength(2);
    const agent = screen.getByRole("combobox", { name: "按 Agent 筛选" });
    expect(
      within(agent).queryByRole("option", { name: "Claude Desktop" }),
    ).not.toBeInTheDocument();
    await userEvent.setup().selectOptions(channel, encoded);
    await waitFor(() =>
      expect(usageApi.getUsageSummary).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.any(Number),
        undefined,
        encoded,
      ),
    );
  });
  it("shows tiny positive estimates as a positive lower precision amount in the overview and channel row", async () => {
    vi.mocked(usageApi.getUsageSummary).mockResolvedValue({
      totalRequests: 1,
      totalCost: "0.000000015",
      realTotalTokens: 10,
      successRate: 100,
      totalInputTokens: 10,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      cacheHitRate: 0,
      unpricedRequests: 0,
      partialRequests: 0,
      cachePartialRequests: 0,
    });
    vi.mocked(usageApi.getProviderStats).mockResolvedValue([
      {
        providerId: "channel-tiny",
        providerName: "低费用渠道",
        appType: "lolicode",
        requestCount: 1,
        totalTokens: 10,
        totalCost: "0.000000015",
        successRate: 100,
        avgLatencyMs: 100,
        unpricedRequests: 0,
        partialRequests: 0,
        cachePartialRequests: 0,
      },
    ]);
    mount();
    const table = await screen.findByRole("table", { name: "各渠道用量" });
    expect(within(table).getByText("<$0.0001")).toBeInTheDocument();
    expect(within(table).queryByText("$0.0000")).not.toBeInTheDocument();
    const metrics = document.querySelector(
      ".lolicode-usage-metrics",
    ) as HTMLElement;
    expect(within(metrics).getByText("<$0.0001")).toBeInTheDocument();
    expect(within(metrics).queryByText("$0.0000")).not.toBeInTheDocument();
  });
});
