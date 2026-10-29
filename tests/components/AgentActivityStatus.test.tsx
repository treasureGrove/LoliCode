import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentActivityStatus } from "@/features/agent/AgentActivityStatus";
import type { AgentMessage, AgentSnapshot } from "@/types/agent";

const message = (
  parts: AgentMessage["parts"],
  completedAt?: number,
): AgentMessage => ({
  id: "assistant",
  role: "assistant",
  createdAt: 2,
  parts,
  completedAt,
});
const snapshot = (
  status: AgentSnapshot["status"],
  messages: AgentMessage[] = [],
): AgentSnapshot => ({
  session: {
    id: "session",
    title: "task",
    projectPath: "/project",
    createdAt: 1,
    updatedAt: 2,
  },
  status,
  messages,
  permissions: [],
  questions: [],
  diffs: [],
});

describe("AgentActivityStatus", () => {
  it("shows waiting for the first model token only for the current unfinished placeholder", () => {
    const value = snapshot("running", [
      message([{ type: "text", text: "上一请求已完成" }], 3),
      {
        id: "user",
        role: "user",
        createdAt: 4,
        parts: [{ type: "text", text: "继续" }],
      },
      { ...message([]), id: "placeholder", createdAt: 5 },
    ]);
    value.modelPhase = "waiting";
    const props = { queued: false, stopping: false, loading: false };
    const view = render(<AgentActivityStatus snapshot={value} {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在等待模型响应…");
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-phase",
      "waiting_model",
    );
    value.messages[value.messages.length - 1].completedAt = 6;
    value.modelPhase = undefined;
    view.rerender(<AgentActivityStatus snapshot={value} {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在执行…");
  });
  it("uses the real finishing phase and clears it on completion rather than showing a stale reply", () => {
    const value = snapshot("running", [
      message([{ type: "text", text: "已生成回复" }]),
    ]);
    value.modelPhase = "finishing";
    const props = { queued: false, stopping: false, loading: false };
    const view = render(<AgentActivityStatus snapshot={value} {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在收尾统计…");
    value.status = "idle";
    value.modelPhase = undefined;
    view.rerender(<AgentActivityStatus snapshot={value} {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("准备就绪");
  });
  it("shows context compaction only while the backend reports a running checkpoint", () => {
    const value = snapshot("running");
    value.compacting = true;
    const props = { queued: false, stopping: false, loading: false };
    const view = render(<AgentActivityStatus snapshot={value} {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在整理上下文…");
    view.rerender(<AgentActivityStatus snapshot={value} {...props} stopping />);
    expect(screen.getByRole("status")).toHaveTextContent("正在停止…");
    value.status = "idle";
    view.rerender(<AgentActivityStatus snapshot={value} {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("准备就绪");
  });
  it("uses actual streamed parts for thinking, replying and tool execution", () => {
    const value = snapshot("running", [
      message([{ type: "reasoning", text: "比较两个可用方向" }]),
    ]);
    const view = render(
      <AgentActivityStatus
        snapshot={value}
        queued={false}
        stopping={false}
        loading={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在思考…");
    value.messages[0].parts.push({
      type: "text",
      text: "建议先完成 Agent 交互",
    });
    view.rerender(
      <AgentActivityStatus
        snapshot={value}
        queued={false}
        stopping={false}
        loading={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在回复…");
    value.messages[0].completedAt = 3;
    value.messages[0].parts.push({
      type: "tool",
      id: "tool",
      name: "read",
      state: "running",
      input: {},
    });
    view.rerender(
      <AgentActivityStatus
        snapshot={value}
        queued={false}
        stopping={false}
        loading={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在执行工具…");
  });

  it("does not infer thinking or current tool activity from previous turns or completed messages", () => {
    const value = snapshot("running", [
      message([
        { type: "tool", id: "old", name: "read", state: "running", input: {} },
      ]),
      {
        id: "new",
        role: "user",
        createdAt: 4,
        parts: [{ type: "text", text: "新的任务" }],
      },
      message([{ type: "reasoning", text: "" }]),
    ]);
    const view = render(
      <AgentActivityStatus
        snapshot={value}
        queued={false}
        stopping={false}
        loading={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在执行…");
    value.messages = [
      message([{ type: "reasoning", text: "已经结束的思考" }], 3),
    ];
    view.rerender(
      <AgentActivityStatus
        snapshot={value}
        queued={false}
        stopping={false}
        loading={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在执行…");
  });

  it("waiting for the user takes priority over stale parts and does not display an activity spinner", () => {
    const value = snapshot("waiting_question", [
      message([{ type: "reasoning", text: "已提出问题" }]),
    ]);
    const view = render(
      <AgentActivityStatus
        snapshot={value}
        queued={false}
        stopping={false}
        loading={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("等待你的回答");
    expect(
      screen.getByRole("status").querySelector(".animate-spin"),
    ).toBeNull();
    value.status = "waiting_permission";
    view.rerender(
      <AgentActivityStatus
        snapshot={value}
        queued={false}
        stopping={false}
        loading={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("等待你的许可");
    expect(
      screen.getByRole("status").querySelector(".animate-spin"),
    ).toBeNull();
  });

  it("clears active presentation on completion and prioritizes pending stop or submission", () => {
    const value = snapshot("idle", [
      message([{ type: "reasoning", text: "旧内容" }]),
    ]);
    const view = render(
      <AgentActivityStatus
        snapshot={value}
        queued={true}
        stopping={true}
        loading={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在停止…");
    view.rerender(
      <AgentActivityStatus
        snapshot={value}
        queued={true}
        stopping={false}
        loading={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("已发送，等待开始…");
    view.rerender(
      <AgentActivityStatus
        snapshot={value}
        queued={false}
        stopping={false}
        loading={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("准备就绪");
    expect(
      screen.getByRole("status").querySelector(".animate-spin"),
    ).toBeNull();
  });
});
