import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionMenu } from "@/features/agent/AgentSessionMenu";
import type { AgentSession } from "@/types/agent";
import { agentApi } from "@/lib/api/agent";
import { copyText } from "@/lib/clipboard";
import { toast } from "sonner";
import { copyAgentSessionMarkdown } from "@/features/agent/useAgentSessionMarkdownCopy";

vi.mock("@/lib/api/agent", () => ({
  agentApi: { readSessionMarkdown: vi.fn() },
}));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const session: AgentSession = {
  id: "session",
  title: "测试任务",
  projectPath: "D:/fixture",
  createdAt: 1,
  updatedAt: 2,
  mode: "build",
  permissionMode: "ask",
};
const rename = vi.fn();
const pin = vi.fn();
const archive = vi.fn();
const remove = vi.fn();
const flush = () =>
  act(async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  });
const renderMenu = (active = false) =>
  render(
    <AgentSessionMenu
      session={session}
      disabled={false}
      active={active}
      onRename={rename}
      onPin={pin}
      onArchive={archive}
      onDelete={remove}
    />,
  );
const openMenu = () =>
  fireEvent.keyDown(
    screen.getByRole("button", { name: "管理会话：测试任务" }),
    { key: "Enter" },
  );
beforeEach(() => {
  vi.clearAllMocks();
  rename.mockResolvedValue(undefined);
  pin.mockResolvedValue(undefined);
  archive.mockResolvedValue(undefined);
  remove.mockResolvedValue(undefined);
  vi.mocked(agentApi.readSessionMarkdown).mockResolvedValue(
    "# Native log\n\nOlder history\n",
  );
  vi.mocked(copyText).mockResolvedValue(undefined);
});
afterEach(cleanup);
describe("AgentSessionMenu", () => {
  it("copies the full native log for a running session rather than its visible messages", async () => {
    renderMenu(true);
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "复制会话为 Markdown" }),
    );
    await flush();
    expect(agentApi.readSessionMarkdown).toHaveBeenCalledWith("session");
    expect(copyText).toHaveBeenCalledWith("# Native log\n\nOlder history\n");
    expect(toast.success).toHaveBeenCalledWith("会话已复制为 Markdown");
  });

  it("keeps the first clicked session across menu changes and serializes clipboard writes", async () => {
    let resolve!: (markdown: string) => void;
    vi.mocked(agentApi.readSessionMarkdown).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = renderMenu();
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "复制会话为 Markdown" }),
    );
    await flush();
    first.unmount();
    render(
      <AgentSessionMenu
        session={{ ...session, id: "other", title: "另一会话" }}
        disabled={false}
        active={false}
        onRename={rename}
        onPin={pin}
        onArchive={archive}
        onDelete={remove}
      />,
    );
    const trigger = screen.getByRole("button", { name: "管理会话：另一会话" });
    expect(trigger).toHaveAttribute("aria-busy", "true");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(
      screen.getByRole("menuitem", { name: "正在准备会话…" }),
    ).toHaveAttribute("aria-disabled", "true");
    const joined = copyAgentSessionMarkdown("other");
    await act(async () => {
      resolve("# First clicked session\n");
      await joined;
    });
    expect(agentApi.readSessionMarkdown).toHaveBeenCalledTimes(1);
    expect(agentApi.readSessionMarkdown).toHaveBeenCalledWith("session");
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledWith("# First clicked session\n");
    expect(trigger).toHaveAttribute("aria-busy", "false");
  });

  it("never copies or reports success after a failed full-log read and permits a retry", async () => {
    vi.mocked(agentApi.readSessionMarkdown).mockRejectedValueOnce(
      new Error("原生日志不存在"),
    );
    renderMenu();
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "复制会话为 Markdown" }),
    );
    await flush();
    expect(copyText).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("读取会话失败：原生日志不存在");
    await act(async () => {
      await copyAgentSessionMarkdown("session");
    });
    expect(copyText).toHaveBeenCalledTimes(1);
  });

  it("reports a clipboard failure separately from a successful native read", async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error("clipboard denied"));
    await copyAgentSessionMarkdown("session");
    expect(toast.error).toHaveBeenCalledWith("复制失败，请检查剪贴板权限。");
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("renames the actual session and retains the typed title after a rejected save", async () => {
    rename.mockRejectedValueOnce(new Error("会话尚在执行，请稍后重命名。"));
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByLabelText("会话名称"), {
      target: { value: "新的任务名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await flush();
    expect(rename).toHaveBeenCalledWith("新的任务名称");
    expect(screen.getByLabelText("会话名称")).toHaveValue("新的任务名称");
    expect(screen.getByRole("alert")).toHaveTextContent("会话尚在执行");
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await flush();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("requires confirmation before deleting records and does not imply deleting project files", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除会话" }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/项目文件会保留/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it("prevents archiving or deleting a running conversation", () => {
    renderMenu(true);
    openMenu();
    expect(screen.getByRole("menuitem", { name: "归档会话" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "删除会话" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(remove).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });
  it("routes pinning to the persistent operation and displays a failure without pretending success", async () => {
    pin.mockRejectedValue(new Error("置顶未保存。"));
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶会话" }));
    await flush();
    expect(pin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("置顶未保存。");
  });
});
