import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LolicodeRelayDialog } from "@/components/shell/LolicodeRelayDialog";
import type { LolicodeRelayStatus } from "@/lib/api/lolicode-account";

const api = vi.hoisted(() => ({ relayStatus: vi.fn(), connectRelay: vi.fn() }));
vi.mock("@/lib/api/lolicode-account", () => ({ lolicodeAccountApi: api }));
const status: LolicodeRelayStatus = {
  account: { id: "42", username: "member", displayName: "Member" },
  ready: false,
  models: [],
  quota: {
    day: "2026-10-21",
    timezone: "Asia/Singapore",
    resetsAt: "2026-10-22T00:00:00+08:00",
    requestLimit: 20,
    tokenLimit: 100000,
    requestsUsed: 3,
    tokensUsed: 1200,
    tokensReserved: 800,
    requestsRemaining: 17,
    tokensRemaining: 98000,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  api.relayStatus.mockResolvedValue(status);
  api.connectRelay.mockResolvedValue(undefined);
});
describe("LoliCode sponsored allowance", () => {
  it("does not fetch when closed or signed out", () => {
    const view = render(
      <LolicodeRelayDialog
        open={false}
        accountId="42"
        onOpenChange={vi.fn()}
      />,
    );
    expect(api.relayStatus).not.toHaveBeenCalled();
    view.rerender(
      <LolicodeRelayDialog open accountId={null} onOpenChange={vi.fn()} />,
    );
    expect(api.relayStatus).not.toHaveBeenCalled();
  });
  it("shows the shared allowance and explains when models are not open yet", async () => {
    render(<LolicodeRelayDialog open accountId="42" onOpenChange={vi.fn()} />);
    expect(await screen.findByText("17 / 20")).toBeInTheDocument();
    expect(screen.getByText("98,000 / 100,000")).toBeInTheDocument();
    expect(screen.getByText(/公益模型尚未开放/)).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "刷新额度和模型" }));
    await waitFor(() => expect(api.connectRelay).toHaveBeenCalledOnce());
  });
  it("does not show a previous account's late response after switching", async () => {
    let complete!: (value: LolicodeRelayStatus) => void;
    api.relayStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const view = render(
      <LolicodeRelayDialog open accountId="42" onOpenChange={vi.fn()} />,
    );
    api.relayStatus.mockResolvedValue({
      ...status,
      account: { ...status.account, id: "7" },
      quota: { ...status.quota, requestsRemaining: 19 },
    });
    view.rerender(
      <LolicodeRelayDialog open accountId="7" onOpenChange={vi.fn()} />,
    );
    expect(await screen.findByText("19 / 20")).toBeInTheDocument();
    await act(async () => complete(status));
    expect(screen.queryByText("17 / 20")).not.toBeInTheDocument();
  });
  it("clears cached quota when the server denies access", async () => {
    render(<LolicodeRelayDialog open accountId="42" onOpenChange={vi.fn()} />);
    await screen.findByText("17 / 20");
    api.connectRelay.mockRejectedValue(new Error("账号已被封禁"));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "刷新额度和模型" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("账号已被封禁");
    expect(screen.queryByText("17 / 20")).not.toBeInTheDocument();
  });
});
