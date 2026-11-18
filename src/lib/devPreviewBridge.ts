/**
 * Development-only preview bridge when running `vite` (`dev:renderer`) directly
 * in a browser outside the Tauri desktop shell. Never active in Tauri builds,
 * production bundles, or Vitest unit tests.
 */
export function installDevBrowserPreviewBridge(): void {
  if (
    !import.meta.env.DEV ||
    import.meta.env.MODE === "test" ||
    typeof window === "undefined" ||
    "__TAURI_INTERNALS__" in window
  ) {
    return;
  }

  const queryTheme = new URLSearchParams(window.location.search).get("theme");
  if (queryTheme === "dark" || queryTheme === "light") {
    window.localStorage.setItem("lolicode-theme", queryTheme);
  }

  const callbacks = new Map<number, (...args: unknown[]) => void>();
  let nextCbId = 1;

  const sampleCatalog = {
    revision: 3,
    defaultModel: "studio/deepseek-v3",
    excludedSources: [],
    models: [
      {
        id: "studio/deepseek-v3",
        providerId: "studio",
        modelId: "deepseek-v3",
        name: "DeepSeek V3.2",
        channelName: "Main Studio",
      },
      {
        id: "studio/deepseek-r1",
        providerId: "studio",
        modelId: "deepseek-r1",
        name: "DeepSeek R1",
        channelName: "Main Studio",
      },
    ],
  };

  let installedPlugins = [
    {
      name: "dsh-plan-note",
      version: "0.1.2",
      enabled: true,
      installedAt: "2026-11-17T08:00:00Z",
      sourceType: "npm",
      sourceSpec: "dsh-plan-note@0.1.2",
      title: { zh: "计划笔记本", en: "Plan Note" },
      description: { zh: "记录 Agent 的分阶段规划与上下文笔记。" },
      author: "community",
      category: "workflow",
      hasBundle: true,
      hasClient: false,
      patchFiles: ["./cordis.patch.yml"],
    },
  ];

  let harnessBundles = [
    {
      id: "terminal",
      name: "@deepseek-ai/dsh-experimental-terminal-bundle",
      description: "在任务执行期间复用终端进程和命令状态。",
      version: "0.2.2-rc.2",
      enabled: true,
    },
    {
      id: "session-search",
      name: "@deepseek-ai/dsh-experimental-session-search",
      description: "使用 SQLite 全文索引检索与阅读历史会话。",
      version: "0.2.2-rc.2",
      enabled: false,
    },
    {
      id: "ralph",
      name: "@deepseek-ai/dsh-experimental-ralph-bundle",
      description: "按会话目标持续跟进任务，直到满足完成条件。",
      version: "0.2.2-rc.2",
      enabled: false,
    },
  ];

  const feedItems = [
    {
      name: "dsh-plan-note",
      title: { zh: "计划笔记本", en: "Plan Note" },
      description: {
        zh: "在工作台任务执行期间自动记录分阶段计划与里程碑笔记，跨轮次保留上下文。",
      },
      author: "deepseek-community",
      category: "workflow",
      categoryTitle: { zh: "工作流" },
      keywords: ["plan", "notes"],
      latestVersion: "0.1.2",
      defaultVersion: "0.1.2",
      publishedAt: 1730000000,
      enginesDsh: ">=0.2.1-rc.1",
      compatible: true,
      exempted: false,
      installed: true,
      enabled: true,
      updateAvailable: false,
      sourceType: "npm",
      versionsCount: 2,
    },
    {
      name: "@yolk_vat-y/dsh-project-memory",
      title: { zh: "项目长期记忆与文档解析", en: "Project Memory" },
      description: {
        zh: "基于工作区索引长期沉淀规范、架构决策与参考 PDF 文档片段。",
      },
      author: "yolk_vat-y",
      category: "memory",
      categoryTitle: { zh: "记忆增强" },
      keywords: ["memory", "pdf"],
      latestVersion: "0.7.0",
      defaultVersion: "0.7.0",
      publishedAt: 1730500000,
      enginesDsh: ">=0.2.0-rc.1",
      compatible: true,
      exempted: false,
      installed: false,
      enabled: false,
      updateAvailable: false,
      sourceType: "npm",
      versionsCount: 4,
    },
    {
      name: "dsh-verification-receipt",
      title: { zh: "自动验证回执单", en: "Verification Receipt" },
      description: {
        zh: "每次改动代码后收集测试与构建状态回执，确保交付结果可靠可追溯。",
      },
      author: "community",
      category: "tools",
      categoryTitle: { zh: "开发工具" },
      keywords: ["test", "verify"],
      latestVersion: "1.1.0",
      defaultVersion: "1.1.0",
      publishedAt: 1731000000,
      enginesDsh: ">=0.2.1-rc.1",
      compatible: true,
      exempted: false,
      installed: false,
      enabled: false,
      updateAvailable: false,
      sourceType: "npm",
      versionsCount: 3,
    },
    {
      name: "dsh-legacy-bridge",
      title: { zh: "旧版命令适配桥", en: "Legacy Command Bridge" },
      description: {
        zh: "针对更高核心版本实验协议开发的辅助扩展，可通过兼容豁免启用。",
      },
      author: "studio-lab",
      category: "tools",
      categoryTitle: { zh: "开发工具" },
      keywords: ["bridge"],
      latestVersion: "0.9.0",
      defaultVersion: "0.9.0",
      publishedAt: 1729000000,
      enginesDsh: ">=0.3.0",
      compatible: false,
      exempted: false,
      installed: false,
      enabled: false,
      updateAvailable: false,
      sourceType: "npm",
      versionsCount: 1,
    },
  ];

  const DEFAULT_SOURCE =
    "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json";

  const buildOverview = () => ({
    runtimeVersion: "0.2.2-rc.2",
    sources: [
      {
        url: DEFAULT_SOURCE,
        title: { zh: "Awesome DSH Plugin (社区主站)" },
        pluginCount: 5959,
        fetchedAt: 1731830000,
        fromCache: true,
      },
    ],
    presets: [],
    selectedSource: DEFAULT_SOURCE,
    installed: installedPlugins,
    onDemandOfficial: [
      {
        name: "@deepseek-ai/dsh-subagent-claude-code",
        title: "Claude Code 子智能体",
        titleEn: "Claude Code Subagent",
        description: "使用原生配置运行子代理编码任务。",
        descriptionEn: "Delegate coding tasks.",
        targetVersion: "0.2.2-rc.2",
        installed: false,
        enabled: false,
      },
      {
        name: "@deepseek-ai/dsh-subagent-codex",
        title: "Codex 子智能体",
        titleEn: "Codex Subagent",
        description: "通过 Codex 运行隔离执行任务。",
        descriptionEn: "Delegate tasks to Codex.",
        targetVersion: "0.2.2-rc.2",
        installed: false,
        enabled: false,
      },
    ],
    harnessBundles,
    pendingReload: false,
    enabledCount:
      installedPlugins.filter((p) => p.enabled).length +
      harnessBundles.filter((b) => b.enabled).length,
    revision: 1,
  });

  const handleInvoke = async (
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> => {
    switch (cmd) {
      case "get_init_error":
        return null;
      case "get_settings":
        return {
          language: "zh",
          visibleApps: {
            claude: true,
            codex: true,
            gemini: false,
            opencode: false,
            openclaw: false,
          },
          firstRunNoticeConfirmed: true,
          newLayoutNoticeConfirmed: true,
          whatsNewSeenVersion: "1.1.1",
        };
      case "list_builtin_apps":
        return [
          { id: "tavern", enabled: true },
          { id: "unreal", enabled: true },
          { id: "rankings", enabled: true },
          { id: "free-ai", enabled: true },
        ];
      case "lolicode_account_status":
        return { signedIn: false, account: null };
      case "lolicode_relay_status":
        return { connected: false };
      case "get_agent_status":
        return { available: true, version: "0.2.2-rc.2" };
      case "get_agent_catalog":
      case "get_tavern_catalog":
        return sampleCatalog;
      case "get_agent_catalog_revision":
        return sampleCatalog.revision;
      case "list_agent_projects":
        return [
          {
            path: "D:/workspace/studio-demo",
            name: "studio-demo",
            pinned: true,
          },
        ];
      case "open_agent_project":
      case "open_agent_standalone":
        return {
          workspace: {
            path: "D:/workspace/studio-demo",
            name: "studio-demo",
          },
          catalog: sampleCatalog,
          sessions: [
            {
              id: "session-preview-1",
              projectPath: "D:/workspace/studio-demo",
              title: "亮色工作台与插件市场对齐",
              updatedAt: 1731830000,
              status: "idle",
            },
          ],
        };
      case "list_agent_sessions":
        return [
          {
            id: "session-preview-1",
            projectPath: "D:/workspace/studio-demo",
            title: "亮色工作台与插件市场对齐",
            updatedAt: 1731830000,
            status: "idle",
          },
        ];
      case "get_agent_session":
        return {
          session: {
            id: "session-preview-1",
            projectPath: "D:/workspace/studio-demo",
            title: "亮色工作台与插件市场对齐",
            updatedAt: 1731830000,
            model: { providerId: "studio", modelId: "deepseek-v3" },
            permissionMode: "ask",
          },
          status: "idle",
          messages: [
            {
              id: "m1",
              role: "user",
              createdAt: 1731829900,
              parts: [
                {
                  type: "text",
                  text: "请帮我确认插件市场搬运的 DSH 插件已经对齐工作台亮色主题。",
                },
              ],
            },
            {
              id: "m2",
              role: "assistant",
              createdAt: 1731830000,
              parts: [
                {
                  type: "text",
                  text: "已完成工作台亮色主题与搬运 / 兼容 DSH 插件市场集成，可以在左侧导航直接切换「插件市场」与「自动化」。",
                },
              ],
            },
          ],
          permissions: [],
          questions: [],
          queuedMessages: [],
          backgroundJobs: 0,
          titlePending: false,
          compacting: false,
        };
      case "get_agent_extensions":
        return { revision: 1, skills: [], plugins: [], mcpServers: [] };
      case "get_agent_harness_plugins":
        return { bundles: harnessBundles, pendingReload: false };
      case "set_agent_harness_plugin_enabled": {
        const id = String(args?.id ?? "");
        const enabled = Boolean(args?.enabled);
        harnessBundles = harnessBundles.map((b) =>
          b.id === id ? { ...b, enabled } : b,
        );
        return { bundles: harnessBundles, pendingReload: true };
      }
      case "get_dsh_marketplace_overview":
        return buildOverview();
      case "query_dsh_marketplace": {
        const q = (args?.query ?? {}) as {
          text?: string;
          category?: string | null;
          compatibleOnly?: boolean;
        };
        const text = (q.text ?? "").trim().toLowerCase();
        const filtered = feedItems.filter((item) => {
          if (q.category && item.category !== q.category) return false;
          if (q.compatibleOnly && !item.compatible) return false;
          if (text) {
            return (
              item.name.toLowerCase().includes(text) ||
              (item.title?.zh ?? "").toLowerCase().includes(text) ||
              (item.description?.zh ?? "").toLowerCase().includes(text)
            );
          }
          return true;
        });
        return {
          sourceUrl: DEFAULT_SOURCE,
          feedTitle: { zh: "Awesome DSH Plugin (社区主站)" },
          total: filtered.length,
          totalInFeed: 5959,
          fromCache: true,
          categories: [
            { id: "workflow", title: { zh: "工作流" }, count: 124 },
            { id: "memory", title: { zh: "记忆增强" }, count: 86 },
            { id: "tools", title: { zh: "开发工具" }, count: 310 },
          ],
          items: filtered.map((it) => {
            const inst = installedPlugins.find((p) => p.name === it.name);
            return {
              ...it,
              installed: Boolean(inst),
              enabled: inst ? inst.enabled : false,
            };
          }),
          nextOffset: null,
        };
      }
      case "get_dsh_marketplace_detail": {
        const name = String(args?.name ?? "");
        const item = feedItems.find((it) => it.name === name) ?? feedItems[0];
        if (!item) return null;
        const inst = installedPlugins.find((p) => p.name === item.name);
        return {
          name: item.name,
          title: item.title,
          description: item.description,
          author: item.author,
          category: item.category,
          categoryTitle: item.categoryTitle,
          defaultVersion: item.defaultVersion,
          installedVersion: inst?.version ?? null,
          installed: Boolean(inst),
          enabled: inst ? inst.enabled : false,
          compatible: item.compatible,
          exempted: item.exempted,
          enginesDsh: item.enginesDsh,
          publishedAt: item.publishedAt,
          homepage: "https://github.com/deepseek-ai/dsh",
          readmeMarkdown: `### ${item.title?.zh ?? item.name}\n\n${item.description?.zh ?? ""}\n\n- 兼容运行时：\`${item.enginesDsh}\`\n- 包标识：\`${item.name}\`\n- 来源通道：${item.sourceType}`,
          versions: [
            {
              version: item.defaultVersion,
              enginesDsh: item.enginesDsh,
              publishedAt: item.publishedAt,
            },
          ],
        };
      }
      case "set_dsh_marketplace_plugin_enabled": {
        const name = String(args?.name ?? "");
        const enabled = Boolean(args?.enabled);
        installedPlugins = installedPlugins.map((p) =>
          p.name === name ? { ...p, enabled } : p,
        );
        return buildOverview();
      }
      case "get_tavern_snapshot":
        return {
          characters: [
            {
              id: "char-studio",
              name: "初音未来",
              description:
                "温柔敏锐的创作搭档，擅长在工作之余一起整理灵感与轻量旋律片段。",
              tags: ["创作搭档", "日常灵感", "温暖"],
              characterVersion: "2.1",
              creator: "Lovely Studio",
              sourceFormat: "V2",
              hasAvatar: false,
            },
            {
              id: "char-assistant",
              name: "小墨",
              description: "负责架构推演与代码梳理的冷静技术顾问。",
              tags: ["技术问答", "推理"],
              hasAvatar: false,
            },
          ],
          stories: [
            {
              id: "story-1",
              characterId: "char-studio",
              title: "午后创作漫谈",
              updatedAt: 1731830000,
              messages: [
                {
                  id: "t1",
                  role: "assistant",
                  text: "下午好呀，刚刚把工作台的暖奶油色板重新校正过一遍，看起来顺眼了很多呢。",
                  createdAt: 1731829950,
                },
                {
                  id: "t2",
                  role: "user",
                  text: "对，我们再顺便确认一下对话界面和卡片阴影在亮色下的质感。",
                  createdAt: 1731830000,
                },
              ],
            },
          ],
        };
      case "check_env_conflicts":
        return [];
      case "plugin:event|listen":
        return nextCbId++;
      case "plugin:event|unlisten":
        return null;
      case "get_tavern_presets":
        return [];
      case "get_tavern_local_model":
        return { status: "stopped", installed: false, enabled: false };
      default:
        return null;
    }
  };

  const win = window as unknown as Record<string, unknown>;
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  win.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: (cb: (...args: unknown[]) => void) => {
      const id = nextCbId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => {
      callbacks.delete(id);
    },
    invoke: (cmd: string, args?: Record<string, unknown>) =>
      handleInvoke(cmd, args),
    convertFileSrc: (path: string) => path,
  };
}
