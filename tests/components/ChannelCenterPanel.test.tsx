import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { ChannelCenterPanel } from "@/components/channels/ChannelCenterPanel";
import {
  channelCenterApi,
  type ChannelCenterSnapshot,
} from "@/lib/api/channel-center";
import { discardUnsavedChanges, hasUnsavedChanges } from "@/lib/unsavedChanges";

vi.mock("@/lib/api/channel-center", () => ({
  channelCenterApi: {
    get: vi.fn(),
    save: vi.fn(),
    discover: vi.fn(),
    apply: vi.fn(),
  },
}));

const copilot = vi.hoisted(() => ({
  accounts: [] as { id: string; login: string }[],
  defaultAccountId: null as string | null,
  isStatusSuccess: true,
  isStatusError: false,
  isAddingAccount: false,
  pollingState: "idle",
  deviceCode: null,
  error: null,
  addAccount: vi.fn(),
  cancelAuth: vi.fn(),
  refetchStatus: vi.fn(),
}));
vi.mock("@/components/providers/forms/hooks/useCopilotAuth", () => ({
  useCopilotAuth: () => copilot,
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
    fireEvent.change(screen.getByLabelText("搜索 API 服务"), {
      target: { value: "Kimi Global" },
    });
    fireEvent.change(screen.getByLabelText("更多 API 服务"), {
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
      screen.getByText("这些配置需要 TAI Switch 在后台运行。"),
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
    const button = screen.getByRole("button", { name: "使用 GitHub 登录" });
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
    expect(screen.getByRole("button", { name: "已加入渠道" })).toBeDisabled();
  });

  it("releases the login lock after reauthorizing an existing Copilot account and offers explicit account selection", async () => {
    copilot.accounts = [{ id: "existing", login: "octocat" }];
    copilot.defaultAccountId = "existing";
    const view = render(<ChannelCenterPanel />);
    await ready();
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
        "GitHub 授权已完成。选择账号后点击“加入渠道”，已有渠道可点击“刷新模型”。",
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
