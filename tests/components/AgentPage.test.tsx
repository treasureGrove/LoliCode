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
import type { AgentCatalog, AgentSession, AgentSnapshot } from "@/types/agent";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    getStatus: vi.fn(),
    getCatalog: vi.fn(),
    openProject: vi.fn(),
    listSessions: vi.fn(),
    createSession: vi.fn(),
    getSession: vi.fn(),
    sendMessage: vi.fn(),
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
  id: "ses_first",
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
  sessionStorage.clear();
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
  vi.mocked(agentApi.listSessions)
    .mockReset()
    .mockResolvedValue([structuredClone(session)]);
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
      id: "ses_new",
      title: "新会话",
    });
  vi.mocked(agentApi.sendMessage).mockReset().mockResolvedValue();
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
  it("rejoins the existing project and keeps the bound model distinct from new-session choices", async () => {
    render(<AgentPage />);
    await flush();
    expect(
      screen.getByRole("heading", { name: "修复测试" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("新会话模型"), {
      target: { value: catalog.models[1].id },
    });
    expect(
      screen.getByText("DeepSeek · Code Model · 实现"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "分析" }));
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.models[1].id,
      "plan",
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
    const second = { ...session, id: "ses_second", title: "正在查看的会话" };
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
    fireEvent.click(screen.getByRole("button", { name: /正在查看的会话/ }));
    await flush();
    fill("刷新后继续的草稿");
    fireEvent.click(screen.getByRole("button", { name: "刷新可用模型" }));
    await flush();
    expect(agentApi.openProject).toHaveBeenCalledWith(project);
    expect(agentApi.getCatalog).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "正在查看的会话" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "刷新后继续的草稿",
    );
    fireEvent.change(screen.getByLabelText("新会话模型"), {
      target: { value: "lolicode/new-channel/new-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      "lolicode/new-channel/new-model",
      "build",
    );
  });

  it("does not refresh or replace the bound catalog while any known project session is running", async () => {
    const second = { ...session, id: "ses_second", title: "历史会话" };
    snapshot.status = "running";
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === session.id
        ? structuredClone(snapshot)
        : { ...emptySnapshot(), session: second },
    );
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /历史会话/ }));
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
    expect(screen.getByRole("button", { name: "切换项目" })).toBeDisabled();
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
    const second = { ...session, id: "ses_second", title: "另一段会话" };
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
    fireEvent.click(screen.getByRole("button", { name: /另一段会话/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /修复测试/ }));
    await flush();
    expect(screen.getByLabelText("发送给 Agent 的消息")).toHaveValue(
      "第一个草稿",
    );
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });

  it("keeps observing a running conversation while another history is selected", async () => {
    const second = { ...session, id: "ses_second", title: "完成的会话" };
    snapshot.status = "running";
    vi.mocked(agentApi.listSessions).mockResolvedValue([session, second]);
    vi.mocked(agentApi.getSession).mockImplementation(async (id) =>
      id === session.id
        ? structuredClone(snapshot)
        : { ...emptySnapshot(), session: second },
    );
    render(<AgentPage />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /完成的会话/ }));
    await flush();
    expect(screen.getByRole("button", { name: "切换项目" })).toBeDisabled();
    snapshot.status = "idle";
    await tick(1500);
    expect(screen.getByRole("button", { name: "切换项目" })).toBeEnabled();
    expect(agentApi.interruptSession).not.toHaveBeenCalled();
  });

  it("keeps an in-flight stop associated with its original conversation when another history is selected", async () => {
    const second = { ...session, id: "ses_second", title: "完成的会话" };
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
    fireEvent.click(screen.getByRole("button", { name: /完成的会话/ }));
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
