import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/app/App";
import type { AgentPageProps } from "@/features/agent/AgentPage";
import { setSettings } from "../msw/state";

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({ hasUpdate: false, updateInfo: null }),
}));
vi.mock("@/features/agent/AgentPage", () => ({
  AgentPage: ({
    onOpenChannels,
    renderSidebar,
    toolRequest,
  }: AgentPageProps) => (
    <div data-testid="agent-workspace">
      {renderSidebar?.({
        actions: <button>新对话</button>,
        workspace: <div data-testid="workspace-tree">项目与对话</div>,
        onCollapse: () => undefined,
      })}
      {toolRequest?.tool && (
        <div
          data-testid="active-agent-tool"
          data-initial-tab={toolRequest.initialTab}
        >
          {toolRequest.tool}
        </div>
      )}
      <button onClick={onOpenChannels}>添加模型渠道</button>
    </div>
  ),
}));
vi.mock("@/features/channels/ChannelCenterPanel", () => ({
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
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();
    expect(
      container.querySelectorAll(".lolicode-unified-sidebar"),
    ).toHaveLength(1);
    expect(screen.getByRole("navigation")).toHaveAttribute(
      "data-collapsed",
      "false",
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

  it("reaches usage and applications through the unified sidebar More menu", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <App />
      </QueryClientProvider>,
    );
    await screen.findByTestId("agent-workspace");
    await user.click(
      screen.getByRole("button", { name: /^(更多|common\.more)(?: ·|$)/ }),
    );
    expect(
      screen.getByRole("menuitem", { name: /^nav.usage/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^applications.title/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /^nav.usage/ }));
    expect(document.getElementById("content-area")).toHaveAttribute(
      "data-view",
      "usage",
    );
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "编程工作台" }));
    expect(await screen.findByTestId("workspace-tree")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /^(更多|common\.more)(?: ·|$)/ }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: /^applications.title/ }),
    );
    expect(document.getElementById("content-area")).toHaveAttribute(
      "data-view",
      "applications",
    );
  });

  it("opens automation and plugins without creating a second navigation, and returns to chat", async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <App />
      </QueryClientProvider>,
    );
    await screen.findByTestId("agent-workspace");
    fireEvent.click(screen.getByRole("button", { name: "自动化" }));
    expect(screen.getByTestId("active-agent-tool")).toHaveTextContent(
      "workflows",
    );
    expect(screen.getByTestId("active-agent-tool")).toHaveAttribute(
      "data-initial-tab",
      "automation",
    );
    expect(screen.getByRole("button", { name: "自动化" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "插件市场" }));
    expect(screen.getByTestId("active-agent-tool")).toHaveTextContent("skills");
    expect(screen.getByTestId("active-agent-tool")).toHaveAttribute(
      "data-initial-tab",
      "plugins",
    );
    expect(screen.getByRole("button", { name: "插件市场" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "编程工作台" }));
    expect(screen.queryByTestId("active-agent-tool")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();
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
