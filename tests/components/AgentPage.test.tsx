import {
  act,
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPage } from "@/features/agent/AgentPage";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api";
import { agentMemoryApi } from "@/lib/api/agent-memory";
import { usageApi } from "@/lib/api/usage";
import { toast } from "@/lib/toast";
import {
  captureAgentDraft,
  readAgentSubmission,
  saveAgentSubmission,
} from "@/lib/agentInputLedger";
import type { AgentCatalog, AgentSession, AgentSnapshot } from "@/types/agent";
import { emitTauriEvent } from "../msw/tauriMocks";

function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return testingRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

vi.mock("@/lib/api/usage", () => ({
  usageApi: { getSessionUsageSummary: vi.fn() },
}));
vi.mock("@/lib/api/agent-memory", () => ({
  agentMemoryApi: { get: vi.fn() },
}));

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    getStatus: vi.fn(),
    getCatalog: vi.fn(),
    getCatalogRevision: vi.fn(),
    openProject: vi.fn(),
    openStandalone: vi.fn(),
    listSessions: vi.fn(),
    listProjects: vi.fn(),
    setProjectMetadata: vi.fn(),
    renameProject: vi.fn(),
    removeProject: vi.fn(),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    renameSession: vi.fn(),
    setSessionMetadata: vi.fn(),
    deleteSession: vi.fn(),
    getExtensions: vi.fn(),
    getPluginStore: vi.fn(),
    getNativeActivity: vi.fn(),
    native: vi.fn(),
    getSession: vi.fn(),
    sendMessage: vi.fn(),
    queryCommand: vi.fn(),
    interruptSession: vi.fn(),
    replyPermission: vi.fn(),
    replyQuestion: vi.fn(),
    rejectQuestion: vi.fn(),
    closeProject: vi.fn(),
  },
}));
vi.mock("@/lib/api", () => ({
  settingsApi: { pickDirectory: vi.fn(), openExternal: vi.fn() },
}));

const project = "D:/fixture/project";
const catalog: AgentCatalog = {
  revision: 3,
  defaultModel: "lolicode/channel-one/model/with/slashes",
  excludedSources: ["原生订阅"],
  models: [
    {
      id: "lolicode/channel-one/model/with/slashes",
      providerId: "lolicode",
      modelId: "channel-one/model/with/slashes",
      name: "Code Model",
      channelName: "DeepSeek",
    },
    {
      id: "lolicode/channel-two/model-b",
      providerId: "lolicode",
      modelId: "channel-two/model-b",
      name: "Model B",
      channelName: "Copilot",
    },
  ],
};
const session: AgentSession = {
  id: "s1",
  title: "修复测试",
  projectPath: project,
  mode: "build",
  model: { providerId: "lolicode", modelId: "channel-one/model/with/slashes" },
  createdAt: 1,
  updatedAt: 2,
};
const emptySnapshot = (): AgentSnapshot => ({
  session: structuredClone(session),
  status: "idle",
  messages: [],
  permissions: [],
  questions: [],
  diffs: [],
  streamConnected: true,
  streamGap: false,
});
let snapshot: AgentSnapshot;
const pendingStopCleanups = new Set<() => void>();
async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}
async function tick(ms = 800) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
function sessionCreationButton() {
  const existing = screen.queryAllByRole("button", {
    name: /^(?:新建|开始)会话$/,
  });
  if (existing.length) return existing[existing.length - 1];
  return screen.getByRole("button", { name: "新建任务" });
}
function fill(text = "修复这个项目的测试") {
  fireEvent.change(screen.getByLabelText("发送给 Agent 的消息"), {
    target: { value: text },
  });
}
function modelRefreshButton() {
  const picker = screen.getByRole("button", { name: "模型" });
  if (picker.getAttribute("aria-expanded") !== "true") fireEvent.click(picker);
  return screen.getByRole("button", { name: "刷新可用模型" });
}
async function folderMenuItem() {
  const trigger = screen.getByRole("button", { name: "选择新建任务类型" });
  expect(trigger).toBeEnabled();
  if (trigger.getAttribute("aria-expanded") !== "true")
    fireEvent.keyDown(trigger, { key: "Enter" });
  await flush();
  return screen.getByRole("menuitem", { name: "打开文件夹" });
}
async function expectFolderEnabled() {
  const item = await folderMenuItem();
  expect(item).not.toHaveAttribute("aria-disabled", "true");
  expect(item).not.toHaveAttribute("data-disabled");
  fireEvent.keyDown(item, { key: "Escape" });
  await flush();
}
async function openFolder() {
  fireEvent.click(await folderMenuItem());
  await flush();
}
function selectModel(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "模型" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索模型或渠道" }), {
    target: { value: name },
  });
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(` · ${name}$`) }),
  );
}

