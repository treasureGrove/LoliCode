import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LolicodeAllowancePage } from "@/features/usage/LolicodeAllowancePage";
import { SidebarQuotaRing } from "@/app/shell/SidebarQuotaRing";
import type {
  LolicodeAccount,
  LolicodeRelayStatus,
} from "@/lib/api/lolicode-account";
import { relayQuotaKey, relaySessionSnapshot } from "@/lib/relay-query-state";

const mocks = vi.hoisted(() => ({
  account: null as LolicodeAccount | null,
  language: "zh",
  isLoading: false,
  error: null as string | null,
  relayStatus: vi.fn(),
  connectRelay: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: mocks.language },
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue || key,
  }),
}));
vi.mock("@/hooks/useLolicodeAccount", () => ({
  useLolicodeAccount: () => mocks,
}));
vi.mock("@/lib/api/lolicode-account", () => ({
  lolicodeAccountApi: {
    refreshRelay: mocks.relayStatus,
    relayStatus: mocks.relayStatus,
    connectRelay: mocks.connectRelay,
  },
}));

const account: LolicodeAccount = {
  id: "42",
  username: "member",
  displayName: "Member",
  avatarUrl: null,
  profileUrl: "https://lolicode.com/u/42",
};
const status: LolicodeRelayStatus = {
  account: { id: "42", username: "member", displayName: "Member" },
  ready: false,
  models: [],
  quota: {
    day: "2029-01-01",
    timezone: "Asia/Singapore",
    resetsAt: "2029-01-02T00:00:00+08:00",
    requestLimit: 20,
    tokenLimit: 100000,
    requestsUsed: 3,
    tokensUsed: 1200,
    tokensReserved: 800,
    requestsRemaining: 17,
    tokensRemaining: 98000,
    creditUnit: "Credit",
    creditLimit: 100,
    creditsUsed: 1.2,
    creditsReserved: 0.8,
    creditsRemaining: 98,
  },
};
const clients: QueryClient[] = [];
function mount(onBack = vi.fn(), withSidebar = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const ui = () => (
    <QueryClientProvider client={client}>
      {withSidebar && mocks.account && (
        <SidebarQuotaRing accountId={mocks.account.id} onManage={vi.fn()} />
      )}
      <LolicodeAllowancePage onBack={onBack} />
    </QueryClientProvider>
  );
  return { ...render(ui()), ui, client, onBack };
}
const creditMeter = () =>
  screen.getByRole("meter", { name: "今日 Credit 剩余额度" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.account = { ...account };
  mocks.language = "zh";
  mocks.isLoading = false;
  mocks.error = null;
  mocks.relayStatus.mockResolvedValue(structuredClone(status));
  mocks.connectRelay.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe("LoliCode allowance page", () => {
  it("shares the canonical Credit balance and per-million quote with the sidebar", async () => {
    mocks.relayStatus.mockResolvedValue({
      ...status,
      ready: true,
      models: [
        {
          id: "canonical",
          creditPricing: {
            unit: "Credit",
            mode: "tokens",
            perTokens: 1_000_000,
            prices: { input: 22, output: 88, cacheRead: 2.2, cacheWrite: 22 },
          },
        },
      ],
      quota: {
        ...status.quota,
        creditsRemaining: 0,
        tokensRemaining: 0,
        creditBalance: {
          unit: "Credit",
          limit: 100,
          used: 20,
          reserved: 5,
          remaining: 75,
          pricingRevision: 4,
          ledgerRevision: 30,
        },
      },
    });
    mount(vi.fn(), true);
    await screen.findByRole("meter", { name: "今日 Credit 剩余额度" });
    expect(creditMeter()).toHaveAttribute("aria-valuenow", "75");
    expect(
      screen.getByRole("meter", { name: "今日免费额度剩余" }),
    ).toHaveAttribute("aria-valuenow", "75");
    expect(
      screen.getByText(
        /每百万 Token：输入 22 \/ 输出 88 \/ 缓存读取 2.2 \/ 缓存写入 22 Credit/,
      ),
    ).toBeInTheDocument();
    expect(mocks.relayStatus).toHaveBeenCalledOnce();
    expect(screen.queryByText(/今日免费额度已用完/)).not.toBeInTheDocument();
  });

  it("retains legacy per-request Credit quotes and never shows a tiny positive charge as zero", async () => {
    mocks.relayStatus.mockResolvedValue({
      ...status,
      ready: true,
      models: [
        {
          id: "request-model",
          creditPricing: {
            unit: "Credit",
            mode: "request",
            creditsPerRequest: 0.001,
          },
        },
      ],
    });
    mount();
    expect(await screen.findByText("每次 <0.01 Credit")).toBeInTheDocument();
  });

  it("uses Credit rates and remaining balance even when raw tokens show a different allowance", async () => {
    mocks.relayStatus.mockResolvedValue({
      ...status,
      ready: true,
      models: [
        {
          id: "premium",
          creditRate: { input: 2, output: 8, cacheRead: 0.25, cacheWrite: 3 },
        },
      ],
      quota: {
        ...status.quota,
        creditUnit: "Credit",
        creditLimit: 100,
        creditsUsed: 38.75,
        creditsReserved: 1.25,
        creditsRemaining: 60,
      },
    });
    mount();
    await screen.findByRole("meter", { name: "今日 Credit 剩余额度" });
    expect(creditMeter()).toHaveAttribute("aria-valuenow", "60");
    expect(screen.getByText(/已预留 1.25 Credit/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /每百万 Token：输入 2,000 \/ 输出 8,000 \/ 缓存读取 250 \/ 缓存写入 3,000 Credit/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/实际用量：1,200 Token/)).toBeInTheDocument();
  });

  it("shows the shared daily allowance and marks open models as free", async () => {
    mocks.relayStatus.mockResolvedValue({
      ...status,
      ready: true,
      models: [{ id: "glm-5.3-flash", name: "GLM 5.3 Flash" }],
    });
    mount();
    expect(await screen.findByText("GLM 5.3 Flash")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "使用情况与额度" }),
    ).toBeInTheDocument();
    expect(screen.getByText("free")).toHaveAttribute(
      "title",
      "公益模型，使用每日免费额度",
    );
    expect(screen.getByText(/今日已调用 3 次/)).toBeInTheDocument();
    expect(
      screen.queryByRole("meter", { name: "今日请求剩余额度" }),
    ).not.toBeInTheDocument();
    expect(creditMeter()).toHaveAttribute("aria-valuenow", "98");
    expect(creditMeter()).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("98"),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("can return while quota is loading without inventing an allowance", async () => {
    mocks.relayStatus.mockReturnValue(new Promise(() => {}));
    const { onBack } = mount();
    expect(await screen.findByText("正在读取额度…")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    const back = screen.getByRole("button", { name: "返回" });
    expect(back).toBeEnabled();
    await userEvent.setup().click(back);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("does not fetch quota while signed out and still provides a way back", async () => {
    mocks.account = null;
    const { onBack } = mount();
    expect(
      screen.getByRole("heading", { name: "登录后查看免费额度" }),
    ).toBeInTheDocument();
    expect(mocks.relayStatus).not.toHaveBeenCalled();
    expect(mocks.connectRelay).not.toHaveBeenCalled();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("refreshes models explicitly and updates the quota cache shared with the sidebar", async () => {
    const { client } = mount();
    await screen.findByRole("meter", { name: "今日 Credit 剩余额度" });
    expect(screen.getByText(/公益模型尚未开放/)).toBeInTheDocument();
    const updated = {
      ...status,
      ready: true,
      models: [{ id: "glm-5.3-flash", name: "GLM 5.3 Flash" }],
      quota: { ...status.quota, requestsUsed: 1, creditsRemaining: 95 },
    };
    mocks.relayStatus.mockResolvedValue(updated);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "刷新额度和模型" }));
    await screen.findByText("GLM 5.3 Flash");
    expect(mocks.connectRelay).not.toHaveBeenCalled();
    expect(mocks.relayStatus).toHaveBeenCalledTimes(2);
    expect(creditMeter()).toHaveAttribute("aria-valuenow", "95");
    expect(
      client.getQueryData(
        relayQuotaKey(account.id, relaySessionSnapshot(client).generation),
      ),
    ).toEqual(updated);
  });

  it("hides old allowance in both the page and sidebar after a denied refresh and remains navigable", async () => {
    const { onBack } = mount(vi.fn(), true);
    await screen.findByRole("meter", { name: "今日 Credit 剩余额度" });
    mocks.relayStatus.mockRejectedValue(new Error("Access denied"));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "刷新额度和模型" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "免费额度 · 额度待更新" }),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("does not show a previous account's late response after switching", async () => {
    let complete!: (value: LolicodeRelayStatus) => void;
    mocks.relayStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const view = mount();
    mocks.account = { ...account, id: "7", displayName: "Other" };
    mocks.relayStatus.mockResolvedValue({
      ...status,
      account: { ...status.account, id: "7", displayName: "Other" },
      quota: { ...status.quota, creditsRemaining: 95 },
    });
    view.rerender(view.ui());
    await waitFor(() =>
      expect(creditMeter()).toHaveAttribute("aria-valuenow", "95"),
    );
    await act(async () => complete(status));
    expect(creditMeter()).toHaveAttribute("aria-valuenow", "95");
    expect(screen.queryByText("98 / 100")).not.toBeInTheDocument();
  });

  it("removes all displayed quota immediately when the account signs out", async () => {
    const view = mount();
    await screen.findByRole("meter", { name: "今日 Credit 剩余额度" });
    mocks.account = null;
    view.rerender(view.ui());
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(mocks.relayStatus).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "登录后查看免费额度" }),
    ).toBeInTheDocument();
  });

  it("uses the server's remaining Credit without subtracting reservations twice", async () => {
    mocks.relayStatus.mockResolvedValue({
      ...status,
      quota: { ...status.quota, creditsRemaining: 58, creditsReserved: 20 },
    });
    mount();
    await screen.findByRole("meter", { name: "今日 Credit 剩余额度" });
    expect(Number(creditMeter().getAttribute("aria-valuenow"))).toBeCloseTo(58);
    expect(creditMeter()).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("58"),
    );
    expect(screen.getByText(/已预留 20 Credit/)).toBeInTheDocument();
  });

  it.each([
    { requestsRemaining: null, requestLimit: null },
    {
      requestsRemaining: Number.MAX_SAFE_INTEGER,
      requestLimit: Number.MAX_SAFE_INTEGER,
    },
    { requestsRemaining: 0, requestLimit: 0 },
  ])(
    "treats request limits as compatibility fields and retains only the usage statistic: %j",
    async (quota) => {
      mocks.relayStatus.mockResolvedValue({
        ...status,
        quota: {
          ...status.quota,
          ...quota,
          requestsUnlimited: true,
          requestsUsed: 230,
        },
      });
      mount();
      await screen.findByRole("meter", { name: "今日 Credit 剩余额度" });
      expect(creditMeter()).toHaveAttribute("aria-valuenow", "98");
      expect(screen.getAllByRole("meter")).toHaveLength(1);
      expect(screen.getByText(/今日已调用 230 次/)).toBeInTheDocument();
      expect(screen.queryByText(/今日免费额度已用完/)).not.toBeInTheDocument();
      expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
    },
  );

  it("still reports exhausted Credit when request counts are unlimited", async () => {
    mocks.relayStatus.mockResolvedValue({
      ...status,
      quota: {
        ...status.quota,
        requestsUnlimited: true,
        requestLimit: null,
        requestsRemaining: null,
        requestsUsed: 230,
        creditUnit: "Credit",
        creditLimit: 100,
        creditsUsed: 100,
        creditsReserved: 0,
        creditsRemaining: 0,
      },
    });
    mount();
    await screen.findByRole("meter", { name: "今日 Credit 剩余额度" });
    expect(creditMeter()).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText(/今日免费额度已用完/)).toBeInTheDocument();
  });
});
