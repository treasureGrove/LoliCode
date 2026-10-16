import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotBillingPanel } from "@/components/usage/CopilotBillingPanel";
import { copilotGetAuthStatus, copilotListAccounts } from "@/lib/api/copilot";
import {
  COPILOT_BILLING_QUERY_KEY,
  copilotBillingApi,
  type CopilotBillingReport,
} from "@/lib/api/copilotBilling";

vi.mock("@/lib/api/copilot", () => ({
  copilotListAccounts: vi.fn(),
  copilotGetAuthStatus: vi.fn(),
}));
vi.mock("@/lib/api/copilotBilling", () => ({
  COPILOT_BILLING_QUERY_KEY: ["copilot", "billing", "reports"],
  copilotBillingApi: { listReports: vi.fn(), sync: vi.fn() },
}));

const now = new Date();
const year = now.getFullYear();
const month = now.getMonth() + 1;
const monthValue = `${year}-${String(month).padStart(2, "0")}`;
let reports: CopilotBillingReport[];

function report(
  updates: Partial<CopilotBillingReport> = {},
): CopilotBillingReport {
  return {
    accountLogin: "alice",
    year,
    month,
    kind: "ai_credits",
    fetchedAt: 1_792_089_600,
    source: "github-billing-api",
    items: [
      {
        product: "copilot",
        sku: "ai_credits",
        model: "gpt-test",
        unitType: "credits",
        pricePerUnit: 99,
        grossQuantity: 100,
        grossAmount: 20,
        discountQuantity: 80,
        discountAmount: 18,
        netQuantity: 20,
        netAmount: 2,
      },
      {
        product: "copilot",
        sku: "ai_credits",
        model: "gpt-test",
        unitType: "credits",
        pricePerUnit: 99,
        grossQuantity: 50,
        grossAmount: 10,
        discountQuantity: 35,
        discountAmount: 7,
        netQuantity: 15,
        netAmount: 3,
      },
    ],
    ...updates,
  };
}

function mount(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <CopilotBillingPanel />
      </QueryClientProvider>,
    ),
  };
}

function readMetric(label: string) {
  const term = screen.getByText(label, { selector: "dt" });
  return term.parentElement!.querySelector("dd")!.textContent;
}

async function ready() {
  await waitFor(() =>
    expect(screen.getByLabelText("GitHub 用户名")).toHaveValue("alice"),
  );
  await waitFor(() => expect(copilotBillingApi.listReports).toHaveBeenCalled());
}

beforeEach(() => {
  vi.resetAllMocks();
  reports = [];
  vi.mocked(copilotListAccounts).mockResolvedValue([
    {
      id: "account-b",
      login: "bob",
      avatar_url: null,
      authenticated_at: 1,
      github_domain: "github.com",
    },
    {
      id: "account-a",
      login: "alice",
      avatar_url: null,
      authenticated_at: 1,
      github_domain: "github.com",
    },
  ]);
  vi.mocked(copilotGetAuthStatus).mockResolvedValue({
    authenticated: true,
    default_account_id: "account-a",
    username: "alice",
    expires_at: null,
    accounts: [],
  });
  vi.mocked(copilotBillingApi.listReports).mockImplementation(
    async () => reports,
  );
});
afterEach(cleanup);