beforeEach(() => {
  vi.mocked(agentMemoryApi.get).mockResolvedValue({
    revision: 1,
    enabled: true,
    requireApproval: true,
    projectPath: project,
    user: { entries: [], used: 0, limit: 1375 },
    project: { entries: [], used: 0, limit: 2200 },
  });
  vi.mocked(agentApi.getPluginStore).mockResolvedValue({
    marketplaces: [],
    availablePlugins: [],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
    capability: { supported: true },
  });
  vi.mocked(agentApi.getNativeActivity).mockResolvedValue({
    features: { workflows: true, automation: true, remote: false },
  });
  vi.mocked(agentApi.native).mockImplementation(async (_service, method) =>
    method === "listSavedWorkflows"
      ? { workflows: [], invalid: [] }
      : { runs: [] },
  );
  vi.mocked(usageApi.getSessionUsageSummary).mockReset().mockResolvedValue({
    totalRequests: 0,
    totalCost: "0",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    realTotalTokens: 0,
    cacheHitRate: 0,
    successRate: 0,
    unpricedRequests: 0,
    partialRequests: 0,
    cachePartialRequests: 0,
  });
  vi.useFakeTimers();
  vi.spyOn(toast, "warning").mockClear().mockReturnValue(0);
  sessionStorage.clear();
  for (const key of Object.keys(localStorage))
    if (key.startsWith("lolicode.agent.input:")) localStorage.removeItem(key);
  localStorage.removeItem("lolicode.agent.recent-projects");
  snapshot = emptySnapshot();
  vi.mocked(agentApi.getStatus).mockReset().mockResolvedValue({
    available: true,
    running: true,
    projectPath: project,
    version: "2.0.12",
  });
  vi.mocked(agentApi.getCatalog)
    .mockReset()
    .mockResolvedValue(structuredClone(catalog));
  vi.mocked(agentApi.getCatalogRevision)
    .mockReset()
    .mockResolvedValue(catalog.revision);
  vi.mocked(agentApi.listSessions)
    .mockReset()
    .mockResolvedValue([structuredClone(session)]);
  vi.mocked(agentApi.listProjects)
    .mockReset()
    .mockResolvedValue([
      { path: project, name: "project", pinned: false, lastOpenedAt: 2 },
    ]);
  vi.mocked(agentApi.renameProject)
    .mockReset()
    .mockImplementation(async (path, name) => ({
      path,
      name,
      pinned: false,
      lastOpenedAt: 2,
    }));
  vi.mocked(agentApi.updateSession)
    .mockReset()
    .mockImplementation(async (id, patch) => {
      const model =
        patch.modelId &&
        catalog.models.find((item) => item.id === patch.modelId);
      snapshot.session = {
        ...snapshot.session,
        id,
        ...(model && {
          model: { providerId: model.providerId, modelId: model.modelId },
          reasoningEffort: model.reasoningEfforts?.includes(
            snapshot.session.reasoningEffort || "",
          )
            ? snapshot.session.reasoningEffort
            : null,
        }),
        ...(patch.mode && { mode: patch.mode }),
        ...(patch.permissionMode && { permissionMode: patch.permissionMode }),
        ...(patch.reasoningEffort !== undefined && {
          reasoningEffort: patch.reasoningEffort || null,
        }),
        ...(patch.contextLimit !== undefined && {
          contextLimit: patch.contextLimit,
        }),
      };
      return structuredClone(snapshot.session);
    });
  vi.mocked(agentApi.renameSession)
    .mockReset()
    .mockImplementation(async (_id, title) => ({ ...session, title }));
  vi.mocked(agentApi.setSessionMetadata)
    .mockReset()
    .mockImplementation(async (_id, patch) => ({ ...session, ...patch }));
  vi.mocked(agentApi.deleteSession).mockReset().mockResolvedValue();
  vi.mocked(agentApi.getExtensions).mockReset().mockResolvedValue({
    revision: 1,
    skills: [],
    plugins: [],
    mcpServers: [],
  });
  vi.mocked(agentApi.getSession)
    .mockReset()
    .mockImplementation(async () => structuredClone(snapshot));
  vi.mocked(agentApi.openProject)
    .mockReset()
    .mockResolvedValue({
      workspace: { path: project, name: "project" },
      catalog: structuredClone(catalog),
      sessions: [structuredClone(session)],
    });
  vi.mocked(agentApi.createSession)
    .mockReset()
    .mockResolvedValue({
      ...structuredClone(session),
      id: "lc:new",
      title: "新会话",
    });
  vi.mocked(agentApi.openStandalone)
    .mockReset()
    .mockResolvedValue({
      workspace: {
        path: "D:/fixture/app/agent/standalone-workspace",
        name: "独立任务",
        standalone: true,
      },
      catalog: structuredClone(catalog),
      sessions: [],
    });
  vi.mocked(agentApi.sendMessage).mockReset().mockResolvedValue();
  vi.mocked(agentApi.queryCommand)
    .mockReset()
    .mockResolvedValue({ status: "unknown" });
  vi.mocked(agentApi.interruptSession).mockReset().mockResolvedValue();
  vi.mocked(agentApi.replyPermission).mockReset().mockResolvedValue();
  vi.mocked(agentApi.replyQuestion).mockReset().mockResolvedValue();
  vi.mocked(agentApi.rejectQuestion).mockReset().mockResolvedValue();
  vi.mocked(agentApi.closeProject).mockReset().mockResolvedValue();
  vi.mocked(settingsApi.pickDirectory).mockReset().mockResolvedValue(project);
  vi.mocked(settingsApi.openExternal).mockReset().mockResolvedValue();
});
afterEach(async () => {
  cleanup();
  // Unmount first so a failed assertion cannot leave a shared Stop lane busy
  // or allow its deferred acknowledgement to update the next test's session.
  await act(async () => {
    for (const finish of pendingStopCleanups) finish();
    pendingStopCleanups.clear();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
  vi.useRealTimers();
});

describe("AgentPage", () => {
  it("returns focus to the composer after using a skill and releasing the panel", async () => {
    vi.mocked(agentApi.getExtensions).mockResolvedValue({
      revision: 1,
      skills: [
        {
          id: "pdf",
          name: "PDF",
          description: "读取和制作 PDF",
          source: "bundled",
          installed: true,
          enabled: true,
          requirements: [],
        },
      ],
      plugins: [],
      mcpServers: [],
    });
    render(
      <div id="content-area">
        <div className="tai-page">
          <AgentPage toolRequest={{ tool: "skills", id: 1 }} />
        </div>
      </div>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "在会话中使用" }));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "请使用 PDF 技能完成这个任务。\n",
    );
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveFocus();
  });

  it("switches independent tool panels and returns to the same session and draft", async () => {
    const changed = vi.fn();
    const consumed = vi.fn();
    const page = (
      tool: "skills" | "workflows" | "memory" | null,
      id: number,
    ) => (
      <div id="content-area">
        <div className="tai-page">
          <AgentPage
            toolRequest={{ tool, id }}
            onToolRequestConsumed={consumed}
            onActiveToolChange={changed}
          />
        </div>
      </div>
    );
    const view = render(page(null, 0));
    await flush();
    fill("切换面板时保留这个草稿");
    const initialCalls = vi.mocked(agentApi.getSession).mock.calls.length;

    for (const [index, tool, title] of [
      [1, "skills", "技能与插件"],
      [2, "workflows", "工作流与自动化"],
      [3, "memory", "记忆"],
    ] as const) {
      view.rerender(page(tool, index));
      await flush();
      expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
      expect(
        screen
          .getAllByRole("region")
          .filter((node) => node.classList.contains("tai-editor-panel")),
      ).toHaveLength(1);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.querySelector<HTMLElement>(".tai-page")?.inert).toBe(
        true,
      );
      expect(changed).toHaveBeenLastCalledWith(tool);
    }

    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    await flush();
    expect(
      screen.queryByRole("region", { name: "记忆" }),
    ).not.toBeInTheDocument();
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(document.querySelector<HTMLElement>(".tai-page")?.inert).not.toBe(
      true,
    );
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "切换面板时保留这个草稿",
    );
    expect(agentApi.getSession).toHaveBeenCalledTimes(initialCalls);

    view.rerender(page("skills", 4));
    await flush();
    view.rerender(page(null, 5));
    await flush();
    expect(
      screen.queryByRole("region", { name: "技能与插件" }),
    ).not.toBeInTheDocument();
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  it("renames the active project without reopening it or changing its session binding", async () => {
    render(<AgentPage />);
    await flush();
    fill("保留中的消息草稿");
    fireEvent.keyDown(
      screen.getByRole("button", { name: "管理项目：project" }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名项目" }));
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), {
      target: { value: "  我的新项目  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await flush();

    expect(agentApi.renameProject).toHaveBeenCalledWith(project, "我的新项目");
    expect(
      screen.getByRole("button", { name: "管理项目：我的新项目" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "我的新项目 的任务" }),
    ).toHaveTextContent(session.title);
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留中的消息草稿",
    );
    expect(agentApi.openProject).not.toHaveBeenCalled();
    expect(agentApi.createSession).not.toHaveBeenCalled();
    expect(agentApi.updateSession).not.toHaveBeenCalled();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("presents queued question requests one at a time", async () => {
    snapshot.status = "waiting_question";
    snapshot.questions = [
      {
        id: "first-question",
        sessionId: "s1",
        title: "选择开发范围",
        fields: [
          {
            key: "scope",
            type: "string",
            title: "范围",
            required: true,
            options: [{ value: "small", label: "先做核心功能" }],
          },
        ],
      },
      {
        id: "second-question",
        sessionId: "s1",
        title: "选择验证方式",
        fields: [
          { key: "check", type: "string", title: "验证", required: true },
        ],
      },
    ];
    vi.mocked(agentApi.replyQuestion).mockImplementation(async () => {
      snapshot.questions = snapshot.questions.slice(1);
    });
    render(<AgentPage />);
    await flush();
    expect(screen.getByRole("form", { name: "选择开发范围" })).toBeVisible();
    expect(
      screen.queryByRole("form", { name: "选择验证方式" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "先做核心功能" }));
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(agentApi.replyQuestion).toHaveBeenCalledWith(
      "s1",
      "first-question",
      { scope: "small" },
    );
    expect(screen.getByRole("form", { name: "选择验证方式" })).toBeVisible();
    expect(
      screen.queryByRole("form", { name: "选择开发范围" }),
    ).not.toBeInTheDocument();
  });

  it("creates an independent task without choosing or requiring a project", async () => {
    const path = "D:/fixture/app/agent/standalone-workspace";
    vi.mocked(agentApi.getStatus).mockResolvedValue({
      available: true,
      running: false,
    });
    vi.mocked(agentApi.createSession).mockResolvedValue({
      ...session,
      id: "lc:standalone",
      projectPath: path,
      title: "新独立任务",
    });
    render(<AgentPage />);
    await flush();
    expect(screen.getByRole("button", { name: "新建任务" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await flush();
    expect(agentApi.openStandalone).toHaveBeenCalledOnce();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.defaultModel,
      "build",
      undefined,
      "ask",
      undefined,
      path,
    );
    expect(settingsApi.pickDirectory).not.toHaveBeenCalled();
    expect(agentApi.openProject).not.toHaveBeenCalled();
    expect(
      screen.getByRole("group", { name: "独立任务 的任务" }),
    ).toBeInTheDocument();
    expect(
      localStorage.getItem("lolicode.agent.recent-projects") || "",
    ).not.toContain("standalone-workspace");
  });
  it("opens a folder from the new task menu", async () => {
    render(<AgentPage />);
    await flush();
    fireEvent.keyDown(
      screen.getByRole("button", { name: "选择新建任务类型" }),
      { key: "Enter" },
    );
    await flush();
    fireEvent.click(screen.getByRole("menuitem", { name: "打开文件夹" }));
    await flush();
    expect(settingsApi.pickDirectory).toHaveBeenCalled();
  });
  it("opens the independent task action from a project without discarding its draft", async () => {
    render(<AgentPage />);
    await flush();
    fill("保留项目草稿");
    fireEvent.keyDown(
      screen.getByRole("button", { name: "选择新建任务类型" }),
      { key: "Enter" },
    );
    await flush();
    fireEvent.click(screen.getByRole("menuitem", { name: /新建独立任务/ }));
    await flush();
    expect(agentApi.openStandalone).toHaveBeenCalledOnce();
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "project" }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留项目草稿",
    );
  });
  it("keeps the independent task starter usable when no model is configured", async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({
      available: true,
      running: false,
    });
    vi.mocked(agentApi.openStandalone).mockResolvedValue({
      workspace: {
        path: "D:/fixture/standalone",
        name: "独立任务",
        standalone: true,
      },
      catalog: { ...catalog, models: [], defaultModel: null },
      sessions: [],
    });
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "新建独立任务" }));
    await flush();
    expect(agentApi.createSession).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "开始新任务" }),
    ).toBeInTheDocument();
  });
  it("preserves a composing session search and restores focus after clearing", async () => {
    render(<AgentPage />);
    await flush();
    const search = screen.getByLabelText("搜索会话");
    fireEvent.change(search, { target: { value: "修复" } });
    fireEvent.keyDown(search, { key: "Escape", isComposing: true });
    expect(search).toHaveValue("修复");
    fireEvent.keyDown(search, { key: "Escape", keyCode: 229 });
    expect(search).toHaveValue("修复");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");

    fireEvent.change(search, { target: { value: "修复" } });
    const clear = screen.getByRole("button", { name: "清空会话搜索" });
    clear.focus();
    fireEvent.click(clear);
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
  });

  it.each([true, false])(
    "returns to the latest message with reduced motion set to %s",
    async (reducedMotion) => {
      const matchMedia = vi.fn().mockReturnValue({ matches: reducedMotion });
      vi.stubGlobal("matchMedia", matchMedia);
      try {
        const view = render(<AgentPage />);
        await flush();
        const chat = view.container.querySelector<HTMLDivElement>(".wb-chat")!;
        const scrollTo = vi.fn();
        chat.scrollTo = scrollTo;
        Object.defineProperties(chat, {
          scrollHeight: { configurable: true, value: 1600 },
          clientHeight: { configurable: true, value: 400 },
        });
        chat.scrollTop = 0;
        fireEvent.scroll(chat);
        fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
        expect(matchMedia).toHaveBeenCalledWith(
          "(prefers-reduced-motion: reduce)",
        );
        expect(scrollTo).toHaveBeenCalledWith({
          top: 1600,
          behavior: reducedMotion ? "instant" : "smooth",
        });
        expect(
          screen.queryByRole("button", { name: "回到最新" }),
        ).not.toBeInTheDocument();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("adds a task starter to the current draft without submitting or discarding existing text", async () => {
    render(<AgentPage />);
    await flush();
    fill("保留这段需求");
    fireEvent.click(screen.getByRole("button", { name: /读懂项目/ }));
    const input = screen.getByLabelText("发送给 Agent 的消息");
    expect(input).toHaveValue(
      "保留这段需求\n\n帮我梳理这个项目的结构，介绍核心模块和主要运行流程。",
    );
    expect(input).toHaveFocus();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(
      sessionStorage.getItem(
        `lolicode.agent.draft:${encodeURIComponent(project)}:${session.id}`,
      ),
    ).toContain("保留这段需求");
  });

  it("interrupts once, waits for actual tool settlement, and sends only the captured draft while preserving newer edits", async () => {
    snapshot.status = "running";
    snapshot.messages = [
      {
        id: "old-user",
        role: "user",
        createdAt: 3,
        parts: [{ type: "text", text: "旧任务" }],
      },
      {
        id: "old-assistant",
        role: "assistant",
        createdAt: 4,
        parts: [
          { type: "text", text: "原任务的部分结果" },
          {
            type: "tool",
            id: "old-tool",
            name: "shell",
            state: "running",
            input: { command: "owned fixture" },
          },
        ],
      },
    ];
    render(<AgentPage />);
    await flush();
    const input = screen.getByLabelText("发送给 Agent 的消息");
    expect(input).toHaveAttribute("rows", "1");
    fill("现在改为检查文件");
    fireEvent.click(screen.getByRole("button", { name: "打断并发送" }));
    fireEvent.submit(input.closest("form")!);
    await flush();
    expect(agentApi.interruptSession).toHaveBeenCalledOnce();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(input).toBeEnabled();
    fill("等待时新写的下一条草稿");
    snapshot.status = "idle";
    await tick(250);
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    snapshot.messages[1].completedAt = 5;
    snapshot.messages[1].parts[1] = {
      type: "tool",
      id: "old-tool",
      name: "shell",
      state: "error",
      input: { command: "owned fixture" },
      error: "任务已停止",
    };
    await tick(250);
    expect(agentApi.sendMessage).toHaveBeenCalledOnce();
    expect(agentApi.sendMessage).toHaveBeenCalledWith(
      session.id,
      "现在改为检查文件",
      expect.any(String),
      [],
      [],
    );
    expect(vi.mocked(agentApi.sendMessage).mock.calls[0][2]).not.toBe(
      "old-user",
    );
    expect(input).toHaveValue("等待时新写的下一条草稿");
    expect(screen.getByText("原任务的部分结果")).toBeInTheDocument();
  });

  it("keeps the replacement draft and original results when Stop fails, then allows an explicit retry", async () => {
    snapshot.status = "running";
    snapshot.messages = [
      {
        id: "partial",
        role: "assistant",
        createdAt: 3,
        parts: [{ type: "text", text: "已完成的旧步骤" }],
      },
    ];
    vi.mocked(agentApi.interruptSession).mockRejectedValueOnce(
      new Error("无法确认停止"),
    );
    render(<AgentPage />);
    await flush();
    fill("改做新的任务");
    fireEvent.click(screen.getByRole("button", { name: "打断并发送" }));
    await flush();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByText("无法确认停止")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "改做新的任务",
    );
    expect(screen.getByText("已完成的旧步骤")).toBeInTheDocument();
    vi.mocked(agentApi.interruptSession).mockImplementation(async () => {
      snapshot.status = "idle";
    });
    fireEvent.click(screen.getByRole("button", { name: "打断并发送" }));
    await flush();
    expect(agentApi.interruptSession).toHaveBeenCalledTimes(2);
    expect(agentApi.sendMessage).toHaveBeenCalledOnce();
  });

  it("never sends a replacement after cancellation times out or an unknown input is admitted later", async () => {
    snapshot.session.id = "lc:unknown-replacement";
    snapshot.status = "running";
    vi.mocked(agentApi.listSessions).mockResolvedValue([snapshot.session]);
    const key = `lolicode.agent.draft:${encodeURIComponent(project)}:${encodeURIComponent(snapshot.session.id)}`;
    saveAgentSubmission({
      version: 1,
      projectPath: project,
      sessionId: snapshot.session.id,
      requestId: "unconfirmed-original",
      text: "原输入",
      draft: captureAgentDraft(key, "原输入"),
      assistantIds: [],
      phase: "uncertain",
      observed: false,
      stopRequested: false,
    });
    render(<AgentPage />);
    await flush();
    fill("保留这个新草稿");
    fireEvent.click(screen.getByRole("button", { name: "打断并发送" }));
    await flush();
    await tick(30_000);
    expect(screen.getByText(/停止确认超时/)).toBeInTheDocument();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(readAgentSubmission(project, snapshot.session.id)?.requestId).toBe(
      "unconfirmed-original",
    );
    snapshot.status = "idle";
    snapshot.messages = [
      {
        id: "unconfirmed-original",
        role: "user",
        createdAt: 3,
        parts: [{ type: "text", text: "原输入" }],
      },
    ];
    vi.mocked(agentApi.queryCommand).mockResolvedValue({ status: "accepted" });
    await tick(6000);
    expect(agentApi.interruptSession).toHaveBeenCalledTimes(2);
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留这个新草稿",
    );
  });

  it("abandons a replacement when switching away and back before a late Stop ACK", async () => {
    const second = { ...session, id: "second", title: "另一段任务" };
    snapshot.status = "running";
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === session.id
        ? structuredClone(snapshot)
        : { ...emptySnapshot(), session: second },
    );
    let finishStop!: () => void;
    vi.mocked(agentApi.interruptSession).mockReturnValueOnce(
      new Promise((resolve) => {
        finishStop = resolve;
        pendingStopCleanups.add(resolve);
      }),
    );
    render(<AgentPage />);
    await flush();
    fill("原会话未发送的草稿");
    fireEvent.click(screen.getByRole("button", { name: "打断并发送" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^另一段任务/ }));
    await flush();
    fill("另一会话草稿");
    fireEvent.click(screen.getByRole("button", { name: /^修复测试/ }));
    await flush();
    await tick(100);
    await act(async () => finishStop());
    snapshot.status = "idle";
    await tick(1500);
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "原会话未发送的草稿",
    );
    fireEvent.click(screen.getByRole("button", { name: /^另一段任务/ }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "另一会话草稿",
    );
  });

  it("abandons a replacement when the project changes during cancellation", async () => {
    snapshot.status = "running";
    const otherProject = "D:/fixture/other";
    const otherSession = {
      ...session,
      id: "other-project-session",
      projectPath: otherProject,
      title: "其他项目任务",
    };
    vi.mocked(agentApi.openProject).mockResolvedValue({
      workspace: { path: otherProject, name: "other" },
      catalog,
      sessions: [otherSession],
    });
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === session.id
        ? structuredClone(snapshot)
        : { ...emptySnapshot(), session: otherSession },
    );
    let finishStop!: () => void;
    vi.mocked(agentApi.interruptSession).mockReturnValueOnce(
      new Promise((resolve) => {
        finishStop = resolve;
        pendingStopCleanups.add(resolve);
      }),
    );
    render(<AgentPage />);
    await flush();
    fill("原项目草稿");
    fireEvent.click(screen.getByRole("button", { name: "打断并发送" }));
    await flush();
    await expectFolderEnabled();
    await openFolder();
    await flush();
    fill("新项目草稿");
    await tick(100);
    await act(async () => finishStop());
    await tick(1000);
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "新项目草稿",
    );
    expect(
      sessionStorage.getItem(
        `lolicode.agent.draft:${encodeURIComponent(project)}:${encodeURIComponent(session.id)}`,
      ),
    ).toBe("原项目草稿");
  });

  it("converts an idle historical plan session only after a user send and waits for acknowledgement", async () => {
    snapshot.session.mode = "plan";
    let acknowledge!: (value: AgentSession) => void;
    vi.mocked(agentApi.updateSession).mockReturnValueOnce(
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    );
    render(<AgentPage />);
    await flush();
    expect(agentApi.updateSession).not.toHaveBeenCalled();
    fill("继续实现");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.updateSession).toHaveBeenCalledWith(session.id, {
      mode: "build",
    });
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(readAgentSubmission(project, session.id)).toBeNull();
    await act(async () => acknowledge({ ...session, mode: "build" }));
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledOnce();
  });

  it("preserves the draft and does not dispatch when converting an old plan session fails", async () => {
    snapshot.session.mode = "plan";
    vi.mocked(agentApi.updateSession).mockRejectedValueOnce(
      new Error("配置保存失败"),
    );
    render(<AgentPage />);
    await flush();
    fill("保留实现草稿");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留实现草稿",
    );
    expect(screen.getByText("配置保存失败")).toBeInTheDocument();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(readAgentSubmission(project, session.id)).toBeNull();
  });
  it.each(["open", "refresh"])(
    "shows nonblocking history warnings during project %s and still creates an in-process session",
    async (action) => {
      const warnings = [
        "旧版历史暂时无法读取，原数据保留。",
        "部分旧记录格式不受支持。",
      ];
      vi.mocked(agentApi.openProject).mockResolvedValue({
        workspace: { path: project, name: "project" },
        catalog: structuredClone(catalog),
        sessions: [],
        warnings,
      });
      render(<AgentPage />);
      await flush();
      if (action === "open") await openFolder();
      else fireEvent.click(modelRefreshButton());
      await flush();
      for (const warning of warnings)
        expect(toast.warning).toHaveBeenCalledWith(warning);
      expect(
        screen.getByRole("heading", { name: /^开始新(?:的)?任务$/ }),
      ).toBeInTheDocument();
      expect(sessionCreationButton()).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      snapshot.session = { ...session, id: "lc:new" };
      fireEvent.click(sessionCreationButton());
      await flush();
      expect(agentApi.createSession).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("heading", { name: "修复测试" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("发送给 Agent 的消息")).toBeEnabled();
    },
  );

  it.each(["ses_legacy", "zc:legacy"])(
    "keeps %s history read-only while new in-process sessions remain usable",
    async (id) => {
      const legacy = { ...session, id };
      snapshot.session = legacy;
      snapshot.messages = [
        {
          id: "old-answer",
          role: "assistant",
          createdAt: 2,
          parts: [{ type: "text", text: "原版历史内容仍可查看" }],
        },
      ];
      vi.mocked(agentApi.listSessions).mockResolvedValue([legacy]);
      render(<AgentPage />);
      await flush();

      expect(screen.getByText("原版历史内容仍可查看")).toBeInTheDocument();
      expect(
        screen.getByText("旧版会话只读，原数据保留，请新建本体会话继续"),
      ).toBeInTheDocument();
      const input = screen.getByLabelText("发送给 Agent 的消息");
      expect(input).toBeDisabled();
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
      expect(screen.getByLabelText("模型", { exact: true })).toBeDisabled();
      expect(screen.getByLabelText("执行权限")).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "分析" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "实现" }),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText(`管理会话：${legacy.title}`)).toBeDisabled();
      fireEvent.click(screen.getByLabelText("模型", { exact: true }));
      fireEvent.change(screen.getByLabelText("执行权限"), {
        target: { value: "auto" },
      });
      fireEvent.submit(input.closest("form")!);
      await flush();
      expect(agentApi.sendMessage).not.toHaveBeenCalled();
      expect(agentApi.updateSession).not.toHaveBeenCalled();

      await expectFolderEnabled();
      snapshot = { ...emptySnapshot(), session: { ...session, id: "lc:new" } };
      fireEvent.click(sessionCreationButton());
      await flush();
      expect(agentApi.createSession).toHaveBeenCalledTimes(1);
      await tick();
      expect(screen.getByLabelText("发送给 Agent 的消息")).toBeEnabled();
      expect(screen.queryByText(/旧版会话只读/)).not.toBeInTheDocument();
      fill("本体新会话继续任务");
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await flush();
      expect(agentApi.sendMessage).toHaveBeenCalledWith(
        "lc:new",
        "本体新会话继续任务",
        expect.any(String),
        [],
        [],
      );
    },
  );

  it("reconciles a retired session receipt without replaying its saved stop intent", async () => {
    const id = "zc:retired-receipt";
    snapshot.session = { ...session, id };
    vi.mocked(agentApi.listSessions).mockResolvedValue([snapshot.session]);
    vi.mocked(agentApi.queryCommand).mockResolvedValue({
      status: "rejected",
      message: "旧版会话只读",
    });
    saveAgentSubmission({
      version: 1,
      projectPath: project,
      sessionId: id,
      requestId: "msg_retired",
      text: "旧输入",
      draft: captureAgentDraft("fixture-old-draft", "旧输入"),
      assistantIds: [],
      phase: "accepted",
      observed: true,
      stopRequested: true,
    });
    render(<AgentPage />);
    await flush();
    expect(agentApi.queryCommand).toHaveBeenCalledWith(id, "msg_retired");
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(readAgentSubmission(project, id)).toBeNull();
    expect(sessionCreationButton()).toBeEnabled();
  });

  it("keeps an unknown native command receipt and retries its exact identity instead of creating a new task", async () => {
    const nativeSession = { ...session, id: "lc:owned-command" };
    snapshot.session = nativeSession;
    vi.mocked(agentApi.listSessions).mockResolvedValue([nativeSession]);
    vi.mocked(agentApi.sendMessage).mockRejectedValueOnce(
      new Error("response lost"),
    );
    render(<AgentPage />);
    await flush();
    fill("恢复原输入");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    const requestId = vi.mocked(agentApi.sendMessage).mock.calls[0][2];
    await tick();
    expect(agentApi.queryCommand).toHaveBeenCalledWith(
      nativeSession.id,
      requestId,
    );
    expect(screen.getByLabelText("模型", { exact: true })).toBeDisabled();
    expect(screen.getByLabelText("执行权限")).toBeDisabled();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "恢复原输入",
    );
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.sendMessage).toHaveBeenLastCalledWith(
      nativeSession.id,
      "恢复原输入",
      requestId,
      [],
      [],
    );
  });

  it("releases a definitively rejected native input while keeping a newer draft", async () => {
    const nativeSession = { ...session, id: "lc:rejected-command" };
    snapshot.session = nativeSession;
    vi.mocked(agentApi.listSessions).mockResolvedValue([nativeSession]);
    vi.mocked(agentApi.sendMessage).mockRejectedValueOnce(
      new Error("response lost"),
    );
    vi.mocked(agentApi.queryCommand).mockResolvedValue({
      status: "rejected",
      message: "原生引擎拒绝此输入",
    });
    render(<AgentPage />);
    await flush();
    fill("被拒绝的输入");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    fill("之后新写的草稿");
    await tick();
    expect(screen.getByText("原生引擎拒绝此输入")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "之后新写的草稿",
    );
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(agentApi.sendMessage).mock.calls;
    expect(calls[1][2]).not.toBe(calls[0][2]);
  });
  it("reloads a changed catalog on return without losing the conversation or its draft", async () => {
    vi.mocked(agentApi.getCatalogRevision).mockResolvedValue(4);
    vi.mocked(agentApi.openProject).mockResolvedValue({
      workspace: { path: project, name: "project" },
      catalog: {
        ...catalog,
        revision: 4,
        models: [
          ...catalog.models,
          {
            ...catalog.models[1],
            id: "lolicode/new/new",
            modelId: "new/new",
            name: "Added Model",
          },
        ],
      },
      sessions: [session],
    });
    render(<AgentPage />);
    await flush();
    fill("热刷新保留的草稿");
    await tick(1);
    expect(agentApi.openProject).toHaveBeenCalledWith(project, true);
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "搜索模型或渠道" }),
      {
        target: { value: "Added Model" },
      },
    );
    expect(
      screen.getByRole("button", { name: / · Added Model$/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "热刷新保留的草稿",
    );
    expect(agentApi.updateSession).not.toHaveBeenCalled();
  });

  it("keeps a busy catalog lease then applies channel updates when the task really settles", async () => {
    snapshot.status = "running";
    vi.mocked(agentApi.openProject).mockResolvedValue({
      workspace: { path: project, name: "project" },
      catalog: { ...catalog, revision: 4 },
      sessions: [session],
    });
    render(<AgentPage />);
    await flush();
    await act(async () =>
      emitTauriEvent("channel-center-updated", { revision: 4 }),
    );
    await tick(1000);
    expect(agentApi.openProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(
      screen.getByText(/渠道已更新，任务结束后将自动刷新/),
    ).toBeInTheDocument();
    snapshot.status = "idle";
    await tick(1000);
    await tick(1);
    expect(agentApi.openProject).toHaveBeenCalledTimes(1);
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });

  it("does not turn a failed Stop and an old idle snapshot into proof an uncertain input was cancelled", async () => {
    vi.mocked(agentApi.sendMessage).mockRejectedValueOnce(
      new Error("response lost"),
    );
    vi.mocked(agentApi.interruptSession).mockRejectedValueOnce(
      new Error("stop response lost"),
    );
    render(<AgentPage />);
    await flush();
    fill("可能晚到的输入");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await flush();
    await tick();
    const ledger = Object.keys(localStorage).find((key) =>
      key.startsWith("lolicode.agent.input:"),
    );
    expect(ledger).toBeTruthy();
    fill("另一条任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
  });
  it("keeps the current model and draft when the actual model switch is rejected", async () => {
    vi.mocked(agentApi.updateSession).mockRejectedValue(
      new Error("模型切换失败，请重试。"),
    );
    render(<AgentPage />);
    await flush();
    fill("保留模型切换前的草稿");
    selectModel("Model B");
    await flush();
    expect(screen.getByLabelText("模型", { exact: true })).toHaveAttribute(
      "title",
      "DeepSeek · Code Model",
    );
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留模型切换前的草稿",
    );
    expect(screen.getByText("模型切换失败，请重试。")).toBeInTheDocument();
  });

  it("does not let an old snapshot undo an acknowledged model change", async () => {
    vi.mocked(agentApi.updateSession).mockResolvedValue({
      ...session,
      model: {
        providerId: catalog.models[1].providerId,
        modelId: catalog.models[1].modelId,
      },
    });
    render(<AgentPage />);
    await flush();
    selectModel("Model B");
    await flush();
    await tick(5000);
    expect(screen.getByLabelText("模型", { exact: true })).toHaveAttribute(
      "title",
      "Copilot · Model B",
    );
    snapshot.session.model = {
      providerId: catalog.models[1].providerId,
      modelId: catalog.models[1].modelId,
    };
    await tick(5000);
    expect(screen.getAllByText("Copilot · Model B")[0]).toBeInTheDocument();
  });

  it("changes Auto Mode without exposing obsolete analysis/build mode controls", async () => {
    render(<AgentPage />);
    await flush();
    fireEvent.change(screen.getByLabelText("执行权限"), {
      target: { value: "auto" },
    });
    await flush();
    expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
      permissionMode: "auto",
    });
    expect(screen.getByLabelText("执行权限")).toHaveAttribute(
      "title",
      expect.stringContaining("常规编辑和安全命令自动允许"),
    );
    expect(
      screen.queryByText(/常规编辑与已识别的安全命令自动允许/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "分析" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("执行权限")).toHaveValue("auto");
    expect(screen.queryByText(/分析模式只读取文件/)).not.toBeInTheDocument();
  });

  it("saves a declared reasoning effort during a running task without sending another prompt", async () => {
    snapshot.status = "running";
    const models = structuredClone(catalog);
    models.models[0].reasoningEfforts = ["low", "high"];
    vi.mocked(agentApi.getCatalog).mockResolvedValue(models);
    render(<AgentPage />);
    await flush();
    fill("保留待发送的要求");
    fireEvent.click(screen.getByRole("button", { name: "思考档位" }));
    fireEvent.click(screen.getByRole("button", { name: "思考档位 high" }));
    await flush();
    expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
      reasoningEffort: "high",
    });
    expect(screen.getByRole("button", { name: "思考档位" })).toHaveTextContent(
      "high",
    );
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留待发送的要求",
    );
    expect(screen.getByRole("button", { name: "打断并发送" })).toBeEnabled();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("saves a session window during a running task while preserving the draft", async () => {
    snapshot.status = "running";
    const models = structuredClone(catalog);
    models.models[0].contextLimit = 128000;
    models.models[0].contextLimits = [128000, 1000000];
    vi.mocked(agentApi.getCatalog).mockResolvedValue(models);
    vi.mocked(agentApi.updateSession).mockResolvedValue({
      ...session,
      contextLimit: 1000000,
    });
    render(<AgentPage />);
    await flush();
    fill("保留窗口切换期间的草稿");
    fireEvent.click(screen.getByRole("button", { name: "上下文窗口" }));
    fireEvent.click(
      screen.getByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    );
    await flush();
    expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
      contextLimit: 1000000,
    });
    expect(
      screen.getByTitle("当前上下文：1,000,000 tokens"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留窗口切换期间的草稿",
    );
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps an acknowledged context through stale snapshots and can restore the channel default", async () => {
    const models = structuredClone(catalog);
    models.models[0].contextLimit = 128000;
    models.models[0].contextLimits = [128000, 1000000];
    vi.mocked(agentApi.getCatalog).mockResolvedValue(models);
    vi.mocked(agentApi.updateSession).mockResolvedValueOnce({
      ...session,
      contextLimit: 1000000,
    });
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "上下文窗口" }));
    fireEvent.click(
      screen.getByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    );
    await flush();
    await tick(5000);
    expect(
      screen.getByRole("button", { name: "上下文窗口" }),
    ).toHaveTextContent("1M");
    fireEvent.click(screen.getByRole("button", { name: "上下文窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "使用默认上下文" }));
    await flush();
    expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
      contextLimit: null,
    });
    expect(
      screen.getByRole("button", { name: "上下文窗口" }),
    ).toHaveTextContent("128K");
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the saved context and draft when a context update fails", async () => {
    snapshot.session.contextLimit = 128000;
    const models = structuredClone(catalog);
    models.models[0].contextLimit = 128000;
    models.models[0].contextLimits = [128000, 1000000];
    vi.mocked(agentApi.getCatalog).mockResolvedValue(models);
    vi.mocked(agentApi.updateSession).mockRejectedValue(
      new Error("上下文保存失败"),
    );
    render(<AgentPage />);
    await flush();
    fill("保留上下文切换前的输入");
    fireEvent.click(screen.getByRole("button", { name: "上下文窗口" }));
    fireEvent.click(
      screen.getByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    );
    await flush();
    expect(
      screen.getByRole("button", { name: "上下文窗口" }),
    ).toHaveTextContent("128K");
    expect(screen.getByText("上下文保存失败")).toBeVisible();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留上下文切换前的输入",
    );
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps context overrides and drafts with their own conversations", async () => {
    const models = structuredClone(catalog);
    models.models[0].contextLimit = 128000;
    models.models[0].contextLimits = [128000, 1000000];
    const second = {
      ...session,
      id: "s2",
      title: "第二个上下文会话",
      contextLimit: 128000,
    };
    vi.mocked(agentApi.getCatalog).mockResolvedValue(models);
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === second.id
        ? { ...emptySnapshot(), session: second }
        : structuredClone(snapshot),
    );
    render(<AgentPage />);
    await flush();
    fill("第一个会话草稿");
    fireEvent.click(screen.getByRole("button", { name: "上下文窗口" }));
    fireEvent.click(
      screen.getByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^第二个上下文会话/ }));
    await flush();
    expect(
      screen.getByRole("button", { name: "上下文窗口" }),
    ).toHaveTextContent("128K");
    fill("第二个会话草稿");
    fireEvent.click(screen.getByRole("button", { name: /^修复测试/ }));
    await flush();
    expect(
      screen.getByRole("button", { name: "上下文窗口" }),
    ).toHaveTextContent("1M");
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "第一个会话草稿",
    );
    expect(agentApi.updateSession).toHaveBeenCalledTimes(1);
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the saved effort when an explicit manual override fails", async () => {
    vi.mocked(agentApi.updateSession).mockRejectedValue(
      new Error("中转不接受此思考档位"),
    );
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "思考档位" }));
    fireEvent.change(screen.getByLabelText("手动档位标识（未验证）"), {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用手动档位" }));
    await flush();
    expect(agentApi.updateSession).toHaveBeenCalledWith(session.id, {
      reasoningEffort: "high",
    });
    expect(screen.getByRole("button", { name: "思考档位" })).toHaveTextContent(
      "上游默认",
    );
    expect(screen.getByText("中转不接受此思考档位")).toBeInTheDocument();
  });

  it("passes an explicit reasoning override when creating a new conversation", async () => {
    vi.mocked(agentApi.listSessions).mockResolvedValue([]);
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "思考档位" }));
    fireEvent.change(screen.getByLabelText("手动档位标识（未验证）"), {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用手动档位" }));
    fireEvent.click(sessionCreationButton());
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.models[0].id,
      "build",
      undefined,
      "ask",
      "high",
    );
  });

  it("passes the chosen window when creating a new conversation", async () => {
    const models = structuredClone(catalog);
    models.models[0].contextLimit = 128000;
    models.models[0].contextLimits = [128000, 1000000];
    vi.mocked(agentApi.getCatalog).mockResolvedValue(models);
    vi.mocked(agentApi.listSessions).mockResolvedValue([]);
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "上下文窗口" }));
    fireEvent.click(
      screen.getByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    );
    fireEvent.keyDown(document.activeElement || document.body, {
      key: "Escape",
    });
    fireEvent.click(sessionCreationButton());
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.models[0].id,
      "build",
      undefined,
      "ask",
      undefined,
      undefined,
      1000000,
    );
  });

  it("clears a new conversation context choice when selecting a different model", async () => {
    const models = structuredClone(catalog);
    models.models[0].contextLimit = 128000;
    models.models[0].contextLimits = [128000, 1000000];
    models.models[1].contextLimit = 32000;
    vi.mocked(agentApi.getCatalog).mockResolvedValue(models);
    vi.mocked(agentApi.listSessions).mockResolvedValue([]);
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "上下文窗口" }));
    fireEvent.click(
      screen.getByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    );
    selectModel("Model B");
    await flush();
    expect(
      screen.getByRole("button", { name: "上下文窗口" }),
    ).toHaveTextContent("32K");
    fireEvent.click(sessionCreationButton());
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.models[1].id,
      "build",
      undefined,
      "ask",
      undefined,
    );
  });

  it("requires an explicit confirmation before enabling full access", async () => {
    render(<AgentPage />);
    await flush();
    fireEvent.change(screen.getByLabelText("执行权限"), {
      target: { value: "full_access" },
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(agentApi.updateSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "启用完整权限" }));
    await flush();
    expect(agentApi.updateSession).toHaveBeenCalledWith(session.id, {
      permissionMode: "full_access",
    });
  });

  it.each(["running", "waiting_permission", "waiting_question"] as const)(
    "changes model and permissions during %s while a replacement waits for cancellation",
    async (status) => {
      snapshot.status = status;
      render(<AgentPage />);
      await flush();
      fill("任务结束后再发送的草稿");
      expect(screen.getByLabelText("模型", { exact: true })).toBeEnabled();
      expect(screen.getByLabelText("执行权限")).toBeEnabled();
      selectModel("Model B");
      await flush();
      expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
        modelId: catalog.models[1].id,
      });
      expect(screen.getByLabelText("模型", { exact: true })).toHaveTextContent(
        "Model B",
      );
      fireEvent.change(screen.getByLabelText("执行权限"), {
        target: { value: "auto" },
      });
      await flush();
      expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
        permissionMode: "auto",
      });
      expect(
        screen.queryByRole("button", { name: "分析" }),
      ).not.toBeInTheDocument();
      const input = screen.getByLabelText("发送给 Agent 的消息");
      expect(input).toHaveValue("任务结束后再发送的草稿");
      expect(input).toBeEnabled();
      expect(screen.getByRole("button", { name: "打断并发送" })).toBeEnabled();
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.submit(input.closest("form")!);
      await flush();
      expect(agentApi.sendMessage).not.toHaveBeenCalled();
      expect(agentApi.interruptSession).toHaveBeenCalledOnce();
      expect(
        screen.queryByText(/模型与思考档位从下一次模型请求生效/),
      ).not.toBeInTheDocument();
      snapshot.status = "idle";
      await tick(250);
      expect(agentApi.sendMessage).toHaveBeenCalledOnce();
    },
  );

  it("keeps stop available while a running session model update is pending", async () => {
    snapshot.status = "running";
    let finish!: (value: AgentSession) => void;
    vi.mocked(agentApi.updateSession).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<AgentPage />);
    await flush();
    selectModel("Model B");
    await flush();
    expect(screen.getByLabelText("模型", { exact: true })).toBeDisabled();
    expect(screen.getByLabelText("执行权限")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await flush();
    expect(agentApi.interruptSession).toHaveBeenCalledOnce();
    await act(async () => finish({ ...session, model: catalog.models[1] }));
  });

  it("switches projects while a previous task continues and preserves its isolated draft", async () => {
    const otherPath = "D:/fixture/other-project";
    const otherSession = {
      ...session,
      id: "other_project",
      title: "另一项目",
      projectPath: otherPath,
    };
    snapshot.status = "running";
    vi.mocked(agentApi.listProjects).mockResolvedValue([
      { path: otherPath, name: "other-project", pinned: true, lastOpenedAt: 3 },
    ]);
    vi.mocked(agentApi.openProject).mockResolvedValue({
      workspace: { path: otherPath, name: "other-project" },
      catalog,
      sessions: [otherSession],
    });
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === session.id
        ? structuredClone(snapshot)
        : { ...emptySnapshot(), session: otherSession },
    );
    render(<AgentPage />);
    await flush();
    fill("原项目后续输入");
    fireEvent.click(screen.getByRole("button", { name: "other-project" }));
    await flush();
    expect(agentApi.openProject).toHaveBeenCalledWith(otherPath);
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("");
    expect(modelRefreshButton()).toBeDisabled();
    await tick(1500);
    expect(agentApi.getSession).toHaveBeenCalledWith(session.id);
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
    expect(
      sessionStorage.getItem(
        `lolicode.agent.draft:${encodeURIComponent(project)}:${encodeURIComponent(session.id)}`,
      ),
    ).toBe("原项目后续输入");
    snapshot.status = "idle";
    await tick(1500);
    expect(modelRefreshButton()).toBeEnabled();
  });

  it("expands a workspace to show its tasks and opens the selected task", async () => {
    const otherPath = "D:/fixture/other-project";
    const otherSession: AgentSession = {
      ...session,
      id: "other_project_task",
      title: "其他工作区的任务",
      projectPath: otherPath,
    };
    vi.mocked(agentApi.listProjects).mockResolvedValue([
      {
        path: otherPath,
        name: "other-project",
        pinned: false,
        lastOpenedAt: 3,
      },
    ]);
    vi.mocked(agentApi.listSessions).mockImplementation(async (path) =>
      path === otherPath ? [otherSession] : [session],
    );
    vi.mocked(agentApi.openProject).mockResolvedValue({
      workspace: { path: otherPath, name: "other-project" },
      catalog,
      sessions: [otherSession],
    });
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => {
      const next = emptySnapshot();
      next.session = id === otherSession.id ? otherSession : session;
      return next;
    });

    render(<AgentPage />);
    await flush();

    expect(screen.queryByText("最近的工作区")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "收起 project 的任务" }),
    );
    expect(
      screen.queryByRole("button", { name: /^修复测试/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "展开 project 的任务" }),
    );
    expect(
      screen.getByRole("button", { name: /^修复测试/ }),
    ).toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: /^其他工作区的任务/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "展开 other-project 的任务" }),
    );
    await flush();

    expect(agentApi.listSessions).toHaveBeenCalledWith(otherPath);
    expect(agentApi.openProject).not.toHaveBeenCalled();
    const task = screen.getByRole("button", { name: /^其他工作区的任务/ });
    fireEvent.click(task);
    await flush();

    expect(agentApi.openProject).toHaveBeenCalledWith(otherPath);
    expect(agentApi.getSession).toHaveBeenCalledWith(otherSession.id);
  });

  it("filters archived sessions from the real persisted list and can show them on demand", async () => {
    const archived = {
      ...session,
      id: "archived",
      title: "已归档任务",
      archived: true,
    };
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, archived]);
    render(<AgentPage />);
    await flush();
    expect(
      screen.queryByRole("button", { name: /^已归档任务/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示归档会话" }));
    await flush();
    expect(agentApi.listSessions).toHaveBeenLastCalledWith(project, true);
    expect(
      screen.getByRole("button", { name: /^已归档任务/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^修复测试/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps the actual archived conversation and its draft when refreshing the engine model catalog", async () => {
    const archived = {
      ...session,
      id: "archive_refresh",
      title: "归档后继续查看",
      archived: true,
    };
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, archived]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: id === archived.id ? archived : session,
    }));
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "显示归档会话" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^归档后继续查看/ }));
    await flush();
    fill("归档会话里的草稿");
    fireEvent.click(modelRefreshButton());
    await flush();
    expect(agentApi.openProject).toHaveBeenCalledWith(project, true);
    expect(agentApi.listSessions).toHaveBeenLastCalledWith(project, true);
    expect(
      screen.getByRole("heading", { name: "归档后继续查看" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "归档会话里的草稿",
    );
  });

  it("collapses the project sidebar with the keyboard without losing the chat draft or stopping the task", async () => {
    render(<AgentPage />);
    await flush();
    fill("保留输入");
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true, repeat: true });
    expect(
      screen.queryByRole("complementary", { name: "项目会话" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留输入",
    );
    fireEvent.click(screen.getByRole("button", { name: "展开项目侧栏" }));
    expect(
      screen.getByRole("complementary", { name: "项目会话" }),
    ).toBeInTheDocument();
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });
  it("rejoins the project and switches the current model through the actual engine before using it for a new session", async () => {
    render(<AgentPage />);
    await flush();
    expect(
      screen.getByRole("heading", { name: "修复测试" }),
    ).toBeInTheDocument();
    selectModel("Model B");
    await flush();
    expect(agentApi.updateSession).toHaveBeenCalledWith(session.id, {
      modelId: catalog.models[1].id,
    });
    expect(screen.getAllByText("Copilot · Model B")[0]).toBeInTheDocument();
    fireEvent.click(sessionCreationButton());
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.models[1].id,
      "build",
      undefined,
      "ask",
      undefined,
    );
    expect(agentApi.openProject).not.toHaveBeenCalled();
  });

  it("opens the native directory picker and restores recent projects without requiring a typed path", async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({
      available: true,
      running: false,
    });
    render(<AgentPage />);
    await flush();
    await openFolder();
    await flush();
    expect(settingsApi.pickDirectory).toHaveBeenCalledTimes(1);
    expect(agentApi.openProject).toHaveBeenCalledWith(project);
    expect(localStorage.getItem("lolicode.agent.recent-projects")).toContain(
      project,
    );
  });

  it("does not create or send when no supported model exists and opens the shared channel page", async () => {
    vi.mocked(agentApi.getCatalog).mockResolvedValue({
      ...catalog,
      models: [],
      defaultModel: null,
    });
    const channels = vi.fn();
    render(<AgentPage onOpenChannels={channels} />);
    await flush();
    expect(sessionCreationButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    fireEvent.click(
      screen.getByRole("button", { name: "管理和添加模型与渠道" }),
    );
    expect(channels).toHaveBeenCalledTimes(1);
    expect(agentApi.createSession).not.toHaveBeenCalled();
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });

  it("uses an already qualified model name once and explains actual excluded sources", async () => {
    vi.mocked(agentApi.getCatalog).mockResolvedValue({
      ...catalog,
      models: [{ ...catalog.models[0], name: "DeepSeek · Code Model" }],
      excludedSources: ["Claude 订阅仅可用于 Claude Code"],
    });
    render(<AgentPage />);
    await flush();
    expect(screen.getByRole("button", { name: "模型" })).toHaveTextContent(
      "DeepSeek · Code Model",
    );
    expect(screen.getByRole("button", { name: "模型" })).not.toHaveTextContent(
      "DeepSeek · DeepSeek · Code Model",
    );
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(
      screen.getByText("Claude 订阅仅可用于 Claude Code"),
    ).toBeInTheDocument();
  });

  it("refreshes the project's actual engine catalog and preserves the selected conversation and draft", async () => {
    const second = { ...session, id: "s2", title: "正在查看的会话" };
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: id === second.id ? second : session,
    }));
    const nextCatalog = {
      ...catalog,
      revision: 4,
      models: [
        ...catalog.models,
        {
          id: "lolicode/new-channel/new-model",
          providerId: "lolicode",
          modelId: "new-channel/new-model",
          name: "New Model",
          channelName: "New Channel",
        },
      ],
    };
    vi.mocked(agentApi.openProject).mockResolvedValue({
      workspace: { path: project, name: "project" },
      catalog: nextCatalog,
      sessions: [session, second],
    });
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^正在查看的会话/ }));
    await flush();
    fill("刷新后继续的草稿");
    fireEvent.click(modelRefreshButton());
    await flush();
    expect(agentApi.openProject).toHaveBeenCalledWith(project, true);
    expect(agentApi.getCatalog).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "正在查看的会话" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "刷新后继续的草稿",
    );
    selectModel("New Model");
    await flush();
    fireEvent.click(sessionCreationButton());
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      "lolicode/new-channel/new-model",
      "build",
      undefined,
      "ask",
      undefined,
    );
  });

  it("does not refresh or replace the bound catalog while any known project session is running", async () => {
    const second = { ...session, id: "s2", title: "历史会话" };
    snapshot.status = "running";
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === session.id
        ? structuredClone(snapshot)
        : { ...emptySnapshot(), session: second },
    );
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^历史会话/ }));
    await flush();
    const refresh = modelRefreshButton();
    expect(refresh).toBeDisabled();
    expect(screen.getByText("任务结束后可刷新模型目录。")).toBeInTheDocument();
    fireEvent.click(refresh);
    expect(agentApi.openProject).not.toHaveBeenCalled();
    expect(agentApi.getCatalog).toHaveBeenCalledTimes(1);
  });

  it("keeps the old catalog and draft when the authoritative project refresh fails", async () => {
    vi.mocked(agentApi.openProject).mockRejectedValue(
      new Error("当前项目还有任务在执行，请等待完成。"),
    );
    render(<AgentPage />);
    await flush();
    fill("保留这段输入");
    fireEvent.click(modelRefreshButton());
    await flush();
    expect(
      screen.getByText("当前项目还有任务在执行，请等待完成。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留这段输入",
    );
    expect(screen.getByRole("button", { name: "模型" })).toHaveAttribute(
      "title",
      "DeepSeek · Code Model",
    );
    expect(agentApi.getCatalog).toHaveBeenCalledTimes(1);
  });

  it("keeps an acknowledged input pending while the backend snapshot is still idle", async () => {
    render(<AgentPage />);
    await flush();
    fill();
    const send = screen.getByRole("button", { name: "发送" });
    fireEvent.click(send);
    fireEvent.click(send);
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledTimes(1);
    const requestId = vi.mocked(agentApi.sendMessage).mock.calls[0][2];
    expect(requestId).toMatch(/^msg_/);
    expect(screen.getByText("已发送，等待开始…")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("");
    await expectFolderEnabled();
    await tick();
    expect(screen.getByText("已发送，等待开始…")).toBeInTheDocument();
    snapshot.messages = [
      {
        id: requestId,
        role: "user",
        createdAt: 3,
        parts: [{ type: "text", text: "修复这个项目的测试" }],
      },
    ];
    await tick();
    expect(screen.getByText("已发送，等待开始…")).toBeInTheDocument();
    snapshot.status = "running";
    snapshot.messages.push({
      id: "msg_assistant",
      role: "assistant",
      createdAt: 4,
      parts: [{ type: "text", text: "开始检查测试" }],
    });
    await tick();
    expect(screen.getByText("正在回复…")).toBeInTheDocument();
    expect(screen.getByText("开始检查测试")).toBeInTheDocument();
    snapshot.messages[1].parts = [
      { type: "text", text: "开始检查测试，找到了原因" },
    ];
    await tick();
    expect(screen.getByText("开始检查测试，找到了原因")).toBeInTheDocument();
  });

  it("preserves the draft when the input queue rejects the request", async () => {
    vi.mocked(agentApi.sendMessage).mockRejectedValue(
      new Error("模型已经移除，请重新选择。"),
    );
    render(<AgentPage />);
    await flush();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(screen.getByText("模型已经移除，请重新选择。")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "修复这个项目的测试",
    );
    expect(screen.queryByText("已发送，等待开始…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("persists the submission before IPC and reuses its request id after an uncertain transport failure", async () => {
    vi.mocked(agentApi.sendMessage).mockImplementationOnce(
      async (id, text, requestId) => {
        const records = Object.keys(localStorage).filter((key) =>
          key.startsWith("lolicode.agent.input:"),
        );
        expect(records).toHaveLength(1);
        expect(JSON.parse(localStorage.getItem(records[0])!)).toMatchObject({
          requestId,
          text,
          sessionId: id,
        });
        throw new Error("无法连接编程引擎：response lost");
      },
    );
    const view = render(<AgentPage />);
    await flush();
    fill("需要可靠接收的任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    const requestId = vi.mocked(agentApi.sendMessage).mock.calls[0][2];
    view.unmount();
    sessionStorage.clear(); // A renderer/app reload loses its old JS draft store.
    render(<AgentPage />);
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "需要可靠接收的任务",
    );
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agentApi.sendMessage).mock.calls[1]).toEqual([
      session.id,
      "需要可靠接收的任务",
      requestId,
      [],
      [],
    ]);
  });

  it("does not let an old ACK delete a newer draft written after the page remounts", async () => {
    let acknowledge!: () => void;
    vi.mocked(agentApi.sendMessage).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    const first = render(<AgentPage />);
    await flush();
    fill("已经提交的 A");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    first.unmount();
    const second = render(<AgentPage />);
    await flush();
    fill("下一条尚未提交的 B");
    await act(async () => {
      acknowledge();
    });
    await flush();
    second.unmount();
    render(<AgentPage />);
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "下一条尚未提交的 B",
    );
  });

  it("keeps a newly edited draft even when its text happens to equal the previous submission", async () => {
    let acknowledge!: () => void;
    vi.mocked(agentApi.sendMessage).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    const first = render(<AgentPage />);
    await flush();
    fill("同样的文字");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    first.unmount();
    const second = render(<AgentPage />);
    await flush();
    fill("先修改");
    fill("同样的文字");
    await act(async () => {
      acknowledge();
    });
    await flush();
    second.unmount();
    render(<AgentPage />);
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "同样的文字",
    );
  });

  it("does not invoke send when its recovery ledger cannot be persisted", async () => {
    const save = Storage.prototype.setItem;
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key.startsWith("lolicode.agent.input:")) throw new Error("quota");
        save.call(this, key, value);
      });
    try {
      render(<AgentPage />);
      await flush();
      fill("必须可恢复的输入");
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await flush();
      expect(agentApi.sendMessage).not.toHaveBeenCalled();
      expect(screen.getByText(/无法保存发送恢复记录/)).toBeInTheDocument();
      expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
        "必须可恢复的输入",
      );
    } finally {
      storage.mockRestore();
    }
  });

  it("allows Stop while send is awaiting admission and stops a late accepted input again before settling", async () => {
    let acknowledge!: () => void;
    vi.mocked(agentApi.sendMessage).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    render(<AgentPage />);
    await flush();
    fill("发送尚未返回");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    const stop = screen.getByRole("button", { name: "停止" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    fireEvent.click(stop);
    await flush();
    expect(agentApi.interruptSession).toHaveBeenCalledTimes(1);
    await tick();
    expect(screen.getByText("正在停止…")).toBeInTheDocument();
    snapshot.status = "running";
    await act(async () => {
      acknowledge();
    });
    await flush();
    expect(agentApi.interruptSession).toHaveBeenCalledTimes(2);
    await tick();
    expect(screen.getByText("正在停止…")).toBeInTheDocument();
    snapshot.status = "idle";
    await tick();
    expect(screen.queryByText("正在停止…")).not.toBeInTheDocument();
  });

  it("does not put Stop behind a pending model configuration IPC", async () => {
    let configure!: (value: AgentSession) => void;
    vi.mocked(agentApi.updateSession).mockReturnValueOnce(
      new Promise((resolve) => {
        configure = resolve;
      }),
    );
    render(<AgentPage />);
    await flush();
    selectModel("Model B");
    await flush();
    snapshot.status = "running";
    await tick(5000);
    const stop = screen.getByRole("button", { name: "停止" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    await flush();
    expect(agentApi.interruptSession).toHaveBeenCalledOnce();
    await act(async () => {
      configure({
        ...session,
        model: {
          providerId: catalog.models[1].providerId,
          modelId: catalog.models[1].modelId,
        },
      });
    });
  });

  it("does not clear a newly accepted input on an error snapshot from the previous turn", async () => {
    snapshot.status = "error";
    snapshot.error = "上一轮失败";
    render(<AgentPage />);
    await flush();
    fill("新的一轮");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    await tick();
    expect(screen.getByText("已发送，等待开始…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("settles an acknowledged latest turn that fails before any running or assistant snapshot", async () => {
    const reason =
      "当前完整输入无法放入摘要请求的上下文预算；未截断历史或重放工具，请选择更长上下文模型后继续。";
    vi.mocked(agentApi.sendMessage).mockImplementationOnce(
      async (_id, text, requestId) => {
        snapshot.messages = [
          {
            id: requestId!,
            role: "user",
            createdAt: 3,
            parts: [{ type: "text", text }],
          },
        ];
        snapshot.status = "error";
        snapshot.error = reason;
      },
    );
    render(<AgentPage />);
    await flush();
    fill("测试公益模型");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    await tick();

    expect(screen.getByText(reason)).toBeVisible();
    expect(screen.getByText("本轮运行失败")).toBeVisible();
    expect(screen.getByText("执行遇到问题")).toBeInTheDocument();
    expect(screen.queryByText("已发送，等待开始…")).not.toBeInTheDocument();
    expect(readAgentSubmission(project, session.id)).toBeNull();
    fill("保留给用户手动继续的草稿");
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    expect(agentApi.sendMessage).toHaveBeenCalledOnce();
    expect(agentApi.updateSession).not.toHaveBeenCalled();
    expect(agentApi.deleteSession).not.toHaveBeenCalled();
  });

  it.each(["different request", "later user turn", "missing failure reason"])(
    "does not settle a pending input from an unrelated terminal snapshot: %s",
    async (caseName) => {
      render(<AgentPage />);
      await flush();
      fill("当前发送");
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await flush();
      const requestId = vi.mocked(agentApi.sendMessage).mock.calls[0][2]!;
      snapshot.messages = [
        {
          id:
            caseName === "different request" ? "some-other-request" : requestId,
          role: "user",
          createdAt: 3,
          parts: [{ type: "text", text: "已记录的输入" }],
        },
      ];
      if (caseName === "later user turn")
        snapshot.messages.push({
          id: "a-later-user-turn",
          role: "user",
          createdAt: 4,
          parts: [{ type: "text", text: "更晚的一轮" }],
        });
      snapshot.status = "error";
      snapshot.error =
        caseName === "missing failure reason" ? "  " : "其他轮次的错误";
      await tick();

      expect(screen.getByText("已发送，等待开始…")).toBeInTheDocument();
      expect(screen.queryByText("本轮运行失败")).not.toBeInTheDocument();
      fill("新草稿");
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
      expect(agentApi.sendMessage).toHaveBeenCalledOnce();
    },
  );

  it("reconciles a lost ACK with the exact native user id, clears only the submitted draft, then allows a new input", async () => {
    vi.mocked(agentApi.sendMessage).mockRejectedValueOnce(
      new Error("response lost"),
    );
    render(<AgentPage />);
    await flush();
    fill("第一条");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    const requestId = vi.mocked(agentApi.sendMessage).mock.calls[0][2];
    snapshot.status = "running";
    snapshot.messages = [
      {
        id: requestId,
        role: "user",
        createdAt: 3,
        parts: [{ type: "text", text: "第一条" }],
      },
    ];
    await tick();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("");
    snapshot.status = "idle";
    snapshot.messages.push({
      id: "msg_done",
      role: "assistant",
      createdAt: 4,
      completedAt: 5,
      parts: [{ type: "text", text: "完成" }],
    });
    await tick();
    fill("第二条");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agentApi.sendMessage).mock.calls[1][2]).not.toBe(
      requestId,
    );
  });

  it("reconciles an input observed before its IPC ACK without retaining a stale ledger that blocks the next turn", async () => {
    let acknowledge!: () => void;
    vi.mocked(agentApi.sendMessage).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    render(<AgentPage />);
    await flush();
    fill("第一条");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    const requestId = vi.mocked(agentApi.sendMessage).mock.calls[0][2];
    snapshot.status = "running";
    snapshot.messages = [
      { id: requestId, role: "user", createdAt: 3, parts: [] },
    ];
    await tick();
    await act(async () => {
      acknowledge();
    });
    await flush();
    snapshot.status = "idle";
    snapshot.messages.push({
      id: "msg_done",
      role: "assistant",
      createdAt: 4,
      completedAt: 5,
      parts: [{ type: "text", text: "完成" }],
    });
    await tick(5000);
    fill("新的任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not submit a different draft under an uncertain receipt and lets Stop settle before sending it", async () => {
    vi.mocked(agentApi.sendMessage).mockRejectedValueOnce(
      new Error("response lost"),
    );
    render(<AgentPage />);
    await flush();
    fill("第一条");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    fill("不同的新任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledOnce();
    expect(screen.getByText(/上次发送的接收状态尚未确认/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await flush();
    snapshot.messages.push({
      id: vi.mocked(agentApi.sendMessage).mock.calls[0][2],
      role: "user",
      createdAt: 3,
      parts: [],
    });
    await tick();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "不同的新任务",
    );
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not treat an unrelated assistant message as this queued request's completion", async () => {
    render(<AgentPage />);
    await flush();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    snapshot.messages = [
      {
        id: "msg_other",
        role: "assistant",
        createdAt: 3,
        completedAt: 4,
        parts: [{ type: "text", text: "其他输入的回复" }],
      },
    ];
    await tick();
    expect(screen.getByText("已发送，等待开始…")).toBeInTheDocument();
  });

  it("requests a stop once and waits for an authoritative idle snapshot", async () => {
    snapshot.status = "running";
    render(<AgentPage />);
    await flush();
    const stop = screen.getByRole("button", { name: "停止" });
    fireEvent.click(stop);
    fireEvent.click(stop);
    await flush();
    expect(agentApi.interruptSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText("正在停止…")).toBeInTheDocument();
    await tick();
    expect(screen.getByText("正在停止…")).toBeInTheDocument();
    snapshot.status = "idle";
    await tick();
    expect(screen.getByText("准备就绪")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "停止" }),
    ).not.toBeInTheDocument();
  });

  it("retains the unsent draft after leaving the page without stopping or closing the engine", async () => {
    const view = render(<AgentPage />);
    await flush();
    fill("以后继续处理的任务");
    view.unmount();
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
    expect(agentApi.closeProject).not.toHaveBeenCalled();
    render(<AgentPage />);
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "以后继续处理的任务",
    );
  });

  it("clears an accepted draft and restores queue metadata when send acknowledges after the page is left", async () => {
    let finishSend: () => void = () => {};
    vi.mocked(agentApi.sendMessage).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSend = resolve;
        }),
    );
    const view = render(<AgentPage />);
    await flush();
    fill("已送入后台的任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    view.unmount();
    await act(async () => finishSend());
    render(<AgentPage />);
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("");
    expect(screen.getByText("已发送，等待开始…")).toBeInTheDocument();
    expect(agentApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(agentApi.closeProject).not.toHaveBeenCalled();
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });

  it("preserves a rejected draft and removes queue metadata when send rejects after leaving the page", async () => {
    let rejectSend: (cause: unknown) => void = () => {};
    vi.mocked(agentApi.sendMessage).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectSend = reject;
        }),
    );
    const view = render(<AgentPage />);
    await flush();
    fill("尚未被后台接受的任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    view.unmount();
    await act(async () => rejectSend(new Error("输入队列无法写入")));
    render(<AgentPage />);
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "尚未被后台接受的任务",
    );
    expect(screen.queryByText("已发送，等待开始…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("isolates conversation drafts and ignores a late snapshot from the previous selection", async () => {
    const second = { ...session, id: "s2", title: "另一段会话" };
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    let finishFirst: (result: AgentSnapshot) => void = () => {};
    vi.mocked(agentApi.getSession).mockImplementation((id) =>
      id === session.id
        ? new Promise((resolve) => {
            finishFirst = resolve;
          })
        : Promise.resolve({ ...emptySnapshot(), session: second }),
    );
    render(<AgentPage />);
    await flush();
    fill("第一个草稿");
    fireEvent.click(screen.getByRole("button", { name: /^另一段会话/ }));
    await flush();
    fill("第二个草稿");
    await act(async () =>
      finishFirst({
        ...emptySnapshot(),
        messages: [
          {
            id: "stale",
            role: "assistant",
            createdAt: 3,
            parts: [{ type: "text", text: "旧会话的迟到内容" }],
          },
        ],
      }),
    );
    expect(screen.queryByText("旧会话的迟到内容")).not.toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "第二个草稿",
    );
    fireEvent.click(screen.getByRole("button", { name: /^修复测试/ }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "第一个草稿",
    );
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });

  it("keeps observing a running conversation while another history is selected", async () => {
    const second = { ...session, id: "s2", title: "完成的会话" };
    snapshot.status = "running";
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === session.id
        ? structuredClone(snapshot)
        : { ...emptySnapshot(), session: second },
    );
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^完成的会话/ }));
    await flush();
    await expectFolderEnabled();
    expect(modelRefreshButton()).toBeDisabled();
    snapshot.status = "idle";
    await tick(1500);
    await expectFolderEnabled();
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });

  it.each(["running", "title"] as const)(
    "discovers a nonselected %s job from lightweight session metadata after mounting",
    async (job) => {
      const background: AgentSnapshot = {
        ...emptySnapshot(),
        session: { ...session, id: "background", title: "后台临时标题" },
        status: job === "running" ? "running" : "idle",
        titlePending: true,
      };
      vi.mocked(agentApi.listSessions).mockResolvedValue([
        { ...session, pinned: true },
        {
          ...background.session,
          activity: { status: background.status, titlePending: true },
        },
      ]);
      vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
        structuredClone(id === background.session.id ? background : snapshot),
      );
      render(<AgentPage />);
      await flush();
      expect(agentApi.getSession).toHaveBeenCalledWith(background.session.id);
      fill("保留当前输入");
      background.status = "idle";
      await tick(1500);
      background.session.title = "后台归纳完成";
      background.titlePending = false;
      await tick(1500);
      expect(
        screen.getByRole("button", { name: /^后台归纳完成/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: session.title }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
        "保留当前输入",
      );
      expect(agentApi.interruptSession).not.toHaveBeenCalled();
    },
  );

  it("updates a late background title after the task is idle without changing the selected conversation or draft", async () => {
    const second = { ...session, id: "s2", title: "正在查看的历史" };
    snapshot.status = "running";
    snapshot.titlePending = true;
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === session.id
        ? structuredClone(snapshot)
        : { ...emptySnapshot(), session: second },
    );
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^正在查看的历史/ }));
    await flush();
    fill("另一会话中未发送的草稿");
    snapshot.status = "idle";
    await tick(1500);
    expect(modelRefreshButton()).toBeEnabled();
    snapshot.session.title = "自动归纳的任务标题";
    snapshot.titlePending = false;
    await tick(1500);
    expect(
      screen.getByRole("button", { name: /^自动归纳的任务标题/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: second.title }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "另一会话中未发送的草稿",
    );
    vi.mocked(agentApi.getSession).mockClear();
    await tick(5000);
    expect(agentApi.getSession).not.toHaveBeenCalledWith(session.id);
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });

  it("keeps an in-flight stop associated with its original conversation when another history is selected", async () => {
    const second = { ...session, id: "s2", title: "完成的会话" };
    snapshot.status = "running";
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === session.id
        ? structuredClone(snapshot)
        : { ...emptySnapshot(), session: second },
    );
    let finishStop: () => void = () => {};
    vi.mocked(agentApi.interruptSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStop = resolve;
          pendingStopCleanups.add(resolve);
        }),
    );
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(screen.getByText("正在停止…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^完成的会话/ }));
    await flush();
    expect(screen.queryByText("正在停止…")).not.toBeInTheDocument();
    expect(screen.getByText("准备就绪")).toBeInTheDocument();
    await act(async () => finishStop());
    expect(agentApi.interruptSession).toHaveBeenCalledWith(session.id);
    expect(screen.queryByText("正在停止…")).not.toBeInTheDocument();
  });

  it("keeps streamed content and the draft during a snapshot read failure", async () => {
    snapshot.status = "running";
    snapshot.messages = [
      {
        id: "assistant",
        role: "assistant",
        createdAt: 3,
        parts: [{ type: "text", text: "已有的执行内容" }],
      },
    ];
    render(<AgentPage />);
    await flush();
    fill("后续补充内容");
    vi.mocked(agentApi.getSession).mockRejectedValueOnce(
      new Error("暂时无法读取会话，请重试。"),
    );
    await tick();
    expect(screen.getByText("暂时无法读取会话，请重试。")).toBeInTheDocument();
    expect(screen.getByText("已有的执行内容")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "后续补充内容",
    );
    expect(screen.getByText("正在回复…")).toBeInTheDocument();
    await tick(2000);
    expect(
      screen.queryByText("暂时无法读取会话，请重试。"),
    ).not.toBeInTheDocument();
  });

  it("routes permissions by their real session and request IDs and keeps rejection errors visible", async () => {
    snapshot.status = "waiting_permission";
    snapshot.permissions = [
      {
        id: "permission-1",
        sessionId: session.id,
        action: "bash",
        description: "运行项目的测试",
        resources: ["pnpm test"],
      },
    ];
    vi.mocked(agentApi.replyPermission).mockRejectedValueOnce(
      new Error("此许可已失效，请刷新。"),
    );
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    await flush();
    expect(agentApi.replyPermission).toHaveBeenCalledWith(
      session.id,
      "permission-1",
      "once",
    );
    expect(screen.getByText("此许可已失效，请刷新。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await flush();
    expect(agentApi.replyPermission).toHaveBeenLastCalledWith(
      session.id,
      "permission-1",
      "reject",
    );
  });

  it("keeps native user-once approvals scoped to one request", async () => {
    snapshot.status = "waiting_permission";
    snapshot.permissions = [
      {
        id: "permission-native",
        sessionId: session.id,
        action: "shell",
        resources: ["owned fixture"],
        approvalMode: "user-once",
      },
    ];
    render(<AgentPage />);
    await flush();
    expect(
      screen.getByRole("button", { name: "此项目记住授权" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "此项目记住授权" }));
    expect(agentApi.replyPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    await flush();
    expect(agentApi.replyPermission).toHaveBeenCalledWith(
      session.id,
      "permission-native",
      "once",
    );
  });

  it("renders real tool execution and applied file diffs without dumping tool input JSON", async () => {
    snapshot.messages = [
      {
        id: "assistant",
        role: "assistant",
        createdAt: 3,
        parts: [
          {
            type: "tool",
            id: "tool-1",
            name: "bash",
            state: "running",
            input: {
              command: "pnpm test",
              env: { PRIVATE_KEY: "not-for-display" },
            },
            output: "正在测试",
          },
        ],
      },
    ];
    snapshot.diffs = [
      {
        path: "src/example.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch:
          "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
      },
    ];
    render(<AgentPage />);
    await flush();
    const activity = screen.getByText("正在处理 1 个步骤").closest("details")!;
    expect(activity).not.toHaveAttribute("open");
    expect(screen.queryByText("运行命令")).not.toBeInTheDocument();
    fireEvent.click(activity.querySelector("summary")!);
    await tick(1);
    expect(screen.getByText("运行命令")).toBeInTheDocument();
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.queryByText(/not-for-display/)).not.toBeInTheDocument();
    expect(screen.getByText(/文件修改 · 1 个文件/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByText(/文件修改 · 1 个文件/).closest("summary")!,
    );
    await tick(1);
    fireEvent.click(screen.getByTitle("src/example.ts").closest("summary")!);
    await tick(1);
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("keeps existing messages while recovering a stream gap", async () => {
    snapshot.status = "running";
    snapshot.streamGap = true;
    snapshot.messages = [
      {
        id: "assistant",
        role: "assistant",
        createdAt: 3,
        parts: [{ type: "text", text: "已经读取项目文件" }],
      },
    ];
    render(<AgentPage />);
    await flush();
    expect(screen.getByText("已经读取项目文件")).toBeInTheDocument();
    expect(
      screen.getByText("正在恢复连接，已有内容会保留。"),
    ).toBeInTheDocument();
  });

  it("does not send Enter during IME composition", async () => {
    render(<AgentPage />);
    await flush();
    fill();
    fireEvent.keyDown(screen.getByLabelText("发送给 Agent 的消息"), {
      key: "Enter",
      isComposing: true,
    });
    await flush();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("发送给 Agent 的消息"), {
      key: "Enter",
      shiftKey: true,
    });
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });
});
