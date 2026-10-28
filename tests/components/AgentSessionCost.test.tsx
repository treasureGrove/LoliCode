import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionCost } from "@/components/agent/AgentSessionCost";
import { usageApi } from "@/lib/api/usage";
import type { UsageSummary } from "@/types/usage";

const bridge = vi.hoisted(() => ({
  listener: undefined as undefined | (() => void),
}));
vi.mock("@/hooks/useTauriEvent", () => ({
  useTauriEvent: (_event: string, listener: () => void) => {
    bridge.listener = listener;
  },
}));
vi.mock("@/lib/api/usage", () => ({
  usageApi: { getSessionUsageSummary: vi.fn() },
}));

const first = "lc:11111111-1111-4111-8111-111111111111";
const second = "lc:22222222-2222-4222-8222-222222222222";
const summary = (patch: Partial<UsageSummary> = {}): UsageSummary => ({
  totalRequests: 3,
  totalCost: "0.123456",
  totalInputTokens: 100,
  totalOutputTokens: 30,
  totalCacheReadTokens: 50,
  totalCacheCreationTokens: 0,
  realTotalTokens: 180,
  cacheHitRate: 1 / 3,
  successRate: 100,
  unpricedRequests: 0,
  partialRequests: 0,
  cachePartialRequests: 0,
  ...patch,
});

function setup(props = { sessionId: first, hasRecordedCalls: true }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <AgentSessionCost {...props} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    client,
    rerenderSession: (sessionId: string) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <AgentSessionCost sessionId={sessionId} hasRecordedCalls />
        </QueryClientProvider>,
      ),
  };
}

