import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileCompanionDialog } from "@/app/shell/MobileCompanionDialog";
import type { MobileCompanionStatus } from "@/lib/api/mobile-companion";
import { settingsApi } from "@/lib/api/settings";
const api = vi.hoisted(() => ({
  status: vi.fn(),
  pair: vi.fn(),
  approve: vi.fn(),
  revoke: vi.fn(),
  accountStatus: vi.fn(),
  setAccountVisible: vi.fn(),
}));
vi.mock("@/lib/api/mobile-companion", () => ({ mobileCompanionApi: api }));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { openExternal: vi.fn() },
}));
const initial: MobileCompanionStatus = {
  hostName: "Test computer",
  protocol: 1,
  quietMode: true,
  pairs: [],
};
const device = {
  roomId: "a".repeat(32),
  relayUrl: "wss://example.com/companion/ws",
  accountId: "7",
  approved: true,
  deviceId: "phone",
  deviceName: "Xiaomi 8 Lite",
  online: true,
  transport: "direct" as const,
  sessionCount: 0,
  expiresAt: Date.now() + 300000,
};
beforeEach(() => {
  vi.clearAllMocks();
  api.status.mockResolvedValue(initial);
  api.revoke.mockResolvedValue(undefined);
  const account = {
    protocol: 2,
    enabled: false,
    signedIn: false,
    accountId: null,
    device: null,
    devices: [],
    requests: [],
    ticketExpiresAt: null,
    lastError: null,
    transportPolicy: "directOnly",
    directAvailable: true,
  };
  api.accountStatus.mockResolvedValue(account);
  api.setAccountVisible.mockResolvedValue(account);
});
describe("account phone connection", () => {
  it("closes from the visible close button", async () => {
    const onOpenChange = vi.fn();
    render(<MobileCompanionDialog open onOpenChange={onOpenChange} />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "关闭手机连接" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("does not register, pair or contact the backend while closed", () => {
    render(<MobileCompanionDialog open={false} onOpenChange={vi.fn()} />);
    expect(api.status).not.toHaveBeenCalled();
    expect(api.accountStatus).not.toHaveBeenCalled();
    expect(api.pair).not.toHaveBeenCalled();
  });
  it("keeps connection details collapsed until requested while retaining account enrollment", async () => {
    render(<MobileCompanionDialog open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(api.status).toHaveBeenCalledOnce());
    expect(screen.getByText("端到端加密 · 无需配对码")).toBeVisible();
    expect(
      screen.getByText("电脑需保持开机、联网并运行 LoliCode。"),
    ).toBeVisible();
    const fallback = screen.getByText(/文本通道只同步有大小和流量限制/);
    expect(fallback).not.toBeVisible();
    await userEvent.setup().click(screen.getByText("连接与功能说明"));
    expect(fallback).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /二维码|配对码|中继/ }),
    ).not.toBeInTheDocument();
    expect(api.pair).not.toHaveBeenCalled();
    expect(api.approve).not.toHaveBeenCalled();
  });
  it("opens the Android download page only when requested", async () => {
    render(<MobileCompanionDialog open onOpenChange={vi.fn()} />);
    expect(settingsApi.openExternal).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "下载 Android 应用" }));
    expect(settingsApi.openExternal).toHaveBeenCalledWith(
      "https://lolicode.com/mobile/",
    );
  });
  it("hides legacy rooms and another account's devices", async () => {
    api.status.mockResolvedValue({
      ...initial,
      pairs: [
        { ...device, accountId: null, deviceName: "Legacy phone" },
        { ...device, accountId: "8", deviceName: "Another account phone" },
      ],
    });
    render(<MobileCompanionDialog open accountId="7" onOpenChange={vi.fn()} />);
    await waitFor(() => expect(api.status).toHaveBeenCalledOnce());
    expect(screen.queryByText("Legacy phone")).not.toBeInTheDocument();
    expect(screen.queryByText("Another account phone")).not.toBeInTheDocument();
  });
  it("only marks an actual online direct route as connected and hides raw diagnostics", async () => {
    api.status.mockResolvedValue({
      ...initial,
      pairs: [{ ...device, online: false, lastError: "secret-ticket" }],
    });
    render(<MobileCompanionDialog open accountId="7" onOpenChange={vi.fn()} />);
    expect(await screen.findByText("连接未就绪")).toBeInTheDocument();
    expect(screen.queryByText("已直连 · 端到端加密")).not.toBeInTheDocument();
    expect(screen.queryByText("secret-ticket")).not.toBeInTheDocument();
    expect(
      screen.getByText("连接受限或文本额度已用尽，请查看设备状态后重试。"),
    ).toBeInTheDocument();
  });
  it("identifies text fallback separately from an actual direct route", async () => {
    api.status.mockResolvedValue({
      ...initial,
      pairs: [{ ...device, transport: "text" }],
    });
    render(<MobileCompanionDialog open accountId="7" onOpenChange={vi.fn()} />);
    expect(
      await screen.findByText("受限文本 · 端到端加密"),
    ).toBeInTheDocument();
    expect(screen.queryByText("已直连 · 端到端加密")).not.toBeInTheDocument();
  });
  it("revokes exactly the selected account connection after a local click", async () => {
    api.status.mockResolvedValue({ ...initial, pairs: [device] });
    render(<MobileCompanionDialog open accountId="7" onOpenChange={vi.fn()} />);
    expect(await screen.findByText("已直连 · 端到端加密")).toBeInTheDocument();
    expect(api.revoke).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "撤销连接" }));
    expect(api.revoke).toHaveBeenCalledWith(device.roomId);
  });
  it("does not restore a late device list after the dialog is closed", async () => {
    let finish!: (value: MobileCompanionStatus) => void;
    api.status.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(
      <MobileCompanionDialog open accountId="7" onOpenChange={vi.fn()} />,
    );
    await act(async () => {
      view.rerender(
        <MobileCompanionDialog
          open={false}
          accountId="7"
          onOpenChange={vi.fn()}
        />,
      );
    });
    await act(async () => finish({ ...initial, pairs: [device] }));
    await act(async () => {
      view.rerender(
        <MobileCompanionDialog open accountId="7" onOpenChange={vi.fn()} />,
      );
    });
    expect(screen.queryByText("Xiaomi 8 Lite")).not.toBeInTheDocument();
  });
});
