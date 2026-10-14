import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarProps } from "@/components/shell/Sidebar";
import { APP_IDS } from "@/config/appConfig";
import { SETTINGS_SECTIONS } from "@/lib/navigation";
import { useSidebarCollapsed } from "@/hooks/useSidebarCollapsed";
import type { VisibleApps } from "@/types";

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({ hasUpdate: true }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "4.0.10" }));
vi.mock("@/hooks/useSidebarStatus", () => ({
  useSidebarStatus: () => ({
    appStatus: (app: string) => ({
      mode: app === "codex" ? "route" : "direct",
      mapping: false,
      alert: app === "codex",
    }),
    todayCost: 1.25,
    authNeedsAttention: true,
  }),
}));

function props(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    activeApp: "claude",
    view: "providers",
    visibleApps: Object.fromEntries(
      APP_IDS.map((app) => [app, true]),
    ) as unknown as VisibleApps,
    settingsSection: "general",
    onSelectApp: vi.fn(),
    onSelectPage: vi.fn(),
    onSelectSettingsSection: vi.fn(),
    onExitSettings: vi.fn(),
    appsUpdateAvailable: true,
    ...overrides,
  };
}
function mount(values: SidebarProps) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<Sidebar {...values} />, { wrapper });
}

beforeEach(() => {
  localStorage.removeItem("cc-switch-sidebar-collapsed");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1000,
  });
});

describe("simple channel navigation", () => {
  it("opens shared channels and retains only the core destinations", () => {
    const values = props({ view: "channels" });
    mount(values);
    const channels = screen.getByRole("button", { name: /^渠道与模型/ });
    expect(channels).toHaveAttribute("aria-current", "page");
    fireEvent.click(channels);
    expect(values.onSelectPage).toHaveBeenLastCalledWith("channels");
    for (const [name, page] of [
      [/^nav.usage/, "usage"],
      [/^nav.apps ·/, "apps"],
      [/^nav.settings ·/, "settings"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(values.onSelectPage).toHaveBeenLastCalledWith(page);
    }
    expect(
      screen.queryByRole("button", { name: /^nav.sessions/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^nav.auth/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "MCP" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Skills" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^nav.prompts/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^切换客户端/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "nav.authNeedsReauth" }),
    ).toBeInTheDocument();
  });

  it("keeps the channel destination stable across legacy client views", () => {
    const values = props();
    const { rerender } = mount(values);
    const channels = screen.getByRole("button", { name: /^渠道与模型/ });
    rerender(<Sidebar {...values} activeApp="openclaw" view="workspace" />);
    expect(screen.getByRole("button", { name: /^渠道与模型/ })).toBe(channels);
    fireEvent.click(channels);
    expect(values.onSelectPage).toHaveBeenCalledWith("channels");
    expect(values.onSelectApp).not.toHaveBeenCalled();
  });

  it("keeps ordinary settings and removes the complex routing entry", async () => {
    const values = props({ view: "settings", settingsSection: "network" });
    mount(values);
    for (const section of SETTINGS_SECTIONS.filter(
      (section) => section !== "routing",
    )) {
      const item = screen.getByRole("button", {
        name: new RegExp(`^settings.sections.${section}`),
      });
      if (section === "network")
        expect(item).toHaveAttribute("aria-current", "page");
      fireEvent.click(item);
      expect(values.onSelectSettingsSection).toHaveBeenLastCalledWith(section);
    }
    expect(
      screen.queryByRole("button", { name: /^settings.sections.routing/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "nav.back" }));
    expect(values.onExitSettings).toHaveBeenCalledOnce();
    expect(await screen.findByText("Lolicode v4.0.10")).toBeInTheDocument();
  });

  it("keeps named keyboard controls reachable in the compact rail", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 900,
    });
    const values = props({ view: "channels" });
    mount(values);
    expect(screen.getByRole("navigation")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    const channels = screen.getByRole("button", { name: /^渠道与模型/ });
    expect(channels).toHaveAttribute("aria-current", "page");
    channels.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(values.onSelectPage).toHaveBeenCalledWith("channels");
    expect(
      screen.getByRole("button", { name: /^渠道与模型/ }),
    ).toHaveAccessibleName(/nav.authNeedsReauth/);
  });
});
describe("sidebar width preference", () => {
  it("uses the latest intent for rapid reversal and retains manual preference across resize", () => {
    const { result } = renderHook(() => useSidebarCollapsed({ current: null }));
    expect(result.current.collapsed).toBe(false);
    act(() => {
      for (let n = 0; n < 10; n++) result.current.toggle();
    });
    expect(result.current.collapsed).toBe(false);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem("cc-switch-sidebar-collapsed")).toBe("true");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
    fireEvent(window, new Event("resize"));
    expect(result.current.collapsed).toBe(true);
  });

  it("responds to its keyboard shortcut once per press and removes the listener on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useSidebarCollapsed({ current: null }),
    );
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(result.current.collapsed).toBe(true);
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true, repeat: true });
    expect(result.current.collapsed).toBe(true);
    unmount();
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(localStorage.getItem("cc-switch-sidebar-collapsed")).toBe("true");
  });
});
