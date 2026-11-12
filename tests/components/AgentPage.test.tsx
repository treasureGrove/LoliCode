import {
  act,
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  within,
} from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPage } from "@/features/agent/AgentPage";
import { useAgentPaneLayout } from "@/features/agent/useAgentPaneLayout";
import { agentApi } from "@/lib/api/agent";
import { agentFilesApi } from "@/lib/api/agent-files";
import { settingsApi } from "@/lib/api";
import { agentMemoryApi } from "@/lib/api/agent-memory";
import { usageApi } from "@/lib/api/usage";
import { settingsApi as desktopSettingsApi } from "@/lib/api/settings";
import * as platform from "@/lib/platform";
import { toast } from "@/lib/toast";
import * as agentImageStore from "@/lib/agentImageStore";
import { saveAgentQueueSubmission } from "@/lib/agentQueueLedger";
import {
  captureAgentDraft,
  readAgentDraft,
  readAgentSubmission,
  saveAgentSubmission,
} from "@/lib/agentInputLedger";
import type { AgentCatalog, AgentSession, AgentSnapshot } from "@/types/agent";
import type {
  AgentNativeSessionWatchMessage,
  SessionAssistantStreamAttempt,
  SessionWireEvent,
} from "@/types/harness-session";
import { emitTauriEvent } from "../msw/tauriMocks";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

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
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
// Engine tests use a fake clock; animation timing and exiting-surface isolation
// are covered with the real Motion runtime in FullScreenPanel.test.tsx.
vi.mock("framer-motion", async () => ({
  ...(await vi.importActual<typeof import("framer-motion")>("framer-motion")),
  useReducedMotion: () => true,
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
    openSecretary: vi.fn(),
    getSecretary: vi.fn(),
    delegateSecretaryTask: vi.fn(),
    sendSecretaryTaskMessage: vi.fn(),
    cancelSecretaryTask: vi.fn(),
    deleteSecretaryTask: vi.fn(),
    updateSession: vi.fn(),
    renameSession: vi.fn(),
    setSessionMetadata: vi.fn(),
    deleteSession: vi.fn(),
    getExtensions: vi.fn(),
    getHarnessPlugins: vi
      .fn()
      .mockResolvedValue({ bundles: [], pendingReload: false }),
    getPluginStore: vi.fn(),
    getNativeActivity: vi.fn(),
    native: vi.fn(),
    automation: vi.fn(),
    getSession: vi.fn(),
    readSessionNative: vi.fn(),
    prepareSession: vi.fn(),
    watchSessionNative: vi.fn(),
    stopSessionNative: vi.fn(),
    readNativeMessageAliases: vi.fn(),
    sendMessage: vi.fn(),
    enqueueMessage: vi.fn(),
    removeQueuedMessage: vi.fn(),
    sendQueuedMessageNow: vi.fn(),
    queryCommand: vi.fn(),
    interruptSession: vi.fn(),
    replyPermission: vi.fn(),
    replyQuestion: vi.fn(),
    rejectQuestion: vi.fn(),
    closeProject: vi.fn(),
  },
}));
vi.mock("@/lib/api", () => ({
  settingsApi: {
    pickDirectory: vi.fn(),
    openExternal: vi.fn(),
    revealAppLogFile: vi.fn(),
  },
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
async function queueRecallAction(ordinal = 1) {
  fireEvent.keyDown(
    screen.getByRole("button", { name: `第 ${ordinal} 条消息的更多操作` }),
    { key: "Enter" },
  );
  await flush();
  return screen.getByRole("menuitem", { name: `撤回编辑第 ${ordinal} 条消息` });
}
function openComposerOptions() {
  const trigger = screen.getByRole("button", { name: "对话设置" });
  if (trigger.getAttribute("aria-expanded") !== "true")
    fireEvent.click(trigger);
  return screen.getByRole("dialog", { name: "对话设置" });
}
function composerPermissionSelect() {
  if (!screen.queryByRole("button", { name: "对话设置" }))
    return screen.getByLabelText("执行权限");
  return within(openComposerOptions()).getByLabelText("执行权限");
}
function composerSettingButton(name: "思考档位" | "上下文窗口") {
  if (!screen.queryByRole("button", { name: "对话设置" }))
    return screen.getByRole("button", { name });
  return within(openComposerOptions()).getByRole("button", { name });
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
  vi.mocked(openFileDialog).mockReset().mockResolvedValue(null);
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
  vi.mocked(agentApi.automation).mockReset().mockResolvedValue([]);
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
  // Fake RAF along with timers: JSDOM otherwise retains its internal interval
  // across clock resets after nested dialog/rail transitions.
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  vi.spyOn(toast, "warning").mockClear().mockReturnValue(0);
  sessionStorage.clear();
  for (const key of Object.keys(localStorage))
    if (
      key.startsWith("lolicode.agent.input:") ||
      key.startsWith("lolicode.agent.draft-record:") ||
      key.startsWith("lolicode.agent.rightDock") ||
      key.startsWith("lolicode.agent.queue-")
    )
      localStorage.removeItem(key);
  localStorage.removeItem("lolicode.agent.recent-projects");
  localStorage.removeItem("lolicode.agent.last-selection.v1");
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
  vi.mocked(agentApi.readSessionNative)
    .mockReset()
    .mockResolvedValue({
      page: { records: [], cursor: -1, hasMore: false },
      projections: { kind: "sequenced", asOfSeq: -1, values: {} },
      state: {
        cursor: -1,
        active: false,
        running: false,
        queue: null,
        pendingInput: [],
      },
    });
  vi.mocked(agentApi.watchSessionNative).mockReset().mockResolvedValue(false);
  vi.mocked(agentApi.prepareSession).mockReset().mockResolvedValue();
  vi.mocked(agentApi.stopSessionNative).mockReset().mockResolvedValue();
  vi.mocked(agentApi.readNativeMessageAliases)
    .mockReset()
    .mockResolvedValue({});
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
  vi.mocked(agentApi.openSecretary)
    .mockReset()
    .mockImplementation(async (_model, _permission, _effort, projectPath) => {
      snapshot.session = {
        ...structuredClone(session),
        projectPath: projectPath ?? project,
        id: "lc:secretary",
        title: "Loli 秘书",
        coordination: { role: "secretary" },
      };
      return structuredClone(snapshot.session);
    });
  vi.mocked(agentApi.getSecretary)
    .mockReset()
    .mockResolvedValue({ sessionId: "lc:secretary", tasks: [] });
  vi.mocked(agentApi.sendSecretaryTaskMessage).mockReset();
  vi.mocked(agentApi.deleteSecretaryTask).mockReset().mockResolvedValue();
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
  vi.mocked(agentApi.enqueueMessage)
    .mockReset()
    .mockImplementation(async (_id, text, requestId) => {
      snapshot.queuedMessages = [
        ...(snapshot.queuedMessages || []),
        { id: requestId, text, attachments: [] },
      ];
      return { status: "accepted" as const };
    });
  vi.mocked(agentApi.removeQueuedMessage)
    .mockReset()
    .mockImplementation(async (_id, requestId) => {
      const entry = snapshot.queuedMessages?.find(
        (item) => item.id === requestId,
      );
      snapshot.queuedMessages = snapshot.queuedMessages?.filter(
        (item) => item.id !== requestId,
      );
      return { requestId, text: entry?.text || "", attachments: [] };
    });
  vi.mocked(agentApi.sendQueuedMessageNow).mockReset().mockResolvedValue();
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
  vi.mocked(settingsApi.revealAppLogFile).mockReset().mockResolvedValue();
});
afterEach(async () => {
  cleanup();
  // Unmount first so a failed assertion cannot leave a shared Stop lane busy
  // or allow its deferred acknowledgement to update the next test's session.
  await act(async () => {
    for (const finish of pendingStopCleanups) finish();
    pendingStopCleanups.clear();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    // Queue recall schedules focus on the next animation frame. Drain it after
    // unmounting, before discarding fake timers, so JSDOM's shared RAF scheduler
    // does not retain a timer ID that can no longer service later focus tests.
    await vi.advanceTimersByTimeAsync(32);
  });
  vi.useRealTimers();
});

describe("AgentPage", () => {
  function openNativeFixture(events: SessionWireEvent[] = []) {
    const nativeSession = {
      ...session,
      id: "lc:11111111-1111-4111-8111-111111111111",
    };
    snapshot.session = nativeSession;
    vi.mocked(agentApi.listSessions).mockResolvedValue([nativeSession]);
    snapshot.messages = [
      {
        id: "old-dto",
        role: "assistant",
        createdAt: 1,
        parts: [{ type: "text", text: "旧转换内容不应作为默认聊天来源" }],
      },
    ];
    vi.mocked(agentApi.openProject).mockResolvedValue({
      workspace: { path: project, name: "project" },
      catalog: structuredClone(catalog),
      sessions: [nativeSession],
    });
    const cursor = events.at(-1)?.seq ?? -1;
    vi.mocked(agentApi.readSessionNative).mockResolvedValue({
      page: {
        records: events.map((event) => ({ type: "event", event })),
        cursor,
        hasMore: false,
      },
      projections: { kind: "sequenced", asOfSeq: cursor, values: {} },
      state: {
        cursor,
        active: false,
        running: false,
        queue: null,
        pendingInput: [],
      },
    });
    return nativeSession;
  }

  it("prepares a selected native host in the background without sending a message", async () => {
    const current = openNativeFixture();
    const page = render(<AgentPage initialProjectPath={project} />);
    await flush();
    await tick(80);
    expect(agentApi.prepareSession).toHaveBeenCalledWith(current.id);
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    const prepared = vi.mocked(agentApi.prepareSession).mock.calls.length;
    page.rerender(<AgentPage initialProjectPath={project} isActive={false} />);
    await flush();
    expect(agentApi.prepareSession).toHaveBeenCalledTimes(prepared);
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])(
    "does not reread cold history when the first idle controls resolve %s the native read",
    async (order) => {
      const current = openNativeFixture();
      const event: SessionWireEvent = {
        seq: 0,
        time: 1,
        type: "user/message",
        surfaceOp: "append",
        data: {
          id: "cold-user",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "先显示本地历史" }],
        },
      };
      let finishControls!: (value: AgentSnapshot) => void;
      let finishHistory!: (
        value: Awaited<ReturnType<typeof agentApi.readSessionNative>>,
      ) => void;
      vi.mocked(agentApi.getSession).mockReturnValue(
        new Promise((resolve) => {
          finishControls = resolve;
        }),
      );
      vi.mocked(agentApi.readSessionNative).mockReturnValueOnce(
        new Promise((resolve) => {
          finishHistory = resolve;
        }),
      );
      const history: Awaited<ReturnType<typeof agentApi.readSessionNative>> = {
        page: { records: [{ type: "event", event }], cursor: 0, hasMore: false },
        projections: { kind: "sequenced", asOfSeq: 0, values: {} },
        state: {
          cursor: 0,
          active: false,
          running: false,
          queue: null,
          pendingInput: [],
        },
      };
      render(<AgentPage initialProjectPath={project} />);
      await flush();
      await tick(80);
      // Native history starts in parallel with the still-pending controls read.
      expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
      expect(agentApi.readSessionNative).toHaveBeenCalledWith(current.id, {
        maxMessages: 12,
      });
      if (order === "before")
        await act(async () => finishControls(structuredClone(snapshot)));
      expect(agentApi.prepareSession).not.toHaveBeenCalled();
      await act(async () => finishHistory(history));
      expect(screen.getByText("先显示本地历史")).toBeVisible();
      if (order === "after")
        await act(async () => finishControls(structuredClone(snapshot)));
      await flush();
      await tick(80);
      expect(agentApi.watchSessionNative).toHaveBeenCalledTimes(1);
      expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "running",
    "waiting_permission",
    "waiting_question",
    "error",
  ] as const)(
    "still retries a cold read when the first controls already report %s",
    async (status) => {
      openNativeFixture();
      snapshot.status = status;
      let finishHistory!: (
        value: Awaited<ReturnType<typeof agentApi.readSessionNative>>,
      ) => void;
      vi.mocked(agentApi.readSessionNative).mockReturnValueOnce(
        new Promise((resolve) => {
          finishHistory = resolve;
        }),
      );
      render(<AgentPage initialProjectPath={project} />);
      await flush();
      await tick(80);
      expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
      await act(async () =>
        finishHistory({
          page: { records: [], cursor: -1, hasMore: false },
          projections: { kind: "sequenced", asOfSeq: -1, values: {} },
          state: {
            cursor: -1,
            active: false,
            running: false,
            queue: null,
            pendingInput: [],
          },
        }),
      );
      await flush();
      expect(agentApi.readSessionNative).toHaveBeenCalledTimes(2);
    },
  );

  it("still wakes cold history for later running/completed controls and an explicit retry", async () => {
    const current = openNativeFixture();
    render(<AgentPage initialProjectPath={project} />);
    await flush();
    await tick(80);
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
    snapshot.status = "running";
    act(() =>
      emitTauriEvent("agent-session-update", {
        type: "changed",
        sessionId: current.id,
      }),
    );
    await tick(80);
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(2);
    snapshot.status = "idle";
    act(() =>
      emitTauriEvent("agent-session-update", {
        type: "changed",
        sessionId: current.id,
      }),
    );
    await tick(80);
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(3);
    vi.mocked(agentApi.getSession).mockRejectedValueOnce(
      "控制读取失败，请重试",
    );
    act(() =>
      emitTauriEvent("agent-session-update", {
        type: "changed",
        sessionId: current.id,
      }),
    );
    await tick(80);
    // The actual host update itself invalidates native history once.
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole("button", { name: /^重试$/ }));
    await flush();
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(5);
  });

  it("still detects cold session changes through polling if the activity notification was missed", async () => {
    openNativeFixture();
    render(<AgentPage initialProjectPath={project} />);
    await flush();
    await tick(80);
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
    snapshot.status = "running";
    await tick(5000);
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(2);
    snapshot.status = "idle";
    await tick(800);
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(3);
  });

  it("still wakes cold history immediately for a local send while desktop controls remain idle", async () => {
    openNativeFixture();
    vi.mocked(agentApi.queryCommand).mockResolvedValue({ status: "accepted" });
    let finishSend!: () => void;
    vi.mocked(agentApi.sendMessage).mockReturnValue(
      new Promise<void>((resolve) => {
        finishSend = resolve;
      }),
    );
    render(<AgentPage initialProjectPath={project} />);
    await flush();
    await tick(80);
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
    fill("发起真正的新活动");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(2);
    await act(async () => finishSend());
    await flush();
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(3);
  });

  it("catches a real completion notification while the first idle controls are still pending", async () => {
    const current = openNativeFixture();
    let finishControls!: (value: AgentSnapshot) => void;
    vi.mocked(agentApi.getSession).mockReturnValueOnce(
      new Promise((resolve) => {
        finishControls = resolve;
      }),
    );
    render(<AgentPage initialProjectPath={project} />);
    await flush();
    await tick(80);
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(1);
    snapshot.messages.push({
      id: "just-finished",
      role: "assistant",
      createdAt: 2,
      parts: [],
    });
    act(() =>
      emitTauriEvent("agent-session-update", {
        type: "changed",
        sessionId: current.id,
      }),
    );
    await act(async () => finishControls(structuredClone(snapshot)));
    await flush();
    expect(agentApi.readSessionNative).toHaveBeenCalledTimes(2);
  });

  it("uses the official native journal in the default conversation and removes the preview entry", async () => {
    const nativeSession = openNativeFixture([
      {
        seq: 0,
        time: 1,
        type: "assistant/message",
        surfaceOp: "append",
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "official-answer",
            role: "assistant",
            content: [{ type: "text", text: "默认聊天中的官方原生回复" }],
          },
          stream: [],
        },
      },
    ]);
    render(<AgentPage initialProjectPath={project} />);
    await flush();
    await tick(80);
    expect(screen.getByText("默认聊天中的官方原生回复")).toBeVisible();
    expect(
      screen.queryByText("旧转换内容不应作为默认聊天来源"),
    ).not.toBeInTheDocument();
    expect(agentApi.readSessionNative).toHaveBeenCalledWith(
      nativeSession.id,
      expect.any(Object),
    );
    fireEvent.click(screen.getByRole("button", { name: "对话更多选项" }));
    await flush();
    expect(
      screen.queryByRole("menuitem", { name: "原生会话预览" }),
    ).not.toBeInTheDocument();
  });

  it("streams into the default native conversation and replaces the transient reply with one committed message", async () => {
    const userEvent: SessionWireEvent = {
      seq: 0,
      time: 1,
      type: "user/message",
      surfaceOp: "append",
      data: {
        id: "native-user",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "开始任务" }],
      },
    };
    const nativeSession = openNativeFixture([userEvent]);
    let accept!: (message: AgentNativeSessionWatchMessage) => void;
    let subscriptionId = "";
    vi.mocked(agentApi.watchSessionNative).mockImplementation(
      (_session, id, onMessage) => {
        subscriptionId = id;
        accept = onMessage;
        return new Promise<boolean>(() => {});
      },
    );
    render(<AgentPage initialProjectPath={project} />);
    await flush();
    await tick(80);
    const attemptId =
      "default-native-attempt" as SessionAssistantStreamAttempt["attemptId"];
    type FollowFrame = Extract<
      AgentNativeSessionWatchMessage,
      { frame: unknown }
    >["frame"];
    const send = (frame: FollowFrame) =>
      act(() => accept({ subscriptionId, frame }));
    send({
      type: "snapshot",
      header: {
        version: 4,
        id: nativeSession.id.slice(3) as Extract<
          FollowFrame,
          { type: "snapshot" }
        >["header"]["id"],
        createdAt: 1,
        isSeeded: false,
      },
      records: [{ type: "event", event: userEvent }],
      cursor: 0,
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
      assistantStream: { revision: 0 },
    });
    send({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId,
        revision: 1,
        startedAfterSeq: 0 as SessionAssistantStreamAttempt["startedAfterSeq"],
        turn: 1,
        step: 1,
      },
    });
    send({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId,
        revision: 2,
        index: 0,
        time: 2,
        chunk: { type: "text-delta", index: 0, text: "边生成边显示的原生回复" },
      },
    });
    await flush();
    expect(screen.getByText("边生成边显示的原生回复")).toBeVisible();
    send({
      type: "event",
      event: {
        seq: 1,
        time: 3,
        type: "assistant/message",
        surfaceOp: "append",
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "committed-answer",
            role: "assistant",
            content: [{ type: "text", text: "边生成边显示的原生回复" }],
          },
          stream: [],
        },
      },
    });
    await flush();
    expect(screen.getAllByText("边生成边显示的原生回复")).toHaveLength(1);
    expect(screen.queryByLabelText("Agent 正在回复")).not.toBeInTheDocument();
    expect(
      screen.queryByText("旧转换内容不应作为默认聊天来源"),
    ).not.toBeInTheDocument();
  });

  it("uses compatibility history only for an explicit host migration classification", async () => {
    openNativeFixture();
    vi.mocked(agentApi.readNativeMessageAliases).mockRejectedValue(
      "LOLICODE_SESSION_LEGACY_HISTORY",
    );
    render(<AgentPage initialProjectPath={project} />);
    await flush();
    await tick(80);
    expect(screen.getByText("旧转换内容不应作为默认聊天来源")).toBeVisible();
    expect(
      screen.getByText("此会话包含旧格式历史，已保留原有显示。"),
    ).toBeVisible();
  });

  it("keeps native read failures visible instead of silently displaying the old converted transcript", async () => {
    openNativeFixture();
    vi.mocked(agentApi.readSessionNative).mockRejectedValue(
      "读取测试失败，请重试",
    );
    vi.mocked(agentApi.readNativeMessageAliases).mockRejectedValue(
      "权限检查失败",
    );
    render(<AgentPage initialProjectPath={project} />);
    await flush();
    await tick(80);
    expect(screen.getByText("读取测试失败，请重试")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新连接" })).toBeEnabled();
    expect(
      screen.queryByText("旧转换内容不应作为默认聊天来源"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("此会话包含旧格式历史，已保留原有显示。"),
    ).not.toBeInTheDocument();
  });

  it("shows a local send immediately while native history is opening and hands it off by receipt identity", async () => {
    const current = openNativeFixture();
    vi.mocked(agentApi.queryCommand).mockResolvedValue({ status: "accepted" });
    type NativeRead = Awaited<ReturnType<typeof agentApi.readSessionNative>>;
    let finishRead!: (read: NativeRead) => void;
    vi.mocked(agentApi.readSessionNative).mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    render(<AgentPage initialProjectPath={project} />);
    await flush();
    await tick(80);
    fill("立即显示我的发送内容");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(vi.mocked(agentApi.sendMessage).mock.calls[0][0]).toBe(current.id);
    expect(
      screen
        .getByText("立即显示我的发送内容", { selector: "p" })
        .closest("[data-agent-transcript-session]"),
    ).toHaveAttribute("data-agent-transcript-session", current.id);
    expect(
      screen.getByText("立即显示我的发送内容", { selector: "p" }),
    ).toBeVisible();
    const requestId = vi.mocked(agentApi.sendMessage).mock.calls[0][2];
    vi.mocked(agentApi.readNativeMessageAliases).mockResolvedValue({
      "native-sent": requestId,
    });
    snapshot.messages.push({
      id: requestId,
      role: "user",
      createdAt: 2,
      parts: [{ type: "text", text: "立即显示我的发送内容" }],
    });
    act(() =>
      emitTauriEvent("agent-session-update", {
        type: "changed",
        sessionId: current.id,
      }),
    );
    await tick(80);
    expect(
      screen.getByText("立即显示我的发送内容", { selector: "p" }),
    ).toBeVisible();
    const acceptedUser: SessionWireEvent = {
      seq: 0,
      time: 2,
      type: "user/message",
      surfaceOp: "append",
      data: {
        id: "native-sent",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "立即显示我的发送内容" }],
      },
    };
    await act(async () =>
      finishRead({
        page: {
          cursor: 0,
          hasMore: false,
          records: [{ type: "event", event: acceptedUser }],
        },
        projections: { kind: "sequenced", asOfSeq: 0, values: {} },
        state: {
          cursor: 0,
          active: false,
          running: false,
          queue: null,
          pendingInput: [],
        },
      }),
    );
    await flush();
    expect(
      screen.getAllByText("立即显示我的发送内容", { selector: "p" }),
    ).toHaveLength(1);
    expect(
      screen
        .getByText("立即显示我的发送内容", { selector: "p" })
        .closest("[data-native-event-seq]"),
    ).toHaveAttribute("data-native-event-seq", "0");
  });

  async function openWorkerConversation(
    mode = "build",
    status: AgentSnapshot["status"] = "idle",
  ) {
    const secretary: AgentSession = {
      ...session,
      id: "lc:secretary",
      title: "Loli 秘书",
      coordination: { role: "secretary" },
    };
    const worker: AgentSession = {
      ...session,
      id: "lc:worker",
      title: "后台分析任务",
      mode,
      coordination: {
        role: "worker",
        parentSessionId: secretary.id,
        taskId: "task-1",
      },
    };
    const parent = { ...emptySnapshot(), session: secretary };
    snapshot = { ...emptySnapshot(), session: worker, status };
    vi.mocked(agentApi.listSessions).mockResolvedValue([secretary, worker]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      structuredClone(id === worker.id ? snapshot : parent),
    );
    vi.mocked(agentApi.getSecretary).mockResolvedValue({
      sessionId: secretary.id,
      tasks: [
        {
          id: "task-1",
          parentSessionId: secretary.id,
          sessionId: worker.id,
          title: "分析任务",
          instructions: "分析入口",
          status: status === "running" ? "running" : "cancelled",
          projectPath: project,
          requestId: "worker-request",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    render(
      <AgentPage secretaryRequest={{ requestId: 1, sessionId: secretary.id }} />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^工作任务/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开工作对话" }));
    await flush();
    return { secretary, worker };
  }

  function acceptWorkerMessage(
    _parent: string,
    taskId: string,
    text: string,
    requestId: string,
  ) {
    snapshot.messages.push({
      id: requestId,
      role: "user",
      createdAt: 3,
      parts: [{ type: "text", text }],
    });
    snapshot.status = "running";
    return Promise.resolve({
      id: taskId,
      parentSessionId: "lc:secretary",
      sessionId: "lc:worker",
      title: "分析任务",
      instructions: "分析入口",
      status: "running" as const,
      projectPath: project,
      requestId: "worker-request",
      createdAt: 1,
      updatedAt: 4,
    });
  }

  it("resumes a stopped worker through the secretary while preserving its plan scope and request ledger", async () => {
    const { worker } = await openWorkerConversation("plan");
    vi.mocked(agentApi.sendSecretaryTaskMessage).mockImplementation(
      acceptWorkerMessage,
    );
    fill("请检查当前现场后继续");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.sendSecretaryTaskMessage).toHaveBeenCalledWith(
      "lc:secretary",
      "task-1",
      "请检查当前现场后继续",
      expect.any(String),
      [],
      [],
    );
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(agentApi.updateSession).not.toHaveBeenCalled();
    expect(snapshot.session.id).toBe(worker.id);
    expect(snapshot.session.mode).toBe("plan");
    expect(screen.getByRole("button", { name: "模型" })).toBeDisabled();
    expect(
      within(openComposerOptions()).getByText(/工作对话沿用分派时的模型/),
    ).toBeInTheDocument();
    expect(composerPermissionSelect()).toBeEnabled();
  });

  it("queues a running worker follow-up in that worker's own queue", async () => {
    await openWorkerConversation("build", "running");
    fill("完成后继续核对文档");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.sendSecretaryTaskMessage).not.toHaveBeenCalled();
    expect(agentApi.enqueueMessage).toHaveBeenCalledWith(
      "lc:worker",
      "完成后继续核对文档",
      expect.any(String),
      [],
      [],
    );
    const requestId = vi.mocked(agentApi.enqueueMessage).mock.calls[0][2];
    expect(snapshot.queuedMessages?.[0].id).toBe(requestId);
    expect(
      screen.getByRole("region", { name: "待发送消息" }),
    ).toHaveTextContent("完成后继续核对文档");
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("");
  });

  it("retries an uncertain worker continuation with the same request ID", async () => {
    await openWorkerConversation();
    vi.mocked(agentApi.sendSecretaryTaskMessage)
      .mockRejectedValueOnce(new Error("工作回执未收到"))
      .mockImplementationOnce(acceptWorkerMessage);
    fill("继续完成这个任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "继续完成这个任务",
    );
    await tick(1000);
    expect(agentApi.queryCommand).toHaveBeenCalledWith(
      "lc:worker",
      vi.mocked(agentApi.sendSecretaryTaskMessage).mock.calls[0][3],
    );
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    const calls = vi.mocked(agentApi.sendSecretaryTaskMessage).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][3]).toBe(calls[0][3]);
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("retries a failed worker turn with a new ID and reuses it after a lost receipt", async () => {
    const messageId = "failed-worker-turn";
    const text = "重新检查附件";
    let retryId: string | undefined;
    const images = [
      {
        id: "original-image",
        fileName: "preview.png",
        mime: "image/png",
        bytes: 4,
        dataUrl: "data:image/png;base64,dGVzdA==",
      },
    ];
    const documents = [
      {
        id: "original-document",
        fileName: "notes.md",
        mime: "text/markdown",
        bytes: 4,
        localPath: "D:/fixture/project/notes.md",
      },
    ];
    const readImages = vi
      .spyOn(agentImageStore, "readAgentImageAttachments")
      .mockImplementation(async (id) =>
        id === messageId || id === retryId ? images : undefined,
      );
    const readDocuments = vi
      .spyOn(agentImageStore, "readAgentDocumentAttachments")
      .mockImplementation(async (id) =>
        id === messageId || id === retryId ? documents : undefined,
      );
    try {
      await openWorkerConversation("build", "error");
      snapshot.error = "MCP 项目目录不可用";
      snapshot.messages = [
        {
          id: messageId,
          role: "user",
          createdAt: 1,
          parts: [{ type: "text", text }],
        },
      ];
      vi.mocked(agentApi.sendSecretaryTaskMessage)
        .mockImplementationOnce(async (_parent, _task, _text, requestId) => {
          retryId = requestId;
          throw new Error("工作回执未收到");
        })
        .mockImplementationOnce(acceptWorkerMessage);
      await tick();
      fill("保留另一条草稿");
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      await flush();
      const [first] = vi.mocked(agentApi.sendSecretaryTaskMessage).mock.calls;
      expect(first).toEqual([
        "lc:secretary",
        "task-1",
        text,
        expect.any(String),
        images,
        documents,
      ]);
      expect(first[3]).not.toBe(messageId);
      expect(readAgentSubmission(project, "lc:worker")).toMatchObject({
        requestId: first[3],
        phase: "uncertain",
      });
      expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
        "保留另一条草稿",
      );
      expect(
        screen.queryByRole("button", { name: "移除图片：preview.png" }),
      ).not.toBeInTheDocument();
      await tick(1000);
      expect(agentApi.queryCommand).toHaveBeenCalledWith("lc:worker", first[3]);
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      await flush();
      expect(agentApi.sendSecretaryTaskMessage).toHaveBeenCalledTimes(2);
      expect(
        vi.mocked(agentApi.sendSecretaryTaskMessage).mock.calls[1],
      ).toEqual(first);
      expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
        "保留另一条草稿",
      );
      expect(agentApi.sendMessage).not.toHaveBeenCalled();
    } finally {
      readImages.mockRestore();
      readDocuments.mockRestore();
    }
  });

  it("preserves recalled image and document payloads when a worker continuation is queued", async () => {
    await openWorkerConversation("build", "running");
    snapshot.queuedMessages = [
      {
        id: "worker-attachment-queue",
        text: "核对这两个附件",
        attachments: [
          { fileName: "notes.md", mime: "text/markdown", bytes: 4 },
        ],
      },
    ];
    vi.mocked(agentApi.removeQueuedMessage).mockImplementationOnce(
      async (_id, requestId) => {
        snapshot.queuedMessages = [];
        return {
          requestId,
          text: "核对这两个附件",
          attachments: [
            {
              fileName: "preview.png",
              mime: "image/png",
              bytes: 4,
              ref: "data:image/png;base64,dGVzdA==",
            },
            {
              fileName: "notes.md",
              mime: "text/markdown",
              bytes: 4,
              dataBase64: "dGVzdA==",
            },
          ],
        };
      },
    );
    await tick(1000);
    fireEvent.click(await queueRecallAction());
    await flush();
    expect(agentApi.removeQueuedMessage).toHaveBeenCalledWith(
      "lc:worker",
      "worker-attachment-queue",
    );
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.enqueueMessage).toHaveBeenCalledWith(
      "lc:worker",
      "核对这两个附件",
      expect.any(String),
      [
        expect.objectContaining({
          fileName: "preview.png",
          dataUrl: "data:image/png;base64,dGVzdA==",
        }),
      ],
      [
        expect.objectContaining({
          fileName: "notes.md",
          dataBase64: "dGVzdA==",
        }),
      ],
    );
    expect(agentApi.sendSecretaryTaskMessage).not.toHaveBeenCalled();
  });

  it("prioritizes an existing worker queue entry without inventing a new follow-up request", async () => {
    await openWorkerConversation("build", "running");
    snapshot.queuedMessages = [
      { id: "worker-priority-queue", text: "优先核对安装", attachments: [] },
    ];
    await tick(1000);
    fill("仍在编辑的任务要求");
    fireEvent.click(
      screen.getByRole("button", { name: "引导第 1 条消息" }),
    );
    await flush();
    expect(agentApi.sendQueuedMessageNow).toHaveBeenCalledWith(
      "lc:worker",
      "worker-priority-queue",
      true,
    );
    expect(agentApi.sendSecretaryTaskMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "仍在编辑的任务要求",
    );
  });

  it("renders trusted secretary reports as system notices while leaving user-authored report-shaped JSON visible", async () => {
    snapshot.session.coordination = { role: "secretary" };
    snapshot.messages = [
      {
        id: "trusted-report",
        role: "system",
        createdAt: 3,
        completedAt: 3,
        parts: [{ type: "text", text: "工作任务「整理文档」已完成。" }],
      },
      {
        id: "ordinary-user-json",
        role: "user",
        createdAt: 4,
        completedAt: 4,
        parts: [
          {
            type: "text",
            text: '{"kind":"secretary_worker_report","note":"这是我提交的数据"}',
          },
        ],
      },
    ];
    snapshot.queuedMessages = [
      {
        id: "trusted-report-pending",
        text: "工作任务「核对安装」需要你回答。",
        attachments: [],
      },
    ];
    vi.mocked(agentApi.getSecretary).mockResolvedValue({
      sessionId: session.id,
      tasks: [],
    });
    render(<AgentPage />);
    await flush();
    const system = screen.getByRole("article", { name: "系统消息" });
    expect(system).toHaveTextContent("工作任务「整理文档」已完成。");
    expect(system).not.toHaveTextContent("secretary_worker_report");
    expect(screen.getByRole("article", { name: "你的消息" })).toHaveTextContent(
      "secretary_worker_report",
    );
    expect(screen.getByRole("article", { name: "你的消息" })).toHaveTextContent(
      "这是我提交的数据",
    );
    expect(
      screen.getByRole("region", { name: "待发送消息" }),
    ).toHaveTextContent("工作任务「核对安装」需要你回答。");
  });

  it("opens a requested secretary once after initialization without consuming the previous conversation draft", async () => {
    const consumed = vi.fn();
    const view = render(<AgentPage onSecretaryRequestConsumed={consumed} />);
    await flush();
    fill("留给原会话的草稿");
    view.rerender(
      <AgentPage
        secretaryRequest={{ requestId: 1 }}
        onSecretaryRequestConsumed={consumed}
      />,
    );
    await flush();
    expect(agentApi.openSecretary).toHaveBeenCalledTimes(1);
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Loli 秘书" }),
    ).toBeInTheDocument();
    expect(
      readAgentDraft(
        `lolicode.agent.draft:${encodeURIComponent(project)}:${encodeURIComponent(session.id)}`,
      ),
    ).toBe("留给原会话的草稿");
    view.rerender(
      <AgentPage
        secretaryRequest={{ requestId: 1 }}
        onSecretaryRequestConsumed={consumed}
      />,
    );
    await flush();
    expect(agentApi.openSecretary).toHaveBeenCalledTimes(1);
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it("binds a requested worker's project and verifies its secretary before opening the conversation", async () => {
    const target = "D:/fixture/secretary-project";
    const secretary: AgentSession = {
      ...session,
      id: "lc:target-secretary",
      title: "目标秘书",
      projectPath: target,
      coordination: { role: "secretary" },
    };
    const worker: AgentSession = {
      ...session,
      id: "lc:target-worker",
      title: "目标工作任务",
      projectPath: target,
      coordination: {
        role: "worker",
        parentSessionId: secretary.id,
        taskId: "target-task",
      },
    };
    const consumed = vi.fn();
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: structuredClone(
        id === worker.id ? worker : id === secretary.id ? secretary : session,
      ),
    }));
    vi.mocked(agentApi.openProject).mockResolvedValue({
      workspace: { path: target, name: "secretary-project" },
      catalog,
      sessions: [secretary, worker],
    });
    vi.mocked(agentApi.getSecretary).mockResolvedValue({
      sessionId: secretary.id,
      tasks: [],
    });
    render(
      <AgentPage
        secretaryRequest={{
          requestId: 2,
          projectPath: target,
          sessionId: secretary.id,
          workerSessionId: worker.id,
        }}
        onSecretaryRequestConsumed={consumed}
      />,
    );
    await flush();
    expect(agentApi.openProject).toHaveBeenCalledWith(target);
    expect(agentApi.getSession).toHaveBeenCalledWith(secretary.id);
    expect(
      screen.getByRole("heading", { name: "目标工作任务" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "秘书会话" })).getByRole(
        "button",
        { name: "总秘书" },
      ),
    ).toBeInTheDocument();
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(agentApi.openSecretary).not.toHaveBeenCalled();
  });

  it("rejects a requested worker from a different secretary before changing the workspace", async () => {
    const worker: AgentSession = {
      ...session,
      id: "lc:wrong-worker",
      coordination: {
        role: "worker",
        parentSessionId: "lc:someone-else",
        taskId: "wrong-task",
      },
    };
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: structuredClone(id === worker.id ? worker : session),
    }));
    const consumed = vi.fn();
    render(
      <AgentPage
        secretaryRequest={{
          requestId: 3,
          sessionId: "lc:expected",
          workerSessionId: worker.id,
        }}
        onSecretaryRequestConsumed={consumed}
      />,
    );
    await flush();
    expect(
      screen.getByRole("heading", { name: session.title }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "工作对话与指定秘书不一致",
    );
    expect(agentApi.openProject).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it("opens only the latest requested secretary when an older request finishes late", async () => {
    const oldSecretary: AgentSession = {
      ...session,
      id: "lc:old-secretary",
      title: "旧请求秘书",
      projectPath: "D:/fixture/old",
      coordination: { role: "secretary" },
    };
    const newSecretary: AgentSession = {
      ...session,
      id: "lc:new-secretary",
      title: "新请求秘书",
      projectPath: "D:/fixture/new",
      coordination: { role: "secretary" },
    };
    let finish!: (value: AgentSnapshot) => void;
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === oldSecretary.id
        ? await new Promise((resolve) => {
            finish = resolve;
          })
        : {
            ...emptySnapshot(),
            session: structuredClone(
              id === newSecretary.id ? newSecretary : session,
            ),
          },
    );
    vi.mocked(agentApi.openProject).mockResolvedValue({
      workspace: { path: newSecretary.projectPath, name: "new" },
      catalog,
      sessions: [newSecretary],
    });
    vi.mocked(agentApi.getSecretary).mockResolvedValue({
      sessionId: newSecretary.id,
      tasks: [],
    });
    const consumed = vi.fn();
    const view = render(
      <AgentPage
        secretaryRequest={{ requestId: 4, sessionId: oldSecretary.id }}
        onSecretaryRequestConsumed={consumed}
      />,
    );
    await flush();
    view.rerender(
      <AgentPage
        secretaryRequest={{ requestId: 5, sessionId: newSecretary.id }}
        onSecretaryRequestConsumed={consumed}
      />,
    );
    await flush();
    await act(async () =>
      finish({ ...emptySnapshot(), session: oldSecretary }),
    );
    await flush();
    expect(agentApi.openProject).toHaveBeenCalledTimes(1);
    expect(agentApi.openProject).toHaveBeenCalledWith(newSecretary.projectPath);
    expect(
      screen.getByRole("heading", { name: "新请求秘书" }),
    ).toBeInTheDocument();
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it("places the global secretary beside new conversation and uses its own workspace", async () => {
    snapshot.session.permissionMode = "ask";
    snapshot.session.reasoningEffort = "high";
    snapshot.session.contextLimit = 32000;
    render(<AgentPage />);
    await flush();
    const button = screen.getByRole("button", { name: "打开 Loli 秘书" });
    expect(button.previousElementSibling).toHaveClass("wb-create-task");
    fireEvent.click(button);
    await flush();
    expect(agentApi.openSecretary).toHaveBeenCalledWith(
      catalog.models[0].id,
      "ask",
      undefined,
      "D:/fixture/app/agent/standalone-workspace",
      undefined,
    );
    expect(
      screen.getByRole("heading", { name: "Loli 秘书" }),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("heading", { name: "Loli 秘书" }).closest("header")!,
      ).getAllByText("Loli 秘书"),
    ).toHaveLength(1);
    expect(
      screen.getByRole("region", { name: "工作任务" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "交办任务" })).toBeEnabled();
    expect(screen.getByText("今天有什么交给我？")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the same global secretary from different project workspaces", async () => {
    const standalone = "D:/fixture/app/agent/standalone-workspace";
    const other = "D:/fixture/other";
    vi.mocked(agentApi.openProject).mockImplementation(async (path) => ({
      workspace: { path, name: path === other ? "other" : "project" },
      catalog,
      sessions: [],
    }));
    const view = render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "打开 Loli 秘书" }));
    await flush();
    const first = structuredClone(snapshot.session);
    view.rerender(<AgentPage initialProjectPath={other} />);
    await flush();
    expect(agentApi.openProject).toHaveBeenCalledWith(other);
    fireEvent.click(screen.getByRole("button", { name: "打开 Loli 秘书" }));
    await flush();
    expect(vi.mocked(agentApi.openSecretary).mock.calls.map((call) => call[3]))
      .toEqual([standalone, standalone]);
    expect(snapshot.session.id).toBe(first.id);
    expect(screen.getByRole("heading", { name: "Loli 秘书" })).toBeInTheDocument();
  });

  it.each([false, true])(
    "opens ordinary project tasks instead of old secretaries on startup and project switches (saved secretary: %s)",
    async (savedSecretary) => {
      const other = "D:/fixture/other";
      const chief: AgentSession = {
        ...session,
        id: "lc:old-project-secretary",
        title: "旧项目秘书",
        coordination: { role: "secretary" },
      };
      const worker: AgentSession = {
        ...session,
        id: "lc:old-project-worker",
        coordination: {
          role: "worker",
          parentSessionId: chief.id,
          taskId: "old-task",
        },
      };
      const otherTask = {
        ...session,
        id: "other-task",
        title: "另一项目任务",
        projectPath: other,
      };
      const otherChief = {
        ...chief,
        id: "lc:other-secretary",
        projectPath: other,
      };
      vi.mocked(agentApi.listSessions).mockResolvedValue([chief, worker, session]);
      vi.mocked(agentApi.listProjects).mockResolvedValue([
        { path: project, name: "project", pinned: false, lastOpenedAt: 2 },
        { path: other, name: "other", pinned: false, lastOpenedAt: 1 },
      ]);
      vi.mocked(agentApi.openProject).mockResolvedValue({
        workspace: { path: other, name: "other" },
        catalog,
        sessions: [otherChief, otherTask],
      });
      const all = [chief, worker, session, otherChief, otherTask];
      vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
        ...emptySnapshot(),
        session: all.find((item) => item.id === id)!,
      }));
      if (savedSecretary)
        localStorage.setItem(
          "lolicode.agent.last-selection.v1",
          JSON.stringify({ projectPath: project, sessionId: chief.id }),
        );
      render(<AgentPage />);
      await flush();
      expect(
        screen.getByRole("heading", { name: session.title }),
      ).toBeInTheDocument();
      expect(agentApi.getSession).not.toHaveBeenCalledWith(chief.id);
      fireEvent.click(screen.getByRole("button", { name: "other" }));
      await flush();
      expect(
        screen.getByRole("heading", { name: otherTask.title }),
      ).toBeInTheDocument();
      expect(agentApi.getSession).not.toHaveBeenCalledWith(otherChief.id);
      expect(agentApi.openSecretary).not.toHaveBeenCalled();
    },
  );

  it("keeps secretaries and workers out of current, expanded, searched and archived workspace task lists", async () => {
    const other = "D:/fixture/other";
    const chief: AgentSession = {
      ...session,
      id: "lc:project-secretary",
      title: "项目总秘书",
      coordination: { role: "secretary" },
    };
    const worker: AgentSession = {
      ...session,
      id: "lc:project-worker",
      title: "项目后台任务",
      coordination: {
        role: "worker",
        parentSessionId: chief.id,
        taskId: "task-1",
      },
    };
    const archivedChief = {
      ...chief,
      id: "lc:archived-chief",
      title: "归档总秘书",
      archived: true,
    };
    const archivedWorker = {
      ...worker,
      id: "lc:archived-worker",
      title: "归档后台任务",
      archived: true,
    };
    const archivedTask = {
      ...session,
      id: "archived-task",
      title: "归档普通任务",
      archived: true,
    };
    const current = [
      chief,
      worker,
      session,
      archivedChief,
      archivedWorker,
      archivedTask,
    ];
    const otherSessions = [
      {
        ...chief,
        id: "lc:other-chief",
        title: "另一项目总秘书",
        projectPath: other,
      },
      {
        ...worker,
        id: "lc:other-worker",
        title: "另一项目后台任务",
        projectPath: other,
      },
      {
        ...session,
        id: "other-task",
        title: "另一项目普通任务",
        projectPath: other,
      },
    ];
    vi.mocked(agentApi.listProjects).mockResolvedValue([
      { path: project, name: "project", pinned: false, lastOpenedAt: 2 },
      { path: other, name: "other", pinned: false, lastOpenedAt: 1 },
    ]);
    vi.mocked(agentApi.listSessions).mockImplementation(
      async (path, includeArchived) =>
        (path === other ? otherSessions : current).filter(
          (item) => includeArchived || !item.archived,
        ),
    );
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "展开 other 的任务" }));
    await flush();
    const currentTasks = screen.getByRole("group", { name: "project 的任务" });
    const otherTasks = screen.getByRole("group", { name: "other 的任务" });
    expect(
      within(currentTasks).getByRole("button", { name: session.title }),
    ).toBeInTheDocument();
    expect(
      within(otherTasks).getByRole("button", { name: "另一项目普通任务" }),
    ).toBeInTheDocument();
    expect(currentTasks).not.toHaveTextContent("项目总秘书");
    expect(currentTasks).not.toHaveTextContent("项目后台任务");
    expect(otherTasks).not.toHaveTextContent("另一项目总秘书");
    expect(otherTasks).not.toHaveTextContent("另一项目后台任务");
    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), {
      target: { value: "秘书" },
    });
    expect(within(currentTasks).queryByRole("button")).toBeNull();
    expect(within(otherTasks).queryByRole("button")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "打开 Loli 秘书" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "清空会话搜索" }));
    fireEvent.click(screen.getByRole("button", { name: "显示归档会话" }));
    await flush();
    expect(
      within(currentTasks).getByRole("button", { name: archivedTask.title }),
    ).toBeInTheDocument();
    expect(currentTasks).not.toHaveTextContent(archivedChief.title);
    expect(currentTasks).not.toHaveTextContent(archivedWorker.title);
    expect(currentTasks).not.toHaveTextContent(session.title);
  });

  it("still sends a goal directly through the secretary chat", async () => {
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "打开 Loli 秘书" }));
    await flush();
    expect(
      screen.queryByRole("button", { name: "告诉秘书目标" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("任务名称")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("执行方式")).not.toBeInTheDocument();
    const goal = "整理项目文档，再核对安装步骤";
    fill(goal);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledWith(
      "lc:secretary",
      goal,
      expect.any(String),
      [],
      [],
    );
    expect(agentApi.delegateSecretaryTask).not.toHaveBeenCalled();
  });

  it("keeps archived secretary work visible without allowing new assignments", async () => {
    const archived: AgentSession = {
      ...session,
      id: "lc:archived-secretary",
      title: "归档秘书",
      archived: true,
      coordination: { role: "secretary" },
    };
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, archived]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: id === archived.id ? archived : session,
    }));
    vi.mocked(agentApi.getSecretary).mockResolvedValue({
      sessionId: archived.id,
      tasks: [],
    });
    render(
      <AgentPage secretaryRequest={{ requestId: 1, sessionId: archived.id }} />,
    );
    await flush();
    expect(screen.getByRole("heading", { name: "归档秘书" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "project 的任务" })).queryByRole(
        "button",
        { name: /^归档秘书/ },
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "工作任务" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "交办任务" }),
    ).not.toBeInTheDocument();
  });

  it("does not increase an unfamiliar current permission mode when opening the secretary", async () => {
    snapshot.session.permissionMode = "custom";
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "打开 Loli 秘书" }));
    await flush();
    expect(agentApi.openSecretary).toHaveBeenCalledWith(
      catalog.models[0].id,
      "ask",
      undefined,
      "D:/fixture/app/agent/standalone-workspace",
      undefined,
    );
  });

  it("restores the saved global secretary without listing it or its workers as workspace tasks", async () => {
    const standalone = "D:/fixture/app/agent/standalone-workspace";
    const secretary: AgentSession = {
      ...session,
      id: "lc:secretary",
      title: "Loli 秘书",
      projectPath: standalone,
      coordination: { role: "secretary" },
    };
    const worker: AgentSession = {
      ...session,
      id: "lc:worker",
      title: "后台分析任务",
      projectPath: standalone,
      coordination: {
        role: "worker",
        parentSessionId: secretary.id,
        taskId: "task-1",
      },
    };
    vi.mocked(agentApi.getStatus).mockResolvedValue({
      available: true,
      running: true,
      projectPath: standalone,
    });
    vi.mocked(agentApi.listProjects).mockResolvedValue([
      {
        path: standalone,
        name: "独立任务",
        standalone: true,
        pinned: false,
        lastOpenedAt: 2,
      },
    ]);
    localStorage.setItem(
      "lolicode.agent.last-selection.v1",
      JSON.stringify({ projectPath: standalone, sessionId: secretary.id }),
    );
    const independent = { ...session, projectPath: standalone };
    vi.mocked(agentApi.listSessions).mockResolvedValue([
      worker,
      secretary,
      independent,
    ]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: structuredClone(
        id === worker.id ? worker : id === secretary.id ? secretary : independent,
      ),
    }));
    render(<AgentPage />);
    await flush();
    expect(
      screen.getByRole("heading", { name: "Loli 秘书" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "后台分析任务" }),
    ).not.toBeInTheDocument();
    const tasks = within(screen.getByRole("group", { name: "独立任务 的任务" }));
    expect(tasks.queryByRole("button", { name: "Loli 秘书" })).toBeNull();
    expect(tasks.getByRole("button", { name: session.title })).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "打开 Loli 秘书" }),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "打开 Loli 秘书" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it.each([false, true])("switches between secretary and worker from the header without losing the draft (permissions locked: %s)", async (permissionLocked) => {
    const secretary: AgentSession = {
      ...session,
      id: "lc:secretary",
      title: "Loli 秘书",
      coordination: { role: "secretary" },
    };
    const worker: AgentSession = {
      ...session,
      id: "lc:worker",
      title: "后台分析任务",
      permissionMode: "ask",
      coordination: {
        role: "worker",
        parentSessionId: secretary.id,
        taskId: "task-1",
        permissionLocked,
      },
    };
    vi.mocked(agentApi.updateSession).mockImplementationOnce(async (_, patch) => {
      worker.permissionMode = patch.permissionMode;
      return structuredClone(worker);
    });
    vi.mocked(agentApi.listSessions).mockResolvedValue([
      secretary,
      worker,
      session,
    ]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: structuredClone(id === worker.id ? worker : secretary),
    }));
    vi.mocked(agentApi.getSecretary).mockResolvedValue({
      sessionId: secretary.id,
      tasks: [
        {
          id: "task-1",
          parentSessionId: secretary.id,
          sessionId: worker.id,
          title: "分析任务",
          instructions: "分析入口",
          status: "waiting_question",
          projectPath: project,
          requestId: "worker-request",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    render(
      <AgentPage secretaryRequest={{ requestId: 1, sessionId: secretary.id }} />,
    );
    await flush();
    fill("给秘书保留的补充要求");
    const lineage = within(screen.getByRole("navigation", { name: "秘书会话" }));
    expect(lineage.getByRole("button", { name: "总秘书" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: /^工作任务/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    let finishOpen!: (next: AgentSnapshot) => void;
    vi.mocked(agentApi.getSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    fireEvent.click(lineage.getByRole("button", { name: /^分析任务/ }));
    fireEvent.click(lineage.getByRole("button", { name: "总秘书" }));
    await act(async () => finishOpen({ ...emptySnapshot(), session: worker }));
    expect(screen.getByRole("heading", { name: "Loli 秘书" })).toBeInTheDocument();
    fireEvent.click(lineage.getByRole("button", { name: /^分析任务/ }));
    await flush();
    expect(
      screen.getByRole("heading", { name: "后台分析任务" }),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("heading", { name: "后台分析任务" }).closest("header")!,
      ).getByText("工作对话"),
    ).toBeInTheDocument();
    expect(lineage.getByRole("button", { name: /^分析任务/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.queryByRole("button", { name: "交办任务" }),
    ).not.toBeInTheDocument();
    const permission = within(openComposerOptions()).getByLabelText("执行权限");
    if (permissionLocked) {
      expect(permission).toBeDisabled();
      expect(agentApi.updateSession).not.toHaveBeenCalled();
    } else {
      expect(permission).toBeEnabled();
      fireEvent.change(permission, { target: { value: "full_access" } });
      await flush();
      expect(agentApi.updateSession).toHaveBeenCalledWith(worker.id, {
        permissionMode: "full_access",
      });
      expect(permission).toHaveValue("full_access");
    }
    fireEvent.click(lineage.getByRole("button", { name: "总秘书" }));
    await flush();
    expect(
      screen.getByRole("heading", { name: "Loli 秘书" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "给秘书保留的补充要求",
    );
  });

  it("does not enter a closed worker when its earlier tab navigation finishes late", async () => {
    const secretary: AgentSession = {
      ...session,
      id: "lc:secretary",
      title: "Loli 秘书",
      coordination: { role: "secretary" },
    };
    const worker: AgentSession = {
      ...session,
      id: "lc:finished-worker",
      title: "已完成的工作",
      coordination: {
        role: "worker",
        parentSessionId: secretary.id,
        taskId: "finished-task",
      },
    };
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session:
        id === worker.id ? worker : id === secretary.id ? secretary : session,
    }));
    vi.mocked(agentApi.getSecretary).mockResolvedValue({
      sessionId: secretary.id,
      tasks: [
        {
          id: "finished-task",
          parentSessionId: secretary.id,
          sessionId: worker.id,
          title: worker.title,
          instructions: "完成项目任务",
          status: "completed",
          projectPath: project,
          requestId: "finished-request",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    vi.mocked(agentApi.deleteSecretaryTask).mockImplementation(async () => {
      vi.mocked(agentApi.getSecretary).mockResolvedValue({
        sessionId: secretary.id,
        tasks: [],
      });
    });
    render(
      <AgentPage secretaryRequest={{ requestId: 1, sessionId: secretary.id }} />,
    );
    await flush();
    let finishOpen!: (next: AgentSnapshot) => void;
    vi.mocked(agentApi.getSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    const tabs = within(screen.getByRole("navigation", { name: "秘书会话" }));
    fireEvent.click(tabs.getByRole("button", { name: "已完成的工作 · 已完成" }));
    fireEvent.click(tabs.getByRole("button", { name: "关闭任务：已完成的工作" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "关闭任务" })).getByRole(
        "button",
        { name: "确认关闭" },
      ),
    );
    await flush();
    expect(agentApi.deleteSecretaryTask).toHaveBeenCalledWith(
      secretary.id,
      "finished-task",
    );
    await act(async () => finishOpen({ ...emptySnapshot(), session: worker }));
    await flush();
    expect(
      screen.getByRole("heading", { name: secretary.title }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: worker.title })).toBeNull();
    expect(tabs.queryByRole("button", { name: /^已完成的工作/ })).toBeNull();
  });

  it("preserves the current conversation and input if opening the secretary fails", async () => {
    vi.mocked(agentApi.openSecretary).mockRejectedValue(
      new Error("秘书暂时无法打开"),
    );
    render(<AgentPage />);
    await flush();
    fill("原会话尚未发送的要求");
    fireEvent.click(screen.getByRole("button", { name: "打开 Loli 秘书" }));
    await flush();
    expect(
      screen.getByRole("heading", { name: session.title }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "原会话尚未发送的要求",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("秘书暂时无法打开");
  });

  it("can open a secretary in the standalone workspace before a project is selected", async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({
      available: true,
      running: false,
    });
    const standalone = "D:/fixture/app/agent/standalone-workspace";
    vi.mocked(agentApi.openSecretary).mockImplementation(async () => {
      snapshot.session = {
        ...session,
        id: "lc:secretary",
        title: "Loli 秘书",
        projectPath: standalone,
        coordination: { role: "secretary" },
      };
      return structuredClone(snapshot.session);
    });
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "打开 Loli 秘书" }));
    await flush();
    expect(agentApi.openStandalone).toHaveBeenCalledTimes(1);
    expect(agentApi.openSecretary).toHaveBeenCalledWith(
      catalog.models[0].id,
      "ask",
      undefined,
      standalone,
      undefined,
    );
    expect(
      screen.getByRole("heading", { name: "Loli 秘书" }),
    ).toBeInTheDocument();
  });

  it("keeps development session synchronization out of the stable workbench", async () => {
    render(<AgentPage />);
    await flush();
    expect(
      screen.getByRole("heading", { name: session.title }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "同步会话" }),
    ).not.toBeInTheDocument();
  });
  it("reveals only fresh preview hints and reloads the same path for a new hint", async () => {
    const preview = vi.spyOn(agentFilesApi, "preview").mockResolvedValue({
      kind: "html",
      name: "index.html",
      path: "index.html",
      mimeType: "text/html",
      content: "<p>preview</p>",
      sizeBytes: 14,
      truncated: false,
    });
    try {
      snapshot.status = "running";
      snapshot.preview = {
        kind: "file",
        id: "historical-preview",
        sessionId: session.id,
        path: "old.html",
        createdAt: 3,
      };
      render(<AgentPage />);
      await flush();
      expect(preview).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("complementary", { name: "文件预览" }),
      ).not.toBeInTheDocument();

      snapshot.messages.push({
        id: "unverified-preview",
        role: "assistant",
        createdAt: 4,
        parts: [
          {
            type: "tool",
            id: "unverified-preview-tool",
            name: "open_preview",
            state: "completed",
            input: { path: "unverified.html" },
          },
        ],
      });
      await tick();
      expect(preview).not.toHaveBeenCalled();

      for (const createdAt of [5, 6]) {
        snapshot.preview = {
          kind: "file",
          id: `preview-${createdAt}`,
          sessionId: session.id,
          path: "index.html",
          createdAt,
        };
        await tick();
        expect(
          screen.getByRole("complementary", { name: "文件预览" }),
        ).toBeVisible();
      }
      fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
      await tick();
      snapshot.preview = {
        kind: "file",
        id: "older-unseen-preview",
        sessionId: session.id,
        path: "stale.html",
        createdAt: 4,
      };
      await tick();
      expect(
        screen.queryByRole("complementary", { name: "文件预览" }),
      ).not.toBeInTheDocument();
      expect(preview.mock.calls).toEqual([
        [session.id, "index.html"],
        [session.id, "index.html"],
      ]);
    } finally {
      preview.mockRestore();
    }
  });
  it("opens a native browser tool without polling and removes it on the matching close event", async () => {
    const frame = vi.spyOn(agentFilesApi, "browserFrame");
    const sync = vi.spyOn(agentFilesApi, "syncBrowserWebview").mockResolvedValue();
    snapshot.status = "running";
    const page = render(<AgentPage />);
    try {
      await flush();
      snapshot.preview = {
        kind: "browser",
        id: "tool-browser-preview",
        sessionId: session.id,
        browserId: "browser-tool-1",
        url: "https://example.test/page",
        native: true,
        createdAt: 3,
      };
      await tick();
      const panel = screen.getByRole("complementary", { name: "运行页面预览" });
      expect(
        panel.querySelector("[data-preview-carrier='native']"),
      ).toBeInTheDocument();
      expect(
        within(panel).getByRole("button", { name: "重新加载网页" }),
      ).toBeEnabled();
      await tick(1600);
      expect(frame).not.toHaveBeenCalled();
      act(() =>
        emitTauriEvent("agent-browser-preview-closed", {
          sessionId: "another-session",
          browserId: "browser-tool-1",
        }),
      );
      expect(panel).toBeVisible();
      act(() =>
        emitTauriEvent("agent-browser-preview-closed", {
          sessionId: session.id,
          browserId: "browser-tool-1",
        }),
      );
      expect(panel).not.toBeInTheDocument();
      snapshot.preview = {
        ...snapshot.preview,
        id: "delayed-browser-tool-hint",
      };
      await tick();
      expect(
        screen.queryByRole("complementary", { name: "运行页面预览" }),
      ).not.toBeInTheDocument();
    } finally {
      page.unmount();
      await flush();
      frame.mockRestore();
      sync.mockRestore();
    }
  });
  it("keeps the live browser mounted while folded and removes it only on close", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const frame = vi.spyOn(agentFilesApi, "browserFrame").mockResolvedValue(png);
    const close = vi.spyOn(agentFilesApi, "closeBrowser").mockResolvedValue();
    try {
      snapshot.status = "running";
      render(<AgentPage />);
      await flush();
      snapshot.preview = {
        kind: "browser",
        id: "browser-open-hint",
        sessionId: session.id,
        browserId: "browser-live",
        url: "http://127.0.0.1:8124/",
        deliveryId: "source-file-hint",
        createdAt: 3,
      };
      await tick();
      const panel = screen.getByRole("complementary", {
        name: "运行页面预览",
      });
      expect(
        within(panel).getByRole("img", { name: "本机开发页面画面" }),
      ).toHaveAttribute("src", png);
      expect(panel.querySelector("iframe")).toBeNull();
      expect(frame).toHaveBeenLastCalledWith(session.id, "browser-live");
      delete snapshot.preview;
      await tick(1600);
      expect(frame.mock.calls.length).toBeGreaterThan(1);
      expect(panel).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "收起文件预览" }));
      expect(panel).toBeInTheDocument();
      expect(panel).not.toBeVisible();
      const foldedCalls = frame.mock.calls.length;
      await tick(1600);
      expect(frame).toHaveBeenCalledTimes(foldedCalls);
      fireEvent.click(screen.getByRole("button", { name: "预览项目文件" }));
      await flush();
      expect(
        screen.getByRole("complementary", { name: "运行页面预览" }),
      ).toBe(panel);
      expect(frame).toHaveBeenCalledTimes(foldedCalls + 1);
      fireEvent.click(
        within(panel).getByRole("button", { name: "关闭页面预览" }),
      );
      expect(close).toHaveBeenCalledWith(session.id, "browser-live");
      snapshot.preview = {
        kind: "file",
        id: "source-file-hint",
        sessionId: session.id,
        path: "index.html",
        createdAt: 3,
      };
      const calls = frame.mock.calls.length;
      await tick(1600);
      expect(frame).toHaveBeenCalledTimes(calls);
      expect(panel).not.toBeInTheDocument();
      expect(
        screen.queryByRole("complementary", { name: "文件预览" }),
      ).not.toBeInTheDocument();
    } finally {
      frame.mockRestore();
      close.mockRestore();
    }
  });
  it("loads a worker's live browser in the secretary and falls back to its file after closing", async () => {
    const frame = vi.spyOn(agentFilesApi, "browserFrame");
    const sync = vi.spyOn(agentFilesApi, "syncBrowserWebview").mockResolvedValue();
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    const bounds = { x: 100, y: 80, width: 300, height: 260 };
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (!this.classList.contains("wb-browser-preview-stage"))
          return realRect.call(this);
        return new DOMRect(bounds.x, bounds.y, bounds.width, bounds.height);
      });
    const file = vi.spyOn(agentFilesApi, "preview").mockResolvedValue({
      kind: "html",
      name: "index.html",
      path: "index.html",
      mimeType: "text/html",
      content: "<p>worker preview</p>",
      sizeBytes: 21,
      truncated: false,
    });
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === session.id ? emptySnapshot() : structuredClone(snapshot),
    );
    const page = render(<AgentPage />);
    try {
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "打开 Loli 秘书" }));
      await flush();
      expect(
        screen.getByRole("heading", { name: "Loli 秘书" }),
      ).toBeInTheDocument();
      const workerFile = {
        kind: "file",
        id: "worker-file",
        sessionId: "lc:worker",
        path: "index.html",
        createdAt: 3,
      } as const;
      snapshot.preview = workerFile;
      await tick(5000);
      expect(file).toHaveBeenCalledWith("lc:worker", "index.html");
      snapshot.preview = {
        kind: "browser",
        id: "worker-browser",
        sessionId: "lc:worker",
        browserId: "browser-worker",
        url: "http://127.0.0.1:8124/",
        native: true,
        createdAt: 4,
      };
      await tick(5000);
      await tick(32);
      expect(sync).toHaveBeenCalledWith(
        "lc:worker",
        "browser-worker",
        bounds,
        false,
        expect.objectContaining({ slot: 0, revision: expect.any(Number) }),
      );
      expect(frame).not.toHaveBeenCalled();
      expect(
        screen.getByRole("complementary", { name: "运行页面预览" }),
      ).toBeVisible();
      act(() =>
        emitTauriEvent("agent-browser-preview-closed", {
          sessionId: "lc:worker",
          browserId: "browser-worker",
        }),
      );
      snapshot.preview = workerFile;
      await tick(5000);
      expect(
        screen.queryByRole("complementary", { name: "运行页面预览" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("complementary", { name: "文件预览" }),
      ).toBeVisible();
      expect(file.mock.calls).toEqual([
        ["lc:worker", "index.html"],
        ["lc:worker", "index.html"],
      ]);
      const panel = screen.getByRole("complementary", { name: "文件预览" });
      fireEvent.click(screen.getByRole("button", { name: session.title }));
      await flush();
      snapshot.preview = {
        ...workerFile,
        id: "unselected-worker-file",
        createdAt: 5,
      };
      act(() => emitTauriEvent("agent-session-update", {
        type: "changed", sessionId: snapshot.session.id,
      }));
      await tick(5000);
      expect(
        screen.queryByRole("complementary", { name: "文件预览" }),
      ).not.toBeInTheDocument();
      expect(panel).toBeInTheDocument();
      expect(panel).not.toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "打开 Loli 秘书" }));
      await flush();
      await tick(40);
      expect(
        screen.getByRole("complementary", { name: "文件预览" }),
      ).not.toBe(panel);
      expect(file).toHaveBeenCalledTimes(3);
    } finally {
      page.unmount();
      await flush();
      frame.mockRestore();
      file.mockRestore();
      rect.mockRestore();
      sync.mockRestore();
    }
  });
  it("retains independent browser tabs, including a delayed open, alongside the file preview", async () => {
    const url = "http://127.0.0.1:8124/delivery";
    const slowUrl = "https://example.com/slow";
    snapshot.messages = [
      {
        id: "output",
        role: "assistant",
        createdAt: 3,
        parts: [
          {
            type: "text",
            text: `[交付文件](docs/report.md) · [较早点击的链接](${slowUrl}) · ${url}`,
          },
        ],
      },
    ];
    const windows = vi.spyOn(platform, "isWindows").mockReturnValue(true);
    const file = vi.spyOn(agentFilesApi, "preview").mockResolvedValue({
      path: "docs/report.md",
      name: "report.md",
      kind: "text",
      content: "Fixture report",
      mimeType: "text/plain",
      sizeBytes: 14,
      truncated: false,
    });
    const browserReceipt = {
      kind: "browser",
      id: "output-browser",
      sessionId: session.id,
      browserId: "output-browser",
      url,
      createdAt: 4,
      native: true,
    } as const;
    let completeSlow!: (
      page: Awaited<ReturnType<typeof agentFilesApi.openBrowser>>,
    ) => void;
    const open = vi
      .spyOn(agentFilesApi, "openBrowser")
      .mockImplementationOnce(
        () => new Promise((resolve) => { completeSlow = resolve; }),
      )
      .mockResolvedValue(browserReceipt);
    const close = vi.spyOn(agentFilesApi, "closeBrowser").mockResolvedValue();
    const sync = vi.spyOn(agentFilesApi, "syncBrowserWebview").mockResolvedValue();
    const external = vi.spyOn(desktopSettingsApi, "openExternal").mockResolvedValue();
    const page = render(<AgentPage />);
    try {
      await flush();
      fireEvent.click(
        screen.getByRole("button", { name: "预览文件：docs/report.md" }),
      );
      await flush();
      expect(file).toHaveBeenCalledWith(session.id, "docs/report.md");

      fireEvent.keyDown(
        screen.getByRole("button", { name: `打开方式：${url}` }),
        { key: "Enter" },
      );
      fireEvent.click(
        screen.getByRole("menuitem", { name: "在系统浏览器中打开" }),
      );
      expect(external).toHaveBeenCalledWith(url);
      expect(open).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("link", { name: "较早点击的链接" }));
      fireEvent.click(screen.getByRole("link", { name: url }));
      await flush();
      expect(open).toHaveBeenCalledWith(session.id, url);
      const browser = screen.getByRole("complementary", {
        name: "运行页面预览",
      });
      completeSlow({
        ...browserReceipt,
        id: "late-browser",
        browserId: "late-browser",
        url: slowUrl,
      });
      await flush();
      expect(close).not.toHaveBeenCalled();
      expect(
        within(browser).getByRole("textbox", { name: "网页地址" }),
      ).toHaveValue(url);
      const tabs = screen.getByRole("tablist", { name: "右侧栏标签" });
      const later = within(tabs).getByRole("tab", { name: url });
      const earlier = within(tabs).getByRole("tab", { name: slowUrl });
      expect(later).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(later, { key: "ArrowLeft" });
      expect(earlier).toHaveFocus();
      expect(later).toHaveAttribute("aria-selected", "true");

      fireEvent.click(within(tabs).getByRole("tab", { name: "report.md" }));
      expect(screen.getByRole("complementary", { name: "文件预览" })).toBeVisible();
      expect(browser).not.toBeVisible();
      fireEvent.click(later);
      expect(browser).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "收起文件预览" }));
      expect(browser).not.toBeVisible();
      expect(close).not.toHaveBeenCalledWith(session.id, "output-browser");
      fireEvent.click(screen.getByRole("button", { name: "预览项目文件" }));
      expect(browser).toBeVisible();
      fireEvent.click(
        within(browser).getByRole("button", { name: "关闭页面预览" }),
      );
      expect(close).toHaveBeenCalledWith(session.id, "output-browser");
      expect(screen.getByRole("textbox", { name: "网页地址" })).toHaveValue(slowUrl);
      expect(close).not.toHaveBeenCalledWith(session.id, "late-browser");
      fireEvent(earlier, new MouseEvent("auxclick", { button: 1, bubbles: true }));
      expect(close).toHaveBeenCalledWith(session.id, "late-browser");
      expect(screen.getByRole("complementary", { name: "文件预览" })).toBeVisible();
    } finally {
      page.unmount();
      await flush();
      windows.mockRestore();
      file.mockRestore();
      open.mockRestore();
      close.mockRestore();
      sync.mockRestore();
      external.mockRestore();
    }
  });

  it("restores split tabs and their active selection without navigating a saved browser", async () => {
    const url = "https://example.test/restorable";
    snapshot.messages = [{
      id: "dock-output",
      role: "assistant",
      createdAt: 3,
      parts: [{ type: "text", text: "[交付文件](docs/report.md)" }],
    }];
    const windows = vi.spyOn(platform, "isWindows").mockReturnValue(true);
    const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(1280);
    const preview = vi.spyOn(agentFilesApi, "preview").mockResolvedValue({
      path: "docs/report.md", name: "report.md", kind: "text", content: "saved document",
      mimeType: "text/plain", sizeBytes: 14, truncated: false,
    });
    const open = vi.spyOn(agentFilesApi, "openBrowser").mockResolvedValue({
      kind: "browser", id: "dock-browser", sessionId: session.id,
      browserId: "dock-browser", url, createdAt: 4, native: true,
    });
    const close = vi.spyOn(agentFilesApi, "closeBrowser").mockResolvedValue();
    const sync = vi.spyOn(agentFilesApi, "syncBrowserWebview").mockResolvedValue();
    const left = () => screen.getByRole("tablist", { name: "左侧分屏标签" });
    const right = () => screen.getByRole("tablist", { name: "右侧分屏标签" });
    let page = render(<AgentPage />);
    try {
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "预览文件：docs/report.md" }));
      fireEvent.click(screen.getByRole("button", { name: "分屏" }));
      const rightHeader = right().parentElement!;
      fireEvent.click(within(rightHeader).getByRole("button", { name: "新建浏览器标签" }));
      const address = screen.getByRole("textbox", { name: "网页地址" });
      fireEvent.change(address, { target: { value: url } });
      fireEvent.click(screen.getByRole("button", { name: "前往网页地址" }));
      await flush();
      expect(open).toHaveBeenCalledWith(session.id, url);
      expect(within(left()).getByRole("tab", { name: "report.md" })).toHaveAttribute("aria-selected", "true");
      expect(within(right()).getByRole("tab", { name: url })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("complementary", { name: "文件预览" })).toBeVisible();
      expect(screen.getByRole("complementary", { name: "运行页面预览" })).toBeVisible();
      fireEvent.keyDown(screen.getByRole("separator", { name: "调整右栏分屏宽度" }), { key: "ArrowLeft" });
      const splitWidth = screen.getByRole("separator", { name: "调整右栏分屏宽度" }).getAttribute("aria-valuenow");
      page.unmount();
      await flush();
      open.mockClear();

      page = render(<AgentPage />);
      await flush();
      expect(within(left()).getByRole("tab", { name: "report.md" })).toBeVisible();
      expect(within(right()).getByRole("tab", { name: url })).toBeVisible();
      expect(screen.getByRole("separator", { name: "调整右栏分屏宽度" })).toHaveAttribute("aria-valuenow", splitWidth);
      expect(screen.getByRole("textbox", { name: "网页地址" })).toHaveValue(url);
      expect(open).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "恢复页面" }));
      await flush();
      expect(open).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith(session.id, url);
    } finally {
      page.unmount();
      await flush();
      windows.mockRestore();
      width.mockRestore();
      preview.mockRestore();
      open.mockRestore();
      close.mockRestore();
      sync.mockRestore();
    }
  });

  it("opens a blank browser from Ctrl+T and navigates in the same native tab", async () => {
    const windows = vi.spyOn(platform, "isWindows").mockReturnValue(true);
    const open = vi.spyOn(agentFilesApi, "openBrowser").mockResolvedValue({
      kind: "browser",
      id: "blank-result",
      sessionId: session.id,
      browserId: "blank-result",
      url: "https://example.test/",
      createdAt: 4,
      native: true,
    });
    const navigate = vi.spyOn(agentFilesApi, "navigateBrowser").mockResolvedValue();
    const close = vi.spyOn(agentFilesApi, "closeBrowser").mockResolvedValue();
    const sync = vi.spyOn(agentFilesApi, "syncBrowserWebview").mockResolvedValue();
    const frame = vi.spyOn(agentFilesApi, "browserFrame");
    const page = render(<AgentPage />);
    try {
      await flush();
      fireEvent.keyDown(window, { key: "t", ctrlKey: true });
      const address = screen.getByRole("textbox", { name: "网页地址" });
      const go = screen.getByRole("button", { name: "前往网页地址" });
      expect(address).toHaveFocus();
      expect(open).not.toHaveBeenCalled();
      fireEvent.change(address, { target: { value: "file:///private.txt" } });
      fireEvent.click(go);
      expect(screen.getByRole("alert")).toHaveTextContent("HTTP 或 HTTPS");
      expect(open).not.toHaveBeenCalled();
      fireEvent.change(address, { target: { value: "example.test" } });
      fireEvent.click(go);
      await flush();
      expect(open).toHaveBeenCalledWith(session.id, "https://example.test/");
      expect(screen.getByRole("textbox", { name: "网页地址" })).toBe(address);
      expect(address).toHaveValue("https://example.test/");
      fireEvent.change(address, { target: { value: "http://localhost:8124/settings" } });
      fireEvent.click(go);
      await flush();
      expect(navigate).toHaveBeenCalledWith(session.id, "blank-result", {
        url: "http://localhost:8124/settings",
      });
      expect(open).toHaveBeenCalledTimes(1);
      expect(frame).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      page.unmount();
      await flush();
      windows.mockRestore();
      open.mockRestore();
      navigate.mockRestore();
      close.mockRestore();
      sync.mockRestore();
      frame.mockRestore();
    }
  });

  it("keeps a separate right preview and folded state for each conversation", async () => {
    const other = { ...session, id: "other-preview", title: "另一会话", updatedAt: 1 };
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, other]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...structuredClone(snapshot),
      session: id === other.id ? other : session,
    }));
    const preview = vi.spyOn(agentFilesApi, "preview").mockImplementation(
      async (_id, path) => ({
        path,
        name: path,
        kind: "text",
        content: path,
        mimeType: "text/plain",
        sizeBytes: 1,
        truncated: false,
      }),
    );
    const openFile = async (path: string) => {
      fireEvent.click(screen.getByRole("button", { name: "预览项目文件" }));
      const panel = screen.getByRole("complementary", { name: "文件预览" });
      fireEvent.change(within(panel).getByLabelText("预览文件路径"), {
        target: { value: path },
      });
      fireEvent.click(within(panel).getByRole("button", { name: "预览" }));
      await flush();
    };
    try {
      render(<AgentPage />);
      await flush();
      await openFile("first.txt");
      fireEvent.click(screen.getByRole("button", { name: "收起文件预览" }));
      fireEvent.click(screen.getByRole("button", { name: other.title }));
      await flush();
      await openFile("second.txt");
      expect(preview).toHaveBeenLastCalledWith(other.id, "second.txt");

      fireEvent.click(screen.getByRole("button", { name: session.title }));
      await flush();
      expect(screen.queryByRole("complementary", { name: "文件预览" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "预览项目文件" }));
      expect(screen.getByRole("textbox", { name: "预览文件路径" })).toHaveValue("first.txt");
      fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));

      fireEvent.click(screen.getByRole("button", { name: other.title }));
      await flush();
      expect(screen.getByRole("textbox", { name: "预览文件路径" })).toHaveValue("second.txt");
    } finally {
      preview.mockRestore();
    }
  });

  it("opens a preview that arrived while a previously viewed conversation was in the background", async () => {
    const other = { ...session, id: "other-background", title: "背景预览对话", updatedAt: 1 };
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, other]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === other.id ? { ...emptySnapshot(), session: other } : structuredClone(snapshot),
    );
    const preview = vi.spyOn(agentFilesApi, "preview").mockResolvedValue({
      path: "result.html",
      name: "result.html",
      kind: "html",
      content: "<p>result</p>",
      mimeType: "text/html",
      sizeBytes: 13,
      truncated: false,
    });
    try {
      render(<AgentPage />);
      await flush();
      fireEvent.click(screen.getByRole("button", { name: other.title }));
      await flush();
      snapshot.preview = {
        kind: "file", id: "background-result", sessionId: session.id,
        path: "result.html", createdAt: 3,
      };
      act(() => emitTauriEvent("agent-session-update", {
        type: "changed", sessionId: session.id,
      }));
      fireEvent.click(screen.getByRole("button", { name: session.title }));
      await flush();
      await tick(40);
      expect(screen.getByRole("complementary", { name: "文件预览" })).toBeVisible();
      expect(preview).toHaveBeenLastCalledWith(session.id, "result.html");
    } finally {
      preview.mockRestore();
    }
  });

  it("keeps session status and file preview in the titlebar while preserving the composer", async () => {
    const view = render(<AgentPage />);
    await flush();
    fill("打开文件预览时保留的草稿");
    const header = screen
      .getByRole("heading", { name: session.title })
      .closest("header")!;
    expect(header).toHaveClass("wb-titlebar");
    expect(within(header).queryByRole("status")).not.toBeInTheDocument();
    expect(within(header).getByRole("heading")).toHaveAttribute(
      "title",
      session.title,
    );
    expect(
      within(header).getByRole("button", {
        name: `打开项目文件夹：${project}`,
      }),
    ).toBeEnabled();
    expect(
      within(header).getByRole("button", { name: "对话更多选项" }),
    ).toBeEnabled();
    expect(
      within(header).queryByText("DeepSeek · Code Model"),
    ).not.toBeInTheDocument();
    expect(view.container.querySelector(".wb-context-line")).toBeNull();
    expect(screen.getByRole("button", { name: "模型" })).toBeEnabled();
    expect(
      within(header).getByRole("button", { name: "预览项目文件" }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(
      within(header).getByRole("button", { name: "预览项目文件" }),
    );
    await flush();
    const panel = screen.getByRole("complementary", { name: "文件预览" });
    expect(panel).toBeVisible();
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "预览文件路径" }),
      { target: { value: "saved-preview-path.html" } },
    );
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "打开文件预览时保留的草稿",
    );
    const collapsePreview = within(header).getByRole("button", {
      name: "收起文件预览",
    });
    expect(collapsePreview).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapsePreview);
    expect(
      screen.queryByRole("complementary", { name: "文件预览" }),
    ).not.toBeInTheDocument();
    expect(panel).toBeInTheDocument();
    expect(panel).not.toBeVisible();
    fireEvent.click(
      within(header).getByRole("button", { name: "预览项目文件" }),
    );
    await flush();
    expect(screen.getByRole("complementary", { name: "文件预览" })).toBe(
      panel,
    );
    expect(
      within(panel).getByRole("textbox", { name: "预览文件路径" }),
    ).toHaveValue("saved-preview-path.html");
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(
      screen.queryByRole("complementary", { name: "文件预览" }),
    ).not.toBeInTheDocument();
    expect(panel).not.toBeInTheDocument();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps help, logs and updates reachable from the titlebar more menu", async () => {
    const onCheckUpdate = vi.fn();
    const onOpenAbout = vi.fn();
    render(
      <AgentPage onCheckUpdate={onCheckUpdate} onOpenAbout={onOpenAbout} />,
    );
    await flush();
    const openMore = async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "对话更多选项" }), {
        key: "Enter",
      });
      await flush();
    };
    await openMore();
    for (const name of [
      "产品文档",
      "用户社群",
      "问题上报",
      "报告安全漏洞",
      "提出产品需求",
      "查看应用日志",
      "检查更新",
      "关于 LoliCode",
    ])
      expect(screen.getByRole("menuitem", { name })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
    fireEvent.click(screen.getByRole("menuitem", { name: "查看应用日志" }));
    await flush();
    expect(settingsApi.revealAppLogFile).toHaveBeenCalledOnce();
    await openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "检查更新" }));
    expect(onCheckUpdate).toHaveBeenCalledOnce();
    await openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "关于 LoliCode" }));
    expect(onOpenAbout).toHaveBeenCalledOnce();
    await openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "产品文档" }));
    await flush();
    expect(settingsApi.openExternal).toHaveBeenCalledWith(
      "https://tools.treasuregrove.art/lolicode/",
    );
    await tick(1);
  });

  it.each([false, true])(
    "keeps one collapse control and restores keyboard focus with tool panel %s",
    async (toolOpen) => {
      render(
        <AgentPage
          toolRequest={toolOpen ? { tool: "skills", id: 1 } : undefined}
          renderSidebar={({ onCollapse, actions, workspace }) => (
            <>
              <button type="button" onClick={onCollapse}>
                收起侧栏
              </button>
              {actions}
              {workspace}
            </>
          )}
        />,
      );
      await flush();
      const collapse = screen.getByRole("button", { name: "收起侧栏" });
      expect(
        screen.queryByRole("button", { name: "收起项目侧栏" }),
      ).not.toBeInTheDocument();
      collapse.focus();
      fireEvent.click(collapse);
      await flush();
      await tick(20);
      const scope = toolOpen
        ? within(screen.getByRole("region", { name: "技能与插件" }))
        : screen;
      const expand = scope.getByRole("button", { name: "展开项目侧栏" });
      expect(expand).toHaveFocus();
      fireEvent.click(expand);
      await flush();
      expect(
        scope.queryByRole("button", { name: "展开项目侧栏" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "收起侧栏" })).toBeVisible();
      if (toolOpen) {
        fireEvent.click(scope.getByRole("button", { name: "返回工作台" }));
        await flush();
        await tick(250);
      }
    },
  );

  it("keeps new tasks, secretary and searchable sessions reachable in the compact sidebar", async () => {
    render(
      <AgentPage
        sidebarCompact
        onSidebarCompactChange={vi.fn()}
        renderSidebar={({ actions, workspace }) => (
          <>
            {actions}
            {workspace}
          </>
        )}
      />,
    );
    await flush();
    expect(screen.getByRole("button", { name: "新建任务" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "打开 Loli 秘书" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("textbox", { name: "搜索会话" }),
    ).not.toBeInTheDocument();
    const sessions = screen.getByRole("button", { name: "项目与会话" });
    fireEvent.click(sessions);
    await flush();
    const popup = screen.getByRole("dialog", { name: "项目与会话" });
    const search = within(popup).getByRole("textbox", { name: "搜索会话" });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Escape" });
    await flush();
    await tick(1);
    expect(
      screen.queryByRole("dialog", { name: "项目与会话" }),
    ).not.toBeInTheDocument();
    expect(sessions).toHaveFocus();
    fireEvent.click(sessions);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "打开 Loli 秘书" }));
    await flush();
    expect(agentApi.openSecretary).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("dialog", { name: "项目与会话" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    [false, "project", "resize"],
    [true, "project", "resize"],
    [false, "session", "resize"],
    [true, "session", "resize"],
    [false, "delete", "resize"],
    [true, "delete", "resize"],
    [false, "project", "keyboard"],
    [true, "project", "keyboard"],
    [false, "session", "keyboard"],
    [true, "session", "keyboard"],
    [false, "delete", "keyboard"],
    [true, "delete", "keyboard"],
  ] as const)(
    "preserves the %s compact sidebar's %s dialog across %s layout changes",
    async (initiallyCompact, operation, change) => {
      vi.stubGlobal(
        "innerWidth",
        change === "resize" && initiallyCompact ? 800 : 1100,
      );
      function SidebarDialogFixture() {
        const [compact, setCompact] = useState(
          change === "keyboard" && initiallyCompact,
        );
        // Use the app's shared split layout without starting unrelated preview
        // animations in this fake-clock test.
        const layout = useAgentPaneLayout({
          sidebarVisible: true,
          sidebarCompact: compact,
          sidebarAutoCompact: true,
          previewVisible: true,
        });
        return (
          <AgentPage
            sharedPaneLayout={layout}
            sidebarCompact={compact}
            onSidebarCompactChange={setCompact}
            renderSidebar={({ actions, workspace }) => (
              <>
                {actions}
                {workspace}
              </>
            )}
          />
        );
      }
      try {
        render(<SidebarDialogFixture />);
        await flush();
        if (initiallyCompact) {
          fireEvent.click(screen.getByRole("button", { name: "项目与会话" }));
          await flush();
        }
        fireEvent.keyDown(
          screen.getByRole("button", {
            name:
              operation === "project"
                ? "管理项目：project"
                : `管理会话：${session.title}`,
          }),
          { key: "Enter" },
        );
        await flush();
        fireEvent.click(
          screen.getByRole("menuitem", {
            name:
              operation === "project"
                ? "重命名项目"
                : operation === "session"
                  ? "重命名"
                  : "删除会话",
          }),
        );
        await flush();
        await tick(1);
        const dialog = screen.getByRole("dialog", {
          name:
            operation === "project"
              ? "重命名项目"
              : operation === "session"
                ? "重命名会话"
                : "删除会话",
        });
        const input =
          operation === "delete" ? null : within(dialog).getByRole("textbox");
        if (input)
          fireEvent.change(input, {
            target: { value: "Keep this unsaved name" },
          });

        if (change === "resize") {
          vi.stubGlobal("innerWidth", initiallyCompact ? 1100 : 800);
          fireEvent(window, new Event("resize"));
        } else {
          fireEvent.keyDown(input ?? dialog, { key: "\\", ctrlKey: true });
        }
        await flush();
        expect(dialog).toBeInTheDocument();
        if (input) expect(input).toHaveValue("Keep this unsaved name");

        fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
        await flush();
        await tick(1);
        expect(dialog).not.toBeInTheDocument();
        if (initiallyCompact) {
          expect(
            screen.getByRole("textbox", { name: "搜索会话" }),
          ).toBeInTheDocument();
          expect(
            screen.queryByRole("button", { name: "项目与会话" }),
          ).not.toBeInTheDocument();
        } else {
          expect(
            screen.getByRole("button", { name: "项目与会话" }),
          ).toBeInTheDocument();
          expect(
            screen.queryByRole("textbox", { name: "搜索会话" }),
          ).not.toBeInTheDocument();
        }
        expect(agentApi.renameProject).not.toHaveBeenCalled();
        expect(agentApi.renameSession).not.toHaveBeenCalled();
        expect(agentApi.deleteSession).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("restores an automatically hidden sidebar when a narrow-window preview is open", async () => {
    vi.stubGlobal("innerWidth", 620);
    try {
      render(<AgentPage />);
      await flush();
      expect(
        screen.getByRole("complementary", { name: "项目会话" }),
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "预览项目文件" }));
      await flush();
      const preview = screen.getByRole("complementary", { name: "文件预览" });
      expect(
        screen.queryByRole("complementary", { name: "项目会话" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "展开项目侧栏" }));
      await flush();
      expect(
        screen.getByRole("complementary", { name: "项目会话" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("complementary", { name: "文件预览" }),
      ).not.toBeInTheDocument();
      expect(preview).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "预览项目文件" }));
      expect(screen.getByRole("complementary", { name: "文件预览" })).toBe(
        preview,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not expose session status or file preview before creating a conversation", async () => {
    vi.mocked(agentApi.listSessions).mockResolvedValue([]);
    render(<AgentPage />);
    await flush();
    const header = screen
      .getByRole("heading", { name: "编程工作台" })
      .closest("header")!;
    expect(within(header).queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "预览项目文件" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "文件预览" }),
    ).not.toBeInTheDocument();
  });

  it("opens session usage from the composer and restores focus with Escape", async () => {
    snapshot.usage = {
      session: {
        totalTokens: 1200,
        inputTokens: 1000,
        outputTokens: 200,
        cacheHitRate: 0.5,
        modelRequests: 2,
        reportedRequests: 2,
        since: 1,
        complete: true,
      },
    };
    render(<AgentPage />);
    await flush();
    fill("查看用量时保留输入");
    const trigger = screen.getByRole("button", { name: "查看会话用量" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("本会话用量")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const usage = screen.getByRole("dialog", { name: "本会话用量" });
    expect(
      within(usage).getByRole("heading", { name: "本会话用量" }),
    ).toBeVisible();
    expect(usage).toHaveTextContent("会话用量 1.2K tokens");
    expect(usage).toHaveTextContent("缓存命中 50.0%");
    fireEvent.keyDown(usage, { key: "Escape" });
    await flush();
    await tick(1);
    expect(
      screen.queryByRole("dialog", { name: "本会话用量" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "查看用量时保留输入",
    );
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the composer compact with permissions visible before opening settings", async () => {
    snapshot.session.permissionMode = "full_access";
    render(<AgentPage />);
    await flush();
    const options = screen.getByRole("button", { name: "对话设置" });
    expect(options).toHaveTextContent("完整权限");
    expect(options).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "添加内容" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "模型" })).toBeEnabled();
    expect(screen.queryByLabelText("执行权限")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "思考档位" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "上下文窗口" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toHaveTextContent(
      "发送",
    );

    fireEvent.click(options);
    const settings = screen.getByRole("dialog", { name: "对话设置" });
    expect(within(settings).getByText("推理强度")).toBeVisible();
    expect(within(settings).getByText("上下文容量")).toBeVisible();
    expect(within(settings).getByLabelText("执行权限")).toHaveValue(
      "full_access",
    );
    fireEvent.change(within(settings).getByLabelText("执行权限"), {
      target: { value: "ask" },
    });
    await flush();
    fireEvent.click(options);
    expect(options).toHaveTextContent("逐次确认");
    expect(
      screen.queryByRole("dialog", { name: "对话设置" }),
    ).not.toBeInTheDocument();
    expect(agentApi.updateSession).toHaveBeenCalledWith(session.id, {
      permissionMode: "ask",
    });
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("lets the user replace an old Harness permission placeholder", async () => {
    snapshot.session.permissionMode = "harness_workspace";
    render(<AgentPage />);
    await flush();
    expect(screen.getByRole("button", { name: "对话设置" })).toHaveTextContent(
      "逐次确认",
    );
    const select = composerPermissionSelect();
    expect(select).toBeEnabled();
    expect(select).toHaveValue("ask");
    expect(within(select).getAllByRole("option")).toHaveLength(3);

    fireEvent.change(select, { target: { value: "auto" } });
    await flush();
    expect(agentApi.updateSession).toHaveBeenCalledWith(session.id, {
      permissionMode: "auto",
    });
    expect(composerPermissionSelect()).toHaveValue("auto");
  });

  it("dismisses nested settings one level at a time and restores keyboard focus", async () => {
    render(<AgentPage />);
    await flush();
    fill("设置关闭后继续写的草稿");
    const options = screen.getByRole("button", { name: "对话设置" });
    fireEvent.click(options);
    const reasoning = screen.getByRole("button", { name: "思考档位" });
    fireEvent.click(reasoning);
    expect(screen.getByRole("dialog", { name: "对话设置" })).toBeVisible();
    const nested = screen.getByRole("dialog", { name: "选择思考档位" });
    fireEvent.keyDown(nested, { key: "Escape" });
    await flush();
    await tick(1);
    expect(
      screen.queryByRole("dialog", { name: "选择思考档位" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "对话设置" })).toBeVisible();
    expect(reasoning).toHaveFocus();
    fireEvent.keyDown(reasoning, { key: "Escape" });
    await flush();
    await tick(1);
    expect(
      screen.queryByRole("dialog", { name: "对话设置" }),
    ).not.toBeInTheDocument();
    expect(options).toHaveFocus();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "设置关闭后继续写的草稿",
    );
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("opens images, documents and the plugin market from the add-content menu", async () => {
    const view = render(<AgentPage />);
    await flush();
    const input =
      view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const chooseImages = vi.spyOn(input, "click");
    const openAddMenu = async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "添加内容" }), {
        key: "Enter",
      });
      await flush();
    };
    await openAddMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "添加图片" }));
    await flush();
    expect(chooseImages).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await openAddMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "添加文档" }));
    await flush();
    expect(openFileDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "添加文档", multiple: true }),
    );
    await openAddMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "管理插件" }));
    await flush();
    await tick(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "技能与插件" });
    expect(within(panel).getByRole("tab", { name: "插件" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(document.activeElement).toBe(panel);
    fireEvent.click(within(panel).getByRole("button", { name: "返回工作台" }));
    await flush();
    await tick(250);
    expect(
      screen.queryByRole("region", { name: "技能与插件" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toBeEnabled();
    chooseImages.mockRestore();
  });

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
    await tick(250);
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
      expect(
        document.querySelector<HTMLElement>(".wb-chat-surface")?.inert,
      ).toBe(true);
      expect(changed).toHaveBeenLastCalledWith(tool);
    }

    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    await flush();
    expect(
      screen.queryByRole("region", { name: "记忆" }),
    ).not.toBeInTheDocument();
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(
      document.querySelector<HTMLElement>(".wb-chat-surface")?.inert,
    ).not.toBe(true);
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

  it.each([
    ["skills", "plugins", "插件", "技能"],
    ["workflows", "automation", "自动化", "工作流"],
  ] as const)(
    "opens the %s shortcut on its requested %s tab",
    async (tool, initialTab, selected, other) => {
      render(<AgentPage toolRequest={{ tool, initialTab, id: 1 }} />);
      await flush();
      expect(screen.getByRole("tab", { name: selected })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByRole("tab", { name: other })).toHaveAttribute(
        "aria-selected",
        "false",
      );
    },
  );

  it("opens a new automation conversation with an unsent draft and leaves the source conversation alone", async () => {
    snapshot.status = "running";
    snapshot.session.permissionMode = "auto";
    snapshot.session.reasoningEffort = "high";
    snapshot.session.contextLimit = 64000;
    const designSession: AgentSession = {
      ...structuredClone(snapshot.session),
      id: "lc:automation-design-kickoff",
      title: "设计自动化",
      createdAt: 3,
      updatedAt: 3,
    };
    let created = false;
    vi.mocked(agentApi.createSession).mockImplementation(async () => {
      created = true;
      return structuredClone(designSession);
    });
    vi.mocked(agentApi.listSessions).mockImplementation(async () =>
      created
        ? [structuredClone(designSession), structuredClone(snapshot.session)]
        : [structuredClone(snapshot.session)],
    );
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === designSession.id
        ? {
            ...emptySnapshot(),
            session: structuredClone(designSession),
          }
        : structuredClone(snapshot),
    );
    const view = render(<AgentPage />);
    await flush();
    fill("原运行会话里尚未发送的草稿");
    view.rerender(
      <AgentPage
        toolRequest={{ tool: "workflows", initialTab: "automation", id: 1 }}
      />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    await flush();
    await tick(1);
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledOnce();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.models[0].id,
      "build",
      "设计自动化",
      "auto",
      "high",
      project,
      64000,
    );
    expect(agentApi.getSession).toHaveBeenCalledWith(designSession.id);
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "请帮我创建一项自动化任务。先确认要执行的工作和运行时间，再给我配置草案。",
    );
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
    expect(agentApi.automation).not.toHaveBeenCalledWith(
      "create",
      expect.anything(),
    );
    expect(
      screen.queryByRole("region", { name: "工作流与自动化" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`^${session.title}`) }),
    );
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "原运行会话里尚未发送的草稿",
    );
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });

  it("automation design kickoff rejects an unavailable source model instead of silently choosing another model", async () => {
    snapshot.session.model = {
      providerId: "removed-channel",
      modelId: "removed-model",
    };
    const view = render(<AgentPage />);
    await flush();
    fill("模型不可用时也要保留的原草稿");
    view.rerender(
      <AgentPage
        toolRequest={{ tool: "workflows", initialTab: "automation", id: 1 }}
      />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    await flush();
    expect(
      screen.getByText(
        "当前会话模型不可用，请先选择可用模型，再开始自动化对话。",
      ),
    ).toBeInTheDocument();
    expect(agentApi.createSession).not.toHaveBeenCalled();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "模型不可用时也要保留的原草稿",
    );
  });

  it("returns from a tool to the selected conversation without losing either draft", async () => {
    const second = { ...session, id: "s2", title: "整理项目文档" };
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: id === second.id ? second : session,
    }));
    const view = render(<AgentPage />);
    await flush();
    fill("第一条会话的草稿");
    fireEvent.click(screen.getByRole("button", { name: second.title }));
    await flush();
    fill("第二条会话的草稿");
    view.rerender(<AgentPage toolRequest={{ tool: "skills", id: 1 }} />);
    await flush();
    expect(
      screen.getByRole("region", { name: "技能与插件" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: session.title }));
    await flush();
    await tick(250);
    expect(
      screen.queryByRole("region", { name: "技能与插件" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: session.title }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "第一条会话的草稿",
    );
    fireEvent.click(screen.getByRole("button", { name: second.title }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "第二条会话的草稿",
    );
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });

  it("restores the sidebar from the tool header while the chat is covered", async () => {
    render(<AgentPage toolRequest={{ tool: "skills", id: 1 }} />);
    await flush();
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(
      screen.queryByRole("complementary", { name: "项目会话" }),
    ).not.toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "技能与插件" });
    const expand = within(panel).getByRole("button", { name: "展开项目侧栏" });
    expand.focus();
    expect(expand).toHaveFocus();
    fireEvent.click(expand);
    expect(
      screen.getByRole("complementary", { name: "项目会话" }),
    ).toBeInTheDocument();
    expect(panel).toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "展开项目侧栏" }),
    ).not.toBeInTheDocument();
  });

  it("waits for the shell navigation guard before leaving a tool and changing conversations", async () => {
    const second = { ...session, id: "s2", title: "等待确认后切换" };
    const pending: Array<() => void> = [];
    const navigate = vi.fn((proceed: () => void) => {
      pending.push(proceed);
    });
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: id === second.id ? second : session,
    }));
    render(
      <AgentPage
        toolRequest={{ tool: "skills", id: 1 }}
        onWorkspaceNavigate={navigate}
      />,
    );
    await flush();
    vi.mocked(agentApi.getSession).mockClear();
    fireEvent.click(screen.getByRole("button", { name: second.title }));
    await flush();
    expect(navigate).toHaveBeenCalledOnce();
    expect(agentApi.getSession).not.toHaveBeenCalled();
    expect(
      screen.getByRole("region", { name: "技能与插件" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: second.title })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    act(() => pending[0]());
    await flush();
    await tick(250);
    expect(agentApi.getSession).toHaveBeenCalledWith(second.id);
    expect(
      screen.queryByRole("region", { name: "技能与插件" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: second.title })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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

  it("releases previews of a removed project and retains the other project's dock", async () => {
    const owner = `${project}\0${session.id}`;
    const other = "D:/fixture/other\0lc:other";
    const layoutKey = "lolicode.agent.rightDock.v1";
    const browserKey = "lolicode.agent.rightDockBrowser.v1";
    const fileKey = "lolicode.agent.rightDockFiles.v1";
    const saved = { panes: [{ tabs: ["browser:1"], active: "browser:1" }], focused: 0, folded: true, ratio: 0.5 };
    localStorage.setItem(layoutKey, JSON.stringify({ [other]: saved }));
    localStorage.setItem(browserKey, JSON.stringify({ [other]: [{ id: 1, url: "https://other.test/" }] }));
    const url = "https://removed.test/";
    snapshot.messages = [{
      id: "removed-output", role: "assistant", createdAt: 3,
      parts: [{ type: "text", text: `[文件](docs/report.md) [网页](${url})` }],
    }];
    vi.mocked(agentApi.removeProject).mockReset().mockResolvedValue();
    const windows = vi.spyOn(platform, "isWindows").mockReturnValue(true);
    const open = vi.spyOn(agentFilesApi, "openBrowser").mockResolvedValue({
      kind: "browser", id: "removed-browser", sessionId: session.id,
      browserId: "removed-browser", url, createdAt: 4, native: true,
    });
    const preview = vi.spyOn(agentFilesApi, "preview").mockResolvedValue({
      path: "docs/report.md", name: "report.md", kind: "text", content: "report",
      mimeType: "text/plain", sizeBytes: 6, truncated: false,
    });
    const close = vi.spyOn(agentFilesApi, "closeBrowser").mockResolvedValue();
    const sync = vi.spyOn(agentFilesApi, "syncBrowserWebview").mockResolvedValue();
    const page = render(<AgentPage />);
    try {
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "预览文件：docs/report.md" }));
      fireEvent.click(screen.getByRole("link", { name: "网页" }));
      await flush();
      expect(JSON.parse(localStorage.getItem(fileKey)!)[owner]).toEqual({ path: "docs/report.md" });
      expect(JSON.parse(localStorage.getItem(browserKey)!)[owner]).toHaveLength(1);

      fireEvent.keyDown(screen.getByRole("button", { name: "管理项目：project" }), { key: "Enter" });
      fireEvent.click(screen.getByRole("menuitem", { name: "移出项目列表" }));
      await flush();
      expect(agentApi.removeProject).toHaveBeenCalledWith(project);
      expect(close).toHaveBeenCalledWith(session.id, "removed-browser");
      expect(JSON.parse(localStorage.getItem(browserKey)!)).toEqual({
        [other]: [{ id: 1, url: "https://other.test/" }],
      });
      expect(JSON.parse(localStorage.getItem(layoutKey)!)).toEqual({ [other]: saved });
      expect(JSON.parse(localStorage.getItem(fileKey)!)).toEqual({});
    } finally {
      page.unmount();
      await flush();
      windows.mockRestore();
      open.mockRestore();
      preview.mockRestore();
      close.mockRestore();
      sync.mockRestore();
    }
  });

  it("keeps genuine question requests answerable with full permissions", async () => {
    snapshot.status = "waiting_question";
    snapshot.session.permissionMode = "full_access";
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
      undefined,
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
        chat.scrollTop = 1200;
        fireEvent.scroll(chat);
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

  it("restores each conversation's reading position and follows the tail on send", async () => {
    const other = { ...session, id: "other-scroll", title: "阅读另一会话", updatedAt: 1 };
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, other]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...structuredClone(snapshot), session: id === other.id ? other : session,
    }));
    const height = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1600);
    const viewport = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      const view = render(<AgentPage />);
      await flush();
      const chat = () => view.container.querySelector<HTMLDivElement>(".wb-chat")!;
      chat().scrollTop = 170;
      fireEvent.scroll(chat());
      fireEvent.click(screen.getByRole("button", { name: other.title }));
      await flush();
      expect(chat().scrollTop).toBe(1600);
      chat().scrollTop = 310;
      fireEvent.scroll(chat());

      fireEvent.click(screen.getByRole("button", { name: session.title }));
      await flush();
      expect(chat().scrollTop).toBe(170);
      fill("发送后跟随最新消息");
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      expect(chat().scrollTop).toBe(1600);
      await flush();

      fireEvent.click(screen.getByRole("button", { name: other.title }));
      await flush();
      expect(chat().scrollTop).toBe(310);
    } finally {
      height.mockRestore();
      viewport.mockRestore();
    }
  });

  it("follows the committed send and keeps following after a delayed scroll event at the old floor", async () => {
    let resizeChat: (() => void) | undefined;
    let acknowledge!: () => void;
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: () => void) {}
      observe(target: Element) {
        if (target.matches(".wb-chat-content")) resizeChat = this.callback;
      }
      unobserve() {}
      disconnect() {}
    });
    vi.mocked(agentApi.sendMessage).mockReturnValueOnce(new Promise<void>((resolve) => {
      acknowledge = resolve;
    }));
    try {
      const view = render(<AgentPage />);
      await flush();
      const chat = view.container.querySelector<HTMLDivElement>(".wb-chat")!;
      let replyGrowth = 0;
      let position = 0;
      Object.defineProperties(chat, {
        scrollHeight: {
          configurable: true,
          get: () => (chat.querySelector(".wb-message-user") ? 1350 : 1000) + replyGrowth,
        },
        clientHeight: { configurable: true, value: 300 },
        scrollTop: {
          configurable: true,
          get: () => position,
          set: (value: number) => { position = Math.min(value, chat.scrollHeight - 300); },
        },
      });
      chat.scrollTop = 700;
      fireEvent.scroll(chat);
      chat.scrollTop = 100;
      fireEvent.scroll(chat);
      expect(screen.getByRole("button", { name: "回到最新" })).toBeVisible();
      fill("发完直接定位新气泡");
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      expect(chat.scrollTop).toBe(1050);

      replyGrowth = 200;
      fireEvent.scroll(chat);
      expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
      expect(resizeChat).toBeDefined();
      act(() => resizeChat?.());
      expect(chat.scrollTop).toBe(1250);

      chat.scrollTop = 900;
      fireEvent.scroll(chat);
      replyGrowth = 300;
      act(() => resizeChat?.());
      expect(chat.scrollTop).toBe(900);
      await act(async () => acknowledge());
      await flush();
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
      readAgentDraft(
        `lolicode.agent.draft:${encodeURIComponent(project)}:${session.id}`,
      ),
    ).toContain("保留这段需求");
  });

  it.each(["running", "waiting_permission", "waiting_question"] as const)(
    "queues Enter during %s without interrupting the current response",
    async (status) => {
      snapshot.status = status;
      render(<AgentPage />);
      await flush();
      fill("下一条任务");
      fireEvent.keyDown(screen.getByLabelText("发送给 Agent 的消息"), {
        key: "Enter",
      });
      await flush();
      expect(agentApi.enqueueMessage).toHaveBeenCalledWith(
        session.id,
        "下一条任务",
        expect.any(String),
        [],
        [],
      );
      expect(agentApi.sendMessage).not.toHaveBeenCalled();
      expect(agentApi.interruptSession).not.toHaveBeenCalled();
      expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("");
      expect(
        within(screen.getByRole("region", { name: "待发送消息" })).getByText(
          "下一条任务",
        ),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "引导第 1 条消息" }),
      ).toBeEnabled();
    },
  );
  it("shows a queued draft immediately and hands it off by ID without waiting on the attachment cache", async () => {
    snapshot.status = "running";
    let finishCache!: () => void;
    let finishEnqueue!: (result: { status: "accepted" }) => void;
    const backup = vi
      .spyOn(agentImageStore, "saveAgentImageAttachments")
      .mockReturnValueOnce(new Promise((resolve) => (finishCache = resolve)));
    vi.mocked(agentApi.enqueueMessage).mockReturnValueOnce(
      new Promise((resolve) => (finishEnqueue = resolve)),
    );
    try {
      render(<AgentPage />);
      await flush();
      fill("立刻显示的排队消息");
      fireEvent.click(screen.getByRole("button", { name: "发送" }));

      const queue = () =>
        within(screen.getByRole("region", { name: "待发送消息" }));
      expect(queue().getByText("立刻显示的排队消息")).toBeVisible();
      expect(
        queue().getByRole("button", { name: "正在加入队列的第 1 条消息" }),
      ).toBeDisabled();
      expect(agentApi.enqueueMessage).toHaveBeenCalledOnce();
      expect(backup).toHaveBeenCalledOnce();

      const requestId = vi.mocked(agentApi.enqueueMessage).mock.calls[0][2];
      snapshot.queuedMessages = [{ id: requestId, text: "立刻显示的排队消息" }];
      await tick();
      expect(queue().getAllByText("立刻显示的排队消息")).toHaveLength(1);
      expect(
        queue().getByRole("button", { name: "引导第 1 条消息" }),
      ).toBeDisabled();
      await act(async () => finishEnqueue({ status: "accepted" }));
      expect(
        queue().getByRole("button", { name: "引导第 1 条消息" }),
      ).toBeEnabled();

      snapshot.queuedMessages = [];
      snapshot.messages = [
        {
          id: requestId,
          role: "user",
          createdAt: 3,
          parts: [{ type: "text", text: "立刻显示的排队消息" }],
        },
      ];
      await tick();
      expect(
        screen.queryByRole("region", { name: "待发送消息" }),
      ).not.toBeInTheDocument();
      expect(screen.getAllByText("立刻显示的排队消息")).toHaveLength(1);
    } finally {
      await act(async () => {
        finishCache();
        finishEnqueue({ status: "accepted" });
      });
      backup.mockRestore();
    }
  });
  it("preserves newer edits when an enqueue acknowledgement arrives late", async () => {
    snapshot.status = "running";
    let finish!: () => void;
    vi.mocked(agentApi.enqueueMessage).mockImplementationOnce(
      async (_id, text, requestId) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        snapshot.queuedMessages = [{ id: requestId, text, attachments: [] }];
        return { status: "accepted" as const };
      },
    );
    render(<AgentPage />);
    await flush();
    fill("捕获的队列消息");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    fill("新写的草稿");
    await act(async () => finish());
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "新写的草稿",
    );
    expect(screen.getByText("捕获的队列消息")).toBeVisible();
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });
  it("retries an uncertain enqueue with the same request identity", async () => {
    snapshot.status = "running";
    vi.mocked(agentApi.enqueueMessage).mockRejectedValueOnce(
      new Error("入队响应丢失"),
    );
    render(<AgentPage />);
    await flush();
    fill("保留消息并重试");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留消息并重试",
    );
    const first = vi.mocked(agentApi.enqueueMessage).mock.calls[0];
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(vi.mocked(agentApi.enqueueMessage).mock.calls[1]).toEqual(first);
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("");
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });
  it("keeps the editor usable after a definite native queue rejection", async () => {
    snapshot.status = "running";
    vi.mocked(agentApi.enqueueMessage).mockResolvedValueOnce({
      status: "rejected",
      message: "队列已满",
    });
    render(<AgentPage />);
    await flush();
    fill("超出队列容量的草稿");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "超出队列容量的草稿",
    );
    expect(screen.getByText("队列已满")).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "待发送消息" }),
    ).not.toBeInTheDocument();
    fill("修改后重新排队");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.enqueueMessage).toHaveBeenCalledTimes(2);
    expect(screen.getByText("修改后重新排队")).toBeVisible();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("");
  });
  it("restores an unconfirmed enqueue draft after reload and reuses its exact request ID", async () => {
    snapshot.status = "running";
    const storageKey = `lolicode.agent.draft:${encodeURIComponent(project)}:${encodeURIComponent(session.id)}`;
    saveAgentQueueSubmission({
      version: 1,
      projectPath: project,
      sessionId: session.id,
      requestId: "queue-recovery-id",
      text: "重新打开后的待确认草稿",
      draft: {
        key: storageKey,
        revision: "recovered-token",
        text: "重新打开后的待确认草稿",
      },
      imageIds: [],
      documentIds: [],
    });
    render(<AgentPage />);
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "重新打开后的待确认草稿",
    );
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(agentApi.enqueueMessage).toHaveBeenCalledWith(
      session.id,
      "重新打开后的待确认草稿",
      "queue-recovery-id",
      [],
      [],
    );
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("");
  });
  it("recovers a lost enqueue response from the native queue snapshot", async () => {
    snapshot.status = "running";
    vi.mocked(agentApi.enqueueMessage).mockImplementationOnce(
      async (_id, text, requestId) => {
        snapshot.queuedMessages = [{ id: requestId, text, attachments: [] }];
        throw new Error("transport lost");
      },
    );
    render(<AgentPage />);
    await flush();
    fill("原生已接收入队");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(screen.getByText("原生已接收入队")).toBeVisible();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("");
    expect(screen.queryByText("transport lost")).not.toBeInTheDocument();
    expect(agentApi.enqueueMessage).toHaveBeenCalledOnce();
  });
  it("recalls text and original image/document payloads into the editor", async () => {
    snapshot.status = "running";
    snapshot.queuedMessages = [
      {
        id: "queue-owned",
        text: "带附件的消息",
        attachments: [
          { fileName: "notes.md", mime: "text/markdown", bytes: 4 },
        ],
      },
    ];
    vi.mocked(agentApi.removeQueuedMessage).mockImplementationOnce(
      async (_id, requestId) => {
        snapshot.queuedMessages = [];
        return {
          requestId,
          text: "带附件的消息",
          attachments: [
            {
              fileName: "preview.png",
              mime: "image/png",
              bytes: 4,
              ref: "data:image/png;base64,dGVzdA==",
            },
            {
              fileName: "notes.md",
              mime: "text/markdown",
              bytes: 4,
              dataBase64: "dGVzdA==",
            },
          ],
        };
      },
    );
    render(<AgentPage />);
    await flush();
    fireEvent.click(await queueRecallAction());
    expect(screen.getByLabelText("发送给 Agent 的消息")).toBeDisabled();
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "带附件的消息",
    );
    expect(
      screen.getByRole("button", { name: "移除图片：preview.png" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "移除文档：notes.md" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "待发送消息" }),
    ).not.toBeInTheDocument();
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });
  it("keeps a concurrent edit and offers recovery after a late withdrawal response", async () => {
    snapshot.status = "running";
    snapshot.queuedMessages = [
      { id: "queue-owned", text: "已撤回的原消息", attachments: [] },
    ];
    let finish!: () => void;
    vi.mocked(agentApi.removeQueuedMessage).mockImplementation(
      async (_id, requestId) => {
        if (!finish)
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        snapshot.queuedMessages = [];
        return { requestId, text: "已撤回的原消息", attachments: [] };
      },
    );
    render(<AgentPage />);
    await flush();
    fireEvent.click(await queueRecallAction());
    await flush();
    // Another editor/window can change storage despite the local input lock.
    fill("并发的新草稿");
    await act(async () => finish());
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "并发的新草稿",
    );
    expect(screen.getByRole("button", { name: "恢复编辑" })).toBeVisible();
    fill("");
    fireEvent.click(screen.getByRole("button", { name: "恢复编辑" }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "已撤回的原消息",
    );
    expect(
      screen.queryByRole("button", { name: "恢复编辑" }),
    ).not.toBeInTheDocument();
  });
  it("recovers an acknowledged withdrawal whose transport response was lost", async () => {
    snapshot.status = "running";
    snapshot.queuedMessages = [
      { id: "queue-owned", text: "不能丢的撤回消息", attachments: [] },
    ];
    vi.mocked(agentApi.removeQueuedMessage).mockImplementationOnce(async () => {
      snapshot.queuedMessages = [];
      throw new Error("撤回响应丢失");
    });
    render(<AgentPage />);
    await flush();
    fireEvent.click(await queueRecallAction());
    await flush();
    expect(screen.getByRole("button", { name: "恢复编辑" })).toBeVisible();
    vi.mocked(agentApi.removeQueuedMessage).mockResolvedValueOnce({
      requestId: "queue-owned",
      text: "不能丢的撤回消息",
      attachments: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "恢复编辑" }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "不能丢的撤回消息",
    );
  });
  it("steers the selected queued item without consuming the current draft", async () => {
    snapshot.status = "running";
    snapshot.queuedMessages = [
      { id: "queue-first", text: "稍后任务", attachments: [] },
      { id: "queue-priority", text: "优先任务", attachments: [] },
    ];
    vi.mocked(agentApi.sendQueuedMessageNow).mockImplementationOnce(async () => {
      snapshot.queuedMessages![1].delivery = "steer";
    });
    render(<AgentPage />);
    await flush();
    fill("继续写的草稿");
    fireEvent.click(
      screen.getByRole("button", { name: "引导第 2 条消息" }),
    );
    await flush();
    expect(agentApi.sendQueuedMessageNow).toHaveBeenCalledWith(
      session.id,
      "queue-priority",
      true,
    );
    const input = screen.getByLabelText("发送给 Agent 的消息");
    expect(input).toHaveValue("继续写的草稿");
    expect(input).toHaveFocus();
    await tick();
    expect(screen.getByRole("article", { name: "你的消息" })).toHaveTextContent(
      "优先任务",
    );
    const queue = within(screen.getByRole("region", { name: "待发送消息" }));
    expect(queue.getByText("稍后任务")).toBeInTheDocument();
    expect(queue.queryByText("优先任务")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    expect(agentApi.enqueueMessage).toHaveBeenCalledWith(
      session.id, "继续写的草稿", expect.any(String), [], [],
    );
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps one primary button for stopping or submitting a follow-up", async () => {
    snapshot.status = "running";
    const view = render(<AgentPage />);
    await flush();
    const primary = screen.getByRole("button", { name: "停止" });
    const input = screen.getByLabelText("发送给 Agent 的消息");
    const toolbar = view.container.querySelector(".wb-composer-toolbar");
    expect(toolbar?.querySelectorAll("[data-composer-action]")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
    fill("按顺序发送的补充");
    expect(screen.getByRole("button", { name: "发送" })).toBe(primary);
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    expect(primary).toHaveAttribute("title", expect.stringContaining("排队"));
    fireEvent.click(primary);
    await flush();
    expect(agentApi.enqueueMessage).toHaveBeenCalledWith(
      session.id, "按顺序发送的补充", expect.any(String), [], [],
    );
    expect(screen.getByRole("button", { name: "停止" })).toBe(primary);
    expect(input).toHaveFocus();
  });
  it("deletes only the selected queued item while preserving the editor", async () => {
    snapshot.status = "running";
    snapshot.queuedMessages = [
      { id: "queue-first", text: "待删除任务", attachments: [] },
      { id: "queue-second", text: "保留任务", attachments: [] },
    ];
    render(<AgentPage />);
    await flush();
    fill("保留编辑内容");
    fireEvent.click(screen.getByRole("button", { name: "删除第 1 条消息" }));
    await flush();
    expect(agentApi.removeQueuedMessage).toHaveBeenCalledWith(
      session.id,
      "queue-first",
    );
    expect(screen.queryByText("待删除任务")).not.toBeInTheDocument();
    expect(screen.getByText("保留任务")).toBeVisible();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留编辑内容",
    );
  });
  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "inserts the composer input immediately without stopping or replacing the current task (%o)",
    async (shortcut) => {
      snapshot.status = "running";
      snapshot.messages = [{
        id: "active-answer", role: "assistant", createdAt: 3,
        parts: [{ type: "text", text: "原任务正在输出" }],
      }];
      let acknowledge!: (receipt: { status: "accepted" }) => void;
      vi.mocked(agentApi.enqueueMessage).mockReturnValueOnce(
        new Promise((resolve) => { acknowledge = resolve; }),
      );
      render(<AgentPage />);
      await flush();
      fill("插入这条当前任务指令");
      const input = screen.getByLabelText("发送给 Agent 的消息");
      fireEvent.keyDown(input, { key: "Enter", ...shortcut });
      const row = screen.getByRole("article", { name: "你的消息" });
      expect(row).toHaveTextContent("插入这条当前任务指令");
      expect(screen.getByText("原任务正在输出")).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "待发送消息" })).toBeNull();
      expect(agentApi.interruptSession).not.toHaveBeenCalled();
      expect(agentApi.sendMessage).not.toHaveBeenCalled();
      expect(agentApi.enqueueMessage).toHaveBeenCalledOnce();
      const requestId = vi.mocked(agentApi.enqueueMessage).mock.calls[0][2];
      expect(agentApi.enqueueMessage).toHaveBeenCalledWith(
        session.id, "插入这条当前任务指令", requestId, [], [], "steer",
      );
      fill("另一条未发送的草稿");
      await act(async () => acknowledge({ status: "accepted" }));
      snapshot.messages.push({
        id: requestId, role: "user", createdAt: 4,
        parts: [{ type: "text", text: "插入这条当前任务指令" }],
      });
      await tick();
      expect(screen.getByRole("article", { name: "你的消息" })).toBe(row);
      expect(input).toHaveValue("另一条未发送的草稿");
    },
  );

  it("keeps a direct steering draft when the current turn ends before admission", async () => {
    snapshot.status = "running";
    vi.mocked(agentApi.enqueueMessage).mockResolvedValueOnce({
      status: "rejected", message: "当前任务已经结束，草稿已保留。",
    });
    render(<AgentPage />);
    await flush();
    fill("保留这条补充说明");
    fireEvent.keyDown(screen.getByLabelText("发送给 Agent 的消息"), {
      key: "Enter",
      ctrlKey: true,
    });
    await flush();
    expect(screen.queryByRole("article", { name: "你的消息" })).toBeNull();
    expect(screen.getByText("当前任务已经结束，草稿已保留。")).toBeVisible();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("保留这条补充说明");
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("retries an unknown steering result with the original request and delivery", async () => {
    snapshot.status = "running";
    vi.mocked(agentApi.enqueueMessage).mockRejectedValueOnce(new Error("回执暂未确认"));
    render(<AgentPage />);
    await flush();
    fill("重试同一条插入消息");
    fireEvent.keyDown(screen.getByLabelText("发送给 Agent 的消息"), {
      key: "Enter",
      ctrlKey: true,
    });
    await flush();
    expect(screen.getByText("回执暂未确认")).toBeVisible();
    expect(screen.queryByRole("article", { name: "你的消息" })).toBeNull();
    fireEvent.keyDown(screen.getByLabelText("发送给 Agent 的消息"), { key: "Enter" });
    await flush();
    const calls = vi.mocked(agentApi.enqueueMessage).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1][5]).toBe("steer");
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
      fireEvent.keyDown(screen.getByRole("button", { name: "添加内容" }), {
        key: "Enter",
      });
      await flush();
      expect(
        screen.getByRole("menuitem", { name: "添加图片" }),
      ).toHaveAttribute("aria-disabled", "true");
      expect(
        screen.getByRole("menuitem", { name: "添加文档" }),
      ).toHaveAttribute("aria-disabled", "true");
      expect(
        screen.getByRole("menuitem", { name: "管理插件" }),
      ).not.toHaveAttribute("aria-disabled", "true");
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await flush();
      expect(composerPermissionSelect()).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "分析" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "实现" }),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText(`管理会话：${legacy.title}`)).toBeDisabled();
      fireEvent.click(screen.getByLabelText("模型", { exact: true }));
      fireEvent.change(composerPermissionSelect(), {
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
    expect(composerPermissionSelect()).toBeDisabled();
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
    fill("");
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await flush();
    await tick();
    const ledger = Object.keys(localStorage).find((key) =>
      key.startsWith("lolicode.agent.input:"),
    );
    expect(ledger).toBeTruthy();
    fill("另一条任务");
    fireEvent.keyDown(screen.getByLabelText("发送给 Agent 的消息"), {
      key: "Enter",
    });
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
    expect(screen.getByRole("button", { name: "模型" })).toHaveAttribute(
      "title",
      "Copilot · Model B",
    );
  });

  it("changes Auto Mode without exposing obsolete analysis/build mode controls", async () => {
    render(<AgentPage />);
    await flush();
    fireEvent.change(composerPermissionSelect(), {
      target: { value: "auto" },
    });
    await flush();
    expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
      permissionMode: "auto",
    });
    expect(composerPermissionSelect()).toHaveAttribute(
      "title",
      expect.stringContaining("允许工作区内的常规操作"),
    );
    expect(
      screen.queryByText(/常规编辑与已识别的安全命令自动允许/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "分析" }),
    ).not.toBeInTheDocument();
    expect(composerPermissionSelect()).toHaveValue("auto");
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
    fireEvent.click(composerSettingButton("思考档位"));
    fireEvent.click(screen.getByRole("button", { name: "思考档位 high" }));
    await flush();
    expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
      reasoningEffort: "high",
    });
    expect(composerSettingButton("思考档位")).toHaveTextContent("high");
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留待发送的要求",
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
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
    fireEvent.click(composerSettingButton("上下文窗口"));
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
    fireEvent.click(composerSettingButton("上下文窗口"));
    fireEvent.click(
      screen.getByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    );
    await flush();
    await tick(5000);
    expect(composerSettingButton("上下文窗口")).toHaveTextContent("1M");
    fireEvent.click(composerSettingButton("上下文窗口"));
    fireEvent.click(screen.getByRole("button", { name: "使用默认上下文" }));
    await flush();
    expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
      contextLimit: null,
    });
    expect(composerSettingButton("上下文窗口")).toHaveTextContent("128K");
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
    fireEvent.click(composerSettingButton("上下文窗口"));
    fireEvent.click(
      screen.getByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    );
    await flush();
    expect(composerSettingButton("上下文窗口")).toHaveTextContent("128K");
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
    fireEvent.click(composerSettingButton("上下文窗口"));
    fireEvent.click(
      screen.getByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^第二个上下文会话/ }));
    await flush();
    expect(composerSettingButton("上下文窗口")).toHaveTextContent("128K");
    fill("第二个会话草稿");
    fireEvent.click(screen.getByRole("button", { name: /^修复测试/ }));
    await flush();
    expect(composerSettingButton("上下文窗口")).toHaveTextContent("1M");
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "第一个会话草稿",
    );
    expect(agentApi.updateSession).toHaveBeenCalledTimes(1);
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the saved effort and draft when a common effort choice fails", async () => {
    vi.mocked(agentApi.updateSession).mockRejectedValue(
      new Error("中转不接受此思考档位"),
    );
    render(<AgentPage />);
    await flush();
    fill("保留思考档位切换前的输入");
    fireEvent.click(composerSettingButton("思考档位"));
    fireEvent.click(screen.getByRole("button", { name: "思考档位 high" }));
    await flush();
    expect(agentApi.updateSession).toHaveBeenCalledWith(session.id, {
      reasoningEffort: "high",
    });
    expect(composerSettingButton("思考档位")).toHaveTextContent("上游默认");
    expect(screen.getByText("中转不接受此思考档位")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留思考档位切换前的输入",
    );
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("passes the chosen common effort when creating a new conversation", async () => {
    vi.mocked(agentApi.listSessions).mockResolvedValue([]);
    render(<AgentPage />);
    await flush();
    fireEvent.click(composerSettingButton("思考档位"));
    fireEvent.click(screen.getByRole("button", { name: "思考档位 high" }));
    fireEvent.click(sessionCreationButton());
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.models[0].id,
      "build",
      undefined,
      undefined,
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
    fireEvent.click(composerSettingButton("上下文窗口"));
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
      undefined,
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
    fireEvent.click(composerSettingButton("上下文窗口"));
    fireEvent.click(
      screen.getByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    );
    selectModel("Model B");
    await flush();
    expect(composerSettingButton("上下文窗口")).toHaveTextContent("32K");
    fireEvent.click(sessionCreationButton());
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.models[1].id,
      "build",
      undefined,
      undefined,
      undefined,
    );
  });

  it("displays full permissions for a new local task and leaves the default to the host", async () => {
    vi.mocked(agentApi.listSessions).mockResolvedValue([]);
    render(<AgentPage />);
    await flush();
    expect(composerPermissionSelect()).toHaveValue("full_access");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(agentApi.updateSession).not.toHaveBeenCalled();
    fireEvent.click(sessionCreationButton());
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.defaultModel,
      "build",
      undefined,
      undefined,
      undefined,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["ask", "auto"] as const)(
    "honors an explicit %s selection for a new local task",
    async (mode) => {
      vi.mocked(agentApi.listSessions).mockResolvedValue([]);
      render(<AgentPage />);
      await flush();
      const select = composerPermissionSelect();
      expect(select).toHaveValue("full_access");
      fireEvent.change(select, { target: { value: mode } });
      expect(select).toHaveValue(mode);
      fireEvent.click(sessionCreationButton());
      await flush();
      expect(agentApi.createSession).toHaveBeenCalledWith(
        catalog.defaultModel,
        "build",
        undefined,
        mode,
        undefined,
      );
      expect(agentApi.updateSession).not.toHaveBeenCalled();
    },
  );

  it("keeps a restored remote workspace on its review default", async () => {
    vi.mocked(agentApi.listSessions).mockResolvedValue([]);
    vi.mocked(agentApi.listProjects).mockResolvedValue([
      {
        path: project,
        name: "remote",
        pinned: false,
        lastOpenedAt: 2,
        remote: { connectionName: "fixture", root: "/project", kind: "ssh" },
      },
    ]);
    render(<AgentPage />);
    await flush();
    const select = composerPermissionSelect();
    expect(select).toHaveValue("ask");
    expect(
      within(select).queryByRole("option", { name: "完整权限" }),
    ).not.toBeInTheDocument();
    fireEvent.click(sessionCreationButton());
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.defaultModel,
      "build",
      undefined,
      undefined,
      undefined,
    );
  });

  it("keeps planning controls out of the composer and shows the configured execution permission", async () => {
    snapshot.session.mode = "plan";
    snapshot.session.permissionMode = "full_access";
    snapshot.plan = { active: true };
    render(<AgentPage />);
    await flush();
    expect(screen.getByRole("button", { name: "对话设置" })).toHaveTextContent(
      "完整权限",
    );
    const select = composerPermissionSelect();
    expect(select).toHaveValue("full_access");
    expect(screen.queryByText(/计划模式/)).not.toBeInTheDocument();
    expect(agentApi.updateSession).not.toHaveBeenCalled();
  });

  it.each(["none", "complete"] as const)(
    "hides the goal strip when the current goal is %s",
    async (phase) => {
      if (phase === "complete")
        snapshot.goal = {
          objective: "已交付的目标",
          phase,
          activation: "disarmed",
          roundsStarted: 2,
          maxGoalRounds: 5,
          revision: 3,
        };
      render(<AgentPage />);
      await flush();
      expect(
        screen.queryByRole("region", { name: "Agent 会话模式" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "设置目标" }),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps the native controls for a goal that is in progress", async () => {
    snapshot.goal = {
      objective: "验证当前目标",
      phase: "active",
      activation: "armed",
      roundsStarted: 1,
      maxGoalRounds: 5,
      revision: 2,
    };
    render(<AgentPage />);
    await flush();
    const goal = within(screen.getByRole("region", { name: "Agent 会话模式" }));
    expect(goal.getByText("验证当前目标")).toBeVisible();
    expect(goal.getByRole("status")).toHaveTextContent("推进中 · 1/5 轮");
    expect(goal.queryByRole("button", { name: "设置目标" })).toBeNull();
    expect(goal.getByRole("button", { name: "清除目标" })).toBeEnabled();
    fireEvent.click(goal.getByRole("button", { name: "修改目标" }));
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "/goal edit ",
    );
    fireEvent.click(goal.getByRole("button", { name: "暂停目标" }));
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledWith(
      session.id,
      "/goal pause",
      expect.stringMatching(/^mode_/),
    );
  });

  it("keeps an existing explicit ask permission when reopening the task", async () => {
    snapshot.session.permissionMode = "ask";
    vi.mocked(agentApi.listSessions).mockResolvedValue([
      structuredClone(snapshot.session),
    ]);
    const view = render(<AgentPage />);
    await flush();
    expect(composerPermissionSelect()).toHaveValue("ask");
    view.unmount();
    render(<AgentPage />);
    await flush();
    expect(composerPermissionSelect()).toHaveValue("ask");
    expect(agentApi.updateSession).not.toHaveBeenCalled();
    expect(agentApi.createSession).not.toHaveBeenCalled();
  });

  it("keeps the local default separate from an existing task's permission changes", async () => {
    snapshot.session.permissionMode = "ask";
    render(<AgentPage />);
    await flush();
    fireEvent.change(composerPermissionSelect(), {
      target: { value: "auto" },
    });
    await flush();
    expect(agentApi.updateSession).toHaveBeenCalledWith(session.id, {
      permissionMode: "auto",
    });
    expect(composerPermissionSelect()).toHaveValue("auto");
    fireEvent.click(sessionCreationButton());
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.defaultModel,
      "build",
      undefined,
      undefined,
      undefined,
    );
  });

  it("creates a task with the default approval mode when composing a workflow", async () => {
    vi.mocked(agentApi.listSessions).mockResolvedValue([]);
    snapshot.session.id = "lc:new";
    render(<AgentPage toolRequest={{ tool: "workflows", id: 1 }} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "在会话中创建工作流" }));
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.defaultModel,
      "build",
      undefined,
      undefined,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveProperty(
      "value",
      expect.stringContaining("请根据当前项目帮我创建可复用工作流"),
    );
    expect(agentApi.sendMessage).not.toHaveBeenCalled();
  });

  it("enables full access immediately without another confirmation", async () => {
    snapshot.session.permissionMode = "ask";
    render(<AgentPage />);
    await flush();
    fireEvent.change(composerPermissionSelect(), {
      target: { value: "full_access" },
    });
    await flush();
    expect(screen.getAllByRole("dialog")).toEqual([
      screen.getByRole("dialog", { name: "对话设置" }),
    ]);
    expect(agentApi.updateSession).toHaveBeenCalledWith(session.id, {
      permissionMode: "full_access",
    });
    expect(composerPermissionSelect()).toHaveValue("full_access");
  });

  it.each(["running", "waiting_permission", "waiting_question"] as const)(
    "changes model and permissions during %s while still allowing steering",
    async (status) => {
      snapshot.status = status;
      render(<AgentPage />);
      await flush();
      fill("任务结束后再发送的草稿");
      expect(screen.getByLabelText("模型", { exact: true })).toBeEnabled();
      expect(composerPermissionSelect()).toBeEnabled();
      selectModel("Model B");
      await flush();
      expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
        modelId: catalog.models[1].id,
      });
      expect(screen.getByLabelText("模型", { exact: true })).toHaveTextContent(
        "Model B",
      );
      fireEvent.change(composerPermissionSelect(), {
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
      expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
      fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
      fireEvent.submit(input.closest("form")!);
      await flush();
      expect(agentApi.sendMessage).not.toHaveBeenCalled();
      expect(agentApi.interruptSession).not.toHaveBeenCalled();
      expect(agentApi.enqueueMessage).toHaveBeenCalledOnce();
      expect(
        screen.queryByText(/模型与思考档位从下一次模型请求生效/),
      ).not.toBeInTheDocument();
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
    expect(composerPermissionSelect()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await flush();
    expect(agentApi.interruptSession).toHaveBeenCalledOnce();
    await act(async () => finish({ ...session, model: catalog.models[1] }));
  });

  it("restores the last selected conversation when the desktop host restarts", async () => {
    const selected = {
      ...session,
      id: "selected-earlier",
      title: "上次打开的会话",
    };
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, selected]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: id === selected.id ? selected : session,
    }));
    const original = render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^上次打开的会话/ }));
    await flush();
    expect(agentApi.getSession).toHaveBeenLastCalledWith(selected.id);
    fill("桌面重启前未提交的草稿");
    original.unmount();
    sessionStorage.clear();

    vi.mocked(agentApi.getStatus).mockResolvedValue({
      available: true,
      running: true,
    });
    vi.mocked(agentApi.openProject).mockResolvedValue({
      workspace: { path: project, name: "project" },
      catalog,
      sessions: [session, selected],
    });
    vi.mocked(agentApi.getSession).mockClear();
    render(<AgentPage />);
    await flush();
    expect(agentApi.openProject).toHaveBeenCalledOnce();
    expect(agentApi.openProject).toHaveBeenCalledWith(project);
    expect(agentApi.getSession).toHaveBeenCalledWith(selected.id);
    expect(agentApi.getSession).not.toHaveBeenCalledWith(session.id);
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "桌面重启前未提交的草稿",
    );
  });

  it("ignores saved workspace paths that the native project list does not recognize", async () => {
    localStorage.setItem(
      "lolicode.agent.last-selection.v1",
      JSON.stringify({
        projectPath: "D:/fixture/not-in-the-workbench",
        sessionId: session.id,
      }),
    );
    vi.mocked(agentApi.getStatus).mockResolvedValue({
      available: true,
      running: true,
    });
    render(<AgentPage />);
    await flush();
    expect(agentApi.openProject).not.toHaveBeenCalled();
    expect(agentApi.getSession).not.toHaveBeenCalled();
  });

  it("falls back to an unarchived conversation when the saved selection was archived", async () => {
    const archived = { ...session, id: "archived-selection", archived: true };
    localStorage.setItem(
      "lolicode.agent.last-selection.v1",
      JSON.stringify({ projectPath: project, sessionId: archived.id }),
    );
    vi.mocked(agentApi.listSessions).mockResolvedValue([archived, session]);
    render(<AgentPage />);
    await flush();
    expect(agentApi.getSession).toHaveBeenCalledWith(session.id);
    expect(agentApi.getSession).not.toHaveBeenCalledWith(archived.id);
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
      readAgentDraft(
        `lolicode.agent.draft:${encodeURIComponent(project)}:${encodeURIComponent(session.id)}`,
      ),
    ).toBe("原项目后续输入");
    snapshot.status = "idle";
    await tick(1500);
    expect(modelRefreshButton()).toBeEnabled();
  });

  it("distinguishes duplicate workspace names with the shortest path suffix", async () => {
    const otherPath = "D:/other/project";
    vi.mocked(agentApi.listProjects).mockResolvedValue([
      { path: project, name: "同名项目", pinned: false, lastOpenedAt: 2 },
      { path: otherPath, name: "同名项目", pinned: false, lastOpenedAt: 3 },
      { path: "D:/fixture/solo", name: "独立名称", pinned: false, lastOpenedAt: 1 },
    ]);
    render(<AgentPage />);
    await flush();

    expect(
      screen.getByRole("button", {
        name: "收起 同名项目 fixture/project 的任务",
      }),
    ).toBeVisible();
    const other = screen.getByRole("button", { name: "同名项目 other/project" });
    expect(other).toHaveAttribute("title", otherPath);
    expect(screen.getByRole("button", { name: "独立名称" })).toBeVisible();

    fireEvent.click(other);
    expect(agentApi.openProject).toHaveBeenCalledWith(otherPath);
    await flush();
  });

  it("keeps expanded workspace task lists isolated when switching projects and back", async () => {
    const otherPath = "D:/fixture/other-project";
    const anotherSession: AgentSession = {
      ...session,
      id: "lc:81f2ec26-12e1-45d7-851b-c9ac8a472db9",
      title: "当前项目的另一任务",
    };
    const otherSession: AgentSession = {
      ...session,
      id: "lc:80ad8bf2-78bd-4685-a7f1-a663d7a66821",
      title: "其他工作区的任务",
      projectPath: otherPath,
    };
    vi.mocked(agentApi.listProjects).mockResolvedValue([
      { path: project, name: "project", pinned: false, lastOpenedAt: 2 },
      {
        path: otherPath,
        name: "other-project",
        pinned: false,
        lastOpenedAt: 3,
      },
    ]);
    vi.mocked(agentApi.listSessions).mockImplementation(async (path) =>
      path === otherPath ? [otherSession] : [session, anotherSession],
    );
    vi.mocked(agentApi.openProject).mockImplementation(async (path) => ({
      workspace: {
        path,
        name: path === otherPath ? "other-project" : "project",
      },
      catalog,
      sessions: path === otherPath ? [otherSession] : [session, anotherSession],
    }));
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: id === otherSession.id ? otherSession : session,
    }));

    render(<AgentPage />);
    await flush();
    expect(
      within(screen.getByRole("group", { name: "project 的任务" })).getByRole(
        "button",
        { name: /^修复测试/ },
      ),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), {
      target: { value: "修复" },
    });
    expect(
      screen.queryByRole("button", { name: /^当前项目的另一任务/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "other-project" }));
    await flush();

    const previousTasks = within(
      screen.getByRole("group", { name: "project 的任务" }),
    );
    expect(
      previousTasks.getByRole("button", { name: /^修复测试/ }),
    ).toBeInTheDocument();
    expect(
      previousTasks.queryByRole("button", { name: /^其他工作区的任务/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空会话搜索" }));
    expect(
      previousTasks.getByRole("button", { name: /^当前项目的另一任务/ }),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("group", {
          name: "other-project 的任务",
        }),
      ).getByRole("button", { name: /^其他工作区的任务/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "project" }));
    await flush();

    const currentTasks = within(
      screen.getByRole("group", { name: "project 的任务" }),
    );
    const otherTasks = within(
      screen.getByRole("group", { name: "other-project 的任务" }),
    );
    expect(
      currentTasks.getByRole("button", { name: /^修复测试/ }),
    ).toBeInTheDocument();
    expect(
      currentTasks.queryByRole("button", { name: /^其他工作区的任务/ }),
    ).not.toBeInTheDocument();
    expect(
      currentTasks.getByRole("button", { name: /^当前项目的另一任务/ }),
    ).toBeInTheDocument();
    expect(
      otherTasks.getByRole("button", { name: /^其他工作区的任务/ }),
    ).toBeInTheDocument();
    expect(
      otherTasks.queryByRole("button", { name: /^修复测试/ }),
    ).not.toBeInTheDocument();

    const search = screen.getByRole("textbox", { name: "搜索会话" });
    fireEvent.change(search, { target: { value: " EC26-12E1 " } });
    expect(
      currentTasks.getByRole("button", { name: /^当前项目的另一任务/ }),
    ).toBeInTheDocument();
    expect(
      currentTasks.queryByRole("button", { name: /^修复测试/ }),
    ).toBeNull();
    expect(
      otherTasks.queryByRole("button", { name: /^其他工作区的任务/ }),
    ).toBeNull();

    fireEvent.change(search, { target: { value: "LC:80AD8BF2" } });
    expect(
      otherTasks.getByRole("button", { name: /^其他工作区的任务/ }),
    ).toBeInTheDocument();
    expect(
      currentTasks.queryByRole("button", { name: /^当前项目的另一任务/ }),
    ).toBeNull();
  });

  it("shows only unarchived tasks in the previous workspace after leaving its archive view", async () => {
    const otherPath = "D:/fixture/other-project";
    const archivedSession: AgentSession = {
      ...session,
      id: "archived_project_task",
      title: "原项目的归档任务",
      archived: true,
    };
    const otherSession: AgentSession = {
      ...session,
      id: "other_project_task",
      title: "其他工作区的任务",
      projectPath: otherPath,
    };
    vi.mocked(agentApi.listProjects).mockResolvedValue([
      { path: project, name: "project", pinned: false, lastOpenedAt: 2 },
      {
        path: otherPath,
        name: "other-project",
        pinned: false,
        lastOpenedAt: 3,
      },
    ]);
    vi.mocked(agentApi.listSessions).mockImplementation(async (path) =>
      path === otherPath ? [otherSession] : [session, archivedSession],
    );
    vi.mocked(agentApi.openProject).mockResolvedValue({
      workspace: { path: otherPath, name: "other-project" },
      catalog,
      sessions: [otherSession],
    });
    vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
      ...emptySnapshot(),
      session: id === otherSession.id ? otherSession : session,
    }));

    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "显示归档会话" }));
    await flush();
    expect(
      screen.getByRole("button", { name: /^原项目的归档任务/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^修复测试/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "other-project" }));
    await flush();

    const previousTasks = within(
      screen.getByRole("group", { name: "project 的任务" }),
    );
    expect(
      previousTasks.getByRole("button", { name: /^修复测试/ }),
    ).toBeInTheDocument();
    expect(
      previousTasks.queryByRole("button", { name: /^原项目的归档任务/ }),
    ).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole("group", {
          name: "other-project 的任务",
        }),
      ).getByRole("button", { name: /^其他工作区的任务/ }),
    ).toBeInTheDocument();
  });

  it.each(["empty response", "failure"] as const)(
    "ignores a stale workspace expansion %s after opening the project and switching away",
    async (outcome) => {
      const otherPath = "D:/fixture/other-project";
      const otherSession: AgentSession = {
        ...session,
        id: "other_project_task",
        title: "其他工作区的新任务",
        projectPath: otherPath,
      };
      let resolveExpansion!: (items: AgentSession[]) => void;
      let rejectExpansion!: (error: Error) => void;
      const expansion = new Promise<AgentSession[]>((resolve, reject) => {
        resolveExpansion = resolve;
        rejectExpansion = reject;
      });
      vi.mocked(agentApi.listProjects).mockResolvedValue([
        { path: project, name: "project", pinned: false, lastOpenedAt: 2 },
        {
          path: otherPath,
          name: "other-project",
          pinned: false,
          lastOpenedAt: 3,
        },
      ]);
      vi.mocked(agentApi.listSessions).mockImplementation(async (path) =>
        path === otherPath ? expansion : [session],
      );
      vi.mocked(agentApi.openProject).mockImplementation(async (path) => ({
        workspace: {
          path,
          name: path === otherPath ? "other-project" : "project",
        },
        catalog,
        sessions: [path === otherPath ? otherSession : session],
      }));
      vi.mocked(agentApi.getSession).mockImplementation(async (id) => ({
        ...emptySnapshot(),
        session: id === otherSession.id ? otherSession : session,
      }));

      render(<AgentPage />);
      await flush();
      fireEvent.click(
        screen.getByRole("button", { name: "展开 other-project 的任务" }),
      );
      await flush();
      expect(agentApi.listSessions).toHaveBeenCalledWith(otherPath);
      expect(
        within(
          screen.getByRole("group", {
            name: "other-project 的任务",
          }),
        ).getByRole("status"),
      ).toHaveTextContent("正在加载任务…");

      fireEvent.click(screen.getByRole("button", { name: "other-project" }));
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "project" }));
      await flush();

      const otherTasks = within(
        screen.getByRole("group", {
          name: "other-project 的任务",
        }),
      );
      expect(
        otherTasks.getByRole("button", { name: /^其他工作区的新任务/ }),
      ).toBeInTheDocument();
      expect(otherTasks.queryByRole("status")).not.toBeInTheDocument();

      await act(async () => {
        if (outcome === "empty response") resolveExpansion([]);
        else rejectExpansion(new Error("旧工作区请求失败"));
      });
      await flush();

      expect(
        otherTasks.getByRole("button", { name: /^其他工作区的新任务/ }),
      ).toBeInTheDocument();
      expect(otherTasks.queryByRole("status")).not.toBeInTheDocument();
      expect(
        otherTasks.queryByRole("button", { name: "加载失败，点击重试" }),
      ).not.toBeInTheDocument();
      expect(
        otherTasks.queryByText("此工作区还没有任务。"),
      ).not.toBeInTheDocument();
    },
  );

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
    expect(screen.getByRole("button", { name: "模型" })).toHaveAttribute(
      "title",
      "Copilot · Model B",
    );
    fireEvent.click(sessionCreationButton());
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.models[1].id,
      "build",
      undefined,
      undefined,
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
      undefined,
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
    let acknowledge!: () => void;
    vi.mocked(agentApi.sendMessage).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    const view = render(<AgentPage />);
    await flush();
    fill();
    const send = screen.getByRole("button", { name: "发送" });
    fireEvent.click(send, { detail: 1 });
    fireEvent.click(send, { detail: 2 });
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
    const chat = within(view.container.querySelector(".wb-chat-content")!);
    const progress = chat.getByText("正在准备任务…");
    expect(chat.getByText("修复这个项目的测试")).toBeInTheDocument();
    expect(chat.queryByText("正在思考…")).not.toBeInTheDocument();
    const shortcut = screen.getByRole("button", { name: "任务进度" });
    expect(shortcut).toHaveAttribute("aria-controls", progress.id);
    fireEvent.click(shortcut);
    expect(progress).toHaveFocus();
    await act(async () => acknowledge());
    await flush();
    expect(agentApi.sendMessage).toHaveBeenCalledTimes(1);
    const requestId = vi.mocked(agentApi.sendMessage).mock.calls[0][2];
    expect(requestId).toMatch(/^msg_/);
    expect(screen.getByText("正在准备任务…")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue("");
    await expectFolderEnabled();
    await tick();
    expect(screen.getByText("正在准备任务…")).toBeInTheDocument();
    snapshot.messages = [
      {
        id: requestId,
        role: "user",
        createdAt: 3,
        parts: [{ type: "text", text: "修复这个项目的测试" }],
      },
    ];
    await tick();
    expect(screen.getByText("正在准备任务…")).toBeInTheDocument();
    snapshot.status = "running";
    snapshot.modelPhase = "waiting";
    await tick();
    expect(chat.getByText("正在等待模型响应…")).toBeInTheDocument();
    snapshot.modelPhase = "streaming";
    snapshot.messages.push({
      id: "msg_assistant",
      role: "assistant",
      createdAt: 4,
      parts: [{ type: "reasoning", text: "先确定检查顺序" }],
    });
    await tick();
    expect(chat.getByText("正在思考…")).toBeInTheDocument();
    snapshot.messages[1].parts.push({ type: "text", text: "开始检查测试" });
    await tick();
    expect(screen.getByText("正在回复…")).toBeInTheDocument();
    expect(screen.getByText("开始检查测试")).toBeInTheDocument();
    snapshot.messages[1].parts = [
      { type: "text", text: "开始检查测试，找到了原因" },
    ];
    await tick();
    expect(screen.getByText("开始检查测试，找到了原因")).toBeInTheDocument();
    snapshot.status = "idle";
    snapshot.modelPhase = undefined;
    snapshot.messages[1].completedAt = 5;
    await tick();
    expect(chat.queryByText("正在回复…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "任务进度" })).not.toBeInTheDocument();
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
    expect(screen.queryByText("正在准备任务…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("shows a message with its image immediately, then replaces it in place when Harness publishes it", async () => {
    let acknowledge!: () => void;
    let finishBackup!: () => void;
    vi.mocked(agentApi.sendMessage).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    const backup = vi.spyOn(agentImageStore, "saveAgentImageAttachments");
    backup.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishBackup = resolve;
      }),
    );
    try {
      const view = render(<AgentPage />);
      await flush();
      fireEvent.change(view.container.querySelector('input[type="file"]')!, {
        target: {
          files: [new File(["test"], "preview.png", { type: "image/png" })],
        },
      });
      await tick(100);
      expect(
        screen.getByRole("button", { name: "移除图片：preview.png" }),
      ).toBeVisible();
      fill("现在显示这条消息");
      fireEvent.click(screen.getByRole("button", { name: "发送" }));

      const row = screen.getByRole("article", { name: "你的消息" });
      expect(row).toHaveTextContent("现在显示这条消息");
      expect(within(row).getByRole("img", { name: "preview.png" })).toBeVisible();
      expect(screen.queryByText("今天想完成什么？")).not.toBeInTheDocument();
      expect(agentApi.sendMessage).toHaveBeenCalledOnce();
      const requestId = vi.mocked(agentApi.sendMessage).mock.calls[0][2];
      await act(async () => acknowledge());
      await flush();
      expect(screen.getByRole("article", { name: "你的消息" })).toBe(row);

      snapshot.status = "running";
      snapshot.messages = [{
        id: requestId,
        role: "user",
        createdAt: 2,
        parts: [{ type: "text", text: "现在显示这条消息" }],
      }];
      await tick();
      expect(screen.getByRole("article", { name: "你的消息" })).toBe(row);
    } finally {
      finishBackup();
      backup.mockRestore();
    }
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
    expect(
      screen.queryByRole("article", { name: "你的消息" }),
    ).not.toBeInTheDocument();
    const requestId = vi.mocked(agentApi.sendMessage).mock.calls[0][2];
    view.unmount();
    sessionStorage.clear();
    localStorage.removeItem(
      `lolicode.agent.draft-record:lolicode.agent.draft:${encodeURIComponent(project)}:${session.id}`,
    ); // Recover the draft from the submission when its own record is missing.
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
    sessionStorage.clear();
    const second = render(<AgentPage />);
    await flush();
    fill("下一条尚未提交的 B");
    await act(async () => {
      acknowledge();
    });
    await flush();
    second.unmount();
    sessionStorage.clear();
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

  it("keeps a warm native observer while a later turn receives its own request and Stop", async () => {
    const current = openNativeFixture();
    snapshot.messages = [];
    let accept!: (message: AgentNativeSessionWatchMessage) => void;
    let subscriptionId = "";
    vi.mocked(agentApi.watchSessionNative).mockImplementation(
      (_session, id, onMessage) => {
        subscriptionId = id;
        accept = onMessage;
        return new Promise<boolean>(() => {});
      },
    );
    render(<AgentPage initialProjectPath={project} />);
    await flush();
    await tick(80);
    act(() => accept({
      subscriptionId,
      frame: {
        type: "snapshot",
        header: {
          version: 4,
          id: current.id.slice(3) as Extract<
            Extract<AgentNativeSessionWatchMessage, { frame: unknown }>["frame"],
            { type: "snapshot" }
          >["header"]["id"],
          createdAt: 1,
          isSeeded: false,
        },
        records: [],
        cursor: -1,
        hasMore: false,
        projections: { asOfSeq: -1, values: {} },
        assistantStream: { revision: 0 },
      },
    }));
    fill("第一轮任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    const firstRequest = vi.mocked(agentApi.sendMessage).mock.calls[0][2];
    snapshot.status = "running";
    snapshot.messages = [{
      id: firstRequest,
      role: "user",
      createdAt: 3,
      parts: [{ type: "text", text: "第一轮任务" }],
    }];
    await tick();
    snapshot.status = "idle";
    snapshot.messages.push({
      id: "first-turn-result",
      role: "assistant",
      createdAt: 4,
      completedAt: 5,
      parts: [{ type: "text", text: "第一轮完成" }],
    });
    await tick();
    expect(readAgentSubmission(project, current.id)).toBeNull();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "模型" })).toBeEnabled();
    expect(agentApi.watchSessionNative).toHaveBeenCalledTimes(1);
    expect(agentApi.stopSessionNative).not.toHaveBeenCalled();

    let acknowledge!: () => void;
    vi.mocked(agentApi.sendMessage).mockReturnValueOnce(new Promise<void>((resolve) => {
      acknowledge = resolve;
    }));
    fill("第二轮任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    const secondRequest = vi.mocked(agentApi.sendMessage).mock.calls[1][2];
    expect(secondRequest).not.toBe(firstRequest);
    expect(readAgentSubmission(project, current.id)).toMatchObject({
      requestId: secondRequest,
      stopRequested: false,
    });
    const stop = screen.getByRole("button", { name: "停止" });
    fireEvent.click(stop);
    fireEvent.click(stop);
    await flush();
    await tick();
    expect(agentApi.interruptSession).toHaveBeenCalledTimes(1);
    expect(readAgentSubmission(project, current.id)).toMatchObject({
      requestId: secondRequest,
      phase: "submitting",
      stopRequested: true,
    });
    expect(screen.getByText("正在停止…")).toBeInTheDocument();
    await act(async () => acknowledge());
    await flush();
    expect(agentApi.interruptSession).toHaveBeenCalledTimes(2);
    expect(agentApi.interruptSession).toHaveBeenNthCalledWith(1, current.id, secondRequest);
    expect(agentApi.interruptSession).toHaveBeenNthCalledWith(2, current.id, secondRequest);
    await tick();
    expect(readAgentSubmission(project, current.id)).toBeNull();
    expect(screen.queryByText("正在停止…")).not.toBeInTheDocument();

    fill("第三轮任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    const thirdRequest = vi.mocked(agentApi.sendMessage).mock.calls[2][2];
    expect([firstRequest, secondRequest]).not.toContain(thirdRequest);
    expect(readAgentSubmission(project, current.id)).toMatchObject({
      requestId: thirdRequest,
      stopRequested: false,
    });
    expect(agentApi.interruptSession).toHaveBeenCalledTimes(2);
    expect(agentApi.watchSessionNative).toHaveBeenCalledTimes(1);
    expect(agentApi.stopSessionNative).not.toHaveBeenCalled();
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
    expect(screen.getByText("正在准备任务…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
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
    expect(screen.queryByText("正在准备任务…")).not.toBeInTheDocument();
    expect(readAgentSubmission(project, session.id)).toBeNull();
    fill("保留给用户手动继续的草稿");
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    expect(agentApi.sendMessage).toHaveBeenCalledOnce();
    const [original] = vi.mocked(agentApi.sendMessage).mock.calls;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await flush();
    const calls = vi.mocked(agentApi.sendMessage).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([
      session.id,
      original[1],
      expect.any(String),
      [],
      [],
    ]);
    expect(calls[1][2]).not.toBe(original[2]);
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留给用户手动继续的草稿",
    );
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

      expect(screen.getByText("正在准备任务…")).toBeInTheDocument();
      expect(screen.queryByText("本轮运行失败")).not.toBeInTheDocument();
      fill("新草稿");
      expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
      fireEvent.keyDown(screen.getByLabelText("发送给 Agent 的消息"), {
        key: "Enter",
      });
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
    fireEvent.keyDown(screen.getByLabelText("发送给 Agent 的消息"), {
      key: "Enter",
    });
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
    expect(screen.getByText("正在准备任务…")).toBeInTheDocument();
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
    expect(screen.queryByText("准备就绪")).not.toBeInTheDocument();
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
    expect(screen.getByText("正在准备任务…")).toBeInTheDocument();
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
    expect(screen.queryByText("正在准备任务…")).not.toBeInTheDocument();
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

  it("updates an expanded inactive workspace title from polls and durable title notices", async () => {
    const otherPath = "D:/fixture/other-project";
    const other = {
      ...session,
      id: "other-task",
      projectPath: otherPath,
      title: "初始后台任务",
    };
    const background: AgentSnapshot = {
      ...emptySnapshot(),
      session: other,
      titlePending: true,
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
      path === otherPath
        ? [{ ...other, activity: { status: "idle", titlePending: true } }]
        : [session],
    );
    let finishRead: ((value: AgentSnapshot) => void) | undefined;
    let holdRead = false;
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === other.id
        ? holdRead
          ? new Promise((resolve) => {
              finishRead = resolve;
            })
          : structuredClone(background)
        : structuredClone(snapshot),
    );
    render(<AgentPage />);
    await flush();
    fill("留在当前会话的草稿");
    fireEvent.click(
      screen.getByRole("button", { name: "展开 other-project 的任务" }),
    );
    await flush();
    const list = within(
      screen.getByRole("group", { name: "other-project 的任务" }),
    );
    expect(list.getByRole("button", { name: other.title })).toBeVisible();

    background.session = { ...other, title: "后台轮询已同步" };
    await tick(1500);
    expect(
      list.getByRole("button", { name: background.session.title }),
    ).toBeVisible();

    holdRead = true;
    await tick(1500);
    expect(finishRead).toBeDefined();
    const fallback = {
      type: "changed",
      sessionId: other.id,
      projectPath: otherPath,
      updatedAt: other.updatedAt + 1,
      title: "首条消息生成的临时标题",
    };
    act(() => emitTauriEvent("agent-session-update", fallback));
    expect(list.getByRole("button", { name: fallback.title })).toBeVisible();
    act(() =>
      emitTauriEvent("agent-session-update", {
        ...fallback,
        updatedAt: fallback.updatedAt + 1,
        title: "自动归纳的新标题",
      }),
    );
    expect(list.getByRole("button", { name: "自动归纳的新标题" })).toBeVisible();
    act(() => emitTauriEvent("agent-session-update", fallback));
    finishRead?.(structuredClone(background));
    await flush();
    expect(list.getByRole("button", { name: "自动归纳的新标题" })).toBeVisible();
    expect(screen.getByRole("heading", { name: session.title })).toBeVisible();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "留在当前会话的草稿",
    );
    expect(agentApi.openProject).not.toHaveBeenCalled();
  });

  it("updates the selected title immediately and keeps a saved name over stale automatic title updates", async () => {
    const previous = { ...session, title: "自动归纳标题" };
    const renamed = {
      ...previous,
      title: "我的手动标题",
      updatedAt: session.updatedAt + 1,
    };
    vi.mocked(agentApi.renameSession).mockImplementation(async () => {
      snapshot.session = renamed;
      return renamed;
    });
    render(<AgentPage />);
    await flush();
    const titleNotice = {
      type: "changed",
      sessionId: session.id,
      projectPath: project,
      updatedAt: previous.updatedAt,
      title: previous.title,
    };
    act(() => emitTauriEvent("agent-session-update", titleNotice));
    expect(screen.getByRole("heading", { name: previous.title })).toBeVisible();
    fireEvent.keyDown(
      screen.getByRole("button", { name: `管理会话：${previous.title}` }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "会话名称" });
    expect(input).toHaveValue(previous.title);
    fireEvent.change(input, { target: { value: renamed.title } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await flush();
    expect(agentApi.renameSession).toHaveBeenCalledWith(
      session.id,
      renamed.title,
    );
    expect(screen.getByRole("heading", { name: renamed.title })).toBeVisible();

    snapshot.session = previous;
    act(() => emitTauriEvent("agent-session-update", titleNotice));
    await tick(100);
    expect(screen.getByRole("heading", { name: renamed.title })).toBeVisible();
    expect(screen.getByRole("button", { name: renamed.title })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
    expect(screen.queryByText("准备就绪")).not.toBeInTheDocument();
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
