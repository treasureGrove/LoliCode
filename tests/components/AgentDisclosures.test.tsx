import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentChanges } from "@/features/agent/AgentChanges";
import { AgentMessageView, AgentToolPart } from "@/features/agent/AgentParts";
import type { AgentDiff, AgentPart } from "@/types/agent";

vi.mock("@/features/sessions/reader/SessionMarkdown", () => ({
  SessionMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

const tool = (
  values: Partial<Extract<AgentPart, { type: "tool" }>> = {},
): Extract<AgentPart, { type: "tool" }> => ({
  type: "tool",
  id: "tool",
  name: "apply_patch",
  state: "completed",
  input: { path: "src/example.ts", old_text: "old", new_text: "new" },
  output: "已修改文件",
  ...values,
});

const diff = (values: Partial<AgentDiff> = {}): AgentDiff => ({
  path: "src/example.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  patch:
    "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n",
  ...values,
});

describe("Agent disclosures", () => {
  it.each([
    ["read_file", "读取文件"],
    ["list_files", "查看目录"],
    ["search_files", "搜索代码"],
    ["write_file", "写入文件"],
    ["run_command", "运行命令"],
  ])(
    "labels native tool %s without exposing unrelated input",
    (name, label) => {
      render(
        <AgentToolPart
          part={tool({
            name,
            input: { path: "src/example.ts", env: { TOKEN: "private-value" } },
          })}
        />,
      );
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.getByText("src/example.ts")).toBeVisible();
      expect(screen.queryByText("private-value")).not.toBeInTheDocument();
    },
  );

  it("starts compact, supports keyboard focus, and preserves the user's expansion across live updates", async () => {
    const view = render(<AgentToolPart part={tool({ state: "running" })} />);
    const disclosure = view.container.querySelector("details")!;
    const summary = disclosure.querySelector("summary")!;
    expect(disclosure.open).toBe(false);
    expect(screen.queryByText("已修改文件")).not.toBeInTheDocument();
    expect(within(summary).getByText("执行中")).toBeVisible();
    await userEvent.tab();
    expect(summary).toHaveFocus();
    await userEvent.click(summary);
    expect(disclosure.open).toBe(true);
    expect(screen.getByText("已修改文件")).toBeVisible();

    view.rerender(<AgentToolPart part={tool({ output: "完成保存" })} />);
    expect(disclosure.open).toBe(true);
    expect(within(summary).getByText("已完成")).toBeVisible();
    expect(screen.getByText("完成保存")).toBeVisible();
    await userEvent.click(summary);
    expect(screen.queryByText("完成保存")).not.toBeInTheDocument();
  });

  it("keeps the failure reason visible when a failed tool is collapsed", async () => {
    const view = render(
      <AgentToolPart
        part={tool({
          state: "error",
          error: "文件已被其他进程修改，请重新读取",
          output: null,
        })}
      />,
    );
    const summary = view.container.querySelector("summary")!;
    expect(within(summary).getByText("失败")).toBeVisible();
    expect(
      within(summary).getByText("文件已被其他进程修改，请重新读取"),
    ).toBeVisible();
    expect(
      screen.queryByRole("alert", { hidden: true }),
    ).not.toBeInTheDocument();
    await userEvent.click(summary);
    expect(screen.getByRole("alert")).toBeVisible();
  });

  it("keeps reasoning separate from the answer and collapsed by default", async () => {
    render(
      <AgentMessageView
        projectPath="/project"
        message={{
          id: "message",
          role: "assistant",
          createdAt: 1,
          parts: [
            { type: "reasoning", id: "reasoning", text: "先比较两个实现" },
            { type: "text", text: "建议采用第一个实现" },
          ],
        }}
      />,
    );
    expect(screen.getByText("建议采用第一个实现")).toBeVisible();
    expect(screen.queryByText("先比较两个实现")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("思考过程"));
    expect(screen.getByText("先比较两个实现")).toBeVisible();
  });

  it("shows file and line totals while the change panel and individual diffs remain collapsed", async () => {
    const view = render(
      <AgentChanges
        diffs={[
          diff(),
          diff({
            path: "src/added.ts",
            status: "added",
            additions: 4,
            deletions: 0,
            patch: "@@ -0,0 +1 @@\n+added\n",
          }),
        ]}
      />,
    );
    const panel = view.container.querySelector("details")!;
    const summary = panel.querySelector("summary")!;
    expect(panel.open).toBe(false);
    expect(summary).toHaveTextContent("文件修改 · 2 个文件");
    expect(summary).toHaveTextContent("+6");
    expect(summary).toHaveTextContent("−1");
    expect(screen.queryByText("new")).not.toBeInTheDocument();
    expect(screen.queryByTitle("src/example.ts")).not.toBeInTheDocument();

    await userEvent.click(summary);
    const file = screen.getByTitle("src/example.ts").closest("details")!;
    expect(file.open).toBe(false);
    expect(
      within(file.querySelector("summary")!).getByLabelText(
        "新增 2 行，删除 1 行",
      ),
    ).toBeVisible();
    expect(
      within(file.querySelector("summary")!).getByText("修改"),
    ).toBeVisible();
    expect(screen.queryByText("new")).not.toBeInTheDocument();
    await userEvent.click(file.querySelector("summary")!);
    expect(screen.getByText("new")).toBeVisible();
  });

  it("updates authoritative file statistics without reopening collapsed files", async () => {
    const view = render(<AgentChanges diffs={[diff()]} />);
    const panel = view.container.querySelector("details")!;
    await userEvent.click(panel.querySelector("summary")!);
    const file = screen.getByTitle("src/example.ts").closest("details")!;
    await userEvent.click(file.querySelector("summary")!);
    expect(file.open).toBe(true);

    view.rerender(
      <AgentChanges
        diffs={[
          diff({ additions: 3 }),
          diff({
            path: "src/removed.ts",
            status: "deleted",
            additions: 0,
            deletions: 8,
          }),
        ]}
      />,
    );
    expect(panel.open).toBe(true);
    expect(file.open).toBe(true);
    expect(
      within(file.querySelector("summary")!).getByLabelText(
        "新增 3 行，删除 1 行",
      ),
    ).toBeVisible();
    const removed = screen.getByTitle("src/removed.ts").closest("details")!;
    expect(removed.open).toBe(false);
    expect(
      within(removed.querySelector("summary")!).getByText("删除"),
    ).toBeVisible();
    await userEvent.click(file.querySelector("summary")!);
    view.rerender(<AgentChanges diffs={[diff({ additions: 4 })]} />);
    expect(file.open).toBe(false);
  });

  it("does not read or mount large tool payloads while collapsed, and opens the latest snapshot", async () => {
    let outputReads = 0;
    let output = `old-output-${"x".repeat(50000)}`;
    const part = tool({ state: "running" });
    Object.defineProperty(part, "output", {
      get: () => {
        outputReads += 1;
        return output;
      },
    });
    const view = render(<AgentToolPart part={part} />);
    const summary = view.container.querySelector("summary")!;
    expect(outputReads).toBe(0);
    expect(view.container.querySelector("pre")).toBeNull();
    output = `latest-output-${"y".repeat(50000)}`;
    await userEvent.click(summary);
    expect(view.container.querySelector("pre")).toHaveTextContent(
      "latest-output-",
    );
    expect(view.container.querySelector("code")?.textContent).toHaveLength(
      30000,
    );
    await userEvent.click(summary);
    expect(view.container.querySelector("pre")).toBeNull();
    outputReads = 0;
    view.rerender(<AgentToolPart part={Object.create(part)} />);
    expect(outputReads).toBe(0);
  });

  it("does not mount streamed reasoning until expanded and discards hidden Markdown again on collapse", async () => {
    const message = (text: string) => ({
      id: "reasoning-message",
      role: "assistant" as const,
      createdAt: 1,
      parts: [{ type: "reasoning" as const, id: "reasoning", text }],
    });
    const view = render(
      <AgentMessageView
        projectPath="/project"
        message={message("old-thinking")}
      />,
    );
    view.rerender(
      <AgentMessageView
        projectPath="/project"
        message={message("latest-thinking")}
      />,
    );
    expect(screen.queryByText("latest-thinking")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("思考过程"));
    expect(screen.getByText("latest-thinking")).toBeVisible();
    view.rerender(
      <AgentMessageView
        projectPath="/project"
        message={message("still-thinking")}
      />,
    );
    expect(screen.getByText("still-thinking")).toBeVisible();
    await userEvent.click(screen.getByText("思考过程"));
    expect(screen.queryByText("still-thinking")).not.toBeInTheDocument();
  });

  it("keeps visible tool scroll positions during updates and restores them after reopening", async () => {
    const view = render(
      <AgentToolPart part={tool({ output: "first output" })} />,
    );
    const summary = view.container.querySelector("summary")!;
    await userEvent.click(summary);
    const body = view.container.querySelector(
      "details > div",
    ) as HTMLDivElement;
    const region = screen.getByRole("region");
    body.scrollTop = 240;
    fireEvent.scroll(body);
    region.scrollLeft = 96;
    fireEvent.scroll(region);
    view.rerender(<AgentToolPart part={tool({ output: "latest output" })} />);
    expect(view.container.querySelector("details > div")).toBe(body);
    expect(body.scrollTop).toBe(240);
    expect(screen.getByRole("region").scrollLeft).toBe(96);
    await userEvent.click(summary);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    await userEvent.click(summary);
    expect(
      (view.container.querySelector("details > div") as HTMLDivElement)
        .scrollTop,
    ).toBe(240);
    expect(screen.getByRole("region").scrollLeft).toBe(96);
    expect(screen.getByText("latest output")).toBeVisible();
  });

  it("unmounts the file list and patches when the panel is closed while retaining per-file expansion and scroll", async () => {
    const other = diff({
      path: "src/other.ts",
      patch: "@@ -1 +1 @@\n-old\n+other\n",
    });
    const view = render(<AgentChanges diffs={[diff(), other]} />);
    const panel = view.container.querySelector("details")!;
    const summary = panel.querySelector("summary")!;
    await userEvent.click(summary);
    const file = screen.getByTitle("src/example.ts").closest("details")!;
    await userEvent.click(file.querySelector("summary")!);
    const patch = file.querySelector(
      "[tabindex='0']:not(summary)",
    ) as HTMLElement;
    patch.scrollTop = 144;
    patch.scrollLeft = 56;
    fireEvent.scroll(patch);
    await userEvent.click(summary);
    expect(view.container.querySelectorAll("details")).toHaveLength(1);
    expect(screen.queryByText("new")).not.toBeInTheDocument();
    view.rerender(
      <AgentChanges
        diffs={[other, diff({ patch: "@@ -1 +1 @@\n-old\n+latest-patch\n" })]}
      />,
    );
    await userEvent.click(summary);
    const reopened = screen.getByTitle("src/example.ts").closest("details")!;
    expect(reopened.open).toBe(true);
    expect(screen.getByText("latest-patch")).toBeVisible();
    const restoredPatch = reopened.querySelector(
      "[tabindex='0']:not(summary)",
    ) as HTMLElement;
    expect(restoredPatch.scrollTop).toBe(144);
    expect(restoredPatch.scrollLeft).toBe(56);
  });

  it("does not show a changes panel when the engine has not returned any file changes", () => {
    const view = render(<AgentChanges diffs={[]} />);
    expect(view.container).toBeEmptyDOMElement();
  });
});
