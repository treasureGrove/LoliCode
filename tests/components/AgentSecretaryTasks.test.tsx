import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import { AgentSecretaryTasks } from "@/features/agent/AgentSecretaryTasks";
import { agentApi } from "@/lib/api/agent";
import zh from "@/i18n/locales/zh.json";
import type {
  AgentSecretaryDraftPr,
  AgentSecretaryGithubState,
  AgentSecretaryState,
  AgentSecretaryTask,
} from "@/types/agent";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    getSecretary: vi.fn(),
    delegateSecretaryTask: vi.fn(),
    getSecretaryGithub: vi.fn(),
    bindSecretaryGithub: vi.fn(),
    refreshSecretaryGithub: vi.fn(),
    setSecretaryGithubMonitoring: vi.fn(),
    setSecretaryGithubPolicy: vi.fn(),
    getSecretaryDraftPr: vi.fn(),
    publishSecretaryDraftPr: vi.fn(),
    disconnectSecretaryGithub: vi.fn(),
    delegateSecretaryGithubItem: vi.fn(),
    getSecretaryGithubReply: vi.fn(),
    sendSecretaryGithubReply: vi.fn(),
    sendSecretaryTaskMessage: vi.fn(),
    cancelSecretaryTask: vi.fn(),
    deleteSecretaryTask: vi.fn(),
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
function followupForm() {
  expand();
  fireEvent.click(screen.getByRole("button", { name: "整理文档" }));
  const input = screen.getByLabelText("补充要求：整理文档");
  fireEvent.change(input, { target: { value: "核对安装步骤" } });
  return { input, form: input.closest("form")! };
}
function delegationForm() {
  const trigger = screen.getByRole("button", { name: "交办任务" });
  fireEvent.click(trigger);
  const form = screen.getByRole("form", { name: "手动交办任务" });
  return {
    trigger,
    form,
    title: within(form).getByLabelText("任务名称"),
    instructions: within(form).getByLabelText("工作要求"),
    executionMode: within(form).getByLabelText("执行方式"),
    submit: within(form).getByRole("button", { name: "开始执行" }),
  };
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
  vi.mocked(agentApi.delegateSecretaryTask).mockReset();
  vi.mocked(agentApi.sendSecretaryTaskMessage)
    .mockReset()
    .mockResolvedValue(task());
  vi.mocked(agentApi.cancelSecretaryTask)
    .mockReset()
    .mockResolvedValue(task({ status: "cancelled" }));
  vi.mocked(agentApi.deleteSecretaryTask).mockReset();
  vi.mocked(agentApi.getSecretaryGithub)
    .mockReset()
    .mockResolvedValue(disconnected);
  vi.mocked(agentApi.bindSecretaryGithub).mockReset();
  vi.mocked(agentApi.refreshSecretaryGithub).mockReset();
  vi.mocked(agentApi.setSecretaryGithubMonitoring).mockReset();
  vi.mocked(agentApi.setSecretaryGithubPolicy).mockReset();
  vi.mocked(agentApi.getSecretaryDraftPr).mockReset();
  vi.mocked(agentApi.publishSecretaryDraftPr).mockReset();
  vi.mocked(agentApi.disconnectSecretaryGithub).mockReset();
  vi.mocked(agentApi.delegateSecretaryGithubItem).mockReset();
  vi.mocked(agentApi.getSecretaryGithubReply).mockReset();
  vi.mocked(agentApi.sendSecretaryGithubReply).mockReset();
});
afterEach(() => vi.useRealTimers());

