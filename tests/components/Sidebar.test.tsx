import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarProps } from "@/app/shell/Sidebar";
import { APP_IDS } from "@/config/appConfig";
import { SETTINGS_SECTIONS } from "@/lib/navigation";
import { useSidebarCollapsed } from "@/hooks/useSidebarCollapsed";
import type { VisibleApps } from "@/types";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server";
import { BUILTIN_APP_IDS, type BuiltinAppId } from "@/lib/api/builtin-apps";
import { SIDEBAR_TOOLS_KEY } from "@/hooks/useSidebarTools";
import { toast } from "@/lib/toast";

vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
let enabledTools: BuiltinAppId[];
let removalFails: boolean;
let appChanges: unknown[];
let pendingRemoval: Promise<void> | undefined;

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
    onOpenUpdates: vi.fn(),
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
  enabledTools = [];
  removalFails = false;
  appChanges = [];
  pendingRemoval = undefined;
  localStorage.removeItem(SIDEBAR_TOOLS_KEY);
  server.use(
    http.post("http://tauri.local/list_builtin_apps", () =>
      HttpResponse.json(
        BUILTIN_APP_IDS.map((id) => ({
          id,
          enabled: enabledTools.includes(id),
        })),
      ),
    ),
    http.post(
      "http://tauri.local/set_builtin_app_enabled",
      async ({ request }) => {
        const change = (await request.json()) as {
          app: BuiltinAppId;
          enabled: boolean;
        };
        appChanges.push(change);
        await pendingRemoval;
        if (removalFails)
          return new HttpResponse("disk unavailable", { status: 500 });
        enabledTools = enabledTools.filter((id) => id !== change.app);
        if (change.enabled) enabledTools.push(change.app);
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  localStorage.removeItem("cc-switch-sidebar-collapsed");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1000,
  });
});

describe("sidebar tool management", () => {
  it.each([
    ["skills", "技能"],
    ["workflows", "工作流与自动化"],
    ["memory", "记忆"],
  ] as const)("selects only the active %s panel in the rail", (tool, label) => {
    mount(props({ view: "agent", activeAgentTool: tool }));
    expect(screen.getByRole("button", { name: label })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("button", { name: "编程工作台" }),
    ).not.toHaveAttribute("aria-current");
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("opens workspace tools from the global rail", () => {
    const onOpenAgentTool = vi.fn();
    mount(props({ onOpenAgentTool }));
    fireEvent.click(screen.getByRole("button", { name: "技能" }));
    fireEvent.click(screen.getByRole("button", { name: "工作流与自动化" }));
    fireEvent.click(screen.getByRole("button", { name: "记忆" }));
    expect(onOpenAgentTool.mock.calls).toEqual([
      ["skills"],
      ["workflows"],
      ["memory"],
    ]);
  });
  it("collapses tools without changing the current page and restores the preference on remount", async () => {
    enabledTools = ["tavern", "rankings"];
    const values = props({ view: "tavern" });
    const first = mount(values);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "nav.tavern" });
    await user.click(screen.getByRole("button", { name: "nav.collapseTools" }));
    expect(
      screen.queryByRole("button", { name: "nav.tavern" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^渠道与模型/ })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "applications.title" }),
    ).toBeVisible();
    expect(values.onSelectPage).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(SIDEBAR_TOOLS_KEY)!)).toMatchObject({
      collapsed: true,
    });
    first.unmount();
    mount(values);
    const expand = await screen.findByRole("button", {
      name: "nav.expandTools",
    });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    await user.click(expand);
    expect(screen.getByRole("button", { name: "nav.tavern" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("pins tools above the folder in the latest pin order and keeps them visible when collapsed", async () => {
    enabledTools = ["tavern", "unreal", "rankings"];
    const first = mount(props());
    const user = userEvent.setup();
    for (const name of ["applications.rankings.title", "nav.tavern"]) {
      fireEvent.contextMenu(await screen.findByRole("button", { name }));
      await user.click(
        await screen.findByRole("menuitem", { name: "nav.pinTool" }),
      );
    }
    const pinned = screen.getByRole("group", { name: "nav.pinnedTools" });
    expect(
      within(pinned)
        .getAllByRole("button")
        .map((item) => item.getAttribute("data-sidebar-tool")),
    ).toEqual(["tavern", "rankings"]);
    await user.click(screen.getByRole("button", { name: "nav.collapseTools" }));
    expect(screen.getByRole("button", { name: "nav.tavern" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "nav.unreal" }),
    ).not.toBeInTheDocument();
    first.unmount();
    mount(props());
    await screen.findByRole("group", { name: "nav.pinnedTools" });
    fireEvent.contextMenu(screen.getByRole("button", { name: "nav.tavern" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "nav.unpinTool" }),
    );
    expect(
      screen.queryByRole("button", { name: "nav.tavern" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "nav.expandTools" }),
      ).toHaveFocus(),
    );
  });

  it("keeps left click and Enter as navigation and supports keyboard context menus with Escape", async () => {
    enabledTools = ["tavern"];
    const values = props();
    mount(values);
    const user = userEvent.setup();
    const item = await screen.findByRole("button", { name: "nav.tavern" });
    await user.click(item);
    expect(values.onSelectPage).toHaveBeenLastCalledWith("tavern");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(values.onSelectPage).toHaveBeenCalledTimes(2);
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(
      await screen.findByRole("menuitem", { name: "nav.removeTool" }),
    ).toBeVisible();
    expect(values.onSelectPage).toHaveBeenCalledTimes(2);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(item).toHaveFocus();
  });

  it("removes an active pinned tool through the existing opt-in API and keeps the other tools", async () => {
    enabledTools = ["tavern", "unreal"];
    localStorage.setItem(
      SIDEBAR_TOOLS_KEY,
      JSON.stringify({ collapsed: true, pinned: ["tavern"] }),
    );
    const values = props({ view: "tavern" });
    mount(values);
    const user = userEvent.setup();
    fireEvent.contextMenu(
      await screen.findByRole("button", { name: "nav.tavern" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "nav.removeTool" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "nav.tavern" }),
      ).not.toBeInTheDocument(),
    );
    expect(appChanges).toEqual([{ app: "tavern", enabled: false }]);
    expect(values.onSelectPage).toHaveBeenCalledWith("applications");
    expect(enabledTools).toEqual(["unreal"]);
    expect(JSON.parse(localStorage.getItem(SIDEBAR_TOOLS_KEY)!)).toEqual({
      collapsed: true,
      pinned: [],
    });
    await user.click(screen.getByRole("button", { name: "nav.expandTools" }));
    expect(screen.getByRole("button", { name: "nav.unreal" })).toBeVisible();
  });

  it("does not navigate away from a page opened while a tool is being removed", async () => {
    enabledTools = ["tavern"];
    let finish!: () => void;
    pendingRemoval = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const values = props({ view: "tavern" });
    const { rerender } = mount(values);
    const user = userEvent.setup();
    fireEvent.contextMenu(
      await screen.findByRole("button", { name: "nav.tavern" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "nav.removeTool" }),
    );
    await waitFor(() => expect(appChanges).toHaveLength(1));
    rerender(<Sidebar {...values} view="settings" />);
    finish();
    await waitFor(() => expect(enabledTools).toEqual([]));
    expect(values.onSelectPage).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "nav.back" })).toBeVisible();
  });

  it("preserves the tool and its pin when removal fails", async () => {
    enabledTools = ["tavern"];
    removalFails = true;
    localStorage.setItem(
      SIDEBAR_TOOLS_KEY,
      JSON.stringify({ collapsed: true, pinned: ["tavern"] }),
    );
    mount(props());
    const user = userEvent.setup();
    fireEvent.contextMenu(
      await screen.findByRole("button", { name: "nav.tavern" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "nav.removeTool" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "applications.changeFailed",
        expect.anything(),
      ),
    );
    expect(screen.getByRole("button", { name: "nav.tavern" })).toBeVisible();
    expect(JSON.parse(localStorage.getItem(SIDEBAR_TOOLS_KEY)!)).toMatchObject({
      pinned: ["tavern"],
    });
  });
});

