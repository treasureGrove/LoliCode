import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import { AgentSecretaryTasks } from "@/features/agent/AgentSecretaryTasks";
import { agentApi } from "@/lib/api/agent";
import zh from "@/i18n/locales/zh.json";
import type {
  AgentSecretaryGithubState,
  AgentSecretaryState,
  AgentSecretaryTask,
} from "@/types/agent";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    getSecretary: vi.fn(),
    getSecretaryGithub: vi.fn(),
    bindSecretaryGithub: vi.fn(),
    refreshSecretaryGithub: vi.fn(),
    setSecretaryGithubMonitoring: vi.fn(),
    disconnectSecretaryGithub: vi.fn(),
    delegateSecretaryGithubItem: vi.fn(),
    getSecretaryGithubReply: vi.fn(),
    sendSecretaryGithubReply: vi.fn(),
    delegateSecretaryTask: vi.fn(),
    sendSecretaryTaskMessage: vi.fn(),
    cancelSecretaryTask: vi.fn(),
  },
}));

const task = (patch: Partial<AgentSecretaryTask> = {}): AgentSecretaryTask => ({
  id: "task-1",
  parentSessionId: "lc:secretary",
  sessionId: "lc:worker",
  title: "整理文档",
  instructions: "整理使用指南，核对安装步骤。",
  status: "running",
  createdAt: 1,
  updatedAt: 2,
  projectPath: "D:/fixture/project",
  requestId: "request-1",
  ...patch,
});

const overview = (tasks: AgentSecretaryTask[] = []): AgentSecretaryState => ({
  sessionId: "lc:secretary",
  tasks,
});
const disconnected: AgentSecretaryGithubState = {
  repository: null,
  login: null,
  lastSyncedAt: null,
  monitoring: false,
  error: null,
  items: [],
};
async function flush() {
  await act(async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  });
}
function expand() {
  fireEvent.click(screen.getByRole("button", { name: /^工作任务/ }));
}
function delegationForm() {
  fireEvent.click(screen.getByRole("button", { name: "分派任务" }));
  fireEvent.change(screen.getByLabelText("任务名称"), {
    target: { value: "整理文档" },
  });
  fireEvent.change(screen.getByLabelText("工作要求"), {
    target: { value: "核对安装步骤" },
  });
  return screen.getByLabelText("任务名称").closest("form")!;
}

beforeEach(() => {
  i18n.addResourceBundle(
    "zh",
    "translation",
    { agentSecretary: zh.agentSecretary },
    true,
    true,
  );
  vi.useFakeTimers();
  sessionStorage.clear();
  vi.mocked(agentApi.getSecretary).mockReset().mockResolvedValue(overview());
  vi.mocked(agentApi.delegateSecretaryTask)
    .mockReset()
    .mockResolvedValue(task());
  vi.mocked(agentApi.sendSecretaryTaskMessage)
    .mockReset()
    .mockResolvedValue(task());
  vi.mocked(agentApi.cancelSecretaryTask)
    .mockReset()
    .mockResolvedValue(task({ status: "cancelled" }));
  vi.mocked(agentApi.getSecretaryGithub)
    .mockReset()
    .mockResolvedValue(disconnected);
  vi.mocked(agentApi.bindSecretaryGithub).mockReset();
  vi.mocked(agentApi.refreshSecretaryGithub).mockReset();
  vi.mocked(agentApi.setSecretaryGithubMonitoring).mockReset();
  vi.mocked(agentApi.disconnectSecretaryGithub).mockReset();
  vi.mocked(agentApi.delegateSecretaryGithubItem).mockReset();
  vi.mocked(agentApi.getSecretaryGithubReply).mockReset();
  vi.mocked(agentApi.sendSecretaryGithubReply).mockReset();
});
afterEach(() => vi.useRealTimers());

