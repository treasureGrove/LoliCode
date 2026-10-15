import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPage } from "@/components/agent/AgentPage";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  captureAgentDraft,
  readAgentSubmission,
  saveAgentSubmission,
} from "@/lib/agentInputLedger";
import type { AgentCatalog, AgentSession, AgentSnapshot } from "@/types/agent";
import { emitTauriEvent } from "../msw/tauriMocks";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    getStatus: vi.fn(),
    getCatalog: vi.fn(),
    getCatalogRevision: vi.fn(),
    openProject: vi.fn(),
    listSessions: vi.fn(),
    listProjects: vi.fn(),
    setProjectMetadata: vi.fn(),
    removeProject: vi.fn(),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    renameSession: vi.fn(),
    setSessionMetadata: vi.fn(),
    deleteSession: vi.fn(),
    getExtensions: vi.fn(),
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
async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}
async function tick(ms = 800) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
function fill(text = "修复这个项目的测试") {
  fireEvent.change(screen.getByLabelText("发送给 Agent 的消息"), {
    target: { value: text },
  });
}

beforeEach(() => {
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
        }),
        ...(patch.mode && { mode: patch.mode }),
        ...(patch.permissionMode && { permissionMode: patch.permissionMode }),
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AgentPage", () => {
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
      fireEvent.click(
        screen.getByRole("button", {
          name: action === "open" ? "切换项目" : "刷新可用模型",
        }),
      );
      await flush();
      for (const warning of warnings)
        expect(toast.warning).toHaveBeenCalledWith(warning);
      expect(
        screen.getByRole("heading", { name: "开始新的任务" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      snapshot.session = { ...session, id: "lc:new" };
      fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
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
      expect(screen.getByRole("button", { name: "分析" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "实现" })).toBeDisabled();
      expect(screen.getByLabelText(`管理会话：${legacy.title}`)).toBeDisabled();
      fireEvent.change(screen.getByLabelText("模型", { exact: true }), {
        target: { value: catalog.models[1].id },
      });
      fireEvent.change(screen.getByLabelText("执行权限"), {
        target: { value: "auto" },
      });
      fireEvent.submit(input.closest("form")!);
      await flush();
      expect(agentApi.sendMessage).not.toHaveBeenCalled();
      expect(agentApi.updateSession).not.toHaveBeenCalled();

      expect(screen.getByRole("button", { name: "切换项目" })).toBeEnabled();
      snapshot = { ...emptySnapshot(), session: { ...session, id: "lc:new" } };
      fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
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
    expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled();
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
    expect(
      screen.getByRole("option", { name: /Added Model/ }),
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
    fireEvent.change(screen.getByLabelText("模型", { exact: true }), {
      target: { value: catalog.models[1].id },
    });
    await flush();
    expect(screen.getByLabelText("模型", { exact: true })).toHaveValue(
      catalog.models[0].id,
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
    fireEvent.change(screen.getByLabelText("模型", { exact: true }), {
      target: { value: catalog.models[1].id },
    });
    await flush();
    await tick(5000);
    expect(screen.getByLabelText("模型", { exact: true })).toHaveValue(
      catalog.models[1].id,
    );
    snapshot.session.model = {
      providerId: catalog.models[1].providerId,
      modelId: catalog.models[1].modelId,
    };
    await tick(5000);
    expect(screen.getByText("Copilot · Model B · 实现")).toBeInTheDocument();
  });

  it("changes Auto Mode in the real session and treats analysis as an independent read-only mode", async () => {
    render(<AgentPage />);
    await flush();
    fireEvent.change(screen.getByLabelText("执行权限"), {
      target: { value: "auto" },
    });
    await flush();
    expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
      permissionMode: "auto",
    });
    expect(
      screen.getByText(/常规编辑与已识别的安全命令自动允许/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "分析" }));
    await flush();
    expect(agentApi.updateSession).toHaveBeenLastCalledWith(session.id, {
      mode: "plan",
    });
    expect(screen.getByLabelText("执行权限")).toHaveValue("auto");
    expect(screen.getByText(/分析模式只读取文件/)).toBeInTheDocument();
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

  it("disables changing the running session configuration and never sends a fake update", async () => {
    snapshot.status = "running";
    render(<AgentPage />);
    await flush();
    expect(screen.getByLabelText("模型", { exact: true })).toBeDisabled();
    expect(screen.getByLabelText("执行权限")).toBeDisabled();
    expect(screen.getByRole("button", { name: "分析" })).toBeDisabled();
    expect(agentApi.updateSession).not.toHaveBeenCalled();
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
    expect(screen.getByRole("button", { name: "刷新可用模型" })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "刷新可用模型" })).toBeEnabled();
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
    fireEvent.click(screen.getByRole("button", { name: "刷新可用模型" }));
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
    fireEvent.change(screen.getByLabelText("模型", { exact: true }), {
      target: { value: catalog.models[1].id },
    });
    await flush();
    expect(agentApi.updateSession).toHaveBeenCalledWith(session.id, {
      modelId: catalog.models[1].id,
    });
    expect(screen.getByText("Copilot · Model B · 实现")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "分析" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.models[1].id,
      "plan",
      undefined,
      "ask",
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
    fireEvent.click(screen.getByRole("button", { name: "选择项目" }));
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
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "渠道与模型" }));
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
    expect(
      screen.getByRole("option", { name: "DeepSeek · Code Model" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", {
        name: "DeepSeek · DeepSeek · Code Model",
      }),
    ).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "刷新可用模型" }));
    await flush();
    expect(agentApi.openProject).toHaveBeenCalledWith(project, true);
    expect(agentApi.getCatalog).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "正在查看的会话" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "刷新后继续的草稿",
    );
    fireEvent.change(screen.getByLabelText("模型", { exact: true }), {
      target: { value: "lolicode/new-channel/new-model" },
    });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      "lolicode/new-channel/new-model",
      "build",
      undefined,
      "ask",
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
    const refresh = screen.getByRole("button", { name: "刷新可用模型" });
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
    fireEvent.click(screen.getByRole("button", { name: "刷新可用模型" }));
    await flush();
    expect(
      screen.getByText("当前项目还有任务在执行，请等待完成。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "保留这段输入",
    );
    expect(
      screen.getByRole("option", { name: "DeepSeek · Code Model" }),
    ).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "切换项目" })).toBeEnabled();
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
    expect(screen.getByText("正在执行…")).toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText("模型", { exact: true }), {
      target: { value: catalog.models[1].id },
    });
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
    expect(screen.getByRole("button", { name: "切换项目" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "刷新可用模型" })).toBeDisabled();
    snapshot.status = "idle";
    await tick(1500);
    expect(screen.getByRole("button", { name: "切换项目" })).toBeEnabled();
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
    expect(screen.getByText("正在执行…")).toBeInTheDocument();
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
    expect(screen.getByText("运行命令")).toBeInTheDocument();
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.queryByText(/not-for-display/)).not.toBeInTheDocument();
    expect(screen.getByText(/文件修改 · 1 个文件/)).toBeInTheDocument();
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
