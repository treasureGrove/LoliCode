import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentOperationsPanel } from "@/features/agent/AgentOperationsPanel";
import { AgentToolDraftsContext } from "@/features/agent/AgentToolDrafts";
import {
  AgentAutomationPanel,
  automationCron,
} from "@/features/agent/AgentAutomationPanel";
import { agentApi } from "@/lib/api/agent";
import type { AgentCatalog, AgentSession } from "@/types/agent";
import { WindowControlsContext } from "@/app/shell/AppPageHeader";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    getNativeActivity: vi.fn(),
    native: vi.fn(),
    automation: vi.fn(),
    remote: vi.fn(),
    createSession: vi.fn(),
    runSavedWorkflow: vi.fn(),
    listSessions: vi.fn(),
    getSession: vi.fn(),
    interruptSession: vi.fn(),
  },
}));
const project = "D:/owned/operations";
const catalog: AgentCatalog = {
  revision: 1,
  defaultModel: "lolicode/source/model",
  excludedSources: [],
  models: [
    {
      id: "lolicode/source/model",
      modelId: "source/model",
      providerId: "lolicode",
      name: "Code",
      channelName: "Fixture",
    },
  ],
};
const session: AgentSession = {
  id: "zc:workflow",
  title: "Workflow",
  projectPath: project,
  mode: "build",
  createdAt: 1,
  updatedAt: 2,
};
const workflow = {
  name: "review-code",
  description: "Read the project",
  scope: "project",
  args: { count: { type: "number", default: 2, required: true } },
};
const job = {
  automationId: "job-owned",
  title: "每日检查",
  prompt: "Read the owned project",
  enabled: true,
  lifecycleStatus: "active",
  cronExpr: "0 9 * * *",
  modelSelection: { providerId: "lolicode", modelId: "source/model" },
};
const onSession = vi.fn();
const onCompose = vi.fn();
const props = () => ({
  open: true,
  onOpenChange: vi.fn(),
  projectPath: project,
  catalog,
  working: false,
  onSession,
  onCompose,
});
async function flush() {
  await act(async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
  });
}
async function tick(ms = 1000) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  onSession.mockReset();
  onCompose.mockReset();
  vi.mocked(agentApi.getNativeActivity).mockReset().mockResolvedValue({});
  vi.mocked(agentApi.native)
    .mockReset()
    .mockImplementation(async (_service, method) => {
      if (method === "listSavedWorkflows")
        return { workflows: [workflow], invalid: [] };
      if (method === "listSavedWorkflowRuns") return { runs: [] };
      if (method === "getSavedWorkflow")
        return { ok: true, script: "export default async function () {}" };
      if (method === "deleteSavedWorkflow") return { ok: true };
      return {};
    });
  vi.mocked(agentApi.automation)
    .mockReset()
    .mockImplementation(async (method) =>
      method === "list"
        ? [job]
        : method === "listRuns"
          ? []
          : method === "create"
            ? job
            : method === "runNow"
              ? { status: "queued" }
              : method === "setEnabled"
                ? { ...job, enabled: false }
                : true,
    );
  vi.mocked(agentApi.remote)
    .mockReset()
    .mockImplementation(async (method) =>
      method === "list"
        ? { connections: [], projects: [] }
        : method === "listWSL"
          ? ["Ubuntu"]
          : {
              id: "remote-owned",
              name: "Owned SSH",
              target: { kind: "ssh", host: "owned-alias" },
              enabled: true,
            },
    );
  vi.mocked(agentApi.createSession).mockReset().mockResolvedValue(session);
  vi.mocked(agentApi.runSavedWorkflow).mockReset().mockResolvedValue(session);
  vi.mocked(agentApi.listSessions)
    .mockReset()
    .mockResolvedValue([{ ...session, id: "zc:native-run" }]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("native workflow / automation / remote entry", () => {
  it("restores an unsaved new workflow after switching tools and keeps drafts separate by project", async () => {
    const drafts = new Map<string, unknown>();
    const panel = (path = project) => (
      <AgentToolDraftsContext.Provider value={drafts}>
        <AgentOperationsPanel {...props()} projectPath={path} />
      </AgentToolDraftsContext.Provider>
    );
    const view = render(panel());
    await flush();
    fireEvent.change(screen.getByLabelText("工作流范围"), {
      target: { value: "global" },
    });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "新建工作流" }));
    fireEvent.change(screen.getByLabelText("工作流名称"), {
      target: { value: "unsaved-workflow" },
    });
    fireEvent.change(screen.getByLabelText("工作流内容"), {
      target: { value: "---\ndescription: Unsaved\n---\nKeep these steps." },
    });
    view.rerender(
      <AgentToolDraftsContext.Provider value={drafts}>
        <div>另一个工具</div>
      </AgentToolDraftsContext.Provider>,
    );
    await flush();
    view.rerender(panel("D:/owned/another-project"));
    await flush();
    expect(screen.queryByLabelText("工作流名称")).not.toBeInTheDocument();
    expect(screen.getByLabelText("工作流范围")).toHaveValue("project");
    view.rerender(panel());
    await flush();
    expect(screen.getByLabelText("工作流范围")).toHaveValue("global");
    expect(screen.getByLabelText("工作流名称")).toHaveValue("unsaved-workflow");
    expect(screen.getByLabelText("工作流内容")).toHaveValue(
      "---\ndescription: Unsaved\n---\nKeep these steps.",
    );
    expect(agentApi.native).not.toHaveBeenCalledWith(
      "IZCodeAgentService",
      "saveSavedWorkflow",
      expect.anything(),
    );
  });

  it("keeps the original document identity when an unsaved edit is remounted", async () => {
    const original = "---\ndescription: Original\n---\nOriginal steps.";
    vi.mocked(agentApi.native).mockImplementation(async (_service, method) => {
      if (method === "listSavedWorkflows")
        return { workflows: [workflow], invalid: [] };
      if (method === "listSavedWorkflowRuns") return { runs: [] };
      if (method === "getSavedWorkflow")
        return { ok: true, document: original };
      return { ok: true };
    });
    const drafts = new Map<string, unknown>();
    const panel = () => (
      <AgentToolDraftsContext.Provider value={drafts}>
        <AgentOperationsPanel {...props()} />
      </AgentToolDraftsContext.Provider>
    );
    const view = render(panel());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "编辑工作流" }));
    await flush();
    const edited = `${original}\nKeep this unfinished edit.`;
    fireEvent.change(screen.getByLabelText("工作流内容"), {
      target: { value: edited },
    });
    view.rerender(
      <AgentToolDraftsContext.Provider value={drafts}>
        {null}
      </AgentToolDraftsContext.Provider>,
    );
    await flush();
    view.rerender(panel());
    await flush();
    expect(screen.getByLabelText("工作流名称")).toHaveValue(workflow.name);
    expect(screen.getByLabelText("工作流名称")).toBeDisabled();
    expect(screen.getByLabelText("工作流内容")).toHaveValue(edited);
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await flush();
    expect(agentApi.native).toHaveBeenCalledWith(
      "IZCodeAgentService",
      "saveSavedWorkflow",
      [
        expect.objectContaining({
          name: workflow.name,
          document: edited,
          overwrite: true,
          expectedDocument: original,
        }),
      ],
    );
  });

  it("resets a standalone workflow form when its project changes without a draft provider", async () => {
    const view = render(<AgentOperationsPanel {...props()} />);
    await flush();
    fireEvent.change(screen.getByLabelText("工作流范围"), {
      target: { value: "global" },
    });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "新建工作流" }));
    fireEvent.change(screen.getByLabelText("工作流名称"), {
      target: { value: "old-project-draft" },
    });
    fireEvent.change(screen.getByLabelText("工作流内容"), {
      target: { value: "Old project steps" },
    });
    view.rerender(
      <AgentOperationsPanel
        {...props()}
        projectPath="D:/owned/second-project"
      />,
    );
    await flush();
    expect(screen.queryByLabelText("工作流名称")).not.toBeInTheDocument();
    expect(screen.getByLabelText("工作流范围")).toHaveValue("project");
    fireEvent.click(screen.getByRole("button", { name: "新建工作流" }));
    expect(screen.getByLabelText("工作流名称")).toHaveValue("");
    expect(screen.getByLabelText("工作流内容")).not.toHaveValue(
      "Old project steps",
    );
  });

  it("edits the complete saved document and keeps the draft when a stale save is rejected", async () => {
    const original =
      "---\n# preserve this comment\ndescription: Original\ncustom: keep-me\n---\nRead README.";
    vi.mocked(agentApi.native).mockImplementation(async (_service, method) => {
      if (method === "listSavedWorkflows")
        return { workflows: [workflow], invalid: [] };
      if (method === "listSavedWorkflowRuns") return { runs: [] };
      if (method === "getSavedWorkflow")
        return { ok: true, document: original, script: "Read README." };
      if (method === "saveSavedWorkflow")
        throw new Error(
          "工作流已被其他操作修改，请重新加载后再保存；你的编辑内容仍保留",
        );
      return {};
    });
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "编辑工作流" }));
    await flush();
    expect(screen.getByLabelText("工作流名称")).toBeDisabled();
    expect(screen.getByLabelText("工作流内容")).toHaveValue(original);
    const edited = original.replace(
      "Read README.",
      "Read README and validate the change.",
    );
    fireEvent.change(screen.getByLabelText("工作流内容"), {
      target: { value: edited },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await flush();
    expect(agentApi.native).toHaveBeenCalledWith(
      "IZCodeAgentService",
      "saveSavedWorkflow",
      [
        expect.objectContaining({
          name: workflow.name,
          document: edited,
          overwrite: true,
          expectedDocument: original,
        }),
      ],
    );
    expect(screen.getByRole("alert")).toHaveTextContent("已被其他操作修改");
    expect(screen.getByLabelText("工作流内容")).toHaveValue(edited);
  });

  it("does not load an old workflow editor into a newly selected project", async () => {
    let resolveDocument!: (value: unknown) => void;
    const documentRequest = new Promise((resolve) => {
      resolveDocument = resolve;
    });
    vi.mocked(agentApi.native).mockImplementation(async (_service, method) => {
      if (method === "listSavedWorkflows")
        return { workflows: [workflow], invalid: [] };
      if (method === "listSavedWorkflowRuns") return { runs: [] };
      if (method === "getSavedWorkflow") return documentRequest;
      return {};
    });
    const view = render(<AgentOperationsPanel {...props()} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "编辑工作流" }));
    view.rerender(
      <AgentOperationsPanel
        {...props()}
        projectPath="D:/owned/second-project"
      />,
    );
    await act(async () => {
      resolveDocument({
        ok: true,
        document: "---\ndescription: Old project\n---\nOld steps",
      });
      await documentRequest;
    });
    await flush();
    expect(screen.queryByLabelText("工作流内容")).not.toBeInTheDocument();
    expect(agentApi.native).not.toHaveBeenCalledWith(
      "IZCodeAgentService",
      "saveSavedWorkflow",
      expect.anything(),
    );
  });

  it("saves a reusable workflow document through the native service instead of an inert chat-only entry", async () => {
    vi.mocked(agentApi.native).mockImplementation(async (_service, method) =>
      method === "saveSavedWorkflow"
        ? { ok: true }
        : method === "listSavedWorkflows"
          ? { workflows: [], invalid: [] }
          : { runs: [] },
    );
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "新建工作流" }));
    fireEvent.change(screen.getByLabelText("工作流名称"), {
      target: { value: "release-check" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存工作流" }));
    await flush();
    expect(agentApi.native).toHaveBeenCalledWith(
      "IZCodeAgentService",
      "saveSavedWorkflow",
      [
        expect.objectContaining({
          workspacePath: project,
          scope: "project",
          name: "release-check",
          document: expect.stringContaining("description:"),
        }),
      ],
    );
  });
  it("hands idle requirements to the design conversation without creating a task", async () => {
    render(<AgentOperationsPanel {...props()} initialTab="automation" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "用对话创建" }));
    expect(screen.getByLabelText("描述自动化任务")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("描述自动化任务"), {
      target: { value: "电脑闲置15分钟后检查代码，两次运行至少间隔120分钟" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始对话构建" }));
    await flush();
    expect(onCompose).toHaveBeenCalledOnce();
    const prompt = onCompose.mock.calls[0][0];
    expect(prompt).toContain("电脑闲置15分钟");
    expect(prompt).toContain("120分钟");
    expect(prompt).toContain("自动化配置卡");
    expect(prompt).toContain("点击保存后生效");
    expect(agentApi.automation).not.toHaveBeenCalledWith(
      "create",
      expect.anything(),
    );
    expect(screen.queryByLabelText("自动化触发方式")).not.toBeInTheDocument();
  });

  it("designs edits for the existing automation and keeps cancellation scoped to its recorded run", async () => {
    vi.mocked(agentApi.automation).mockImplementation(async (method) =>
      method === "list"
        ? [job]
        : method === "listRuns"
          ? [
              {
                runId: "owned-running",
                automationId: job.automationId,
                createdAt: 1,
                dispatchStatus: "dispatched",
                outcome: "running",
                sessionId: "lc:owned",
              },
            ]
          : { status: "stopping" },
    );
    render(<AgentOperationsPanel {...props()} initialTab="automation" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "编辑任务" }));
    await flush();
    expect(onCompose).toHaveBeenCalledWith(
      expect.stringContaining(`"automationId": "${job.automationId}"`),
    );
    expect(agentApi.automation).not.toHaveBeenCalledWith(
      "update",
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("button", { name: "查看运行记录" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    await flush();
    expect(agentApi.automation).toHaveBeenCalledWith("cancelRun", [
      "owned-running",
      { workspacePath: project },
    ]);
  });

  it("does not contact unavailable migrated services while reading or after receiving in-process features", async () => {
    let finish!: (value: {
      inProcess: boolean;
      features: { workflows: boolean; automation: boolean; remote: boolean };
    }) => void;
    vi.mocked(agentApi.getNativeActivity).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    expect(screen.getByText(/正在读取当前引擎/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "工作流" })).toBeDisabled();
    expect(agentApi.native).not.toHaveBeenCalled();
    expect(agentApi.automation).not.toHaveBeenCalled();
    expect(agentApi.remote).not.toHaveBeenCalled();
    await act(async () =>
      finish({
        inProcess: true,
        features: { workflows: false, automation: false, remote: false },
      }),
    );
    await flush();
    expect(screen.getByText("当前执行引擎未提供工作流")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "SSH / WSL" }));
    expect(
      screen.getByText("远端工程暂未接入当前 Rust 执行引擎"),
    ).toBeInTheDocument();
    expect(screen.getByText(/不会启动旧的 ZCode 服务/)).toBeInTheDocument();
    expect(agentApi.native).not.toHaveBeenCalled();
    expect(agentApi.automation).not.toHaveBeenCalled();
    expect(agentApi.remote).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "返回工作台" })).toBeEnabled();
  });
  it("fails closed for unknown in-process features and ignores a prior dialog capability reply", async () => {
    let old!: (value: {}) => void;
    vi.mocked(agentApi.getNativeActivity)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            old = resolve;
          }),
      )
      .mockResolvedValueOnce({ inProcess: true });
    const options = props();
    const view = render(<AgentOperationsPanel {...options} />);
    await flush();
    view.rerender(<AgentOperationsPanel {...options} open={false} />);
    await flush();
    view.rerender(<AgentOperationsPanel {...options} open />);
    await flush();
    await act(async () => old({}));
    await flush();
    expect(screen.getByRole("tab", { name: "工作流" })).toBeEnabled();
    expect(screen.getByText("当前执行引擎未提供工作流")).toBeInTheDocument();
    expect(agentApi.native).not.toHaveBeenCalled();
  });
  it("retries capability failures and requests only explicitly supported advanced features", async () => {
    vi.mocked(agentApi.getNativeActivity)
      .mockRejectedValueOnce(new Error("状态暂时不可读"))
      .mockResolvedValueOnce({
        inProcess: true,
        features: { workflows: false, automation: true, remote: false },
      });
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("状态暂时不可读");
    expect(agentApi.native).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新读取可用功能" }));
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "自动化" }));
    await flush();
    expect(agentApi.automation).toHaveBeenCalledWith("list", [
      { workspacePath: project },
    ]);
    expect(agentApi.native).not.toHaveBeenCalled();
    expect(agentApi.remote).not.toHaveBeenCalled();
  });
  it("times out a hung capability read, retries it, and ignores its late response", async () => {
    let finishOld!: (value: {}) => void;
    vi.mocked(agentApi.getNativeActivity)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce({
        inProcess: true,
        features: { workflows: false, automation: true, remote: false },
      });
    render(<AgentOperationsPanel {...props()} initialTab="automation" />);
    await flush();
    await tick(29_999);
    expect(screen.getByText(/正在读取当前引擎/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "自动化" })).toBeDisabled();
    await tick(1);
    expect(screen.getByRole("alert")).toHaveTextContent("可用功能超时");
    expect(screen.queryByText(/正在读取当前引擎/)).not.toBeInTheDocument();
    expect(agentApi.automation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新读取可用功能" }));
    await flush();
    expect(agentApi.getNativeActivity).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: job.title })).toBeInTheDocument();
    await act(async () =>
      finishOld({
        inProcess: true,
        features: { workflows: false, automation: false, remote: false },
      }),
    );
    await flush();
    expect(screen.getByRole("button", { name: job.title })).toBeInTheDocument();
    expect(
      screen.queryByText("当前执行引擎未提供自动化"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("cancels the old capability deadline when switching projects and clears a successful read's timer", async () => {
    let finishOld!: (value: {}) => void;
    let finishCurrent!: (value: {}) => void;
    vi.mocked(agentApi.getNativeActivity)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCurrent = resolve;
          }),
      );
    const options = props();
    const view = render(
      <AgentOperationsPanel {...options} initialTab="automation" />,
    );
    await flush();
    await tick(25_000);
    const nextProject = "D:/owned/another-operations";
    view.rerender(
      <AgentOperationsPanel
        {...options}
        initialTab="automation"
        projectPath={nextProject}
      />,
    );
    await flush();
    await tick(5000);
    expect(screen.getByText(/正在读取当前引擎/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => finishOld({}));
    await flush();
    expect(screen.getByText(/正在读取当前引擎/)).toBeInTheDocument();
    expect(agentApi.automation).not.toHaveBeenCalled();
    await act(async () =>
      finishCurrent({
        inProcess: true,
        features: { workflows: false, automation: true, remote: false },
      }),
    );
    await flush();
    expect(agentApi.automation).toHaveBeenCalledWith("list", [
      { workspacePath: nextProject },
    ]);
    await tick(30_000);
    expect(screen.getByRole("button", { name: job.title })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("loads real workflow catalog and hands creation intent back to the existing composer", async () => {
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    expect(agentApi.native).toHaveBeenCalledWith(
      "IZCodeAgentService",
      "listSavedWorkflows",
      [{ workspacePath: project, scope: "project" }],
    );
    expect(screen.getByText("review-code")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索工作流" }), {
      target: { value: "Read the project" },
    });
    expect(screen.getByText("review-code")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索工作流" }), {
      target: { value: "no-matching-workflow" },
    });
    expect(screen.queryByText("review-code")).not.toBeInTheDocument();
    expect(screen.getByText("没有找到匹配的工作流")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索工作流" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "在会话中创建工作流" }));
    expect(onCompose).toHaveBeenCalledWith(
      expect.stringContaining("创建可复用工作流"),
    );
  });
  it("uses the same native command identity and session after a lost workflow response", async () => {
    vi.mocked(agentApi.runSavedWorkflow).mockRejectedValueOnce(
      new Error("response lost"),
    );
    const options = props();
    const view = render(<AgentOperationsPanel {...options} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "配置与运行" }));
    fireEvent.click(screen.getByRole("button", { name: "在新会话运行工作流" }));
    await flush();
    const initial = vi.mocked(agentApi.runSavedWorkflow).mock.calls[0];
    expect(initial).toEqual([
      session.id,
      "review-code",
      expect.any(String),
      "project",
      { count: 2 },
    ]);
    expect(screen.getByText("response lost")).toBeInTheDocument();
    view.unmount();
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "配置与运行" }));
    fireEvent.click(screen.getByRole("button", { name: "在新会话运行工作流" }));
    await flush();
    expect(agentApi.createSession).toHaveBeenCalledOnce();
    expect(agentApi.createSession).toHaveBeenCalledWith(
      catalog.defaultModel,
      "build",
      "工作流 · review-code",
      "full_access",
      undefined,
      project,
    );
    expect(vi.mocked(agentApi.runSavedWorkflow).mock.calls[1]).toEqual(initial);
    expect(onSession).toHaveBeenCalledWith(session);
  });
  it("starts a design session directly from a template with its weekly schedule intact", async () => {
    const onBuildAutomation = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentAutomationPanel
        projectPath={project}
        catalog={catalog}
        onSession={onSession}
        onCompose={onCompose}
        onBuildAutomation={onBuildAutomation}
      />,
    );
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: /文档同步检查.*每周三 15:00/ }),
    );
    await flush();
    expect(onBuildAutomation).toHaveBeenCalledOnce();
    const prompt = onBuildAutomation.mock.calls[0][0];
    expect(prompt).toContain("每周三 15:00");
    expect(prompt).toContain("检查项目文档与当前实现是否保持同步");
    expect(prompt).toContain("自动化配置卡");
    expect(onCompose).not.toHaveBeenCalled();
    expect(agentApi.automation).not.toHaveBeenCalledWith(
      "create",
      expect.anything(),
    );
    expect(automationCron("hourly", "09:00", "1", "12")).toBe("12 * * * *");
    expect(() => automationCron("hourly", "09:00", "1", "91")).toThrow();
  });

  it("passes the entire saved configuration to the design conversation without replacing model options or one-shot behavior", async () => {
    const saved = {
      ...job,
      cronExpr: "35 14 * * 1,3,5",
      recurring: false,
      mode: "guarded",
      modelSelection: {
        providerId: "lolicode",
        modelId: "source/model",
        options: { reasoningLevel: "high", contextWindow: 64000 },
      },
    };
    vi.mocked(agentApi.automation).mockImplementation(async (method) =>
      method === "list" ? [saved] : method === "listRuns" ? [] : saved,
    );
    render(<AgentOperationsPanel {...props()} initialTab="automation" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: job.title }));
    await flush();
    expect(onCompose).toHaveBeenCalledWith(
      expect.stringContaining(JSON.stringify(saved, null, 2)),
    );
    expect(onCompose).toHaveBeenCalledWith(
      expect.stringContaining("保留未要求修改的设置"),
    );
    expect(
      screen.queryByRole("form", { name: "自动化设置" }),
    ).not.toBeInTheDocument();
    expect(agentApi.automation).not.toHaveBeenCalledWith(
      "update",
      expect.anything(),
    );
    expect(automationCron("weekly", "14:35", "5,1,1,3", "0")).toBe(
      "35 14 * * 1,3,5",
    );
    expect(() => automationCron("weekly", "14:35", "", "0")).toThrow();
  });

  it("restores automation descriptions across tool switches and keeps project drafts separate", async () => {
    const drafts = new Map<string, unknown>();
    const panel = (path = project) => (
      <AgentToolDraftsContext.Provider value={drafts}>
        <AgentOperationsPanel
          {...props()}
          projectPath={path}
          initialTab="automation"
        />
      </AgentToolDraftsContext.Provider>
    );
    const view = render(panel());
    await flush();
    fireEvent.change(screen.getByLabelText("描述自动化任务"), {
      target: { value: "Keep this unfinished prompt" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "工作流" }));
    fireEvent.click(screen.getByRole("tab", { name: "自动化" }));
    await flush();
    expect(screen.getByLabelText("描述自动化任务")).toHaveValue(
      "Keep this unfinished prompt",
    );
    view.rerender(panel("D:/owned/other"));
    await flush();
    expect(screen.getByLabelText("描述自动化任务")).toHaveValue("");
    view.rerender(panel());
    await flush();
    expect(screen.getByLabelText("描述自动化任务")).toHaveValue(
      "Keep this unfinished prompt",
    );
    expect(agentApi.automation).not.toHaveBeenCalledWith(
      "create",
      expect.anything(),
    );
  });

  it("keeps the description editable after opening the design conversation fails", async () => {
    const onBuildAutomation = vi
      .fn()
      .mockRejectedValue(new Error("设计会话暂时不可用"));
    render(
      <AgentAutomationPanel
        projectPath={project}
        catalog={catalog}
        onSession={onSession}
        onBuildAutomation={onBuildAutomation}
      />,
    );
    await flush();
    fireEvent.change(screen.getByLabelText("描述自动化任务"), {
      target: { value: "每天检查代码" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始对话构建" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("设计会话暂时不可用");
    expect(screen.getByLabelText("描述自动化任务")).toHaveValue("每天检查代码");
    expect(screen.getByRole("button", { name: "开始对话构建" })).toBeEnabled();
    expect(agentApi.automation).not.toHaveBeenCalledWith(
      "create",
      expect.anything(),
    );
  });

  it("keeps an in-flight design request unique across remounts and lets another project remain usable", async () => {
    let finish!: () => void;
    const request = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onBuildAutomation = vi.fn(() => request);
    const drafts = new Map<string, unknown>();
    const panel = (path = project) => (
      <AgentToolDraftsContext.Provider value={drafts}>
        <AgentAutomationPanel
          projectPath={path}
          catalog={catalog}
          onSession={onSession}
          onBuildAutomation={onBuildAutomation}
        />
      </AgentToolDraftsContext.Provider>
    );
    let view = render(panel());
    try {
      await flush();
      fireEvent.change(screen.getByLabelText("描述自动化任务"), {
        target: { value: "项目A的待构建任务" },
      });
      fireEvent.click(screen.getByRole("button", { name: "开始对话构建" }));
      await flush();
      view.unmount();
      view = render(panel());
      await flush();
      expect(screen.getByRole("button", { name: "正在处理…" })).toBeDisabled();
      expect(onBuildAutomation).toHaveBeenCalledOnce();
      view.rerender(panel("D:/owned/other"));
      await flush();
      fireEvent.change(screen.getByLabelText("描述自动化任务"), {
        target: { value: "保留项目B的草稿" },
      });
      expect(
        screen.getByRole("button", { name: "开始对话构建" }),
      ).toBeEnabled();
      expect(agentApi.automation).toHaveBeenCalledWith("list", [
        { workspacePath: "D:/owned/other" },
      ]);
      await act(async () => {
        finish();
        await request;
      });
      expect(screen.getByLabelText("描述自动化任务")).toHaveValue(
        "保留项目B的草稿",
      );
      view.rerender(panel());
      await flush();
      expect(screen.getByLabelText("描述自动化任务")).toHaveValue("");
      expect(onBuildAutomation).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        finish();
        await request;
      });
    }
  });

  it("shows the latest run even when native history is returned out of order", async () => {
    vi.mocked(agentApi.automation).mockImplementation(async (method) =>
      method === "list"
        ? [job]
        : method === "listRuns"
          ? [
              {
                runId: "old-failure",
                automationId: job.automationId,
                createdAt: 1,
                dispatchStatus: "dispatched",
                outcome: "failed",
              },
              {
                runId: "recent-success",
                automationId: job.automationId,
                createdAt: 2,
                dispatchStatus: "dispatched",
                outcome: "succeeded",
              },
            ]
          : true,
    );
    render(<AgentOperationsPanel {...props()} initialTab="automation" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "已完成" }));
    expect(screen.getByRole("button", { name: job.title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "失败" }));
    expect(
      screen.queryByRole("button", { name: job.title }),
    ).not.toBeInTheDocument();
  });

  it("pauses an automation directly from its settings switch", async () => {
    render(<AgentOperationsPanel {...props()} initialTab="automation" />);
    await flush();
    fireEvent.click(
      screen.getByRole("switch", { name: `${job.title} 启用计划` }),
    );
    await flush();
    expect(agentApi.automation).toHaveBeenCalledWith("setEnabled", [
      job.automationId,
      false,
      { workspacePath: project },
    ]);
  });
  it("clearly marks design creation unavailable when no conversation callback is connected", async () => {
    render(
      <AgentAutomationPanel
        projectPath={project}
        catalog={catalog}
        onSession={onSession}
      />,
    );
    await flush();
    fireEvent.change(screen.getByLabelText("描述自动化任务"), {
      target: { value: "每天检查代码" },
    });
    expect(screen.getByRole("button", { name: "开始对话构建" })).toBeDisabled();
    expect(
      screen.getByText(/当前入口暂不支持构建设计对话/),
    ).toBeInTheDocument();
    expect(agentApi.automation).not.toHaveBeenCalledWith(
      "create",
      expect.anything(),
    );
    expect(agentApi.createSession).not.toHaveBeenCalled();
  });

  it("keeps queued automation distinct from a successful terminal and opens its actual run session", async () => {
    let terminal = false;
    vi.mocked(agentApi.automation).mockImplementation(async (method) =>
      method === "list"
        ? [job]
        : method === "listRuns"
          ? [
              {
                runId: "run-owned",
                automationId: "job-owned",
                createdAt: 1,
                dispatchStatus: "dispatched",
                outcome: terminal ? "succeeded" : "running",
                sessionId: "native-run",
              },
            ]
          : { status: "queued" },
    );
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "自动化" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "立即运行" }));
    await flush();
    expect(
      screen.getByText(/已提交任务，等待原生执行结果/),
    ).toBeInTheDocument();
    expect(screen.getByText(/· 执行中/)).toBeInTheDocument();
    expect(screen.queryByText(/· 已完成/)).not.toBeInTheDocument();
    terminal = true;
    await tick(3000);
    expect(screen.getByText(/· 已完成/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开运行会话" }));
    await flush();
    expect(onSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "zc:native-run" }),
    );
  });
  it("requires confirmation for deletion and keeps a false native result visible as a failure", async () => {
    vi.mocked(agentApi.automation).mockImplementation(async (method) =>
      method === "list" ? [job] : method === "listRuns" ? [] : false,
    );
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "自动化" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
    expect(agentApi.automation).not.toHaveBeenCalledWith(
      "delete",
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认删除自动化" }));
    await flush();
    expect(screen.getByText(/删除未完成/)).toBeInTheDocument();
    expect(screen.getByText("每日检查")).toBeInTheDocument();
  });
  it("keeps return, Escape and the original window actions available in its panel", async () => {
    const options = props();
    const windowClose = vi.fn();
    render(
      <WindowControlsContext.Provider
        value={<button onClick={windowClose}>关闭应用窗口</button>}
      >
        <AgentOperationsPanel {...options} />
      </WindowControlsContext.Provider>,
    );
    await flush();
    expect(
      screen.getByRole("region", { name: "工作流与自动化" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭应用窗口" }));
    expect(windowClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect(options.onOpenChange).toHaveBeenCalledWith(false);
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(options.onOpenChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect(options.onOpenChange).toHaveBeenCalledWith(false);
  });
  it("does not submit a second SSH connect while the first survives a dialog close/reopen", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(agentApi.remote).mockImplementation(async (method) =>
      method === "list"
        ? { connections: [], projects: [] }
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const options = props();
    const view = render(<AgentOperationsPanel {...options} />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "SSH / WSL" }));
    await flush();
    fireEvent.change(screen.getByLabelText("SSH 主机或别名"), {
      target: { value: "owned-alias" },
    });
    expect(screen.queryByLabelText("SSH 密码")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "验证并保存连接" }));
    await flush();
    view.rerender(<AgentOperationsPanel {...options} open={false} />);
    await flush();
    view.rerender(<AgentOperationsPanel {...options} open />);
    await flush();
    expect(screen.getByRole("button", { name: "正在处理…" })).toBeDisabled();
    await act(async () =>
      finish({
        id: "remote-owned",
        name: "Owned SSH",
        target: { kind: "ssh", host: "owned-alias" },
        enabled: true,
      }),
    );
    await flush();
    expect(
      vi
        .mocked(agentApi.remote)
        .mock.calls.filter(([method]) => method === "connect"),
    ).toHaveLength(1);
    expect(localStorage.length).toBe(0);
  });

  it("opens SSH projects in the main workbench without initializing a second Agent service", async () => {
    const connection = {
      id: "remote-owned",
      name: "Owned SSH",
      target: { kind: "ssh", host: "owned-alias" },
      enabled: true,
    };
    const remoteProject = {
      id: "owned-project",
      connectionId: connection.id,
      name: "site",
      root: "/home/dev/site",
      path: "D:/private/anchors/owned-project",
    };
    vi.mocked(agentApi.remote).mockImplementation(async (method) => {
      if (method === "list")
        return { connections: [connection], projects: [remoteProject] };
      if (method === "openProject") return remoteProject;
      return connection;
    });
    const onOpenProject = vi.fn();
    const options = { ...props(), onOpenProject };
    render(<AgentOperationsPanel {...options} />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "SSH / WSL" }));
    await flush();
    fireEvent.change(screen.getByLabelText("远程项目目录"), {
      target: { value: "/home/dev/site" },
    });
    fireEvent.click(screen.getByRole("button", { name: "在工作台打开" }));
    await flush();
    expect(agentApi.remote).toHaveBeenCalledWith("openProject", [
      connection.id,
      "/home/dev/site",
    ]);
    expect(onOpenProject).toHaveBeenCalledWith(remoteProject.path);
    expect(options.onOpenChange).toHaveBeenCalledWith(false);
    expect(
      vi
        .mocked(agentApi.native)
        .mock.calls.some(
          ([service, method]) =>
            service === "IZCodeTaskService" || method === "initialize",
        ),
    ).toBe(false);
    expect(screen.queryByText("远程任务")).not.toBeInTheDocument();
  });

  it("keeps disconnected projects visible, supports explicit reconnect and manual WSL names after discovery fails", async () => {
    const connection = {
      id: "remote-owned",
      name: "Owned SSH",
      target: { kind: "ssh", host: "owned-alias" },
      enabled: false,
    };
    vi.mocked(agentApi.remote).mockImplementation(async (method) => {
      if (method === "list")
        return {
          connections: [connection],
          projects: [
            {
              id: "p",
              connectionId: connection.id,
              name: "site",
              root: "/home/dev/site",
              path: "D:/private/anchors/p",
            },
          ],
        };
      if (method === "listWSL") throw new Error("WSL 环境未就绪");
      if (method === "reconnect") {
        connection.enabled = true;
        return connection;
      }
      return connection;
    });
    render(
      <AgentOperationsPanel
        {...props()}
        onOpenProject={vi.fn()}
        initialTab="remote"
      />,
    );
    await flush();
    expect(screen.getByRole("button", { name: "打开工程" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await flush();
    expect(agentApi.remote).toHaveBeenCalledWith("reconnect", [connection.id]);
    expect(screen.getByRole("button", { name: "打开工程" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("远程连接类型"), {
      target: { value: "wsl" },
    });
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("WSL 环境未就绪");
    expect(screen.getByLabelText("WSL 发行版")).toBeEnabled();
  });
});