describe("simple channel navigation", () => {
  it.each(["agent", "settings"] as const)(
    "keeps Apps directly above Updates at the bottom in %s",
    (view) => {
      const values = props({ view });
      const { container } = mount(values);
      const apps = screen.getByRole("button", { name: "applications.title" });
      const footer = container.querySelector(".tai-shell-footer")!;
      expect(footer).toContainElement(apps);
      expect(footer.querySelectorAll("button")[0]).toBe(apps);
      expect(footer.querySelectorAll("button")[1]).toHaveAccessibleName(
        /软件更新|nav.softwareUpdates/,
      );
      expect(
        container.querySelector(".tai-shell-directory"),
      ).not.toContainElement(apps);
      fireEvent.click(apps);
      expect(values.onSelectPage).toHaveBeenCalledWith("applications");
    },
  );
  it("opens software updates from the avatar menu and keeps the About entry available", async () => {
    const user = userEvent.setup();
    const values = props({ view: "settings" });
    mount(values);
    await user.click(screen.getByRole("button", { name: "头像与设置" }));
    const updates = screen.getByRole("menuitem", { name: /^软件更新/ });
    expect(updates).toHaveAccessibleName(/发现 LoliCode 新版本/);
    await user.click(updates);
    expect(values.onOpenUpdates).toHaveBeenCalledOnce();
    expect(values.onSelectPage).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: /^settings.sections.about/ }),
    );
    expect(values.onSelectSettingsSection).toHaveBeenLastCalledWith("about");
  });

  it("opens shared channels and retains only the core destinations", async () => {
    const user = userEvent.setup();
    const values = props({ view: "channels" });
    mount(values);
    const channels = screen.getByRole("button", { name: /^渠道与模型/ });
    expect(channels).toHaveAttribute("aria-current", "page");
    fireEvent.click(channels);
    expect(values.onSelectPage).toHaveBeenLastCalledWith("channels");
    for (const [name, page] of [
      [/^nav.usage/, "usage"],
      [/^编程工作台/, "agent"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(values.onSelectPage).toHaveBeenLastCalledWith(page);
    }
    await user.click(screen.getByRole("button", { name: "头像与设置" }));
    await user.click(screen.getByRole("menuitem", { name: "设置" }));
    expect(values.onSelectPage).toHaveBeenLastCalledWith("settings");
    expect(
      screen.queryByRole("button", { name: /^nav.sessions/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^nav.apps(?: ·|$)/ }),
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
    expect(channels).toHaveAccessibleName(/nav.authNeedsReauth/);
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
    expect(screen.getByRole("navigation")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(screen.queryByText("LoliCode v4.0.10")).not.toBeInTheDocument();
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
