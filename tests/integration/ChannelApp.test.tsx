import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/app/App";
import { setSettings } from "../msw/state";

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({ hasUpdate: false, updateInfo: null }),
}));

vi.mock("@/features/channels/ChannelCenterPanel", () => ({
  ChannelCenterPanel: () => (
    <div data-testid="channel-center">Shared channels</div>
  ),
}));

beforeEach(() => {
  localStorage.setItem("cc-switch-last-view", "channels");
  localStorage.removeItem("cc-switch-last-app");
  setSettings({
    firstRunNoticeConfirmed: true,
    newLayoutNoticeConfirmed: true,
    whatsNewSeenVersion: "4.0.10",
  });
});
describe("simple application shell", () => {
  it("opens the shared channel center without complex resource navigation", async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <App />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("channel-center")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "渠道与模型" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    for (const name of [
      "MCP",
      "Skills",
      "nav.sessions",
      "nav.prompts",
      "nav.auth",
    ])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });
  it.each(["auth", "providers", "openclawConfig", "workspace"])(
    "merges the old %s destination into the channel center",
    async (destination) => {
      localStorage.setItem("cc-switch-last-view", destination);
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <App />
        </QueryClientProvider>,
      );
      expect(await screen.findByTestId("channel-center")).toBeInTheDocument();
    },
  );
});
