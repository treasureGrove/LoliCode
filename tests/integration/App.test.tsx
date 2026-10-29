import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import App from "@/app/App";
import { providersApi } from "@/lib/api/providers";
import { proxyApi } from "@/lib/api/proxy";
import { settingsApi } from "@/lib/api/settings";
import { discardUnsavedChanges } from "@/lib/unsavedChanges";
import { VIEW_STORAGE_KEY } from "@/lib/navigation";
import {
  getProviders,
  getSettings,
  resetProviderState,
  setSettings,
} from "../msw/state";
import { emitTauriEvent } from "../msw/tauriMocks";
import { server } from "../msw/server";

// Exercise the production shell and its real navigation. Retired per-client
// provider editors are deliberately not reinstated by a test-only router.
const { toastError, toastSuccess, checkUpdate } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  checkUpdate: vi.fn(async () => false),
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: toastError, success: toastSuccess, warning: vi.fn() },
}));
vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({ hasUpdate: false, updateInfo: null, checkUpdate }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "4.0.18" }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setDecorations: async () => undefined }),
}));
vi.mock("@/app/shell/WindowControls", () => ({
  WindowControls: () => null,
}));
vi.mock("@/features/agent/AgentPage", () => ({
  AgentPage: ({
    onOpenChannels,
    onCheckUpdate,
  }: {
    onOpenChannels: () => void;
    onCheckUpdate: () => void;
  }) => (
    <div data-testid="agent-workspace">
      <button onClick={onOpenChannels}>manage-channels</button>
      <button onClick={onCheckUpdate}>check-product-update</button>
    </div>
  ),
}));
vi.mock("@/features/channels/ChannelCenterPanel", async () => {
  const { useUnsavedChangesTracker } = await vi.importActual<
    typeof import("@/lib/unsavedChanges")
  >("@/lib/unsavedChanges");
  return {
    ChannelCenterPanel: ({
      onNavigationBlockedChange,
      initialToolsOpen,
    }: {
      onNavigationBlockedChange: (busy: boolean) => void;
      initialToolsOpen?: boolean;
    }) => (
      <div
        data-testid="channel-center"
        data-tools-open={Boolean(initialToolsOpen)}
      >
        <div {...useUnsavedChangesTracker()}>
          <input aria-label="channel-draft" />
        </div>
        <button onClick={() => onNavigationBlockedChange(true)}>
          start-channel-operation
        </button>
        <button onClick={() => onNavigationBlockedChange(false)}>
          finish-channel-operation
        </button>
      </div>
    ),
  };
});
vi.mock("@/features/settings/SettingsPage", () => ({
  SettingsPage: ({
    section,
    onImportSuccess,
  }: {
    section: string;
    onImportSuccess: () => Promise<void>;
  }) => (
    <div data-testid="settings-page" data-section={section}>
      <button onClick={() => void onImportSuccess()}>
        config-import-completed
      </button>
    </div>
  ),
}));
vi.mock("@/features/usage/SimpleUsagePage", () => ({
  SimpleUsagePage: () => <div data-testid="usage-page" />,
}));

const clients = new Set<QueryClient>();
function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.add(client);
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  resetProviderState();
  discardUnsavedChanges();
  localStorage.removeItem(VIEW_STORAGE_KEY);
  localStorage.removeItem("cc-switch-last-app");
  setSettings({
    firstRunNoticeConfirmed: true,
    newLayoutNoticeConfirmed: false,
    whatsNewSeenVersion: "4.0.18",
  });
  checkUpdate.mockResolvedValue(false);
});
afterEach(() => {
  for (const client of clients) client.clear();
  clients.clear();
  discardUnsavedChanges();
  vi.restoreAllMocks();
});

