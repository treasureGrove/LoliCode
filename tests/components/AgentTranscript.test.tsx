import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AgentTranscript,
  groupAgentTranscript,
} from "@/features/agent/AgentTranscript";
import { AgentRunError } from "@/features/agent/AgentRunError";
import { AgentFileActionsContext } from "@/features/agent/AgentFilePath";
import type { AgentMessage, AgentPart } from "@/types/agent";

vi.mock("@/features/sessions/reader/SessionMarkdown", () => ({
  SessionMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

type Tool = Extract<AgentPart, { type: "tool" }>;
const tool = (id: string, patch: Partial<Tool> = {}): Tool => ({
  type: "tool",
  id,
  name: "write_file",
  state: "completed",
  input: { path: `${id}.txt` },
  output: `${id} private output`,
  ...patch,
});
const message = (
  id: string,
  parts: AgentPart[],
  role: AgentMessage["role"] = "assistant",
): AgentMessage => ({ id, role, createdAt: 1, completedAt: 2, parts });
const user = (id: string) =>
  message(id, [{ type: "text", text: `Request ${id}` }], "user");
const groups = (container: HTMLElement) =>
  container.querySelectorAll<HTMLDetailsElement>(".wb-execution-group");

describe("Agent transcript execution groups", () => {
  it("counts completed file targets once across relative and Windows absolute spellings", () => {
    const view = render(
      <AgentTranscript
        projectPath="D:/Project"
        messages={[
          user("one"),
          message("a", [
            tool("a", {
              input: { path: "src/a.ts", file_path: "unused-extra.ts" },
            }),
            tool("b", { input: { path: "D:\\project\\src\\a.ts" } }),
            tool("c", { input: { path: "./src/../src/a.ts" } }),
          ]),
        ]}
      />,
    );
    expect(
      groups(view.container)[0].querySelector("summary"),
    ).toHaveTextContent("已修改 1 个文件 · 已执行 3 步");
  });
  it("merges consecutive assistant tools and reasoning into one closed group without mounting bodies", async () => {
    let outputReads = 0;
    let reasoningReads = 0;
    const first = tool("a");
    Object.defineProperty(first, "output", {
      get: () => {
        outputReads++;
        return "large hidden output";
      },
    });
    const reasoning: AgentPart = { type: "reasoning", text: "" };
    Object.defineProperty(reasoning, "text", {
      get: () => {
        reasoningReads++;
        return "private chain of thought";
      },
    });
    const messages = [
      user("first"),
      message("a", [first]),
      message("b", [reasoning]),
      message("c", [
        tool("b"),
        tool("c", { name: "run_command", input: { command: "verify" } }),
      ]),
    ];
    const view = render(
      <AgentTranscript messages={messages} projectPath="/project" />,
    );
    expect(groups(view.container)).toHaveLength(1);
    const group = groups(view.container)[0];
    expect(group.open).toBe(false);
    expect(group.querySelector("summary")).toHaveTextContent(
      "已修改 2 个文件 · 已执行 3 步",
    );
    expect(view.container.querySelectorAll("details")).toHaveLength(1);
    expect(outputReads).toBe(0);
    expect(reasoningReads).toBe(0);
    await userEvent.click(group.querySelector("summary")!);
    expect(view.container.querySelectorAll("details")).toHaveLength(5);
    expect(outputReads).toBe(0);
    expect(reasoningReads).toBe(0);
    expect(screen.queryByText("large hidden output")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("思考过程"));
    expect(screen.getByText("private chain of thought")).toBeVisible();
    await userEvent.click(group.querySelector("summary")!);
    expect(
      screen.queryByText("private chain of thought"),
    ).not.toBeInTheDocument();
    expect(view.container.querySelectorAll("details")).toHaveLength(1);
  });

  it("keeps real reply text, user and system boundaries in the original order", () => {
    const messages = [
      user("one"),
      message("a", [
        tool("a"),
        { type: "text", text: "First reply" },
        { type: "reasoning", text: "hidden" },
      ]),
      message("b", [tool("b"), { type: "text", text: "   " }]),
      user("two"),
      message("c", [tool("c"), { type: "text", text: "Second reply" }]),
      message("system", [{ type: "text", text: "System note" }], "system"),
    ];
    expect(groupAgentTranscript(messages).map((block) => block.kind)).toEqual([
      "message",
      "activity",
      "text",
      "activity",
      "message",
      "activity",
      "text",
      "message",
    ]);
    const view = render(
      <AgentTranscript messages={messages} projectPath="/project" />,
    );
    expect(groups(view.container)).toHaveLength(3);
    const text = view.container.textContent!;
    const ordered = [
      "Request one",
      "First reply",
      "Request two",
      "Second reply",
      "System note",
    ];
    for (let index = 1; index < ordered.length; index++)
      expect(text.indexOf(ordered[index - 1])).toBeLessThan(
        text.indexOf(ordered[index]),
      );
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
    expect(
      groups(view.container)[1].querySelector("summary"),
    ).toHaveTextContent("已执行 1 步");
  });

  it("updates a running count without reopening the group and preserves chosen expansion", async () => {
    const prefix = [
      user("one"),
      message("thinking", [
        { type: "reasoning", id: "reason", text: "thinking" },
      ]),
    ];
    const view = render(
      <AgentTranscript
        messages={prefix}
        projectPath="/project"
        status="running"
      />,
    );
    const original = groups(view.container)[0];
    expect(original.querySelector("summary")).toHaveTextContent("正在思考");
    const running = [
      ...prefix,
      message("tools", [tool("a", { state: "running" })]),
    ];
    view.rerender(
      <AgentTranscript
        messages={running}
        projectPath="/project"
        status="running"
      />,
    );
    expect(groups(view.container)[0]).toBe(original);
    expect(original.open).toBe(false);
    expect(original.querySelector("summary")).toHaveTextContent(
      "正在处理 1 个步骤",
    );
    expect(screen.queryByText("写入文件")).not.toBeInTheDocument();
    await userEvent.click(original.querySelector("summary")!);
    view.rerender(
      <AgentTranscript
        messages={[...prefix, message("tools", [tool("a"), tool("b")])]}
        projectPath="/project"
        status="running"
      />,
    );
    expect(groups(view.container)[0]).toBe(original);
    expect(original.open).toBe(true);
    expect(original.querySelector("summary")).toHaveTextContent(
      "正在处理 2 个步骤",
    );
    view.rerender(
      <AgentTranscript
        messages={[...prefix, message("tools", [tool("a"), tool("b")])]}
        projectPath="/project"
        status="idle"
      />,
    );
    expect(original.open).toBe(true);
    expect(original.querySelector("summary")).toHaveTextContent(
      "已修改 2 个文件 · 已执行 2 步",
    );
  });

  it("retains file actions and per-step expansion when the execution group is hidden and reopened", async () => {
    const preview = vi.fn();
    const view = render(
      <AgentFileActionsContext.Provider
        value={{
          sessionId: "session",
          projectPath: "/project",
          onPreview: preview,
        }}
      >
        <AgentTranscript
          messages={[user("one"), message("a", [tool("a")])]}
          projectPath="/project"
        />
      </AgentFileActionsContext.Provider>,
    );
    const group = groups(view.container)[0];
    await userEvent.click(group.querySelector("summary")!);
    const step = within(group).getByText("写入文件").closest("details")!;
    await userEvent.click(step.querySelector("summary")!);
    expect(screen.getByText("a private output")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "预览文件：a.txt" }),
    );
    expect(preview).toHaveBeenCalledWith("a.txt");
    await userEvent.click(group.querySelector("summary")!);
    expect(screen.queryByText("a private output")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "预览文件：a.txt" }),
    ).not.toBeInTheDocument();
    await userEvent.click(group.querySelector("summary")!);
    expect(
      within(group).getByText("写入文件").closest("details"),
    ).toHaveAttribute("open");
    expect(screen.getByText("a private output")).toBeVisible();
  });

  it("keeps failures readable while folded without claiming failed writes changed files or treating stop as failure", async () => {
    const view = render(
      <AgentTranscript
        projectPath="/project"
        messages={[
          user("one"),
          message("a", [
            tool("a", { state: "error", error: "File changed externally" }),
            tool("b", { state: "error", error: "任务已停止" }),
            tool("c"),
          ]),
        ]}
      />,
    );
    const group = groups(view.container)[0];
    expect(group.querySelector("summary")).toHaveTextContent("已修改 1 个文件");
    expect(group.querySelector("summary")).toHaveTextContent(
      "1 步失败：File changed externally",
    );
    expect(group.querySelector("summary")).toHaveTextContent("1 步已停止");
    expect(view.container.querySelectorAll("details")).toHaveLength(1);
    await userEvent.click(group.querySelector("summary")!);
    expect(screen.getByText("已停止")).toBeVisible();
  });
});

