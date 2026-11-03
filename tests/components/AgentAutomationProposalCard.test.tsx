import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAutomationProposalCard } from "@/features/agent/AgentAutomationProposalCard";
import { AgentTranscript } from "@/features/agent/AgentTranscript";
import { agentApi } from "@/lib/api/agent";
import {
  parseAutomationProposal,
  type AgentAutomationProposal,
} from "@/lib/agentAutomation";
import type { AgentPart, AgentSession, AgentSnapshot } from "@/types/agent";

vi.mock("@/lib/api/agent", () => ({
  agentApi: { getSession: vi.fn(), automation: vi.fn() },
}));

const projectPath = "D:/owned/proposal-project";
const sessionId = "lc:automation-design";
const proposal: AgentAutomationProposal = {
  type: "automation_proposal",
  version: 1,
  input: {
    title: "每日代码检查",
    prompt: "检查当前项目代码变更并整理待办。",
    trigger: "schedule",
    cronExpr: "0 9 * * *",
  },
};
const snapshot = (
  permissionMode: AgentSession["permissionMode"] = "auto",
): AgentSnapshot => ({
  session: {
    id: sessionId,
    title: "自动化设计",
    projectPath,
    model: { providerId: "owned-channel", modelId: "source/model" },
    permissionMode,
    reasoningEffort: "high",
    createdAt: 1,
    updatedAt: 1,
  },
  status: "idle",
  messages: [],
  permissions: [],
  questions: [],
  diffs: [],
});
type Tool = Extract<AgentPart, { type: "tool" }>;
const tool = (patch: Partial<Tool> = {}): Tool => ({
  type: "tool",
  id: "proposal-1",
  name: "propose_automation",
  state: "completed",
  input: proposal.input,
  output: JSON.stringify(proposal),
  ...patch,
});
const transcript = (part = tool()) => (
  <AgentTranscript
    projectPath={projectPath}
    sessionId={sessionId}
    messages={[
      {
        id: "assistant",
        role: "assistant",
        createdAt: 1,
        parts: [
          { type: "reasoning", text: "先确定项目检查的安排。" },
          {
            ...tool(),
            id: "read-1",
            name: "read_file",
            output: "project notes",
          },
          part,
          { type: "text", text: "确认后可保存下面的自动化配置。" },
        ],
      },
    ]}
  />
);
const card = (value = proposal) => (
  <AgentAutomationProposalCard
    proposal={value}
    toolCallId="proposal-1"
    projectPath={projectPath}
    sessionId={sessionId}
  />
);
const confirmResult = (
  automationId: unknown = "saved-job",
  toolCallId: unknown = "proposal-1",
) => ({ status: "saved", automationId, toolCallId });

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(agentApi.getSession).mockReset().mockResolvedValue(snapshot());
  vi.mocked(agentApi.automation)
    .mockReset()
    .mockImplementation(async (method, args = []) =>
      method === "list"
        ? []
        : method === "confirmProposal"
          ? confirmResult(args[0], args[2])
          : { automationId: "saved-job" },
    );
});

