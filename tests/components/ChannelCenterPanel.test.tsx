import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { ChannelCenterPanel } from "@/components/channels/ChannelCenterPanel";
import {
  channelCenterApi,
  type ChannelCenterSnapshot,
  type ChannelSource,
} from "@/lib/api/channel-center";
import { discardUnsavedChanges, hasUnsavedChanges } from "@/lib/unsavedChanges";
import { settingsApi } from "@/lib/api";
import type { ManagedAuthDeviceCodeResponse } from "@/lib/api/auth";

vi.mock("@/lib/api/channel-center", () => ({
  channelCenterApi: {
    get: vi.fn(),
    save: vi.fn(),
    discover: vi.fn(),
    apply: vi.fn(),
    startZhipuLogin: vi.fn(),
    pollZhipuLogin: vi.fn(),
    cancelZhipuLogin: vi.fn(),
    discoverNativeSubscription: vi.fn(),
    openNativeSubscriptionLogin: vi.fn(),
  },
}));
vi.mock("@/lib/api", () => ({ settingsApi: { openExternal: vi.fn() } }));
const authCenterProps = vi.hoisted(() => vi.fn());
vi.mock("@/components/settings/AuthCenterPanel", () => ({
  AuthCenterPanel: (props: unknown) => {
    authCenterProps(props);
    return <div>已有账号维护列表</div>;
  },
}));

const copilot = vi.hoisted(() => ({
  accounts: [] as { id: string; login: string }[],
  defaultAccountId: null as string | null,
  isStatusSuccess: true,
  isStatusError: false,
  isAddingAccount: false,
  pollingState: "idle",
  deviceCode: null as ManagedAuthDeviceCodeResponse | null,
  error: null,
  addAccount: vi.fn(),
  cancelAuth: vi.fn(),
  refetchStatus: vi.fn(),
  reauthAccount: vi.fn(),
}));
const managedAuthHook = vi.hoisted(() => vi.fn());
vi.mock("@/components/providers/forms/hooks/useManagedAuth", () => ({
  useManagedAuth: (provider: string) => {
    managedAuthHook(provider);
    return copilot;
  },
}));

const initial: ChannelCenterSnapshot = {
  revision: 0,
  channels: [],
  targets: ["opencode", "hermes", "openclaw"],
};

const populated: ChannelCenterSnapshot = {
  ...initial,
  defaultModel: "deepseek/deepseek-chat",
  channels: [
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "private-test-key",
      authKind: "api_key",
      protocol: "openai_chat",
      enabled: true,
      models: [
        { id: "deepseek-chat", name: "DeepSeek Chat", supportsTools: true },
        {
          id: "deepseek-reasoner",
          name: "DeepSeek Reasoner",
          supportsTools: true,
        },
        { id: "embedding-model", supportsTools: false },
      ],
    },
  ],
};

let saved: ChannelCenterSnapshot;

beforeEach(() => {
  discardUnsavedChanges();
  copilot.accounts = [];
  copilot.defaultAccountId = null;
  copilot.isAddingAccount = false;
  copilot.pollingState = "idle";
  copilot.addAccount.mockReset();
  copilot.cancelAuth.mockReset();
  copilot.reauthAccount.mockReset();
  copilot.isStatusSuccess = true;
  copilot.isStatusError = false;
  copilot.deviceCode = null;
  copilot.error = null;
  managedAuthHook.mockClear();
  authCenterProps.mockClear();
  vi.mocked(settingsApi.openExternal).mockReset().mockResolvedValue();
  vi.mocked(channelCenterApi.startZhipuLogin).mockReset().mockResolvedValue({
    flowId: "fixture-zhipu",
    url: "https://zcode.z.ai/login",
    expiresIn: 60,
  });
  vi.mocked(channelCenterApi.pollZhipuLogin)
    .mockReset()
    .mockResolvedValue({ status: "pending" });
  vi.mocked(channelCenterApi.cancelZhipuLogin).mockReset().mockResolvedValue();
  vi.mocked(channelCenterApi.openNativeSubscriptionLogin)
    .mockReset()
    .mockResolvedValue();
  vi.mocked(channelCenterApi.discoverNativeSubscription)
    .mockReset()
    .mockImplementation(async (tool) => ({
      id: `native-${tool}`,
      name: `${tool === "claude" ? "Claude" : "Gemini"} 原生订阅`,
      baseUrl: "",
      apiKey: "",
      authKind:
        tool === "claude" ? "claude_subscription" : "gemini_subscription",
      accountId: "native",
      protocol: tool === "claude" ? "anthropic" : "gemini_native",
      enabled: true,
      models: [
        { id: "native-default", name: "原生工具默认模型（工具维护目录）" },
      ],
    }));
  saved = structuredClone(initial);
  vi.mocked(channelCenterApi.get)
    .mockReset()
    .mockImplementation(async () => structuredClone(saved));
  vi.mocked(channelCenterApi.save)
    .mockReset()
    .mockImplementation(async (snapshot) => {
      saved = structuredClone({
        ...snapshot,
        revision: (snapshot.revision ?? 0) + 1,
      });
    });
  vi.mocked(channelCenterApi.discover)
    .mockReset()
    .mockImplementation(async (channel) => ({
      ...channel,
      models: [
        { id: "model-a", name: "Model A", supportsTools: true },
        { id: "model-b", name: "Model B", supportsTools: true },
      ],
    }));
  vi.mocked(channelCenterApi.apply)
    .mockReset()
    .mockResolvedValue({ results: [], requiresBackground: false });
});