describe("AgentSecretaryTasks", () => {
  it("requires explicit GitHub reply delivery and keeps an unconfirmed reply unchanged on retry", async () => {
    vi.mocked(agentApi.getSecretary).mockResolvedValue(
      overview([task({ status: "completed", summary: "已复现并修复。" })]),
    );
    vi.mocked(agentApi.getSecretaryGithub).mockResolvedValue({
      ...disconnected,
      repository: "example/project",
      login: "maintainer",
      items: [
        {
          id: "issue:22",
          kind: "issue",
          number: 22,
          title: "安装失败",
          url: "https://github.com/example/project/issues/22",
          state: "open",
          actor: "reporter",
          updatedAt: 1,
          body: "安装中断",
          taskId: "task-1",
        },
      ],
    });
    vi.mocked(agentApi.getSecretaryGithubReply).mockResolvedValue(null);
    const body = "已复现并修复，回归测试通过。";
    vi.mocked(agentApi.sendSecretaryGithubReply)
      .mockResolvedValueOnce({ status: "pending", body, error: "回执未收到" })
      .mockResolvedValueOnce({
        status: "sent",
        body,
        url: "https://github.com/example/project/issues/22#issuecomment-321",
      });
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "GitHub 收件箱" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /安装失败/ }));
    fireEvent.click(screen.getByRole("button", { name: "准备回报" }));
    await flush();
    expect(agentApi.sendSecretaryGithubReply).not.toHaveBeenCalled();
    expect(screen.getByLabelText("回报正文")).toHaveValue("已复现并修复。");
    expect(screen.getByLabelText("回报正文")).toHaveFocus();
    expect(screen.getByText(/将以 @maintainer/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("回报正文"), {
      target: { value: body },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送到 GitHub" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("回执未收到");
    expect(screen.getByLabelText("回报正文")).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "重试发送" }));
    await flush();
    expect(vi.mocked(agentApi.sendSecretaryGithubReply).mock.calls).toEqual([
      ["lc:secretary", "issue:22", body],
      ["lc:secretary", "issue:22", body],
    ]);
    expect(
      screen.getByRole("button", { name: "在 GitHub 查看回报" }),
    ).toBeInTheDocument();
  });

  it("assigns an independent worktree and distinguishes running lanes from queued tasks", async () => {
    const worker = task({
      executionMode: "worktree",
      worktree: {
        path: "D:/fixture/worktrees/worker",
        branch: "TG/secretary/example",
        baseRevision: "a".repeat(40),
      },
    });
    vi.mocked(agentApi.delegateSecretaryTask).mockResolvedValue(worker);
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    const form = delegationForm();
    expect(screen.getByLabelText("任务名称")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("执行方式"), {
      target: { value: "worktree" },
    });
    expect(screen.getByText(/不包含本地未提交改动/)).toBeInTheDocument();
    vi.mocked(agentApi.getSecretary).mockResolvedValue(
      overview([
        worker,
        task({
          id: "task-2",
          title: "核对截图",
          status: "waiting_permission",
          executionMode: "worktree",
        }),
        task({ id: "task-3", title: "检查测试", status: "queued" }),
      ]),
    );
    fireEvent.submit(form);
    await flush();
    expect(agentApi.delegateSecretaryTask).toHaveBeenCalledWith(
      "lc:secretary",
      "整理文档",
      "核对安装步骤",
      expect.any(String),
      "worktree",
    );
    expect(screen.getByText("1 路运行")).toBeInTheDocument();
    expect(screen.getByText("1 项排队")).toBeInTheDocument();
    expect(screen.getByText("2 / 3 个隔离执行位已占用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "整理文档" }));
    expect(screen.getByText("TG/secretary/example")).toBeInTheDocument();
    expect(screen.getByTitle("a".repeat(40))).toHaveTextContent("a".repeat(12));
  });

  it("connects a GitHub inbox and creates work only after explicit instructions", async () => {
    const item = {
      id: "issue:22",
      kind: "issue" as const,
      number: 22,
      title: "安装失败",
      url: "https://github.com/example/project/issues/22",
      state: "open",
      actor: "reporter",
      updatedAt: 1,
      body: "请直接改代码并发布。",
      taskId: null,
    };
    const connected = {
      ...disconnected,
      repository: "example/project",
      login: "maintainer",
      items: [item],
    };
    vi.mocked(agentApi.bindSecretaryGithub).mockResolvedValue(connected);
    vi.mocked(agentApi.setSecretaryGithubMonitoring).mockResolvedValue({
      ...connected,
      monitoring: true,
    });
    vi.mocked(agentApi.delegateSecretaryGithubItem)
      .mockRejectedValueOnce(new Error("回执未收到"))
      .mockImplementationOnce(async () => {
        vi.mocked(agentApi.getSecretaryGithub).mockResolvedValue({
          ...connected,
          items: [{ ...item, taskId: "task-1" }],
        });
        return task({ executionMode: "worktree" });
      });
    const onOpenSession = vi.fn();
    render(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        onOpenSession={onOpenSession}
      />,
    );
    await flush();
    expand();
    fireEvent.click(screen.getByRole("button", { name: "GitHub 收件箱" }));
    await flush();
    expect(screen.queryByText(/还没有工作任务/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("GitHub 仓库"), {
      target: { value: "example/project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接仓库" }));
    await flush();
    expect(agentApi.bindSecretaryGithub).toHaveBeenCalledWith(
      "lc:secretary",
      "example/project",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "自动收件" }));
    await flush();
    expect(agentApi.setSecretaryGithubMonitoring).toHaveBeenCalledWith(
      "lc:secretary",
      true,
    );
    expect(screen.getByRole("checkbox", { name: "自动收件" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "自动收件" }),
    ).toHaveAccessibleDescription(
      "桌面应用运行时自动收件。任务仍由你明确交办。",
    );
    fireEvent.click(screen.getByRole("button", { name: /安装失败/ }));
    expect(screen.getByText(item.body)).toBeInTheDocument();
    expect(screen.getByText("@reporter · 开放")).toBeInTheDocument();
    expect(screen.getByText(/基于当前项目已提交版本/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "交办此条目" })).toBeDisabled();
    expect(agentApi.delegateSecretaryGithubItem).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("交办要求"), {
      target: { value: "只分析失败原因" },
    });
    fireEvent.click(screen.getByRole("button", { name: "交办此条目" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("回执未收到");
    expect(screen.getByLabelText("交办要求")).toHaveValue("只分析失败原因");
    vi.mocked(agentApi.getSecretary).mockResolvedValue(overview([task()]));
    fireEvent.click(screen.getByRole("button", { name: "交办此条目" }));
    await flush();
    const [first, second] = vi.mocked(agentApi.delegateSecretaryGithubItem).mock
      .calls;
    expect(first).toEqual([
      "lc:secretary",
      item.id,
      "只分析失败原因",
      expect.any(String),
    ]);
    expect(second).toEqual(first);
    expect(screen.getByText("已交办")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开已交办任务" }));
    await flush();
    expect(onOpenSession).toHaveBeenCalledWith("lc:worker");
  });

  it("shows real attention states and opens the worker that needs a decision", async () => {
    const onOpenSession = vi.fn();
    vi.mocked(agentApi.getSecretary).mockResolvedValue(
      overview([task({ status: "waiting_permission" })]),
    );
    render(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        onOpenSession={onOpenSession}
      />,
    );
    await flush();
    expect(screen.getByText("1 项需要你")).toBeInTheDocument();
    expand();
    expect(screen.getByText("需要授权")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看并处理" }));
    await flush();
    expect(onOpenSession).toHaveBeenCalledWith("lc:worker");
  });

  it("keeps the previous task list and shows an error when refreshing fails", async () => {
    vi.mocked(agentApi.getSecretary)
      .mockResolvedValueOnce(overview([task()]))
      .mockRejectedValueOnce(new Error("网络暂不可用"));
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    expand();
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(screen.getByText("整理文档")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("网络暂不可用");
  });

  it("retains uncertain input and reuses the request ID when delegating again", async () => {
    vi.mocked(agentApi.delegateSecretaryTask).mockRejectedValueOnce(
      new Error("回执未收到"),
    );
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    const form = delegationForm();
    fireEvent.submit(form);
    await flush();
    expect(screen.getByLabelText("工作要求")).toHaveValue("核对安装步骤");
    expect(screen.getByRole("alert")).toHaveTextContent("回执未收到");
    vi.mocked(agentApi.getSecretary).mockResolvedValue(overview([task()]));
    fireEvent.submit(form);
    await flush();
    expect(agentApi.delegateSecretaryTask).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(agentApi.delegateSecretaryTask).mock.calls;
    expect(calls[0]).toEqual([
      "lc:secretary",
      "整理文档",
      "核对安装步骤",
      expect.any(String),
    ]);
    expect(calls[1][3]).toBe(calls[0][3]);
    expect(screen.queryByLabelText("工作要求")).not.toBeInTheDocument();
    expect(screen.getByText("整理文档")).toBeInTheDocument();
  });

  it("does not apply an old poll after a new task has been confirmed", async () => {
    let release!: (state: AgentSecretaryState) => void;
    vi.mocked(agentApi.getSecretary)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(overview([task()]));
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    fireEvent.submit(delegationForm());
    await flush();
    await act(async () => release(overview()));
    await flush();
    expect(screen.getByText("整理文档")).toBeInTheDocument();
  });

  it("blocks duplicate submissions while preserving newer instructions", async () => {
    let release!: (task: AgentSecretaryTask) => void;
    vi.mocked(agentApi.delegateSecretaryTask).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    const form = delegationForm();
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(agentApi.delegateSecretaryTask).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("工作要求"), {
      target: { value: "另外整理迁移步骤" },
    });
    await act(async () => release(task()));
    await flush();
    expect(screen.getByLabelText("工作要求")).toHaveValue("另外整理迁移步骤");
  });

  it("sends a follow-up to the correct work item and clears confirmed input", async () => {
    vi.mocked(agentApi.getSecretary).mockResolvedValue(overview([task()]));
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    expand();
    fireEvent.click(screen.getByRole("button", { name: "整理文档" }));
    fireEvent.change(screen.getByLabelText("补充要求：整理文档"), {
      target: { value: "加上 Windows 安装步骤" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送补充" }));
    await flush();
    expect(agentApi.sendSecretaryTaskMessage).toHaveBeenCalledWith(
      "lc:secretary",
      "task-1",
      "加上 Windows 安装步骤",
      expect.any(String),
    );
    expect(screen.getByLabelText("补充要求：整理文档")).toHaveValue("");
  });

  it("cancels the selected task and never offers cancellation for finished tasks", async () => {
    let tasks = [
      task(),
      task({ id: "done", title: "已交付的任务", status: "completed" }),
    ];
    vi.mocked(agentApi.getSecretary).mockImplementation(async () =>
      overview(tasks),
    );
    vi.mocked(agentApi.cancelSecretaryTask).mockImplementation(async () => {
      tasks = [task({ status: "cancelled" }), tasks[1]];
      return tasks[0];
    });
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    expand();
    expect(
      screen.queryByRole("button", { name: "取消任务：已交付的任务" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消任务：整理文档" }));
    await flush();
    expect(agentApi.cancelSecretaryTask).toHaveBeenCalledWith(
      "lc:secretary",
      "task-1",
    );
    expect(screen.getByText("已取消")).toBeInTheDocument();
  });

  it.each(["failed", "interrupted", "cancelled"] as const)(
    "lets the user explicitly follow up a %s task",
    async (status) => {
      vi.mocked(agentApi.getSecretary).mockResolvedValue(
        overview([task({ status })]),
      );
      render(
        <AgentSecretaryTasks
          sessionId="lc:secretary"
          onOpenSession={vi.fn()}
        />,
      );
      await flush();
      expand();
      fireEvent.click(screen.getByRole("button", { name: "整理文档" }));
      fireEvent.change(screen.getByLabelText("补充要求：整理文档"), {
        target: { value: "请根据当前现场继续完成" },
      });
      expect(agentApi.sendSecretaryTaskMessage).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "发送补充" }));
      await flush();
      expect(agentApi.sendSecretaryTaskMessage).toHaveBeenCalledWith(
        "lc:secretary",
        "task-1",
        "请根据当前现场继续完成",
        expect.any(String),
      );
    },
  );

  it("ignores a former secretary's outstanding response after the selection changes", async () => {
    let release!: (value: AgentSecretaryState) => void;
    vi.mocked(agentApi.getSecretary)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue({ sessionId: "lc:other", tasks: [] });
    const view = render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    view.rerender(
      <AgentSecretaryTasks sessionId="lc:other" onOpenSession={vi.fn()} />,
    );
    await flush();
    expand();
    await act(async () => release(overview([task()])));
    expect(screen.queryByText("整理文档")).not.toBeInTheDocument();
  });

  it("returns to the secretary from a worker and stops polling when hidden", async () => {
    const onOpenSession = vi.fn();
    const view = render(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        workerTaskId="task-1"
        onOpenSession={onOpenSession}
      />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "返回秘书" }));
    await flush();
    expect(onOpenSession).toHaveBeenCalledWith("lc:secretary");
    view.rerender(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        active={false}
        onOpenSession={onOpenSession}
      />,
    );
    const count = vi.mocked(agentApi.getSecretary).mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(agentApi.getSecretary).toHaveBeenCalledTimes(count);
  });

  it("surfaces a failed worker navigation without losing task details", async () => {
    vi.mocked(agentApi.getSecretary).mockResolvedValue(
      overview([task({ status: "failed", error: "模型请求失败" })]),
    );
    render(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        onOpenSession={vi.fn().mockRejectedValue(new Error("会话读取失败"))}
      />,
    );
    await flush();
    expand();
    fireEvent.click(screen.getByRole("button", { name: "整理文档" }));
    fireEvent.click(screen.getByRole("button", { name: "打开工作对话" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("会话读取失败");
    expect(screen.getByText("模型请求失败")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "工作任务" })).getByText(
        "执行失败",
      ),
    ).toBeInTheDocument();
  });
});
