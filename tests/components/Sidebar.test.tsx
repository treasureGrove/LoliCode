import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { Sidebar, type SidebarProps } from "@/app/shell/Sidebar";
import { APP_IDS } from "@/config/appConfig";
import { BUILTIN_APP_IDS } from "@/lib/api/builtin-apps";
import { SETTINGS_SECTIONS } from "@/lib/navigation";
import { useSidebarCollapsed } from "@/hooks/useSidebarCollapsed";
import { SIDEBAR_TOOLS_KEY } from "@/hooks/useSidebarTools";
import type { VisibleApps } from "@/types";
import { server } from "../msw/server";

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({ hasUpdate: true }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "4.0.10" }));
vi.mock("@/hooks/useSidebarStatus", () => ({
  useSidebarStatus: () => ({ todayCost: 1.25, authNeedsAttention: true }),
}));

let appChanges: unknown[];

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

const moreButton = () =>
  screen.getByRole("button", { name: /^(更多|common\.more)(?: ·|$)/ });

beforeEach(() => {
  appChanges = [];
  localStorage.removeItem(SIDEBAR_TOOLS_KEY);
  localStorage.removeItem("cc-switch-sidebar-collapsed");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1000,
  });
  server.use(
    http.post("http://tauri.local/list_builtin_apps", () =>
      HttpResponse.json(BUILTIN_APP_IDS.map((id) => ({ id, enabled: true }))),
    ),
    http.post(
      "http://tauri.local/set_builtin_app_enabled",
      async ({ request }) => {
        appChanges.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
});

describe("unified workspace navigation", () => {
  it("shows Agent and character chat tabs with accessible destination names", () => {
    const values = props({ view: "agent" });
    mount(values);
    const navigation = screen.getByRole("navigation");
    expect(navigation).toHaveAttribute("data-collapsed", "false");
    for (const name of [
      /^编程工作台/,
      /^角色对话/,
      /^(更多|common\.more)(?: ·|$)/,
    ]) {
      const button = within(navigation).getByRole("button", { name });
      expect(button).toHaveAccessibleName();
    }
    expect(screen.getByRole("button", { name: "角色对话" })).toHaveTextContent(
      "对话",
    );
    expect(
      screen.getByRole("button", { name: "编程工作台" }),
    ).toHaveTextContent("代理");
    expect(screen.getByRole("button", { name: "自动化" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "插件市场" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编程工作台" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens Agent, character chat, and the More destinations", async () => {
    const values = props({ view: "channels" });
    mount(values);
    for (const [name, page] of [
      [/^角色对话/, "tavern"],
      [/^编程工作台/, "agent"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(values.onSelectPage).toHaveBeenLastCalledWith(page);
    }
    const user = userEvent.setup();
    for (const [name, page] of [
      [/^nav.usage/, "usage"],
      [/^applications.title/, "applications"],
    ] as const) {
      await user.click(moreButton());
      const item = screen.getByRole("menuitem", { name });
      if (page === "usage") expect(item).toHaveAccessibleName(/\$1\.25/);
      await user.click(item);
      expect(values.onSelectPage).toHaveBeenLastCalledWith(page);
    }
    expect(values.onSelectApp).not.toHaveBeenCalled();
  });

  it("keeps character shortcuts usable when the chat sidebar is compact", async () => {
    server.use(
      http.post("http://tauri.local/get_tavern_snapshot", () =>
        HttpResponse.json({
          characters: [{ id: "friend", name: "小梨", hasAvatar: false }],
          stories: [],
        }),
      ),
    );
    const onSelect = vi.fn();
    mount(
      props({
        view: "tavern",
        selectedTavernCharacterId: "friend",
        onSelectTavernCharacter: onSelect,
      }),
    );
    const friend = await screen.findByRole("button", { name: "小梨" });
    expect(friend).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(screen.getByRole("navigation")).toHaveAttribute(
      "data-sidebar-compact",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "展开侧栏" }),
    ).toBeInTheDocument();
    fireEvent.click(friend);
    expect(onSelect).toHaveBeenCalledWith("friend");
    expect(screen.getByRole("button", { name: "角色对话" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.queryByRole("button", { name: "自动化" }),
    ).not.toBeInTheDocument();
  });

  it("opens automation and plugins directly while retaining chat as their parent destination", async () => {
    const onOpenAgentTool = vi.fn();
    const values = props({
      view: "agent",
      activeAgentTool: "workflows",
      onOpenAgentTool,
    });
    mount(values);
    expect(screen.getByRole("button", { name: "自动化" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "编程工作台" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "自动化" }));
    expect(onOpenAgentTool).toHaveBeenLastCalledWith("workflows", "automation");
    await user.click(screen.getByRole("button", { name: "插件市场" }));
    expect(onOpenAgentTool).toHaveBeenLastCalledWith("skills", "plugins");
    expect(values.onSelectPage).not.toHaveBeenCalled();
  });

  it("embeds the actual workspace actions and tree without duplicating task creation", () => {
    const onCollapse = vi.fn();
    const onCreate = vi.fn();
    mount(
      props({
        embedded: true,
        view: "agent",
        onCollapse,
        workspaceActions: <button onClick={onCreate}>新建任务</button>,
        workspaceContent: <div aria-label="项目列表">当前工作区</div>,
      }),
    );
    expect(screen.getByRole("navigation")).toHaveAttribute(
      "data-embedded",
      "true",
    );
    expect(screen.getByLabelText("项目列表")).toHaveTextContent("当前工作区");
    const tree = screen.getByLabelText("项目列表");
    const tools = screen.getByRole("group", { name: "工作台工具" });
    expect(
      tree.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      tools.compareDocumentPosition(moreButton()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(tools).getByRole("button", { name: "插件市场" }),
    ).toHaveTextContent("插件");
    expect(
      within(tools).getByRole("button", { name: "插件市场" }),
    ).toHaveAttribute("title", "插件市场");
    expect(
      screen.queryByRole("button", { name: "开始对话" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    expect(onCreate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it.each([
    ["skills", "技能"],
    ["workflows", "工作流与自动化"],
    ["memory", "记忆"],
  ] as const)("marks the active %s panel inside More", async (tool, label) => {
    const values = props({ view: "agent", activeAgentTool: tool });
    mount(values);
    expect(moreButton()).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("button", { name: "编程工作台" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.queryByRole("button", { name: label }),
    ).not.toBeInTheDocument();
    await userEvent.setup().click(moreButton());
    expect(screen.getByRole("menuitem", { name: label })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(values.onSelectPage).not.toHaveBeenCalled();
  });

  it.each([
    ["skills", "技能"],
    ["workflows", "工作流与自动化"],
    ["memory", "记忆"],
  ] as const)(
    "opens %s from More without changing the destination directly",
    async (tool, label) => {
      const onOpenAgentTool = vi.fn();
      const values = props({ onOpenAgentTool });
      mount(values);
      await userEvent.setup().click(moreButton());
      await userEvent
        .setup()
        .click(screen.getByRole("menuitem", { name: label }));
      expect(onOpenAgentTool).toHaveBeenCalledOnce();
      expect(onOpenAgentTool).toHaveBeenCalledWith(tool);
      expect(values.onSelectPage).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    },
  );

  it("keeps updates in More and the profile menu without a separate rail button", async () => {
    const values = props({ view: "agent" });
    mount(values);
    expect(
      screen.queryByRole("button", { name: /^软件更新|^nav.softwareUpdates/ }),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(moreButton());
    const updates = screen.getByRole("menuitem", {
      name: /^软件更新|^nav.softwareUpdates/,
    });
    expect(updates).toHaveAccessibleName(
      /发现 LoliCode 新版本|nav.softwareUpdatesAvailable/,
    );
    await user.click(updates);
    expect(values.onOpenUpdates).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "头像与设置" }));
    await user.click(screen.getByRole("menuitem", { name: /^软件更新/ }));
    expect(values.onOpenUpdates).toHaveBeenCalledTimes(2);
    expect(values.onSelectPage).not.toHaveBeenCalled();
  });

  it.each([
    "applications",
    ...BUILTIN_APP_IDS.filter((id) => id !== "tavern"),
  ] as const)(
    "selects Applications for the %s page without exposing built-in shortcuts",
    async (view) => {
      const values = props({ view });
      mount(values);
      expect(moreButton()).toHaveAttribute("data-selected", "true");
      await userEvent.setup().click(moreButton());
      expect(
        screen.getByRole("menuitem", { name: "applications.title" }),
      ).toHaveAttribute("aria-current", "page");
      for (const name of [
        "nav.tavern",
        "nav.unreal",
        "applications.rankings.title",
        "applications.free-ai.title",
      ]) {
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      }
      expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(
        1,
      );
      expect(values.onSelectPage).not.toHaveBeenCalled();
      expect(appChanges).toEqual([]);
    },
  );

  it("ignores old pinned shortcuts while retaining the saved preferences and application data", () => {
    const saved = JSON.stringify({
      collapsed: false,
      pinned: [...BUILTIN_APP_IDS],
    });
    localStorage.setItem(SIDEBAR_TOOLS_KEY, saved);
    mount(props({ view: "rankings" }));
    expect(
      screen.queryByRole("button", { name: "nav.tavern" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "nav.expandTools" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "nav.collapseTools" }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(SIDEBAR_TOOLS_KEY)).toBe(saved);
    expect(appChanges).toEqual([]);
  });

  it.each(["agent", "settings"] as const)(
    "keeps account and More together in the %s footer and Applications reachable",
    async (view) => {
      const values = props({ view });
      const { container } = mount(values);
      const footer = container.querySelector(".lolicode-sidebar-footer")!;
      expect(footer).toContainElement(moreButton());
      expect(footer).toContainElement(
        screen.getByRole("button", { name: "头像与设置" }),
      );
      await userEvent.setup().click(moreButton());
      await userEvent
        .setup()
        .click(screen.getByRole("menuitem", { name: "applications.title" }));
      expect(values.onSelectPage).toHaveBeenCalledWith("applications");
    },
  );

  it("keeps the Agent destination stable across legacy client views", () => {
    const values = props();
    const { rerender } = mount(values);
    const agent = screen.getByRole("button", { name: "编程工作台" });
    rerender(<Sidebar {...values} activeApp="openclaw" view="workspace" />);
    expect(screen.getByRole("button", { name: "编程工作台" })).toBe(agent);
    fireEvent.click(agent);
    expect(values.onSelectPage).toHaveBeenCalledWith("agent");
    expect(values.onSelectApp).not.toHaveBeenCalled();
  });

  it("updates selection without replacing the focused navigation control", () => {
    const values = props({ view: "channels" });
    const { rerender } = mount(values);
    const chat = screen.getByRole("button", { name: "编程工作台" });
    chat.focus();
    rerender(<Sidebar {...values} view="agent" />);
    expect(screen.getByRole("button", { name: "编程工作台" })).toBe(chat);
    expect(chat).toHaveFocus();
    expect(chat).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: "角色对话" }),
    ).not.toHaveAttribute("aria-current");
    expect(values.onSelectPage).not.toHaveBeenCalled();
  });

  it("keeps workspace controls and Agent directory hosts mounted between modes", () => {
    const actions = vi.fn<(node: HTMLDivElement | null) => void>();
    const content = vi.fn<(node: HTMLDivElement | null) => void>();
    const values = props({
      view: "agent",
      tavernEnabled: false,
      workspaceSlots: { actions, content },
    });
    const { rerender } = mount(values);
    const sidebar = screen.getByRole("navigation");
    const agent = screen.getByRole("button", { name: "编程工作台" });
    const chat = screen.getByRole("button", { name: "角色对话" });
    const account = screen.getByRole("button", { name: "头像与设置" });
    const [actionsHost] = actions.mock.calls[0];
    const [contentHost] = content.mock.calls[0];
    expect(actionsHost).toBeVisible();
    expect(contentHost).toBeVisible();
    expect(agent).toHaveAttribute("aria-current", "page");

    chat.focus();
    rerender(<Sidebar {...values} view="tavern" />);
    expect(screen.getByRole("navigation")).toBe(sidebar);
    expect(screen.getByRole("button", { name: "头像与设置" })).toBe(account);
    expect(screen.getByRole("button", { name: "角色对话" })).toBe(chat);
    expect(chat).toHaveFocus();
    expect(chat).toHaveAttribute("aria-current", "page");
    expect(agent).not.toHaveAttribute("aria-current");
    expect(actionsHost).toHaveAttribute("hidden");
    expect(contentHost).toHaveAttribute("hidden");
    expect(actionsHost).toBeInTheDocument();
    expect(contentHost).toBeInTheDocument();

    rerender(<Sidebar {...values} />);
    expect(screen.getByRole("navigation")).toBe(sidebar);
    expect(actions).toHaveBeenCalledTimes(1);
    expect(content).toHaveBeenCalledTimes(1);
    expect(actionsHost).toBeVisible();
    expect(contentHost).toBeVisible();
    expect(agent).toHaveAttribute("aria-current", "page");
  });

  it("keeps named controls reachable with the keyboard", async () => {
    const values = props({ view: "channels" });
    mount(values);
    const chat = screen.getByRole("button", { name: "角色对话" });
    chat.focus();
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    expect(values.onSelectPage).toHaveBeenCalledWith("tavern");
    moreButton().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(moreButton()).toHaveFocus();
  });
});

describe("compact settings navigation", () => {
  it("keeps ordinary settings, the About update notice, and the back action", async () => {
    const values = props({ view: "settings", settingsSection: "network" });
    mount(values);
    for (const section of SETTINGS_SECTIONS.filter(
      (section) => section !== "routing",
    )) {
      const item = screen.getByRole("button", {
        name:
          section === "models"
            ? /^渠道与模型/
            : new RegExp(`^settings.sections.${section}`),
      });
      if (section === "network")
        expect(item).toHaveAttribute("aria-current", "page");
      if (section === "about")
        expect(item).toHaveAccessibleName(/nav.settingsHasUpdate/);
      if (section === "models")
        expect(item).toHaveAccessibleName(/nav.authNeedsReauth/);
      fireEvent.click(item);
      expect(values.onSelectSettingsSection).toHaveBeenLastCalledWith(section);
    }
    expect(
      screen.queryByRole("button", { name: /^settings.sections.routing/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "nav.back" }));
    expect(values.onExitSettings).toHaveBeenCalledOnce();
    expect(screen.queryByText("LoliCode v4.0.10")).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "头像与设置" }));
    await user.click(screen.getByRole("menuitem", { name: "设置" }));
    expect(values.onSelectPage).toHaveBeenLastCalledWith("settings");
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
    act(() => result.current.toggle());
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
