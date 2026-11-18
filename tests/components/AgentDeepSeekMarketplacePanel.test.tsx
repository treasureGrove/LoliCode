import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDeepSeekMarketplacePanel } from "@/features/agent/AgentDeepSeekMarketplacePanel";
import { settingsApi } from "@/lib/api";
import { agentApi } from "@/lib/api/agent";
import type {
  DshMarketDetail,
  DshMarketOverview,
  DshMarketPage,
} from "@/types/agent";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    getDshMarketplaceOverview: vi.fn(),
    queryDshMarketplace: vi.fn(),
    getDshMarketplaceDetail: vi.fn(),
    addDshMarketplaceSource: vi.fn(),
    removeDshMarketplaceSource: vi.fn(),
    selectDshMarketplaceSource: vi.fn(),
    refreshDshMarketplaceSource: vi.fn(),
    installDshMarketplacePlugin: vi.fn(),
    setDshMarketplacePluginEnabled: vi.fn(),
    updateDshMarketplacePlugin: vi.fn(),
    uninstallDshMarketplacePlugin: vi.fn(),
    setHarnessPluginEnabled: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  settingsApi: { pickDirectory: vi.fn(), openExternal: vi.fn() },
}));

const DEFAULT_SOURCE =
  "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json";

const baseOverview: DshMarketOverview = {
  runtimeVersion: "0.2.2-rc.2",
  sources: [
    {
      url: DEFAULT_SOURCE,
      title: { zh: "Awesome DSH Plugin", en: "Awesome DSH Plugin" },
      pluginCount: 2,
      fetchedAt: 1700000000,
      fromCache: true,
    },
  ],
  presets: [
    {
      url: "https://dshmarket.com/index.json",
      label: "DSH Market 镜像",
      description: "DeepSeek Harness 社区插件市场镜像源。",
      added: false,
    },
  ],
  selectedSource: DEFAULT_SOURCE,
  installed: [],
  onDemandOfficial: [
    {
      name: "@deepseek-ai/dsh-subagent-claude-code",
      title: "Claude Code 子代理",
      titleEn: "Claude Code Subagent",
      description: "通过 Claude CLI 运行子代理任务。",
      descriptionEn: "Run tasks through Claude CLI.",
      targetVersion: "0.2.2-rc.2",
      installed: false,
      enabled: false,
    },
  ],
  harnessBundles: [
    {
      id: "terminal",
      name: "@deepseek-ai/dsh-experimental-terminal-bundle",
      description: "Persistent terminal tools",
      version: "0.2.2-rc.2",
      enabled: false,
    },
  ],
  pendingReload: false,
  enabledCount: 0,
  revision: 1,
};

const basePage: DshMarketPage = {
  sourceUrl: DEFAULT_SOURCE,
  feedTitle: { zh: "Awesome DSH Plugin", en: "Awesome DSH Plugin" },
  total: 2,
  totalInFeed: 2,
  fromCache: true,
  categories: [
    {
      id: "memory",
      title: { zh: "记忆增强", en: "Memory" },
      count: 1,
    },
    {
      id: "workflow",
      title: { zh: "工作流", en: "Workflow" },
      count: 1,
    },
  ],
  items: [
    {
      name: "dsh-plan-note",
      title: { zh: "计划笔记本", en: "Plan Note" },
      description: { zh: "记录 Agent 的分阶段规划与上下文笔记。" },
      author: "deepseek-community",
      category: "memory",
      categoryTitle: { zh: "记忆增强", en: "Memory" },
      keywords: ["plan", "notes"],
      latestVersion: "1.0.0",
      defaultVersion: "1.0.0",
      publishedAt: 1730000000,
      enginesDsh: ">=0.2.1-rc.1",
      compatible: true,
      exempted: false,
      installed: false,
      enabled: false,
      updateAvailable: false,
      sourceType: "npm",
      versionsCount: 2,
    },
    {
      name: "dsh-legacy-helper",
      title: { zh: "旧版辅助包", en: "Legacy Helper" },
      description: { zh: "需要更高核心版本的插件。" },
      author: "community",
      category: "workflow",
      categoryTitle: { zh: "工作流", en: "Workflow" },
      keywords: ["legacy"],
      latestVersion: "0.9.0",
      defaultVersion: "0.9.0",
      publishedAt: 1720000000,
      enginesDsh: ">=0.3.0",
      compatible: false,
      exempted: false,
      installed: false,
      enabled: false,
      updateAvailable: false,
      sourceType: "npm",
      versionsCount: 1,
    },
  ],
  nextOffset: null,
};

