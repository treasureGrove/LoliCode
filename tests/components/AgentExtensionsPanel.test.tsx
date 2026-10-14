import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentExtensionsPanel } from "@/components/agent/AgentExtensionsPanel";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api";
import { open } from "@tauri-apps/plugin-dialog";
import type { AgentExtensions } from "@/types/agent";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    getExtensions: vi.fn(),
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
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentApi.getExtensions).mockResolvedValue(structuredClone(catalog));
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
