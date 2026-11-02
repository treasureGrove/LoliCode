import { fireEvent, render, screen, within } from "@testing-library/react";
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

describe("Agent conversation message frames", () => {
  it("places user and assistant identities outside their own bubbles and keeps system notices separate", () => {
    render(
      <AgentTranscript
        projectPath="/project"
        userIdentity={{
          displayName: "Noble Tung",
          avatarUrl: "https://example.com/avatar.png",
        }}
        messages={[
          user("question"),
          message("reply", [{ type: "text", text: "Here is the result." }]),
          message(
            "system",
            [{ type: "text", text: "Session restored." }],
            "system",
          ),
        ]}
      />,
    );
    const question = screen.getByRole("article", { name: "你的消息" });
    const reply = screen.getByRole("article", { name: "Agent 回复" });
    const system = screen.getByRole("article", { name: "系统消息" });
    expect(question).toHaveClass("wb-chat-message", "wb-chat-message--user");
    expect(reply).toHaveClass("wb-chat-message", "wb-chat-message--assistant");
    const userAvatar = question.querySelector(".wb-chat-avatar");
    const assistantAvatar = reply.querySelector(".wb-chat-avatar");
    expect(userAvatar?.parentElement).toBe(question);
    expect(assistantAvatar?.parentElement).toBe(reply);
    expect(userAvatar?.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/avatar.png",
    );
    expect(assistantAvatar?.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("lolicode-icon.png"),
    );
    expect(question.querySelector(".wb-chat-author")).toHaveTextContent(
      "Noble Tung",
    );
    expect(reply.querySelector(".wb-chat-author")).toHaveTextContent("小笨狗");
    expect(
      question.querySelector(".wb-chat-bubble.wb-message-user"),
    ).toHaveTextContent("Request question");
    expect(
      reply.querySelector(".wb-chat-bubble.wb-message-assistant"),
    ).toHaveTextContent("Here is the result.");
    expect(system).toHaveClass("wb-chat-message--system");
    expect(system.querySelector(".wb-chat-avatar")).toBeNull();
    expect(system).toHaveTextContent("Session restored.");
  });

  it("falls back after an avatar error and accepts a later avatar without remounting the message", () => {
    const messages = [user("question")];
    const view = render(
      <AgentTranscript
        projectPath="/project"
        messages={messages}
        userIdentity={{
          displayName: "noble",
          avatarUrl: "https://example.com/old.png",
        }}
      />,
    );
    const article = screen.getByRole("article", { name: "你的消息" });
    fireEvent.error(article.querySelector(".wb-chat-avatar img")!);
    expect(article.querySelector(".wb-chat-avatar img")).toBeNull();
    expect(article.querySelector(".wb-chat-avatar-fallback")).toHaveTextContent(
      "N",
    );
    view.rerender(
      <AgentTranscript
        projectPath="/project"
        messages={messages}
        userIdentity={{
          displayName: "noble",
          avatarUrl: "https://example.com/new.png",
        }}
      />,
    );
    expect(screen.getByRole("article", { name: "你的消息" })).toBe(article);
    expect(article.querySelector(".wb-chat-avatar img")).toHaveAttribute(
      "src",
      "https://example.com/new.png",
    );
    view.rerender(
      <AgentTranscript projectPath="/project" messages={messages} />,
    );
    expect(
      article.querySelector(".wb-chat-avatar-fallback svg"),
    ).not.toBeNull();
    expect(article.querySelector(".wb-chat-author")).toHaveTextContent("你");
  });

  it("keeps image previews and document attachments inside the user bubble", async () => {
    render(
      <AgentTranscript
        projectPath="/project"
        messages={[user("attachments")]}
        imageAttachmentsByMessage={{
          attachments: [
            {
              id: "image",
              fileName: "reference.png",
              mime: "image/png",
              bytes: 3,
              dataUrl: "data:image/png;base64,YWJj",
            },
          ],
        }}
        documentAttachmentsByMessage={{
          attachments: [
            {
              id: "document",
              fileName: "notes.md",
              mime: "text/markdown",
              bytes: 5,
            },
          ],
        }}
      />,
    );
    const article = screen.getByRole("article", { name: "你的消息" });
    const bubble = article.querySelector(".wb-chat-bubble")!;
    const preview = screen.getByRole("button", {
      name: "放大查看图片：reference.png",
    });
    expect(bubble).toContainElement(preview);
    expect(bubble).toContainElement(screen.getByText("notes.md"));
    expect(bubble).toContainElement(
      screen.getByRole("img", { name: "reference.png" }),
    );
    await userEvent.click(preview);
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("aligns execution details with assistant replies without changing text/tool boundaries", () => {
    const view = render(
      <AgentTranscript
        projectPath="/project"
        messages={[
          user("one"),
          message("reply", [
            { type: "text", text: "Checking the project." },
            tool("write"),
            { type: "text", text: "Finished." },
          ]),
        ]}
      />,
    );
    const execution = screen.getByRole("article", { name: "Agent 执行过程" });
    expect(execution).toHaveClass(
      "wb-chat-message--assistant",
      "wb-chat-message--activity",
    );
    expect(execution.querySelector(".wb-chat-avatar")).not.toBeNull();
    expect(execution.querySelector(".wb-chat-author")).toBeNull();
    expect(execution.querySelector(".wb-chat-bubble")).toContainElement(
      groups(view.container)[0],
    );
    const rows = [...view.container.querySelectorAll(".wb-chat-message")];
    expect(rows[0]).toHaveTextContent("Request one");
    expect(rows[1]).toHaveTextContent("Checking the project.");
    expect(rows[2]).toBe(execution);
    expect(rows[3]).toHaveTextContent("Finished.");
  });
});

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
