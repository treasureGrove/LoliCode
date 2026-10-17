import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentOperationsPanel } from "@/components/agent/AgentOperationsPanel";
import { automationCron } from "@/components/agent/AgentAutomationPanel";
import { agentApi } from "@/lib/api/agent";
import type { AgentCatalog, AgentSession } from "@/types/agent";
import { WindowControlsContext } from "@/components/shell/AppPageHeader";

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
        ? []
        : method === "listWSL"
          ? [{ name: "Ubuntu" }]
          : { id: "remote-owned", kind: "ssh", state: "connected" },
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
  it("separates real idle triggers from wall-clock schedules and sends the chosen inactivity thresholds", async () => {
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "自动化" }));
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "创建定时任务" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "手动创建" }));
    fireEvent.change(screen.getByLabelText("自动化触发方式"), {
      target: { value: "idle" },
    });
    await flush();
    expect(screen.queryByLabelText("自动化运行时间")).not.toBeInTheDocument();
    expect(agentApi.automation).toHaveBeenCalledWith("idleStatus", []);
    fireEvent.change(screen.getByLabelText("自动化名称"), {
      target: { value: "Idle review" },
    });
    fireEvent.change(screen.getByLabelText("自动化任务内容"), {
      target: { value: "Read owned code" },
    });
    fireEvent.change(screen.getByLabelText("自动化闲置分钟"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("自动化闲时间隔"), {
      target: { value: "120" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存定时任务" }));
    await flush();
    expect(agentApi.automation).toHaveBeenCalledWith("create", [
      expect.objectContaining({
        trigger: "idle",
        idleAfterMinutes: 15,
        idleIntervalMinutes: 120,
        workspacePath: project,
      }),
    ]);
  });
  it("edits the existing automation id and keeps cancellation scoped to its recorded run", async () => {
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
          : method === "update"
            ? job
            : { status: "stopping" },
    );
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "自动化" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "编辑任务" }));
    expect(screen.getByLabelText("自动化名称")).toHaveValue(job.title);
    fireEvent.change(screen.getByLabelText("自动化名称"), {
      target: { value: "Updated task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await flush();
    expect(agentApi.automation).toHaveBeenCalledWith("update", [
      job.automationId,
      expect.objectContaining({ title: "Updated task" }),
      { workspacePath: project },
    ]);
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
  it("loads real workflow catalog and hands creation intent back to the existing composer", async () => {
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    expect(agentApi.native).toHaveBeenCalledWith(
      "IZCodeAgentService",
      "listSavedWorkflows",
      [{ workspacePath: project, scope: "project" }],
    );
    expect(screen.getByText("review-code")).toBeInTheDocument();
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
      "ask",
      undefined,
      project,
    );
    expect(vi.mocked(agentApi.runSavedWorkflow).mock.calls[1]).toEqual(initial);
    expect(onSession).toHaveBeenCalledWith(session);
  });
  it("creates a weekly schedule through simple controls with the actual opaque gateway model id", async () => {
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "自动化" }));
    await flush();
    expect(screen.queryByLabelText("自动化执行计划")).not.toBeInTheDocument();
    expect(screen.getAllByText("每天 09:00").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "创建定时任务" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "手动创建" }));
    fireEvent.change(screen.getByLabelText("自动化名称"), {
      target: { value: "每周检查" },
    });
    fireEvent.change(screen.getByLabelText("自动化任务内容"), {
      target: { value: "Review owned code" },
    });
    fireEvent.change(screen.getByLabelText("自动化运行频率"), {
      target: { value: "weekly" },
    });
    fireEvent.change(screen.getByLabelText("自动化运行时间"), {
      target: { value: "14:35" },
    });
    fireEvent.change(screen.getByLabelText("自动化运行星期"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存定时任务" }));
    await flush();
    expect(agentApi.automation).toHaveBeenCalledWith("create", [
      expect.objectContaining({
        title: "每周检查",
        cronExpr: "35 14 * * 3",
        workspacePath: project,
        modelSelection: {
          providerId: "lolicode",
          modelId: "source/model",
          options: { reasoningLevel: "default" },
        },
      }),
    ]);
    expect(automationCron("hourly", "09:00", "1", "12")).toBe("12 * * * *");
    expect(() => automationCron("hourly", "09:00", "1", "91")).toThrow();
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
  it("keeps close, Escape and the original window actions available", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "关闭应用窗口" }));
    expect(windowClose).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "关闭项目与自动化弹窗" }),
    );
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
        ? []
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
    fireEvent.change(screen.getByLabelText("SSH 密码"), {
      target: { value: "owned-private-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接环境" }));
    await flush();
    view.rerender(<AgentOperationsPanel {...options} open={false} />);
    await flush();
    view.rerender(<AgentOperationsPanel {...options} open />);
    await flush();
    expect(screen.getByRole("button", { name: "连接环境" })).toBeDisabled();
    expect(JSON.stringify(localStorage)).not.toContain(
      "owned-private-password",
    );
    await act(async () =>
      finish({ id: "remote-owned", kind: "ssh", state: "connected" }),
    );
    await flush();
    expect(
      vi
        .mocked(agentApi.remote)
        .mock.calls.filter(([method]) => method === "connect"),
    ).toHaveLength(1);
  });
  it("preserves SSH aliases and native model options, and responds to remote permission and multi-select questions", async () => {
    let permissions = true;
    let questions = true;
    let lastRequest = "";
    let firstTransportFailure = false;
    let firstStopFailure = false;
    let completeSend: (() => void) | undefined;
    let heldSend = false;
    vi.mocked(agentApi.remote).mockImplementation(async (method) =>
      method === "list"
        ? [{ id: "remote-owned", kind: "ssh", state: "connected" }]
        : { id: "remote-owned", kind: "ssh", state: "connected" },
    );
    vi.mocked(agentApi.native).mockImplementation(
      async (_service, method, args) => {
        if (method === "listSavedWorkflows")
          return { workflows: [], invalid: [] };
        if (method === "listSavedWorkflowRuns") return { runs: [] };
        if (method === "sendPrompt") {
          if (firstTransportFailure) {
            firstTransportFailure = false;
            throw new Error("remote response lost");
          }
          if (heldSend)
            await new Promise<void>((resolve) => {
              completeSend = resolve;
            });
          lastRequest = (args?.[0] as { traceId: string }).traceId;
          return undefined;
        }
        if (method === "readSessionMessages")
          return lastRequest
            ? [
                {
                  info: {
                    role: "user",
                    messageId: "different-native-message-id",
                    anchor: { sourceCommandId: lastRequest },
                  },
                },
              ]
            : [];
        if (method === "stopGeneration") {
          if (firstStopFailure) {
            firstStopFailure = false;
            throw new Error("stop response lost");
          }
          return true;
        }
        if (method === "initialize") return { available: true };
        if (method === "getView")
          return {
            providers: [
              {
                providerId: "remote-provider",
                providerName: "Remote Fixture",
                models: [
                  {
                    modelId: "source/model",
                    config: {
                      optionSpecs: {
                        reasoningLevel: {
                          values: ["low", "high"],
                          default: "high",
                        },
                      },
                    },
                  },
                ],
              },
            ],
          };
        if (method === "listTasks")
          return [{ taskId: "task-owned", title: "Remote task" }];
        if (method === "createTask") return { taskId: "task-owned" };
        if (method === "getTaskSnapshot")
          return {
            meta: {
              taskId: "task-owned",
              title: "Remote task",
              status: permissions || questions ? "running" : "completed",
            },
            messages: [
              {
                id: "native-message-id",
                role: "assistant",
                content: "真实远程快照 fixture",
              },
            ],
            runtime: {
              pendingPermissions: permissions
                ? [
                    {
                      requestId: "perm-owned",
                      traceId: "turn-owned",
                      description: "允许读取远端文件？",
                      raw: {
                        input: {
                          command: "node --version",
                          cwd: "/owned/project",
                          apiKey: "not-a-display-field",
                        },
                      },
                      options: [
                        {
                          optionId: "once",
                          name: "原生允许一次",
                          response: { behavior: "allow" },
                        },
                      ],
                    },
                  ]
                : [],
              pendingElicitations: questions
                ? [
                    {
                      requestId: "question-owned",
                      traceId: "turn-owned",
                      message: "选择检查项",
                      questions: [
                        {
                          question: "检查哪些文件？",
                          multiSelect: true,
                          options: [
                            { value: "src", label: "源码" },
                            { value: "tests", label: "测试" },
                          ],
                        },
                      ],
                    },
                  ]
                : [],
            },
          };
        if (method === "respondPermission") {
          permissions = false;
          return true;
        }
        if (method === "respondElicitation") {
          questions = false;
          return true;
        }
        return {};
      },
    );
    render(<AgentOperationsPanel {...props()} />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "SSH / WSL" }));
    await flush();
    fireEvent.change(screen.getByLabelText("SSH 主机或别名"), {
      target: { value: "owned-alias" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接环境" }));
    await flush();
    const target = vi
      .mocked(agentApi.remote)
      .mock.calls.find(([method]) => method === "connect")?.[1]?.[0] as {
      target: Record<string, unknown>;
    };
    expect(target.target).toEqual({
      kind: "ssh",
      host: "owned-alias",
      sshConfigAlias: "owned-alias",
    });
    fireEvent.change(screen.getByLabelText("远程工作目录"), {
      target: { value: "C:\\not-supported" },
    });
    fireEvent.click(screen.getByRole("button", { name: "打开远程项目" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "暂不支持 Windows 远端",
    );
    expect(agentApi.native).not.toHaveBeenCalledWith(
      "IZCodeAgentService",
      "initialize",
      expect.anything(),
      expect.anything(),
    );
    fireEvent.change(screen.getByLabelText("远程工作目录"), {
      target: { value: "/owned/project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "打开远程项目" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "新建远程会话" }));
    await flush();
    expect(
      screen.getByText("尚未发送的远程草稿，首次发送后保存。"),
    ).toBeInTheDocument();
    expect(
      vi
        .mocked(agentApi.native)
        .mock.calls.filter(([, method]) => method === "getTaskSnapshot"),
    ).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("远程任务内容"), {
      target: { value: "bootstrap input" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送到远程会话" }));
    await flush();
    expect(agentApi.native).toHaveBeenCalledWith(
      "IZCodeTaskService",
      "createTask",
      [
        {
          workspacePath: "/owned/project",
          mode: "build",
          v4Create: true,
          deferPersistenceUntilFirstPrompt: true,
          modelSelection: {
            providerId: "remote-provider",
            modelId: "source/model",
            options: { reasoningLevel: "high" },
          },
        },
      ],
      { remoteId: "remote-owned" },
    );
    expect(screen.getByText("真实远程快照 fixture")).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, node) =>
          node?.tagName === "PRE" &&
          node.textContent ===
            "命令\nnode --version\n\n工作目录\n/owned/project",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not-a-display-field/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "原生允许一次" }));
    await flush();
    expect(agentApi.native).toHaveBeenCalledWith(
      "IZCodeTaskService",
      "respondPermission",
      [
        {
          taskId: "task-owned",
          workspacePath: "/owned/project",
          requestId: "perm-owned",
          runId: "turn-owned",
          optionId: "once",
          response: { behavior: "allow" },
        },
      ],
      { remoteId: "remote-owned" },
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /：源码$/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /：测试$/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(agentApi.native).toHaveBeenCalledWith(
      "IZCodeTaskService",
      "respondElicitation",
      [
        expect.objectContaining({
          requestId: "question-owned",
          action: "accept",
          content: { answer_0: ["src", "tests"] },
        }),
      ],
      { remoteId: "remote-owned" },
    );
    firstTransportFailure = true;
    fireEvent.change(screen.getByLabelText("远程任务内容"), {
      target: { value: "first input" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送到远程会话" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("remote response lost");
    fireEvent.click(screen.getByRole("button", { name: "发送到远程会话" }));
    await flush();
    const sends = vi
      .mocked(agentApi.native)
      .mock.calls.filter(
        ([, method, args]) =>
          method === "sendPrompt" &&
          (args?.[0] as { content: string }).content === "first input",
      );
    expect(sends).toHaveLength(2);
    expect(sends[1][2]).toEqual(sends[0][2]);
    await tick();
    expect(
      localStorage.getItem(
        'lolicode.remote-input:["remote-owned","/owned/project","task-owned"]',
      ),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("远程任务内容"), {
      target: { value: "second input" },
    });
    heldSend = true;
    firstStopFailure = true;
    fireEvent.click(screen.getByRole("button", { name: "发送到远程会话" }));
    await flush();
    expect(
      screen.getByRole("button", { name: "发送到远程会话" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "停止远程任务" }));
    await flush();
    expect(agentApi.native).toHaveBeenCalledWith(
      "IZCodeTaskService",
      "stopGeneration",
      [{ taskId: "task-owned", workspacePath: "/owned/project" }],
      { remoteId: "remote-owned" },
    );
    await tick();
    const receiptKey =
      'lolicode.remote-input:["remote-owned","/owned/project","task-owned"]';
    expect(
      JSON.parse(localStorage.getItem(receiptKey) || "null"),
    ).toMatchObject({ stopRequested: true, stopAcknowledged: false });
    await act(async () => completeSend?.());
    await flush();
    await tick();
    expect(
      vi
        .mocked(agentApi.native)
        .mock.calls.filter(([, method]) => method === "stopGeneration"),
    ).toHaveLength(2);
    expect(localStorage.getItem(receiptKey)).toBeNull();
  });
});