describe("automation proposal transcript integration", () => {
  it("keeps completed proposals visible outside collapsed execution details", () => {
    const view = render(transcript());
    const preview = screen.getByRole("region", { name: "自动化配置提案" });
    expect(
      within(preview).getByRole("heading", { name: proposal.input.title }),
    ).toBeVisible();
    expect(within(preview).getByText("每天 09:00")).toBeVisible();
    expect(
      within(preview).getByRole("button", { name: "保存自动化" }),
    ).toBeVisible();
    expect(preview.closest("details")).toBeNull();
    expect(
      view.container.querySelector(".wb-execution-group"),
    ).not.toHaveAttribute("open");
    expect(
      screen.queryByText("先确定项目检查的安排。"),
    ).not.toBeInTheDocument();
    expect(agentApi.getSession).not.toHaveBeenCalled();
    expect(agentApi.automation).not.toHaveBeenCalled();
  });

  it.each([
    { permissionMode: "ask", mode: "build" },
    { permissionMode: "auto", mode: "guarded" },
    { permissionMode: "full_access", mode: "yolo" },
  ] as const)(
    "saves the current project's proposal using the session model and $permissionMode permissions",
    async ({ permissionMode, mode }) => {
      vi.mocked(agentApi.getSession).mockResolvedValue(
        snapshot(permissionMode),
      );
      render(transcript());
      fireEvent.click(screen.getByRole("button", { name: "保存自动化" }));
      expect(await screen.findByText("已保存自动化")).toBeVisible();
      expect(agentApi.getSession).toHaveBeenCalledOnce();
      expect(agentApi.getSession).toHaveBeenCalledWith(sessionId);
      expect(agentApi.automation).toHaveBeenCalledWith("create", [
        expect.objectContaining({
          ...proposal.input,
          workspacePath: projectPath,
          clientRequestId: `proposal:${sessionId}:proposal-1`,
          recurring: true,
          mode,
          modelSelection: {
            providerId: "owned-channel",
            modelId: "source/model",
            options: { reasoningLevel: "high" },
          },
        }),
      ]);
      expect(agentApi.automation).toHaveBeenCalledWith("confirmProposal", [
        "saved-job",
        sessionId,
        "proposal-1",
        { workspacePath: projectPath },
      ]);
      expect(
        screen.queryByRole("button", { name: "保存自动化" }),
      ).not.toBeInTheDocument();
    },
  );

  it.each([
    {
      state: "error" as const,
      output: JSON.stringify(proposal),
      error: "提案工具执行失败",
    },
    { state: "running" as const, output: JSON.stringify(proposal) },
    { state: "completed" as const, output: "{invalid-json}" },
    {
      name: "read_file",
      state: "completed" as const,
      output: JSON.stringify(proposal),
    },
    {
      state: "completed" as const,
      output: JSON.stringify({
        ...proposal,
        input: { ...proposal.input, cronExpr: "0 9 1 * *" },
      }),
    },
  ])(
    "does not expose a save card for invalid or incomplete tool results: %o",
    (patch) => {
      render(transcript(tool(patch)));
      expect(
        screen.queryByRole("region", { name: "自动化配置提案" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /保存自动化|保存修改/ }),
      ).not.toBeInTheDocument();
      expect(agentApi.automation).not.toHaveBeenCalled();
    },
  );
  it("does not turn a display-only Markdown proposal into a save action", () => {
    render(
      <AgentTranscript
        projectPath={projectPath}
        sessionId={sessionId}
        messages={[
          {
            id: "plain-text",
            role: "assistant",
            createdAt: 1,
            parts: [
              {
                type: "text",
                text: `下面是一份配置示例：\n\n\`\`\`json\n${JSON.stringify(proposal, null, 2)}\n\`\`\``,
              },
            ],
          },
        ]}
      />,
    );
    expect(
      screen.queryByRole("region", { name: "自动化配置提案" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /保存自动化|保存修改/ }),
    ).not.toBeInTheDocument();
    expect(agentApi.automation).not.toHaveBeenCalled();
  });
});