async function ready() {
  await waitFor(() =>
    expect(screen.queryByText("正在加载渠道…")).not.toBeInTheDocument(),
  );
}

function fillApi() {
  fireEvent.click(screen.getByRole("button", { name: "DeepSeek" }));
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "test-secret-key" },
  });
}

describe("ChannelCenterPanel", () => {
  it("places subscription and API choices in one picker and reuses the same form area", async () => {
    const { container } = render(<ChannelCenterPanel />);
    await ready();
    const picker = screen.getByRole("group", { name: "添加渠道方式" });
    const formArea = container.querySelector(".lolicode-channel-form");
    expect(
      within(picker).getByRole("button", { name: "DeepSeek" }),
    ).toBeInTheDocument();
    for (const name of [
      "GitHub Copilot · 账号登录",
      "ZCode · 账号登录",
      "OpenAI · 账号登录",
      "xAI · 账号登录",
      "Claude · 账号登录",
      "Gemini · 账号登录",
    ]) {
      fireEvent.click(within(picker).getByRole("button", { name }));
      expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("API 地址")).not.toBeInTheDocument();
      expect(container.querySelector(".lolicode-channel-form")).toBe(formArea);
      expect(
        within(formArea as HTMLElement).getByRole("heading", { name }),
      ).toBeInTheDocument();
    }
    fireEvent.click(within(picker).getByRole("button", { name: "DeepSeek" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(container.querySelector("aside")).toBeNull();
  });

  it.each([
    ["OpenAI", "codex_oauth", "ChatGPT"],
    ["xAI", "xai_oauth", "xAI"],
  ] as const)(
    "adds the selected %s managed account through its existing auth provider",
    async (brand, authKind, label) => {
      copilot.accounts = [{ id: "subscription-account", login: "member" }];
      render(<ChannelCenterPanel />);
      await ready();
      fireEvent.click(
        screen.getByRole("button", { name: `${brand} · 账号登录` }),
      );
      expect(managedAuthHook).toHaveBeenLastCalledWith(authKind);
      fireEvent.click(screen.getByRole("button", { name: "加入渠道" }));
      await screen.findByLabelText(`${label} · member 渠道`);
      expect(channelCenterApi.discover).toHaveBeenCalledWith(
        expect.objectContaining({
          authKind,
          accountId: "subscription-account",
          baseUrl: "",
          apiKey: "",
          protocol: "openai_responses",
        }),
      );
      expect(saved.channels[0].authKind).toBe(authKind);
      expect(saved.channels[0].apiKey).toBe("");
    },
  );

  it("does not save a removed subscription account or pretend model discovery succeeded", async () => {
    saved = {
      ...initial,
      channels: [
        {
          ...populated.channels[0],
          id: "subscription",
          name: "ChatGPT · member",
          authKind: "codex_oauth",
          accountId: "removed-account",
          apiKey: "",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          protocol: "openai_responses",
        },
      ],
    };
    vi.mocked(channelCenterApi.discover).mockRejectedValue(
      new Error("此账号已被移除，请重新登录。"),
    );
    render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    await screen.findByText("此账号已被移除，请重新登录。");
    expect(channelCenterApi.save).not.toHaveBeenCalled();
    expect(screen.getByLabelText("ChatGPT · member 渠道")).toBeInTheDocument();
    expect(
      screen.queryByText("ChatGPT · member 的模型列表已更新。"),
    ).not.toBeInTheDocument();
  });

  it("prevents switching channels during managed login and releases it after cancellation", async () => {
    const navigation = vi.fn();
    render(<ChannelCenterPanel onNavigationBlockedChange={navigation} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "OpenAI · 账号登录" }));
    fireEvent.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));
    expect(copilot.addAccount).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "DeepSeek" })).toBeDisabled();
    expect(navigation).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    expect(copilot.cancelAuth).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "DeepSeek" })).toBeEnabled();
    expect(navigation).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));
    expect(copilot.addAccount).toHaveBeenCalledTimes(2);
  });

  it("waits for managed authorization completion before adding an account from a status refresh", async () => {
    const view = render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "OpenAI · 账号登录" }));
    fireEvent.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));
    copilot.isAddingAccount = true;
    copilot.pollingState = "polling";
    copilot.accounts = [{ id: "new-account", login: "member" }];
    view.rerender(<ChannelCenterPanel />);
    expect(channelCenterApi.discover).not.toHaveBeenCalled();
    expect(channelCenterApi.save).not.toHaveBeenCalled();
    copilot.isAddingAccount = false;
    copilot.pollingState = "success";
    view.rerender(<ChannelCenterPanel />);
    await screen.findByLabelText("ChatGPT · member 渠道");
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        authKind: "codex_oauth",
        accountId: "new-account",
        apiKey: "",
      }),
    );
  });

  it("uses a remaining account when account maintenance removes the previously selected login", async () => {
    copilot.accounts = [
      { id: "first", login: "first-user" },
      { id: "second", login: "second-user" },
    ];
    copilot.defaultAccountId = "first";
    const view = render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "OpenAI · 账号登录" }));
    fireEvent.change(screen.getByLabelText("ChatGPT 账号"), {
      target: { value: "second" },
    });
    expect(screen.getByLabelText("ChatGPT 账号")).toHaveValue("second");
    copilot.accounts = [{ id: "first", login: "first-user" }];
    view.rerender(<ChannelCenterPanel />);
    expect(screen.getByLabelText("ChatGPT 账号")).toHaveValue("first");
    expect(screen.getByRole("button", { name: "加入渠道" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "加入渠道" }));
    await screen.findByLabelText("ChatGPT · first-user 渠道");
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "first" }),
    );
  });

  it("removes stale managed authorization controls when login succeeds while channel discovery is pending", async () => {
    let finishDiscovery: (source: ChannelSource) => void = () => {};
    let pendingSource: ChannelSource;
    vi.mocked(channelCenterApi.discover).mockImplementation((source) => {
      pendingSource = source;
      return new Promise((resolve) => {
        finishDiscovery = resolve;
      });
    });
    const view = render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "OpenAI · 账号登录" }));
    fireEvent.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));
    copilot.isAddingAccount = true;
    copilot.pollingState = "polling";
    copilot.deviceCode = {
      provider: "codex_oauth",
      device_code: "fixture-private-device-token",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.openai.com/codex/device",
      expires_in: 600,
      interval: 5,
    };
    view.rerender(<ChannelCenterPanel />);
    expect(
      screen.getByRole("button", { name: "取消登录" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();
    copilot.accounts = [{ id: "member", login: "member" }];
    copilot.isAddingAccount = false;
    copilot.pollingState = "success";
    view.rerender(<ChannelCenterPanel />);
    await waitFor(() =>
      expect(channelCenterApi.discover).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByRole("button", { name: "取消登录" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "打开授权页" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("ABCD-EFGH")).not.toBeInTheDocument();
    expect(
      screen.queryByText("fixture-private-device-token"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("账号渠道和模型已加入。"),
    ).not.toBeInTheDocument();
    await act(async () =>
      finishDiscovery({
        ...pendingSource!,
        models: [{ id: "model-a", supportsTools: true }],
      }),
    );
    await screen.findByLabelText("ChatGPT · member 渠道");
    expect(screen.getByText("账号渠道和模型已加入。")).toBeInTheDocument();
    expect(copilot.cancelAuth).not.toHaveBeenCalled();
  });

  it("adds ZCode through its account card without exposing a key form", async () => {
    vi.mocked(channelCenterApi.pollZhipuLogin).mockResolvedValue({
      status: "success",
      channel: {
        id: "zcode-account",
        name: "ZCode",
        authKind: "zhipu_oauth",
        accountId: "official-account",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        apiKey: "",
        protocol: "openai_chat",
        models: [],
        enabled: true,
      },
    });
    render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "ZCode · 账号登录" }));
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "登录智谱 / ZCode" }));
    await screen.findByLabelText("ZCode 渠道");
    expect(settingsApi.openExternal).toHaveBeenCalledWith(
      "https://zcode.z.ai/login",
    );
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        authKind: "zhipu_oauth",
        accountId: "official-account",
        apiKey: "",
      }),
    );
  });

  it.each([
    ["Claude", "claude", "Claude Code", "claude_subscription"],
    ["Gemini", "gemini", "Gemini CLI", "gemini_subscription"],
  ] as const)(
    "opens and detects the real %s native subscription without exporting credentials",
    async (brand, tool, toolName, authKind) => {
      render(<ChannelCenterPanel />);
      await ready();
      fireEvent.click(
        screen.getByRole("button", { name: `${brand} · 账号登录` }),
      );
      fireEvent.click(screen.getByRole("button", { name: "打开工具登录" }));
      await screen.findByText(
        `已打开 ${toolName} 登录窗口。完成登录后，点击“检测并加入渠道”。`,
      );
      expect(channelCenterApi.openNativeSubscriptionLogin).toHaveBeenCalledWith(
        tool,
      );
      expect(channelCenterApi.save).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "检测并加入渠道" }));
      await screen.findByLabelText(`${brand} 原生订阅 渠道`);
      expect(channelCenterApi.discoverNativeSubscription).toHaveBeenCalledWith(
        tool,
      );
      expect(channelCenterApi.discover).not.toHaveBeenCalled();
      expect(saved.channels[0]).toEqual(
        expect.objectContaining({
          authKind,
          accountId: "native",
          apiKey: "",
          baseUrl: "",
          models: [expect.objectContaining({ id: "native-default" })],
        }),
      );
      expect(screen.getByText("仅原生工具")).toBeInTheDocument();
      expect(
        screen.getByText("native-default · 由原生工具管理"),
      ).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: toolName })).toBeChecked();
      expect(
        screen.getByRole("checkbox", { name: "Claude Desktop" }),
      ).not.toBeChecked();
      expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    },
  );

  it("does not add a native subscription before the original tool is installed and logged in", async () => {
    vi.mocked(channelCenterApi.discoverNativeSubscription).mockRejectedValue(
      new Error("没有检测到 Claude Code 登录，请先在工具中登录。"),
    );
    render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Claude · 账号登录" }));
    fireEvent.click(screen.getByRole("button", { name: "检测并加入渠道" }));
    await screen.findByText("没有检测到 Claude Code 登录，请先在工具中登录。");
    expect(channelCenterApi.save).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "检测并加入渠道" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "DeepSeek" })).toBeEnabled();
  });

  it("rejects unexpected native credential exports and keeps them out of saved channels", async () => {
    vi.mocked(channelCenterApi.discoverNativeSubscription).mockResolvedValue({
      id: "native-claude",
      name: "Claude 原生订阅",
      authKind: "claude_subscription",
      accountId: "native",
      apiKey: "must-stay-private",
      baseUrl: "",
      protocol: "anthropic",
      enabled: true,
      models: [{ id: "native-default" }],
    });
    render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Claude · 账号登录" }));
    fireEvent.click(screen.getByRole("button", { name: "检测并加入渠道" }));
    await screen.findByText(
      "没有取得有效的原生订阅登录状态，请在工具中完成登录后重试。",
    );
    expect(channelCenterApi.save).not.toHaveBeenCalled();
    expect(screen.queryByText("must-stay-private")).not.toBeInTheDocument();
  });

  it("blocks duplicate native detection and channel switching until it finishes", async () => {
    let finish: (source: ChannelSource) => void = () => {};
    vi.mocked(channelCenterApi.discoverNativeSubscription).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const navigation = vi.fn();
    render(<ChannelCenterPanel onNavigationBlockedChange={navigation} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Claude · 账号登录" }));
    const detect = screen.getByRole("button", { name: "检测并加入渠道" });
    fireEvent.click(detect);
    fireEvent.click(detect);
    expect(channelCenterApi.discoverNativeSubscription).toHaveBeenCalledTimes(
      1,
    );
    expect(screen.getByRole("button", { name: "DeepSeek" })).toBeDisabled();
    expect(navigation).toHaveBeenLastCalledWith(true);
    await act(async () =>
      finish({
        id: "native-claude",
        name: "Claude 原生订阅",
        authKind: "claude_subscription",
        accountId: "native",
        baseUrl: "",
        apiKey: "",
        protocol: "anthropic",
        enabled: true,
        models: [
          { id: "native-default", name: "原生工具默认模型（工具维护目录）" },
        ],
      }),
    );
    await waitFor(() => expect(detect).toBeEnabled());
    expect(navigation).toHaveBeenLastCalledWith(false);
    expect(channelCenterApi.save).toHaveBeenCalledTimes(1);
  });

  it("keeps account maintenance in a dialog and preserves the API draft when closing it", async () => {
    render(<ChannelCenterPanel />);
    await ready();
    fillApi();
    fireEvent.click(screen.getByRole("button", { name: "管理登录账号" }));
    expect(
      screen.getByRole("dialog", { name: "管理登录账号" }),
    ).toBeInTheDocument();
    expect(screen.getByText("已有账号维护列表")).toBeInTheDocument();
    expect(authCenterProps).toHaveBeenLastCalledWith({
      showIntro: false,
      authScrollTarget: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveValue("test-secret-key");
    expect(hasUnsavedChanges()).toBe(true);
    expect(channelCenterApi.save).not.toHaveBeenCalled();
  });

  it("opens account maintenance for the source's actual managed provider", async () => {
    saved = {
      ...initial,
      channels: [
        {
          ...populated.channels[0],
          id: "xai-member",
          name: "xAI · member",
          authKind: "xai_oauth",
          accountId: "member",
          apiKey: "",
          protocol: "openai_responses",
        },
      ],
    };
    render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "账号管理" }));
    expect(authCenterProps).toHaveBeenLastCalledWith({
      showIntro: false,
      authScrollTarget: "xai_oauth",
    });
  });

  it("opens account management from the legacy entry without reopening it on unrelated rerenders", async () => {
    const view = render(<ChannelCenterPanel initialAccountManagerOpen />);
    await ready();
    expect(
      screen.getByRole("dialog", { name: "管理登录账号" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    view.rerender(<ChannelCenterPanel initialAccountManagerOpen />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "渠道中心" }),
    ).toBeInTheDocument();
  });

  it("labels Claude Code and Claude Desktop separately in selections and results", async () => {
    saved = {
      ...structuredClone(populated),
      targets: ["claude", "claude-desktop"],
    };
    vi.mocked(channelCenterApi.apply).mockResolvedValue({
      requiresBackground: true,
      results: [
        { app: "claude", status: "success", message: "已保存配置" },
        { app: "claude-desktop", status: "success", message: "已保存配置" },
      ],
    });
    render(<ChannelCenterPanel />);
    await ready();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Claude Desktop" }),
    ).toBeChecked();
    expect(
      screen.queryByRole("checkbox", { name: "Claude" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "一键配置 2 个工具" }));
    await screen.findByText("Claude Code · 配置成功");
    expect(screen.getByText("Claude Desktop · 配置成功")).toBeInTheDocument();
    expect(
      screen.getByText(
        "已运行的 Claude Code 请打开新终端或重启 CLI，使新配置生效。",
      ),
    ).toBeInTheDocument();
  });
  it("uses an existing service logo and preset endpoint without asking for an address", async () => {
    render(<ChannelCenterPanel />);
    await ready();
    expect(screen.queryByLabelText("API 地址")).not.toBeInTheDocument();
    const kimi = screen.getByRole("button", { name: "Kimi · 中国" });
    expect(kimi.querySelector("svg")).not.toBeNull();
    fireEvent.click(kimi);
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "fixture-kimi-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加并查找模型" }));
    await screen.findByLabelText("Kimi · 中国 渠道");
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://api.moonshot.cn/v1",
        protocol: "openai_chat",
        apiKey: "fixture-kimi-key",
      }),
    );
    expect(screen.queryByLabelText("API 地址")).not.toBeInTheDocument();
  });

  it("shows an address input only after selecting a custom channel", async () => {
    render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "自定义渠道" }));
    expect(screen.getByLabelText("API 地址")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("API 地址"), {
      target: { value: "https://private.example.test/custom/v2" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "fixture-custom-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加并查找模型" }));
    await screen.findByLabelText("private.example.test 渠道");
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://private.example.test/custom/v2",
      }),
    );
  });

  it("preserves an existing custom endpoint and protocol while editing its key", async () => {
    saved = structuredClone(populated);
    saved.channels[0].baseUrl =
      "https://proxy.example.test/region-hk/special/v1";
    saved.channels[0].protocol = "anthropic";
    render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    expect(screen.getByLabelText("API 地址")).toHaveValue(
      "https://proxy.example.test/region-hk/special/v1",
    );
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "updated-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改并刷新模型" }));
    await waitFor(() => expect(channelCenterApi.save).toHaveBeenCalled());
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://proxy.example.test/region-hk/special/v1",
        protocol: "anthropic",
      }),
    );
  });

  it("clears the old service key when changing hosts and preserves the key on a repeated preset click", async () => {
    saved = structuredClone(populated);
    render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("private-test-key");
    fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "保存修改并刷新模型" }),
    ).toBeDisabled();
    expect(channelCenterApi.discover).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "new-openai-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("new-openai-key");
    fireEvent.click(screen.getByRole("button", { name: "保存修改并刷新模型" }));
    await waitFor(() => expect(channelCenterApi.discover).toHaveBeenCalled());
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "new-openai-key",
      }),
    );
  });

  it("matches an existing regional preset without changing its saved endpoint or protocol", async () => {
    saved = structuredClone(populated);
    saved.channels[0].baseUrl = "https://api.moonshot.ai/v1/";
    saved.channels[0].protocol = "openai_responses";
    render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    expect(screen.queryByLabelText("API 地址")).not.toBeInTheDocument();
    expect(screen.getByText("Kimi Global")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "updated-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改并刷新模型" }));
    await waitFor(() => expect(channelCenterApi.save).toHaveBeenCalled());
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://api.moonshot.ai/v1/",
        protocol: "openai_responses",
        name: "DeepSeek",
      }),
    );
  });

  it("lets a user search more existing services and pick a regional endpoint", async () => {
    render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "更多服务" }));
    fireEvent.change(screen.getByLabelText("搜索服务"), {
      target: { value: "Kimi Global" },
    });
    fireEvent.change(screen.getByLabelText("更多渠道服务"), {
      target: { value: "opencode:Kimi Global" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "fixture-global-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加并查找模型" }));
    await screen.findByLabelText("Kimi Global 渠道");
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://api.moonshot.ai/v1" }),
    );
  });
  it("ignores a stale StrictMode load after the latest load enables editing", async () => {
    let finishFirstLoad: (snapshot: ChannelCenterSnapshot) => void = () => {};
    vi.mocked(channelCenterApi.get)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstLoad = resolve;
          }),
      )
      .mockResolvedValueOnce(structuredClone(populated));
    render(
      <StrictMode>
        <ChannelCenterPanel />
      </StrictMode>,
    );
    await ready();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hermes" }));
    await act(async () => finishFirstLoad(structuredClone(initial)));
    expect(screen.getByLabelText("DeepSeek 渠道")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Hermes" })).not.toBeChecked();
    expect(hasUnsavedChanges()).toBe(true);
  });
  it("keeps the secret draft and performs no apply when saving an added channel fails", async () => {
    vi.mocked(channelCenterApi.save).mockRejectedValue(
      new Error("401 test-secret-key"),
    );
    render(<ChannelCenterPanel />);
    await ready();
    fillApi();
    expect(hasUnsavedChanges()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "添加并查找模型" }));
    await screen.findByText("没有访问权限，请检查 API Key 或重新登录账号。");
    expect(screen.getByLabelText("API Key")).toHaveValue("test-secret-key");
    expect(screen.getByLabelText("API Key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.queryByLabelText("API 地址")).not.toBeInTheDocument();
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://api.deepseek.com/v1" }),
    );
    expect(hasUnsavedChanges()).toBe(true);
    expect(channelCenterApi.apply).not.toHaveBeenCalled();
    expect(screen.queryByText(/test-secret-key/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("DeepSeek 渠道")).not.toBeInTheDocument();
  });

  it("adds one discovered catalog, fetches its saved revision, and clears only the saved draft", async () => {
    render(<ChannelCenterPanel />);
    await ready();
    fillApi();
    fireEvent.click(screen.getByRole("button", { name: "添加并查找模型" }));
    await screen.findByLabelText("DeepSeek 渠道");
    expect(channelCenterApi.save).toHaveBeenCalledTimes(1);
    expect(channelCenterApi.get).toHaveBeenCalledTimes(2);
    expect(saved.revision).toBe(1);
    expect(saved.channels[0].models.every((model) => model.enabled)).toBe(true);
    expect(saved.defaultModel).toBe(`${saved.channels[0].id}/model-a`);
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    await waitFor(() => expect(hasUnsavedChanges()).toBe(false));
    expect(channelCenterApi.apply).not.toHaveBeenCalled();
  });

  it("keeps a committed source without duplicating it when the post-save refresh fails", async () => {
    vi.mocked(channelCenterApi.get)
      .mockResolvedValueOnce(structuredClone(initial))
      .mockRejectedValueOnce(new Error("读取渠道失败"));
    render(<ChannelCenterPanel />);
    await ready();
    fillApi();
    fireEvent.click(screen.getByRole("button", { name: "添加并查找模型" }));
    await screen.findByText(
      "选择已保存，但无法刷新渠道。请点击重新加载后继续。",
    );
    expect(screen.getByLabelText("DeepSeek 渠道")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "添加并查找模型" }),
    ).toBeDisabled();
    expect(channelCenterApi.save).toHaveBeenCalledTimes(1);
    expect(channelCenterApi.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await ready();
    expect(saved.channels).toHaveLength(1);
    expect(channelCenterApi.save).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate apply and preserves partial per-tool results", async () => {
    saved = structuredClone(populated);
    let finishApply: (
      result: Awaited<ReturnType<typeof channelCenterApi.apply>>,
    ) => void = () => {};
    vi.mocked(channelCenterApi.apply).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishApply = resolve;
        }),
    );
    const navigation = vi.fn();
    render(<ChannelCenterPanel onNavigationBlockedChange={navigation} />);
    await ready();
    const button = screen.getByRole("button", { name: "一键配置 3 个工具" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(channelCenterApi.apply).toHaveBeenCalledTimes(1),
    );
    expect(channelCenterApi.apply).toHaveBeenCalledWith(1);
    expect(button).toBeDisabled();
    expect(navigation).toHaveBeenLastCalledWith(true);
    await act(async () =>
      finishApply({
        results: [
          { app: "opencode", status: "success", message: "已加入兼容模型" },
          { app: "hermes", status: "skipped", message: "没有兼容模型" },
          {
            app: "openclaw",
            status: "error",
            message: "配置文件无法写入，请检查文件权限",
          },
        ],
        requiresBackground: true,
      }),
    );
    expect(screen.getByText("OpenCode · 配置成功")).toBeInTheDocument();
    expect(screen.getByText("Hermes · 已跳过")).toBeInTheDocument();
    expect(screen.getByText("OpenClaw · 配置失败")).toBeInTheDocument();
    expect(screen.queryByText("OpenClaw · 配置成功")).not.toBeInTheDocument();
    expect(
      screen.getByText("这些配置需要 LoliCode 在后台运行。"),
    ).toBeInTheDocument();
    expect(navigation).toHaveBeenLastCalledWith(false);
  });

  it("does not apply another editor's intervening save after this editor saves", async () => {
    saved = structuredClone(populated);
    vi.mocked(channelCenterApi.get)
      .mockResolvedValueOnce(structuredClone(populated))
      .mockResolvedValueOnce({
        ...structuredClone(populated),
        revision: 2,
        targets: ["codex"],
      });
    render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hermes" }));
    fireEvent.click(screen.getByRole("button", { name: "一键配置 2 个工具" }));
    await screen.findByText(
      "渠道列表已被另一处修改。请重新加载后再配置；本页的选择已保留。",
    );
    expect(channelCenterApi.apply).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "OpenCode" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Hermes" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Codex" })).not.toBeChecked();
    expect(hasUnsavedChanges()).toBe(true);
  });

  it("retains model choices on refresh and repairs a deselected default before saving", async () => {
    saved = structuredClone(populated);
    vi.mocked(channelCenterApi.discover).mockImplementation(
      async (channel) => ({
        ...channel,
        models: [
          ...populated.channels[0].models,
          { id: "new-model", supportsTools: true },
        ],
      }),
    );
    render(<ChannelCenterPanel />);
    await ready();
    expect(
      screen.getByRole("checkbox", { name: "DeepSeek · embedding-model" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "DeepSeek · embedding-model" }),
    ).not.toBeChecked();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "DeepSeek · DeepSeek Chat" }),
    );
    expect(screen.getByLabelText("默认模型")).toHaveValue(
      "deepseek/deepseek-reasoner",
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    await screen.findByRole("checkbox", { name: "DeepSeek · new-model" });
    expect(
      screen.getByRole("checkbox", { name: "DeepSeek · DeepSeek Chat" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "DeepSeek · new-model" }),
    ).toBeChecked();
    expect(
      saved.channels[0].models.find((model) => model.id === "deepseek-chat")
        ?.enabled,
    ).toBe(false);
    expect(saved.defaultModel).toBe("deepseek/deepseek-reasoner");
  });

  it("does not write an empty catalog after a failed initial load", async () => {
    vi.mocked(channelCenterApi.get).mockRejectedValueOnce(
      new Error("读取渠道失败，请重试"),
    );
    render(<ChannelCenterPanel />);
    await ready();
    expect(
      screen.getByRole("button", { name: "添加并查找模型" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "一键配置 3 个工具" }),
    ).toBeDisabled();
    expect(channelCenterApi.save).not.toHaveBeenCalled();
    saved = structuredClone(populated);
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await screen.findByLabelText("DeepSeek 渠道");
    expect(channelCenterApi.save).not.toHaveBeenCalled();
  });

  it("stops apply when saving conflicts, and keeps API input during an explicit reload", async () => {
    saved = structuredClone(populated);
    vi.mocked(channelCenterApi.save).mockRejectedValue(
      new Error("渠道列表已被另一处修改。请重新加载后再保存"),
    );
    render(<ChannelCenterPanel />);
    await ready();
    fillApi();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hermes" }));
    fireEvent.click(screen.getByRole("button", { name: "一键配置 2 个工具" }));
    await screen.findByText("渠道列表已被另一处修改。请重新加载后再保存");
    expect(channelCenterApi.apply).not.toHaveBeenCalled();
    expect(hasUnsavedChanges()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(
      screen.getByRole("dialog", { name: "重新加载已保存的选择？" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByRole("checkbox", { name: "Hermes" })).not.toBeChecked();
    expect(screen.getByLabelText("API Key")).toHaveValue("test-secret-key");
  });

  it("uses browser login and automatically adds the newly authorized Copilot account", async () => {
    const view = render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "GitHub Copilot · 账号登录" }),
    );
    const button = screen.getByRole("button", {
      name: "使用 GitHub Copilot 登录",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(copilot.addAccount).toHaveBeenCalledTimes(1);
    copilot.isAddingAccount = true;
    copilot.pollingState = "polling";
    view.rerender(<ChannelCenterPanel />);
    copilot.isAddingAccount = false;
    copilot.pollingState = "success";
    view.rerender(<ChannelCenterPanel />);
    expect(channelCenterApi.discover).not.toHaveBeenCalled();
    copilot.accounts = [{ id: "account-1", login: "octocat" }];
    copilot.defaultAccountId = "account-1";
    copilot.pollingState = "idle";
    view.rerender(<ChannelCenterPanel />);
    await screen.findByLabelText("GitHub Copilot · octocat 渠道");
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        authKind: "github_copilot",
        accountId: "account-1",
        apiKey: "",
      }),
    );
    expect(saved.channels[0].apiKey).toBe("");
    expect(
      screen.getByRole("button", { name: "刷新此账号模型" }),
    ).toBeEnabled();
  });

  it("releases the login lock after reauthorizing an existing Copilot account and offers explicit account selection", async () => {
    copilot.accounts = [{ id: "existing", login: "octocat" }];
    copilot.defaultAccountId = "existing";
    const view = render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "GitHub Copilot · 账号登录" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "登录另一个账号" }));
    copilot.isAddingAccount = true;
    copilot.pollingState = "polling";
    view.rerender(<ChannelCenterPanel />);
    copilot.isAddingAccount = false;
    copilot.pollingState = "success";
    view.rerender(<ChannelCenterPanel />);
    copilot.pollingState = "idle";
    view.rerender(<ChannelCenterPanel />);
    expect(
      screen.getByText(
        "授权已完成。请选择账号并点击“加入渠道”，已有渠道可刷新模型。",
      ),
    ).toBeInTheDocument();
    expect(channelCenterApi.discover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "加入渠道" }));
    await screen.findByLabelText("GitHub Copilot · octocat 渠道");
    expect(channelCenterApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "existing",
        authKind: "github_copilot",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "登录另一个账号" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "登录另一个账号" }));
    expect(copilot.addAccount).toHaveBeenCalledTimes(2);
  });

  it("releases the existing-account login lock after an authorization error", async () => {
    copilot.accounts = [{ id: "existing", login: "octocat" }];
    const view = render(<ChannelCenterPanel />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "GitHub Copilot · 账号登录" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "登录另一个账号" }));
    copilot.isAddingAccount = true;
    copilot.pollingState = "polling";
    view.rerender(<ChannelCenterPanel />);
    copilot.isAddingAccount = false;
    copilot.pollingState = "error";
    view.rerender(<ChannelCenterPanel />);
    fireEvent.click(screen.getByRole("button", { name: "登录另一个账号" }));
    expect(copilot.addAccount).toHaveBeenCalledTimes(2);
  });
});
