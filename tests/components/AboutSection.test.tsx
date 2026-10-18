import {
  act,
  fireEvent,
  render as renderBase,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSection } from "@/components/settings/AboutSection";
import { UpdateProvider } from "@/contexts/UpdateContext";
import { APP_CHANGELOG, APP_WEBSITE } from "@/lib/branding";
import { useSettingsMetadata } from "@/hooks/useSettingsMetadata";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const render = (ui: React.ReactNode) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderBase(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
};
vi.mock("@/lib/api/resource-updates", () => ({
  resourcePackKey: ["presentation-resource-pack"],
  resourceUpdatesApi: {
    local: async () => ({
      id: null,
      version: null,
      assets: {},
      canRollback: false,
      pendingConfirmation: false,
      warning: null,
    }),
  },
}));
vi.mock("@/lib/api/renderer-updates", () => ({
  rendererStatusKey: ["renderer-update-status"],
  rendererUpdatesApi: {
    local: async () => ({
      runningId: null,
      runningVersion: null,
      bootTicket: null,
      development: true,
      warning: null,
      state: {
        activeId: null,
        activeVersion: null,
        stagedVersion: null,
        restartRequired: false,
        pendingConfirmation: false,
        highestVersion: 0,
        canRollback: false,
      },
    }),
  },
}));

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  open: vi.fn(),
  portable: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@/lib/updater", () => ({ checkForUpdate: mocks.check }));