describe("automation proposal saves", () => {
  it("retries a lost response with exactly the same payload even after session settings change", async () => {
    vi.mocked(agentApi.automation).mockRejectedValueOnce(
      new Error("保存响应丢失"),
    );
    render(card());
    fireEvent.click(screen.getByRole("button", { name: "保存自动化" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存响应丢失");
    const first = vi.mocked(agentApi.automation).mock.calls[0];
    const changed = snapshot("full_access");
    changed.session.model = {
      providerId: "other-channel",
      modelId: "other-model",
    };
    changed.session.reasoningEffort = "low";
    vi.mocked(agentApi.getSession).mockResolvedValue(changed);
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    expect(await screen.findByText("已保存自动化")).toBeVisible();
    expect(vi.mocked(agentApi.automation).mock.calls[1]).toEqual(first);
    expect(agentApi.getSession).toHaveBeenCalledOnce();
  });

  it("restores an unconfirmed save across remounts with its original clientRequestId and payload", async () => {
    vi.mocked(agentApi.automation).mockRejectedValueOnce(new Error("连接中断"));
    const view = render(card());
    fireEvent.click(screen.getByRole("button", { name: "保存自动化" }));
    await screen.findByRole("alert");
    const first = vi.mocked(agentApi.automation).mock.calls[0];
    view.unmount();
    vi.mocked(agentApi.getSession).mockResolvedValue(snapshot("full_access"));
    render(card());
    expect(screen.getByText("自动 · 风险操作询问")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "保存自动化" }));
    expect(await screen.findByText("已保存自动化")).toBeVisible();
    expect(vi.mocked(agentApi.automation).mock.calls[1]).toEqual(first);
    expect(agentApi.getSession).toHaveBeenCalledOnce();
  });

  it("restores a confirmed save after reopening without offering or dispatching a second save", async () => {
    const view = render(card());
    fireEvent.click(screen.getByRole("button", { name: "保存自动化" }));
    expect(await screen.findByText("已保存自动化")).toBeVisible();
    view.unmount();
    render(card());
    expect(screen.getByText("已保存自动化")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /保存自动化|保存修改|重试保存/ }),
    ).not.toBeInTheDocument();
    expect(agentApi.automation).toHaveBeenCalledTimes(2);
    expect(agentApi.getSession).toHaveBeenCalledOnce();
  });

  it("updates the original job in its workspace and preserves saved model options and one-shot behavior", async () => {
    const existing = {
      automationId: "owned-job",
      title: "旧任务",
      prompt: "旧任务内容",
      cronExpr: "0 8 * * *",
      enabled: false,
      lifecycleStatus: "paused",
      recurring: false,
      mode: "yolo",
      locale: "en",
      idleAfterMinutes: 25,
      idleIntervalMinutes: 90,
      modelSelection: {
        providerId: "saved-channel",
        modelId: "saved-model",
        options: { reasoningLevel: "max", contextWindow: 64000, custom: true },
      },
    };
    vi.mocked(agentApi.automation).mockImplementation(
      async (method, args = []) =>
        method === "list"
          ? [existing]
          : method === "confirmProposal"
            ? confirmResult(args[0], args[2])
            : existing,
    );
    render(card({ ...proposal, automationId: existing.automationId }));
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByText("已保存自动化")).toBeVisible();
    expect(agentApi.automation).toHaveBeenCalledWith("list", [
      { workspacePath: projectPath },
    ]);
    expect(agentApi.automation).toHaveBeenCalledWith("update", [
      existing.automationId,
      expect.objectContaining({
        workspacePath: projectPath,
        clientRequestId: `proposal:${sessionId}:proposal-1`,
        recurring: false,
        mode: "yolo",
        locale: "en",
        idleAfterMinutes: 25,
        idleIntervalMinutes: 90,
        modelSelection: existing.modelSelection,
      }),
      { workspacePath: projectPath },
    ]);
    expect(agentApi.automation).not.toHaveBeenCalledWith(
      "create",
      expect.anything(),
    );
  });

  it.each([false, true])(
    "retries only conversation confirmation after saving succeeds and syncing fails, remounted=%s",
    async (remount) => {
      let attempts = 0;
      vi.mocked(agentApi.automation).mockImplementation(
        async (method, args = []) => {
          if (method === "confirmProposal") {
            if (++attempts === 1) throw new Error("对话记录暂时不可用");
            return confirmResult(args[0], args[2]);
          }
          return { automationId: "saved-job" };
        },
      );
      const view = render(card());
      fireEvent.click(screen.getByRole("button", { name: "保存自动化" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "自动化已保存，对话记录尚未同步",
      );
      expect(screen.queryByText("已保存自动化")).not.toBeInTheDocument();
      if (remount) {
        view.unmount();
        render(card());
      }
      vi.mocked(agentApi.getSession).mockResolvedValue(snapshot("full_access"));
      fireEvent.click(screen.getByRole("button", { name: "同步保存结果" }));
      expect(await screen.findByText("已保存自动化")).toBeVisible();
      const calls = vi.mocked(agentApi.automation).mock.calls;
      expect(calls.map(([method]) => method)).toEqual([
        "create",
        "confirmProposal",
        "confirmProposal",
      ]);
      expect(calls[2]).toEqual(calls[1]);
      expect(calls[2][1]).toEqual([
        "saved-job",
        sessionId,
        "proposal-1",
        { workspacePath: projectPath },
      ]);
      expect(agentApi.getSession).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { status: "pending", automationId: "saved-job", toolCallId: "proposal-1" },
    { status: "saved", automationId: "another-job", toolCallId: "proposal-1" },
    { status: "saved", automationId: "saved-job", toolCallId: "another-tool" },
  ])(
    "does not accept a confirmation ACK for a different save: %o",
    async (ack) => {
      vi.mocked(agentApi.automation).mockImplementation(async (method) =>
        method === "confirmProposal" ? ack : { automationId: "saved-job" },
      );
      render(card());
      fireEvent.click(screen.getByRole("button", { name: "保存自动化" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "未收到有效的对话记录同步结果",
      );
      expect(
        screen.getByRole("button", { name: "同步保存结果" }),
      ).toBeEnabled();
      expect(screen.queryByText("已保存自动化")).not.toBeInTheDocument();
      expect(
        vi.mocked(agentApi.automation).mock.calls.map(([method]) => method),
      ).toEqual(["create", "confirmProposal"]);
    },
  );

  it("keeps a timed-out confirmation separate from the completed save and retries only confirmation", async () => {
    vi.useFakeTimers();
    let ready = false;
    vi.mocked(agentApi.automation).mockImplementation(
      async (method, args = []) =>
        method === "confirmProposal"
          ? ready
            ? confirmResult(args[0], args[2])
            : new Promise(() => {})
          : { automationId: "saved-job" },
    );
    const flush = () =>
      act(async () => {
        for (let index = 0; index < 12; index++) await Promise.resolve();
      });
    try {
      render(card());
      fireEvent.click(screen.getByRole("button", { name: "保存自动化" }));
      await flush();
      expect(screen.getByRole("button", { name: "正在同步…" })).toBeDisabled();
      await act(async () => vi.advanceTimersByTimeAsync(30_001));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "自动化已保存，对话记录尚未同步",
      );
      ready = true;
      fireEvent.click(screen.getByRole("button", { name: "同步保存结果" }));
      await flush();
      expect(screen.getByText("已保存自动化")).toBeVisible();
      expect(
        vi.mocked(agentApi.automation).mock.calls.map(([method]) => method),
      ).toEqual(["create", "confirmProposal", "confirmProposal"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers an already mounted card when native history confirms a previously failed sync", async () => {
    vi.mocked(agentApi.automation).mockImplementation(async (method) => {
      if (method === "confirmProposal") throw new Error("响应中断");
      return { automationId: "saved-job" };
    });
    const view = render(transcript());
    const originalCard = screen.getByRole("region", { name: "自动化配置提案" });
    fireEvent.click(screen.getByRole("button", { name: "保存自动化" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "对话记录尚未同步",
    );
    view.rerender(
      transcript(
        tool({
          output: JSON.stringify({
            ...proposal,
            savedAutomationId: "saved-job",
          }),
        }),
      ),
    );
    expect(screen.getByRole("region", { name: "自动化配置提案" })).toBe(
      originalCard,
    );
    expect(screen.getByText("已保存自动化")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "同步保存结果" }),
    ).not.toBeInTheDocument();
    expect(agentApi.automation).toHaveBeenCalledTimes(2);
  });

  it("keeps a mounted card confirmed when native history updates before a late sync rejection", async () => {
    let rejectSync!: (cause: Error) => void;
    vi.mocked(agentApi.automation).mockImplementation(async (method) =>
      method === "confirmProposal"
        ? new Promise((_, reject) => {
            rejectSync = reject;
          })
        : { automationId: "saved-job" },
    );
    const view = render(transcript());
    fireEvent.click(screen.getByRole("button", { name: "保存自动化" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "正在同步…" })).toBeDisabled(),
    );
    view.rerender(
      transcript(
        tool({
          output: JSON.stringify({
            ...proposal,
            savedAutomationId: "saved-job",
          }),
        }),
      ),
    );
    expect(screen.getByText("已保存自动化")).toBeVisible();
    await act(async () => {
      rejectSync(new Error("迟到的同步响应失败"));
      for (let index = 0; index < 10; index++) await Promise.resolve();
    });
    expect(screen.getByText("已保存自动化")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "同步保存结果" }),
    ).not.toBeInTheDocument();
    expect(agentApi.automation).toHaveBeenCalledTimes(2);
  });

  it("restores confirmed native history without browser storage or another save request", () => {
    render(
      transcript(
        tool({
          output: JSON.stringify({
            ...proposal,
            savedAutomationId: "native-saved-job",
          }),
        }),
      ),
    );
    expect(screen.getByText("已保存自动化")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /保存自动化|同步保存结果/ }),
    ).not.toBeInTheDocument();
    expect(agentApi.automation).not.toHaveBeenCalled();
    expect(agentApi.getSession).not.toHaveBeenCalled();
  });

  it("does not save into a project that does not match the live session", async () => {
    const changed = snapshot();
    changed.session.projectPath = "D:/owned/different-project";
    vi.mocked(agentApi.getSession).mockResolvedValue(changed);
    render(card());
    fireEvent.click(screen.getByRole("button", { name: "保存自动化" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "项目或模型无法确认",
    );
    expect(agentApi.automation).not.toHaveBeenCalled();
  });

  it("does not dispatch the same save twice while the first one is pending", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(agentApi.automation).mockImplementation((method, args = []) =>
      method === "confirmProposal"
        ? Promise.resolve(confirmResult(args[0], args[2]))
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    render(card());
    const save = screen.getByRole("button", { name: "保存自动化" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(agentApi.automation).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    finish({ automationId: "saved-job" });
    expect(await screen.findByText("已保存自动化")).toBeVisible();
  });
});

describe("parseAutomationProposal", () => {
  it("preserves the saved automation identity received from completed native tool history", () => {
    const saved = { ...proposal, savedAutomationId: "native-saved-job" };
    expect(parseAutomationProposal(JSON.stringify(saved))).toEqual(saved);
  });
  it("keeps validated scheduling fields and removes untrusted routing values", () => {
    const input = {
      ...proposal.input,
      title: "  每日检查  ",
      workspacePath: "D:/other",
      modelSelection: { providerId: "other", modelId: "other" },
      clientRequestId: "injected",
    };
    expect(
      parseAutomationProposal(JSON.stringify({ ...proposal, input })),
    ).toEqual({ ...proposal, input: { ...proposal.input, title: "每日检查" } });
  });

  it.each([
    { ...proposal, version: 2 },
    { ...proposal, savedAutomationId: "" },
    { ...proposal, savedAutomationId: 42 },
    { ...proposal, input: { ...proposal.input, title: " " } },
    { ...proposal, input: { ...proposal.input, mode: "invalid" } },
    {
      ...proposal,
      input: {
        ...proposal.input,
        trigger: "idle",
        idleAfterMinutes: 0,
        idleIntervalMinutes: 60,
      },
    },
    {
      ...proposal,
      input: {
        ...proposal.input,
        trigger: "idle",
        idleAfterMinutes: 10,
        idleIntervalMinutes: 1.5,
      },
    },
  ])("rejects malformed proposals: %o", (value) => {
    expect(parseAutomationProposal(JSON.stringify(value))).toBeNull();
  });
});
