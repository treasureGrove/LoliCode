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
});
afterEach(cleanup);
describe("AgentSessionMenu", () => {
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