const baseDetail: DshMarketDetail = {
  name: "dsh-plan-note",
  runtimeVersion: "0.2.2-rc.2",
  title: { zh: "计划笔记本", en: "Plan Note" },
  description: { zh: "记录 Agent 的分阶段规划与上下文笔记。" },
  author: "deepseek-community",
  homepage: "https://example.com/dsh-plan-note",
  category: "memory",
  categoryTitle: { zh: "记忆增强", en: "Memory" },
  keywords: ["plan"],
  versions: [
    {
      version: "1.0.0",
      publishTimestamp: 1730000000,
      sourceType: "npm",
      enginesDsh: ">=0.2.1-rc.1",
      compatible: true,
      exempted: false,
    },
  ],
  defaultVersion: "1.0.0",
  latestVersion: "1.0.0",
  compatible: true,
  exempted: false,
  installed: false,
  enabled: false,
  readme: "# Plan Note\n\n让 Harness 会话在规划阶段保留持久化工作笔记。",
};

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) {
      await Promise.resolve();
    }
  });
};

describe("AgentDeepSeekMarketplacePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentApi.getDshMarketplaceOverview).mockResolvedValue(
      structuredClone(baseOverview),
    );
    vi.mocked(agentApi.queryDshMarketplace).mockResolvedValue(
      structuredClone(basePage),
    );
    vi.mocked(agentApi.getDshMarketplaceDetail).mockResolvedValue(
      structuredClone(baseDetail),
    );
    vi.mocked(agentApi.setDshMarketplacePluginEnabled).mockResolvedValue({
      ...baseOverview,
      enabledCount: 0,
      installed: [
        {
          name: "dsh-plan-note",
          version: "1.0.0",
          enabled: false,
          installedAt: "2026-11-17T08:00:00Z",
          sourceType: "npm",
          sourceSpec: "dsh-plan-note@1.0.0",
          hasBundle: true,
          hasClient: false,
          patchFiles: ["./cordis.patch.yml"],
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders Official extensions by default, and supports Discover search/install/toggle", async () => {
    const onChanged = vi.fn();
    const installedOverview: DshMarketOverview = {
      ...baseOverview,
      enabledCount: 1,
      pendingReload: true,
      installed: [
        {
          name: "dsh-plan-note",
          version: "1.0.0",
          enabled: true,
          installedAt: "2026-11-17T08:00:00Z",
          sourceType: "npm",
          sourceSpec: "dsh-plan-note@1.0.0",
          title: { zh: "计划笔记本" },
          hasBundle: true,
          hasClient: false,
          patchFiles: ["./cordis.patch.yml"],
        },
      ],
    };
    vi.mocked(agentApi.installDshMarketplacePlugin).mockResolvedValue(
      installedOverview,
    );

    render(
      <AgentDeepSeekMarketplacePanel
        open
        onClose={vi.fn()}
        projectPath="D:/workspace/demo"
        onChanged={onChanged}
      />,
    );
    await flush();

    expect(
      screen.getByText("LOVELY STUDIO · 兼容 / 搬运 DSH 插件生态"),
    ).toBeInTheDocument();
    expect(screen.getByText("搬运 · 兼容 DSH 插件")).toBeInTheDocument();
    expect(screen.getByText(/DSH ♡ PLUGINS/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "官方与按需" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("持久终端")).toBeInTheDocument();

    // Switch to Discover tab (lower priority) and filter category
    fireEvent.click(screen.getByRole("tab", { name: "发现市场" }));
    await flush();
    expect(screen.getByText("计划笔记本")).toBeInTheDocument();
    expect(screen.getByText("记忆增强")).toBeInTheDocument();

    // Filter category
    fireEvent.click(screen.getByRole("button", { name: "记忆增强 (1)" }));
    await flush();
    expect(agentApi.queryDshMarketplace).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "memory" }),
    );

    // Install first card
    const installButtons = screen.getAllByRole("button", { name: "安装" });
    fireEvent.click(installButtons[0]!);
    await flush();

    expect(agentApi.installDshMarketplacePlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        nameOrSpec: "dsh-plan-note",
        version: "1.0.0",
        acceptIncompatible: false,
      }),
    );
    expect(onChanged).toHaveBeenLastCalledWith(1);
    expect(
      screen.getByText(/插件配置已更新并同步至 Harness 会话配置/),
    ).toBeInTheDocument();

    // Switch to Installed tab and toggle plugin off
    fireEvent.click(screen.getByRole("tab", { name: "已安装 (1)" }));
    const toggle = screen.getByRole("checkbox", {
      name: "启用插件 计划笔记本",
    });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await flush();
    expect(agentApi.setDshMarketplacePluginEnabled).toHaveBeenCalledWith(
      "dsh-plan-note",
      false,
    );
    expect(onChanged).toHaveBeenLastCalledWith(0);
  });

  it("opens plugin detail README and triggers homepage external link", async () => {
    render(<AgentDeepSeekMarketplacePanel open onClose={vi.fn()} />);
    await flush();

    fireEvent.click(screen.getByRole("tab", { name: "发现市场" }));
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "计划笔记本" }));
    await flush();

    expect(agentApi.getDshMarketplaceDetail).toHaveBeenCalledWith(
      "dsh-plan-note",
      "1.0.0",
      DEFAULT_SOURCE,
    );
    expect(
      screen.getByText(/让 Harness 会话在规划阶段保留持久化工作笔记/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /打开主页/ }));
    expect(settingsApi.openExternal).toHaveBeenCalledWith(
      "https://example.com/dsh-plan-note",
    );
  });

  it("prompts for compatibility exemption before retrying incompatible install", async () => {
    vi.mocked(agentApi.installDshMarketplacePlugin)
      .mockRejectedValueOnce(
        new Error(
          "版本不兼容：dsh-legacy-helper@0.9.0 要求 DeepSeek Harness >=0.3.0，当前运行版本为 0.2.2-rc.2",
        ),
      )
      .mockResolvedValueOnce({
        ...baseOverview,
        enabledCount: 1,
        installed: [
          {
            name: "dsh-legacy-helper",
            version: "0.9.0",
            enabled: true,
            installedAt: "2026-11-17T08:00:00Z",
            sourceType: "npm",
            sourceSpec: "dsh-legacy-helper@0.9.0",
            hasBundle: true,
            hasClient: false,
            patchFiles: ["./cordis.patch.yml"],
          },
        ],
      });

    render(<AgentDeepSeekMarketplacePanel open onClose={vi.fn()} />);
    await flush();

    fireEvent.click(screen.getByRole("tab", { name: "发现市场" }));
    await flush();

    const installButtons = screen.getAllByRole("button", { name: "安装" });
    fireEvent.click(installButtons[1]!);
    await flush();

    expect(
      screen.getByText(/版本不兼容：dsh-legacy-helper@0.9.0/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "允许兼容豁免并安装" }));
    await flush();

    expect(agentApi.installDshMarketplacePlugin).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nameOrSpec: "dsh-legacy-helper",
        version: "0.9.0",
        acceptIncompatible: true,
      }),
    );
  });

  it("toggles built-in Harness bundles and installs on-demand official bundles", async () => {
    vi.mocked(agentApi.setHarnessPluginEnabled).mockResolvedValue({
      bundles: [
        {
          ...baseOverview.harnessBundles[0]!,
          enabled: true,
        },
      ],
      pendingReload: true,
    });
    vi.mocked(agentApi.installDshMarketplacePlugin).mockResolvedValue({
      ...baseOverview,
      enabledCount: 2,
    });

    render(<AgentDeepSeekMarketplacePanel open onClose={vi.fn()} />);
    await flush();

    fireEvent.click(
      screen.getByRole("checkbox", { name: /启用内置扩展 持久终端/ }),
    );
    await flush();
    expect(agentApi.setHarnessPluginEnabled).toHaveBeenCalledWith(
      "terminal",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "一键安装" }));
    await flush();
    expect(agentApi.installDshMarketplacePlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        nameOrSpec: "@deepseek-ai/dsh-subagent-claude-code",
        version: "0.2.2-rc.2",
      }),
    );
  });

  it("manages custom Format-1 index sources", async () => {
    vi.mocked(agentApi.addDshMarketplaceSource).mockResolvedValue({
      ...baseOverview,
      sources: [
        ...baseOverview.sources,
        {
          url: "https://custom.example/index.json",
          title: { en: "Custom Feed" },
          pluginCount: 4,
          fromCache: false,
        },
      ],
      selectedSource: "https://custom.example/index.json",
    });

    render(<AgentDeepSeekMarketplacePanel open onClose={vi.fn()} />);
    await flush();

    fireEvent.click(screen.getByRole("tab", { name: "发现市场" }));
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /索引源 \(1\)/ }));
    fireEvent.change(screen.getByLabelText("自定义索引 URL"), {
      target: { value: "https://custom.example/index.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加索引源" }));
    await flush();

    expect(agentApi.addDshMarketplaceSource).toHaveBeenCalledWith(
      "https://custom.example/index.json",
    );
  });
});