describe("AgentSecretaryTasks", () => {
  it("shows only the chief secretary when no work conversations exist", async () => {
    const onOpenSession = vi.fn();
    render(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        selectedSessionId="lc:secretary"
        onOpenSession={onOpenSession}
      />,
    );
    await flush();
    const strip = within(screen.getByRole("navigation", { name: "秘书会话" }));
    const chief = strip.getByRole("button", { name: "总秘书" });
    expect(strip.getAllByRole("button")).toEqual([chief]);
    expect(chief).toHaveAttribute("aria-current", "page");
    fireEvent.click(chief);
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^工作任务/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("places real parents before nested conversations and keeps unresolved links usable", async () => {
    const parent = task({ id: "parent", title: "上级工作", createdAt: 3 });
    const child = task({
      id: "child",
      title: "子任务",
      sessionId: "lc:child",
      directParentSessionId: parent.sessionId,
      createdAt: 2,
    });
    const grandchild = task({
      id: "grandchild",
      title: "孙任务",
      sessionId: "lc:grandchild",
      directParentSessionId: child.sessionId,
      createdAt: 1,
    });
    const orphan = task({
      id: "orphan",
      title: "缺少上级",
      sessionId: "lc:orphan",
      directParentSessionId: "lc:hidden",
      createdAt: 4,
    });
    const firstCycle = task({
      id: "cycle-a",
      title: "循环甲",
      sessionId: "lc:cycle-a",
      directParentSessionId: "lc:cycle-b",
      createdAt: 5,
    });
    const secondCycle = task({
      id: "cycle-b",
      title: "循环乙",
      sessionId: "lc:cycle-b",
      directParentSessionId: "lc:cycle-a",
      createdAt: 6,
    });
    vi.mocked(agentApi.getSecretary).mockResolvedValue(
      overview([grandchild, child, orphan, secondCycle, parent, firstCycle]),
    );
    const onOpenSession = vi.fn();
    const view = render(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        onOpenSession={onOpenSession}
      />,
    );
    await flush();
    const strip = within(screen.getByRole("navigation", { name: "秘书会话" }));
    const parentChip = strip.getByRole("button", { name: /^上级工作/ });
    const childChip = strip.getByRole("button", { name: /^子任务/ });
    const grandchildChip = strip.getByRole("button", { name: /^孙任务/ });
    const orphanChip = strip.getByRole("button", { name: /^缺少上级/ });
    const firstCycleChip = strip.getByRole("button", { name: /^循环甲/ });
    const secondCycleChip = strip.getByRole("button", { name: /^循环乙/ });
    expect(strip.getAllByRole("button")).toEqual([
      strip.getByRole("button", { name: "总秘书" }),
      parentChip,
      childChip,
      grandchildChip,
      orphanChip,
      firstCycleChip,
      secondCycleChip,
    ]);
    expect(childChip).toHaveAttribute(
      "aria-description",
      "上一级工作对话：上级工作",
    );
    expect(grandchildChip).toHaveAttribute(
      "aria-description",
      "上一级工作对话：子任务",
    );
    for (const chip of [
      parentChip,
      orphanChip,
      firstCycleChip,
      secondCycleChip,
    ])
      expect(chip).not.toHaveAttribute("aria-description");
    fireEvent.click(grandchildChip);
    await flush();
    expect(onOpenSession).toHaveBeenLastCalledWith(grandchild.sessionId);
    view.rerender(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        selectedSessionId={grandchild.sessionId}
        workerTaskId={grandchild.id}
        onOpenSession={onOpenSession}
      />,
    );
    expect(grandchildChip).toHaveAttribute("aria-current", "page");
    fireEvent.click(orphanChip);
    await flush();
    expect(onOpenSession).toHaveBeenLastCalledWith(orphan.sessionId);
    fireEvent.click(firstCycleChip);
    await flush();
    expect(onOpenSession).toHaveBeenLastCalledWith(firstCycle.sessionId);
    expect(agentApi.getSecretary).toHaveBeenCalledTimes(1);
  });

  it("keeps real work conversation chips available and focused during rapid navigation", async () => {
    const first = task();
    const second = task({
      id: "task-2",
      sessionId: "lc:worker-2",
      title: "核对构建",
      status: "waiting_permission",
    });
    vi.mocked(agentApi.getSecretary).mockResolvedValue(
      overview([first, second]),
    );
    let rejectFirst!: (error: Error) => void;
    const onOpenSession = vi.fn().mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        rejectFirst = reject;
      }),
    );
    const view = render(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        selectedSessionId="lc:secretary"
        onOpenSession={onOpenSession}
      />,
    );
    await flush();
    const strip = within(screen.getByRole("navigation", { name: "秘书会话" }));
    const chief = strip.getByRole("button", { name: "总秘书" });
    const firstChip = strip.getByRole("button", {
      name: "整理文档 · 正在工作",
    });
    const secondChip = strip.getByRole("button", {
      name: "核对构建 · 需要授权",
    });
    expect(strip.getAllByRole("button")).toEqual([
      chief,
      firstChip,
      secondChip,
    ]);
    expect(screen.getByRole("button", { name: /^工作任务/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(firstChip);
    secondChip.focus();
    fireEvent.click(secondChip);
    expect(onOpenSession.mock.calls).toEqual([
      [first.sessionId],
      [second.sessionId],
    ]);
    expect(chief).toHaveAttribute("aria-current", "page");
    view.rerender(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        workerTaskId={second.id}
        selectedSessionId={second.sessionId}
        onOpenSession={onOpenSession}
      />,
    );
    await act(async () => rejectFirst(new Error("旧选择读取失败")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(secondChip).toHaveAttribute("aria-current", "page");
    expect(secondChip).toHaveFocus();
    expect(chief).not.toHaveAttribute("aria-current");
    expect(agentApi.getSecretary).toHaveBeenCalledTimes(1);
    fireEvent.click(chief);
    await flush();
    expect(onOpenSession).toHaveBeenLastCalledWith("lc:secretary");
    expect(agentApi.getSecretary).toHaveBeenCalledTimes(1);

    vi.mocked(agentApi.getSecretary).mockResolvedValue(
      overview([first, { ...second, status: "completed" }]),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(strip.getByRole("button", { name: "核对构建 · 已完成" })).toBe(
      secondChip,
    );
    expect(agentApi.getSecretary).toHaveBeenCalledTimes(2);
  });

  it("dispatches a named worktree task and shows it in the expanded task list", async () => {
    vi.mocked(agentApi.delegateSecretaryTask).mockImplementationOnce(
      async (
        parentSessionId,
        title,
        instructions,
        requestId,
        executionMode,
      ) => {
        const created = task({
          parentSessionId,
          title,
          instructions,
          requestId,
          executionMode,
          status: "queued",
        });
        vi.mocked(agentApi.getSecretary).mockResolvedValue(overview([created]));
        return created;
      },
    );
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    const fields = delegationForm();
    expect(fields.title).toHaveFocus();
    expect(fields.executionMode).toHaveValue("shared");
    expect(fields.submit).toBeDisabled();
    fireEvent.change(fields.title, { target: { value: "  检查项目文档  " } });
    expect(fields.submit).toBeDisabled();
    fireEvent.change(fields.instructions, {
      target: { value: "  核对安装步骤并回报。  " },
    });
    fireEvent.change(fields.executionMode, { target: { value: "worktree" } });
    fireEvent.click(fields.submit);
    await flush();
    expect(agentApi.delegateSecretaryTask).toHaveBeenCalledOnce();
    expect(agentApi.delegateSecretaryTask).toHaveBeenCalledWith(
      "lc:secretary",
      "检查项目文档",
      "核对安装步骤并回报。",
      expect.any(String),
      "worktree",
    );
    expect(fields.trigger).toHaveAttribute("aria-expanded", "false");
    expect(fields.form).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查项目文档" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^工作任务/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("blocks duplicate dispatch and retries the same draft with the original request ID", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(agentApi.delegateSecretaryTask)
      .mockReturnValueOnce(
        new Promise((_, fail) => {
          reject = fail;
        }),
      )
      .mockImplementationOnce(
        async (parentSessionId, title, instructions, requestId) => {
          const created = task({
            parentSessionId,
            title,
            instructions,
            requestId,
          });
          vi.mocked(agentApi.getSecretary).mockResolvedValue(
            overview([created]),
          );
          return created;
        },
      );
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    const fields = delegationForm();
    fireEvent.change(fields.title, { target: { value: "检查构建" } });
    fireEvent.change(fields.instructions, {
      target: { value: "运行本地检查。" },
    });
    fireEvent.submit(fields.form);
    fireEvent.submit(fields.form);
    expect(agentApi.delegateSecretaryTask).toHaveBeenCalledTimes(1);
    expect(fields.submit).toBeDisabled();
    await act(async () => reject(new Error("派工结果未确认")));
    expect(screen.getByRole("alert")).toHaveTextContent("派工结果未确认");
    expect(fields.title).toHaveValue("检查构建");
    expect(fields.instructions).toHaveValue("运行本地检查。");
    fireEvent.click(fields.submit);
    await flush();
    const calls = vi.mocked(agentApi.delegateSecretaryTask).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][4]).toBe("shared");
    expect(calls[1]).toEqual(calls[0]);
    expect(screen.getByRole("button", { name: "检查构建" })).toBeVisible();
  });

  it("hides manual delegation in inactive workspaces and worker conversations", async () => {
    const onOpenSession = vi.fn();
    const view = render(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        onOpenSession={onOpenSession}
      />,
    );
    await flush();
    const fields = delegationForm();
    fireEvent.change(fields.title, { target: { value: "保留的任务草稿" } });
    view.rerender(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        active={false}
        onOpenSession={onOpenSession}
      />,
    );
    expect(fields.trigger).toBeDisabled();
    expect(fields.form).not.toBeInTheDocument();
    view.rerender(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        workerTaskId="task-1"
        onOpenSession={onOpenSession}
      />,
    );
    expect(fields.trigger).not.toBeInTheDocument();
    view.rerender(
      <AgentSecretaryTasks
        sessionId="lc:secretary"
        onOpenSession={onOpenSession}
      />,
    );
    expect(screen.getByLabelText("任务名称")).toHaveValue("保留的任务草稿");
    await flush();
  });

  it("keeps the task list collapsed if it was closed during dispatch", async () => {
    let finish!: () => void;
    vi.mocked(agentApi.delegateSecretaryTask).mockImplementationOnce(
      (parentSessionId, title, instructions, requestId) =>
        new Promise((resolve) => {
          const created = task({
            parentSessionId,
            title,
            instructions,
            requestId,
          });
          finish = () => {
            vi.mocked(agentApi.getSecretary).mockResolvedValue(
              overview([created]),
            );
            resolve(created);
          };
        }),
    );
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    const fields = delegationForm();
    fireEvent.change(fields.title, { target: { value: "整理文档" } });
    fireEvent.change(fields.instructions, { target: { value: "核对索引" } });
    fireEvent.click(fields.submit);
    const tasks = screen.getByRole("button", { name: /^工作任务/ });
    fireEvent.click(tasks);
    await act(async () => finish());
    expect(tasks).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(tasks);
    expect(screen.getByRole("button", { name: "整理文档" })).toBeVisible();
  });

  it("leaves automatic dispatch off until receiving and the reviewed rule are saved", async () => {
    const source: AgentSecretaryGithubState = {
      ...disconnected,
      repository: "example/project",
      login: "maintainer",
      policy: { enabled: false, revision: 3, rules: [], decisions: [] },
    };
    vi.mocked(agentApi.getSecretaryGithub).mockResolvedValue(source);
    vi.mocked(agentApi.setSecretaryGithubMonitoring).mockResolvedValue({
      ...source,
      monitoring: true,
    });
    vi.mocked(agentApi.setSecretaryGithubPolicy).mockImplementation(
      async (_, enabled, rules) => ({
        ...source,
        monitoring: true,
        policy: {
          enabled,
          revision: 4,
          rules,
          decisions: [
            {
              itemId: "issue:22",
              title: "安装失败",
              url: "https://github.com/example/project/issues/22",
              ruleId: rules[0].id,
              ruleName: rules[0].name,
              status: "dispatched",
              decidedAt: 1000,
            },
          ],
        },
      }),
    );
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "GitHub 收件箱" }));
    await flush();
    fireEvent.click(
      screen.getByText("自动分派", { selector: "summary strong" }),
    );
    const enabled = screen.getByRole("checkbox", { name: "开启自动分派" });
    expect(enabled).not.toBeChecked();
    expect(enabled).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "自动收件" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "添加规则" }));
    fireEvent.change(screen.getByLabelText("规则名称"), {
      target: { value: "安装诊断" },
    });
    fireEvent.change(screen.getByLabelText("指令关键词"), {
      target: { value: "TRIAGE" },
    });
    fireEvent.change(screen.getByLabelText("允许的 GitHub 账号"), {
      target: { value: "@Alice, bob" },
    });
    fireEvent.change(screen.getByLabelText("执行要求"), {
      target: { value: "复现安装问题并提供证据。" },
    });
    fireEvent.click(enabled);
    expect(agentApi.setSecretaryGithubPolicy).not.toHaveBeenCalled();
    expect(agentApi.delegateSecretaryGithubItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存自动分派设置" }));
    await flush();
    expect(agentApi.setSecretaryGithubPolicy).toHaveBeenCalledWith(
      "lc:secretary",
      true,
      [
        {
          id: expect.any(String),
          name: "安装诊断",
          keyword: "triage",
          enabled: true,
          actors: ["alice", "bob"],
          kinds: ["issue"],
          instructions: "复现安装问题并提供证据。",
        },
      ],
      3,
    );
    fireEvent.click(screen.getByText(/命中记录/, { selector: "summary" }));
    expect(screen.getByText("安装失败")).toBeVisible();
    expect(screen.getByText("已分派")).toBeVisible();
  });

  it("turns automatic dispatch off immediately without saving an incomplete rule edit", async () => {
    const rule = {
      id: "check",
      name: "检查文档",
      enabled: true,
      actors: ["alice"],
      kinds: ["issue" as const],
      keyword: "docs",
      instructions: "检查文档。",
    };
    const source: AgentSecretaryGithubState = {
      ...disconnected,
      repository: "example/project",
      monitoring: true,
      policy: { enabled: true, revision: 5, rules: [rule], decisions: [] },
    };
    vi.mocked(agentApi.getSecretaryGithub).mockResolvedValue(source);
    vi.mocked(agentApi.setSecretaryGithubPolicy).mockImplementation(
      async (_, enabled, rules, expectedRevision) => ({
        ...source,
        policy: {
          enabled,
          revision: expectedRevision! + 1,
          rules,
          decisions: [],
        },
      }),
    );
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "GitHub 收件箱" }));
    await flush();
    fireEvent.click(
      screen.getByText("自动分派", { selector: "summary strong" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /检查文档/ }));
    fireEvent.change(screen.getByLabelText("执行要求"), {
      target: { value: "" },
    });
    expect(
      screen.getByRole("button", { name: "保存自动分派设置" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "开启自动分派" }));
    await flush();
    expect(agentApi.setSecretaryGithubPolicy).toHaveBeenCalledWith(
      "lc:secretary",
      false,
      [rule],
      5,
    );
    expect(screen.getByLabelText("执行要求")).toHaveValue("");
    expect(
      screen.getByRole("checkbox", { name: "开启自动分派" }),
    ).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("执行要求"), {
      target: { value: "核对更新后的文档。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存自动分派设置" }));
    await flush();
    expect(agentApi.setSecretaryGithubPolicy).toHaveBeenLastCalledWith(
      "lc:secretary",
      false,
      [{ ...rule, instructions: "核对更新后的文档。" }],
      6,
    );
  });

  it("keeps the edited rules and blocks saving after a newer policy arrives", async () => {
    const source: AgentSecretaryGithubState = {
      ...disconnected,
      repository: "example/project",
      monitoring: true,
      policy: {
        enabled: false,
        revision: 1,
        rules: [
          {
            id: "one",
            name: "核对安装",
            enabled: true,
            actors: ["alice"],
            kinds: ["issue"],
            keyword: "install",
            instructions: "检查安装步骤。",
          },
        ],
        decisions: [],
      },
    };
    vi.mocked(agentApi.getSecretaryGithub).mockResolvedValue(source);
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "GitHub 收件箱" }));
    await flush();
    fireEvent.click(
      screen.getByText("自动分派", { selector: "summary strong" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /核对安装/ }));
    fireEvent.change(screen.getByLabelText("执行要求"), {
      target: { value: "保留本地编辑" },
    });
    vi.mocked(agentApi.getSecretaryGithub).mockResolvedValue({
      ...source,
      policy: { ...source.policy!, revision: 2 },
    });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByLabelText("执行要求")).toHaveValue("保留本地编辑");
    expect(
      screen.getByRole("button", { name: "保存自动分派设置" }),
    ).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("已保存的设置有更新");
    expect(agentApi.setSecretaryGithubPolicy).not.toHaveBeenCalled();
  });

  const prPreview: AgentSecretaryDraftPr = {
    repository: "example/project",
    login: "maintainer",
    baseBranch: "main",
    headBranch: "TG/secretary/work",
    headRevision: "a".repeat(40),
    baseRevision: "b".repeat(40),
    treeRevision: "c".repeat(40),
    changes: [{ status: "M", path: "docs/installation.md" }],
    changedFileCount: 1,
    patch: "@@ -1 +1 @@\n-old\n+new",
    patchTruncated: false,
    title: "核对安装",
    body: "文档已更新。",
  };

  async function openDraftPr() {
    vi.mocked(agentApi.getSecretary).mockResolvedValue(
      overview([
        task({
          status: "completed",
          executionMode: "worktree",
          worktree: {
            path: "D:/fixture/worker",
            branch: prPreview.headBranch,
            baseRevision: prPreview.baseRevision,
          },
        }),
      ]),
    );
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    expand();
    fireEvent.click(screen.getByRole("button", { name: "整理文档" }));
    expect(agentApi.getSecretaryDraftPr).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "预览草稿 PR" }));
    await flush();
  }

  it("previews the worktree read-only and retries the exact authorized draft publication", async () => {
    vi.mocked(agentApi.getSecretaryDraftPr).mockResolvedValue(prPreview);
    vi.mocked(agentApi.publishSecretaryDraftPr)
      .mockResolvedValueOnce({
        status: "pending",
        title: "核对安装文档",
        body: prPreview.body,
        error: "正在核对发布结果",
      })
      .mockResolvedValueOnce({
        status: "published",
        title: "核对安装文档",
        body: prPreview.body,
        number: 42,
        lifecycle: "draft",
        url: "https://github.com/example/project/pull/42",
      });
    await openDraftPr();
    expect(agentApi.getSecretaryDraftPr).toHaveBeenCalledWith(
      "lc:secretary",
      "task-1",
    );
    expect(screen.getByText("docs/installation.md")).toBeVisible();
    expect(screen.getByText("查看差异")).toBeVisible();
    expect(agentApi.publishSecretaryDraftPr).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("PR 标题"), {
      target: { value: "核对安装文档" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "推送分支并创建草稿 PR" }),
    );
    await flush();
    expect(screen.getByLabelText("PR 标题")).toHaveAttribute("readonly");
    fireEvent.click(
      screen.getByRole("button", { name: "重试推送并创建草稿 PR" }),
    );
    await flush();
    const outbound = {
      headRevision: prPreview.headRevision,
      baseRevision: prPreview.baseRevision,
      treeRevision: prPreview.treeRevision,
      title: "核对安装文档",
      body: prPreview.body,
    };
    expect(vi.mocked(agentApi.publishSecretaryDraftPr).mock.calls).toEqual([
      ["lc:secretary", "task-1", outbound],
      ["lc:secretary", "task-1", outbound],
    ]);
    expect(screen.getByText("已创建草稿 PR #42 · 草稿")).toBeVisible();
  });

  it("requires a fresh preview after the worktree changes and preserves the edited text", async () => {
    vi.mocked(agentApi.getSecretaryDraftPr)
      .mockResolvedValueOnce(prPreview)
      .mockResolvedValueOnce({ ...prPreview, treeRevision: "d".repeat(40) });
    vi.mocked(agentApi.publishSecretaryDraftPr).mockRejectedValueOnce(
      new Error("工作树内容已变化，请重新预览"),
    );
    await openDraftPr();
    fireEvent.change(screen.getByLabelText("PR 正文"), {
      target: { value: "本地修改过的正文" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "推送分支并创建草稿 PR" }),
    );
    await flush();
    expect(
      screen.getByRole("button", { name: "推送分支并创建草稿 PR" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新预览" }));
    await flush();
    expect(screen.getByLabelText("PR 正文")).toHaveValue("本地修改过的正文");
    expect(
      screen.getByRole("button", { name: "推送分支并创建草稿 PR" }),
    ).toBeEnabled();
    expect(agentApi.publishSecretaryDraftPr).toHaveBeenCalledTimes(1);
  });

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

  it("shows tasks assigned by the secretary and distinguishes running lanes from queued tasks", async () => {
    const worker = task({
      executionMode: "worktree",
      worktree: {
        path: "D:/fixture/worktrees/worker",
        branch: "TG/secretary/example",
        baseRevision: "a".repeat(40),
      },
    });
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    expand();
    expect(screen.getByText("还没有工作任务。")).toBeInTheDocument();
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
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(screen.queryByText("还没有工作任务。")).not.toBeInTheDocument();
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
      "桌面应用运行时自动收件。可在下方设置自动分派规则。",
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
    expect(
      within(screen.getByRole("article")).getByText("需要授权"),
    ).toBeInTheDocument();
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
    expect(
      screen.getByRole("button", { name: "整理文档" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("网络暂不可用");
  });

  it("retains uncertain input and reuses the request ID when retrying a follow-up", async () => {
    vi.mocked(agentApi.getSecretary).mockResolvedValue(overview([task()]));
    vi.mocked(agentApi.sendSecretaryTaskMessage).mockRejectedValueOnce(
      new Error("回执未收到"),
    );
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    const { form, input } = followupForm();
    fireEvent.submit(form);
    await flush();
    expect(input).toHaveValue("核对安装步骤");
    expect(screen.getByRole("alert")).toHaveTextContent("回执未收到");
    fireEvent.submit(form);
    await flush();
    expect(agentApi.sendSecretaryTaskMessage).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(agentApi.sendSecretaryTaskMessage).mock.calls;
    expect(calls[0]).toEqual([
      "lc:secretary",
      "task-1",
      "核对安装步骤",
      expect.any(String),
    ]);
    expect(calls[1][3]).toBe(calls[0][3]);
    expect(input).toHaveValue("");
  });

  it("does not apply an old poll after a follow-up has been confirmed", async () => {
    let release!: (state: AgentSecretaryState) => void;
    vi.mocked(agentApi.getSecretary)
      .mockResolvedValueOnce(overview([task()]))
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
    await flush();
    const { form } = followupForm();
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    fireEvent.submit(form);
    await flush();
    await act(async () => release(overview()));
    await flush();
    expect(
      screen.getByRole("button", { name: "整理文档" }),
    ).toBeInTheDocument();
  });

  it("blocks duplicate follow-ups while preserving newer input", async () => {
    let release!: (task: AgentSecretaryTask) => void;
    vi.mocked(agentApi.getSecretary).mockResolvedValue(overview([task()]));
    vi.mocked(agentApi.sendSecretaryTaskMessage).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    const { form, input } = followupForm();
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(agentApi.sendSecretaryTaskMessage).toHaveBeenCalledTimes(1);
    fireEvent.change(input, {
      target: { value: "另外整理迁移步骤" },
    });
    await act(async () => release(task()));
    await flush();
    expect(input).toHaveValue("另外整理迁移步骤");
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
    expect(
      screen.getByText("已取消", { selector: ".wb-secretary-task-status" }),
    ).toBeInTheDocument();
  });

  it("removes only the confirmed finished task and keeps active tasks in the list", async () => {
    const running = task();
    const finished = task({
      id: "done",
      title: "已交付的任务",
      status: "completed",
    });
    vi.mocked(agentApi.getSecretary).mockResolvedValue(
      overview([running, finished]),
    );
    let refresh!: (value: AgentSecretaryState) => void;
    vi.mocked(agentApi.deleteSecretaryTask).mockImplementation(async () => {
      vi.mocked(agentApi.getSecretary).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            refresh = resolve;
          }),
      );
    });
    render(
      <AgentSecretaryTasks sessionId="lc:secretary" onOpenSession={vi.fn()} />,
    );
    await flush();
    expand();
    expect(
      screen.queryByRole("button", { name: "删除任务：整理文档" }),
    ).not.toBeInTheDocument();
    const remove = screen.getByRole("button", {
      name: "删除任务：已交付的任务",
    });
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(agentApi.deleteSecretaryTask).not.toHaveBeenCalled();
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await flush();
    expect(agentApi.deleteSecretaryTask).toHaveBeenCalledWith(
      "lc:secretary",
      "done",
    );
    expect(
      screen.queryByRole("button", { name: "已交付的任务" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "整理文档" }),
    ).toBeInTheDocument();
    refresh(overview([running]));
    await flush();
    expect(
      screen.queryByRole("button", { name: "已交付的任务" }),
    ).not.toBeInTheDocument();
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
      within(screen.getByRole("article")).getByText("执行失败"),
    ).toBeInTheDocument();
  });
});
