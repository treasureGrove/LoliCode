import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SimpleUsagePage } from "@/components/usage/SimpleUsagePage";
import { usageApi } from "@/lib/api/usage";
import { channelCenterApi } from "@/lib/api/channel-center";

vi.mock("@/lib/api/usage", () => ({
  usageApi: { getUsageSummary: vi.fn(), getProviderStats: vi.fn() },
}));
vi.mock("@/lib/api/channel-center", () => ({
  channelCenterApi: { get: vi.fn() },
}));
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SimpleUsagePage />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
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