describe("Copilot personal billing", () => {
  it("restores the default account and shows official gross, discounts and net separately", async () => {
    reports = [report()];
    mount();
    await ready();
    expect(await screen.findByText("官方净额")).toBeInTheDocument();
    expect(readMetric("AI Credits 用量")).toBe("150");
    expect(readMetric("优惠前金额")).toContain("30.00");
    expect(readMetric("已抵扣金额")).toContain("25.00");
    expect(readMetric("官方净额")).toContain("5.00");
    const table = screen.getByRole("table", { name: "按模型汇总的官方账单" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(
      within(table).getByRole("rowheader", { name: "gpt-test" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/官方账单未区分 IDE、Agent 或会话/),
    ).toBeInTheDocument();
    expect(screen.getByText(/净额不代表发票已结算金额/)).toBeInTheDocument();
    expect(copilotBillingApi.sync).not.toHaveBeenCalled();
  });

  it("distinguishes an unsynced month from a successfully synced zero ledger", async () => {
    mount();
    await ready();
    expect(
      await screen.findByText("尚未同步此账号、月份及计费口径的官方账单。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("官方净额")).not.toBeInTheDocument();
    vi.mocked(copilotBillingApi.sync).mockImplementation(async () => {
      reports = [report({ items: [] })];
      return reports[0];
    });
    fireEvent.click(screen.getByRole("button", { name: "同步官方账单" }));
    expect(await screen.findByText(/上次同步：/)).toBeInTheDocument();
    expect(readMetric("AI Credits 用量")).toBe("0");
    expect(readMetric("官方净额")).toContain("0.00");
    expect(screen.queryByText(/尚未同步此账号/)).not.toBeInTheDocument();
  });

  it("keeps month and account ledgers separate, with matching OAuth account and an exact refresh", async () => {
    reports = [report()];
    const { client } = mount();
    await ready();
    await screen.findByText("官方净额");
    fireEvent.change(screen.getByLabelText("账单月份"), {
      target: { value: "2020-01" },
    });
    expect(await screen.findByText(/尚未同步此账号/)).toBeInTheDocument();
    expect(screen.queryByText("官方净额")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("GitHub 用户名"), {
      target: { value: "BOB" },
    });
    const next = report({
      accountLogin: "bob",
      year: 2020,
      month: 1,
      items: [],
    });
    vi.mocked(copilotBillingApi.sync).mockImplementation(async () => {
      reports.push(next);
      return next;
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(screen.getByRole("button", { name: "同步官方账单" }));
    await screen.findByText(/上次同步：/);
    expect(copilotBillingApi.sync).toHaveBeenCalledWith({
      accountId: "account-b",
      username: "BOB",
      token: undefined,
      year: 2020,
      month: 1,
      kind: "ai_credits",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [...COPILOT_BILLING_QUERY_KEY, "bob", 2020, 1, "ai_credits"],
      exact: true,
    });
  });

  it("never mixes the legacy requests ledger with credits", async () => {
    const requests = report({
      kind: "premium_requests",
      items: [
        {
          ...report().items[0],
          grossQuantity: 9,
          unitType: "requests",
          grossAmount: 3,
          discountAmount: 2,
          netAmount: 1,
        },
      ],
    });
    reports = [report(), requests];
    mount();
    await ready();
    await screen.findByText("AI Credits 用量");
    fireEvent.change(screen.getByLabelText("计费口径"), {
      target: { value: "premium_requests" },
    });
    await screen.findByText("Premium Requests 用量");
    expect(readMetric("Premium Requests 用量")).toBe("9");
    expect(screen.queryByText("AI Credits 用量")).not.toBeInTheDocument();
    expect(readMetric("官方净额")).toContain("1.00");
  });

  it("clears the temporary token after failure, redacts it from errors and preserves the last report", async () => {
    reports = [report()];
    const storage = vi.spyOn(Storage.prototype, "setItem");
    mount();
    await ready();
    await screen.findByText("官方净额");
    fireEvent.click(screen.getByRole("button", { name: "高级授权（可选）" }));
    const tokenInput = screen.getByLabelText("临时账单令牌");
    expect(tokenInput).toHaveAttribute("type", "password");
    fireEvent.change(tokenInput, {
      target: { value: "my-private-credential" },
    });
    fireEvent.click(screen.getByRole("button", { name: "显示账单令牌" }));
    expect(tokenInput).toHaveAttribute("type", "text");
    vi.mocked(copilotBillingApi.sync).mockRejectedValue(
      new Error("403 missing Plan: my-private-credential"),
    );
    fireEvent.click(screen.getByRole("button", { name: "同步官方账单" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "403 missing Plan: [已隐藏]",
    );
    expect(tokenInput).toHaveValue("");
    expect(tokenInput).toHaveAttribute("type", "password");
    expect(document.body.textContent).not.toContain("my-private-credential");
    expect(readMetric("官方净额")).toContain("5.00");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "正在保留上次同步的账单",
    );
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
    expect(screen.getByRole("button", { name: "同步官方账单" })).toBeEnabled();
    const next = report({ items: [] });
    vi.mocked(copilotBillingApi.sync).mockImplementation(async () => {
      reports = [next];
      return next;
    });
    fireEvent.change(tokenInput, { target: { value: "second-credential" } });
    fireEvent.click(screen.getByRole("button", { name: "同步官方账单" }));
    await waitFor(() => expect(readMetric("官方净额")).toContain("0.00"));
    expect(tokenInput).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables account, period and repeat requests while a sync is pending", async () => {
    let resolve!: (value: CopilotBillingReport) => void;
    vi.mocked(copilotBillingApi.sync).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    mount();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "同步官方账单" }));
    expect(screen.getByLabelText("GitHub 用户名")).toBeDisabled();
    expect(screen.getByLabelText("账单月份")).toBeDisabled();
    expect(screen.getByLabelText("计费口径")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "正在同步…" }));
    expect(copilotBillingApi.sync).toHaveBeenCalledTimes(1);
    await act(async () => {
      reports = [report({ items: [] })];
      resolve(reports[0]);
    });
    expect(screen.getByRole("button", { name: "同步官方账单" })).toBeEnabled();
  });

  it("does not let an unmounted request update another account's view or invalidate its ledger", async () => {
    let resolve!: (value: CopilotBillingReport) => void;
    vi.mocked(copilotBillingApi.sync).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = mount();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "同步官方账单" }));
    first.unmount();
    const invalidate = vi.spyOn(first.client, "invalidateQueries");
    mount(first.client);
    await ready();
    fireEvent.change(screen.getByLabelText("GitHub 用户名"), {
      target: { value: "bob" },
    });
    await screen.findByText(/尚未同步此账号/);
    await act(async () => resolve(report()));
    expect(screen.getByLabelText("GitHub 用户名")).toHaveValue("bob");
    expect(screen.queryByText("官方净额")).not.toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
    expect(
      first.client.getQueryData([
        ...COPILOT_BILLING_QUERY_KEY,
        "bob",
        year,
        month,
        "ai_credits",
      ]),
    ).toBeNull();
  });

  it("supports a manually entered user when no GitHub account is connected", async () => {
    vi.mocked(copilotListAccounts).mockResolvedValue([]);
    vi.mocked(copilotGetAuthStatus).mockRejectedValue("not connected");
    mount();
    expect(screen.getByRole("button", { name: "同步官方账单" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("GitHub 用户名"), {
      target: { value: "new-user" },
    });
    fireEvent.click(screen.getByRole("button", { name: "高级授权（可选）" }));
    fireEvent.change(screen.getByLabelText("临时账单令牌"), {
      target: { value: "github_pat_example" },
    });
    vi.mocked(copilotBillingApi.sync).mockRejectedValue({
      sensitive: "ignored",
    });
    fireEvent.click(screen.getByRole("button", { name: "同步官方账单" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "官方账单同步失败，请稍后重试。",
    );
    expect(copilotBillingApi.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: undefined,
        username: "new-user",
        token: "github_pat_example",
        year,
        month,
      }),
    );
    expect(screen.getByLabelText("临时账单令牌")).toHaveValue("");
    expect(screen.getByLabelText("账单月份")).toHaveValue(monthValue);
  });

  it("keeps the requested account fixed when default-account metadata arrives during sync", async () => {
    let resolveAuth!: (
      value: Awaited<ReturnType<typeof copilotGetAuthStatus>>,
    ) => void;
    let resolveBill!: (value: CopilotBillingReport) => void;
    vi.mocked(copilotGetAuthStatus).mockImplementation(
      () =>
        new Promise((done) => {
          resolveAuth = done;
        }),
    );
    vi.mocked(copilotBillingApi.sync).mockImplementation(
      () =>
        new Promise((done) => {
          resolveBill = done;
        }),
    );
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText("GitHub 用户名")).toHaveValue("bob"),
    );
    fireEvent.click(screen.getByRole("button", { name: "同步官方账单" }));
    await act(async () =>
      resolveAuth({
        authenticated: true,
        default_account_id: "account-a",
        username: "alice",
        expires_at: null,
        accounts: [],
      }),
    );
    expect(screen.getByLabelText("GitHub 用户名")).toHaveValue("bob");
    await act(async () => {
      reports = [report({ accountLogin: "bob", items: [] })];
      resolveBill(reports[0]);
    });
    expect(copilotBillingApi.sync).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-b", username: "bob" }),
    );
    expect(screen.getByLabelText("GitHub 用户名")).toHaveValue("bob");
    expect(await screen.findByText("官方净额")).toBeInTheDocument();
  });

  it("never reuses a GitHub Enterprise credential for the github.com ledger", async () => {
    vi.mocked(copilotListAccounts).mockResolvedValue([
      {
        id: "enterprise",
        login: "alice",
        avatar_url: null,
        authenticated_at: 1,
        github_domain: "github.example.com",
      },
    ]);
    mount();
    await waitFor(() => expect(copilotListAccounts).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("GitHub 用户名"), {
      target: { value: "alice" },
    });
    vi.mocked(copilotBillingApi.sync).mockRejectedValue("需要 Plan 读取权限");
    fireEvent.click(screen.getByRole("button", { name: "同步官方账单" }));
    await screen.findByRole("alert");
    expect(copilotBillingApi.sync).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined, username: "alice" }),
    );
  });
});
