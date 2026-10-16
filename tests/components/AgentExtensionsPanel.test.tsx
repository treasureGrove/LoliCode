import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { WindowControlsContext } from "@/components/shell/AppPageHeader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentExtensionsPanel } from "@/components/agent/AgentExtensionsPanel";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api";
import { open } from "@tauri-apps/plugin-dialog";
import type { AgentExtensions } from "@/types/agent";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    getExtensions: vi.fn(),
    getPluginStore: vi.fn(),
    updatePluginMarketplace: vi.fn(),
    installMarketplacePlugin: vi.fn(),
    uninstallMarketplacePlugin: vi.fn(),
    setSkillEnabled: vi.fn(),
    importSkill: vi.fn(),
    removeSkill: vi.fn(),
    installPlugin: vi.fn(),
    setPluginEnabled: vi.fn(),
    uninstallPlugin: vi.fn(),
    getExtensionConfig: vi.fn(),
    saveExtensionConfig: vi.fn(),
  },
}));
vi.mock("@/lib/api", () => ({
  settingsApi: { pickDirectory: vi.fn(), openExternal: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const catalog: AgentExtensions = {
  revision: 4,
  skills: [
    {
      id: "pdf",
      name: "PDF",
      description: "读取和制作 PDF。",
      source: "bundled",
      installed: true,
      enabled: true,
      license: "Apache-2.0",
      requirements: ["Python"],
    },
  ],
  plugins: [
    {
      id: "local-plugin",
      name: "Local Plugin",
      entry: "private/plugins/local-plugin/index.js",
      enabled: true,
      source: "local",
    },
  ],
  mcpServers: [{ id: "docs", type: "remote", enabled: true }],
};
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
};
const reload = vi.fn();
const changeOpen = vi.fn();
function PanelHarness({
  windowControls = null,
}: {
  windowControls?: React.ReactNode;
}) {
  const [visible, setVisible] = useState(true);
  return (
    <WindowControlsContext.Provider value={windowControls}>
      <button onClick={() => setVisible(true)}>打开扩展面板</button>
      <AgentExtensionsPanel
        open={visible}
        working={false}
        onOpenChange={(value) => {
          changeOpen(value);
          setVisible(value);
        }}
        onReload={reload}
      />
    </WindowControlsContext.Provider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentApi.getExtensions).mockResolvedValue(structuredClone(catalog));
  vi.mocked(agentApi.getPluginStore).mockResolvedValue({
    marketplaces: [],
    availablePlugins: [],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
    capability: { supported: true },
  });
  vi.mocked(agentApi.setSkillEnabled).mockResolvedValue({
    ...catalog,
    revision: 5,
    skills: [{ ...catalog.skills[0], enabled: false }],
  });
  vi.mocked(agentApi.importSkill).mockResolvedValue(catalog);
  vi.mocked(agentApi.installPlugin).mockResolvedValue(catalog);
  vi.mocked(agentApi.saveExtensionConfig).mockResolvedValue(catalog);
  vi.mocked(agentApi.getExtensionConfig).mockResolvedValue({
    revision: 4,
    mcp: {
      servers: {
        docs: {
          type: "remote",
          url: "https://example.test/mcp",
          headers: { Authorization: "[hidden]" },
        },
      },
    },
    pluginOptions: { "local-plugin": { token: "[hidden]" } },
  });
  vi.mocked(settingsApi.pickDirectory).mockResolvedValue("D:/fixture/skill");
  vi.mocked(open).mockResolvedValue("D:/fixture/plugin.mjs");
  reload.mockResolvedValue(undefined);
});
afterEach(cleanup);
describe("AgentExtensionsPanel", () => {
  it("keeps verified skills usable when the optional marketplace fails to load", async () => {
    vi.mocked(agentApi.getPluginStore).mockRejectedValue(
      new Error("CLI registry unavailable"),
    );
    render(<PanelHarness />);
    await flush();
    expect(
      screen.getByRole("checkbox", { name: "启用技能 PDF" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("tab", { name: "插件" }));
    expect(screen.getByText("CLI registry unavailable")).toBeInTheDocument();
  });
  it("does not advertise custom stores or JS/MCP execution when the native host only supports CLI skills", async () => {
    vi.mocked(agentApi.getPluginStore).mockResolvedValue({
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
      capability: {
        supported: true,
        customSources: false,
        localPluginRuntime: false,
        mcpRuntime: false,
      },
    });
    render(<PanelHarness />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "插件" }));
    expect(screen.queryByRole("tab", { name: "个人" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "安装插件文件" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "管理插件市场来源" }));
    expect(
      screen.queryByRole("button", { name: "添加来源" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "MCP 工具" }));
    expect(
      screen.getByText(/当前应用内执行引擎尚未接入 MCP 连接/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "保存待接入配置" }),
    ).toBeInTheDocument();
  });
  it("installs a real CLI listing, refreshes its receipt, and enables it through the native adapter", async () => {
    const available = {
      id: "cli-github",
      name: "github",
      marketplace: "zcode-plugins-official",
      version: "0.1.2",
      installed: false,
      componentTypes: ["CLI 技能"],
      listing: { displayName: "GitHub CLI", category: "developer-tools" },
    };
    const empty = {
      marketplaces: [
        {
          id: "zcode-plugins-official",
          name: "ZCode CLI 适配目录",
          pluginCount: 1,
          isOfficial: true,
        },
      ],
      availablePlugins: [available],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
      capability: { supported: true },
    };
    const installed = {
      ...empty,
      availablePlugins: [{ ...available, installed: true }],
      installedPlugins: [{ ...available, enabled: true }],
    };
    vi.mocked(agentApi.getPluginStore)
      .mockResolvedValueOnce(empty)
      .mockResolvedValue(installed);
    vi.mocked(agentApi.installMarketplacePlugin).mockResolvedValue(installed);
    vi.mocked(agentApi.setPluginEnabled).mockResolvedValue(catalog);
    render(<PanelHarness />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "插件" }));
    fireEvent.change(screen.getByLabelText("搜索插件"), {
      target: { value: "GitHub" },
    });
    fireEvent.click(screen.getByRole("button", { name: "安装" }));
    await flush();
    expect(agentApi.installMarketplacePlugin).toHaveBeenCalledWith(
      "zcode-plugins-official",
      "github",
    );
    fireEvent.click(screen.getByLabelText("启用插件 GitHub CLI"));
    await flush();
    expect(agentApi.setPluginEnabled).toHaveBeenCalledWith("cli-github", false);
  });
  it("always exposes both dismiss buttons during a slow initial load and ignores its late reply", async () => {
    let finish: (value: AgentExtensions) => void = () => {};
    vi.mocked(agentApi.getExtensions).mockImplementationOnce(
      () =>
        new Promise<AgentExtensions>((resolve) => {
          finish = resolve;
        }),
    );
    render(<PanelHarness />);
    await flush();
    const close = screen.getByRole("button", { name: "关闭弹窗" });
    expect(close).toBeEnabled();
    expect(close).toHaveFocus();
    expect(screen.getByRole("button", { name: "返回工作台" })).toBeEnabled();
    fireEvent.click(close);
    await flush();
    expect(changeOpen).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => finish({ ...catalog, pendingReload: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lets Escape dismiss a loading modal while preserving standard modal isolation", async () => {
    vi.mocked(agentApi.getExtensions).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    render(<PanelHarness />);
    await flush();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(document.body.style.pointerEvents).toBe("none");
    expect(
      screen.queryByRole("button", { name: "打开扩展面板" }),
    ).not.toBeInTheDocument();
    const outside = screen.getByRole("button", {
      name: "打开扩展面板",
      hidden: true,
    });
    outside.focus();
    expect(screen.getByRole("button", { name: "关闭弹窗" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.pointerEvents).toBe("");
    expect(
      screen.getByRole("button", { name: "打开扩展面板" }),
    ).toBeInTheDocument();
  });

  it("can return to the workbench using the fixed footer button", async () => {
    render(<PanelHarness />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    await flush();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(changeOpen).toHaveBeenCalledWith(false);
  });

  it("does not overwrite a newly reopened view with the previous initial load", async () => {
    let finish: (value: AgentExtensions) => void = () => {};
    vi.mocked(agentApi.getExtensions)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...catalog,
        skills: [{ ...catalog.skills[0], name: "当前技能" }],
      });
    render(<PanelHarness />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "打开扩展面板" }));
    await flush();
    await act(async () =>
      finish({
        ...catalog,
        skills: [{ ...catalog.skills[0], name: "旧的迟到技能" }],
      }),
    );
    expect(screen.getByText("当前技能")).toBeInTheDocument();
    expect(screen.queryByText("旧的迟到技能")).not.toBeInTheDocument();
  });

  it("allows dismissal during a write but preserves its mutation barrier across reopen", async () => {
    let finishOld: (value: AgentExtensions) => void = () => {};
    let finishNew: (value: AgentExtensions) => void = () => {};
    vi.mocked(agentApi.setSkillEnabled)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          }),
      );
    render(<PanelHarness />);
    await flush();
    fireEvent.click(screen.getByLabelText("启用技能 PDF"));
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "打开扩展面板" }));
    await flush();
    expect(screen.getByLabelText("启用技能 PDF")).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭弹窗" })).toBeEnabled();
    fireEvent.click(screen.getByLabelText("启用技能 PDF"));
    expect(agentApi.setSkillEnabled).toHaveBeenCalledTimes(1);
    await act(async () =>
      finishOld({
        ...catalog,
        skills: [{ ...catalog.skills[0], name: "旧写入结果" }],
      }),
    );
    await flush();
    expect(screen.queryByText("旧写入结果")).not.toBeInTheDocument();
    const toggle = screen.getByLabelText("启用技能 PDF");
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(agentApi.setSkillEnabled).toHaveBeenCalledTimes(2);
    await act(async () =>
      finishNew({
        ...catalog,
        skills: [{ ...catalog.skills[0], enabled: false }],
      }),
    );
    expect(toggle).toBeEnabled();
    expect(toggle).not.toBeChecked();
  });

  it("does not start a post-reload catalog read after dismissal or write stale reload state", async () => {
    let finish: () => void = () => {};
    reload.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(agentApi.getExtensions)
      .mockResolvedValueOnce({ ...catalog, pendingReload: true })
      .mockResolvedValueOnce(catalog);
    render(<PanelHarness />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "重新载入扩展" }));
    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "打开扩展面板" }));
    await flush();
    await act(async () => finish());
    expect(agentApi.getExtensions).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("button", { name: "重新载入扩展" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("启用技能 PDF")).toBeEnabled();
  });

  it("ignores a late reload snapshot after closing and reopening the modal", async () => {
    let finish: (value: AgentExtensions) => void = () => {};
    vi.mocked(agentApi.getExtensions)
      .mockResolvedValueOnce({ ...catalog, pendingReload: true })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...catalog,
        skills: [{ ...catalog.skills[0], name: "重开后的技能" }],
      });
    render(<PanelHarness />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "重新载入扩展" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "打开扩展面板" }));
    await flush();
    await act(async () =>
      finish({
        ...catalog,
        skills: [{ ...catalog.skills[0], name: "旧重载结果" }],
      }),
    );
    expect(screen.getByText("重开后的技能")).toBeInTheDocument();
    expect(screen.queryByText("旧重载结果")).not.toBeInTheDocument();
  });

  it("does not submit an MCP write after dismissal during the configuration read", async () => {
    let finish: (
      value: Awaited<ReturnType<typeof agentApi.getExtensionConfig>>,
    ) => void = () => {};
    vi.mocked(agentApi.getExtensionConfig).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<PanelHarness />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "MCP 工具" }));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "第一次保存" },
    });
    fireEvent.change(screen.getByLabelText("服务地址"), {
      target: { value: "https://example.test/first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存服务" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "打开扩展面板" }));
    await flush();
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "新的输入" },
    });
    await act(async () =>
      finish({ revision: 4, mcp: { servers: {} }, pluginOptions: {} }),
    );
    await flush();
    expect(agentApi.saveExtensionConfig).not.toHaveBeenCalled();
    expect(screen.getByLabelText("名称")).toHaveValue("新的输入");
  });

  it("serializes an already-dispatched MCP save across close and reopen before accepting another change", async () => {
    let finish: (value: AgentExtensions) => void = () => {};
    vi.mocked(agentApi.saveExtensionConfig).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<PanelHarness />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "MCP 工具" }));
    fireEvent.click(screen.getByLabelText("启用工具 docs"));
    await flush();
    expect(agentApi.saveExtensionConfig).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "打开扩展面板" }));
    await flush();
    expect(screen.getByLabelText("启用工具 docs")).toBeDisabled();
    expect(screen.getByRole("button", { name: "返回工作台" })).toBeEnabled();
    fireEvent.click(screen.getByLabelText("启用工具 docs"));
    expect(agentApi.getExtensionConfig).toHaveBeenCalledTimes(1);
    expect(agentApi.saveExtensionConfig).toHaveBeenCalledTimes(1);
    vi.mocked(agentApi.getExtensions).mockResolvedValueOnce({
      ...catalog,
      revision: 5,
      mcpServers: [{ id: "docs", type: "remote", enabled: false }],
    });
    await act(async () => finish({ ...catalog, revision: 5 }));
    await flush();
    const toggle = screen.getByLabelText("启用工具 docs");
    expect(toggle).toBeEnabled();
    expect(toggle).not.toBeChecked();
    vi.mocked(agentApi.getExtensionConfig).mockResolvedValueOnce({
      revision: 5,
      mcp: {
        servers: {
          docs: {
            type: "remote",
            url: "https://example.test/mcp",
            disabled: true,
          },
        },
      },
      pluginOptions: {},
    });
    fireEvent.click(toggle);
    await flush();
    expect(agentApi.saveExtensionConfig).toHaveBeenCalledTimes(2);
    expect(agentApi.saveExtensionConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        revision: 5,
        mcp: {
          servers: {
            docs: {
              type: "remote",
              url: "https://example.test/mcp",
              disabled: false,
            },
          },
        },
      }),
    );
  });

  it("does not import a skill selected after its dialog has already been dismissed", async () => {
    let finish: (value: string | null) => void = () => {};
    vi.mocked(settingsApi.pickDirectory).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<PanelHarness />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "导入技能目录" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    await flush();
    await act(async () => finish("D:/fixture/late-skill"));
    expect(agentApi.importSkill).not.toHaveBeenCalled();
  });

  it("keeps native window actions inside the modal's accessible subtree with distinct close labels", async () => {
    const closeWindow = vi.fn();
    render(
      <PanelHarness
        windowControls={<button onClick={closeWindow}>关闭窗口</button>}
      />,
    );
    await flush();
    const windowButton = screen.getByRole("button", { name: "关闭窗口" });
    expect(windowButton.closest('[role="dialog"]')).toBe(
      screen.getByRole("dialog"),
    );
    expect(screen.getByRole("group", { name: "窗口操作" })).toContainElement(
      windowButton,
    );
    fireEvent.click(windowButton);
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "关闭弹窗" })).toBeEnabled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("shows the real loaded plugin error and pending revision instead of treating enabled as loaded", async () => {
    vi.mocked(agentApi.getExtensions).mockResolvedValue({
      ...catalog,
      runtimeRunning: true,
      runtimeRevision: 3,
      pendingReload: true,
      plugins: [
        { ...catalog.plugins[0], loaded: false, runtimeStatus: "unknown" },
      ],
      loadedPlugins: [
        {
          id: "exported-plugin-id",
          sourceType: "local",
          target: "private-plugin",
          server: true,
          tui: false,
          rpc: false,
          status: "failed",
          error: "当前插件不支持此引擎。",
        },
      ],
    });
    render(
      <AgentExtensionsPanel
        open
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
      />,
    );
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "当前插件不支持此引擎。",
    );
    expect(
      screen.getByRole("button", { name: "重新载入扩展" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "插件" }));
    expect(screen.getByText("运行状态待确认")).toBeInTheDocument();
    expect(screen.queryByText("已载入")).not.toBeInTheDocument();
  });
  it("keeps reload unavailable before a project is open while retaining the saved extensions", async () => {
    vi.mocked(agentApi.getExtensions).mockResolvedValue({
      ...catalog,
      runtimeRunning: false,
      pendingReload: true,
    });
    render(
      <AgentExtensionsPanel
        open
        working={false}
        projectOpen={false}
        onOpenChange={changeOpen}
        onReload={reload}
      />,
    );
    await flush();
    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.getByText(/打开项目后，工作台会载入/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新载入扩展" })).toBeDisabled();
    expect(reload).not.toHaveBeenCalled();
  });
  it("only loads when opened and displays the actual bundled skill, dependency and license", async () => {
    const view = render(
      <AgentExtensionsPanel
        open={false}
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
      />,
    );
    expect(agentApi.getExtensions).not.toHaveBeenCalled();
    view.rerender(
      <AgentExtensionsPanel
        open
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
      />,
    );
    await flush();
    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.getByText(/运行依赖：Python/)).toBeInTheDocument();
    expect(screen.getByText(/Apache-2.0/)).toBeInTheDocument();
    expect(screen.getByLabelText("启用技能 PDF")).toBeChecked();
  });
  it("persists enabling changes, blocks duplicate submissions and waits to reload while another task runs", async () => {
    let finish: (value: AgentExtensions) => void = () => {};
    vi.mocked(agentApi.setSkillEnabled).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <AgentExtensionsPanel
        open
        working
        onOpenChange={changeOpen}
        onReload={reload}
      />,
    );
    await flush();
    const toggle = screen.getByLabelText("启用技能 PDF");
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(agentApi.setSkillEnabled).toHaveBeenCalledTimes(1);
    await act(async () =>
      finish({
        ...catalog,
        skills: [{ ...catalog.skills[0], enabled: false }],
      }),
    );
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/任务结束后重新载入扩展/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新载入扩展" })).toBeDisabled();
    expect(reload).not.toHaveBeenCalled();
  });
  it("keeps actual enabled state and visible errors when saving fails", async () => {
    vi.mocked(agentApi.setSkillEnabled).mockRejectedValue(
      new Error("保存失败，原配置保留。"),
    );
    render(
      <AgentExtensionsPanel
        open
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
      />,
    );
    await flush();
    fireEvent.click(screen.getByLabelText("启用技能 PDF"));
    await flush();
    expect(screen.getByLabelText("启用技能 PDF")).toBeChecked();
    expect(screen.getByText("保存失败，原配置保留。")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重新载入扩展" }),
    ).not.toBeInTheDocument();
  });
  it("does not claim loaded extensions when a real engine reload fails", async () => {
    reload.mockRejectedValue(new Error("插件无法载入。"));
    render(
      <AgentExtensionsPanel
        open
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
      />,
    );
    await flush();
    fireEvent.click(screen.getByLabelText("启用技能 PDF"));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "重新载入扩展" }));
    await flush();
    expect(screen.getByText("插件无法载入。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新载入扩展" })).toBeEnabled();
  });
  it("imports the selected real skill folder and leaves cancellation untouched", async () => {
    render(
      <AgentExtensionsPanel
        open
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
      />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "导入技能目录" }));
    await flush();
    expect(agentApi.importSkill).toHaveBeenCalledWith("D:/fixture/skill");
    vi.mocked(settingsApi.pickDirectory).mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: "导入技能目录" }));
    await flush();
    expect(agentApi.importSkill).toHaveBeenCalledTimes(1);
  });
  it("passes an installed skill to the composer without inventing a tool execution", async () => {
    const useSkill = vi.fn();
    render(
      <AgentExtensionsPanel
        open
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
        onUseSkill={useSkill}
      />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "在会话中使用" }));
    expect(useSkill).toHaveBeenCalledWith(catalog.skills[0]);
    expect(agentApi.setSkillEnabled).not.toHaveBeenCalled();
  });
  it("offers verified on-demand skills without claiming their bodies are already loaded", async () => {
    const useSkill = vi.fn();
    vi.mocked(agentApi.getExtensions).mockResolvedValue({
      ...catalog,
      skills: [
        { ...catalog.skills[0], loaded: false, runtimeStatus: "available" },
      ],
    });
    render(
      <AgentExtensionsPanel
        open
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
        onUseSkill={useSkill}
      />,
    );
    await flush();
    expect(screen.getByText(/按需可用/)).toBeInTheDocument();
    expect(screen.queryByText(/已载入/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在会话中使用" }));
    expect(useSkill).toHaveBeenCalledWith(
      expect.objectContaining({ loaded: false, runtimeStatus: "available" }),
    );
  });
  it("shows the real reason a bounded skill could not be made available", async () => {
    vi.mocked(agentApi.getExtensions).mockResolvedValue({
      ...catalog,
      skills: [
        {
          ...catalog.skills[0],
          loaded: false,
          runtimeStatus: "failed",
          error: "技能正文超过单文件读取上限",
        },
      ],
    });
    render(
      <AgentExtensionsPanel
        open
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
        onUseSkill={vi.fn()}
      />,
    );
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "技能正文超过单文件读取上限",
    );
    expect(screen.getByRole("button", { name: "在会话中使用" })).toBeDisabled();
  });
  it("installs an actual native-selected plugin path and does not invent marketplace entries", async () => {
    render(
      <AgentExtensionsPanel
        open
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
      />,
    );
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "插件" }));
    expect(screen.getByText("Local Plugin")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "安装插件文件" }));
    await flush();
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ directory: false, multiple: false }),
    );
    expect(agentApi.installPlugin).toHaveBeenCalledWith(
      "D:/fixture/plugin.mjs",
    );
  });
  it("toggles a real MCP server while retaining masked credentials and plugin settings", async () => {
    render(
      <AgentExtensionsPanel
        open
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
      />,
    );
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "MCP 工具" }));
    fireEvent.click(screen.getByLabelText("启用工具 docs"));
    await flush();
    expect(agentApi.saveExtensionConfig).toHaveBeenCalledWith({
      revision: 4,
      mcp: {
        servers: {
          docs: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: { Authorization: "[hidden]" },
            disabled: true,
          },
        },
      },
      pluginOptions: { "local-plugin": { token: "[hidden]" } },
    });
    expect(screen.queryByText("[hidden]")).not.toBeInTheDocument();
  });
  it("rejects a non-HTTP MCP address before submitting any configuration", async () => {
    render(
      <AgentExtensionsPanel
        open
        working={false}
        onOpenChange={changeOpen}
        onReload={reload}
      />,
    );
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "MCP 工具" }));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "evil" },
    });
    fireEvent.change(screen.getByLabelText("服务地址"), {
      target: { value: "file:///fixture" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存服务" }));
    await flush();
    expect(
      screen.getByText("请填写 http 或 https 服务地址。"),
    ).toBeInTheDocument();
    expect(agentApi.saveExtensionConfig).not.toHaveBeenCalled();
  });
});