describe("AgentSessionCost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.listener = undefined;
  });

  it("reads the existing session ledger and explains auxiliary model costs", async () => {
    vi.mocked(usageApi.getSessionUsageSummary).mockResolvedValue(summary());
    setup();
    await screen.findByText("估算费用 $0.1235");
    expect(usageApi.getSessionUsageSummary).toHaveBeenCalledWith(
      "lolicode",
      first,
    );
    expect(screen.getByLabelText("本会话估算费用").title).toContain(
      "标题生成和上下文压缩",
    );
    expect(screen.getByLabelText("本会话估算费用").title).toContain(
      "3 次模型请求",
    );
  });

  it("does not display unknown prices as a zero bill", async () => {
    vi.mocked(usageApi.getSessionUsageSummary).mockResolvedValue(
      summary({ totalCost: "0", unpricedRequests: 3 }),
    );
    setup();
    await screen.findByText("费用待定价");
    expect(screen.queryByText(/\$0/)).toBeNull();
    expect(screen.getByText("3 次请求待定价")).toBeInTheDocument();
  });

  it("keeps priced amounts while reporting incomplete requests", async () => {
    vi.mocked(usageApi.getSessionUsageSummary).mockResolvedValue(
      summary({ unpricedRequests: 1, cachePartialRequests: 1 }),
    );
    setup();
    await screen.findByText("已定价估算 $0.1235");
    expect(
      screen.getByText(/1 次请求待定价 · 1 次请求缓存计价不完整/),
    ).toBeInTheDocument();
  });

  it("distinguishes explicitly priced zero from missing usage", async () => {
    vi.mocked(usageApi.getSessionUsageSummary).mockResolvedValue(
      summary({ totalCost: "0" }),
    );
    const view = setup();
    await screen.findByText("估算费用 $0.0000");
    vi.mocked(usageApi.getSessionUsageSummary).mockResolvedValue(
      summary({ totalCost: "0", partialRequests: 1 }),
    );
    await act(async () => {
      await view.client.invalidateQueries();
    });
    await screen.findByText("费用待确认");
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("does not guess unlinked historical session fees", async () => {
    vi.mocked(usageApi.getSessionUsageSummary).mockResolvedValue(
      summary({ totalRequests: 0, totalCost: "0" }),
    );
    setup();
    await screen.findByText("费用待关联");
    expect(screen.getByLabelText("本会话估算费用").title).toContain(
      "历史未能关联会话",
    );
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("reports a missing ledger without inventing a fee", async () => {
    vi.mocked(usageApi.getSessionUsageSummary).mockRejectedValue(
      new Error("temporary read failure"),
    );
    setup();
    await screen.findByText("费用暂不可用");
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("retains the last amount when a background read fails", async () => {
    vi.mocked(usageApi.getSessionUsageSummary)
      .mockResolvedValueOnce(summary())
      .mockRejectedValue(new Error("temporary read failure"));
    const view = setup();
    await screen.findByText("估算费用 $0.1235");
    await act(async () => {
      await view.client.invalidateQueries();
    });
    await screen.findByText("估算费用 $0.1235（待刷新）");
  });

  it("does not carry another session's amount across selection changes", async () => {
    let resolveSecond!: (value: UsageSummary) => void;
    vi.mocked(usageApi.getSessionUsageSummary)
      .mockResolvedValueOnce(summary())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const view = setup();
    await screen.findByText("估算费用 $0.1235");
    view.rerenderSession(second);
    expect(screen.queryByText("估算费用 $0.1235")).toBeNull();
    await waitFor(() => expect(resolveSecond).toBeDefined());
    await act(async () => {
      resolveSecond(summary({ totalCost: "0.4" }));
    });
    await screen.findByText("估算费用 $0.4000");
  });

  it("updates the current amount when a real ledger write event arrives", async () => {
    vi.mocked(usageApi.getSessionUsageSummary)
      .mockResolvedValueOnce(summary())
      .mockResolvedValue(summary({ totalCost: "0.2" }));
    setup();
    await screen.findByText("估算费用 $0.1235");
    await act(async () => {
      bridge.listener?.();
    });
    await screen.findByText("估算费用 $0.2000");
  });

  it("keeps tiny positive costs distinct from a zero estimate", async () => {
    vi.mocked(usageApi.getSessionUsageSummary).mockResolvedValue(
      summary({ totalCost: "0.00000003" }),
    );
    setup();
    await screen.findByText("估算费用 <$0.0001");
  });

  it("shows an explicitly reported zero charge even when token usage is absent", async () => {
    vi.mocked(usageApi.getSessionUsageSummary).mockResolvedValue(
      summary({
        totalCost: "0",
        partialRequests: 3,
        reportedCostRequests: 3,
        estimatedCostRequests: 0,
      }),
    );
    setup();
    await screen.findByText("渠道回报 $0.0000");
    expect(screen.getByLabelText("本会话费用").title).toContain("3 次渠道回报");
    expect(screen.getByText("3 次请求用量待确认")).toBeInTheDocument();
  });

  it("identifies dictionary estimates and mixed amounts without calling them upstream charges", async () => {
    vi.mocked(usageApi.getSessionUsageSummary).mockResolvedValue(
      summary({ reportedCostRequests: 0, estimatedCostRequests: 3 }),
    );
    const view = setup();
    await screen.findByText("本地估算 $0.1235");
    vi.mocked(usageApi.getSessionUsageSummary).mockResolvedValue(
      summary({ reportedCostRequests: 1, estimatedCostRequests: 2 }),
    );
    await act(async () => {
      await view.client.invalidateQueries();
    });
    await screen.findByText("混合费用 $0.1235");
    expect(screen.getByLabelText("本会话费用").title).toContain(
      "1 次渠道回报 · 2 次本地估算",
    );
  });

  it("keeps unclassified historical amounts distinct from entirely reported charges", async () => {
    vi.mocked(usageApi.getSessionUsageSummary).mockResolvedValue(
      summary({ reportedCostRequests: 1, estimatedCostRequests: 0 }),
    );
    setup();
    await screen.findByText("费用 $0.1235");
    expect(screen.getByLabelText("本会话费用").title).toContain(
      "2 次费用来源未区分",
    );
  });
});