vi.mock("@/lib/api", () => ({
  settingsApi: {
    installUpdateAndRestart: mocks.install,
    openExternal: mocks.open,
    isPortable: mocks.portable,
  },
}));
vi.mock("@/lib/query/queries", () => ({
  useSettingsQuery: () => ({ isSuccess: true, data: { checkUpdates: false } }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "4.0.12" }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, fn);
    return () => {
      if (mocks.listeners.get(name) === fn) mocks.listeners.delete(name);
    };
  },
}));
vi.mock("@/lib/toast", () => ({ toast: mocks.toast }));
vi.mock("@/components/WhatsNewDialog", () => ({ WhatsNewDialog: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function mount(portable = false) {
  return render(
    <UpdateProvider>
      <AboutSection isPortable={portable} />
    </UpdateProvider>,
  );
}
async function discover() {
  fireEvent.click(
    screen.getByRole("button", { name: "settings.checkForUpdates" }),
  );
  await screen.findByText("LoliCode 4.0.13 release notes");
}
beforeEach(() => {
  mocks.check.mockReset().mockResolvedValue({
    status: "available",
    info: {
      currentVersion: "4.0.12",
      availableVersion: "4.0.13",
      notes: "LoliCode 4.0.13 release notes",
    },
  });
  mocks.install.mockReset().mockResolvedValue(false);
  mocks.open.mockReset().mockResolvedValue(undefined);
  mocks.listeners.clear();
  mocks.portable.mockReset().mockResolvedValue(false);
  localStorage.clear();
});

describe("software updates in About", () => {
  it("cannot install while portable detection is pending, even with cached settings and a discovered update", async () => {
    const detection = deferred<boolean>();
    mocks.portable.mockReturnValue(detection.promise);
    function MetadataAbout() {
      const { isPortable } = useSettingsMetadata();
      return <AboutSection isPortable={isPortable} />;
    }
    render(
      <UpdateProvider>
        <MetadataAbout />
      </UpdateProvider>,
    );
    await discover();
    expect(
      screen.queryByRole("button", { name: "下载并安装" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开下载页面" }));
    expect(mocks.open).toHaveBeenCalledWith(APP_WEBSITE);
    expect(mocks.install).not.toHaveBeenCalled();
    await act(async () => {
      detection.resolve(true);
      await detection.promise;
    });
    expect(screen.getByText("settings.portableMode")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "下载并安装" }),
    ).not.toBeInTheDocument();
  });

  it("keeps failed or malformed portable detection on the manual download path", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.portable.mockRejectedValue(new Error("Mode unavailable"));
    function MetadataAbout() {
      const { isPortable } = useSettingsMetadata();
      return <AboutSection isPortable={isPortable} />;
    }
    const view = render(
      <UpdateProvider>
        <MetadataAbout />
      </UpdateProvider>,
    );
    await discover();
    fireEvent.click(screen.getByRole("button", { name: "打开下载页面" }));
    expect(mocks.install).not.toHaveBeenCalled();
    expect(screen.getByText(/尚未确认安装方式/)).toBeInTheDocument();
    view.unmount();
    mocks.portable.mockResolvedValue(undefined);
    render(
      <UpdateProvider>
        <MetadataAbout />
      </UpdateProvider>,
    );
    await discover();
    expect(
      screen.queryByRole("button", { name: "下载并安装" }),
    ).not.toBeInTheDocument();
    expect(mocks.install).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("discovers an update without starting installation and links to the LoliCode site", async () => {
    mount();
    await discover();
    expect(screen.getByRole("button", { name: "下载并安装" })).toBeEnabled();
    expect(mocks.install).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.releaseNotes" }),
    );
    expect(mocks.open).toHaveBeenCalledWith(APP_CHANGELOG);
    expect(APP_CHANGELOG).toBe(
      "https://github.com/treasureGrove/LoliCode-Releases/releases",
    );
  });

  it("shows real progress and preserves the running operation when About is reopened", async () => {
    const download = deferred<boolean>();
    mocks.install.mockReturnValue(download.promise);
    const view = mount();
    await discover();
    fireEvent.click(screen.getByRole("button", { name: "下载并安装" }));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledOnce());
    act(() =>
      mocks.listeners.get("update-download-progress")?.({
        payload: { downloaded: 1048576, total: 2097152 },
      }),
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(screen.getByText("50% · 1.0 MB / 2.0 MB")).toBeInTheDocument();
    view.rerender(
      <UpdateProvider>
        <div>Other settings</div>
      </UpdateProvider>,
    );
    view.rerender(
      <UpdateProvider>
        <AboutSection isPortable={false} />
      </UpdateProvider>,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(
      screen.getByRole("button", { name: "正在下载更新包…" }),
    ).toBeDisabled();
    expect(mocks.install).toHaveBeenCalledOnce();
    act(() =>
      mocks.listeners.get("app-update-progress")?.({
        payload: { phase: "verifying" },
      }),
    );
    expect(
      screen.getByRole("button", { name: "正在校验更新包…" }),
    ).toBeDisabled();
    await act(async () => {
      download.resolve(true);
      await download.promise;
    });
    expect(
      screen.getByRole("button", { name: "正在安装并重启…" }),
    ).toBeDisabled();
  });

  it("shows readiness or signature errors, enables retry, and does not open a fallback download", async () => {
    mocks.install.mockRejectedValueOnce(
      new Error("仍有编程任务或授权/提问等待处理，请等待任务结束后重试更新。"),
    );
    mount();
    await discover();
    fireEvent.click(screen.getByRole("button", { name: "下载并安装" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("仍有编程任务");
    expect(mocks.open).not.toHaveBeenCalled();
    mocks.install.mockRejectedValueOnce(
      new Error("Signature verification failed"),
    );
    fireEvent.click(screen.getByRole("button", { name: "重试下载并安装" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Signature verification failed",
      ),
    );
    expect(mocks.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试下载并安装" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "下载并安装" }),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "settings.upToDate",
      expect.anything(),
    );
    expect(mocks.install).toHaveBeenCalledTimes(3);
  });

  it("never invents a percentage for a download without total size", async () => {
    const download = deferred<boolean>();
    mocks.install.mockReturnValue(download.promise);
    mount();
    await discover();
    fireEvent.click(screen.getByRole("button", { name: "下载并安装" }));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledOnce());
    act(() =>
      mocks.listeners.get("update-download-progress")?.({
        payload: { downloaded: 1048576, total: null },
      }),
    );
    expect(screen.getByRole("progressbar")).not.toHaveAttribute(
      "aria-valuenow",
    );
    expect(screen.getByText("1.0 MB")).toBeInTheDocument();
    await act(async () => {
      download.resolve(false);
      await download.promise;
    });
  });

  it("opens the tools download page for a portable build instead of installing", async () => {
    const page = deferred<void>();
    mocks.open.mockReturnValue(page.promise);
    mount(true);
    await discover();
    const button = screen.getByRole("button", { name: "打开下载页面" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledWith(APP_WEBSITE);
    expect(mocks.install).not.toHaveBeenCalled();
    await act(async () => {
      page.resolve();
      await page.promise;
    });
  });

  it("reports a failed check as an error rather than latest", async () => {
    mocks.check.mockRejectedValue(new Error("Feed unavailable"));
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.checkForUpdates" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Feed unavailable",
    );
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "settings.checkForUpdates" }),
    ).toBeEnabled();
  });
});
