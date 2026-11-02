import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/app/App";
import type { AgentPageProps } from "@/features/agent/AgentPage";
import type { GlobalPage, SettingsSection } from "@/lib/navigation";
import { setSettings } from "../msw/state";

const state = vi.hoisted(() => ({ unsaved: false }));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({ hasUpdate: false, updateInfo: null }),
}));
vi.mock("@/lib/unsavedChanges", () => ({
  hasUnsavedChanges: () => state.unsaved,
  discardUnsavedChanges: () => {
    state.unsaved = false;
  },
}));
vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    onConfirm,
    onCancel,
  }: {
    isOpen: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label="未保存的修改">
        <button onClick={onConfirm}>放弃修改</button>
        <button onClick={onCancel}>继续编辑</button>
      </div>
    ) : null,
}));
vi.mock("@/app/shell/Sidebar", () => ({
  Sidebar: ({
    onSelectPage,
    onSelectSettingsSection,
  }: {
    onSelectPage: (page: GlobalPage | "settings") => void;
    onSelectSettingsSection: (section: SettingsSection) => void;
  }) => (
    <nav aria-label="测试导航">
      <button onClick={() => onSelectPage("agent")}>工作台</button>
      <button onClick={() => onSelectPage("channels")}>渠道</button>
      <button onClick={() => onSelectPage("settings")}>设置</button>
      <button onClick={() => onSelectSettingsSection("about")}>选择关于</button>
      <button onClick={() => onSelectPage("allowance")}>使用情况与额度</button>
    </nav>
  ),
}));
vi.mock("@/features/agent/AgentPage", () => ({
  AgentPage: ({ renderSidebar }: AgentPageProps) => (
    <div data-testid="agent-workspace">
      {renderSidebar?.({
        actions: null,
        workspace: null,
        onCollapse: () => undefined,
      })}
      工作台内容
    </div>
  ),
}));
vi.mock("@/features/settings/SettingsPage", () => ({
  SettingsPage: ({ section }: { section: SettingsSection }) => (
    <div data-testid="settings-page">{section}</div>
  ),
}));
vi.mock("@/features/channels/ChannelCenterPanel", () => ({
  ChannelCenterPanel: ({
    onNavigationBlockedChange,
  }: {
    onNavigationBlockedChange: (blocked: boolean) => void;
  }) => (
    <div data-testid="channel-center">
      <button onClick={() => onNavigationBlockedChange(true)}>开始保存</button>
      <button onClick={() => onNavigationBlockedChange(false)}>完成保存</button>
    </div>
  ),
}));
vi.mock("@/features/usage/LolicodeAllowancePage", () => ({
  LolicodeAllowancePage: ({ onBack }: { onBack: () => void }) => (
    <section data-testid="allowance-page">
      <h1>使用情况与额度</h1>
      <button onClick={onBack}>返回上一页</button>
    </section>
  ),
}));

beforeEach(() => {
  state.unsaved = false;
  localStorage.removeItem("cc-switch-last-view");
  localStorage.removeItem("cc-switch-last-app");
  setSettings({
    firstRunNoticeConfirmed: true,
    newLayoutNoticeConfirmed: true,
    whatsNewSeenVersion: "4.0.10",
  });
});

function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <App />
    </QueryClientProvider>,
  );
}

describe("standalone allowance navigation", () => {
  it("returns to its entry page through the back button or Escape", async () => {
    mount();
    await screen.findByTestId("agent-workspace");
    fireEvent.click(screen.getByRole("button", { name: "使用情况与额度" }));
    expect(await screen.findByTestId("allowance-page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回上一页" }));
    expect(await screen.findByTestId("agent-workspace")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "渠道" }));
    await screen.findByTestId("channel-center");
    fireEvent.click(screen.getByRole("button", { name: "使用情况与额度" }));
    await screen.findByTestId("allowance-page");
    // Re-entering the current destination must not replace its return target.
    fireEvent.click(screen.getByRole("button", { name: "使用情况与额度" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByTestId("channel-center")).toBeInTheDocument();
  });

  it("preserves the settings section and its own previous-page target", async () => {
    mount();
    await screen.findByTestId("agent-workspace");
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByTestId("settings-page");
    fireEvent.click(screen.getByRole("button", { name: "选择关于" }));
    expect(screen.getByTestId("settings-page")).toHaveTextContent("about");
    fireEvent.click(screen.getByRole("button", { name: "使用情况与额度" }));
    await screen.findByTestId("allowance-page");
    fireEvent.click(screen.getByRole("button", { name: "返回上一页" }));
    expect(await screen.findByTestId("settings-page")).toHaveTextContent(
      "about",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByTestId("agent-workspace")).toBeInTheDocument();
  });

  it("offers a route back to the workspace when restored directly on startup", async () => {
    localStorage.setItem("cc-switch-last-view", "allowance");
    mount();
    await screen.findByTestId("allowance-page");
    fireEvent.click(screen.getByRole("button", { name: "返回上一页" }));
    expect(await screen.findByTestId("agent-workspace")).toBeInTheDocument();
  });

  it("waits for an in-progress channel save before opening the allowance page", async () => {
    localStorage.setItem("cc-switch-last-view", "channels");
    mount();
    await screen.findByTestId("channel-center");
    fireEvent.click(screen.getByRole("button", { name: "开始保存" }));
    fireEvent.click(screen.getByRole("button", { name: "使用情况与额度" }));
    expect(screen.queryByTestId("allowance-page")).not.toBeInTheDocument();
    expect(screen.getByTestId("channel-center")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "完成保存" }));
    fireEvent.click(screen.getByRole("button", { name: "使用情况与额度" }));
    expect(await screen.findByTestId("allowance-page")).toBeInTheDocument();
  });

  it("respects unsaved changes both when entering and when returning", async () => {
    mount();
    await screen.findByTestId("agent-workspace");
    state.unsaved = true;
    fireEvent.click(screen.getByRole("button", { name: "使用情况与额度" }));
    expect(screen.queryByTestId("allowance-page")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByTestId("agent-workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "使用情况与额度" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    await screen.findByTestId("allowance-page");

    state.unsaved = true;
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("allowance-page")).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "未保存的修改" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(await screen.findByTestId("agent-workspace")).toBeInTheDocument();
  });
});
