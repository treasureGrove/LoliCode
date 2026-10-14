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

describe("task navigation and client context", () => {
  it("keeps task anchors in place when changing client and exposes every global destination", () => {
    const values = props();
    const { rerender } = mount(values);
    const workbench = screen.getByRole("button", { name: "工作台" });
    expect(workbench).toHaveAttribute("aria-current", "page");
    rerender(<Sidebar {...values} activeApp="openclaw" view="workspace" />);
    expect(screen.getByRole("button", { name: "工作台" })).toBe(workbench);
    fireEvent.click(workbench);
    expect(values.onSelectApp).toHaveBeenCalledWith("openclaw");
    for (const [name, page] of [
      [/^nav.usage/, "usage"],
      [/^nav.sessions/, "sessions"],
      [/^MCP$/, "mcp"],
      [/^Skills$/, "skills"],
      [/^nav.prompts/, "prompts"],
      [/^nav.auth/, "auth"],
      [/^nav.apps ·/, "apps"],
      [/^nav.settings ·/, "settings"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(values.onSelectPage).toHaveBeenLastCalledWith(page);
    }
    expect(
      screen.getByRole("img", { name: "nav.authNeedsReauth" }),
    ).toBeInTheDocument();
  });

  it("opens the independent client switcher by keyboard and chooses a visible client", async () => {
    const user = userEvent.setup();
    const values = props();
    mount(values);
    const trigger = screen.getByRole("button", {
      name: /^切换客户端 · Claude Code/,
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(APP_IDS.length);
    expect(
      screen.getByRole("menuitemradio", { name: "Claude Code" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: /Codex/ }));
    expect(values.onSelectApp).toHaveBeenCalledTimes(1);
    expect(values.onSelectApp).toHaveBeenCalledWith("codex");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps hidden clients out of the chooser and returns focus after Escape", async () => {
    const user = userEvent.setup();
    const values = props();
    values.visibleApps.codex = false;
    mount(values);
    const trigger = screen.getByRole("button", { name: /^切换客户端/ });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("menuitemradio", { name: /Codex/ }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(values.onSelectApp).not.toHaveBeenCalled();
  });

  it("retains all six settings groups, update information and the exit action", async () => {
    const values = props({ view: "settings", settingsSection: "network" });
    mount(values);
    for (const section of SETTINGS_SECTIONS) {
      const item = screen.getByRole("button", {
        name: new RegExp(`^settings.sections.${section}`),
      });
      if (section === "network")
        expect(item).toHaveAttribute("aria-current", "page");
      fireEvent.click(item);
      expect(values.onSelectSettingsSection).toHaveBeenLastCalledWith(section);
    }
    fireEvent.click(screen.getByRole("button", { name: "nav.back" }));
    expect(values.onExitSettings).toHaveBeenCalledOnce();
    expect(await screen.findByText("TAI Switch v4.0.10")).toBeInTheDocument();
  });

  it("keeps named controls and client choice reachable in the compact rail", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 900,
    });
    mount(props({ view: "skillsDiscovery" }));
    expect(screen.getByRole("navigation")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Skills" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("button", { name: /^切换客户端/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^nav.auth/ }),
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
