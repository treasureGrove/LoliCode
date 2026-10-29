import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileCompanionAccountPanel } from "@/app/shell/MobileCompanionAccountPanel";
import type { CompanionAccountStatus } from "@/lib/api/mobile-companion";

const api = vi.hoisted(() => ({
  accountStatus: vi.fn(),
  setAccountVisible: vi.fn(),
  connectAccount: vi.fn(),
  disconnectAccount: vi.fn(),
  approveAccountRequest: vi.fn(),
  rejectAccountRequest: vi.fn(),
}));
vi.mock("@/lib/api/mobile-companion", () => ({ mobileCompanionApi: api }));
const base: CompanionAccountStatus = {
  protocol: 2,
  enabled: false,
  signedIn: true,
  accountId: "7",
  device: null,
  devices: [],
  requests: [],
  ticketExpiresAt: null,
  lastError: null,
  transportPolicy: "directOnly",
  directAvailable: true,
};
const desktop = {
  deviceId: "desktop",
  deviceName: "My PC",
  kind: "desktop" as const,
  publicKey: "public",
  fingerprint: "a".repeat(64),
  online: true,
  lastSeenAt: Date.now(),
};
const phone = {
  ...desktop,
  deviceId: "phone",
  deviceName: "Xiaomi 8 Lite",
  kind: "phone" as const,
  fingerprint: "b".repeat(64),
};
beforeEach(() => {
  vi.clearAllMocks();
  api.accountStatus.mockResolvedValue(base);
  api.setAccountVisible.mockResolvedValue(base);
  api.connectAccount.mockResolvedValue({
    ...base,
    enabled: true,
    device: desktop,
  });
  api.approveAccountRequest.mockResolvedValue({
    ...base,
    enabled: true,
    device: desktop,
  });
});
describe("account companion enrollment", () => {
  it("only reads local status and never registers a device before the user enables access", async () => {
    const view = render(
      <MobileCompanionAccountPanel open={false} accountId="7" />,
    );
    expect(api.accountStatus).not.toHaveBeenCalled();
    view.rerender(<MobileCompanionAccountPanel open accountId="7" />);
    await screen.findByRole("button", { name: "允许我的手机发现此电脑" });
    expect(api.connectAccount).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "这台电脑的名称" }), "Desk");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "允许我的手机发现此电脑" }));
    expect(api.connectAccount).toHaveBeenCalledWith("Desk");
    expect(await screen.findByText("My PC")).toBeInTheDocument();
  });
  it("binds local approval to the exact request and displayed public-key fingerprint", async () => {
    const pending = {
      ...base,
      enabled: true,
      device: desktop,
      requests: [
        {
          requestId: "request-1",
          accountId: "7",
          challenge: "random",
          desktop,
          phone,
          createdAt: Date.now(),
          expiresAt: Date.now() + 300000,
          status: "pending" as const,
        },
      ],
    };
    api.accountStatus.mockResolvedValue(pending);
    api.setAccountVisible.mockResolvedValue(pending);
    render(<MobileCompanionAccountPanel open accountId="7" />);
    await screen.findByText("Xiaomi 8 Lite");
    expect(api.approveAccountRequest).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "确认这是我的手机" }));
    expect(api.approveAccountRequest).toHaveBeenCalledWith(
      "request-1",
      phone.fingerprint,
    );
  });
  it("drops late old-account discovery after an account switch", async () => {
    let finish!: (value: CompanionAccountStatus) => void;
    api.accountStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<MobileCompanionAccountPanel open accountId="7" />);
    const switched = { ...base, accountId: "8" };
    api.accountStatus.mockResolvedValue(switched);
    api.setAccountVisible.mockResolvedValue(switched);
    view.rerender(<MobileCompanionAccountPanel open accountId="8" />);
    await act(async () =>
      finish({
        ...base,
        enabled: true,
        device: { ...desktop, deviceName: "Previous account computer" },
      }),
    );
    await waitFor(() => expect(api.accountStatus).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText("Previous account computer"),
    ).not.toBeInTheDocument();
  });
  it("offers existing account login and hides backend diagnostics", async () => {
    const loggedOut = { ...base, signedIn: false, accountId: null };
    api.accountStatus.mockResolvedValue(loggedOut);
    api.setAccountVisible.mockResolvedValue(loggedOut);
    const login = vi.fn();
    render(
      <MobileCompanionAccountPanel
        open
        accountId={null}
        onRequestLogin={login}
      />,
    );
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "登录 LoliCode" }));
    expect(login).toHaveBeenCalledOnce();
  });
  it("does not expose an error's credentials or revive a response after closing", async () => {
    api.connectAccount.mockRejectedValue(new Error("secret-device-ticket"));
    const view = render(<MobileCompanionAccountPanel open accountId="7" />);
    await userEvent
      .setup()
      .click(
        await screen.findByRole("button", { name: "允许我的手机发现此电脑" }),
      );
    expect(await screen.findByRole("alert")).not.toHaveTextContent(
      "secret-device-ticket",
    );
    view.rerender(<MobileCompanionAccountPanel open={false} accountId="7" />);
    expect(api.setAccountVisible).toHaveBeenLastCalledWith(false);
  });
});
