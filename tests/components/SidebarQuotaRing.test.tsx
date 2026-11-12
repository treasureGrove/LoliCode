import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarQuotaRing } from "@/app/shell/SidebarQuotaRing";
import type { LolicodeRelayStatus } from "@/lib/api/lolicode-account";

const api = vi.hoisted(() => ({ relayStatus: vi.fn() }));
vi.mock("@/lib/api/lolicode-account", () => ({
  lolicodeAccountApi: { refreshRelay: api.relayStatus },
}));

const status: LolicodeRelayStatus = {
  account: { id: "42", username: "member", displayName: "Member" },
  ready: true,
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

function mount(accountId = "42", onManage = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const ui = (id: string, refreshRevision = 0) => (
    <QueryClientProvider client={client}>
      <SidebarQuotaRing
        accountId={id}
        onManage={onManage}
        refreshRevision={refreshRevision}
      />
    </QueryClientProvider>
  );
  return { ...render(ui(accountId)), ui, client, onManage };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.relayStatus.mockResolvedValue(structuredClone(status));
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.keyboard;
  vi.useRealTimers();
});

describe("sidebar free allowance ring", () => {
  it("uses the Credit balance and reservation instead of the raw token balance", async () => {
    api.relayStatus.mockResolvedValue({
      ...status,
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
    expect(await screen.findByRole("meter")).toHaveAttribute(
      "aria-valuenow",
      "60",
    );
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "免费额度 · 今日剩余 60%" }),
    );
    const details = await screen.findByRole("dialog");
    expect(details).toHaveTextContent("60 / 100");
    expect(details).toHaveTextContent("1.25 Credit 已预留");
    expect(details).toHaveTextContent("已使用 Token1,200");
  });

  it("uses the Credit allowance and exposes request usage as a statistic on hover", async () => {
    const { onManage } = mount();
    const meter = await screen.findByRole("meter", {
      name: "今日免费额度剩余",
    });
    expect(meter).toHaveAttribute("aria-valuenow", "98");
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "免费额度 · 今日剩余 98%" }),
    );
    const details = await screen.findByRole("dialog", { name: "免费额度" });
    expect(details).toHaveTextContent("今日调用3");
    expect(details).toHaveTextContent("98 / 100");
    expect(details).toHaveTextContent("0.8 Credit 已预留，未计入剩余");
    expect(details).toHaveTextContent("新加坡时间");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "管理用量" }));
    expect(onManage).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("does not subtract reserved tokens from the server's remaining amount a second time", async () => {
    api.relayStatus.mockResolvedValue({
      ...status,
      quota: {
        ...status.quota,
        requestsRemaining: 20,
        creditsRemaining: 58,
        creditsReserved: 20,
      },
    });
    mount();
    expect(await screen.findByRole("meter")).toHaveAttribute(
      "aria-valuenow",
      "58",
    );
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "免费额度 · 今日剩余 58%" }),
    );
    expect(await screen.findByRole("dialog")).toHaveTextContent("58 / 100");
  });

  it.each([
    { requestsRemaining: null, requestLimit: null },
    {
      requestsRemaining: Number.MAX_SAFE_INTEGER,
      requestLimit: Number.MAX_SAFE_INTEGER,
    },
    { requestsRemaining: 0, requestLimit: 0 },
  ])(
    "does not let compatibility request limits reduce the Credit ring: %j",
    async (quota) => {
      api.relayStatus.mockResolvedValue({
        ...status,
        quota: {
          ...status.quota,
          ...quota,
          requestsUnlimited: true,
          requestsUsed: 230,
        },
      });
      mount();
      expect(await screen.findByRole("meter")).toHaveAttribute(
        "aria-valuenow",
        "98",
      );
      expect(
        screen.getByRole("button", { name: "免费额度 · 今日剩余 98%" }),
      ).not.toHaveAttribute("data-tone", "empty");
      fireEvent.pointerEnter(
        screen.getByRole("button", { name: "免费额度 · 今日剩余 98%" }),
      );
      expect(await screen.findByRole("dialog")).toHaveTextContent(
        "今日调用230",
      );
    },
  );

  it("still shows exhaustion when the Credit balance is zero", async () => {
    api.relayStatus.mockResolvedValue({
      ...status,
      quota: {
        ...status.quota,
        requestsUnlimited: true,
        requestLimit: null,
        requestsRemaining: null,
        creditUnit: "Credit",
        creditLimit: 100,
        creditsUsed: 100,
        creditsReserved: 0,
        creditsRemaining: 0,
      },
    });
    mount();
    expect(await screen.findByRole("meter")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    expect(
      screen.getByRole("button", { name: "免费额度 · 今日剩余 0%" }),
    ).toHaveAttribute("data-tone", "empty");
  });

  it("shows an unknown allowance while loading instead of a full ring", async () => {
    api.relayStatus.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", {
      name: "免费额度 · 额度待更新",
    });
    fireEvent.pointerEnter(trigger);
    expect(await screen.findByRole("status")).toHaveTextContent("正在读取额度");
    expect(api.relayStatus).toHaveBeenCalledOnce();
  });

  it("clears the displayed allowance after the server rejects a refresh", async () => {
    mount();
    await screen.findByRole("meter");
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: /免费额度 · 今日剩余/ }),
    );
    await screen.findByRole("dialog");
    api.relayStatus.mockRejectedValueOnce(new Error("Access denied"));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "刷新免费额度" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法读取额度",
    );
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.queryByText("17 / 20")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "免费额度 · 额度待更新" }),
    ).toHaveAttribute("data-tone", "unknown");
  });

  it("shows unavailable quota instead of a numeric summary for an invalid server snapshot", async () => {
    api.relayStatus.mockResolvedValue({
      ...status,
      quota: { ...status.quota, creditsRemaining: Number.NaN },
    });
    mount();
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "免费额度 · 额度待更新" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "免费额度" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("暂时无法读取额度"),
    );
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.queryByText(/剩余 null|NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText("17 / 20")).not.toBeInTheDocument();
  });

  it("never applies a late response from a previous account", async () => {
    let completeFirst!: (value: LolicodeRelayStatus) => void;
    api.relayStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        completeFirst = resolve;
      }),
    );
    const view = mount();
    api.relayStatus.mockResolvedValue({
      ...status,
      account: { ...status.account, id: "7" },
      quota: { ...status.quota, creditsRemaining: 55 },
    });
    view.rerender(view.ui("7"));
    expect(await screen.findByRole("meter")).toHaveAttribute(
      "aria-valuenow",
      "55",
    );
    await act(async () => completeFirst(status));
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "55");
    expect(
      screen.queryByRole("button", { name: "免费额度 · 今日剩余 98%" }),
    ).not.toBeInTheDocument();
  });

  it("reloads at reset time and does not show a full allowance before the response arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2028-12-31T15:59:59Z"));
    api.relayStatus.mockResolvedValueOnce({
      ...status,
      quota: { ...status.quota, resetsAt: "2028-12-31T16:00:00Z" },
    });
    let completeReset!: (value: LolicodeRelayStatus) => void;
    api.relayStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        completeReset = resolve;
      }),
    );
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "98");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(api.relayStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "免费额度 · 额度待更新" }),
    ).toBeInTheDocument();
    await act(async () => {
      completeReset({
        ...status,
        quota: {
          ...status.quota,
          requestsRemaining: 20,
          tokensRemaining: 100000,
          creditsRemaining: 100,
        },
      });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
  });

  it("keeps the allowance preview open on click until Manage usage is selected", async () => {
    const { onManage } = mount();
    await screen.findByRole("meter");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /免费额度 · 今日剩余/ }));
    expect(
      await screen.findByRole("dialog", { name: "免费额度" }),
    ).toBeVisible();
    expect(onManage).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "管理用量" }));
    expect(onManage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["{Enter}", " "])(
    "opens the allowance preview using %s and lets the keyboard manage usage",
    async (key) => {
      const { onManage } = mount();
      await screen.findByRole("meter");
      const trigger = screen.getByRole("button", {
        name: /免费额度 · 今日剩余/,
      });
      trigger.focus();
      const user = userEvent.setup();
      await user.keyboard(key);
      expect(
        await screen.findByRole("dialog", { name: "免费额度" }),
      ).toBeVisible();
      expect(onManage).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "刷新免费额度" }),
      ).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("button", { name: "管理用量" })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(onManage).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("stays closed after Escape restores keyboard focus to the ring", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("meter");
    document.documentElement.dataset.keyboard = "";
    const trigger = screen.getByRole("button", { name: /免费额度 · 今日剩余/ });
    trigger.focus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.pointerEnter(trigger);
    await screen.findByRole("dialog", { name: "免费额度" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