describe("LoliCode product shell with retained native compatibility", () => {
  it("starts in the Agent without legacy provider prefetch or configuration rewrites", async () => {
    const getAll = vi.spyOn(providersApi, "getAll");
    const save = vi.spyOn(settingsApi, "save");
    const beforeSettings = getSettings();
    const beforeProviders = getProviders("claude");
    renderApp();
    expect(await screen.findByTestId("agent-workspace")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(getAll).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(getProviders("claude")).toEqual(beforeProviders);
    expect(getSettings()).toEqual(beforeSettings);
    expect(
      screen.queryByRole("button", { name: "Claude Code" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "MCP" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    "providers",
    "workspace",
    "openclawConfig",
    "openclawEnv",
    "openclawTools",
    "openclawAgents",
    "auth",
  ])("migrates the saved %s view into shared channels", async (view) => {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
    renderApp();
    expect(await screen.findByTestId("channel-center")).toBeInTheDocument();
    expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe("channels");
  });
  it.each([
    "mcp",
    "skills",
    "skillsDiscovery",
    "prompts",
    "sessions",
    "hermesMemory",
  ])("migrates the saved %s view into the Agent workspace", async (view) => {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
    renderApp();
    expect(await screen.findByTestId("agent-workspace")).toBeInTheDocument();
    expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe("agent");
  });

  it("retains the old apps intent as the shared local Agent tools card", async () => {
    localStorage.setItem(VIEW_STORAGE_KEY, "apps");
    renderApp();
    expect(await screen.findByTestId("channel-center")).toHaveAttribute(
      "data-tools-open",
      "true",
    );
  });

  it("navigates between the Agent, shared channels, and usage", async () => {
    renderApp();
    fireEvent.click(
      await screen.findByRole("button", { name: "manage-channels" }),
    );
    expect(await screen.findByTestId("channel-center")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "nav.usage" }));
    expect(await screen.findByTestId("usage-page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编程工作台" }));
    expect(await screen.findByTestId("agent-workspace")).toBeInTheDocument();
  });

  it("protects the channel draft on sidebar and keyboard navigation", async () => {
    localStorage.setItem(VIEW_STORAGE_KEY, "channels");
    renderApp();
    const draft = await screen.findByLabelText("channel-draft");
    fireEvent.input(draft, { target: { value: "draft route" } });
    fireEvent.click(screen.getByRole("button", { name: "编程工作台" }));
    expect(
      await screen.findByText("common.unsavedLeaveMessage"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "common.unsavedLeaveCancel" }),
    );
    expect(draft).toHaveValue("draft route");
    expect(screen.queryByTestId("agent-workspace")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(
      await screen.findByText("common.unsavedLeaveMessage"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "common.unsavedLeaveConfirm" }),
    );
    expect(await screen.findByTestId("settings-page")).toBeInTheDocument();
    expect(screen.queryByLabelText("channel-draft")).not.toBeInTheDocument();
  });

  it("keeps a running channel operation mounted until it can be left safely", async () => {
    localStorage.setItem(VIEW_STORAGE_KEY, "channels");
    renderApp();
    fireEvent.click(
      await screen.findByRole("button", { name: "start-channel-operation" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "编程工作台" }));
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(screen.getByTestId("channel-center")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-page")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "finish-channel-operation" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "编程工作台" }));
    expect(await screen.findByTestId("agent-workspace")).toBeInTheDocument();
  });

  it("returns to the previous product page when closing settings with Escape", async () => {
    renderApp();
    await screen.findByTestId("agent-workspace");
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(await screen.findByTestId("settings-page")).toHaveAttribute(
      "data-section",
      "general",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByTestId("agent-workspace")).toBeInTheDocument();
  });

  it.each(["webdav", "s3"])(
    "retains null-safe background %s failure notifications",
    async (source) => {
      renderApp();
      await screen.findByTestId("agent-workspace");
      expect(() =>
        emitTauriEvent(`${source}-sync-status-updated`, null),
      ).not.toThrow();
      expect(toastError).not.toHaveBeenCalled();
      emitTauriEvent(`${source}-sync-status-updated`, {
        source: "auto",
        status: "error",
        error: "network timeout",
      });
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          `settings.${source === "s3" ? "s3Sync" : "webdavSync"}.autoSyncFailedToast`,
        ),
      );
    },
  );

  it("shows startup route recovery failures without restoring the old provider UI", async () => {
    vi.spyOn(proxyApi, "takeStartupAttachFailures").mockResolvedValue([
      { appType: "codex", stack: true, error: "fixture route unavailable" },
    ]);
    renderApp();
    expect(await screen.findByTestId("agent-workspace")).toBeInTheDocument();
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "部分本地客户端路由未能恢复，请在渠道与模型中检查配置。",
        expect.objectContaining({ description: "codex" }),
      ),
    );
  });

  it("keeps universal-provider synchronization and tray refresh active", async () => {
    const updateTray = vi
      .spyOn(providersApi, "updateTrayMenu")
      .mockResolvedValue(true);
    const client = renderApp();
    client.setQueryData(["providers", "codex"], { preserved: true });
    await screen.findByTestId("agent-workspace");
    emitTauriEvent("universal-provider-synced", {});
    await waitFor(() => expect(updateTray).toHaveBeenCalled());
    expect(client.getQueryState(["providers", "codex"])?.isInvalidated).toBe(
      true,
    );
  });

  it("retains migration notices for native configuration and skills", async () => {
    server.use(
      http.post("http://tauri.local/get_migration_result", () =>
        HttpResponse.json(true),
      ),
      http.post("http://tauri.local/get_skills_migration_result", () =>
        HttpResponse.json({ count: 3 }),
      ),
    );
    renderApp();
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "配置迁移成功",
        expect.any(Object),
      ),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "migration.skillsSuccess",
        expect.any(Object),
      ),
    );
  });

  it("uses the product updater from the Agent workspace", async () => {
    renderApp();
    fireEvent.click(
      await screen.findByRole("button", { name: "check-product-update" }),
    );
    await waitFor(() => expect(checkUpdate).toHaveBeenCalledOnce());
    expect(toastSuccess).toHaveBeenCalledWith("settings.upToDate");
  });

  it("refreshes compatible configuration caches after import without a provider page", async () => {
    const updateTray = vi
      .spyOn(providersApi, "updateTrayMenu")
      .mockResolvedValue(true);
    const client = renderApp();
    client.setQueryData(["providers", "codex"], { preserved: true });
    await screen.findByTestId("agent-workspace");
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "config-import-completed" }),
    );
    await waitFor(() => expect(updateTray).toHaveBeenCalled());
    expect(client.getQueryState(["providers", "codex"])?.isInvalidated).toBe(
      true,
    );
  });
});
