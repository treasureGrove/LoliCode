import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentPermissionCard } from "@/components/agent/AgentPermissionCard";
import type { AgentPermission } from "@/types/agent";

const permission = (
  changes: Partial<AgentPermission> = {},
): AgentPermission => ({
  id: "permission-native",
  sessionId: "session-owned",
  action: "Bash",
  resources: [],
  description: "Dangerous command requires your approval for this execution",
  approvalMode: "user-once",
  ...changes,
});

describe("AgentPermissionCard native previews", () => {
  it("does not allow another decision after the backend acknowledges it", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(<AgentPermissionCard request={permission()} onReply={reply} />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "允许一次" })),
    );
    expect(screen.getByText("已提交处理结果，等待 Agent 继续。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(reply).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
  });

  it("can retry a failed decision and resets for a different request", async () => {
    const reply = vi
      .fn()
      .mockRejectedValueOnce(new Error("暂时无法提交"))
      .mockResolvedValue(undefined);
    const view = render(
      <AgentPermissionCard request={permission()} onReply={reply} />,
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "允许一次" })),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法提交");
    expect(screen.getByRole("button", { name: "允许一次" })).toBeEnabled();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "允许一次" })),
    );
    view.rerender(
      <AgentPermissionCard
        request={permission({ id: "next-permission" })}
        onReply={reply}
      />,
    );
    expect(screen.getByRole("button", { name: "允许一次" })).toBeEnabled();
    expect(
      screen.queryByText("已提交处理结果，等待 Agent 继续。"),
    ).not.toBeInTheDocument();
  });

  it("shows the real dangerous command and directory while preserving native single-use approval", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentPermissionCard
        request={permission({
          toolInput: {
            command: "git clean -fd -- permission-fixture.txt",
            cwd: "D:/owned/temporary-project",
          },
        })}
        onReply={reply}
      />,
    );
    expect(screen.getByLabelText("将执行的命令")).toHaveTextContent(
      "git clean -fd -- permission-fixture.txt",
    );
    expect(screen.getByLabelText("工作目录")).toHaveTextContent(
      "D:/owned/temporary-project",
    );
    expect(
      screen.getByText("这条命令需要你确认后才能执行。"),
    ).toBeInTheDocument();
    const remember = screen.getByRole("button", { name: "此项目记住授权" });
    expect(remember).toBeDisabled();
    fireEvent.click(remember);
    expect(reply).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    });
    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith("once");
  });

  it("previews only exact command/path fields and does not dump credentials or arbitrary JSON", () => {
    render(
      <AgentPermissionCard
        request={permission({
          toolInput: {
            file_path: "src/owned.ts",
            filePath: "src/owned.ts",
            path: "src/another.ts",
            apiKey: "must-never-render",
            other: { hidden: "must-never-render" },
          },
        })}
        onReply={vi.fn()}
      />,
    );
    expect(screen.getAllByText("src/owned.ts")).toHaveLength(1);
    expect(screen.getByText("src/another.ts")).toBeInTheDocument();
    expect(screen.queryByText(/must-never-render/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("将执行的命令")).not.toBeInTheDocument();
  });

  it("escapes tool content as text and keeps long commands readable in a keyboard-accessible scroll area", () => {
    const command = `printf '<img src=x onerror=alert(1)>' ${"argument ".repeat(100)}`;
    const { container } = render(
      <AgentPermissionCard
        request={permission({ toolInput: { command } })}
        onReply={vi.fn()}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    const preview = screen.getByLabelText("将执行的命令");
    expect(preview.textContent).toBe(command);
    expect(preview).toHaveAttribute("tabindex", "0");
    expect(preview).toHaveClass("overflow-auto", "max-h-40");
  });

  it("preserves unfamiliar native descriptions and ordinary remember options", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentPermissionCard
        request={permission({
          approvalMode: undefined,
          description: "Native custom approval reason",
          toolInput: "Do not infer a command from unstructured input",
        })}
        onReply={reply}
      />,
    );
    expect(
      screen.getByText("Native custom approval reason"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("将执行的命令")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "此项目记住授权" }));
    });
    expect(reply).toHaveBeenCalledWith("always");
  });
});
