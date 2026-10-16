import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { setSettings } from "../msw/state";

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({ hasUpdate: false, updateInfo: null }),
}));
vi.mock("@/components/agent/AgentPage", () => ({
  AgentPage: ({ onOpenChannels }: { onOpenChannels: () => void }) => (
    <div data-testid="agent-workspace">
      <button onClick={onOpenChannels}>添加模型渠道</button>
    </div>
  ),
}));
vi.mock("@/components/channels/ChannelCenterPanel", () => ({
  ChannelCenterPanel: ({
    initialToolsOpen,
  }: {
    initialToolsOpen?: boolean;
  }) => (
    <div
      data-testid="channel-center"
      data-tools-open={Boolean(initialToolsOpen)}
    >
      Channels
    </div>
  ),
}));

beforeEach(() => {
  localStorage.removeItem("cc-switch-last-view");
  localStorage.removeItem("cc-switch-last-app");
  setSettings({
    firstRunNoticeConfirmed: true,
    newLayoutNoticeConfirmed: true,
    whatsNewSeenVersion: "4.0.10",
  });
});

describe("LoliCode desktop entry", () => {
  it("opens the coding workspace and reaches shared channels from onboarding", async () => {
    const { container } = render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <App />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("agent-workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编程工作台" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("button", { name: "头像与设置" }),
    ).toBeInTheDocument();
    expect(container.querySelector(".tai-shell-mark")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^应用(?: ·|$)/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("navigation")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(
      screen.queryByRole("heading", { name: "LoliCode" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加模型渠道" }));
    expect(await screen.findByTestId("channel-center")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "渠道与模型" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.queryByRole("button", { name: "授权中心" }),
    ).not.toBeInTheDocument();
  });
  it("opens the local Agent tools card within channels for the old apps route", async () => {
    localStorage.setItem("cc-switch-last-view", "apps");
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <App />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("channel-center")).toHaveAttribute(
      "data-tools-open",
      "true",
    );
    expect(screen.getByRole("button", { name: "渠道与模型" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
