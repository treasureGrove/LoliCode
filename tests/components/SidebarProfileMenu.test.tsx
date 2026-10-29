import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProfileMenu } from "@/app/shell/SidebarProfileMenu";
import type {
  LolicodeAccount,
  LolicodeRelayStatus,
} from "@/lib/api/lolicode-account";

const mocks = vi.hoisted(() => ({
  language: "zh",
  account: null as LolicodeAccount | null,
  isLoading: false,
  isPending: false,
  isRefreshing: false,
  warning: null as string | null,
  error: null as string | null,
  login: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
  openExternal: vi.fn(),
  relayStatus: vi.fn(),
  connectRelay: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: mocks.language },
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue || key,
  }),
}));
vi.mock("@/hooks/useLolicodeAccount", () => ({
  useLolicodeAccount: () => mocks,
}));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { openExternal: mocks.openExternal },
}));
vi.mock("@/lib/api/lolicode-account", () => ({
  lolicodeAccountApi: {
    relayStatus: mocks.relayStatus,
    connectRelay: mocks.connectRelay,
  },
}));

const account: LolicodeAccount = {
  id: "42",
  username: "forum-user",
  displayName: "小桃",
  avatarUrl: "https://lolicode.com/assets/avatars/42.png",
  profileUrl: "https://lolicode.com/u/42",
};
function mount() {
  const onOpenSettings = vi.fn();
  const onOpenUpdates = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    ...render(
      <SidebarProfileMenu
        selected
        hasUpdate
        onOpenSettings={onOpenSettings}
        onOpenUpdates={onOpenUpdates}
      />,
      { wrapper },
    ),
    onOpenSettings,
    onOpenUpdates,
  };
}
async function openMenu() {
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "头像与设置" }));
}
async function openLogin() {
  await openMenu();
  await userEvent
    .setup()
    .click(screen.getByRole("menuitem", { name: "登录 LoliCode" }));
  return screen.findByRole("dialog", { name: "登录 LoliCode" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.language = "zh";
  mocks.account = null;
  mocks.isLoading = false;
  mocks.isPending = false;
  mocks.isRefreshing = false;
  mocks.warning = null;
  mocks.error = null;
  mocks.login.mockResolvedValue({ account });
  mocks.logout.mockResolvedValue({ account: null });
  mocks.refresh.mockResolvedValue({ account });
  mocks.connectRelay.mockResolvedValue(undefined);
  mocks.relayStatus.mockResolvedValue({
    account: {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
    },
    ready: false,
    models: [],
    quota: {
      day: "2026-10-29",
      timezone: "Asia/Singapore",
      resetsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      requestLimit: 20,
      requestsUsed: 3,
      requestsRemaining: 17,
      tokenLimit: 100000,
      tokensUsed: 1200,
      tokensReserved: 800,
      tokensRemaining: 98000,
    },
  } satisfies LolicodeRelayStatus);
});

describe("LoliCode sidebar account", () => {
  it("offers a website login with a neutral signed-out avatar", async () => {
    mount();
    const trigger = screen.getByRole("button", { name: "头像与设置" });
    expect(trigger).toHaveAttribute("data-selected", "true");
    expect(trigger.querySelector("img")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^免费额度/ }),
    ).not.toBeInTheDocument();
    expect(mocks.relayStatus).not.toHaveBeenCalled();
    await openMenu();
    expect(screen.getByRole("menu")).toHaveTextContent("尚未登录 LoliCode");
    expect(
      screen.getByRole("menuitem", { name: "登录 LoliCode" }),
    ).toBeInTheDocument();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("shows the signed-in allowance ring and opens its existing usage manager", async () => {
    mocks.account = account;
    const user = userEvent.setup();
    mount();
    const allowance = await screen.findByRole("button", {
      name: "免费额度 · 今日剩余 85%",
    });
    expect(
      screen.getByRole("meter", { name: "今日免费额度剩余" }),
    ).toHaveAttribute("aria-valuenow", "85");
    await user.click(allowance);
    expect(
      await screen.findByRole("dialog", { name: "免费额度" }),
    ).toHaveTextContent("LoliCode 每日免费额度");
    await user.click(screen.getByRole("button", { name: "管理用量" }));
    expect(
      await screen.findByRole("dialog", { name: "公益模型与每日额度" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("17 / 20")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "免费额度" }),
    ).not.toBeInTheDocument();
  });

  it("shows the website nickname/avatar, opens its profile, and refreshes it", async () => {
    mocks.account = account;
    mount();
    const trigger = screen.getByRole("button", { name: "头像与设置" });
    expect(trigger.querySelector("img")).toHaveAttribute(
      "src",
      account.avatarUrl,
    );
    expect(trigger.querySelector("img")).toHaveAttribute(
      "referrerpolicy",
      "no-referrer",
    );
    await openMenu();
    expect(screen.getByRole("menu")).toHaveTextContent("小桃");
    expect(screen.getByRole("menu")).toHaveTextContent("@forum-user");
    expect(
      screen.queryByRole("menuitem", { name: "登录 LoliCode" }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("menuitem", { name: "刷新账户资料" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    await userEvent
      .setup()
      .click(screen.getByRole("menuitem", { name: "个人主页" }));
    expect(mocks.openExternal).toHaveBeenCalledWith(account.profileUrl);
  });

  it("falls back to the nickname when the real avatar cannot load", () => {
    mocks.account = account;
    mount();
    const trigger = screen.getByRole("button", { name: "头像与设置" });
    fireEvent.error(trigger.querySelector("img")!);
    expect(trigger.querySelector("img")).toBeNull();
    expect(trigger).toHaveTextContent("小");
  });

  it("submits only user-entered credentials and clears them after cancel", async () => {
    const user = userEvent.setup();
    mount();
    await openLogin();
    const password = screen.getByLabelText("密码");
    expect(password).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("用户名或邮箱"), "me@example.test");
    await user.type(password, "test-password");
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    expect(password).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "头像与设置" })).toHaveFocus();
    await openLogin();
    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(screen.getByLabelText("用户名或邮箱")).toHaveValue("");
    await user.type(screen.getByLabelText("用户名或邮箱"), " forum-user ");
    await user.type(screen.getByLabelText("密码"), "test-password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(mocks.login).toHaveBeenCalledWith("forum-user", "test-password");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("keeps failed login retryable without showing raw server errors", async () => {
    mocks.login.mockRejectedValue("unsafe server echo test-password");
    const user = userEvent.setup();
    mount();
    await openLogin();
    await user.type(screen.getByLabelText("用户名或邮箱"), "forum-user");
    await user.type(screen.getByLabelText("密码"), "test-password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("登录失败");
    expect(screen.getByRole("alert")).not.toHaveTextContent("test-password");
    expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
  });

  it("retains offline account details and lets the user sign out", async () => {
    mocks.account = account;
    mocks.warning = "暂时无法连接 LoliCode，请检查网络后重试。";
    mount();
    await openMenu();
    expect(screen.getByRole("status")).toHaveTextContent("暂时无法连接");
    expect(screen.getByRole("menu")).toHaveTextContent("小桃");
    await userEvent
      .setup()
      .click(screen.getByRole("menuitem", { name: "退出 LoliCode 登录" }));
    expect(mocks.logout).toHaveBeenCalledOnce();
  });

  it("preserves separate settings/updates actions, badges, and keyboard focus", async () => {
    const user = userEvent.setup();
    const { onOpenSettings, onOpenUpdates } = mount();
    const trigger = screen.getByRole("button", { name: "头像与设置" });
    expect(trigger).toHaveAccessibleDescription("发现 LoliCode 新版本");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("menuitem", { name: "登录 LoliCode" }),
    ).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "连接手机" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onOpenSettings).toHaveBeenCalledOnce();
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: /^软件更新/ }));
    expect(onOpenUpdates).toHaveBeenCalledOnce();
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.keyboard("{Enter}{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("uses the editor language for account actions", async () => {
    mocks.language = "en";
    mount();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Profile and settings" }));
    expect(
      screen.getByRole("menuitem", { name: "Sign in to LoliCode" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Settings" }),
    ).toBeInTheDocument();
  });
});
