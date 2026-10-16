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
import { copilotListAccounts } from "@/lib/api/copilot";
import { copilotBillingApi } from "@/lib/api/copilotBilling";

vi.mock("@/lib/api/usage", () => ({
  usageApi: {
    getUsageSummary: vi.fn(),
    getProviderStats: vi.fn(),
    getUsageFirstDate: vi.fn(),
    getUsageTrends: vi.fn(),
  },
}));
vi.mock("@/lib/api/channel-center", () => ({
  channelCenterApi: { get: vi.fn() },
}));
vi.mock("@/lib/api/copilotBilling", () => ({
  COPILOT_BILLING_QUERY_KEY: ["copilot", "billing", "reports"],
  copilotBillingApi: {
    listReports: vi.fn().mockResolvedValue([]),
    sync: vi.fn(),
  },
}));
vi.mock("@/lib/api/copilot", () => ({
  copilotListAccounts: vi.fn().mockResolvedValue([]),
  copilotGetAuthStatus: vi.fn().mockResolvedValue({
    authenticated: false,
    default_account_id: null,
    accounts: [],
  }),
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
  vi.mocked(copilotBillingApi.listReports).mockResolvedValue([]);
  vi.mocked(copilotListAccounts).mockResolvedValue([]);
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
});
describe("basic usage", () => {
  it("keeps official Copilot billing separate from local request estimates and time filters", async () => {
    const now = new Date();
    vi.mocked(copilotListAccounts).mockResolvedValue([
      {
        id: "personal-alice",
        login: "alice",
        avatar_url: null,
        authenticated_at: 0,
        github_domain: "github.com",
      },
    ]);
    vi.mocked(copilotBillingApi.listReports).mockResolvedValue([
      {
        accountLogin: "alice",
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        kind: "ai_credits",
        fetchedAt: Math.floor(now.getTime() / 1000),
        source: "github-billing-api",
        items: [
          {
            product: "Copilot AI Credits",
            sku: "AI Credit",
            model: "example-model",
            unitType: "ai-credits",
            pricePerUnit: 0.01,
            grossQuantity: 900,
            grossAmount: 9,
            discountQuantity: 800,
            discountAmount: 8,
            netQuantity: 100,
            netAmount: 1,
          },
        ],
      },
    ]);
    mount();
    const official = within(
      screen.getByRole("region", { name: "GitHub Copilot 官方账单" }),
    );
    expect(await official.findAllByText("US$1.00")).toHaveLength(2);
    expect(await screen.findByText("$0.1234")).toBeInTheDocument();
    expect(screen.queryByText("$1.1234")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "全部" }));
    expect(official.getAllByText("US$1.00")).toHaveLength(2);
    expect(screen.getByText("$0.1234")).toBeInTheDocument();
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
    vi.mocked(channelCenterApi.get).mockResolvedValue({
      channels: [
        {
          id: "fixture",
          name: "工作用 DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "",
          authKind: "api_key",
          protocol: "openai_chat",
          models: [],
          enabled: true,
        },
      ],
      targets: [],
    });
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
    expect(screen.getByText("统一渠道服务")).toBeInTheDocument();
    expect(screen.queryByText("channel-fixture")).not.toBeInTheDocument();
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