describe("Agent turn failure footer", () => {
  it("binds a concrete failure to the final user turn and uses the inline error structure", () => {
    const messages = [
      user("old"),
      message("old-reply", [{ type: "text", text: "Old response" }]),
      user("new"),
      message("new-reply", []),
    ];
    render(
      <AgentRunError
        messages={messages}
        status="error"
        error="HTTP 500: model gateway unavailable"
        currentTurnId="new"
      />,
    );
    const failure = screen.getByRole("alert");
    expect(failure).toHaveAttribute("data-turn-id", "new");
    expect(failure).toHaveClass("wb-run-error");
    expect(failure.querySelector(".wb-run-error-dot")).not.toBeNull();
    expect(within(failure).getByText("本轮运行失败")).toBeVisible();
    expect(
      within(failure).getByText("HTTP 500: model gateway unavailable"),
    ).toBeVisible();
    expect(failure.querySelector(".wb-notice")).toBeNull();
  });

  it("does not put a stale failure under a new local turn or active response", () => {
    const messages = [user("old"), message("reply", [])];
    const view = render(
      <AgentRunError
        messages={messages}
        status="error"
        error="old failure"
        currentTurnId="old"
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    view.rerender(
      <AgentRunError
        messages={messages}
        status="error"
        error="old failure"
        pending
        currentTurnId="new"
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.rerender(
      <AgentRunError
        messages={[...messages, user("new")]}
        status="error"
        error="old failure"
        currentTurnId="old"
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.rerender(
      <AgentRunError
        messages={[...messages, user("new")]}
        status="running"
        error="old failure"
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("distinguishes explicit cancellation and can show a failure before an assistant message exists", () => {
    const messages = [user("one")];
    const view = render(
      <AgentRunError messages={messages} status="idle" error="任务已停止" />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveClass("wb-run-cancelled");
    expect(screen.getByText("本轮已停止")).toBeVisible();
    view.rerender(
      <AgentRunError
        messages={messages}
        status="error"
        error="上下文无法安全整理"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("上下文无法安全整理");
    view.rerender(
      <AgentRunError messages={[]} status="error" error="missing session" />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
